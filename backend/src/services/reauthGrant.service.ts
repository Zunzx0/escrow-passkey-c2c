import crypto from "node:crypto";
import type { GrantAction, GrantDecision, Prisma, PrismaClient } from "@prisma/client";
import type { AuthenticationResponseJSON } from "@simplewebauthn/types";
import { prisma } from "../lib/prisma";
import { env } from "../config/env";
import { HttpError } from "../utils/httpError";
import { computeRequestFingerprint } from "../utils/idempotency";
import { decideCounterUpdate, tryConsumeChallenge, verifyReauthCrypto } from "./webauthn.service";

type Tx = Prisma.TransactionClient | PrismaClient;

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// Reuses computeRequestFingerprint purely as a canonical-JSON structural
// hash: two contexts are "the same" iff their canonicalized JSON matches,
// regardless of key order (ke-hoach §11's canonicalization applies
// equally well here — this is not a financial idempotency key, just a
// convenient existing deep-equality primitive).
function contextsMatch(a: unknown, b: unknown): boolean {
  return computeRequestFingerprint(a as Record<string, unknown>) === computeRequestFingerprint(b as Record<string, unknown>);
}

export type GrantScope = {
  action: GrantAction;
  transactionId?: string;
  disputeId?: string;
  decision?: GrantDecision;
};

/**
 * BA.md §21 step 9 + §5: after a verified, UV-required re-auth ceremony
 * whose rebuilt context matches what was bound at challenge-issuance
 * time, issue a single-use grant scoped to (user, action, transaction/
 * dispute, decision, context, short expiry). The server stores only
 * `tokenHash` — the raw token is returned ONCE here and never persisted
 * anywhere; the caller must hold onto it and present it back to the
 * actual business operation (e.g. Stage 16's RELEASE), which consumes it
 * via consumeGrant below.
 *
 * `rebuildContext` is called TWICE with fresh server data by design:
 * once here (immediately before granting, per §21 step 8 — "dựng lại
 * context từ dữ liệu hiện tại và đối chiếu với context đã lưu") and again
 * inside consumeGrant at actual business-operation time. Two separate
 * checks close the TOCTOU window between "user re-authenticated" and
 * "money actually moves".
 */
export async function verifyReauthAndIssueGrant(params: {
  userId: string;
  scope: GrantScope;
  response: AuthenticationResponseJSON;
  rebuildContext: (tx: Tx) => Promise<Record<string, unknown>>;
}): Promise<{ token: string; expiresAt: Date }> {
  const { user, credential, challengeRecord, verification } = await verifyReauthCrypto(params.userId, params.response);

  return prisma.$transaction(async (tx) => {
    const consumed = await tryConsumeChallenge(tx, challengeRecord.id);
    if (!consumed) {
      throw new HttpError(400, "Challenge đã được sử dụng hoặc hết hạn.");
    }

    // Same signCount risk policy as login (Stage 2) — a re-auth ceremony
    // is still just a WebAuthn authentication under the hood.
    const storedCounter = credential.counter;
    const newCounter = BigInt(verification.authenticationInfo.newCounter);
    const { counterToPersist, securityEvent } = decideCounterUpdate(storedCounter, newCounter);
    await tx.passkeyCredential.update({
      where: { id: credential.id },
      data: { counter: counterToPersist, lastUsedAt: new Date() },
    });
    if (securityEvent) {
      await tx.securityEvent.create({
        data: {
          userId: user.id,
          passkeyCredentialId: credential.id,
          eventType: securityEvent.eventType,
          severity: securityEvent.severity,
          metadata: {
            storedSignCount: storedCounter.toString(),
            newSignCount: newCounter.toString(),
            persistedSignCount: counterToPersist.toString(),
            purpose: "REAUTH",
          },
        },
      });
    }

    // BA.md §21 step 8: rebuild context from CURRENT trusted data and
    // compare against what was bound when the challenge was issued.
    const currentContext = await params.rebuildContext(tx);
    if (!contextsMatch(challengeRecord.context, currentContext)) {
      throw new HttpError(409, "Ngữ cảnh đã thay đổi kể từ khi bắt đầu xác thực lại, vui lòng thử lại.");
    }

    const rawToken = crypto.randomBytes(32).toString("base64url");
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + env.REAUTH_GRANT_TTL_MINUTES * 60_000);

    await tx.reauthGrant.create({
      data: {
        userId: user.id,
        tokenHash,
        action: params.scope.action,
        transactionId: params.scope.transactionId,
        disputeId: params.scope.disputeId,
        decision: params.scope.decision,
        context: currentContext as Prisma.InputJsonValue,
        expiresAt,
      },
    });

    return { token: rawToken, expiresAt };
  });
}

/**
 * Consumes a grant ATOMICALLY inside the CALLER's own transaction — this
 * function never opens its own (same discipline as applyLedgerOperation,
 * Stage 3 review). The future business operation (Stage 16 RELEASE,
 * Stage 18-19 admin adjudication) calls this inside its own
 * `prisma.$transaction`, right alongside `applyLedgerOperation`, so grant
 * consumption and the financial effect either both commit or both roll
 * back — never one without the other (ke-hoach §10, §21 steps 11-16).
 *
 * Checks, in order: grant exists, belongs to this user, unused, unexpired,
 * exact action/transaction/dispute/decision scope match (ke-hoach §19's
 * "Grant sai action" / "Grant sai transaction" / "Admin đổi decision" test
 * rows), and — the SECOND context re-check (see verifyReauthAndIssueGrant
 * above) — the context is STILL what it was when the grant was issued.
 * Marks the grant used via a conditional update (count===0 => some
 * concurrent caller already consumed it — never pretend success).
 */
export async function consumeGrant(
  tx: Tx,
  params: {
    token: string;
    userId: string;
    scope: GrantScope;
    // Takes the SAME `tx` this function was called with — the caller must
    // read current state through this transaction, not a separate client,
    // or the context re-check wouldn't actually be consistent with the
    // rest of the atomic operation happening around it.
    rebuildContext: (tx: Tx) => Promise<Record<string, unknown>>;
  }
): Promise<void> {
  const tokenHash = hashToken(params.token);
  const grant = await tx.reauthGrant.findUnique({ where: { tokenHash } });
  if (!grant) throw new HttpError(401, "Grant không hợp lệ.");
  if (grant.userId !== params.userId) throw new HttpError(403, "Grant không thuộc về bạn.");
  if (grant.usedAt) throw new HttpError(409, "Grant đã được sử dụng.");
  if (grant.expiresAt < new Date()) throw new HttpError(409, "Grant đã hết hạn.");
  if (grant.action !== params.scope.action) throw new HttpError(403, "Grant sai hành động.");
  if ((grant.transactionId ?? null) !== (params.scope.transactionId ?? null)) {
    throw new HttpError(403, "Grant sai giao dịch.");
  }
  if ((grant.disputeId ?? null) !== (params.scope.disputeId ?? null)) {
    throw new HttpError(403, "Grant sai hồ sơ tranh chấp.");
  }
  if (params.scope.decision !== undefined && grant.decision !== params.scope.decision) {
    throw new HttpError(403, "Grant sai quyết định.");
  }

  const currentContext = await params.rebuildContext(tx);
  if (!contextsMatch(grant.context, currentContext)) {
    throw new HttpError(409, "Ngữ cảnh giao dịch đã thay đổi, vui lòng xác thực lại.");
  }

  const result = await tx.reauthGrant.updateMany({
    where: { id: grant.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (result.count === 0) {
    throw new HttpError(409, "Grant vừa được sử dụng bởi thao tác khác.");
  }
}
