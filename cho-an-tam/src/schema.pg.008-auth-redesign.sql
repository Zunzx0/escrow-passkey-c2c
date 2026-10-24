ALTER TABLE users DROP CONSTRAINT IF EXISTS users_account_status_check;
ALTER TABLE users ADD CONSTRAINT users_account_status_check CHECK
  (account_status IN ('PENDING_BOOTSTRAP','PENDING_EMAIL','PENDING_PASSKEY','ACTIVE','RECOVERING','SUSPENDED'));
ALTER TABLE users ADD COLUMN email TEXT;
ALTER TABLE users ADD COLUMN email_verified_at TEXT;
ALTER TABLE users ADD COLUMN webauthn_user_id TEXT;
ALTER TABLE users ADD COLUMN recovery_acknowledged INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN recovery_restricted_until TEXT;
ALTER TABLE passkey_credentials ADD COLUMN backup_eligible INTEGER;
ALTER TABLE passkey_credentials ADD COLUMN backed_up INTEGER;
ALTER TABLE sessions ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'password' CHECK (auth_method IN ('password','passkey','recovery'));
ALTER TABLE sessions ADD COLUMN auth_at TEXT;
ALTER TABLE sessions ADD COLUMN device_name TEXT;
ALTER TABLE sessions ADD COLUMN enrollment_verified_at TEXT;
ALTER TABLE reauth_grants DROP CONSTRAINT IF EXISTS reauth_grants_action_check;
ALTER TABLE reauth_grants ADD CONSTRAINT reauth_grants_action_check CHECK (action IN
  ('RELEASE_ESCROW','ADJUDICATE','MANAGE_CREDENTIAL','CHANGE_PASSWORD','ADD_CREDENTIAL','REMOVE_CREDENTIAL','REGENERATE_RECOVERY','CHANGE_EMAIL','UPGRADE_SESSION'));
ALTER TABLE reauth_grants ADD COLUMN credential_id TEXT;
ALTER TABLE reauth_grants ADD COLUMN target_id TEXT;
