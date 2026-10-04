/**
 * Nguồn gốc quyền ADMIN và đường leo thang đặc quyền (nhánh claude/admin-provenance).
 *
 * PR #13 chặn tài khoản BUYER/SELLER bị nâng role bằng dấu hiệu "có ví USER". Dấu hiệu đó không
 * bao được tài khoản CHƯA có ví: một tài khoản mua mới đăng ký (PENDING_PASSKEY) bị sửa
 * role='ADMIN' rồi hoàn tất Passkey thì bước kích hoạt BỎ QUA việc mở ví (vì role=ADMIN), và tài
 * khoản đó thành "quản trị viên" không ví, lọt qua mọi kiểm tra. Bộ này kiểm một dấu hiệu nguồn
 * gốc riêng (bảng admin_provenance) độc lập với cả role lẫn ví:
 *
 *   G0  không có API nào biến người mua/bán thành ADMIN (đăng ký kèm role/isAdmin/accountStatus
 *       bị bỏ qua; duyệt bán hàng chỉ BUYER -> SELLER)
 *   G1  admin bootstrap hợp lệ vẫn hoạt động, có dấu nguồn gốc BOOTSTRAP_CLI
 *   G2  ràng buộc ở CSDL: UPDATE role -> 'ADMIN' bị từ chối; không gắn được dấu nguồn gốc cho tài
 *       khoản không phải admin bootstrap mới; dấu nguồn gốc không sửa được
 *   G3  tài khoản ACTIVE bị sửa role='ADMIN' (vượt trigger) mà KHÔNG có ví: mọi API quản trị 403
 *       ADMIN_IDENTITY_INVALID; các lối đọc ngoài /api/admin (danh sách đơn, chi tiết đơn, nhật ký,
 *       việc cần làm) không mở rộng theo role giả
 *   G4  tài khoản ACTIVE CÓ ví bị sửa role='ADMIN': vẫn 403 ở mọi API quản trị
 *   G5  tài khoản PENDING_PASSKEY bị sửa role='ADMIN': không kích hoạt được (403), không credential
 *   G6  CSDL riêng (không đụng CSDL test chung): bootstrap qua biến môi trường gắn BOOTSTRAP_ENV;
 *       CSDL "cũ" chưa có bảng nguồn gốc được backfill ĐÚNG MỘT LẦN, chỉ cho ADMIN không có ví;
 *       ADMIN chèn sau migration không được backfill
 *   9 bất biến.
 *
 * Yêu cầu: server test đang chạy (`npm run start:test`). G6 tự spawn server con trên CSDL riêng
 * (SQLite: file tạm trong data/test; PostgreSQL: cơ sở dữ liệu enclave_prov_test cạnh enclave_test).
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { flows, createSeller } = require('./helpers/accounts');
const { createAuthenticator } = require('./softwareAuthenticator');
const { DEFAULT_PASSWORD } = require('./helpers/hybrid');
const { checkInvariants } = require('../src/lib/invariants');
const { db, DIALECT, uuid, nowIso } = require('../src/db');
const { hashPassword } = require('../src/lib/password');
// Vượt trigger chặn nâng quyền để dựng kịch bản xấu nhất mà lớp kiểm tra lúc chạy phải tự đứng vững.
const { forceRole } = require('./helpers/tamper');

const ROOT = path.join(__dirname, '..');
const BASE = process.env.BASE_URL || 'http://localhost:3100';
const RP_ID = process.env.WEBAUTHN_RP_ID || 'localhost';
const ORIGIN = process.env.WEBAUTHN_ORIGIN || BASE;
const CHILD_PORT = 3183;

let failures = 0;
function assert(cond, label) {
  console.log(`  ${cond ? '✅' : '❌'} ${label}`);
  if (!cond) failures++;
}
function section(title) { console.log(`\n${title}`); }
async function group(title, fn) {
  section(title);
  try {
    await fn();
  } catch (e) {
    assert(false, `Nhóm dừng giữa chừng vì lỗi: ${e.message}`);
  }
}

async function api(p, opts = {}, retried = false) {
  const { method = 'GET', body, token, base = BASE } = opts;
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(base + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let data = {};
  try { data = await res.json(); } catch (_) {}
  if (res.status === 429 && !retried) {
    console.log('  ⏳ Chạm rate limit — chờ 60 giây rồi thử lại…');
    await new Promise((r) => setTimeout(r, 61000));
    return api(p, opts, true);
  }
  return { status: res.status, data };
}

const uniq = (p) => `${p}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 4)}`;
const roleOf = async (id) => (await db.prepare('SELECT role FROM users WHERE id = ?').get(id)).role;


async function tableExists(name) {
  if (DIALECT === 'pg') {
    return !!(await db.prepare("SELECT 1 FROM information_schema.tables WHERE table_schema = 'app' AND table_name = ?").get(name));
  }
  return !!(await db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

async function provenanceOf(userId) {
  if (!(await tableExists('admin_provenance'))) return undefined;
  return db.prepare('SELECT * FROM admin_provenance WHERE user_id = ?').get(userId);
}

async function rejects(fn) {
  try { await fn(); return false; } catch (_) { return true; }
}

/** Mọi API quản trị, kèm các đối tượng thật để không route nào trả 404 vì thiếu dữ liệu. */
function adminEndpoints({ disputeId, txnId, sellerRequestId }) {
  return [
    ['GET', '/api/admin/disputes'],
    ['GET', `/api/admin/disputes/${disputeId}`],
    ['POST', `/api/admin/disputes/${disputeId}/reauth/options`, { decision: 'REFUND' }],
    ['POST', `/api/admin/disputes/${disputeId}/reauth/verify`, { reauthSessionId: 'x', response: { id: 'x' } }],
    ['POST', `/api/admin/disputes/${disputeId}/refund`, { requestId: crypto.randomUUID(), reauthGrant: 'x' }],
    ['POST', `/api/admin/disputes/${disputeId}/release`, { requestId: crypto.randomUUID(), reauthGrant: 'x' }],
    ['GET', '/api/admin/seller-requests'],
    ['POST', `/api/admin/seller-requests/${sellerRequestId}/approve`, {}],
    ['POST', `/api/admin/seller-requests/${sellerRequestId}/reject`, { reason: 'x' }],
    ['GET', '/api/admin/users'],
    ['GET', `/api/admin/transactions/${txnId}/logs`],
    ['GET', `/api/admin/transactions/${txnId}/logs/verify`],
    ['GET', '/api/admin/invariants'],
    ['GET', '/api/admin/security-events'],
  ];
}

