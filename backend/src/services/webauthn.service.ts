import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  AuthenticatorDevice,
  AuthenticatorTransportFuture,
  RegistrationResponseJSON,
} from "@simplewebauthn/types";
import type { ChallengePurpose, PrismaClient, Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { webauthnConfig } from "../config/webauthn";
import { env } from "../config/env";
import { checkRateLimit } from "../utils/rateLimit";
import { HttpError } from "../utils/httpError";

type Tx = Prisma.TransactionClient | PrismaClient;

const CHALLENGE_TTL_MS = env.AUTH_CHALLENGE_TTL_MINUTES * 60_000;

// ---------------------------------------------------------------------
// Challenge issuance: rate-limited per (purpose, ip, email) and capped to
// at most one ACTIVE (unused, unexpired) challenge per (userId, purpose)
// at a time — issuing a new one supersedes any prior one (Stage 2
// review). Cleanup of expired/unused rows is still deferred to roadmap
// step 23; this cap is a functional limit, not a storage-cleanup job.
// ---------------------------------------------------------------------

export function checkChallengeIssuanceRateLimit(purpose: ChallengePurpose, ip: string, email: string) {
  const rl = checkRateLimit(`challenge:${purpose}:${ip}:${email}`, env.CHALLENGE_RATE_LIMIT_MAX, env.CHALLENGE_RATE_LIMIT_WINDOW_MINUTES);
  if (!rl.allowed) {
    throw new HttpError(429, "Quá nhiều yêu cầu, vui lòng thử lại sau.");
  }
}

async function issueChallenge(
  userId: string | null,
  purpose: ChallengePurpose,
  challenge: string,
  context?: Prisma.InputJsonValue
) {
  if (userId) {
    // Supersede any prior outstanding challenge for this (user, purpose) —
    // at most one stays valid at a time.
    await prisma.authChallenge.updateMany({
      where: { userId, purpose, usedAt: null },
      data: { usedAt: new Date() },
    });
  }
  await prisma.authChallenge.create({
    data: { userId, purpose, challenge, context, expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS) },
  });
}

/** Read-only: finds the latest still-valid challenge for (userId, purpose). Does NOT consume it. */
async function getValidChallenge(userId: string, purpose: ChallengePurpose) {
  const record = await prisma.authChallenge.findFirst({
    where: { userId, purpose, usedAt: null },
    orderBy: { createdAt: "desc" },
  });
  if (!record || record.expiresAt < new Date()) {
    throw new HttpError(400, "Challenge expired or not found, please try again");
  }
  return record;
}

/**
 * Conditionally marks a challenge used INSIDE an existing transaction,
 * guarding against concurrent double-consumption of the very same
 * challenge (e.g. a replayed successful assertion racing the original
 * request). Returns false — and the caller must abort/rollback — if the
 * challenge was already consumed or is now expired.
 */
async function tryConsumeChallenge(tx: Tx, challengeId: string): Promise<boolean> {
  const result = await tx.authChallenge.updateMany({
    where: { id: challengeId, usedAt: null, expiresAt: { gt: new Date() } },
    data: { usedAt: new Date() },
  });
  return result.count === 1;
}

// --- Registration (first Passkey only) ---------------------------------
// Adding a SECOND+ Passkey to an already-ACTIVE account is a
// credential-management operation that BA.md §4 requires to go through
// Passkey re-auth + a scoped ADD_PASSKEY grant — that machinery doesn't
// exist until Stage 6, so this is only ever used for a PENDING_PASSKEY
// account completing its mandatory first credential (enforced by the
// caller, auth.service.ts).

export async function buildFirstPasskeyRegistrationOptions(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    include: { passkeyCredentials: true },
  });

  const options = await generateRegistrationOptions({
    rpName: webauthnConfig.rpName,
    rpID: webauthnConfig.rpID,
    userName: user.email,
    userDisplayName: user.displayName || user.email,
    userID: new TextEncoder().encode(user.id),
    attestationType: "none",
    excludeCredentials: user.passkeyCredentials.map((c) => ({
      id: c.credentialId,
      transports: c.transports as AuthenticatorTransportFuture[],
    })),
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
    },
  });

  await issueChallenge(user.id, "REGISTER", options.challenge);
  return options;
}

