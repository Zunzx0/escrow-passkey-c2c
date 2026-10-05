'use strict';
/**
 * Kiểm thử store PayPal (src/lib/paypalPaymentStore.js) trên CSDL THẬT, fixture riêng — không dùng CSDL
 * test chung, không cần server chạy, không gọi PayPal.
 *
 *   node test/paypal-store-concurrency-e2e.js                       SQLite (file tạm trong data/test/)
 *   node test/paypal-store-concurrency-e2e.js --pg=<url>            thêm PostgreSQL
 *
 * <url> phải trỏ tới một CSDL có tên kết thúc bằng "_store_test" (ví dụ enclave_paypal_store_test):
 * bộ test XOÁ schema app/mock_provider của CSDL đó rồi dựng lại từ schema.pg.sql. Tạo CSDL nếu chưa có.
 *
 * Mức đồng thời:
 *   - SQLite: hai store dùng CHUNG một kết nối (hai kết nối đồng bộ trong một process Node khoá chết nhau);
 *     đồng thời là các lời gọi async đan xen.
 *   - PostgreSQL: hai pool trong MỘT process Node (không phải hai process).
 *   - K5: HAI process Node thật, mỗi process một kết nối, bắt đầu cùng lúc bằng file barrier — cả hai nền.
 * Thứ tự các bước được điều khiển tường minh bằng promise/barrier: POST capture tới PayPal là một
 * promise chỉ hoàn tất khi test cho phép; không dùng sleep ngẫu nhiên.
 *
 * Phạm vi: CHỈ store và lược đồ đề xuất. Chưa chứng minh luồng ghi ví tích hợp (route, adapter,
 * applyProviderResult) — các bài P8 chỉ mô phỏng bước credit bằng một UPDATE trong cùng transaction.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { SqliteAsyncDatabase, PgAsyncDatabase } = require('../src/lib/asyncDb');
const { createPayPalPaymentStore, proposedSchema } = require('../src/lib/paypalPaymentStore');

const ROOT = path.join(__dirname, '..');
let failures = 0;
let passes = 0;
function assert(cond, label) {
  console.log(`  ${cond ? '✅' : '❌'} ${label}`);
  if (cond) passes++; else failures++;
}
function section(title) { console.log(`\n${title}`); }
async function group(title, fn) {
  section(title);
  try { await fn(); } catch (e) {
    console.log((e.stack || '').split('\n').slice(0, 4).join('\n'));
    assert(false, `Nhóm dừng giữa chừng vì lỗi: ${e.message}`);
  }
}
async function rejects(fn) { try { await fn(); return false; } catch (_) { return true; } }
async function rejectsWith(fn, code) { try { await fn(); return null; } catch (e) { return e.code === code ? e : null; } }

const uid = () => crypto.randomUUID();
const iso = (msFromNow = 0) => new Date(Date.now() + msFromNow).toISOString();
const MERCHANT = 'SANDBOXMERCHANT01';

function quoteFor(amountVnd, rate = 25000) {
  const cents = (BigInt(amountVnd) * 100n + BigInt(rate) - 1n) / BigInt(rate);
  return { version: 1, amountVnd, currency: 'USD', usdCents: Number(cents),
    usdValue: `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`, rateVndPerUsd: rate };
}

// ------------------------------------------------------------------------------------------
// Fixture
// ------------------------------------------------------------------------------------------
async function sqliteFixture() {
  const Database = require('../src/lib/sqlite');
  const file = path.join(ROOT, 'data', 'test', `paypal-store-${Date.now()}.db`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const open = () => {
    const raw = new Database(file);
    raw.pragma('journal_mode = WAL');
    raw.pragma('foreign_keys = ON');
    raw.pragma('busy_timeout = 5000');
    return new SqliteAsyncDatabase(raw);
  };
  const setup = open();
  setup.raw.exec(fs.readFileSync(path.join(ROOT, 'src', 'schema.sql'), 'utf8'));
  for (const sql of proposedSchema('sqlite')) setup.raw.exec(sql);
  await setup.close();
  return {
    dialect: 'sqlite',
    childTarget: { dialect: 'sqlite', file },
    // Hai kết nối SQLite ĐỒNG BỘ trong cùng một process Node sẽ khoá chết nhau: BEGIN IMMEDIATE của
    // kết nối thứ hai chặn event loop trong lúc transaction async của kết nối thứ nhất cần event loop
    // để commit. SQLite chạy một process duy nhất, nên ở đây hai store dùng CHUNG một kết nối và tính
    // đồng thời là các lời gọi async đan xen (đúng như production SQLite). Đồng thời giữa hai process
    // thật được kiểm trên PostgreSQL (hai pool).
    sharedConnection: true,
    open,
    async cleanup() {
      for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(file + s); } catch (_) { /* file tạm */ } }
    },
  };
}

async function pgFixture(url) {
  const pg = require('pg');
  const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  if (!/_store_test$/.test(name)) throw new Error(`--pg phải trỏ tới CSDL tên kết thúc "_store_test" (nhận "${name}")`);
  const toSafe = (v) => { if (v === null) return null; const n = Number(v); if (!Number.isSafeInteger(n)) throw new Error(`số ${v} vượt ngưỡng an toàn`); return n; };
  pg.types.setTypeParser(20, toSafe);
  pg.types.setTypeParser(1700, toSafe);
  const ssl = /sslmode=disable/.test(url) ? false : { rejectUnauthorized: false };

  const adminUrl = new URL(url); adminUrl.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: adminUrl.toString(), ssl });
  await admin.connect();
  if (!(await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])).rowCount) await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();

  const setup = new pg.Client({ connectionString: url, ssl });
  await setup.connect();
  await setup.query('DROP SCHEMA IF EXISTS app CASCADE; DROP SCHEMA IF EXISTS mock_provider CASCADE;');
  await setup.query(fs.readFileSync(path.join(ROOT, 'src', 'schema.pg.sql'), 'utf8'));
  for (const sql of proposedSchema('pg')) await setup.query(sql);
  await setup.end();

  const pools = [];
  return {
    dialect: 'pg',
    childTarget: { dialect: 'pg', url },
    open() {
      const pool = new pg.Pool({ connectionString: url, ssl, max: 4, allowExitOnIdle: true });
      pool.on('connect', (c) => { c.query('SET search_path TO app, public').catch(() => {}); });
      pools.push(pool);
      return new PgAsyncDatabase(pool);
    },
    async cleanup() { /* CSDL thử nghiệm riêng được giữ để soi lại; lần chạy sau tự dựng lại */ },
  };
}

