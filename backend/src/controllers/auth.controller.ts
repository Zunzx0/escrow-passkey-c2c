import type { Request, Response } from "express";
import { z } from "zod";
import { createSession, destroySession } from "../services/session.service";
import {
  buildRegistrationPasskeyOptions,
  completeFirstPasskeyRegistration,
  loginWithPassword,
  registerWithPassword,
} from "../services/auth.service";
import { buildPasskeyLoginOptions, checkChallengeIssuanceRateLimit, verifyPasskeyLogin } from "../services/webauthn.service";

function serializeUser(user: {
  id: string;
  email: string;
  displayName: string | null;
  role: string;
  accountStatus: string;
}) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    accountStatus: user.accountStatus,
  };
}

const emailSchema = z.object({ email: z.string().email() });

// --- Registration: step 1, info + password ------------------------------
export async function postRegister(req: Request, res: Response) {
  const body = z
    .object({
      email: z.string().email(),
      password: z.string().min(8, "Mật khẩu tối thiểu 8 ký tự"),
      displayName: z.string().min(1).max(80).optional(),
    })
    .parse(req.body);

  const user = await registerWithPassword(body.email, body.password, body.displayName);
  // No session yet — account is PENDING_PASSKEY until the first Passkey
  // is registered (BA.md §3.3, §19).
  res.status(201).json({ id: user.id, email: user.email, accountStatus: user.accountStatus });
}

// --- Registration: step 2, first Passkey ---------------------------------
export async function postRegisterPasskeyOptions(req: Request, res: Response) {
  const body = emailSchema.parse(req.body);
  checkChallengeIssuanceRateLimit("REGISTER", req.ip ?? "unknown", body.email);
  const options = await buildRegistrationPasskeyOptions(body.email);
  res.json(options);
}

export async function postRegisterPasskeyVerify(req: Request, res: Response) {
  const body = z.object({ email: z.string().email(), response: z.any() }).parse(req.body);
  const user = await completeFirstPasskeyRegistration(body.email, body.response);
  await createSession(user.id, req, res);
  res.status(201).json(serializeUser(user));
}

// --- Password login -------------------------------------------------------
export async function postLoginPassword(req: Request, res: Response) {
  const body = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body);
  const user = await loginWithPassword(body.email, body.password, req.ip ?? "unknown");
  await createSession(user.id, req, res);
  res.json(serializeUser(user));
}

// --- Passkey login ---------------------------------------------------------
export async function postLoginPasskeyOptions(req: Request, res: Response) {
  const body = emailSchema.parse(req.body);
  checkChallengeIssuanceRateLimit("LOGIN", req.ip ?? "unknown", body.email);
  const options = await buildPasskeyLoginOptions(body.email);
  res.json(options);
}

export async function postLoginPasskeyVerify(req: Request, res: Response) {
  const body = z.object({ email: z.string().email(), response: z.any() }).parse(req.body);
  const user = await verifyPasskeyLogin(body.email, body.response);

  if (user.accountStatus !== "ACTIVE") {
    res.status(403).json({ error: "Tài khoản chưa kích hoạt." });
    return;
  }

  await createSession(user.id, req, res);
  res.json(serializeUser(user));
}

// --- Session ---------------------------------------------------------------
export async function postLogout(req: Request, res: Response) {
  await destroySession(req, res);
  res.status(204).end();
}

export async function getMe(req: Request, res: Response) {
  res.json(serializeUser(req.user!));
}
