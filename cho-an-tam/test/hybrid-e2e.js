/**
 * Kiểm thử mô hình xác thực LAI và các "đường vòng" quanh nó.
 *
 * Bộ này trả lời đúng những câu mà một người phản biện sẽ hỏi:
 *
 *   - Tài khoản chưa đăng ký Passkey thì làm được gì? (đáp: không làm được gì ngoài việc
 *     hoàn tất đăng ký)
 *   - Có mật khẩu rồi thì làm được gì? (đáp: mở phiên, tạo đơn, KHOÁ được tiền vào ký quỹ
 *     — nhưng không đưa được tiền ra khỏi ký quỹ, không thêm được credential, không đổi
 *     được mật khẩu)
 *   - Gọi thẳng API bằng phiên hợp lệ mà không có phiếu uỷ quyền thì sao? (đáp: bị từ chối
 *     ở máy chủ, không phải chỉ bị ẩn nút trên giao diện)
 *   - Phiếu của việc này có dùng cho việc khác được không? (đáp: không, kể cả giữa hai
 *     hướng phân xử)
 *
 * Sau mỗi nhóm, chín bất biến của hệ thống được kiểm lại bằng dữ liệu thật.
 */
const crypto = require('crypto');
const { api, flows } = require('./helpers/accounts');

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const PRICE = 640000;

let pass = 0;
let fail = 0;
const failures = [];

