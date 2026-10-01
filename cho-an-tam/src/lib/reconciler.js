// Worker đối soát thanh toán (Payment Reconciliation).
//
// Vì sao cần, khi đã có webhook: webhook có thể thất lạc, tới trễ, hoặc tới lúc máy chủ đang
// tắt. Nếu hệ thống chỉ tin vào webhook thì một khoản đã thành công ở provider có thể nằm mãi
// ở PENDING — người dùng mất tiền trên giấy tờ. Worker định kỳ đi hỏi provider về các yêu cầu
// còn PENDING để tự phát hiện kết quả mà webhook không mang tới.
//
// Nguyên tắc cứng: worker KHÔNG tự đổi trạng thái hay cộng ví. Khi provider đã có kết quả cuối,
// worker gọi đúng lib/paymentService.js#applyProviderResult — cùng hàm mà webhook dùng. Nhờ vậy
// worker và webhook chạy đồng thời, hai worker chạy cùng lúc, hay một worker chạy lại nhiều lần
// đều chỉ tạo ra tối đa MỘT lần tất toán.
//
// Những gì worker KHÔNG làm, theo đúng thiết kế đã chốt:
//   - không coi "provider vẫn PENDING" hay "đã chờ quá lâu" là FAILED — yêu cầu cứ giữ PENDING;
//   - không coi "không hỏi được provider" là FAILED — lỗi được ghi lại, lần sau hỏi tiếp.
const { db, nowIso } = require('../db');
const provider = require('./mockPaymentProvider');
const { applyProviderResult } = require('./paymentService');
const { logSecurityEvent, EVENTS } = require('./securityEvents');

const DEFAULT_MIN_AGE_SECONDS = parseInt(process.env.RECONCILE_MIN_AGE_SECONDS || '30', 10);

function markAttempt(id) {
  // Chỉ là vết vận hành: không tăng version, nên không bao giờ làm hỏng lượt tất toán đang chạy
  // song song ở webhook.
  db.prepare(
    `UPDATE payment_requests SET reconcile_attempts = reconcile_attempts + 1, last_reconciled_at = ?
     WHERE id = ? AND status = 'PENDING'`
  ).run(nowIso(), id);
}

function recordError(id, message) {
  db.prepare('UPDATE payment_requests SET last_reconcile_error = ? WHERE id = ?').run(String(message).slice(0, 300), id);
}

function clearError(id) {
  db.prepare('UPDATE payment_requests SET last_reconcile_error = NULL WHERE id = ? AND last_reconcile_error IS NOT NULL').run(id);
}

/**
 * Chạy MỘT lượt đối soát.
 *
 * @param {object} [opts]
 * @param {number} [opts.minAgeSeconds]  chỉ đụng tới yêu cầu đã tạo lâu hơn ngưỡng này — cho
 *                                       webhook một khoảng thời gian để tới theo đường bình thường
 * @param {number} [opts.limit]          số yêu cầu tối đa trong một lượt
 * @param {string} [opts.paymentRequestId] chỉ đối soát đúng một yêu cầu (dùng khi kiểm thử)
 * @param {function} [opts.onQuery]      được gọi ngay trước khi hỏi provider (dùng khi kiểm thử)
 */
async function reconcileOnce({
  minAgeSeconds = DEFAULT_MIN_AGE_SECONDS,
  limit = 50,
  paymentRequestId = null,
  onQuery = null,
} = {}) {
  const cutoff = new Date(Date.now() - minAgeSeconds * 1000).toISOString();
  const pending = paymentRequestId
    ? db.prepare(`SELECT * FROM payment_requests WHERE id = ? AND status = 'PENDING' AND created_at <= ?`)
      .all(paymentRequestId, cutoff)
    : db.prepare(
      `SELECT * FROM payment_requests WHERE status = 'PENDING' AND created_at <= ?
       ORDER BY created_at ASC LIMIT ?`
    ).all(cutoff, limit);

  const summary = { scanned: pending.length, applied: 0, duplicate: 0, conflict: 0, stillPending: 0, errors: 0, results: [] };

  for (const pr of pending) {
    markAttempt(pr.id);
    if (onQuery) onQuery(pr.id);

    let answer;
    try {
      answer = await provider.queryStatus(pr.provider_ref);
    } catch (e) {
      recordError(pr.id, `${e.code || 'PROVIDER_ERROR'}: ${e.message}`);
      summary.errors += 1;
      summary.results.push({ id: pr.id, outcome: 'PROVIDER_ERROR', error: e.code || e.message });
      continue;
    }
    clearError(pr.id);

    if (answer.status === 'PENDING') {
      summary.stillPending += 1;
      summary.results.push({ id: pr.id, outcome: 'STILL_PENDING' });
      continue;
    }

    try {
      const result = applyProviderResult({
        paymentRequestId: pr.id,
        providerRef: pr.provider_ref,
        status: answer.status,
        amount: answer.amount,
        source: 'RECONCILER',
      });
      summary[result.outcome === 'APPLIED' ? 'applied' : result.outcome === 'DUPLICATE' ? 'duplicate' : 'conflict'] += 1;
      summary.results.push({ id: pr.id, outcome: result.outcome, status: result.status });

      if (result.outcome === 'CONFLICT') {
        // Provider và phía ta nói hai điều khác nhau về cùng một khoản tiền: phải để lại vết để
        // người vận hành đối chiếu tay. Tuyệt đối không tự ghi đè bên nào.
        logSecurityEvent(null, {
          type: EVENTS.RECONCILE_CONFLICT,
          outcome: 'DENIED',
          detail: { paymentRequestId: pr.id, reason: result.reason, source: 'RECONCILER' },
        });
      }
    } catch (e) {
      // Ví dụ: xung đột phiên bản ví với một thao tác khác. Giao dịch đã rollback toàn bộ, yêu
      // cầu vẫn PENDING — lượt sau thử lại.
      recordError(pr.id, `${e.code || 'APPLY_ERROR'}: ${e.message}`);
      summary.errors += 1;
      summary.results.push({ id: pr.id, outcome: 'APPLY_ERROR', error: e.code || e.message });
    }
  }

  return summary;
}

/**
 * Chạy worker định kỳ bên trong process máy chủ. Có chốt chặn để hai lượt không chồng lên
 * nhau trong cùng một process; chồng giữa các process khác nhau thì applyProviderResult đã lo.
 */
function startReconciler({ intervalSeconds, minAgeSeconds = DEFAULT_MIN_AGE_SECONDS }) {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const s = await reconcileOnce({ minAgeSeconds });
      if (s.applied || s.conflict || s.errors) {
        console.log(`[reconcile] quét ${s.scanned}, tất toán ${s.applied}, trùng ${s.duplicate}, mâu thuẫn ${s.conflict}, lỗi ${s.errors}`);
      }
    } catch (e) {
      console.error('[reconcile] lượt đối soát hỏng:', e.message);
    } finally {
      running = false;
    }
  }, intervalSeconds * 1000);
  timer.unref();
  return timer;
}

module.exports = { reconcileOnce, startReconciler, DEFAULT_MIN_AGE_SECONDS };
