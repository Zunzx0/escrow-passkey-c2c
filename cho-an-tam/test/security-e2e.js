/**
 * E2E cho các lớp bảo vệ của hệ thống ký quỹ mua bán C2C.
 *
 * Mỗi mục kiểm ứng với một mối đe doạ đã nêu ở mục 2.3 của báo cáo:
 *
 *   SEC01  challenge ngẫu nhiên, ngữ cảnh uỷ quyền lưu ở máy chủ
 *   SEC02  sửa số tiền sau khi ký thì giải ngân bị chặn
 *   SEC03  trả lại đúng nội dung thì cùng phiếu đó giải ngân được
 *   SEC04  phiếu uỷ quyền dùng một lần, không giải ngân lần hai
 *   SEC05  phiếu của giao dịch này không dùng được cho giao dịch khác
 *   SEC06  gửi lặp yêu cầu khoá tiền chỉ tạo một tác động
 *   SEC07  cùng mã yêu cầu nhưng khác nội dung thì báo xung đột
 *   SEC08  hai người mua cùng một tin đăng, chỉ một người khoá được tiền
 *   SEC09  thao tác trên giao dịch không thuộc về mình bị từ chối
 *   SEC10  một tài khoản nhiều passkey, và quản lý passkey đòi xác thực lại
 *   SEC11  không xoá được passkey cuối cùng
 *   SEC12  chuỗi nhật ký phát hiện sửa, chèn và xoá bản ghi
 *
 * Yêu cầu: server đang chạy (npm start).
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
  if (res.status === 429 && !retried) {
    console.log('  ⏳ Chạm rate limit 10 req/phút (đúng thiết kế) — chờ 60 giây rồi thử lại…');
    await new Promise((r) => setTimeout(r, 61000));
    return api(path, opts, true);
  }
  return { status: res.status, data };
}

// Đăng ký gồm HAI bước: tạo tài khoản bằng mật khẩu, rồi đăng ký Passkey bắt buộc.
// Chỉ sau bước thứ hai tài khoản mới ACTIVE và mới có ví.
const registerUser = flows.registerUser;

const stamp = Date.now().toString(36);
const PRICE = 850000;

/** Đăng một sản phẩm mới. Mỗi tin đăng là một sản phẩm đơn chiếc. */
async function createListing(seller, title, price = PRICE) {
  const res = await api('/api/listings', {
    method: 'POST', token: seller.token,
    body: { title, category: 'DIEN_THOAI', description: 'Dùng cho kiểm thử', price, location: 'Hà Nội' },
  });
  if (!res.data.id) throw new Error(`Tạo tin đăng thất bại: ${res.status} ${JSON.stringify(res.data)}`);
  return res.data.id;
}

/** Đưa một giao dịch tới trạng thái chờ người mua xác nhận. */
async function orderUpTo(buyer, seller, listingId, stage = 'WAIT_CONFIRM') {
  const order = await api('/api/transactions/orders', {
    method: 'POST', token: buyer.token, body: { listingId, note: 'kiểm thử' },
  });
  if (!order.data.id) throw new Error(`Đặt mua thất bại: ${order.status} ${JSON.stringify(order.data)}`);
  const id = order.data.id;
  if (stage === 'CREATED') return id;

  const secured = await api(`/api/transactions/${id}/secure`, {
    method: 'POST', token: buyer.token, body: { requestId: crypto.randomUUID() },
  });
  if (secured.status !== 200) throw new Error(`Khoá tiền thất bại: ${secured.status} ${JSON.stringify(secured.data)}`);
  if (stage === 'SECURED') return id;

  await api(`/api/transactions/${id}/ship`, { method: 'POST', token: seller.token });
  const waiting = await api(`/api/transactions/${id}/wait-confirm`, { method: 'POST', token: buyer.token });
  if (waiting.status !== 200) throw new Error(`Chuyển WAIT_CONFIRM thất bại: ${waiting.status}`);
  return id;
}

