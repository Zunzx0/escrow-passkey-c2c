import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { consumeGrant } from "../src/services/reauthGrant.service";
import { buildReleaseContext } from "../src/services/transaction.service";
import { resetTestDb, testPrisma } from "./helpers/db";
import { fundWallet, ORIGIN, RP_ID, registerAndLoginActiveUser } from "./helpers/authFlow";
import { buildAuthenticationResponse } from "./helpers/virtualAuthenticator";

type UserHandle = Awaited<ReturnType<typeof registerAndLoginActiveUser>>;

async function createListingAs(agent: UserHandle["agent"], price = 100_000) {
  const res = await agent.post("/api/listings").send({ title: "Áo thun demo", price }).expect(201);
  return res.body as { id: string; price: number };
}

/** Drives a transaction all the way to WAIT_CONFIRM through the real HTTP flow — the only state RELEASE re-auth is valid from. */
async function setupWaitConfirmTransaction(price = 80_000) {
  const seller = await registerAndLoginActiveUser(`seller-${Date.now()}-${Math.random()}@example.com`);
  const buyer = await registerAndLoginActiveUser(`buyer-${Date.now()}-${Math.random()}@example.com`);
  const listing = await createListingAs(seller.agent, price);
  await fundWallet(buyer.user.id, price);
  const txRes = await buyer.agent.post("/api/transactions").send({ listingId: listing.id }).expect(201);
  await buyer.agent.post(`/api/transactions/${txRes.body.id}/lock`).expect(200);
  await seller.agent.post(`/api/transactions/${txRes.body.id}/ship`).expect(200);
  await buyer.agent.post(`/api/transactions/${txRes.body.id}/receive`).expect(200);
  return { seller, buyer, listing, transactionId: txRes.body.id as string, price };
}

async function issueReleaseGrant(buyer: UserHandle, transactionId: string) {
  const optionsRes = await buyer.agent.post(`/api/transactions/${transactionId}/release/reauth/options`).expect(200);
  const response = await buildAuthenticationResponse({
    rpID: RP_ID,
    origin: ORIGIN,
    challenge: optionsRes.body.challenge,
    credential: buyer.credential,
    signCount: 1,
  });
  const verifyRes = await buyer.agent
    .post(`/api/transactions/${transactionId}/release/reauth/verify`)
    .send({ response })
    .expect(200);
  return verifyRes.body.token as string;
}

