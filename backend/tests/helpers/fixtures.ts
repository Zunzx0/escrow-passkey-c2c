import { testPrisma } from "./db";

let seq = 0;
function unique() {
  seq += 1;
  return `${Date.now()}-${seq}`;
}

/** A real ACTIVE user with their own funded wallet — for Stage 3 wallet-engine tests, which sit below the (not-yet-built) Listing/Transaction business flows. */
export async function createFundedUser(initialAvailable: number) {
  const suffix = unique();
  const user = await testPrisma.user.create({
    data: {
      email: `wallet-fixture-${suffix}@example.com`,
      passwordHash: "irrelevant-for-ledger-tests",
      role: "MEMBER",
      accountStatus: "ACTIVE",
    },
  });
  const wallet = await testPrisma.wallet.create({
    data: { userId: user.id, availableBalance: initialAvailable, lockedBalance: 0 },
  });
  return { user, wallet };
}

export async function getEscrowWallet() {
  return testPrisma.wallet.findFirstOrThrow({ where: { isEscrow: true } });
}

/**
 * Minimal Transaction row to satisfy WalletEntry's exactly-one-subject
 * CHECK constraint. Stage 3 only needs a real transactionId to hang
 * WalletEntry rows off of — the Transaction state machine itself
 * (CREATED -> SECURED -> ...) is Stage 4+.
 */
export async function createFixtureTransaction(buyerId: string, sellerId: string, amount: number) {
  const listing = await testPrisma.listing.create({
    data: { sellerId, title: `Fixture listing ${unique()}`, price: amount, status: "AVAILABLE" },
  });
  return testPrisma.transaction.create({
    data: { buyerId, sellerId, listingId: listing.id, amount, status: "CREATED", escrowStatus: "NONE" },
  });
}

/**
 * Minimal PaymentRequest row for EXTERNAL_CREDIT/TOPUP-shaped WalletEntry
 * tests. Defaults to PENDING (the real schema default — a request is not
 * SUCCEEDED until the Mock Payment Provider confirms it, Stage 21).
 * applyLedgerOperation's EXTERNAL_CREDIT path refuses to credit a wallet
 * against anything but a SUCCEEDED request, so tests that exercise the
 * happy path must pass `status: "SUCCEEDED"` explicitly.
 */
export async function createFixturePaymentRequest(
  userId: string,
  amount: number,
  status: "PENDING" | "SUCCEEDED" | "FAILED" | "TIMEOUT" = "PENDING"
) {
  const suffix = unique();
  return testPrisma.paymentRequest.create({
    data: {
      userId,
      amount,
      status,
      idempotencyKey: `fixture-topup-key-${suffix}`,
      providerReference: `fixture-provider-ref-${suffix}`,
    },
  });
}
