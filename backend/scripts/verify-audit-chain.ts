/**
 * Stage 10 (roadmap bước 20) verification script — NOT a formal test suite.
 *
 * Re-verifies EVERY transaction's audit hash chain against the running
 * database (dev DB by default — pass DATABASE_URL to point elsewhere),
 * using the exact same `verifyAuditChain` the app itself would use to
 * detect tampering. This is the standalone, whole-database-scope
 * counterpart to `tests/audit.chain.test.ts`'s per-scenario checks.
 *
 * Detects (BA.md §23 "Audit"): content tampering, prev_hash tampering,
 * seq_no tampering, deleted middle records. Does NOT detect a
 * DB-privileged attacker who edits a record and recomputes every hash
 * after it, or who deletes the chain's tail — BA.md §17/§24 name this as
 * an accepted limitation without external anchoring, which is explicitly
 * out of scope for this thesis.
 *
 * PaymentRequest audit chains aren't included yet — Stage 11/roadmap bước
 * 21 (Mock Payment Provider) doesn't exist, so no such rows exist to
 * check. Extend this script to also loop `prisma.paymentRequest.findMany()`
 * once that stage is built.
 *
 * Run with: npx tsx scripts/verify-audit-chain.ts
 */
import { PrismaClient } from "@prisma/client";
import { verifyAuditChain } from "../src/services/audit.service";

const prisma = new PrismaClient();

let failures = 0;
let checked = 0;

async function main() {
  console.log("Verifying every transaction's audit hash chain...\n");

  const transactions = await prisma.transaction.findMany({ select: { id: true }, orderBy: { createdAt: "asc" } });

  for (const { id } of transactions) {
    const result = await verifyAuditChain(prisma, { transactionId: id });
    if (result.valid && result.recordCount === 0) continue; // nothing audited yet for this transaction — nothing to verify

    checked += 1;
    if (result.valid) {
      console.log(`  PASS  ${id}  (${result.recordCount} bản ghi)`);
    } else {
      failures += 1;
      console.log(`  FAIL  ${id}  đứt tại seq_no=${result.brokenAtSeqNo}: ${result.reason}`);
    }
  }

  console.log(`\nĐã kiểm ${checked} chuỗi (trong tổng số ${transactions.length} giao dịch).`);
  console.log(failures === 0 ? "ALL CHAINS VALID" : `${failures} CHAIN(S) FAILED`);
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
