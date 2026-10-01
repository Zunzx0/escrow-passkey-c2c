/**
 * Tạo tài khoản cho bộ kiểm thử theo mô hình xác thực lai.
 *
 * Ba con đường cấp quyền, và cả ba đều được đi ĐÚNG như thật ở đây:
 *
 *   Người mua     — POST /api/passkeys/register/account (tên đăng nhập + mật khẩu)
 *                   → POST /api/passkeys/register/passkey/{options,verify} (bắt buộc, UV required).
 *                   Chỉ sau bước thứ hai tài khoản mới ACTIVE và mới có ví.
 *
 *   Người bán     — đăng ký như trên (ra Người mua) → POST /api/users/me/seller-request
 *                   → quản trị viên duyệt qua POST /api/admin/seller-requests/:id/approve.
 *
 *   Quản trị viên — thủ tục vận hành createBootstrapAdmin() tạo tài khoản kèm mật khẩu tạm
 *                   → đăng nhập bằng mật khẩu tạm → đổi mật khẩu tạm → đăng ký Passkey đầu
 *                   tiên. Không có điểm cuối HTTP nào cấp quyền quản trị, và cũng KHÔNG tạo
 *                   tài khoản quản trị bằng cách ghi thẳng vào cơ sở dữ liệu rồi dùng như
 *                   tài khoản thường — làm vậy thì luồng bootstrap không bao giờ được kiểm.
 *
 * Tệp này giữ nguyên chữ ký hàm của bản cũ để ba bộ test không phải sửa chỗ gọi.
 */

const { makeAuthFlows, DEFAULT_PASSWORD } = require('./hybrid');

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const RP_ID = process.env.WEBAUTHN_RP_ID || 'localhost';
const ORIGIN = process.env.WEBAUTHN_ORIGIN || BASE;

/**
 * Client HTTP dùng riêng cho các hàm ở tệp này.
 *
 * Các điểm cuối xác thực bị giới hạn tần suất theo đúng thiết kế. Bộ test tạo nhiều tài
 * khoản nên sẽ chạm trần — chờ hết cửa sổ rồi thử lại, thay vì hạ mức bảo vệ xuống cho dễ test.
 */
async function api(path, opts = {}, retried = false) {
  const { method = 'GET', body, token } = opts;
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = {};
  try {
    data = await res.json();
  } catch (_) {}

  if (res.status === 429 && !retried) {
    console.log('  ⏳ Chạm giới hạn tần suất (đúng thiết kế) — chờ 60 giây rồi thử lại…');
    await new Promise((r) => setTimeout(r, 61000));
    return api(path, opts, true);
  }
  return { status: res.status, data };
}

const flows = makeAuthFlows({ api, rpId: RP_ID, origin: ORIGIN });

// --- Chữ ký cũ, giữ lại để ba bộ test gọi y như trước ---------------------------------

/** @deprecated tham số registerUser không còn dùng; luồng bootstrap tự đi qua API thật. */
function createAdmin(_registerUser, opts) {
  return flows.createAdmin(opts);
}

/** @deprecated hai tham số đầu không còn dùng. */
function createSeller(_api, _registerUser, admin, opts) {
  return flows.createSeller(admin, opts);
}

module.exports = {
  api,
  flows,
  DEFAULT_PASSWORD,
  createAdmin,
  createSeller,
  registerUser: flows.registerUser,
  loginPassword: flows.loginPassword,
  loginPasskey: flows.loginPasskey,
  accountGrant: flows.accountGrant,
  releaseGrant: flows.releaseGrant,
  adjudicationGrant: flows.adjudicationGrant,
};
