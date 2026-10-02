// Phiếu uỷ quyền cấp sau một lần xác thực lại bằng passkey.
//
// Phiếu ràng buộc với ĐÚNG một chủ thể và ĐÚNG một hành động. Tuỳ hành động, phiếu còn
// ràng buộc thêm đối tượng của thao tác:
//
//   RELEASE_ESCROW     + đúng một giao dịch
//   ADJUDICATE         + đúng một giao dịch, đúng một hồ sơ tranh chấp, ĐÚNG MỘT QUYẾT ĐỊNH
//   MANAGE_CREDENTIAL  không gắn đối tượng nào
//   CHANGE_PASSWORD    không gắn đối tượng nào
//
// Cột decision của phiếu phân xử là thứ chặn kịch bản: quản trị viên xác thực trong lúc
// màn hình hiển thị "hoàn tiền cho người mua", còn yêu cầu gửi lên máy chủ lại mang "giải
// ngân cho người bán". Nếu phiếu không mang quyết định thì lần xác thực lại chỉ chứng minh
// quản trị viên có mặt, không chứng minh quản trị viên đã chấp thuận điều gì.
//
// Máy chủ chỉ lưu giá trị băm của phiếu, nên một bản sao cơ sở dữ liệu bị lộ cũng không đủ
// để dựng lại phiếu gốc.
//
// Toàn bộ việc tra và tiêu thụ phiếu nằm ở đây thay vì lặp lại ở từng route, để phép so
// sánh theo thời gian không đổi chỉ tồn tại một chỗ duy nhất.
const crypto = require('crypto');
const { db, uuid, nowIso } = require('../db');
const { AppError } = require('./errors');

const REAUTH_TTL_SECONDS = parseInt(process.env.REAUTH_TTL_SECONDS || '120', 10);

const ACTIONS = {
  RELEASE: 'RELEASE_ESCROW',
  ADJUDICATE: 'ADJUDICATE',
  MANAGE_CREDENTIAL: 'MANAGE_CREDENTIAL',
  CHANGE_PASSWORD: 'CHANGE_PASSWORD',
};

// Những hành động không gắn với một giao dịch cụ thể; giao diện xin phiếu qua tuyến chung
// /api/passkeys/reauth/options.
const ACCOUNT_ACTIONS = new Set([ACTIONS.MANAGE_CREDENTIAL, ACTIONS.CHANGE_PASSWORD]);

const DECISIONS = { REFUND: 'REFUND', RELEASE: 'RELEASE' };

// Phiếu còn gắn với PHIÊN đã xác thực lại: phiếu lọt sang một phiên khác của cùng tài khoản
// (ví dụ kẻ tấn công đăng nhập song song bằng mật khẩu đánh cắp) cũng không dùng được.
function requireSessionId(sessionId) {
  if (!sessionId) throw new Error('Phiếu uỷ quyền cần sessionId của phiên đang xác thực lại');
  return sessionId;
}

