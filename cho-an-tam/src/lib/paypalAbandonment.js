'use strict';

// Chủ ví chủ động BỎ một ý định nạp PayPal chưa gửi thu tiền (POST /api/payments/paypal/:id/abandon).
//
// Đây KHÔNG phải hoàn tiền và KHÔNG hủy order ở PayPal: chỉ đóng request cục bộ thành FAILED với lý do
// USER_ABANDONED. Không POST capture/void/refund, không chạm ví/sổ cái.
//
// Thứ tự chống race (không giữ transaction qua mạng):
//   1. đọc store, kiểm điều kiện sơ bộ (không gọi provider nếu đã không an toàn);
//   2. GET order fresh từ provider (ngoài transaction);
//   3. closeUncaptured: transaction ngắn, recheck atomic READY/chưa POST/không claim/PENDING và ghi audit
//      cùng transaction. claimCapture cũng kiểm status='PENDING' trong câu UPDATE giành claim, nên
//      close và capture chỉ một bên thắng.
const { AppError } = require('./errors');
const { EVENTS, buildSecurityEventInsert } = require('./securityEvents');

const REASON = 'USER_ABANDONED';
// PENDING chưa đủ: capture PENDING cũng được adapter chuẩn hoá thành PENDING, nên phải kèm !captureId và
// orderStatus thuộc nhóm "chưa thu".
const UNCAPTURED_ORDER_STATUS = new Set(['CREATED', 'SAVED', 'APPROVED', 'PAYER_ACTION_REQUIRED', 'VOIDED']);

const unsafe = () => new AppError(409, 'PAYPAL_ABANDON_UNSAFE', 'Yêu cầu này không thể bỏ an toàn; hãy giữ requestId và chờ đối soát');

function createAbandonment({ store, provider, db, serialize }) {
  const isAbandoned = async (id) => {
    // CHỈ hàng audit atomic là bằng chứng "do endpoint abandon đóng"; last_reconcile_error (có thể bị ghi đè
    // hoặc caller khác ghi trùng chuỗi) KHÔNG dùng để quyết định replay. detail do sanitize dựng ổn định, id
    // là id thật của request (đã qua owned()), truyền bằng tham số.
    const pr = await db.prepare('SELECT status FROM payment_requests WHERE id=?').get(id);
    if (!pr || pr.status !== 'FAILED') return false;
    const ev = await db.prepare('SELECT 1 AS x FROM security_events WHERE event_type = ? AND detail LIKE ?')
      .get(EVENTS.PAYPAL_REQUEST_ABANDONED, `%"paymentRequestId":"${id}"%`);
    return !!ev;
  };

  // req: request Express của chủ ví (actor/ip/route cho audit). row: request đã qua owned().
  async function abandon(row, { req, nowIso }) {
    const id = row.paymentRequestId;
    // Replay: có audit abandon VÀ binding mới nhất (đọc SAU truy vấn audit) chưa có bằng chứng thu tiền.
    const replay = async () => {
      if (!(await isAbandoned(id))) throw unsafe();
      const b = await store.loadByRequestId(id);
      if (!b || b.capture.state === 'RECOVERY_REQUIRED' || b.capture.state === 'VERIFIED' || b.capture.recoveryRequiredAt || b.capture.captureId ||
          /^(CONFLICTING_CAPTURE|CAPTURED_AFTER_REQUEST_CLOSED)/.test(b.capture.lastError || '')) throw unsafe();
      return done('ALREADY_ABANDONED');
    };
    const done = async (outcome) => ({ ...await serialize(id, { allowProviderLookup: false }), outcome });
    if (row.status === 'FAILED') return replay();
    const c = row.capture;
    if (row.status !== 'PENDING' || !row.orderId || c.state !== 'READY' || c.postSentAt !== null || c.claimedAt !== null) throw unsafe();

    const current = await provider.getOrder({ orderId: row.orderId, paymentRequestId: id, quote: row.quote });
    if (!current || current.orderId !== row.orderId || current.paymentRequestId !== id || current.amount !== row.amountVnd) {
      throw new AppError(409, 'PAYPAL_ORDER_MISMATCH', 'Bằng chứng PayPal không khớp yêu cầu');
    }
    if (current.status !== 'PENDING' || current.captureId || !UNCAPTURED_ORDER_STATUS.has(current.orderStatus)) throw unsafe();

    const audit = buildSecurityEventInsert(req, {
      type: EVENTS.PAYPAL_REQUEST_ABANDONED, outcome: 'ALLOWED', statusCode: 200, actorId: row.userId,
      detail: { action: 'ABANDON', reason: REASON, source: 'OWNER', paymentRequestId: id, amount: row.amountVnd },
    });
    const closed = await store.closeUncaptured(id, { nowIso, reason: REASON, audit, onlyNeverPosted: true, expectedOrderId: current.orderId });
    if (closed.closed) return done('ABANDONED');
    // Thua race: nếu một lượt abandon song song đã thắng thì coi là replay, còn lại thì không an toàn.
    return replay();
  }
  return { abandon };
}

module.exports = { createAbandonment, REASON };
