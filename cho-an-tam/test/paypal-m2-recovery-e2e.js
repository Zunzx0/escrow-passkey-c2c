'use strict';
// M2 — phục hồi sau sự cố tiến trình thật: crash giữa commit, POST treo rồi tiến trình chết, khởi động lại
// và đối soát/nhận lại quyền. Trạng thái PayPal (fake) nằm trong file nên sống qua các tiến trình.
// Chạy: APP_ENV=test DB_PATH=data/test/... node test/paypal-m2-recovery-e2e.js
const H = require('./helpers/paypal-m2-harness');
const { statePath } = H.init('recovery');
H.resetFake(statePath);

const path = require('path');
const { spawnSync, spawn } = require('child_process');
const { createDurableFake } = require('./helpers/paypal-m2-fake');
const CHILD = path.join(__dirname, 'helpers', 'paypal-m2-child.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, label, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await sleep(25); }
  throw new Error(`hết thời gian chờ: ${label}`);
}

function childEnv(extra) {
  return { ...process.env, PPM2_STATE: statePath, ...extra };
}

async function main() {
  const { db, uuid } = require('../src/db');
  const { createSandboxProvider } = require('../src/lib/paypalSandboxProvider');
  const { createPayPalRuntime } = require('../src/lib/paypalRuntime');

  const t = H.tally('M2 phục hồi');
  const cfg = H.config();                                  // timeout 500 ms
  const cfgLong = H.config({ timeoutMs: 5000, leaseMs: 30000 });
  const makeRuntime = (c = cfg) => createPayPalRuntime({ config: c,
    provider: createSandboxProvider(c, { fetchImpl: createDurableFake({ statePath }).fetchImpl }) });
  const fakeView = () => createDurableFake({ statePath });
  const buyer = await H.createAccount(db, { label: 'rc-buyer' });
  const balance = async () => Number((await H.wallet(db, buyer.id)).available_balance);
  const bindingRow = (id) => db.prepare('SELECT * FROM paypal_payment_bindings WHERE payment_request_id = ?').get(id);
  const requestRow = (id) => db.prepare('SELECT status FROM payment_requests WHERE id = ?').get(id);
  const expireLease = (id) => db.prepare('UPDATE paypal_payment_bindings SET capture_claimed_at = ? WHERE payment_request_id = ?')
    .run('2000-01-01T00:00:00.000Z', id);
  const newApproved = async (amount) => {
    const r = await makeRuntime().create({ userId: buyer.id, amount, requestId: 'rc-' + uuid() });
    fakeView().approve(r.orderId);
    return r;
  };

  // ===================================================================================
  t.section('R1 — tiến trình con crash ngay trước commit (sau khi ghi số dư và bút toán)');
  {
    const r = await newApproved(21000);
    const before = await balance();
    const child = spawnSync(process.execPath, [CHILD], { cwd: H.ROOT, encoding: 'utf8', timeout: 60000,
      env: childEnv({ PPM2_REQUEST: r.id, PPM2_USER: buyer.id, FAULT_INJECT: 'paypal-topup:before-status-change', FAULT_INJECT_MODE: 'crash' }) });
    t.eq(child.status, 97, 'tiến trình con thoát với mã 97 (crash giả lập trước commit)');
    t.eq(fakeView().order(r.orderId).status, 'COMPLETED', 'PayPal đã thu tiền trước khi crash');
    t.eq((await requestRow(r.id)).status, 'PENDING', 'sau crash: request vẫn PENDING, không SUCCEEDED dở dang');
    t.eq((await H.credits(db, r.id)).length, 0, 'sau crash: không có bút toán dở dang');
    t.eq(await balance(), before, 'sau crash: số dư không đổi');
    const b = await bindingRow(r.id);
    t.ok(b.capture_claim && b.capture_post_sent_at && b.capture_state === 'IN_FLIGHT',
      'sau crash: bằng chứng còn IN_FLIGHT với dấu đã POST (chưa ai xác nhận)');
    const restarted = makeRuntime();
    t.eq((await restarted.capture(r.id, buyer.id)).outcome, 'BUSY',
      'khởi động lại trong lúc lease còn hạn: capture trả BUSY, không POST lần hai');
    t.eq(fakeView().countCalls('capture', r.orderId), 1, 'vẫn đúng một lệnh thu ở PayPal');
    t.eq((await restarted.reconcileOne(r.id)).outcome, 'APPLIED', 'đối soát sau khởi động: tất toán đúng một lần');
    t.eq((await H.credits(db, r.id)).length, 1, 'đúng một bút toán');
    t.eq(await balance(), before + 21000, 'ví tăng đúng một lần');
    t.eq((await restarted.reconcileOne(r.id)).outcome, 'DUPLICATE', 'đối soát lần nữa: DUPLICATE, không cộng thêm');
    t.eq(await balance(), before + 21000, 'vẫn đúng một lần sau đối soát lặp');
  }

  t.section('R2 — tiến trình con crash sau khi ghi bút toán, trước commit (điểm thứ nhất)');
  {
    const r = await newApproved(22000);
    const before = await balance();
    const child = spawnSync(process.execPath, [CHILD], { cwd: H.ROOT, encoding: 'utf8', timeout: 60000,
      env: childEnv({ PPM2_REQUEST: r.id, PPM2_USER: buyer.id, FAULT_INJECT: 'paypal-topup:after-wallet-update', FAULT_INJECT_MODE: 'crash' }) });
    t.eq(child.status, 97, 'tiến trình con thoát với mã 97');
    t.eq((await H.credits(db, r.id)).length, 0, 'bút toán đã ghi trước crash bị rollback');
    t.eq(await balance(), before, 'số dư không đổi sau crash');
    t.eq((await makeRuntime().reconcileOne(r.id)).outcome, 'APPLIED', 'đối soát sau crash: tất toán đúng một lần');
    t.eq(await balance(), before + 22000, 'ví tăng đúng một lần sau phục hồi');
  }

  t.section('R3 — tiến trình con bị giết khi POST đang treo; khởi động lại; lệnh treo hoàn tất muộn');
  {
    const r = await newApproved(23000);
    const before = await balance();
    const child = spawn(process.execPath, [CHILD], { cwd: H.ROOT, stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv({ PPM2_REQUEST: r.id, PPM2_USER: buyer.id, PPM2_PLAN: 'hold', PPM2_TIMEOUT_MS: '5000', PPM2_LEASE_MS: '30000' }) });
    await waitFor(async () => fakeView().pendingEffects().length >= 1 && Boolean((await bindingRow(r.id))?.capture_post_sent_at),
      'POST đã gửi và đang treo');
    const orphan = fakeView().pendingEffects()[0];
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
    t.ok(fakeView().pendingEffects().includes(orphan), 'lệnh treo còn trong trạng thái bền sau khi tiến trình chết (fake sống qua restart)');
    t.eq(fakeView().order(r.orderId).status, 'APPROVED', 'PayPal chưa thu khi lệnh treo còn treo');
    const restarted = makeRuntime(cfgLong);
    t.eq((await restarted.capture(r.id, buyer.id)).outcome, 'BUSY', 'khởi động lại khi lease cũ còn hạn: BUSY, không POST');
    t.eq(fakeView().countCalls('capture', r.orderId), 1, 'chỉ lệnh treo của tiến trình cũ');
    await expireLease(r.id);
    const winner = await restarted.capture(r.id, buyer.id);
    t.eq(winner.outcome, 'APPLIED', 'sau khi lease hết hạn: tiến trình mới thu và tất toán');
    t.eq(fakeView().countCalls('capture', r.orderId), 2, 'hai lệnh thu ở phía PayPal (cũ treo, mới)');
    fakeView().completeEffect(orphan);
    t.eq(fakeView().order(r.orderId).status, 'COMPLETED', 'lệnh cũ hoàn tất muộn không làm đổi trạng thái đã thu');
    t.eq((await H.credits(db, r.id)).length, 1, 'đúng một bút toán dù lệnh cũ hoàn tất muộn');
    t.eq(await balance(), before + 23000, 'ví tăng đúng một lần');
  }

  t.section('R4 — tiến trình con bị giết khi POST treo; lệnh treo hoàn tất; khởi động lại chỉ đối soát (GET)');
  {
    const r = await newApproved(24000);
    const before = await balance();
    const child = spawn(process.execPath, [CHILD], { cwd: H.ROOT, stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv({ PPM2_REQUEST: r.id, PPM2_USER: buyer.id, PPM2_PLAN: 'hold', PPM2_TIMEOUT_MS: '5000', PPM2_LEASE_MS: '30000' }) });
    await waitFor(async () => fakeView().pendingEffects().length >= 1 && Boolean((await bindingRow(r.id))?.capture_post_sent_at),
      'POST đã gửi và đang treo');
    const orphan = fakeView().pendingEffects()[0];
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
    fakeView().completeEffect(orphan);
    t.eq(fakeView().order(r.orderId).status, 'COMPLETED', 'PayPal đã thu theo lệnh treo hoàn tất');
    const restarted = makeRuntime();
    const posts = fakeView().countCalls('capture', r.orderId);
    t.eq((await restarted.reconcileOne(r.id)).outcome, 'APPLIED', 'khởi động lại: đối soát bằng GET tất toán một lần');
    t.eq(fakeView().countCalls('capture', r.orderId), posts, 'đối soát không gửi lệnh thu nào');
    t.eq((await H.credits(db, r.id)).length, 1, 'đúng một bút toán');
    t.eq(await balance(), before + 24000, 'ví tăng đúng một lần');
  }

  t.section('Bất biến sau các sự cố');
  const inv = await H.invariantSummary(db);
  t.ok(inv.paypalOk, 'ba bất biến PayPal đúng sau mọi sự cố');
  t.ok(inv.coreOk, `chín bất biến cũ đúng (đã kiểm ${inv.coreChecked})`, JSON.stringify(inv.coreViolations).slice(0, 300));

  const { fail } = t.summary();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e.stack); process.exit(1); });
