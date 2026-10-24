const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const Database=require('../src/lib/sqlite');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'enclave-auth-migration-'));
const raw=new Database(path.join(tmp,'old.db'));
try {
  raw.exec(fs.readFileSync(path.join(__dirname,'../src/schema.sql'),'utf8'));
  require('../src/lib/adminProvenance').migrateSqlite(raw);
  raw.prepare("INSERT INTO users(id,username,display_name,role,password_hash,account_status) VALUES('u','legacy','Người dùng cũ','BUYER','fixture-only','ACTIVE')").run();
  raw.prepare("INSERT INTO passkey_credentials(id,user_id,credential_id,public_key,device_name) VALUES('c','u','key-id',?,'Thiết bị cũ')").run(Buffer.from([1,2,3]));
  raw.prepare("INSERT INTO wallets(id,user_id,wallet_type,available_balance) VALUES('w','u','USER',10000)").run();
  raw.prepare("INSERT INTO wallet_entries(id,wallet_id,request_id,entry_type,available_delta,available_after,locked_after,idempotency_key) VALUES('e','w','r','DEMO_TOPUP',10000,10000,0,'original')").run();
  // Simulate existing auth-v10 tables, where CREATE TABLE IF NOT EXISTS cannot add columns.
  raw.exec("CREATE TABLE auth_email_codes (user_id TEXT PRIMARY KEY REFERENCES users(id),code_hash TEXT NOT NULL,expires_at TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,sent_at TEXT NOT NULL)");
  raw.exec("CREATE TABLE auth_email_outbox (id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),recipient TEXT NOT NULL,subject TEXT NOT NULL,body_cipher TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at TEXT NOT NULL,claim_until TEXT,sent_at TEXT,last_error TEXT,created_at TEXT NOT NULL)");
  raw.prepare("INSERT INTO auth_email_codes VALUES('u','old-hash','2030-01-01',2,'2026-10-21')").run();
  raw.prepare("INSERT INTO auth_email_outbox(id,user_id,recipient,subject,body_cipher,next_attempt_at,created_at) VALUES('mail','u','old@example.test','Existing','old-encrypted-body','2026-10-21','2026-10-21')").run();
  const backupPath=path.join(tmp,'before-upgrade.db');
  raw.prepare('VACUUM INTO ?').run(backupPath);
  require('../src/lib/authMigration').migrateSqlite(raw);
  require('../src/lib/adminProvenance').migrateSqlite(raw);
  require('../src/lib/authMigration').migrateSqlite(raw);
  assert.equal(raw.prepare("SELECT available_balance FROM wallets WHERE id='w'").get().available_balance,10000);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM wallet_entries').get().n,1);
  assert.deepEqual([...raw.prepare("SELECT public_key FROM passkey_credentials WHERE id='c'").get().public_key],[1,2,3]);
  assert.equal(raw.prepare("SELECT email_verified_at FROM users WHERE id='u'").get().email_verified_at,null);
  assert.deepEqual({...raw.prepare("SELECT code_hash,attempts,email FROM auth_email_codes WHERE user_id='u'").get()},{code_hash:'old-hash',attempts:2,email:null});
  assert.deepEqual({...raw.prepare("SELECT body_cipher,expires_at FROM auth_email_outbox WHERE id='mail'").get()},{body_cipher:'old-encrypted-body',expires_at:null});
  assert.equal(raw.prepare("SELECT user_handle FROM passkey_credentials WHERE id='c'").get().user_handle,null);
  assert.deepEqual(raw.pragma('foreign_key_check'),[]);
  assert.throws(()=>raw.prepare("UPDATE users SET role='ADMIN' WHERE id='u'").run(),/ADMIN_PROMOTION_FORBIDDEN/);
  const restoredPath=path.join(tmp,'restored.db');fs.copyFileSync(backupPath,restoredPath);
  const restored=new Database(restoredPath);
  try{
    assert.equal(restored.prepare("SELECT available_balance FROM wallets WHERE id='w'").get().available_balance,10000);
    assert.equal(restored.prepare("SELECT COUNT(*) AS n FROM wallet_entries").get().n,1);
    assert.equal(restored.prepare('SELECT code_hash FROM auth_email_codes').get().code_hash,'old-hash');
    assert.equal(restored.prepare('PRAGMA table_info(auth_email_codes)').all().some(c=>c.name==='email'),false);
    require('../src/lib/authMigration').migrateSqlite(restored);
    assert.equal(restored.prepare('SELECT body_cipher FROM auth_email_outbox').get().body_cipher,'old-encrypted-body');
    assert.deepEqual(restored.pragma('foreign_key_check'),[]);
  }finally{restored.close();}
  console.log('AUTH MIGRATION: preserves users, keys, balances, ledger, foreign keys, admin guards; repeat-safe; backup restore + upgrade PASS');
} finally {raw.close();}
