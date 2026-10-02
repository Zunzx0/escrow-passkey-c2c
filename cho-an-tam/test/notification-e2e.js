/**
 * E2E cho thông báo và "Việc cần xử lý".
 *
 *   N01  mỗi bước vòng đời đơn hàng sinh đúng thông báo cho đúng người
 *   N02  "Việc cần xử lý" bám trạng thái thật — xoá hết thông báo thì việc vẫn còn đó
 *   N03  tranh chấp và phân xử: báo cho bên kia, cho quản trị viên, rồi cho cả hai bên
 *   N04  giải ngân thông thường báo cho người bán
 *   N05  nạp tiền: thành công/thất bại đều báo; webhook lặp KHÔNG sinh thông báo thừa
 *   N06  đọc/đánh dấu đã đọc chỉ trên thông báo của chính mình
 *   N07  bảng thông báo hỏng thì nghiệp vụ VẪN thành công — thông báo không bao giờ quyết định trạng thái
 *
 * Yêu cầu: server đang chạy (npm start).
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const crypto = require('crypto');
const fetch = globalThis.fetch || require('node-fetch');
const { flows } = require('./helpers/accounts');
const provider = require('../src/lib/mockPaymentProvider');
const { db } = require('../src/db');

const BASE = process.env.BASE_URL || 'http://localhost:3000';

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

async function notes(user, type, { transactionId, paymentRequestId } = {}) {
  const r = await api('/api/notifications?limit=100', { token: user.token });
  return r.data.notifications.filter((n) => n.type === type
    && (!transactionId || n.transactionId === transactionId)
    && (!paymentRequestId || n.paymentRequestId === paymentRequestId));
}
async function todo(user) {
  return (await api('/api/notifications/todo', { token: user.token })).data.items;
}
const hasTodo = (items, kind, transactionId) => items.some((i) => i.kind === kind && (!transactionId || i.transactionId === transactionId));

async function main() {
  console.log(`\n=== E2E THÔNG BÁO + VIỆC CẦN XỬ LÝ: ${BASE} ===`);
  const rand = Date.now();

  const admin = await flows.createAdmin({ username: `ntf_adm_${rand}`, displayName: 'Admin Notify' });
  const seller = await flows.createSeller(admin, { username: `ntf_sel_${rand}`, displayName: 'Seller Notify' });
  const buyer = await flows.registerUser({ username: `ntf_buy_${rand}`, displayName: 'Buyer Notify' });
  const outsider = await flows.registerUser({ username: `ntf_out_${rand}`, displayName: 'Outsider' });

  async function newOrder(title, price) {
    const listing = await api('/api/listings', {
      method: 'POST', token: seller.token, body: { title, category: 'DIEN_THOAI', price, location: 'Hà Nội' },
    });
    const order = await api('/api/transactions/orders', {
      method: 'POST', token: buyer.token, body: { listingId: listing.data.id },
    });
    return order.data.id;
  }
  const step = (path, user, body = {}) => api(`/api/transactions/${path}`, { method: 'POST', token: user.token, body });

  // ---------------------------------------------------------------------- N01 + N02
  section('N01: Mỗi bước vòng đời đơn hàng sinh đúng thông báo cho đúng người');
  const t1 = await newOrder(`Đơn thông báo ${rand}`, 300000);
  assert(hasTodo(await todo(buyer), 'PAY_ORDER', t1), 'Đơn vừa tạo: người mua có việc "Thanh toán đơn hàng"');

  await step(`${t1}/secure`, buyer, { requestId: crypto.randomUUID() });
  assert((await notes(seller, 'ORDER_PAID', { transactionId: t1 })).length === 1, 'Khoá tiền xong: người bán nhận ORDER_PAID');
  assert((await notes(buyer, 'ORDER_PAID', { transactionId: t1 })).length === 0, 'Người mua KHÔNG nhận ORDER_PAID');
  assert(hasTodo(await todo(seller), 'ACK_ORDER', t1), 'Người bán có việc "Xác nhận đơn hàng mới"');
  assert(!hasTodo(await todo(buyer), 'PAY_ORDER', t1), 'Việc "Thanh toán" của người mua đã biến mất');

  const buyerAck = await step(`${t1}/acknowledge`, buyer);
  assert(buyerAck.status === 403, `Người mua KHÔNG xác nhận đơn thay người bán được (nhận ${buyerAck.status})`);
  const ack = await step(`${t1}/acknowledge`, seller);
  assert(ack.status === 200 && !!ack.data.sellerAckAt && ack.data.status === 'SECURED',
    'Người bán xác nhận đơn: ghi mốc sellerAckAt, trạng thái vẫn SECURED (không phải chuyển trạng thái)');
  const ackAgain = await step(`${t1}/acknowledge`, seller);
  assert(ackAgain.status === 409, `Không xác nhận lần hai được (nhận ${ackAgain.status})`);
  assert((await notes(buyer, 'ORDER_ACKNOWLEDGED', { transactionId: t1 })).length === 1, 'Người mua nhận ORDER_ACKNOWLEDGED');
  assert(hasTodo(await todo(seller), 'SHIP_ORDER', t1) && !hasTodo(await todo(seller), 'ACK_ORDER', t1),
    'Việc của người bán chuyển từ "Xác nhận đơn" sang "Giao hàng"');
  const ackLog = (await db.prepare(`SELECT COUNT(*) AS n FROM audit_logs WHERE transaction_id = ? AND action = 'SELLER_ACKNOWLEDGED'`).get(t1)).n;
  assert(ackLog === 1, 'Xác nhận đơn được ghi đúng một bản ghi vào chuỗi nhật ký');

  section('N02: "Việc cần xử lý" bám trạng thái thật, không bám bảng thông báo');
  await db.prepare('DELETE FROM notifications WHERE user_id = ?').run(seller.user.id);
  assert((await notes(seller, 'ORDER_PAID', { transactionId: t1 })).length === 0, 'Đã xoá hết thông báo của người bán');
  assert(hasTodo(await todo(seller), 'SHIP_ORDER', t1), 'Việc "Giao hàng" VẪN còn — mất thông báo không làm mất việc cần làm');

  await step(`${t1}/ship`, seller);
  assert((await notes(buyer, 'ORDER_SHIPPED', { transactionId: t1 })).length === 1, 'Gửi hàng xong: người mua nhận ORDER_SHIPPED');
  assert(hasTodo(await todo(buyer), 'CONFIRM_RECEIPT', t1), 'Người mua có việc "Xác nhận đã nhận hàng"');
  assert(!hasTodo(await todo(seller), 'SHIP_ORDER', t1), 'Việc "Giao hàng" của người bán đã biến mất');

  await step(`${t1}/wait-confirm`, buyer);
  assert((await notes(buyer, 'ORDER_WAIT_CONFIRM', { transactionId: t1 })).length === 1, 'Nhận hàng xong: người mua nhận nhắc xác nhận giải ngân');
  assert((await notes(seller, 'ORDER_WAIT_CONFIRM', { transactionId: t1 })).length === 1, 'Người bán cũng được báo người mua đã nhận hàng');
  assert(hasTodo(await todo(buyer), 'RELEASE_OR_DISPUTE', t1), 'Người mua có việc "Xác nhận giải ngân hoặc mở tranh chấp"');

  // ---------------------------------------------------------------------- N03
  section('N03: Tranh chấp và phân xử');
  const dispute = await step(`${t1}/dispute`, buyer, { reason: 'Hàng không đúng mô tả' });
  assert(dispute.status === 201, 'Người mua mở tranh chấp');
  assert((await notes(seller, 'DISPUTE_OPENED', { transactionId: t1 })).length === 1, 'Người bán (bên kia) nhận DISPUTE_OPENED');
  assert((await notes(buyer, 'DISPUTE_OPENED', { transactionId: t1 })).length === 0, 'Người mở tranh chấp KHÔNG tự nhận thông báo');
  assert((await notes(admin, 'DISPUTE_OPENED', { transactionId: t1 })).length === 1, 'Quản trị viên nhận DISPUTE_OPENED');
  assert(hasTodo(await todo(admin), 'ADJUDICATE_DISPUTE', t1), 'Quản trị viên có việc "Phân xử tranh chấp"');
  assert(!hasTodo(await todo(buyer), 'RELEASE_OR_DISPUTE', t1), 'Việc "Xác nhận giải ngân" của người mua đã biến mất');

  const disputeId = dispute.data.dispute.id;
  const grant = await flows.adjudicationGrant(admin.token, admin.auth, disputeId, 'REFUND');
  const refund = await api(`/api/admin/disputes/${disputeId}/refund`, {
    method: 'POST', token: admin.token, body: { requestId: crypto.randomUUID(), reauthGrant: grant.data.reauthGrant },
  });
  assert(refund.status === 200, 'Quản trị viên phân xử hoàn tiền');
  assert((await notes(buyer, 'DISPUTE_RESOLVED', { transactionId: t1 })).length === 1, 'Người mua nhận DISPUTE_RESOLVED');
  assert((await notes(seller, 'DISPUTE_RESOLVED', { transactionId: t1 })).length === 1, 'Người bán nhận DISPUTE_RESOLVED');
  assert(!hasTodo(await todo(admin), 'ADJUDICATE_DISPUTE', t1), 'Việc "Phân xử" của quản trị viên đã biến mất');

  // ---------------------------------------------------------------------- N04
  section('N04: Giải ngân thông thường báo cho người bán');
  const t2 = await newOrder(`Đơn giải ngân ${rand}`, 250000);
  await step(`${t2}/secure`, buyer, { requestId: crypto.randomUUID() });
  await step(`${t2}/ship`, seller);
  await step(`${t2}/wait-confirm`, buyer);
  const rg = await flows.releaseGrant(buyer.token, buyer.auth, t2);
  const rel = await step(`${t2}/release`, buyer, { requestId: crypto.randomUUID(), reauthGrant: rg.data.reauthGrant });
  assert(rel.status === 200, 'Người mua giải ngân');
  assert((await notes(seller, 'ORDER_COMPLETED', { transactionId: t2 })).length === 1, 'Người bán nhận ORDER_COMPLETED');

  // ---------------------------------------------------------------------- N05
  section('N05: Nạp tiền — thành công/thất bại đều báo, webhook lặp không sinh thông báo thừa');
  {
    const ok = await api('/api/payments/topup', { method: 'POST', token: buyer.token, body: { amount: 100000 } });
    const cb = await provider.settlePayment(ok.data.providerRef, 'SUCCEEDED');
    await api('/api/payments/webhook', { method: 'POST', body: cb });
    await api('/api/payments/webhook', { method: 'POST', body: cb }); // lặp
    assert((await notes(buyer, 'TOPUP_SUCCEEDED', { paymentRequestId: ok.data.id })).length === 1,
      'Đúng MỘT thông báo TOPUP_SUCCEEDED dù webhook gửi hai lần');

    const bad = await api('/api/payments/topup', { method: 'POST', token: buyer.token, body: { amount: 100000 } });
    const cbBad = await provider.settlePayment(bad.data.providerRef, 'FAILED');
    await api('/api/payments/webhook', { method: 'POST', body: cbBad });
    assert((await notes(buyer, 'TOPUP_FAILED', { paymentRequestId: bad.data.id })).length === 1, 'Nạp tiền thất bại: người dùng nhận TOPUP_FAILED');

    const pending = await api('/api/payments/topup', { method: 'POST', token: buyer.token, body: { amount: 100000 } });
    assert(hasTodo(await todo(buyer), 'TOPUP_PENDING'), 'Còn yêu cầu nạp tiền PENDING thì có việc "Nạp tiền đang chờ xác nhận"');
    await provider.settlePayment(pending.data.providerRef, 'FAILED'); // dọn cho các lần chạy sau
    await api('/api/payments/webhook', { method: 'POST', body: provider.buildProviderCallback({
      paymentRequestId: pending.data.id, providerRef: pending.data.providerRef, status: 'FAILED', amount: 100000,
    }) });
  }

  // ---------------------------------------------------------------------- N06
  section('N06: Đọc/đánh dấu chỉ trên thông báo của chính mình');
  {
    const list = await api('/api/notifications', { token: buyer.token });
    const unreadBefore = list.data.unreadCount;
    const target = list.data.notifications.find((n) => !n.read);
    assert(unreadBefore > 0 && !!target, `Người mua có ${unreadBefore} thông báo chưa đọc`);

    const foreign = await api(`/api/notifications/${target.id}/read`, { method: 'POST', token: outsider.token });
    assert(foreign.status === 404, `Người khác KHÔNG đánh dấu được thông báo của người mua (nhận ${foreign.status})`);
    const foreignList = await api('/api/notifications', { token: outsider.token });
    assert(!foreignList.data.notifications.some((n) => n.id === target.id), 'Người khác không thấy thông báo của người mua');

    const mark = await api(`/api/notifications/${target.id}/read`, { method: 'POST', token: buyer.token });
    assert(mark.status === 200 && mark.data.read === true, 'Chủ thông báo đánh dấu đã đọc');
    const after = await api('/api/notifications', { token: buyer.token });
    assert(after.data.unreadCount === unreadBefore - 1, `Số chưa đọc giảm đúng 1 (${unreadBefore} -> ${after.data.unreadCount})`);

    await api('/api/notifications/read-all', { method: 'POST', token: buyer.token });
    const all = await api('/api/notifications', { token: buyer.token });
    assert(all.data.unreadCount === 0, 'Đánh dấu tất cả đã đọc');
  }

  // ---------------------------------------------------------------------- N07
  section('N07: Bảng thông báo hỏng thì nghiệp vụ vẫn thành công');
  {
    const t3 = await newOrder(`Đơn khi bảng thông báo hỏng ${rand}`, 200000);
    await step(`${t3}/secure`, buyer, { requestId: crypto.randomUUID() });
    await db.exec('ALTER TABLE notifications RENAME TO notifications_broken');
    let ship;
    try {
      ship = await step(`${t3}/ship`, seller);
    } finally {
      await db.exec('ALTER TABLE notifications_broken RENAME TO notifications');
    }
    assert(ship.status === 200 && ship.data.status === 'SHIPPING', `Gửi hàng VẪN thành công khi không ghi được thông báo (nhận ${ship.status})`);
    assert((await notes(buyer, 'ORDER_SHIPPED', { transactionId: t3 })).length === 0, 'Thông báo cho bước đó không có (ghi hỏng đã bị nuốt)');
    assert(hasTodo(await todo(buyer), 'CONFIRM_RECEIPT', t3), 'Nhưng việc "Xác nhận đã nhận hàng" vẫn hiện — suy từ trạng thái thật');
  }

  const inv = await api('/api/admin/invariants', { token: admin.token });
  assert(inv.data.ok === true && inv.data.checked === 9, 'Chín bất biến vẫn đúng sau toàn bộ kịch bản');

  console.log(failures === 0 ? '\n=== KẾT QUẢ: TẤT CẢ PASS ✅ ===\n' : `\n=== KẾT QUẢ: ${failures} KIỂM THỬ THẤT BẠI ❌ ===\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('LỖI KHÔNG MONG ĐỢI:', e);
  process.exit(1);
});
