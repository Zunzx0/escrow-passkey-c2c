-- Auth v3: shared durable state. Compatible with SQLite and PostgreSQL.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email_verified_at IS NOT NULL;
CREATE TABLE IF NOT EXISTS auth_limits (
  bucket_key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_login_throttles (
  identity_hash TEXT PRIMARY KEY, failures TEXT NOT NULL DEFAULT '[]',
  locked_until BIGINT NOT NULL DEFAULT 0, lock_count INTEGER NOT NULL DEFAULT 0,
  last_failure_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_email_codes (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL, expires_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  sent_at TEXT NOT NULL, email TEXT
);
CREATE TABLE IF NOT EXISTS auth_otp_failures (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  failed_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_otp_failures_user ON auth_otp_failures(user_id,failed_at);
CREATE TABLE IF NOT EXISTS auth_otp_locks (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  locked_until BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_email_sends (
  id TEXT PRIMARY KEY, recipient_hash TEXT NOT NULL, sent_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_email_sends_recipient ON auth_email_sends(recipient_hash,sent_at);
CREATE TABLE IF NOT EXISTS auth_registration_flows (
  id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  email_mask TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT
);
CREATE TABLE IF NOT EXISTS auth_recovery_codes (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE, used_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_links (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE, purpose TEXT NOT NULL, context_data TEXT NOT NULL DEFAULT '{}',
  expires_at TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS account_recoveries (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('WAITING','READY','COMPLETED','CANCELLED')),
  available_at TEXT NOT NULL, expires_at TEXT NOT NULL, reminded_12 INTEGER NOT NULL DEFAULT 0,
  reminded_23 INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_account_recoveries_pending ON account_recoveries(user_id)
  WHERE status IN ('WAITING','READY');
CREATE TABLE IF NOT EXISTS auth_email_changes (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL, new_email TEXT NOT NULL, old_code_hash TEXT, new_code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, expires_at TEXT NOT NULL, used_at TEXT
);
CREATE TABLE IF NOT EXISTS auth_refresh_history (
  token_hash TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_audit (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_audit_user ON auth_audit(user_id, created_at);
-- Body encrypted with AES-256-GCM; no OTP, reset token, or recovery link in logs.
CREATE TABLE IF NOT EXISTS auth_email_outbox (
  id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  recipient TEXT NOT NULL, subject TEXT NOT NULL, body_cipher TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL,
  claim_until TEXT, sent_at TEXT, last_error TEXT, created_at TEXT NOT NULL, expires_at TEXT
);
