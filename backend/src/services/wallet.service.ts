import { Prisma, PrismaClient, WalletEntryType } from "@prisma/client";
import { HttpError } from "../utils/httpError";

export type LedgerEntryInput = {
  walletId: string;
  deltaAvailable: number;
  deltaLocked: number;
  entryType: WalletEntryType;
};

export type LedgerEntryResult = {
  id: string;
  walletId: string;
  deltaAvailable: number;
  deltaLocked: number;
  availableBalanceAfter: number;
  lockedBalanceAfter: number;
  entryType: WalletEntryType;
};

export type LedgerOperationResult = {
  replayed: boolean;
  entries: LedgerEntryResult[];
};

// Whitelisted operation kinds (Stage 3 review, 2026-09-17) — NOT a
// caller-supplied boolean flag like `skipZeroSum: true`, which any
// service could set to bypass the Σdelta=0 invariant. Each kind has its
// own fixed rules below; there is no way to ask for "internal transfer,
// but please don't balance it."
//
//   INTERNAL_TRANSFER — money already inside the system moving between
//     wallets (LOCK/RELEASE/REFUND). Bound to a Transaction. Must balance
//     to exactly Σdelta = 0 (ke-hoach §9, invariant #2).
//
//   EXTERNAL_CREDIT — new money entering the system from the (mock)
//     payment provider (TOPUP). Bound to a PaymentRequest that must
//     already be provider-confirmed SUCCEEDED — checked below, so this
//     engine can never be used as a free "mint money" endpoint even by a
//     careless caller. Exactly one entry, a positive credit to a single
//     wallet's availableBalance.
export type LedgerOperationKind = "INTERNAL_TRANSFER" | "EXTERNAL_CREDIT";

const ENTRY_TYPES_BY_KIND: Record<LedgerOperationKind, ReadonlySet<WalletEntryType>> = {
  INTERNAL_TRANSFER: new Set<WalletEntryType>(["LOCK", "RELEASE", "REFUND"]),
  EXTERNAL_CREDIT: new Set<WalletEntryType>(["TOPUP"]),
};

export type LedgerOperationParams =
  | {
      operationKind: "INTERNAL_TRANSFER";
      idempotencyKey: string;
      requestFingerprint: string;
      subject: { transactionId: string };
      entries: LedgerEntryInput[];
    }
  | {
      operationKind: "EXTERNAL_CREDIT";
      idempotencyKey: string;
      requestFingerprint: string;
      subject: { paymentRequestId: string };
      entries: LedgerEntryInput[];
    };

function assertSafeInteger(n: number, label: string) {
  if (!Number.isSafeInteger(n)) {
    throw new HttpError(400, `${label} phải là số nguyên hợp lệ`);
  }
}

function toResult(entry: {
  id: string;
  walletId: string;
  deltaAvailable: number;
  deltaLocked: number;
  availableBalanceAfter: number;
  lockedBalanceAfter: number;
  entryType: WalletEntryType;
}): LedgerEntryResult {
  return {
    id: entry.id,
    walletId: entry.walletId,
    deltaAvailable: entry.deltaAvailable,
    deltaLocked: entry.deltaLocked,
    availableBalanceAfter: entry.availableBalanceAfter,
    lockedBalanceAfter: entry.lockedBalanceAfter,
    entryType: entry.entryType,
  };
}

// Runtime (not just type-level) guard against the exact misuse flagged in
// Stage 3 review: some other service calling applyLedgerOperation with the
// ROOT PrismaClient and mutating a wallet outside the caller's own atomic
// boundary. TypeScript alone can't prevent this — Prisma.TransactionClient
// is structurally a subset of PrismaClient, so the root client is
// type-assignable to a `Prisma.TransactionClient`-typed parameter despite
// having extra methods. At RUNTIME, though, the object Prisma hands to a
// `prisma.$transaction(async (tx) => ...)` callback genuinely lacks
// `$transaction`/`$connect`/etc (verified empirically, 2026-09-17) — the
// root client always has them. That difference is what we check.
export function assertIsTransactionClient(tx: Prisma.TransactionClient): void {
  const maybeRootClient = tx as unknown as { $transaction?: unknown };
  if (typeof maybeRootClient.$transaction === "function") {
    throw new Error(
      "applyLedgerOperation must be called with the Prisma.TransactionClient handed to an ACTIVE prisma.$transaction(async (tx) => ...) callback, never with the root PrismaClient. " +
        "Wallet mutations must always share the caller's atomic boundary (state + grant + audit writes) — see ke-hoach §10."
    );
  }
}

