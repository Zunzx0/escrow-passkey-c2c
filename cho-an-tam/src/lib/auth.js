const jwt = require('jsonwebtoken');
const { db } = require('../db');
const { createSession, getSession, sessionProblem, touchSession, setRefreshCookie } = require('./session');

const JWT_SECRET = process.env.JWT_SECRET || 'CHANGE_ME_dev_only_not_secure';
const ACCESS_TOKEN_TTL_SECONDS = parseInt(process.env.ACCESS_TOKEN_TTL_SECONDS || '900', 10);

// Hai loại phiên. Cả hai đều là "đã đăng nhập", nhưng phạm vi khác nhau.
//
//   full    tài khoản ở trạng thái ACTIVE, dùng được mọi chức năng theo vai trò.
//   enroll  tài khoản chưa hoàn tất thiết lập (PENDING_BOOTSTRAP hoặc PENDING_PASSKEY).
//           Chỉ đi tiếp được đúng con đường hoàn tất: đổi mật khẩu tạm và đăng ký Passkey
//           đầu tiên. Không có ví, không gọi được chức năng nghiệp vụ nào.
//
// Phạm vi được kiểm ở MÁY CHỦ chứ không dựa vào việc giao diện có ẩn nút hay không.
const SCOPE_FULL = 'full';
const SCOPE_ENROLL = 'enroll';

function scopeForStatus(accountStatus) {
  return accountStatus === 'ACTIVE' ? SCOPE_FULL : SCOPE_ENROLL;
}

/**
 * Cấp mã phiên.
 *
 * `tv` mang token_version của tài khoản. Đổi mật khẩu làm tăng giá trị này, nên mọi mã
 * phiên cấp trước đó lập tức mất hiệu lực — đây là điều kiện để phát biểu "đổi mật khẩu
 * huỷ các phiên đang mở khác" ở Bảng 2.1 thành một tính chất kiểm chứng được, thay vì một
 * lời hứa suông trên một hệ thống dùng JWT không trạng thái.
 */
function signAccessToken(user, scope, sessionId) {
  if (!sessionId) throw new Error('signAccessToken cần sessionId của phiên phía máy chủ');
  return jwt.sign(
    {
      sub: user.id,
      username: user.username,
      role: user.role,
      scp: scope || scopeForStatus(user.account_status),
      tv: user.token_version || 0,
      sid: sessionId,
    },
    JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_TTL_SECONDS }
  );
}

/** Mở một phiên mới: ghi phiên phía máy chủ, đặt cookie làm mới, trả access token. */
async function startSession(req, res, user, scope) {
  const { sessionId, refreshToken } = await createSession(user.id);
  setRefreshCookie(req, res, refreshToken);
  return { token: signAccessToken(user, scope, sessionId), sessionId };
}

/**
 * Vai trò LUÔN đọc lại từ database, không lấy từ payload của JWT.
 *
 * Lý do: quản trị viên duyệt yêu cầu cấp quyền bán sẽ đổi role BUYER -> SELLER ngay trong
 * DB, nhưng token người đó đang cầm vẫn ghi "BUYER" cho tới khi hết hạn. Nếu tin payload
 * thì họ phải chờ hết ACCESS_TOKEN_TTL_SECONDS (mặc định 15 phút) hoặc đăng nhập lại mới
 * dùng được quyền mới. Đọc từ DB làm quyền có hiệu lực tức thì theo cả hai chiều — cấp
 * quyền cũng như thu quyền. Trạng thái tài khoản cũng vậy.
 *
 * JWT vẫn giữ nguyên vai trò của nó: chứng minh "ai đang gọi" (claim `sub`) và có chữ ký
 * nên không giả mạo được. Chỉ có các TRƯỜNG role/scope là không còn được tin.
 *
 * Trả về null nếu token hợp lệ nhưng tài khoản đã bị xoá, bị khoá, hoặc mật khẩu đã đổi
 * sau khi token này được cấp.
 */
async function loadUserFromToken(token) {
  const payload = jwt.verify(token, JWT_SECRET);
  const row = await db
    .prepare('SELECT id, username, display_name, role, account_status, token_version, is_active FROM users WHERE id = ?')
    .get(payload.sub);
  if (!row || !row.is_active) return null;
  if ((payload.tv || 0) !== row.token_version) return null; // mật khẩu đã đổi -> phiên cũ hết hiệu lực

  // Phiên phía máy chủ: đã đăng xuất, quá hạn hay nhàn rỗi quá lâu thì JWT còn hạn cũng vô hiệu.
  const session = await getSession(payload.sid);
  if (sessionProblem(session) || session.user_id !== row.id) return null;
  await touchSession(session);

  // Phạm vi thực tế là giao của phạm vi ghi trong token và phạm vi mà trạng thái tài khoản
  // hiện tại cho phép. Token cũ mang scope 'full' của một tài khoản vừa bị đưa về trạng thái
  // chưa hoàn tất sẽ không còn dùng được như phiên đầy đủ.
  const allowed = scopeForStatus(row.account_status);
  const claimed = payload.scp === SCOPE_FULL ? SCOPE_FULL : SCOPE_ENROLL;
  const scope = allowed === SCOPE_FULL && claimed === SCOPE_FULL ? SCOPE_FULL : SCOPE_ENROLL;

  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    accountStatus: row.account_status,
    tokenVersion: row.token_version,
    sessionId: session.id,
    scope,
  };
}

