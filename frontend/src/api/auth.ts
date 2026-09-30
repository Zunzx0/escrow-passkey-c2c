import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/types";
import { apiGet, apiPost } from "./client";
import type { CurrentUser } from "./types";

export function registerWithPassword(email: string, password: string, displayName?: string) {
  return apiPost<{ id: string; email: string; accountStatus: string }>("/auth/register", { email, password, displayName });
}

export function getRegisterPasskeyOptions(email: string) {
  return apiPost<PublicKeyCredentialCreationOptionsJSON>("/auth/register/passkey/options", { email });
}

export function verifyRegisterPasskey(email: string, response: RegistrationResponseJSON) {
  return apiPost<CurrentUser>("/auth/register/passkey/verify", { email, response });
}

export function loginWithPassword(email: string, password: string) {
  return apiPost<CurrentUser>("/auth/login/password", { email, password });
}

export function getLoginPasskeyOptions(email: string) {
  return apiPost<PublicKeyCredentialRequestOptionsJSON>("/auth/login/passkey/options", { email });
}

export function verifyLoginPasskey(email: string, response: AuthenticationResponseJSON) {
  return apiPost<CurrentUser>("/auth/login/passkey/verify", { email, response });
}

export function logout() {
  return apiPost<void>("/auth/logout");
}

export function getMe() {
  return apiGet<CurrentUser>("/auth/me");
}
