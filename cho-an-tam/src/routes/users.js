const express = require('express');

const { db, uuid, nowIso } = require('../db');
const { requireAuth, requireEnrollAuth, optionalAuth, signAccessToken } = require('../lib/auth');
const { AppError } = require('../lib/errors');
const { ACTIONS, requireGrant, markGrantUsed } = require('../lib/reauth');
const { hashPassword, verifyPassword, assertPasswordPolicy } = require('../lib/password');
const { rateLimit } = require('../lib/rateLimit');
const { logSecurityEvent, EVENTS } = require('../lib/securityEvents');

const router = express.Router();

// Đổi mật khẩu là thao tác nhạy cảm và mỗi lần gọi đều chạy một hàm dẫn xuất khoá chậm,
// nên nó vừa đáng bảo vệ vừa là một điểm tốn tài nguyên đáng chặn.
const sensitiveLimiter = rateLimit({ perMinute: parseInt(process.env.RATE_LIMIT_AUTH_PER_MINUTE || '10', 10) });

function serializeSellerRequest(r) {
  if (!r) return null;
  return {
    id: r.id,
    userId: r.user_id,
    userName: r.user_name || null,
    userUsername: r.user_username || null,
    shopName: r.shop_name,
    pitch: r.pitch,
    status: r.status,
    reviewNote: r.review_note,
    reviewedByName: r.reviewed_by_name || null,
    reviewedAt: r.reviewed_at,
    createdAt: r.created_at,
  };
}

// Hồ sơ đầy đủ của chính mình: dùng để khôi phục phiên sau khi tải lại trang
// (JWT nằm trong localStorage nhưng thông tin hiển thị thì lấy tươi từ server).
// Dùng requireEnrollAuth: tài khoản chưa hoàn tất thiết lập cũng phải xem được hồ sơ của
// chính mình, nếu không giao diện sẽ không biết phải dẫn người dùng tới bước nào tiếp theo.
// Đây là một trong số rất ít tuyến mở cho phiên chưa đầy đủ, và nó chỉ ĐỌC.
router.get('/me', requireEnrollAuth, (req, res, next) => {
  try {
    const user = db
      .prepare('SELECT id, username, display_name, role, account_status, is_active, created_at FROM users WHERE id = ?')
      .get(req.user.id);
    if (!user || !user.is_active) throw new AppError(401, 'USER_INACTIVE', 'Tài khoản không khả dụng');

    const wallet = db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(user.id);
    const credential = db
      .prepare('SELECT created_at, last_used_at FROM passkey_credentials WHERE user_id = ?')
      .get(user.id);
    const credentialCount = db
      .prepare('SELECT COUNT(*) AS n FROM passkey_credentials WHERE user_id = ?')
      .get(user.id).n;

    res.json({
      user: {
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        role: user.role,
        accountStatus: user.account_status,
        sessionScope: req.user.scope,
        credentialCount,
        createdAt: user.created_at,
      },
      wallet: wallet
        ? {
            id: wallet.id,
            availableBalance: wallet.available_balance,
            lockedBalance: wallet.locked_balance,
            version: wallet.version,
          }
        : null,
      passkey: credential
        ? { createdAt: credential.created_at, lastUsedAt: credential.last_used_at }
        : null,
    });
  } catch (e) {
    next(e);
  }
});

// ---------------------------------------------------------------------------
// Đổi mật khẩu
//
// Việc xếp đổi mật khẩu vào nhóm thao tác nhạy cảm là BẮT BUỘC trong mô hình lai. Nếu chỉ
// cần đang đăng nhập là đổi được mật khẩu thì kẻ chiếm được phiên sẽ tự đặt một mật khẩu
// mới và giữ được lối vào lâu dài mà không cần chạm tới Passkey — tức là mở lại đúng lỗ
// hổng mà quy tắc xác thực lại được đặt ra để bịt.
//
// Vì vậy điều kiện ở đây là một phiếu uỷ quyền CHANGE_PASSWORD, sinh từ một lần xác thực
// lại bằng một credential đang có, chứ không phải mật khẩu cũ. Mật khẩu cũ là thứ mà kẻ
// chiếm phiên có thể đã biết; credential thì không.
//
// Sau khi đổi, token_version tăng lên nên mọi mã phiên cấp trước đó — kể cả mã phiên mà kẻ
// tấn công đang cầm — lập tức mất hiệu lực. Người gọi nhận lại một mã phiên mới.
// ---------------------------------------------------------------------------

