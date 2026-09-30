import type { AuthenticationResponseJSON, PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/types";
import { apiGet, apiPost } from "./client";
import type { Dispute, DisputeDecision, Transaction } from "./types";

export function getDisputes() {
  return apiGet<Dispute[]>("/disputes");
}

export function getDispute(id: string) {
  return apiGet<Dispute>(`/disputes/${id}`);
}

export function getAdjudicationReauthOptions(id: string, decision: DisputeDecision) {
  return apiPost<PublicKeyCredentialRequestOptionsJSON>(`/disputes/${id}/adjudicate/reauth/options`, { decision });
}

export function verifyAdjudicationReauth(id: string, decision: DisputeDecision, response: AuthenticationResponseJSON) {
  return apiPost<{ token: string; expiresAt: string }>(`/disputes/${id}/adjudicate/reauth/verify`, { decision, response });
}

export function adjudicateDispute(id: string, decision: DisputeDecision, token: string, resolutionNote?: string) {
  return apiPost<Transaction>(`/disputes/${id}/adjudicate`, { decision, token, resolutionNote: resolutionNote || undefined });
}
