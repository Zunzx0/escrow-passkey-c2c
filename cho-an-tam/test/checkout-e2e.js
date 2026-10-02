/**
 * E2E cho đúng các lối mà giao diện dùng khi nạp tiền và xem chi tiết đơn.
 *
 *   K01  trang thanh toán của provider trả đúng thông tin, "thanh toán thành công" -> provider gửi
 *        webhook qua HTTP thật -> ví được cộng (trang của provider KHÔNG tự cộng ví)
 *   K02  "thành công nhưng webhook thất lạc" -> ví CHƯA đổi, yêu cầu vẫn PENDING; worker đối soát
 *        phát hiện và tất toán
 *   K03  "thanh toán thất bại" -> ví không đổi
 *   K04  không "thanh toán lại" được một khoản đã có kết quả ở provider
 *   K05  chi tiết giao dịch mang kèm hồ sơ tranh chấp cho cả hai bên
 *
 * Yêu cầu: server đang chạy (npm start) với MOCK_PROVIDER_CHECKOUT khác 0.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const fetch = globalThis.fetch || require('node-fetch');
const { flows } = require('./helpers/accounts');
const { checkInvariants } = require('../src/lib/invariants');
const { db } = require('../src/db');

const BASE = process.env.BASE_URL || 'http://localhost:3000';

let failures = 0;
function assert(cond, label) {
  console.log(`  ${cond ? '✅' : '❌'} ${label}`);
  if (!cond) failures++;
}
function section(title) { console.log(`\n${title}`); }

async function http(p, opts = {}, retried = false) {
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
    return http(p, opts, true);
  }
  return { status: res.status, data };
}

const balanceOf = (userId) => db.prepare('SELECT available_balance FROM wallets WHERE user_id = ?').get(userId).available_balance;
const prRow = (id) => db.prepare('SELECT * FROM payment_requests WHERE id = ?').get(id);

async function main() {
  console.log(`\n=== E2E LUỒNG GIAO DIỆN: NẠP TIỀN QUA CỔNG THANH TOÁN + CHI TIẾT ĐƠN: ${BASE} ===`);
  const rand = Date.now();
  const buyer = await flows.registerUser({ username: `ck_buy_${rand}`, displayName: 'Checkout Buyer' });

  async function topup(amount) {
    const r = await http('/api/payments/topup', { method: 'POST', token: buyer.token, body: { amount } });
    return r.data;
  }

  section('K01: Thanh toán thành công ở cổng -> webhook qua HTTP thật -> ví được cộng');
  {
    const before = balanceOf(buyer.user.id);
    const pr = await topup(200000);
    const page = await http(`/mock-provider/checkout/${pr.providerRef}`, { token: buyer.token });
    assert(page.status === 200 && page.data.amount === 200000 && page.data.status === 'PENDING', 'Trang của cổng thanh toán hiển thị đúng số tiền, trạng thái PENDING');

    const pay = await http(`/mock-provider/checkout/${pr.providerRef}/pay`, { method: 'POST', token: buyer.token, body: { outcome: 'SUCCEEDED', deliverWebhook: true } });
    assert(pay.status === 200 && pay.data.webhook.delivered && pay.data.webhook.status === 200, 'Cổng thanh toán gửi được webhook về máy chủ (HTTP 200)');
    const row = prRow(pr.id);
    assert(row.status === 'SUCCEEDED' && row.resolved_by === 'WEBHOOK', 'Yêu cầu tất toán SUCCEEDED qua WEBHOOK');
    assert(balanceOf(buyer.user.id) - before === 200000, 'Ví cộng đúng 200.000₫');
  }

  section('K02: Thành công nhưng webhook thất lạc -> chỉ đối soát mới phát hiện');
  {
    const before = balanceOf(buyer.user.id);
    const pr = await topup(150000);
    const pay = await http(`/mock-provider/checkout/${pr.providerRef}/pay`, { method: 'POST', token: buyer.token, body: { outcome: 'SUCCEEDED', deliverWebhook: false } });
    assert(pay.status === 200 && pay.data.webhook.skipped, 'Cổng thanh toán ghi nhận thành công nhưng không gửi webhook');
    assert(prRow(pr.id).status === 'PENDING', 'Phía sàn vẫn PENDING — trang của cổng thanh toán không tự cộng ví');
    assert(balanceOf(buyer.user.id) === before, 'Ví CHƯA đổi');

    const run = spawnSync(process.execPath, ['scripts/reconcile.js', `--id=${pr.id}`, '--min-age=0'], {
      cwd: path.join(__dirname, '..'), env: process.env, encoding: 'utf8',
    });
    const summary = JSON.parse(run.stdout.trim().split('\n').pop());
    assert(summary.applied === 1, 'Worker đối soát phát hiện kết quả và tất toán');
    const row = prRow(pr.id);
    assert(row.status === 'SUCCEEDED' && row.resolved_by === 'RECONCILER', 'Yêu cầu tất toán SUCCEEDED qua RECONCILER');
    assert(balanceOf(buyer.user.id) - before === 150000, 'Ví cộng đúng 150.000₫');
  }

  section('K03: Thanh toán thất bại -> ví không đổi');
  {
    const before = balanceOf(buyer.user.id);
    const pr = await topup(120000);
    await http(`/mock-provider/checkout/${pr.providerRef}/pay`, { method: 'POST', token: buyer.token, body: { outcome: 'FAILED', deliverWebhook: true } });
    assert(prRow(pr.id).status === 'FAILED', 'Yêu cầu tất toán FAILED');
    assert(balanceOf(buyer.user.id) === before, 'Ví KHÔNG đổi');

    section('K04: Không "thanh toán lại" được khoản đã có kết quả ở cổng');
    const again = await http(`/mock-provider/checkout/${pr.providerRef}/pay`, { method: 'POST', token: buyer.token, body: { outcome: 'SUCCEEDED', deliverWebhook: true } });
    assert(again.status === 409 && again.data.error === 'ALREADY_SETTLED', `Bị từ chối (nhận ${again.status} ${again.data.error})`);
    assert(prRow(pr.id).status === 'FAILED' && balanceOf(buyer.user.id) === before, 'Trạng thái và ví giữ nguyên');
  }

  section('K05: Chi tiết giao dịch mang kèm hồ sơ tranh chấp cho cả hai bên');
  {
    const admin = await flows.createAdmin({ username: `ck_adm_${rand}`, displayName: 'Checkout Admin' });
    const seller = await flows.createSeller(admin, { username: `ck_sel_${rand}`, displayName: 'Checkout Seller' });
    const listing = await http('/api/listings', { method: 'POST', token: seller.token, body: { title: `Sách cũ ${rand}`, category: 'SACH', price: 90000, location: 'Hà Nội' } });
    const order = await http('/api/transactions/orders', { method: 'POST', token: buyer.token, body: { listingId: listing.data.id } });
    const id = order.data.id;
    await http(`/api/transactions/${id}/secure`, { method: 'POST', token: buyer.token, body: { requestId: crypto.randomUUID() } });
    await http(`/api/transactions/${id}/ship`, { method: 'POST', token: seller.token, body: {} });

    const sellerWaitConfirm = await http(`/api/transactions/${id}/wait-confirm`, { method: 'POST', token: seller.token, body: {} });
    assert(sellerWaitConfirm.status === 403, `Người BÁN không tự chuyển đơn sang "đã nhận hàng" được (nhận ${sellerWaitConfirm.status}) — khớp nút giao diện đã sửa`);
    const buyerWaitConfirm = await http(`/api/transactions/${id}/wait-confirm`, { method: 'POST', token: buyer.token, body: {} });
    assert(buyerWaitConfirm.status === 200, 'Người MUA xác nhận đã nhận hàng');

    await http(`/api/transactions/${id}/dispute`, { method: 'POST', token: buyer.token, body: { reason: 'Thiếu phụ kiện' } });
    const asBuyer = await http(`/api/transactions/${id}`, { token: buyer.token });
    const asSeller = await http(`/api/transactions/${id}`, { token: seller.token });
    assert(asBuyer.data.dispute && asBuyer.data.dispute.status === 'OPEN' && asBuyer.data.dispute.openedBy === 'BUYER', 'Người mua thấy hồ sơ tranh chấp đang mở');
    assert(asSeller.data.dispute && asSeller.data.dispute.reason === 'Thiếu phụ kiện', 'Người bán thấy đúng lý do tranh chấp');
  }

  const inv = checkInvariants(db);
  assert(inv.ok, `Chín bất biến vẫn đúng${inv.ok ? '' : ': ' + JSON.stringify(inv.violations)}`);

  console.log(failures === 0 ? '\n=== KẾT QUẢ: TẤT CẢ PASS ✅ ===\n' : `\n=== KẾT QUẢ: ${failures} KIỂM THỬ THẤT BẠI ❌ ===\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('LỖI KHÔNG MONG ĐỢI:', e);
  process.exit(1);
});
