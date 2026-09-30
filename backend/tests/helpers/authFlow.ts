import request from "supertest";
import { app } from "../../src/app";
import { buildRegistrationResponse, generateVirtualCredential, type VirtualCredential } from "./virtualAuthenticator";
import { testPrisma } from "./db";

export const RP_ID = "localhost";
export const ORIGIN = "http://localhost:5173";

/**
 * Registers + activates a real user through the ACTUAL HTTP auth flow
 * (password + real virtual-authenticator Passkey ceremony), returning a
 * supertest agent that carries the resulting session cookie — so Stage 4+
 * tests exercise requireAuth/role checks for real, not by hand-crafting a
 * session row. Also returns the raw `credential` (Stage 6 onward needs it
 * to build further authentication ceremonies — e.g. re-auth — against the
 * SAME registered Passkey, not just the one-time registration response).
 */
export async function registerAndLoginActiveUser(email: string, password = "TestPass123!") {
  const agent = request.agent(app);
  await agent.post("/api/auth/register").send({ email, password }).expect(201);
  const optionsRes = await agent.post("/api/auth/register/passkey/options").send({ email }).expect(200);
  const credential = await generateVirtualCredential();
  const response = buildRegistrationResponse({
    rpID: RP_ID,
    origin: ORIGIN,
    challenge: optionsRes.body.challenge,
    credential,
  });
  const verifyRes = await agent.post("/api/auth/register/passkey/verify").send({ email, response }).expect(201);
  return {
    agent,
    user: verifyRes.body as { id: string; email: string; role: string; accountStatus: string },
    credential: credential as VirtualCredential,
  };
}

/**
 * Directly credits a wallet via the test DB — a stand-in for the real
 * TOPUP flow, which doesn't exist until Stage 21 (Mock Payment Provider).
 * Stage 3/4 tests need SOME way to fund a wallet for LOCK tests.
 */
export async function fundWallet(userId: string, amount: number) {
  await testPrisma.wallet.update({ where: { userId }, data: { availableBalance: { increment: amount } } });
}
