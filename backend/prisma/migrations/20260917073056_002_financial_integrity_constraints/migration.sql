-- Enforce "there is exactly one Escrow wallet" (BA.md §18: "Có ví người
-- dùng và một ví Escrow duy nhất"). A partial unique index on the
-- boolean flag allows at most one row where isEscrow = true, while
-- every per-user wallet (isEscrow = false) is unaffected. This is a
-- real PostgreSQL constraint, not just a Prisma-level assumption — see
-- backend/scripts/verify-single-escrow-wallet.ts for a standalone
-- check that a second insert attempt is rejected by the database.
CREATE UNIQUE INDEX "Wallet_single_escrow" ON "Wallet" ("isEscrow") WHERE "isEscrow" = true;

-- A WalletEntry always belongs to exactly one financial "subject": an
-- escrow Transaction (LOCK/RELEASE/REFUND) or a top-up PaymentRequest
-- (TOPUP) — never both, never neither.
ALTER TABLE "WalletEntry" ADD CONSTRAINT "WalletEntry_exactly_one_subject" CHECK (
  ("transactionId" IS NOT NULL AND "paymentRequestId" IS NULL)
  OR
  ("transactionId" IS NULL AND "paymentRequestId" IS NOT NULL)
);

-- Same rule for AuditLog: each chain belongs to exactly one subject
-- (an escrow Transaction or a top-up PaymentRequest), each with its own
-- independent seqNo sequence.
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_exactly_one_subject" CHECK (
  ("transactionId" IS NOT NULL AND "paymentRequestId" IS NULL)
  OR
  ("transactionId" IS NULL AND "paymentRequestId" IS NOT NULL)
);
