const express = require('express');

const { db, uuid, nowIso } = require('../db');
const { requireAuth } = require('../lib/auth');
const { AppError } = require('../lib/errors');
const { verifyProviderSignature, submitPayment } = require('../lib/mockPaymentProvider');
const { applyProviderResult } = require('../lib/paymentService');
const { getUserWallet } = require('../lib/walletOps');

const router = express.Router();

const MIN_AMOUNT = parseInt(process.env.TOPUP_MIN || '1000', 10);
const MAX_AMOUNT = parseInt(process.env.TOPUP_MAX_PER_REQUEST || '50000000', 10);
// Hạn mức tích luỹ. Một request hợp lệ thì chưa đủ: không có các hạn mức này, lặp lại request
// hợp lệ là nạp được vô hạn (với cổng giả lập, đó là "in tiền" không giới hạn).
const MAX_PER_DAY = parseInt(process.env.TOPUP_MAX_PER_DAY || '100000000', 10);
const MAX_PENDING = parseInt(process.env.TOPUP_MAX_PENDING || '5', 10);
const MAX_WALLET_BALANCE = parseInt(process.env.WALLET_MAX_BALANCE || '200000000', 10);
const DAY_MS = 24 * 3600 * 1000;

function vnd(n) {
  return `${Number(n).toLocaleString('vi-VN')}đ`;
}

/**
 * Chỉ nhận số nguyên JSON thật sự. Không ép kiểu bằng Number(): "1000", [1000], true đều bị
 * Number() biến thành số hợp lệ và lọt qua kiểm tra khoảng.
 */
function parseAmount(raw) {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw)) {
    throw new AppError(400, 'INVALID_AMOUNT', 'amount phải là một số nguyên (đơn vị đồng)');
  }
  if (raw < MIN_AMOUNT || raw > MAX_AMOUNT) {
    throw new AppError(400, 'AMOUNT_OUT_OF_RANGE', `amount phải từ ${vnd(MIN_AMOUNT)} đến ${vnd(MAX_AMOUNT)}`);
  }
  return raw;
}

