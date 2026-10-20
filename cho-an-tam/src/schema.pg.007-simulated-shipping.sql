-- Additive migration: no changes/backfill to existing orders, wallets or escrow.
CREATE TABLE IF NOT EXISTS app.shipments (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL UNIQUE REFERENCES app.transactions(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('PICKUP_PENDING','IN_TRANSIT','ARRIVED','STOPPED')),
  packed_at TEXT NOT NULL,
  pickup_due_at TEXT NOT NULL,
  picked_up_at TEXT,
  arrival_due_at TEXT NOT NULL,
  arrived_at TEXT,
  stopped_at TEXT,
  stop_reason TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  CHECK (pickup_due_at >= packed_at AND arrival_due_at > pickup_due_at),
  CHECK (status NOT IN ('IN_TRANSIT','ARRIVED') OR picked_up_at IS NOT NULL),
  CHECK (status <> 'ARRIVED' OR arrived_at IS NOT NULL),
  CHECK (status <> 'STOPPED' OR (stopped_at IS NOT NULL AND stop_reason IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_shipment_status_due ON app.shipments(status, pickup_due_at, arrival_due_at);
