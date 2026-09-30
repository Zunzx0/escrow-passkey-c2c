import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resetTestDb, testPrisma } from "./helpers/db";
import { fundWallet, ORIGIN, RP_ID, registerAndLoginActiveUser } from "./helpers/authFlow";
import { buildAuthenticationResponse } from "./helpers/virtualAuthenticator";
import { getEscrowWallet } from "./helpers/fixtures";

type UserHandle = Awaited<ReturnType<typeof registerAndLoginActiveUser>>;

async function createListingAs(agent: UserHandle["agent"], price = 100_000) {
  const res = await agent.post("/api/listings").send({ title: "Áo thun demo", price }).expect(201);
  return res.body as { id: string; price: number };
}

/** Drives a transaction all the way to WAIT_CONFIRM + a valid, unused RELEASE grant token. */
async function setupReleaseReady(price = 80_000) {
  const seller = await registerAndLoginActiveUser(`seller-${Date.now()}-${Math.random()}@example.com`);
  const buyer = await registerAndLoginActiveUser(`buyer-${Date.now()}-${Math.random()}@example.com`);
  const listing = await createListingAs(seller.agent, price);
  await fundWallet(buyer.user.id, price);
  const txRes = await buyer.agent.post("/api/transactions").send({ listingId: listing.id }).expect(201);
  await buyer.agent.post(`/api/transactions/${txRes.body.id}/lock`).expect(200);
  await seller.agent.post(`/api/transactions/${txRes.body.id}/ship`).expect(200);
  await buyer.agent.post(`/api/transactions/${txRes.body.id}/receive`).expect(200);

  const optionsRes = await buyer.agent.post(`/api/transactions/${txRes.body.id}/release/reauth/options`).expect(200);
  const response = await buildAuthenticationResponse({
    rpID: RP_ID,
    origin: ORIGIN,
    challenge: optionsRes.body.challenge,
    credential: buyer.credential,
    signCount: 1,
  });
  const verifyRes = await buyer.agent
    .post(`/api/transactions/${txRes.body.id}/release/reauth/verify`)
    .send({ response })
    .expect(200);

  return { seller, buyer, listing, transactionId: txRes.body.id as string, price, token: verifyRes.body.token as string };
}