function assertTopupLimits(userId, wallet, amount) {
  const since = new Date(Date.now() - DAY_MS).toISOString();
  const s = db.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN status = 'PENDING' AND created_at > ? THEN 1 ELSE 0 END), 0) AS pending_recent,
       COALESCE(SUM(CASE WHEN status IN ('PENDING','SUCCEEDED') AND created_at > ? THEN amount ELSE 0 END), 0) AS day_total,
       COALESCE(SUM(CASE WHEN status = 'PENDING' THEN amount ELSE 0 END), 0) AS pending_total
     FROM payment_requests WHERE user_id = ?`
  ).get(since, since, userId);

  const limited = (message) => new AppError(409, 'TOPUP_LIMIT_EXCEEDED', message);
  if (s.pending_recent >= MAX_PENDING) {
    throw limited(`Bạn đang có ${s.pending_recent} yêu cầu nạp tiền chờ xác nhận. Hãy hoàn tất hoặc huỷ bớt trước khi tạo thêm.`);
  }
  if (s.day_total + amount > MAX_PER_DAY) {
    throw limited(`Vượt hạn mức nạp ${vnd(MAX_PER_DAY)} trong 24 giờ.`);
  }
  const projected = wallet.available_balance + wallet.locked_balance + s.pending_total + amount;
  if (projected > MAX_WALLET_BALANCE) {
    throw limited(`Số dư ví không được vượt ${vnd(MAX_WALLET_BALANCE)}.`);
  }
}

function serializePaymentRequest(p) {
  return {
    id: p.id,
    amount: p.amount,
    status: p.status,
    providerRef: p.provider_ref,
    resolvedBy: p.resolved_by || null,
    createdAt: p.created_at,
    resolvedAt: p.resolved_at,
  };
}

// ---------- Tạo yêu cầu nạp tiền ----------
//
// Chỉ tạo bản ghi PENDING rồi gửi yêu cầu sang provider. KHÔNG chạm tới ví ở đây — ví chỉ đổi
// khi có kết quả SUCCEEDED từ provider, qua lib/paymentService.js#applyProviderResult.
router.post('/topup', requireAuth, (req, res, next) => {
  try {
    const amount = parseAmount((req.body || {}).amount);

    // Quản trị viên không phải một bên giao dịch nên không có ví — không có gì để nạp vào.
    const wallet = getUserWallet(req.user.id);
    if (!wallet) throw new AppError(400, 'WALLET_NOT_FOUND', 'Tài khoản này không có ví để nạp tiền');

    const id = uuid();
    // provider_ref mô phỏng mã do PHÍA PROVIDER cấp — độc lập với id nội bộ, đúng như một
    // provider thật sẽ làm. Ở đây tự sinh vì đang đóng luôn vai provider.
    const providerRef = uuid();
    const now = nowIso();
    // Kiểm hạn mức và ghi yêu cầu trong CÙNG một giao dịch ghi của SQLite, nên hai request đồng
    // thời không cùng lọt qua phép đếm rồi cùng ghi.
    db.transaction(() => {
      assertTopupLimits(req.user.id, wallet, amount);
      db.prepare(
        `INSERT INTO payment_requests (id, user_id, amount, status, provider_ref, version, created_at, updated_at)
         VALUES (?, ?, ?, 'PENDING', ?, 0, ?, ?)`
      ).run(id, req.user.id, amount, providerRef, now, now);
    })();

    // Ghi yêu cầu ở phía ta TRƯỚC rồi mới gửi sang provider: nếu bước gửi hỏng, yêu cầu vẫn
    // nằm ở PENDING và worker đối soát là nơi xử lý tiếp, không có tiền nào bị cộng sai.
    submitPayment({ providerRef, merchantRef: id, amount });

    res.status(201).json(serializePaymentRequest({
      id, amount, status: 'PENDING', provider_ref: providerRef, created_at: now, resolved_at: null,
    }));
  } catch (e) {
    next(e);
  }
});

// ---------- Danh sách yêu cầu nạp tiền của chính mình ----------

router.get('/me', requireAuth, (req, res) => {
  const rows = db
    .prepare('SELECT * FROM payment_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 200')
    .all(req.user.id);
  res.json({ paymentRequests: rows.map(serializePaymentRequest) });
});

// ---------------------------------------------------------------------------
// Webhook nhận callback từ Mock Payment Provider.
//
// KHÔNG có requireAuth: một provider thật không mang mã phiên/JWT của người dùng, nó xác
// thực bằng CHỮ KÝ trên chính payload. Sai chữ ký thì bị từ chối trước khi chạm tới bất kỳ dữ
// liệu nghiệp vụ nào. Sau bước chữ ký, mọi quyết định tất toán nằm ở applyProviderResult(),
// dùng chung với worker đối soát:
//   APPLIED   -> 200
//   DUPLICATE -> 200 kèm duplicate:true (provider gửi lặp là chuyện bình thường, phải trả 2xx
//                để nó thôi gửi lại; không chạm ví lần hai)
//   CONFLICT  -> 409 WEBHOOK_CONFLICT (kết quả trái với kết quả đã tất toán; không ghi đè)
// ---------------------------------------------------------------------------
router.post('/webhook', (req, res, next) => {
  try {
    const { payload, signature } = req.body || {};
    if (!payload || typeof payload !== 'object') {
      throw new AppError(400, 'VALIDATION_ERROR', 'Thiếu payload');
    }
    const { paymentRequestId, providerRef, status, amount } = payload;
    if (!paymentRequestId || !providerRef || !status || !Number.isInteger(amount)) {
      throw new AppError(400, 'VALIDATION_ERROR', 'payload thiếu hoặc sai kiểu trường bắt buộc');
    }
    if (status !== 'SUCCEEDED' && status !== 'FAILED') {
      throw new AppError(400, 'VALIDATION_ERROR', 'status phải là SUCCEEDED hoặc FAILED');
    }

    if (!verifyProviderSignature(payload, signature)) {
      throw new AppError(401, 'INVALID_SIGNATURE', 'Chữ ký webhook không hợp lệ — callback bị từ chối');
    }

    const result = applyProviderResult(
      { paymentRequestId, providerRef, status, amount, source: 'WEBHOOK' },
      { req }
    );
    if (result.outcome === 'CONFLICT') throw new AppError(409, 'WEBHOOK_CONFLICT', result.reason);
    if (result.outcome === 'DUPLICATE') {
      return res.json({ paymentRequestId, status: result.status, duplicate: true });
    }
    res.json({ paymentRequestId, status: result.status });
  } catch (e) {
    next(e);
  }
});

// ---------- Chi tiết một yêu cầu (đặt SAU /me và /webhook vì đây là route dạng :id) ----------

router.get('/:id', requireAuth, (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM payment_requests WHERE id = ?').get(req.params.id);
    if (!row) throw new AppError(404, 'PAYMENT_REQUEST_NOT_FOUND', 'Không tìm thấy yêu cầu nạp tiền');
    if (row.user_id !== req.user.id) throw new AppError(403, 'FORBIDDEN', 'Bạn không có quyền xem yêu cầu nạp tiền này');
    res.json(serializePaymentRequest(row));
  } catch (e) {
    next(e);
  }
});

module.exports = router;
