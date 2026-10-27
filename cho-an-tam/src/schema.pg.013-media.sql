CREATE TABLE IF NOT EXISTS app.media_assets (
 id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES app.users(id),
 purpose TEXT NOT NULL CHECK(purpose IN ('LISTING','EVIDENCE')),transaction_id TEXT REFERENCES app.transactions(id),
 request_id TEXT NOT NULL,input_sha256 TEXT NOT NULL,output_sha256 TEXT,
 width INTEGER,height INTEGER,bytes INTEGER NOT NULL DEFAULT 0,reserved_bytes INTEGER NOT NULL DEFAULT 524288,
 status TEXT NOT NULL CHECK(status IN ('UPLOADING','STAGED','ATTACHED','FAILED','EXPIRED')),
 storage_key TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL,expires_at TEXT NOT NULL,updated_at TEXT NOT NULL,
 version INTEGER NOT NULL DEFAULT 0,storage_deleted_at TEXT,
 UNIQUE(owner_id,request_id)
);
CREATE INDEX IF NOT EXISTS idx_media_pending ON app.media_assets(status,expires_at);
CREATE INDEX IF NOT EXISTS idx_media_owner ON app.media_assets(owner_id,status);
CREATE TABLE IF NOT EXISTS app.media_quota_locks (id TEXT PRIMARY KEY,version INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS app.media_upload_rates (user_id TEXT PRIMARY KEY REFERENCES app.users(id),window_start TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS app.media_cleanup_jobs (
 storage_key TEXT PRIMARY KEY,asset_id TEXT NOT NULL REFERENCES app.media_assets(id),owner_id TEXT NOT NULL REFERENCES app.users(id),
 asset_version INTEGER NOT NULL,reserved_bytes INTEGER NOT NULL DEFAULT 524288,
 created_at TEXT NOT NULL,updated_at TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 0,deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_media_cleanup_pending ON app.media_cleanup_jobs(deleted_at,owner_id);
CREATE TABLE IF NOT EXISTS app.listing_media (
 listing_id TEXT NOT NULL REFERENCES app.listings(id),asset_id TEXT NOT NULL UNIQUE REFERENCES app.media_assets(id),position INTEGER NOT NULL,
 PRIMARY KEY(listing_id,position)
);
CREATE TABLE IF NOT EXISTS app.dispute_media (
 dispute_id TEXT NOT NULL REFERENCES app.disputes(id),asset_id TEXT NOT NULL UNIQUE REFERENCES app.media_assets(id),
 actor_id TEXT NOT NULL REFERENCES app.users(id),attached_at TEXT NOT NULL,
 PRIMARY KEY(dispute_id,asset_id)
);
CREATE TABLE IF NOT EXISTS app.order_media_snapshot (
 transaction_id TEXT NOT NULL REFERENCES app.transactions(id),asset_id TEXT NOT NULL REFERENCES app.media_assets(id),position INTEGER NOT NULL,sha256 TEXT NOT NULL,
 PRIMARY KEY(transaction_id,position),UNIQUE(transaction_id,asset_id)
);
