-- Migration PostgreSQL số 2: nguồn gốc quyền quản trị (xem src/lib/adminProvenance.js).
--
-- Chạy ĐÚNG MỘT LẦN (app.schema_migrations). Thứ tự quan trọng: tạo bảng -> backfill -> trigger,
-- vì trigger chặn mọi dòng LEGACY_BACKFILL chèn về sau.

CREATE TABLE app.admin_provenance (
  user_id TEXT PRIMARY KEY REFERENCES app.users(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('BOOTSTRAP_CLI','BOOTSTRAP_ENV','LEGACY_BACKFILL')),
  username_at_grant TEXT NOT NULL,
  granted_at TEXT NOT NULL
);

-- ADMIN có sẵn, không có ví USER (ADMIN có ví USER là dấu hiệu bị nâng quyền nên bị loại).
INSERT INTO app.admin_provenance (user_id, source, username_at_grant, granted_at)
SELECT u.id, 'LEGACY_BACKFILL', u.username, app.now_iso()
FROM app.users u
WHERE u.role = 'ADMIN'
  AND NOT EXISTS (SELECT 1 FROM app.wallets w WHERE w.user_id = u.id AND w.wallet_type = 'USER');

CREATE OR REPLACE FUNCTION app.forbid_admin_promotion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.role = 'ADMIN' AND OLD.role IS DISTINCT FROM 'ADMIN' THEN
    RAISE EXCEPTION 'ADMIN_PROMOTION_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_users_no_admin_promotion
  BEFORE UPDATE OF role ON app.users
  FOR EACH ROW EXECUTE FUNCTION app.forbid_admin_promotion();

CREATE OR REPLACE FUNCTION app.guard_admin_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.role = 'ADMIN' AND NEW.account_status IS DISTINCT FROM 'PENDING_BOOTSTRAP' THEN
    RAISE EXCEPTION 'ADMIN_PROMOTION_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_users_admin_insert_guard
  BEFORE INSERT ON app.users
  FOR EACH ROW EXECUTE FUNCTION app.guard_admin_insert();

CREATE OR REPLACE FUNCTION app.guard_admin_provenance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'ADMIN_PROVENANCE_IMMUTABLE' USING ERRCODE = '42501';
  END IF;
  IF NEW.source = 'LEGACY_BACKFILL' OR NOT EXISTS (
    SELECT 1 FROM app.users u
    WHERE u.id = NEW.user_id AND u.role = 'ADMIN' AND u.account_status = 'PENDING_BOOTSTRAP'
      AND NOT EXISTS (SELECT 1 FROM app.wallets w WHERE w.user_id = u.id)
  ) THEN
    RAISE EXCEPTION 'ADMIN_PROVENANCE_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_admin_provenance_guard
  BEFORE INSERT OR UPDATE ON app.admin_provenance
  FOR EACH ROW EXECUTE FUNCTION app.guard_admin_provenance();
