// Ghi nhận sự kiện an toàn: ai đã thử làm gì mà bị từ chối, và ai đã thực hiện thành công
// một thao tác nhạy cảm.
//
// Vì sao cần, dù đã có audit_logs: audit_logs chỉ ghi các lần chuyển trạng thái THÀNH CÔNG
// của một giao dịch. Phần lớn thứ đáng quan tâm khi phân tích an toàn lại là những lần
// KHÔNG thành công — đăng nhập sai liên tiếp, phiếu uỷ quyền hết hạn, chữ ký sai origin,
// lệnh gửi ở sai trạng thái — và phần lớn trong số đó không gắn với giao dịch nào.
//
// Nguyên tắc bất di bất dịch: KHÔNG ghi bí mật. Mật khẩu, mã phiên, phiếu uỷ quyền, giá trị
// challenge và khoá riêng đều không được xuất hiện ở đây. Hàm sanitize() bên dưới chỉ cho
// qua một danh sách trường đã chọn, thay vì cố lọc ra các trường xấu — cách sau luôn sót khi
// có người thêm trường mới.
const { db } = require('../db');

// Danh sách trường ĐƯỢC PHÉP ghi vào cột detail.
const ALLOWED_DETAIL_KEYS = new Set([
  'reason',
  'action',
  'decision',
  'transactionId',
  'disputeId',
  'credentialId',
  'deviceName',
  'accountStatus',
  'expectedStatus',
  'attempts',
  'limitPerMinute',
  'paymentRequestId',
  'amount',
  'source',
  'oldCounter',
  'newCounter',
]);

const EVENTS = {
  LOGIN_PASSWORD_FAILED: 'LOGIN_PASSWORD_FAILED',
  LOGIN_PASSKEY_FAILED: 'LOGIN_PASSKEY_FAILED',
  REAUTH_REQUIRED: 'REAUTH_REQUIRED',
  REAUTH_FAILED: 'REAUTH_FAILED',
  CHALLENGE_REPLAY: 'CHALLENGE_REPLAY',
  CHALLENGE_EXPIRED: 'CHALLENGE_EXPIRED',
  ORIGIN_OR_SIGNATURE_REJECTED: 'ORIGIN_OR_SIGNATURE_REJECTED',
  CONTEXT_MISMATCH: 'CONTEXT_MISMATCH',
  INVALID_STATE: 'INVALID_STATE',
  FORBIDDEN: 'FORBIDDEN',
  ACCOUNT_SETUP_INCOMPLETE: 'ACCOUNT_SETUP_INCOMPLETE',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  LOGIN_LOCKED: 'LOGIN_LOCKED',
  LOGOUT: 'LOGOUT',
  MOCK_CHECKOUT_DENIED: 'MOCK_CHECKOUT_DENIED',
  TOPUP_LIMITED: 'TOPUP_LIMITED',
  REGISTRATION_DENIED: 'REGISTRATION_DENIED',
  // Thao tác nhạy cảm THÀNH CÔNG cũng phải để lại vết, không chỉ các lần bị từ chối.
  ACCOUNT_ACTIVATED: 'ACCOUNT_ACTIVATED',
  PASSWORD_CHANGED: 'PASSWORD_CHANGED',
  CREDENTIAL_ADDED: 'CREDENTIAL_ADDED',
  CREDENTIAL_REMOVED: 'CREDENTIAL_REMOVED',
  ADMIN_BOOTSTRAP_PASSWORD_CHANGED: 'ADMIN_BOOTSTRAP_PASSWORD_CHANGED',
  ADMIN_ADJUDICATION: 'ADMIN_ADJUDICATION',
  // Mock Payment Provider — webhook nạp tiền.
  WEBHOOK_INVALID_SIGNATURE: 'WEBHOOK_INVALID_SIGNATURE',
  WEBHOOK_CONFLICT: 'WEBHOOK_CONFLICT',
  TOPUP_SUCCEEDED: 'TOPUP_SUCCEEDED',
  TOPUP_FAILED: 'TOPUP_FAILED',
  // Worker đối soát thấy provider báo một kết quả trái với kết quả đã tất toán ở phía ta.
  RECONCILE_CONFLICT: 'RECONCILE_CONFLICT',
  // signCount của Passkey không tăng như kỳ vọng — tín hiệu rủi ro, xác thực vẫn được chấp nhận.
  COUNTER_ANOMALY: 'COUNTER_ANOMALY',
};

