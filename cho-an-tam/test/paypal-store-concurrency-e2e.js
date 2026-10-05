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
 * Mỗi nền dùng HAI kết nối độc lập (hai SqliteAsyncDatabase trên cùng file / hai pool PostgreSQL) để
 * mô phỏng hai tiến trình backend. Thứ tự các bước được điều khiển tường minh (barrier): bước mạng tới
 * PayPal được thay bằng khoảng giữa claim và finish.
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
