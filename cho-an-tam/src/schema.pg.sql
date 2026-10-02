-- Lược đồ PostgreSQL (Supabase) — cùng nghiệp vụ, cùng ràng buộc với src/schema.sql (SQLite).
-- Giải thích ý nghĩa từng bảng và từng ràng buộc nằm ở schema.sql; tệp này chỉ ghi những chỗ
-- KHÁC so với bản SQLite và lý do.
--
-- 1. Mọi bảng nằm trong schema riêng `app` (Mock Provider nằm ở `mock_provider`), không nằm ở
--    `public`. Supabase chỉ phơi `public` qua Data API (PostgREST), nên frontend hay bất kỳ ai cầm
--    anon key cũng không đọc/ghi thẳng được bảng nghiệp vụ. Chỉ backend, đi bằng chuỗi kết nối
--    PostgreSQL riêng, mới chạm được tới đây.
--
-- 2. Thời điểm vẫn lưu dạng TEXT ISO-8601 (2026-10-02T08:15:30.123Z), KHÔNG đổi sang TIMESTAMPTZ.
--    Chuỗi băm nhật ký (lib/hash.js) băm nguyên văn created_at; TIMESTAMPTZ đọc ra sẽ có định dạng
--    khác (2026-10-02 08:15:30.123+00) và làm mọi bản ghi cũ bị coi là đã bị sửa. Chuỗi ISO cùng độ
--    dài nên so sánh chuỗi cũng chính là so sánh thời gian.
--
-- 3. Cột JSON (context_data, event_data, detail, transports) cũng giữ TEXT, cùng lý do với (2):
--    JSONB sắp xếp lại khoá và khoảng trắng, nội dung đọc ra không còn y hệt nội dung đã băm.
--
-- 4. Số tiền, số dư và signCount dùng BIGINT; lớp truy cập (lib/asyncDb.js) đọc BIGINT về Number
--    và từ chối giá trị vượt Number.MAX_SAFE_INTEGER thay vì làm tròn im lặng.
--
-- 5. Thứ tự tạo bảng theo khoá ngoại: disputes phải có trước reauth_grants.

CREATE SCHEMA IF NOT EXISTS app;
CREATE SCHEMA IF NOT EXISTS mock_provider;

CREATE OR REPLACE FUNCTION app.now_iso() RETURNS TEXT
  LANGUAGE sql STABLE
  AS $$ SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') $$;

CREATE TABLE IF NOT EXISTS app.users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('BUYER','SELLER','ADMIN')),
  password_hash TEXT NOT NULL,
  account_status TEXT NOT NULL DEFAULT 'PENDING_PASSKEY'
    CHECK (account_status IN ('PENDING_BOOTSTRAP','PENDING_PASSKEY','ACTIVE')),
  token_version INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT app.now_iso(),
  updated_at TEXT NOT NULL DEFAULT app.now_iso()
);

CREATE TABLE IF NOT EXISTS app.passkey_credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,
  public_key BYTEA NOT NULL,
  counter BIGINT NOT NULL DEFAULT 0,
  transports TEXT,
  device_name TEXT,
  created_at TEXT NOT NULL DEFAULT app.now_iso(),
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_passkey_credentials_user ON app.passkey_credentials(user_id);

CREATE TABLE IF NOT EXISTS app.seller_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  shop_name TEXT NOT NULL,
  pitch TEXT,
  status TEXT NOT NULL CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  review_note TEXT,
  reviewed_by TEXT REFERENCES app.users(id) ON DELETE SET NULL,
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT app.now_iso(),
  updated_at TEXT NOT NULL DEFAULT app.now_iso()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_seller_requests_one_pending
  ON app.seller_requests(user_id) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS idx_seller_requests_status ON app.seller_requests(status, created_at);

