import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { HttpError } from "../utils/httpError";
import { computeRequestFingerprint } from "../utils/idempotency";
import { applyLedgerOperation } from "./wallet.service";
import { appendAuditLog } from "./audit.service";
import {
  generateProviderEventId,
  generateProviderReference,
  signMockProviderPayload,
  verifyMockProviderSignature,
  type MockProviderCallbackPayload,
  type MockProviderStatus,
} from "./mockProvider.service";

// --- Stage 11 (roadmap bước 21): Mock Payment Provider + Top-up -----------
// ke-hoach §8: "User tạo yêu cầu nạp → Payment Request PENDING → Mock
// Provider → callback/webhook → server xác minh chữ ký + nội dung →
// SUCCEEDED/FAILED/PENDING → nếu thành công mới credit wallet. Không cho
// Buyer trực tiếp wallet.balance += amount." The EXTERNAL_CREDIT path in
// applyLedgerOperation (wallet.service.ts) and the PaymentRequest/
// PaymentCallback schema were both built in Stage 1/3, unused until now —
// same "engine built ahead of time" pattern as Stage 6→9's grant engine.

// --- Create top-up request -------------------------------------------------

/**
 * Client-supplied `idempotencyKey` (NOT server-generated) — unlike LOCK/
 * RELEASE, which are only ever meaningful ONCE per transaction (so a
 * deterministic server-derived key like `lock:${id}` is correct), a top-up
 * is something a user legitimately does MANY times over their account's
 * lifetime. A server-derived key would incorrectly collapse every future
 * top-up into "the same request" as the first. The client must generate a
 * fresh key per user-intended top-up action and resend the SAME key only
 * when retrying (double-click/network-retry) that specific attempt —
 * exactly Stripe's `Idempotency-Key` model (kiến thức §18/§34).
 */
export async function createTopUpRequest(userId: string, amount: number, idempotencyKey: string) {
  const existing = await prisma.paymentRequest.findUnique({ where: { idempotencyKey } });
  if (existing) {
    if (existing.userId !== userId) {
      // Astronomically unlikely (client-generated keys should be UUIDs),
      // but must never leak/reuse another user's request if it happens.
      throw new HttpError(409, "idempotency_key đã được dùng bởi một yêu cầu khác.");
    }
    if (existing.amount !== amount) {
      throw new HttpError(409, "idempotency_key đã được dùng với số tiền khác.");
    }
    return existing; // idempotent retry of the request-CREATION step
  }

  return prisma.paymentRequest.create({
    data: {
      userId,
      amount,
      status: "PENDING",
      idempotencyKey,
      providerReference: generateProviderReference(),
    },
  });
}

export async function listMyPaymentRequests(userId: string) {
  return prisma.paymentRequest.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
}

export async function getPaymentRequestForOwner(userId: string, paymentRequestId: string) {
  const request = await prisma.paymentRequest.findUnique({ where: { id: paymentRequestId } });
  if (!request) throw new HttpError(404, "Không tìm thấy yêu cầu thanh toán.");
  if (request.userId !== userId) throw new HttpError(403, "Bạn không có quyền xem yêu cầu thanh toán này.");
  return request;
}

// --- Webhook processing -----------------------------------------------------

export type WebhookOutcome =
  | "CREDITED"
  | "FAILED"
  | "TIMEOUT"
  | "ACKNOWLEDGED_PENDING"
  | "REJECTED_SIGNATURE"
  | "REJECTED_AMOUNT_MISMATCH"
  | "IGNORED_TERMINAL"
  | "REPLAYED_DUPLICATE";

export interface WebhookResult {
  outcome: WebhookOutcome;
  paymentRequestId: string;
}

