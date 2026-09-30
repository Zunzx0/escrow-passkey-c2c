import type { AuthenticationResponseJSON } from "@simplewebauthn/types";
import type { GrantDecision, Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { HttpError } from "../utils/httpError";
import { computeRequestFingerprint } from "../utils/idempotency";
import { applyLedgerOperation, isWalletEntryUniqueViolation, resolveWalletEntryIdempotencyRace } from "./wallet.service";
import { buildReauthOptions } from "./webauthn.service";
import { consumeGrant, verifyReauthAndIssueGrant } from "./reauthGrant.service";
import { appendAuditLog } from "./audit.service";

type ReadClient = Prisma.TransactionClient | PrismaClient;

// --- Stage 9: Admin adjudication (ke-hoach §28 steps 18-19, BA.md §9.4,
// §22 steps 6-14) ----------------------------------------------------------
// DISPUTED/FROZEN -> RELEASED/RELEASED (decision=RELEASE) or
// REFUNDED/REFUNDED (decision=REFUND). Mirrors Stage 6/7's re-auth + grant
// + money-moving-action triple exactly, parameterized by `decision` and
// scoped to a Dispute instead of directly to a Transaction. BA.md §15
// invariant #5 ("Grant phân xử phải đúng hồ sơ tranh chấp và đúng quyết
// định") is enforced by reauthGrant.service.ts's `consumeGrant`, which has
// checked `disputeId`/`decision` scope since Stage 6 — built ahead of time
// specifically for this stage, unused until now.

// --- Admin reads: BA.md §22 step 6 "Quản trị viên đọc hồ sơ, dữ liệu liên
// quan... trước khi chọn kết quả." An admin is NOT a transaction
// participant, so getTransactionForParticipant (transaction.service.ts)
// would 403 an admin — these two reads exist so adjudication is actually
// usable, not because BA.md asks for a dispute "inbox" UI. ------------------

export async function listDisputesForAdmin() {
  return prisma.dispute.findMany({
    include: { transaction: true },
    orderBy: { createdAt: "asc" }, // oldest-unresolved-first, a support-queue ordering
  });
}

export async function getDisputeForAdmin(disputeId: string) {
  const dispute = await prisma.dispute.findUnique({ where: { id: disputeId }, include: { transaction: true } });
  if (!dispute) throw new HttpError(404, "Không tìm thấy hồ sơ tranh chấp.");
  return dispute;
}

/**
 * BA.md §6-analog for adjudication: the minimum decision-relevant facts,
 * rebuilt from CURRENT trusted data at challenge issuance, grant issuance,
 * and grant consumption (three separate checks, same discipline as
 * buildReleaseContext). `decision` is included in the context itself (not
 * just checked separately via consumeGrant's scope) so a tampered decision
 * fails BOTH the scope check and the context-equality check — the same
 * belt-and-suspenders redundancy buildReleaseContext uses for `action`.
 */
export async function buildAdjudicationContext(
  client: ReadClient,
  disputeId: string,
  decision: GrantDecision
): Promise<Record<string, unknown>> {
  const dispute = await client.dispute.findUnique({ where: { id: disputeId } });
  if (!dispute) throw new HttpError(404, "Không tìm thấy hồ sơ tranh chấp.");
  const transaction = await client.transaction.findUnique({ where: { id: dispute.transactionId } });
  if (!transaction) throw new HttpError(404, "Không tìm thấy giao dịch.");
  return {
    action: "ADJUDICATE",
    disputeId: dispute.id,
    transactionId: transaction.id,
    buyerId: transaction.buyerId,
    sellerId: transaction.sellerId,
    amount: transaction.amount,
    decision,
  };
}

async function loadAdjudicatableDispute(disputeId: string) {
  const dispute = await prisma.dispute.findUnique({ where: { id: disputeId } });
  if (!dispute) throw new HttpError(404, "Không tìm thấy hồ sơ tranh chấp.");
  const transaction = await prisma.transaction.findUniqueOrThrow({ where: { id: dispute.transactionId } });
  // Early fail-fast guard — adjudicateDispute re-checks this again at grant
  // consumption time; this only avoids wasting a re-auth ceremony on a
  // dispute that plainly isn't adjudicatable yet (e.g. already resolved).
  if (transaction.status !== "DISPUTED") {
    throw new HttpError(409, `Giao dịch đang ở trạng thái ${transaction.status}, chưa thể phân xử.`);
  }
  return { dispute, transaction };
}

export async function requestAdjudicationReauth(adminId: string, disputeId: string, decision: GrantDecision) {
  await loadAdjudicatableDispute(disputeId);
  const context = await buildAdjudicationContext(prisma, disputeId, decision);
  return buildReauthOptions(adminId, context);
}

export async function verifyAdjudicationReauth(
  adminId: string,
  disputeId: string,
  decision: GrantDecision,
  response: AuthenticationResponseJSON
) {
  await loadAdjudicatableDispute(disputeId);
  return verifyReauthAndIssueGrant({
    userId: adminId,
    scope: { action: "ADJUDICATE", disputeId, decision },
    response,
    rebuildContext: (tx) => buildAdjudicationContext(tx, disputeId, decision),
  });
}

/**
 * Mirrors assertLockIsConsistent/assertReleaseIsConsistent/Stage 8's
 * assertDisputeIsConsistent: the idempotent-retry fast path never trusts a
 * terminal `status` blindly. Checks the ledger (money actually moved, by
 * the right type) AND the Dispute row itself (BA.md §15 invariant #5 —
 * "phải đúng hồ sơ tranh chấp và đúng quyết định" applies to the STORED
 * outcome too, not just the grant that authorized it).
 */
async function assertAdjudicationIsConsistent(
  client: ReadClient,
  transaction: { id: string; escrowStatus: string },
  disputeId: string,
  decision: GrantDecision
) {
  const expectedEscrowStatus = decision === "RELEASE" ? "RELEASED" : "REFUNDED";
  if (transaction.escrowStatus !== expectedEscrowStatus) {
    throw new Error(
      `Invariant violation: transaction ${transaction.id} adjudicated as ${decision} but escrowStatus=${transaction.escrowStatus}`
    );
  }
  const entries = await client.walletEntry.findMany({ where: { idempotencyKey: `adjudicate:${transaction.id}` } });
  if (entries.length !== 2 || !entries.every((e) => e.entryType === decision)) {
    throw new Error(
      `Invariant violation: transaction ${transaction.id} adjudicated as ${decision} but its wallet entries are missing/malformed (found ${entries.length})`
    );
  }
  const dispute = await client.dispute.findUnique({ where: { id: disputeId } });
  if (!dispute || dispute.status !== "RESOLVED" || dispute.decision !== decision) {
    throw new Error(`Invariant violation: transaction ${transaction.id} settled as ${decision} but its dispute record is inconsistent`);
  }
  return transaction;
}

/**
 * `token` is the one-time grant token from verifyAdjudicationReauth — never
 * trusted on its own: consumeGrant re-validates admin ownership, action,
 * disputeId, decision, AND rebuilds+compares context a THIRD time (closing
 * the TOCTOU window between grant issuance and this call, BA.md §21).
 */
export async function adjudicateDispute(adminId: string, disputeId: string, decision: GrantDecision, token: string, resolutionNote?: string) {
  const dispute = await prisma.dispute.findUnique({ where: { id: disputeId } });
  if (!dispute) throw new HttpError(404, "Không tìm thấy hồ sơ tranh chấp.");
  const transaction = await prisma.transaction.findUniqueOrThrow({ where: { id: dispute.transactionId } });

  const terminalStatus = decision === "RELEASE" ? "RELEASED" : "REFUNDED";

  // Fast path only — never trusted for the actual mutation below. Mirrors
  // releaseTransaction's exact shape: a legitimate retry (client never saw
  // the first response) succeeds WITHOUT needing the single-use grant token
  // to still be valid.
  if (transaction.status === terminalStatus) {
    await assertAdjudicationIsConsistent(prisma, transaction, disputeId, decision);
    return transaction;
  }
  // BA.md §15 invariant #3: "một giao dịch chỉ được tất toán một lần: hoặc
  // release hoặc refund." A transaction already settled with the OTHER
  // decision must 409, never be silently treated as this request's retry.
  if (transaction.status === "RELEASED" || transaction.status === "REFUNDED" || transaction.status === "COMPLETED") {
    throw new HttpError(409, `Giao dịch đã được tất toán trước đó (${transaction.status}), không thể phân xử lại.`);
  }
  if (transaction.status !== "DISPUTED") {
    throw new HttpError(409, `Giao dịch đang ở trạng thái ${transaction.status}, chưa thể phân xử.`);
  }

  const requestFingerprint = computeRequestFingerprint({
    actorId: adminId,
    transactionId: transaction.id,
    action: "ADJUDICATE",
    amount: transaction.amount,
    disputeId,
    decision,
  });

  async function applyAdjudication() {
    return prisma.$transaction(async (tx) => {
      const freshTransaction = await tx.transaction.findUniqueOrThrow({ where: { id: transaction.id } });
      if (freshTransaction.status === terminalStatus) {
        await assertAdjudicationIsConsistent(tx, freshTransaction, disputeId, decision);
        return freshTransaction; // lost a benign race to a concurrent identical retry
      }
      if (freshTransaction.status === "RELEASED" || freshTransaction.status === "REFUNDED" || freshTransaction.status === "COMPLETED") {
        throw new HttpError(409, `Giao dịch đã được tất toán trước đó (${freshTransaction.status}), không thể phân xử lại.`);
      }
      if (freshTransaction.status !== "DISPUTED") {
        throw new HttpError(409, `Giao dịch đang ở trạng thái ${freshTransaction.status}, chưa thể phân xử.`);
      }

      // Validate authorization/grant/context FIRST (fail fast before
      // touching any wallet) — same ordering choice as RELEASE (Stage 7).
      await consumeGrant(tx, {
        token,
        userId: adminId,
        scope: { action: "ADJUDICATE", disputeId, decision },
        rebuildContext: (tx2) => buildAdjudicationContext(tx2, disputeId, decision),
      });

      const escrowWallet = await tx.wallet.findFirstOrThrow({ where: { isEscrow: true } });
      const recipientUserId = decision === "RELEASE" ? freshTransaction.sellerId : freshTransaction.buyerId;
      const recipientWallet = await tx.wallet.findUnique({ where: { userId: recipientUserId } });
      if (!recipientWallet) throw new HttpError(404, "Không tìm thấy ví người nhận.");

      // BA.md §11: RELEASE => Escrow locked -A / Seller available +A;
      // REFUND => Escrow locked -A / Buyer available +A. Same shape as
      // Stage 7's RELEASE, just with the recipient chosen by `decision`.
      await applyLedgerOperation(tx, {
        operationKind: "INTERNAL_TRANSFER",
        idempotencyKey: `adjudicate:${freshTransaction.id}`,
        requestFingerprint,
        subject: { transactionId: freshTransaction.id },
        entries: [
          { walletId: escrowWallet.id, deltaAvailable: 0, deltaLocked: -freshTransaction.amount, entryType: decision },
          { walletId: recipientWallet.id, deltaAvailable: freshTransaction.amount, deltaLocked: 0, entryType: decision },
        ],
      });

      const transactionUpdateResult = await tx.transaction.updateMany({
        where: { id: freshTransaction.id, version: freshTransaction.version, status: "DISPUTED" },
        data: {
          status: terminalStatus,
          escrowStatus: terminalStatus,
          ...(decision === "RELEASE" ? { releasedAt: new Date() } : { refundedAt: new Date() }),
          version: { increment: 1 },
        },
      });
      if (transactionUpdateResult.count === 0) {
        throw new HttpError(409, "Giao dịch vừa bị thay đổi bởi thao tác khác (version conflict)");
      }

      await tx.dispute.update({
        where: { id: disputeId },
        data: { status: "RESOLVED", decision, resolvedById: adminId, resolutionNote, resolvedAt: new Date() },
      });

      await appendAuditLog(tx, {
        subject: { transactionId: freshTransaction.id },
        actorId: adminId,
        action: `ADJUDICATE_${decision}`,
        data: {
          disputeId,
          decision,
          fromStatus: "DISPUTED",
          toStatus: terminalStatus,
          amount: freshTransaction.amount,
          resolutionNote: resolutionNote ?? null,
        },
      });

      return tx.transaction.findUniqueOrThrow({ where: { id: freshTransaction.id } });
    });
  }

  // Same defense-in-depth idempotency-race safety net as LOCK/RELEASE —
  // not proven reachable here either (consumeGrant's own usedAt
  // conditional update already serializes concurrent attempts at the same
  // token before either reaches the ledger).
  try {
    return await applyAdjudication();
  } catch (err) {
    if (isWalletEntryUniqueViolation(err)) {
      await resolveWalletEntryIdempotencyRace(prisma, `adjudicate:${transaction.id}`, requestFingerprint);
      const settled = await prisma.transaction.findUniqueOrThrow({ where: { id: transaction.id } });
      await assertAdjudicationIsConsistent(prisma, settled, disputeId, decision);
      return settled;
    }
    throw err;
  }
}
