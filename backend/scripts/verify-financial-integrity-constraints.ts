/**
 * Foundation-stage verification script — NOT a formal test suite.
 *
 * Proves that three constraints demanded by BA.md/ke-hoach-du-an are
 * real PostgreSQL constraints (migration 002_financial_integrity_constraints),
 * not just assumptions living in Prisma schema comments or application
 * code:
 *
 *   1. Exactly one Escrow wallet can ever exist (partial unique index).
 *   2. A WalletEntry must reference exactly one subject — a Transaction
 *      or a PaymentRequest, never neither (CHECK constraint).
 *   3. Same rule for AuditLog (CHECK constraint).
 *
 * A proper automated test suite (with setup/teardown, a dedicated test
 * database, and the full invariant/idempotency/concurrency matrix) is
 * roadmap step 26 ("Functional automated tests"). This script exists
 * now, at foundation time, because these three constraints are cheap to
 * verify today and expensive to discover broken later.
 *
 * Run with: npx tsx scripts/verify-financial-integrity-constraints.ts
 */
import { PrismaClient, Prisma } from "@prisma/client";

const prisma = new PrismaClient();

let failures = 0;

function pass(label: string) {
  console.log(`  PASS  ${label}`);
}

function fail(label: string, detail?: unknown) {
  failures += 1;
  console.log(`  FAIL  ${label}`);
  if (detail !== undefined) console.log(`        ${String(detail)}`);
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

function isCheckViolation(err: unknown): boolean {
  // Prisma surfaces a raw Postgres CHECK violation as P2010 (raw query
  // failed) when it doesn't map to a known Prisma error code, or the
  // underlying pg error code 23514 shows up in the message.
  if (err instanceof Prisma.PrismaClientUnknownRequestError) return /23514|violates check constraint/i.test(err.message);
  if (err instanceof Prisma.PrismaClientKnownRequestError) return /23514|violates check constraint/i.test(err.message);
  return false;
}

async function verifySingleEscrowWallet() {
  const before = await prisma.wallet.count({ where: { isEscrow: true } });
  if (before !== 1) {
    fail(`Expected exactly 1 escrow wallet before test, found ${before}`);
    return;
  }

  try {
    await prisma.wallet.create({
      data: { isEscrow: true, userId: null, availableBalance: 0, lockedBalance: 0 },
    });
    fail("Second Escrow wallet insert was accepted — constraint is NOT enforced");
    // deleteMany has no `take` — the real single Escrow wallet must never
    // be swept up here, so this only deletes rows beyond the first,
    // ordered so the original (oldest) one is always kept.
    const extras = await prisma.wallet.findMany({ where: { isEscrow: true }, orderBy: { createdAt: "asc" }, skip: 1 });
    await prisma.wallet.deleteMany({ where: { id: { in: extras.map((w) => w.id) } } }).catch(() => undefined);
  } catch (err) {
    if (isUniqueViolation(err)) {
      pass("Second Escrow wallet insert rejected by DB unique index");
    } else {
      fail("Second Escrow wallet insert rejected, but not by the expected unique constraint", err);
    }
  }

  const after = await prisma.wallet.count({ where: { isEscrow: true } });
  if (after === 1) {
    pass("Escrow wallet count still exactly 1 after the attempt");
  } else {
    fail(`Escrow wallet count is ${after} after the attempt, expected 1`);
  }
}

async function verifyWalletEntryExactlyOneSubject() {
  const escrow = await prisma.wallet.findFirstOrThrow({ where: { isEscrow: true } });

  try {
    await prisma.walletEntry.create({
      data: {
        walletId: escrow.id,
        transactionId: null,
        paymentRequestId: null,
        deltaAvailable: 0,
        deltaLocked: 0,
        availableBalanceAfter: escrow.availableBalance,
        lockedBalanceAfter: escrow.lockedBalance,
        entryType: "TOPUP",
        idempotencyKey: `verify-script-${Date.now()}`,
        requestFingerprint: "verify-script",
      },
    });
    fail("WalletEntry with neither transactionId nor paymentRequestId was accepted — CHECK constraint is NOT enforced");
  } catch (err) {
    if (isCheckViolation(err)) {
      pass("WalletEntry with no subject rejected by DB CHECK constraint");
    } else {
      fail("WalletEntry with no subject rejected, but not by the expected CHECK constraint", err);
    }
  }
}

async function verifyAuditLogExactlyOneSubject() {
  try {
    await prisma.auditLog.create({
      data: {
        transactionId: null,
        paymentRequestId: null,
        seqNo: 1,
        actorId: null,
        action: "VERIFY_SCRIPT",
        data: {},
        prevHash: "0".repeat(64),
        currentHash: "1".repeat(64),
      },
    });
    fail("AuditLog with neither transactionId nor paymentRequestId was accepted — CHECK constraint is NOT enforced");
  } catch (err) {
    if (isCheckViolation(err)) {
      pass("AuditLog with no subject rejected by DB CHECK constraint");
    } else {
      fail("AuditLog with no subject rejected, but not by the expected CHECK constraint", err);
    }
  }
}

async function main() {
  console.log("Verifying financial integrity DB constraints (foundation stage)...\n");

  console.log("1. Exactly one Escrow wallet");
  await verifySingleEscrowWallet();

  console.log("\n2. WalletEntry exactly-one-subject CHECK");
  await verifyWalletEntryExactlyOneSubject();

  console.log("\n3. AuditLog exactly-one-subject CHECK");
  await verifyAuditLogExactlyOneSubject();

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch((err) => {
    console.error("Verification script crashed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
