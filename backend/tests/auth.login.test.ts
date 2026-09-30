import { afterAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app";
import { resetTestDb, testPrisma } from "./helpers/db";
import {
  buildAuthenticationResponse,
  buildRegistrationResponse,
  encodeCoseEc2Key,
  generateVirtualCredential,
  type VirtualCredential,
} from "./helpers/virtualAuthenticator";

const RP_ID = "localhost";
const ORIGIN = "http://localhost:5173";

async function registerActiveUser(email: string): Promise<VirtualCredential> {
  await request(app).post("/api/auth/register").send({ email, password: "TestPass123!" }).expect(201);
  const optionsRes = await request(app).post("/api/auth/register/passkey/options").send({ email }).expect(200);
  const credential = await generateVirtualCredential();
  const response = buildRegistrationResponse({
    rpID: RP_ID,
    origin: ORIGIN,
    challenge: optionsRes.body.challenge,
    credential,
  });
  await request(app).post("/api/auth/register/passkey/verify").send({ email, response }).expect(201);
  return credential;
}

async function getLoginChallenge(email: string): Promise<string> {
  const res = await request(app).post("/api/auth/login/passkey/options").send({ email }).expect(200);
  return res.body.challenge;
}

describe("Passkey login (Stage 2)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  it("does not reveal via /login/passkey/options whether an email has an account", async () => {
    await registerActiveUser("real@example.com");

    const realRes = await request(app).post("/api/auth/login/passkey/options").send({ email: "real@example.com" });
    const fakeRes = await request(app).post("/api/auth/login/passkey/options").send({ email: "nobody@example.com" });

    expect(realRes.status).toBe(200);
    expect(fakeRes.status).toBe(200);
    expect(Object.keys(realRes.body).sort()).toEqual(Object.keys(fakeRes.body).sort());
    expect(realRes.body.allowCredentials).toEqual([]);
    expect(fakeRes.body.allowCredentials).toEqual([]);
  });

  it("rejects a credential that doesn't belong to the target user", async () => {
    await registerActiveUser("owner@example.com");
    const strangerCredential = await generateVirtualCredential(); // never registered to anyone

    const challenge = await getLoginChallenge("owner@example.com");
    const response = await buildAuthenticationResponse({
      rpID: RP_ID,
      origin: ORIGIN,
      challenge,
      credential: strangerCredential,
      signCount: 1,
    });

    const res = await request(app).post("/api/auth/login/passkey/verify").send({ email: "owner@example.com", response });
    expect(res.status).toBe(401);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("does not create a session for a non-ACTIVE account even with a valid credential", async () => {
    // Deliberately inconsistent state (shouldn't happen through normal
    // flows, since credential creation is bundled with activation) — a
    // defense-in-depth check that the login controller must still catch.
    const user = await testPrisma.user.create({
      data: {
        email: "pending@example.com",
        passwordHash: "irrelevant",
        role: "MEMBER",
        accountStatus: "PENDING_PASSKEY",
      },
    });
    const credential = await generateVirtualCredential();
    await testPrisma.passkeyCredential.create({
      data: {
        userId: user.id,
        credentialId: credential.credentialIdB64,
        publicKey: Buffer.from(encodeCoseEc2Key(credential.publicKeyX, credential.publicKeyY)),
        counter: 0,
        transports: [],
      },
    });

    const challenge = await getLoginChallenge("pending@example.com");
    const response = await buildAuthenticationResponse({
      rpID: RP_ID,
      origin: ORIGIN,
      challenge,
      credential,
      signCount: 1,
    });

    const res = await request(app).post("/api/auth/login/passkey/verify").send({ email: "pending@example.com", response });
    expect(res.status).toBe(403);
    expect(res.headers["set-cookie"]).toBeUndefined();

    const sessions = await testPrisma.session.findMany({ where: { userId: user.id } });
    expect(sessions).toHaveLength(0);
  });

  it("still logs in on a signCount anomaly, but records a security_events row", async () => {
    const email = "anomaly@example.com";
    const credential = await registerActiveUser(email);

    // First real login: counter goes from 0 -> 5.
    const challenge1 = await getLoginChallenge(email);
    const response1 = await buildAuthenticationResponse({ rpID: RP_ID, origin: ORIGIN, challenge: challenge1, credential, signCount: 5 });
    const res1 = await request(app).post("/api/auth/login/passkey/verify").send({ email, response: response1 });
    expect(res1.status).toBe(200);

    // Second login with a LOWER counter (both old and new nonzero) — an
    // anomaly per kiến thức §9, but must not block the login.
    const challenge2 = await getLoginChallenge(email);
    const response2 = await buildAuthenticationResponse({ rpID: RP_ID, origin: ORIGIN, challenge: challenge2, credential, signCount: 3 });
    const res2 = await request(app).post("/api/auth/login/passkey/verify").send({ email, response: response2 });
    expect(res2.status).toBe(200);

    const user = await testPrisma.user.findUniqueOrThrow({ where: { email } });
    const events = await testPrisma.securityEvent.findMany({ where: { userId: user.id, eventType: "WEBAUTHN_SIGNCOUNT_ANOMALY" } });
    expect(events).toHaveLength(1);
    expect(events[0].severity).toBe("WARNING");
    const metadata = events[0].metadata as { storedSignCount: string; newSignCount: string; persistedSignCount: string };
    expect(metadata.storedSignCount).toBe("5");
    expect(metadata.newSignCount).toBe("3");
    expect(metadata.persistedSignCount).toBe("5");

    // The high-water mark must be KEPT, not overwritten with the lower
    // value — otherwise every future comparison for this credential would
    // silently use a weaker baseline (Stage 2 review, 2026-09-17).
    const cred = await testPrisma.passkeyCredential.findUniqueOrThrow({
      where: { credentialId: credential.credentialIdB64 },
    });
    expect(cred.counter).toBe(5n);
  });

  it("still logs in when a previously-counting credential suddenly reports counter=0, keeps the high-water mark, and logs the distinct reset event", async () => {
    const email = "counter-reset@example.com";
    const credential = await registerActiveUser(email);

    const challenge1 = await getLoginChallenge(email);
    const response1 = await buildAuthenticationResponse({ rpID: RP_ID, origin: ORIGIN, challenge: challenge1, credential, signCount: 10 });
    const res1 = await request(app).post("/api/auth/login/passkey/verify").send({ email, response: response1 });
    expect(res1.status).toBe(200);

    const challenge2 = await getLoginChallenge(email);
    const response2 = await buildAuthenticationResponse({ rpID: RP_ID, origin: ORIGIN, challenge: challenge2, credential, signCount: 0 });
    const res2 = await request(app).post("/api/auth/login/passkey/verify").send({ email, response: response2 });
    expect(res2.status).toBe(200);

    const user = await testPrisma.user.findUniqueOrThrow({ where: { email } });
    const events = await testPrisma.securityEvent.findMany({
      where: { userId: user.id, eventType: "WEBAUTHN_COUNTER_RESET_TO_ZERO" },
    });
    expect(events).toHaveLength(1);
    // Must NOT also fire the ordinary anomaly event for the same login.
    const anomalyEvents = await testPrisma.securityEvent.findMany({
      where: { userId: user.id, eventType: "WEBAUTHN_SIGNCOUNT_ANOMALY" },
    });
    expect(anomalyEvents).toHaveLength(0);

    const cred = await testPrisma.passkeyCredential.findUniqueOrThrow({
      where: { credentialId: credential.credentialIdB64 },
    });
    expect(cred.counter).toBe(10n); // high-water mark kept, not reset to 0
  });

  it("rejects replay of an already-consumed successful assertion", async () => {
    const email = "replay@example.com";
    const credential = await registerActiveUser(email);

    const challenge = await getLoginChallenge(email);
    const response = await buildAuthenticationResponse({ rpID: RP_ID, origin: ORIGIN, challenge, credential, signCount: 1 });

    const first = await request(app).post("/api/auth/login/passkey/verify").send({ email, response });
    expect(first.status).toBe(200);

    const second = await request(app).post("/api/auth/login/passkey/verify").send({ email, response });
    expect(second.status).toBeGreaterThanOrEqual(400);
  });

  it("succeeds even with UV=false — login policy is 'preferred', not 'required' (Stage 6 review regression test, contrast with REAUTH which must reject this)", async () => {
    const email = "no-uv-login@example.com";
    const credential = await registerActiveUser(email);

    const challenge = await getLoginChallenge(email);
    const response = await buildAuthenticationResponse({
      rpID: RP_ID,
      origin: ORIGIN,
      challenge,
      credential,
      signCount: 1,
      userVerified: false,
    });

    const res = await request(app).post("/api/auth/login/passkey/verify").send({ email, response });
    expect(res.status).toBe(200);
  });
});

describe("WebAuthn challenge issuance rate limiting (Stage 2)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  it("rate-limits spammed /register/passkey/options for the same email", async () => {
    const email = "spam-register@example.com";
    await request(app).post("/api/auth/register").send({ email, password: "TestPass123!" }).expect(201);

    let lastStatus = 0;
    for (let i = 0; i < 15; i++) {
      const res = await request(app).post("/api/auth/register/passkey/options").send({ email });
      lastStatus = res.status;
      if (lastStatus === 429) break;
    }
    expect(lastStatus).toBe(429);
  });

  it("rate-limits spammed /login/passkey/options for the same email", async () => {
    const email = "spam-login@example.com";
    await registerActiveUser(email);

    let lastStatus = 0;
    for (let i = 0; i < 15; i++) {
      const res = await request(app).post("/api/auth/login/passkey/options").send({ email });
      lastStatus = res.status;
      if (lastStatus === 429) break;
    }
    expect(lastStatus).toBe(429);
  });
});
