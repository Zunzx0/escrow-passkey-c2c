import type { AuthenticationResponseJSON } from "@simplewebauthn/types";
import type { Prisma, PrismaClient, TransactionStatus } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { HttpError } from "../utils/httpError";
import { computeRequestFingerprint } from "../utils/idempotency";
import { applyLedgerOperation, isWalletEntryUniqueViolation, resolveWalletEntryIdempotencyRace } from "./wallet.service";
import { buildReauthOptions } from "./webauthn.service";
import { consumeGrant, verifyReauthAndIssueGrant } from "./reauthGrant.service";
import { appendAuditLog } from "./audit.service";

type ReadClient = Prisma.TransactionClient | PrismaClient;

/**
 * Guards the idempotent-retry fast path (Stage 4 review, 2026-09-18): a
 * transaction with status SECURED is only safe to hand back as "LOCK
 * already succeeded" if its data actually says so. Blindly trusting
 * `status === "SECURED"` would paper over a hypothetical bug elsewhere
 * that left the flag set without the matching listing/ledger state — this
 * throws loudly instead (never a silent 200) if that's ever observed.
 */
async function assertLockIsConsistent(
  client: ReadClient,
  transaction: { id: string; listingId: string; escrowStatus: string }
): Promise<void> {
  if (transaction.escrowStatus !== "LOCKED") {
    throw new Error(
      `Invariant violation: transaction ${transaction.id} has status SECURED but escrowStatus=${transaction.escrowStatus}`
    );
  }
  const listing = await client.listing.findUnique({ where: { id: transaction.listingId } });
  if (!listing || listing.status !== "LOCKED") {
    throw new Error(
      `Invariant violation: transaction ${transaction.id} is SECURED but its listing (${transaction.listingId}) is not LOCKED`
    );
  }
  const entries = await client.walletEntry.findMany({ where: { idempotencyKey: `lock:${transaction.id}` } });
  if (entries.length !== 2 || !entries.every((e) => e.entryType === "LOCK")) {
    throw new Error(
      `Invariant violation: transaction ${transaction.id} is SECURED but its LOCK wallet entries are missing/malformed (found ${entries.length})`
    );
  }
}

// Create Transaction (ke-hoach §28 step 10, §13 "Create Transaction: chưa
// chuyển tiền"). listingId is intentionally NOT unique on Transaction —
// several CREATED transactions may reference the same listing before one
// of them LOCKs it successfully (schema.prisma comment, BA.md §8.1/§18).
export async function createTransaction(buyerId: string, listingId: string) {
  const listing = await prisma.listing.findUnique({ where: { id: listingId } });
  if (!listing) throw new HttpError(404, "Không tìm thấy tin đăng.");
  if (listing.sellerId === buyerId) {
    throw new HttpError(400, "Không thể tự mua tin đăng của chính mình.");
  }
  if (listing.status !== "AVAILABLE") {
    throw new HttpError(409, "Tin đăng hiện không khả dụng.");
  }

  // amount is snapshotted from the listing's price AT THIS MOMENT — a
  // later change to how listings work must never retroactively change an
  // already-created transaction's amount.
  return prisma.transaction.create({
    data: {
      buyerId,
      sellerId: listing.sellerId,
      listingId: listing.id,
      amount: listing.price,
      status: "CREATED",
      escrowStatus: "NONE",
    },
  });
}

// List the caller's OWN transactions (as buyer or seller) — added for the
// FE (frontend review, 2026-09-18): without this there is no way for a
// signed-in user to navigate back to a transaction they didn't just
// create. Read-only, scoped strictly to `buyerId === userId OR
// sellerId === userId` — never returns another user's transactions.
export async function listMyTransactions(userId: string) {
  return prisma.transaction.findMany({
    where: { OR: [{ buyerId: userId }, { sellerId: userId }] },
    orderBy: { createdAt: "desc" },
  });
}

export async function getTransactionForParticipant(userId: string, transactionId: string) {
  const transaction = await prisma.transaction.findUnique({ where: { id: transactionId } });
  if (!transaction) throw new HttpError(404, "Không tìm thấy giao dịch.");
  if (transaction.buyerId !== userId && transaction.sellerId !== userId) {
    throw new HttpError(403, "Bạn không có quyền xem giao dịch này.");
  }
  return transaction;
}