export async function getValidRegistrationChallenge(userId: string) {
  return getValidChallenge(userId, "REGISTER");
}

/** Pure WebAuthn verification — no DB writes. Throws on any failure. */
export async function verifyRegistrationCrypto(expectedChallenge: string, response: RegistrationResponseJSON) {
  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: webauthnConfig.origin,
    expectedRPID: webauthnConfig.rpID,
    // EXPLICIT — see the identical note in verifyPasskeyLogin below.
    // Registration's authenticatorSelection also uses
    // userVerification:"preferred", not "required".
    requireUserVerification: false,
  }).catch((err: Error) => {
    throw new HttpError(400, `Passkey registration could not be verified: ${err.message}`);
  });

  if (!verification.verified || !verification.registrationInfo) {
    throw new HttpError(400, "Passkey registration could not be verified");
  }
  return verification.registrationInfo;
}

/** Writes the credential row using an existing transaction client. */
export async function createPasskeyCredential(
  tx: Tx,
  userId: string,
  response: RegistrationResponseJSON,
  registrationInfo: Awaited<ReturnType<typeof verifyRegistrationCrypto>>
) {
  const { credentialID, credentialPublicKey, counter, credentialDeviceType, credentialBackedUp, aaguid } =
    registrationInfo;

  return tx.passkeyCredential.create({
    data: {
      userId,
      credentialId: credentialID,
      publicKey: Buffer.from(credentialPublicKey),
      counter: BigInt(counter),
      transports: (response.response.transports ?? []) as string[],
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
      aaguid,
    },
  });
}

export { tryConsumeChallenge };

// --- Counter (signCount) risk policy -------------------------------------
// Pure, DB-free decision function — kept separate so it can be unit
// tested directly against the subtle cases (Stage 2 review, 2026-09-17).
//
// Policy (never a hard authentication failure — kiến thức §9, BA.md §18):
//   stored=0, new=0    -> counter-less authenticator, normal. Persist 0.
//   stored=0, new>0    -> first real reading. Persist newCounter.
//   stored>0, new>old  -> normal increment. Persist newCounter.
//   stored>0, 0<new<=old -> regression: log ANOMALY, but persist
//                           max(stored, new) i.e. KEEP the stored
//                           high-water mark — overwriting it with the
//                           lower value would silently weaken every
//                           future comparison for this credential.
//   stored>0, new=0    -> a previously-counting authenticator suddenly
//                         claims "no counter support". This is NOT the
//                         same signal as an ordinary regression (it
//                         isn't covered by "both nonzero"), so it gets
//                         its own event type. Also keep the stored
//                         high-water mark rather than resetting to 0 —
//                         resetting would permanently disable future
//                         detection for this credential (a cloned
//                         credential that always reports 0 would
//                         otherwise evade the check forever after one
//                         such reading).
export type CounterSecurityEvent = {
  eventType: "WEBAUTHN_SIGNCOUNT_ANOMALY" | "WEBAUTHN_COUNTER_RESET_TO_ZERO";
  severity: "WARNING";
};

export function decideCounterUpdate(
  storedCounter: bigint,
  newCounter: bigint
): { counterToPersist: bigint; securityEvent: CounterSecurityEvent | null } {
  if (storedCounter === 0n) {
    return { counterToPersist: newCounter, securityEvent: null };
  }

  if (newCounter > storedCounter) {
    return { counterToPersist: newCounter, securityEvent: null };
  }

  if (newCounter === 0n) {
    return {
      counterToPersist: storedCounter,
      securityEvent: { eventType: "WEBAUTHN_COUNTER_RESET_TO_ZERO", severity: "WARNING" },
    };
  }

  // 0 < newCounter <= storedCounter
  return {
    counterToPersist: storedCounter,
    securityEvent: { eventType: "WEBAUTHN_SIGNCOUNT_ANOMALY", severity: "WARNING" },
  };
}

