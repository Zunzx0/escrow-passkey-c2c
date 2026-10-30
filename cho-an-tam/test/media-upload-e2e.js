'use strict';
// Media upload acceptance suite: real route modules over real HTTP + Sharp fixtures + isolated DB +
// an explicitly injected in-memory PRIVATE storage adapter (setMediaStorageForTests, APP_ENV=test only).
//
// Safety properties of this harness:
//  - the parent process only spawns a child with a sanitized, explicit environment;
//  - the child uses the actual src/server.js application with an explicitly absent
//    DOTENV_CONFIG_PATH; no .env file or inherited secret/storage setting is read;
//  - no MEDIA_STORAGE_* value is ever provided; the only storage is the in-memory adapter below;
//  - fixtures are generated in memory with Sharp (synthetic solid colours / noise, no real photo/person);
//  - nothing talks to the network except 127.0.0.1 loopback to the app under test.
//
// Modes: no argument = launcher (temporary SQLite); `--run` = child worker (also used by
// test/media-upload-postgres.js against a dedicated local PostgreSQL, gated by MEDIA_TEST_DEDICATED_PG=1).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const BASE_DIR = path.join(ROOT, 'data', 'test');
const mode = process.argv[2];

function safeEnv(file) {
  const env = {};
  for (const k of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT', 'NODE_PATH']) {
    if (process.env[k]) env[k] = process.env[k];
  }
  const key = crypto.randomBytes(32).toString('hex');
  return {
    ...env,
    APP_ENV: 'test', NODE_ENV: 'test', DATABASE_URL: '', DB_PATH: file,
    DOTENV_CONFIG_PATH: path.join(path.dirname(file), 'absent.env'),
    JWT_SECRET: key, PAYMENT_WEBHOOK_SECRET: key, MOCK_PROVIDER_SECRET: key, AUTH_SECRET_PEPPER: key,
    AUTH_MAIL_ENCRYPTION_KEY: key, AUTH_EMAIL_TRANSPORT: 'test', AUTH_PUBLIC_URL: 'https://enclave.example/',
    AUTH_BACKGROUND_JOBS: '0', RECONCILE_INTERVAL_SECONDS: '0', CHALLENGE_CLEANUP_INTERVAL_SECONDS: '0',
    SHIPPING_WORKER_INTERVAL_MS: '0', ORDER_INSPECTION_INTERVAL_MS: '0', ORDER_LIFECYCLE_WORKER_SECONDS: '0',
    MEDIA_CLEANUP_INTERVAL_SECONDS: '0', MEDIA_WORKER_SECONDS: '0',
    RATE_LIMIT_AUTH_PER_MINUTE: '100000', RATE_LIMIT_API_PER_MINUTE: '100000', AUTH_REGISTER_PER_IP_HOUR: '10000',
    WEBAUTHN_RP_ID: 'localhost', WEBAUTHN_ORIGIN: 'http://localhost', PGSSL: 'disable', SERVE_FRONTEND: '0',
    // MEDIA_STORAGE_URL / MEDIA_STORAGE_SERVICE_KEY / MEDIA_STORAGE_BUCKET are deliberately absent.
  };
}