// LOCK (ke-hoach §28 step 11, §13 "LOCK: CREATED -> SECURED", §9 "Buyer
// available -A, Escrow locked +A"). Single atomic boundary, per §10's
// canonical sequence:
//   BEGIN -> validate/revalidate business state -> wallets/ledger ->
//   transaction state -> audit -> COMMIT
// (no grant step — LOCK is not in BA.md §7's sensitive-action list that
// requires Passkey re-auth).
export async function lockTransaction(buyerId: string, transactionId: string) {
  const transaction = await prisma.transaction.findUnique({ where: { id: transactionId } });
  if (!transaction) throw new HttpError(404, "Không tìm thấy giao dịch.");
  if (transaction.buyerId !== buyerId) {
    throw new HttpError(403, "Bạn không có quyền khóa giao dịch này.");
  }
  // Fast path only — never trusted for the actual mutation below, which
  // re-reads and re-validates everything inside the transaction (§12).
  if (transaction.status === "SECURED") {
    await assertLockIsConsistent(prisma, transaction);
    return transaction; // idempotent retry of an already-successful LOCK
  }
  if (transaction.status !== "CREATED") {
    throw new HttpError(409, `Giao dịch đang ở trạng thái ${transaction.status}, không thể khóa.`);
  }

  // Deterministic, server-derived idempotency key: a LOCK is only ever
  // meaningful once per transaction, so the transactionId itself is a
  // safe natural key — no client-supplied Idempotency-Key header needed
  // for this specific action. request_fingerprint is built ONLY from
  // server-verified data (actorId from the session, amount read from the
  // DB transaction row) — never from the request body (Stage 3 review).
  const requestFingerprint = computeRequestFingerprint({
    actorId: buyerId,
    transactionId: transaction.id,
    action: "LOCK",
    amount: transaction.amount,
  });

  async function applyLock() {
    return prisma.$transaction(async (tx) => {
      const freshTransaction = await tx.transaction.findUniqueOrThrow({ where: { id: transactionId } });
      if (freshTransaction.status === "SECURED") {
        await assertLockIsConsistent(tx, freshTransaction);
        return freshTransaction; // lost a benign race to a concurrent identical retry
      }
      if (freshTransaction.status !== "CREATED") {
        throw new HttpError(409, `Giao dịch đang ở trạng thái ${freshTransaction.status}, không thể khóa.`);
      }

      // Single-item LOCK guard (ke-hoach §5): conditional update on BOTH
      // status AND version, never inferred from a missing UNIQUE on
      // listingId. count===0 means another transaction won the race.
      const listing = await tx.listing.findUniqueOrThrow({ where: { id: freshTransaction.listingId } });
      const listingLockResult = await tx.listing.updateMany({
        where: { id: listing.id, status: "AVAILABLE", version: listing.version },
        data: { status: "LOCKED", version: { increment: 1 } },
      });
      if (listingLockResult.count === 0) {
        throw new HttpError(409, "Tin đăng đã được khóa bởi một giao dịch khác.");
      }

      const buyerWallet = await tx.wallet.findUnique({ where: { userId: buyerId } });
      if (!buyerWallet) throw new HttpError(404, "Không tìm thấy ví.");
      const escrowWallet = await tx.wallet.findFirstOrThrow({ where: { isEscrow: true } });

      // Insufficient balance (§19 "LOCK thiếu tiền") is enforced by
      // applyLedgerOperation itself — if it throws, the listing LOCK
      // above is rolled back too, since everything shares this one
      // transaction.
      await applyLedgerOperation(tx, {
        operationKind: "INTERNAL_TRANSFER",
        idempotencyKey: `lock:${freshTransaction.id}`,
        requestFingerprint,
        subject: { transactionId: freshTransaction.id },
        entries: [
          { walletId: buyerWallet.id, deltaAvailable: -freshTransaction.amount, deltaLocked: 0, entryType: "LOCK" },
          { walletId: escrowWallet.id, deltaAvailable: 0, deltaLocked: freshTransaction.amount, entryType: "LOCK" },
        ],
      });

      const transactionUpdateResult = await tx.transaction.updateMany({
        where: { id: freshTransaction.id, version: freshTransaction.version, status: "CREATED" },
        data: { status: "SECURED", escrowStatus: "LOCKED", version: { increment: 1 } },
      });
      if (transactionUpdateResult.count === 0) {
        throw new HttpError(409, "Giao dịch vừa bị thay đổi bởi thao tác khác (version conflict)");
      }

      await appendAuditLog(tx, {
        subject: { transactionId: freshTransaction.id },
        actorId: buyerId,
        action: "LOCK",
        data: { fromStatus: "CREATED", toStatus: "SECURED", fromEscrowStatus: "NONE", toEscrowStatus: "LOCKED", amount: freshTransaction.amount },
      });

      return tx.transaction.findUniqueOrThrow({ where: { id: freshTransaction.id } });
    });
  }

  // In THIS flow, the listing's conditional update above already
  // serializes two concurrent LOCK attempts on the SAME transaction
  // before either can reach the ledger — whichever request's UPDATE wins
  // the row lock commits first, and Postgres makes the loser's WHERE
  // re-evaluate against the now-changed row, so it fails at the listing
  // step (never reaching applyLedgerOperation at all). A genuine
  // idempotency_key collision on WalletEntry should therefore not be
  // reachable here — but we still wrap this call the way every future
  // ledger-calling service must (Stage 3 review), as defense in depth
  // against this reasoning ever becoming wrong under a future change to
  // the sequence above.
  try {
    return await applyLock();
  } catch (err) {
    if (isWalletEntryUniqueViolation(err)) {
      await resolveWalletEntryIdempotencyRace(prisma, `lock:${transactionId}`, requestFingerprint);
      const settled = await prisma.transaction.findUniqueOrThrow({ where: { id: transactionId } });
      await assertLockIsConsistent(prisma, settled);
      return settled;
    }
    throw err;
  }
}

