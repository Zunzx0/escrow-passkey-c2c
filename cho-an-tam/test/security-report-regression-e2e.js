/**
 * Kiểm thử hồi quy cho các phát hiện trong report_choden.md / PHAN-TICH-BAO-CAO-KIEM-THU-BAO-MAT.md
 * (nhánh claude/security-report-regression — Giai đoạn 2 của tài liệu phân tích).
 *
 * Mục tiêu KHÔNG phải chứng minh các lỗ hổng còn tồn tại — các phần dưới đây đã được xử lý ở
 * nhánh `migrate-postgres`. Mục tiêu là khoá lại bằng kiểm thử để một thay đổi sau này vô tình
 * làm hở lại các biện pháp đã có thì phát hiện ngay, không phải đợi báo cáo kiểm thử lần sau.
 *
 *   SR01  Mock Payment Provider từ chối request không có access token (H1)
 *   SR02  Không xem/chốt được payment của người khác chỉ bằng providerRef (H1)
 *   SR03  Một payment chỉ chốt được MỘT LẦN, kể cả khi hai request đua nhau (H1 + mới sửa 2026-10-02)
 *   SR04  amount kiểu chuỗi/mảng/boolean/null/số thực/ngoài khoảng đều bị từ chối (L3)
 *   SR05  Giới hạn số yêu cầu nạp đang PENDING, kể cả khi nhiều request đua nhau (M3)
 *   SR06  Giới hạn tổng nạp trong 24 giờ, và giới hạn số dư ví dự kiến (M3)
 *   SR07  Một phiếu uỷ quyền không thực hiện thành công hai thao tác (M1)
 *   SR08  Đăng xuất thu hồi phiên tại máy chủ — access token cũ dùng lại bị 401 (L4)
 *   SR09  /health ở production chỉ trả {status:"OK"}, không lộ cấu hình nội bộ (L1)
 *   SR10  Body JSON hỏng trả lỗi chung, không lộ thông báo của parser (L2)
 *   SR11  Tuyến API không tồn tại trả JSON thống nhất, không phải trang lỗi của Express (L7)
 *   SR12  Chín bất biến tài chính vẫn đúng sau toàn bộ các bước trên
 *
 * Yêu cầu: server test đang chạy (`npm run start:test`), vì SR09 tự spawn một server con riêng
 * với APP_ENV=production trên cổng khác để quan sát ĐÚNG hành vi production mà không ảnh hưởng
 * tới server chính đang chạy bộ còn lại.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const fetch = globalThis.fetch || require('node-fetch');
const { flows } = require('./helpers/accounts');
const { checkInvariants } = require('../src/lib/invariants');
const { db } = require('../src/db');

const BASE = process.env.BASE_URL || 'http://localhost:3100';
const ROOT = path.join(__dirname, '..');

let failures = 0;
function assert(cond, label) {
  console.log(`  ${cond ? '✅' : '❌'} ${label}`);
  if (!cond) failures++;
}
function section(title) { console.log(`\n${title}`); }

async function api(p, opts = {}, retried = false) {
  const { method = 'GET', body, token, rawBody } = opts;
  const headers = {};
  if (rawBody !== undefined) headers['Content-Type'] = 'application/json';
  else if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const payload = rawBody !== undefined ? rawBody : (body !== undefined ? JSON.stringify(body) : undefined);
  const res = await fetch(BASE + p, { method, headers, body: payload });
  let data = {};
  let text = '';
  try { text = await res.text(); data = JSON.parse(text); } catch (_) {}
  if (res.status === 429 && !retried) {
    console.log('  ⏳ Chạm rate limit — chờ 60 giây rồi thử lại…');
    await new Promise((r) => setTimeout(r, 61000));
    return api(p, opts, true);
  }
  return { status: res.status, data, text, contentType: res.headers.get('content-type') || '' };
}

const walletOf = async (userId) => db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(userId);
const balanceOf = async (userId) => (await walletOf(userId)).available_balance;

/** Số yêu cầu nạp tiền đang PENDING của một người — đọc trực tiếp để không phụ thuộc endpoint. */
const pendingCountOf = async (userId) =>
  (await db.prepare(`SELECT COUNT(*) AS n FROM payment_requests WHERE user_id = ? AND status = 'PENDING'`).get(userId)).n;

