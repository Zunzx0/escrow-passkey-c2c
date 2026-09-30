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

async function makeAdmin(email = `admin-${Date.now()}-${Math.random()}@example.com`) {
  const admin = await registerAndLoginActiveUser(email);
  await testPrisma.user.update({ where: { id: admin.user.id }, data: { role: "ADMIN" } });
  return admin;
}

/** Drives a transaction to WAIT_CONFIRM, then buyer opens a dispute -> DISPUTED/FROZEN. */
async function setupDisputedTransaction(price = 80_000) {
  const seller = await registerAndLoginActiveUser(`seller-${Date.now()}-${Math.random()}@example.com`);
  const buyer = await registerAndLoginActiveUser(`buyer-${Date.now()}-${Math.random()}@example.com`);
  const listing = await createListingAs(seller.agent, price);
  await fundWallet(buyer.user.id, price);
  const txRes = await buyer.agent.post("/api/transactions").send({ listingId: listing.id }).expect(201);
  await buyer.agent.post(`/api/transactions/${txRes.body.id}/lock`).expect(200);
  await seller.agent.post(`/api/transactions/${txRes.body.id}/ship`).expect(200);
  await buyer.agent.post(`/api/transactions/${txRes.body.id}/receive`).expect(200);
  const disputeRes = await buyer.agent
    .post(`/api/transactions/${txRes.body.id}/dispute`)
    .send({ reason: "Sản phẩm lỗi." })
    .expect(201);

  return { seller, buyer, listing, transactionId: txRes.body.id as string, disputeId: disputeRes.body.id as string, price };
}

async function issueAdjudicationGrant(admin: UserHandle, disputeId: string, decision: "REFUND" | "RELEASE") {
  const optionsRes = await admin.agent
    .post(`/api/disputes/${disputeId}/adjudicate/reauth/options`)
    .send({ decision })
    .expect(200);
  const response = await buildAuthenticationResponse({
    rpID: RP_ID,
    origin: ORIGIN,
    challenge: optionsRes.body.challenge,
    credential: admin.credential,
    signCount: 1,
  });
  const verifyRes = await admin.agent
    .post(`/api/disputes/${disputeId}/adjudicate/reauth/verify`)
    .send({ decision, response })
    .expect(200);
  return verifyRes.body.token as string;
}