// --- Stage 5: Seller acknowledgement / SHIPPING / Buyer receive --------
// (ke-hoach §28 steps 12-14, BA.md §8.3-8.5). None of these three actions
// move money — no applyLedgerOperation call, no financial idempotency_key
// needed. Each wraps its conditional `UPDATE ... WHERE id=? AND
// version=old_version AND status=<expected>` (§12) in a `prisma.$transaction`
// together with the audit-log write (Stage 10) — the wrapper was NOT
// needed pre-Stage-10 (no second table was written alongside it), but
// BA.md §16 requires a nhật ký record on every state transition AND on
// "mốc sự kiện nghiệp vụ quan trọng" — its OWN example of the latter is
// seller acknowledgement, so all three functions need it even though only
// two of them (ship/receive) also change `status`.
//
// `deliveryDeadline`/`inspectionDeadline` (schema.prisma, BA.md §18)
// deliberately stay untouched (null) here — BA.md never specifies WHEN
// they get computed, only that hitting inspection_deadline must never
// trigger an automatic state change (§10 "Không tự động giải ngân khi
// hết thời hạn kiểm tra"). Setting them is an open decision, likely
// belonging to roadmap step 24 (Notifications/reminders) — do not invent
// a formula for them here.

// Seller acknowledgement (BA.md §8.3): does NOT change `status` — only
// records `sellerAckAt`. Only valid from SECURED. Idempotent: calling it
// again after it's already recorded returns the existing timestamp
// unchanged, rather than erroring or overwriting the milestone — and,
// since nothing new happened, writes NO audit entry on that retry path.
export async function sellerAcknowledge(sellerId: string, transactionId: string) {
  const transaction = await prisma.transaction.findUnique({ where: { id: transactionId } });
  if (!transaction) throw new HttpError(404, "Không tìm thấy giao dịch.");
  if (transaction.sellerId !== sellerId) {
    throw new HttpError(403, "Bạn không có quyền thao tác giao dịch này.");
  }
  if (transaction.status !== "SECURED") {
    throw new HttpError(409, `Giao dịch đang ở trạng thái ${transaction.status}, không thể tiếp nhận đơn.`);
  }
  if (transaction.sellerAckAt) {
    return transaction; // idempotent retry — milestone already recorded
  }

  return prisma.$transaction(async (tx) => {
    const result = await tx.transaction.updateMany({
      where: { id: transactionId, version: transaction.version, status: "SECURED", sellerAckAt: null },
      data: { sellerAckAt: new Date(), version: { increment: 1 } },
    });
    if (result.count === 0) {
      const fresh = await tx.transaction.findUniqueOrThrow({ where: { id: transactionId } });
      if (fresh.sellerAckAt) return fresh; // lost a benign race to a concurrent identical ack — no audit write
      throw new HttpError(409, "Giao dịch vừa bị thay đổi bởi thao tác khác (version conflict)");
    }

    const updated = await tx.transaction.findUniqueOrThrow({ where: { id: transactionId } });
    await appendAuditLog(tx, {
      subject: { transactionId },
      actorId: sellerId,
      action: "SELLER_ACK",
      data: { sellerAckAt: updated.sellerAckAt?.toISOString() ?? null },
    });
    return updated;
  });
}