describe("Passkey re-auth + scoped grant (Stage 6)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  describe("Options + verify (HTTP, real virtual-authenticator ceremonies)", () => {
    it("issues REAUTH options with allowCredentials populated (unlike login) and userVerification required", async () => {
      const { buyer, transactionId } = await setupWaitConfirmTransaction();
      const res = await buyer.agent.post(`/api/transactions/${transactionId}/release/reauth/options`).expect(200);
      expect(res.body.allowCredentials).toHaveLength(1);
      expect(res.body.allowCredentials[0].id).toBe(buyer.credential.credentialIdB64);
      expect(res.body.userVerification).toBe("required");
    });

    it("happy path: a UV assertion issues a grant; the raw token is never stored, only its hash", async () => {
      const { seller, buyer, transactionId } = await setupWaitConfirmTransaction();
      const token = await issueReleaseGrant(buyer, transactionId);
      expect(typeof token).toBe("string");
      expect(token.length).toBeGreaterThan(20);

      const grants = await testPrisma.reauthGrant.findMany({ where: { userId: buyer.user.id } });
      expect(grants).toHaveLength(1);
      expect(grants[0].tokenHash).not.toBe(token);
      expect(grants[0].action).toBe("RELEASE");
      expect(grants[0].transactionId).toBe(transactionId);
      expect(grants[0].usedAt).toBeNull();
      // Context is scoped to authorization-relevant fields only (Stage 6
      // review) — buyerId, sellerId, transactionId, listingId, amount,
      // action. Never listing.title/description/image/updatedAt.
      expect(grants[0].context).toMatchObject({
        action: "RELEASE",
        transactionId,
        buyerId: buyer.user.id,
        sellerId: seller.user.id,
      });
    });

    it("re-auth applies the SAME signCount risk policy as login (Stage 2): an anomaly doesn't block re-auth, logs a security_event, and the stored counter is never lowered", async () => {
      const { buyer, transactionId } = await setupWaitConfirmTransaction();

      // Establish a high-water-mark counter of 10 via a real login
      // ceremony first — registration alone leaves counter=0.
      const loginOptionsRes = await buyer.agent
        .post("/api/auth/login/passkey/options")
        .send({ email: buyer.user.email })
        .expect(200);
      const loginResponse = await buildAuthenticationResponse({
        rpID: RP_ID,
        origin: ORIGIN,
        challenge: loginOptionsRes.body.challenge,
        credential: buyer.credential,
        signCount: 10,
      });
      await buyer.agent
        .post("/api/auth/login/passkey/verify")
        .send({ email: buyer.user.email, response: loginResponse })
        .expect(200);

      const credBefore = await testPrisma.passkeyCredential.findUniqueOrThrow({
        where: { credentialId: buyer.credential.credentialIdB64 },
      });
      expect(credBefore.counter).toBe(10n);

      // Re-auth with a LOWER signCount (7) — must NOT block (this is the
      // exact bug class Stage 2 fixed: the library's own gate would
      // reject outright unless we pass counter:0 to it), must log the
      // anomaly, must NOT lower the stored high-water mark.
      const optionsRes = await buyer.agent.post(`/api/transactions/${transactionId}/release/reauth/options`).expect(200);
      const response = await buildAuthenticationResponse({
        rpID: RP_ID,
        origin: ORIGIN,
        challenge: optionsRes.body.challenge,
        credential: buyer.credential,
        signCount: 7,
      });
      const verifyRes = await buyer.agent.post(`/api/transactions/${transactionId}/release/reauth/verify`).send({ response });
      expect(verifyRes.status).toBe(200);

      const credAfter = await testPrisma.passkeyCredential.findUniqueOrThrow({
        where: { credentialId: buyer.credential.credentialIdB64 },
      });
      expect(credAfter.counter).toBe(10n); // NOT lowered to 7

      const events = await testPrisma.securityEvent.findMany({
        where: { userId: buyer.user.id, eventType: "WEBAUTHN_SIGNCOUNT_ANOMALY" },
      });
      expect(events).toHaveLength(1);
      const metadata = events[0].metadata as {
        storedSignCount: string;
        newSignCount: string;
        persistedSignCount: string;
        purpose: string;
      };
      expect(metadata.storedSignCount).toBe("10");
      expect(metadata.newSignCount).toBe("7");
      expect(metadata.persistedSignCount).toBe("10");
      expect(metadata.purpose).toBe("REAUTH");
    });

    it("does NOT invalidate the grant when an unrelated Listing field changes — context is scoped to authorization-relevant fields, not the whole Listing row", async () => {
      const { buyer, listing, transactionId } = await setupWaitConfirmTransaction();
      const optionsRes = await buyer.agent.post(`/api/transactions/${transactionId}/release/reauth/options`).expect(200);

      // No listing-edit endpoint exists yet, but the context must be
      // provably scoped so that when one does, editing a description
      // doesn't silently invalidate an in-flight RELEASE grant.
      await testPrisma.listing.update({
        where: { id: listing.id },
        data: { title: "Đã đổi tên", description: "Mô tả mới, không liên quan tới authorization" },
      });

      const response = await buildAuthenticationResponse({
        rpID: RP_ID,
        origin: ORIGIN,
        challenge: optionsRes.body.challenge,
        credential: buyer.credential,
        signCount: 1,
      });
      const verifyRes = await buyer.agent.post(`/api/transactions/${transactionId}/release/reauth/verify`).send({ response });
      expect(verifyRes.status).toBe(200);
      expect(typeof verifyRes.body.token).toBe("string");
    });

    it("rejects an assertion without user verification, even with otherwise-valid crypto/challenge — UV is MANDATORY for re-auth", async () => {
      const { buyer, transactionId } = await setupWaitConfirmTransaction();
      const optionsRes = await buyer.agent.post(`/api/transactions/${transactionId}/release/reauth/options`).expect(200);
      const response = await buildAuthenticationResponse({
        rpID: RP_ID,
        origin: ORIGIN,
        challenge: optionsRes.body.challenge,
        credential: buyer.credential,
        signCount: 1,
        userVerified: false,
      });
      await buyer.agent.post(`/api/transactions/${transactionId}/release/reauth/verify`).send({ response }).expect(401);
      expect(await testPrisma.reauthGrant.count()).toBe(0);
    });

    it("rejects the seller and an unrelated stranger from requesting a RELEASE re-auth on this transaction", async () => {
      const { seller, transactionId } = await setupWaitConfirmTransaction();
      await seller.agent.post(`/api/transactions/${transactionId}/release/reauth/options`).expect(403);

      const stranger = await registerAndLoginActiveUser("stranger-reauth-options@example.com");
      await stranger.agent.post(`/api/transactions/${transactionId}/release/reauth/options`).expect(403);
    });

    it("rejects requesting RELEASE re-auth before the transaction reaches WAIT_CONFIRM", async () => {
      const seller = await registerAndLoginActiveUser("seller-early@example.com");
      const buyer = await registerAndLoginActiveUser("buyer-early@example.com");
      const listing = await createListingAs(seller.agent, 10_000);
      await fundWallet(buyer.user.id, 10_000);
      const txRes = await buyer.agent.post("/api/transactions").send({ listingId: listing.id }).expect(201);
      await buyer.agent.post(`/api/transactions/${txRes.body.id}/lock`).expect(200); // SECURED, not WAIT_CONFIRM yet

      await buyer.agent.post(`/api/transactions/${txRes.body.id}/release/reauth/options`).expect(409);
    });

    it("rejects replaying an already-consumed REAUTH challenge/assertion", async () => {
      const { buyer, transactionId } = await setupWaitConfirmTransaction();
      const optionsRes = await buyer.agent.post(`/api/transactions/${transactionId}/release/reauth/options`).expect(200);
      const response = await buildAuthenticationResponse({
        rpID: RP_ID,
        origin: ORIGIN,
        challenge: optionsRes.body.challenge,
        credential: buyer.credential,
        signCount: 1,
      });
      await buyer.agent.post(`/api/transactions/${transactionId}/release/reauth/verify`).send({ response }).expect(200);
      const second = await buyer.agent.post(`/api/transactions/${transactionId}/release/reauth/verify`).send({ response });
      expect(second.status).toBeGreaterThanOrEqual(400);
      expect(await testPrisma.reauthGrant.count()).toBe(1); // no second grant from the replay
    });

    it("rejects issuing a grant when the transaction's context changed between options and verify (BA.md §21 step 8)", async () => {
      const { buyer, transactionId } = await setupWaitConfirmTransaction();
      const optionsRes = await buyer.agent.post(`/api/transactions/${transactionId}/release/reauth/options`).expect(200);

      // No real endpoint can change a locked-in transaction.amount yet —
      // mutate directly to prove the context re-check actually fires,
      // same methodology as the Stage 4 LOCK-snapshot regression test.
      await testPrisma.transaction.update({ where: { id: transactionId }, data: { amount: 999_999 } });

      const response = await buildAuthenticationResponse({
        rpID: RP_ID,
        origin: ORIGIN,
        challenge: optionsRes.body.challenge,
        credential: buyer.credential,
        signCount: 1,
      });
      const res = await buyer.agent.post(`/api/transactions/${transactionId}/release/reauth/verify`).send({ response });
      expect(res.status).toBe(409);
      expect(await testPrisma.reauthGrant.count()).toBe(0);
    });

    it("rate-limits spammed release/reauth/options requests", async () => {
      const { buyer, transactionId } = await setupWaitConfirmTransaction();
      let lastStatus = 0;
      for (let i = 0; i < 15; i++) {
        const res = await buyer.agent.post(`/api/transactions/${transactionId}/release/reauth/options`);
        lastStatus = res.status;
        if (lastStatus === 429) break;
      }
      expect(lastStatus).toBe(429);
    });
  });

  describe("consumeGrant — the exact function Stage 16 (RELEASE) will call inside its own transaction", () => {
    it("happy path: consumes the grant exactly once, marking usedAt", async () => {
      const { buyer, transactionId } = await setupWaitConfirmTransaction();
      const token = await issueReleaseGrant(buyer, transactionId);

      await testPrisma.$transaction((tx) =>
        consumeGrant(tx, {
          token,
          userId: buyer.user.id,
          scope: { action: "RELEASE", transactionId },
          rebuildContext: (tx2) => buildReleaseContext(tx2, transactionId),
        })
      );

      const grant = await testPrisma.reauthGrant.findFirstOrThrow({ where: { userId: buyer.user.id } });
      expect(grant.usedAt).not.toBeNull();
    });

    it("rejects reusing an already-consumed grant (ke-hoach §19 'Grant reuse')", async () => {
      const { buyer, transactionId } = await setupWaitConfirmTransaction();
      const token = await issueReleaseGrant(buyer, transactionId);
      const attempt = () =>
        testPrisma.$transaction((tx) =>
          consumeGrant(tx, {
            token,
            userId: buyer.user.id,
            scope: { action: "RELEASE", transactionId },
            rebuildContext: (tx2) => buildReleaseContext(tx2, transactionId),
          })
        );
      await attempt();
      await expect(attempt()).rejects.toThrow();
    });

    it("rejects a grant used for the wrong action ('Grant sai action') without consuming it", async () => {
      const { buyer, transactionId } = await setupWaitConfirmTransaction();
      const token = await issueReleaseGrant(buyer, transactionId);
      await expect(
        testPrisma.$transaction((tx) =>
          consumeGrant(tx, {
            token,
            userId: buyer.user.id,
            scope: { action: "ADJUDICATE", transactionId },
            rebuildContext: (tx2) => buildReleaseContext(tx2, transactionId),
          })
        )
      ).rejects.toThrow();
      const grant = await testPrisma.reauthGrant.findFirstOrThrow({ where: { userId: buyer.user.id } });
      expect(grant.usedAt).toBeNull(); // a rejected attempt must not burn the grant
    });

    it("rejects a grant used for the wrong transaction ('Grant đúng user nhưng sai transaction')", async () => {
      const { buyer, transactionId } = await setupWaitConfirmTransaction();
      const other = await setupWaitConfirmTransaction();
      const token = await issueReleaseGrant(buyer, transactionId);
      await expect(
        testPrisma.$transaction((tx) =>
          consumeGrant(tx, {
            token,
            userId: buyer.user.id,
            scope: { action: "RELEASE", transactionId: other.transactionId },
            rebuildContext: (tx2) => buildReleaseContext(tx2, other.transactionId),
          })
        )
      ).rejects.toThrow();
    });

    it("rejects a grant presented by a different user than it was issued to", async () => {
      const { buyer, transactionId } = await setupWaitConfirmTransaction();
      const token = await issueReleaseGrant(buyer, transactionId);
      const stranger = await registerAndLoginActiveUser("stranger-consume@example.com");
      await expect(
        testPrisma.$transaction((tx) =>
          consumeGrant(tx, {
            token,
            userId: stranger.user.id,
            scope: { action: "RELEASE", transactionId },
            rebuildContext: (tx2) => buildReleaseContext(tx2, transactionId),
          })
        )
      ).rejects.toThrow();
    });

    it("rejects an expired grant", async () => {
      const { buyer, transactionId } = await setupWaitConfirmTransaction();
      const token = await issueReleaseGrant(buyer, transactionId);
      await testPrisma.reauthGrant.updateMany({
        where: { userId: buyer.user.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await expect(
        testPrisma.$transaction((tx) =>
          consumeGrant(tx, {
            token,
            userId: buyer.user.id,
            scope: { action: "RELEASE", transactionId },
            rebuildContext: (tx2) => buildReleaseContext(tx2, transactionId),
          })
        )
      ).rejects.toThrow();
    });

    it("rejects consumption when the context changed since the grant was issued (second, independent context check)", async () => {
      const { buyer, transactionId } = await setupWaitConfirmTransaction();
      const token = await issueReleaseGrant(buyer, transactionId);
      await testPrisma.transaction.update({ where: { id: transactionId }, data: { amount: 1 } });
      await expect(
        testPrisma.$transaction((tx) =>
          consumeGrant(tx, {
            token,
            userId: buyer.user.id,
            scope: { action: "RELEASE", transactionId },
            rebuildContext: (tx2) => buildReleaseContext(tx2, transactionId),
          })
        )
      ).rejects.toThrow();
    });

    it("real concurrent consumption of the SAME grant: exactly one attempt succeeds", async () => {
      const { buyer, transactionId } = await setupWaitConfirmTransaction();
      const token = await issueReleaseGrant(buyer, transactionId);
      const attempt = () =>
        testPrisma.$transaction((tx) =>
          consumeGrant(tx, {
            token,
            userId: buyer.user.id,
            scope: { action: "RELEASE", transactionId },
            rebuildContext: (tx2) => buildReleaseContext(tx2, transactionId),
          })
        );
      const results = await Promise.allSettled([attempt(), attempt(), attempt()]);
      const succeeded = results.filter((r) => r.status === "fulfilled");
      expect(succeeded).toHaveLength(1);

      const grant = await testPrisma.reauthGrant.findFirstOrThrow({ where: { userId: buyer.user.id } });
      expect(grant.usedAt).not.toBeNull();
    });
  });
});
