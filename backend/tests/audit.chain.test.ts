import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resetTestDb, testPrisma } from "./helpers/db";
import { fundWallet, ORIGIN, RP_ID, registerAndLoginActiveUser } from "./helpers/authFlow";
import { buildAuthenticationResponse } from "./helpers/virtualAuthenticator";
import { GENESIS_HASH, verifyAuditChain } from "../src/services/audit.service";

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

async function getChain(transactionId: string) {
  return testPrisma.auditLog.findMany({ where: { transactionId }, orderBy: { seqNo: "asc" } });
}

describe("Audit chain + verifier (Stage 10 / roadmap bước 20)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  describe("Writing — happy path", () => {
    it("LOCK -> seller-ack -> ship -> receive -> RELEASE writes a correctly-linked 5-record chain", async () => {
      const seller = await registerAndLoginActiveUser(`seller-${Date.now()}-${Math.random()}@example.com`);
      const buyer = await registerAndLoginActiveUser(`buyer-${Date.now()}-${Math.random()}@example.com`);
      const listing = await createListingAs(seller.agent, 90_000);
      await fundWallet(buyer.user.id, 90_000);

      const txRes = await buyer.agent.post("/api/transactions").send({ listingId: listing.id }).expect(201);
      const transactionId = txRes.body.id as string;
      // Create Transaction itself writes NO audit entry — only LOCK onward
      // does (BA.md §16 only names state transitions + business
      // milestones, and CREATED/NONE is neither — it's the starting point).
      expect(await getChain(transactionId)).toHaveLength(0);

      await buyer.agent.post(`/api/transactions/${transactionId}/lock`).expect(200);
      await seller.agent.post(`/api/transactions/${transactionId}/seller-ack`).expect(200);
      await seller.agent.post(`/api/transactions/${transactionId}/ship`).expect(200);
      await buyer.agent.post(`/api/transactions/${transactionId}/receive`).expect(200);

      const optionsRes = await buyer.agent.post(`/api/transactions/${transactionId}/release/reauth/options`).expect(200);
      const response = await buildAuthenticationResponse({
        rpID: RP_ID,
        origin: ORIGIN,
        challenge: optionsRes.body.challenge,
        credential: buyer.credential,
        signCount: 1,
      });
      const verifyRes = await buyer.agent.post(`/api/transactions/${transactionId}/release/reauth/verify`).send({ response }).expect(200);
      await buyer.agent.post(`/api/transactions/${transactionId}/release`).send({ token: verifyRes.body.token }).expect(200);

      const chain = await getChain(transactionId);
      expect(chain.map((r) => r.action)).toEqual(["LOCK", "SELLER_ACK", "SHIP", "RECEIVE", "RELEASE"]);
      expect(chain.map((r) => r.seqNo)).toEqual([1, 2, 3, 4, 5]);
      expect(chain.map((r) => r.actorId)).toEqual([
        buyer.user.id,
        seller.user.id,
        seller.user.id,
        buyer.user.id,
        buyer.user.id,
      ]);

      // BA.md §16: first record chains from H0 = 0^256.
      expect(chain[0].prevHash).toBe(GENESIS_HASH);
      expect(chain[0].prevHash).toHaveLength(64);
      // Every subsequent record's prev_hash === the previous record's current_hash.
      for (let i = 1; i < chain.length; i++) {
        expect(chain[i].prevHash).toBe(chain[i - 1].currentHash);
      }
      // Every current_hash is a real 64-hex-char SHA-256 digest, and no two collide.
      for (const record of chain) {
        expect(record.currentHash).toMatch(/^[0-9a-f]{64}$/);
      }
      expect(new Set(chain.map((r) => r.currentHash)).size).toBe(chain.length);

      const result = await verifyAuditChain(testPrisma, { transactionId });
      expect(result).toEqual({ valid: true, recordCount: 5 });
    });

    it("dispute + admin adjudication (decision=REFUND) writes DISPUTE_OPENED then ADJUDICATE_REFUND, chain still verifies", async () => {
      const seller = await registerAndLoginActiveUser(`seller-${Date.now()}-${Math.random()}@example.com`);
      const buyer = await registerAndLoginActiveUser(`buyer-${Date.now()}-${Math.random()}@example.com`);
      const listing = await createListingAs(seller.agent, 40_000);
      await fundWallet(buyer.user.id, 40_000);
      const txRes = await buyer.agent.post("/api/transactions").send({ listingId: listing.id }).expect(201);
      const transactionId = txRes.body.id as string;

      await buyer.agent.post(`/api/transactions/${transactionId}/lock`).expect(200);
      await seller.agent.post(`/api/transactions/${transactionId}/ship`).expect(200);
      await buyer.agent.post(`/api/transactions/${transactionId}/receive`).expect(200);
      const disputeRes = await buyer.agent.post(`/api/transactions/${transactionId}/dispute`).send({ reason: "Hàng lỗi." }).expect(201);
      const disputeId = disputeRes.body.id as string;

      const admin = await makeAdmin();
      // No resolutionNote passed — proves the null-exclusion canonicalization
      // rule (BA.md §17.6) doesn't break write-then-verify consistency.
      const optionsRes = await admin.agent
        .post(`/api/disputes/${disputeId}/adjudicate/reauth/options`)
        .send({ decision: "REFUND" })
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
        .send({ decision: "REFUND", response })
        .expect(200);
      await admin.agent.post(`/api/disputes/${disputeId}/adjudicate`).send({ decision: "REFUND", token: verifyRes.body.token }).expect(200);

      const chain = await getChain(transactionId);
      expect(chain.map((r) => r.action)).toEqual(["LOCK", "SHIP", "RECEIVE", "DISPUTE_OPENED", "ADJUDICATE_REFUND"]);
      expect(chain.map((r) => r.seqNo)).toEqual([1, 2, 3, 4, 5]);
      expect(chain[3].actorId).toBe(buyer.user.id); // opened the dispute
      expect(chain[4].actorId).toBe(admin.user.id); // adjudicated it
      const data4 = chain[4].data as Record<string, unknown>;
      expect(data4.disputeId).toBe(disputeId);
      expect(data4.decision).toBe("REFUND");

      const result = await verifyAuditChain(testPrisma, { transactionId });
      expect(result).toEqual({ valid: true, recordCount: 5 });
    });
  });

  describe("Writing — idempotent retries never duplicate an audit entry", () => {
    it("LOCK/seller-ack/ship/receive called twice each still produce exactly ONE record per action", async () => {
      const seller = await registerAndLoginActiveUser(`seller-${Date.now()}-${Math.random()}@example.com`);
      const buyer = await registerAndLoginActiveUser(`buyer-${Date.now()}-${Math.random()}@example.com`);
      const listing = await createListingAs(seller.agent, 60_000);
      await fundWallet(buyer.user.id, 60_000);
      const txRes = await buyer.agent.post("/api/transactions").send({ listingId: listing.id }).expect(201);
      const transactionId = txRes.body.id as string;

      await buyer.agent.post(`/api/transactions/${transactionId}/lock`).expect(200);
      await buyer.agent.post(`/api/transactions/${transactionId}/lock`).expect(200); // retry
      await seller.agent.post(`/api/transactions/${transactionId}/seller-ack`).expect(200);
      await seller.agent.post(`/api/transactions/${transactionId}/seller-ack`).expect(200); // retry
      await seller.agent.post(`/api/transactions/${transactionId}/ship`).expect(200);
      await seller.agent.post(`/api/transactions/${transactionId}/ship`).expect(200); // retry
      await buyer.agent.post(`/api/transactions/${transactionId}/receive`).expect(200);
      await buyer.agent.post(`/api/transactions/${transactionId}/receive`).expect(200); // retry

      const chain = await getChain(transactionId);
      expect(chain.map((r) => r.action)).toEqual(["LOCK", "SELLER_ACK", "SHIP", "RECEIVE"]);
      expect(chain.map((r) => r.seqNo)).toEqual([1, 2, 3, 4]);

      const result = await verifyAuditChain(testPrisma, { transactionId });
      expect(result).toEqual({ valid: true, recordCount: 4 });
    });
  });

  describe("Verifier — tamper detection (BA.md §23 'Audit' adversarial list)", () => {
    async function buildThreeRecordChain() {
      const seller = await registerAndLoginActiveUser(`seller-${Date.now()}-${Math.random()}@example.com`);
      const buyer = await registerAndLoginActiveUser(`buyer-${Date.now()}-${Math.random()}@example.com`);
      const listing = await createListingAs(seller.agent, 30_000);
      await fundWallet(buyer.user.id, 30_000);
      const txRes = await buyer.agent.post("/api/transactions").send({ listingId: listing.id }).expect(201);
      const transactionId = txRes.body.id as string;
      await buyer.agent.post(`/api/transactions/${transactionId}/lock`).expect(200);
      await seller.agent.post(`/api/transactions/${transactionId}/seller-ack`).expect(200);
      await seller.agent.post(`/api/transactions/${transactionId}/ship`).expect(200);
      return transactionId;
    }

    it("passes on an untouched chain", async () => {
      const transactionId = await buildThreeRecordChain();
      expect(await verifyAuditChain(testPrisma, { transactionId })).toEqual({ valid: true, recordCount: 3 });
    });

    it("detects content tampering ('Sửa nội dung bản ghi giữa chuỗi')", async () => {
      const transactionId = await buildThreeRecordChain();
      await testPrisma.auditLog.updateMany({ where: { transactionId, seqNo: 2 }, data: { action: "TAMPERED" } });

      const result = await verifyAuditChain(testPrisma, { transactionId });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.brokenAtSeqNo).toBe(2);
        expect(result.reason).toContain("current_hash");
      }
    });

    it("detects prev_hash tampering ('Sửa prev_hash')", async () => {
      const transactionId = await buildThreeRecordChain();
      await testPrisma.auditLog.updateMany({ where: { transactionId, seqNo: 2 }, data: { prevHash: "f".repeat(64) } });

      const result = await verifyAuditChain(testPrisma, { transactionId });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.brokenAtSeqNo).toBe(2);
        expect(result.reason).toContain("prev_hash");
      }
    });

    it("detects seq_no tampering ('Sửa seq_no')", async () => {
      const transactionId = await buildThreeRecordChain();
      // Move the MIDDLE record to an unused seq_no — breaks the 1..N contiguity.
      await testPrisma.auditLog.updateMany({ where: { transactionId, seqNo: 2 }, data: { seqNo: 99 } });

      const result = await verifyAuditChain(testPrisma, { transactionId });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toContain("seq_no");
      }
    });

    it("detects a deleted middle record ('Xóa bản ghi giữa chuỗi')", async () => {
      const transactionId = await buildThreeRecordChain();
      await testPrisma.auditLog.deleteMany({ where: { transactionId, seqNo: 2 } });

      const result = await verifyAuditChain(testPrisma, { transactionId });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.brokenAtSeqNo).toBe(3); // the next real record, now in the wrong position
        expect(result.reason).toContain("seq_no");
      }
    });

    it("an empty chain (no audited actions yet) is trivially valid", async () => {
      const buyer = await registerAndLoginActiveUser(`buyer-${Date.now()}-${Math.random()}@example.com`);
      const seller = await registerAndLoginActiveUser(`seller-${Date.now()}-${Math.random()}@example.com`);
      const listing = await createListingAs(seller.agent, 10_000);
      const txRes = await buyer.agent.post("/api/transactions").send({ listingId: listing.id }).expect(201);

      const result = await verifyAuditChain(testPrisma, { transactionId: txRes.body.id });
      expect(result).toEqual({ valid: true, recordCount: 0 });
    });
  });
});
