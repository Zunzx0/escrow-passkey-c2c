/**
 * E2E cho worker đối soát thanh toán (Payment Reconciliation).
 *
 *   R01  webhook thắng trước worker (webhook chen vào đúng lúc worker đang chờ provider)
 *   R02  worker thắng trước webhook (webhook tới sau thành bản lặp)
 *   R03  hai worker cùng đối soát một yêu cầu, chạy song song ở hai process
 *   R04  worker chạy lại nhiều lần / áp lại cùng một kết quả của provider
 *   R05  provider báo PENDING nhiều lần rồi mới thành công (delayed success)
 *   R06  provider báo FAILED — không cộng tiền
 *   R07  API truy vấn của provider lỗi — giữ nguyên trạng thái an toàn, lần sau hỏi lại được
 *   R08  process worker chết ngang giữa giao dịch cộng tiền — không để lại gì dở dang
 *   R09  kết quả trái chiều giữa worker và webhook — không ghi đè kết quả đã tất toán
 *
 * Worker chạy như MỘT PROCESS RIÊNG (scripts/reconcile.js), không gọi hàm trong cùng process,
 * để cuộc đua giữa worker, webhook và worker thứ hai là cuộc đua thật giữa các process cùng
 * ghi vào một cơ sở dữ liệu. Sau mỗi ca kiểm: payment_request (trạng thái, version, ai tất toán),
 * số dư ví, wallet_entries và toàn bộ bất biến — đọc thẳng từ cơ sở dữ liệu.
 *
 * Yêu cầu: server đang chạy (npm start), KHÔNG bật FAULT_INJECT.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const path = require('path');
const { spawn } = require('child_process');
const fetch = globalThis.fetch || require('node-fetch');
const { flows } = require('./helpers/accounts');
const provider = require('../src/lib/mockPaymentProvider');
const { applyProviderResult } = require('../src/lib/paymentService');
const { checkInvariants } = require('../src/lib/invariants');
const { CRASH_EXIT_CODE } = require('../src/lib/faultInjection');
const { db } = require('../src/db');

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const ROOT = path.join(__dirname, '..');

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

/**
 * Chạy một process worker cho đúng một yêu cầu. `onQuery` được gọi đúng lúc worker in ra
 * "query <id>", tức là đã đọc thấy yêu cầu còn PENDING và đang chờ provider trả lời.
 */
function runWorker(paymentRequestId, { env = {}, onQuery = null } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['scripts/reconcile.js', `--id=${paymentRequestId}`, '--min-age=0'], {
      cwd: ROOT,
      env: { ...process.env, ...env },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => {
      err += d;
      if (onQuery && String(d).includes(`query ${paymentRequestId}`)) {
        const fn = onQuery;
        onQuery = null;
        fn();
      }
    });
    child.on('close', (code) => {
      let summary = null;
      try { summary = JSON.parse(out.trim().split('\n').pop()); } catch (_) {}
      const result = summary && summary.results.find((r) => r.id === paymentRequestId);
      resolve({ code, summary, outcome: result ? result.outcome : 'NOT_SCANNED', stderr: err });
    });
  });
}

function prRow(id) {
  return db.prepare('SELECT * FROM payment_requests WHERE id = ?').get(id);
}
async function balanceOf(userId) {
  return (await db.prepare('SELECT available_balance FROM wallets WHERE user_id = ?').get(userId)).available_balance;
}
async function entryCount(id) {
  return (await db.prepare('SELECT COUNT(*) AS n FROM wallet_entries WHERE request_id = ?').get(id)).n;
}
async function assertInvariants(label) {
  const r = await checkInvariants(db);
  assert(r.ok, `Mọi bất biến vẫn đúng sau ${label}${r.ok ? '' : ': ' + JSON.stringify(r.violations)}`);
}

