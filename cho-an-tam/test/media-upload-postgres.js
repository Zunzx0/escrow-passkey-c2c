'use strict';
// Media upload suite against a DEDICATED temporary PostgreSQL cluster (never an installed service, never .env,
// never a remote database). Mirrors test/order-money-postgres.js:
//   1. copy src/ and the suite into a throw-away snapshot so concurrent edits cannot change a run;
//   2. initdb + pg_ctl on 127.0.0.1 and a random free port, trust auth, database enclave_media_test;
//   3. build a legacy v11 database with a listing/order/wallet, apply 012, and let the application apply 013
//      (private-media-assets) itself at startup - the real upgrade path;
//   4. run test/media-upload-e2e.js --run (same file as SQLite) with a sanitized explicit environment;
//   5. verify migration 013 recorded, repeat-safe, legacy data untouched and no fabricated photos.
// Only the in-memory setMediaStorageForTests adapter is used for storage; MEDIA_STORAGE_* are never passed.
//
// Gate: PostgreSQL binaries are located via MEDIA_TEST_PG_BIN, then ORDER_TEST_PG_BIN, then the default
// Windows install path. If they are missing the run FAILS (like the order-money suite) unless
// MEDIA_TEST_PG_OPTIONAL=1, in which case it prints SKIPPED and exits 0 - a skip is not a pass.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const isWin = process.platform === 'win32';
const exe = (name) => (isWin ? name + '.exe' : name);
const bin = process.env.MEDIA_TEST_PG_BIN || process.env.ORDER_TEST_PG_BIN || (isWin ? 'C:/Program Files/PostgreSQL/17/bin' : '/usr/lib/postgresql/17/bin');
const DB = 'enclave_media_test';

