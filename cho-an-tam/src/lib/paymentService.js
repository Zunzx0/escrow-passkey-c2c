// Con đường DUY NHẤT làm thay đổi trạng thái của một yêu cầu nạp tiền và cộng tiền vào ví
// (ngoại lệ duy nhất là expireUnsubmitted ở cuối tệp: đóng FAILED một yêu cầu provider chưa từng
// nhận, không bao giờ cộng ví).
//
// Kết quả từ provider đến qua hai kênh độc lập — webhook đã ký (routes/payments.js) và worker
// đối soát tự đi hỏi (lib/reconciler.js). Cả hai gọi đúng hàm applyProviderResult() dưới đây,
// nên chỉ có một chỗ quyết định "được tất toán chưa, có được cộng tiền không". Nếu mỗi kênh tự
// viết logic riêng, hai kênh sớm muộn sẽ lệch nhau và cùng cộng tiền cho một yêu cầu.
//
// Bảo đảm của hàm:
//   - tất toán ĐÚNG MỘT LẦN: cập nhật có điều kiện WHERE status='PENDING' AND version=?; ai đến
//     sau (webhook trùng, worker thứ hai, webhook đến sau worker) nhận DUPLICATE hoặc CONFLICT;
//   - cộng tiền nguyên tử: đổi trạng thái, cộng ví và ghi bút toán nằm trong một giao dịch cơ
//     sở dữ liệu; hỏng ở bất kỳ bước nào (kể cả process chết giữa chừng) thì không bước nào
//     được coi là đã xảy ra;
//   - không bao giờ ghi đè một kết quả đã tất toán.
const { db, nowIso } = require('../db');
const { AppError } = require('./errors');
const { applyWalletDelta, insertWalletEntry, fingerprintRequest, getUserWallet } = require('./walletOps');
const { maybeFail } = require('./faultInjection');
const { logSecurityEvent, EVENTS } = require('./securityEvents');
const { onTopupResolved } = require('./notifications');

const FINAL_STATUSES = new Set(['SUCCEEDED', 'FAILED']);
const SOURCES = new Set(['WEBHOOK', 'RECONCILER']);

function settledOutcome(currentStatus, incomingStatus) {
  if (currentStatus === incomingStatus) return { outcome: 'DUPLICATE', status: currentStatus };
  return {
    outcome: 'CONFLICT',
    status: currentStatus,
    reason: `Yêu cầu đã tất toán ở trạng thái ${currentStatus}, không nhận trạng thái ${incomingStatus} nữa`,
  };
}

/**
 * Áp một kết quả cuối cùng từ provider vào một yêu cầu nạp tiền.
 *
 * @param {object} result  { paymentRequestId, providerRef, status, amount, source }
 * @param {object} [opts]  { req } — request HTTP nếu có, chỉ để nhật ký an toàn ghi được IP/tuyến
 * @returns {{ outcome: 'APPLIED'|'DUPLICATE'|'CONFLICT', status: string, reason?: string }}
 *
 * Chỉ ném lỗi khi đầu vào sai hoặc yêu cầu không tồn tại. Thắng/thua trong cuộc đua tất toán
 * KHÔNG phải lỗi — đó là kết quả DUPLICATE/CONFLICT để từng kênh tự quyết cách phản hồi.
 */
