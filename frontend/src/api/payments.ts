import { apiGet, apiPost } from "./client";
import type { PaymentRequest, PaymentRequestStatus, WebhookResult } from "./types";

export function createTopUp(amount: number, idempotencyKey: string) {
  return apiPost<PaymentRequest>("/payments/topup", { amount, idempotencyKey });
}

export function getMyPaymentRequests() {
  return apiGet<PaymentRequest[]>("/payments/mine");
}

export function simulateProviderCallback(id: string, status: PaymentRequestStatus) {
  return apiPost<WebhookResult>(`/payments/${id}/simulate`, { status });
}