// Seller ships (BA.md §8.4): SECURED -> SHIPPING. Only the transaction's
// own seller. BA.md does not make sellerAckAt a precondition for
// shipping — the two are independent actions both gated on SECURED, so
// this deliberately does NOT require sellerAcknowledge to have run
// first.
export async function shipTransaction(sellerId: string, transactionId: string) {
  const transaction = await prisma.transaction.findUnique({ where: { id: transactionId } });
  if (!transaction) throw new HttpError(404, "Không tìm thấy giao dịch.");
  if (transaction.sellerId !== sellerId) {
    throw new HttpError(403, "Bạn không có quyền thao tác giao dịch này.");
  }
  if (transaction.status === "SHIPPING") {
    return transaction; // idempotent retry
  }
  if (transaction.status !== "SECURED") {
    throw new HttpError(409, `Giao dịch đang ở trạng thái ${transaction.status}, không thể chuyển sang đang giao.`);
  }

  return prisma.$transaction(async (tx) => {
    const result = await tx.transaction.updateMany({
      where: { id: transactionId, version: transaction.version, status: "SECURED" },
      data: { status: "SHIPPING", shippedAt: new Date(), version: { increment: 1 } },
    });
    if (result.count === 0) {
      const fresh = await tx.transaction.findUniqueOrThrow({ where: { id: transactionId } });
      if (fresh.status === "SHIPPING") return fresh; // lost a benign race to a concurrent identical retry — no audit write
      throw new HttpError(409, "Giao dịch vừa bị thay đổi bởi thao tác khác (version conflict)");
    }

    await appendAuditLog(tx, {
      subject: { transactionId },
      actorId: sellerId,
      action: "SHIP",
      data: { fromStatus: "SECURED", toStatus: "SHIPPING" },
    });
    return tx.transaction.findUniqueOrThrow({ where: { id: transactionId } });
  });
}

// Buyer confirms receipt (BA.md §8.5): SHIPPING -> WAIT_CONFIRM. ONLY the
// buyer — "Người bán không được tự đưa giao dịch sang WAIT_CONFIRM" is
// enforced by the exact same ownership check LOCK uses (buyerId must
// match), so a seller calling this on their own transaction gets 403,
// never a silent no-op. This is NOT release/giải ngân — that is a
// separate, Passkey-re-auth-gated action (Stage 6/16).
export async function buyerReceive(buyerId: string, transactionId: string) {
  const transaction = await prisma.transaction.findUnique({ where: { id: transactionId } });
  if (!transaction) throw new HttpError(404, "Không tìm thấy giao dịch.");
  if (transaction.buyerId !== buyerId) {
    throw new HttpError(403, "Bạn không có quyền thao tác giao dịch này.");
  }
  if (transaction.status === "WAIT_CONFIRM") {
    return transaction; // idempotent retry
  }
  if (transaction.status !== "SHIPPING") {
    throw new HttpError(409, `Giao dịch đang ở trạng thái ${transaction.status}, không thể xác nhận đã nhận hàng.`);
  }

  return prisma.$transaction(async (tx) => {
    const result = await tx.transaction.updateMany({
      where: { id: transactionId, version: transaction.version, status: "SHIPPING" },
      data: { status: "WAIT_CONFIRM", receivedAt: new Date(), version: { increment: 1 } },
    });
    if (result.count === 0) {
      const fresh = await tx.transaction.findUniqueOrThrow({ where: { id: transactionId } });
      if (fresh.status === "WAIT_CONFIRM") return fresh; // lost a benign race to a concurrent identical retry — no audit write
      throw new HttpError(409, "Giao dịch vừa bị thay đổi bởi thao tác khác (version conflict)");
    }

    await appendAuditLog(tx, {
      subject: { transactionId },
      actorId: buyerId,
      action: "RECEIVE",
      data: { fromStatus: "SHIPPING", toStatus: "WAIT_CONFIRM" },
    });
    return tx.transaction.findUniqueOrThrow({ where: { id: transactionId } });
  });
}