async function issueGrant({ userId, sessionId, transactionId, disputeId, action, decision, contextHash }) {
  requireSessionId(sessionId);
  // Token gốc CSPRNG 32 byte, encode base64url; server chỉ lưu SHA-256 của nó.
  const rawToken = crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(rawToken, 'utf8').digest('hex');
  const expiresAt = new Date(Date.now() + REAUTH_TTL_SECONDS * 1000).toISOString();

  await db.prepare(
    `INSERT INTO reauth_grants
       (id, user_id, session_id, transaction_id, dispute_id, action, decision, token_hash, context_hash, expires_at, used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
  ).run(
    uuid(),
    userId,
    sessionId,
    transactionId || null,
    disputeId || null,
    action,
    decision || null,
    tokenHash,
    contextHash || null,
    expiresAt
  );

  return { rawToken, expiresAt };
}

/**
 * Tìm phiếu còn hiệu lực khớp với token do người gọi đưa ra.
 *
 * Truy vấn lọc trước theo chủ thể, hành động, đối tượng, quyết định, thời hạn và trạng thái
 * chưa dùng, rồi mới so token trong bộ nhớ bằng crypto.timingSafeEqual. So sánh chuỗi thông
 * thường dừng lại ở byte đầu tiên khác nhau, nên thời gian phản hồi rò rỉ thông tin về giá
 * trị đúng; hàm so sánh thời gian không đổi loại bỏ kênh phụ đó.
 *
 * Mọi tiêu chí ràng buộc đều nằm trong MỆNH ĐỀ WHERE chứ không kiểm sau khi tìm thấy. Nhờ
 * vậy một phiếu cấp cho giao dịch A, hoặc cấp cho quyết định hoàn tiền, đơn giản là không
 * nằm trong tập ứng viên khi người gọi dùng nó cho giao dịch B hoặc cho quyết định giải ngân.
 */
async function findValidGrant({ userId, sessionId, transactionId, disputeId, action, decision, rawToken }) {
  requireSessionId(sessionId);
  if (!rawToken) return null;

  const providedHash = crypto.createHash('sha256').update(String(rawToken), 'utf8').digest('hex');
  const providedBuf = Buffer.from(providedHash, 'hex');

  // IS NOT DISTINCT FROM: so sánh bằng nhưng coi NULL = NULL là đúng. SQLite có cách viết tắt
  // `IS ?` nhưng PostgreSQL không nhận, còn dạng đầy đủ này chạy được trên cả hai.
  const candidates = await db
    .prepare(
      `SELECT * FROM reauth_grants
       WHERE user_id = ? AND session_id = ? AND action = ? AND used_at IS NULL AND expires_at > ?
         AND transaction_id IS NOT DISTINCT FROM ?
         AND dispute_id IS NOT DISTINCT FROM ?
         AND decision IS NOT DISTINCT FROM ?`
    )
    .all(userId, sessionId, action, nowIso(), transactionId || null, disputeId || null, decision || null);

  return (
    candidates.find((g) => {
      const storedBuf = Buffer.from(g.token_hash, 'hex');
      return storedBuf.length === providedBuf.length && crypto.timingSafeEqual(storedBuf, providedBuf);
    }) || null
  );
}

/** Đánh dấu phiếu đã dùng. PHẢI gọi bên trong cùng giao dịch cơ sở dữ liệu với nghiệp vụ. */
async function markGrantUsed(grantId) {
  const result = await db
    .prepare('UPDATE reauth_grants SET used_at = ? WHERE id = ? AND used_at IS NULL')
    .run(nowIso(), grantId);
  if (result.changes !== 1) {
    throw new AppError(401, 'REAUTH_REQUIRED', 'Phiếu uỷ quyền vừa được dùng ở nơi khác');
  }
}

/** Tra phiếu và ném lỗi nếu không hợp lệ. Không tiêu thụ phiếu. */
async function requireGrant({ userId, sessionId, transactionId, disputeId, action, decision, rawToken, message }) {
  const grant = await findValidGrant({ userId, sessionId, transactionId, disputeId, action, decision, rawToken });
  if (!grant) {
    throw new AppError(
      401,
      'REAUTH_REQUIRED',
      message || 'Thao tác này cần xác thực lại bằng passkey. Phiếu uỷ quyền không hợp lệ hoặc đã hết hạn.'
    );
  }
  return grant;
}

/**
 * Đối chiếu ngữ cảnh lần thứ HAI, ngay trước khi nghiệp vụ chạy.
 *
 * Phiếu chỉ chứng minh "chủ thể này đã uỷ quyền MỘT nội dung nào đó". Ở đây kiểm nội dung
 * ấy có đúng là nội dung đang sắp thực thi hay không — chặn kịch bản dữ liệu bị sửa trong
 * khoảng thời gian giữa lúc ký và lúc lệnh thực sự chạy.
 */
function assertContextUnchanged(grant, currentContextHash) {
  if (grant.context_hash && grant.context_hash !== currentContextHash) {
    throw new AppError(
      409,
      'CONTEXT_MISMATCH',
      'Nội dung đã thay đổi sau khi bạn xác thực. Vì an toàn, hãy xác thực lại.'
    );
  }
}

module.exports = {
  ACTIONS,
  ACCOUNT_ACTIONS,
  DECISIONS,
  REAUTH_TTL_SECONDS,
  issueGrant,
  findValidGrant,
  markGrantUsed,
  requireGrant,
  assertContextUnchanged,
};
