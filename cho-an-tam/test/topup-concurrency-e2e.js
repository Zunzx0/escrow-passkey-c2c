/**
 * Hồi quy: nạp tiền bị gửi lặp hoặc gửi đồng thời, và quyền của quản trị viên đối với nạp tiền
 * (nhánh claude/fix-topup-idempotency).
 *
 * Kết quả rà soát trước khi viết bộ này: KHÔNG tìm thấy đường nào ghi có hai lần cho một yêu cầu.
 * Mọi đường tất toán (webhook, mock checkout -> webhook, worker đối soát) đều đi qua
 * applyProviderResult(), nơi giao dịch chiếm yêu cầu bằng
 *   UPDATE payment_requests ... WHERE id=? AND status='PENDING' AND version=?
 * (bên thua không ghi gì), trong giao dịch ghi được tuần tự hoá toàn cục, với
 * UNIQUE(wallet_entries.idempotency_key = 'topup:<id>') làm chốt chặn thứ hai. Không có điểm cuối
 * nào cho quản trị viên nạp/cộng tiền. Các bộ cũ chỉ kiểm phần lớn những điều này TUẦN TỰ (T05,
 * K04) hoặc với kết quả trái nhau (SR03); bộ này bắn ĐỒNG THỜI để khoá hành vi lại:
 *
 *   C1  hai /pay SUCCEEDED đồng thời trên cùng providerRef -> đúng 1 lần thanh toán, 1 lần cộng
 *   C2  cùng một webhook đã ký gửi 6 lần đồng thời -> 1 APPLIED, 5 duplicate, 1 bút toán
 *   C3  webhook SUCCEEDED và FAILED (cùng yêu cầu, đều ký đúng) đồng thời -> đúng một kết quả
 *       thắng, ví khớp kết quả đó, bên kia 409 WEBHOOK_CONFLICT
 *   C4  provider đã SUCCEEDED nhưng webhook thất lạc; webhook gửi lại x3 + 2 tiến trình đối soát
 *       chạy cùng lúc -> đúng 1 lần cộng
 *   A1  quản trị viên không tạo được yêu cầu nạp (không có ví) — 400 WALLET_NOT_FOUND, không có
 *       bản ghi nào
 *   A2  quản trị viên không xem/không "thanh toán hộ" được trang checkout của người khác (404)
 *   A3  người dùng thường không gọi được /api/admin/*; không tồn tại điểm cuối cộng tiền của admin
 *   9 bất biến sau mỗi nhóm.
 *
 * Yêu cầu: server test đang chạy (`npm run start:test`) với MOCK_PROVIDER_CHECKOUT khác 0.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const path = require('path');
const { spawn } = require('child_process');
const { flows } = require('./helpers/accounts');
const { buildProviderCallback } = require('../src/lib/mockPaymentProvider');
const { checkInvariants } = require('../src/lib/invariants');
const { db } = require('../src/db');

const ROOT = path.join(__dirname, '..');
const BASE = process.env.BASE_URL || 'http://localhost:3100';

let failures = 0;
function assert(cond, label) {
  console.log(`  ${cond ? '✅' : '❌'} ${label}`);
  if (!cond) failures++;
}
function section(title) { console.log(`\n${title}`); }

async function api(p, opts = {}, retried = false) {
  const { method = 'GET', body, token } = opts;
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(BASE + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let data = {};
  try { data = await res.json(); } catch (_) {}
  if (res.status === 429 && !retried) {
    console.log('  ⏳ Chạm rate limit — chờ 60 giây rồi thử lại…');
    await new Promise((r) => setTimeout(r, 61000));
    return api(p, opts, true);
  }
  return { status: res.status, data };
}

const balanceOf = async (userId) =>
  (await db.prepare("SELECT available_balance FROM wallets WHERE user_id = ? AND wallet_type = 'USER'").get(userId)).available_balance;
const prRow = (id) => db.prepare('SELECT * FROM payment_requests WHERE id = ?').get(id);
const creditEntries = async (id) =>
  Number((await db.prepare("SELECT COUNT(*) AS n FROM wallet_entries WHERE request_id = ? AND entry_type = 'TOPUP_CREDIT'").get(id)).n);

async function assertInvariantsOk(label) {
  const r = await checkInvariants(db);
  assert(r.ok, `${label}: ${r.checked} bất biến đều đúng${r.ok ? '' : ` (vi phạm: ${JSON.stringify(r.violations)})`}`);
}

async function createTopup(token, amount) {
  const r = await api('/api/payments/topup', { method: 'POST', token, body: { amount } });
  if (r.status !== 201) throw new Error(`tạo yêu cầu nạp thất bại: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
}

function postWebhook({ payload, signature }) {
  return api('/api/payments/webhook', { method: 'POST', body: { payload, signature } });
}

/** Chạy worker đối soát ở một TIẾN TRÌNH riêng, như cron/worker thật, cho đúng một yêu cầu. */
function runReconcileProcess(id) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['scripts/reconcile.js', `--id=${id}`, '--min-age=0'], { cwd: ROOT, env: process.env });
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