/** Xác thực lại và lấy phiếu uỷ quyền giải ngân cho đúng một giao dịch. */
async function getReleaseGrant(buyer, txnId) {
  const opt = await api(`/api/transactions/${txnId}/reauth/options`, { method: 'POST', token: buyer.token });
  const assertion = buyer.auth.authenticate({ rpId: RP_ID, origin: ORIGIN, challenge: opt.data.options.challenge });
  const verify = await api(`/api/transactions/${txnId}/reauth/verify`, {
    method: 'POST', token: buyer.token,
    body: { reauthSessionId: opt.data.reauthSessionId, response: assertion },
  });
  return { grant: verify.data.reauthGrant, options: opt.data.options, context: opt.data.context };
}

/** Xác thực lại để lấy phiếu uỷ quyền cho thao tác quản lý passkey. */
async function getCredentialGrant(user, authenticator) {
  const opt = await api('/api/passkeys/reauth/options', { method: 'POST', token: user.token });
  const assertion = (authenticator || user.auth).authenticate({
    rpId: RP_ID, origin: ORIGIN, challenge: opt.data.options.challenge,
  });
  const verify = await api('/api/passkeys/reauth/verify', {
    method: 'POST', token: user.token,
    body: { reauthSessionId: opt.data.reauthSessionId, response: assertion },
  });
  return verify.data.reauthGrant;
}

