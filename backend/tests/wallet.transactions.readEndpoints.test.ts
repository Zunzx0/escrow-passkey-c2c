import { afterAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app";
import { resetTestDb, testPrisma } from "./helpers/db";
import { fundWallet, registerAndLoginActiveUser } from "./helpers/authFlow";

type UserHandle = Awaited<ReturnType<typeof registerAndLoginActiveUser>>;

async function createListingAs(agent: UserHandle["agent"], price = 50_000) {
  const res = await agent.post("/api/listings").send({ title: "Áo thun demo", price }).expect(201);
  return res.body as { id: string; price: number };
}

// Added alongside the frontend build (2026-09-18) — these two read-only
// endpoints exist purely so a signed-in user can see their own balance
// and navigate back to their own transactions. Neither mutates anything.
describe("GET /api/wallet/me and GET /api/transactions/mine", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  it("returns the caller's own wallet balance", async () => {
    const { agent, user } = await registerAndLoginActiveUser("wallet-read@example.com");
    await fundWallet(user.id, 12_345);

    const res = await agent.get("/api/wallet/me").expect(200);
    expect(res.body).toEqual({ availableBalance: 12_345, lockedBalance: 0, version: 0 });
  });

  it("requires authentication", async () => {
    await request(app).get("/api/wallet/me").expect(401);
  });

  it("lists only the caller's own transactions, as buyer or seller, never anyone else's", async () => {
    const seller = await registerAndLoginActiveUser("mine-seller@example.com");
    const buyer = await registerAndLoginActiveUser("mine-buyer@example.com");
    const stranger = await registerAndLoginActiveUser("mine-stranger@example.com");

    const listing = await createListingAs(seller.agent, 40_000);
    const txRes = await buyer.agent.post("/api/transactions").send({ listingId: listing.id }).expect(201);

    const buyerList = await buyer.agent.get("/api/transactions/mine").expect(200);
    expect(buyerList.body.map((t: { id: string }) => t.id)).toContain(txRes.body.id);

    const sellerList = await seller.agent.get("/api/transactions/mine").expect(200);
    expect(sellerList.body.map((t: { id: string }) => t.id)).toContain(txRes.body.id);

    const strangerList = await stranger.agent.get("/api/transactions/mine").expect(200);
    expect(strangerList.body).toHaveLength(0);
  });

  it("lists only the caller's own wallet entries, most recent first, never another user's or the escrow's", async () => {
    const seller = await registerAndLoginActiveUser("entries-seller@example.com");
    const buyer = await registerAndLoginActiveUser("entries-buyer@example.com");
    const listing = await createListingAs(seller.agent, 25_000);
    await fundWallet(buyer.user.id, 25_000);
    const txRes = await buyer.agent.post("/api/transactions").send({ listingId: listing.id }).expect(201);
    await buyer.agent.post(`/api/transactions/${txRes.body.id}/lock`).expect(200);

    const buyerEntries = await buyer.agent.get("/api/wallet/me/entries").expect(200);
    expect(buyerEntries.body).toHaveLength(1);
    expect(buyerEntries.body[0]).toMatchObject({ entryType: "LOCK", deltaAvailable: -25_000, transactionId: txRes.body.id });

    const sellerEntries = await seller.agent.get("/api/wallet/me/entries").expect(200);
    expect(sellerEntries.body).toHaveLength(0); // seller's own wallet untouched by LOCK
  });
});