async function main() {
  console.log(`\n=== E2E ĐỐI SOÁT THANH TOÁN (RECONCILIATION): ${BASE} ===`);
  const rand = Date.now();

  const health = await api('/health');
  const jobs = (health.data && health.data.backgroundJobs) || {};
  if (jobs.reconcileIntervalSeconds > 0 && jobs.reconcileMinAgeSeconds < 15) {
    console.log('  ⚠  Worker trong máy chủ có ngưỡng tuổi < 15s, có thể chen vào các ca dưới đây.');
  }

  const buyer = await flows.registerUser({ username: `rec_buy_${rand}`, displayName: 'Buyer Reconcile' });
  const userId = buyer.user.id;

  async function newTopup(amount) {
    const r = await api('/api/payments/topup', { method: 'POST', token: buyer.token, body: { amount } });
    if (r.status !== 201) throw new Error(`Không tạo được yêu cầu nạp tiền: ${JSON.stringify(r.data)}`);
    return r.data;
  }
  function postWebhook({ payload, signature }) {
    return api('/api/payments/webhook', { method: 'POST', body: { payload, signature } });
  }

  // ---------------------------------------------------------------------- R01
  section('R01: Webhook thắng trước worker — webhook chen vào lúc worker đang chờ provider');
  {
    const AMOUNT = 100000;
    const before = await balanceOf(userId);
    const topup = await newTopup(AMOUNT);
    const callback = await provider.settlePayment(topup.providerRef, 'SUCCEEDED');

    let webhookPromise = null;
    const worker = await runWorker(topup.id, {
      env: { MOCK_PROVIDER_LATENCY_MS: '1500' },
      onQuery: () => { webhookPromise = postWebhook(callback); },
    });
    const webhook = await webhookPromise;

    assert(webhook && webhook.status === 200 && webhook.data.duplicate !== true, 'Webhook tới trong lúc worker chờ provider và tất toán trước');
    assert(worker.code === 0 && worker.outcome === 'DUPLICATE', `Worker tới sau nhận DUPLICATE, không tất toán lần hai (nhận ${worker.outcome})`);
    const pr = await prRow(topup.id);
    assert(pr.status === 'SUCCEEDED' && pr.resolved_by === 'WEBHOOK', `Tất toán bởi WEBHOOK (thực tế ${pr.resolved_by})`);
    assert(pr.version === 1, `version tăng đúng 1 lần (thực tế ${pr.version})`);
    assert((await balanceOf(userId)) - before === AMOUNT, 'Ví cộng đúng MỘT lần');
    assert((await entryCount(topup.id)) === 1, 'Đúng 1 wallet_entry');
    await assertInvariants('R01');
  }

  // ---------------------------------------------------------------------- R02
  section('R02: Worker thắng trước webhook — webhook tới sau trở thành bản lặp');
  {
    const AMOUNT = 110000;
    const before = await balanceOf(userId);
    const topup = await newTopup(AMOUNT);
    const callback = await provider.settlePayment(topup.providerRef, 'SUCCEEDED'); // webhook "đang trên đường"

    const worker = await runWorker(topup.id);
    assert(worker.code === 0 && worker.outcome === 'APPLIED', `Worker phát hiện kết quả và tất toán (nhận ${worker.outcome})`);

    const webhook = await postWebhook(callback);
    assert(webhook.status === 200 && webhook.data.duplicate === true, 'Webhook tới sau được nhận diện là bản lặp, trả 200');

    const pr = await prRow(topup.id);
    assert(pr.status === 'SUCCEEDED' && pr.resolved_by === 'RECONCILER', `Tất toán bởi RECONCILER (thực tế ${pr.resolved_by})`);
    assert(pr.version === 1, `version tăng đúng 1 lần (thực tế ${pr.version})`);
    assert((await balanceOf(userId)) - before === AMOUNT, 'Ví cộng đúng MỘT lần');
    assert((await entryCount(topup.id)) === 1, 'Đúng 1 wallet_entry');
    await assertInvariants('R02');
  }

  // ---------------------------------------------------------------------- R03
  section('R03: Hai worker cùng đối soát một yêu cầu, chạy song song ở hai process');
  {
    const AMOUNT = 120000;
    const before = await balanceOf(userId);
    const topup = await newTopup(AMOUNT);
    await provider.settlePayment(topup.providerRef, 'SUCCEEDED'); // webhook thất lạc

    const env = { MOCK_PROVIDER_LATENCY_MS: '1500' };
    const [a, b] = await Promise.all([runWorker(topup.id, { env }), runWorker(topup.id, { env })]);
    const outcomes = [a.outcome, b.outcome];
    const appliedCount = outcomes.filter((o) => o === 'APPLIED').length;
    assert(a.code === 0 && b.code === 0, 'Cả hai process worker kết thúc bình thường');
    assert(appliedCount === 1, `Đúng MỘT worker tất toán (kết quả: ${outcomes.join(' / ')})`);
    assert(outcomes.includes('DUPLICATE'), 'Worker còn lại đã thật sự đua (đọc thấy PENDING) và nhận DUPLICATE');
    const pr = await prRow(topup.id);
    assert(pr.status === 'SUCCEEDED' && pr.version === 1, `SUCCEEDED, version = 1 (thực tế ${pr.version})`);
    assert((await balanceOf(userId)) - before === AMOUNT, 'Ví cộng đúng MỘT lần dù hai worker cùng chạy');
    assert((await entryCount(topup.id)) === 1, 'Đúng 1 wallet_entry');
    await assertInvariants('R03');
  }

  // ---------------------------------------------------------------------- R04
  section('R04: Worker chạy lại nhiều lần và áp lại cùng một kết quả của provider');
  {
    const AMOUNT = 130000;
    const before = await balanceOf(userId);
    const topup = await newTopup(AMOUNT);
    await provider.settlePayment(topup.providerRef, 'SUCCEEDED');

    const first = await runWorker(topup.id);
    const second = await runWorker(topup.id);
    const third = await runWorker(topup.id);
    assert(first.outcome === 'APPLIED', `Lượt 1 tất toán (nhận ${first.outcome})`);
    assert(second.outcome === 'NOT_SCANNED' && third.outcome === 'NOT_SCANNED',
      'Lượt 2 và 3 không còn gì để đối soát (yêu cầu đã rời PENDING)');

    // Áp lại đúng kết quả đó qua chính service dùng chung — mô phỏng một worker thử lại sau khi
    // mất kết nối đúng lúc vừa ghi xong.
    const retries = [];
    for (let i = 0; i < 2; i++) {
      retries.push(await applyProviderResult({
        paymentRequestId: topup.id, providerRef: topup.providerRef, status: 'SUCCEEDED', amount: AMOUNT, source: 'RECONCILER',
      }));
    }
    assert(retries.every((r) => r.outcome === 'DUPLICATE'), 'Áp lại cùng kết quả hai lần đều nhận DUPLICATE');

    const pr = await prRow(topup.id);
    assert(pr.version === 1 && pr.reconcile_attempts === 1, `version = 1, chỉ 1 lần hỏi provider (thực tế v${pr.version}, ${pr.reconcile_attempts} lần)`);
    assert((await balanceOf(userId)) - before === AMOUNT, 'Ví cộng đúng MỘT lần');
    assert((await entryCount(topup.id)) === 1, 'Đúng 1 wallet_entry');
    await assertInvariants('R04');
  }

  // ---------------------------------------------------------------------- R05
  section('R05: Provider báo PENDING nhiều lần rồi mới thành công (delayed success)');
  {
    const AMOUNT = 140000;
    const before = await balanceOf(userId);
    const topup = await newTopup(AMOUNT);

    for (let i = 1; i <= 3; i++) {
      const w = await runWorker(topup.id);
      assert(w.outcome === 'STILL_PENDING', `Lượt ${i}: provider còn PENDING, yêu cầu giữ nguyên (nhận ${w.outcome})`);
    }
    let pr = await prRow(topup.id);
    assert(pr.status === 'PENDING' && pr.version === 0, 'Sau 3 lượt: vẫn PENDING, version chưa đổi — không tự coi là thất bại');
    assert(pr.reconcile_attempts === 3, `Ghi nhận đủ 3 lần hỏi provider (thực tế ${pr.reconcile_attempts})`);
    assert((await balanceOf(userId)) === before && (await entryCount(topup.id)) === 0, 'Chưa có tiền nào được cộng');

    await provider.settlePayment(topup.providerRef, 'SUCCEEDED');
    const w = await runWorker(topup.id);
    assert(w.outcome === 'APPLIED', `Provider thành công muộn thì lượt kế tiếp tất toán (nhận ${w.outcome})`);
    pr = await prRow(topup.id);
    assert(pr.status === 'SUCCEEDED' && pr.version === 1 && pr.reconcile_attempts === 4, 'SUCCEEDED, version = 1, tổng 4 lần hỏi');
    assert((await balanceOf(userId)) - before === AMOUNT && (await entryCount(topup.id)) === 1, 'Ví cộng đúng MỘT lần, 1 wallet_entry');
    await assertInvariants('R05');
  }

  // ---------------------------------------------------------------------- R06
  section('R06: Provider báo FAILED — không cộng tiền');
  {
    const AMOUNT = 150000;
    const before = await balanceOf(userId);
    const topup = await newTopup(AMOUNT);
    await provider.settlePayment(topup.providerRef, 'FAILED');

    const w = await runWorker(topup.id);
    assert(w.outcome === 'APPLIED', `Worker tất toán kết quả FAILED (nhận ${w.outcome})`);
    const pr = await prRow(topup.id);
    assert(pr.status === 'FAILED' && pr.resolved_by === 'RECONCILER' && pr.version === 1, 'FAILED, tất toán bởi RECONCILER, version = 1');
    assert((await balanceOf(userId)) === before, 'Ví KHÔNG đổi');
    assert((await entryCount(topup.id)) === 0, 'Không có wallet_entry nào');
    await assertInvariants('R06');
  }

  // ---------------------------------------------------------------------- R07
  section('R07: API truy vấn của provider lỗi — giữ trạng thái an toàn, lần sau hỏi lại được');
  {
    const AMOUNT = 160000;
    const before = await balanceOf(userId);
    const topup = await newTopup(AMOUNT);
    await provider.settlePayment(topup.providerRef, 'SUCCEEDED');
    await provider.setQueryMode(topup.providerRef, 'ERROR');

    const failed = await runWorker(topup.id);
    assert(failed.code === 0 && failed.outcome === 'PROVIDER_ERROR', `Worker ghi nhận lỗi provider, không sập (nhận ${failed.outcome})`);
    let pr = await prRow(topup.id);
    assert(pr.status === 'PENDING' && pr.version === 0, 'Yêu cầu vẫn PENDING — lỗi provider không bị coi là FAILED');
    assert(String(pr.last_reconcile_error || '').includes('PROVIDER_UNAVAILABLE'), 'Lỗi được ghi lại ở last_reconcile_error');
    assert((await balanceOf(userId)) === before && (await entryCount(topup.id)) === 0, 'Chưa có tiền nào được cộng');

    await provider.setQueryMode(topup.providerRef, 'NORMAL');
    const ok = await runWorker(topup.id);
    assert(ok.outcome === 'APPLIED', `Provider hoạt động lại thì lượt kế tiếp tất toán (nhận ${ok.outcome})`);
    pr = await prRow(topup.id);
    assert(pr.status === 'SUCCEEDED' && pr.last_reconcile_error === null, 'SUCCEEDED và vết lỗi cũ đã được xoá');
    assert((await balanceOf(userId)) - before === AMOUNT && (await entryCount(topup.id)) === 1, 'Ví cộng đúng MỘT lần');
    await assertInvariants('R07');
  }

  // ---------------------------------------------------------------------- R08
  section('R08: Process worker chết ngang giữa giao dịch cộng tiền');
  {
    const AMOUNT = 170000;
    const before = await balanceOf(userId);
    const topup = await newTopup(AMOUNT);
    await provider.settlePayment(topup.providerRef, 'SUCCEEDED');

    // Chết đúng lúc số dư đã được cộng TRONG giao dịch nhưng bút toán chưa ghi và chưa commit.
    const crashed = await runWorker(topup.id, {
      env: { FAULT_INJECT: 'topup:after-wallet-update', FAULT_INJECT_MODE: 'crash' },
    });
    assert(crashed.code === CRASH_EXIT_CODE, `Process worker chết giữa chừng (mã thoát ${crashed.code})`);

    let pr = await prRow(topup.id);
    assert(pr.status === 'PENDING' && pr.version === 0 && pr.resolved_by === null, 'Yêu cầu vẫn PENDING, version chưa đổi — phần ghi dở không được commit');
    assert((await balanceOf(userId)) === before, 'Số dư KHÔNG đổi dù process đã cộng tiền trong giao dịch trước khi chết');
    assert((await entryCount(topup.id)) === 0, 'Không có wallet_entry mồ côi');
    await assertInvariants('R08 (ngay sau khi process chết)');

    const recovered = await runWorker(topup.id);
    assert(recovered.outcome === 'APPLIED', `Lượt đối soát kế tiếp tất toán bình thường (nhận ${recovered.outcome})`);
    pr = await prRow(topup.id);
    assert(pr.status === 'SUCCEEDED' && pr.version === 1, 'SUCCEEDED, version = 1');
    assert((await balanceOf(userId)) - before === AMOUNT && (await entryCount(topup.id)) === 1, 'Ví cộng đúng MỘT lần sau khi phục hồi');
    await assertInvariants('R08 (sau khi phục hồi)');
  }

  // ---------------------------------------------------------------------- R09
  section('R09: Worker đã tất toán FAILED, webhook trái chiều tới sau không được ghi đè');
  {
    const AMOUNT = 180000;
    const before = await balanceOf(userId);
    const topup = await newTopup(AMOUNT);
    await provider.settlePayment(topup.providerRef, 'FAILED');

    const w = await runWorker(topup.id);
    assert(w.outcome === 'APPLIED', 'Worker tất toán FAILED');
    const contrary = provider.buildProviderCallback({
      paymentRequestId: topup.id, providerRef: topup.providerRef, status: 'SUCCEEDED', amount: AMOUNT,
    });
    const webhook = await postWebhook(contrary);
    assert(webhook.status === 409 && webhook.data.error === 'WEBHOOK_CONFLICT', `Webhook trái chiều bị từ chối (nhận ${webhook.status} ${webhook.data.error})`);
    const pr = await prRow(topup.id);
    assert(pr.status === 'FAILED' && pr.version === 1, 'Vẫn FAILED, version = 1 — không bị lật');
    assert((await balanceOf(userId)) === before && (await entryCount(topup.id)) === 0, 'Ví KHÔNG đổi');
    await assertInvariants('R09');
  }

  console.log(failures === 0 ? '\n=== KẾT QUẢ: TẤT CẢ PASS ✅ ===\n' : `\n=== KẾT QUẢ: ${failures} KIỂM THỬ THẤT BẠI ❌ ===\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('LỖI KHÔNG MONG ĐỢI:', e);
  process.exit(1);
});
