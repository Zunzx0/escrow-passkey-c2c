import type { RegistrationResponseJSON } from "@simplewebauthn/types";
import { prisma } from "../lib/prisma";
import { hashPassword, verifyPassword } from "../utils/password";
import { checkRateLimit } from "../utils/rateLimit";
import { env } from "../config/env";
import { HttpError } from "../utils/httpError";
import {
  buildFirstPasskeyRegistrationOptions,
  createPasskeyCredential,
  getValidRegistrationChallenge,
  tryConsumeChallenge,
  verifyRegistrationCrypto,
} from "./webauthn.service";

// Generic message for every password-login failure mode (wrong email,
// wrong password) so responses don't reveal whether an email is
// registered (BA.md §20).
const GENERIC_LOGIN_ERROR = "Email hoặc mật khẩu không đúng.";

// --- Step 1 of registration: info + password (BA.md §19 steps 1-4) -----
// Role is never accepted from the client — every self-service
// registration is MEMBER (a regular account; buyer/seller-ness is always
// per-transaction, see utils/authz.ts); there is no public
// admin-registration path.
export async function registerWithPassword(email: string, password: string, displayName?: string) {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    // Registration (unlike login) legitimately needs to tell the caller
    // "this email is taken" — that's normal signup UX, not the same
    // anti-enumeration concern as a login attempt.
    throw new HttpError(409, "Email đã được đăng ký.");
  }

  const passwordHash = await hashPassword(password);

  return prisma.user.create({
    data: {
      email,
      passwordHash,
      displayName,
      role: "MEMBER",
      accountStatus: "PENDING_PASSKEY",
    },
  });
}

export async function buildRegistrationPasskeyOptions(email: string) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) throw new HttpError(404, "Chưa có tài khoản chờ đăng ký Passkey cho email này.");
  if (user.accountStatus !== "PENDING_PASSKEY") {
    throw new HttpError(409, "Tài khoản đã kích hoạt — thêm Passkey mới cần xác thực lại (chưa hỗ trợ ở giai đoạn này).");
  }
  return buildFirstPasskeyRegistrationOptions(user.id);
}

// --- Step 2 of registration: first Passkey (BA.md §19 steps 5-11) ------
// Everything from "challenge verified" onward — insert PasskeyCredential,
// consume the challenge, activate the account, create the wallet — runs
// in ONE DB transaction (Stage 2 review). There is no window where the
// account is ACTIVE without its credential+wallet, or where the
// challenge could be replayed to redo any of this.
export async function completeFirstPasskeyRegistration(email: string, response: RegistrationResponseJSON) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) throw new HttpError(404, "Chưa có tài khoản chờ đăng ký Passkey cho email này.");
  if (user.accountStatus !== "PENDING_PASSKEY") {
    throw new HttpError(409, "Tài khoản đã kích hoạt.");
  }

  // Read-only: fetch the still-valid challenge (does not consume it yet).
  const challengeRecord = await getValidRegistrationChallenge(user.id);

  // Pure crypto verification — no DB writes. If this throws, nothing
  // about the challenge or account changes, so the ceremony can be
  // retried with a fresh response against the same still-valid
  // challenge (until it naturally expires).
  const registrationInfo = await verifyRegistrationCrypto(challengeRecord.challenge, response);

  const activated = await prisma.$transaction(async (tx) => {
    const challengeOk = await tryConsumeChallenge(tx, challengeRecord.id);
    if (!challengeOk) {
      throw new HttpError(400, "Challenge đã được sử dụng hoặc hết hạn.");
    }

    await createPasskeyCredential(tx, user.id, response, registrationInfo);

    const updated = await tx.user.update({
      where: { id: user.id },
      data: { accountStatus: "ACTIVE" },
    });

    if (updated.role !== "ADMIN") {
      // ADMIN never holds a transaction wallet (BA.md §2.3).
      await tx.wallet.create({
        data: { userId: updated.id, availableBalance: 0, lockedBalance: 0 },
      });
    }

    return updated;
  });

  return activated;
}

// --- Password login (BA.md §20) -----------------------------------------
export async function loginWithPassword(email: string, password: string, ip: string) {
  const rateLimitKey = `password-login:${ip}:${email}`;
  const rl = checkRateLimit(rateLimitKey, env.PASSWORD_LOGIN_RATE_LIMIT_MAX, env.PASSWORD_LOGIN_RATE_LIMIT_WINDOW_MINUTES);
  if (!rl.allowed) {
    throw new HttpError(429, "Quá nhiều lần đăng nhập thất bại, vui lòng thử lại sau.");
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) throw new HttpError(401, GENERIC_LOGIN_ERROR);

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) throw new HttpError(401, GENERIC_LOGIN_ERROR);

  if (user.accountStatus !== "ACTIVE") {
    // This DOES reveal account-incomplete state, but only to someone who
    // already knows the correct password for this exact email — that's
    // the account owner, not an enumeration attacker (they already
    // authenticated the password factor).
    throw new HttpError(403, "Tài khoản chưa hoàn tất đăng ký Passkey. Vui lòng hoàn tất trước khi đăng nhập.");
  }

  return user;
}