async function applyProviderResult({ paymentRequestId, providerRef, status, amount, source }, { req = null } = {}) {
  if (!FINAL_STATUSES.has(status)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Kết quả từ provider phải là SUCCEEDED hoặc FAILED');
  }
  if (!SOURCES.has(source)) throw new Error(`Nguồn kết quả không hợp lệ: ${source}`);

  const pr = await db.prepare('SELECT * FROM payment_requests WHERE id = ?').get(paymentRequestId);
  if (!pr) throw new AppError(404, 'PAYMENT_REQUEST_NOT_FOUND', 'Không tìm thấy yêu cầu nạp tiền');
  if (pr.provider_ref !== providerRef) {
    return { outcome: 'CONFLICT', status: pr.status, reason: 'providerRef không khớp yêu cầu nạp tiền' };
  }
  if (pr.amount !== amount) {
    return { outcome: 'CONFLICT', status: pr.status, reason: 'Số tiền từ provider không khớp yêu cầu nạp tiền' };
  }
  if (pr.status !== 'PENDING') return settledOutcome(pr.status, status);

  let applied = false;
  await db.transaction(async () => {
    const now = nowIso();
    const claim = await db
      .prepare(
        `UPDATE payment_requests
         SET status = ?, version = version + 1, resolved_at = ?, resolved_by = ?, updated_at = ?
         WHERE id = ? AND status = 'PENDING' AND version = ?`
      )
      .run(status, now, source, now, pr.id, pr.version);
    if (claim.changes !== 1) return;

    if (status === 'SUCCEEDED') {
      const wallet = await getUserWallet(pr.user_id);
      if (!wallet) throw new AppError(404, 'WALLET_NOT_FOUND', 'Không tìm thấy ví của người nạp tiền');
      const updated = await applyWalletDelta(wallet, pr.amount, 0);
      // Số dư đã đổi, bút toán chưa ghi — điểm hỏng nguy hiểm nhất, dùng cho kiểm thử crash.
      maybeFail('after-wallet-update', 'topup');
      await insertWalletEntry({
        walletId: wallet.id,
        transactionId: null,
        requestId: pr.id,
        entryType: 'TOPUP_CREDIT',
        availableDelta: pr.amount,
        lockedDelta: 0,
        walletAfter: updated,
        // Khoá bằng chính id của payment_request: một yêu cầu chỉ tất toán SUCCEEDED một lần
        // duy nhất nên đây là khoá chống lặp tự nhiên, và UNIQUE ở cơ sở dữ liệu là lưới an
        // toàn thứ hai nếu hàng rào trạng thái ở trên có lỗi.
        idempotencyKey: `topup:${pr.id}`,
        requestFingerprint: fingerprintRequest({
          actorId: pr.user_id, action: 'TOPUP', transactionId: null, amount: pr.amount,
        }),
        description: 'Nạp tiền qua Mock Payment Provider',
      });
    }
    applied = true;
  })();

  if (!applied) {
    // Thua trong cuộc đua tất toán — đọc lại trạng thái mới nhất, xử lý như "đã tất toán".
    const latest = await db.prepare('SELECT status FROM payment_requests WHERE id = ?').get(pr.id);
    return settledOutcome(latest.status, status);
  }

  await logSecurityEvent(req, {
    type: status === 'SUCCEEDED' ? EVENTS.TOPUP_SUCCEEDED : EVENTS.TOPUP_FAILED,
    outcome: 'ALLOWED',
    statusCode: req ? 200 : null,
    detail: { paymentRequestId: pr.id, amount: pr.amount, source },
  });
  // Chỉ nhánh APPLIED mới báo — webhook lặp hay worker thua cuộc đua không sinh thông báo thừa.
  await onTopupResolved(pr, status);

  return { outcome: 'APPLIED', status };
}

// ---------------------------------------------------------------------------------------
// Bước GỬI yêu cầu sang provider (submission_status, xem schema.sql)
// ---------------------------------------------------------------------------------------
//
// Yêu cầu được ghi PENDING + SUBMITTING TRƯỚC rồi mới gửi provider (để không bao giờ có khoản
// provider biết mà phía ta không biết). Gửi hỏng thì yêu cầu không được nằm im: nó mang
// SUBMIT_FAILED, client gửi lại cùng requestId hoặc worker đối soát sẽ gửi lại. Provider nhận
// idempotent theo providerRef nên gửi lại bao nhiêu lần cũng chỉ một bản ghi.

function maxSubmitAttempts() {
  return Math.max(1, parseInt(process.env.TOPUP_SUBMIT_MAX_ATTEMPTS || '5', 10) || 5);
}

/**
 * Gửi (hoặc gửi lại) một yêu cầu PENDING sang provider và ghi kết quả vào submission_status.
 * @returns {{ submitted: boolean, error?: Error }}
 */
