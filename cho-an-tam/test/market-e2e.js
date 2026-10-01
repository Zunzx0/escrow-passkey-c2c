/**
 * E2E cho lớp marketplace "mua bán C2C" dựng trên lõi Escrow + Passkeys.
 * Bổ sung cho test/e2e.js (kiểm tra lõi escrow) và test/security-e2e.js (kiểm tra
 * các mối đe doạ đã nêu ở mục 2.3 của báo cáo).
 *
 * Chạy: mở server ở một cửa sổ (`npm start`), rồi ở cửa sổ khác gõ `node test/market-e2e.js`.
 * Không cần cài thêm gói nào — dùng fetch có sẵn của Node và software authenticator nội bộ.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const crypto = require('crypto');
const fetch = globalThis.fetch || require('node-fetch');
const { createAuthenticator } = require('./softwareAuthenticator');
const { createAdmin, createSeller, flows } = require('./helpers/accounts');

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const RP_ID = process.env.WEBAUTHN_RP_ID || 'localhost';
const ORIGIN = process.env.WEBAUTHN_ORIGIN || BASE;

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

  // Endpoint Passkeys giới hạn 10 request/phút/IP theo yêu cầu bảo mật. Bộ test tạo
  // nhiều tài khoản nên sẽ chạm trần — chờ hết cửa sổ rồi thử lại thay vì hạ mức bảo mật.
  if (res.status === 429 && !retried) {
    console.log('  ⏳ Chạm rate limit 10 req/phút (đúng thiết kế) — chờ 60 giây rồi thử lại…');
    await new Promise((r) => setTimeout(r, 61000));
    return api(path, opts, true);
  }
  return { status: res.status, data };
}

/**
 * Đăng ký qua ĐÚNG một luồng chung cho cả ba vai trò, và luồng đó luôn tạo ra Người mua.
 * Năng lực bán chỉ đến từ quy trình xin và duyệt; quyền quản trị chỉ đến từ thủ tục vận hành.
 * `extra` dùng để nhồi thêm trường lạ vào payload nhằm kiểm rằng máy chủ bỏ qua chúng.
 */
// Đăng ký gồm HAI bước: tạo tài khoản bằng mật khẩu, rồi đăng ký Passkey bắt buộc.
// Chỉ sau bước thứ hai tài khoản mới ACTIVE và mới có ví.
const registerUser = flows.registerUser;

async function reauthGrantFor(txnId, actor) {
  const opt = await api(`/api/transactions/${txnId}/reauth/options`, { method: 'POST', token: actor.token });
  const assertion = actor.auth.authenticate({ rpId: RP_ID, origin: ORIGIN, challenge: opt.data.options.challenge });
  const verify = await api(`/api/transactions/${txnId}/reauth/verify`, {
    method: 'POST', token: actor.token,
    body: { reauthSessionId: opt.data.reauthSessionId, response: assertion },
  });
  return verify.data.reauthGrant;
}

const PRICE = 850000;

