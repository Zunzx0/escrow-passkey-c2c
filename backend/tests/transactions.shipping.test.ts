import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resetTestDb, testPrisma } from "./helpers/db";
import { fundWallet, registerAndLoginActiveUser } from "./helpers/authFlow";

async function createListingAs(agent: Awaited<ReturnType<typeof registerAndLoginActiveUser>>["agent"], price = 100_000) {
  const res = await agent.post("/api/listings").send({ title: "Áo thun demo", price }).expect(201);
  return res.body as { id: string; price: number };
}

/** Sets up a fully SECURED transaction (LOCK already succeeded) ready for Stage 5 actions. */
async function setupSecuredTransaction(price = 50_000) {
  const seller = await registerAndLoginActiveUser(`seller-${Date.now()}-${Math.random()}@example.com`);
  const buyer = await registerAndLoginActiveUser(`buyer-${Date.now()}-${Math.random()}@example.com`);
  const listing = await createListingAs(seller.agent, price);
  await fundWallet(buyer.user.id, price);
  const txRes = await buyer.agent.post("/api/transactions").send({ listingId: listing.id }).expect(201);
  await buyer.agent.post(`/api/transactions/${txRes.body.id}/lock`).expect(200);
  return { seller, buyer, listing, transactionId: txRes.body.id as string, price };
}