async function submitToProvider(pr) {
  const provider = require('./mockPaymentProvider');
  try {
    await provider.submitPayment({ providerRef: pr.provider_ref, merchantRef: pr.id, amount: pr.amount });
  } catch (e) {
    await db.prepare(
      `UPDATE payment_requests
       SET submission_status = 'SUBMIT_FAILED', submit_attempts = submit_attempts + 1, last_submit_error = ?, updated_at = ?
       WHERE id = ? AND status = 'PENDING' AND submission_status <> 'SUBMITTED'`
    ).run(`${e.code || 'SUBMIT_ERROR'}: ${e.message}`.slice(0, 300), nowIso(), pr.id);
    return { submitted: false, error: e };
  }
  const marked = await db.prepare(
    `UPDATE payment_requests
     SET submission_status = 'SUBMITTED', submit_attempts = submit_attempts + 1, last_submit_error = NULL, updated_at = ?
     WHERE id = ? AND status = 'PENDING' AND submission_status <> 'SUBMITTED'`
  ).run(nowIso(), pr.id);
  if (marked.changes !== 1) {
    // Hoặc đã SUBMITTED từ trước (bình thường), hoặc yêu cầu vừa bị đưa sang FAILED vì hết lượt
    // gửi trong lúc lần gửi này đang chạy. Trường hợp sau: huỷ khoản vừa tạo ở provider để người
    // dùng không thể thanh toán một yêu cầu mà phía ta đã đóng.
    const cur = await db.prepare('SELECT status FROM payment_requests WHERE id = ?').get(pr.id);
    if (cur && cur.status === 'FAILED') {
      try { await provider.settlePayment(pr.provider_ref, 'FAILED', { onlyFromPending: true }); } catch (_) { /* đã có kết quả */ }
      return { submitted: false, error: new AppError(409, 'PAYMENT_REQUEST_CLOSED', 'Yêu cầu nạp tiền đã đóng') };
    }
  }
  return { submitted: true };
}

/**
 * Đóng một yêu cầu mà provider CHƯA TỪNG nhận được, sau khi đã gửi đủ TOPUP_SUBMIT_MAX_ATTEMPTS
 * lần. Chỉ đóng khi provider xác nhận không có bản ghi nào cho providerRef — nếu có (một lần gửi
 * trước thật ra đã tới), yêu cầu được đánh dấu SUBMITTED và tiếp tục chờ kết quả như thường.
 * Không có tiền nào di chuyển: chỉ một yêu cầu SUCCEEDED mới từng cộng ví.
 *
 * @returns {{ outcome: 'EXPIRED'|'SUBMITTED'|'SKIPPED' }}
 */
async function expireUnsubmitted(pr) {
  const provider = require('./mockPaymentProvider');
  const atProvider = await provider.findPayment(pr.provider_ref);
  if (atProvider) {
    await db.prepare(
      `UPDATE payment_requests SET submission_status = 'SUBMITTED', last_submit_error = NULL, updated_at = ?
       WHERE id = ? AND status = 'PENDING'`
    ).run(nowIso(), pr.id);
    return { outcome: 'SUBMITTED' };
  }

  let expired = false;
  await db.transaction(async () => {
    const now = nowIso();
    const r = await db.prepare(
      `UPDATE payment_requests
       SET status = 'FAILED', version = version + 1, resolved_at = ?, resolved_by = 'RECONCILER',
           last_reconcile_error = ?, updated_at = ?
       WHERE id = ? AND status = 'PENDING' AND submission_status <> 'SUBMITTED' AND submit_attempts >= ?`
    ).run(now, `SUBMIT_EXHAUSTED: provider không nhận yêu cầu sau ${maxSubmitAttempts()} lần gửi`, now, pr.id, maxSubmitAttempts());
    expired = r.changes === 1;
  })();
  if (!expired) return { outcome: 'SKIPPED' };

  await logSecurityEvent(null, {
    type: EVENTS.TOPUP_FAILED,
    outcome: 'ALLOWED',
    detail: { paymentRequestId: pr.id, amount: pr.amount, source: 'RECONCILER', reason: 'SUBMIT_EXHAUSTED' },
  });
  await onTopupResolved(pr, 'FAILED');
  return { outcome: 'EXPIRED' };
}

module.exports = { applyProviderResult, submitToProvider, expireUnsubmitted, maxSubmitAttempts };