describe("Buyer RELEASE (Stage 7)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  it("happy path: escrow -A, seller +A, COMPLETED/RELEASED, grant consumed — atomically", async () => {
    const { seller, buyer, transactionId, price, token } = await setupReleaseReady(90_000);
    expect(price).toBe(90_000);

    const res = await buyer.agent.post(`/api/transactions/${transactionId}/release`).send({ token }).expect(200);
    expect(res.body.status).toBe("COMPLETED");
    expect(res.body.escrowStatus).toBe("RELEASED");
    expect(res.body.completedAt).not.toBeNull();

    const escrow = await getEscrowWallet();
    expect(escrow.lockedBalance).toBe(0);

    const sellerWallet = await testPrisma.wallet.findUniqueOrThrow({ where: { userId: seller.user.id } });
    expect(sellerWallet.availableBalance).toBe(90_000);
    expect(sellerWallet.version).toBe(1);

    const buyerWallet = await testPrisma.wallet.findUniqueOrThrow({ where: { userId: buyer.user.id } });
    expect(buyerWallet.availableBalance).toBe(0); // already debited at LOCK, RELEASE doesn't touch the buyer

    const entries = await testPrisma.walletEntry.findMany({ where: { transactionId, entryType: "RELEASE" } });
    expect(entries).toHaveLength(2);

    const grant = await testPrisma.reauthGrant.findFirstOrThrow({ where: { transactionId } });
    expect(grant.usedAt).not.toBeNull();
  });

  it("rejects the seller and an unrelated stranger", async () => {
    const { seller, transactionId, token } = await setupReleaseReady();
    await seller.agent.post(`/api/transactions/${transactionId}/release`).send({ token }).expect(403);

    const stranger = await registerAndLoginActiveUser("stranger-release@example.com");
    await stranger.agent.post(`/api/transactions/${transactionId}/release`).send({ token }).expect(403);

    const row = await testPrisma.transaction.findUniqueOrThrow({ where: { id: transactionId } });
    expect(row.status).toBe("WAIT_CONFIRM");
  });

  it("rejects RELEASE while the transaction isn't WAIT_CONFIRM (state checked before the token is even validated)", async () => {
    const seller = await registerAndLoginActiveUser("seller-wrongstate@example.com");
    const buyer = await registerAndLoginActiveUser("buyer-wrongstate@example.com");
    const listing = await createListingAs(seller.agent, 10_000);
    await fundWallet(buyer.user.id, 10_000);
    const txRes = await buyer.agent.post("/api/transactions").send({ listingId: listing.id }).expect(201);
    await buyer.agent.post(`/api/transactions/${txRes.body.id}/lock`).expect(200); // SECURED, not WAIT_CONFIRM

    await buyer.agent.post(`/api/transactions/${txRes.body.id}/release`).send({ token: "not-a-real-token" }).expect(409);
  });

  it("rejects an invalid/garbage grant token", async () => {
    const { buyer, transactionId } = await setupReleaseReady();
    await buyer.agent.post(`/api/transactions/${transactionId}/release`).send({ token: "garbage-token" }).expect(401);

    const row = await testPrisma.transaction.findUniqueOrThrow({ where: { id: transactionId } });
    expect(row.status).toBe("WAIT_CONFIRM");
    // 2 LOCK entries already exist from setup — the garbage token must
    // not have added any RELEASE entries on top of those.
    expect(await testPrisma.walletEntry.count({ where: { transactionId, entryType: "RELEASE" } })).toBe(0);
  });

  it("rejects a grant scoped to a DIFFERENT transaction, even for the same buyer ('Grant sai giao dịch')", async () => {
    const a = await setupReleaseReady();
    const b = await setupReleaseReady(); // a different buyer/transaction

    await a.buyer.agent.post(`/api/transactions/${a.transactionId}/release`).send({ token: b.token }).expect(403);

    const rowA = await testPrisma.transaction.findUniqueOrThrow({ where: { id: a.transactionId } });
    expect(rowA.status).toBe("WAIT_CONFIRM");
  });

  it("rejects an expired grant", async () => {
    const { buyer, transactionId, token } = await setupReleaseReady();
    await testPrisma.reauthGrant.updateMany({
      where: { transactionId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await buyer.agent.post(`/api/transactions/${transactionId}/release`).send({ token }).expect(409);
  });

  it("is idempotent: re-POSTing after a successful RELEASE returns 200 even though the (now-used) grant token would otherwise fail on its own", async () => {
    const { buyer, transactionId, price, token } = await setupReleaseReady(33_000);

    const first = await buyer.agent.post(`/api/transactions/${transactionId}/release`).send({ token }).expect(200);
    expect(first.body.status).toBe("COMPLETED");

    // Retry with the SAME (now-used) token — must still succeed: the
    // fast idempotent path keys off transaction status, so it never even
    // re-checks the grant on this second call.
    const second = await buyer.agent.post(`/api/transactions/${transactionId}/release`).send({ token }).expect(200);
    expect(second.body.status).toBe("COMPLETED");

    const sellerWallet = await testPrisma.wallet.findFirstOrThrow({ where: { availableBalance: price } });
    expect(sellerWallet.version).toBe(1); // credited exactly once
    expect(await testPrisma.walletEntry.count({ where: { transactionId, entryType: "RELEASE" } })).toBe(2);
  });

  it("real concurrent RELEASE spam with the SAME grant token: exactly one financial effect", async () => {
    const { seller, buyer, transactionId, price, token } = await setupReleaseReady(50_000);

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => buyer.agent.post(`/api/transactions/${transactionId}/release`).send({ token }))
    );
    // supertest resolves even on non-2xx (it's not a network failure), so
    // every promise settles "fulfilled" — the real signal is each
    // response's status code.
    const succeeded = results.filter((r) => r.status === "fulfilled" && (r as PromiseFulfilledResult<{ status: number }>).value.status === 200);
    expect(succeeded.length).toBeGreaterThan(0);

    const sellerWallet = await testPrisma.wallet.findUniqueOrThrow({ where: { userId: seller.user.id } });
    expect(sellerWallet.availableBalance).toBe(price); // credited exactly once regardless of how many calls raced
    expect(sellerWallet.version).toBe(1);

    const escrow = await getEscrowWallet();
    expect(escrow.lockedBalance).toBe(0);

    expect(await testPrisma.walletEntry.count({ where: { transactionId, entryType: "RELEASE" } })).toBe(2);

    const row = await testPrisma.transaction.findUniqueOrThrow({ where: { id: transactionId } });
    expect(row.status).toBe("COMPLETED");
    expect(row.version).toBe(4); // LOCK, ship, receive, release — one bump each, RELEASE applied exactly once
  });

  it("fault injection: forcing a failure after grant consumption rolls back BOTH the grant-used mark and the wallet effect", async () => {
    const { buyer, transactionId, token } = await setupReleaseReady(20_000);

    // Simulate an impossible state (escrow has less locked than this
    // transaction needs) to force applyLedgerOperation to fail AFTER
    // consumeGrant has already (within the same DB transaction) marked
    // the grant used — proving the whole thing rolls back together, not
    // just the money side.
    const escrow = await getEscrowWallet();
    await testPrisma.wallet.update({ where: { id: escrow.id }, data: { lockedBalance: 0 } });

    await buyer.agent.post(`/api/transactions/${transactionId}/release`).send({ token }).expect(409);

    const row = await testPrisma.transaction.findUniqueOrThrow({ where: { id: transactionId } });
    expect(row.status).toBe("WAIT_CONFIRM"); // rolled back, not COMPLETED

    const grant = await testPrisma.reauthGrant.findFirstOrThrow({ where: { transactionId } });
    expect(grant.usedAt).toBeNull(); // rolled back, not consumed

    expect(await testPrisma.walletEntry.count({ where: { transactionId, entryType: "RELEASE" } })).toBe(0);
  });

  it("end-to-end: LOCK -> ack -> ship -> receive -> release-reauth -> RELEASE leaves the ledger exactly balanced", async () => {
    const { seller, buyer, transactionId, price, token } = await setupReleaseReady(123_000);
    await buyer.agent.post(`/api/transactions/${transactionId}/release`).send({ token }).expect(200);

    const buyerWallet = await testPrisma.wallet.findUniqueOrThrow({ where: { userId: buyer.user.id } });
    const sellerWallet = await testPrisma.wallet.findUniqueOrThrow({ where: { userId: seller.user.id } });
    const escrow = await getEscrowWallet();

    expect(buyerWallet.availableBalance).toBe(0);
    expect(buyerWallet.lockedBalance).toBe(0);
    expect(sellerWallet.availableBalance).toBe(price);
    expect(escrow.availableBalance).toBe(0);
    expect(escrow.lockedBalance).toBe(0);

    const allEntries = await testPrisma.walletEntry.findMany({ where: { transactionId } });
    const sumDelta = allEntries.reduce((s, e) => s + e.deltaAvailable + e.deltaLocked, 0);
    expect(sumDelta).toBe(0); // Σdelta = 0 across the WHOLE transaction's history (LOCK + RELEASE)
  });
});