async function assertAllAdminDenied(label, token, ctx) {
  const results = [];
  for (const [method, p, body] of adminEndpoints(ctx)) {
    const r = await api(p, { method, token, body });
    results.push(`${method} ${p.replace(/[0-9a-f-]{36}/g, ':id')} -> ${r.status} ${r.data.error || ''}`);
    assert(r.status === 403 && r.data.error === 'ADMIN_IDENTITY_INVALID',
      `${label}: ${method} ${p.replace(/[0-9a-f-]{36}/g, ':id')} bị 403 ADMIN_IDENTITY_INVALID (nhận ${r.status} ${r.data.error || ''})`);
  }
  const sr = await db.prepare('SELECT status FROM seller_requests WHERE id = ?').get(ctx.sellerRequestId);
  assert(sr.status === 'PENDING', `${label}: yêu cầu bán hàng vẫn PENDING (không bị duyệt/từ chối hộ)`);
  const d = await db.prepare('SELECT status FROM disputes WHERE id = ?').get(ctx.disputeId);
  assert(d.status === 'OPEN', `${label}: hồ sơ tranh chấp vẫn OPEN`);
}

/** Các lối đọc NGOÀI /api/admin từng mở rộng theo role ADMIN. */
async function assertNoAdminReadOutsideRouter(label, token, ctx) {
  const list = await api('/api/transactions', { token });
  const ids = (list.data.transactions || []).map((t) => t.id);
  assert(list.status === 200 && !ids.includes(ctx.txnId),
    `${label}: GET /api/transactions không trả đơn của người khác (nhận ${ids.length} đơn)`);
  const detail = await api(`/api/transactions/${ctx.txnId}`, { token });
  assert(detail.status === 403, `${label}: GET /api/transactions/:id của người khác bị 403 (nhận ${detail.status})`);
  const logs = await api(`/api/transactions/${ctx.txnId}/logs`, { token });
  assert(logs.status === 403, `${label}: GET /api/transactions/:id/logs của người khác bị 403 (nhận ${logs.status})`);
  const todo = await api('/api/notifications/todo', { token });
  const kinds = JSON.stringify(todo.data || {});
  assert(todo.status === 200 && !/ADJUDICATE_DISPUTE|REVIEW_SELLER_REQUESTS/.test(kinds),
    `${label}: việc cần làm không có mục phân xử / duyệt bán hàng`);
}