// ------------------------------------------------------------------------------------------
// Hai process con thật: mỗi process mở kết nối riêng, chờ file "go", rồi giành quyền capture trên
// cùng danh sách request. Barrier là file — cả hai bắt đầu sau khi CẢ HAI đã báo sẵn sàng.
const CHILD_SCRIPT = `
  const fs = require('fs');
  const t = JSON.parse(process.env.PPS_TARGET);
  const ids = JSON.parse(process.env.PPS_IDS);
  const { SqliteAsyncDatabase, PgAsyncDatabase } = require('./src/lib/asyncDb');
  const { createPayPalPaymentStore } = require('./src/lib/paypalPaymentStore');
  let db;
  if (t.dialect === 'sqlite') {
    const Database = require('./src/lib/sqlite');
    const raw = new Database(t.file); raw.pragma('busy_timeout = 10000'); raw.pragma('foreign_keys = ON');
    db = new SqliteAsyncDatabase(raw);
  } else {
    const pg = require('pg');
    pg.types.setTypeParser(20, (v) => v === null ? null : Number(v));
    const pool = new pg.Pool({ connectionString: t.url, ssl: /sslmode=disable/.test(t.url) ? false : { rejectUnauthorized: false }, max: 2 });
    pool.on('connect', (c) => { c.query('SET search_path TO app, public').catch(() => {}); });
    db = new PgAsyncDatabase(pool);
  }
  const store = createPayPalPaymentStore({ db });
  (async () => {
    await db.prepare('SELECT 1 AS ok').get();
    fs.writeFileSync(process.env.PPS_READY, 'ready');
    while (!fs.existsSync(process.env.PPS_GO)) await new Promise((r) => setImmediate(r));
    const now = new Date().toISOString(); const cutoff = new Date(Date.now() - 60000).toISOString();
    // Đảo thứ tự ở process thứ hai để hai process tranh nhau từ hai đầu danh sách.
    const order = process.env.PPS_REVERSE === '1' ? ids.slice().reverse() : ids;
    const got = await Promise.all(order.map((id) => store.claimCapture(id, null, 'proc-' + process.pid + '-' + id, now, cutoff)));
    const byId = new Map(order.map((id, i) => [id, got[i].outcome]));
    const outcomes = ids.map((id) => byId.get(id));
    process.stdout.write(JSON.stringify({ pid: process.pid, outcomes }));
    await db.close();
  })().catch((e) => { process.stderr.write(String(e && e.stack || e)); process.exit(2); });
`;

function runTwoProcesses(target, ids) {
  const { spawn } = require('child_process');
  const dir = path.join(ROOT, 'data', 'test');
  const tag = `${Date.now()}-${crypto.randomUUID().slice(0, 6)}`;
  const go = path.join(dir, `pps-go-${tag}`);
  const spawnOne = (n) => {
    const ready = path.join(dir, `pps-ready-${tag}-${n}`);
    const child = spawn(process.execPath, ['-e', CHILD_SCRIPT], {
      cwd: ROOT,
      env: { ...process.env, PPS_TARGET: JSON.stringify(target), PPS_IDS: JSON.stringify(ids), PPS_READY: ready, PPS_GO: go,
        PPS_REVERSE: n === 2 ? '1' : '0' },
    });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const done = new Promise((resolve) => child.on('close', (code) => {
      let parsed = {};
      try { parsed = JSON.parse(out); } catch (_) { /* báo lỗi qua err */ }
      try { fs.unlinkSync(ready); } catch (_) { /* file tạm */ }
      resolve({ code, err: err.slice(0, 300), ...parsed });
    }));
    return { ready, done };
  };
  const a = spawnOne(1); const b = spawnOne(2);
  return (async () => {
    for (let i = 0; i < 3000 && !(fs.existsSync(a.ready) && fs.existsSync(b.ready)); i++) await new Promise((r) => setTimeout(r, 10));
    fs.writeFileSync(go, 'go');
    const res = await Promise.all([a.done, b.done]);
    try { fs.unlinkSync(go); } catch (_) { /* file tạm */ }
    return res;
  })();
}