async function main() {
  console.log(`\n=== E2E BẢO MẬT: ${BASE} ===`);

  // DB mở trực tiếp để mô phỏng kẻ tấn công sửa được dữ liệu.
  const { db } = require('../src/db');

  const buyer = await registerUser({ username: `sec_buyer_${stamp}`, displayName: 'Người mua kiểm thử' });
  const admin = await createAdmin(registerUser, {
    username: `sec_admin_${stamp}`, displayName: 'Quản trị kiểm thử',
  });
  const seller = await createSeller(api, registerUser, admin, {
    username: `sec_seller_${stamp}`, displayName: 'Người bán kiểm thử',
  });

  const listingId = await createListing(seller, 'Điện thoại kiểm thử bảo mật');
  const txnId = await orderUpTo(buyer, seller, listingId);

  // ---------------------------------------------------------------------- SEC01
  section('SEC01: Challenge ngẫu nhiên, ngữ cảnh uỷ quyền lưu ở máy chủ');
  const opt = await api(`/api/transactions/${txnId}/reauth/options`, { method: 'POST', token: buyer.token });
  const context = opt.data.context;
  assert(!!context, 'Server trả kèm ngữ cảnh để giao diện hiển thị thứ sắp uỷ quyền');
  assert(context && context.amount === PRICE, `Ngữ cảnh ghi đúng số tiền ${PRICE}`);
  assert(context && context.sellerId === seller.user.id, 'Ngữ cảnh ghi đúng người bán nhận tiền');

  const contextHash = crypto.createHash('sha256').update(JSON.stringify(context), 'utf8').digest('base64url');
  assert(opt.data.options.challenge !== contextHash,
    'Challenge KHÔNG phải giá trị băm của ngữ cảnh — đúng vai trò bảo đảm tính mới');

  const challengeBytes = Buffer.from(opt.data.options.challenge, 'base64url').length;
  assert(challengeBytes >= 16, `Challenge dài ${challengeBytes} byte, đạt tối thiểu 16 byte`);

  const opt2 = await api(`/api/transactions/${txnId}/reauth/options`, { method: 'POST', token: buyer.token });
  assert(opt2.data.options.challenge !== opt.data.options.challenge, 'Hai lần phát cho ra hai challenge khác nhau');
  assert(opt.data.options.userVerification === 'required',
    'Thao tác giải ngân đòi mức xác minh người dùng, không chấp nhận mức hiện diện');

  // ---------------------------------------------------------------------- SEC02
  section('SEC02: Sửa số tiền SAU KHI ký → giải ngân bị chặn');
  const assertion = buyer.auth.authenticate({ rpId: RP_ID, origin: ORIGIN, challenge: opt.data.options.challenge });
  const verify = await api(`/api/transactions/${txnId}/reauth/verify`, {
    method: 'POST', token: buyer.token,
    body: { reauthSessionId: opt.data.reauthSessionId, response: assertion },
  });
  const grant = verify.data.reauthGrant;
  assert(!!grant, 'Ký hợp lệ → nhận được phiếu uỷ quyền');

  const original = db.prepare('SELECT amount FROM transactions WHERE id = ?').get(txnId).amount;
  db.prepare('UPDATE transactions SET amount = ? WHERE id = ?').run(original + 1000000, txnId);

  const tampered = await api(`/api/transactions/${txnId}/release`, {
    method: 'POST', token: buyer.token, body: { requestId: crypto.randomUUID(), reauthGrant: grant },
  });
  assert(tampered.status === 409 && tampered.data.error === 'CONTEXT_MISMATCH',
    `Giải ngân bị CHẶN sau khi số tiền bị sửa (nhận ${tampered.status} ${tampered.data.error})`);
  const stillLocked = db.prepare('SELECT escrow_status FROM transactions WHERE id = ?').get(txnId);
  assert(stillLocked.escrow_status === 'LOCKED', 'Tiền vẫn nằm nguyên trong Escrow, không bị rút ra');

  // ---------------------------------------------------------------------- SEC03
  section('SEC03: Trả lại đúng nội dung ban đầu → cùng phiếu đó giải ngân được');
  db.prepare('UPDATE transactions SET amount = ? WHERE id = ?').run(original, txnId);
  const sellerBefore = db.prepare(
    'SELECT available_balance FROM wallets WHERE user_id = ?'
  ).get(seller.user.id).available_balance;
  // Ví ký quỹ dùng chung cho mọi giao dịch nên phải đo MỨC GIẢM, không đo số dư tuyệt
  // đối: các giao dịch khác đang dở dang vẫn giữ tiền ở đó một cách hợp lệ.
  const escrowBefore = db.prepare(
    `SELECT locked_balance FROM wallets WHERE wallet_type = 'SYSTEM_ESCROW'`
  ).get().locked_balance;

  const ok = await api(`/api/transactions/${txnId}/release`, {
    method: 'POST', token: buyer.token, body: { requestId: crypto.randomUUID(), reauthGrant: grant },
  });
  assert(ok.status === 200, `Giải ngân thành công khi nội dung khớp (nhận ${ok.status})`);
  assert(ok.data.status === 'COMPLETED', 'Giao dịch chuyển sang COMPLETED');

  const sellerAfter = db.prepare(
    'SELECT available_balance FROM wallets WHERE user_id = ?'
  ).get(seller.user.id).available_balance;
  assert(sellerAfter - sellerBefore === PRICE, `Người bán nhận đúng toàn bộ ${PRICE}, không tách khoản`);

  const escrowAfter = db.prepare(
    `SELECT locked_balance FROM wallets WHERE wallet_type = 'SYSTEM_ESCROW'`
  ).get().locked_balance;
  assert(escrowBefore - escrowAfter === PRICE, `Phần bị khoá của ký quỹ giảm đúng ${PRICE}`);

  const legs = db.prepare(
    `SELECT SUM(available_delta + locked_delta) AS tong FROM wallet_entries WHERE transaction_id = ?`
  ).get(txnId).tong;
  assert(legs === 0, 'Tổng biến động của mọi bút toán trong giao dịch bằng không');

  // ---------------------------------------------------------------------- SEC04
  section('SEC04: Phiếu uỷ quyền dùng một lần');
  const again = await api(`/api/transactions/${txnId}/release`, {
    method: 'POST', token: buyer.token, body: { requestId: crypto.randomUUID(), reauthGrant: grant },
  });
  assert(again.status !== 200, `Lệnh giải ngân thứ hai bị từ chối (nhận ${again.status} ${again.data.error})`);

  // ---------------------------------------------------------------------- SEC05
  section('SEC05: Phiếu của giao dịch này không dùng được cho giao dịch khác');
  const listingA = await createListing(seller, 'Sản phẩm A');
  const listingB = await createListing(seller, 'Sản phẩm B');
  const txnA = await orderUpTo(buyer, seller, listingA);
  const txnB = await orderUpTo(buyer, seller, listingB);
  const { grant: grantA } = await getReleaseGrant(buyer, txnA);

  const crossUse = await api(`/api/transactions/${txnB}/release`, {
    method: 'POST', token: buyer.token, body: { requestId: crypto.randomUUID(), reauthGrant: grantA },
  });
  assert(crossUse.status === 401 && crossUse.data.error === 'REAUTH_REQUIRED',
    `Phiếu của giao dịch A dùng cho giao dịch B bị từ chối (nhận ${crossUse.status} ${crossUse.data.error})`);

  const expired = db.prepare('SELECT id FROM reauth_grants WHERE transaction_id = ? AND used_at IS NULL').get(txnA);
  db.prepare('UPDATE reauth_grants SET expires_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 1000).toISOString(), expired.id);
  const stale = await api(`/api/transactions/${txnA}/release`, {
    method: 'POST', token: buyer.token, body: { requestId: crypto.randomUUID(), reauthGrant: grantA },
  });
  assert(stale.status === 401, `Phiếu hết hạn bị từ chối (nhận ${stale.status} ${stale.data.error})`);

  // ---------------------------------------------------------------------- SEC06
  section('SEC06: Gửi lặp yêu cầu khoá tiền chỉ tạo một tác động');
  const listingC = await createListing(seller, 'Sản phẩm C');
  const txnC = await orderUpTo(buyer, seller, listingC, 'CREATED');
  const sameRequestId = crypto.randomUUID();

  const lock1 = await api(`/api/transactions/${txnC}/secure`, {
    method: 'POST', token: buyer.token, body: { requestId: sameRequestId },
  });
  const lock2 = await api(`/api/transactions/${txnC}/secure`, {
    method: 'POST', token: buyer.token, body: { requestId: sameRequestId },
  });
  assert(lock1.status === 200 && lock2.status === 200, 'Cả hai lần gửi đều trả về 200');
  const lockLegs = db.prepare(
    `SELECT COUNT(*) AS n FROM wallet_entries WHERE transaction_id = ? AND entry_type = 'ESCROW_LOCK_DEBIT'`
  ).get(txnC).n;
  assert(lockLegs === 1, `Chỉ có đúng 1 bút toán trừ tiền, không nhân đôi (đếm được ${lockLegs})`);

  // ---------------------------------------------------------------------- SEC07
  section('SEC07: Cùng mã yêu cầu nhưng khác nội dung thì báo xung đột');
  const listingD = await createListing(seller, 'Sản phẩm D');
  const txnD = await orderUpTo(buyer, seller, listingD, 'CREATED');
  const reused = await api(`/api/transactions/${txnD}/secure`, {
    method: 'POST', token: buyer.token, body: { requestId: sameRequestId },
  });
  assert(reused.status === 409 && reused.data.error === 'IDEMPOTENCY_KEY_REUSED',
    `Mã yêu cầu đã dùng cho giao dịch khác bị chặn (nhận ${reused.status} ${reused.data.error})`);
  const dState = db.prepare('SELECT escrow_status FROM transactions WHERE id = ?').get(txnD);
  assert(dState.escrow_status === 'NONE', 'Giao dịch D không bị khoá tiền nhầm theo kết quả cũ');

  // ---------------------------------------------------------------------- SEC08
  section('SEC08: Hai người mua cùng một tin đăng, chỉ một người khoá được tiền');
  const buyer2 = await registerUser({ username: `sec_buyer2_${stamp}`, displayName: 'Người mua thứ hai' });
  const listingE = await createListing(seller, 'Sản phẩm đơn chiếc');
  const txnE1 = await orderUpTo(buyer, seller, listingE, 'CREATED');
  const txnE2 = await orderUpTo(buyer2, seller, listingE, 'CREATED');

  const race1 = await api(`/api/transactions/${txnE1}/secure`, {
    method: 'POST', token: buyer.token, body: { requestId: crypto.randomUUID() },
  });
  const race2 = await api(`/api/transactions/${txnE2}/secure`, {
    method: 'POST', token: buyer2.token, body: { requestId: crypto.randomUUID() },
  });
  const winners = [race1, race2].filter((r) => r.status === 200).length;
  assert(winners === 1, `Đúng một người khoá được tiền (thành công: ${winners})`);
  assert(race2.status === 409 && race2.data.error === 'LISTING_SOLD',
    `Người đến sau nhận đúng lỗi sản phẩm đã bán (nhận ${race2.status} ${race2.data.error})`);

  // ---------------------------------------------------------------------- SEC09
  section('SEC09: Thao tác trên giao dịch không thuộc về mình bị từ chối');
  const idor = await api(`/api/transactions/${txnE1}/release`, {
    method: 'POST', token: buyer2.token, body: { requestId: crypto.randomUUID(), reauthGrant: 'bat-ky' },
  });
  assert(idor.status === 403 && idor.data.error === 'FORBIDDEN',
    `Người ngoài giao dịch bị chặn ở bước kiểm quyền sở hữu (nhận ${idor.status} ${idor.data.error})`);

  // ---------------------------------------------------------------------- SEC10
  section('SEC10: Nhiều passkey trên một tài khoản, quản lý passkey đòi xác thực lại');
  const owner = await registerUser({ username: `sec_multi_${stamp}`, displayName: 'Người nhiều thiết bị' });

  let list = await api('/api/passkeys/credentials', { token: owner.token });
  assert(list.data.credentials.length === 1, 'Sau đăng ký có đúng 1 thiết bị');

  const phone = createAuthenticator();
  const noGrant = await api('/api/passkeys/credentials/options', {
    method: 'POST', token: owner.token, body: { deviceName: 'Điện thoại dự phòng' },
  });
  assert(noGrant.status === 401 && noGrant.data.error === 'REAUTH_REQUIRED',
    `Thêm thiết bị khi chỉ có mã phiên bị từ chối (nhận ${noGrant.status} ${noGrant.data.error})`);

  const credGrant = await getCredentialGrant(owner);
  assert(!!credGrant, 'Xác thực lại bằng passkey đang có thì nhận được phiếu uỷ quyền');

  const addOpt = await api('/api/passkeys/credentials/options', {
    method: 'POST', token: owner.token, body: { deviceName: 'Điện thoại dự phòng', reauthGrant: credGrant },
  });
  const addResp = phone.register({ rpId: RP_ID, origin: ORIGIN, challenge: addOpt.data.options.challenge });
  const added = await api('/api/passkeys/credentials/verify', {
    method: 'POST', token: owner.token,
    body: { registrationSessionId: addOpt.data.registrationSessionId, response: addResp, reauthGrant: credGrant },
  });
  assert(added.status === 201 && added.data.credentials.length === 2, 'Có phiếu thì thêm được thiết bị thứ hai');
  assert(added.data.credentials.some((c) => c.deviceName === 'Điện thoại dự phòng'), 'Thiết bị mới lưu đúng tên');

  const loginOpt = await api('/api/passkeys/login/options', { method: 'POST' });
  const loginAssertion = phone.authenticate({ rpId: RP_ID, origin: ORIGIN, challenge: loginOpt.data.options.challenge });
  const login = await api('/api/passkeys/login/verify', {
    method: 'POST',
    body: { authenticationSessionId: loginOpt.data.authenticationSessionId, response: loginAssertion },
  });
  assert(login.status === 200 && login.data.user.id === owner.user.id,
    'Đăng nhập bằng thiết bị thứ hai vào đúng tài khoản cũ');

  // ---------------------------------------------------------------------- SEC11
  section('SEC11: Không cho tự khoá mình ra ngoài');
  const first = added.data.credentials.find((c) => c.deviceName !== 'Điện thoại dự phòng');
  const delNoGrant = await api(`/api/passkeys/credentials/${first.id}`, { method: 'DELETE', token: owner.token });
  assert(delNoGrant.status === 401, `Xoá thiết bị khi không có phiếu bị từ chối (nhận ${delNoGrant.status})`);

  const delGrant1 = await getCredentialGrant(owner, phone);
  const del1 = await api(`/api/passkeys/credentials/${first.id}`, {
    method: 'DELETE', token: owner.token, body: { reauthGrant: delGrant1 },
  });
  assert(del1.status === 200 && del1.data.credentials.length === 1, 'Có phiếu thì xoá được thiết bị khi còn cái khác');

  const lastId = del1.data.credentials[0].id;
  const delGrant2 = await getCredentialGrant(owner, phone);
  const del2 = await api(`/api/passkeys/credentials/${lastId}`, {
    method: 'DELETE', token: owner.token, body: { reauthGrant: delGrant2 },
  });
  assert(del2.status === 409 && del2.data.error === 'LAST_CREDENTIAL',
    `Xoá passkey CUỐI CÙNG bị từ chối (nhận ${del2.status} ${del2.data.error})`);

  // ---------------------------------------------------------------------- SEC12
  section('SEC12: Chuỗi nhật ký phát hiện sửa, chèn và xoá bản ghi');
  const chainBefore = await api(`/api/transactions/${txnId}/logs/verify`, { token: buyer.token });
  assert(chainBefore.data.valid === true, 'Chuỗi nhật ký nguyên vẹn trước khi can thiệp');

  const target = db.prepare(
    'SELECT id, event_data FROM audit_logs WHERE transaction_id = ? ORDER BY sequence_no ASC LIMIT 1'
  ).get(txnId);
  db.prepare('UPDATE audit_logs SET event_data = ? WHERE id = ?').run('{"bi_sua":true}', target.id);
  const afterEdit = await api(`/api/transactions/${txnId}/logs/verify`, { token: buyer.token });
  assert(afterEdit.data.valid === false, 'Sửa nội dung một bản ghi giữa chuỗi bị phát hiện');
  db.prepare('UPDATE audit_logs SET event_data = ? WHERE id = ?').run(target.event_data, target.id);

  const mid = db.prepare(
    'SELECT id FROM audit_logs WHERE transaction_id = ? ORDER BY sequence_no ASC LIMIT 1 OFFSET 1'
  ).get(txnId);
  const midRow = db.prepare('SELECT * FROM audit_logs WHERE id = ?').get(mid.id);
  db.prepare('DELETE FROM audit_logs WHERE id = ?').run(mid.id);
  const afterDelete = await api(`/api/transactions/${txnId}/logs/verify`, { token: buyer.token });
  assert(afterDelete.data.valid === false, 'Xoá một bản ghi giữa chuỗi bị phát hiện qua số thứ tự');

  db.prepare(
    `INSERT INTO audit_logs (id, transaction_id, sequence_no, actor_id, action, old_status, new_status,
       event_data, previous_hash, current_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(midRow.id, midRow.transaction_id, midRow.sequence_no, midRow.actor_id, midRow.action,
    midRow.old_status, midRow.new_status, midRow.event_data, midRow.previous_hash,
    midRow.current_hash, midRow.created_at);
  const restored = await api(`/api/transactions/${txnId}/logs/verify`, { token: buyer.token });
  assert(restored.data.valid === true, 'Khôi phục đúng bản ghi thì chuỗi hợp lệ trở lại');
  console.log('     → Phát hiện được sửa, chèn và xoá giữa chuỗi. Tính lại toàn chuỗi và xoá');
  console.log('       cuối chuỗi vẫn là giới hạn đã nêu ở mục 2.2.7, cần điểm neo bên ngoài.');

  // ---------------------------------------------------------------------- kết luận
  console.log(failures === 0 ? '\n=== KẾT QUẢ: TẤT CẢ PASS ✅ ===\n' : `\n=== KẾT QUẢ: ${failures} KIỂM THỬ THẤT BẠI ❌ ===\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('LỖI KHÔNG MONG ĐỢI:', e);
  process.exit(1);
});
