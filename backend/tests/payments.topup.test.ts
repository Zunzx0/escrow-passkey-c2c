import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app";
import { resetTestDb, testPrisma } from "./helpers/db";
import { registerAndLoginActiveUser } from "./helpers/authFlow";
import { signMockProviderPayload, type MockProviderCallbackPayload } from "../src/services/mockProvider.service";
import { verifyAuditChain } from "../src/services/audit.service";

type UserHandle = Awaited<ReturnType<typeof registerAndLoginActiveUser>>;

async function createTopUp(user: UserHandle, amount = 100_000, idempotencyKey = randomUUID()) {
  const res = await user.agent.post("/api/payments/topup").send({ amount, idempotencyKey }).expect(201);
  return res.body as { id: string; providerReference: string; amount: number; status: string; idempotencyKey: string };
}

describe("Mock Payment Provider + Top-up (Stage 11 / roadmap bước 21)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  describe("Creating a top-up request", () => {
    it("creates a PENDING PaymentRequest with a server-generated providerReference", async () => {
      const buyer = await registerAndLoginActiveUser(`buyer-${Date.now()}-${Math.random()}@example.com`);
      const paymentRequest = await createTopUp(buyer, 150_000);

      expect(paymentRequest.status).toBe("PENDING");
      expect(paymentRequest.amount).toBe(150_000);
      expect(paymentRequest.providerReference).toMatch(/^mock_pr_/);

      const wallet = await testPrisma.wallet.findUniqueOrThrow({ where: { userId: buyer.user.id } });
      expect(wallet.availableBalance).toBe(0); // creating the REQUEST never credits anything by itself
    });

    it("requires authentication", async () => {
      await request(app).post("/api/payments/topup").send({ amount: 10_000, idempotencyKey: randomUUID() }).expect(401);
    });

    it("is idempotent on (userId, idempotencyKey, amount): retrying the SAME key+amount returns the SAME request, not a duplicate", async () => {
      const buyer = await registerAndLoginActiveUser(`buyer-${Date.now()}-${Math.random()}@example.com`);
      const key = randomUUID();
      const first = await createTopUp(buyer, 80_000, key);
      const second = await createTopUp(buyer, 80_000, key);
      expect(second.id).toBe(first.id);

      const count = await testPrisma.paymentRequest.count({ where: { userId: buyer.user.id } });
      expect(count).toBe(1);
    });

    it("rejects the SAME idempotencyKey reused with a DIFFERENT amount (ke-hoach §11 'Same key/different payload -> 409')", async () => {
      const buyer = await registerAndLoginActiveUser(`buyer-${Date.now()}-${Math.random()}@example.com`);
      const key = randomUUID();
      await createTopUp(buyer, 80_000, key);
      await buyer.agent.post("/api/payments/topup").send({ amount: 90_000, idempotencyKey: key }).expect(409);
    });

    it("rejects a negative or zero amount, and an amount above the Postgres Int4 ceiling (ke-hoach §19 'Amount âm/0' / 'Amount lớn')", async () => {
      const buyer = await registerAndLoginActiveUser(`buyer-${Date.now()}-${Math.random()}@example.com`);
      await buyer.agent.post("/api/payments/topup").send({ amount: 0, idempotencyKey: randomUUID() }).expect(400);
      await buyer.agent.post("/api/payments/topup").send({ amount: -5000, idempotencyKey: randomUUID() }).expect(400);
      await buyer.agent.post("/api/payments/topup").send({ amount: 3_000_000_000, idempotencyKey: randomUUID() }).expect(400);
    });
  });

  describe("Reading — scoped to the owner", () => {
    it("GET /api/payments/mine only ever returns the caller's own requests", async () => {
      const buyer = await registerAndLoginActiveUser(`buyer-${Date.now()}-${Math.random()}@example.com`);
      const stranger = await registerAndLoginActiveUser(`stranger-${Date.now()}-${Math.random()}@example.com`);
      await createTopUp(buyer, 20_000);
      await createTopUp(stranger, 30_000);

      const res = await buyer.agent.get("/api/payments/mine").expect(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].amount).toBe(20_000);
    });

    it("GET /api/payments/:id rejects a non-owner with 403", async () => {
      const buyer = await registerAndLoginActiveUser(`buyer-${Date.now()}-${Math.random()}@example.com`);
      const stranger = await registerAndLoginActiveUser(`stranger-${Date.now()}-${Math.random()}@example.com`);
      const paymentRequest = await createTopUp(buyer, 20_000);

      await stranger.agent.get(`/api/payments/${paymentRequest.id}`).expect(403);
      await buyer.agent.get(`/api/payments/${paymentRequest.id}`).expect(200);
    });
  });

  describe("Happy path via /simulate (SUCCEEDED)", () => {
    it("credits availableBalance (never lockedBalance), marks SUCCEEDED, logs the callback, writes an audit entry", async () => {
      const buyer = await registerAndLoginActiveUser(`buyer-${Date.now()}-${Math.random()}@example.com`);
      const paymentRequest = await createTopUp(buyer, 250_000);

      const res = await buyer.agent.post(`/api/payments/${paymentRequest.id}/simulate`).send({ status: "SUCCEEDED" }).expect(200);
      expect(res.body).toEqual({ outcome: "CREDITED", paymentRequestId: paymentRequest.id });

      const wallet = await testPrisma.wallet.findUniqueOrThrow({ where: { userId: buyer.user.id } });
      expect(wallet.availableBalance).toBe(250_000);
      expect(wallet.lockedBalance).toBe(0);

      const settled = await testPrisma.paymentRequest.findUniqueOrThrow({ where: { id: paymentRequest.id } });
      expect(settled.status).toBe("SUCCEEDED");

      const entries = await testPrisma.walletEntry.findMany({ where: { paymentRequestId: paymentRequest.id } });
      expect(entries).toHaveLength(1);
      expect(entries[0].entryType).toBe("TOPUP");
      expect(entries[0].deltaAvailable).toBe(250_000);
      expect(entries[0].deltaLocked).toBe(0);

      const callbacks = await testPrisma.paymentCallback.findMany({ where: { paymentRequestId: paymentRequest.id } });
      expect(callbacks).toHaveLength(1);
      expect(callbacks[0].signatureValid).toBe(true);
      expect(callbacks[0].reportedStatus).toBe("SUCCEEDED");
      expect(callbacks[0].processedAt).not.toBeNull();

      // Cross-stage integration: the generic verifier built in Stage 10
      // (only ever exercised against Transaction chains until now) works
      // correctly against a PaymentRequest chain too.
      const chain = await testPrisma.auditLog.findMany({ where: { paymentRequestId: paymentRequest.id } });
      expect(chain.map((c) => c.action)).toEqual(["TOPUP_SUCCEEDED"]);
      expect(chain[0].actorId).toBeNull(); // no human actor — the (mock) provider triggered this
      const verifyResult = await verifyAuditChain(testPrisma, { paymentRequestId: paymentRequest.id });
      expect(verifyResult).toEqual({ valid: true, recordCount: 1 });
    });

    it("ke-hoach §19 'Duplicate webhook SUCCESS ×10 -> Top-up một lần': 10 DISTINCT success events credit exactly once", async () => {
      const buyer = await registerAndLoginActiveUser(`buyer-${Date.now()}-${Math.random()}@example.com`);
      const paymentRequest = await createTopUp(buyer, 40_000);

      const results = await Promise.all(
        Array.from({ length: 10 }).map(() => buyer.agent.post(`/api/payments/${paymentRequest.id}/simulate`).send({ status: "SUCCEEDED" }))
      );
      expect(results.every((r) => r.status === 200)).toBe(true);
      const credited = results.filter((r) => r.body.outcome === "CREDITED");
      expect(credited).toHaveLength(1); // exactly one of the 10 distinct events actually credited

      const wallet = await testPrisma.wallet.findUniqueOrThrow({ where: { userId: buyer.user.id } });
      expect(wallet.availableBalance).toBe(40_000); // not 400_000

      const callbacks = await testPrisma.paymentCallback.count({ where: { paymentRequestId: paymentRequest.id } });
      expect(callbacks).toBe(10); // every distinct event is still logged, even the 9 that had no further effect

      const entries = await testPrisma.walletEntry.count({ where: { paymentRequestId: paymentRequest.id } });
      expect(entries).toBe(1);
    });

    it("replaying the IDENTICAL callback delivery (same eventId) is a no-op REPLAYED_DUPLICATE, not a second log row", async () => {
      const buyer = await registerAndLoginActiveUser(`buyer-${Date.now()}-${Math.random()}@example.com`);
      const paymentRequest = await createTopUp(buyer, 60_000);
      const sameEventId = "evt_fixed_delivery_id";

      const first = await buyer.agent.post(`/api/payments/${paymentRequest.id}/simulate`).send({ status: "SUCCEEDED", eventId: sameEventId }).expect(200);
      expect(first.body.outcome).toBe("CREDITED");
      const second = await buyer.agent.post(`/api/payments/${paymentRequest.id}/simulate`).send({ status: "SUCCEEDED", eventId: sameEventId }).expect(200);
      expect(second.body.outcome).toBe("REPLAYED_DUPLICATE");

      const wallet = await testPrisma.wallet.findUniqueOrThrow({ where: { userId: buyer.user.id } });
      expect(wallet.availableBalance).toBe(60_000);
      expect(await testPrisma.paymentCallback.count({ where: { paymentRequestId: paymentRequest.id } })).toBe(1); // the replay wrote nothing new
    });

    it("works correctly on a request that's been sitting PENDING for a while ('Delayed webhook -> State đúng')", async () => {
      const buyer = await registerAndLoginActiveUser(`buyer-${Date.now()}-${Math.random()}@example.com`);
      const paymentRequest = await createTopUp(buyer, 15_000);
      // Simulate the passage of time / unrelated activity before the
      // provider's callback finally arrives — no hidden expiry should block it.
      await testPrisma.paymentRequest.update({ where: { id: paymentRequest.id }, data: { createdAt: new Date(Date.now() - 3_600_000) } });

      const res = await buyer.agent.post(`/api/payments/${paymentRequest.id}/simulate`).send({ status: "SUCCEEDED" }).expect(200);
      expect(res.body.outcome).toBe("CREDITED");
      const wallet = await testPrisma.wallet.findUniqueOrThrow({ where: { userId: buyer.user.id } });
      expect(wallet.availableBalance).toBe(15_000);
    });
  });

  describe("Negative outcomes — FAILED / TIMEOUT / PENDING", () => {
    it("FAILED: status set, no wallet effect, audit entry TOPUP_FAILED", async () => {
      const buyer = await registerAndLoginActiveUser(`buyer-${Date.now()}-${Math.random()}@example.com`);
      const paymentRequest = await createTopUp(buyer, 20_000);

      const res = await buyer.agent.post(`/api/payments/${paymentRequest.id}/simulate`).send({ status: "FAILED" }).expect(200);
      expect(res.body.outcome).toBe("FAILED");

      const settled = await testPrisma.paymentRequest.findUniqueOrThrow({ where: { id: paymentRequest.id } });
      expect(settled.status).toBe("FAILED");
      const wallet = await testPrisma.wallet.findUniqueOrThrow({ where: { userId: buyer.user.id } });
      expect(wallet.availableBalance).toBe(0);
      const chain = await testPrisma.auditLog.findMany({ where: { paymentRequestId: paymentRequest.id } });
      expect(chain.map((c) => c.action)).toEqual(["TOPUP_FAILED"]);
    });

    it("TIMEOUT: status set, no wallet effect, audit entry TOPUP_TIMEOUT", async () => {
      const buyer = await registerAndLoginActiveUser(`buyer-${Date.now()}-${Math.random()}@example.com`);
      const paymentRequest = await createTopUp(buyer, 25_000);

      const res = await buyer.agent.post(`/api/payments/${paymentRequest.id}/simulate`).send({ status: "TIMEOUT" }).expect(200);
      expect(res.body.outcome).toBe("TIMEOUT");

      const settled = await testPrisma.paymentRequest.findUniqueOrThrow({ where: { id: paymentRequest.id } });
      expect(settled.status).toBe("TIMEOUT");
      const wallet = await testPrisma.wallet.findUniqueOrThrow({ where: { userId: buyer.user.id } });
      expect(wallet.availableBalance).toBe(0);
    });

    it("an explicit PENDING acknowledgment callback changes nothing (ke-hoach 'Provider timeout -> Không tự cộng tiền')", async () => {
      const buyer = await registerAndLoginActiveUser(`buyer-${Date.now()}-${Math.random()}@example.com`);
      const paymentRequest = await createTopUp(buyer, 10_000);

      const res = await buyer.agent.post(`/api/payments/${paymentRequest.id}/simulate`).send({ status: "PENDING" }).expect(200);
      expect(res.body.outcome).toBe("ACKNOWLEDGED_PENDING");

      const settled = await testPrisma.paymentRequest.findUniqueOrThrow({ where: { id: paymentRequest.id } });
      expect(settled.status).toBe("PENDING"); // unchanged — still waiting
    });

    it("silence (no callback at all) leaves the request PENDING forever on its own — Stage 11 never invents an auto-timeout", async () => {
      const buyer = await registerAndLoginActiveUser(`buyer-${Date.now()}-${Math.random()}@example.com`);
      const paymentRequest = await createTopUp(buyer, 10_000);
      // No callback simulated at all.
      const settled = await testPrisma.paymentRequest.findUniqueOrThrow({ where: { id: paymentRequest.id } });
      expect(settled.status).toBe("PENDING");
      const wallet = await testPrisma.wallet.findUniqueOrThrow({ where: { userId: buyer.user.id } });
      expect(wallet.availableBalance).toBe(0);
    });
  });

  describe("Out-of-order callbacks — terminal-state integrity", () => {
    it("a FAILED callback followed by a LATE SUCCEEDED callback does NOT flip the outcome or credit the wallet", async () => {
      const buyer = await registerAndLoginActiveUser(`buyer-${Date.now()}-${Math.random()}@example.com`);
      const paymentRequest = await createTopUp(buyer, 35_000);

      await buyer.agent.post(`/api/payments/${paymentRequest.id}/simulate`).send({ status: "FAILED" }).expect(200);
      const late = await buyer.agent.post(`/api/payments/${paymentRequest.id}/simulate`).send({ status: "SUCCEEDED" }).expect(200);
      expect(late.body.outcome).toBe("IGNORED_TERMINAL");

      const settled = await testPrisma.paymentRequest.findUniqueOrThrow({ where: { id: paymentRequest.id } });
      expect(settled.status).toBe("FAILED"); // stays FAILED — the late SUCCESS never wins
      const wallet = await testPrisma.wallet.findUniqueOrThrow({ where: { userId: buyer.user.id } });
      expect(wallet.availableBalance).toBe(0);
    });
  });

  describe("Signature verification and forged callbacks (ke-hoach §19 'Callback giả')", () => {
    it("POST /api/payments/webhook with an invalid signature is rejected 401, logged with signatureValid=false, no credit", async () => {
      const buyer = await registerAndLoginActiveUser(`buyer-${Date.now()}-${Math.random()}@example.com`);
      const paymentRequest = await createTopUp(buyer, 45_000);

      const payload: MockProviderCallbackPayload = {
        providerReference: paymentRequest.providerReference,
        eventId: "evt_forged",
        status: "SUCCEEDED",
        amount: 45_000,
        timestamp: new Date().toISOString(),
      };
      const res = await request(app).post("/api/payments/webhook").send({ payload, signature: "0".repeat(64) }).expect(401);
      expect(res.body.outcome).toBe("REJECTED_SIGNATURE");

      const settled = await testPrisma.paymentRequest.findUniqueOrThrow({ where: { id: paymentRequest.id } });
      expect(settled.status).toBe("PENDING");
      const wallet = await testPrisma.wallet.findUniqueOrThrow({ where: { userId: buyer.user.id } });
      expect(wallet.availableBalance).toBe(0);

      const callback = await testPrisma.paymentCallback.findFirstOrThrow({ where: { paymentRequestId: paymentRequest.id } });
      expect(callback.signatureValid).toBe(false);
    });

    it("a correctly-signed payload but with a TAMPERED amount is rejected 409, no credit, callback still logged", async () => {
      const buyer = await registerAndLoginActiveUser(`buyer-${Date.now()}-${Math.random()}@example.com`);
      const paymentRequest = await createTopUp(buyer, 70_000);

      // Genuinely signs the payload (so the signature itself IS valid) —
      // proving the amount check is a SEPARATE line of defense, not
      // something the signature check alone would have caught.
      const tamperedPayload: MockProviderCallbackPayload = {
        providerReference: paymentRequest.providerReference,
        eventId: "evt_tampered_amount",
        status: "SUCCEEDED",
        amount: 999_999, // does not match the PaymentRequest's real 70_000
        timestamp: new Date().toISOString(),
      };
      const signature = signMockProviderPayload(tamperedPayload);
      const res = await request(app).post("/api/payments/webhook").send({ payload: tamperedPayload, signature }).expect(409);
      expect(res.body.outcome).toBe("REJECTED_AMOUNT_MISMATCH");

      const settled = await testPrisma.paymentRequest.findUniqueOrThrow({ where: { id: paymentRequest.id } });
      expect(settled.status).toBe("PENDING");
      const wallet = await testPrisma.wallet.findUniqueOrThrow({ where: { userId: buyer.user.id } });
      expect(wallet.availableBalance).toBe(0);
      expect(await testPrisma.paymentCallback.count({ where: { paymentRequestId: paymentRequest.id } })).toBe(1);
    });

    it("an unknown providerReference is rejected 404 with nothing written (no valid FK to attach a log row to)", async () => {
      const payload: MockProviderCallbackPayload = {
        providerReference: "mock_pr_does-not-exist",
        eventId: "evt_ghost",
        status: "SUCCEEDED",
        amount: 10_000,
        timestamp: new Date().toISOString(),
      };
      const signature = signMockProviderPayload(payload);
      await request(app).post("/api/payments/webhook").send({ payload, signature }).expect(404);
      expect(await testPrisma.paymentCallback.count()).toBe(0);
    });

    it("rejects a malformed webhook body (missing fields / invalid status enum) with 400 before touching the DB", async () => {
      await request(app).post("/api/payments/webhook").send({ payload: { providerReference: "x" }, signature: "abc" }).expect(400);
      await request(app)
        .post("/api/payments/webhook")
        .send({
          payload: { providerReference: "mock_pr_x", eventId: "e1", status: "NOT_A_REAL_STATUS", amount: 1000, timestamp: new Date().toISOString() },
          signature: "abc",
        })
        .expect(400);
    });

    it("rejects a webhook payload amount outside the valid range (ke-hoach §19 'Amount lớn'/'Amount âm/0'), even with a genuine signature", async () => {
      const buyer = await registerAndLoginActiveUser(`buyer-${Date.now()}-${Math.random()}@example.com`);
      const paymentRequest = await createTopUp(buyer, 10_000);

      for (const badAmount of [0, -1, 3_000_000_000]) {
        const payload = {
          providerReference: paymentRequest.providerReference,
          eventId: `evt_bad_amount_${badAmount}`,
          status: "SUCCEEDED",
          amount: badAmount,
          timestamp: new Date().toISOString(),
        };
        // signMockProviderPayload's type requires a valid MockProviderStatus/
        // amount shape — bad amounts here are still numerically well-formed,
        // so this cast is only about satisfying TS, not bypassing the
        // server's own zod validation (which runs on the actual HTTP body).
        const signature = signMockProviderPayload(payload as unknown as MockProviderCallbackPayload);
        await request(app).post("/api/payments/webhook").send({ payload, signature }).expect(400);
      }

      expect(await testPrisma.paymentCallback.count({ where: { paymentRequestId: paymentRequest.id } })).toBe(0);
    });
  });

  describe("Ownership of the /simulate dev tool", () => {
    it("rejects a non-owner trying to simulate a callback for someone else's top-up", async () => {
      const buyer = await registerAndLoginActiveUser(`buyer-${Date.now()}-${Math.random()}@example.com`);
      const stranger = await registerAndLoginActiveUser(`stranger-${Date.now()}-${Math.random()}@example.com`);
      const paymentRequest = await createTopUp(buyer, 15_000);

      await stranger.agent.post(`/api/payments/${paymentRequest.id}/simulate`).send({ status: "SUCCEEDED" }).expect(403);

      const settled = await testPrisma.paymentRequest.findUniqueOrThrow({ where: { id: paymentRequest.id } });
      expect(settled.status).toBe("PENDING"); // untouched
    });
  });
});