// ------------------------------------------------------------------------------------------
async function runSuite(fx) {
  console.log(`\n=========== STORE PAYPAL — ${fx.dialect.toUpperCase()} ===========`);
  let dbA = fx.open();
  let dbB = fx.sharedConnection ? dbA : fx.open();
  let A = createPayPalPaymentStore({ db: dbA });
  let B = createPayPalPaymentStore({ db: dbB });

  const users = { owner: uid(), other: uid() };
  for (const [k, id] of Object.entries(users)) {
    await dbA.prepare(
      `INSERT INTO users (id, username, display_name, role, password_hash, account_status, token_version, created_at, updated_at)
       VALUES (?, ?, ?, 'BUYER', 'x', 'ACTIVE', 0, ?, ?)`
    ).run(id, `pps-${k}-${id.slice(0, 6)}`, k, iso(), iso());
  }

  const insertRequest = (db, { provider = 'PAYPAL_SANDBOX', amount = 100000, userId = users.owner } = {}) => {
    const id = uid();
    return db.prepare(
      `INSERT INTO payment_requests (id, user_id, amount, status, provider_ref, version, provider, created_at, updated_at)
       VALUES (?, ?, ?, 'PENDING', ?, 0, ?, ?, ?)`
    ).run(id, userId, amount, uid(), provider, iso(), iso()).then(() => id);
  };
  /** Request PayPal + báo giá trong CÙNG một transaction, đúng như route tạo nạp tiền phải làm. */
  const newPayPal = async ({ amount = 100000, userId = users.owner } = {}) => {
    let id;
    await dbA.transaction(async () => {
      id = await insertRequest(dbA, { amount, userId });
      await A.createBinding({ paymentRequestId: id, quote: quoteFor(amount), merchantId: MERCHANT, nowIso: iso() });
    })();
    return id;
  };
  const raw = (id) => dbA.prepare('SELECT * FROM paypal_payment_bindings WHERE payment_request_id = ?').get(id);
  const reqRow = (id) => dbA.prepare('SELECT status, provider FROM payment_requests WHERE id = ?').get(id);

  // =====================================================================================
  await group('P1: Tạo liên kết — báo giá bất biến, cô lập provider, tạo nguyên tử', async () => {
    const id = await newPayPal({ amount: 123456 });
    const row = await A.loadByRequestId(id);
    assert(row && row.provider === 'PAYPAL_SANDBOX' && row.paymentRequestId === id && row.userId === users.owner &&
      row.amountVnd === 123456 && row.status === 'PENDING' && row.orderId === null && row.createAttemptAt === null,
    'Dữ liệu tin cậy đúng hình dạng service yêu cầu');
    assert(JSON.stringify(row.quote) === JSON.stringify(quoteFor(123456)) && row.quote.usdValue === '4.94',
      `Báo giá đọc lại đúng nguyên vẹn (${row.quote.usdValue} USD cho 123.456đ ở 25.000đ/USD)`);
    assert(row.merchantId === MERCHANT && row.capture.state === 'READY', 'Snapshot merchant, capture READY');
    assert(!JSON.stringify(row).includes('capture_claim') && !('claim' in row.capture), 'Không lộ token claim ra ngoài store');

    const mockId = await insertRequest(dbA, { provider: 'MOCK' });
    assert((await A.loadByRequestId(mockId)) === null, 'Request MOCK: loadByRequestId trả null (cô lập provider)');
    assert(await rejects(() => A.createBinding({ paymentRequestId: mockId, quote: quoteFor(100000), merchantId: MERCHANT, nowIso: iso() })),
      'Không gắn được báo giá PayPal vào request MOCK (trigger)');
    const wrongAmt = await insertRequest(dbA, { amount: 200000 });
    assert(await rejects(() => A.createBinding({ paymentRequestId: wrongAmt, quote: quoteFor(100000), merchantId: MERCHANT, nowIso: iso() })),
      'Báo giá lệch số tiền của request bị từ chối (trigger)');
    const badQuote = { ...quoteFor(100000), usdCents: 399 };
    assert(!!(await rejectsWith(() => A.createBinding({ paymentRequestId: uid(), quote: badQuote, merchantId: MERCHANT, nowIso: iso() }), 'PAYPAL_INVALID_QUOTE')),
      'Báo giá tự mâu thuẫn (cent sai) bị từ chối trước khi chạm CSDL');
    assert(await rejects(() => dbA.prepare("UPDATE payment_requests SET provider = 'MOCK' WHERE id = ?").run(id)),
      'Không đổi được provider của request đã tạo (trigger)');

    let ghost;
    await dbA.transaction(async () => {
      ghost = await insertRequest(dbA, {});
      await A.createBinding({ paymentRequestId: ghost, quote: quoteFor(100000), merchantId: MERCHANT, nowIso: iso() });
      throw new Error('rollback có chủ đích');
    })().catch(() => {});
    assert(!(await reqRow(ghost)) && !(await raw(ghost)), 'Tạo request + báo giá là nguyên tử: lỗi giữa chừng không để lại gì');
  });

  // =====================================================================================
  let createId;
  await group('P2: claimCreateAttempt — timestamp lần đầu bền vững, không làm mới', async () => {
    createId = await newPayPal();
    const t1 = iso(-2000); const t2 = iso(-1000);
    const [ra, rb] = await Promise.all([A.claimCreateAttempt(createId, t1), B.claimCreateAttempt(createId, t2)]);
    const stored = (await raw(createId)).create_attempt_at;
    assert((stored === t1 || stored === t2) && ra.createAttemptAt === stored && rb.createAttemptAt === stored,
      `Hai tiến trình đồng thời cùng nhận đúng MỘT timestamp (${stored === t1 ? 't1' : 't2'})`);
    const again = await A.claimCreateAttempt(createId, iso());
    assert(again.createAttemptAt === stored, 'Retry sau đó không làm mới timestamp');
    assert(await rejects(() => dbA.prepare('UPDATE paypal_payment_bindings SET create_attempt_at = ? WHERE payment_request_id = ?').run(iso(), createId)),
      'Ghi đè trực tiếp timestamp đã có bị CSDL chặn');
    assert(again.paymentRequestId === createId && again.userId === users.owner && JSON.stringify(again.quote) === JSON.stringify(quoteFor(100000)),
      'claimCreateAttempt trả đúng request/chủ sở hữu/báo giá ban đầu');
  });

  // =====================================================================================
  await group('P3: bindOrder — order duy nhất, replay idempotent, không tráo order', async () => {
    const x = await newPayPal(); const y = await newPayPal();
    const [b1, b2] = await Promise.all([A.bindOrder(x, 'ORDER-X1'), B.bindOrder(x, 'ORDER-X2')]);
    const bound = (await raw(x)).order_id;
    assert((b1 !== b2) && ((b1 && bound === 'ORDER-X1') || (b2 && bound === 'ORDER-X2')),
      `Hai order khác nhau đồng thời: đúng một thắng, CSDL giữ order của bên thắng (${bound})`);
    assert(await A.bindOrder(x, bound) === true, 'Gắn lại CÙNG order: true (replay)');
    const loser = bound === 'ORDER-X1' ? 'ORDER-X2' : 'ORDER-X1';
    assert(await A.bindOrder(x, loser) === false, 'Gắn order khác sau khi đã gắn: false');
    assert(await B.bindOrder(y, bound) === false && (await raw(y)).order_id === null,
      'Order đã thuộc request khác: false, request kia vẫn chưa gắn (UNIQUE)');
    const viaOrder = await A.loadByOrderId(bound);
    assert(viaOrder && viaOrder.paymentRequestId === x && viaOrder.orderId === bound, 'loadByOrderId tìm đúng request');
    assert((await A.loadByOrderId('ORDER-KHONG-CO')) === null, 'Order lạ: null');
    const mockId = await insertRequest(dbA, { provider: 'MOCK' });
    assert(await A.bindOrder(mockId, 'ORDER-MOCK') === false, 'Không gắn order PayPal vào request MOCK');
    assert(await rejects(() => dbA.prepare('UPDATE paypal_payment_bindings SET order_id = ? WHERE payment_request_id = ?').run('ORDER-TRAO', x)),
      'Đổi order đã gắn bằng UPDATE trực tiếp bị CSDL chặn');
    assert(await rejects(() => dbA.prepare("UPDATE paypal_payment_bindings SET quote_json = '{}' WHERE payment_request_id = ?").run(x)),
      'Sửa báo giá bằng UPDATE trực tiếp bị CSDL chặn');
    const okOuter = await dbA.transaction(async () => {
      const r = await A.bindOrder(y, bound);
      await dbA.prepare('SELECT 1 AS ok FROM paypal_payment_bindings WHERE payment_request_id = ?').get(y);
      return r;
    })().then((r) => r === false).catch(() => false);
    assert(okOuter, 'Vi phạm UNIQUE trong bindOrder không làm hỏng transaction bao ngoài (savepoint)');
    const afterBind = await A.claimCreateAttempt(createId, iso());
    assert(afterBind.createAttemptAt !== null, 'claimCreateAttempt vẫn đọc được sau các lần gắn');
  });

  // =====================================================================================
  await group('P4: claimCapture — chủ sở hữu, trạng thái, một người giữ quyền', async () => {
    const id = await newPayPal();
    assert((await A.claimCapture(id, users.owner, uid(), iso(), iso(-60000))).outcome === 'NOT_READY', 'Chưa gắn order: NOT_READY');
    await A.bindOrder(id, `ORD-${id}`);
    assert((await A.claimCapture(id, users.other, uid(), iso(), iso(-60000))).outcome === 'FORBIDDEN', 'Người khác: FORBIDDEN');
    const mockId = await insertRequest(dbA, { provider: 'MOCK' });
    assert((await A.claimCapture(mockId, users.owner, uid(), iso(), iso(-60000))).outcome === 'NOT_FOUND', 'Request MOCK: NOT_FOUND');

    const now = iso(); const cutoff = iso(-60000);
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) =>
      (i % 2 ? B : A).claimCapture(id, users.owner, `claim-${i}`, now, cutoff)));
    const outcomes = results.map((r) => r.outcome);
    console.log(`  [P4] ${outcomes.join(' ')}`);
    assert(outcomes.filter((o) => o === 'CLAIMED').length === 1 && outcomes.filter((o) => o === 'BUSY').length === 5,
      'Sáu lượt đồng thời trên hai tiến trình: đúng 1 CLAIMED, 5 BUSY');
    const r1 = await raw(id);
    assert(r1.capture_state === 'IN_FLIGHT' && Number(r1.capture_attempts) === 1, 'IN_FLIGHT, capture_attempts = 1');
    const holder = results.findIndex((r) => r.outcome === 'CLAIMED');
    assert((await A.finishCaptureAttempt(id, `claim-${holder}`, { state: 'READY', errorCode: 'ORDER_NOT_APPROVED' })).ok,
      'Người giữ quyền nhả với READY (người mua chưa phê duyệt)');
    const again = await A.claimCapture(id, users.owner, uid(), iso(), iso(-60000));
    assert(again.outcome === 'CLAIMED' && again.mustVerifyFirst === false, 'Sau READY: giành lại được, không cần GET trước');

    const done = await newPayPal(); await A.bindOrder(done, `ORD-${done}`);
    await dbA.prepare("UPDATE payment_requests SET status = 'SUCCEEDED' WHERE id = ?").run(done);
    assert((await A.claimCapture(done, users.owner, uid(), iso(), iso(-60000))).outcome === 'REPLAY', 'Request SUCCEEDED: REPLAY');
    const closed = await newPayPal(); await A.bindOrder(closed, `ORD-${closed}`);
    await dbA.prepare("UPDATE payment_requests SET status = 'FAILED' WHERE id = ?").run(closed);
    assert((await A.claimCapture(closed, users.owner, uid(), iso(), iso(-60000))).outcome === 'CLOSED', 'Request FAILED: CLOSED');
  });

  // =====================================================================================
  await group('P5: Người giữ quyền cũ (lease hết hạn) không ghi đè người mới; timeout -> UNKNOWN', async () => {
    const id = await newPayPal(); await A.bindOrder(id, `ORD-${id}`);
    const tA = iso(-120000);
    const a = await A.claimCapture(id, users.owner, 'holder-A', tA, iso(-600000));
    assert(a.outcome === 'CLAIMED', 'A giành quyền');
    // A đã gửi POST capture rồi im lặng (hợp đồng: ghi dấu ngay trước khi POST).
    if (typeof A.markCapturePostSent === 'function') await A.markCapturePostSent(id, 'holder-A', tA);
    // B đến khi lease của A đã quá hạn (cutoff sau thời điểm A claim).
    const b = await B.claimCapture(id, null, 'holder-B', iso(), iso(-60000));
    assert(b.outcome === 'CLAIMED' && b.mustVerifyFirst === true && b.previousState === 'IN_FLIGHT',
      'B giành quyền đã hết hạn, được yêu cầu GET trước (không biết A đã thu tiền chưa)');
    const lateA = await A.finishCaptureAttempt(id, 'holder-A', { state: 'VERIFIED', captureId: 'CAP-A' });
    const mid = await raw(id);
    assert(!lateA.ok && lateA.reason === 'STALE_CLAIM' && mid.capture_claim === 'holder-B' && mid.capture_id === null,
      'A trả kết quả muộn: STALE_CLAIM, không ghi đè quyền/kết quả của B');
    assert((await B.finishCaptureAttempt(id, 'holder-B', { state: 'UNKNOWN', errorCode: 'TIMEOUT' })).ok, 'B timeout: ghi UNKNOWN');
    const afterTimeout = await raw(id);
    assert(afterTimeout.capture_state === 'UNKNOWN' && afterTimeout.capture_claim === null && (await reqRow(id)).status === 'PENDING',
      'UNKNOWN: nhả quyền, request vẫn PENDING (không đoán thất bại)');
    const c = await A.claimCapture(id, null, 'holder-C', iso(), iso(-60000));
    assert(c.outcome === 'CLAIMED' && c.mustVerifyFirst === true && c.previousState === 'UNKNOWN', 'Sau UNKNOWN: lượt tiếp phải GET trước');
    assert((await A.finishCaptureAttempt(id, 'holder-C', { state: 'VERIFIED', captureId: `CAP-${id}` })).ok, 'C xác minh: VERIFIED');
    assert(!(await B.finishCaptureAttempt(id, 'holder-B', { state: 'READY' })).ok, 'B ghi lần nữa sau đó: STALE_CLAIM');
    const fin = await raw(id);
    assert(fin.capture_state === 'VERIFIED' && fin.capture_id === `CAP-${id}` && Number(fin.capture_attempts) === 3,
      `Kết quả cuối VERIFIED với capture của C, ba lượt giành quyền (thực tế ${fin.capture_attempts})`);
    assert(await rejects(() => dbA.prepare("UPDATE paypal_payment_bindings SET capture_state = 'READY' WHERE payment_request_id = ?").run(id)),
      'VERIFIED không quay về READY bằng UPDATE trực tiếp');
  });

  // =====================================================================================
  await group('P6: Webhook xác minh trong lúc có người đang capture; capture ID duy nhất', async () => {
    const id = await newPayPal(); await A.bindOrder(id, `ORD-${id}`);
    const h = await A.claimCapture(id, users.owner, 'holder-W', iso(), iso(-60000));
    assert(h.outcome === 'CLAIMED', 'Có người đang giữ quyền capture');
    assert((await B.markCaptureVerified(id, `CAPW-${id}`)).ok, 'Webhook (đã xác minh) ghi VERIFIED, xoá quyền đang giữ');
    assert(!(await A.finishCaptureAttempt(id, 'holder-W', { state: 'UNKNOWN' })).ok, 'Người giữ quyền ghi sau đó: STALE_CLAIM');
    assert((await raw(id)).capture_state === 'VERIFIED', 'Trạng thái vẫn VERIFIED');
    assert((await B.markCaptureVerified(id, `CAPW-${id}`)).ok, 'Webhook lặp cùng capture ID: idempotent');
    const conflict = await B.markCaptureVerified(id, 'CAP-KHAC');
    assert(!conflict.ok && conflict.reason === 'CAPTURE_ID_CONFLICT', 'Capture ID khác: CAPTURE_ID_CONFLICT');
    assert((await A.claimCapture(id, users.owner, uid(), iso(), iso(-60000))).outcome === 'REPLAY', 'Sau VERIFIED: claim trả REPLAY');
    const z = await newPayPal(); await A.bindOrder(z, `ORD-${z}`);
    const dup = await A.markCaptureVerified(z, `CAPW-${id}`);
    assert(!dup.ok && dup.reason === 'CAPTURE_ID_CONFLICT', 'Một capture ID không gắn được cho hai request (UNIQUE)');
    const unbound = await newPayPal();
    assert((await A.markCaptureVerified(unbound, 'CAP-UNBOUND')).reason === 'NOT_READY', 'Request chưa gắn order: NOT_READY');
  });

  // =====================================================================================
  await group('P7: Đóng hết hạn và capture không thể cùng thắng', async () => {
    const a = await newPayPal(); await A.bindOrder(a, `ORD-${a}`);
    await A.claimCapture(a, users.owner, 'holder-x', iso(), iso(-60000));
    const ca = await B.closeUncaptured(a, { nowIso: iso(), reason: 'ORDER_EXPIRED' });
    assert(!ca.closed && ca.reason === 'CAPTURE_IN_FLIGHT' && (await reqRow(a)).status === 'PENDING',
      'Capture trước, đóng sau: từ chối đóng, request vẫn PENDING');
    const b = await newPayPal(); await A.bindOrder(b, `ORD-${b}`);
    assert((await B.closeUncaptured(b, { nowIso: iso(), reason: 'ORDER_EXPIRED' })).closed, 'Đóng trước (chưa ai capture): đóng được');
    assert((await A.claimCapture(b, users.owner, uid(), iso(), iso(-60000))).outcome === 'CLOSED', 'Capture sau khi đóng: CLOSED');
    const c = await newPayPal(); await A.bindOrder(c, `ORD-${c}`);
    await A.claimCapture(c, null, 'holder-u', iso(), iso(-60000));
    await A.finishCaptureAttempt(c, 'holder-u', { state: 'UNKNOWN', errorCode: 'TIMEOUT' });
    const cc = await B.closeUncaptured(c, { nowIso: iso(), reason: 'ORDER_EXPIRED' });
    assert(!cc.closed && cc.reason === 'CAPTURE_UNKNOWN', 'Capture UNKNOWN (timeout): không được đóng FAILED — cần đối soát');

    const ids = [];
    for (let i = 0; i < 6; i++) { const id = await newPayPal(); await A.bindOrder(id, `ORD-${id}`); ids.push(id); }
    const races = await Promise.all(ids.map((id, i) => Promise.all([
      (i % 2 ? A : B).claimCapture(id, users.owner, `race-${i}`, iso(), iso(-60000)),
      (i % 2 ? B : A).closeUncaptured(id, { nowIso: iso(), reason: 'ORDER_EXPIRED' }),
    ])));
    let consistent = true; const tally = [];
    for (let i = 0; i < ids.length; i++) {
      const [claim, close] = races[i];
      const won = (claim.outcome === 'CLAIMED') + (close.closed ? 1 : 0);
      const st = await reqRow(ids[i]); const bd = await raw(ids[i]);
      tally.push(claim.outcome === 'CLAIMED' ? 'capture' : 'đóng');
      if (won !== 1 || (st.status === 'FAILED' && bd.capture_state !== 'READY') ||
          (claim.outcome === 'CLAIMED' && st.status !== 'PENDING')) consistent = false;
    }
    console.log(`  [P7] bên thắng: ${tally.join(', ')}`);
    assert(consistent, 'Sáu cuộc đua đồng thời: mỗi request đúng một bên thắng, không có FAILED kèm capture dở');
  });

  // =====================================================================================
  await group('P8: VERIFIED ghi cùng transaction với bước ghi ví (mô phỏng)', async () => {
    const id = await newPayPal(); await A.bindOrder(id, `ORD-${id}`);
    await A.claimCapture(id, users.owner, 'holder-s', iso(), iso(-60000));
    // Mô phỏng tất toán: đổi status trong cùng transaction rồi lỗi trước commit.
    await dbA.transaction(async () => {
      await dbA.prepare("UPDATE payment_requests SET status = 'SUCCEEDED' WHERE id = ? AND status = 'PENDING'").run(id);
      const f = await A.finishCaptureAttempt(id, 'holder-s', { state: 'VERIFIED', captureId: `CAPS-${id}` });
      if (!f.ok) throw new Error('mất quyền');
      throw new Error('lỗi sau khi ghi ví, trước commit');
    })().catch(() => {});
    const rb = await raw(id);
    assert((await reqRow(id)).status === 'PENDING' && rb.capture_state === 'IN_FLIGHT' && rb.capture_claim === 'holder-s' && rb.capture_id === null,
      'Lỗi trước commit: ví/request VÀ capture cùng rollback, người giữ quyền vẫn giữ để thử lại');
    await dbA.transaction(async () => {
      await dbA.prepare("UPDATE payment_requests SET status = 'SUCCEEDED' WHERE id = ? AND status = 'PENDING'").run(id);
      const f = await A.finishCaptureAttempt(id, 'holder-s', { state: 'VERIFIED', captureId: `CAPS-${id}` });
      if (!f.ok) throw new Error('mất quyền');
    })();
    const ok = await raw(id);
    assert((await reqRow(id)).status === 'SUCCEEDED' && ok.capture_state === 'VERIFIED' && ok.capture_id === `CAPS-${id}`,
      'Commit: SUCCEEDED và VERIFIED cùng có hiệu lực');

    const stale = await newPayPal(); await A.bindOrder(stale, `ORD-${stale}`);
    await A.claimCapture(stale, null, 'old', iso(-120000), iso(-600000));
    await B.claimCapture(stale, null, 'new', iso(), iso(-60000));
    const lost = await dbA.transaction(async () => {
      await dbA.prepare("UPDATE payment_requests SET status = 'SUCCEEDED' WHERE id = ? AND status = 'PENDING'").run(stale);
      const f = await A.finishCaptureAttempt(stale, 'old', { state: 'VERIFIED', captureId: `CAPO-${stale}` });
      if (!f.ok) throw new Error('mất quyền');
    })().then(() => false).catch(() => true);
    assert(lost && (await reqRow(stale)).status === 'PENDING', 'Người giữ quyền cũ: finish báo mất quyền, credit rollback theo');
  });

  // Một "PayPal" giả trong test: POST capture là một promise chỉ hoàn tất khi test cho phép (barrier),
  // GET trả trạng thái do test quyết định. Không có sleep ngẫu nhiên.
  const deferred = () => { let resolve; const p = new Promise((r) => { resolve = r; }); return { p, resolve }; };
  const hasPostMarker = typeof A.markCapturePostSent === 'function';

  // =====================================================================================
  await group('K1: POST của A treo, lease hết, B GET thấy PENDING -> không được đóng; POST A thành công muộn vẫn được ghi nhận', async () => {
    const id = await newPayPal(); await A.bindOrder(id, `ORD-${id}`);
    const a = await A.claimCapture(id, users.owner, 'holder-A', iso(-120000), iso(-600000));
    assert(a.outcome === 'CLAIMED', 'A giành quyền');
    if (hasPostMarker) assert((await A.markCapturePostSent(id, 'holder-A', iso(-119000))).ok, 'A ghi dấu đã gửi POST capture');
    const postA = deferred();                                  // POST của A đang treo trên mạng
    const aFlight = postA.p.then(async (resp) => {
      const fin = await A.finishCaptureAttempt(id, 'holder-A', { state: 'VERIFIED', captureId: resp.captureId });
      const mark = fin.ok ? fin : await A.markCaptureVerified(id, resp.captureId);
      return { fin, mark };
    });

    const b = await B.claimCapture(id, null, 'holder-B', iso(), iso(-60000));   // lease của A đã hết hạn
    assert(b.outcome === 'CLAIMED' && b.mustVerifyFirst === true, 'B tiếp quản và được yêu cầu GET trước');
    // B GET order -> PayPal vẫn báo APPROVED/PENDING. Đó KHÔNG phải bằng chứng chưa thu tiền.
    const bReady = await B.finishCaptureAttempt(id, 'holder-B', { state: 'READY' });
    assert(!bReady.ok && bReady.reason === 'CAPTURE_OUTCOME_UNRESOLVED',
      `B không được đưa về READY chỉ vì GET thấy PENDING (nhận ${JSON.stringify(bReady)})`);
    if (!bReady.ok) await B.finishCaptureAttempt(id, 'holder-B', { state: 'UNKNOWN', errorCode: 'POST_OUTCOME_UNKNOWN' });
    const close = await B.closeUncaptured(id, { nowIso: iso(), reason: 'ORDER_EXPIRED' });
    assert(!close.closed && (await reqRow(id)).status === 'PENDING', `Đóng hết hạn không thắng (nhận ${JSON.stringify(close)})`);

    postA.resolve({ captureId: `CAP-LATE-${id}` });            // POST của A hoàn tất muộn: PayPal ĐÃ thu tiền
    const { fin, mark } = await aFlight;
    assert(!fin.ok && fin.reason === 'STALE_CLAIM', 'Token A đã hết hiệu lực: finish của A không ghi đè');
    assert(mark.ok === true, `Bằng chứng thu tiền của A vẫn được ghi nhận qua markCaptureVerified (nhận ${JSON.stringify(mark)})`);
    const fr = await raw(id);
    assert(fr.capture_state === 'VERIFIED' && fr.capture_id === `CAP-LATE-${id}` && (await reqRow(id)).status === 'PENDING',
      'Kết quả: VERIFIED với capture của A, request PENDING chờ settlement (không FAILED)');
  });

  await group('K2: Bằng chứng muộn đến khi B vẫn đang giữ quyền -> ghi nhận, B ghi sau bị từ chối', async () => {
    const id = await newPayPal(); await A.bindOrder(id, `ORD-${id}`);
    await A.claimCapture(id, users.owner, 'holder-A', iso(-120000), iso(-600000));
    if (hasPostMarker) await A.markCapturePostSent(id, 'holder-A', iso(-119000));
    const b = await B.claimCapture(id, null, 'holder-B', iso(), iso(-60000));
    assert(b.outcome === 'CLAIMED', 'B đang giữ quyền');
    const finA = await A.finishCaptureAttempt(id, 'holder-A', { state: 'VERIFIED', captureId: `CAPA-${id}` });
    assert(!finA.ok && (await raw(id)).capture_claim === 'holder-B', 'finish của A không ghi đè token của B');
    assert((await A.markCaptureVerified(id, `CAPA-${id}`)).ok, 'Bằng chứng của A ghi nhận được');
    const finB = await B.finishCaptureAttempt(id, 'holder-B', { state: 'UNKNOWN' });
    assert(!finB.ok && (await raw(id)).capture_state === 'VERIFIED', 'B ghi UNKNOWN sau đó: bị từ chối, VERIFIED giữ nguyên');
  });

  await group('K3: Thu tiền muộn trên request đã FAILED -> RECOVERY_REQUIRED, giữ bằng chứng, không mở lại', async () => {
    const id = await newPayPal(); await A.bindOrder(id, `ORD-${id}`);
    assert((await A.closeUncaptured(id, { nowIso: iso(), reason: 'ORDER_EXPIRED' })).closed, 'Request đóng FAILED (chưa từng capture)');
    const late = await A.markCaptureVerified(id, `CAPF-${id}`);
    assert(late.ok === false && late.outcome === 'RECOVERY_REQUIRED', `Không báo thành công giả: RECOVERY_REQUIRED (nhận ${JSON.stringify(late)})`);
    const r1 = await raw(id);
    assert(r1.capture_id === `CAPF-${id}` && r1.capture_state === 'RECOVERY_REQUIRED', 'Capture ID được lưu bền làm bằng chứng');
    assert((await reqRow(id)).status === 'FAILED', 'Request vẫn FAILED: store không tự mở lại hay ghi ví');
    const again = await B.markCaptureVerified(id, `CAPF-${id}`);
    assert(again.ok === false && again.outcome === 'RECOVERY_REQUIRED', 'Replay cùng capture: vẫn RECOVERY_REQUIRED (idempotent)');
    const other = await B.markCaptureVerified(id, `CAPF2-${id}`);
    assert(other.ok === false && other.reason === 'CAPTURE_ID_CONFLICT' && (await raw(id)).capture_id === `CAPF-${id}`,
      'Capture khác: CAPTURE_ID_CONFLICT, bằng chứng đầu giữ nguyên');
    assert(/CAPF2-/.test((await raw(id)).last_capture_error || ''), 'Capture xung đột cũng được ghi lại để đối soát');
    const cl = await A.claimCapture(id, users.owner, uid(), iso(), iso(-60000));
    assert(cl.outcome === 'RECOVERY_REQUIRED', `claimCapture trên request cần phục hồi: RECOVERY_REQUIRED (nhận ${cl.outcome})`);

    const p = await newPayPal(); await A.bindOrder(p, `ORD-${p}`);
    assert((await A.markCaptureVerified(p, `CAPP-${p}`)).ok === true, 'Request PENDING bình thường: VERIFIED như cũ');

    // Holder đang capture thì request bị đóng bởi một đường khác (lỗi ở nơi khác): finish VERIFIED -> cần phục hồi.
    const q = await newPayPal(); await A.bindOrder(q, `ORD-${q}`);
    await A.claimCapture(q, users.owner, 'holder-Q', iso(), iso(-60000));
    if (hasPostMarker) await A.markCapturePostSent(q, 'holder-Q', iso());
    await dbA.prepare("UPDATE payment_requests SET status = 'FAILED' WHERE id = ?").run(q);
    const fq = await A.finishCaptureAttempt(q, 'holder-Q', { state: 'VERIFIED', captureId: `CAPQ-${q}` });
    const rq = await raw(q);
    assert(fq.ok === false && fq.reason === 'RECOVERY_REQUIRED' && rq.capture_id === `CAPQ-${q}` && rq.capture_state === 'RECOVERY_REQUIRED',
      `finish VERIFIED trên request đã FAILED: RECOVERY_REQUIRED, giữ bằng chứng (nhận ${JSON.stringify(fq)})`);
  });

  await group('K4: Kết thúc không thu tiền chỉ với bằng chứng mạnh; chưa từng POST thì READY hợp lệ', async () => {
    if (!hasPostMarker) { assert(false, 'Bản cũ không phân biệt chưa gửi POST / đã gửi POST'); return; }
    const id = await newPayPal(); await A.bindOrder(id, `ORD-${id}`);
    await A.claimCapture(id, users.owner, 'h1', iso(), iso(-60000));
    await A.markCapturePostSent(id, 'h1', iso());
    assert(!!(await rejectsWith(() => A.finishCaptureAttempt(id, 'h1', { state: 'NOT_CAPTURED', evidence: 'ORDER_APPROVED' }), 'VALIDATION_ERROR')),
      'APPROVED không phải bằng chứng kết thúc: bị từ chối');
    assert((await A.finishCaptureAttempt(id, 'h1', { state: 'NOT_CAPTURED', evidence: 'ORDER_VOIDED' })).ok, 'Order VOIDED: NOT_CAPTURED');
    assert((await B.closeUncaptured(id, { nowIso: iso(), reason: 'ORDER_VOIDED' })).closed, 'Sau NOT_CAPTURED: đóng được');

    const n = await newPayPal(); await A.bindOrder(n, `ORD-${n}`);
    await A.claimCapture(n, users.owner, 'dead', iso(-120000), iso(-600000));   // giữ quyền rồi chết TRƯỚC khi POST
    const t = await B.claimCapture(n, null, 'next', iso(), iso(-60000));
    assert(t.outcome === 'CLAIMED' && t.mustVerifyFirst === false, 'Người trước chưa từng POST: không bắt buộc GET trước');
    assert((await B.finishCaptureAttempt(n, 'next', { state: 'READY' })).ok, 'Chưa từng POST: nhả về READY hợp lệ');
    assert((await B.closeUncaptured(n, { nowIso: iso(), reason: 'ORDER_EXPIRED' })).closed, 'Chưa từng POST: đóng được');
    assert(await rejects(() => dbA.prepare('UPDATE paypal_payment_bindings SET capture_post_sent_at = NULL WHERE payment_request_id = ?').run(id)),
      'Dấu đã gửi POST không xoá được bằng UPDATE trực tiếp');
  });

  // =====================================================================================
  await group('K5: HAI process Node thật cùng giành quyền capture (barrier bằng file)', async () => {
    const ids = [];
    for (let i = 0; i < 5; i++) { const id = await newPayPal(); await A.bindOrder(id, `ORD-${id}`); ids.push(id); }
    const results = await runTwoProcesses(fx.childTarget, ids);
    const ok = results.every((r) => r.code === 0 && Array.isArray(r.outcomes));
    assert(ok, `Hai process con chạy xong (exit ${results.map((r) => r.code).join('/')})${ok ? '' : ' ' + results.map((r) => r.err).join(' | ')}`);
    if (!ok) return;
    let exactlyOne = true;
    for (let i = 0; i < ids.length; i++) {
      const outs = [results[0].outcomes[i], results[1].outcomes[i]];
      if (outs.filter((o) => o === 'CLAIMED').length !== 1 || outs.filter((o) => o === 'BUSY').length !== 1) exactlyOne = false;
    }
    console.log(`  [K5] pid ${results[0].pid}: ${results[0].outcomes.join(' ')} | pid ${results[1].pid}: ${results[1].outcomes.join(' ')}`);
    assert(results[0].pid !== results[1].pid && exactlyOne, 'Mỗi request: đúng một process CLAIMED, process kia BUSY');
    const attempts = await Promise.all(ids.map(async (id) => Number((await raw(id)).capture_attempts)));
    assert(attempts.every((n) => n === 1), `capture_attempts = 1 cho mọi request (thực tế ${attempts.join(',')})`);
  });

  // =====================================================================================
  await group('P9: Khởi động lại — báo giá, order, timestamp, trạng thái capture giữ nguyên', async () => {
    const before = await A.loadByRequestId(createId);
    await dbA.close(); if (dbB !== dbA) await dbB.close();
    dbA = fx.open(); dbB = fx.sharedConnection ? dbA : fx.open();
    A = createPayPalPaymentStore({ db: dbA }); B = createPayPalPaymentStore({ db: dbB });
    const after = await B.loadByRequestId(createId);
    assert(JSON.stringify(after) === JSON.stringify(before), 'Đọc lại sau khởi động: giống hệt trước khi tắt');
    const retry = await B.claimCreateAttempt(createId, iso(5000));
    assert(retry.createAttemptAt === before.createAttemptAt, 'Retry create sau khởi động không làm mới timestamp');
  });

  await dbA.close(); if (dbB !== dbA) await dbB.close();
}

async function main() {
  const pgArg = process.argv.find((a) => a.startsWith('--pg='));
  const fixtures = [await sqliteFixture()];
  if (pgArg) fixtures.push(await pgFixture(pgArg.slice('--pg='.length)));
  for (const fx of fixtures) {
    const before = { passes, failures };
    await runSuite(fx);
    console.log(`\n  [${fx.dialect}] ${passes - before.passes} đạt, ${failures - before.failures} hỏng`);
    await fx.cleanup();
  }
  if (!pgArg) console.log('\n  (PostgreSQL chưa chạy: thêm --pg=<url CSDL _store_test riêng>)');
  console.log(failures ? `\n${failures} FAIL` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error('[paypal-store] lỗi:', e); process.exit(1); });