// Mã lỗi của tầng ứng dụng -> loại sự kiện an toàn. Nhờ bảng này, việc ghi nhận nằm gọn ở
// một middleware xử lý lỗi tập trung, thay vì rải lời gọi ghi log khắp các route — nơi rất
// dễ thêm một nhánh từ chối mới mà quên ghi lại.
const ERROR_TO_EVENT = {
  INVALID_CREDENTIALS: EVENTS.LOGIN_PASSWORD_FAILED,
  REAUTH_REQUIRED: EVENTS.REAUTH_REQUIRED,
  VERIFICATION_FAILED: EVENTS.ORIGIN_OR_SIGNATURE_REJECTED,
  CHALLENGE_REPLAY: EVENTS.CHALLENGE_REPLAY,
  CHALLENGE_EXPIRED: EVENTS.CHALLENGE_EXPIRED,
  CHALLENGE_NOT_FOUND: EVENTS.REAUTH_FAILED,
  CHALLENGE_PURPOSE_MISMATCH: EVENTS.REAUTH_FAILED,
  CONTEXT_MISMATCH: EVENTS.CONTEXT_MISMATCH,
  INVALID_STATE: EVENTS.INVALID_STATE,
  FORBIDDEN: EVENTS.FORBIDDEN,
  ADMIN_IDENTITY_INVALID: EVENTS.FORBIDDEN,
  ADJUDICATOR_CONFLICT: EVENTS.FORBIDDEN,
  ACCOUNT_SETUP_INCOMPLETE: EVENTS.ACCOUNT_SETUP_INCOMPLETE,
  INVALID_ACCOUNT_STATUS: EVENTS.ACCOUNT_SETUP_INCOMPLETE,
  IDEMPOTENCY_KEY_REUSED: EVENTS.IDEMPOTENCY_CONFLICT,
  RATE_LIMITED: EVENTS.RATE_LIMITED,
  USERNAME_PROBE_LIMITED: EVENTS.RATE_LIMITED,
  REGISTRATION_UNAVAILABLE: EVENTS.REGISTRATION_DENIED,
  LOGIN_TEMPORARILY_LOCKED: EVENTS.LOGIN_LOCKED,
  TOPUP_LIMIT_EXCEEDED: EVENTS.TOPUP_LIMITED,
  NOT_PAYMENT_OWNER: EVENTS.MOCK_CHECKOUT_DENIED,
  NO_CREDENTIAL: EVENTS.REAUTH_FAILED,
  LAST_CREDENTIAL: EVENTS.FORBIDDEN,
  INVALID_SIGNATURE: EVENTS.WEBHOOK_INVALID_SIGNATURE,
  WEBHOOK_CONFLICT: EVENTS.WEBHOOK_CONFLICT,
};

function sanitize(detail) {
  const out = {};
  for (const [k, v] of Object.entries(detail || {})) {
    if (!ALLOWED_DETAIL_KEYS.has(k)) continue;
    if (v === undefined || v === null) continue;
    out[k] = typeof v === 'string' ? v.slice(0, 200) : v;
  }
  return out;
}

/**
 * Ghi một sự kiện an toàn.
 *
 * Hàm này KHÔNG BAO GIỜ được phép làm hỏng luồng nghiệp vụ đang chạy: nếu ghi log thất bại
 * thì nuốt lỗi. Một lần giải ngân hợp lệ không nên thất bại chỉ vì bảng nhật ký gặp sự cố.
 */
async function logSecurityEvent(req, { type, outcome = 'DENIED', statusCode = null, username = null, actorId = null, detail = {} }) {
  try {
    await db.prepare(
      `INSERT INTO security_events (event_type, outcome, actor_id, username, ip, method, route, status_code, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      type,
      outcome,
      // actorId cho những lúc chủ thể đã xác định được nhưng request chưa mang phiên (ví dụ
      // ngay trong bước đăng nhập bằng Passkey).
      actorId || (req && req.user && req.user.id) || null,
      username || (req && req.user && req.user.username) || null,
      (req && req.ip) || null,
      (req && req.method) || null,
      req ? `${req.baseUrl || ''}${(req.route && req.route.path) || req.path || ''}` : null,
      statusCode,
      JSON.stringify(sanitize(detail))
    );
  } catch (e) {
    console.error('[security-events] không ghi được sự kiện:', e.message);
  }
}

/** Dùng trong middleware lỗi tập trung: đổi mã lỗi thành sự kiện tương ứng, nếu có. */
async function logFromError(req, err, statusCode) {
  const type = ERROR_TO_EVENT[err && err.code];
  if (!type) return;
  await logSecurityEvent(req, {
    type,
    outcome: 'DENIED',
    statusCode,
    // Với đăng nhập thất bại thì chưa có req.user; lấy tên đăng nhập người gọi đưa lên để
    // còn đếm được số lần thử trên cùng một tài khoản. Đây là dữ liệu định danh, không phải bí mật.
    username: (req && req.body && typeof req.body.username === 'string')
      ? String(req.body.username).slice(0, 64)
      : null,
    detail: { reason: err && err.code },
  });
}

/** Đọc nhật ký sự kiện cho màn hình quản trị. */
async function listSecurityEvents({ limit = 100, type = null } = {}) {
  const rows = type
    ? await db.prepare(
        `SELECT * FROM security_events WHERE event_type = ? ORDER BY id DESC LIMIT ?`
      ).all(type, Math.min(limit, 500))
    : await db.prepare(`SELECT * FROM security_events ORDER BY id DESC LIMIT ?`).all(Math.min(limit, 500));

  return rows.map((r) => ({
    id: r.id,
    eventType: r.event_type,
    outcome: r.outcome,
    actorId: r.actor_id,
    username: r.username,
    ip: r.ip,
    method: r.method,
    route: r.route,
    statusCode: r.status_code,
    detail: JSON.parse(r.detail || '{}'),
    createdAt: r.created_at,
  }));
}

module.exports = { EVENTS, logSecurityEvent, logFromError, listSecurityEvents };
