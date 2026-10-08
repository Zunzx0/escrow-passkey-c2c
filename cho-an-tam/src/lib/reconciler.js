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
// Ngoại lệ duy nhất: yêu cầu provider CHƯA TỪNG nhận (bước gửi hỏng). Worker gửi lại; gửi đủ
// TOPUP_SUBMIT_MAX_ATTEMPTS lần mà provider vẫn không có bản ghi thì đóng FAILED — không có khoản
// nào ở provider để người dùng thanh toán, nên giữ PENDING chỉ chiếm suất nạp tiền của họ mãi.
const { db, nowIso } = require('../db');
const provider = require('./mockPaymentProvider');
const { applyProviderResult, claimSubmission, submitToProvider, expireUnsubmitted, maxSubmitAttempts } = require('./paymentService');
const { logSecurityEvent, EVENTS } = require('./securityEvents');

const DEFAULT_MIN_AGE_SECONDS = parseInt(process.env.RECONCILE_MIN_AGE_SECONDS || '30', 10);

// Quét lại request PayPal ĐÃ đóng FAILED mà chưa từng POST capture (abandon của chủ ví), phòng capture
// muộn khi mất webhook. Hạn mức RIÊNG cộng thêm ngoài truy vấn PENDING nên không chiếm lượt của PENDING.
// Cận 72 giờ tính từ created_at: tài liệu PayPal nêu order CREATED chỉ giữ 3 giờ và gia hạn tối đa 72 giờ
// (adapter của ta không gia hạn). CHƯA kiểm chứng trên Sandbox.
function boundedEnvInt(name, fallback, max) {
  const n = Number(process.env[name]);
  return Number.isSafeInteger(n) && n > 0 ? Math.min(n, max) : fallback;
}
const abandonedWindowHours = () => boundedEnvInt('PAYPAL_ABANDONED_SCAN_WINDOW_HOURS', 72, 24 * 30);
const abandonedRescanSeconds = () => boundedEnvInt('PAYPAL_ABANDONED_RESCAN_SECONDS', 900, 7 * 24 * 3600);

async function markAttempt(id, paymentProvider='MOCK') {
  // Chỉ là vết vận hành: không tăng version, nên không bao giờ làm hỏng lượt tất toán đang chạy
  // song song ở webhook.
  await db.prepare(
    `UPDATE payment_requests SET reconcile_attempts = reconcile_attempts + 1, last_reconciled_at = ?
     WHERE id = ? AND provider = ? AND (status = 'PENDING' OR (provider = 'PAYPAL_SANDBOX' AND status = 'FAILED'))`
  ).run(nowIso(), id, paymentProvider);
}

async function recordError(id, message) {
  await db.prepare('UPDATE payment_requests SET last_reconcile_error = ? WHERE id = ?').run(String(message).slice(0, 300), id);
}