describe("Seller acknowledgement / SHIPPING / Buyer receive (Stage 5)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  describe("Seller acknowledgement", () => {
    it("records sellerAckAt WITHOUT changing status (BA.md §8.3)", async () => {
      const { seller, transactionId } = await setupSecuredTransaction();
      const res = await seller.agent.post(`/api/transactions/${transactionId}/seller-ack`).expect(200);
      expect(res.body.status).toBe("SECURED");
      expect(res.body.sellerAckAt).not.toBeNull();
    });

    it("is idempotent: re-acknowledging returns the SAME timestamp, not a new one", async () => {
      const { seller, transactionId } = await setupSecuredTransaction();
      const first = await seller.agent.post(`/api/transactions/${transactionId}/seller-ack`).expect(200);
      const second = await seller.agent.post(`/api/transactions/${transactionId}/seller-ack`).expect(200);
      expect(second.body.sellerAckAt).toBe(first.body.sellerAckAt);

      const row = await testPrisma.transaction.findUniqueOrThrow({ where: { id: transactionId } });
      expect(row.version).toBe(2); // LOCK (1) + one real ack (1) — the retry did not bump it again
    });

    it("rejects the buyer and an unrelated stranger — only the transaction's own seller may acknowledge", async () => {
      const { buyer, transactionId } = await setupSecuredTransaction();
      await buyer.agent.post(`/api/transactions/${transactionId}/seller-ack`).expect(403);

      const stranger = await registerAndLoginActiveUser("stranger-ack@example.com");
      await stranger.agent.post(`/api/transactions/${transactionId}/seller-ack`).expect(403);
    });

    it("rejects acknowledgement while still CREATED (never locked)", async () => {
      const seller = await registerAndLoginActiveUser("seller-ack-created@example.com");
      const buyer = await registerAndLoginActiveUser("buyer-ack-created@example.com");
      const listing = await createListingAs(seller.agent, 10_000);
      const txRes = await buyer.agent.post("/api/transactions").send({ listingId: listing.id }).expect(201);

      await seller.agent.post(`/api/transactions/${txRes.body.id}/seller-ack`).expect(409);
    });
  });

  describe("Ship", () => {
    it("transitions SECURED -> SHIPPING and records shippedAt (BA.md §8.4)", async () => {
      const { seller, transactionId } = await setupSecuredTransaction();
      const res = await seller.agent.post(`/api/transactions/${transactionId}/ship`).expect(200);
      expect(res.body.status).toBe("SHIPPING");
      expect(res.body.escrowStatus).toBe("LOCKED"); // unchanged — only status advances
      expect(res.body.shippedAt).not.toBeNull();
    });

    it("does NOT require a prior seller-ack (BA.md text places no such dependency)", async () => {
      const { seller, transactionId } = await setupSecuredTransaction();
      const res = await seller.agent.post(`/api/transactions/${transactionId}/ship`).expect(200);
      expect(res.body.status).toBe("SHIPPING");
      expect(res.body.sellerAckAt).toBeNull();
    });

    it("is idempotent: shipping twice returns 200 both times with no extra state change", async () => {
      const { seller, transactionId } = await setupSecuredTransaction();
      await seller.agent.post(`/api/transactions/${transactionId}/ship`).expect(200);
      await seller.agent.post(`/api/transactions/${transactionId}/ship`).expect(200);

      const row = await testPrisma.transaction.findUniqueOrThrow({ where: { id: transactionId } });
      expect(row.version).toBe(2); // LOCK (1) + one real ship (1)
    });

    it("rejects the buyer and an unrelated stranger", async () => {
      const { buyer, transactionId } = await setupSecuredTransaction();
      await buyer.agent.post(`/api/transactions/${transactionId}/ship`).expect(403);
    });

    it("rejects shipping a transaction that was never locked (still CREATED)", async () => {
      const seller = await registerAndLoginActiveUser("seller-ship-created@example.com");
      const buyer = await registerAndLoginActiveUser("buyer-ship-created@example.com");
      const listing = await createListingAs(seller.agent, 10_000);
      const txRes = await buyer.agent.post("/api/transactions").send({ listingId: listing.id }).expect(201);

      await seller.agent.post(`/api/transactions/${txRes.body.id}/ship`).expect(409);
    });

    it("moves NO money — wallet balances are untouched by ship", async () => {
      const { seller, buyer, transactionId, price } = await setupSecuredTransaction(70_000);
      await seller.agent.post(`/api/transactions/${transactionId}/ship`).expect(200);

      const buyerWallet = await testPrisma.wallet.findUniqueOrThrow({ where: { userId: buyer.user.id } });
      expect(buyerWallet.availableBalance).toBe(0); // already debited at LOCK, unchanged by ship
      expect(buyerWallet.version).toBe(1); // still just the LOCK's version bump
      expect(price).toBe(70_000);
    });
  });

  describe("Buyer receive", () => {
    async function setupShippingTransaction(price = 40_000) {
      const setup = await setupSecuredTransaction(price);
      await setup.seller.agent.post(`/api/transactions/${setup.transactionId}/ship`).expect(200);
      return setup;
    }

    it("transitions SHIPPING -> WAIT_CONFIRM and records receivedAt (BA.md §8.5)", async () => {
      const { buyer, transactionId } = await setupShippingTransaction();
      const res = await buyer.agent.post(`/api/transactions/${transactionId}/receive`).expect(200);
      expect(res.body.status).toBe("WAIT_CONFIRM");
      expect(res.body.receivedAt).not.toBeNull();
    });

    it("is idempotent: confirming twice returns 200 both times with no extra state change", async () => {
      const { buyer, transactionId } = await setupShippingTransaction();
      await buyer.agent.post(`/api/transactions/${transactionId}/receive`).expect(200);
      await buyer.agent.post(`/api/transactions/${transactionId}/receive`).expect(200);

      const row = await testPrisma.transaction.findUniqueOrThrow({ where: { id: transactionId } });
      expect(row.version).toBe(3); // LOCK(1) + ship(1) + one real receive(1)
    });

    it("rejects the SELLER trying to self-confirm receipt — BA.md §8.5 explicit rule", async () => {
      const { seller, transactionId } = await setupShippingTransaction();
      await seller.agent.post(`/api/transactions/${transactionId}/receive`).expect(403);

      const row = await testPrisma.transaction.findUniqueOrThrow({ where: { id: transactionId } });
      expect(row.status).toBe("SHIPPING"); // unchanged
    });

    it("rejects an unrelated stranger", async () => {
      const { transactionId } = await setupShippingTransaction();
      const stranger = await registerAndLoginActiveUser("stranger-receive@example.com");
      await stranger.agent.post(`/api/transactions/${transactionId}/receive`).expect(403);
    });

    it("rejects confirming receipt while still SECURED (not yet shipped)", async () => {
      const { buyer, transactionId } = await setupSecuredTransaction();
      await buyer.agent.post(`/api/transactions/${transactionId}/receive`).expect(409);
    });

    it("moves NO money — wallet/escrow balances are untouched by receive", async () => {
      const { buyer, transactionId } = await setupShippingTransaction(55_000);
      await buyer.agent.post(`/api/transactions/${transactionId}/receive`).expect(200);

      const buyerWallet = await testPrisma.wallet.findUniqueOrThrow({ where: { userId: buyer.user.id } });
      expect(buyerWallet.availableBalance).toBe(0);
      expect(buyerWallet.version).toBe(1); // still just the LOCK's version bump

      const escrow = await testPrisma.wallet.findFirstOrThrow({ where: { isEscrow: true } });
      expect(escrow.lockedBalance).toBe(55_000); // unchanged — still locked, release is Stage 6/16
    });
  });

  describe("End-to-end happy path", () => {
    it("LOCK -> seller-ack -> ship -> receive advances the state machine exactly as BA.md §8 specifies", async () => {
      const { seller, buyer, transactionId } = await setupSecuredTransaction(90_000);

      await seller.agent.post(`/api/transactions/${transactionId}/seller-ack`).expect(200);
      const shipped = await seller.agent.post(`/api/transactions/${transactionId}/ship`).expect(200);
      expect(shipped.body.status).toBe("SHIPPING");

      const received = await buyer.agent.post(`/api/transactions/${transactionId}/receive`).expect(200);
      expect(received.body.status).toBe("WAIT_CONFIRM");
      expect(received.body.escrowStatus).toBe("LOCKED"); // still locked — RELEASE is Stage 6/16

      const final = await testPrisma.transaction.findUniqueOrThrow({ where: { id: transactionId } });
      expect(final.sellerAckAt).not.toBeNull();
      expect(final.shippedAt).not.toBeNull();
      expect(final.receivedAt).not.toBeNull();
      expect(final.version).toBe(4); // LOCK, ack, ship, receive — one bump each
    });
  });
});
