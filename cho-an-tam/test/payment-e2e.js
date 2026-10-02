/**
 * E2E cho Mock Payment Provider + nạp tiền.
 *
 * Tám kịch bản bắt buộc theo ma trận kiểm thử đã chốt:
 *
 *   T01  TOPUP SUCCESS            T05  DUPLICATE_CALLBACK
 *   T02  TOPUP FAILED             T06  FAKE_WEBHOOK
 *   T03  PENDING / TIMEOUT        T07  OUT_OF_ORDER_CALLBACK
 *   T04  DELAYED_SUCCESS          T08  nhật ký sự kiện an toàn
 *
 * Mỗi kịch bản kiểm không chỉ HTTP status mà còn: trạng thái payment_request, số dư ví,
 * wallet_entries, nhật ký sự kiện an toàn, idempotency và chín bất biến hệ thống — đúng
 * nguyên tắc "kiểm ở DB, không chỉ ở UI" đã chốt cho Chương 3.
 *
 * mockPaymentProvider.buildProviderCallback() ở đây được gọi từ PHÍA BÀI TEST, đóng vai
 * provider thật — backend (routes/payments.js) không bao giờ tự gọi hàm này.
 *
 * Yêu cầu: server đang chạy (npm start), KHÔNG bật FAULT_INJECT.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fetch = globalThis.fetch || require('node-fetch');
const { flows } = require('./helpers/accounts');
const { buildProviderCallback } = require('../src/lib/mockPaymentProvider');
const { db } = require('../src/db');

const BASE = process.env.BASE_URL || 'http://localhost:3000';

let failures = 0;
function assert(cond, label) {
  console.log(`  ${cond ? '✅' : '❌'} ${label}`);
  if (!cond) failures++;
}
function section(title) { console.log(`\n${title}`); }

async function api(path, opts = {}, retried = false) {
  const { method = 'GET', body, token } = opts;
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let data = {};
  try { data = await res.json(); } catch (_) {}
  if (res.status === 429 && !retried) {
    console.log('  ⏳ Chạm rate limit — chờ 60 giây rồi thử lại…');
    await new Promise((r) => setTimeout(r, 61000));
    return api(path, opts, true);
  }
  return { status: res.status, data };
}

const registerUser = flows.registerUser;

function walletRow(userId) {
  return db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(userId);
}
function paymentRow(id) {
  return db.prepare('SELECT * FROM payment_requests WHERE id = ?').get(id);
}
function entriesFor(requestId) {
  return db.prepare('SELECT * FROM wallet_entries WHERE request_id = ?').all(requestId);
}
function getInvariants(adminToken) {
  return api('/api/admin/invariants', { token: adminToken });
}

async function createTopup(token, amount) {
  return api('/api/payments/topup', { method: 'POST', token, body: { amount } });
}
async function postWebhook(payload, signature) {
  return api('/api/payments/webhook', { method: 'POST', body: { payload, signature } });
}

async function main() {
  console.log(`\n=== E2E MOCK PAYMENT PROVIDER + NẠP TIỀN: ${BASE} ===`);
  const rand = Date.now();

  const admin = await flows.createAdmin({ username: `pay_adm_${rand}`, displayName: 'Admin Payment' });
  const buyer = await registerUser({ username: `pay_buy_${rand}`, displayName: 'Buyer Payment' });

  // ---- T01: TOPUP SUCCESS ----
  section('T01: TOPUP SUCCESS — webhook hợp lệ báo SUCCEEDED thì cộng ví đúng một lần');
  {
    const AMOUNT = 300000;
    const before = await walletRow(buyer.user.id);
    const created = await createTopup(buyer.token, AMOUNT);
    assert(created.status === 201 && created.data.status === 'PENDING', `Tạo yêu cầu nạp tiền PENDING (nhận ${created.status})`);
    const { id, providerRef } = created.data;

    const { payload, signature } = buildProviderCallback({ paymentRequestId: id, providerRef, status: 'SUCCEEDED', amount: AMOUNT });
    const cb = await postWebhook(payload, signature);
    assert(cb.status === 200 && cb.data.status === 'SUCCEEDED', `Webhook SUCCEEDED được chấp nhận (nhận ${cb.status})`);

    const pr = await paymentRow(id);
    assert(pr.status === 'SUCCEEDED', 'payment_requests.status = SUCCEEDED');
    assert(pr.version === 1, `payment_requests.version tăng đúng 1 lần (thực tế ${pr.version})`);

    const after = await walletRow(buyer.user.id);
    assert(after.available_balance - before.available_balance === AMOUNT, `Ví cộng đúng ${AMOUNT.toLocaleString('vi-VN')}₫`);

    const entries = await entriesFor(id);
    assert(entries.length === 1 && entries[0].entry_type === 'TOPUP_CREDIT', 'Đúng 1 wallet_entry loại TOPUP_CREDIT');
    assert(entries[0].available_delta === AMOUNT, 'wallet_entry ghi đúng available_delta');

    const inv = await getInvariants(admin.token);
    assert(inv.data.ok === true, 'Chín bất biến vẫn đúng sau TOPUP SUCCESS');
  }

  // ---- T02: TOPUP FAILED ----
  section('T02: TOPUP FAILED — webhook báo thất bại thì ví KHÔNG đổi');
  {
    const AMOUNT = 200000;
    const before = await walletRow(buyer.user.id);
    const created = await createTopup(buyer.token, AMOUNT);
    const { id, providerRef } = created.data;

    const { payload, signature } = buildProviderCallback({ paymentRequestId: id, providerRef, status: 'FAILED', amount: AMOUNT });
    const cb = await postWebhook(payload, signature);
    assert(cb.status === 200 && cb.data.status === 'FAILED', `Webhook FAILED được chấp nhận (nhận ${cb.status})`);

    const pr = await paymentRow(id);
    assert(pr.status === 'FAILED', 'payment_requests.status = FAILED');

    const after = await walletRow(buyer.user.id);
    assert(after.available_balance === before.available_balance, 'Ví không đổi khi nạp tiền thất bại');
    assert((await entriesFor(id)).length === 0, 'Không có wallet_entry nào được ghi khi FAILED');

    const inv = await getInvariants(admin.token);
    assert(inv.data.ok === true, 'Chín bất biến vẫn đúng sau TOPUP FAILED');
  }

  // ---- T03: PENDING / TIMEOUT ----
  section('T03: PENDING/TIMEOUT — chưa có callback thì không tự coi là thất bại, và vẫn tất toán được về sau');
  {
    const AMOUNT = 150000;
    const before = await walletRow(buyer.user.id);
    const created = await createTopup(buyer.token, AMOUNT);
    const { id, providerRef } = created.data;

    // "Timeout" ở đây nghĩa là không có callback nào tới. Hệ thống không có tác vụ nào tự ý
    // chuyển PENDING sang FAILED (xem comment ở schema.sql), nên trạng thái phải giữ nguyên
    // bất kể chờ bao lâu — khác timeout không đồng nghĩa thất bại.
    const check = await api(`/api/payments/${id}`, { token: buyer.token });
    assert(check.status === 200 && check.data.status === 'PENDING', 'Yêu cầu vẫn PENDING khi chưa có callback');
    assert((await walletRow(buyer.user.id)).available_balance === before.available_balance, 'Ví không đổi khi còn PENDING');

    // PENDING không bị khoá cứng chỉ vì "đã chờ lâu" — callback tới muộn vẫn tất toán được.
    const { payload, signature } = buildProviderCallback({ paymentRequestId: id, providerRef, status: 'SUCCEEDED', amount: AMOUNT });
    const cb = await postWebhook(payload, signature);
    assert(cb.status === 200 && cb.data.status === 'SUCCEEDED',
      'PENDING chờ lâu vẫn tất toán được khi callback cuối cùng cũng tới (không bị coi là hết hạn cứng)');
    assert((await walletRow(buyer.user.id)).available_balance - before.available_balance === AMOUNT, 'Ví cộng đúng số tiền khi tất toán muộn');
  }

  // ---- T04: DELAYED_SUCCESS ----
  section('T04: DELAYED_SUCCESS — callback tới muộn vẫn xử lý đúng như bình thường');
  {
    const AMOUNT = 250000;
    const before = await walletRow(buyer.user.id);
    const created = await createTopup(buyer.token, AMOUNT);
    const { id, providerRef } = created.data;

    await new Promise((r) => setTimeout(r, 500)); // mô phỏng độ trễ mạng/provider

    const { payload, signature } = buildProviderCallback({ paymentRequestId: id, providerRef, status: 'SUCCEEDED', amount: AMOUNT });
    const cb = await postWebhook(payload, signature);
    assert(cb.status === 200 && cb.data.status === 'SUCCEEDED', 'Callback tới muộn vẫn được xử lý thành công');
    assert((await walletRow(buyer.user.id)).available_balance - before.available_balance === AMOUNT, 'Ví vẫn cộng đúng số tiền dù callback tới muộn');
  }

  // ---- T05: DUPLICATE_CALLBACK ----
  section('T05: DUPLICATE_CALLBACK — gửi lặp cùng kết quả không cộng tiền hai lần');
  {
    const AMOUNT = 400000;
    const before = await walletRow(buyer.user.id);
    const created = await createTopup(buyer.token, AMOUNT);
    const { id, providerRef } = created.data;

    const { payload, signature } = buildProviderCallback({ paymentRequestId: id, providerRef, status: 'SUCCEEDED', amount: AMOUNT });
    const first = await postWebhook(payload, signature);
    assert(first.status === 200 && first.data.duplicate !== true, 'Lần gọi đầu tiên xử lý thật, không phải bản lặp');

    const second = await postWebhook(payload, signature);
    assert(second.status === 200 && second.data.duplicate === true, 'Lần gọi lặp thứ hai được nhận diện là duplicate');

    const after = await walletRow(buyer.user.id);
    assert(after.available_balance - before.available_balance === AMOUNT, 'Ví chỉ được cộng đúng MỘT lần dù webhook gửi lặp');
    assert((await entriesFor(id)).length === 1, 'Vẫn chỉ có đúng 1 wallet_entry sau khi webhook gửi lặp');

    const inv = await getInvariants(admin.token);
    assert(inv.data.ok === true, 'Chín bất biến vẫn đúng sau webhook lặp');
  }

  // ---- T06: FAKE_WEBHOOK ----
  section('T06: FAKE_WEBHOOK — chữ ký sai bị từ chối, không chạm vào bất kỳ dữ liệu nào');
  {
    const AMOUNT = 500000;
    const before = await walletRow(buyer.user.id);
    const created = await createTopup(buyer.token, AMOUNT);
    const { id, providerRef } = created.data;

    const { payload } = buildProviderCallback({ paymentRequestId: id, providerRef, status: 'SUCCEEDED', amount: AMOUNT });
    const fakeSignature = 'aa'.repeat(32); // đúng độ dài một HMAC-SHA256 hex, nhưng SAI giá trị
    const fake = await postWebhook(payload, fakeSignature);
    assert(fake.status === 401 && fake.data.error === 'INVALID_SIGNATURE', `Chữ ký giả bị từ chối (nhận ${fake.status} ${fake.data.error})`);

    const pr = await paymentRow(id);
    assert(pr.status === 'PENDING', 'Yêu cầu vẫn PENDING sau khi nhận webhook giả');
    assert((await walletRow(buyer.user.id)).available_balance === before.available_balance, 'Ví không đổi sau webhook giả');
    assert((await entriesFor(id)).length === 0, 'Không có wallet_entry nào được ghi từ webhook giả');

    const lastBadSigRow = await db
      .prepare(`SELECT detail FROM security_events WHERE event_type = 'WEBHOOK_INVALID_SIGNATURE' ORDER BY id DESC LIMIT 1`)
      .get();
    assert(!!lastBadSigRow && !lastBadSigRow.detail.includes(fakeSignature),
      'Giá trị chữ ký giả không bị ghi nguyên văn vào nhật ký sự kiện an toàn');

    // Webhook giả không được để lại tác dụng phụ nào làm hỏng khả năng tất toán hợp lệ về sau.
    const real = buildProviderCallback({ paymentRequestId: id, providerRef, status: 'SUCCEEDED', amount: AMOUNT });
    const cb = await postWebhook(real.payload, real.signature);
    assert(cb.status === 200 && cb.data.status === 'SUCCEEDED', 'Sau webhook giả, callback thật ký đúng vẫn xử lý được bình thường');
  }

  // ---- T07: OUT_OF_ORDER_CALLBACK ----
  section('T07: OUT_OF_ORDER_CALLBACK — callback tới sau trái ngược không ghi đè kết quả đã tất toán');
  {
    const AMOUNT = 350000;
    const before = await walletRow(buyer.user.id);
    const created = await createTopup(buyer.token, AMOUNT);
    const { id, providerRef } = created.data;

    // FAILED tất toán trước (giả lập nó tới trước do thứ tự mạng đảo lộn).
    const failedCb = buildProviderCallback({ paymentRequestId: id, providerRef, status: 'FAILED', amount: AMOUNT });
    const first = await postWebhook(failedCb.payload, failedCb.signature);
    assert(first.status === 200 && first.data.status === 'FAILED', 'Callback FAILED tất toán trước, đúng như dự kiến');

    // SUCCEEDED tới SAU — phải bị từ chối, không được lật ngược kết quả đã tất toán.
    const succeededCb = buildProviderCallback({ paymentRequestId: id, providerRef, status: 'SUCCEEDED', amount: AMOUNT });
    const second = await postWebhook(succeededCb.payload, succeededCb.signature);
    assert(second.status === 409 && second.data.error === 'WEBHOOK_CONFLICT',
      `Callback trái ngược tới sau bị từ chối (nhận ${second.status} ${second.data.error})`);

    const pr = await paymentRow(id);
    assert(pr.status === 'FAILED', 'payment_requests.status VẪN LÀ FAILED, không bị lật sang SUCCEEDED');
    assert((await walletRow(buyer.user.id)).available_balance === before.available_balance, 'Ví không bị cộng tiền dù callback SUCCEEDED tới sau');
    assert((await entriesFor(id)).length === 0, 'Không có wallet_entry nào được ghi từ callback trái ngược');

    const inv = await getInvariants(admin.token);
    assert(inv.data.ok === true, 'Chín bất biến vẫn đúng sau callback out-of-order');
  }

  // ---- T08: nhật ký sự kiện an toàn ----
  section('T08: Webhook để lại đúng vết trong nhật ký sự kiện an toàn');
  {
    const count = async (type) => (await db.prepare('SELECT COUNT(*) AS n FROM security_events WHERE event_type = ?').get(type)).n;
    assert((await count('TOPUP_SUCCEEDED')) >= 3, `Có ghi nhận TOPUP_SUCCEEDED (đếm được ${(await count('TOPUP_SUCCEEDED'))})`);
    assert((await count('TOPUP_FAILED')) >= 2, `Có ghi nhận TOPUP_FAILED (đếm được ${(await count('TOPUP_FAILED'))})`);
    assert((await count('WEBHOOK_INVALID_SIGNATURE')) >= 1, `Có ghi nhận WEBHOOK_INVALID_SIGNATURE (đếm được ${(await count('WEBHOOK_INVALID_SIGNATURE'))})`);
    assert((await count('WEBHOOK_CONFLICT')) >= 1, `Có ghi nhận WEBHOOK_CONFLICT (đếm được ${(await count('WEBHOOK_CONFLICT'))})`);
  }

  console.log(failures === 0 ? '\n=== KẾT QUẢ: TẤT CẢ PASS ✅ ===\n' : `\n=== KẾT QUẢ: ${failures} KIỂM THỬ THẤT BẠI ❌ ===\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('LỖI KHÔNG MONG ĐỢI:', e);
  process.exit(1);
});