// --- Passkey login -------------------------------------------------------
// Email-first UX, but the OPTIONS response must not reveal whether the
// email has an account/Passkey (Stage 2 review — anti-enumeration):
// `allowCredentials` is always empty and the endpoint always returns 200
// with a freshly generated challenge, whether or not the account exists.
// The Passkey itself still resolves correctly client-side because
// registration used `residentKey: "preferred"` (discoverable credentials
// on most platform authenticators), and server-side matching happens at
// VERIFY time from `response.id`, not from a pre-populated allow-list.

export async function buildPasskeyLoginOptions(email: string) {
  const user = await prisma.user.findUnique({ where: { email }, include: { passkeyCredentials: true } });

  const options = await generateAuthenticationOptions({
    rpID: webauthnConfig.rpID,
    userVerification: "preferred",
    allowCredentials: [],
  });

  // Always write a challenge row (userId null if the account doesn't
  // exist) so the two code paths do the same DB work and return the same
  // shape/status — only later, at verify time, does a nonexistent
  // account fail (generically, same as any other mismatch).
  await issueChallenge(user?.id ?? null, "LOGIN", options.challenge);

  return options;
}

export async function verifyPasskeyLogin(email: string, response: AuthenticationResponseJSON) {
  const user = await prisma.user.findUnique({ where: { email }, include: { passkeyCredentials: true } });
  if (!user) throw new HttpError(401, "Đăng nhập không thành công.");

  const credential = user.passkeyCredentials.find((c) => c.credentialId === response.id);
  if (!credential) throw new HttpError(401, "Đăng nhập không thành công.");

  const challengeRecord = await getValidChallenge(user.id, "LOGIN");

  // IMPORTANT: we deliberately pass counter: 0 here, NOT the real stored
  // counter. @simplewebauthn/server's verifyAuthenticationResponse has
  // its OWN internal rule that REJECTS the whole authentication outright
  // when newCounter <= the counter we hand it (unless that counter is
  // 0, which it treats as "this authenticator doesn't support signCount,
  // skip the check"). That built-in behavior directly conflicts with
  // BA.md §18 / kiến thức §9, which require a non-increasing counter to
  // be logged as a security signal WITHOUT ever auto-rejecting the
  // login. So we always tell the library "counter unknown" (0) to
  // disable its own gate, and do our own old-vs-new comparison below
  // using the REAL stored value for anomaly detection instead.
  const authenticator: AuthenticatorDevice = {
    credentialID: credential.credentialId,
    credentialPublicKey: new Uint8Array(credential.publicKey),
    counter: 0,
    transports: credential.transports as AuthenticatorTransportFuture[],
  };

  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge: challengeRecord.challenge,
    expectedOrigin: webauthnConfig.origin,
    expectedRPID: webauthnConfig.rpID,
    authenticator,
    // EXPLICIT, not relying on the library default (Stage 6 review found
    // that default is `true` — see verifyReauthCrypto below). Login's
    // options were generated with userVerification:"preferred" (BA.md §4
    // only makes UV MANDATORY for reauth-gated sensitive actions, not for
    // ordinary Passkey login), so verification must not silently upgrade
    // "preferred" into "required" just because that happens to be
    // @simplewebauthn/server's default.
    requireUserVerification: false,
  }).catch((err: Error) => {
    throw new HttpError(401, `Đăng nhập không thành công: ${err.message}`);
  });

  if (!verification.verified) {
    throw new HttpError(401, "Đăng nhập không thành công.");
  }

  // The library's job stops at "is this a valid, fresh signature from the
  // claimed credential" (crypto/challenge/origin/RP ID/UV) — its verdict
  // is `verification.verified` above. What to DO about the counter it
  // read (`authenticationInfo.newCounter`, always the real value from
  // the response regardless of what we passed in as input) is entirely
  // our own risk policy, decided by decideCounterUpdate — never a reason
  // to reject an otherwise-valid authentication.
  const storedCounter = credential.counter;
  const newCounter = BigInt(verification.authenticationInfo.newCounter);
  const { counterToPersist, securityEvent } = decideCounterUpdate(storedCounter, newCounter);

  const consumed = await prisma.$transaction(async (tx) => {
    const ok = await tryConsumeChallenge(tx, challengeRecord.id);
    if (!ok) return false;

    await tx.passkeyCredential.update({
      where: { id: credential.id },
      data: { counter: counterToPersist, lastUsedAt: new Date() },
    });

    if (securityEvent) {
      await tx.securityEvent.create({
        data: {
          userId: user.id,
          passkeyCredentialId: credential.id,
          eventType: securityEvent.eventType,
          severity: securityEvent.severity,
          metadata: {
            storedSignCount: storedCounter.toString(),
            newSignCount: newCounter.toString(),
            persistedSignCount: counterToPersist.toString(),
            purpose: "LOGIN",
          },
        },
      });
    }

    return true;
  });

  if (!consumed) {
    throw new HttpError(400, "Challenge đã được sử dụng hoặc hết hạn.");
  }

  return user;
}

