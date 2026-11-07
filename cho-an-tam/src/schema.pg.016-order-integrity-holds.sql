-- Additive incident holds; no historical audit records or balances are rewritten.
CREATE TABLE IF NOT EXISTS app.order_integrity_holds (
  transaction_id TEXT PRIMARY KEY REFERENCES app.transactions(id),
  detected_at TEXT NOT NULL,
  detected_by TEXT REFERENCES app.users(id) ON DELETE SET NULL,
  reason_code TEXT NOT NULL,
  invalid_log_id BIGINT,
  details_json TEXT NOT NULL DEFAULT '{}'
);
