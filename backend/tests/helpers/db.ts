import { PrismaClient } from "@prisma/client";

export const testPrisma = new PrismaClient();

/**
 * Wipes every table that Stage 2 tests can touch, in FK-safe order, then
 * recreates the single Escrow wallet (a foundation invariant — see
 * verify-financial-integrity-constraints.ts — that must hold before any
 * test runs). Called between tests so each test starts from a known,
 * empty state instead of leaking state into the next one.
 */
export async function resetTestDb() {
  await testPrisma.securityEvent.deleteMany();
  await testPrisma.auditLog.deleteMany();
  await testPrisma.walletEntry.deleteMany();
  await testPrisma.reauthGrant.deleteMany();
  await testPrisma.dispute.deleteMany();
  await testPrisma.paymentCallback.deleteMany();
  await testPrisma.paymentRequest.deleteMany();
  await testPrisma.transaction.deleteMany();
  await testPrisma.listingImage.deleteMany();
  await testPrisma.listing.deleteMany();
  await testPrisma.authChallenge.deleteMany();
  await testPrisma.session.deleteMany();
  await testPrisma.passkeyCredential.deleteMany();
  await testPrisma.wallet.deleteMany();
  await testPrisma.user.deleteMany();

  await testPrisma.wallet.create({
    data: { isEscrow: true, userId: null, availableBalance: 0, lockedBalance: 0 },
  });
}