// --- Stage 6: Passkey re-auth + scoped grant for RELEASE ----------------
// (ke-hoach §28 step 15, BA.md §6 "Ngữ cảnh giải ngân của người mua"). This
// builds and proves the generic re-auth/grant engine using RELEASE's
// fully-specified context shape as the worked example — it does NOT
// implement RELEASE itself (the money-moving action, escrow LOCKED ->
// RELEASED, WAIT_CONFIRM -> COMPLETED) — that is Stage 16, which will call
// `consumeGrant` from reauthGrant.service.ts inside its own
// `prisma.$transaction`, the same way LOCK calls `applyLedgerOperation`.

/**
 * BA.md §6: "Ngữ cảnh giải ngân của người mua gồm tối thiểu: Người mua,
 * Giao dịch, Tin đăng, Số tiền, Hành động RELEASE." This is the SINGLE
 * source of truth for that shape — called with fresh data at challenge
 * issuance, at grant issuance (re-check), and will be called again at
 * RELEASE consumption time (Stage 16) so all three checks compare
 * apples to apples.
 *
 * `sellerId` is included on top of BA.md's minimum list (Stage 6 review)
 * because it's WHO the money would go to — directly authorization-
 * relevant, unlike the rest of the Listing row. Deliberately reads ONLY
 * these 5 fields off `transaction` — never `listing.title`/`description`/
 * image/`updatedAt` or any other mutable Listing display field, and
 * `amount` is `transaction.amount` (the snapshot locked in at LOCK time),
 * never `listing.price`. A seller editing an unrelated listing field
 * (once listing editing exists) must NEVER invalidate an in-flight
 * RELEASE grant — see the regression test for this in
 * tests/reauthGrant.test.ts.
 */
export async function buildReleaseContext(client: ReadClient, transactionId: string): Promise<Record<string, unknown>> {
  const transaction = await client.transaction.findUnique({ where: { id: transactionId } });
  if (!transaction) throw new HttpError(404, "Không tìm thấy giao dịch.");
  return {
    action: "RELEASE",
    buyerId: transaction.buyerId,
    sellerId: transaction.sellerId,
    transactionId: transaction.id,
    listingId: transaction.listingId,
    amount: transaction.amount,
  };
}

async function loadReleaseEligibleTransaction(buyerId: string, transactionId: string) {
  const transaction = await prisma.transaction.findUnique({ where: { id: transactionId } });
  if (!transaction) throw new HttpError(404, "Không tìm thấy giao dịch.");
  if (transaction.buyerId !== buyerId) {
    throw new HttpError(403, "Bạn không có quyền thao tác giao dịch này.");
  }
  // Early fail-fast guard — RELEASE (Stage 16) will re-check this again
  // at the moment the grant is actually consumed; this only avoids
  // wasting a re-auth ceremony on a transaction that plainly isn't
  // eligible yet.
  if (transaction.status !== "WAIT_CONFIRM") {
    throw new HttpError(409, `Giao dịch đang ở trạng thái ${transaction.status}, chưa thể giải ngân.`);
  }
  return transaction;
}

export async function requestReleaseReauth(buyerId: string, transactionId: string) {
  await loadReleaseEligibleTransaction(buyerId, transactionId);
  const context = await buildReleaseContext(prisma, transactionId);
  return buildReauthOptions(buyerId, context);
}

