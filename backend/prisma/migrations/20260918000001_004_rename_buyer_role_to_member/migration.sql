-- Stage 4 review (2026-09-18): BA.md never defines an account-level
-- BUYER role -- buyer/seller are per-transaction (transaction.buyer_id /
-- seller_id, listing.seller_id), not an account identity. Renaming the
-- enum value preserves existing rows/defaults automatically (Postgres
-- keeps the same underlying OID, only the label changes).
ALTER TYPE "UserRole" RENAME VALUE 'BUYER' TO 'MEMBER';