/**
 * The ONE function in the codebase allowed to mutate
 * Wallet.availableBalance / Wallet.lockedBalance. Implements ke-hoach
 * §9-12:
 *
 *  - Whitelisted operation kinds (see LedgerOperationKind above), not a
 *    caller-supplied bypass flag.
 *  - Optimistic locking: each wallet update is a conditional
 *    `UPDATE ... WHERE id=? AND version=old_version`. Affected rows = 0
 *    means a concurrent modification raced us — we throw a 409, we never
 *    silently retry or pretend success (§12, §25: no unbounded retry of a
 *    financial operation).
 *  - Idempotency: same idempotency_key + same request_fingerprint replays
 *    the previously-recorded entries with NO new financial effect; same
 *    key + a different fingerprint is rejected as a conflict (§11).
 *
 * MUST be called with the Prisma.TransactionClient from the CALLER's own
 * `prisma.$transaction(...)` — this function never opens a transaction of
 * its own, precisely so that future business services (Stage 4 LOCK,
 * Stage 16 RELEASE, Stage 19 REFUND, Stage 21 TOPUP) can fold their
 * transaction-state/grant/audit writes into the SAME atomic boundary as
 * the wallet movement:
 *
 *   prisma.$transaction(async (tx) => {
 *     // 1. validate/revalidate business state
 *     // 2. applyLedgerOperation(tx, ...)
 *     // 3. update transaction state
 *     // 4. consume grant if needed
 *     // 5. audit
 *   })
 *
 * There is deliberately no "standalone" variant of this function in
 * production code — see tests/helpers/ledger.ts for the test-only wrapper
 * used before any such caller exists.
 */
export async function applyLedgerOperation(
  tx: Prisma.TransactionClient,
  params: LedgerOperationParams
): Promise<LedgerOperationResult> {
  assertIsTransactionClient(tx);

  const { operationKind, idempotencyKey, requestFingerprint, subject, entries } = params;

  if (entries.length === 0) {
    throw new HttpError(400, "Ledger operation phải có ít nhất một entry");
  }

  const walletIds = entries.map((e) => e.walletId);
  if (new Set(walletIds).size !== walletIds.length) {
    throw new HttpError(400, "Ledger operation không được có hai entry cùng walletId");
  }

  for (const entry of entries) {
    assertSafeInteger(entry.deltaAvailable, "deltaAvailable");
    assertSafeInteger(entry.deltaLocked, "deltaLocked");
    if (entry.deltaAvailable === 0 && entry.deltaLocked === 0) {
      throw new HttpError(400, "Ledger entry không được có delta bằng 0 ở cả hai trường");
    }
    if (!ENTRY_TYPES_BY_KIND[operationKind].has(entry.entryType)) {
      throw new HttpError(400, `entryType ${entry.entryType} không hợp lệ cho operationKind ${operationKind}`);
    }
  }

  if (operationKind === "INTERNAL_TRANSFER") {
    const sum = entries.reduce((s, e) => s + e.deltaAvailable + e.deltaLocked, 0);
    if (sum !== 0) {
      throw new HttpError(400, "INTERNAL_TRANSFER không cân bằng: Σdelta phải bằng 0");
    }
  } else {
    // EXTERNAL_CREDIT: exactly one wallet, a strictly positive credit to
    // availableBalance, never touching lockedBalance directly.
    if (entries.length !== 1) {
      throw new HttpError(400, "EXTERNAL_CREDIT chỉ được có đúng một entry");
    }
    const [entry] = entries;
    if (entry.deltaAvailable <= 0 || entry.deltaLocked !== 0) {
      throw new HttpError(400, "EXTERNAL_CREDIT phải có deltaAvailable > 0 và deltaLocked = 0");
    }

    // The gate that stops this engine from being a free money-mint
    // endpoint: an EXTERNAL_CREDIT operation may only proceed against a
    // PaymentRequest the (mock) provider has already confirmed SUCCEEDED.
    // The full Mock Payment Provider lifecycle is Stage 21; this check
    // only enforces the invariant at the lowest layer, regardless of what
    // any future caller does or forgets to do above it.
    const paymentRequest = await tx.paymentRequest.findUnique({ where: { id: subject.paymentRequestId } });
    if (!paymentRequest) {
      throw new HttpError(404, `PaymentRequest ${subject.paymentRequestId} không tồn tại`);
    }
    if (paymentRequest.status !== "SUCCEEDED") {
      throw new HttpError(
        409,
        `PaymentRequest ${subject.paymentRequestId} chưa được provider xác nhận SUCCEEDED (status hiện tại: ${paymentRequest.status})`
      );
    }
    // The credited wallet must actually belong to the PaymentRequest's
    // own user — otherwise a caller could confirm-and-credit ANY wallet
    // using someone else's successful top-up.
    const creditedWallet = await tx.wallet.findUnique({ where: { id: entry.walletId } });
    if (!creditedWallet || creditedWallet.userId !== paymentRequest.userId) {
      throw new HttpError(409, "EXTERNAL_CREDIT wallet không khớp userId của PaymentRequest");
    }
  }

  // --- Idempotency: look up by idempotencyKey (leftmost column of the
  // @@unique([idempotencyKey, walletId]) index, so this is an index scan,
  // not a table scan). ---------------------------------------------------
  const existing = await tx.walletEntry.findMany({ where: { idempotencyKey } });
  if (existing.length > 0) {
    const fingerprintsMatch = existing.every((e) => e.requestFingerprint === requestFingerprint);
    if (!fingerprintsMatch) {
      throw new HttpError(409, "idempotency_key đã được dùng với request_fingerprint khác");
    }
    const existingWalletIds = new Set(existing.map((e) => e.walletId));
    const sameWalletSet =
      existingWalletIds.size === walletIds.length && walletIds.every((id) => existingWalletIds.has(id));
    if (!sameWalletSet) {
      // Should be impossible: the whole operation is one atomic
      // transaction, so a prior attempt either wrote entries for EVERY
      // wallet in it or none. Surfaced loudly rather than proceeding.
      throw new HttpError(409, "idempotency_key tồn tại nhưng không khớp tập wallet của thao tác này");
    }
    return { replayed: true, entries: existing.map(toResult) };
  }

  // --- Apply, in a fixed (walletId-ascending) order so two operations
  // touching an overlapping set of wallets always acquire row locks in the
  // same order, avoiding deadlocks under concurrency. --------------------
  const orderedEntries = [...entries].sort((a, b) => (a.walletId < b.walletId ? -1 : a.walletId > b.walletId ? 1 : 0));
  const subjectFields =
    operationKind === "INTERNAL_TRANSFER"
      ? { transactionId: subject.transactionId }
      : { paymentRequestId: subject.paymentRequestId };

  const createdEntries: LedgerEntryResult[] = [];
  for (const entry of orderedEntries) {
    const wallet = await tx.wallet.findUnique({ where: { id: entry.walletId } });
    if (!wallet) {
      throw new HttpError(404, `Wallet ${entry.walletId} không tồn tại`);
    }

    const newAvailable = wallet.availableBalance + entry.deltaAvailable;
    const newLocked = wallet.lockedBalance + entry.deltaLocked;
    if (newAvailable < 0 || newLocked < 0) {
      throw new HttpError(409, `Wallet ${entry.walletId} không đủ số dư cho thao tác này`);
    }

    const updateResult = await tx.wallet.updateMany({
      where: { id: entry.walletId, version: wallet.version },
      data: { availableBalance: newAvailable, lockedBalance: newLocked, version: { increment: 1 } },
    });
    if (updateResult.count === 0) {
      throw new HttpError(409, `Wallet ${entry.walletId} vừa bị thay đổi bởi thao tác khác (version conflict)`);
    }

    const created = await tx.walletEntry.create({
      data: {
        walletId: entry.walletId,
        ...subjectFields,
        deltaAvailable: entry.deltaAvailable,
        deltaLocked: entry.deltaLocked,
        availableBalanceAfter: newAvailable,
        lockedBalanceAfter: newLocked,
        entryType: entry.entryType,
        idempotencyKey,
        requestFingerprint,
      },
    });

    createdEntries.push(toResult(created));
  }

  return { replayed: false, entries: createdEntries };
}