export async function verifyReleaseReauth(buyerId: string, transactionId: string, response: AuthenticationResponseJSON) {
  await loadReleaseEligibleTransaction(buyerId, transactionId);
  return verifyReauthAndIssueGrant({
    userId: buyerId,
    scope: { action: "RELEASE", transactionId },
    response,
    rebuildContext: (tx) => buildReleaseContext(tx, transactionId),
  });
}

// --- Stage 7: Buyer RELEASE (ke-hoach §28 step 16, BA.md §8.6/§21) -------
// WAIT_CONFIRM -> COMPLETED, escrow LOCKED -> RELEASED. The one financial
// operation Stage 6's grant machinery was built for: `consumeGrant` +
// `applyLedgerOperation` + the transaction-state update + the audit write
// (Stage 10) all share the SAME `prisma.$transaction` (§10, §21 steps
// 12-18).

async function assertReleaseIsConsistent(
  client: ReadClient,
  transaction: { id: string; escrowStatus: string }
): Promise<void> {
  if (transaction.escrowStatus !== "RELEASED") {
    throw new Error(
      `Invariant violation: transaction ${transaction.id} has status COMPLETED but escrowStatus=${transaction.escrowStatus}`
    );
  }
  const entries = await client.walletEntry.findMany({ where: { idempotencyKey: `release:${transaction.id}` } });
  if (entries.length !== 2 || !entries.every((e) => e.entryType === "RELEASE")) {
    throw new Error(
      `Invariant violation: transaction ${transaction.id} is COMPLETED but its RELEASE wallet entries are missing/malformed (found ${entries.length})`
    );
  }
}

/**
 * `token` is the one-time grant token returned by verifyReleaseReauth —
 * never trusted on its own: consumeGrant re-validates ownership/action/
 * transaction scope AND rebuilds+compares context a THIRD time (closing
 * the TOCTOU window between grant issuance and this call, BA.md §21).
 */
