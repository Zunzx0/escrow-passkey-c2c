/**
 * Các luồng xác thực của mô hình lai, dùng chung cho mọi bộ kiểm thử.
 *
 * Mỗi tệp test có fixture riêng nên chỉ truyền vào `api`, RP ID và origin của chính nó;
 * phần còn lại giống hệt nhau và không nên chép đi chép lại ở ba nơi.
 *
 * Điểm quan trọng: các hàm ở đây đi qua ĐÚNG những điểm cuối mà người dùng thật đi qua,
 * kể cả luồng khởi tạo quản trị viên. Không hàm nào ghi thẳng vào cơ sở dữ liệu để đi tắt,
 * trừ đúng một bước mà thiết kế quy định là thủ tục vận hành trên máy chủ (createBootstrapAdmin).
 */
const { createAuthenticator } = require('../softwareAuthenticator');
const { createBootstrapAdmin } = require('../../src/lib/adminBootstrap');

const DEFAULT_PASSWORD = 'MatKhau-Test-123';

function makeAuthFlows({ api, rpId, origin }) {
  function ok(res, what) {
    if (res.status >= 400) {
      throw new Error(`${what} thất bại (${res.status}): ${JSON.stringify(res.data)}`);
    }
    return res;
  }

  /** Đăng ký Passkey đầu tiên cho một phiên đang ở phạm vi enroll. Trả về phiên đầy đủ. */
  async function enrollFirstPasskey(enrollToken, auth, { uv = true } = {}) {
    const opt = ok(
      await api('/api/passkeys/register/passkey/options', { method: 'POST', token: enrollToken, body: {} }),
      'Xin tuỳ chọn đăng ký Passkey'
    );
    const attResp = auth.register({ rpId, origin, challenge: opt.data.options.challenge, uv });
    return api('/api/passkeys/register/passkey/verify', {
      method: 'POST',
      token: enrollToken,
      body: { registrationSessionId: opt.data.registrationSessionId, response: attResp },
    });
  }

  /**
   * Đăng ký đầy đủ hai bước: tạo tài khoản bằng mật khẩu, rồi đăng ký Passkey bắt buộc.
   * Giữ nguyên hình dạng trả về của bản cũ ({ auth, token, user, status }) để các test
   * hiện có không phải sửa chỗ nào khác.
   */
  async function registerUser({ username, displayName, password = DEFAULT_PASSWORD, authenticator = null, ...extra }) {
    const auth = authenticator || createAuthenticator();

    const acc = await api('/api/passkeys/register/account', {
      method: 'POST',
      body: { username, displayName, password, ...extra },
    });
    if (acc.status !== 201) {
      return { auth, status: acc.status, error: acc.data.error, message: acc.data.message, password };
    }

    const verify = await enrollFirstPasskey(acc.data.token, auth);
    return {
      auth,
      password,
      enrollToken: acc.data.token,
      token: verify.data.token,
      user: verify.data.user,
      status: verify.status,
      error: verify.data.error,
      message: verify.data.message,
    };
  }

  /** Đăng nhập bằng mật khẩu. Trả nguyên phản hồi để test kiểm cả trường hợp thất bại. */
  function loginPassword(username, password) {
    return api('/api/passkeys/login/password', { method: 'POST', body: { username, password } });
  }

  /** Đăng nhập bằng Passkey (không cần nhập tên đăng nhập). */
  async function loginPasskey(auth, { uv = true } = {}) {
    const opt = ok(await api('/api/passkeys/login/options', { method: 'POST' }), 'Xin tuỳ chọn đăng nhập');
    const assertion = auth.authenticate({ rpId, origin, challenge: opt.data.options.challenge, uv });
    return api('/api/passkeys/login/verify', {
      method: 'POST',
      body: { authenticationSessionId: opt.data.authenticationSessionId, response: assertion },
    });
  }

  /**
   * Xin phiếu uỷ quyền cho một thao tác trên tài khoản.
   * @param action MANAGE_CREDENTIAL hoặc CHANGE_PASSWORD
   */
  async function accountGrant(token, auth, action, { uv = true } = {}) {
    const opt = ok(
      await api('/api/passkeys/reauth/options', { method: 'POST', token, body: { action } }),
      `Xin challenge xác thực lại (${action})`
    );
    const assertion = auth.authenticate({ rpId, origin, challenge: opt.data.options.challenge, uv });
    const verify = await api('/api/passkeys/reauth/verify', {
      method: 'POST',
      token,
      body: { reauthSessionId: opt.data.reauthSessionId, response: assertion },
    });
    return verify;
  }

  /** Xin phiếu uỷ quyền giải ngân cho đúng một giao dịch (phía người mua). */
  async function releaseGrant(token, auth, txnId, { uv = true } = {}) {
    const opt = ok(
      await api(`/api/transactions/${txnId}/reauth/options`, { method: 'POST', token, body: {} }),
      'Xin challenge xác thực lại để giải ngân'
    );
    const assertion = auth.authenticate({ rpId, origin, challenge: opt.data.options.challenge, uv });
    return api(`/api/transactions/${txnId}/reauth/verify`, {
      method: 'POST',
      token,
      body: { reauthSessionId: opt.data.reauthSessionId, response: assertion },
    });
  }

  /**
   * Xin phiếu uỷ quyền phân xử, ràng buộc đúng hồ sơ tranh chấp và ĐÚNG một quyết định.
   * @param decision REFUND hoặc RELEASE
   */
  async function adjudicationGrant(adminToken, auth, disputeId, decision, { uv = true } = {}) {
    const opt = ok(
      await api(`/api/admin/disputes/${disputeId}/reauth/options`, {
        method: 'POST',
        token: adminToken,
        body: { decision },
      }),
      `Xin challenge phân xử (${decision})`
    );
    const assertion = auth.authenticate({ rpId, origin, challenge: opt.data.options.challenge, uv });
    return api(`/api/admin/disputes/${disputeId}/reauth/verify`, {
      method: 'POST',
      token: adminToken,
      body: { reauthSessionId: opt.data.reauthSessionId, response: assertion },
    });
  }

  /**
   * Khởi tạo quản trị viên đi ĐÚNG ba chặng của thủ tục bootstrap:
   *   1. thủ tục vận hành trên máy chủ tạo tài khoản kèm mật khẩu tạm
   *   2. đăng nhập bằng mật khẩu tạm rồi đổi mật khẩu tạm đó
   *   3. đăng ký Passkey đầu tiên -> tài khoản mới chuyển sang ACTIVE
   *
   * Không tạo tài khoản quản trị "bằng tay" trong cơ sở dữ liệu rồi dùng như tài khoản
   * thường: làm vậy thì luồng bootstrap không bao giờ được kiểm thử.
   */
  async function createAdmin({ username, displayName }) {
    const { temporaryPassword } = createBootstrapAdmin({ username, displayName });

    const login = ok(await loginPassword(username, temporaryPassword), 'Đăng nhập bằng mật khẩu tạm');
    if (login.data.nextStep !== 'CHANGE_TEMPORARY_PASSWORD') {
      throw new Error(`Quản trị viên mới phải ở bước đổi mật khẩu tạm, nhận được: ${login.data.nextStep}`);
    }

    const password = `Admin-${username}-2026`;
    const changed = ok(
      await api('/api/passkeys/bootstrap/password', {
        method: 'POST',
        token: login.data.token,
        body: { currentPassword: temporaryPassword, newPassword: password },
      }),
      'Đổi mật khẩu tạm của quản trị viên'
    );

    const auth = createAuthenticator();
    const verify = ok(await enrollFirstPasskey(changed.data.token, auth), 'Đăng ký Passkey đầu tiên của quản trị viên');
    if (verify.data.user.role !== 'ADMIN' || verify.data.user.accountStatus !== 'ACTIVE') {
      throw new Error(`Bootstrap quản trị viên chưa hoàn tất: ${JSON.stringify(verify.data.user)}`);
    }

    return { auth, password, temporaryPassword, token: verify.data.token, user: verify.data.user };
  }

  /** Đăng ký một tài khoản rồi đưa qua đúng quy trình xin và duyệt quyền bán. */
  async function createSeller(admin, { username, displayName, shopName, pitch }) {
    const account = await registerUser({ username, displayName });
    if (!account.token) throw new Error(`Không đăng ký được tài khoản người bán "${username}"`);

    const req = ok(
      await api('/api/users/me/seller-request', {
        method: 'POST',
        token: account.token,
        body: { shopName: shopName || displayName, pitch: pitch || 'Tài khoản phục vụ kiểm thử tự động.' },
      }),
      `Gửi yêu cầu bán hàng cho "${username}"`
    );
    const request = req.data.sellerRequest || req.data.request;
    if (!request || !request.id) throw new Error(`Không đọc được yêu cầu bán hàng: ${JSON.stringify(req.data)}`);

    ok(
      await api(`/api/admin/seller-requests/${request.id}/approve`, {
        method: 'POST',
        token: admin.token,
        body: {},
      }),
      `Duyệt quyền bán cho "${username}"`
    );

    return { ...account, user: { ...account.user, role: 'SELLER' } };
  }

  return {
    DEFAULT_PASSWORD,
    registerUser,
    enrollFirstPasskey,
    loginPassword,
    loginPasskey,
    accountGrant,
    releaseGrant,
    adjudicationGrant,
    createAdmin,
    createSeller,
  };
}

module.exports = { makeAuthFlows, DEFAULT_PASSWORD };