function assert(cond, label) {
  if (cond) {
    pass += 1;
    console.log(`  ✅ ${label}`);
  } else {
    fail += 1;
    failures.push(label);
    console.log(`  ❌ ${label}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

/** Gọi lại đúng hàm mà máy chủ dùng, qua điểm cuối quản trị, để kiểm bằng dữ liệu thật. */
async function assertInvariants(adminToken, label) {
  const res = await api('/api/admin/invariants', { token: adminToken });
  const ok = res.status === 200 && res.data.ok === true;
  assert(ok, `Chín bất biến còn đúng sau ${label}` + (ok ? '' : `: ${JSON.stringify(res.data.violations)}`));
}

async function main() {
  console.log(`\n=== KIỂM THỬ MÔ HÌNH XÁC THỰC LAI: ${BASE} ===`);
  const rand = crypto.randomBytes(4).toString('hex');

  const admin = await flows.createAdmin({ username: `hadm_${rand}`, displayName: 'Quan Tri Lai' });
  const seller = await flows.createSeller(admin, { username: `hsel_${rand}`, displayName: 'Nguoi Ban Lai' });

  const listing = await api('/api/listings', {
    method: 'POST', token: seller.token,
    body: {
      title: `Máy ảnh film cũ ${rand}`, category: 'MAY_ANH', condition: 'GOOD',
      description: 'Còn hộp, đủ phụ kiện', price: PRICE, location: 'Hà Nội',
    },
  });
  if (listing.status !== 201) throw new Error(`Không đăng bán được: ${JSON.stringify(listing.data)}`);
  const listingId = listing.data.id;

  // ---------------------------------------------------------------- H01
  section('H01: Đăng ký hai bước — Passkey là bước bắt buộc để hoàn tất tài khoản');

  const username = `hbuy_${rand}`;
  const password = 'MatKhau-Lai-2026';
  const acc = await api('/api/passkeys/register/account', {
    method: 'POST', body: { username, displayName: 'Nguoi Mua Lai', password, role: 'ADMIN' },
  });
  assert(acc.status === 201, `Tạo tài khoản bằng mật khẩu thành công (nhận ${acc.status})`);
  assert(acc.data.user.accountStatus === 'PENDING_PASSKEY', 'Tài khoản mới ở trạng thái chờ đăng ký Passkey');
  assert(acc.data.user.role === 'BUYER', 'Trường role gửi kèm bị bỏ qua, tài khoản vẫn chỉ có năng lực mua');
  assert(acc.data.scope === 'enroll', 'Phiên cấp ra chỉ có phạm vi hoàn tất thiết lập');
  const enrollToken = acc.data.token;

  const walletTooEarly = await api('/api/wallets/me', { token: enrollToken });
  assert(
    walletTooEarly.status === 403 && walletTooEarly.data.error === 'ACCOUNT_SETUP_INCOMPLETE',
    `Phiên chưa hoàn tất không gọi được chức năng nghiệp vụ (nhận ${walletTooEarly.status})`
  );

  const orderTooEarly = await api('/api/transactions/orders', {
    method: 'POST', token: enrollToken, body: { listingId },
  });
  assert(orderTooEarly.status === 403, `Phiên chưa hoàn tất không đặt mua được (nhận ${orderTooEarly.status})`);

  const meEarly = await api('/api/users/me', { token: enrollToken });
  assert(meEarly.status === 200 && meEarly.data.wallet === null, 'Tài khoản chưa hoàn tất thì chưa có ví');

  // Mức xác minh người dùng là BẮT BUỘC cho credential đầu tiên.
  const buyerAuth = require('./softwareAuthenticator').createAuthenticator();
  const noUv = await flows.enrollFirstPasskey(enrollToken, buyerAuth, { uv: false });
  assert(
    noUv.status === 400,
    `Đăng ký Passkey không có cờ xác minh người dùng bị từ chối (nhận ${noUv.status})`
  );
  const meStillPending = await api('/api/users/me', { token: enrollToken });
  assert(
    meStillPending.data.user.accountStatus === 'PENDING_PASSKEY',
    'Tài khoản KHÔNG được kích hoạt khi bước đăng ký Passkey thất bại'
  );

  const enrolled = await flows.enrollFirstPasskey(enrollToken, buyerAuth, { uv: true });
  assert(enrolled.status === 201, `Đăng ký Passkey có xác minh người dùng thành công (nhận ${enrolled.status})`);
  assert(enrolled.data.user.accountStatus === 'ACTIVE', 'Tài khoản chuyển sang hoạt động');
  const buyer = { auth: buyerAuth, token: enrolled.data.token, user: enrolled.data.user, password };

  const walletNow = await api('/api/wallets/me', { token: buyer.token });
  assert(walletNow.status === 200 && walletNow.data.availableBalance > 0, 'Ví chỉ được mở khi tài khoản hoạt động');

  await assertInvariants(admin.token, 'H01');

  // ---------------------------------------------------------------- H02
  section('H02: Hai lối đăng nhập cùng cấp một loại phiên');

  const byPassword = await flows.loginPassword(username, password);
  assert(byPassword.status === 200 && byPassword.data.scope === 'full', 'Đăng nhập bằng mật khẩu thành công');
  const passwordSession = byPassword.data.token;

  const byPasskey = await flows.loginPasskey(buyer.auth);
  assert(byPasskey.status === 200 && byPasskey.data.scope === 'full', 'Đăng nhập bằng Passkey thành công');
  assert(
    byPasskey.data.scope === byPassword.data.scope,
    'Hai lối cấp cùng một loại phiên, không lối nào được ưu ái hơn'
  );

  const wrongPassword = await flows.loginPassword(username, password + 'x');
  const wrongUser = await flows.loginPassword(`khongtontai_${rand}`, password);
  assert(wrongPassword.status === 401 && wrongUser.status === 401, 'Sai mật khẩu và sai tên đăng nhập đều bị từ chối');
  assert(
    wrongPassword.data.error === wrongUser.data.error && wrongPassword.data.message === wrongUser.data.message,
    'Hai trường hợp sai trả về CÙNG một thông báo, không lộ tài khoản nào có thật'
  );

  // ---------------------------------------------------------------- H03
  section('H03: Phiên tạo từ mật khẩu vẫn khoá được tiền, nhưng không đưa tiền ra khỏi ký quỹ');

  const order = await api('/api/transactions/orders', {
    method: 'POST', token: passwordSession, body: { listingId },
  });
  assert(order.status === 201, `Phiên từ mật khẩu tạo được đơn mua (nhận ${order.status})`);
  const txnId = order.data.id;

  const secured = await api(`/api/transactions/${txnId}/secure`, {
    method: 'POST', token: passwordSession, body: { requestId: crypto.randomUUID() },
  });
  assert(
    secured.status === 200 && secured.data.escrowStatus === 'LOCKED',
    `Phiên từ mật khẩu KHOÁ ĐƯỢC tiền vào ký quỹ (nhận ${secured.status}) — đúng như Chương 2 đã nêu`
  );

  await api(`/api/transactions/${txnId}/ship`, { method: 'POST', token: seller.token, body: {} });
  await api(`/api/transactions/${txnId}/wait-confirm`, { method: 'POST', token: buyer.token, body: {} });

  const releaseNoGrant = await api(`/api/transactions/${txnId}/release`, {
    method: 'POST', token: passwordSession, body: { requestId: crypto.randomUUID(), reauthGrant: 'khong-co-that' },
  });
  assert(
    releaseNoGrant.status === 401 && releaseNoGrant.data.error === 'REAUTH_REQUIRED',
    `Giải ngân bằng phiên hợp lệ mà không có phiếu bị từ chối (nhận ${releaseNoGrant.status})`
  );

  const releaseGrant = await flows.releaseGrant(passwordSession, buyer.auth, txnId);
  assert(releaseGrant.status === 200, 'Xác thực lại bằng Passkey thì được cấp phiếu giải ngân');

  const released = await api(`/api/transactions/${txnId}/release`, {
    method: 'POST', token: passwordSession,
    body: { requestId: crypto.randomUUID(), reauthGrant: releaseGrant.data.reauthGrant },
  });
  assert(released.status === 200 && released.data.status === 'COMPLETED', 'Có phiếu thì giải ngân được');

  await assertInvariants(admin.token, 'H03');

  // ---------------------------------------------------------------- H04
  section('H04: Đổi mật khẩu đòi xác thực lại và thu hồi mọi phiên khác');

  const noGrant = await api('/api/users/me/password', {
    method: 'POST', token: buyer.token, body: { newPassword: 'MatKhau-Moi-2026' },
  });
  assert(
    noGrant.status === 401 && noGrant.data.error === 'REAUTH_REQUIRED',
    `Đổi mật khẩu khi chỉ có mã phiên bị từ chối (nhận ${noGrant.status})`
  );

  // Phiếu của việc quản lý thiết bị KHÔNG dùng cho việc đổi mật khẩu.
  const manageGrant = await flows.accountGrant(buyer.token, buyer.auth, 'MANAGE_CREDENTIAL');
  const crossUse = await api('/api/users/me/password', {
    method: 'POST', token: buyer.token,
    body: { newPassword: 'MatKhau-Moi-2026', reauthGrant: manageGrant.data.reauthGrant },
  });
  assert(crossUse.status === 401, `Phiếu quản lý thiết bị không đổi được mật khẩu (nhận ${crossUse.status})`);

  const pwGrant = await flows.accountGrant(buyer.token, buyer.auth, 'CHANGE_PASSWORD');
  assert(pwGrant.status === 200 && pwGrant.data.action === 'CHANGE_PASSWORD', 'Cấp được phiếu đổi mật khẩu');

  const newPassword = 'MatKhau-Moi-2026';
  const changed = await api('/api/users/me/password', {
    method: 'POST', token: buyer.token, body: { newPassword, reauthGrant: pwGrant.data.reauthGrant },
  });
  assert(changed.status === 200 && changed.data.token, 'Có phiếu thì đổi được mật khẩu');

  const oldSessionAfter = await api('/api/wallets/me', { token: passwordSession });
  assert(
    oldSessionAfter.status === 401,
    `Phiên cũ (kể cả phiên kẻ tấn công đang cầm) bị thu hồi sau khi đổi mật khẩu (nhận ${oldSessionAfter.status})`
  );

  const oldPasswordLogin = await flows.loginPassword(username, password);
  const newPasswordLogin = await flows.loginPassword(username, newPassword);
  assert(oldPasswordLogin.status === 401, 'Mật khẩu cũ không dùng được nữa');
  assert(newPasswordLogin.status === 200, 'Mật khẩu mới dùng được');

  await assertInvariants(admin.token, 'H04');

  // ---------------------------------------------------------------- H05
  section('H05: Phiếu uỷ quyền không dùng chéo giữa các hành động');

  const pwGrant2 = await flows.accountGrant(newPasswordLogin.data.token, buyer.auth, 'CHANGE_PASSWORD');
  const addDevice = await api('/api/passkeys/credentials/options', {
    method: 'POST', token: newPasswordLogin.data.token,
    body: { deviceName: 'May tinh phu', reauthGrant: pwGrant2.data.reauthGrant },
  });
  assert(addDevice.status === 401, `Phiếu đổi mật khẩu không thêm được thiết bị (nhận ${addDevice.status})`);

  // ---------------------------------------------------------------- H06
  section('H06: Khởi tạo quản trị viên đi đúng thứ tự ba chặng');

  const { createBootstrapAdmin } = require('../src/lib/adminBootstrap');
  const bootUsername = `hboot_${rand}`;
  const { temporaryPassword } = createBootstrapAdmin({ username: bootUsername, displayName: 'Quan Tri Moi' });

  const bootLogin = await flows.loginPassword(bootUsername, temporaryPassword);
  assert(bootLogin.status === 200 && bootLogin.data.scope === 'enroll', 'Đăng nhập bằng mật khẩu tạm cho phiên hạn chế');
  assert(bootLogin.data.nextStep === 'CHANGE_TEMPORARY_PASSWORD', 'Bước kế tiếp là đổi mật khẩu tạm');

  const adminApiTooEarly = await api('/api/admin/disputes', { token: bootLogin.data.token });
  assert(adminApiTooEarly.status === 403, `Chưa hoàn tất thì không gọi được chức năng quản trị (nhận ${adminApiTooEarly.status})`);

  const skipToPasskey = await api('/api/passkeys/register/passkey/options', {
    method: 'POST', token: bootLogin.data.token, body: {},
  });
  assert(
    skipToPasskey.status === 409,
    `Không nhảy cóc sang đăng ký Passkey khi chưa đổi mật khẩu tạm (nhận ${skipToPasskey.status})`
  );

  const bootChanged = await api('/api/passkeys/bootstrap/password', {
    method: 'POST', token: bootLogin.data.token,
    body: { currentPassword: temporaryPassword, newPassword: `Admin-${bootUsername}-2026` },
  });
  assert(bootChanged.status === 200, 'Đổi được mật khẩu tạm');
  assert(bootChanged.data.user.accountStatus === 'PENDING_PASSKEY', 'Sau khi đổi mật khẩu vẫn chưa hoạt động');

  const stillBlocked = await api('/api/admin/disputes', { token: bootChanged.data.token });
  assert(stillBlocked.status === 403, `Đổi mật khẩu xong vẫn chưa gọi được chức năng quản trị (nhận ${stillBlocked.status})`);

  const bootAuth = require('./softwareAuthenticator').createAuthenticator();
  const bootEnrolled = await flows.enrollFirstPasskey(bootChanged.data.token, bootAuth);
  assert(bootEnrolled.status === 201 && bootEnrolled.data.user.accountStatus === 'ACTIVE', 'Đăng ký Passkey xong mới hoạt động');

  const adminApiNow = await api('/api/admin/disputes', { token: bootEnrolled.data.token });
  assert(adminApiNow.status === 200, `Hoàn tất ba chặng thì dùng được chức năng quản trị (nhận ${adminApiNow.status})`);

  const bootWallet = await api('/api/users/me', { token: bootEnrolled.data.token });
  assert(bootWallet.data.wallet === null, 'Quản trị viên không có ví, vì không phải một bên của giao dịch');

  await assertInvariants(admin.token, 'H06');

  // ---------------------------------------------------------------- H07
  section('H07: Bất biến số 8 — tài khoản hoạt động luôn có ít nhất một Passkey');

  const finalCheck = await api('/api/admin/invariants', { token: admin.token });
  assert(finalCheck.status === 200 && finalCheck.data.checked === 9, 'Điểm cuối kiểm bất biến trả về đủ chín phép kiểm');
  const passkeyCheck = (finalCheck.data.checks || []).find((c) => c.code === 'ACTIVE_ACCOUNT_HAS_PASSKEY');
  assert(!!passkeyCheck && passkeyCheck.no === 8 && passkeyCheck.ok, 'Bất biến số 8 (tài khoản ACTIVE có Passkey) đúng');
  assert(finalCheck.data.ok === true, `Không có bất biến nào bị vi phạm: ${JSON.stringify(finalCheck.data.violations)}`);

  console.log(`\n=== KẾT QUẢ: ${fail === 0 ? 'TẤT CẢ PASS ✅' : `${fail} TEST FAIL ❌`} (${pass} pass) ===`);
  if (fail > 0) {
    console.log('Các mục fail:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('LỖI KHÔNG MONG ĐỢI:', e);
  process.exit(1);
});
