ALTER TABLE passkey_credentials ADD COLUMN IF NOT EXISTS user_handle TEXT;
ALTER TABLE auth_email_codes ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE auth_email_outbox ADD COLUMN IF NOT EXISTS expires_at TEXT;
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