function readBearer(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

async function authenticate(req, res, requiredScope) {
  const token = readBearer(req);
  if (!token) {
    res.status(401).json({ error: 'UNAUTHENTICATED', message: 'Thiếu access token' });
    return null;
  }
  let user;
  try {
    user = await loadUserFromToken(token);
  } catch (e) {
    // Chỉ lỗi của chính JWT (sai chữ ký, hết hạn, sai định dạng) mới là "token không hợp lệ".
    // Lỗi cơ sở dữ liệu phải đi tiếp tới middleware lỗi thành 500 — trả 401 cho nó sẽ khiến
    // trình duyệt tưởng phiên đã hết và tự đăng xuất người dùng chỉ vì máy chủ trục trặc.
    if (!(e instanceof jwt.JsonWebTokenError)) throw e;
    res.status(401).json({ error: 'UNAUTHENTICATED', message: 'Token không hợp lệ hoặc đã hết hạn' });
    return null;
  }
  if (!user) {
    res.status(401).json({ error: 'UNAUTHENTICATED', message: 'Tài khoản không khả dụng hoặc phiên đã bị thu hồi' });
    return null;
  }
  if (requiredScope === SCOPE_FULL && user.scope !== SCOPE_FULL) {
    res.status(403).json({
      error: 'ACCOUNT_SETUP_INCOMPLETE',
      message:
        user.accountStatus === 'PENDING_BOOTSTRAP'
          ? 'Tài khoản quản trị viên còn dùng mật khẩu tạm. Hãy đổi mật khẩu rồi đăng ký Passkey.'
          : 'Tài khoản chưa đăng ký Passkey. Hãy hoàn tất bước này trước khi dùng các chức năng khác.',
      accountStatus: user.accountStatus,
    });
    return null;
  }
  return user;
}

/**
 * Mặc định là TỪ CHỐI: mọi tuyến dùng requireAuth đều đòi phiên đầy đủ.
 *
 * Nhờ vậy, thêm một tuyến nghiệp vụ mới mà quên nghĩ tới trạng thái tài khoản thì tuyến đó
 * tự động không mở cho phiên chưa hoàn tất thiết lập, thay vì mở nhầm rồi chờ ai đó phát
 * hiện. Chỉ đúng vài tuyến của luồng hoàn tất mới dùng requireEnrollAuth.
 */
async function requireAuth(req, res, next) {
  const user = await authenticate(req, res, SCOPE_FULL);
  if (!user) return;
  req.user = user;
  next();
}

/** Cho phép cả phiên đầy đủ lẫn phiên hoàn tất thiết lập. Dùng cho đúng luồng enroll. */
async function requireEnrollAuth(req, res, next) {
  const user = await authenticate(req, res, SCOPE_ENROLL);
  if (!user) return;
  req.user = user;
  next();
}

// Dùng cho các endpoint công khai nhưng muốn "biết thêm" nếu người dùng đã đăng nhập
// (ví dụ storefront: khách vãng lai vẫn xem được, người bán thì thấy cả tin đang ẩn).
async function optionalAuth(req, res, next) {
  const token = readBearer(req);
  if (token) {
    try {
      const user = await loadUserFromToken(token);
      if (user && user.scope === SCOPE_FULL) req.user = user;
    } catch (e) {
      // Token hỏng/hết hạn trên endpoint công khai: coi như khách vãng lai.
    }
  }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'FORBIDDEN', message: 'Không đủ quyền thực hiện thao tác này' });
    }
    next();
  };
}

/** Chỉ cho phép đúng một trạng thái tài khoản. Dùng để chốt thứ tự của luồng khởi tạo. */
function requireAccountStatus(...statuses) {
  return (req, res, next) => {
    if (!req.user || !statuses.includes(req.user.accountStatus)) {
      return res.status(409).json({
        error: 'INVALID_ACCOUNT_STATUS',
        message: 'Tài khoản không ở đúng bước của luồng thiết lập.',
        accountStatus: req.user ? req.user.accountStatus : null,
      });
    }
    next();
  };
}

module.exports = {
  signAccessToken,
  startSession,
  loadUserFromToken,
  requireAuth,
  requireEnrollAuth,
  optionalAuth,
  requireRole,
  requireAccountStatus,
  scopeForStatus,
  SCOPE_FULL,
  SCOPE_ENROLL,
  ACCESS_TOKEN_TTL_SECONDS,
};