async function launch() {
  fs.mkdirSync(BASE_DIR, { recursive: true });
  const dir = fs.mkdtempSync(path.join(BASE_DIR, 'media-upload-'));
  const snapshot=path.join(dir,'suite'),dbDir=path.join(snapshot,'data','test','media-upload-local');
  fs.mkdirSync(path.join(snapshot,'test'),{recursive:true});fs.mkdirSync(dbDir,{recursive:true});
  fs.cpSync(path.join(ROOT,'src'),path.join(snapshot,'src'),{recursive:true});
  fs.copyFileSync(__filename,path.join(snapshot,'test','media-upload-e2e.js'));
  const file = path.join(dbDir, 'media.db');
  console.log('MEDIA_SOURCE_SNAPSHOT '+snapshot);
  try {
    const result = await new Promise((resolve, reject) => {
      const c = spawn(process.execPath, [path.join(snapshot,'test','media-upload-e2e.js'), '--run'], {
        cwd: snapshot, env: {...safeEnv(file),NODE_PATH:path.join(ROOT,'node_modules')}, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      });
      let stdout = '', stderr = '';
      const timer = setTimeout(() => { c.kill(); reject(new Error('media suite timed out')); }, 420000);
      c.stdout.on('data', (x) => { stdout += x;process.stdout.write(x); });
      c.stderr.on('data', (x) => { stderr += x;process.stderr.write(x); });
      c.once('error', (e) => { clearTimeout(timer); reject(e); });
      c.once('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });
    process.exitCode = result.code === 0 ? 0 : 1;
  } finally {
    assert.ok(path.resolve(file).startsWith(BASE_DIR + path.sep));
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(file + suffix); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    // Retain the immutable source snapshot for verification; only test DB files are removed.
  }
}

function assertIsolated() {
  assert.equal(process.env.APP_ENV, 'test');
  assert.ok(!process.env.MEDIA_STORAGE_URL && !process.env.MEDIA_STORAGE_SERVICE_KEY && !process.env.MEDIA_STORAGE_BUCKET,
    'no storage configuration may reach the test child');
  if (process.env.DATABASE_URL) {
    const u = new URL(process.env.DATABASE_URL);
    assert.equal(u.hostname, '127.0.0.1');
    assert.equal(u.pathname, '/enclave_media_test');
    assert.equal(process.env.MEDIA_TEST_DEDICATED_PG, '1');
  } else {
    const file = path.resolve(process.env.DB_PATH || '');
    assert.ok(file.startsWith(BASE_DIR + path.sep));
    assert.match(path.basename(path.dirname(file)), /^media-upload-/);
    assert.equal(path.basename(file), 'media.db');
  }
}

// ---- small binary helpers (PNG chunk surgery for pixel-bomb / APNG fixtures) ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

class Skip extends Error {}

async function run() {
  assertIsolated();
  const sourceHashes={};function hashTree(folder){for(const item of fs.readdirSync(folder,{withFileTypes:true})){const full=path.join(folder,item.name);if(item.isDirectory())hashTree(full);else if(/\.(js|sql)$/.test(item.name))sourceHashes[path.relative(ROOT,full).replaceAll('\\','/')]=crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');}}
  hashTree(path.join(ROOT,'src'));sourceHashes['test/media-upload-e2e.js']=crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex');
  console.log('MEDIA_SOURCE_HASHES '+JSON.stringify(sourceHashes));
  const sharp = require('sharp');
  const { db, DIALECT } = require('../src/db');
  await db.ready;
  const storage = require('../src/lib/mediaStorage');
  const media = require('../src/lib/mediaService');
  const { ACTIONS, issueGrant } = require('../src/lib/reauth');
  const txRouter = require('../src/routes/transactions');
  const adminRouter = require('../src/routes/admin');

  assert.ok(process.env.DOTENV_CONFIG_PATH && !fs.existsSync(process.env.DOTENV_CONFIG_PATH), 'dotenv path is deliberately absent');
  // Importing app does not call start(), so no production/background worker is started.
  // This exercises the actual body parsers, security headers and central error handler.
  const { app } = require('../src/server');
  const server = await new Promise((resolve, reject) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); s.once('error', reject); });
  const base = `http://127.0.0.1:${server.address().port}`;

  // ---------------- in-memory PRIVATE storage adapter with fault injection ----------------
  const objects = new Map();
  const putKeys = [];
  const putAttempts = [];
  const removed = [];
  const failRemoveKeys = new Set();
  const faults = { failPut: false, failGet: false, failRemove: false, putBarrier: null, beforePut:null, afterPut: null, beforeRemove: null };
  const adapter = {
    isPrivate: async () => true,
    put: async (key, buffer) => {
      putAttempts.push(key);
      if(faults.beforePut)await faults.beforePut(key);
      if (faults.putBarrier) await faults.putBarrier;
      if (faults.failPut) throw new Error('fixture storage unavailable');
      assert.ok(Buffer.isBuffer(buffer), 'adapter receives a Buffer');
      assert.match(key, /^(listing|evidence)\/[0-9a-f-]{36}\.webp$/, 'server-chosen key only');
      objects.set(key, Buffer.from(buffer));
      putKeys.push(key);
      if (faults.afterPut) await faults.afterPut(key);
    },
    get: async (key) => {
      if (faults.failGet || !objects.has(key)) throw new Error('fixture object missing');
      return Buffer.from(objects.get(key));
    },
    remove: async (key) => {
      if (faults.beforeRemove) await faults.beforeRemove(key);
      if (faults.failRemove || failRemoveKeys.has(key)) throw new Error('fixture remove unavailable');
      objects.delete(key);
      removed.push(key);
    },
  };
  storage.setMediaStorageForTests(adapter);

  // ---------------- assertion + DB helpers ----------------
  let checks = 0;
  const results = [];
  const txIds = [];
  const eq = (a, b, label) => { assert.deepEqual(a, b, label); checks++; };
  const ok = (v, label) => { assert.ok(v, label); checks++; };
  const sql = (q, ...a) => db.prepare(q).get(...a);
  const rows = (q, ...a) => db.prepare(q).all(...a);
  const write = (q, ...a) => db.prepare(q).run(...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function until(predicate,label,milliseconds=6000){const deadline=Date.now()+milliseconds;while(Date.now()<deadline){if(await predicate())return;await sleep(15);}throw new Error('Timed out: '+label);}
  const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
  const num = async (q, ...a) => Number((await sql(q, ...a)).n);
  const past = () => new Date(Date.now() - 60000).toISOString();
  const MARK = 'ENCLAVE-PRIVATE-EXIF-MARKER';
  const FORBIDDEN_META = /storage|sha256|digest|bucket|supabase|\.webp|input_|output_|reserved/i;

  async function request(route, actor, { body, raw, mime, method, headers = {} } = {}) {
    const r = await fetch(base + route, {
      method: method || (body !== undefined || raw !== undefined ? 'POST' : 'GET'),
      headers: {
        Origin: 'http://localhost',
        ...(actor ? { Authorization: 'Bearer ' + actor.token } : {}),
        ...(raw !== undefined ? { 'Content-Type': mime || 'image/png' } : body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
    });
    const buffer = Buffer.from(await r.arrayBuffer());
    let data = {};
    if ((r.headers.get('content-type') || '').includes('json')) { try { data = JSON.parse(buffer.toString()); } catch { data = {}; } }
    return { status: r.status, data, buffer, headers: r.headers };
  }
  const api = (p, a, b, method) => request('/api' + p, a, { body: b, method });
  const must = (r, status = 200) => { eq(r.status, status, JSON.stringify(r.data).slice(0, 400)); return r.data; };
  const imageUrl = (id) => '/api/media/images/' + encodeURIComponent(id);
  const imageGet = (id, actor, query = '') => request(imageUrl(id) + query, actor);

  function upload(a, buffer, { purpose = 'LISTING', transactionId, requestId = crypto.randomUUID(), mime = 'image/png', headers = {}, rawQuery } = {}) {
    const q = rawQuery !== undefined ? rawQuery : new URLSearchParams({ purpose, requestId, ...(transactionId ? { transactionId } : {}) }).toString();
    return request('/api/media/uploads?' + q, a, { raw: buffer, mime, headers });
  }

  // ---------------- Sharp-only fixtures ----------------
  const F = {};
  async function noiseJpeg() {
    const w = 1700, h = 1700;
    const raw = crypto.randomBytes(w * h * 3);
    for (const quality of [60, 40, 25, 10]) {
      const out = await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality }).toBuffer();
      if (out.length < 5 * 1024 * 1024 - 1024) return out;
    }
    throw new Skip('could not synthesize a noise JPEG below 5 MiB');
  }
  async function animatedWebp() {
    const frame = (c) => sharp({ create: { width: 16, height: 16, channels: 3, background: { r: c, g: c, b: 40 } } }).png().toBuffer();
    const out = await sharp([await frame(30), await frame(220)], { join: { animated: true } }).webp({ loop: 0, delay: [100, 100] }).toBuffer();
    const info = await sharp(out, { pages: -1 }).metadata();
    if (!((info.pages || 1) > 1)) throw new Skip('Sharp could not synthesize a multi-page WebP fixture');
    return out;
  }
  async function buildFixtures() {
    const solid = (w, h, c) => ({ create: { width: w, height: h, channels: 3, background: c } });
    F.png = await sharp(solid(40, 20, { r: 40, g: 120, b: 200 })).png().toBuffer();
    F.pngAlpha = await sharp({ create: { width: 64, height: 32, channels: 4, background: { r: 10, g: 200, b: 10, alpha: 0.5 } } }).png().toBuffer();
    F.jpegMeta = await sharp(solid(40, 20, { r: 200, g: 80, b: 20 }))
      .withMetadata({ orientation: 6, icc: 'p3', exif: { IFD0: { Artist: MARK, ImageDescription: 'NO-REAL-PERSON' } } }).jpeg().toBuffer();
    assert.ok(F.jpegMeta.includes(Buffer.from(MARK)), 'fixture must really contain EXIF marker or the strip test is vacuous');
    assert.equal((await sharp(F.jpegMeta).metadata()).orientation, 6, 'fixture orientation');
    F.webpMeta = await sharp(F.png).withMetadata({ exif: { IFD0: { Artist: MARK } } }).webp().toBuffer();
    assert.ok(F.webpMeta.includes(Buffer.from(MARK)), 'webp fixture must contain EXIF marker');
    F.webp = await sharp(F.png).webp().toBuffer();
    F.bigJpeg = await sharp(solid(3200, 2400, { r: 90, g: 90, b: 160 })).jpeg().toBuffer();
    F.bigRotated = await sharp(solid(3200, 2400, { r: 90, g: 160, b: 90 })).withMetadata({ orientation: 6 }).jpeg().toBuffer();
    F.tallPng = await sharp(solid(1200, 3000, { r: 160, g: 90, b: 90 })).png().toBuffer();
    F.widePng = await sharp(solid(2000, 500, { r: 160, g: 160, b: 90 })).png().toBuffer();
    F.gif = await sharp(F.png).gif().toBuffer();
    F.svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    F.html = Buffer.from('<!doctype html><html><script>alert(1)</script></html>');
    F.heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(40)]);
    F.truncated = F.jpegMeta.subarray(0, Math.floor(F.jpegMeta.length / 2));
    // APNG-style acTL chunk injected after IHDR: libvips decodes the first frame only.
    const ihdrEnd = 8 + 4 + 4 + 13 + 4;
    const actl = Buffer.alloc(8); actl.writeUInt32BE(2, 0); actl.writeUInt32BE(0, 4);
    F.apngLike = Buffer.concat([F.png.subarray(0, ihdrEnd), pngChunk('acTL', actl), F.png.subarray(ihdrEnd)]);
    // Declared 100000 x 100000 pixels in a few dozen bytes.
    F.bomb = Buffer.from(F.png); F.bomb.writeUInt32BE(100000, 16); F.bomb.writeUInt32BE(100000, 20);
    F.bomb.writeUInt32BE(crc32(F.bomb.subarray(12, 29)), 29);
    F.multipart = Buffer.concat([
      Buffer.from('--ENCLAVEBOUNDARY\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n'),
      F.png, Buffer.from('\r\n--ENCLAVEBOUNDARY--\r\n')]);
    F.jsonBody = Buffer.from(JSON.stringify({ image: F.png.toString('base64') }));
    F.polyglot = Buffer.concat([F.png, Buffer.from('<script>ENCLAVE-ACTIVE-PAYLOAD</script>')]);
  }
  await buildFixtures();

  // ---------------- actors / flows (same trusted-fixture approach as order-money-spec-e2e) ----------------
  async function actor(role = 'SELLER', balance = 10000000) {
    const { createSession } = require('../src/lib/session');
    const { signAccessToken } = require('../src/lib/auth');
    const id = crypto.randomUUID();
    const username = 'media_' + id.replaceAll('-', '').slice(0, 18);
    const now = new Date().toISOString();
    const admin = role === 'ADMIN';
    await write('INSERT INTO users(id,username,display_name,role,password_hash,account_status,token_version,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,0,1,?,?)',
      id, username, 'Media fixture ' + username, role, 'fixture-only', admin ? 'PENDING_BOOTSTRAP' : 'ACTIVE', now, now);
    if (admin) {
      await require('../src/lib/adminProvenance').recordBootstrapProvenance(db, { userId: id, username, source: 'BOOTSTRAP_CLI', now });
      await write("UPDATE users SET account_status='ACTIVE' WHERE id=?", id);
    } else {
      const wid = crypto.randomUUID();
      await write("INSERT INTO wallets(id,user_id,wallet_type,available_balance,locked_balance,version,created_at,updated_at) VALUES(?,?,'USER',?,0,0,?,?)", wid, id, balance, now, now);
      if (balance) {
        await require('../src/lib/walletOps').insertWalletEntry({
          walletId: wid, requestId: 'seed:' + id, entryType: 'DEMO_TOPUP', availableDelta: balance, lockedDelta: 0,
          walletAfter: { available_balance: balance, locked_balance: 0 }, idempotencyKey: 'seed:' + id });
      }
    }
    const credentialId = crypto.randomUUID();
    await write("INSERT INTO passkey_credentials(id,user_id,credential_id,public_key,counter,transports,device_name,created_at) VALUES(?,?,?,?,0,'[]','media-fixture',?)",
      credentialId, id, 'fixture-' + id, Buffer.from('fixture-only'), now);
    const { sessionId } = await createSession(id, { authMethod: 'passkey' });
    return { id, credentialId, sessionId, role, token: signAccessToken({ id, username, role, account_status: 'ACTIVE', token_version: 0 }, 'full', sessionId) };
  }
  const shipping = { recipientName: 'Người nhận kiểm thử', phone: '0912345678', address: 'Số 88 đường thử nghiệm riêng', ward: 'Phường Thử', district: 'Quận Thử', province: 'Hà Nội' };
  const listingBody = (extra = {}) => ({ title: 'Ảnh hàng C2C ' + crypto.randomUUID(), price: 60000, category: 'SACH', condition: 'GOOD', location: 'Hà Nội', ...extra });
  const meta = (r) => r.data;
  async function up(a, buffer = F.png, options = {}) {
    const r = await upload(a, buffer, { mime: 'image/png', ...options });
    ok([200, 201].includes(r.status), 'upload accepted: ' + r.status + ' ' + JSON.stringify(r.data).slice(0, 200));
    const m = meta(r);
    ok(m.id && m.url === '/api/media/images/' + m.id, 'metadata id/url');
    return m;
  }
  const upEvidence = (a, transactionId, buffer = F.png) => up(a, buffer, { purpose: 'EVIDENCE', transactionId });
  const rowOf = (id) => sql('SELECT * FROM media_assets WHERE id=?', id);
  const assetCount = (a, where = '1=1') => num(`SELECT COUNT(*) n FROM media_assets WHERE owner_id=? AND ${where}`, a.id);
  const liveCount = (a) => assetCount(a, "status IN ('STAGED','ATTACHED','UPLOADING')");

  async function newListing(s, ids, extra = {}) {
    return must(await api('/listings', s, listingBody({ ...(ids ? { imageIds: ids } : {}), ...extra })), 201);
  }
  async function grant(a, id, action = ACTIONS.LOCK, decision) {
    let t = await sql('SELECT * FROM transactions WHERE id=?', id);
    let d = action === ACTIONS.ADJUDICATE ? await sql('SELECT * FROM disputes WHERE transaction_id=?', id) : null,review;
    if(d){
      if(!d.admin_id)must(await api('/admin/disputes/'+d.id+'/claim',a,{}));
      d=await sql('SELECT * FROM disputes WHERE id=?',d.id);t=await sql('SELECT * FROM transactions WHERE id=?',id);
      must(await api('/admin/disputes/'+d.id+'/review',a,{decision,basis:'Đã xem ảnh và nội dung bổ sung của hai bên trong tình huống kiểm thử; ghi căn cứ mô phỏng trước khi ký quyết định.',reviewed:true,receiptAcknowledged:true,expectedDisputeRevision:d.revision,expectedOrderVersion:t.version}),201);
      review=await require('../src/lib/disputeReview').latestReview(db,d.id);d=await sql('SELECT * FROM disputes WHERE id=?',d.id);t=await sql('SELECT * FROM transactions WHERE id=?',id);
    }
    const context = d ? adminRouter.buildAdjudicationContext(d, t, decision, a.id, a.sessionId,review) : await txRouter.buildAuthorizationContext(t, action, a.sessionId);
    return issueGrant({ userId: a.id, sessionId: a.sessionId, transactionId: id, disputeId: d?.id, action, decision, credentialId: a.credentialId,
      contextHash: crypto.createHash('sha256').update(JSON.stringify(context)).digest('hex') });
  }
  async function order(b, s, item) {
    const l = item || await newListing(s);
    const t = must(await api('/transactions/orders', b, { listingId: l.id, shipping, requestId: crypto.randomUUID() }), 201);
    txIds.push(t.id);
    return t.id;
  }
  async function secure(b, id) {
    const g = await grant(b, id);
    return api('/transactions/' + id + '/secure', b, { requestId: crypto.randomUUID(), reauthGrant: g.rawToken });
  }
  async function held(ids) {
    const b = await actor('BUYER'), s = await actor();
    const listing = await newListing(s, ids);
    const id = await order(b, s, listing);
    must(await secure(b, id));
    return { b, s, id, listing };
  }
  async function disputed() {
    const p = await held();
    must(await api('/transactions/' + p.id + '/dispute', p.b, { type: 'DEFECT', reason: 'Mô tả có ảnh cần xem xét' }), 201);
    return { ...p, d: await sql('SELECT * FROM disputes WHERE transaction_id=?', p.id) };
  }
  const money = async () => ({
    wallets: await rows('SELECT id,available_balance,locked_balance,version FROM wallets ORDER BY id'),
    entries: await rows('SELECT * FROM wallet_entries ORDER BY id'),
  });
  const caseState = async (txnId) => ({
    txn: await sql('SELECT status,escrow_status,amount,buyer_id,seller_id,listing_id,version FROM transactions WHERE id=?', txnId),
    dispute: await sql('SELECT id,type,status,opened_by,reason,admin_id,admin_decision,resolved_at,revision FROM disputes WHERE transaction_id=?', txnId),
    messages: await num('SELECT COUNT(*) n FROM dispute_messages WHERE dispute_id=(SELECT id FROM disputes WHERE transaction_id=?)', txnId),
    media: await num('SELECT COUNT(*) n FROM dispute_media WHERE dispute_id=(SELECT id FROM disputes WHERE transaction_id=?)', txnId),
  });
  const evidenceOf = (d) => d.imageEvidence || d.dispute?.imageEvidence || d.transaction?.imageEvidence || [];
  const idsOf = (list) => (list || []).map((x) => x.id);

  async function seedAsset(ownerId, { status = 'ATTACHED', bytes = 524288, reserved = 524288, expires, storageDeleted = null, withObject = false, purpose = 'LISTING' } = {}) {
    const id = crypto.randomUUID(), at = new Date().toISOString();
    const key = `${purpose.toLowerCase()}/${id}.webp`;
    await write("INSERT INTO media_assets(id,owner_id,purpose,request_id,input_sha256,output_sha256,width,height,bytes,reserved_bytes,status,storage_key,created_at,expires_at,updated_at,storage_deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      id, ownerId, purpose, crypto.randomUUID(), sha(id), sha(id + 'out'), 10, 10, bytes, reserved, status, key, at,
      expires || new Date(Date.now() + 86400000).toISOString(), at, storageDeleted);
    if (withObject) objects.set(key, Buffer.from('fixture-object-' + id));
    return { id, key };
  }
  async function untilMinuteStart() { const s = new Date().getSeconds(); if (s >= 35) await sleep((61 - s) * 1000); }

  async function test(id, label, fn) {
    const start = checks;
    try {
      await fn();
      results.push({ id, label, result: 'PASS', checks: checks - start });
      console.log('PASS ' + id + ' ' + label + ' (' + (checks - start) + ' assertions)');
    } catch (e) {
      if (e instanceof Skip) {
        results.push({ id, label, result: 'SKIP', checks: checks - start, message: e.message });
        console.log('SKIP ' + id + ' ' + label + ': ' + e.message);
      } else {
        results.push({ id, label, result: 'FAIL', checks: checks - start, message: e.message });
        console.error('FAIL ' + id + ' ' + label + ': ' + e.stack);
      }
    } finally {
      Object.assign(faults, { failPut: false, failGet: false, failRemove: false, putBarrier: null, beforePut:null, afterPut: null, beforeRemove: null });
      failRemoveKeys.clear();
      storage.setMediaStorageForTests(adapter);
      for (const k of ['MEDIA_STORAGE_URL', 'MEDIA_STORAGE_SERVICE_KEY', 'MEDIA_STORAGE_BUCKET']) delete process.env[k];
      process.env.APP_ENV = 'test';
    }
  }
  async function assertCleanWebp(buf, label) {
    const info = await sharp(buf).metadata();
    eq(info.format, 'webp', label + ' format');
    ok(!info.exif && !info.icc && !info.xmp && !info.iptc, label + ' no metadata blocks');
    ok(info.width <= 1600 && info.height <= 1600, label + ' edge <= 1600');
    ok(buf.length <= 512 * 1024, label + ' <= 512 KiB');
    ok(!buf.includes(Buffer.from(MARK)) && !buf.includes(Buffer.from('NO-REAL-PERSON')), label + ' marker absent');
    ok(!buf.includes(Buffer.from('EXIF')) && !buf.includes(Buffer.from('XMP ')) && !buf.includes(Buffer.from('ICCP')), label + ' no EXIF/XMP/ICCP chunk');
    eq((info.pages || 1), 1, label + ' single frame');
    return info;
  }
  async function rejected(buffer, mime, label, opts = {}) {
    const s = await actor(); // fresh actor: rejected decodes still consume the per-minute upload budget
    const objectsBefore = objects.size, putsBefore = putKeys.length;
    const r = await upload(s, buffer, { mime, ...opts });
    ok(r.status >= 400 && r.status < 500, label + ' -> controlled 4xx, got ' + r.status);
    ok(/^MEDIA_|^UNAUTH|^FORBIDDEN/.test(r.data.error || ''), label + ' -> safe error code, got ' + r.data.error);
    eq(objects.size, objectsBefore, label + ' wrote no object');
    eq(putKeys.length, putsBefore, label + ' no put');
    eq(await assetCount(s, "status IN ('STAGED','ATTACHED')"), 0, label + ' left no live asset');
    return r;
  }

  try {
    console.log('MEDIA_SUITE ' + JSON.stringify({ dialect: DIALECT, layer: 'actual src/server.js app over HTTP + Sharp + isolated DB + injected private adapter', node: process.version, sharp: sharp.versions.sharp }));

    // ======================================================================
    await test('M01', 'storage fails closed (missing/public/broken/production/invalid config); no filesystem fallback; test adapter forbidden outside APP_ENV=test', async () => {
      const s = await actor();
      storage.setMediaStorageForTests(null);
      let r = await upload(s, F.png);
      eq(r.status, 503); eq(r.data.error, 'MEDIA_STORAGE_UNAVAILABLE'); eq(await assetCount(s), 0);
      storage.setMediaStorageForTests({ ...adapter, isPrivate: async () => false });
      eq((await upload(s, F.png)).status, 503);
      storage.setMediaStorageForTests({ ...adapter, isPrivate: async () => { throw new Error('boom'); } });
      eq((await upload(s, F.png)).status, 503);
      eq(await assetCount(s), 0);
      eq(putKeys.length, 0, 'no put reached any adapter while storage was unavailable');
      // Invalid / unsafe storage configuration is rejected before any request could be made.
      storage.setMediaStorageForTests(null);
      const bad = ['http://abc.supabase.co', 'https://evil.example', 'https://abc.supabase.co.evil.example', 'https://evilsupabase.co',
        'https://user:pw@abc.supabase.co', 'https://abc.supabase.co/path', 'https://abc.supabase.co/?a=1'];
      for (const url of bad) {
        process.env.MEDIA_STORAGE_URL = url; process.env.MEDIA_STORAGE_SERVICE_KEY = 'fixture-not-a-secret';
        await assert.rejects(storage.getMediaStorage(), (e) => e.code === 'MEDIA_STORAGE_UNAVAILABLE' && e.status === 503, url); checks++;
      }
      process.env.MEDIA_STORAGE_URL = 'https://abc.supabase.co'; process.env.MEDIA_STORAGE_SERVICE_KEY = 'fixture-not-a-secret'; process.env.MEDIA_STORAGE_BUCKET = 'Bad_Bucket';
      await assert.rejects(storage.getMediaStorage(), (e) => e.code === 'MEDIA_STORAGE_UNAVAILABLE'); checks++;
      for (const k of ['MEDIA_STORAGE_URL', 'MEDIA_STORAGE_SERVICE_KEY', 'MEDIA_STORAGE_BUCKET']) delete process.env[k];
      // Adapter cannot be installed or honoured outside APP_ENV=test (no production fallback to memory).
      storage.setMediaStorageForTests(adapter);
      process.env.APP_ENV = 'production';
      try {
        assert.throws(() => storage.setMediaStorageForTests(adapter), /MEDIA_TEST_ADAPTER_FORBIDDEN/); checks++;
        await assert.rejects(storage.getMediaStorage(), (e) => e.code === 'MEDIA_STORAGE_UNAVAILABLE' && e.status === 503); checks++;
      } finally { process.env.APP_ENV = 'test'; }
      assert.throws(() => storage.setMediaStorageForTests({ put() {} }), /Invalid media test adapter/); checks++;
      storage.setMediaStorageForTests(adapter);
      eq((await upload(null, F.png)).status, 401);
    });

    await test('M02', 'upload auth/role/purpose matrix', async () => {
      const seller = await actor(), buyer = await actor('BUYER'), admin = await actor('ADMIN');
      eq((await upload(null, F.png)).status, 401);
      eq((await upload({ token: 'not.a.jwt' }, F.png)).status, 401);
      eq((await upload(buyer, F.png)).status, 403);
      eq((await upload(admin, F.png)).status, 403);
      const p = await held();
      const stranger = await actor('BUYER');
      const nonParty = await upload(stranger, F.png, { purpose: 'EVIDENCE', transactionId: p.id });
      ok([403, 404].includes(nonParty.status), 'non-party cannot stage evidence for another order: ' + nonParty.status);
      const unknown = await upload(stranger, F.png, { purpose: 'EVIDENCE', transactionId: crypto.randomUUID() });
      eq(unknown.status, 404);
      if (nonParty.status !== unknown.status) console.log('NOTE M02: non-party evidence upload returns ' + nonParty.status + ' while unknown order returns 404 (order-id existence oracle)');
      const adminEvidence = await upload(admin, F.png, { purpose: 'EVIDENCE', transactionId: p.id });
      ok([403, 404].includes(adminEvidence.status));
      eq(await liveCount(stranger), 0);
      const m = await up(seller);
      for (const k of ['id', 'url', 'width', 'height', 'bytes', 'purpose', 'createdAt', 'uploadedBy']) ok(m[k] !== undefined && m[k] !== null, 'metadata key ' + k);
      eq(m.url, '/api/media/images/' + m.id); eq(m.purpose, 'LISTING'); eq(m.uploadedBy, seller.id);
      ok(!FORBIDDEN_META.test(JSON.stringify(m)), 'no storage key/hash/provider detail leaks in metadata');
      ok(Math.abs(Date.parse(m.createdAt) - Date.now()) < 120000, 'createdAt is upload time (attribution only, not capture time)');
    });

    await test('M03', 'query validation: requestId UUID, purpose, target binding', async () => {
      const s = await actor();
      const rid = crypto.randomUUID();
      for (const [q, code] of [
        ['purpose=LISTING&requestId=../../bad', 'MEDIA_REQUEST_INVALID'],
        ['purpose=LISTING', 'MEDIA_REQUEST_INVALID'],
        ['purpose=LISTING&requestId=' + rid + '&requestId=' + crypto.randomUUID(), null],
        ['purpose=OTHER&requestId=' + rid, 'MEDIA_PURPOSE_INVALID'],
        ['requestId=' + rid, 'MEDIA_PURPOSE_INVALID'],
        ['purpose=EVIDENCE&requestId=' + rid, 'MEDIA_TARGET_INVALID'],
        ['purpose=EVIDENCE&requestId=' + rid + '&transactionId=not-a-uuid', 'MEDIA_TARGET_INVALID'],
        ['purpose=LISTING&requestId=' + rid + '&transactionId=' + crypto.randomUUID(), 'MEDIA_TARGET_INVALID'],
      ]) {
        const r = await upload(s, F.png, { rawQuery: q });
        ok(r.status >= 400 && r.status < 500, q + ' -> ' + r.status);
        if (code) eq(r.data.error, code, q);
      }
      eq(await assetCount(s), 0);
      eq((await request('/api/media/uploads/not-a-uuid', s)).status, 404);
      eq((await request('/api/media/uploads/' + crypto.randomUUID(), s)).status, 404);
    });

    await test('M04', 'JPEG/PNG/WebP re-encoded to clean WebP; EXIF/ICC/XMP/orientation; stored bytes + DB digests', async () => {
      const s = await actor();
      for (const [buffer, mime, label] of [[F.jpegMeta, 'image/jpeg', 'jpeg+exif'], [F.png, 'image/png', 'png'], [F.pngAlpha, 'image/png', 'png+alpha'], [F.webpMeta, 'image/webp', 'webp+exif'], [F.webp, 'image/webp', 'webp']]) {
        const m = await up(s, buffer, { mime });
        const row = await rowOf(m.id);
        const stored = objects.get(row.storage_key);
        ok(stored, label + ' stored in adapter');
        eq(row.input_sha256, sha(buffer), label + ' input digest bound'); eq(row.output_sha256, sha(stored), label + ' output digest'); eq(row.bytes, stored.length);
        ok(/^listing\/[0-9a-f-]{36}\.webp$/.test(row.storage_key) && !row.storage_key.includes('..'));
        const info = await assertCleanWebp(stored, label);
        eq([m.width, m.height], [info.width, info.height], label + ' metadata matches decoded image'); eq(m.bytes, stored.length);
        const served = await imageGet(m.id, s);
        eq(served.status, 200); ok(served.buffer.equals(stored), label + ' served bytes are the stored clean bytes');
        ok((served.headers.get('content-type') || '').startsWith('image/webp'));
        eq(served.headers.get('x-content-type-options'), 'nosniff');
        ok(/no-store/.test(served.headers.get('cache-control') || ''));
        ok(/sandbox/.test(served.headers.get('content-security-policy') || ''), 'sandboxed CSP on image response');
        ok(!/attachment|\.svg|\.html/i.test(served.headers.get('content-disposition') || ''));
        if (label === 'jpeg+exif') { eq([m.width, m.height], [20, 40], 'EXIF orientation 6 applied to pixels'); }
      }
      const noisyAttempt = await upload(s, await noiseJpeg(), { mime: 'image/jpeg' });
      if (noisyAttempt.status === 201 || noisyAttempt.status === 200) {
        const row = await rowOf(noisyAttempt.data.id); ok(row.bytes <= 512 * 1024, 'noisy photo shrunk to <= 512 KiB'); await assertCleanWebp(objects.get(row.storage_key), 'noise');
      } else {
        eq(noisyAttempt.status, 413); eq(noisyAttempt.data.error, 'MEDIA_OUTPUT_TOO_LARGE');
        eq(await assetCount(s, "status IN ('STAGED','ATTACHED')"), 5);
      }
    });

    await test('M05', 'resize to 1600 edge, never enlarge, orientation applied before resize', async () => {
      const s = await actor();
      const cases = [[F.bigJpeg, 'image/jpeg', 1600, 1200], [F.bigRotated, 'image/jpeg', 1200, 1600], [F.tallPng, 'image/png', 640, 1600], [F.widePng, 'image/png', 1600, 400], [F.png, 'image/png', 40, 20]];
      for (const [buffer, mime, w, h] of cases) {
        const m = await up(s, buffer, { mime });
        eq([m.width, m.height], [w, h]);
        await assertCleanWebp(objects.get((await rowOf(m.id)).storage_key), `${w}x${h}`);
      }
    });

    await test('M06', 'rejects SVG/HTML/GIF/HEIC/corrupt/animated/multipart/JSON/wrong MIME/encoding/empty', async () => {
      await rejected(F.svg, 'image/svg+xml', 'svg as svg');
      await rejected(F.svg, 'image/png', 'svg as png');
      await rejected(F.svg, 'image/jpeg', 'svg as jpeg');
      await rejected(F.html, 'image/jpeg', 'html as jpeg');
      await rejected(F.html, 'text/html', 'html as html');
      await rejected(F.gif, 'image/gif', 'gif as gif');
      await rejected(F.gif, 'image/png', 'gif as png');
      await rejected(F.heic, 'image/heic', 'heic as heic');
      await rejected(F.heic, 'image/jpeg', 'heic as jpeg');
      await rejected(F.truncated, 'image/jpeg', 'truncated jpeg');
      await rejected(Buffer.from([255, 216, 255, 0, 1, 2]), 'image/jpeg', 'garbage jpeg');
      await rejected(F.png, 'image/jpeg', 'png bytes declared jpeg');
      await rejected(F.jpegMeta, 'image/png', 'jpeg bytes declared png');
      await rejected(F.webp, 'image/png', 'webp bytes declared png');
      await rejected(F.multipart, 'multipart/form-data; boundary=ENCLAVEBOUNDARY', 'multipart');
      await rejected(F.jsonBody, 'application/json', 'json base64');
      await rejected(F.png, 'text/plain', 'text/plain');
      await rejected(F.png, 'application/octet-stream', 'octet-stream');
      await rejected(Buffer.alloc(0), 'image/png', 'empty body');
      const gz = await rejected(F.png, 'image/png', 'content-encoding', { headers: { 'Content-Encoding': 'gzip' } });
      ok([400, 415].includes(gz.status));
    });

    await test('M06b', 'rejects animated WebP', async () => {
      await rejected(await animatedWebp(), 'image/webp', 'animated webp');
    });

    await test('M07', 'size and pixel limits: >5MiB, chunked overflow, IHDR bomb, 20MP boundary, APNG-style input', async () => {
      const s = await actor();
      const tolerant = async (fn) => { try { return await fn(); } catch { return { status: 0, data: {}, networkReset: true }; } };
      const big = await tolerant(() => upload(s, Buffer.alloc(5 * 1024 * 1024 + 1, 1), { mime: 'image/jpeg' }));
      ok(big.status === 413 || big.networkReset, 'content-length over 5 MiB rejected (413 or early close), got ' + big.status);
      if (big.status === 413) eq(big.data.error, 'MEDIA_FILE_TOO_LARGE');
      // Chunked body without Content-Length cannot bypass the byte cap.
      const stream = new ReadableStream({ start(c) { for (let i = 0; i < 6; i++) c.enqueue(new Uint8Array(1024 * 1024).fill(7)); c.close(); } });
      const chunked = await tolerant(() => fetch(base + '/api/media/uploads?' + new URLSearchParams({ purpose: 'LISTING', requestId: crypto.randomUUID() }),
        { method: 'POST', headers: { Authorization: 'Bearer ' + s.token, 'Content-Type': 'image/jpeg', Origin: 'http://localhost' }, body: stream, duplex: 'half' })
        .then(async (r) => ({ status: r.status, data: await r.json().catch(() => ({})) })));
      ok(chunked.status === 413 || chunked.networkReset, 'chunked overflow rejected, got ' + chunked.status);
      const started = Date.now();
      const bomb = await upload(s, F.bomb);
      ok([400, 413, 415].includes(bomb.status), 'IHDR 100000x100000 rejected: ' + bomb.status);
      ok(Date.now() - started < 5000, 'pixel bomb rejected promptly');
      // 20,000,000 pixels is the inclusive limit; one extra row/column is over.
      const exact = await sharp({ create: { width: 4000, height: 5000, channels: 3, background: { r: 20, g: 30, b: 40 } } }).png({ compressionLevel: 9 }).toBuffer();
      const over = await sharp({ create: { width: 4001, height: 5000, channels: 3, background: { r: 20, g: 30, b: 40 } } }).png({ compressionLevel: 9 }).toBuffer();
      ok(exact.length < 5 * 1024 * 1024 && over.length < 5 * 1024 * 1024, 'fixture under byte cap so only pixel rule is exercised');
      const okExact = await upload(s, exact);
      eq(okExact.status, 201); eq([okExact.data.width, okExact.data.height], [1280, 1600]);
      const overRes = await upload(s, over);
      ok([400, 413, 415].includes(overRes.status), 'over 20MP rejected: ' + overRes.status);
      eq(await assetCount(s, "status IN ('STAGED','ATTACHED')"), 1, 'only the 20.000MP image was staged');
      // APNG-like input is either rejected or flattened to one still frame; never stored animated.
      const apng = await upload(s, F.apngLike);
      if (apng.status === 201) { eq((await sharp(objects.get((await rowOf(apng.data.id)).storage_key), { pages: -1 }).metadata()).pages || 1, 1); }
      else ok([400, 415].includes(apng.status));
      // Trailing active payload is never served back verbatim.
      const poly = await upload(s, F.polyglot);
      if (poly.status === 201) {
        const served = await imageGet(poly.data.id, s);
        ok(!served.buffer.includes(Buffer.from('ENCLAVE-ACTIVE-PAYLOAD')) && !served.buffer.equals(F.polyglot));
        eq((await sharp(served.buffer).metadata()).format, 'webp');
      } else ok([400, 415].includes(poly.status));
    });

    await test('M08', 'requestId replay is stable; payload/purpose/target mismatch is 409; owner namespace; no extra put', async () => {
      const s = await actor(), other = await actor();
      const requestId = crypto.randomUUID();
      const first = await upload(s, F.png, { requestId });
      eq(first.status, 201);
      const puts = putKeys.length;
      const replay = await upload(s, F.png, { requestId });
      eq(replay.status, 200); eq(replay.data.id, first.data.id); eq(putKeys.length, puts, 'replay performs no second storage write');
      eq(replay.data.createdAt, first.data.createdAt);
      for (const [buffer, mime] of [[F.jpegMeta, 'image/jpeg'], [F.webp, 'image/webp']]) {
        const mismatch = await upload(s, buffer, { requestId, mime });
        eq(mismatch.status, 409); eq(mismatch.data.error, 'MEDIA_REQUEST_REUSED');
      }
      eq(await assetCount(s), 1);
      // Same UUID used by another owner is a different namespace and never exposes the first asset.
      const theirs = await upload(other, F.png, { requestId });
      eq(theirs.status, 201); ok(theirs.data.id !== first.data.id);
      eq((await api('/media/uploads/' + requestId, s)).data.id, first.data.id);
      eq((await api('/media/uploads/' + requestId, other)).data.id, theirs.data.id);
      // Reusing the id for a different order target (same buyer, both orders legitimate) is a binding mismatch.
      const b = await actor('BUYER'), seller = await actor();
      const id1 = await order(b, seller), id2 = await order(b, seller);
      must(await secure(b, id1)); must(await secure(b, id2));
      const rid = crypto.randomUUID();
      eq((await upload(b, F.png, { requestId: rid, purpose: 'EVIDENCE', transactionId: id1 })).status, 201);
      const swapped = await upload(b, F.png, { requestId: rid, purpose: 'EVIDENCE', transactionId: id2 });
      eq(swapped.status, 409); eq(swapped.data.error, 'MEDIA_REQUEST_REUSED');
      eq(await assetCount(b), 1);
    });

    await test('M09', 'concurrent same requestId: one write; in-progress 409; GET uploads/:requestId pending 202 then 200; owner only', async () => {
      const s = await actor(), other = await actor();
      const requestId = crypto.randomUUID();
      let release; faults.putBarrier = new Promise((r) => { release = r; });
      const firstP = upload(s, F.png, { requestId });
      for (let i = 0; i < 60 && !(await sql("SELECT 1 AS x FROM media_assets WHERE owner_id=? AND request_id=? AND status='UPLOADING'", s.id, requestId)); i++) await sleep(50);
      ok(await sql("SELECT 1 AS x FROM media_assets WHERE owner_id=? AND request_id=? AND status='UPLOADING'", s.id, requestId), 'reservation row visible before storage completes');
      const dup = await upload(s, F.png, { requestId });
      eq(dup.status, 409); eq(dup.data.error, 'MEDIA_UPLOAD_IN_PROGRESS');
      const pending = await api('/media/uploads/' + requestId, s);
      eq(pending.status, 202); eq(pending.data.status, 'UPLOADING');
      eq((await api('/media/uploads/' + requestId, other)).status, 404);
      eq((await api('/media/uploads/' + requestId, null)).status, 401);
      eq((await imageGet(pending.data.id, s)).status, 404, 'unfinished upload has no readable bytes');
      release(); faults.putBarrier = null;
      const first = await firstP;
      eq(first.status, 201);
      const done = await api('/media/uploads/' + requestId, s);
      eq(done.status, 200); eq(done.data.id, first.data.id);
      eq(putKeys.filter((k) => k.endsWith(first.data.id + '.webp')).length, 1);
      eq(await assetCount(s), 1);
      // Fully parallel burst on a fresh id: exactly one creation.
      const burstId = crypto.randomUUID(), burst = await Promise.all(Array.from({ length: 5 }, () => upload(s, F.png, { requestId: burstId })));
      eq(burst.filter((r) => r.status === 201).length, 1);
      ok(burst.every((r) => [200, 201, 409].includes(r.status)), 'statuses: ' + burst.map((r) => r.status));
      const created = burst.find((r) => r.status === 201).data.id;
      ok(burst.filter((r) => r.status !== 409).every((r) => r.data.id === created));
      eq(await num('SELECT COUNT(*) n FROM media_assets WHERE owner_id=? AND request_id=?', s.id, burstId), 1);
      eq(putKeys.filter((k) => k.endsWith(created + '.webp')).length, 1);
    });

    await test('M10', 'staging cap of 12 holds under concurrent reservations', async () => {
      const s = await actor();
      for (let i = 0; i < 10; i++) await up(s);
      const burst = await Promise.all(Array.from({ length: 5 }, () => upload(s, F.png)));
      eq(burst.filter((r) => r.status === 201).length, 2, 'statuses ' + burst.map((r) => r.status));
      ok(burst.filter((r) => r.status !== 201).every((r) => r.status === 409 && r.data.error === 'MEDIA_STAGING_LIMIT'));
      eq(await num("SELECT COUNT(*) n FROM media_assets WHERE owner_id=? AND status IN ('UPLOADING','STAGED')", s.id), 12);
      const over = await upload(s, F.png);
      eq(over.status, 409); eq(over.data.error, 'MEDIA_STAGING_LIMIT');
    });

    await test('M11', 'per-user upload rate limit (18/min) is enforced before decoding and is per user', async () => {
      await untilMinuteStart();
      const s = await actor(), other = await actor();
      const requestId = crypto.randomUUID();
      eq((await upload(s, F.png, { requestId })).status, 201);
      for (let i = 1; i < 18; i++) eq((await upload(s, F.png, { requestId })).status, 200, 'attempt ' + (i + 1));
      const objectsBefore = objects.size;
      const limited = await upload(s, F.png, { requestId: crypto.randomUUID() });
      eq(limited.status, 429); eq(limited.data.error, 'MEDIA_UPLOAD_RATE_LIMIT');
      eq(objects.size, objectsBefore); eq(await assetCount(s), 1);
      eq((await upload(other, F.png)).status, 201);
    });

    await test('M12', 'owner 32MiB and global 128MiB quotas count reservations and undeleted failed objects, and recover after cleanup', async () => {
      const mk = async (owner, n, extra) => { const ids = []; for (let i = 0; i < n; i++) ids.push((await seedAsset(owner.id, extra)).id); return ids; };
      const wipe = async (owner) => {
        for (const row of await rows('SELECT storage_key FROM media_assets WHERE owner_id=?', owner.id)) objects.delete(row.storage_key);
        await write('DELETE FROM media_assets WHERE owner_id=?', owner.id);
      };
      // Owner: 64 x 512KiB attached leaves no room for another 512KiB reservation.
      const a = await actor();
      await mk(a, 64);
      let before = objects.size;
      let r = await upload(a, F.png);
      eq(r.status, 413); eq(r.data.error, 'MEDIA_OWNER_QUOTA'); eq(objects.size, before);
      await wipe(a);
      // 63 attached + one in-flight reservation also fills the quota.
      const b = await actor();
      await mk(b, 63);
      await seedAsset(b.id, { status: 'UPLOADING', bytes: 0 });
      r = await upload(b, F.png);
      eq(r.status, 413); eq(r.data.error, 'MEDIA_OWNER_QUOTA');
      await wipe(b);
      // 63 attached + one FAILED row whose object was not yet deleted still counts; cleanup releases it.
      const c = await actor();
      await mk(c, 63);
      const failed = await seedAsset(c.id, { status: 'FAILED', bytes: 0, withObject: true });
      r = await upload(c, F.png);
      eq(r.status, 413, 'failed upload with undeleted object keeps its reservation');
      const cleaned = await media.cleanupMediaAssets();
      ok(cleaned.removed >= 1); ok(!objects.has(failed.key)); ok((await rowOf(failed.id)).storage_deleted_at);
      r = await upload(c, F.png);
      eq(r.status, 201, 'quota released once failed object is gone: ' + JSON.stringify(r.data));
      await wipe(c);
      // Global quota.
      const holder = await actor(), fresh = await actor();
      await mk(holder, 256);
      before = objects.size;
      r = await upload(fresh, F.png);
      eq(r.status, 503); eq(r.data.error, 'MEDIA_GLOBAL_QUOTA'); eq(objects.size, before); eq(await assetCount(fresh), 0);
      await wipe(holder);
      eq((await upload(fresh, F.png)).status, 201);
    });

    await test('M13', 'storage failure rolls back: no live asset/metadata/money change; retry semantics; cleanup retried safely', async () => {
      const s = await actor();
      const before = await money();
      // (a) put fails
      const requestId = crypto.randomUUID();
      faults.failPut = true;
      const objectsBefore = objects.size;
      const r = await upload(s, F.png, { requestId });
      eq(r.status, 503); eq(r.data.error, 'MEDIA_STORAGE_UNAVAILABLE'); ok(!FORBIDDEN_META.test(JSON.stringify(r.data).replace(/MEDIA_STORAGE_UNAVAILABLE/, '')), 'error body is generic');
      faults.failPut = false;
      eq(objects.size, objectsBefore); eq(await money(), before);
      const failedRow = await sql('SELECT * FROM media_assets WHERE owner_id=? AND request_id=?', s.id, requestId);
      eq(failedRow.status, 'FAILED'); ok(failedRow.storage_deleted_at, 'nothing stored so nothing left to delete');
      eq((await api('/media/uploads/' + requestId, s)).status, 410);
      eq((await imageGet(failedRow.id, s)).status, 404);
      const retrySame = await upload(s, F.png, { requestId });
      eq(retrySame.status, 201, 'same requestId retries after confirmed cleanup');
      eq(retrySame.data.id,failedRow.id,'retry reuses logical asset id');
      ok((await rowOf(failedRow.id)).storage_key!==failedRow.storage_key,'retry gets a new attempt object key');
      const fresh = await upload(s, F.png);
      eq(fresh.status, 201);
      // (b) put succeeds, finalization fails (reservation expired concurrently): stored object is removed.
      faults.afterPut = async (key) => { await write('UPDATE media_assets SET expires_at=? WHERE storage_key=?', past(), key); };
      const rid2 = crypto.randomUUID(), p2 = await upload(s, F.png, { requestId: rid2 });
      faults.afterPut = null;
      eq(p2.status, 409); eq(p2.data.error, 'MEDIA_UPLOAD_EXPIRED');
      const r2 = await sql('SELECT * FROM media_assets WHERE owner_id=? AND request_id=?', s.id, rid2);
      eq(r2.status, 'FAILED'); ok(r2.storage_deleted_at); ok(!objects.has(r2.storage_key)); ok(removed.includes(r2.storage_key));
      // (c) finalization fails AND remove fails: object lingers but is marked for cleanup, quota still counted, cleanup removes it.
      faults.afterPut = async (key) => { await write('UPDATE media_assets SET expires_at=? WHERE storage_key=?', past(), key); };
      faults.failRemove = true;
      const rid3 = crypto.randomUUID(), p3 = await upload(s, F.png, { requestId: rid3 });
      faults.afterPut = null;
      ok(p3.status >= 400 && p3.status < 500 || p3.status === 503);
      const r3 = await sql('SELECT * FROM media_assets WHERE owner_id=? AND request_id=?', s.id, rid3);
      eq(r3.status, 'FAILED'); eq(r3.storage_deleted_at, null); ok(objects.has(r3.storage_key), 'object still present while remove is failing');
      eq((await imageGet(r3.id, s)).status, 404, 'failed asset never readable');
      const failing = await media.cleanupMediaAssets();
      ok(failing.failed >= 1); ok(objects.has(r3.storage_key));
      faults.failRemove = false;
      const okClean = await media.cleanupMediaAssets();
      ok(okClean.removed >= 1); ok(!objects.has(r3.storage_key)); ok((await rowOf(r3.id)).storage_deleted_at);
      const again = removed.length;
      await media.cleanupMediaAssets();
      eq(removed.filter((k) => k === r3.storage_key).length, 1, 'cleanup removes each object once'); ok(removed.length >= again);
      eq(await money(), before, 'no money movement from any image failure');
    });

    await test('M14', 'cleanup removes only expired/failed: attached, snapshot and evidence bytes survive; racing in-flight upload leaves no orphan', async () => {
      const s = await actor();
      const attached = await up(s), expiring = await up(s), live = await up(s);
      const l = await newListing(s, [attached.id]);
      const stuck = await seedAsset(s.id, { status: 'UPLOADING', withObject: true, expires: past(), bytes: 0 });
      const p = await disputed();
      const ev = await upEvidence(p.b, p.id);
      must(await api('/transactions/' + p.id + '/dispute/messages', p.b, { message: 'Ảnh bằng chứng cần giữ lại', imageIds: [ev.id] }), 201);
      const snap = await held();
      const withImage = await up(snap.s);
      const l2 = await newListing(snap.s, [withImage.id]);
      const b2 = await actor('BUYER');
      const oid = await order(b2, snap.s, l2); must(await secure(b2, oid));
      await write("UPDATE media_assets SET expires_at=? WHERE id IN (?,?,?)", past(), expiring.id, attached.id, withImage.id);
      await write("UPDATE media_assets SET expires_at=? WHERE id=?", past(), ev.id);
      const r1 = await media.cleanupMediaAssets({ now: Date.now() });
      ok(r1.removed >= 2);
      for (const id of [attached.id, ev.id, withImage.id]) { eq((await rowOf(id)).status, 'ATTACHED'); ok(objects.has((await rowOf(id)).storage_key)); }
      eq((await imageGet(attached.id)).status, 200, 'attached public image still served');
      eq((await imageGet(ev.id, p.s)).status, 200, 'evidence still served to counterparty');
      eq((await imageGet(withImage.id, b2)).status, 200, 'order snapshot image still served');
      eq((await rowOf(expiring.id)).status, 'EXPIRED'); ok(!objects.has((await rowOf(expiring.id)).storage_key));
      eq((await rowOf(stuck.id)).status, 'FAILED', 'unfinished stale upload is failed so a confirmed-clean retry can resume'); ok(!objects.has(stuck.key));
      eq((await rowOf(live.id)).status, 'STAGED'); ok(objects.has((await rowOf(live.id)).storage_key));
      eq((await api('/media/uploads/' + (await rowOf(expiring.id)).request_id, s)).status, 410);
      const expiringKey=(await rowOf(expiring.id)).storage_key;
      const keyCount = removed.filter((k) => k === expiringKey).length;
      await media.cleanupMediaAssets({ now: Date.now() });
      eq(removed.filter((k) => k === expiringKey).length, keyCount, 'idempotent');
      eq(l.images.length, 1);
      // Cleanup racing an in-flight upload.
      const racer = await actor(); let release; faults.putBarrier = new Promise((r) => { release = r; });
      const rid = crypto.randomUUID(), inflight = upload(racer, F.png, { requestId: rid });
      for (let i = 0; i < 60 && !(await sql("SELECT 1 AS x FROM media_assets WHERE owner_id=? AND request_id=?", racer.id, rid)); i++) await sleep(50);
      await write('UPDATE media_assets SET expires_at=? WHERE owner_id=? AND request_id=?', past(), racer.id, rid);
      await media.cleanupMediaAssets();
      release(); faults.putBarrier = null;
      const raced = await inflight;
      ok(raced.status >= 400, 'upload that lost the race does not report success: ' + raced.status);
      const rr = await sql('SELECT * FROM media_assets WHERE owner_id=? AND request_id=?', racer.id, rid);
      ok(['FAILED', 'EXPIRED'].includes(rr.status)); ok(!objects.has(rr.storage_key), 'no orphan object after race'); ok(rr.storage_deleted_at);
    });

    await test('M15', 'listing create/patch attach: order, cover, reorder, omit preserves, [] clears, no-photo honest', async () => {
      const s = await actor();
      const [a, b, c] = [await up(s), await up(s, F.png), await up(s, F.webp, { mime: 'image/webp' })];
      const bare = await newListing(s);
      eq(bare.images, []); ok(!bare.image, 'no fabricated cover image when none uploaded');
      const l = await newListing(s, [a.id, b.id, c.id]);
      eq(idsOf(l.images), [a.id, b.id, c.id]); eq(l.images[0].id, a.id, 'first image is the cover');
      for (const img of l.images) { eq(img.url, '/api/media/images/' + img.id); ok(!FORBIDDEN_META.test(JSON.stringify(img))); }
      for (const id of [a.id, b.id, c.id]) eq((await rowOf(id)).status, 'ATTACHED');
      eq(idsOf(must(await api('/listings/' + l.id, null)).images), [a.id, b.id, c.id], 'public detail keeps order');
      const listed = must(await api('/listings?sellerId=' + s.id, null)).listings.find((x) => x.id === l.id);
      ok(Array.isArray(listed.images) && idsOf(listed.images)[0] === a.id, 'card/list payload carries gallery with cover first');
      const v0 = (await sql('SELECT version FROM listings WHERE id=?', l.id)).version;
      eq(idsOf(must(await api('/listings/' + l.id, s, { title: 'Đổi tiêu đề ảnh giữ nguyên' }, 'PATCH')).images), [a.id, b.id, c.id], 'omitting imageIds preserves');
      const reorder = must(await api('/listings/' + l.id, s, { imageIds: [c.id, a.id] }, 'PATCH'));
      eq(idsOf(reorder.images), [c.id, a.id]);
      eq((await rows('SELECT asset_id,position FROM listing_media WHERE listing_id=? ORDER BY position', l.id)).map((x) => [x.asset_id, Number(x.position)]), [[c.id, 0], [a.id, 1]]);
      ok((await sql('SELECT version FROM listings WHERE id=?', l.id)).version >= v0 + 2, 'listing version bumps on image change');
      eq((await imageGet(b.id)).status, 404, 'image removed from the gallery is no longer public');
      ok(objects.has((await rowOf(b.id)).storage_key), 'detaching never deletes bytes');
      const only = must(await api('/listings/' + l.id, s, { imageIds: [a.id] }, 'PATCH'));
      eq(idsOf(only.images), [a.id]);
      const cleared = must(await api('/listings/' + l.id, s, { imageIds: [] }, 'PATCH'));
      eq(cleared.images, []); eq(await num('SELECT COUNT(*) n FROM listing_media WHERE listing_id=?', l.id), 0);
      eq((await imageGet(a.id)).status, 404);
      eq((await imageGet(a.id, s)).status, 200, 'owner can still preview detached photo');
      eq(idsOf(must(await api('/listings/' + l.id, s, { imageIds: [a.id, b.id] }, 'PATCH')).images), [a.id, b.id], 're-attach after clear');
      // Another seller / buyer cannot edit images.
      const intruder = await actor(), buyer = await actor('BUYER');
      eq((await api('/listings/' + l.id, intruder, { imageIds: [] }, 'PATCH')).status, 403);
      eq((await api('/listings/' + l.id, buyer, { imageIds: [] }, 'PATCH')).status, 403);
      eq(await num('SELECT COUNT(*) n FROM listing_media WHERE listing_id=?', l.id), 2);
    });

    await test('M16', 'listing attach validation is atomic: shape, count, owner, purpose, duplicate use, expiry', async () => {
      const s = await actor(), other = await actor();
      const seven = []; for (let i = 0; i < 7; i++) seven.push((await up(s)).id);
      const mine = (await up(s)).id, foreign = (await up(other)).id;
      const beforeListings = await num('SELECT COUNT(*) n FROM listings WHERE seller_id=?', s.id);
      const create = (imageIds) => api('/listings', s, listingBody({ imageIds }));
      for (const bad of [seven, [mine, mine], 'abc', {}, [123], [''], ['not-a-uuid'], null]) {
        const r = await create(bad);
        eq(r.status, 400, JSON.stringify(bad).slice(0, 60) + ' -> ' + JSON.stringify(r.data));
      }
      const unknownUuid = crypto.randomUUID();
      const foreignRes = await create([foreign]), unknownRes = await create([unknownUuid]), mixedRes = await create([mine, foreign]);
      eq(foreignRes.status, 403); eq(unknownRes.status, foreignRes.status, 'unknown and foreign ids are indistinguishable');
      eq(unknownRes.data.error, foreignRes.data.error); eq(mixedRes.status, 403);
      eq(await num('SELECT COUNT(*) n FROM listings WHERE seller_id=?', s.id), beforeListings, 'no partial listing was created');
      eq((await rowOf(mine)).status, 'STAGED', 'valid image in a rejected request stays staged'); eq((await rowOf(foreign)).status, 'STAGED');
      // Evidence-purpose and already-attached and expired assets.
      const p = await held(); const ev = await upEvidence(p.s, p.id);
      eq((await api('/listings', p.s, listingBody({ imageIds: [ev.id] }))).status, 403);
      const first = await newListing(s, [mine]);
      const dup = await create([mine]);
      eq(dup.status, 409); eq(dup.data.error, 'MEDIA_ALREADY_ATTACHED');
      eq(idsOf(must(await api('/listings/' + first.id, s)).images), [mine], 'first listing unchanged');
      const stale = await up(s); await write('UPDATE media_assets SET expires_at=? WHERE id=?', past(), stale.id);
      eq((await create([stale.id])).status, 410);
      // PATCH failures leave the existing gallery untouched.
      const patchBad = await api('/listings/' + first.id, s, { imageIds: [mine, foreign] }, 'PATCH');
      eq(patchBad.status, 403); eq(idsOf(must(await api('/listings/' + first.id, s)).images), [mine]);
      eq((await api('/listings/' + first.id, s, { imageIds: seven }, 'PATCH')).status, 400);
      eq(idsOf(must(await api('/listings/' + first.id, s)).images), [mine]);
    });

    await test('M17', 'deleting an unsold listing with photos does not 500 and stops serving them', async () => {
      const s = await actor(), a = await up(s);
      const l = await newListing(s, [a.id]);
      const r = await api('/listings/' + l.id, s, undefined, 'DELETE');
      eq(r.status,200,'valid owner deletes unsold listing with images: '+JSON.stringify(r.data));
      eq((await imageGet(a.id)).status,404);eq(await num('SELECT COUNT(*) n FROM listing_media WHERE listing_id=?',l.id),0);
    });

    await test('M18', 'image read matrix: staged/public/hidden/pending/sold/anonymous/invalid token/query token/404 parity', async () => {
      const s = await actor(), stranger = await actor('BUYER'), admin = await actor('ADMIN');
      const staged = await up(s);
      eq((await imageGet(staged.id, s)).status, 200);
      for (const who of [null, stranger, admin, { token: 'bad.token.value' }]) eq((await imageGet(staged.id, who)).status, 404, 'staged is owner-only');
      const pub = await up(s), l = await newListing(s, [pub.id]);
      for (const who of [null, stranger, admin, { token: 'bad.token.value' }]) { const r = await imageGet(pub.id, who); eq(r.status, 200); eq(r.headers.get('x-content-type-options'), 'nosniff'); ok(/no-store/.test(r.headers.get('cache-control'))); }
      must(await api('/listings/' + l.id, s, { visibility: 'HIDDEN' }, 'PATCH'));
      for (const who of [null, stranger, admin]) eq((await imageGet(pub.id, who)).status, 404, 'hidden listing image');
      eq((await imageGet(pub.id, s)).status, 200);
      for (const q of ['?token=' + s.token, '?access_token=' + s.token, '?jwt=' + s.token, '?Authorization=Bearer%20' + s.token]) eq((await imageGet(pub.id, null, q)).status, 404, 'JWT in query string is not authentication');
      must(await api('/listings/' + l.id, s, { visibility: 'PUBLIC' }, 'PATCH'));
      eq((await imageGet(pub.id)).status, 200);
      await write("UPDATE listings SET status='PENDING_SELLER_REVIEW' WHERE id=?", l.id);
      for (const who of [null, stranger]) eq((await imageGet(pub.id, who)).status, 404, 'pending-review listing image');
      eq((await imageGet(pub.id, s)).status, 200);
      await write("UPDATE listings SET status='AVAILABLE' WHERE id=?", l.id);
      // 404 parity: unreadable-existing vs unknown vs malformed must look the same to a stranger.
      const hiddenLike = await imageGet(staged.id, stranger), unknown = await imageGet(crypto.randomUUID(), stranger), malformed = await imageGet('../../etc/passwd', stranger);
      eq(unknown.status, 404); eq(malformed.status, 404);
      eq(hiddenLike.status, unknown.status, 'existing-but-forbidden must be 404 like unknown (no existence leak)');
      eq(hiddenLike.data.error, unknown.data.error);
      ok(!JSON.stringify(hiddenLike.data).includes(s.id), 'no owner id in error body');
      // Sold/locked listing stays visible publicly; participants keep access when listing becomes hidden.
      const b = await actor('BUYER'), s2 = await actor(), pub2 = await up(s2), l2 = await newListing(s2, [pub2.id]);
      const oid = await order(b, s2, l2); must(await secure(b, oid));
      eq((await imageGet(pub2.id)).status, 200, 'locked listing remains visible like the storefront');
      must(await api('/listings/' + l2.id, s2, { visibility: 'HIDDEN' }, 'PATCH'));
      eq((await imageGet(pub2.id, b)).status, 200, 'buyer reads snapshot of hidden listing'); eq((await imageGet(pub2.id, s2)).status, 200);
      eq((await imageGet(pub2.id, stranger)).status, 404); eq((await imageGet(pub2.id)).status, 404);
      eq((await imageGet(pub2.id, admin)).status, 404, 'unclaimed admin has no automatic image access');
      // Stored object tampering / failures never leak bytes or internals.
      const key = (await rowOf(pub2.id)).storage_key, original = objects.get(key);
      const tampered = Buffer.from(original); tampered[tampered.length - 1] ^= 0xff; objects.set(key, tampered);
      let r = await imageGet(pub2.id, b); eq(r.status, 503); ok(!r.buffer.equals(tampered), 'digest mismatch is never served'); ok(!FORBIDDEN_META.test(JSON.stringify(r.data).replace(/MEDIA_STORAGE_UNAVAILABLE/, '')));
      objects.set(key, Buffer.concat([original, Buffer.from([0])])); eq((await imageGet(pub2.id, b)).status, 503, 'oversize/length mismatch rejected');
      objects.set(key, original); faults.failGet = true; eq((await imageGet(pub2.id, b)).status, 503); faults.failGet = false;
      eq((await imageGet(pub2.id, b)).status, 200);
    });

    await test('M19', 'LOCK: listing image/version change invalidates older grant; snapshot at LOCK; historical read survives later listing edits', async () => {
      const s = await actor(), b = await actor('BUYER'), other = await actor('BUYER');
      const old = await up(s), next = await up(s, F.jpegMeta, { mime: 'image/jpeg' });
      const l = await newListing(s, [old.id]);
      const id = await order(b, s, l);
      eq(await num('SELECT COUNT(*) n FROM order_media_snapshot WHERE transaction_id=?', id), 0, 'no snapshot before LOCK');
      const g = await grant(b, id);
      const v0 = (await sql('SELECT version FROM listings WHERE id=?', l.id)).version;
      must(await api('/listings/' + l.id, s, { imageIds: [next.id] }, 'PATCH'));
      ok((await sql('SELECT version FROM listings WHERE id=?', l.id)).version > v0, 'imageIds-only patch bumps listing version');
      const before = await money();
      const stale = await api('/transactions/' + id + '/secure', b, { requestId: crypto.randomUUID(), reauthGrant: g.rawToken });
      eq(stale.status, 409); eq(stale.data.error, 'CONTEXT_MISMATCH'); eq(await money(), before);
      eq((await sql('SELECT status FROM transactions WHERE id=?', id)).status, 'CREATED');
      eq(await num('SELECT COUNT(*) n FROM order_media_snapshot WHERE transaction_id=?', id), 0, 'failed LOCK leaves no snapshot');
      must(await secure(b, id));
      const snap = await rows('SELECT * FROM order_media_snapshot WHERE transaction_id=? ORDER BY position', id);
      eq(snap.map((x) => x.asset_id), [next.id]); eq(snap.map((x) => Number(x.position)), [0]); eq(snap[0].sha256, (await rowOf(next.id)).output_sha256);
      // Reordering alone also invalidates a LOCK grant (second order, same seller).
      const [x, y] = [await up(s), await up(s)], l2 = await newListing(s, [x.id, y.id]), b2 = await actor('BUYER'), id2 = await order(b2, s, l2), g2 = await grant(b2, id2);
      must(await api('/listings/' + l2.id, s, { imageIds: [y.id, x.id] }, 'PATCH'));
      eq((await api('/transactions/' + id2 + '/secure', b2, { requestId: crypto.randomUUID(), reauthGrant: g2.rawToken })).data.error, 'CONTEXT_MISMATCH');
      must(await secure(b2, id2));
      eq((await rows('SELECT asset_id FROM order_media_snapshot WHERE transaction_id=? ORDER BY position', id2)).map((r) => r.asset_id), [y.id, x.id]);
      // Reserved/sold listing images are immutable.
      for (const imageIds of [[old.id], []]) {
        const r = await api('/listings/' + l.id, s, { imageIds }, 'PATCH');
        eq(r.status, 409); eq(r.data.error, 'MEDIA_LISTING_LOCKED');
      }
      eq(idsOf(must(await api('/listings/' + l.id, s)).images), [next.id], 'gallery unchanged after rejected edits');
      eq((await sql('SELECT status FROM media_assets WHERE id=?', next.id)).status, 'ATTACHED');
      // Cancel releases the listing; editing it later must not rewrite the order's snapshot.
      must(await api('/transactions/' + id + '/cancel', b, {}));
      must(await api('/listings/' + l.id, s, { imageIds: [old.id] }, 'PATCH'));
      eq((await rows('SELECT asset_id FROM order_media_snapshot WHERE transaction_id=? ORDER BY position', id)).map((r) => r.asset_id), [next.id], 'snapshot immutable');
      eq((await imageGet(next.id, b)).status, 200, 'buyer still reads historical order image');
      eq((await imageGet(next.id, s)).status, 200);
      eq((await imageGet(next.id, other)).status, 404); eq((await imageGet(next.id)).status, 404, 'no longer part of the public gallery');
      const detail = must(await api('/transactions/' + id, b));
      const shown = detail.images || detail.orderImages || detail.listing?.images;
      if (shown) eq(idsOf(shown), [next.id], 'order detail shows the snapshot, not the current listing gallery');
      else console.log('NOTE M19: GET /transactions/:id exposes no images/orderImages field; historical gallery is only checked via DB + image reads');
      // Order without photos keeps an honest empty snapshot.
      const s3 = await actor(), b3 = await actor('BUYER'), id3 = await order(b3, s3, await newListing(s3));
      must(await secure(b3, id3));
      eq(await num('SELECT COUNT(*) n FROM order_media_snapshot WHERE transaction_id=?', id3), 0);
    });

    await test('M20', 'evidence upload gating by order state and party', async () => {
      const b = await actor('BUYER'), s = await actor();
      const id = await order(b, s, await newListing(s));
      const draft = await upload(b, F.png, { purpose: 'EVIDENCE', transactionId: id });
      eq(draft.status, 409); eq(draft.data.error, 'MEDIA_TARGET_CLOSED');
      must(await secure(b, id));
      const mb = await upEvidence(b, id), ms = await upEvidence(s, id);
      eq(mb.purpose, 'EVIDENCE'); eq(mb.uploadedBy, b.id);
      ok(/^evidence\//.test((await rowOf(mb.id)).storage_key));
      eq((await imageGet(mb.id, b)).status, 200); eq((await imageGet(mb.id, s)).status, 404, 'staged evidence is private to its uploader');
      eq((await imageGet(ms.id, b)).status, 404); eq((await imageGet(mb.id)).status, 404);
      eq((await sql('SELECT transaction_id FROM media_assets WHERE id=?', mb.id)).transaction_id, id);
      // Evidence staged before the complaint can be attached while opening it; images alone do not change the case.
      const beforeMoney = await money();
      const opened = must(await api('/transactions/' + id + '/dispute', b, { type: 'DEFECT', reason: 'Ảnh đính kèm khi mở khiếu nại', imageIds: [mb.id] }), 201);
      eq(opened.dispute.type, 'DEFECT'); eq((await rowOf(mb.id)).status, 'ATTACHED');
      eq((await sql('SELECT actor_id FROM dispute_media WHERE asset_id=?', mb.id)).actor_id, b.id);
      eq(await money(), beforeMoney, 'opening with evidence writes no ledger rows');
      eq((await imageGet(mb.id, s)).status, 200, 'counterparty can read once attached to the case');
      const late = await upEvidence(s, id);
      eq((await rowOf(late.id)).status, 'STAGED');
    });

    await test('M21', 'evidence attach: no money/status/type/decision change; revision+order version bump; audit; stale authorization fails; access incl. claimed admin', async () => {
      const p = await disputed(), admin = await actor('ADMIN'), otherAdmin = await actor('ADMIN'), stranger = await actor('BUYER');
      const e1 = await upEvidence(p.b, p.id);
      const before = { money: await money(), state: await caseState(p.id), audits: await num('SELECT COUNT(*) n FROM audit_logs WHERE transaction_id=?', p.id) };
      must(await api('/transactions/' + p.id + '/dispute/messages', p.b, { message: 'Bổ sung ảnh không tự chứng minh hàng đúng', imageIds: [e1.id] }), 201);
      eq(await money(), before.money, 'no wallet/ledger change');
      const after = await caseState(p.id);
      for (const k of ['status', 'escrow_status', 'amount', 'buyer_id', 'seller_id', 'listing_id']) eq(after.txn[k], before.state.txn[k], k);
      for (const k of ['type', 'status', 'opened_by', 'reason', 'admin_id', 'admin_decision', 'resolved_at']) eq(after.dispute[k], before.state.dispute[k], k);
      ok(after.dispute.revision > before.state.dispute.revision, 'dispute revision bumped'); ok(after.txn.version > before.state.txn.version, 'order version bumped');
      eq(after.media, before.state.media + 1);
      const row = await sql('SELECT * FROM dispute_media WHERE asset_id=?', e1.id);
      eq(row.actor_id, p.b.id); ok(Date.parse(row.attached_at) > 0);
      const audit = await rows("SELECT * FROM audit_logs WHERE transaction_id=? AND action='DISPUTE_IMAGES_ATTACHED'", p.id);
      eq(audit.length, 1, 'one audit entry for the attach'); ok(JSON.stringify(audit[0]).includes(e1.id), 'audit references image id');
      ok(!JSON.stringify(audit[0]).includes('Bổ sung ảnh'), 'audit never stores message text');
      ok((await require('../src/lib/hash').verifyChain(db, p.id)).valid, 'hash chain intact');
      ok((await num('SELECT COUNT(*) n FROM audit_logs WHERE transaction_id=?', p.id)) > before.audits);
      // Access: counterparty + uploader yes; stranger/anonymous no; admin only after explicit claim.
      eq((await imageGet(e1.id, p.b)).status, 200); eq((await imageGet(e1.id, p.s)).status, 200);
      for (const who of [null, stranger, admin, otherAdmin]) eq((await imageGet(e1.id, who)).status, 404);
      const unclaimed = must(await api('/admin/disputes/' + p.d.id, admin));
      ok(!idsOf(evidenceOf(unclaimed)).includes(e1.id), 'unclaimed admin detail does not list private evidence');
      const strangerDetail = await api('/transactions/' + p.id, stranger);
      ok([403, 404].includes(strangerDetail.status), 'stranger cannot read the order detail: ' + strangerDetail.status);
      must(await api('/admin/disputes/' + p.d.id + '/claim', admin, {}));
      eq((await imageGet(e1.id, admin)).status, 200); eq((await imageGet(e1.id, otherAdmin)).status, 404);
      const adminDetail = must(await api('/admin/disputes/' + p.d.id, admin)), partyDetail = must(await api('/transactions/' + p.id, p.s));
      for (const d of [adminDetail, partyDetail]) {
        const item = evidenceOf(d).find((x) => x.id === e1.id);
        ok(item, 'imageEvidence[] lists the image'); eq(item.url, '/api/media/images/' + e1.id);
        eq(item.actorId, p.b.id, 'evidence names who attached it'); ok(Date.parse(item.attachedAt) > 0, 'evidence shows attach time'); ok(Date.parse(item.createdAt) > 0, 'and upload time');
        ok(!FORBIDDEN_META.test(JSON.stringify(item)));
      }
      // Stale admin authorization (issued after claim, before further evidence) is refused and moves no money.
      const adminGrant = await grant(admin, p.id, ACTIONS.ADJUDICATE, 'REFUND');
      const e2 = await upEvidence(p.s, p.id), moneyBefore = await money();
      must(await api('/transactions/' + p.id + '/dispute/messages', p.s, { message: 'Phản hồi kèm ảnh của người bán', imageIds: [e2.id] }), 201);
      eq((await sql('SELECT dispute_id FROM dispute_media WHERE asset_id=?',e2.id)).dispute_id,p.d.id,'second image actually attached before stale-grant check');
      ok(idsOf(evidenceOf(must(await api('/transactions/'+p.id,p.b)))).includes(e2.id),'second image visible in case payload');
      const secondAudit=await rows("SELECT event_data FROM audit_logs WHERE transaction_id=? AND action='DISPUTE_IMAGES_ATTACHED'",p.id);
      const secondDigest=(await rowOf(e2.id)).output_sha256;
      ok(secondAudit.some(row=>row.event_data.includes(e2.id)&&row.event_data.includes(secondDigest)),'audit references second image and digest');
      const stale = await api('/admin/disputes/' + p.d.id + '/refund', admin, { requestId: crypto.randomUUID(), reauthGrant: adminGrant.rawToken });
      eq(stale.status, 409); eq(stale.data.error, 'DISPUTE_REVIEW_STALE'); eq(await money(), moneyBefore);
      eq((await sql('SELECT status FROM disputes WHERE id=?', p.d.id)).status, 'OPEN');
      eq((await imageGet(e2.id, admin)).status, 200, 'claimed admin reads both parties evidence');
      eq((await imageGet(e2.id, p.b)).status, 200);
      ok((await require('../src/lib/hash').verifyChain(db, p.id)).valid);
    });

    await test('M22', 'evidence limits (6/party, 12/case), atomic rollback, append-only, wrong owner/purpose/case, contract text lengths', async () => {
      const p = await disputed();
      const stage = async (who, n) => { const out = []; for (let i = 0; i < n; i++) out.push((await upEvidence(who, p.id)).id); return out; };
      const msg = (who, imageIds, message = 'Ảnh bổ sung cho hồ sơ') => api('/transactions/' + p.id + '/dispute/messages', who, { message, imageIds });
      const buyerImgs = await stage(p.b, 9);
      // More than six in one request, duplicates, bad shapes.
      for (const bad of [buyerImgs.slice(0, 7), [buyerImgs[0], buyerImgs[0]], 'x', [1]]) eq((await msg(p.b, bad)).status, 400);
      eq(await caseState(p.id).then((x) => x.media), 0);
      must(await msg(p.b, buyerImgs.slice(0, 4)), 201);
      const snapshot = await caseState(p.id), ledgerBefore = await money();
      const overflow = await msg(p.b, buyerImgs.slice(4, 7));
      eq(overflow.status, 409); eq(overflow.data.error, 'MEDIA_EVIDENCE_LIMIT');
      eq(await caseState(p.id), snapshot, 'rejected over-limit request leaves message/revision/media untouched');
      for (const id of buyerImgs.slice(4, 7)) eq((await rowOf(id)).status, 'STAGED');
      must(await msg(p.b, buyerImgs.slice(4, 6)), 201);
      const seventh = await msg(p.b, [buyerImgs[6]]); eq(seventh.status, 409);
      // Re-attaching an already attached image adds no duplicate row.
      const mediaRows = (await caseState(p.id)).media;
      const reattach = await msg(p.b, [buyerImgs[0]]);
      ok([201, 409].includes(reattach.status)); eq((await caseState(p.id)).media, mediaRows);
      // Seller reaches the 12 total.
      const sellerImgs = await stage(p.s, 6);
      must(await msg(p.s, sellerImgs.slice(0, 3)), 201); must(await msg(p.s, sellerImgs.slice(3)), 201);
      eq((await caseState(p.id)).media, 12);
      eq(await money(), ledgerBefore, 'no wallet or ledger change while attaching up to the case limit');
      // Ownership / purpose / case binding.
      const q = await disputed();
      const qBuyerImg = await upEvidence(q.b, q.id), qSellerImg = await upEvidence(q.s, q.id), listingImg = await up(q.s);
      const otherSeller = await actor(), otherOrder = await order(q.b, otherSeller);
      must(await secure(q.b, otherOrder));
      const crossCaseImg = await upEvidence(q.b, otherOrder);
      const qmsg = (who, imageIds, message = 'Ảnh bổ sung cho hồ sơ') => api('/transactions/' + q.id + '/dispute/messages', who, { message, imageIds });
      const qState = await caseState(q.id);
      for (const [who, ids, label] of [[q.b, [qSellerImg.id], 'counterparty asset'], [q.s, [qBuyerImg.id], 'counterparty asset'], [q.s, [listingImg.id], 'same-owner listing-purpose asset'],
        [q.b, [crossCaseImg.id], 'asset staged for another order'], [q.b, [crypto.randomUUID()], 'unknown id']]) {
        const r = await qmsg(who, ids);
        eq(r.status, 403, label + ' refused: ' + JSON.stringify(r.data));
        eq(await caseState(q.id), qState, label + ' left no partial state');
      }
      // Contract text lengths: reason 10..1000, message 5..1000, message required with images.
      const shortMsg = await qmsg(q.b, [qBuyerImg.id], 'abcd'); eq(shortMsg.status, 400);
      const emptyMsg = await qmsg(q.b, [qBuyerImg.id], ''); eq(emptyMsg.status, 400);
      eq((await rowOf(qBuyerImg.id)).status, 'STAGED'); eq(await caseState(q.id), qState);
      const r3 = await held(); const stagedBefore = await upEvidence(r3.b, r3.id);
      const shortReason = await api('/transactions/' + r3.id + '/dispute', r3.b, { type: 'DEFECT', reason: 'ngắn', imageIds: [stagedBefore.id] });
      eq(shortReason.status, 400); eq((await sql('SELECT status FROM transactions WHERE id=?', r3.id)).status, 'SECURED'); eq((await rowOf(stagedBefore.id)).status, 'STAGED');
      // Append-only: there is no way to delete/replace attached evidence through any route.
      for (const [method, route] of [['DELETE', '/media/images/' + buyerImgs[0]], ['PUT', '/media/images/' + buyerImgs[0]], ['PATCH', '/media/images/' + buyerImgs[0]],
        ['DELETE', '/transactions/' + p.id + '/dispute/images/' + buyerImgs[0]], ['PATCH', '/transactions/' + p.id + '/dispute']]) {
        const r = await api(route, p.b, method === 'DELETE' ? undefined : {}, method);
        ok(r.status >= 400 && r.status < 500, method + ' ' + route + ' -> ' + r.status);
      }
      eq((await caseState(p.id)).media, 12); eq((await rowOf(buyerImgs[0])).status, 'ATTACHED');
    });

    await test('M23', 'evidence stays readable after closure; no uploads/attaches after the case is closed', async () => {
      const p = await disputed(), admin = await actor('ADMIN'), stranger = await actor('BUYER');
      const attached = await upEvidence(p.b, p.id), spare = await upEvidence(p.b, p.id);
      must(await api('/transactions/' + p.id + '/dispute/messages', p.b, { message: 'Ảnh trước khi đóng hồ sơ', imageIds: [attached.id] }), 201);
      must(await api('/admin/disputes/' + p.d.id + '/claim', admin, {}));
      const g = await grant(admin, p.id, ACTIONS.ADJUDICATE, 'REFUND');
      must(await api('/admin/disputes/' + p.d.id + '/refund', admin, { requestId: crypto.randomUUID(), reauthGrant: g.rawToken }));
      ok((await sql('SELECT status FROM disputes WHERE id=?', p.d.id)).status !== 'OPEN', 'case closed by adjudication');
      for (const who of [p.b, p.s, admin]) eq((await imageGet(attached.id, who)).status, 200, 'readable after closure');
      for (const who of [null, stranger]) eq((await imageGet(attached.id, who)).status, 404);
      const state = await caseState(p.id), moneyBefore = await money();
      const late = await api('/transactions/' + p.id + '/dispute/messages', p.b, { message: 'Bổ sung sau khi đã đóng', imageIds: [spare.id] });
      eq(late.status, 409); eq((await rowOf(spare.id)).status, 'STAGED'); eq(await caseState(p.id), state); eq(await money(), moneyBefore);
      const upl = await upload(p.b, F.png, { purpose: 'EVIDENCE', transactionId: p.id });
      eq(upl.status, 409); eq(upl.data.error, 'MEDIA_TARGET_CLOSED');
    });

    await test('M24', 'decoder concurrency is bounded (2) and excess work is refused, not queued unboundedly', async () => {
      const image = require('../src/lib/mediaImage');
      const many = await Promise.allSettled(Array.from({ length: 6 }, () => image.normalizeImage(F.png, 'image/png')));
      eq(many.filter((x) => x.status === 'fulfilled').length, 2);
      eq(many.filter((x) => x.status === 'rejected' && x.reason.code === 'MEDIA_PROCESSING_BUSY' && x.reason.status === 429).length, 4);
      const after = await image.normalizeImage(F.png, 'image/png');
      ok(after.buffer.length > 0, 'counter released after burst');
      const s = await actor();
      const reasons = await Promise.all(Array.from({ length: 8 }, () => upload(s, F.bigJpeg, { mime: 'image/jpeg' })));
      ok(reasons.every((r) => [201, 409, 429].includes(r.status)), 'burst statuses: ' + reasons.map((r) => r.status));
      for (const row of await rows('SELECT * FROM media_assets WHERE owner_id=?', s.id)) {
        if (row.status === 'FAILED') ok(row.storage_deleted_at && !objects.has(row.storage_key), 'busy-failed reservation was fully released');
      }
    });

    await test('M26','PUT writes object then loses response: cleanup and quota remain correct',async()=>{
      const s=await actor(),before=await money();
      faults.afterPut=async()=>{throw new Error('fixture response lost after durable write');};
      let r=await upload(s,F.png);eq(r.status,503);
      const first=(await rows('SELECT * FROM media_assets WHERE owner_id=?',s.id))[0];
      eq(first.status,'FAILED');ok(first.storage_deleted_at);ok(!objects.has(first.storage_key));
      faults.afterPut=async key=>{failRemoveKeys.add(key);throw new Error('fixture response lost; cleanup unavailable');};
      const requestId=crypto.randomUUID();r=await upload(s,F.png,{requestId});eq(r.status,503);
      const failed=await sql('SELECT * FROM media_assets WHERE owner_id=? AND request_id=?',s.id,requestId);
      eq(failed.status,'FAILED');eq(failed.storage_deleted_at,null);ok(objects.has(failed.storage_key));eq(Number(failed.reserved_bytes),524288);
      faults.afterPut=null;const retryWhileDirty=await upload(s,F.png,{requestId});eq(retryWhileDirty.status,409);eq(retryWhileDirty.data.error,'MEDIA_CLEANUP_PENDING');
      failRemoveKeys.delete(failed.storage_key);await media.cleanupMediaAssets();
      ok(!objects.has(failed.storage_key));ok((await rowOf(failed.id)).storage_deleted_at);
      const retry=await upload(s,F.png,{requestId});eq(retry.status,201);eq(retry.data.id,failed.id);ok((await rowOf(failed.id)).storage_key!==failed.storage_key);
      eq(await money(),before,'ambiguous object storage never moves money');
    });

    await test('M27','ambiguous DB commit preserves finalized STAGED and referenced ATTACHED objects',async()=>{
      for(const attachImmediately of [false,true]){
        const s=await actor(),requestId=crypto.randomUUID(),originalTransaction=db.transaction;let fired=false,attachedListing;
        db.transaction=function(fn){const wrapped=originalTransaction.call(db,fn);return async function(...args){const value=await wrapped.apply(this,args);if(!fired&&value?.status==='STAGED'&&value.request_id===requestId){fired=true;if(attachImmediately)attachedListing=await newListing(s,[value.id]);throw new Error('fixture COMMIT succeeded but acknowledgement was lost');}return value;};};
        let r;try{r=await upload(s,F.png,{requestId});}finally{db.transaction=originalTransaction;}
        ok(fired,'post-commit fault actually fired');eq(r.status,201,JSON.stringify(r.data));
        const asset=await rowOf(r.data.id);eq(asset.status,attachImmediately?'ATTACHED':'STAGED');ok(objects.has(asset.storage_key));eq(removed.filter(k=>k===asset.storage_key).length,0);eq((await imageGet(asset.id,s)).status,200);
        if(attachImmediately){eq((await sql('SELECT listing_id FROM listing_media WHERE asset_id=?',asset.id)).listing_id,attachedListing.id);eq((await imageGet(asset.id)).status,200);}
        const lookup=must(await api('/media/uploads/'+requestId,s));eq(lookup.id,asset.id);
      }
    });

    await test('M28','stale cleanup cannot tombstone a newer failed rotated attempt',async()=>{
      const s=await actor(),requestId=crypto.randomUUID();faults.afterPut=async key=>{failRemoveKeys.add(key);throw new Error('seed failed attempt A');};
      eq((await upload(s,F.png,{requestId})).status,503);faults.afterPut=null;
      const attemptA=await sql('SELECT * FROM media_assets WHERE owner_id=? AND request_id=?',s.id,requestId);failRemoveKeys.delete(attemptA.storage_key);
      let releaseA,enteredA;const gateA=new Promise(r=>releaseA=r),seenA=new Promise(r=>enteredA=r);let callsA=0;
      faults.beforeRemove=async key=>{if(key===attemptA.storage_key&&++callsA===1){enteredA();await gateA;}};
      const cleanupA=media.cleanupMediaAssets();
      try{
        await seenA;await media.cleanupMediaAssets();ok((await rowOf(attemptA.id)).storage_deleted_at,'cleanup B confirmed old key deletion');
        faults.afterPut=async key=>{failRemoveKeys.add(key);throw new Error('new attempt B fails and cannot remove');};
        eq((await upload(s,F.png,{requestId})).status,503);faults.afterPut=null;
        const attemptB=await rowOf(attemptA.id);ok(attemptB.storage_key!==attemptA.storage_key);eq(attemptB.storage_deleted_at,null);ok(objects.has(attemptB.storage_key));
        releaseA();await cleanupA;
        const after=await rowOf(attemptB.id);eq(after.storage_key,attemptB.storage_key);eq(after.version,attemptB.version);eq(after.status,'FAILED');eq(after.storage_deleted_at,null,'old cleanup cannot mark new key deleted');
        const retry=await upload(s,F.png,{requestId});eq(retry.status,409);eq(retry.data.error,'MEDIA_CLEANUP_PENDING');
        failRemoveKeys.delete(attemptB.storage_key);await media.cleanupMediaAssets();ok(!objects.has(attemptB.storage_key));
        eq((await upload(s,F.png,{requestId})).status,201);
      }finally{releaseA();faults.beforeRemove=null;faults.afterPut=null;await cleanupA.catch(()=>{});}
    });

    await test('M29','stale failed-handler abandonment cannot mark a newer attempt cleaned',async()=>{
      const s=await actor(),requestId=crypto.randomUUID();let releaseA,enteredA,keyA,attempts=0;
      const gateA=new Promise(r=>releaseA=r),seenA=new Promise(r=>enteredA=r);
      faults.afterPut=async key=>{attempts++;if(attempts===1)keyA=key;else failRemoveKeys.add(key);throw new Error('fixture storage write acknowledged ambiguously');};
      let removesA=0;faults.beforeRemove=async key=>{if(key===keyA&&++removesA===1){enteredA();await gateA;}};
      const originalUpload=upload(s,F.png,{requestId});
      try{
        await seenA;const old=await sql('SELECT * FROM media_assets WHERE owner_id=? AND request_id=?',s.id,requestId);eq(old.status,'FAILED');eq(old.storage_deleted_at,null);
        await media.cleanupMediaAssets();ok((await rowOf(old.id)).storage_deleted_at);
        eq((await upload(s,F.png,{requestId})).status,503);
        const newer=await rowOf(old.id);ok(newer.storage_key!==keyA);eq(newer.status,'FAILED');eq(newer.storage_deleted_at,null);ok(objects.has(newer.storage_key));
        releaseA();eq((await originalUpload).status,503);
        const current=await rowOf(old.id);eq(current.storage_key,newer.storage_key);eq(current.version,newer.version);eq(current.storage_deleted_at,null,'stale catch cannot release newer quota');
        faults.afterPut=null;failRemoveKeys.delete(newer.storage_key);await media.cleanupMediaAssets();eq((await upload(s,F.png,{requestId})).status,201);
      }finally{releaseA();faults.beforeRemove=null;faults.afterPut=null;await originalUpload.catch(()=>{});}
    });

    await test('M30','disconnect after complete body keeps upload slot until pending PUT finally ends',async()=>{
      const router=require('../src/routes/media'),stats=router.getMediaUploadStatsForTests;
      ok(typeof stats==='function','guarded route statistics available');await until(()=>stats().active===0,'prior handlers complete');
      const s=await actor(),limit=stats().limit;ok(Number.isSafeInteger(limit)&&limit>=1&&limit<=8);
      let release;const gate=new Promise(r=>release=r);faults.putBarrier=gate;
      const http=require('node:http'),rawClients=[],started=putAttempts.length,ids=[];
      try{
        for(let i=0;i<limit;i++){
          const requestId=crypto.randomUUID();ids.push(requestId);
          let resolveResult;const result=new Promise(r=>resolveResult=r);
          const req=http.request(base+'/api/media/uploads?'+new URLSearchParams({purpose:'LISTING',requestId}),{method:'POST',headers:{Authorization:'Bearer '+s.token,'Content-Type':'image/png','Content-Length':String(F.png.length),Origin:'http://localhost'}},res=>{res.resume();res.once('end',()=>resolveResult({status:res.statusCode}));});
          req.once('error',()=>resolveResult({aborted:true}));req.end(F.png);rawClients.push({req,result});
          await until(()=>putAttempts.length>=started+i+1,'upload body fully read and PUT pending');
          req.destroy();await result;await sleep(15);eq(stats().active,i+1,'disconnected handler still owns slot');
        }
        const countBefore=await assetCount(s),attemptBefore=putAttempts.length;
        const rejected=await upload(s,F.png);eq(rejected.status,429);eq(rejected.data.error,'MEDIA_PROCESSING_BUSY');ok(rejected.headers.get('retry-after'));eq(await assetCount(s),countBefore);eq(putAttempts.length,attemptBefore);eq(stats().active,limit);
        release();faults.putBarrier=null;await until(()=>stats().active===0,'all detached handlers finally release slots');
        for(const requestId of ids){const row=await sql('SELECT * FROM media_assets WHERE owner_id=? AND request_id=?',s.id,requestId);eq(row.status,'STAGED');ok(objects.has(row.storage_key));eq((await api('/media/uploads/'+requestId,s)).status,200);}
      }finally{release();faults.putBarrier=null;for(const client of rawClients)client.req.destroy();await Promise.all(rawClients.map(c=>c.result));await until(()=>stats().active===0,'cleanup disconnected handlers').catch(()=>{});}
    });

    await test('M31','late PUT of old key retains cleanup obligation without touching a newer successful retry',async()=>{
      const s=await actor(),requestId=crypto.randomUUID();let keyA,releaseA;
      const gateA=new Promise(r=>releaseA=r);
      faults.beforePut=async key=>{if(!keyA){keyA=key;await gateA;}};
      const firstUpload=upload(s,F.png,{requestId});
      try{
        await until(()=>!!keyA,'attempt A reached storage with complete body');
        const old=await sql('SELECT * FROM media_assets WHERE owner_id=? AND request_id=?',s.id,requestId);
        await write('UPDATE media_assets SET expires_at=? WHERE id=?',past(),old.id);
        await media.cleanupMediaAssets();ok((await rowOf(old.id)).storage_deleted_at,'cleanup completed before delayed PUT A');
        const newer=await upload(s,F.png,{requestId});eq(newer.status,201);eq(newer.data.id,old.id);
        const current=await rowOf(old.id);ok(current.storage_key!==keyA);eq(current.status,'STAGED');ok(objects.has(current.storage_key));
        failRemoveKeys.add(keyA);releaseA();const oldResponse=await firstUpload;
        ok([201,409,503].includes(oldResponse.status),'late response has controlled reconciliation semantics');
        const after=await rowOf(old.id);eq(after.storage_key,current.storage_key);eq(after.status,'STAGED');eq(after.storage_deleted_at,null);eq((await imageGet(after.id,s)).status,200);
        ok(objects.has(keyA),'forced failed DELETE keeps late key A until cleanup can retry');
        const debt=await sql('SELECT * FROM media_cleanup_jobs WHERE storage_key=?',keyA);ok(debt,'old attempt has durable independent cleanup job');eq(debt.asset_id,old.id);eq(debt.owner_id,s.id);eq(debt.deleted_at,null);eq(Number(debt.reserved_bytes),524288);
        const filler=[];try{for(let n=0;n<62;n++)filler.push(await seedAsset(s.id));const quota=await upload(s,F.png);eq(quota.status,413,'old attempt cleanup reservation participates in owner quota');eq(quota.data.error,'MEDIA_OWNER_QUOTA');}finally{for(const row of filler)await write('DELETE FROM media_assets WHERE id=?',row.id);}
        eq((await imageGet(after.id)).status,404,'unattached newer retry remains private');
        const blockedCleanup=await media.cleanupMediaAssets();ok(blockedCleanup.failed>=1,'durable cleanup still attempts old key A despite newer live key B');
        failRemoveKeys.delete(keyA);await media.cleanupMediaAssets();ok(!objects.has(keyA),'late old key eventually removed');ok((await sql('SELECT deleted_at FROM media_cleanup_jobs WHERE storage_key=?',keyA)).deleted_at);ok(objects.has(current.storage_key),'new successful retry key never deleted');eq((await imageGet(after.id,s)).status,200);
      }finally{releaseA();faults.beforePut=null;await firstUpload.catch(()=>{});}
    });

    await test('M25', 'global invariants: money/audit chains intact; every live asset has exactly its verified bytes; no orphan objects; no dangling references', async () => {
      const result = await require('../src/lib/invariants').checkInvariants(db);
      ok(result.ok, JSON.stringify(result.violations));
      for (const id of txIds) ok((await require('../src/lib/hash').verifyChain(db, id)).valid, 'hash chain ' + id);
      eq(await rows("SELECT transaction_id FROM wallet_entries WHERE entry_type IN ('ESCROW_REFUND_DEBIT','ESCROW_RELEASE_DEBIT') GROUP BY transaction_id HAVING COUNT(*)>1"), []);
      await media.cleanupMediaAssets();
      eq(await num('SELECT COUNT(*) n FROM media_cleanup_jobs WHERE deleted_at IS NULL'),0,'all forced cleanup debts eventually retired');
      const assets = await rows('SELECT * FROM media_assets');
      const byKey = new Map(assets.map((a) => [a.storage_key, a]));
      for (const a of assets) {
        if (['STAGED', 'ATTACHED'].includes(a.status) && Number(a.bytes) > 0) {
          ok(objects.has(a.storage_key), 'live asset has its object ' + a.id);
          const obj = objects.get(a.storage_key);
          eq(obj.length, Number(a.bytes), 'length ' + a.id); eq(sha(obj), a.output_sha256, 'digest ' + a.id);
        }
        if (['FAILED', 'EXPIRED'].includes(a.status)) ok(!objects.has(a.storage_key) || !a.storage_deleted_at, 'deleted rows keep no object ' + a.id);
      }
      for (const key of objects.keys()) {
        const a = byKey.get(key);
        ok(a, 'every stored object has a DB reservation row (no orphan): ' + key);
        ok(['STAGED', 'ATTACHED'].includes(a.status), 'stored object belongs to a live asset (status ' + a.status + '): ' + key);
      }
      eq(await rows('SELECT lm.asset_id FROM listing_media lm LEFT JOIN media_assets a ON a.id=lm.asset_id WHERE a.id IS NULL'), []);
      eq(await rows('SELECT dm.asset_id FROM dispute_media dm LEFT JOIN media_assets a ON a.id=dm.asset_id WHERE a.id IS NULL'), []);
      eq(await rows("SELECT s.asset_id FROM order_media_snapshot s JOIN media_assets a ON a.id=s.asset_id WHERE a.status NOT IN ('ATTACHED')"), [], 'snapshot assets are never expired/failed');
      eq(await rows("SELECT dm.asset_id FROM dispute_media dm JOIN media_assets a ON a.id=dm.asset_id WHERE a.status<>'ATTACHED' OR a.purpose<>'EVIDENCE'"), []);
      eq(await rows("SELECT lm.asset_id FROM listing_media lm JOIN media_assets a ON a.id=lm.asset_id WHERE a.status<>'ATTACHED' OR a.purpose<>'LISTING'"), []);
      eq(await rows('SELECT listing_id, COUNT(*) n FROM listing_media GROUP BY listing_id HAVING COUNT(*)>6'), []);
      eq(await rows('SELECT dispute_id, COUNT(*) n FROM dispute_media GROUP BY dispute_id HAVING COUNT(*)>12'), []);
      eq(await rows('SELECT dispute_id, actor_id, COUNT(*) n FROM dispute_media GROUP BY dispute_id, actor_id HAVING COUNT(*)>6'), []);
    });

    console.log('MEDIA_RESULTS ' + JSON.stringify({ dialect: DIALECT, checks, passed: results.filter((x) => x.result === 'PASS').length, skipped: results.filter((x) => x.result === 'SKIP').length, failed: results.filter((x) => x.result === 'FAIL').length, results }));
    process.exitCode = results.some((x) => x.result === 'FAIL') ? 1 : 0;
  } finally {
    storage.setMediaStorageForTests(null);
    await new Promise((r) => server.close(r));
    await db.close();
  }
}

if (!mode) launch().catch((e) => { console.error(e); process.exitCode = 1; });
else if (mode === '--run') run().catch((e) => { console.error(e); process.exitCode = 1; });
else throw new Error('Unknown media test mode');
