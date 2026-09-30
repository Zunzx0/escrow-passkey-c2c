import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { applyLedgerOperation } from "../src/services/wallet.service";
import { computeRequestFingerprint } from "../src/utils/idempotency";
import { resetTestDb, testPrisma } from "./helpers/db";
import { createFixturePaymentRequest, createFixtureTransaction, createFundedUser, getEscrowWallet } from "./helpers/fixtures";
import { applyLedgerOperationStandalone } from "./helpers/ledger";

describe("Wallet ledger engine (Stage 3)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  it("refuses to run against the root PrismaClient — must be called with an active transaction's client", async () => {
    const { wallet: buyerWallet } = await createFundedUser(100_000);
    const { user: seller } = await createFundedUser(0);
    const escrow = await getEscrowWallet();
    const transaction = await createFixtureTransaction(buyerWallet.userId!, seller.id, 1_000);

    // testPrisma IS the root client (has $transaction/$connect at
    // runtime) — passing it directly must be rejected, proving a future
    // service cannot bypass its own atomic boundary this way.
    await expect(
      applyLedgerOperation(testPrisma as any, {
        operationKind: "INTERNAL_TRANSFER",
        idempotencyKey: `bad-call-${transaction.id}`,
        requestFingerprint: computeRequestFingerprint({ actorId: "x", transactionId: transaction.id, action: "LOCK", amount: 1_000 }),
        subject: { transactionId: transaction.id },
        entries: [
          { walletId: buyerWallet.id, deltaAvailable: -1_000, deltaLocked: 0, entryType: "LOCK" },
          { walletId: escrow.id, deltaAvailable: 0, deltaLocked: 1_000, entryType: "LOCK" },
        ],
      })
    ).rejects.toThrow(/root PrismaClient/);

    expect(await testPrisma.walletEntry.count()).toBe(0);
  });

  it("applies a balanced LOCK-shaped transfer atomically: both wallets update, both entries recorded", async () => {
    const { user: buyer, wallet: buyerWallet } = await createFundedUser(100_000);
    const { user: seller } = await createFundedUser(0);
    const escrow = await getEscrowWallet();
    const transaction = await createFixtureTransaction(buyer.id, seller.id, 30_000);

    const result = await applyLedgerOperationStandalone({
      operationKind: "INTERNAL_TRANSFER",
      idempotencyKey: `lock-${transaction.id}`,
      requestFingerprint: computeRequestFingerprint({
        actorId: buyer.id,
        transactionId: transaction.id,
        action: "LOCK",
        amount: 30_000,
      }),
      subject: { transactionId: transaction.id },
      entries: [
        { walletId: buyerWallet.id, deltaAvailable: -30_000, deltaLocked: 0, entryType: "LOCK" },
        { walletId: escrow.id, deltaAvailable: 0, deltaLocked: 30_000, entryType: "LOCK" },
      ],
    });

    expect(result.replayed).toBe(false);
    expect(result.entries).toHaveLength(2);

    const buyerAfter = await testPrisma.wallet.findUniqueOrThrow({ where: { id: buyerWallet.id } });
    expect(buyerAfter.availableBalance).toBe(70_000);
    expect(buyerAfter.version).toBe(1);

    const escrowAfter = await testPrisma.wallet.findUniqueOrThrow({ where: { id: escrow.id } });
    expect(escrowAfter.lockedBalance).toBe(30_000);
    expect(escrowAfter.version).toBe(1);
  });

  it("rejects a transfer that would drive availableBalance negative, and leaves balance/version/entries untouched", async () => {
    const { user: buyer, wallet: buyerWallet } = await createFundedUser(1_000);
    const { user: seller } = await createFundedUser(0);
    const escrow = await getEscrowWallet();
    const transaction = await createFixtureTransaction(buyer.id, seller.id, 5_000);

    await expect(
      applyLedgerOperationStandalone({
        operationKind: "INTERNAL_TRANSFER",
        idempotencyKey: `lock-${transaction.id}`,
        requestFingerprint: computeRequestFingerprint({ actorId: buyer.id, transactionId: transaction.id, action: "LOCK", amount: 5_000 }),
        subject: { transactionId: transaction.id },
        entries: [
          { walletId: buyerWallet.id, deltaAvailable: -5_000, deltaLocked: 0, entryType: "LOCK" },
          { walletId: escrow.id, deltaAvailable: 0, deltaLocked: 5_000, entryType: "LOCK" },
        ],
      })
    ).rejects.toThrow();

    const buyerAfter = await testPrisma.wallet.findUniqueOrThrow({ where: { id: buyerWallet.id } });
    expect(buyerAfter.availableBalance).toBe(1_000);
    expect(buyerAfter.version).toBe(0);
    expect(await testPrisma.walletEntry.count()).toBe(0);
  });

  it("rejects a transfer that would drive lockedBalance negative (REFUND-shaped, escrow has nothing locked)", async () => {
    const { user: buyer, wallet: buyerWallet } = await createFundedUser(0);
    const { user: seller } = await createFundedUser(0);
    const escrow = await getEscrowWallet(); // lockedBalance starts at 0
    const transaction = await createFixtureTransaction(buyer.id, seller.id, 10_000);

    await expect(
      applyLedgerOperationStandalone({
        operationKind: "INTERNAL_TRANSFER",
        idempotencyKey: `refund-${transaction.id}`,
        requestFingerprint: computeRequestFingerprint({ actorId: buyer.id, transactionId: transaction.id, action: "REFUND", amount: 10_000 }),
        subject: { transactionId: transaction.id },
        entries: [
          { walletId: escrow.id, deltaAvailable: 0, deltaLocked: -10_000, entryType: "REFUND" },
          { walletId: buyerWallet.id, deltaAvailable: 10_000, deltaLocked: 0, entryType: "REFUND" },
        ],
      })
    ).rejects.toThrow();

    expect(await testPrisma.walletEntry.count()).toBe(0);
  });

  it("rejects an INTERNAL_TRANSFER whose deltas don't sum to zero, before writing anything", async () => {
    const { user: buyer, wallet: buyerWallet } = await createFundedUser(100_000);
    const { user: seller } = await createFundedUser(0);
    const escrow = await getEscrowWallet();
    const transaction = await createFixtureTransaction(buyer.id, seller.id, 1_000);

    await expect(
      applyLedgerOperationStandalone({
        operationKind: "INTERNAL_TRANSFER",
        idempotencyKey: "unbalanced-op",
        requestFingerprint: computeRequestFingerprint({ actorId: buyer.id, transactionId: transaction.id, action: "LOCK", amount: 1_000 }),
        subject: { transactionId: transaction.id },
        entries: [
          { walletId: buyerWallet.id, deltaAvailable: -1_000, deltaLocked: 0, entryType: "LOCK" },
          { walletId: escrow.id, deltaAvailable: 0, deltaLocked: 999, entryType: "LOCK" }, // off by 1
        ],
      })
    ).rejects.toThrow();

    const buyerAfter = await testPrisma.wallet.findUniqueOrThrow({ where: { id: buyerWallet.id } });
    expect(buyerAfter.availableBalance).toBe(100_000);
    expect(await testPrisma.walletEntry.count()).toBe(0);
  });

  it("rejects an INTERNAL_TRANSFER that uses TOPUP as an entryType (whitelist, not a caller flag)", async () => {
    const { user: buyer, wallet: buyerWallet } = await createFundedUser(100_000);
    const { user: seller } = await createFundedUser(0);
    const escrow = await getEscrowWallet();
    const transaction = await createFixtureTransaction(buyer.id, seller.id, 1_000);

    await expect(
      applyLedgerOperationStandalone({
        operationKind: "INTERNAL_TRANSFER",
        idempotencyKey: "smuggled-topup",
        requestFingerprint: computeRequestFingerprint({ actorId: buyer.id, transactionId: transaction.id, action: "LOCK", amount: 1_000 }),
        subject: { transactionId: transaction.id },
        entries: [
          { walletId: buyerWallet.id, deltaAvailable: 1_000, deltaLocked: 0, entryType: "TOPUP" },
          { walletId: escrow.id, deltaAvailable: -1_000, deltaLocked: 0, entryType: "TOPUP" },
        ],
      })
    ).rejects.toThrow(/không hợp lệ cho operationKind/);

    expect(await testPrisma.walletEntry.count()).toBe(0);
  });

  it("allows a single-entry EXTERNAL_CREDIT/TOPUP once the PaymentRequest is provider-confirmed SUCCEEDED", async () => {
    const { user, wallet } = await createFundedUser(0);
    const paymentRequest = await createFixturePaymentRequest(user.id, 50_000, "SUCCEEDED");

    const result = await applyLedgerOperationStandalone({
      operationKind: "EXTERNAL_CREDIT",
      idempotencyKey: `topup-${paymentRequest.id}`,
      requestFingerprint: computeRequestFingerprint({ actorId: user.id, paymentRequestId: paymentRequest.id, action: "TOPUP", amount: 50_000 }),
      subject: { paymentRequestId: paymentRequest.id },
      entries: [{ walletId: wallet.id, deltaAvailable: 50_000, deltaLocked: 0, entryType: "TOPUP" }],
    });

    expect(result.replayed).toBe(false);
    const after = await testPrisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
    expect(after.availableBalance).toBe(50_000);
    expect(after.version).toBe(1);
  });

  it("rejects EXTERNAL_CREDIT against a PaymentRequest that is still PENDING (not provider-confirmed) — engine is not a free mint", async () => {
    const { user, wallet } = await createFundedUser(0);
    const paymentRequest = await createFixturePaymentRequest(user.id, 50_000); // defaults to PENDING

    await expect(
      applyLedgerOperationStandalone({
        operationKind: "EXTERNAL_CREDIT",
        idempotencyKey: `topup-${paymentRequest.id}`,
        requestFingerprint: computeRequestFingerprint({ actorId: user.id, paymentRequestId: paymentRequest.id, action: "TOPUP", amount: 50_000 }),
        subject: { paymentRequestId: paymentRequest.id },
        entries: [{ walletId: wallet.id, deltaAvailable: 50_000, deltaLocked: 0, entryType: "TOPUP" }],
      })
    ).rejects.toThrow(/SUCCEEDED/);

    const after = await testPrisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
    expect(after.availableBalance).toBe(0);
    expect(await testPrisma.walletEntry.count()).toBe(0);
  });

  it("rejects EXTERNAL_CREDIT crediting a wallet that isn't the PaymentRequest's own user's wallet", async () => {
    const { user: payer } = await createFundedUser(0);
    const { wallet: someoneElsesWallet } = await createFundedUser(0);
    const paymentRequest = await createFixturePaymentRequest(payer.id, 50_000, "SUCCEEDED");

    await expect(
      applyLedgerOperationStandalone({
        operationKind: "EXTERNAL_CREDIT",
        idempotencyKey: `topup-${paymentRequest.id}`,
        requestFingerprint: computeRequestFingerprint({ actorId: payer.id, paymentRequestId: paymentRequest.id, action: "TOPUP", amount: 50_000 }),
        subject: { paymentRequestId: paymentRequest.id },
        entries: [{ walletId: someoneElsesWallet.id, deltaAvailable: 50_000, deltaLocked: 0, entryType: "TOPUP" }],
      })
    ).rejects.toThrow(/không khớp userId/);

    expect(await testPrisma.walletEntry.count()).toBe(0);
  });

  it("replays an identical retry (same idempotency_key + same request_fingerprint) with NO second financial effect", async () => {
    const { user: buyer, wallet: buyerWallet } = await createFundedUser(100_000);
    const { user: seller } = await createFundedUser(0);
    const escrow = await getEscrowWallet();
    const transaction = await createFixtureTransaction(buyer.id, seller.id, 30_000);

    const params = {
      operationKind: "INTERNAL_TRANSFER" as const,
      idempotencyKey: `lock-${transaction.id}`,
      requestFingerprint: computeRequestFingerprint({ actorId: buyer.id, transactionId: transaction.id, action: "LOCK", amount: 30_000 }),
      subject: { transactionId: transaction.id },
      entries: [
        { walletId: buyerWallet.id, deltaAvailable: -30_000, deltaLocked: 0, entryType: "LOCK" as const },
        { walletId: escrow.id, deltaAvailable: 0, deltaLocked: 30_000, entryType: "LOCK" as const },
      ],
    };

    const first = await applyLedgerOperationStandalone(params);
    const second = await applyLedgerOperationStandalone(params);

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.entries.map((e) => e.id).sort()).toEqual(first.entries.map((e) => e.id).sort());

    const buyerAfter = await testPrisma.wallet.findUniqueOrThrow({ where: { id: buyerWallet.id } });
    expect(buyerAfter.availableBalance).toBe(70_000); // unchanged by the second call
    expect(buyerAfter.version).toBe(1); // incremented exactly once
    expect(await testPrisma.walletEntry.count()).toBe(2); // not 4
  });

  it("rejects a reused idempotency_key with a DIFFERENT request_fingerprint, and makes no additional change", async () => {
    const { user: buyer, wallet: buyerWallet } = await createFundedUser(100_000);
    const { user: seller } = await createFundedUser(0);
    const escrow = await getEscrowWallet();
    const transaction = await createFixtureTransaction(buyer.id, seller.id, 30_000);
    const key = `lock-${transaction.id}`;

    await applyLedgerOperationStandalone({
      operationKind: "INTERNAL_TRANSFER",
      idempotencyKey: key,
      requestFingerprint: computeRequestFingerprint({ actorId: buyer.id, transactionId: transaction.id, action: "LOCK", amount: 30_000 }),
      subject: { transactionId: transaction.id },
      entries: [
        { walletId: buyerWallet.id, deltaAvailable: -30_000, deltaLocked: 0, entryType: "LOCK" },
        { walletId: escrow.id, deltaAvailable: 0, deltaLocked: 30_000, entryType: "LOCK" },
      ],
    });

    // Same key, but the fingerprint now reflects a DIFFERENT amount — a
    // key reuse in a different context must be rejected, not treated as
    // a harmless retry (ke-hoach §11).
    await expect(
      applyLedgerOperationStandalone({
        operationKind: "INTERNAL_TRANSFER",
        idempotencyKey: key,
        requestFingerprint: computeRequestFingerprint({ actorId: buyer.id, transactionId: transaction.id, action: "LOCK", amount: 99_999 }),
        subject: { transactionId: transaction.id },
        entries: [
          { walletId: buyerWallet.id, deltaAvailable: -30_000, deltaLocked: 0, entryType: "LOCK" },
          { walletId: escrow.id, deltaAvailable: 0, deltaLocked: 30_000, entryType: "LOCK" },
        ],
      })
    ).rejects.toThrow();

    const buyerAfter = await testPrisma.wallet.findUniqueOrThrow({ where: { id: buyerWallet.id } });
    expect(buyerAfter.availableBalance).toBe(70_000); // only the first call's effect
    expect(await testPrisma.walletEntry.count()).toBe(2);
  });

  it("under real concurrent requests spamming the SAME idempotency_key+fingerprint, only one financial effect happens", async () => {
    const { user: buyer, wallet: buyerWallet } = await createFundedUser(100_000);
    const { user: seller } = await createFundedUser(0);
    const escrow = await getEscrowWallet();
    const transaction = await createFixtureTransaction(buyer.id, seller.id, 10_000);

    const params = {
      operationKind: "INTERNAL_TRANSFER" as const,
      idempotencyKey: `lock-spam-${transaction.id}`,
      requestFingerprint: computeRequestFingerprint({ actorId: buyer.id, transactionId: transaction.id, action: "LOCK", amount: 10_000 }),
      subject: { transactionId: transaction.id },
      entries: [
        { walletId: buyerWallet.id, deltaAvailable: -10_000, deltaLocked: 0, entryType: "LOCK" as const },
        { walletId: escrow.id, deltaAvailable: 0, deltaLocked: 10_000, entryType: "LOCK" as const },
      ],
    };

    const results = await Promise.all(Array.from({ length: 10 }, () => applyLedgerOperationStandalone(params)));

    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(results.filter((r) => r.replayed)).toHaveLength(9);

    const buyerAfter = await testPrisma.wallet.findUniqueOrThrow({ where: { id: buyerWallet.id } });
    expect(buyerAfter.availableBalance).toBe(90_000);
    expect(buyerAfter.version).toBe(1);
    expect(await testPrisma.walletEntry.count()).toBe(2);
  });

  it("under real concurrent load on the SAME wallet with DIFFERENT operations, optimistic locking prevents any lost update or double-count", async () => {
    const { user: buyer, wallet: buyerWallet } = await createFundedUser(1_000_000);
    const { user: seller } = await createFundedUser(0);
    const escrow = await getEscrowWallet();
    const amount = 10_000;
    const N = 20;

    const transactions = await Promise.all(Array.from({ length: N }, () => createFixtureTransaction(buyer.id, seller.id, amount)));

    const results = await Promise.allSettled(
      transactions.map((transaction) =>
        applyLedgerOperationStandalone({
          operationKind: "INTERNAL_TRANSFER",
          idempotencyKey: `lock-${transaction.id}`,
          requestFingerprint: computeRequestFingerprint({ actorId: buyer.id, transactionId: transaction.id, action: "LOCK", amount }),
          subject: { transactionId: transaction.id },
          entries: [
            { walletId: buyerWallet.id, deltaAvailable: -amount, deltaLocked: 0, entryType: "LOCK" },
            { walletId: escrow.id, deltaAvailable: 0, deltaLocked: amount, entryType: "LOCK" },
          ],
        })
      )
    );

    const succeeded = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");
    expect(succeeded.length + failed.length).toBe(N);
    // Sanity: plenty of balance for all N, so this isn't limited by
    // insufficient funds — any failures here are genuine version conflicts.
    // The goal of this test is NOT "all N succeed" — it's that whatever
    // the success/conflict split, the final state is exactly consistent
    // with it: no lost update, no double effect, no invariant broken.
    expect(succeeded.length).toBeGreaterThan(0);

    const buyerAfter = await testPrisma.wallet.findUniqueOrThrow({ where: { id: buyerWallet.id } });
    const escrowAfter = await testPrisma.wallet.findUniqueOrThrow({ where: { id: escrow.id } });

    expect(buyerAfter.availableBalance).toBe(1_000_000 - succeeded.length * amount);
    expect(buyerAfter.version).toBe(succeeded.length);
    expect(escrowAfter.lockedBalance).toBe(succeeded.length * amount);
    expect(escrowAfter.version).toBe(succeeded.length);
    expect(buyerAfter.availableBalance).toBeGreaterThanOrEqual(0);

    const buyerEntries = await testPrisma.walletEntry.findMany({ where: { walletId: buyerWallet.id } });
    expect(buyerEntries).toHaveLength(succeeded.length);
    const sumDelta = buyerEntries.reduce((s, e) => s + e.deltaAvailable, 0);
    expect(sumDelta).toBe(-succeeded.length * amount);
  });

  it("fault injection: a successfully-applied first wallet update is fully rolled back when the second wallet's update fails", async () => {
    const { wallet: buyerWallet } = await createFundedUser(50_000);
    const escrow = await getEscrowWallet(); // availableBalance = 0
    const { user: seller } = await createFundedUser(0);
    const transaction = await createFixtureTransaction(buyerWallet.userId!, seller.id, 1_000);

    // Deltas sum to zero (so the balance check passes and we actually
    // reach the per-wallet update loop), but the amount is far larger
    // than either wallet holds. Whichever wallet is processed FIRST (per
    // the engine's fixed walletId-ascending order) receives a plain
    // credit and WILL succeed; the one processed SECOND receives the
    // matching debit and WILL fail — proving the first wallet's already-
    // committed-within-the-transaction change is undone by the rollback,
    // not just "never applied".
    const amount = 1_000_000;
    const [firstId, secondId] = [buyerWallet.id, escrow.id].sort();

    const firstBefore = await testPrisma.wallet.findUniqueOrThrow({ where: { id: firstId } });
    const secondBefore = await testPrisma.wallet.findUniqueOrThrow({ where: { id: secondId } });

    await expect(
      applyLedgerOperationStandalone({
        operationKind: "INTERNAL_TRANSFER",
        idempotencyKey: `fault-injection-${transaction.id}`,
        requestFingerprint: computeRequestFingerprint({ actorId: "fault-injection-test", transactionId: transaction.id, action: "LOCK", amount }),
        subject: { transactionId: transaction.id },
        entries: [
          { walletId: firstId, deltaAvailable: amount, deltaLocked: 0, entryType: "LOCK" },
          { walletId: secondId, deltaAvailable: -amount, deltaLocked: 0, entryType: "LOCK" },
        ],
      })
    ).rejects.toThrow();

    const firstAfter = await testPrisma.wallet.findUniqueOrThrow({ where: { id: firstId } });
    const secondAfter = await testPrisma.wallet.findUniqueOrThrow({ where: { id: secondId } });

    expect(firstAfter.availableBalance).toBe(firstBefore.availableBalance);
    expect(firstAfter.lockedBalance).toBe(firstBefore.lockedBalance);
    expect(firstAfter.version).toBe(firstBefore.version);
    expect(secondAfter.availableBalance).toBe(secondBefore.availableBalance);
    expect(secondAfter.lockedBalance).toBe(secondBefore.lockedBalance);
    expect(secondAfter.version).toBe(secondBefore.version);
    expect(await testPrisma.walletEntry.count()).toBe(0);
  });
});
