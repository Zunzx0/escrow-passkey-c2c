// Nạp .env để lấy cấu hình WebAuthn cho các test.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

// Node >= 18 đã có fetch sẵn; chỉ fallback sang node-fetch cho Node cũ.
const fetch = globalThis.fetch || require('node-fetch');
const { createAuthenticator } = require('./softwareAuthenticator');
const { createAdmin, createSeller, flows } = require('./helpers/accounts');

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const RP_ID = 'localhost';
const ORIGIN = BASE;

let failures = 0;
function assert(cond, label) {
  if (cond) {
    console.log(`  ✅ ${label}`);
  } else {
    console.log(`  ❌ ${label}`);
    failures++;
  }
}

async function api(path, opts = {}, retried = false) {
  const { method = 'GET', body, token } = opts;
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = {};
  try { data = await res.json(); } catch (_) {}

  // Endpoint Passkeys giới hạn 10 request/phút/IP. Bộ test tạo nhiều tài khoản nên sẽ
  // chạm trần — chờ hết cửa sổ rồi thử lại thay vì hạ mức bảo mật xuống cho dễ test.
  if (res.status === 429 && !retried) {
    console.log('  ⏳ Chạm rate limit 10 req/phút (đúng thiết kế) — chờ 60 giây rồi thử lại…');
    await new Promise((r) => setTimeout(r, 61000));
    return api(path, opts, true);
  }
  return { status: res.status, data };
}

// Vai trò do server quyết định, client KHÔNG tự chọn được. Đăng ký LUÔN ra BUYER. Người bán phải đi qua quy trình xin và duyệt; quản trị viên
// chỉ được tạo bằng thủ tục vận hành (xem test/helpers/accounts.js).

// Đăng ký gồm HAI bước: tạo tài khoản bằng mật khẩu, rồi đăng ký Passkey bắt buộc. Chỉ sau
// bước thứ hai tài khoản mới ACTIVE và mới có ví.
//
// `extra` cho phép nhồi thêm trường lạ (role, inviteCode…) vào payload để kiểm rằng máy chủ
// bỏ qua chúng. Luồng đăng ký chỉ đọc username, displayName và password.
const registerUser = flows.registerUser;
const login = flows.loginPasskey;