router.post('/me/password', requireAuth, sensitiveLimiter, (req, res, next) => {
  try {
    const { newPassword, reauthGrant } = req.body || {};
    if (!newPassword) throw new AppError(400, 'VALIDATION_ERROR', 'Thiếu newPassword');

    const grant = requireGrant({
      userId: req.user.id,
      action: ACTIONS.CHANGE_PASSWORD,
      rawToken: reauthGrant,
      message: 'Đổi mật khẩu cần xác thực lại bằng passkey đang có',
    });

    assertPasswordPolicy(newPassword);

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (verifyPassword(newPassword, user.password_hash)) {
      throw new AppError(400, 'SAME_PASSWORD', 'Mật khẩu mới phải khác mật khẩu hiện tại');
    }

    const hashed = hashPassword(newPassword);
    const now = nowIso();

    // Đổi mật khẩu, thu hồi phiên cũ và tiêu thụ phiếu trong CÙNG một giao dịch cơ sở dữ liệu.
    db.transaction(() => {
      db.prepare(
        'UPDATE users SET password_hash = ?, token_version = token_version + 1, updated_at = ? WHERE id = ?'
      ).run(hashed, now, user.id);
      markGrantUsed(grant.id);
    })();

    logSecurityEvent(req, { type: EVENTS.PASSWORD_CHANGED, outcome: 'ALLOWED', statusCode: 200 });

    const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    res.json({
      token: signAccessToken(fresh),
      changedAt: now,
      message: 'Đã đổi mật khẩu. Mọi phiên đăng nhập khác của tài khoản này đã bị thu hồi.',
    });
  } catch (e) {
    next(e);
  }
});

// ---------------------------------------------------------------------------
// Yêu cầu cấp quyền bán hàng
//
// Người mua tự gửi, quản trị viên duyệt. Khi được duyệt, chính tài khoản này được
// nâng lên SELLER — ví, passkey và lịch sử giao dịch đã mua giữ nguyên (xem admin.js).
// ---------------------------------------------------------------------------

// Yêu cầu MỚI NHẤT của chính mình. Giao diện dùng nó để quyết định hiện nút "Đăng ký
// bán hàng", thẻ "đang chờ duyệt" hay lý do bị từ chối.
router.get('/me/seller-request', requireAuth, (req, res, next) => {
  try {
    const row = db
      .prepare(
        `SELECT sr.*, rv.display_name AS reviewed_by_name
         FROM seller_requests sr
         LEFT JOIN users rv ON rv.id = sr.reviewed_by
         WHERE sr.user_id = ?
         ORDER BY sr.created_at DESC
         LIMIT 1`
      )
      .get(req.user.id);
    res.json({ request: serializeSellerRequest(row) });
  } catch (e) {
    next(e);
  }
});

router.post('/me/seller-request', requireAuth, (req, res, next) => {
  try {
    if (req.user.role !== 'BUYER') {
      throw new AppError(
        403,
        'ROLE_NOT_ELIGIBLE',
        req.user.role === 'SELLER'
          ? 'Tài khoản của bạn đã có quyền bán hàng'
          : 'Tài khoản quản trị không đăng ký bán hàng được'
      );
    }

    const shopName = String(req.body.shopName || '').trim();
    const pitch = String(req.body.pitch || '').trim();
    if (shopName.length < 2 || shopName.length > 60) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Tên cửa hàng phải từ 2 đến 60 ký tự');
    }
    if (pitch.length > 1000) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Phần mô tả tối đa 1000 ký tự');
    }

    // Chặn ở tầng ứng dụng cho thông báo dễ hiểu; partial unique index trong schema.sql
    // mới là chốt chặn thật khi hai request bay lên cùng lúc.
    const pending = db
      .prepare(`SELECT 1 FROM seller_requests WHERE user_id = ? AND status = 'PENDING'`)
      .get(req.user.id);
    if (pending) {
      throw new AppError(409, 'REQUEST_ALREADY_PENDING', 'Bạn đang có một yêu cầu chờ duyệt');
    }

    const id = uuid();
    const now = nowIso();
    try {
      db.prepare(
        `INSERT INTO seller_requests (id, user_id, shop_name, pitch, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'PENDING', ?, ?)`
      ).run(id, req.user.id, shopName, pitch || null, now, now);
    } catch (e) {
      if (/UNIQUE constraint failed/.test(e.message || '')) {
        throw new AppError(409, 'REQUEST_ALREADY_PENDING', 'Bạn đang có một yêu cầu chờ duyệt');
      }
      throw e;
    }

    const row = db.prepare('SELECT * FROM seller_requests WHERE id = ?').get(id);
    res.status(201).json({ request: serializeSellerRequest(row) });
  } catch (e) {
    next(e);
  }
});

// Hồ sơ công khai của một người bán — chỉ lộ thông tin cần cho trang cửa hàng.
router.get('/:id', optionalAuth, (req, res, next) => {
  try {
    const user = db
      .prepare('SELECT id, username, display_name, role, created_at FROM users WHERE id = ? AND is_active = 1')
      .get(req.params.id);
    if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'Không tìm thấy người dùng');

    const listingCount = db
      .prepare(`SELECT COUNT(*) AS n FROM listings WHERE seller_id = ? AND visibility = 'PUBLIC'`)
      .get(user.id).n;
    const completedSales = db
      .prepare(`SELECT COUNT(*) AS n FROM transactions WHERE seller_id = ? AND status IN ('COMPLETED','RELEASED')`)
      .get(user.id).n;

    res.json({
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      role: user.role,
      joinedAt: user.created_at,
      listingCount,
      completedSales,
    });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
module.exports.serializeSellerRequest = serializeSellerRequest;
