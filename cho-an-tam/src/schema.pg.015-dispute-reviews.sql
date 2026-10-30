-- Reviews are private, append-only records. Historical decisions are not backfilled.
CREATE TABLE IF NOT EXISTS dispute_reviews (
  id TEXT PRIMARY KEY,
  dispute_id TEXT NOT NULL REFERENCES disputes(id),
  admin_id TEXT NOT NULL REFERENCES users(id),
  decision TEXT NOT NULL CHECK(decision IN ('REFUND','RELEASE','REQUEST_MORE')),
  basis TEXT NOT NULL CHECK(length(basis) BETWEEN 30 AND 2000),
  reviewed INTEGER NOT NULL CHECK(reviewed = 1),
  receipt_acknowledged INTEGER NOT NULL CHECK(receipt_acknowledged IN (0,1)),
  dispute_revision INTEGER NOT NULL,
  order_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(dispute_id,dispute_revision)
);
CREATE INDEX IF NOT EXISTS dispute_reviews_case ON dispute_reviews(dispute_id,dispute_revision DESC);
CREATE OR REPLACE FUNCTION reject_dispute_review_mutation() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'dispute_reviews is append-only'; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS dispute_reviews_immutable ON dispute_reviews;
CREATE TRIGGER dispute_reviews_immutable BEFORE UPDATE OR DELETE ON dispute_reviews
FOR EACH ROW EXECUTE FUNCTION reject_dispute_review_mutation();
