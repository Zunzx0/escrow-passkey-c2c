import type { AuthenticationResponseJSON, PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/types";
import { apiGet, apiPost } from "./client";
import type { Dispute, Transaction } from "./types";

export function createTransaction(listingId: string) {
  return apiPost<Transaction>("/transactions", { listingId });
}

export function getTransaction(id: string) {
  return apiGet<Transaction>(`/transactions/${id}`);
}

export function getMyTransactions() {
  return apiGet<Transaction[]>("/transactions/mine");
}

export function lockTransaction(id: string) {
  return apiPost<Transaction>(`/transactions/${id}/lock`);
}

export function sellerAcknowledge(id: string) {
  return apiPost<Transaction>(`/transactions/${id}/seller-ack`);
}

export function shipTransaction(id: string) {
  return apiPost<Transaction>(`/transactions/${id}/ship`);
}

export function buyerReceive(id: string) {
  return apiPost<Transaction>(`/transactions/${id}/receive`);
}

export function getReleaseReauthOptions(id: string) {
  return apiPost<PublicKeyCredentialRequestOptionsJSON>(`/transactions/${id}/release/reauth/options`);
}

export function verifyReleaseReauth(id: string, response: AuthenticationResponseJSON) {
  return apiPost<{ token: string; expiresAt: string }>(`/transactions/${id}/release/reauth/verify`, { response });
}

export function releaseTransaction(id: string, token: string) {
  return apiPost<Transaction>(`/transactions/${id}/release`, { token });
}

export function openDispute(id: string, reason: string) {
  return apiPost<Dispute>(`/transactions/${id}/dispute`, { reason });
}