async function clearError(id) {
  await db.prepare('UPDATE payment_requests SET last_reconcile_error = NULL WHERE id = ? AND last_reconcile_error IS NOT NULL').run(id);
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
  paypalRuntime = null,
} = {}) {
  if(paypalRuntime && process.env.APP_ENV!=='test')throw Error('Worker runtime injection is test-only');
  const cutoff = new Date(Date.now() - minAgeSeconds * 1000).toISOString();
  const pending = paymentRequestId
    ? await db.prepare(`SELECT * FROM payment_requests WHERE id = ? AND provider = 'MOCK' AND status = 'PENDING' AND created_at <= ?`)
      .all(paymentRequestId, cutoff)
    : await db.prepare(
      `SELECT * FROM payment_requests WHERE provider = 'MOCK' AND status = 'PENDING' AND created_at <= ?
       ORDER BY created_at ASC LIMIT ?`
    ).all(cutoff, limit);

  const summary = {
    scanned: pending.length, applied: 0, duplicate: 0, conflict: 0, stillPending: 0, errors: 0,
    resubmitted: 0, expired: 0, skipped: 0, results: [],
  };

  /**
   * Yêu cầu mà provider chưa nhận (SUBMITTING / SUBMIT_FAILED, hoặc yêu cầu cũ provider báo không
   * biết): giành quyền gửi rồi gửi lại. Gửi được -> tiếp tục hỏi provider như thường (trả false).
   * Đã đủ số lần gửi và provider xác nhận không biết -> đóng FAILED. Trả về true nếu xử lý xong yêu
   * cầu trong lượt này; false nếu yêu cầu đã sẵn sàng để hỏi trạng thái.
   */
  async function handleUnsubmitted(pr, { recoverUnknown = false } = {}) {
    const claim = await claimSubmission(pr, { recoverUnknown });
    if (!claim) {
      // Tiến trình khác đã đổi trạng thái (đang gửi, hoặc vừa gửi xong) kể từ lúc đọc. Không chen vào —
      // lượt sau đọc lại và quyết định trên trạng thái mới.
      summary.skipped += 1;
      return true;
    }
    const sent = await submitToProvider(pr, claim);
    if (sent.submitted) {
      summary.resubmitted += 1;
      return false;
    }
    if (sent.busy) {
      summary.skipped += 1;
      return true;
    }
    const fresh = await db.prepare('SELECT * FROM payment_requests WHERE id = ?').get(pr.id);
    if (fresh.status === 'PENDING' && Number(fresh.submit_attempts) >= maxSubmitAttempts()) {
      try {
        const r = await expireUnsubmitted(fresh);
        if (r.outcome === 'EXPIRED') {
          summary.expired += 1;
          summary.results.push({ id: pr.id, outcome: 'EXPIRED', status: 'FAILED' });
          return true;
        }
        if (r.outcome === 'SUBMITTED') {
          summary.resubmitted += 1;
          return false;
        }
        summary.skipped += 1;
        return true;
      } catch (e) {
        await recordError(pr.id, `${e.code || 'EXPIRE_ERROR'}: ${e.message}`);
      }
    }
    summary.errors += 1;
    summary.results.push({ id: pr.id, outcome: 'SUBMIT_FAILED', error: sent.error && (sent.error.code || sent.error.message) });
    return true;
  }

  for (const pr of pending) {
    await markAttempt(pr.id);
    if (onQuery) onQuery(pr.id);

    if (pr.submission_status && pr.submission_status !== 'SUBMITTED') {
      if (await handleUnsubmitted(pr)) continue;
    }

    let answer;
    try {
      answer = await provider.queryStatus(pr.provider_ref);
    } catch (e) {
      if (e.code === 'UNKNOWN_PAYMENT') {
        // Provider không hề biết yêu cầu này (dữ liệu trước khi có submission_status, hoặc lần gửi
        // trước báo thành công nhầm): coi như chưa gửi và gửi lại qua đúng đường có quyền gửi —
        // thay vì ghi lỗi mãi mãi. Đây là đường phục hồi duy nhất được giành quyền trên yêu cầu
        // SUBMITTED, và chỉ khi trạng thái không đổi kể từ lúc đọc (xem claimSubmission).
        if (await handleUnsubmitted(pr, { recoverUnknown: true })) continue;
        try {
          answer = await provider.queryStatus(pr.provider_ref);
        } catch (e2) {
          await recordError(pr.id, `${e2.code || 'PROVIDER_ERROR'}: ${e2.message}`);
          summary.errors += 1;
          summary.results.push({ id: pr.id, outcome: 'PROVIDER_ERROR', error: e2.code || e2.message });
          continue;
        }
      } else {
        await recordError(pr.id, `${e.code || 'PROVIDER_ERROR'}: ${e.message}`);
        summary.errors += 1;
        summary.results.push({ id: pr.id, outcome: 'PROVIDER_ERROR', error: e.code || e.message });
        continue;
      }
    }
    await clearError(pr.id);

    if (answer.status === 'PENDING') {
      summary.stillPending += 1;
      summary.results.push({ id: pr.id, outcome: 'STILL_PENDING' });
      continue;
    }

    try {
      const result = await applyProviderResult({
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
        await logSecurityEvent(null, {
          type: EVENTS.RECONCILE_CONFLICT,
          outcome: 'DENIED',
          detail: { paymentRequestId: pr.id, reason: result.reason, source: 'RECONCILER' },
        });
      }
    } catch (e) {
      // Ví dụ: xung đột phiên bản ví với một thao tác khác. Giao dịch đã rollback toàn bộ, yêu
      // cầu vẫn PENDING — lượt sau thử lại.
      await recordError(pr.id, `${e.code || 'APPLY_ERROR'}: ${e.message}`);
      summary.errors += 1;
      summary.results.push({ id: pr.id, outcome: 'APPLY_ERROR', error: e.code || e.message });
    }
  }

  const paypal=paypalRuntime||require('./paypalRuntime').getRuntime();
  if (paypal.publicConfig().paypalSandbox.enabled) {
    const rows=paymentRequestId
      ? await db.prepare("SELECT id FROM payment_requests WHERE id=? AND provider='PAYPAL_SANDBOX' AND status IN ('PENDING','FAILED') AND created_at<=?").all(paymentRequestId,cutoff)
      : await db.prepare("SELECT pr.id FROM payment_requests pr JOIN paypal_payment_bindings b ON b.payment_request_id=pr.id WHERE pr.provider='PAYPAL_SANDBOX' AND b.order_id IS NOT NULL AND b.recovery_required_at IS NULL AND pr.created_at<=? AND (pr.status='PENDING' OR (pr.status='FAILED' AND b.capture_post_sent_at IS NOT NULL AND b.recovery_required_at IS NULL)) ORDER BY COALESCE(pr.last_reconciled_at,pr.created_at) ASC LIMIT ?").all(cutoff,limit);
    // Nhóm FAILED-chưa-POST: truy vấn thứ hai, chỉ ở lượt lô, tập rời với truy vấn trên (đã chặn trùng id).
    let abandoned=[];
    if(!paymentRequestId) {
      const nowMs=Date.now(),share=Math.max(1,Math.floor(limit/5));
      const seen=new Set(rows.map(r=>r.id));
      abandoned=(await db.prepare("SELECT pr.id FROM payment_requests pr JOIN paypal_payment_bindings b ON b.payment_request_id=pr.id WHERE pr.provider='PAYPAL_SANDBOX' AND pr.status='FAILED' AND b.order_id IS NOT NULL AND b.capture_post_sent_at IS NULL AND b.capture_state='READY' AND b.recovery_required_at IS NULL AND pr.created_at>? AND (pr.last_reconciled_at IS NULL OR pr.last_reconciled_at<=?) ORDER BY COALESCE(pr.last_reconciled_at,pr.created_at) ASC LIMIT ?")
        .all(new Date(nowMs-abandonedWindowHours()*3600*1000).toISOString(),new Date(nowMs-abandonedRescanSeconds()*1000).toISOString(),share))
        .filter(r=>!seen.has(r.id)).map(r=>({id:r.id,abandoned:true}));
    }
    summary.paypal={scanned:rows.length,applied:0,errors:0,recoveryRequired:0,abandonedScanned:abandoned.length};
    for(const row of [...rows,...abandoned]) {
      await markAttempt(row.id,'PAYPAL_SANDBOX');
      try {
        const result=await paypal.reconcileOne(row.id);
        if(result.outcome==='APPLIED')summary.paypal.applied++;
        if(result.outcome==='RECOVERY_REQUIRED')summary.paypal.recoveryRequired++;
        summary.results.push({id:row.id,provider:'PAYPAL_SANDBOX',...result});
        if(!row.abandoned)await clearError(row.id); // nhóm abandon: giữ USER_ABANDONED chỉ ở nhánh quét thành công (recordError khi lỗi có thể ghi đè); replay không dựa vào cột này
      } catch(error) {
        summary.paypal.errors++;
        // Never store upstream bodies/secrets in the operational error column.
        await recordError(row.id,error.code||'PAYPAL_RECONCILE_ERROR');
        summary.results.push({id:row.id,provider:'PAYPAL_SANDBOX',outcome:'ERROR',error:error.code||'PAYPAL_RECONCILE_ERROR'});
      }
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
      if (s.applied || s.conflict || s.errors || (s.paypal && (s.paypal.applied || s.paypal.errors || s.paypal.recoveryRequired))) {
        console.log(`[reconcile] quét ${s.scanned}, tất toán ${s.applied}, trùng ${s.duplicate}, mâu thuẫn ${s.conflict}, lỗi ${s.errors}; PayPal ${s.paypal?JSON.stringify(s.paypal):"tắt"}`);
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