/**
 * For a business service's OWN top-level `prisma.$transaction(...)` that
 * failed with a P2002 unique violation on WalletEntry's
 * `(idempotencyKey, walletId)` constraint — meaning a CONCURRENT request
 * with the identical idempotency_key committed first:
 *
 *   Request A and B both carry the same idempotency_key
 *   -> both start their own $transaction, both check "any entry with this
 *      key yet?" and both see none (neither has committed yet)
 *   -> A commits first
 *   -> B's own INSERT then hits the UNIQUE constraint -> B's whole
 *      transaction rolls back (no partial effect from B)
 *   -> B (in ITS catch block, after its rollback) calls this function to
 *      look up A's now-committed canonical result and returns it as a
 *      replay.
 *
 * This is NOT a retry of the money mutation — the mutation runs exactly
 * once, by whichever request's transaction commits first. This function
 * only performs a read. If no canonical result is found (should not
 * happen, since the constraint violation proves *something* committed),
 * or if it belongs to a different request_fingerprint, this throws rather
 * than looping (ke-hoach §25: never retry a financial operation, never
 * paper over a failure to make a test pass).
 */
export async function resolveWalletEntryIdempotencyRace(
  prismaOrTx: PrismaClient | Prisma.TransactionClient,
  idempotencyKey: string,
  requestFingerprint: string
): Promise<LedgerOperationResult> {
  const canonical = await prismaOrTx.walletEntry.findMany({ where: { idempotencyKey } });
  if (canonical.length === 0) {
    throw new Error(
      `Idempotency race on key ${idempotencyKey}: a unique violation was observed but no canonical committed WalletEntry rows were found — failing safe instead of retrying the financial operation.`
    );
  }
  const fingerprintsMatch = canonical.every((e) => e.requestFingerprint === requestFingerprint);
  if (!fingerprintsMatch) {
    throw new HttpError(409, `idempotency_key ${idempotencyKey} đã có kết quả với request_fingerprint khác`);
  }
  return { replayed: true, entries: canonical.map(toResult) };
}

export function isWalletEntryUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}