async function main() {
  section('Chuẩn bị: quản trị viên, hai người mua');
  const stamp = Date.now();
  const admin = await flows.createAdmin({ username: `tc_adm_${stamp}`, displayName: 'Admin Topup' });
  const buyer = await flows.registerUser({ username: `tc_buy_${stamp}`, displayName: 'Buyer Topup' });
  const other = await flows.registerUser({ username: `tc_oth_${stamp}`, displayName: 'Buyer Khác' });
  assert(!!admin.token && !!buyer.token && !!other.token, 'Ba tài khoản sẵn sàng');

  // =======================================================================================
  section('C1: Hai /pay SUCCEEDED ĐỒNG THỜI trên cùng một trang thanh toán');
  // =======================================================================================
  {
    const amount = 110000;
    const before = await balanceOf(buyer.user.id);
    const pr = await createTopup(buyer.token, amount);
    const pay = () => api(`/mock-provider/checkout/${pr.providerRef}/pay`, {
      method: 'POST', token: buyer.token, body: { outcome: 'SUCCEEDED', deliverWebhook: true },
    });
    const [p1, p2] = await Promise.all([pay(), pay()]);
    console.log(`  [C1] /pay #1 -> ${p1.status} ${p1.data.error || ''}   /pay #2 -> ${p2.status} ${p2.data.error || ''}`);
    const ok = [p1, p2].filter((r) => r.status === 200);
    const loser = p1.status === 200 ? p2 : p1;
    assert(ok.length === 1, `Đúng một lần thanh toán được chấp nhận (thực tế ${ok.length})`);
    assert(loser.status === 409 && loser.data.error === 'ALREADY_SETTLED', `Lần còn lại 409 ALREADY_SETTLED (nhận ${loser.status} ${loser.data.error})`);
    const row = await prRow(pr.id);
    assert(row.status === 'SUCCEEDED' && row.version === 1, `Yêu cầu SUCCEEDED, version đúng 1 (status=${row.status}, version=${row.version})`);
    assert((await balanceOf(buyer.user.id)) - before === amount, `Ví cộng ĐÚNG MỘT LẦN ${amount}`);
    assert((await creditEntries(pr.id)) === 1, 'Đúng 1 bút toán TOPUP_CREDIT');
    await assertInvariantsOk('Sau C1');
  }

  // =======================================================================================
  section('C2: Cùng một webhook đã ký gửi 6 lần ĐỒNG THỜI');
  // =======================================================================================
  {
    const amount = 120000;
    const before = await balanceOf(buyer.user.id);
    const pr = await createTopup(buyer.token, amount);
    const cb = buildProviderCallback({ paymentRequestId: pr.id, providerRef: pr.providerRef, status: 'SUCCEEDED', amount });
    const results = await Promise.all(Array.from({ length: 6 }, () => postWebhook(cb)));
    const applied = results.filter((r) => r.status === 200 && !r.data.duplicate);
    const dup = results.filter((r) => r.status === 200 && r.data.duplicate === true);
    console.log(`  [C2] ${results.map((r) => `${r.status}${r.data.duplicate ? 'd' : ''}`).join(' ')}`);
    assert(applied.length === 1, `Đúng 1 webhook được áp dụng (thực tế ${applied.length})`);
    assert(dup.length === 5, `5 webhook còn lại trả 200 duplicate:true (thực tế ${dup.length})`);
    assert((await balanceOf(buyer.user.id)) - before === amount, `Ví cộng ĐÚNG MỘT LẦN ${amount}`);
    assert((await creditEntries(pr.id)) === 1, 'Đúng 1 bút toán TOPUP_CREDIT');
    await assertInvariantsOk('Sau C2');
  }

  // =======================================================================================
  section('C3: Webhook SUCCEEDED và FAILED cho cùng yêu cầu gửi ĐỒNG THỜI');
  // =======================================================================================
  {
    const amount = 130000;
    const before = await balanceOf(buyer.user.id);
    const pr = await createTopup(buyer.token, amount);
    const ok = buildProviderCallback({ paymentRequestId: pr.id, providerRef: pr.providerRef, status: 'SUCCEEDED', amount });
    const ko = buildProviderCallback({ paymentRequestId: pr.id, providerRef: pr.providerRef, status: 'FAILED', amount });
    const [rOk, rKo] = await Promise.all([postWebhook(ok), postWebhook(ko)]);
    console.log(`  [C3] SUCCEEDED -> ${rOk.status} ${rOk.data.error || ''}   FAILED -> ${rKo.status} ${rKo.data.error || ''}`);
    const row = await prRow(pr.id);
    const winner = row.status === 'SUCCEEDED' ? rOk : rKo;
    const loser = row.status === 'SUCCEEDED' ? rKo : rOk;
    assert(row.status === 'SUCCEEDED' || row.status === 'FAILED', `Yêu cầu có đúng một kết quả cuối (${row.status})`);
    assert(winner.status === 200 && !winner.data.duplicate, 'Webhook mang kết quả thắng được áp dụng (200)');
    assert(loser.status === 409 && loser.data.error === 'WEBHOOK_CONFLICT', `Webhook trái kết quả bị 409 WEBHOOK_CONFLICT, không ghi đè (nhận ${loser.status} ${loser.data.error})`);
    const delta = (await balanceOf(buyer.user.id)) - before;
    assert(row.status === 'SUCCEEDED' ? delta === amount : delta === 0, `Ví khớp kết quả cuối (Δ=${delta}, status=${row.status})`);
    assert((await creditEntries(pr.id)) === (row.status === 'SUCCEEDED' ? 1 : 0), 'Số bút toán TOPUP_CREDIT khớp kết quả cuối');
    await assertInvariantsOk('Sau C3');
  }

  // =======================================================================================
  section('C4: Webhook thất lạc; webhook gửi lại x3 và 2 tiến trình đối soát chạy CÙNG LÚC');
  // =======================================================================================
  {
    const amount = 140000;
    const before = await balanceOf(buyer.user.id);
    const pr = await createTopup(buyer.token, amount);
    const pay = await api(`/mock-provider/checkout/${pr.providerRef}/pay`, {
      method: 'POST', token: buyer.token, body: { outcome: 'SUCCEEDED', deliverWebhook: false },
    });
    assert(pay.status === 200 && (await prRow(pr.id)).status === 'PENDING', 'Provider đã SUCCEEDED, phía sàn vẫn PENDING');
    const cb = buildProviderCallback({ paymentRequestId: pr.id, providerRef: pr.providerRef, status: 'SUCCEEDED', amount });
    const [w1, w2, w3, k1, k2] = await Promise.all([
      postWebhook(cb), postWebhook(cb), postWebhook(cb), runReconcileProcess(pr.id), runReconcileProcess(pr.id),
    ]);
    const webhookApplied = [w1, w2, w3].filter((r) => r.status === 200 && !r.data.duplicate).length;
    const workerApplied = [k1, k2].reduce((s, k) => s + ((k.summary && k.summary.applied) || 0), 0);
    console.log(`  [C4] webhook áp dụng=${webhookApplied}, worker áp dụng=${workerApplied}, mã thoát worker=${k1.code}/${k2.code}`);
    assert([w1, w2, w3].every((r) => r.status === 200), 'Cả ba webhook đều nhận 200 (áp dụng hoặc duplicate)');
    assert(k1.code === 0 && k2.code === 0, 'Hai tiến trình đối soát kết thúc bình thường');
    assert(webhookApplied + workerApplied === 1, `Tổng cộng ĐÚNG MỘT lần áp dụng giữa webhook và worker (thực tế ${webhookApplied + workerApplied})`);
    const row = await prRow(pr.id);
    assert(row.status === 'SUCCEEDED' && row.version === 1, `Yêu cầu SUCCEEDED, version đúng 1 (version=${row.version})`);
    assert((await balanceOf(buyer.user.id)) - before === amount, `Ví cộng ĐÚNG MỘT LẦN ${amount}`);
    assert((await creditEntries(pr.id)) === 1, 'Đúng 1 bút toán TOPUP_CREDIT');
    await assertInvariantsOk('Sau C4');
  }

  // =======================================================================================
  section('A1: Quản trị viên không tạo được yêu cầu nạp tiền (không có ví)');
  // =======================================================================================
  {
    const r = await api('/api/payments/topup', { method: 'POST', token: admin.token, body: { amount: 100000 } });
    assert(r.status === 400 && r.data.error === 'WALLET_NOT_FOUND', `Bị từ chối 400 WALLET_NOT_FOUND (nhận ${r.status} ${r.data.error})`);
    const n = await db.prepare('SELECT COUNT(*) AS n FROM payment_requests WHERE user_id = ?').get(admin.user.id);
    assert(Number(n.n) === 0, 'Không có bản ghi payment_requests nào của quản trị viên');
    const w = await db.prepare('SELECT COUNT(*) AS n FROM wallets WHERE user_id = ?').get(admin.user.id);
    assert(Number(w.n) === 0, 'Quản trị viên vẫn không có ví');
  }

  // =======================================================================================
  section('A2: Quản trị viên không xem / không "thanh toán hộ" trang checkout của người khác');
  // =======================================================================================
  {
    const amount = 150000;
    const before = await balanceOf(other.user.id);
    const pr = await createTopup(other.token, amount);
    const view = await api(`/mock-provider/checkout/${pr.providerRef}`, { token: admin.token });
    assert(view.status === 404, `Quản trị viên xem trang checkout của người khác bị 404 (nhận ${view.status} ${view.data.error})`);
    const pays = await Promise.all([1, 2].map(() => api(`/mock-provider/checkout/${pr.providerRef}/pay`, {
      method: 'POST', token: admin.token, body: { outcome: 'SUCCEEDED', deliverWebhook: true },
    })));
    assert(pays.every((r) => r.status === 404), `Hai lần quản trị viên bấm thanh toán hộ (đồng thời) đều 404 (nhận ${pays.map((r) => r.status).join('/')})`);
    const buyerPay = await api(`/mock-provider/checkout/${pr.providerRef}/pay`, {
      method: 'POST', token: buyer.token, body: { outcome: 'SUCCEEDED', deliverWebhook: true },
    });
    assert(buyerPay.status === 404, `Người dùng khác cũng bị 404 (nhận ${buyerPay.status})`);
    assert((await prRow(pr.id)).status === 'PENDING' && (await balanceOf(other.user.id)) === before, 'Yêu cầu vẫn PENDING, ví chủ yêu cầu không đổi');
  }

  // =======================================================================================
  section('A3: Quyền quản trị được kiểm đúng; không có điểm cuối cộng tiền cho quản trị viên');
  // =======================================================================================
  {
    for (const p of ['/api/admin/users', '/api/admin/invariants', '/api/admin/disputes']) {
      const r = await api(p, { token: buyer.token });
      assert(r.status === 403, `Người dùng thường gọi ${p} bị 403 (nhận ${r.status})`);
    }
    const anon = await api('/api/admin/invariants');
    assert(anon.status === 401, `Không đăng nhập gọi /api/admin/invariants bị 401 (nhận ${anon.status})`);
    const before = await balanceOf(buyer.user.id);
    for (const p of ['/api/admin/topup', `/api/admin/users/${buyer.user.id}/topup`, `/api/admin/wallets/${buyer.user.id}/credit`]) {
      const r = await api(p, { method: 'POST', token: admin.token, body: { amount: 100000, requestId: 'x' } });
      assert(r.status === 404, `Quản trị viên POST ${p} -> 404, không có đường cộng tiền thủ công (nhận ${r.status})`);
    }
    assert((await balanceOf(buyer.user.id)) === before, 'Ví người dùng không đổi');
    await assertInvariantsOk('Sau A1–A3');
  }

  const inv = await api('/api/admin/invariants', { token: admin.token });
  assert(inv.status === 200 && inv.data.ok === true, `Cuối bộ: /api/admin/invariants báo ${inv.data.checked} bất biến đều đúng`);

  console.log(failures ? `\n${failures} FAIL` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error('[topup-concurrency] lỗi:', e); process.exit(1); });
