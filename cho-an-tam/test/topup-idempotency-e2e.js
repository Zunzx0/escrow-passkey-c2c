/**
 * Hồi quy: yêu cầu nạp tiền gửi lặp, và yêu cầu kẹt PENDING mãi vì bước gửi sang provider thất bại
 * (nhánh claude/topup-request-idempotency).
 *
 * Hai lỗi trước khi sửa:
 *   1. POST /api/payments/topup không có khoá chống lặp: bấm hai lần / client tự thử lại sau khi mất
 *      phản hồi tạo ra HAI yêu cầu PENDING, người dùng có thể thanh toán cả hai.
 *   2. Yêu cầu được ghi PENDING rồi MỚI gửi sang provider. Gửi hỏng thì client nhận 500 chung chung,
 *      yêu cầu nằm PENDING mà provider không hề biết; worker đối soát hỏi provider chỉ nhận
 *      UNKNOWN_PAYMENT và ghi lỗi mãi mãi; yêu cầu chiếm một suất TOPUP_MAX_PENDING suốt 24 giờ.
 *
 * Thiết kế sau khi sửa (src/lib/paymentService.js, src/routes/payments.js, src/lib/reconciler.js):
 *   - body nhận thêm `requestId` (tuỳ chọn, chuỗi 8–100 ký tự [A-Za-z0-9._:-]); UNIQUE theo
 *     (user_id, client_request_id). Gửi lại cùng requestId + cùng amount -> 200, trả ĐÚNG yêu cầu cũ
 *     (idempotentReplay: true); cùng requestId khác amount -> 409 IDEMPOTENCY_KEY_REUSED.
 *   - payment_requests.submission_status: SUBMITTING -> SUBMITTED | SUBMIT_FAILED. Gửi hỏng ->
 *     503 PROVIDER_UNAVAILABLE, yêu cầu ở PENDING + SUBMIT_FAILED.
 *   - gửi lại cùng requestId thì thử gửi provider lần nữa; worker đối soát cũng tự gửi lại (kể cả
 *     yêu cầu cũ "SUBMITTED" mà provider không biết); quá TOPUP_SUBMIT_MAX_ATTEMPTS lần mà provider
 *     vẫn không nhận -> FAILED (không có tiền nào di chuyển), giải phóng suất PENDING.
 *   - submitPayment của Mock Provider idempotent theo provider_ref.
 *
 * Yêu cầu: server test đang chạy (`npm run start:test`). Các ca "provider sập" spawn server con dùng
 * CHUNG CSDL test (cổng 3184) với MOCK_PROVIDER_SUBMIT_FAIL=1 — và trên SQLite thêm
 * MOCK_PROVIDER_DB_PATH trỏ tới thư mục không tồn tại, để tái hiện được cả trên mã CŨ.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { flows } = require('./helpers/accounts');
const { checkInvariants } = require('../src/lib/invariants');
const { db, DIALECT, uuid, nowIso } = require('../src/db');
const provider = require('../src/lib/mockPaymentProvider');

const ROOT = path.join(__dirname, '..');
const BASE = process.env.BASE_URL || 'http://localhost:3100';
const CHILD_PORT = 3184;
const CHILD_BASE = `http://localhost:${CHILD_PORT}`;
const MAX_SUBMIT_ATTEMPTS = 3;

let failures = 0;
function assert(cond, label) {
  console.log(`  ${cond ? '✅' : '❌'} ${label}`);
  if (!cond) failures++;
}
function section(title) { console.log(`\n${title}`); }
async function group(title, fn) {
  section(title);
  try { await fn(); } catch (e) { assert(false, `Nhóm dừng giữa chừng vì lỗi: ${e.message}`); }
}

async function api(p, { method = 'GET', body, token, base = BASE } = {}, retried = false) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(base + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let data = {};
  try { data = await res.json(); } catch (_) {}
  if (res.status === 429 && !retried) {
    console.log('  ⏳ Chạm rate limit — chờ 60 giây rồi thử lại…');
    await new Promise((r) => setTimeout(r, 61000));
    return api(p, { method, body, token, base }, true);
  }
  return { status: res.status, data };
}

const rid = () => `topup-${crypto.randomUUID()}`;
const topup = (token, amount, requestId, base) =>
  api('/api/payments/topup', { method: 'POST', token, base, body: requestId === undefined ? { amount } : { amount, requestId } });
const prRow = (id) => db.prepare('SELECT * FROM payment_requests WHERE id = ?').get(id);
const countRequests = async (userId) =>
  Number((await db.prepare('SELECT COUNT(*) AS n FROM payment_requests WHERE user_id = ?').get(userId)).n);
const pendingCount = async (userId) =>
  Number((await db.prepare("SELECT COUNT(*) AS n FROM payment_requests WHERE user_id = ? AND status = 'PENDING'").get(userId)).n);
const balanceOf = async (userId) =>
  (await db.prepare("SELECT available_balance FROM wallets WHERE user_id = ? AND wallet_type = 'USER'").get(userId)).available_balance;
const creditEntries = async (id) =>
  Number((await db.prepare("SELECT COUNT(*) AS n FROM wallet_entries WHERE request_id = ? AND entry_type = 'TOPUP_CREDIT'").get(id)).n);

function outageEnv() {
  const env = { MOCK_PROVIDER_SUBMIT_FAIL: '1', TOPUP_SUBMIT_MAX_ATTEMPTS: String(MAX_SUBMIT_ATTEMPTS) };
  if (DIALECT === 'sqlite') env.MOCK_PROVIDER_DB_PATH = path.join('data', 'test', 'khong-ton-tai', 'x', 'provider.db');
  return env;
}

async function startChild(extraEnv) {
  const env = { ...process.env, PORT: String(CHILD_PORT), RECONCILE_INTERVAL_SECONDS: '0', CHALLENGE_CLEANUP_INTERVAL_SECONDS: '0' };
  for (const k of Object.keys(env)) {
    if (k.startsWith('ADMIN_BOOTSTRAP_') || k === 'FAULT_INJECT' || k === 'FAULT_INJECT_MODE') delete env[k];
  }
  Object.assign(env, extraEnv);
  const child = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env });
  const exited = new Promise((r) => child.once('exit', r));
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  let up = false;
  for (let i = 0; i < 80 && !up && child.exitCode === null; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try { up = (await fetch(`${CHILD_BASE}/health`)).ok; } catch (_) {}
  }
  return {
    up,
    out: () => out,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        const late = await Promise.race([exited.then(() => false), new Promise((r) => setTimeout(() => r(true), 5000))]);
        if (late) { child.kill('SIGKILL'); await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]); }
      }
      return child.exitCode !== null || child.signalCode !== null;
    },
  };
}

function runReconcile(id, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['scripts/reconcile.js', `--id=${id}`, '--min-age=0'], { cwd: ROOT, env: { ...process.env, ...extraEnv } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => {
      let summary = null;
      try { summary = JSON.parse(out.trim().split('\n').pop()); } catch (_) {}
      resolve({ code, summary, out });
    });
  });
}

async function pay(token, providerRef) {
  return api(`/mock-provider/checkout/${providerRef}/pay`, { method: 'POST', token, body: { outcome: 'SUCCEEDED', deliverWebhook: true } });
}

async function main() {
  const stamp = Date.now();
  const buyer = await flows.registerUser({ username: `ti-buy-${stamp}`, displayName: 'Người nạp tiền' });
  const other = await flows.registerUser({ username: `ti-oth-${stamp}`, displayName: 'Người khác' });
  const third = await flows.registerUser({ username: `ti-thr-${stamp}`, displayName: 'Người thứ ba' });
  assert(!!buyer.token && !!other.token && !!third.token, 'Ba tài khoản sẵn sàng');

  await group('I1: Cùng requestId gửi 5 lần ĐỒNG THỜI -> đúng một yêu cầu', async () => {
    const key = rid();
    const before = await countRequests(buyer.user.id);
    const rs = await Promise.all(Array.from({ length: 5 }, () => topup(buyer.token, 101000, key)));
    console.log(`  [I1] ${rs.map((r) => `${r.status}${r.data.idempotentReplay ? 'r' : ''}`).join(' ')}`);
    const ids = new Set(rs.map((r) => r.data.id));
    assert((await countRequests(buyer.user.id)) - before === 1, `Chỉ thêm đúng 1 yêu cầu (thực tế ${(await countRequests(buyer.user.id)) - before})`);
    assert(rs.filter((r) => r.status === 201).length === 1 && rs.filter((r) => r.status === 200 && r.data.idempotentReplay === true).length === 4,
      'Đúng 1 phản hồi 201 và 4 phản hồi 200 idempotentReplay');
    assert(ids.size === 1, 'Cả 5 phản hồi trỏ cùng một id yêu cầu');
    const row = await prRow([...ids][0]);
    assert(row && row.submission_status === 'SUBMITTED' && !!(await provider.findPayment(row.provider_ref)),
      'Yêu cầu đã gửi sang provider (SUBMITTED), provider có đúng bản ghi');
  });

  await group('I2: Gửi lại sau khi thành công, rồi sau khi đã tất toán -> vẫn đúng yêu cầu cũ, cộng tiền một lần', async () => {
    const key = rid();
    const first = await topup(buyer.token, 102000, key);
    const again = await topup(buyer.token, 102000, key);
    assert(first.status === 201 && again.status === 200 && again.data.id === first.data.id && again.data.providerRef === first.data.providerRef,
      `Lần 2: 200, cùng id và providerRef (nhận ${again.status})`);
    const before = await balanceOf(buyer.user.id);
    const p = await pay(buyer.token, first.data.providerRef);
    assert(p.status === 200, 'Thanh toán ở cổng thành công');
    const after = await topup(buyer.token, 102000, key);
    assert(after.status === 200 && after.data.id === first.data.id && after.data.status === 'SUCCEEDED',
      `Gửi lại sau tất toán: 200, trả trạng thái hiện tại SUCCEEDED (nhận ${after.status} ${after.data.status})`);
    assert((await balanceOf(buyer.user.id)) - before === 102000 && (await creditEntries(first.data.id)) === 1, 'Ví cộng đúng một lần');
  });

  await group('I3: Cùng requestId, KHÁC số tiền -> 409 IDEMPOTENCY_KEY_REUSED', async () => {
    const key = rid();
    const first = await topup(buyer.token, 103000, key);
    const before = await countRequests(buyer.user.id);
    const bad = await topup(buyer.token, 104000, key);
    assert(bad.status === 409 && bad.data.error === 'IDEMPOTENCY_KEY_REUSED', `Nhận 409 IDEMPOTENCY_KEY_REUSED (nhận ${bad.status} ${bad.data.error || ''})`);
    assert((await countRequests(buyer.user.id)) === before, 'Không tạo yêu cầu mới');
    assert((await prRow(first.data.id)).amount === 103000, 'Yêu cầu cũ giữ nguyên số tiền');
  });

  await group('I4: requestId thuộc phạm vi từng người dùng', async () => {
    const key = rid();
    const a = await topup(third.token, 105000, key);
    const b = await topup(other.token, 105000, key);
    assert(a.status === 201 && b.status === 201 && a.data.id !== b.data.id, 'Hai người dùng cùng requestId được hai yêu cầu riêng');
  });

  await group('I5: requestId sai định dạng -> 400 VALIDATION_ERROR', async () => {
    for (const [label, v] of [['số', 12345678], ['quá ngắn', 'abc'], ['ký tự lạ', 'xin chào bạn ơi'], ['quá dài', 'x'.repeat(101)], ['boolean', true]]) {
      const before = await countRequests(other.user.id);
      const r = await topup(other.token, 106000, v);
      assert(r.status === 400 && r.data.error === 'VALIDATION_ERROR', `${label}: 400 VALIDATION_ERROR (nhận ${r.status} ${r.data.error || ''})`);
      assert((await countRequests(other.user.id)) === before, `${label}: không tạo yêu cầu`);
    }
  });

  await group('I6: Không gửi requestId -> hành vi cũ (mỗi lần một yêu cầu)', async () => {
    const before = await countRequests(other.user.id);
    const a = await topup(other.token, 107000);
    const b = await topup(other.token, 107000);
    assert(a.status === 201 && b.status === 201 && a.data.id !== b.data.id && (await countRequests(other.user.id)) - before === 2,
      'Hai lần gửi không khoá -> hai yêu cầu 201');
    assert(a.data.submissionStatus === 'SUBMITTED' && a.data.requestId === null, 'Phản hồi có submissionStatus=SUBMITTED, requestId=null');
  });

  // Các ca provider sập dùng người dùng riêng để không đụng hạn mức PENDING của các nhóm trên.
  const victim = await flows.registerUser({ username: `ti-vic-${stamp}`, displayName: 'Nạp lúc provider sập' });
  const victim2 = await flows.registerUser({ username: `ti-vi2-${stamp}`, displayName: 'Nạp lúc provider sập 2' });

  let s1 = null; let s2 = null; let s3 = null;
  await group('S0: Provider sập khi tạo yêu cầu (server con)', async () => {
    const child = await startChild(outageEnv());
    try {
      assert(child.up, 'Server con với provider sập khởi động');
      const key1 = rid(); const key3 = rid();
      const r1 = await topup(victim.token, 111000, key1, CHILD_BASE);
      const r2 = await topup(victim.token, 112000, undefined, CHILD_BASE);
      const r3 = await topup(victim2.token, 113000, key3, CHILD_BASE);
      for (const [label, r] of [['có requestId', r1], ['không requestId', r2], ['ca hết lượt', r3]]) {
        assert(r.status === 503 && r.data.error === 'PROVIDER_UNAVAILABLE',
          `${label}: 503 PROVIDER_UNAVAILABLE thay vì 500 chung (nhận ${r.status} ${r.data.error || ''})`);
      }
      const rows = await db.prepare('SELECT * FROM payment_requests WHERE user_id IN (?, ?) ORDER BY amount').all(victim.user.id, victim2.user.id);
      s1 = rows.find((r) => r.amount === 111000); s2 = rows.find((r) => r.amount === 112000); s3 = rows.find((r) => r.amount === 113000);
      s1 && (s1.key = key1); s3 && (s3.key = key3);
      assert(!!s1 && !!s2 && !!s3, 'Ba yêu cầu được ghi lại (không mất dấu yêu cầu của người dùng)');
      for (const r of [s1, s2, s3].filter(Boolean)) {
        assert(r.status === 'PENDING' && r.submission_status === 'SUBMIT_FAILED' && Number(r.submit_attempts) === 1,
          `${r.amount}: PENDING + SUBMIT_FAILED, submit_attempts=1 (thực tế ${r.status}/${r.submission_status}/${r.submit_attempts})`);
        assert(!(await provider.findPayment(r.provider_ref)), `${r.amount}: provider KHÔNG có bản ghi`);
      }
    } finally {
      assert(await child.stop(), 'Server con đã thoát hẳn');
    }
  });

  await group('S1: Gửi lại CÙNG requestId khi provider đã hồi phục -> gửi lại provider, nạp được đúng một lần', async () => {
    const r = await topup(victim.token, 111000, s1.key);
    assert(r.status === 200 && r.data.id === s1.id && r.data.submissionStatus === 'SUBMITTED',
      `200, cùng yêu cầu, nay SUBMITTED (nhận ${r.status} ${r.data.error || ''} ${r.data.submissionStatus || ''})`);
    const before = await balanceOf(victim.user.id);
    const p = await pay(victim.token, s1.provider_ref);
    assert(p.status === 200, `Trang thanh toán của provider dùng được (nhận ${p.status} ${p.data.error || ''})`);
    assert((await balanceOf(victim.user.id)) - before === 111000 && (await creditEntries(s1.id)) === 1, 'Ví cộng đúng 111.000đ một lần');
  });

  await group('S2: Yêu cầu không requestId bị kẹt -> worker đối soát tự gửi lại provider', async () => {
    const k = await runReconcile(s2.id);
    const row = await prRow(s2.id);
    assert(k.code === 0 && row.status === 'PENDING' && row.submission_status === 'SUBMITTED',
      `Sau một lượt đối soát: PENDING + SUBMITTED (thực tế ${row.status}/${row.submission_status}, exit ${k.code})`);
    assert(!!(await provider.findPayment(s2.provider_ref)), 'Provider đã có bản ghi');
    const before = await balanceOf(victim.user.id);
    await pay(victim.token, s2.provider_ref);
    assert((await balanceOf(victim.user.id)) - before === 112000, 'Thanh toán xong, ví cộng đúng 112.000đ');
  });

  await group(`S3: Provider sập kéo dài -> sau ${MAX_SUBMIT_ATTEMPTS} lần gửi, yêu cầu FAILED, không có tiền di chuyển`, async () => {
    const pendingBefore = await pendingCount(victim2.user.id);
    const balanceBefore = await balanceOf(victim2.user.id);
    // Worker vẫn ĐỌC được kho provider (để xác nhận không có bản ghi) nhưng provider không nhận
    // yêu cầu tạo thanh toán — nên chỉ bật MOCK_PROVIDER_SUBMIT_FAIL, không đổi đường dẫn kho.
    const workerOutage = { MOCK_PROVIDER_SUBMIT_FAIL: '1', TOPUP_SUBMIT_MAX_ATTEMPTS: String(MAX_SUBMIT_ATTEMPTS) };
    for (let i = 0; i < MAX_SUBMIT_ATTEMPTS; i++) await runReconcile(s3.id, workerOutage);
    const row = await prRow(s3.id);
    assert(row.status === 'FAILED' && row.resolved_by === 'RECONCILER' && Number(row.submit_attempts) === MAX_SUBMIT_ATTEMPTS,
      `FAILED bởi RECONCILER sau ${MAX_SUBMIT_ATTEMPTS} lần gửi (thực tế ${row.status}/${row.resolved_by}/${row.submit_attempts})`);
    assert((await pendingCount(victim2.user.id)) === pendingBefore - 1, 'Suất PENDING được giải phóng');
    assert((await balanceOf(victim2.user.id)) === balanceBefore && (await creditEntries(s3.id)) === 0, 'Ví không đổi, không có bút toán');
    assert(!(await provider.findPayment(s3.provider_ref)), 'Provider không có bản ghi nào (không thể bị thanh toán sau đó)');
    const late = await topup(victim2.token, 113000, s3.key);
    assert(late.status === 200 && late.data.id === s3.id && late.data.status === 'FAILED',
      `Gửi lại cùng requestId sau đó: 200, trả trạng thái FAILED, không gửi provider nữa (nhận ${late.status} ${late.data.status})`);
    assert(!(await provider.findPayment(s3.provider_ref)), 'Vẫn không có bản ghi ở provider');
  });

  await group('S4: Yêu cầu CŨ "SUBMITTED" mà provider không biết (dữ liệu trước bản sửa) -> đối soát gửi lại', async () => {
    const id = uuid(); const ref = uuid(); const now = nowIso();
    await db.prepare(
      `INSERT INTO payment_requests (id, user_id, amount, status, provider_ref, version, created_at, updated_at)
       VALUES (?, ?, 114000, 'PENDING', ?, 0, ?, ?)`
    ).run(id, other.user.id, ref, now, now);
    const k = await runReconcile(id);
    const row = await prRow(id);
    assert(k.code === 0 && row.status === 'PENDING' && row.submission_status === 'SUBMITTED' && !!(await provider.findPayment(ref)),
      `Provider nay có bản ghi, yêu cầu PENDING + SUBMITTED (thực tế ${row.status}/${row.submission_status})`);
  });

  await group('S5: Gửi lại provider là idempotent (provider đã có bản ghi)', async () => {
    const r = await topup(third.token, 115000, rid());
    await db.prepare("UPDATE payment_requests SET submission_status = 'SUBMITTING' WHERE id = ?").run(r.data.id);
    const k = await runReconcile(r.data.id);
    const row = await prRow(r.data.id);
    assert(k.code === 0 && row.submission_status === 'SUBMITTED' && row.status === 'PENDING',
      `Đối soát đưa về SUBMITTED, vẫn PENDING (thực tế ${row.submission_status}/${row.status})`);
    const p = await provider.findPayment(row.provider_ref);
    assert(!!p && p.amount === 115000 && p.merchant_ref === r.data.id && p.status === 'PENDING', 'Provider giữ nguyên đúng một bản ghi');
  });

  const inv = await checkInvariants(db);
  assert(inv.ok, `${inv.checked} bất biến đều đúng${inv.ok ? '' : ` (vi phạm: ${JSON.stringify(inv.violations)})`}`);

  console.log(failures ? `\n${failures} FAIL` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error('[topup-idempotency] lỗi:', e); process.exit(1); });
