import { startAuthentication, startRegistration, WebAuthnError } from "@simplewebauthn/browser";
import { getLoginPasskeyOptions, getRegisterPasskeyOptions, verifyLoginPasskey, verifyRegisterPasskey } from "../api/auth";
import { getReleaseReauthOptions, verifyReleaseReauth } from "../api/transactions";
import { getAdjudicationReauthOptions, verifyAdjudicationReauth } from "../api/disputes";
import type { CurrentUser, DisputeDecision } from "../api/types";

/**
 * Turns a raised WebAuthn/browser error into the friendly message ke-hoach
 * §16 asks for ("Passkey Cancel: ... thông báo thân thiện, cho retry") —
 * the caller is responsible for resetting its own loading state and
 * allowing the user to try again; this never throws its own error, it
 * only translates the message.
 */
function friendlyPasskeyMessage(err: unknown): string {
  if (err instanceof WebAuthnError) {
    // ERROR_CEREMONY_ABORTED covers the common "user cancelled / dialog
    // dismissed / timed out" case (maps from the browser's own
    // NotAllowedError) — everything else already has a reasonably
    // descriptive message from the library itself.
    if (err.code === "ERROR_CEREMONY_ABORTED") {
      return "Bạn đã hủy hoặc không hoàn tất xác thực Passkey. Vui lòng thử lại.";
    }
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return "Xác thực Passkey không thành công.";
}

export class PasskeyFlowError extends Error {}

/** Registers the FIRST Passkey for a just-created (PENDING_PASSKEY) account. */
export async function registerPasskey(email: string): Promise<CurrentUser> {
  try {
    const options = await getRegisterPasskeyOptions(email);
    const response = await startRegistration(options);
    return await verifyRegisterPasskey(email, response);
  } catch (err) {
    throw new PasskeyFlowError(friendlyPasskeyMessage(err));
  }
}

/** Logs in with an existing Passkey (email-first, discoverable credential). */
export async function loginWithPasskey(email: string): Promise<CurrentUser> {
  try {
    const options = await getLoginPasskeyOptions(email);
    const response = await startAuthentication(options);
    return await verifyLoginPasskey(email, response);
  } catch (err) {
    throw new PasskeyFlowError(friendlyPasskeyMessage(err));
  }
}

/**
 * Full RELEASE re-auth ceremony (BA.md §21): request a context-bound
 * REAUTH challenge, perform the (UV-required) WebAuthn ceremony, and
 * return the one-time grant token — the caller then calls
 * releaseTransaction(id, token) separately, right after Passkey success,
 * never storing the token beyond that single call.
 */
export async function performReleaseReauth(transactionId: string): Promise<string> {
  try {
    const options = await getReleaseReauthOptions(transactionId);
    const response = await startAuthentication(options);
    const grant = await verifyReleaseReauth(transactionId, response);
    return grant.token;
  } catch (err) {
    throw new PasskeyFlowError(friendlyPasskeyMessage(err));
  }
}

/** Creates a one-time grant bound to one dispute and one admin decision. */
export async function performAdjudicationReauth(disputeId: string, decision: DisputeDecision): Promise<string> {
  try {
    const options = await getAdjudicationReauthOptions(disputeId, decision);
    const response = await startAuthentication(options);
    const grant = await verifyAdjudicationReauth(disputeId, decision, response);
    return grant.token;
  } catch (err) {
    throw new PasskeyFlowError(friendlyPasskeyMessage(err));
  }
}
