import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { assertIsTransactionClient } from "./wallet.service";

type ReadClient = Prisma.TransactionClient | PrismaClient;

// --- Stage 10 (roadmap bước 20): Audit chain + verifier, BA.md §16-17 -----
// One hash chain PER subject (Transaction now; PaymentRequest once roadmap
// bước 21/Stage 11 exists — schema.prisma's AuditLog already models both
// via two optional FKs + an exactly-one-subject CHECK constraint, built
// ahead of time in Stage 1). A record is written whenever a transaction
// changes state OR an important business milestone occurs (§16 — the
// spec's own example of a milestone is exactly Stage 5's seller
// acknowledgement, which moves no money and no `status`).

// BA.md §16: "Giá trị khởi tạo: H0 = 0^256" — 256 bits of zero, i.e. 64 hex
// zero characters (this IS a valid SHA-256 hex digest shape, just the
// reserved "nothing came before this" sentinel, never an output SHA-256
// could actually produce).
export const GENESIS_HASH = "0".repeat(64);

export type AuditSubject = { transactionId: string } | { paymentRequestId: string };

function subjectWhere(subject: AuditSubject) {
  return "transactionId" in subject ? { transactionId: subject.transactionId } : { paymentRequestId: subject.paymentRequestId };
}

// BA.md §17 canonicalization rules — deliberately a SEPARATE function from
// utils/idempotency.ts's `canonicalize`: that one is used by
// computeRequestFingerprint for a completely different purpose (comparing
// two requests for structural equality) and does NOT strip nulls, because
// nothing requires it to. The audit hash chain has its own explicit,
// numbered rule (§17.6) that must not silently leak into or out of that
// unrelated, already-tested code path.
//
//   1. JSON keys sorted alphabetically — recursive, since `data` can be a
//      nested object (e.g. {before, after}).
//   2. UTF-8 — createHash('sha256').update(str, 'utf8') is explicit below.
//   3. No unnecessary whitespace — JSON.stringify's default compact form.
//   4. Timestamps as one consistent ISO-8601 UTC format — see
//      toAuditTimestamp below.
//   5. Money as integers, never floats — already how this whole codebase
//      represents VND (Stage 1 decision); nothing extra needed here.
//   6. NULL-valued FIELDS excluded before hashing — object keys only,
//      never array elements (an array's positions carry meaning; dropping
//      a `null` element would silently change what the array represents).
//   7. Same rule at write time and verify time — both call this function.
function canonicalizeForAuditHash(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeForAuditHash);
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return Object.keys(obj)
      .filter((key) => obj[key] !== null && obj[key] !== undefined) // §17.6
      .sort() // §17.1
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = canonicalizeForAuditHash(obj[key]);
        return acc;
      }, {});
  }
  return value;
}

// §17.4: "một định dạng thống nhất, ví dụ YYYY-MM-DDThh:mm:ssZ" — whole
// seconds, no fractional part. Truncating here (rather than keeping JS's
// default millisecond fraction) makes the hash robust to however Postgres
// happens to store/round the DATETIME column: verification re-derives this
// exact string from the `createdAt` read back from the DB, independent of
// the column's actual stored sub-second precision.
function toAuditTimestamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

type HashableContent = {
  transactionId: string | null;
  paymentRequestId: string | null;
  actorId: string | null;
  seqNo: number;
  action: string;
  data: unknown;
  createdAt: string;
  prevHash: string;
};

// BA.md §16: "Giá trị băm hiện tại được tính từ biểu diễn chuẩn hóa của
// nội dung bản ghi và giá trị băm của bản ghi trước" — prevHash is folded
// into the SAME canonicalization pass as every other field, rather than
// concatenated separately, so there is exactly one ordering/formatting
// rule to get right (and re-derive at verify time), not two.
function computeAuditHash(content: HashableContent): string {
  const canonicalJson = JSON.stringify(canonicalizeForAuditHash(content));
  return createHash("sha256").update(canonicalJson, "utf8").digest("hex");
}

/**
 * Appends one record to a subject's audit chain. MUST be called with the
 * Prisma.TransactionClient from the CALLER's own `prisma.$transaction(...)`
 * — never opens one itself (same discipline as applyLedgerOperation/
 * consumeGrant, BA.md §14: the audit write shares the exact atomic
 * boundary as the state change it's recording). `data` should hold
 * whatever BA.md §16 calls "dữ liệu cần thiết" — e.g. the before/after
 * status pair and the amount for a state transition.
 *
 * Never called for an idempotent-retry no-op: every call site's OUTER fast
 * path (e.g. `if (transaction.status === "SECURED") return transaction`)
 * returns before entering the $transaction at all, and the INNER
 * lost-a-benign-race fast path (inside the $transaction, when a concurrent
 * identical retry loses) also returns without reaching this — so a
 * duplicate/no-op business action never produces a duplicate audit entry.
 */