export async function releaseTransaction(buyerId: string, transactionId: string, token: string) {
  const transaction = await prisma.transaction.findUnique({ where: { id: transactionId } });
  if (!transaction) throw new HttpError(404, "Không tìm thấy giao dịch.");
  if (transaction.buyerId !== buyerId) {
    throw new HttpError(403, "Bạn không có quyền thao tác giao dịch này.");
  }
  // Fast path only — never trusted for the actual mutation below. This is
  // what makes a legitimate retry (client never saw the first response)
  // succeed WITHOUT needing the grant token to still be valid — the grant
  // is single-use by design, so a retry's token would otherwise fail
  // consumeGrant's usedAt check even though the operation already
  // genuinely completed.
  if (transaction.status === "COMPLETED") {
    await assertReleaseIsConsistent(prisma, transaction);
    return transaction;
  }
  if (transaction.status !== "WAIT_CONFIRM") {
    throw new HttpError(409, `Giao dịch đang ở trạng thái ${transaction.status}, chưa thể giải ngân.`);
  }

  const requestFingerprint = computeRequestFingerprint({
    actorId: buyerId,
    transactionId: transaction.id,
    action: "RELEASE",
    amount: transaction.amount,
  });

  async function applyRelease() {
    return prisma.$transaction(async (tx) => {
      const freshTransaction = await tx.transaction.findUniqueOrThrow({ where: { id: transactionId } });
      if (freshTransaction.status === "COMPLETED") {
        await assertReleaseIsConsistent(tx, freshTransaction);
        return freshTransaction; // lost a benign race to a concurrent identical retry
      }
      if (freshTransaction.status !== "WAIT_CONFIRM") {
        throw new HttpError(409, `Giao dịch đang ở trạng thái ${freshTransaction.status}, chưa thể giải ngân.`);
      }

      // Validate authorization/grant/context FIRST (fail fast before
      // touching any wallet) — BA.md §21 step 11. Whether this runs
      // before or after the ledger write doesn't change the atomicity
      // guarantee (everything is one transaction either way), but
      // failing here first avoids doing wallet work that would just be
      // rolled back anyway.
      await consumeGrant(tx, {
        token,
        userId: buyerId,
        scope: { action: "RELEASE", transactionId: freshTransaction.id },
        rebuildContext: (tx2) => buildReleaseContext(tx2, freshTransaction.id),
      });

      const escrowWallet = await tx.wallet.findFirstOrThrow({ where: { isEscrow: true } });
      const sellerWallet = await tx.wallet.findUnique({ where: { userId: freshTransaction.sellerId } });
      if (!sellerWallet) throw new HttpError(404, "Không tìm thấy ví người bán.");

      // §9: Escrow locked -A, Seller available +A. Insufficient-balance
      // is enforced by applyLedgerOperation itself — should never
      // realistically fire here (escrow.lockedBalance can't be less than
      // this transaction's own LOCK contribution), but if it somehow
      // does, the grant-consumed mark above rolls back too.
      await applyLedgerOperation(tx, {
        operationKind: "INTERNAL_TRANSFER",
        idempotencyKey: `release:${freshTransaction.id}`,
        requestFingerprint,
        subject: { transactionId: freshTransaction.id },
        entries: [
          { walletId: escrowWallet.id, deltaAvailable: 0, deltaLocked: -freshTransaction.amount, entryType: "RELEASE" },
          { walletId: sellerWallet.id, deltaAvailable: freshTransaction.amount, deltaLocked: 0, entryType: "RELEASE" },
        ],
      });

      const transactionUpdateResult = await tx.transaction.updateMany({
        where: { id: freshTransaction.id, version: freshTransaction.version, status: "WAIT_CONFIRM" },
        data: { status: "COMPLETED", escrowStatus: "RELEASED", completedAt: new Date(), version: { increment: 1 } },
      });
      if (transactionUpdateResult.count === 0) {
        throw new HttpError(409, "Giao dịch vừa bị thay đổi bởi thao tác khác (version conflict)");
      }

      await appendAuditLog(tx, {
        subject: { transactionId: freshTransaction.id },
        actorId: buyerId,
        action: "RELEASE",
        data: {
          fromStatus: "WAIT_CONFIRM",
          toStatus: "COMPLETED",
          fromEscrowStatus: "LOCKED",
          toEscrowStatus: "RELEASED",
          amount: freshTransaction.amount,
        },
      });

      return tx.transaction.findUniqueOrThrow({ where: { id: freshTransaction.id } });
    });
  }

  // Same same-key idempotency-race safety net as LOCK (Stage 3/4
  // precedent) — defense in depth, not proven reachable in this flow
  // either (consumeGrant's own usedAt conditional update already
  // serializes concurrent attempts at the SAME token before either
  // reaches the ledger).
  try {
    return await applyRelease();
  } catch (err) {
    if (isWalletEntryUniqueViolation(err)) {
      await resolveWalletEntryIdempotencyRace(prisma, `release:${transactionId}`, requestFingerprint);
      const settled = await prisma.transaction.findUniqueOrThrow({ where: { id: transactionId } });
      await assertReleaseIsConsistent(prisma, settled);
      return settled;
    }
    throw err;
  }
}

// --- Stage 8: Open dispute / FREEZE (ke-hoach §28 step 17, BA.md §9, §22
// steps 1-5) --------------------------------------------------------------
// Opens a dispute and freezes the escrow. Deliberately does NOT include
// admin adjudication (BA.md §9.4, §22 steps 6-14 — choosing REFUND/RELEASE,
// which needs its own Passkey re-auth + grant, same shape as Stage 6/16 but
// for an admin) — that is a later stage (roadmap steps 18-19). No money
// moves here: BA.md §9.3 "Đóng băng không làm thay đổi số dư."

// BA.md §9.1: buyer can dispute from any of the 3 "in flight" states;
// seller can ONLY dispute from WAIT_CONFIRM (e.g. a disagreement raised
// after the buyer already confirmed receipt).
const BUYER_DISPUTE_STATUSES = new Set<TransactionStatus>(["SECURED", "SHIPPING", "WAIT_CONFIRM"]);
const SELLER_DISPUTE_STATUSES = new Set<TransactionStatus>(["WAIT_CONFIRM"]);

/**
 * Mirrors assertLockIsConsistent/assertReleaseIsConsistent: the idempotent-
 * retry fast path never trusts `status === "DISPUTED"` blindly — a Dispute
 * row must actually exist, since BA.md §18 models "at most one dispute per
 * transaction" as an application-level invariant this code must uphold
 * (schema-enforced too, via the `transactionId @unique` FK).
 */