// ------------------------------------------------------------------------------------------
// G6: CSDL riêng cho server con
// ------------------------------------------------------------------------------------------
function separateDbTarget() {
  if (DIALECT === 'pg') {
    const u = new URL(process.env.DATABASE_URL);
    const name = decodeURIComponent(u.pathname.replace(/^\//, ''));
    if (!/_test$/.test(name)) throw new Error(`DATABASE_URL không phải CSDL test (${name})`);
    const sepName = name.replace(/_test$/, '_prov_test');
    const sep = new URL(u.toString());
    sep.pathname = `/${sepName}`;
    return { kind: 'pg', url: sep.toString(), name: sepName };
  }
  return { kind: 'sqlite', file: path.join('data', 'test', `provenance-${Date.now()}.db`) };
}

async function pgClient(url) {
  const { Client } = require('pg');
  const sslOff = /sslmode=disable/.test(url) || process.env.PGSSL === 'disable';
  const c = new Client({ connectionString: url, ssl: sslOff ? false : { rejectUnauthorized: false } });
  await c.connect();
  return c;
}

async function resetSeparateDb(target) {
  if (target.kind === 'pg') {
    const admin = await pgClient(process.env.DATABASE_URL);
    try {
      const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [target.name]);
      if (!exists.rowCount) await admin.query(`CREATE DATABASE "${target.name}"`);
    } finally { await admin.end(); }
    const c = await pgClient(target.url);
    try { await c.query('DROP SCHEMA IF EXISTS app CASCADE; DROP SCHEMA IF EXISTS mock_provider CASCADE;'); } finally { await c.end(); }
    return;
  }
  removeSqliteFiles(target.file);
}

function removeSqliteFiles(file) {
  const base = file.replace(/\.db$/, '');
  for (const f of [file, `${base}.mock-provider.db`]) {
    for (const s of ['', '-wal', '-shm']) {
      try { const p = path.join(ROOT, f + s); if (fs.existsSync(p)) fs.unlinkSync(p); } catch (_) { /* file tạm */ }
    }
  }
}

/** Chạy SQL thẳng trên CSDL riêng (không qua server). */
async function onSeparateDb(target, fn) {
  if (target.kind === 'pg') {
    const c = await pgClient(target.url);
    try {
      await c.query('SET search_path TO app, public');
      return await fn({
        exec: (sql) => c.query(sql),
        all: async (sql, params = []) => (await c.query(sql.replace(/\?/g, (() => { let i = 0; return () => `$${++i}`; })()), params)).rows,
      });
    } finally { await c.end(); }
  }
  const Database = require('../src/lib/sqlite');
  const raw = new Database(path.join(ROOT, target.file));
  try {
    return await fn({
      exec: (sql) => raw.exec(sql),
      all: (sql, params = []) => raw.prepare(sql).all(...params),
    });
  } finally { raw.close(); }
}

async function runChild(target, extraEnv = {}) {
  const env = {
    ...process.env,
    PORT: String(CHILD_PORT),
    RECONCILE_INTERVAL_SECONDS: '0',
    CHALLENGE_CLEANUP_INTERVAL_SECONDS: '0',
  };
  for (const k of Object.keys(env)) {
    if (k.startsWith('ADMIN_BOOTSTRAP_') || k === 'FAULT_INJECT' || k === 'FAULT_INJECT_MODE') delete env[k];
  }
  if (target.kind === 'pg') env.DATABASE_URL = target.url;
  else { delete env.DATABASE_URL; env.DB_PATH = target.file; }
  Object.assign(env, extraEnv);

  const child = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env });
  const exited = new Promise((r) => child.once('exit', r));
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  let up = false;
  for (let i = 0; i < 80 && !up && child.exitCode === null; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try { up = (await fetch(`http://localhost:${CHILD_PORT}/health`)).ok; } catch (_) {}
  }
  if (child.exitCode === null) {
    child.kill();
    const late = await Promise.race([exited.then(() => false), new Promise((r) => setTimeout(() => r(true), 5000))]);
    if (late) { child.kill('SIGKILL'); await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]); }
  }
  return { up, out };
}

