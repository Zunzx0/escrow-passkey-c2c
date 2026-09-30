import { afterAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app";
import { resetTestDb, testPrisma } from "./helpers/db";
import { fundWallet, registerAndLoginActiveUser } from "./helpers/authFlow";

async function createListingAs(agent: Awaited<ReturnType<typeof registerAndLoginActiveUser>>["agent"], price = 100_000) {
  const res = await agent.post("/api/listings").send({ title: "Áo thun demo", price }).expect(201);
  return res.body as { id: string; price: number };
}

/** Sets up a fully SECURED transaction (LOCK already succeeded). */
async function setupSecuredTransaction(price = 50_000) {
  const seller = await registerAndLoginActiveUser(`seller-${Date.now()}-${Math.random()}@example.com`);
  const buyer = await registerAndLoginActiveUser(`buyer-${Date.now()}-${Math.random()}@example.com`);
  const listing = await createListingAs(seller.agent, price);
  await fundWallet(buyer.user.id, price);
  const txRes = await buyer.agent.post("/api/transactions").send({ listingId: listing.id }).expect(201);
  await buyer.agent.post(`/api/transactions/${txRes.body.id}/lock`).expect(200);
  return { seller, buyer, listing, transactionId: txRes.body.id as string, price };
}

async function setupShippingTransaction(price = 50_000) {
  const setup = await setupSecuredTransaction(price);
  await setup.seller.agent.post(`/api/transactions/${setup.transactionId}/ship`).expect(200);
  return setup;
}

async function setupWaitConfirmTransaction(price = 50_000) {
  const setup = await setupShippingTransaction(price);
  await setup.buyer.agent.post(`/api/transactions/${setup.transactionId}/receive`).expect(200);
  return setup;
}

describe("Open dispute / FREEZE (Stage 8)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  it("buyer can open a dispute from SECURED — transaction -> DISPUTED/FROZEN, no money moves (BA.md §9.1/§9.3)", async () => {
    const { buyer, transactionId, price } = await setupSecuredTransaction(70_000);
    const res = await buyer.agent.post(`/api/transactions/${transactionId}/dispute`).send({ reason: "Người bán chưa gửi hàng." }).expect(201);

    expect(res.body.transactionId).toBe(transactionId);
    expect(res.body.openedById).toBe(buyer.user.id);
    expect(res.body.reason).toBe("Người bán chưa gửi hàng.");
    expect(res.body.status).toBe("OPEN");

    const row = await testPrisma.transaction.findUniqueOrThrow({ where: { id: transactionId } });
    expect(row.status).toBe("DISPUTED");
    expect(row.escrowStatus).toBe("FROZEN");

    const escrow = await testPrisma.wallet.findFirstOrThrow({ where: { isEscrow: true } });
    expect(escrow.lockedBalance).toBe(price); // unchanged — freezing moves no money
  });

  it("buyer can open a dispute from SHIPPING", async () => {
    const { buyer, transactionId } = await setupShippingTransaction();
    await buyer.agent.post(`/api/transactions/${transactionId}/dispute`).send({ reason: "Hàng chưa tới." }).expect(201);

    const row = await testPrisma.transaction.findUniqueOrThrow({ where: { id: transactionId } });
    expect(row.status).toBe("DISPUTED");
    expect(row.escrowStatus).toBe("FROZEN");
  });

  it("buyer can open a dispute from WAIT_CONFIRM", async () => {
    const { buyer, transactionId } = await setupWaitConfirmTransaction();
    await buyer.agent.post(`/api/transactions/${transactionId}/dispute`).send({ reason: "Sản phẩm không đúng mô tả." }).expect(201);

    const row = await testPrisma.transaction.findUniqueOrThrow({ where: { id: transactionId } });
    expect(row.status).toBe("DISPUTED");
  });

  it("seller can open a dispute from WAIT_CONFIRM (BA.md §9.1: seller's only allowed state)", async () => {
    const { seller, transactionId } = await setupWaitConfirmTransaction();
    const res = await seller.agent.post(`/api/transactions/${transactionId}/dispute`).send({ reason: "Người mua khiếu nại vô căn cứ." }).expect(201);
    expect(res.body.openedById).toBe(seller.user.id);

    const row = await testPrisma.transaction.findUniqueOrThrow({ where: { id: transactionId } });
    expect(row.status).toBe("DISPUTED");
  });

  it("rejects the seller trying to open from SECURED — sellers may only dispute from WAIT_CONFIRM", async () => {
    const { seller, transactionId } = await setupSecuredTransaction();
    await seller.agent.post(`/api/transactions/${transactionId}/dispute`).send({ reason: "..." }).expect(409);

    const row = await testPrisma.transaction.findUniqueOrThrow({ where: { id: transactionId } });
    expect(row.status).toBe("SECURED"); // unchanged
  });

  it("rejects the seller trying to open from SHIPPING", async () => {
    const { seller, transactionId } = await setupShippingTransaction();
    await seller.agent.post(`/api/transactions/${transactionId}/dispute`).send({ reason: "..." }).expect(409);
  });

  it("rejects an unrelated stranger", async () => {
    const { transactionId } = await setupSecuredTransaction();
    const stranger = await registerAndLoginActiveUser("stranger-dispute@example.com");
    await stranger.agent.post(`/api/transactions/${transactionId}/dispute`).send({ reason: "..." }).expect(403);
  });

  it("rejects opening a dispute on a transaction that was never locked (still CREATED)", async () => {
    const seller = await registerAndLoginActiveUser("seller-dispute-created@example.com");
    const buyer = await registerAndLoginActiveUser("buyer-dispute-created@example.com");
    const listing = await createListingAs(seller.agent, 10_000);
    const txRes = await buyer.agent.post("/api/transactions").send({ listingId: listing.id }).expect(201);

    await buyer.agent.post(`/api/transactions/${txRes.body.id}/dispute`).send({ reason: "..." }).expect(409);
  });

  it("rejects an empty or missing reason", async () => {
    const { buyer, transactionId } = await setupSecuredTransaction();
    await buyer.agent.post(`/api/transactions/${transactionId}/dispute`).send({ reason: "" }).expect(400);
    await buyer.agent.post(`/api/transactions/${transactionId}/dispute`).send({}).expect(400);

    const row = await testPrisma.transaction.findUniqueOrThrow({ where: { id: transactionId } });
    expect(row.status).toBe("SECURED"); // unchanged
  });

  it("is idempotent: the same party re-opening returns the SAME dispute record, not a duplicate", async () => {
    const { buyer, transactionId } = await setupSecuredTransaction();
    const first = await buyer.agent.post(`/api/transactions/${transactionId}/dispute`).send({ reason: "Lần đầu." }).expect(201);
    const second = await buyer.agent.post(`/api/transactions/${transactionId}/dispute`).send({ reason: "Lần đầu." }).expect(201);
    expect(second.body.id).toBe(first.body.id);

    const row = await testPrisma.transaction.findUniqueOrThrow({ where: { id: transactionId } });
    expect(row.version).toBe(2); // LOCK(1) + one real dispute-open(1) — the retry did not bump it again

    const disputeCount = await testPrisma.dispute.count({ where: { transactionId } });
    expect(disputeCount).toBe(1); // BA.md §18: at most one dispute per transaction
  });

  it("BA.md §9.3: the OTHER party sees and gets back the same already-open dispute, not a 409/403", async () => {
    const { seller, buyer, transactionId } = await setupWaitConfirmTransaction();
    const opened = await buyer.agent.post(`/api/transactions/${transactionId}/dispute`).send({ reason: "Buyer mở trước." }).expect(201);
    const seenBySeller = await seller.agent.post(`/api/transactions/${transactionId}/dispute`).send({ reason: "Seller cũng gọi lại." }).expect(201);
    expect(seenBySeller.body.id).toBe(opened.body.id);
    expect(seenBySeller.body.openedById).toBe(buyer.user.id); // still attributed to whoever opened it first

    const disputeCount = await testPrisma.dispute.count({ where: { transactionId } });
    expect(disputeCount).toBe(1);
  });

  it("5 concurrent open-dispute requests on the same transaction -> exactly one Dispute row, exactly one version bump", async () => {
    const { buyer, transactionId } = await setupSecuredTransaction();

    const results = await Promise.all(
      Array.from({ length: 5 }).map(() => buyer.agent.post(`/api/transactions/${transactionId}/dispute`).send({ reason: "Race." }))
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    const ids = new Set(results.map((r) => r.body.id));
    expect(ids.size).toBe(1); // every response points at the same single dispute

    const disputeCount = await testPrisma.dispute.count({ where: { transactionId } });
    expect(disputeCount).toBe(1);

    const row = await testPrisma.transaction.findUniqueOrThrow({ where: { id: transactionId } });
    expect(row.status).toBe("DISPUTED");
    expect(row.version).toBe(2); // LOCK(1) + exactly one real dispute-open(1)
  });

  it("404s on a non-existent transaction id", async () => {
    const buyer = await registerAndLoginActiveUser("buyer-dispute-404@example.com");
    await buyer.agent.post("/api/transactions/does-not-exist/dispute").send({ reason: "..." }).expect(404);
  });
});
