CREATE UNIQUE INDEX IF NOT EXISTS ux_order_request ON transactions(buyer_id,order_request_id) WHERE order_request_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS buyer_order_locks (buyer_id TEXT PRIMARY KEY REFERENCES users(id),version INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS order_shipping_snapshot (
  order_id TEXT PRIMARY KEY REFERENCES transactions(id) ON DELETE CASCADE,
  recipient_name TEXT NOT NULL,phone TEXT NOT NULL,address TEXT NOT NULL,ward TEXT NOT NULL,district TEXT NOT NULL,province TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,locked_at TEXT
);
CREATE TABLE IF NOT EXISTS dispute_messages (
  id TEXT PRIMARY KEY,dispute_id TEXT NOT NULL REFERENCES disputes(id),actor_id TEXT REFERENCES users(id),message TEXT NOT NULL,created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS order_reminders (
  order_id TEXT NOT NULL REFERENCES transactions(id),kind TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(order_id,kind)
);

CREATE TABLE IF NOT EXISTS order_cancellation_notes(order_id TEXT PRIMARY KEY REFERENCES transactions(id),actor_id TEXT NOT NULL REFERENCES users(id),note TEXT NOT NULL,created_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS order_shipping_history(order_id TEXT NOT NULL REFERENCES transactions(id),version INTEGER NOT NULL,snapshot_json TEXT NOT NULL,changed_by TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,PRIMARY KEY(order_id,version));
