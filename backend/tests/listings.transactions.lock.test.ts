import { afterAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app";
import { resetTestDb, testPrisma } from "./helpers/db";
import { fundWallet, registerAndLoginActiveUser } from "./helpers/authFlow";
import { getEscrowWallet } from "./helpers/fixtures";

async function createListingAs(agent: ReturnType<typeof request.agent>, price = 100_000) {
  const res = await agent.post("/api/listings").send({ title: "Áo thun demo", price }).expect(201);
  return res.body as { id: string; price: number; status: string; version: number };
}

describe("Listings + Create Transaction + LOCK (Stage 4)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  describe("Listings", () => {
    it("lets a MEMBER account create a listing, defaulting to AVAILABLE/version 0", async () => {
      const { agent } = await registerAndLoginActiveUser("seller1@example.com");
      const listing = await createListingAs(agent, 250_000);
      expect(listing.status).toBe("AVAILABLE");
      expect(listing.version).toBe(0);
      expect(listing.price).toBe(250_000);
    });

    it("rejects a non-positive price", async () => {
      const { agent } = await registerAndLoginActiveUser("seller2@example.com");
      await agent.post("/api/listings").send({ title: "x", price: 0 }).expect(400);
      await agent.post("/api/listings").send({ title: "x", price: -5000 }).expect(400);
    });

    it("rejects a price above the PostgreSQL Int4 ceiling", async () => {
      const { agent } = await registerAndLoginActiveUser("seller3@example.com");
      await agent.post("/api/listings").send({ title: "x", price: 3_000_000_000 }).expect(400);
    });

    it("blocks ADMIN-role accounts from creating listings", async () => {
      const { agent, user } = await registerAndLoginActiveUser("wouldbeadmin@example.com");
      await testPrisma.user.update({ where: { id: user.id }, data: { role: "ADMIN" } });
      await agent.post("/api/listings").send({ title: "x", price: 1000 }).expect(403);
    });

    it("lists only AVAILABLE listings on the public browse endpoint", async () => {
      const { agent: sellerAgent } = await registerAndLoginActiveUser("seller4@example.com");
      const listing = await createListingAs(sellerAgent, 50_000);

      const { agent: buyerAgent, user: buyer } = await registerAndLoginActiveUser("buyer4@example.com");
      await fundWallet(buyer.id, 50_000);
      const txRes = await buyerAgent.post("/api/transactions").send({ listingId: listing.id }).expect(201);
      await buyerAgent.post(`/api/transactions/${txRes.body.id}/lock`).expect(200);

      const browseRes = await request(app).get("/api/listings").expect(200);
      expect(browseRes.body.items.find((l: { id: string }) => l.id === listing.id)).toBeUndefined();
    });

    it("the detail view stays publicly reachable for a LOCKED listing (deliberate policy: browse hides it, detail-by-id still resolves)", async () => {
      const { agent: sellerAgent } = await registerAndLoginActiveUser("seller4b@example.com");
      const listing = await createListingAs(sellerAgent, 30_000);
      const { agent: buyerAgent, user: buyer } = await registerAndLoginActiveUser("buyer4b@example.com");
      await fundWallet(buyer.id, 30_000);
      const txRes = await buyerAgent.post("/api/transactions").send({ listingId: listing.id }).expect(201);
      await buyerAgent.post(`/api/transactions/${txRes.body.id}/lock`).expect(200);

      const detailRes = await request(app).get(`/api/listings/${listing.id}`).expect(200);
      expect(detailRes.body.status).toBe("LOCKED");
    });

    it("the detail view includes the seller's public id+displayName only — never email or other account fields, and no auth is required to view it", async () => {
      const { agent: sellerAgent, user: seller } = await registerAndLoginActiveUser("seller-info@example.com");
      const listing = await createListingAs(sellerAgent, 15_000);

      const res = await request(app).get(`/api/listings/${listing.id}`).expect(200); // unauthenticated request
      expect(res.body.seller.id).toBe(seller.id);
      expect(res.body.seller).not.toHaveProperty("email");
      expect(res.body.seller).not.toHaveProperty("passwordHash");
    });

    it("includes the seller's public id+displayName on browse cards, never email", async () => {
      const { agent, user: seller } = await registerAndLoginActiveUser("browse-seller@example.com");
      await createListingAs(agent, 12_000);

      const res = await request(app).get("/api/listings").expect(200);
      expect(res.body.items[0].seller.id).toBe(seller.id);
      expect(res.body.items[0].seller).not.toHaveProperty("email");
      expect(res.body.items[0].seller).not.toHaveProperty("passwordHash");
    });

    it("filters the browse endpoint by title search (case-insensitive)", async () => {
      const { agent } = await registerAndLoginActiveUser("search-seller@example.com");
      await agent.post("/api/listings").send({ title: "Áo Thun Nike", price: 100_000 }).expect(201);
      await agent.post("/api/listings").send({ title: "Giày Adidas", price: 200_000 }).expect(201);

      const res = await request(app).get("/api/listings?search=nike").expect(200);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].title).toBe("Áo Thun Nike");
    });

    it("filters the browse endpoint by min/max price", async () => {
      const { agent } = await registerAndLoginActiveUser("price-seller@example.com");
      await agent.post("/api/listings").send({ title: "Rẻ", price: 10_000 }).expect(201);
      await agent.post("/api/listings").send({ title: "Vừa", price: 50_000 }).expect(201);
      await agent.post("/api/listings").send({ title: "Đắt", price: 500_000 }).expect(201);

      const res = await request(app).get("/api/listings?minPrice=20000&maxPrice=100000").expect(200);
      expect(res.body.items.map((l: { title: string }) => l.title)).toEqual(["Vừa"]);
    });

    it("rejects minPrice greater than maxPrice", async () => {
      await request(app).get("/api/listings?minPrice=100000&maxPrice=1000").expect(400);
    });

    it("sorts the browse endpoint by price ascending/descending, defaulting to newest first", async () => {
      const { agent } = await registerAndLoginActiveUser("sort-seller@example.com");
      await agent.post("/api/listings").send({ title: "B", price: 200_000 }).expect(201);
      await agent.post("/api/listings").send({ title: "A", price: 100_000 }).expect(201);
      await agent.post("/api/listings").send({ title: "C", price: 300_000 }).expect(201);

      const asc = await request(app).get("/api/listings?sort=price_asc").expect(200);
      expect(asc.body.items.map((l: { title: string }) => l.title)).toEqual(["A", "B", "C"]);

      const desc = await request(app).get("/api/listings?sort=price_desc").expect(200);
      expect(desc.body.items.map((l: { title: string }) => l.title)).toEqual(["C", "B", "A"]);

      const newest = await request(app).get("/api/listings").expect(200);
      expect(newest.body.items.map((l: { title: string }) => l.title)).toEqual(["C", "A", "B"]); // most recently created first
    });

    it("paginates the browse endpoint", async () => {
      const { agent } = await registerAndLoginActiveUser("page-seller@example.com");
      for (let i = 0; i < 5; i++) {
        await agent.post("/api/listings").send({ title: `Tin ${i}`, price: 10_000 + i }).expect(201);
      }

      const pageOne = await request(app).get("/api/listings?page=1&limit=2").expect(200);
      expect(pageOne.body.items).toHaveLength(2);
      expect(pageOne.body.total).toBe(5);

      const pageTwo = await request(app).get("/api/listings?page=2&limit=2").expect(200);
      expect(pageTwo.body.items).toHaveLength(2);
      expect(pageTwo.body.items[0].id).not.toBe(pageOne.body.items[0].id);
    });
  });

  describe("Create Transaction", () => {
    it("creates a CREATED/NONE transaction snapshotting the listing's price, no money moved", async () => {
      const { agent: sellerAgent } = await registerAndLoginActiveUser("seller5@example.com");
      const listing = await createListingAs(sellerAgent, 77_000);

      const { agent: buyerAgent, user: buyer } = await registerAndLoginActiveUser("buyer5@example.com");
      const res = await buyerAgent.post("/api/transactions").send({ listingId: listing.id }).expect(201);

      expect(res.body.status).toBe("CREATED");
      expect(res.body.escrowStatus).toBe("NONE");
      expect(res.body.amount).toBe(77_000);
      expect(res.body.buyerId).toBe(buyer.id);

      const buyerWallet = await testPrisma.wallet.findUniqueOrThrow({ where: { userId: buyer.id } });
      expect(buyerWallet.availableBalance).toBe(0); // unchanged — Create Transaction moves no money
    });

    it("rejects buying your own listing", async () => {
      const { agent } = await registerAndLoginActiveUser("selfbuy@example.com");
      const listing = await createListingAs(agent, 10_000);
      await agent.post("/api/transactions").send({ listingId: listing.id }).expect(400);
    });

    it("rejects a non-existent listing", async () => {
      const { agent } = await registerAndLoginActiveUser("buyer6@example.com");
      await agent.post("/api/transactions").send({ listingId: "does-not-exist" }).expect(404);
    });

    it("rejects creating a transaction against a listing that is no longer AVAILABLE", async () => {
      const { agent: sellerAgent } = await registerAndLoginActiveUser("seller7@example.com");
      const listing = await createListingAs(sellerAgent, 20_000);

      const { agent: buyer1, user: b1 } = await registerAndLoginActiveUser("buyer7a@example.com");
      await fundWallet(b1.id, 20_000);
      const tx1 = await buyer1.post("/api/transactions").send({ listingId: listing.id }).expect(201);
      await buyer1.post(`/api/transactions/${tx1.body.id}/lock`).expect(200);

      const { agent: buyer2 } = await registerAndLoginActiveUser("buyer7b@example.com");
      await buyer2.post("/api/transactions").send({ listingId: listing.id }).expect(409);
    });

    it("allows MULTIPLE CREATED transactions to reference the same listing before any of them locks", async () => {
      const { agent: sellerAgent } = await registerAndLoginActiveUser("seller8@example.com");
      const listing = await createListingAs(sellerAgent, 15_000);

      const { agent: buyer1 } = await registerAndLoginActiveUser("buyer8a@example.com");
      const { agent: buyer2 } = await registerAndLoginActiveUser("buyer8b@example.com");

      await buyer1.post("/api/transactions").send({ listingId: listing.id }).expect(201);
      await buyer2.post("/api/transactions").send({ listingId: listing.id }).expect(201);

      const count = await testPrisma.transaction.count({ where: { listingId: listing.id } });
      expect(count).toBe(2);
    });
  });

  describe("GET /api/transactions/:id — authorization", () => {
    it("lets the buyer and the seller view it, and blocks an unrelated user (IDOR)", async () => {
      const { agent: sellerAgent, user: seller } = await registerAndLoginActiveUser("seller9@example.com");
      const listing = await createListingAs(sellerAgent, 30_000);
      const { agent: buyerAgent, user: buyer } = await registerAndLoginActiveUser("buyer9@example.com");
      const txRes = await buyerAgent.post("/api/transactions").send({ listingId: listing.id }).expect(201);

      await buyerAgent.get(`/api/transactions/${txRes.body.id}`).expect(200);
      await sellerAgent.get(`/api/transactions/${txRes.body.id}`).expect(200);

      const { agent: strangerAgent } = await registerAndLoginActiveUser("stranger9@example.com");
      await strangerAgent.get(`/api/transactions/${txRes.body.id}`).expect(403);
      expect(seller.id).not.toBe(buyer.id);
    });
  });

  describe("LOCK", () => {
    it("locks the AMOUNT SNAPSHOTTED at Create Transaction time, never a re-read of the listing's current price", async () => {
      const { agent: sellerAgent } = await registerAndLoginActiveUser("seller-snapshot@example.com");
      const listing = await createListingAs(sellerAgent, 1_000_000);
      const { agent: buyerAgent, user: buyer } = await registerAndLoginActiveUser("buyer-snapshot@example.com");
      await fundWallet(buyer.id, 1_000_000);

      const txRes = await buyerAgent.post("/api/transactions").send({ listingId: listing.id }).expect(201);
      expect(txRes.body.amount).toBe(1_000_000);

      // There is no listing price-edit endpoint yet, but the CODE must
      // never re-derive the LOCK amount from listing.price at LOCK time
      // regardless — mutate it directly in the DB to prove the service
      // truly reads transaction.amount, not listing.price (Stage 4
      // review: "nếu hệ thống cho phép sửa giá listing... số tiền khóa
      // vẫn phải là 1.000.000 theo snapshot").
      await testPrisma.listing.update({ where: { id: listing.id }, data: { price: 2_500_000 } });

      const lockRes = await buyerAgent.post(`/api/transactions/${txRes.body.id}/lock`).expect(200);
      expect(lockRes.body.amount).toBe(1_000_000);

      const buyerWallet = await testPrisma.wallet.findUniqueOrThrow({ where: { userId: buyer.id } });
      expect(buyerWallet.availableBalance).toBe(0); // debited 1,000,000, not 2,500,000

      const escrow = await getEscrowWallet();
      expect(escrow.lockedBalance).toBe(1_000_000);

      const entries = await testPrisma.walletEntry.findMany({ where: { transactionId: txRes.body.id } });
      expect(entries.map((e) => Math.abs(e.deltaAvailable) + Math.abs(e.deltaLocked))).toEqual([1_000_000, 1_000_000]);
    });

    it("happy path: debits buyer, credits escrow, locks the listing, secures the transaction — atomically", async () => {
      const { agent: sellerAgent, user: seller } = await registerAndLoginActiveUser("seller10@example.com");
      const listing = await createListingAs(sellerAgent, 40_000);
      const { agent: buyerAgent, user: buyer } = await registerAndLoginActiveUser("buyer10@example.com");
      await fundWallet(buyer.id, 100_000);

      const txRes = await buyerAgent.post("/api/transactions").send({ listingId: listing.id }).expect(201);
      const lockRes = await buyerAgent.post(`/api/transactions/${txRes.body.id}/lock`).expect(200);

      expect(lockRes.body.status).toBe("SECURED");
      expect(lockRes.body.escrowStatus).toBe("LOCKED");

      const buyerWallet = await testPrisma.wallet.findUniqueOrThrow({ where: { userId: buyer.id } });
      expect(buyerWallet.availableBalance).toBe(60_000);
      expect(buyerWallet.version).toBe(1);

      const escrow = await getEscrowWallet();
      expect(escrow.lockedBalance).toBe(40_000);

      const listingAfter = await testPrisma.listing.findUniqueOrThrow({ where: { id: listing.id } });
      expect(listingAfter.status).toBe("LOCKED");
      expect(listingAfter.version).toBe(1);

      const entries = await testPrisma.walletEntry.findMany({ where: { transactionId: txRes.body.id } });
      expect(entries).toHaveLength(2);
      expect(seller.id).not.toBe(buyer.id);
    });

    it("insufficient balance: rejects, and rolls back BOTH the listing lock and any wallet change", async () => {
      const { agent: sellerAgent } = await registerAndLoginActiveUser("seller11@example.com");
      const listing = await createListingAs(sellerAgent, 500_000);
      const { agent: buyerAgent, user: buyer } = await registerAndLoginActiveUser("buyer11@example.com");
      await fundWallet(buyer.id, 1_000); // far short of 500,000

      const txRes = await buyerAgent.post("/api/transactions").send({ listingId: listing.id }).expect(201);
      await buyerAgent.post(`/api/transactions/${txRes.body.id}/lock`).expect(409);

      const buyerWallet = await testPrisma.wallet.findUniqueOrThrow({ where: { userId: buyer.id } });
      expect(buyerWallet.availableBalance).toBe(1_000);
      expect(buyerWallet.version).toBe(0);

      const listingAfter = await testPrisma.listing.findUniqueOrThrow({ where: { id: listing.id } });
      expect(listingAfter.status).toBe("AVAILABLE"); // rolled back, not left LOCKED
      expect(listingAfter.version).toBe(0);

      const transactionAfter = await testPrisma.transaction.findUniqueOrThrow({ where: { id: txRes.body.id } });
      expect(transactionAfter.status).toBe("CREATED"); // rolled back, not left SECURED

      expect(await testPrisma.walletEntry.count()).toBe(0);
    });

    it("rejects a LOCK attempt by someone other than the transaction's own buyer", async () => {
      const { agent: sellerAgent } = await registerAndLoginActiveUser("seller12@example.com");
      const listing = await createListingAs(sellerAgent, 10_000);
      const { agent: buyerAgent, user: buyer } = await registerAndLoginActiveUser("buyer12@example.com");
      await fundWallet(buyer.id, 10_000);
      const txRes = await buyerAgent.post("/api/transactions").send({ listingId: listing.id }).expect(201);

      const { agent: strangerAgent } = await registerAndLoginActiveUser("stranger12@example.com");
      await strangerAgent.post(`/api/transactions/${txRes.body.id}/lock`).expect(403);

      const transactionAfter = await testPrisma.transaction.findUniqueOrThrow({ where: { id: txRes.body.id } });
      expect(transactionAfter.status).toBe("CREATED");
    });

    it("re-submitting an already-SECURED transaction's lock is idempotent (200, same state, no second effect)", async () => {
      const { agent: sellerAgent } = await registerAndLoginActiveUser("seller13@example.com");
      const listing = await createListingAs(sellerAgent, 25_000);
      const { agent: buyerAgent, user: buyer } = await registerAndLoginActiveUser("buyer13@example.com");
      await fundWallet(buyer.id, 25_000);
      const txRes = await buyerAgent.post("/api/transactions").send({ listingId: listing.id }).expect(201);

      const first = await buyerAgent.post(`/api/transactions/${txRes.body.id}/lock`).expect(200);
      const second = await buyerAgent.post(`/api/transactions/${txRes.body.id}/lock`).expect(200);

      expect(first.body.status).toBe("SECURED");
      expect(second.body.status).toBe("SECURED");

      const buyerWallet = await testPrisma.wallet.findUniqueOrThrow({ where: { userId: buyer.id } });
      expect(buyerWallet.availableBalance).toBe(0);
      expect(buyerWallet.version).toBe(1); // debited exactly once
      expect(await testPrisma.walletEntry.count({ where: { transactionId: txRes.body.id } })).toBe(2);
    });

    it("the idempotent-retry fast path re-verifies ledger consistency instead of blindly trusting status===SECURED", async () => {
      const { agent: sellerAgent } = await registerAndLoginActiveUser("seller-corrupt@example.com");
      const listing = await createListingAs(sellerAgent, 12_000);
      const { agent: buyerAgent, user: buyer } = await registerAndLoginActiveUser("buyer-corrupt@example.com");
      await fundWallet(buyer.id, 12_000);
      const txRes = await buyerAgent.post("/api/transactions").send({ listingId: listing.id }).expect(201);
      await buyerAgent.post(`/api/transactions/${txRes.body.id}/lock`).expect(200);

      // Simulate a hypothetical bug elsewhere that left status=SECURED
      // without its matching LOCK wallet entries — the retry path must
      // refuse to silently report success in this state (500, not 200).
      await testPrisma.walletEntry.deleteMany({ where: { transactionId: txRes.body.id } });

      await buyerAgent.post(`/api/transactions/${txRes.body.id}/lock`).expect(500);
    });

    it("a second CREATED transaction for an already-LOCKED listing is rejected and stays CREATED forever (no CANCELLED state exists)", async () => {
      const { agent: sellerAgent } = await registerAndLoginActiveUser("seller14@example.com");
      const listing = await createListingAs(sellerAgent, 60_000);

      const { agent: buyer1, user: b1 } = await registerAndLoginActiveUser("buyer14a@example.com");
      const { agent: buyer2, user: b2 } = await registerAndLoginActiveUser("buyer14b@example.com");
      await fundWallet(b1.id, 60_000);
      await fundWallet(b2.id, 60_000);

      const tx1 = await buyer1.post("/api/transactions").send({ listingId: listing.id }).expect(201);
      const tx2 = await buyer2.post("/api/transactions").send({ listingId: listing.id }).expect(201);

      await buyer1.post(`/api/transactions/${tx1.body.id}/lock`).expect(200);
      await buyer2.post(`/api/transactions/${tx2.body.id}/lock`).expect(409);

      const tx2After = await testPrisma.transaction.findUniqueOrThrow({ where: { id: tx2.body.id } });
      expect(tx2After.status).toBe("CREATED");

      const b2WalletAfter = await testPrisma.wallet.findUniqueOrThrow({ where: { userId: b2.id } });
      expect(b2WalletAfter.availableBalance).toBe(60_000); // untouched — no partial debit for the loser
    });

    it("real concurrent LOCK on the SAME listing from two different transactions: exactly one wins, no double-lock, loser's wallet untouched", async () => {
      const { agent: sellerAgent } = await registerAndLoginActiveUser("seller15@example.com");
      const listing = await createListingAs(sellerAgent, 45_000);

      const { agent: buyer1, user: b1 } = await registerAndLoginActiveUser("buyer15a@example.com");
      const { agent: buyer2, user: b2 } = await registerAndLoginActiveUser("buyer15b@example.com");
      await fundWallet(b1.id, 45_000);
      await fundWallet(b2.id, 45_000);

      const tx1 = await buyer1.post("/api/transactions").send({ listingId: listing.id }).expect(201);
      const tx2 = await buyer2.post("/api/transactions").send({ listingId: listing.id }).expect(201);

      const [res1, res2] = await Promise.all([
        buyer1.post(`/api/transactions/${tx1.body.id}/lock`),
        buyer2.post(`/api/transactions/${tx2.body.id}/lock`),
      ]);

      const statuses = [res1.status, res2.status].sort();
      expect(statuses).toEqual([200, 409]);

      const listingAfter = await testPrisma.listing.findUniqueOrThrow({ where: { id: listing.id } });
      expect(listingAfter.status).toBe("LOCKED");
      expect(listingAfter.version).toBe(1); // locked exactly once, not twice

      const escrow = await getEscrowWallet();
      expect(escrow.lockedBalance).toBe(45_000); // exactly one LOCK's worth, never double

      const entries = await testPrisma.walletEntry.count();
      expect(entries).toBe(2); // one LOCK operation's worth (buyer debit + escrow credit)

      const winnerId = res1.status === 200 ? b1.id : b2.id;
      const loserId = res1.status === 200 ? b2.id : b1.id;
      const winnerWallet = await testPrisma.wallet.findUniqueOrThrow({ where: { userId: winnerId } });
      const loserWallet = await testPrisma.wallet.findUniqueOrThrow({ where: { userId: loserId } });
      expect(winnerWallet.availableBalance).toBe(0);
      expect(loserWallet.availableBalance).toBe(45_000); // completely untouched
    });
  });
});