async function main() {
  console.log(`\n=== HỒI QUY BÁO CÁO KIỂM THỬ BẢO MẬT: ${BASE} ===`);
  const rand = crypto.randomBytes(4).toString('hex');

  const admin = await flows.createAdmin({ username: `sr_adm_${rand}`, displayName: 'SR Admin' });
  const seller = await flows.createSeller(admin, { username: `sr_sel_${rand}`, displayName: 'SR Seller' });
  const buyer = await flows.registerUser({ username: `sr_buy_${rand}`, displayName: 'SR Buyer' });
  const outsider = await flows.registerUser({ username: `sr_out_${rand}`, displayName: 'SR Outsider' });
  assert(!!admin.token && !!seller.token && !!buyer.token && !!outsider.token, 'Bốn tài khoản sẵn sàng');

  // =======================================================================================
  section('SR01: Mock Payment Provider từ chối request không có access token');
  // =======================================================================================
  {
    const topup = await api('/api/payments/topup', { method: 'POST', token: buyer.token, body: { amount: 50000 } });
    assert(topup.status === 201, 'Tạo được yêu cầu nạp tiền để có providerRef thật dùng cho phần sau');
    const providerRef = topup.data.providerRef;

    const getNoAuth = await api(`/mock-provider/checkout/${providerRef}`, {});
    assert(getNoAuth.status === 401, `Xem trang thanh toán không kèm token bị từ chối (nhận ${getNoAuth.status})`);

    const payNoAuth = await api(`/mock-provider/checkout/${providerRef}/pay`, { method: 'POST', body: { outcome: 'SUCCEEDED' } });
    assert(payNoAuth.status === 401, `Chốt thanh toán không kèm token bị từ chối (nhận ${payNoAuth.status})`);

    // Dọn: để providerRef này không ảnh hưởng tới SR06 (hạn mức ngày) — chốt FAILED cho xong.
    await api(`/mock-provider/checkout/${providerRef}/pay`, { method: 'POST', token: buyer.token, body: { outcome: 'FAILED', deliverWebhook: true } });
  }

  // =======================================================================================
  section('SR02: Không xem/chốt được payment của người khác chỉ bằng providerRef');
  // =======================================================================================
  {
    const topup = await api('/api/payments/topup', { method: 'POST', token: buyer.token, body: { amount: 60000 } });
    const providerRef = topup.data.providerRef;
    const balanceBefore = await balanceOf(outsider.user.id);

    const viewAsOutsider = await api(`/mock-provider/checkout/${providerRef}`, { token: outsider.token });
    assert(viewAsOutsider.status === 404 && viewAsOutsider.data.error === 'UNKNOWN_PAYMENT',
      `Người ngoài xem payment của người khác nhận 404 UNKNOWN_PAYMENT, không phải 403 (nhận ${viewAsOutsider.status} ${viewAsOutsider.data.error})`);

    const payAsOutsider = await api(`/mock-provider/checkout/${providerRef}/pay`, {
      method: 'POST', token: outsider.token, body: { outcome: 'SUCCEEDED' },
    });
    assert(payAsOutsider.status === 404 && payAsOutsider.data.error === 'UNKNOWN_PAYMENT',
      `Người ngoài chốt payment của người khác nhận 404 UNKNOWN_PAYMENT (nhận ${payAsOutsider.status} ${payAsOutsider.data.error})`);

    assert((await balanceOf(outsider.user.id)) === balanceBefore, 'Ví người ngoài không đổi — không "chốt hộ" được dù request bị chặn');

    const viewAsOwner = await api(`/mock-provider/checkout/${providerRef}`, { token: buyer.token });
    assert(viewAsOwner.status === 200, 'Chính chủ vẫn xem được bình thường — 404 ở trên là CHẶN đúng người, không phải lỗi chung');

    await api(`/mock-provider/checkout/${providerRef}/pay`, { method: 'POST', token: buyer.token, body: { outcome: 'FAILED', deliverWebhook: true } });
  }

  // =======================================================================================
  section('SR03: Một payment chỉ chốt được MỘT LẦN, kể cả khi hai request đua nhau');
  // =======================================================================================
  {
    const amount = 70000;
    const topup = await api('/api/payments/topup', { method: 'POST', token: buyer.token, body: { amount } });
    const providerRef = topup.data.providerRef;
    const before = await balanceOf(buyer.user.id);

    const [succ, fail] = await Promise.all([
      api(`/mock-provider/checkout/${providerRef}/pay`, { method: 'POST', token: buyer.token, body: { outcome: 'SUCCEEDED', deliverWebhook: true } }),
      api(`/mock-provider/checkout/${providerRef}/pay`, { method: 'POST', token: buyer.token, body: { outcome: 'FAILED', deliverWebhook: true } }),
    ]);
    const winners = [succ, fail].filter((r) => r.status === 200);
    const losers = [succ, fail].filter((r) => r.status !== 200);
    assert(winners.length === 1, `Đúng một trong hai lệnh chốt thành công (thực tế: ${winners.length})`);
    assert(losers.length === 1 && losers[0].status === 409 && losers[0].data.error === 'ALREADY_SETTLED',
      `Lệnh thua nhận đúng 409 ALREADY_SETTLED (nhận ${losers[0] && losers[0].status} ${losers[0] && losers[0].data.error})`);

    // Chờ webhook (nếu thắng là SUCCEEDED) được xử lý xong — gửi webhook là await bên trong /pay
    // nên tới đây response đã trả thì webhook đã chạy xong, không cần chờ thêm.
    const after = await balanceOf(buyer.user.id);
    const delta = after - before;
    assert(delta === 0 || delta === amount, `Ví chỉ đổi đúng 0 hoặc đúng ${amount}, không nhân đôi (thực tế Δ=${delta})`);
  }

  // =======================================================================================
  section('SR04: amount sai kiểu hoặc ngoài khoảng đều bị từ chối, không ép kiểu ngầm');
  // =======================================================================================
  {
    const badTypes = [
      ['chuỗi số', '50000'],
      ['mảng', [50000]],
      ['boolean', true],
      ['null', null],
      ['số thực', 50000.5],
    ];
    for (const [label, amount] of badTypes) {
      const r = await api('/api/payments/topup', { method: 'POST', token: buyer.token, body: { amount } });
      assert(r.status === 400 && r.data.error === 'INVALID_AMOUNT',
        `amount kiểu ${label} bị từ chối với INVALID_AMOUNT (nhận ${r.status} ${r.data.error})`);
    }

    const MIN_AMOUNT = parseInt(process.env.TOPUP_MIN || '1000', 10);
    const MAX_AMOUNT = parseInt(process.env.TOPUP_MAX_PER_REQUEST || '50000000', 10);
    const tooSmall = await api('/api/payments/topup', { method: 'POST', token: buyer.token, body: { amount: MIN_AMOUNT - 1 } });
    assert(tooSmall.status === 400 && tooSmall.data.error === 'AMOUNT_OUT_OF_RANGE',
      `Số tiền dưới ngưỡng tối thiểu bị từ chối (nhận ${tooSmall.status} ${tooSmall.data.error})`);
    const tooBig = await api('/api/payments/topup', { method: 'POST', token: buyer.token, body: { amount: MAX_AMOUNT + 1 } });
    assert(tooBig.status === 400 && tooBig.data.error === 'AMOUNT_OUT_OF_RANGE',
      `Số tiền vượt ngưỡng một request bị từ chối (nhận ${tooBig.status} ${tooBig.data.error})`);
  }

  // =======================================================================================
  section('SR05: Giới hạn số yêu cầu nạp PENDING, kể cả khi nhiều request đua nhau');
  // =======================================================================================
  {
    const limitBuyer = await flows.registerUser({ username: `sr_lim_${rand}`, displayName: 'SR Limit Buyer' });
    const MAX_PENDING = parseInt(process.env.TOPUP_MAX_PENDING || '5', 10);
    const attempts = MAX_PENDING + 4;

    const results = await Promise.all(
      Array.from({ length: attempts }, () => api('/api/payments/topup', { method: 'POST', token: limitBuyer.token, body: { amount: 10000 } }))
    );
    const ok = results.filter((r) => r.status === 201).length;
    const blocked = results.filter((r) => r.status === 409 && r.data.error === 'TOPUP_LIMIT_EXCEEDED').length;
    assert(ok === MAX_PENDING, `Đúng ${MAX_PENDING} request thành công dù ${attempts} request đua nhau (thực tế: ${ok})`);
    assert(blocked === attempts - MAX_PENDING, `${attempts - MAX_PENDING} request còn lại bị TOPUP_LIMIT_EXCEEDED (thực tế: ${blocked})`);

    const actualPending = await pendingCountOf(limitBuyer.user.id);
    assert(actualPending === MAX_PENDING, `Số dòng PENDING thật trong DB đúng bằng giới hạn, không lệch do race (thực tế: ${actualPending})`);
  }

  // =======================================================================================
  section('SR06: Giới hạn tổng nạp 24 giờ, và giới hạn số dư ví dự kiến');
  // =======================================================================================
  {
    const dayBuyer = await flows.registerUser({ username: `sr_day_${rand}`, displayName: 'SR Day Buyer' });
    const MAX_AMOUNT = parseInt(process.env.TOPUP_MAX_PER_REQUEST || '50000000', 10);
    const MAX_PER_DAY = parseInt(process.env.TOPUP_MAX_PER_DAY || '100000000', 10);

    // Nạp sát trần MAX_AMOUNT nhiều lần, SETTLE ngay mỗi lần để không chạm trần PENDING, cho tới
    // khi day_total gần chạm MAX_PER_DAY.
    let dayTotal = 0;
    while (dayTotal + MAX_AMOUNT <= MAX_PER_DAY) {
      const t = await api('/api/payments/topup', { method: 'POST', token: dayBuyer.token, body: { amount: MAX_AMOUNT } });
      assert(t.status === 201, `Nạp ${MAX_AMOUNT} khi chưa chạm trần ngày (đã nạp ${dayTotal}) thành công`);
      await api(`/mock-provider/checkout/${t.data.providerRef}/pay`, { method: 'POST', token: dayBuyer.token, body: { outcome: 'SUCCEEDED', deliverWebhook: true } });
      dayTotal += MAX_AMOUNT;
    }
    const remaining = MAX_PER_DAY - dayTotal; // < MAX_AMOUNT, còn lại trong ngày
    // max(remaining+1, MIN_AMOUNT): phải vượt đúng phần còn lại trong ngày để chắc chắn bắn ra
    // TOPUP_LIMIT_EXCEEDED, nhưng cũng phải không nhỏ hơn MIN_AMOUNT — nếu không, khi remaining
    // gần 0 (ví dụ đúng 0 như với các giá trị mặc định), remaining+1 có thể nhỏ hơn MIN_AMOUNT
    // và phép kiểm KIỂU DỮ LIỆU/khoảng của amount bắn ra AMOUNT_OUT_OF_RANGE trước, làm bài test
    // tưởng nhầm là đã kiểm đúng nhánh hạn mức ngày.
    const overDayAmount = Math.max(remaining + 1, MIN_AMOUNT_FOR(process));
    const overDay = await api('/api/payments/topup', { method: 'POST', token: dayBuyer.token, body: { amount: overDayAmount } });
    assert(overDay.status === 409 && overDay.data.error === 'TOPUP_LIMIT_EXCEEDED',
      `Vượt hạn mức ngày bị từ chối (nhận ${overDay.status} ${overDay.data.error})`);
    if (remaining >= MIN_AMOUNT_FOR(process)) {
      const withinDay = await api('/api/payments/topup', { method: 'POST', token: dayBuyer.token, body: { amount: remaining } });
      assert(withinDay.status === 201, `Nạp đúng phần còn lại trong ngày vẫn được chấp nhận (nhận ${withinDay.status})`);
      await api(`/mock-provider/checkout/${withinDay.data.providerRef}/pay`, { method: 'POST', token: dayBuyer.token, body: { outcome: 'FAILED', deliverWebhook: true } });
    }

    // Giới hạn số dư ví: day_total mặc định (100.000.000) THẤP HƠN hạn mức ví (200.000.000) nên
    // không thể chạm trần ví chỉ bằng nạp tiền trong một ngày — đúng như thiết kế hạn mức ngày
    // là lớp chặn ĐẦU TIÊN. Hạn mức ví chỉ có ý nghĩa khi ví có tiền từ nguồn KHÁC nạp tiền (ví
    // dụ bán hàng). Dựng tình huống đó bằng cách bơm thẳng available_balance của người bán —
    // CÓ CHỦ Ý ở mức white-box, chỉ để kiểm ĐÚNG MỘT nhánh kiểm tra của assertTopupLimits(), và
    // phục hồi lại số dư cũ ngay sau khi kiểm xong để không để lại dữ liệu giả cho các bước sau.
    const MAX_WALLET_BALANCE = parseInt(process.env.WALLET_MAX_BALANCE || '200000000', 10);
    const sellerWalletBefore = await walletOf(seller.user.id);
    // Đặt available_balance về ĐÚNG (MAX_WALLET_BALANCE - 10.000), bất kể số dư hiện tại là bao
    // nhiêu — tài khoản mới kích hoạt đã được cấp DEMO_BUYER_INITIAL_BALANCE, không phải 0, nên
    // không thể tính bump như thể số dư ban đầu bằng 0.
    const targetBeforeLimit = MAX_WALLET_BALANCE - 10000;
    const bump = targetBeforeLimit - sellerWalletBefore.available_balance;
    await db.prepare('UPDATE wallets SET available_balance = available_balance + ? WHERE user_id = ?').run(bump, seller.user.id);
    try {
      const overWallet = await api('/api/payments/topup', { method: 'POST', token: seller.token, body: { amount: 20000 } });
      assert(overWallet.status === 409 && overWallet.data.error === 'TOPUP_LIMIT_EXCEEDED',
        `Nạp tiền làm vượt trần số dư ví bị từ chối (nhận ${overWallet.status} ${overWallet.data.error})`);
      const withinWallet = await api('/api/payments/topup', { method: 'POST', token: seller.token, body: { amount: 5000 } });
      assert(withinWallet.status === 201, `Nạp tiền còn trong hạn mức ví vẫn được chấp nhận (nhận ${withinWallet.status})`);
      if (withinWallet.status === 201) {
        await api(`/mock-provider/checkout/${withinWallet.data.providerRef}/pay`, { method: 'POST', token: seller.token, body: { outcome: 'FAILED', deliverWebhook: true } });
      }
    } finally {
      // Phục hồi số dư ví người bán về như trước khi bơm, để không ảnh hưởng tới các bước sau.
      await db.prepare('UPDATE wallets SET available_balance = ? WHERE user_id = ?').run(sellerWalletBefore.available_balance, seller.user.id);
    }
  }

  // =======================================================================================
  section('SR07: Một phiếu uỷ quyền không thực hiện thành công hai thao tác');
  // =======================================================================================
  {
    const listing = await api('/api/listings', {
      method: 'POST', token: seller.token,
      body: { title: `SR07 ${rand}`, category: 'SACH', price: 65000, location: 'Hà Nội' },
    });
    const order = await api('/api/transactions/orders', { method: 'POST', token: buyer.token, body: { listingId: listing.data.id } });
    const txnId = order.data.id;
    await api(`/api/transactions/${txnId}/secure`, { method: 'POST', token: buyer.token, body: { requestId: crypto.randomUUID() } });
    await api(`/api/transactions/${txnId}/ship`, { method: 'POST', token: seller.token });
    await api(`/api/transactions/${txnId}/wait-confirm`, { method: 'POST', token: buyer.token });

    const opt = await api(`/api/transactions/${txnId}/reauth/options`, { method: 'POST', token: buyer.token });
    const assertion = buyer.auth.authenticate({
      rpId: process.env.WEBAUTHN_RP_ID || 'localhost',
      origin: process.env.WEBAUTHN_ORIGIN || BASE,
      challenge: opt.data.options.challenge,
    });
    const verify = await api(`/api/transactions/${txnId}/reauth/verify`, {
      method: 'POST', token: buyer.token,
      body: { reauthSessionId: opt.data.reauthSessionId, response: assertion },
    });
    const grant = verify.data.reauthGrant;
    assert(!!grant, 'Cấp được phiếu uỷ quyền giải ngân');

    const sellerBefore = await balanceOf(seller.user.id);
    const first = await api(`/api/transactions/${txnId}/release`, {
      method: 'POST', token: buyer.token, body: { requestId: crypto.randomUUID(), reauthGrant: grant },
    });
    assert(first.status === 200 && first.data.status === 'COMPLETED', `Lần giải ngân đầu bằng phiếu thành công (nhận ${first.status})`);

    // Dùng LẠI đúng phiếu đó cho một requestId KHÁC (không phải gửi lại y nguyên — đó là
    // idempotency replay, đã kiểm ở market-e2e M13). Ở đây kiểm riêng: phiếu đã TIÊU THỤ rồi thì
    // không dùng lại được cho một thao tác MỚI, kể cả trên đúng giao dịch đó.
    const listing2 = await api('/api/listings', {
      method: 'POST', token: seller.token,
      body: { title: `SR07b ${rand}`, category: 'SACH', price: 40000, location: 'Hà Nội' },
    });
    const order2 = await api('/api/transactions/orders', { method: 'POST', token: buyer.token, body: { listingId: listing2.data.id } });
    const txn2 = order2.data.id;
    await api(`/api/transactions/${txn2}/secure`, { method: 'POST', token: buyer.token, body: { requestId: crypto.randomUUID() } });
    await api(`/api/transactions/${txn2}/ship`, { method: 'POST', token: seller.token });
    await api(`/api/transactions/${txn2}/wait-confirm`, { method: 'POST', token: buyer.token });
    const reuseOtherTxn = await api(`/api/transactions/${txn2}/release`, {
      method: 'POST', token: buyer.token, body: { requestId: crypto.randomUUID(), reauthGrant: grant },
    });
    assert(reuseOtherTxn.status === 401, `Phiếu đã dùng không giải ngân được giao dịch KHÁC (nhận ${reuseOtherTxn.status})`);

    const sellerAfter = await balanceOf(seller.user.id);
    assert(sellerAfter - sellerBefore === 65000, 'Người bán chỉ nhận đúng tiền của giao dịch đầu, không nhận thêm từ lần dùng lại phiếu');
  }

  // =======================================================================================
  section('SR08: Đăng xuất thu hồi phiên tại máy chủ — access token cũ dùng lại bị 401');
  // =======================================================================================
  {
    const sess = await flows.registerUser({ username: `sr_out2_${rand}`, displayName: 'SR Logout' });
    const before = await api('/api/wallets/me', { token: sess.token });
    assert(before.status === 200, 'Token còn hiệu lực trước khi đăng xuất');

    const logout = await api('/api/passkeys/session/logout', { method: 'POST', token: sess.token });
    assert(logout.status === 200 && logout.data.ok === true, `Đăng xuất thành công (nhận ${logout.status})`);

    const after = await api('/api/wallets/me', { token: sess.token });
    assert(after.status === 401, `Dùng lại ĐÚNG access token cũ sau khi đăng xuất bị 401 (nhận ${after.status})`);
  }

  // =======================================================================================
  section('SR09: /health ở production chỉ trả {status:"OK"}, không lộ cấu hình nội bộ');
  // =======================================================================================
  await (async () => {
    const PORT = 3177;
    const dbPath = process.env.DATABASE_URL ? null : path.join('data', 'test', `health-check-${Date.now()}.db`);
    const env = { ...process.env, APP_ENV: 'production', PORT: String(PORT) };
    if (dbPath) env.DB_PATH = dbPath;
    delete env.FAULT_INJECT;

    const child = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });

    try {
      let res = null;
      for (let i = 0; i < 40 && !res; i++) {
        await new Promise((r) => setTimeout(r, 250));
        try { res = await fetch(`http://localhost:${PORT}/health`); } catch (_) {}
      }
      assert(!!res, `Server con (APP_ENV=production) khởi động và trả lời /health (log: ${out.slice(0, 300)})`);
      if (res) {
        const body = await res.json();
        const keys = Object.keys(body).sort();
        assert(keys.length === 1 && keys[0] === 'status' && body.status === 'OK',
          `/health production CHỈ có field "status" (thực tế: ${JSON.stringify(body)})`);
      }
    } finally {
      child.kill();
      if (dbPath) {
        // Windows không nhả khoá file ngay khi process vừa bị kill — chờ một nhịp ngắn, và
        // không để lỗi dọn dẹp (EBUSY) làm hỏng cả bài kiểm thử: đây chỉ là file tạm, dọn
        // không được thì bỏ qua, không phải một khẳng định cần đúng.
        await new Promise((r) => setTimeout(r, 400));
        const candidates = [dbPath, dbPath.replace(/\.db$/, '') + '.mock-provider.db'];
        for (const base of candidates) {
          for (const suffix of ['', '-wal', '-shm']) {
            const f = path.join(ROOT, base + suffix);
            try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (_) { /* dọn thất bại không sao, chỉ là file tạm */ }
          }
        }
      }
    }
  })();

  // =======================================================================================
  section('SR10: Body JSON hỏng trả lỗi chung, không lộ thông báo của parser');
  // =======================================================================================
  {
    const broken = await api('/api/payments/topup', {
      method: 'POST', token: buyer.token, rawBody: '{ "amount": 50000, ',
    });
    assert(broken.status === 400 && broken.data.error === 'INVALID_JSON',
      `Body JSON hỏng trả 400 INVALID_JSON (nhận ${broken.status} ${broken.data.error})`);
    const msg = (broken.data.message || '').toLowerCase();
    assert(!/unexpected token|position|json\.parse|syntaxerror/.test(msg),
      `Thông báo không lộ chi tiết của parser (nhận: "${broken.data.message}")`);
  }

  // =======================================================================================
  section('SR11: Tuyến API không tồn tại trả JSON thống nhất, không phải trang lỗi Express');
  // =======================================================================================
  {
    const missing = await api('/api/duong-dan-khong-ton-tai-' + rand, { token: buyer.token });
    assert(missing.status === 404 && missing.data.error === 'NOT_FOUND',
      `Tuyến /api không tồn tại trả 404 NOT_FOUND dạng JSON (nhận ${missing.status} ${JSON.stringify(missing.data)})`);
    assert(/json/.test(missing.contentType), `Content-Type là JSON, không phải text/html (nhận ${missing.contentType})`);
    assert(!/Cannot GET|Cannot POST|<pre>/.test(missing.text), 'Không phải trang lỗi mặc định của Express (không có "Cannot GET/POST")');

    const missingMock = await api('/mock-provider/duong-dan-khong-ton-tai-' + rand, { token: buyer.token });
    assert(missingMock.status === 404 && missingMock.data.error === 'NOT_FOUND',
      `Tuyến /mock-provider không tồn tại cũng trả JSON thống nhất (nhận ${missingMock.status})`);
  }

  // =======================================================================================
  section('SR12: Chín bất biến tài chính vẫn đúng sau toàn bộ các bước trên');
  // =======================================================================================
  {
    const inv = await checkInvariants(db);
    assert(inv.ok, `9 bất biến đúng (violations=${JSON.stringify(inv.violations || [])})`);
  }

  console.log(failures === 0 ? '\n=== KẾT QUẢ: TẤT CẢ PASS ✅ ===\n' : `\n=== KẾT QUẢ: ${failures} KIỂM THỬ THẤT BẠI ❌ ===\n`);
  process.exit(failures === 0 ? 0 : 1);
}

// MIN_AMOUNT đọc lại ở đây để SR06 không phải định nghĩa thêm biến module-level trùng tên.
function MIN_AMOUNT_FOR(p) { return parseInt(p.env.TOPUP_MIN || '1000', 10); }

main().catch((e) => {
  console.error('LỖI KHÔNG MONG ĐỢI:', e);
  process.exit(1);
});
