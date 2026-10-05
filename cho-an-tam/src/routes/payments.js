const express = require('express');

const { db, uuid, nowIso } = require('../db');
const { requireAuth } = require('../lib/auth');
const { AppError } = require('../lib/errors');
const { verifyProviderSignature } = require('../lib/mockPaymentProvider');
const { applyProviderResult, claimSubmission, submitToProvider } = require('../lib/paymentService');
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

async function assertTopupLimits(userId, wallet, amount) {
  const since = new Date(Date.now() - DAY_MS).toISOString();
  const s = await db.prepare(
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
    // Khoá chống lặp client đã gửi (null nếu không gửi) và trạng thái bước gửi sang provider:
    // SUBMITTING | SUBMITTED | SUBMIT_FAILED. Chỉ SUBMITTED mới mở được trang thanh toán.
    requestId: p.client_request_id || null,
    submissionStatus: p.submission_status || 'SUBMITTED',
  };
}

/**
 * Khoá chống lặp do client gửi (tuỳ chọn). Chuỗi 8–100 ký tự [A-Za-z0-9._:-] — đủ cho UUID và
 * các khoá dạng "topup-<uuid>"; không nhận số/boolean để hai client không vô tình trùng khoá.
 */
function parseClientRequestId(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string' || !/^[A-Za-z0-9._:-]{8,100}$/.test(raw)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'requestId phải là chuỗi 8–100 ký tự gồm chữ, số và . _ : -');
  }
  return raw;
}

const loadByClientKey = (userId, key) =>
  db.prepare('SELECT * FROM payment_requests WHERE user_id = ? AND client_request_id = ?').get(userId, key);

const PROVIDER_UNAVAILABLE = () => new AppError(
  503,
  'PROVIDER_UNAVAILABLE',
  'Cổng thanh toán tạm thời không nhận yêu cầu. Yêu cầu đã được lưu — hãy thử lại sau ít phút (gửi lại cùng requestId) hoặc hệ thống sẽ tự gửi lại.'
);

/**
 * Trả lại yêu cầu đã có cho một lần gửi lặp (cùng người dùng, cùng requestId).
 * Khác số tiền là dùng lại khoá cho một nghiệp vụ khác -> 409.
 *
 * Yêu cầu còn PENDING mà provider chưa nhận thì GIÀNH quyền gửi rồi gửi lại. Nếu tiến trình khác đang
 * giữ quyền còn hạn (đang gửi), không gửi lần nữa: trả trạng thái hiện tại (SUBMITTING) để client chờ.
 */
async function replayExisting(res, existing, amount) {
  if (existing.amount !== amount) {
    throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', 'requestId này đã dùng cho một yêu cầu nạp tiền khác số tiền');
  }
  let row = existing;
  if (row.status === 'PENDING' && row.submission_status !== 'SUBMITTED') {
    const claim = await claimSubmission(row);
    if (claim) {
      const sent = await submitToProvider(row, claim);
      row = await db.prepare('SELECT * FROM payment_requests WHERE id = ?').get(row.id);
      if (!sent.submitted && !sent.busy && row.status === 'PENDING') throw PROVIDER_UNAVAILABLE();
    } else {
      row = await db.prepare('SELECT * FROM payment_requests WHERE id = ?').get(row.id);
    }
  }
  res.status(200).json({ ...serializePaymentRequest(row), idempotentReplay: true });
}