async function assertDisputeIsConsistent(client: ReadClient, transaction: { id: string; escrowStatus: string }) {
  if (transaction.escrowStatus !== "FROZEN") {
    throw new Error(
      `Invariant violation: transaction ${transaction.id} has status DISPUTED but escrowStatus=${transaction.escrowStatus}`
    );
  }
  const dispute = await client.dispute.findUnique({ where: { transactionId: transaction.id } });
  if (!dispute) {
    throw new Error(`Invariant violation: transaction ${transaction.id} is DISPUTED but has no dispute record`);
  }
  return dispute;
}

/**
 * Either party of the transaction may open — BA.md §9.1 does not restrict
 * this to only the buyer. `reason` is free text (evidence detail is BA.md
 * §9.3's "hồ sơ tranh chấp" — updating it further, e.g. adding more
 * evidence, is out of scope here; this only covers the OPEN action).
 */
export async function openDispute(callerId: string, transactionId: string, reason: string) {
  const transaction = await prisma.transaction.findUnique({ where: { id: transactionId } });
  if (!transaction) throw new HttpError(404, "Không tìm thấy giao dịch.");

  const isBuyer = transaction.buyerId === callerId;
  const isSeller = transaction.sellerId === callerId;
  if (!isBuyer && !isSeller) {
    throw new HttpError(403, "Bạn không có quyền thao tác giao dịch này.");
  }

  // Fast path only — never trusted for the actual mutation below. Either
  // party of an already-disputed transaction gets back the SAME dispute
  // record (BA.md §9.3: "tối đa một hồ sơ tranh chấp... tiếp tục cập nhật
  // hồ sơ đó"), not an error.
  if (transaction.status === "DISPUTED") {
    return assertDisputeIsConsistent(prisma, transaction);
  }

  const allowedStatuses = isBuyer ? BUYER_DISPUTE_STATUSES : SELLER_DISPUTE_STATUSES;
  if (!allowedStatuses.has(transaction.status)) {
    throw new HttpError(409, `Giao dịch đang ở trạng thái ${transaction.status}, không thể mở tranh chấp.`);
  }

  // Writes two tables (Transaction + Dispute) atomically, same rule as LOCK
  // (§10, §14): any multi-table mutation shares one prisma.$transaction.
  return prisma.$transaction(async (tx) => {
    const freshTransaction = await tx.transaction.findUniqueOrThrow({ where: { id: transactionId } });
    if (freshTransaction.status === "DISPUTED") {
      return assertDisputeIsConsistent(tx, freshTransaction); // lost a benign race to a concurrent identical retry
    }
    if (!allowedStatuses.has(freshTransaction.status)) {
      throw new HttpError(409, `Giao dịch đang ở trạng thái ${freshTransaction.status}, không thể mở tranh chấp.`);
    }

    // Conditional on version AND the allowed-status set in one statement —
    // whichever of two concurrent openDispute calls on the SAME
    // transaction commits first wins the row; the other's WHERE misses
    // (count===0) and fails below BEFORE it can ever reach dispute.create()
    // — so the Dispute table's own unique constraint on transactionId is
    // never actually raced here, only enforced as a second line of defense.
    const transactionUpdateResult = await tx.transaction.updateMany({
      where: { id: freshTransaction.id, version: freshTransaction.version, status: { in: Array.from(allowedStatuses) } },
      data: { status: "DISPUTED", escrowStatus: "FROZEN", version: { increment: 1 } },
    });
    if (transactionUpdateResult.count === 0) {
      throw new HttpError(409, "Giao dịch vừa bị thay đổi bởi thao tác khác (version conflict)");
    }

    const dispute = await tx.dispute.create({
      data: { transactionId: freshTransaction.id, openedById: callerId, reason },
    });

    await appendAuditLog(tx, {
      subject: { transactionId: freshTransaction.id },
      actorId: callerId,
      action: "DISPUTE_OPENED",
      data: { fromStatus: freshTransaction.status, toStatus: "DISPUTED", disputeId: dispute.id, reason },
    });

    return dispute;
  });
}
