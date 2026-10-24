ALTER TABLE users DROP CONSTRAINT users_account_status_check;
ALTER TABLE users ADD CONSTRAINT users_account_status_check CHECK
  (account_status IN ('PENDING_BOOTSTRAP','PENDING_EMAIL','PENDING_PASSKEY','BASIC','VERIFIED','ACTIVE','RECOVERING','SUSPENDED'));
ALTER TABLE users ADD COLUMN auth_last_active_at TEXT;
ALTER TABLE transactions ADD COLUMN inspection_due_at TEXT;
CREATE INDEX idx_transactions_inspection_due ON transactions(status,inspection_due_at);
DROP INDEX IF EXISTS idx_users_email;
CREATE UNIQUE INDEX idx_users_email ON users(email) WHERE email_verified_at IS NOT NULL;
UPDATE users SET account_status=CASE WHEN email_verified_at IS NULL THEN 'BASIC' ELSE 'VERIFIED' END
  WHERE role<>'ADMIN' AND account_status IN ('PENDING_EMAIL','PENDING_PASSKEY');
ALTER TABLE reauth_grants DROP CONSTRAINT reauth_grants_action_check;
ALTER TABLE reauth_grants ADD CONSTRAINT reauth_grants_action_check CHECK (action IN
  ('RELEASE_ESCROW','ADJUDICATE','MANAGE_CREDENTIAL','CHANGE_PASSWORD','ADD_CREDENTIAL','REMOVE_CREDENTIAL','REGENERATE_RECOVERY','CHANGE_EMAIL','UPGRADE_SESSION','LOCK_ESCROW'));