CREATE TABLE IF NOT EXISTS app.wallets (
  id TEXT PRIMARY KEY,
  user_id TEXT UNIQUE REFERENCES app.users(id) ON DELETE CASCADE,
  wallet_type TEXT NOT NULL CHECK (wallet_type IN ('USER','SYSTEM_ESCROW')),
  available_balance BIGINT NOT NULL DEFAULT 0 CHECK (available_balance >= 0),
  locked_balance BIGINT NOT NULL DEFAULT 0 CHECK (locked_balance >= 0),
  version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT app.now_iso(),
  updated_at TEXT NOT NULL DEFAULT app.now_iso(),
  CHECK (
    (wallet_type = 'USER' AND user_id IS NOT NULL)
    OR (wallet_type = 'SYSTEM_ESCROW' AND user_id IS NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_single_system_escrow_wallet
  ON app.wallets(wallet_type) WHERE wallet_type = 'SYSTEM_ESCROW';

CREATE TABLE IF NOT EXISTS app.payment_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  amount BIGINT NOT NULL CHECK (amount > 0),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SUCCEEDED','FAILED')),
  provider_ref TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL DEFAULT 0,
  resolved_at TEXT,
  resolved_by TEXT CHECK (resolved_by IS NULL OR resolved_by IN ('WEBHOOK','RECONCILER')),
  reconcile_attempts INTEGER NOT NULL DEFAULT 0,
  last_reconciled_at TEXT,
  last_reconcile_error TEXT,
  created_at TEXT NOT NULL DEFAULT app.now_iso(),
  updated_at TEXT NOT NULL DEFAULT app.now_iso()
);
CREATE INDEX IF NOT EXISTS idx_payment_requests_user ON app.payment_requests(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_payment_requests_pending ON app.payment_requests(status, created_at);

CREATE TABLE IF NOT EXISTS app.listings (
  id TEXT PRIMARY KEY,
  seller_id TEXT NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL,
  location TEXT,
  condition TEXT NOT NULL DEFAULT 'GOOD' CHECK (condition IN ('NEW','LIKE_NEW','GOOD','FAIR')),
  image TEXT,
  price BIGINT NOT NULL CHECK (price > 0),
  visibility TEXT NOT NULL DEFAULT 'PUBLIC' CHECK (visibility IN ('PUBLIC','HIDDEN')),
  status TEXT NOT NULL DEFAULT 'AVAILABLE' CHECK (status IN ('AVAILABLE','LOCKED','SOLD')),
  version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT app.now_iso(),
  updated_at TEXT NOT NULL DEFAULT app.now_iso()
);
CREATE INDEX IF NOT EXISTS idx_listings_seller ON app.listings(seller_id);
CREATE INDEX IF NOT EXISTS idx_listings_category ON app.listings(category, visibility);

CREATE TABLE IF NOT EXISTS app.transactions (
  id TEXT PRIMARY KEY,
  buyer_id TEXT NOT NULL REFERENCES app.users(id),
  seller_id TEXT NOT NULL REFERENCES app.users(id),
  item_name TEXT NOT NULL,
  item_description TEXT,
  amount BIGINT NOT NULL CHECK (amount > 0),
  status TEXT NOT NULL DEFAULT 'CREATED' CHECK (status IN
    ('CREATED','SECURED','SHIPPING','WAIT_CONFIRM','COMPLETED','DISPUTED','REFUNDED','RELEASED')),
  escrow_status TEXT NOT NULL DEFAULT 'NONE' CHECK (escrow_status IN
    ('NONE','LOCKED','FROZEN','RELEASED','REFUNDED')),
  listing_id TEXT REFERENCES app.listings(id),
  buyer_note TEXT,
  seller_ack_at TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT app.now_iso(),
  updated_at TEXT NOT NULL DEFAULT app.now_iso(),
  CHECK (buyer_id <> seller_id)
);
CREATE INDEX IF NOT EXISTS idx_transaction_buyer ON app.transactions(buyer_id);
CREATE INDEX IF NOT EXISTS idx_transaction_seller ON app.transactions(seller_id);
CREATE INDEX IF NOT EXISTS idx_transaction_status ON app.transactions(status);
CREATE INDEX IF NOT EXISTS idx_transaction_listing ON app.transactions(listing_id, status);

CREATE TABLE IF NOT EXISTS app.disputes (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL UNIQUE REFERENCES app.transactions(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES app.users(id),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED_REFUND','RESOLVED_RELEASE')),
  admin_id TEXT REFERENCES app.users(id),
  admin_decision TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT app.now_iso()
);
CREATE INDEX IF NOT EXISTS idx_disputes_status ON app.disputes(status);

CREATE TABLE IF NOT EXISTS app.auth_challenges (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES app.users(id) ON DELETE CASCADE,
  transaction_id TEXT REFERENCES app.transactions(id) ON DELETE CASCADE,
  challenge TEXT NOT NULL UNIQUE,
  purpose TEXT NOT NULL CHECK (purpose IN ('REGISTRATION','AUTHENTICATION','REAUTH','ADMIN_BOOTSTRAP')),
  context_data TEXT NOT NULL DEFAULT '{}',
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT app.now_iso()
);
CREATE INDEX IF NOT EXISTS idx_auth_challenges_lookup ON app.auth_challenges(purpose, expires_at, used_at);

CREATE TABLE IF NOT EXISTS app.wallet_entries (
  id TEXT PRIMARY KEY,
  wallet_id TEXT NOT NULL REFERENCES app.wallets(id),
  transaction_id TEXT REFERENCES app.transactions(id),
  request_id TEXT NOT NULL,
  entry_type TEXT NOT NULL CHECK (entry_type IN
    ('DEMO_TOPUP','TOPUP_CREDIT','ESCROW_LOCK_DEBIT','ESCROW_LOCK_CREDIT','ESCROW_RELEASE_DEBIT',
     'ESCROW_RELEASE_CREDIT','ESCROW_REFUND_DEBIT','ESCROW_REFUND_CREDIT')),
  available_delta BIGINT NOT NULL DEFAULT 0,
  locked_delta BIGINT NOT NULL DEFAULT 0,
  available_after BIGINT NOT NULL CHECK (available_after >= 0),
  locked_after BIGINT NOT NULL CHECK (locked_after >= 0),
  idempotency_key TEXT NOT NULL UNIQUE,
  request_fingerprint TEXT,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT app.now_iso(),
  CHECK (available_delta <> 0 OR locked_delta <> 0)
);
CREATE INDEX IF NOT EXISTS idx_wallet_entries_wallet ON app.wallet_entries(wallet_id, created_at);
CREATE INDEX IF NOT EXISTS idx_wallet_entries_transaction ON app.wallet_entries(transaction_id, created_at);
CREATE INDEX IF NOT EXISTS idx_wallet_entries_request ON app.wallet_entries(request_id);

CREATE TABLE IF NOT EXISTS app.sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  refresh_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON app.sessions(user_id);

CREATE TABLE IF NOT EXISTS app.reauth_grants (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  session_id TEXT,
  transaction_id TEXT REFERENCES app.transactions(id) ON DELETE CASCADE,
  dispute_id TEXT REFERENCES app.disputes(id) ON DELETE CASCADE,
  action TEXT NOT NULL DEFAULT 'RELEASE_ESCROW'
    CHECK (action IN ('RELEASE_ESCROW','ADJUDICATE','MANAGE_CREDENTIAL','CHANGE_PASSWORD')),
  decision TEXT CHECK (decision IS NULL OR decision IN ('REFUND','RELEASE')),
  token_hash TEXT NOT NULL UNIQUE,
  context_hash TEXT,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT app.now_iso(),
  CHECK (action <> 'RELEASE_ESCROW' OR (transaction_id IS NOT NULL AND decision IS NULL)),
  CHECK (action <> 'ADJUDICATE'
         OR (transaction_id IS NOT NULL AND dispute_id IS NOT NULL AND decision IS NOT NULL)),
  CHECK (action NOT IN ('MANAGE_CREDENTIAL','CHANGE_PASSWORD')
         OR (transaction_id IS NULL AND dispute_id IS NULL AND decision IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_reauth_grants_lookup ON app.reauth_grants(user_id, transaction_id, expires_at);

CREATE TABLE IF NOT EXISTS app.audit_logs (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES app.transactions(id) ON DELETE CASCADE,
  sequence_no INTEGER NOT NULL,
  actor_id TEXT REFERENCES app.users(id),
  action TEXT NOT NULL,
  old_status TEXT,
  new_status TEXT,
  event_data TEXT NOT NULL DEFAULT '{}',
  previous_hash TEXT NOT NULL,
  current_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT app.now_iso(),
  UNIQUE (transaction_id, sequence_no)
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_transaction ON app.audit_logs(transaction_id, sequence_no);

CREATE TABLE IF NOT EXISTS app.notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  transaction_id TEXT REFERENCES app.transactions(id) ON DELETE CASCADE,
  payment_request_id TEXT REFERENCES app.payment_requests(id) ON DELETE CASCADE,
  dedupe_key TEXT NOT NULL UNIQUE,
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT app.now_iso()
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON app.notifications(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS app.security_events (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  event_type TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('DENIED','ALLOWED')),
  actor_id TEXT REFERENCES app.users(id) ON DELETE SET NULL,
  username TEXT,
  ip TEXT,
  method TEXT,
  route TEXT,
  status_code INTEGER,
  detail TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT app.now_iso()
);
CREATE INDEX IF NOT EXISTS idx_security_events_time ON app.security_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_events_type ON app.security_events(event_type, created_at DESC);

-- Kho trạng thái riêng của Mock Payment Provider. Cùng cơ sở dữ liệu nhưng KHÁC schema, và
-- backend nghiệp vụ không bao giờ đọc tắt bảng này để quyết định kết quả — nó chỉ biết kết quả
-- qua webhook đã ký hoặc qua hàm queryStatus (xem lib/mockPaymentProvider.js).
CREATE TABLE IF NOT EXISTS mock_provider.provider_payments (
  provider_ref TEXT PRIMARY KEY,
  merchant_ref TEXT NOT NULL,
  amount BIGINT NOT NULL CHECK (amount > 0),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SUCCEEDED','FAILED')),
  query_mode TEXT NOT NULL DEFAULT 'NORMAL' CHECK (query_mode IN ('NORMAL','ERROR')),
  query_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Trên Supabase: thu mọi quyền của hai vai trò mà Data API dùng. Hai schema này đã không được
-- phơi qua Data API; đây là lớp phòng thủ thứ hai nếu ai đó lỡ thêm chúng vào danh sách phơi.
-- Trên PostgreSQL thường (máy dev, CI) hai vai trò này không tồn tại nên khối lệnh bỏ qua.
DO $$
DECLARE r TEXT;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA app, mock_provider FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA app, mock_provider FROM %I', r);
    END IF;
  END LOOP;
END $$;