// ---------- Tạo yêu cầu nạp tiền ----------
//
// Chỉ tạo bản ghi PENDING rồi gửi yêu cầu sang provider. KHÔNG chạm tới ví ở đây — ví chỉ đổi
// khi có kết quả SUCCEEDED từ provider, qua lib/paymentService.js#applyProviderResult.
//
// Chống lặp: client gửi kèm `requestId` (khuyến nghị — giao diện nên sinh một lần cho mỗi lần bấm
// "Nạp tiền" và giữ nguyên khi thử lại). Cùng người dùng + cùng requestId chỉ bao giờ có MỘT yêu
// cầu: phép kiểm nằm trong cùng giao dịch ghi (tuần tự hoá) với lệnh INSERT, và chỉ mục duy nhất
// (user_id, client_request_id) là lưới an toàn thứ hai. Không gửi requestId thì giữ hành vi cũ.
router.post('/topup', requireAuth, async (req, res, next) => {
  try {
    const amount = parseAmount((req.body || {}).amount);
    const clientRequestId = parseClientRequestId((req.body || {}).requestId);

    if (clientRequestId) {
      const existing = await loadByClientKey(req.user.id, clientRequestId);
      if (existing) return await replayExisting(res, existing, amount);
    }

    const id = uuid();
    // provider_ref mô phỏng mã do PHÍA PROVIDER cấp — độc lập với id nội bộ, đúng như một
    // provider thật sẽ làm. Ở đây tự sinh vì đang đóng luôn vai provider.
    const providerRef = uuid();
    // Người tạo giữ quyền gửi ngay từ lúc INSERT: không tiến trình nào khác được gửi yêu cầu này.
    const claim = uuid();
    const now = nowIso();
    let replay = null;
    // Kiểm hạn mức và ghi yêu cầu trong CÙNG một giao dịch ghi của cơ sở dữ liệu, nên hai request
    // đồng thời không cùng lọt qua phép đếm rồi cùng ghi.
    try {
      await db.transaction(async () => {
        if (clientRequestId) {
          // Kiểm lại BÊN TRONG giao dịch: request cùng khoá chạy song song có thể đã ghi xong.
          replay = await loadByClientKey(req.user.id, clientRequestId);
          if (replay) return;
        }
        // Đọc ví BÊN TRONG giao dịch: đọc ở ngoài thì một webhook tất toán chen vào giữa sẽ làm số
        // dư cũ đi trong khi pending_total đã giảm, khiến phép chiếu số dư đếm thiếu.
        // Quản trị viên không phải một bên giao dịch nên không có ví — không có gì để nạp vào.
        const wallet = await getUserWallet(req.user.id);
        if (!wallet) throw new AppError(400, 'WALLET_NOT_FOUND', 'Tài khoản này không có ví để nạp tiền');
        await assertTopupLimits(req.user.id, wallet, amount);
        await db.prepare(
          `INSERT INTO payment_requests
             (id, user_id, amount, status, provider_ref, version, client_request_id, submission_status,
              submit_claim, submit_claimed_at, created_at, updated_at)
           VALUES (?, ?, ?, 'PENDING', ?, 0, ?, 'SUBMITTING', ?, ?, ?, ?)`
        ).run(id, req.user.id, amount, providerRef, clientRequestId, claim, now, now, now);
      })();
    } catch (e) {
      // Một tiến trình khác (cùng CSDL) vừa ghi cùng khoá: chỉ mục duy nhất chặn — trả yêu cầu đó.
      if (clientRequestId && db.isUniqueViolation(e)) replay = await loadByClientKey(req.user.id, clientRequestId);
      if (!replay) throw e;
    }
    if (replay) return await replayExisting(res, replay, amount);

    // Ghi yêu cầu ở phía ta TRƯỚC rồi mới gửi sang provider: nếu bước gửi hỏng, yêu cầu nằm ở
    // PENDING + SUBMIT_FAILED (không phải im lặng PENDING), client nhận 503 rõ ràng, và việc gửi
    // lại thuộc về client (cùng requestId) hoặc worker đối soát.
    const sent = await submitToProvider({ id, provider_ref: providerRef, amount }, claim);
    if (!sent.submitted) throw PROVIDER_UNAVAILABLE();

    res.status(201).json(serializePaymentRequest(await db.prepare('SELECT * FROM payment_requests WHERE id = ?').get(id)));
  } catch (e) {
    next(e);
  }
});

// ---------- Danh sách yêu cầu nạp tiền của chính mình ----------

router.get('/me', requireAuth, async (req, res) => {
  const rows = await db
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
router.post('/webhook', async (req, res, next) => {
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

    const result = await applyProviderResult(
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

router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const row = await db.prepare('SELECT * FROM payment_requests WHERE id = ?').get(req.params.id);
    if (!row) throw new AppError(404, 'PAYMENT_REQUEST_NOT_FOUND', 'Không tìm thấy yêu cầu nạp tiền');
    if (row.user_id !== req.user.id) throw new AppError(403, 'FORBIDDEN', 'Bạn không có quyền xem yêu cầu nạp tiền này');
    res.json(serializePaymentRequest(row));
  } catch (e) {
    next(e);
  }
});

module.exports = router;