describe("Admin adjudication (Stage 9)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  describe("Admin reads", () => {
    it("GET /api/disputes lists disputes for admin, rejects non-admin", async () => {
      const { seller, buyer } = await setupDisputedTransaction();
      const admin = await makeAdmin();

      const res = await admin.agent.get("/api/disputes").expect(200);
      expect(res.body.length).toBeGreaterThanOrEqual(1);
      expect(res.body[0].transaction).toBeDefined();

      await seller.agent.get("/api/disputes").expect(403);
      await buyer.agent.get("/api/disputes").expect(403);
    });

    it("GET /api/disputes/:id returns the dispute + transaction for admin, 404 for unknown id", async () => {
      const { disputeId, transactionId } = await setupDisputedTransaction();
      const admin = await makeAdmin();

      const res = await admin.agent.get(`/api/disputes/${disputeId}`).expect(200);
      expect(res.body.transaction.id).toBe(transactionId);

      await admin.agent.get("/api/disputes/does-not-exist").expect(404);
    });
  });

  describe("Happy path", () => {
    it("decision=RELEASE: escrow -A, seller +A, transaction RELEASED/RELEASED, dispute RESOLVED (BA.md §9.4/§11)", async () => {
      const { seller, disputeId, transactionId, price } = await setupDisputedTransaction(70_000);
      const admin = await makeAdmin();
      const token = await issueAdjudicationGrant(admin, disputeId, "RELEASE");

      const res = await admin.agent
        .post(`/api/disputes/${disputeId}/adjudicate`)
        .send({ decision: "RELEASE", token, resolutionNote: "Người bán đúng." })
        .expect(200);
      expect(res.body.status).toBe("RELEASED");
      expect(res.body.escrowStatus).toBe("RELEASED");
      expect(res.body.releasedAt).not.toBeNull();

      const escrow = await getEscrowWallet();
      expect(escrow.lockedBalance).toBe(0);

      const sellerWallet = await testPrisma.wallet.findUniqueOrThrow({ where: { userId: seller.user.id } });
      expect(sellerWallet.availableBalance).toBe(price);

      const dispute = await testPrisma.dispute.findUniqueOrThrow({ where: { id: disputeId } });
      expect(dispute.status).toBe("RESOLVED");
      expect(dispute.decision).toBe("RELEASE");
      expect(dispute.resolvedById).toBe(admin.user.id);
      expect(dispute.resolutionNote).toBe("Người bán đúng.");
      expect(dispute.resolvedAt).not.toBeNull();

      const transaction = await testPrisma.transaction.findUniqueOrThrow({ where: { id: transactionId } });
      expect(transaction.refundedAt).toBeNull();
    });

    it("decision=REFUND: escrow -A, buyer +A, transaction REFUNDED/REFUNDED (BA.md §9.4/§11)", async () => {
      const { buyer, disputeId, transactionId, price } = await setupDisputedTransaction(45_000);
      const admin = await makeAdmin();
      const token = await issueAdjudicationGrant(admin, disputeId, "REFUND");

      const res = await admin.agent.post(`/api/disputes/${disputeId}/adjudicate`).send({ decision: "REFUND", token }).expect(200);
      expect(res.body.status).toBe("REFUNDED");
      expect(res.body.escrowStatus).toBe("REFUNDED");
      expect(res.body.refundedAt).not.toBeNull();

      const escrow = await getEscrowWallet();
      expect(escrow.lockedBalance).toBe(0);

      const buyerWallet = await testPrisma.wallet.findUniqueOrThrow({ where: { userId: buyer.user.id } });
      expect(buyerWallet.availableBalance).toBe(price); // buyer originally paid `price` at LOCK, now refunded

      const dispute = await testPrisma.dispute.findUniqueOrThrow({ where: { id: disputeId } });
      expect(dispute.status).toBe("RESOLVED");
      expect(dispute.decision).toBe("REFUND");

      const transaction = await testPrisma.transaction.findUniqueOrThrow({ where: { id: transactionId } });
      expect(transaction.releasedAt).toBeNull();
    });

    it("end-to-end: Σdelta=0 across the WHOLE transaction's ledger history (LOCK + adjudicate)", async () => {
      const { seller, buyer, disputeId, transactionId, price } = await setupDisputedTransaction(123_000);
      const admin = await makeAdmin();
      const token = await issueAdjudicationGrant(admin, disputeId, "RELEASE");
      await admin.agent.post(`/api/disputes/${disputeId}/adjudicate`).send({ decision: "RELEASE", token }).expect(200);

      const buyerWallet = await testPrisma.wallet.findUniqueOrThrow({ where: { userId: buyer.user.id } });
      const sellerWallet = await testPrisma.wallet.findUniqueOrThrow({ where: { userId: seller.user.id } });
      expect(buyerWallet.availableBalance).toBe(0);
      expect(sellerWallet.availableBalance).toBe(price);

      const txEntries = await testPrisma.walletEntry.findMany({ where: { transactionId } });
      const sumDelta = txEntries.reduce((s, e) => s + e.deltaAvailable + e.deltaLocked, 0);
      expect(sumDelta).toBe(0); // LOCK + adjudicate(RELEASE) together net to zero
    });
  });

  describe("Authorization", () => {
    it("rejects a non-admin (buyer/seller/stranger) at every adjudication endpoint", async () => {
      const { seller, buyer, disputeId } = await setupDisputedTransaction();
      const stranger = await registerAndLoginActiveUser("stranger-adjudicate@example.com");

      for (const actor of [seller, buyer, stranger]) {
        await actor.agent.post(`/api/disputes/${disputeId}/adjudicate/reauth/options`).send({ decision: "RELEASE" }).expect(403);
        await actor.agent.post(`/api/disputes/${disputeId}/adjudicate`).send({ decision: "RELEASE", token: "x" }).expect(403);
      }
    });
  });

  describe("Grant scoping (BA.md §15 invariant #5: đúng hồ sơ tranh chấp + đúng quyết định)", () => {
    it("rejects a grant issued for REFUND when the adjudicate call claims RELEASE", async () => {
      const { disputeId } = await setupDisputedTransaction();
      const admin = await makeAdmin();
      const token = await issueAdjudicationGrant(admin, disputeId, "REFUND");

      await admin.agent.post(`/api/disputes/${disputeId}/adjudicate`).send({ decision: "RELEASE", token }).expect(403);

      const dispute = await testPrisma.dispute.findUniqueOrThrow({ where: { id: disputeId } });
      expect(dispute.status).toBe("OPEN"); // unchanged
    });

    it("rejects a grant scoped to a DIFFERENT dispute, even for the same admin and same decision", async () => {
      const a = await setupDisputedTransaction();
      const b = await setupDisputedTransaction();
      const admin = await makeAdmin();
      const tokenForB = await issueAdjudicationGrant(admin, b.disputeId, "RELEASE");

      await admin.agent.post(`/api/disputes/${a.disputeId}/adjudicate`).send({ decision: "RELEASE", token: tokenForB }).expect(403);
    });

    it("rejects an expired grant", async () => {
      const { disputeId } = await setupDisputedTransaction();
      const admin = await makeAdmin();
      const token = await issueAdjudicationGrant(admin, disputeId, "RELEASE");
      await testPrisma.reauthGrant.updateMany({ where: { disputeId }, data: { expiresAt: new Date(Date.now() - 1000) } });

      await admin.agent.post(`/api/disputes/${disputeId}/adjudicate`).send({ decision: "RELEASE", token }).expect(409);
    });

    it("rejects a garbage/invalid token", async () => {
      const { disputeId } = await setupDisputedTransaction();
      const admin = await makeAdmin();

      await admin.agent.post(`/api/disputes/${disputeId}/adjudicate`).send({ decision: "RELEASE", token: "garbage" }).expect(401);
    });
  });

  describe("State machine discipline", () => {
    it("rejects adjudicating a transaction that was never disputed", async () => {
      const seller = await registerAndLoginActiveUser("seller-not-disputed@example.com");
      const buyer = await registerAndLoginActiveUser("buyer-not-disputed@example.com");
      const listing = await createListingAs(seller.agent, 10_000);
      await fundWallet(buyer.user.id, 10_000);
      const txRes = await buyer.agent.post("/api/transactions").send({ listingId: listing.id }).expect(201);
      await buyer.agent.post(`/api/transactions/${txRes.body.id}/lock`).expect(200); // SECURED, never disputed

      const admin = await makeAdmin();
      await admin.agent.post(`/api/disputes/does-not-exist/adjudicate/reauth/options`).send({ decision: "RELEASE" }).expect(404);
    });

    it("BA.md §15 invariant #3: once settled one way, adjudicating with the OTHER decision 409s instead of double-settling", async () => {
      const { disputeId } = await setupDisputedTransaction();
      const admin = await makeAdmin();

      const firstToken = await issueAdjudicationGrant(admin, disputeId, "RELEASE");
      await admin.agent.post(`/api/disputes/${disputeId}/adjudicate`).send({ decision: "RELEASE", token: firstToken }).expect(200);

      // A second, independently-issued grant for REFUND on the SAME
      // already-resolved dispute must never be allowed to flip the outcome
      // — loadAdjudicatableDispute fails fast: the transaction is no
      // longer DISPUTED, so it 409s before a new grant can even be issued.
      await admin.agent.post(`/api/disputes/${disputeId}/adjudicate/reauth/options`).send({ decision: "REFUND" }).expect(409);
    });

    it("is idempotent: re-POSTing the same decision after success returns 200 without re-touching the (now-used) grant", async () => {
      const { seller, disputeId, price } = await setupDisputedTransaction(33_000);
      const admin = await makeAdmin();
      const token = await issueAdjudicationGrant(admin, disputeId, "RELEASE");

      const first = await admin.agent.post(`/api/disputes/${disputeId}/adjudicate`).send({ decision: "RELEASE", token }).expect(200);
      expect(first.body.status).toBe("RELEASED");

      const second = await admin.agent.post(`/api/disputes/${disputeId}/adjudicate`).send({ decision: "RELEASE", token }).expect(200);
      expect(second.body.status).toBe("RELEASED");

      const sellerWallet = await testPrisma.wallet.findUniqueOrThrow({ where: { userId: seller.user.id } });
      expect(sellerWallet.availableBalance).toBe(price); // credited exactly once
      expect(sellerWallet.version).toBe(1);
    });
  });

  describe("Concurrency", () => {
    it("5 concurrent adjudicate calls with the SAME grant token -> exactly one financial effect", async () => {
      const { seller, disputeId, price } = await setupDisputedTransaction(50_000);
      const admin = await makeAdmin();
      const token = await issueAdjudicationGrant(admin, disputeId, "RELEASE");

      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () => admin.agent.post(`/api/disputes/${disputeId}/adjudicate`).send({ decision: "RELEASE", token }))
      );
      const succeeded = results.filter((r) => r.status === "fulfilled" && (r as PromiseFulfilledResult<{ status: number }>).value.status === 200);
      expect(succeeded.length).toBeGreaterThan(0);

      const sellerWallet = await testPrisma.wallet.findUniqueOrThrow({ where: { userId: seller.user.id } });
      expect(sellerWallet.availableBalance).toBe(price);
      expect(sellerWallet.version).toBe(1);

      const escrow = await getEscrowWallet();
      expect(escrow.lockedBalance).toBe(0);
      expect(await testPrisma.walletEntry.count({ where: { walletId: sellerWallet.id, entryType: "RELEASE" } })).toBe(1);
    });
  });
});