export async function appendAuditLog(
  tx: Prisma.TransactionClient,
  params: {
    subject: AuditSubject;
    actorId: string | null;
    action: string;
    data: Record<string, unknown>;
  }
): Promise<void> {
  assertIsTransactionClient(tx);

  const where = subjectWhere(params.subject);
  // Ordering by seqNo desc + take the first row is the whole chain's
  // "tail" — concurrent double-writes on the SAME subject are not actually
  // reachable here in practice: every call site's own Transaction-row
  // version-conditional UPDATE already serializes concurrent attempts on
  // that transaction BEFORE either can reach this call (same reasoning
  // Stage 4/7/8/9 already established for the ledger/dispute unique
  // constraints). AuditLog's own `@@unique([transactionId, seqNo])` /
  // `@@unique([paymentRequestId, seqNo])` is a second line of defense, not
  // something this function tries to retry around — if it somehow fires
  // anyway, it propagates and rolls back the whole enclosing transaction
  // rather than silently smoothing over a broken chain (ke-hoach §25).
  const last = await tx.auditLog.findFirst({ where, orderBy: { seqNo: "desc" } });
  const seqNo = (last?.seqNo ?? 0) + 1;
  const prevHash = last?.currentHash ?? GENESIS_HASH;
  const createdAt = new Date();

  const currentHash = computeAuditHash({
    transactionId: "transactionId" in params.subject ? params.subject.transactionId : null,
    paymentRequestId: "paymentRequestId" in params.subject ? params.subject.paymentRequestId : null,
    actorId: params.actorId,
    seqNo,
    action: params.action,
    data: params.data,
    createdAt: toAuditTimestamp(createdAt),
    prevHash,
  });

  await tx.auditLog.create({
    data: {
      ...("transactionId" in params.subject ? { transactionId: params.subject.transactionId } : { paymentRequestId: params.subject.paymentRequestId }),
      actorId: params.actorId,
      seqNo,
      action: params.action,
      data: params.data as Prisma.InputJsonValue,
      prevHash,
      currentHash,
      createdAt,
    },
  });
}

export type AuditChainVerificationResult =
  | { valid: true; recordCount: number }
  | { valid: false; brokenAtSeqNo: number; reason: string };

/**
 * BA.md §23's "Audit" adversarial test list: content tampering, prevHash
 * tampering, seqNo tampering, and deleting a middle record are ALL
 * detected by the two checks below applied record-by-record. What is
 * explicitly NOT detected (§17's own closing paragraph, restated in §23 as
 * "ghi nhận giới hạn"): a DB-privileged attacker who edits one record AND
 * correctly recomputes every hash for the rest of the chain after it (a
 * full suffix recompute), or who deletes the chain's TAIL rather than its
 * middle. BA.md §24 explicitly puts "external anchoring" for the audit
 * hash chain out of scope, which is the only real defense against that —
 * so this verifier's guarantee is bounded exactly as the spec describes,
 * not oversold.
 */
export async function verifyAuditChain(client: ReadClient, subject: AuditSubject): Promise<AuditChainVerificationResult> {
  const records = await client.auditLog.findMany({ where: subjectWhere(subject), orderBy: { seqNo: "asc" } });
  if (records.length === 0) {
    return { valid: true, recordCount: 0 };
  }

  let expectedPrevHash = GENESIS_HASH;
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const expectedSeqNo = i + 1;

    // Catches a deleted/missing middle record (a gap in the 1..N sequence)
    // and catches seq_no itself being tampered on a record.
    if (record.seqNo !== expectedSeqNo) {
      return {
        valid: false,
        brokenAtSeqNo: record.seqNo,
        reason: `seq_no không liên tục: kỳ vọng ${expectedSeqNo}, thấy ${record.seqNo} (có thể một bản ghi giữa chuỗi đã bị xóa)`,
      };
    }

    // Catches prev_hash being tampered, OR a prior record's content/hash
    // having been tampered without cascading the fix forward.
    if (record.prevHash !== expectedPrevHash) {
      return { valid: false, brokenAtSeqNo: record.seqNo, reason: "prev_hash không khớp current_hash của bản ghi liền trước" };
    }

    // Catches this record's OWN content being tampered (and the hash not
    // recomputed to match — the case where it WAS recomputed is caught by
    // the prev_hash check on the NEXT iteration instead).
    const recomputed = computeAuditHash({
      transactionId: record.transactionId,
      paymentRequestId: record.paymentRequestId,
      actorId: record.actorId,
      seqNo: record.seqNo,
      action: record.action,
      data: record.data,
      createdAt: toAuditTimestamp(record.createdAt),
      prevHash: record.prevHash,
    });
    if (recomputed !== record.currentHash) {
      return { valid: false, brokenAtSeqNo: record.seqNo, reason: "current_hash không khớp với nội dung bản ghi (nội dung có thể đã bị sửa)" };
    }

    expectedPrevHash = record.currentHash;
  }

  return { valid: true, recordCount: records.length };
}
