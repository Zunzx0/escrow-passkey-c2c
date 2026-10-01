const express = require('express');

const { db, uuid, nowIso } = require('../db');
const { requireAuth } = require('../lib/auth');
const { AppError } = require('../lib/errors');
const { verifyProviderSignature, submitPayment } = require('../lib/mockPaymentProvider');
const { applyProviderResult } = require('../lib/paymentService');
const { getUserWallet } = require('../lib/walletOps');

const router = express.Router();

const MIN_AMOUNT = 1000;
const MAX_AMOUNT = 50000000;

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
    const amount = Number((req.body || {}).amount);
    if (!Number.isInteger(amount) || amount < MIN_AMOUNT || amount > MAX_AMOUNT) {
      throw new AppError(
        400,
        'VALIDATION_ERROR',
        `amount phải là số nguyên từ ${MIN_AMOUNT.toLocaleString('vi-VN')}đ đến ${MAX_AMOUNT.toLocaleString('vi-VN')}đ`
      );
    }

    // Quản trị viên không phải một bên giao dịch nên không có ví — không có gì để nạp vào.
    const wallet = getUserWallet(req.user.id);
    if (!wallet) throw new AppError(400, 'WALLET_NOT_FOUND', 'Tài khoản này không có ví để nạp tiền');

    const id = uuid();
    // provider_ref mô phỏng mã do PHÍA PROVIDER cấp — độc lập với id nội bộ, đúng như một
    // provider thật sẽ làm. Ở đây tự sinh vì đang đóng luôn vai provider.
    const providerRef = uuid();
    const now = nowIso();
    db.prepare(
      `INSERT INTO payment_requests (id, user_id, amount, status, provider_ref, version, created_at, updated_at)
       VALUES (?, ?, ?, 'PENDING', ?, 0, ?, ?)`
    ).run(id, req.user.id, amount, providerRef, now, now);

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