/**
 * The ONE function both the public `/webhook` endpoint AND the `/simulate`
 * dev/test endpoint call — guarantees there is exactly one implementation
 * of "what a callback does," so a test that exercises `/simulate` is
 * implicitly also proving what a genuinely correctly-signed provider
 * callback would do, with no risk of the two paths drifting apart.
 *
 * ke-hoach §8: "Callback không xác thực được chữ ký phải bị reject, ghi
 * log, không xử lý như callback hợp lệ" — every callback for a KNOWN
 * `providerReference` is persisted as a PaymentCallback row (schema
 * comment: "so the 'Callback giả' and 'Duplicate webhook' test cases have
 * evidence to check"), even when rejected. An UNKNOWN `providerReference`
 * has nothing valid to attach a row to (the FK is required) and is refused
 * outright before anything is written.
 *
 * Never throws for a business-outcome rejection (bad signature, amount
 * mismatch, already-terminal) — those are normal, loggable results, not
 * exceptions. Throwing INSIDE this function's own `prisma.$transaction`
 * would roll back the very callback row that must survive to serve as
 * evidence of the rejected attempt.
 */
export async function processWebhookCallback(payload: MockProviderCallbackPayload, signature: string): Promise<WebhookResult> {
  const paymentRequest = await prisma.paymentRequest.findUnique({ where: { providerReference: payload.providerReference } });
  if (!paymentRequest) {
    throw new HttpError(404, "Không tìm thấy yêu cầu thanh toán tương ứng với providerReference.");
  }

  const signatureValid = verifyMockProviderSignature(payload, signature);

  return prisma.$transaction(async (tx) => {
    // Callback-DELIVERY-level idempotency: the identical providerEventId
    // for this PaymentRequest is a replay of one delivery, not a new
    // event — a real provider's retry must not be double-processed.
    const existingCallback = await tx.paymentCallback.findUnique({
      where: { paymentRequestId_providerEventId: { paymentRequestId: paymentRequest.id, providerEventId: payload.eventId } },
    });
    if (existingCallback) {
      return { outcome: "REPLAYED_DUPLICATE" as const, paymentRequestId: paymentRequest.id };
    }

    const callback = await tx.paymentCallback.create({
      data: {
        paymentRequestId: paymentRequest.id,
        providerEventId: payload.eventId,
        reportedStatus: payload.status,
        signatureValid,
        rawPayload: payload as unknown as Prisma.InputJsonValue,
      },
    });
    async function markProcessed() {
      await tx.paymentCallback.update({ where: { id: callback.id }, data: { processedAt: new Date() } });
    }

    if (!signatureValid) {
      await markProcessed();
      return { outcome: "REJECTED_SIGNATURE" as const, paymentRequestId: paymentRequest.id };
    }

    // The signature only proves the payload came from someone holding the
    // shared secret — it doesn't prove the CONTENT is self-consistent with
    // what we created the request for. A mismatched amount is rejected
    // even though the signature is genuine.
    if (payload.amount !== paymentRequest.amount) {
      await markProcessed();
      return { outcome: "REJECTED_AMOUNT_MISMATCH" as const, paymentRequestId: paymentRequest.id };
    }

    // BA.md §15's "một giao dịch chỉ được tất toán một lần" spirit,
    // extended to PaymentRequest's own terminal-state integrity (ke-hoach
    // §19 "Delayed webhook -> State đúng"): once SUCCEEDED/FAILED/TIMEOUT,
    // no later callback — however it's worded — may flip it again.
    if (paymentRequest.status !== "PENDING") {
      await markProcessed();
      return { outcome: "IGNORED_TERMINAL" as const, paymentRequestId: paymentRequest.id };
    }

    if (payload.status === "PENDING") {
      // Acknowledgment-only ("still processing") — no state change.
      await markProcessed();
      return { outcome: "ACKNOWLEDGED_PENDING" as const, paymentRequestId: paymentRequest.id };
    }

    // Conditional on status=PENDING so a concurrent callback settling the
    // SAME request first is not double-applied (mirrors every other
    // business operation's version-conditional update pattern, using
    // `status` itself as the guard since PaymentRequest has no separate
    // `version` column).
    const updateResult = await tx.paymentRequest.updateMany({
      where: { id: paymentRequest.id, status: "PENDING" },
      data: { status: payload.status },
    });
    if (updateResult.count === 0) {
      await markProcessed();
      return { outcome: "IGNORED_TERMINAL" as const, paymentRequestId: paymentRequest.id };
    }

    if (payload.status === "SUCCEEDED") {
      const wallet = await tx.wallet.findUniqueOrThrow({ where: { userId: paymentRequest.userId } });
      const requestFingerprint = computeRequestFingerprint({
        actorId: paymentRequest.userId,
        paymentRequestId: paymentRequest.id,
        action: "TOPUP",
        amount: paymentRequest.amount,
      });
      // ke-hoach §9: TOPUP only ever credits `availableBalance` — never
      // `lockedBalance` (enforced again, independently, inside
      // applyLedgerOperation's EXTERNAL_CREDIT branch itself). Keyed by
      // paymentRequestId, NOT providerEventId — however many distinct
      // "SUCCEEDED" events a flaky/duplicating provider sends for the
      // SAME request, the wallet is credited exactly once (ke-hoach §19
      // "Duplicate webhook SUCCESS ×10 -> Top-up một lần").
      await applyLedgerOperation(tx, {
        operationKind: "EXTERNAL_CREDIT",
        idempotencyKey: `topup:${paymentRequest.id}`,
        requestFingerprint,
        subject: { paymentRequestId: paymentRequest.id },
        entries: [{ walletId: wallet.id, deltaAvailable: paymentRequest.amount, deltaLocked: 0, entryType: "TOPUP" }],
      });

      await appendAuditLog(tx, {
        subject: { paymentRequestId: paymentRequest.id },
        actorId: null, // no human actor — a (mock) provider callback triggered this
        action: "TOPUP_SUCCEEDED",
        data: { amount: paymentRequest.amount, providerEventId: payload.eventId },
      });

      await markProcessed();
      return { outcome: "CREDITED" as const, paymentRequestId: paymentRequest.id };
    }

    // FAILED / TIMEOUT — terminal negative outcomes, no wallet effect.
    await appendAuditLog(tx, {
      subject: { paymentRequestId: paymentRequest.id },
      actorId: null,
      action: payload.status === "FAILED" ? "TOPUP_FAILED" : "TOPUP_TIMEOUT",
      data: { providerEventId: payload.eventId },
    });

    await markProcessed();
    return { outcome: payload.status as "FAILED" | "TIMEOUT", paymentRequestId: paymentRequest.id };
  });
}

// --- Mock provider simulation (dev/test tool, NOT what a real provider
// would call — see src/routes/payment.routes.ts) ---------------------------

/**
 * Stands in for "the outside mock provider decided an outcome and is now
 * calling our webhook" — signs a payload with the SAME function the real
 * webhook expects, then runs it through the SAME `processWebhookCallback`
 * a genuine provider callback would go through. Restricted to the
 * request's own owner at the route layer (a real provider isn't "logged in
 * as" anyone, but this endpoint only exists because there is no real
 * external provider to trigger it — scoping it to the owner prevents one
 * member from completing/failing ANOTHER member's top-up).
 */
export async function simulateMockProviderCallback(
  paymentRequestId: string,
  status: MockProviderStatus,
  eventId?: string
): Promise<WebhookResult> {
  const paymentRequest = await prisma.paymentRequest.findUniqueOrThrow({ where: { id: paymentRequestId } });
  const payload: MockProviderCallbackPayload = {
    providerReference: paymentRequest.providerReference,
    eventId: eventId ?? generateProviderEventId(),
    status,
    amount: paymentRequest.amount,
    timestamp: new Date().toISOString(),
  };
  const signature = signMockProviderPayload(payload);
  return processWebhookCallback(payload, signature);
}
