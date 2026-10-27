ALTER TABLE app.listings DROP CONSTRAINT IF EXISTS listings_status_check;
ALTER TABLE app.listings ADD CONSTRAINT listings_status_check CHECK(status IN ('AVAILABLE','LOCKED','SOLD','PENDING_SELLER_REVIEW'));
ALTER TABLE app.transactions DROP CONSTRAINT IF EXISTS transactions_status_check;
ALTER TABLE app.transactions ADD CONSTRAINT transactions_status_check CHECK(status IN ('CREATED','SECURED','SHIPPING','WAIT_CONFIRM','COMPLETED','DISPUTED','REFUNDED','RELEASED','CANCELLED'));
ALTER TABLE app.disputes ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE app.disputes DROP CONSTRAINT IF EXISTS disputes_status_check;
ALTER TABLE app.disputes ADD CONSTRAINT disputes_status_check CHECK(status IN ('OPEN','RESOLVED_REFUND','RESOLVED_RELEASE','RESOLVED_BY_BUYER_RELEASE'));
ALTER TABLE app.transactions ADD COLUMN IF NOT EXISTS secured_at TEXT;
ALTER TABLE app.transactions ADD COLUMN IF NOT EXISTS draft_expires_at TEXT;
ALTER TABLE app.transactions ADD COLUMN IF NOT EXISTS order_request_id TEXT;
ALTER TABLE app.transactions ADD COLUMN IF NOT EXISTS order_request_hash TEXT;
ALTER TABLE app.transactions ADD COLUMN IF NOT EXISTS cancelled_at TEXT;
ALTER TABLE app.transactions ADD COLUMN IF NOT EXISTS cancel_reason TEXT;
ALTER TABLE app.transactions ADD COLUMN IF NOT EXISTS inspected_at TEXT;
ALTER TABLE app.transactions ADD COLUMN IF NOT EXISTS inspected_by TEXT REFERENCES app.users(id);
ALTER TABLE app.transactions ADD COLUMN IF NOT EXISTS received_confirmed_at TEXT;
ALTER TABLE app.transactions ADD COLUMN IF NOT EXISTS received_confirmed_by TEXT CHECK(received_confirmed_by IN ('BUYER','SYSTEM'));
ALTER TABLE app.disputes ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'DEFECT';
ALTER TABLE app.disputes ADD COLUMN IF NOT EXISTS opened_by TEXT NOT NULL DEFAULT 'BUYER';
ALTER TABLE app.disputes ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE app.disputes ADD COLUMN IF NOT EXISTS buyer_never_confirmed_receipt INTEGER NOT NULL DEFAULT 0;
ALTER TABLE app.disputes ADD COLUMN IF NOT EXISTS evidence_due_at TEXT;
ALTER TABLE app.disputes ADD COLUMN IF NOT EXISTS admin_due_at TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS ux_order_request ON app.transactions(buyer_id,order_request_id) WHERE order_request_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS app.buyer_order_locks (buyer_id TEXT PRIMARY KEY REFERENCES app.users(id),version INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS app.order_shipping_snapshot (
  order_id TEXT PRIMARY KEY REFERENCES app.transactions(id) ON DELETE CASCADE,
  recipient_name TEXT NOT NULL,phone TEXT NOT NULL,address TEXT NOT NULL,ward TEXT NOT NULL,district TEXT NOT NULL,province TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,locked_at TEXT
);
CREATE TABLE IF NOT EXISTS app.dispute_messages (
  id TEXT PRIMARY KEY,dispute_id TEXT NOT NULL REFERENCES app.disputes(id),actor_id TEXT REFERENCES app.users(id),message TEXT NOT NULL,created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS app.order_reminders (
  order_id TEXT NOT NULL REFERENCES app.transactions(id),kind TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(order_id,kind)
);

CREATE TABLE IF NOT EXISTS app.order_cancellation_notes(order_id TEXT PRIMARY KEY REFERENCES app.transactions(id),actor_id TEXT NOT NULL REFERENCES app.users(id),note TEXT NOT NULL,created_at TEXT NOT NULL);

UPDATE app.transactions SET secured_at=(SELECT MIN(a.created_at) FROM app.audit_logs a WHERE a.transaction_id=app.transactions.id AND a.action='ESCROW_LOCKED') WHERE secured_at IS NULL AND EXISTS(SELECT 1 FROM app.audit_logs a WHERE a.transaction_id=app.transactions.id AND a.action='ESCROW_LOCKED');

CREATE TABLE IF NOT EXISTS app.order_shipping_history(order_id TEXT NOT NULL REFERENCES app.transactions(id),version INTEGER NOT NULL,snapshot_json TEXT NOT NULL,changed_by TEXT NOT NULL REFERENCES app.users(id),created_at TEXT NOT NULL,PRIMARY KEY(order_id,version));
