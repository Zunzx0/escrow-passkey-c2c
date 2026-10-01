// Con đường DUY NHẤT làm thay đổi trạng thái của một yêu cầu nạp tiền và cộng tiền vào ví.
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
function applyProviderResult({ paymentRequestId, providerRef, status, amount, source }, { req = null } = {}) {
  if (!FINAL_STATUSES.has(status)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Kết quả từ provider phải là SUCCEEDED hoặc FAILED');
  }
  if (!SOURCES.has(source)) throw new Error(`Nguồn kết quả không hợp lệ: ${source}`);

  const pr = db.prepare('SELECT * FROM payment_requests WHERE id = ?').get(paymentRequestId);
  if (!pr) throw new AppError(404, 'PAYMENT_REQUEST_NOT_FOUND', 'Không tìm thấy yêu cầu nạp tiền');
  if (pr.provider_ref !== providerRef) {
    return { outcome: 'CONFLICT', status: pr.status, reason: 'providerRef không khớp yêu cầu nạp tiền' };
  }
  if (pr.amount !== amount) {
    return { outcome: 'CONFLICT', status: pr.status, reason: 'Số tiền từ provider không khớp yêu cầu nạp tiền' };
  }
  if (pr.status !== 'PENDING') return settledOutcome(pr.status, status);

  let applied = false;
  db.transaction(() => {
    const now = nowIso();
    const claim = db
      .prepare(
        `UPDATE payment_requests
         SET status = ?, version = version + 1, resolved_at = ?, resolved_by = ?, updated_at = ?
         WHERE id = ? AND status = 'PENDING' AND version = ?`
      )
      .run(status, now, source, now, pr.id, pr.version);
    if (claim.changes !== 1) return;

    if (status === 'SUCCEEDED') {
      const wallet = getUserWallet(pr.user_id);
      if (!wallet) throw new AppError(404, 'WALLET_NOT_FOUND', 'Không tìm thấy ví của người nạp tiền');
      const updated = applyWalletDelta(wallet, pr.amount, 0);
      // Số dư đã đổi, bút toán chưa ghi — điểm hỏng nguy hiểm nhất, dùng cho kiểm thử crash.
      maybeFail('after-wallet-update', 'topup');
      insertWalletEntry({
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
    const latest = db.prepare('SELECT status FROM payment_requests WHERE id = ?').get(pr.id);
    return settledOutcome(latest.status, status);
  }

  logSecurityEvent(req, {
    type: status === 'SUCCEEDED' ? EVENTS.TOPUP_SUCCEEDED : EVENTS.TOPUP_FAILED,
    outcome: 'ALLOWED',
    statusCode: req ? 200 : null,
    detail: { paymentRequestId: pr.id, amount: pr.amount, source },
  });
  // Chỉ nhánh APPLIED mới báo — webhook lặp hay worker thua cuộc đua không sinh thông báo thừa.
  onTopupResolved(pr, status);

  return { outcome: 'APPLIED', status };
}

module.exports = { applyProviderResult };