// --- Passkey re-auth (Stage 6, ke-hoach §7/§28 step 15, BA.md §4-§6/§21) -
// Distinct from login in two ways: (1) User Verification is MANDATORY,
// not "preferred" — every sensitive action gated by a reauth_grant
// requires it (BA.md §4), so `allowCredentials` is populated with the
// CALLER'S OWN credentials (unlike login, there is no enumeration concern
// — the user is already authenticated) and `userVerification: "required"`
// is requested; (2) the challenge is bound to a `context` snapshot
// (BA.md §6) built by the caller from currently-trusted server data, so
// it can be compared against a freshly-rebuilt context at both grant
// issuance and grant consumption time (see reauthGrant.service.ts).

export async function buildReauthOptions(userId: string, context: Record<string, unknown>) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    include: { passkeyCredentials: true },
  });

  const options = await generateAuthenticationOptions({
    rpID: webauthnConfig.rpID,
    userVerification: "required",
    allowCredentials: user.passkeyCredentials.map((c) => ({
      id: c.credentialId,
      transports: c.transports as AuthenticatorTransportFuture[],
    })),
  });

  await issueChallenge(user.id, "REAUTH", options.challenge, context as Prisma.InputJsonValue);
  return options;
}

export async function getValidReauthChallenge(userId: string) {
  return getValidChallenge(userId, "REAUTH");
}

/**
 * Pure WebAuthn verification for a re-auth ceremony — no DB writes beyond
 * what verifyAuthenticationResponse itself needs to read. Mirrors
 * verifyPasskeyLogin's crypto/counter handling (including the counter:0
 * library-gate workaround — see decideCounterUpdate's doc comment) but
 * does NOT consume the challenge or write the counter update itself; the
 * caller (reauthGrant.service.ts) does that atomically together with the
 * context re-check and grant creation, all in one DB transaction.
 */
export async function verifyReauthCrypto(userId: string, response: AuthenticationResponseJSON) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    include: { passkeyCredentials: true },
  });

  const credential = user.passkeyCredentials.find((c) => c.credentialId === response.id);
  if (!credential) throw new HttpError(401, "Passkey không hợp lệ cho tài khoản này.");

  const challengeRecord = await getValidChallenge(user.id, "REAUTH");

  const authenticator: AuthenticatorDevice = {
    credentialID: credential.credentialId,
    credentialPublicKey: new Uint8Array(credential.publicKey),
    counter: 0, // same counter-gate workaround as login (decideCounterUpdate)
    transports: credential.transports as AuthenticatorTransportFuture[],
  };

  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge: challengeRecord.challenge,
    expectedOrigin: webauthnConfig.origin,
    expectedRPID: webauthnConfig.rpID,
    authenticator,
    // MANDATORY here, unlike login/registration — BA.md §4: UV is
    // required for every reauth_grant-gated action, explicitly, not left
    // to the library default.
    requireUserVerification: true,
  }).catch((err: Error) => {
    throw new HttpError(401, `Xác thực lại không thành công: ${err.message}`);
  });

  if (!verification.verified) {
    throw new HttpError(401, "Xác thực lại không thành công.");
  }

  return { user, credential, challengeRecord, verification };
}
