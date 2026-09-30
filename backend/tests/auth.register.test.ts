import { afterAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app";
import { resetTestDb, testPrisma } from "./helpers/db";
import { buildRegistrationResponse, generateVirtualCredential } from "./helpers/virtualAuthenticator";

const RP_ID = "localhost";
const ORIGIN = "http://localhost:5173";

async function registerPendingUser(email: string) {
  await request(app).post("/api/auth/register").send({ email, password: "TestPass123!" }).expect(201);
}

describe("Passkey registration (Stage 2)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  it("rejects verify against an expired challenge", async () => {
    const email = "expired@example.com";
    await registerPendingUser(email);
    const optionsRes = await request(app).post("/api/auth/register/passkey/options").send({ email }).expect(200);

    await testPrisma.authChallenge.updateMany({
      where: { purpose: "REGISTER" },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const credential = await generateVirtualCredential();
    const response = buildRegistrationResponse({
      rpID: RP_ID,
      origin: ORIGIN,
      challenge: optionsRes.body.challenge,
      credential,
    });

    const res = await request(app).post("/api/auth/register/passkey/verify").send({ email, response });
    expect(res.status).toBe(400);

    const user = await testPrisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.accountStatus).toBe("PENDING_PASSKEY");
  });

  it("rejects a reused (already-consumed) challenge", async () => {
    const email = "reuse@example.com";
    await registerPendingUser(email);
    const optionsRes = await request(app).post("/api/auth/register/passkey/options").send({ email }).expect(200);
    const credential = await generateVirtualCredential();
    const response = buildRegistrationResponse({
      rpID: RP_ID,
      origin: ORIGIN,
      challenge: optionsRes.body.challenge,
      credential,
    });

    const first = await request(app).post("/api/auth/register/passkey/verify").send({ email, response });
    expect(first.status).toBe(201);

    // Replaying the identical response is rejected — either because the
    // challenge was already consumed, or (as here) because the account
    // is no longer PENDING_PASSKEY, an even earlier guard. Either way it
    // must not be treated as a second successful registration.
    const second = await request(app).post("/api/auth/register/passkey/verify").send({ email, response });
    expect(second.status).toBeGreaterThanOrEqual(400);

    const credentials = await testPrisma.passkeyCredential.findMany({ where: { credentialId: credential.credentialIdB64 } });
    expect(credentials).toHaveLength(1);
  });

  it("rejects a response signed for the wrong origin", async () => {
    const email = "wrongorigin@example.com";
    await registerPendingUser(email);
    const optionsRes = await request(app).post("/api/auth/register/passkey/options").send({ email }).expect(200);
    const credential = await generateVirtualCredential();
    const response = buildRegistrationResponse({
      rpID: RP_ID,
      origin: ORIGIN,
      challenge: optionsRes.body.challenge,
      credential,
      tamperOrigin: "http://evil.example.com",
    });

    const res = await request(app).post("/api/auth/register/passkey/verify").send({ email, response });
    expect(res.status).toBe(400);

    const user = await testPrisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.accountStatus).toBe("PENDING_PASSKEY");
  });

  it("rejects a response whose authData rpIdHash doesn't match RP_ID", async () => {
    const email = "wrongrpid@example.com";
    await registerPendingUser(email);
    const optionsRes = await request(app).post("/api/auth/register/passkey/options").send({ email }).expect(200);
    const credential = await generateVirtualCredential();
    const response = buildRegistrationResponse({
      rpID: RP_ID,
      origin: ORIGIN,
      challenge: optionsRes.body.challenge,
      credential,
      tamperRpIdHash: true,
    });

    const res = await request(app).post("/api/auth/register/passkey/verify").send({ email, response });
    expect(res.status).toBe(400);
  });

  it("succeeds even with UV=false — registration policy is 'preferred', not 'required' (Stage 6 review regression test)", async () => {
    const email = "no-uv@example.com";
    await registerPendingUser(email);
    const optionsRes = await request(app).post("/api/auth/register/passkey/options").send({ email }).expect(200);
    const credential = await generateVirtualCredential();
    const response = buildRegistrationResponse({
      rpID: RP_ID,
      origin: ORIGIN,
      challenge: optionsRes.body.challenge,
      credential,
      userVerified: false,
    });

    const res = await request(app).post("/api/auth/register/passkey/verify").send({ email, response });
    expect(res.status).toBe(201);
    expect(res.body.accountStatus).toBe("ACTIVE");
  });

  it("completes registration: credential + ACTIVE + wallet all succeed together", async () => {
    const email = "happy@example.com";
    await registerPendingUser(email);
    const optionsRes = await request(app).post("/api/auth/register/passkey/options").send({ email }).expect(200);
    const credential = await generateVirtualCredential();
    const response = buildRegistrationResponse({
      rpID: RP_ID,
      origin: ORIGIN,
      challenge: optionsRes.body.challenge,
      credential,
    });

    const res = await request(app).post("/api/auth/register/passkey/verify").send({ email, response });
    expect(res.status).toBe(201);
    expect(res.body.accountStatus).toBe("ACTIVE");

    const user = await testPrisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.accountStatus).toBe("ACTIVE");

    const cred = await testPrisma.passkeyCredential.findUnique({
      where: { credentialId: credential.credentialIdB64 },
    });
    expect(cred).not.toBeNull();
    expect(cred?.userId).toBe(user.id);

    const wallet = await testPrisma.wallet.findUnique({ where: { userId: user.id } });
    expect(wallet).not.toBeNull();
    expect(wallet?.availableBalance).toBe(0);
    expect(wallet?.lockedBalance).toBe(0);

    const challenge = await testPrisma.authChallenge.findFirst({ where: { challenge: optionsRes.body.challenge } });
    expect(challenge?.usedAt).not.toBeNull();
  });

  it("does not leave a half-active account if the credential insert conflicts mid-transaction", async () => {
    const email = "conflict@example.com";
    await registerPendingUser(email);
    const optionsRes = await request(app).post("/api/auth/register/passkey/options").send({ email }).expect(200);
    const credential = await generateVirtualCredential();
    const response = buildRegistrationResponse({
      rpID: RP_ID,
      origin: ORIGIN,
      challenge: optionsRes.body.challenge,
      credential,
    });

    // Force a unique-constraint conflict on credentialId, belonging to an
    // unrelated user, so the transaction fails AFTER crypto verification
    // succeeded but DURING the credential insert.
    const otherEmail = "other@example.com";
    await registerPendingUser(otherEmail);
    const otherUser = await testPrisma.user.findUniqueOrThrow({ where: { email: otherEmail } });
    await testPrisma.passkeyCredential.create({
      data: {
        userId: otherUser.id,
        credentialId: credential.credentialIdB64,
        publicKey: Buffer.from([1, 2, 3]),
        counter: 0,
        transports: [],
      },
    });

    const res = await request(app).post("/api/auth/register/passkey/verify").send({ email, response });
    expect(res.status).toBeGreaterThanOrEqual(400);

    const user = await testPrisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.accountStatus).toBe("PENDING_PASSKEY");

    const wallet = await testPrisma.wallet.findUnique({ where: { userId: user.id } });
    expect(wallet).toBeNull();

    // The challenge must not have been permanently burned by the failed
    // attempt (rollback undoes tryConsumeChallenge too).
    const challenge = await testPrisma.authChallenge.findFirst({ where: { challenge: optionsRes.body.challenge } });
    expect(challenge?.usedAt).toBeNull();
  });
});