async function main() {
  console.log(`\n=== E2E MUA BÁN C2C: ${BASE} ===`);
  const rand = Date.now();

  // ---- M00: luồng đăng ký chung ----
  section('M00: Một form đăng ký duy nhất, luôn ra Người mua');
  const plain = await registerUser({ username: `plain_${rand}`, displayName: 'Nguoi Thuong' });
  assert(plain.status === 201 && plain.user.role === 'BUYER', 'Đăng ký thường tạo ra Người mua');

  const injected = await registerUser({
    username: `fake_${rand}`, displayName: 'Gia Mao', role: 'ADMIN', inviteCode: 'SHOP-XXXX-XXXX',
  });
  assert(injected.status === 201 && injected.user.role === 'BUYER',
    'Nhồi thêm role và mã bịa vào payload đều bị bỏ qua, tài khoản vẫn là Người mua');

  // ---- M01: chuẩn bị tài khoản ----
  section('M01: Nâng quyền quản trị, duyệt người bán và tạo hai người mua');
  const admin = await createAdmin(registerUser, { username: `admin_${rand}`, displayName: 'Quan Tri' });
  assert(admin.user.role === 'ADMIN', 'Thủ tục vận hành nâng được Người mua lên Quản trị viên');

  const seller = await createSeller(api, registerUser, admin, {
    username: `seller_${rand}`, displayName: 'Người Bán', shopName: 'Cửa hàng kiểm thử',
  });
  const buyer = await registerUser({ username: `buyer_${rand}`, displayName: 'Người Mua 1' });
  const buyer2 = await registerUser({ username: `buyer2_${rand}`, displayName: 'Người Mua 2' });
  assert(buyer.status === 201 && buyer2.status === 201, 'Tạo tài khoản bằng Passkey thành công');
  assert(seller.user.role === 'SELLER', 'Duyệt yêu cầu nâng Người mua lên Người bán');

  const startBalance = (await api('/api/wallets/me', { token: buyer.token })).data.availableBalance;
  assert(startBalance > PRICE, `Người mua có số dư demo ${startBalance.toLocaleString('vi-VN')}₫`);

  // ---- M02: đăng bán ----
  section('M02: Người bán đăng sản phẩm lên sàn');
  const created = await api('/api/listings', {
    method: 'POST', token: seller.token,
    body: {
      title: `iPhone 13 128GB ${rand}`, category: 'DIEN_THOAI', condition: 'LIKE_NEW',
      description: 'Pin 89%, đủ hộp và cáp zin', price: PRICE, location: 'Hà Nội',
    },
  });
  assert(created.status === 201, `Đăng bán thành công (nhận ${created.status})`);
  assert(created.data.price === PRICE, 'Giá bán lưu đúng, là toàn bộ số tiền của giao dịch');
  assert(created.data.isSold === false, 'Tin đăng mới chưa có đơn mua');
  const listingId = created.data.id;

  // ---- M03: quyền đăng bán ----
  section('M03: Người mua không được đăng bán');
  const forbidden = await api('/api/listings', {
    method: 'POST', token: buyer.token,
    body: { title: 'Thử đăng', category: 'DIEN_THOAI', price: 100000 },
  });
  assert(forbidden.status === 403, `Tài khoản Người mua bị chặn đăng bán (nhận ${forbidden.status})`);

  // ---- M04: ràng buộc giá ----
  section('M04: Kiểm tra ràng buộc giá bán');
  const tooCheap = await api('/api/listings', {
    method: 'POST', token: seller.token,
    body: { title: 'Giá quá thấp', category: 'DIEN_THOAI', price: 500 },
  });
  assert(tooCheap.status === 400, `Giá dưới mức tối thiểu bị từ chối (nhận ${tooCheap.status})`);

  const noPrice = await api('/api/listings', {
    method: 'POST', token: seller.token,
    body: { title: 'Thiếu giá', category: 'DIEN_THOAI' },
  });
  assert(noPrice.status === 400, `Thiếu giá bán bị từ chối (nhận ${noPrice.status})`);

  // ---- M05: đặt mua, server tự lấy giá ----
  section('M05: Đặt mua — server tự lấy giá từ tin đăng');
  const order = await api('/api/transactions/orders', {
    method: 'POST', token: buyer.token,
    body: { listingId, note: 'Giao giờ hành chính giúp mình' },
  });
  assert(order.status === 201, `Tạo đơn mua thành công (nhận ${order.status})`);
  assert(order.data.amount === PRICE, `Số tiền do server tính, đúng bằng giá tin đăng ${PRICE}`);
  assert(order.data.status === 'CREATED' && order.data.escrowStatus === 'NONE', 'Đơn mới ở CREATED + NONE');
  assert(order.data.buyerNote === 'Giao giờ hành chính giúp mình', 'Lời nhắn của người mua được lưu');
  const txnId = order.data.id;

  const selfBuy = await api('/api/transactions/orders', {
    method: 'POST', token: seller.token, body: { listingId },
  });
  assert(selfBuy.status === 400 || selfBuy.status === 403, `Người bán không tự mua hàng của mình (nhận ${selfBuy.status})`);

  // ---- M06: đơn chưa thanh toán chưa giữ chỗ ----
  section('M06: Đơn chưa thanh toán không giữ chỗ sản phẩm');
  const stillOpen = await api('/api/listings/' + listingId);
  assert(stillOpen.data.isSold === false, 'Tạo đơn nhưng chưa khoá tiền thì tin đăng vẫn mở bán');

  // ---- M07: khoá tiền vào Escrow ----
  section('M07: Thanh toán — khoá toàn bộ số tiền vào Escrow');
  const balBefore = (await api('/api/wallets/me', { token: buyer.token })).data;
  const secured = await api(`/api/transactions/${txnId}/secure`, {
    method: 'POST', token: buyer.token, body: { requestId: crypto.randomUUID() },
  });
  assert(secured.status === 200 && secured.data.escrowStatus === 'LOCKED', 'Đơn chuyển sang SECURED + LOCKED');

  const balAfter = (await api('/api/wallets/me', { token: buyer.token })).data;
  assert(balBefore.availableBalance - balAfter.availableBalance === PRICE,
    `Ví người mua giảm đúng ${PRICE.toLocaleString('vi-VN')}₫`);

  const sold = await api('/api/listings/' + listingId);
  assert(sold.data.isSold === true, 'Khoá tiền xong thì tin đăng chuyển sang đã có đơn');

  // ---- M08: chống hai người cùng mua một sản phẩm ----
  section('M08: Chống mua trùng — ai trả tiền trước giữ sản phẩm');
  const lateOrder = await api('/api/transactions/orders', {
    method: 'POST', token: buyer2.token, body: { listingId },
  });
  assert(lateOrder.status === 409 && lateOrder.data.error === 'LISTING_SOLD',
    `Người đến sau không tạo được đơn (nhận ${lateOrder.status} ${lateOrder.data.error})`);

  // ---- M09: khoá giá khi đã có đơn ----
  section('M09: Không đổi được giá khi sản phẩm đã có đơn mua');
  // Giá mới vẫn hợp lệ về mặt định dạng, để phép kiểm dừng ở đúng lý do "đã có đơn"
  // chứ không dừng sớm ở bước kiểm miền giá trị.
  const repriced = await api('/api/listings/' + listingId, {
    method: 'PATCH', token: seller.token, body: { price: 990000 },
  });
  assert(repriced.status === 409 && repriced.data.error === 'LISTING_SOLD',
    `Đổi giá bị chặn (nhận ${repriced.status} ${repriced.data.error})`);

  const renamed = await api('/api/listings/' + listingId, {
    method: 'PATCH', token: seller.token, body: { description: 'Đã cập nhật mô tả' },
  });
  assert(renamed.status === 200, 'Vẫn sửa được mô tả — chỉ giá mới bị khoá');

  // ---- M10: giao hàng ----
  section('M10: Người bán giao hàng, báo đã giao đến');
  const shipped = await api(`/api/transactions/${txnId}/ship`, { method: 'POST', token: seller.token });
  assert(shipped.status === 200 && shipped.data.status === 'SHIPPING', 'Đơn chuyển sang SHIPPING');
  const delivered = await api(`/api/transactions/${txnId}/wait-confirm`, { method: 'POST', token: buyer.token });
  assert(delivered.status === 200 && delivered.data.status === 'WAIT_CONFIRM', 'Đơn chuyển sang WAIT_CONFIRM');

  const buyerShip = await api(`/api/transactions/${txnId}/ship`, { method: 'POST', token: buyer.token });
  assert(buyerShip.status !== 200, `Người mua không tự báo giao hàng được (nhận ${buyerShip.status})`);

  // ---- M11: giải ngân bắt buộc xác thực lại ----
  section('M11: Giải ngân bắt buộc xác thực lại bằng Passkey');
  const noGrant = await api(`/api/transactions/${txnId}/release`, {
    method: 'POST', token: buyer.token, body: { requestId: crypto.randomUUID() },
  });
  assert(noGrant.status === 400 || noGrant.status === 401,
    `Giải ngân không kèm phiếu uỷ quyền bị từ chối (nhận ${noGrant.status})`);

  const fakeGrant = await api(`/api/transactions/${txnId}/release`, {
    method: 'POST', token: buyer.token,
    body: { requestId: crypto.randomUUID(), reauthGrant: 'phieu-gia-mao' },
  });
  assert(fakeGrant.status === 401, `Phiếu uỷ quyền giả bị từ chối (nhận ${fakeGrant.status})`);

  // ---- M12: một dòng tiền duy nhất ----
  section('M12: Toàn bộ số tiền chuyển cho người bán, không tách khoản');
  const sellerBefore = (await api('/api/wallets/me', { token: seller.token })).data.availableBalance;
  const buyerBefore = (await api('/api/wallets/me', { token: buyer.token })).data.availableBalance;

  const grant = await reauthGrantFor(txnId, buyer);
  const requestId = crypto.randomUUID();
  const released = await api(`/api/transactions/${txnId}/release`, {
    method: 'POST', token: buyer.token, body: { requestId, reauthGrant: grant },
  });
  assert(released.status === 200 && released.data.status === 'COMPLETED', 'Đơn chuyển sang COMPLETED + RELEASED');

  const sellerAfter = (await api('/api/wallets/me', { token: seller.token })).data.availableBalance;
  const buyerAfterRelease = (await api('/api/wallets/me', { token: buyer.token })).data.availableBalance;
  assert(sellerAfter - sellerBefore === PRICE, `Người bán nhận đúng ${PRICE.toLocaleString('vi-VN')}₫`);
  assert(buyerAfterRelease === buyerBefore, 'Người mua không nhận lại đồng nào — toàn bộ tiền đã chuyển cho người bán');

  // ---- M13: idempotency ----
  section('M13: Gửi lại cùng mã yêu cầu không chuyển tiền hai lần');
  const replay = await api(`/api/transactions/${txnId}/release`, {
    method: 'POST', token: buyer.token, body: { requestId, reauthGrant: grant },
  });
  assert(replay.status === 200, 'Gửi lại đúng mã yêu cầu trả về kết quả cũ');
  const sellerAfterReplay = (await api('/api/wallets/me', { token: seller.token })).data.availableBalance;
  assert(sellerAfterReplay === sellerAfter, 'Số dư người bán không tăng thêm lần thứ hai');

  // ---- M14: bán xong thì sản phẩm rời sàn ----
  section('M14: Bán xong, sản phẩm không quay lại sàn');
  const afterSale = await api('/api/listings/' + listingId);
  assert(afterSale.data.isSold === true, 'Tin đăng vẫn ở trạng thái đã bán sau khi hoàn tất');
  const reorder = await api('/api/transactions/orders', {
    method: 'POST', token: buyer2.token, body: { listingId },
  });
  assert(reorder.status === 409, `Không đặt mua lại được sản phẩm đã bán (nhận ${reorder.status})`);

  // ---- M15: chuỗi nhật ký ----
  section('M15: Chuỗi nhật ký của giao dịch');
  const logs = await api(`/api/transactions/${txnId}/logs`, { token: buyer.token });
  assert(logs.status === 200 && logs.data.logs.length >= 4, `Giao dịch có ${logs.data.logs.length} bản ghi nhật ký`);
  const seqs = logs.data.logs.map((l) => l.sequenceNo).filter((n) => n !== undefined);
  if (seqs.length) {
    const lienTuc = seqs.every((n, i) => n === i + 1);
    assert(lienTuc, 'Số thứ tự các bản ghi liên tục từ 1');
  }
  const chain = await api(`/api/transactions/${txnId}/logs/verify`, { token: buyer.token });
  assert(chain.data.valid === true, 'Chuỗi băm hợp lệ');

  const outsider = await api(`/api/transactions/${txnId}/logs`, { token: buyer2.token });
  assert(outsider.status === 403, `Người ngoài giao dịch không đọc được nhật ký (nhận ${outsider.status})`);

  // ---- M16: người bán mở tranh chấp ----
  section('M16: Người bán mở tranh chấp khi người mua phủ nhận đã nhận hàng');
  const listing2 = await api('/api/listings', {
    method: 'POST', token: seller.token,
    body: { title: `Laptop cũ ${rand}`, category: 'MAY_TINH', price: 400000, location: 'TP. Hồ Chí Minh' },
  });
  const order2 = await api('/api/transactions/orders', {
    method: 'POST', token: buyer.token, body: { listingId: listing2.data.id },
  });
  const txn2 = order2.data.id;
  await api(`/api/transactions/${txn2}/secure`, {
    method: 'POST', token: buyer.token, body: { requestId: crypto.randomUUID() },
  });
  await api(`/api/transactions/${txn2}/ship`, { method: 'POST', token: seller.token });
  await api(`/api/transactions/${txn2}/wait-confirm`, { method: 'POST', token: buyer.token });

  const dispute = await api(`/api/transactions/${txn2}/dispute`, {
    method: 'POST', token: seller.token, body: { reason: 'Người mua đã nhận hàng nhưng không xác nhận' },
  });
  assert(dispute.status === 201, `Người bán mở được tranh chấp (nhận ${dispute.status})`);
  assert(dispute.data.dispute.openedBy === 'SELLER', 'Hồ sơ ghi đúng bên mở là người bán');
  assert(dispute.data.transaction.escrowStatus === 'FROZEN', 'Tiền chuyển sang trạng thái đóng băng');

  const frozenRelease = await api(`/api/transactions/${txn2}/release`, {
    method: 'POST', token: buyer.token, body: { requestId: crypto.randomUUID(), reauthGrant: 'x' },
  });
  assert(frozenRelease.status !== 200, `Đóng băng rồi thì lối giải ngân thông thường bị chặn (nhận ${frozenRelease.status})`);

  // ---- M17: quản trị viên phân xử ----
  section('M17: Quản trị viên phân xử tranh chấp');
  // Quản trị viên đã được nâng quyền ở M01.
  {
    const list = await api('/api/admin/disputes?status=OPEN', { token: admin.token });
    const target = list.data.disputes.find((d) => d.transactionId === txn2);
    assert(!!target, 'Quản trị viên thấy hồ sơ tranh chấp đang mở');

    const sellerBeforeResolve = (await api('/api/wallets/me', { token: seller.token })).data.availableBalance;
    // Quyết định phân xử làm tiền rời khỏi ký quỹ nên phải kèm phiếu uỷ quyền của chính
    // quản trị viên, ràng buộc đúng hồ sơ tranh chấp này và đúng quyết định RELEASE.
    const adjGrant = await flows.adjudicationGrant(admin.token, admin.auth, target.id, 'RELEASE');
    assert(adjGrant.status === 200 && adjGrant.data.reauthGrant, 'Cấp phiếu phân xử RELEASE thành công');
    assert(adjGrant.data.signedContext.decision === 'RELEASE', 'Ngữ cảnh được ký mang đúng quyết định');

    const resolved = await api(`/api/admin/disputes/${target.id}/release`, {
      method: 'POST', token: admin.token,
      body: { requestId: crypto.randomUUID(), reauthGrant: adjGrant.data.reauthGrant },
    });
    assert(resolved.status === 200, `Phân xử giải ngân thành công (nhận ${resolved.status})`);
    assert(resolved.data.transaction.status === 'RELEASED',
      'Trạng thái RELEASED phân biệt với COMPLETED, giữ lại căn cứ giải ngân');

    const sellerAfterResolve = (await api('/api/wallets/me', { token: seller.token })).data.availableBalance;
    assert(sellerAfterResolve - sellerBeforeResolve === 400000, 'Người bán nhận toàn bộ số tiền theo phán quyết');
  }

  // ---- M18: LOCK concurrent — N buyer cùng khoá một tin đăng, đúng 1 người thắng ----
  // Đây là ma trận kiểm thử "LOCK concurrent" bắt buộc của Chương 3: 1 listing AVAILABLE,
  // N transaction CREATED, N buyer bắn /secure THẬT SỰ đồng thời (Promise.all, không phải
  // bấm hai lần chậm). Hàng rào phải là listings.status + version (cập nhật có điều kiện
  // trong lockListingForOrder), không phải việc dò transactions.listing_id — nên kiểm
  // chứng đọc thẳng từ DB, không chỉ từ response HTTP.
  section('M18: LOCK concurrent — N buyer đặt và khoá tiền cùng lúc trên MỘT tin đăng');
  {
    const { db } = require('../src/db');
    const N = 5;
    const racePrice = 500000;

    const raceListing = await api('/api/listings', {
      method: 'POST', token: seller.token,
      body: { title: `Đua khoá tin đăng ${rand}`, category: 'DIEN_TU', price: racePrice, location: 'Hà Nội' },
    });
    const raceListingId = raceListing.data.id;

    const raceBuyers = [];
    for (let i = 0; i < N; i++) {
      raceBuyers.push(await registerUser({ username: `race${i}_${rand}`, displayName: `Race Buyer ${i}` }));
    }

    // Mỗi buyer tạo đơn riêng cho cùng tin đăng — tất cả đều CREATED + NONE, chưa ai giữ
    // chỗ (findReservingOrder chỉ chặn ở trạng thái giữ chỗ trở lên, CREATED thì chưa).
    const orderIds = [];
    for (const b of raceBuyers) {
      const o = await api('/api/transactions/orders', { method: 'POST', token: b.token, body: { listingId: raceListingId } });
      assert(o.status === 201, `Buyer đua tạo đơn CREATED thành công (nhận ${o.status})`);
      orderIds.push(o.data.id);
    }

    const beforeBalances = await Promise.all(raceBuyers.map((b) => api('/api/wallets/me', { token: b.token })));

    const secureResults = await Promise.all(
      orderIds.map((txnId, i) =>
        api(`/api/transactions/${txnId}/secure`, {
          method: 'POST', token: raceBuyers[i].token, body: { requestId: `race-lock-${i}-${rand}` },
        })
      )
    );

    const wins = secureResults.filter((r) => r.status === 200);
    const losses = secureResults.filter((r) => r.status !== 200);
    assert(wins.length === 1, `Đúng 1/${N} request LOCK đồng thời thành công (thực tế: ${wins.length})`);
    assert(losses.length === N - 1 && losses.every((r) => r.status === 409),
      `${N - 1} request còn lại đều nhận 409 (thực tế: ${losses.map((r) => r.status).join(',')})`);
    assert(losses.every((r) => r.data.error === 'LISTING_SOLD'), 'Request thua đều nhận đúng mã lỗi LISTING_SOLD');

    // Kiểm ở DB, không chỉ ở response HTTP.
    const listingRow = db.prepare('SELECT status, version FROM listings WHERE id = ?').get(raceListingId);
    assert(listingRow.status === 'LOCKED', 'listings.status chuyển đúng sang LOCKED');
    assert(listingRow.version === 1, `listings.version tăng đúng 1 lần (thực tế: ${listingRow.version})`);

    const secureCount = db
      .prepare(`SELECT COUNT(*) AS n FROM transactions WHERE id IN (${orderIds.map(() => '?').join(',')}) AND status = 'SECURED'`)
      .get(...orderIds).n;
    assert(secureCount === 1, `Chỉ đúng 1 transaction ở SECURED trong số ${N} đơn cạnh tranh (thực tế: ${secureCount})`);

    const afterBalances = await Promise.all(raceBuyers.map((b) => api('/api/wallets/me', { token: b.token })));
    let debitedCount = 0;
    for (let i = 0; i < N; i++) {
      const delta = beforeBalances[i].data.availableBalance - afterBalances[i].data.availableBalance;
      if (delta !== 0) {
        assert(delta === racePrice, `Nếu một buyer đua bị trừ tiền thì trừ đúng ${racePrice.toLocaleString('vi-VN')}₫`);
        debitedCount++;
      }
    }
    assert(debitedCount === 1, `Chỉ đúng 1 buyer bị trừ tiền trong số ${N} người đua (thực tế: ${debitedCount})`);

    const escrowCreditCount = db
      .prepare(
        `SELECT COUNT(*) AS n FROM wallet_entries
         WHERE transaction_id IN (${orderIds.map(() => '?').join(',')}) AND entry_type = 'ESCROW_LOCK_CREDIT'`
      )
      .get(...orderIds).n;
    assert(escrowCreditCount === 1, `Escrow chỉ được cộng tiền đúng 1 lần trong số ${N} người đua (thực tế: ${escrowCreditCount})`);
  }

  console.log(failures === 0 ? '\n=== KẾT QUẢ: TẤT CẢ PASS ✅ ===\n' : `\n=== KẾT QUẢ: ${failures} KIỂM THỬ THẤT BẠI ❌ ===\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('LỖI KHÔNG MONG ĐỢI:', e);
  process.exit(1);
});