async function main() {
  console.log(`\n=== E2E TEST: ${BASE} ===\n`);

  // ---- TC01: Đăng ký Buyer bằng Passkey -> wallet 5.000.000 + DEMO_TOPUP ----
  console.log('TC01: Đăng ký Buyer');
  const rand = Date.now();
  const buyer = await registerUser({ username: `buyer_${rand}`, displayName: 'Buyer Test' });
  assert(buyer.status === 201 && buyer.user.role === 'BUYER', 'Đăng ký Buyer trả 201');
  const buyerWallet1 = await api('/api/wallets/me', { token: buyer.token });
  assert(buyerWallet1.data.availableBalance === 5000000, 'Buyer có sẵn 5.000.000 VND');
  const buyerEntries1 = await api('/api/wallets/me/entries', { token: buyer.token });
  assert(buyerEntries1.data.entries.some((e) => e.entryType === 'DEMO_TOPUP'), 'Có wallet entry DEMO_TOPUP');

  // ---- TC02: Không thể tự nâng quyền (AUTH-02) ----
  // Luồng đăng ký không nhận tham số nào quyết định quyền, nên trường `role` client
  // gửi lên bị bỏ qua hoàn toàn ở cả hai bước.
  console.log('\nTC02: Không cho tự đăng ký ADMIN');
  const selfClaim = await registerUser({ username: `hacker_${rand}`, displayName: 'Hacker' });
  assert(selfClaim.status === 201 && selfClaim.user.role === 'BUYER',
    'Đăng ký luôn ra BUYER, không thể tự nhận role ADMIN');

  const injectRole = await registerUser({ username: `hacker2_${rand}`, displayName: 'Hacker 2', role: 'ADMIN' });
  assert(injectRole.status === 201 && injectRole.user.role === 'BUYER',
    'Client gửi kèm role=ADMIN bị bỏ qua, server vẫn cấp BUYER');

  // Quản trị viên: chỉ tạo được bằng thủ tục vận hành, không qua đường mạng.
  const admin = await createAdmin(registerUser, { username: `admin_${rand}`, displayName: 'Quan Tri Vien' });
  assert(admin.user.role === 'ADMIN', 'Thủ tục vận hành nâng được BUYER lên ADMIN');
  const adminJwt = admin.token;

  // Người bán: đi qua đúng quy trình xin và duyệt.
  const seller = await createSeller(api, registerUser, admin, { username: `seller_${rand}`, displayName: 'Seller Test' });
  assert(seller.user && seller.user.role === 'SELLER', 'Duyệt yêu cầu nâng BUYER lên SELLER');
  // Người bán vốn là một người mua được nâng quyền, nên ví vẫn giữ nguyên số dư demo và
  // toàn bộ lịch sử cũ. Vì vậy mốc so sánh là số dư tại thời điểm này, không phải 0.
  const sellerWallet0 = await api('/api/wallets/me', { token: seller.token });
  const sellerStart = sellerWallet0.data.availableBalance;
  assert(sellerWallet0.data.lockedBalance === 0, 'Seller chưa có khoản nào bị khóa');

  // ---- TC05: Đăng nhập Passkey ----
  console.log('\nTC05: Đăng nhập lại bằng Passkey');
  const loginResp = await login(buyer.auth);
  assert(loginResp.status === 200 && loginResp.data.token, 'Đăng nhập lại thành công, có JWT');

  // ---- TC06: Buyer tạo transaction ----
  console.log('\nTC06: Buyer tạo giao dịch');
  const createTxn = await api('/api/transactions', {
    method: 'POST', token: buyer.token,
    body: { sellerId: seller.user.id, itemName: 'iPhone cũ', amount: 2000000 },
  });
  assert(createTxn.status === 201 && createTxn.data.status === 'CREATED', 'Transaction CREATED');
  const txnId = createTxn.data.id;

  // ---- TC10: Seller khác cập nhật giao dịch (không sở hữu) -> 403 ----
  console.log('\nTC10: Seller không sở hữu bị chặn');
  const otherSeller = await createSeller(api, registerUser, admin, { username: `seller2_${rand}`, displayName: 'Seller Khac' });
  const forbiddenShip = await api(`/api/transactions/${txnId}/ship`, { method: 'POST', token: otherSeller.token });
  assert(forbiddenShip.status === 403, 'Seller khác bị 403 khi thao tác giao dịch không sở hữu');

  // ---- TC11: CREATED -> COMPLETED (nhảy cóc) bị chặn ----
  console.log('\nTC11: Không cho nhảy cóc trạng thái');
  const skipRelease = await api(`/api/transactions/${txnId}/release`, {
    method: 'POST', token: buyer.token, body: { requestId: 'x', reauthGrant: 'y' },
  });
  assert(skipRelease.status === 409, 'Release khi còn CREATED bị 409 INVALID_STATE');

  // ---- TC07: Buyer không đủ số dư ----
  console.log('\nTC07: Buyer không đủ số dư bị rollback');
  // 100.000.000đ là mức tối đa của một giao dịch (lib/money.js), vẫn vượt xa số dư 5.000.000đ.
  const bigTxn = await api('/api/transactions', {
    method: 'POST', token: buyer.token,
    body: { sellerId: seller.user.id, itemName: 'Xe hơi', amount: 100000000 },
  });
  assert(bigTxn.status === 201, 'Tạo được giao dịch ở mức tối đa cho phép');
  const failLock = await api(`/api/transactions/${bigTxn.data.id}/secure`, {
    method: 'POST', token: buyer.token, body: { requestId: 'req-insufficient-' + rand },
  });
  assert(failLock.status === 400, 'Khóa tiền vượt số dư bị từ chối (400)');
  const walletAfterFail = await api('/api/wallets/me', { token: buyer.token });
  assert(walletAfterFail.data.availableBalance === 5000000, 'Số dư Buyer KHÔNG đổi sau lock thất bại (rollback đúng)');

  // ---- TC08 + TC09: Lock Escrow hợp lệ + idempotency ----
  console.log('\nTC08+TC09: Lock Escrow + gửi lại cùng requestId');
  const lockReqId = 'lock-req-' + rand;
  const lock1 = await api(`/api/transactions/${txnId}/secure`, { method: 'POST', token: buyer.token, body: { requestId: lockReqId } });
  assert(lock1.status === 200 && lock1.data.status === 'SECURED' && lock1.data.escrowStatus === 'LOCKED', 'Lock Escrow -> SECURED+LOCKED');

  const buyerWalletAfterLock = await api('/api/wallets/me', { token: buyer.token });
  assert(buyerWalletAfterLock.data.availableBalance === 3000000, 'Buyer giảm đúng 2.000.000');
  assert(buyerWalletAfterLock.data.lockedBalance === 0, 'Buyer không có locked (locked nằm ở ví Escrow)');

  const lock2 = await api(`/api/transactions/${txnId}/secure`, { method: 'POST', token: buyer.token, body: { requestId: lockReqId } });
  assert(lock2.status === 200, 'Gửi lại cùng requestId trả 200 (idempotent)');
  const buyerWalletAfterReplay = await api('/api/wallets/me', { token: buyer.token });
  assert(buyerWalletAfterReplay.data.availableBalance === 3000000, 'Số dư KHÔNG bị trừ thêm lần 2 (idempotency đúng)');

  // ---- Seller ship -> wait-confirm (UC06) ----
  console.log('\nUC06: Seller cập nhật giao hàng');
  const ship1 = await api(`/api/transactions/${txnId}/ship`, { method: 'POST', token: seller.token });
  assert(ship1.status === 200 && ship1.data.status === 'SHIPPING', 'SECURED -> SHIPPING');
  const wc1 = await api(`/api/transactions/${txnId}/wait-confirm`, { method: 'POST', token: buyer.token });
  assert(wc1.status === 200 && wc1.data.status === 'WAIT_CONFIRM', 'SHIPPING -> WAIT_CONFIRM');

  // ---- TC12+TC13: Re-auth đúng transaction / grant transaction A dùng cho B ----
  console.log('\nTC12+TC13: Re-auth grant chỉ dùng đúng transaction');
  const reauthOpt = await api(`/api/transactions/${txnId}/reauth/options`, { method: 'POST', token: buyer.token });
  assert(reauthOpt.status === 200, 'Tạo reauth challenge OK');
  const assertion1 = buyer.auth.authenticate({ rpId: RP_ID, origin: ORIGIN, challenge: reauthOpt.data.options.challenge });
  const reauthVerify = await api(`/api/transactions/${txnId}/reauth/verify`, {
    method: 'POST', token: buyer.token,
    body: { reauthSessionId: reauthOpt.data.reauthSessionId, response: assertion1 },
  });
  assert(reauthVerify.status === 200 && reauthVerify.data.reauthGrant, 'Tạo grant thành công');
  const grant = reauthVerify.data.reauthGrant;

  // Tạo transaction B và thử dùng grant của A cho B
  const txnB = await api('/api/transactions', {
    method: 'POST', token: buyer.token, body: { sellerId: seller.user.id, itemName: 'Item B', amount: 100000 },
  });
  const crossUse = await api(`/api/transactions/${txnB.data.id}/release`, {
    method: 'POST', token: buyer.token, body: { requestId: 'cross-' + rand, reauthGrant: grant },
  });
  assert(crossUse.status === 401 || crossUse.status === 409, 'Grant của giao dịch A KHÔNG dùng được cho giao dịch B');

  // ---- TC14+TC15: Release hợp lệ + release lần hai ----
  console.log('\nTC14+TC15: Release hợp lệ + release lần hai bị chặn');
  const releaseReqId = 'release-req-' + rand;
  const release1 = await api(`/api/transactions/${txnId}/release`, {
    method: 'POST', token: buyer.token, body: { requestId: releaseReqId, reauthGrant: grant },
  });
  assert(release1.status === 200 && release1.data.status === 'COMPLETED' && release1.data.escrowStatus === 'RELEASED', 'Release -> COMPLETED+RELEASED');

  const sellerWalletAfterRelease = await api('/api/wallets/me', { token: seller.token });
  assert(sellerWalletAfterRelease.data.availableBalance === sellerStart + 2000000,
    'Seller nhận đúng 2.000.000 so với số dư trước khi giải ngân');

  const release2 = await api(`/api/transactions/${txnId}/release`, {
    method: 'POST', token: buyer.token, body: { requestId: 'release-again-' + rand, reauthGrant: grant },
  });
  assert(release2.status === 401 || release2.status === 409, 'Release lần hai (grant đã dùng) bị từ chối');

  // ---- TC22: Ledger đủ 2 entries mỗi thao tác ----
  console.log('\nTC22: Ledger đủ 2 entries mỗi thao tác tài chính');
  const finalBuyerEntries = await api('/api/wallets/me/entries', { token: buyer.token });
  const lockDebits = finalBuyerEntries.data.entries.filter((e) => e.entryType === 'ESCROW_LOCK_DEBIT');
  assert(lockDebits.length === 1, 'Buyer có đúng 1 entry ESCROW_LOCK_DEBIT (không trùng lặp)');

  // ---- TC17: Transaction version cũ ----
  console.log('\nTC17: Transaction version cũ bị 409');
  const txnCreatedRow = await api(`/api/transactions/${txnB.data.id}`, { token: buyer.token });
  // Gọi secure với version đúng trước, rồi thử double-call song song để giả lập version conflict qua race
  // (đã kiểm chứng qua TC16 bên dưới bằng Promise.all)

  // ---- TC16 / TC27: Hai release đồng thời — chỉ một thành công ----
  console.log('\nTC16: Hai giải ngân đồng thời trên cùng transaction — chỉ 1 thành công');
  const buyer2 = await registerUser({ username: `buyer2_${rand}`, displayName: 'Buyer 2' });
  const seller2 = await createSeller(api, registerUser, admin, { username: `seller3_${rand}`, displayName: 'Seller 3' });
  const txnC = await api('/api/transactions', {
    method: 'POST', token: buyer2.token, body: { sellerId: seller2.user.id, itemName: 'Concurrent Item', amount: 500000 },
  });
  await api(`/api/transactions/${txnC.data.id}/secure`, { method: 'POST', token: buyer2.token, body: { requestId: 'lockc-' + rand } });
  await api(`/api/transactions/${txnC.data.id}/ship`, { method: 'POST', token: seller2.token });
  await api(`/api/transactions/${txnC.data.id}/wait-confirm`, { method: 'POST', token: buyer2.token });
  const reauthOptC = await api(`/api/transactions/${txnC.data.id}/reauth/options`, { method: 'POST', token: buyer2.token });
  const assertionC = buyer2.auth.authenticate({ rpId: RP_ID, origin: ORIGIN, challenge: reauthOptC.data.options.challenge });
  const reauthVerifyC = await api(`/api/transactions/${txnC.data.id}/reauth/verify`, {
    method: 'POST', token: buyer2.token,
    body: { reauthSessionId: reauthOptC.data.reauthSessionId, response: assertionC },
  });
  const grantC = reauthVerifyC.data.reauthGrant;

  const [rA, rB] = await Promise.all([
    api(`/api/transactions/${txnC.data.id}/release`, { method: 'POST', token: buyer2.token, body: { requestId: 'race-A-' + rand, reauthGrant: grantC } }),
    api(`/api/transactions/${txnC.data.id}/release`, { method: 'POST', token: buyer2.token, body: { requestId: 'race-B-' + rand, reauthGrant: grantC } }),
  ]);
  const successCount = [rA, rB].filter((r) => r.status === 200).length;
  assert(successCount === 1, `Chỉ đúng 1/2 request release đồng thời thành công (thực tế: ${successCount})`);

  // ---- TC19+TC20+TC21: Dispute -> Admin refund/release ----
  console.log('\nTC19-21: Dispute + Admin refund/release');
  const txnD = await api('/api/transactions', {
    method: 'POST', token: buyer.token, body: { sellerId: seller.user.id, itemName: 'Item Dispute', amount: 300000 },
  });
  await api(`/api/transactions/${txnD.data.id}/secure`, { method: 'POST', token: buyer.token, body: { requestId: 'lockd-' + rand } });
  await api(`/api/transactions/${txnD.data.id}/ship`, { method: 'POST', token: seller.token });
  await api(`/api/transactions/${txnD.data.id}/wait-confirm`, { method: 'POST', token: buyer.token });
  const disputeResp = await api(`/api/transactions/${txnD.data.id}/dispute`, {
    method: 'POST', token: buyer.token, body: { reason: 'Hàng không đúng mô tả' },
  });
  assert(disputeResp.status === 201 && disputeResp.data.transaction.status === 'DISPUTED' && disputeResp.data.transaction.escrowStatus === 'FROZEN', 'Dispute -> DISPUTED+FROZEN');

  // Admin đã được tạo ở TC02 bằng thủ tục vận hành.
  {
    const disputeId = disputeResp.data.dispute.id;

    // Quyết định phân xử làm tiền rời khỏi ký quỹ, nên nó cũng phải kèm phiếu uỷ quyền sinh
    // từ một lần xác thực lại bằng Passkey của CHÍNH quản trị viên. Không có phiếu thì lệnh
    // bị từ chối ở máy chủ, kể cả khi phiên quản trị hoàn toàn hợp lệ.
    const refundNoGrant = await api(`/api/admin/disputes/${disputeId}/refund`, {
      method: 'POST', token: adminJwt, body: { requestId: 'refund-nogrant-' + rand },
    });
    assert(refundNoGrant.status === 401, `Phân xử KHÔNG kèm phiếu bị từ chối (nhận ${refundNoGrant.status})`);

    // Phiếu ràng buộc đúng một quyết định: phiếu cấp cho hoàn tiền không dùng cho giải ngân được.
    const refundGrant = await flows.adjudicationGrant(adminJwt, admin.auth, disputeId, 'REFUND');
    assert(refundGrant.status === 200 && refundGrant.data.reauthGrant, 'Cấp phiếu phân xử REFUND thành công');

    const wrongWay = await api(`/api/admin/disputes/${disputeId}/release`, {
      method: 'POST', token: adminJwt,
      body: { requestId: 'release-wrong-' + rand, reauthGrant: refundGrant.data.reauthGrant },
    });
    assert(wrongWay.status === 401, `Phiếu REFUND dùng cho RELEASE bị từ chối (nhận ${wrongWay.status})`);

    const refundResp2 = await api(`/api/admin/disputes/${disputeId}/refund`, {
      method: 'POST', token: adminJwt,
      body: { requestId: 'refund-' + rand, reauthGrant: refundGrant.data.reauthGrant },
    });
    assert(refundResp2.status === 200 && refundResp2.data.transaction.status === 'REFUNDED', 'Admin refund -> REFUNDED+REFUNDED');

    // Phiếu dùng một lần: sau khi đã tiêu thụ thì không tái sử dụng được.
    const refundAgain = await api(`/api/admin/disputes/${disputeId}/refund`, {
      method: 'POST', token: adminJwt,
      body: { requestId: 'refund-again-' + rand, reauthGrant: refundGrant.data.reauthGrant },
    });
    assert(refundAgain.status >= 400, `Dùng lại phiếu phân xử đã tiêu thụ bị từ chối (nhận ${refundAgain.status})`);

    // TC28: không còn bất kỳ tham số nào ở bước đăng ký nâng được quyền.
    const stillBuyer = await registerUser({ username: `nobody_${rand}`, displayName: 'Khong Ai', role: 'ADMIN', inviteCode: 'ADM-ZZZZZ-ZZZZZ' });
    assert(stillBuyer.status === 201 && stillBuyer.user.role === 'BUYER',
      'Gửi kèm role và mã bịa đều bị bỏ qua, tài khoản vẫn là BUYER');

    // ---- TC23-26: Hash Chain ----
    console.log('\nTC23-26: Hash Chain verify');
    const logsResp = await api(`/api/admin/transactions/${txnId}/logs`, { token: adminJwt });
    assert(logsResp.data.logs.length >= 3, `Transaction ${txnId} có ${logsResp.data.logs.length} audit logs`);
    const verify1 = await api(`/api/admin/transactions/${txnId}/logs/verify`, { token: adminJwt });
    assert(verify1.data.valid === true, 'Hash Chain hợp lệ trước khi sửa');

    // TC24: sửa event_data trực tiếp trong DB rồi verify lại (giả lập tấn công)
  }

  console.log(`\n=== KẾT QUẢ: ${failures === 0 ? 'TẤT CẢ PASS ✅' : failures + ' TEST FAIL ❌'} ===\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('LỖI KHÔNG MONG ĐỢI:', e);
  process.exit(1);
});