function command(file, args) {
  const r = spawnSync(path.join(bin, exe(file)), args, { encoding: 'utf8', windowsHide: true, stdio: file === 'pg_ctl' ? 'ignore' : 'pipe', timeout: 120000 });
  if (r.error || r.status !== 0) throw new Error(file + ': ' + (r.error?.message || '') + (r.stderr || '') + (r.stdout || ''));
  return r;
}
function environment(url,absentEnvPath) {
  const env = {};
  for (const k of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT']) if (process.env[k]) env[k] = process.env[k];
  const key = crypto.randomBytes(32).toString('hex');
  return {
    ...env,
    NODE_PATH: path.join(root, 'node_modules'),
    APP_ENV: 'test', NODE_ENV: 'test', DATABASE_URL: url, MEDIA_TEST_DEDICATED_PG: '1',
    JWT_SECRET: key, PAYMENT_WEBHOOK_SECRET: key, MOCK_PROVIDER_SECRET: key, AUTH_SECRET_PEPPER: key, AUTH_MAIL_ENCRYPTION_KEY: key,
    AUTH_EMAIL_TRANSPORT: 'test', AUTH_PUBLIC_URL: 'https://enclave.example/', AUTH_BACKGROUND_JOBS: '0',
    RECONCILE_INTERVAL_SECONDS: '0', CHALLENGE_CLEANUP_INTERVAL_SECONDS: '0', SHIPPING_WORKER_INTERVAL_MS: '0',
    ORDER_INSPECTION_INTERVAL_MS: '0', ORDER_LIFECYCLE_WORKER_SECONDS: '0', MEDIA_CLEANUP_INTERVAL_SECONDS: '0', MEDIA_WORKER_SECONDS: '0',
    RATE_LIMIT_AUTH_PER_MINUTE: '100000', RATE_LIMIT_API_PER_MINUTE: '100000', AUTH_REGISTER_PER_IP_HOUR: '10000',
    WEBAUTHN_RP_ID: 'localhost', WEBAUTHN_ORIGIN: 'http://localhost', PGSSL: 'disable', SERVE_FRONTEND: '0',
    DOTENV_CONFIG_PATH: absentEnvPath,
    // MEDIA_STORAGE_URL / MEDIA_STORAGE_SERVICE_KEY / MEDIA_STORAGE_BUCKET are deliberately absent.
  };
}
async function availablePort() {
  const s = net.createServer();
  await new Promise((resolve, reject) => { s.once('error', reject); s.listen(0, '127.0.0.1', resolve); });
  const port = s.address().port;
  await new Promise((resolve) => s.close(resolve));
  return port;
}

async function main() {
  if (!fs.existsSync(path.join(bin, exe('initdb')))) {
    if (process.env.MEDIA_TEST_PG_OPTIONAL === '1') { console.log('MEDIA POSTGRES: SKIPPED (no PostgreSQL binaries at ' + bin + ') - this is NOT a pass'); return; }
    throw new Error('PostgreSQL binaries required at ' + bin + ' (set MEDIA_TEST_PG_BIN, or MEDIA_TEST_PG_OPTIONAL=1 to skip explicitly)');
  }
  const { Client } = require('pg');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enclave-media-pg-'));
  const data = path.join(dir, 'data'), snapshot = path.join(dir, 'suite');
  let started = false, failed = false;
  const files = ['schema.pg.sql', 'schema.pg.002-admin-provenance.sql', 'schema.pg.003-topup-idempotency.sql', 'schema.pg.004-payment-provider.sql',
    'schema.pg.005-paypal-bindings.sql', 'schema.pg.006-paypal-terminal-evidence.sql', 'schema.pg.007-simulated-shipping.sql', 'schema.pg.008-auth-redesign.sql',
    'schema.auth.sql', 'schema.pg.010-progressive-auth.sql', 'schema.pg.011-auth-verification-hardening.sql'];
  try {
    fs.mkdirSync(path.join(snapshot, 'test'), { recursive: true });
    fs.cpSync(path.join(root, 'src'), path.join(snapshot, 'src'), { recursive: true });
    fs.copyFileSync(path.join(root, 'test', 'media-upload-e2e.js'), path.join(snapshot, 'test', 'media-upload-e2e.js'));
    for (const f of [...files, 'schema.pg.012-order-lifecycle.sql', 'schema.pg.013-media.sql']) assert.ok(fs.existsSync(path.join(snapshot, 'src', f)), 'migration file present: ' + f);

    const port = await availablePort();
    command('initdb', ['-D', data, '-U', DB, '-A', 'trust', '--no-locale', '--encoding=UTF8', '--no-sync']);
    started = true;
    command('pg_ctl', ['-D', data, '-l', path.join(dir, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port}`, '-w', 'start']);
    const admin = new Client({ connectionString: `postgresql://${DB}@127.0.0.1:${port}/postgres` });
    await admin.connect();
    try { await admin.query(`CREATE DATABASE ${DB}`); } finally { await admin.end(); }
    const url = `postgresql://${DB}@127.0.0.1:${port}/${DB}`;

    // Legacy v11 data, then migration 012 (order lifecycle). Migration 013 is applied by the application itself.
    const c = new Client({ connectionString: url });
    await c.connect();
    try {
      await c.query('CREATE SCHEMA app; SET search_path TO app,public');
      await c.query('CREATE TABLE app.schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)');
      for (let i = 0; i < files.length; i++) {
        await c.query(fs.readFileSync(path.join(snapshot, 'src', files[i]), 'utf8'));
        await c.query('INSERT INTO app.schema_migrations VALUES($1,$2,$3)', [i + 1, files[i], new Date().toISOString()]);
      }
      await c.query("INSERT INTO users(id,username,display_name,role,password_hash,account_status) VALUES('media-legacy-buyer','media_legacy_buyer','Legacy buyer','BUYER','fixture','ACTIVE'),('media-legacy-seller','media_legacy_seller','Legacy seller','SELLER','fixture','ACTIVE')");
      await c.query("INSERT INTO passkey_credentials(id,user_id,credential_id,public_key) VALUES('media-legacy-buyer-key','media-legacy-buyer','media-legacy-buyer-credential',$1),('media-legacy-seller-key','media-legacy-seller','media-legacy-seller-credential',$1)",[Buffer.from('fixture-only')]);
      await c.query("INSERT INTO wallets(id,user_id,wallet_type,available_balance) VALUES('media-legacy-wallet','media-legacy-buyer','USER',10000)");
      await c.query("INSERT INTO wallet_entries(id,wallet_id,request_id,entry_type,available_delta,available_after,locked_after,idempotency_key) VALUES('media-legacy-entry','media-legacy-wallet','media-legacy-seed','DEMO_TOPUP',10000,10000,0,'preserved-media-legacy-ledger-key')");
      await c.query("INSERT INTO listings(id,seller_id,title,price,category,condition,visibility,status,version) VALUES('media-legacy-listing','media-legacy-seller','Legacy item without photos',60000,'SACH','GOOD','PUBLIC','AVAILABLE',3)");
      await c.query("INSERT INTO transactions(id,buyer_id,seller_id,item_name,amount,status,escrow_status,listing_id) VALUES('media-legacy-order','media-legacy-buyer','media-legacy-seller','Legacy item without photos',60000,'REFUNDED','REFUNDED','media-legacy-listing')");
      const m12 = 'schema.pg.012-order-lifecycle.sql';
      await c.query(fs.readFileSync(path.join(snapshot, 'src', m12), 'utf8'));
      await c.query('INSERT INTO app.schema_migrations VALUES($1,$2,$3)', [12, 'order-lifecycle-address-inspection', new Date().toISOString()]);
      assert.equal((await c.query('SELECT COUNT(*)::int n FROM information_schema.tables WHERE table_schema=$1 AND table_name=$2', ['app', 'media_assets'])).rows[0].n, 0, 'media tables absent before the app upgrade');
      console.log('POSTGRES legacy v12 fixture prepared (media migration 013 not applied yet)');
    } finally { await c.end(); }

    const result = spawnSync(process.execPath, ['test/media-upload-e2e.js', '--run'], {
      cwd: snapshot, env: environment(url,path.join(snapshot,'absent.env')), windowsHide: true, encoding: 'utf8', timeout: 420000, maxBuffer: 16 * 1024 * 1024,
    });
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    assert.equal(result.status, 0, 'PostgreSQL media HTTP + DB suite exited non-zero');
    assert.ok(/MEDIA_SUITE .*"dialect":"pg"/.test(result.stdout || '') && /MEDIA_RESULTS .*"dialect":"pg"/.test(result.stdout || ''), 'suite really ran on the PostgreSQL dialect');
    assert.ok(!/"result":"FAIL"/.test(result.stdout || ''), 'no failed case in the result summary');

    const v = new Client({ connectionString: url });
    await v.connect();
    try {
      await v.query('SET search_path TO app,public');
      const migration = (await v.query('SELECT version,name FROM app.schema_migrations WHERE version=13')).rows;
      assert.deepEqual(migration, [{ version: 13, name: 'private-media-assets' }], 'application recorded migration 13');
      const file = fs.readFileSync(path.join(snapshot, 'src', 'schema.pg.013-media.sql'), 'utf8');
      await v.query(file); await v.query(file); // repeat-safe
      const tables = (await v.query("SELECT table_name FROM information_schema.tables WHERE table_schema='app' AND table_name IN ('media_assets','media_cleanup_jobs','media_quota_locks','media_upload_rates','listing_media','dispute_media','order_media_snapshot') ORDER BY 1")).rows.map((r) => r.table_name);
      assert.deepEqual(tables, ['dispute_media', 'listing_media', 'media_assets', 'media_cleanup_jobs', 'media_quota_locks', 'media_upload_rates', 'order_media_snapshot']);
      // Legacy data untouched; no photo was fabricated for old listings or orders.
      assert.equal((await v.query("SELECT available_balance FROM wallets WHERE id='media-legacy-wallet'")).rows[0].available_balance, '10000');
      assert.equal((await v.query("SELECT version FROM listings WHERE id='media-legacy-listing'")).rows[0].version, 3);
      assert.equal((await v.query("SELECT COUNT(*)::int n FROM listing_media WHERE listing_id='media-legacy-listing'")).rows[0].n, 0);
      assert.equal((await v.query("SELECT COUNT(*)::int n FROM order_media_snapshot WHERE transaction_id='media-legacy-order'")).rows[0].n, 0);
      // Database-level guards that must hold regardless of application code.
      const uniques = (await v.query("SELECT indexdef FROM pg_indexes WHERE schemaname='app' AND tablename IN ('listing_media','dispute_media','media_assets')")).rows.map((r) => r.indexdef).join('\n');
      assert.match(uniques, /listing_media.*\(asset_id\)/s, 'one asset belongs to at most one listing slot');
      assert.match(uniques, /dispute_media.*\(asset_id\)/s, 'one asset belongs to at most one dispute');
      assert.match(uniques, /media_assets.*\(owner_id, request_id\)/s, 'requestId is unique per owner');
      assert.equal((await v.query("SELECT COUNT(*)::int n FROM media_assets WHERE status='UPLOADING' AND expires_at < $1", [new Date(Date.now() - 86400000).toISOString()])).rows[0].n, 0, 'no stuck stale reservations');
      assert.equal((await v.query('SELECT COUNT(*)::int n FROM dispute_media dm JOIN media_assets a ON a.id=dm.asset_id WHERE a.purpose<>$1', ['EVIDENCE'])).rows[0].n, 0);
      assert.equal((await v.query('SELECT COUNT(*)::int n FROM listing_media lm JOIN media_assets a ON a.id=lm.asset_id WHERE a.purpose<>$1', ['LISTING'])).rows[0].n, 0);
    } finally { await v.end(); }
    console.log('MEDIA POSTGRES: harness finished (suite exit 0, migration 013 verified). Not a pass claim until a human reads the case list above.');
  } catch (e) {
    failed = true;
    throw e;
  } finally {
    if (started && fs.existsSync(path.join(data, 'postmaster.pid'))) {
      try { command('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']); } catch (e) { console.error('pg_ctl stop failed: ' + e.message); }
    }
    console.log('Dedicated PostgreSQL stopped; temp directory ' + dir);
    if (!failed && process.env.MEDIA_TEST_KEEP !== '1') {
      const resolved = path.resolve(dir);
      if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('enclave-media-pg-')) {
        try { fs.rmSync(resolved, { recursive: true, force: true }); } catch { /* leave for manual inspection */ }
      }
    }
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
