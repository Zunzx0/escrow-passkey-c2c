import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { env } from "../config/env";

// --- Stage 11 (roadmap bước 21): Mock Payment Provider signing ------------
// ke-hoach §8: "callback/webhook (có chữ ký/HMAC xác thực nguồn gốc) →
// server xác minh chữ ký + nội dung"; kiến thức §33: "Mock Provider cần ký
// callback bằng HMAC/shared secret hoặc cơ chế tương đương. Server phải
// verify trước khi xử lý." `MOCK_PAYMENT_HMAC_SECRET` was already added to
// env config in an earlier stage, unused until now (same "built ahead of
// time" pattern as the PaymentRequest/PaymentCallback schema).

export type MockProviderStatus = "PENDING" | "SUCCEEDED" | "FAILED" | "TIMEOUT";

export interface MockProviderCallbackPayload {
  providerReference: string;
  eventId: string;
  status: MockProviderStatus;
  amount: number;
  timestamp: string;
}

// Fixed, hand-sorted field order (alphabetical) — the payload's shape is
// small and fully known, so a manual canonical form is simpler and just as
// correct as running the generic recursive canonicalizer used elsewhere in
// this codebase (utils/idempotency.ts, audit.service.ts) for arbitrary
// caller-supplied shapes.
function canonicalPayloadString(payload: MockProviderCallbackPayload): string {
  return JSON.stringify({
    amount: payload.amount,
    eventId: payload.eventId,
    providerReference: payload.providerReference,
    status: payload.status,
    timestamp: payload.timestamp,
  });
}

export function signMockProviderPayload(payload: MockProviderCallbackPayload): string {
  return createHmac("sha256", env.MOCK_PAYMENT_HMAC_SECRET).update(canonicalPayloadString(payload), "utf8").digest("hex");
}

/**
 * Constant-time comparison (kiến thức §33's "verify trước khi xử lý" —
 * a naive `===` string comparison leaks timing information about how many
 * leading bytes matched, which is exactly the kind of thing a real webhook
 * signature check must not do). Returns false (never throws) on a
 * malformed/wrong-length signature — a forged callback must fail closed,
 * not crash the endpoint.
 */
export function verifyMockProviderSignature(payload: MockProviderCallbackPayload, signature: string): boolean {
  const expected = signMockProviderPayload(payload);
  const expectedBuf = Buffer.from(expected, "hex");
  let actualBuf: Buffer;
  try {
    actualBuf = Buffer.from(signature, "hex");
  } catch {
    return false;
  }
  if (actualBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

export function generateProviderReference(): string {
  return `mock_pr_${randomUUID()}`;
}

export function generateProviderEventId(): string {
  return `mock_evt_${randomUUID()}`;
}