async function main() {
  const stamp = Date.now();
  const admin = await flows.createAdmin({ username: `prov-adm-${stamp}`, displayName: 'Admin thật' });
  const seller = await createSeller(null, null, admin, { username: uniq('prov-sel'), displayName: 'Người bán' });
  const buyer = await flows.registerUser({ username: uniq('prov-buy'), displayName: 'Người mua' });

  // Một đơn đang tranh chấp và một yêu cầu bán hàng đang chờ — đối tượng thật cho các API quản trị.
  const listing = await api('/api/listings', { method: 'POST', token: seller.token,
    body: { title: `Prov ${crypto.randomUUID().slice(0, 6)}`, category: 'MAY_TINH', price: 150000, location: 'Hà Nội' } });
  const order = await api('/api/transactions/orders', { method: 'POST', token: buyer.token, body: { listingId: listing.data.id } });
  const txnId = order.data.id;
  await api(`/api/transactions/${txnId}/secure`, { method: 'POST', token: buyer.token, body: { requestId: crypto.randomUUID() } });
  await api(`/api/transactions/${txnId}/ship`, { method: 'POST', token: seller.token });
  await api(`/api/transactions/${txnId}/wait-confirm`, { method: 'POST', token: buyer.token });
  const disp = await api(`/api/transactions/${txnId}/dispute`, { method: 'POST', token: buyer.token, body: { reason: 'Kiểm thử nguồn gốc admin' } });
  const disputeId = disp.data.dispute && disp.data.dispute.id;
  const applicant = await flows.registerUser({ username: uniq('prov-app'), displayName: 'Người xin bán' });
  const sreq = await api('/api/users/me/seller-request', { method: 'POST', token: applicant.token,
    body: { shopName: 'Shop chờ duyệt', pitch: 'Đối tượng thật cho API duyệt bán hàng.' } });
  const sellerRequestId = (sreq.data.sellerRequest || sreq.data.request || {}).id;
  const ctx = { disputeId, txnId, sellerRequestId };
  assert(!!disputeId && !!sellerRequestId, 'Chuẩn bị: một đơn đang tranh chấp và một yêu cầu bán hàng đang chờ');

  await group('G0: Không có API nào biến người mua/bán thành ADMIN', async () => {
    const sneaky = await flows.registerUser({
      username: uniq('prov-sneaky'), displayName: 'Thử nâng quyền',
      role: 'ADMIN', isAdmin: true, accountStatus: 'ACTIVE', account_status: 'ACTIVE',
    });
    assert(!!sneaky.token, 'Đăng ký kèm role/isAdmin/accountStatus vẫn đi hết luồng bình thường');
    assert((await roleOf(sneaky.user.id)) === 'BUYER', 'Các trường quyền trong body đăng ký bị bỏ qua: role = BUYER');
    assert((await provenanceOf(sneaky.user.id)) === undefined || (await provenanceOf(sneaky.user.id)) === null,
      'Không có dấu nguồn gốc admin cho tài khoản đăng ký');
    const r = await api('/api/admin/invariants', { token: sneaky.token });
    assert(r.status === 403, `Tài khoản đó gọi API quản trị bị 403 (nhận ${r.status})`);
    assert((await roleOf(seller.user.id)) === 'SELLER', 'Duyệt bán hàng đưa BUYER -> SELLER, không cao hơn');
  });

  await group('G1: Admin bootstrap hợp lệ vẫn hoạt động, có dấu nguồn gốc', async () => {
    const r = await api('/api/admin/invariants', { token: admin.token });
    assert(r.status === 200 && r.data.ok === true, `Admin bootstrap gọi /api/admin/invariants được (nhận ${r.status})`);
    const p = await provenanceOf(admin.user.id);
    assert(!!p && p.source === 'BOOTSTRAP_CLI', `Có dấu nguồn gốc BOOTSTRAP_CLI (thực tế ${p ? p.source : 'không có'})`);
    const users = await api('/api/admin/users', { token: admin.token });
    assert(users.status === 200, 'Admin bootstrap đọc được danh sách người dùng');
    const list = await api('/api/transactions', { token: admin.token });
    assert(list.status === 200 && list.data.transactions.some((t) => t.id === txnId), 'Admin bootstrap vẫn xem được mọi đơn (hành vi cũ giữ nguyên)');
  });

  await group('G2: Ràng buộc ở CSDL chặn nâng quyền và giả dấu nguồn gốc', async () => {
    const victim = buyer.user.id;
    assert(await rejects(() => db.prepare("UPDATE users SET role = 'ADMIN' WHERE id = ?").run(victim)),
      'UPDATE users SET role = ADMIN bị CSDL từ chối');
    assert((await roleOf(victim)) === 'BUYER', 'role vẫn là BUYER');
    assert(await rejects(() => db.prepare(
      `INSERT INTO admin_provenance (user_id, source, username_at_grant, granted_at) VALUES (?, 'BOOTSTRAP_CLI', 'x', ?)`
    ).run(victim, nowIso())), 'Không gắn được dấu nguồn gốc cho tài khoản mua đang ACTIVE');
    assert(await rejects(() => db.prepare(
      `INSERT INTO admin_provenance (user_id, source, username_at_grant, granted_at) VALUES (?, 'LEGACY_BACKFILL', 'x', ?)`
    ).run(victim, nowIso())), 'Không chèn được dấu LEGACY_BACKFILL ngoài lần migration');
    assert(await rejects(() => db.prepare(`UPDATE admin_provenance SET source = 'BOOTSTRAP_ENV' WHERE user_id = ?`).run(admin.user.id))
      && (await provenanceOf(admin.user.id)).source === 'BOOTSTRAP_CLI', 'Dấu nguồn gốc không sửa được');
  });

  await group('G3: Tài khoản ACTIVE bị sửa role=ADMIN, KHÔNG có ví', async () => {
    const fake = await flows.registerUser({ username: uniq('prov-nowallet'), displayName: 'Admin giả không ví' });
    const w = await db.prepare("SELECT id FROM wallets WHERE user_id = ? AND wallet_type = 'USER'").get(fake.user.id);
    await db.prepare('DELETE FROM wallet_entries WHERE wallet_id = ?').run(w.id);
    await db.prepare('DELETE FROM wallets WHERE id = ?').run(w.id);
    await forceRole(fake.user.id, 'ADMIN');
    assert((await roleOf(fake.user.id)) === 'ADMIN' && !(await db.prepare('SELECT 1 FROM wallets WHERE user_id = ?').get(fake.user.id)),
      'Dựng được trạng thái: role=ADMIN, ACTIVE, có Passkey, không có ví');
    await assertAllAdminDenied('Admin giả không ví', fake.token, ctx);
    await assertNoAdminReadOutsideRouter('Admin giả không ví', fake.token, ctx);
    await forceRole(fake.user.id, 'BUYER');
  });

  await group('G4: Tài khoản ACTIVE CÓ ví bị sửa role=ADMIN', async () => {
    const fake = await flows.registerUser({ username: uniq('prov-wallet'), displayName: 'Admin giả có ví' });
    await forceRole(fake.user.id, 'ADMIN');
    await assertAllAdminDenied('Admin giả có ví', fake.token, ctx);
    await assertNoAdminReadOutsideRouter('Admin giả có ví', fake.token, ctx);
    await forceRole(fake.user.id, 'BUYER');
  });

  await group('G5: Tài khoản PENDING_PASSKEY bị sửa role=ADMIN không kích hoạt được', async () => {
    const username = uniq('prov-pending');
    const acc = await api('/api/passkeys/register/account', { method: 'POST',
      body: { username, displayName: 'Chờ Passkey', password: DEFAULT_PASSWORD } });
    const userId = acc.data.user.id;
    await forceRole(userId, 'ADMIN');
    const dev = createAuthenticator();
    const opt = await api('/api/passkeys/register/passkey/options', { method: 'POST', token: acc.data.token, body: {} });
    const resp = dev.register({ rpId: RP_ID, origin: ORIGIN, challenge: opt.data.options.challenge, uv: true });
    const v = await api('/api/passkeys/register/passkey/verify', { method: 'POST', token: acc.data.token,
      body: { registrationSessionId: opt.data.registrationSessionId, response: resp } });
    assert(v.status === 403 && v.data.error === 'ADMIN_IDENTITY_INVALID',
      `Hoàn tất Passkey bị 403 ADMIN_IDENTITY_INVALID (nhận ${v.status} ${v.data.error || ''})`);
    const row = await db.prepare('SELECT account_status FROM users WHERE id = ?').get(userId);
    const creds = await db.prepare('SELECT COUNT(*) AS n FROM passkey_credentials WHERE user_id = ?').get(userId);
    assert(row.account_status === 'PENDING_PASSKEY' && Number(creds.n) === 0, 'Tài khoản vẫn PENDING_PASSKEY, không có credential nào');
    if (v.status === 201 && v.data.token) {
      // Trước bản sửa: tài khoản đã thành "admin" không ví — thử luôn một API quản trị để thấy hậu quả.
      const r = await api('/api/admin/users', { token: v.data.token });
      assert(r.status === 403, `Tài khoản vừa kích hoạt gọi /api/admin/users bị 403 (nhận ${r.status})`);
    }
    await forceRole(userId, 'BUYER');
  });

  await group('G6: CSDL riêng — bootstrap qua biến môi trường và backfill một lần', async () => {
    const target = separateDbTarget();
    await resetSeparateDb(target);
    try {
      const envAdmin = `envadm${stamp.toString(36)}`;
      const first = await runChild(target, { ADMIN_BOOTSTRAP_USERNAME: envAdmin, ADMIN_BOOTSTRAP_PASSWORD: 'Tam-Thoi-Env-2026!' });
      assert(first.up, 'Server con khởi động trên CSDL riêng (lần 1, có biến bootstrap)');
      const firstRows = await onSeparateDb(target, (c) => c.all(
        'SELECT u.username, u.role, p.source FROM users u LEFT JOIN admin_provenance p ON p.user_id = u.id WHERE u.username = ?', [envAdmin]));
      assert(firstRows.length === 1 && firstRows[0].role === 'ADMIN' && firstRows[0].source === 'BOOTSTRAP_ENV',
        `Admin bootstrap từ biến môi trường có dấu BOOTSTRAP_ENV (thực tế ${JSON.stringify(firstRows)})`);

      // Đưa CSDL về hình dạng "cũ" (trước khi có bảng nguồn gốc) và gieo ba loại ADMIN.
      await onSeparateDb(target, async (c) => {
        if (target.kind === 'pg') {
          await c.exec('DROP TABLE IF EXISTS admin_provenance CASCADE');
          await c.exec('DROP TRIGGER IF EXISTS trg_users_no_admin_promotion ON users');
          await c.exec('DROP FUNCTION IF EXISTS app.forbid_admin_promotion() CASCADE');
          await c.exec('DROP FUNCTION IF EXISTS app.guard_admin_provenance() CASCADE');
          await c.exec('DROP FUNCTION IF EXISTS app.guard_admin_insert() CASCADE');
          await c.exec('DELETE FROM schema_migrations WHERE version > 1');
        } else {
          await c.exec('DROP TABLE IF EXISTS admin_provenance');
          for (const t of await c.all("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'users'")) {
            await c.exec(`DROP TRIGGER "${t.name}"`);
          }
        }
        const now = nowIso();
        const pw = hashPassword(DEFAULT_PASSWORD);
        for (const [name, role] of [['legacyadm', 'ADMIN'], ['tamperedbuyer', 'ADMIN']]) {
          await c.all(`INSERT INTO users (id, username, display_name, role, password_hash, account_status, token_version, created_at, updated_at)
                       VALUES (?, ?, ?, ?, ?, 'ACTIVE', 0, ?, ?)`, [uuid(), `${name}${stamp.toString(36)}`, name, role, pw, now, now]);
        }
        const tb = (await c.all('SELECT id FROM users WHERE username = ?', [`tamperedbuyer${stamp.toString(36)}`]))[0];
        await c.all(`INSERT INTO wallets (id, user_id, wallet_type, available_balance, locked_balance, version, created_at, updated_at)
                     VALUES (?, ?, 'USER', 0, 0, 0, ?, ?)`, [uuid(), tb.id, now, now]);
      });

      const second = await runChild(target);
      assert(second.up, 'Server con khởi động lần 2 — migration tạo lại bảng nguồn gốc và backfill');
      const sources = async () => Object.fromEntries((await onSeparateDb(target, (c) => c.all(
        `SELECT u.username, p.source FROM users u LEFT JOIN admin_provenance p ON p.user_id = u.id WHERE u.role = 'ADMIN'`))).map((r) => [r.username, r.source || null]));
      const after2 = await sources();
      assert(after2[`legacyadm${stamp.toString(36)}`] === 'LEGACY_BACKFILL', 'ADMIN cũ không có ví được backfill LEGACY_BACKFILL');
      assert(after2[envAdmin] === 'LEGACY_BACKFILL', 'Admin bootstrap trước đó (không ví) cũng được backfill');
      assert(after2[`tamperedbuyer${stamp.toString(36)}`] === null, 'ADMIN có ví USER (dấu hiệu bị nâng quyền) KHÔNG được backfill');

      // Sau migration, trigger chỉ cho chèn ADMIN ở PENDING_BOOTSTRAP — vẫn là một ADMIN không có
      // dấu nguồn gốc, và lần khởi động sau KHÔNG được backfill nó.
      assert(await rejects(() => onSeparateDb(target, (c) => c.all(
        `INSERT INTO users (id, username, display_name, role, password_hash, account_status, token_version, created_at, updated_at)
         VALUES (?, ?, 'x', 'ADMIN', 'x', 'ACTIVE', 0, ?, ?)`, [uuid(), `activeadm${stamp.toString(36)}`, nowIso(), nowIso()]))),
      'CSDL từ chối chèn thẳng một tài khoản ADMIN đang ACTIVE');
      await onSeparateDb(target, (c) => c.all(
        `INSERT INTO users (id, username, display_name, role, password_hash, account_status, token_version, created_at, updated_at)
         VALUES (?, ?, 'late', 'ADMIN', ?, 'PENDING_BOOTSTRAP', 0, ?, ?)`, [uuid(), `lateadm${stamp.toString(36)}`, hashPassword(DEFAULT_PASSWORD), nowIso(), nowIso()]));
      const third = await runChild(target);
      assert(third.up, 'Server con khởi động lần 3');
      const after3 = await sources();
      assert(after3[`lateadm${stamp.toString(36)}`] === null, 'ADMIN chèn SAU migration không được backfill (backfill chỉ chạy một lần)');
      assert(after3[`legacyadm${stamp.toString(36)}`] === 'LEGACY_BACKFILL', 'Dấu nguồn gốc đã có giữ nguyên qua các lần khởi động');
    } finally {
      if (target.kind === 'sqlite') {
        await new Promise((r) => setTimeout(r, 200));
        removeSqliteFiles(target.file);
      }
    }
  });

  const inv = await checkInvariants(db);
  assert(inv.ok, `${inv.checked} bất biến đều đúng${inv.ok ? '' : ` (vi phạm: ${JSON.stringify(inv.violations)})`}`);

  console.log(failures ? `\n${failures} FAIL` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error('[admin-provenance] lỗi:', e); process.exit(1); });
