'use strict';

// Lưu trữ bền vững cho yêu cầu nạp tiền qua PayPal Sandbox (store của paypalSandboxService).
//
// Module độc lập: nhận `db` (API bất đồng bộ của lib/asyncDb.js) qua tham số, không require db.js,
// không đăng ký migration. Lược đồ đề xuất nằm ở proposedSchema() để root chép vào migration chính
// thức; bộ kiểm thử áp nó lên CSDL thử nghiệm riêng. Thiết kế đầy đủ: PAYPAL-STORE-DESIGN.md.
//
// Bốn nguyên tắc:
//  1. Dữ liệu tin cậy chỉ đọc từ CSDL. Báo giá, số tiền, merchant, provider, timestamp lần create đầu
//     và dấu "đã gửi POST capture" là bất biến — ứng dụng không có câu UPDATE nào xoá/đổi chúng, và
//     trigger chặn mọi đường khác.
//  2. Mọi chuyển trạng thái là UPDATE có điều kiện trên dữ liệu MỚI NHẤT; không tin snapshot của
//     người gọi. Quyền capture là lease có token: chỉ người giữ đúng token mới ghi được kết quả.
//  3. Một khi đã gửi POST capture, KHÔNG có đường nào quay về READY. Lease hết hạn, timeout, hay GET
//     order vẫn thấy APPROVED/PENDING đều KHÔNG chứng minh PayPal chưa thu tiền: một POST cũ có thể
//     hoàn tất sau lần GET. Chỉ bằng chứng mạnh (order VOIDED, capture DECLINED) mới kết thúc được ở
//     NOT_CAPTURED; còn lại giữ UNKNOWN chờ đối soát.
//  4. Không giữ transaction CSDL qua mạng. claimCapture/markCapturePostSent commit trước khi gọi
//     PayPal; finishCaptureAttempt/markCaptureVerified ghi kết quả SAU khi có câu trả lời.
//
// Store KHÔNG cộng ví, KHÔNG mở lại request đã FAILED. Ghi VERIFIED nên chạy trong cùng
// db.transaction() với hàm tất toán (transaction lồng nhau dùng savepoint), để credit, sổ cái, trạng
// thái request và capture ID cùng commit hoặc cùng rollback.

const PROVIDER = 'PAYPAL_SANDBOX';
const CAPTURE_STATES = ['READY', 'IN_FLIGHT', 'UNKNOWN', 'VERIFIED', 'NOT_CAPTURED', 'RECOVERY_REQUIRED'];
const FINISH_STATES = new Set(['READY', 'UNKNOWN', 'VERIFIED', 'NOT_CAPTURED']);
// Bằng chứng đủ mạnh để kết luận "PayPal không thu tiền và sẽ không thu" sau khi đã gửi POST.
// APPROVED, PENDING, CREATED, PAYER_ACTION_REQUIRED KHÔNG nằm trong danh sách.
// CAPTURE_DECLINED cũng KHÔNG (quyết định của Codex, 05/10/2026): một capture bị từ chối chưa chứng
// minh toàn bộ order và các lượt POST còn treo đã kết thúc. Chỉ order VOIDED — đã được adapter xác minh
// qua API chính thức — mới đủ mạnh.
const NOT_CAPTURED_EVIDENCE = ['ORDER_VOIDED'];

class PayPalStoreError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    // Hai tên trường: AppError của server dùng `status`, PayPalSandboxError dùng `statusCode`.
    this.status = status;
    this.statusCode = status;
  }
}

function fail(code, message, status = 409) {
  throw new PayPalStoreError(code, message, status);
}

const identifier = (v) => typeof v === 'string' && v.length > 0 && v.length <= 200;
const isoString = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v));

function toSafeInt(v) {
  const n = typeof v === 'string' ? Number(v) : v;
  return Number.isSafeInteger(n) ? n : NaN;
}

// ---------------------------------------------------------------------------------------
// Báo giá
// ---------------------------------------------------------------------------------------
// Cùng công thức với createQuote() của paypalSandboxProvider.js (số nguyên BigInt, làm tròn lên).
// Viết lại ở đây để store không phụ thuộc adapter; service vẫn tự validateQuote().
function checkQuote(quote) {
  if (!quote || typeof quote !== 'object') fail('PAYPAL_INVALID_QUOTE', 'A stored server quote is required', 400);
  const { version, amountVnd, currency, usdCents, usdValue, rateVndPerUsd } = quote;
  if (version !== 1 || currency !== 'USD' || !Number.isSafeInteger(amountVnd) || amountVnd <= 0 ||
      !Number.isSafeInteger(rateVndPerUsd) || rateVndPerUsd <= 0) {
    fail('PAYPAL_INVALID_QUOTE', 'Quote shape is invalid', 400);
  }
  const cents = (BigInt(amountVnd) * 100n + BigInt(rateVndPerUsd) - 1n) / BigInt(rateVndPerUsd);
  const value = `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
  if (cents > BigInt(Number.MAX_SAFE_INTEGER) || usdCents !== Number(cents) || usdValue !== value) {
    fail('PAYPAL_INVALID_QUOTE', 'Quote is inconsistent', 400);
  }
  return Object.freeze({ version, amountVnd, currency, usdCents, usdValue, rateVndPerUsd });
}

const canonicalQuote = (q) => JSON.stringify({
  version: q.version, amountVnd: q.amountVnd, currency: q.currency,
  usdCents: q.usdCents, usdValue: q.usdValue, rateVndPerUsd: q.rateVndPerUsd,
});

// ---------------------------------------------------------------------------------------
// Lược đồ đề xuất (root chép vào migration; store không tự áp)
// ---------------------------------------------------------------------------------------
const STATE_LIST = CAPTURE_STATES.map((s) => `'${s}'`).join(',');
const EVIDENCE_LIST = NOT_CAPTURED_EVIDENCE.map((s) => `'${s}'`).join(',');

function bindingColumns(intType) {
  return `
         payment_request_id TEXT PRIMARY KEY REFERENCES %PR%(id) ON DELETE CASCADE,
         provider TEXT NOT NULL DEFAULT 'PAYPAL_SANDBOX' CHECK (provider = 'PAYPAL_SANDBOX'),
         quote_json TEXT NOT NULL,
         amount_vnd ${intType} NOT NULL CHECK (amount_vnd > 0),
         currency TEXT NOT NULL CHECK (currency = 'USD'),
         usd_cents ${intType} NOT NULL CHECK (usd_cents > 0),
         rate_vnd_per_usd ${intType} NOT NULL CHECK (rate_vnd_per_usd > 0),
         merchant_id TEXT NOT NULL,
         order_id TEXT UNIQUE,
         order_bound_at TEXT,
         create_attempt_at TEXT,
         capture_state TEXT NOT NULL DEFAULT 'READY' CHECK (capture_state IN (${STATE_LIST})),
         capture_claim TEXT,
         capture_claimed_at TEXT,
         capture_attempts INTEGER NOT NULL DEFAULT 0,
         first_capture_at TEXT,
         capture_post_sent_at TEXT,
         capture_post_count INTEGER NOT NULL DEFAULT 0,
         capture_id TEXT UNIQUE,
         capture_verified_at TEXT,
         not_captured_evidence TEXT CHECK (not_captured_evidence IS NULL OR not_captured_evidence IN (${EVIDENCE_LIST})),
         recovery_required_at TEXT,
         last_capture_error TEXT,
         created_at TEXT NOT NULL,
         CHECK ((capture_state IN ('VERIFIED','RECOVERY_REQUIRED')) = (capture_id IS NOT NULL)),
         CHECK (capture_state <> 'IN_FLIGHT' OR capture_claim IS NOT NULL),
         CHECK (capture_state <> 'NOT_CAPTURED' OR not_captured_evidence IS NOT NULL),
         CHECK (capture_state <> 'RECOVERY_REQUIRED' OR recovery_required_at IS NOT NULL),
         CHECK (capture_state <> 'READY' OR capture_post_sent_at IS NULL),
         CHECK (capture_id IS NULL OR order_id IS NOT NULL)`;
}

// Cột provider + trigger bất biến: ĐÃ có trong migration v4 thật của Codex (provider isolation). Chỉ dùng
// cho fixture trên nền cũ chưa có v4; migration binding (v5) KHÔNG được ALTER provider lại.
function providerSchema(dialect) {
  if (dialect === 'sqlite') {
    return [
      `ALTER TABLE payment_requests ADD COLUMN provider TEXT NOT NULL DEFAULT 'MOCK'
         CHECK (provider IN ('MOCK','PAYPAL_SANDBOX'))`,
      `CREATE TRIGGER IF NOT EXISTS trg_payment_requests_provider_immutable
       BEFORE UPDATE OF provider ON payment_requests FOR EACH ROW WHEN NEW.provider IS NOT OLD.provider
       BEGIN SELECT RAISE(ABORT, 'PAYMENT_PROVIDER_IMMUTABLE'); END`,
    ];
  }
  if (dialect === 'pg') {
    return [
      `ALTER TABLE app.payment_requests ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'MOCK'
         CHECK (provider IN ('MOCK','PAYPAL_SANDBOX'))`,
      `CREATE OR REPLACE FUNCTION app.forbid_payment_provider_change() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.provider IS DISTINCT FROM OLD.provider THEN
           RAISE EXCEPTION 'PAYMENT_PROVIDER_IMMUTABLE' USING ERRCODE = '42501';
         END IF;
         RETURN NEW;
       END $$`,
      `DROP TRIGGER IF EXISTS trg_payment_requests_provider_immutable ON app.payment_requests`,
      `CREATE TRIGGER trg_payment_requests_provider_immutable BEFORE UPDATE OF provider ON app.payment_requests
       FOR EACH ROW EXECUTE FUNCTION app.forbid_payment_provider_change()`,
    ];
  }
  throw new TypeError(`Unsupported dialect: ${dialect}`);
}

// Bảng binding + trigger: nội dung của migration v5. Không đụng cột provider.
function bindingSchema(dialect) {
  if (dialect === 'sqlite') {
    return [
      `CREATE TABLE IF NOT EXISTS paypal_payment_bindings (${bindingColumns('INTEGER').replace('%PR%', 'payment_requests')}
       )`,
      `CREATE TRIGGER IF NOT EXISTS trg_paypal_binding_insert_guard
       BEFORE INSERT ON paypal_payment_bindings FOR EACH ROW WHEN NOT EXISTS (
         SELECT 1 FROM payment_requests pr
         WHERE pr.id = NEW.payment_request_id AND pr.provider = 'PAYPAL_SANDBOX' AND pr.amount = NEW.amount_vnd)
       BEGIN SELECT RAISE(ABORT, 'PAYPAL_BINDING_REQUEST_MISMATCH'); END`,
      `CREATE TRIGGER IF NOT EXISTS trg_paypal_binding_immutable
       BEFORE UPDATE ON paypal_payment_bindings FOR EACH ROW WHEN
            NEW.payment_request_id IS NOT OLD.payment_request_id OR NEW.provider IS NOT OLD.provider
         OR NEW.quote_json IS NOT OLD.quote_json OR NEW.amount_vnd IS NOT OLD.amount_vnd
         OR NEW.currency IS NOT OLD.currency OR NEW.usd_cents IS NOT OLD.usd_cents
         OR NEW.rate_vnd_per_usd IS NOT OLD.rate_vnd_per_usd OR NEW.merchant_id IS NOT OLD.merchant_id
         OR NEW.created_at IS NOT OLD.created_at
         OR (OLD.order_id IS NOT NULL AND NEW.order_id IS NOT OLD.order_id)
         OR (OLD.create_attempt_at IS NOT NULL AND NEW.create_attempt_at IS NOT OLD.create_attempt_at)
         OR (OLD.capture_post_sent_at IS NOT NULL AND NEW.capture_post_sent_at IS NOT OLD.capture_post_sent_at)
         OR (OLD.capture_id IS NOT NULL AND NEW.capture_id IS NOT OLD.capture_id)
         OR (OLD.capture_state IN ('VERIFIED','RECOVERY_REQUIRED') AND NEW.capture_state IS NOT OLD.capture_state)
         OR (OLD.capture_state = 'NOT_CAPTURED' AND NEW.capture_state NOT IN ('NOT_CAPTURED','VERIFIED','RECOVERY_REQUIRED'))
       BEGIN SELECT RAISE(ABORT, 'PAYPAL_BINDING_IMMUTABLE'); END`,
    ];
  }
  if (dialect === 'pg') {
    return [
      `CREATE TABLE IF NOT EXISTS app.paypal_payment_bindings (${bindingColumns('BIGINT').replace('%PR%', 'app.payment_requests')}
       )`,
      `CREATE OR REPLACE FUNCTION app.guard_paypal_binding() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF TG_OP = 'INSERT' THEN
           IF NOT EXISTS (SELECT 1 FROM app.payment_requests pr WHERE pr.id = NEW.payment_request_id
                          AND pr.provider = 'PAYPAL_SANDBOX' AND pr.amount = NEW.amount_vnd) THEN
             RAISE EXCEPTION 'PAYPAL_BINDING_REQUEST_MISMATCH' USING ERRCODE = '42501';
           END IF;
           RETURN NEW;
         END IF;
         IF NEW.payment_request_id IS DISTINCT FROM OLD.payment_request_id OR NEW.provider IS DISTINCT FROM OLD.provider
            OR NEW.quote_json IS DISTINCT FROM OLD.quote_json OR NEW.amount_vnd IS DISTINCT FROM OLD.amount_vnd
            OR NEW.currency IS DISTINCT FROM OLD.currency OR NEW.usd_cents IS DISTINCT FROM OLD.usd_cents
            OR NEW.rate_vnd_per_usd IS DISTINCT FROM OLD.rate_vnd_per_usd OR NEW.merchant_id IS DISTINCT FROM OLD.merchant_id
            OR NEW.created_at IS DISTINCT FROM OLD.created_at
            OR (OLD.order_id IS NOT NULL AND NEW.order_id IS DISTINCT FROM OLD.order_id)
            OR (OLD.create_attempt_at IS NOT NULL AND NEW.create_attempt_at IS DISTINCT FROM OLD.create_attempt_at)
            OR (OLD.capture_post_sent_at IS NOT NULL AND NEW.capture_post_sent_at IS DISTINCT FROM OLD.capture_post_sent_at)
            OR (OLD.capture_id IS NOT NULL AND NEW.capture_id IS DISTINCT FROM OLD.capture_id)
            OR (OLD.capture_state IN ('VERIFIED','RECOVERY_REQUIRED') AND NEW.capture_state IS DISTINCT FROM OLD.capture_state)
            OR (OLD.capture_state = 'NOT_CAPTURED' AND NEW.capture_state NOT IN ('NOT_CAPTURED','VERIFIED','RECOVERY_REQUIRED')) THEN
           RAISE EXCEPTION 'PAYPAL_BINDING_IMMUTABLE' USING ERRCODE = '42501';
         END IF;
         RETURN NEW;
       END $$`,
      `DROP TRIGGER IF EXISTS trg_paypal_binding_guard ON app.paypal_payment_bindings`,
      `CREATE TRIGGER trg_paypal_binding_guard BEFORE INSERT OR UPDATE ON app.paypal_payment_bindings
       FOR EACH ROW EXECUTE FUNCTION app.guard_paypal_binding()`,
    ];
  }
  throw new TypeError(`Unsupported dialect: ${dialect}`);
}

/** Toàn bộ lược đồ đề xuất (provider + binding) cho nền chưa có migration v4. */
function proposedSchema(dialect) {
  return [...providerSchema(dialect), ...bindingSchema(dialect)];
}

// ---------------------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------------------
const SELECT_JOINED = `
  SELECT pr.id AS pr_id, pr.user_id, pr.provider AS pr_provider, pr.provider_ref, pr.amount, pr.status,
         b.provider AS b_provider, b.quote_json, b.amount_vnd, b.currency, b.usd_cents, b.rate_vnd_per_usd,
         b.merchant_id, b.order_id, b.order_bound_at, b.create_attempt_at, b.capture_state, b.capture_claim,
         b.capture_claimed_at, b.capture_attempts, b.first_capture_at, b.capture_post_sent_at, b.capture_post_count,
         b.capture_id, b.capture_verified_at, b.not_captured_evidence, b.recovery_required_at, b.last_capture_error
  FROM payment_requests pr
  JOIN paypal_payment_bindings b ON b.payment_request_id = pr.id
  WHERE pr.provider = 'PAYPAL_SANDBOX'`;

function createPayPalPaymentStore({ db } = {}) {
  if (!db || typeof db.prepare !== 'function' || typeof db.transaction !== 'function') {
    throw new TypeError('An application database (lib/asyncDb.js API) is required');
  }

  /** Dựng dữ liệu tin cậy từ một dòng đã join; dữ liệu lệch nhau thì báo hỏng, không tự sửa. */
  function toTrusted(r) {
    if (!r) return null;
    let stored;
    try { stored = JSON.parse(r.quote_json); } catch (_) { fail('PAYPAL_BINDING_INCONSISTENT', 'Stored quote is unreadable'); }
    const quote = checkQuote(stored);
    const amountVnd = toSafeInt(r.amount);
    if (r.pr_provider !== PROVIDER || r.b_provider !== PROVIDER ||
        amountVnd !== toSafeInt(r.amount_vnd) || quote.amountVnd !== amountVnd ||
        quote.usdCents !== toSafeInt(r.usd_cents) || quote.rateVndPerUsd !== toSafeInt(r.rate_vnd_per_usd) ||
        quote.currency !== r.currency || canonicalQuote(quote) !== r.quote_json) {
      fail('PAYPAL_BINDING_INCONSISTENT', 'Stored PayPal binding does not match its payment request');
    }
    return {
      provider: PROVIDER,
      paymentRequestId: r.pr_id,
      userId: r.user_id,
      providerRef: r.provider_ref,
      amountVnd,
      quote,
      merchantId: r.merchant_id,
      status: r.status,
      orderId: r.order_id || null,
      orderBoundAt: r.order_bound_at || null,
      createAttemptAt: r.create_attempt_at || null,
      // Không bao giờ trả token claim ra ngoài store.
      capture: Object.freeze({
        state: r.capture_state,
        attempts: toSafeInt(r.capture_attempts),
        claimedAt: r.capture_claimed_at || null,
        firstAttemptAt: r.first_capture_at || null,
        postSentAt: r.capture_post_sent_at || null,
        postCount: toSafeInt(r.capture_post_count),
        captureId: r.capture_id || null,
        verifiedAt: r.capture_verified_at || null,
        notCapturedEvidence: r.not_captured_evidence || null,
        recoveryRequiredAt: r.recovery_required_at || null,
        lastError: r.last_capture_error || null,
      }),
    };
  }

  const rawById = (id) => db.prepare(`${SELECT_JOINED} AND pr.id = ?`).get(id);
  const nowIsoDefault = () => new Date().toISOString();

  async function loadByRequestId(paymentRequestId) {
    if (!identifier(paymentRequestId)) return null;
    return toTrusted(await rawById(paymentRequestId));
  }

  async function loadByOrderId(orderId) {
    if (!identifier(orderId)) return null;
    return toTrusted(await db.prepare(`${SELECT_JOINED} AND b.order_id = ?`).get(orderId));
  }

  /**
   * Ghi báo giá bất biến cho một payment_requests vừa INSERT với provider='PAYPAL_SANDBOX'.
   * PHẢI gọi trong CÙNG db.transaction() với lệnh INSERT request và phép kiểm ví/hạn mức/chống lặp.
   */
  async function createBinding({ paymentRequestId, quote, merchantId, nowIso }) {
    if (!identifier(paymentRequestId) || !identifier(merchantId) || !isoString(nowIso)) {
      fail('VALIDATION_ERROR', 'paymentRequestId, merchantId and nowIso are required', 400);
    }
    const q = checkQuote(quote);
    await db.prepare(
      `INSERT INTO paypal_payment_bindings
         (payment_request_id, provider, quote_json, amount_vnd, currency, usd_cents, rate_vnd_per_usd,
          merchant_id, capture_state, capture_attempts, capture_post_count, created_at)
       VALUES (?, 'PAYPAL_SANDBOX', ?, ?, ?, ?, ?, ?, 'READY', 0, 0, ?)`
    ).run(paymentRequestId, canonicalQuote(q), q.amountVnd, q.currency, q.usdCents, q.rateVndPerUsd, merchantId, nowIso);
    return loadByRequestId(paymentRequestId);
  }

  /** Ghi timestamp lần thử create ĐẦU TIÊN nếu đang null; không bao giờ làm mới. Trả liên kết mới nhất. */
  async function claimCreateAttempt(paymentRequestId, nowIso) {
    if (!identifier(paymentRequestId) || !isoString(nowIso)) {
      fail('VALIDATION_ERROR', 'paymentRequestId and nowIso are required', 400);
    }
    await db.prepare(
      `UPDATE paypal_payment_bindings SET create_attempt_at = ?
       WHERE payment_request_id = ? AND create_attempt_at IS NULL AND order_id IS NULL
         AND EXISTS (SELECT 1 FROM payment_requests pr WHERE pr.id = paypal_payment_bindings.payment_request_id
                     AND pr.provider = 'PAYPAL_SANDBOX')`
    ).run(nowIso, paymentRequestId);
    return loadByRequestId(paymentRequestId);
  }

  /** true: lần đầu gắn hoặc gắn lại ĐÚNG order. false: order khác, order thuộc request khác, không phải PayPal. */
  async function bindOrder(paymentRequestId, orderId, nowIso = nowIsoDefault()) {
    if (!identifier(paymentRequestId) || !identifier(orderId)) return false;
    let changed = 0;
    try {
      changed = await db.transaction(async () => (await db.prepare(
        `UPDATE paypal_payment_bindings SET order_id = ?, order_bound_at = ?
         WHERE payment_request_id = ? AND order_id IS NULL
           AND EXISTS (SELECT 1 FROM payment_requests pr WHERE pr.id = paypal_payment_bindings.payment_request_id
                       AND pr.provider = 'PAYPAL_SANDBOX')`
      ).run(orderId, nowIso, paymentRequestId)).changes)();
    } catch (e) {
      if (db.isUniqueViolation(e)) return false;
      throw e;
    }
    if (changed === 1) return true;
    const row = await db.prepare('SELECT order_id FROM paypal_payment_bindings WHERE payment_request_id = ?').get(paymentRequestId);
    return !!row && row.order_id === orderId;
  }

  /**
   * Giành quyền capture (lease). Kiểm provider, chủ sở hữu, request, order, trạng thái capture — trong
   * một transaction, trên dữ liệu mới nhất. outcome:
   *   CLAIMED            giành được. mustVerifyFirst=true khi ĐÃ từng gửi POST capture (capture_post_sent_at
   *                      có giá trị): không biết PayPal đã thu chưa, phải GET order trước, chỉ POST lại với
   *                      cùng PayPal-Request-Id.
   *   BUSY               người khác giữ quyền còn hạn.
   *   REPLAY             request SUCCEEDED: chỉ đọc lại.
   *   SETTLEMENT_REQUIRED capture VERIFIED nhưng request vẫn PENDING: ví CHƯA cộng; chạy settlement.
   *   RECOVERY_REQUIRED  PayPal đã thu tiền nhưng request đã FAILED: cần quy trình phục hồi, không capture.
   *   CLOSED             request FAILED.
   *   NOT_CAPTURED       đã có bằng chứng mạnh PayPal không thu và sẽ không thu: không capture nữa.
   *   NOT_READY          chưa gắn order.   FORBIDDEN  của người khác.   NOT_FOUND  không phải request PayPal.
   * userId=null là lời gọi tin cậy phía máy chủ (worker, webhook), bỏ qua kiểm chủ sở hữu.
   */
  async function claimCapture(paymentRequestId, userId, claimId, nowIso, leaseCutoffIso) {
    if (!identifier(claimId) || !isoString(nowIso) || !isoString(leaseCutoffIso)) {
      fail('VALIDATION_ERROR', 'claimId, nowIso and leaseCutoffIso are required', 400);
    }
    return db.transaction(async () => {
      const r = await rawById(paymentRequestId);
      if (!r) return { outcome: 'NOT_FOUND', row: null };
      const row = toTrusted(r);
      if (userId !== null && row.userId !== userId) return { outcome: 'FORBIDDEN', row: null };
      if (row.capture.state === 'RECOVERY_REQUIRED') return { outcome: 'RECOVERY_REQUIRED', row };
      if (row.status === 'SUCCEEDED') return { outcome: 'REPLAY', row };
      // Đã có bằng chứng thu tiền nhưng request CHƯA SUCCEEDED: ví chưa được cộng. Không trả REPLAY (dễ
      // bị hiểu là xong) — người gọi phải chạy settlement trong một transaction với bằng chứng này.
      if (row.capture.state === 'VERIFIED') return { outcome: 'SETTLEMENT_REQUIRED', row };
      if (row.status === 'FAILED') return { outcome: 'CLOSED', row };
      if (row.capture.state === 'NOT_CAPTURED') return { outcome: 'NOT_CAPTURED', row };
      if (!row.orderId) return { outcome: 'NOT_READY', row };
      if (r.capture_claim && r.capture_claimed_at >= leaseCutoffIso) return { outcome: 'BUSY', row };

      const previousState = r.capture_state;
      const upd = await db.prepare(
        `UPDATE paypal_payment_bindings
         SET capture_state = 'IN_FLIGHT', capture_claim = ?, capture_claimed_at = ?,
             capture_attempts = capture_attempts + 1, first_capture_at = COALESCE(first_capture_at, ?)
         WHERE payment_request_id = ? AND order_id IS NOT NULL AND capture_state IN ('READY','IN_FLIGHT','UNKNOWN')
           AND (capture_claim IS NULL OR capture_claimed_at < ?)`
      ).run(claimId, nowIso, nowIso, paymentRequestId, leaseCutoffIso);
      if (upd.changes !== 1) return { outcome: 'BUSY', row };
      const fresh = toTrusted(await rawById(paymentRequestId));
      return {
        outcome: 'CLAIMED',
        // Đã từng POST, hoặc người trước tự khai UNKNOWN: không biết PayPal đã thu chưa -> GET trước.
        mustVerifyFirst: fresh.capture.postSentAt !== null || previousState === 'UNKNOWN',
        previousState,
        row: fresh,
      };
    })();
  }

  /**
   * Người giữ quyền ghi dấu "sắp gửi POST capture" NGAY TRƯỚC khi gọi PayPal (commit trước lời gọi
   * mạng). Từ thời điểm này request không bao giờ quay về READY. Gọi lại ở mỗi lần POST (đếm số lần).
   * @returns {{ ok: true } | { ok: false, reason: 'STALE_CLAIM' }}
   */
  async function markCapturePostSent(paymentRequestId, claimId, nowIso = nowIsoDefault()) {
    if (!identifier(claimId) || !isoString(nowIso)) fail('VALIDATION_ERROR', 'claimId and nowIso are required', 400);
    const r = await db.prepare(
      `UPDATE paypal_payment_bindings
       SET capture_post_sent_at = COALESCE(capture_post_sent_at, ?), capture_post_count = capture_post_count + 1
       WHERE payment_request_id = ? AND capture_claim = ? AND capture_state = 'IN_FLIGHT'`
    ).run(nowIso, paymentRequestId, claimId);
    return r.changes === 1 ? { ok: true } : { ok: false, reason: 'STALE_CLAIM' };
  }

  /** Ghi bằng chứng thu tiền trên request đã FAILED: không mở lại, không ghi ví, giữ capture ID. */
  async function persistRecovery(paymentRequestId, captureId, nowIso) {
    await db.prepare(
      `UPDATE paypal_payment_bindings
       SET capture_state = 'RECOVERY_REQUIRED', capture_id = ?, recovery_required_at = ?,
           capture_claim = NULL, capture_claimed_at = NULL,
           last_capture_error = 'CAPTURED_AFTER_REQUEST_CLOSED'
       WHERE payment_request_id = ? AND capture_id IS NULL AND capture_state NOT IN ('VERIFIED','RECOVERY_REQUIRED')`
    ).run(captureId, nowIso, paymentRequestId);
    return { ok: false, outcome: 'RECOVERY_REQUIRED', reason: 'RECOVERY_REQUIRED', captureId };
  }

  async function recordConflict(paymentRequestId, captureId) {
    await db.prepare('UPDATE paypal_payment_bindings SET last_capture_error = ? WHERE payment_request_id = ?')
      .run(`CONFLICTING_CAPTURE:${String(captureId).slice(0, 150)}`, paymentRequestId);
  }

  /**
   * Ghi kết quả một lượt capture và nhả quyền — CHỈ khi còn giữ đúng token.
   *   READY         CHỈ khi chưa từng gửi POST capture (ví dụ GET trước khi POST thấy chưa phê duyệt).
   *                 Đã gửi POST -> { ok:false, reason:'CAPTURE_OUTCOME_UNRESOLVED' }, quyền vẫn giữ; người
   *                 gọi phải ghi UNKNOWN, VERIFIED hoặc NOT_CAPTURED.
   *   UNKNOWN       timeout/không rõ; request giữ PENDING, chờ đối soát.
   *   NOT_CAPTURED  bằng chứng mạnh: evidence ∈ ORDER_VOIDED | CAPTURE_DECLINED.
   *   VERIFIED      PayPal xác nhận đã thu (captureId bắt buộc). Request đã FAILED -> RECOVERY_REQUIRED (bằng
   *                 chứng được commit, KHÔNG ghi ví): người gọi KHÔNG được rollback lời gọi này.
   * @returns {{ ok: true } | { ok: false, reason: 'STALE_CLAIM'|'CAPTURE_OUTCOME_UNRESOLVED'|'CAPTURE_ID_CONFLICT'|'RECOVERY_REQUIRED' }}
   */
  async function finishCaptureAttempt(paymentRequestId, claimId, { state, captureId = null, errorCode = null, evidence = null } = {}) {
    if (!FINISH_STATES.has(state)) fail('VALIDATION_ERROR', `Unsupported capture result state: ${state}`, 400);
    if (state === 'VERIFIED' && !identifier(captureId)) fail('VALIDATION_ERROR', 'captureId is required for VERIFIED', 400);
    if (state !== 'VERIFIED' && captureId !== null) fail('VALIDATION_ERROR', 'captureId is only recorded with VERIFIED', 400);
    if (state === 'NOT_CAPTURED' && !NOT_CAPTURED_EVIDENCE.includes(evidence)) {
      fail('VALIDATION_ERROR', `NOT_CAPTURED requires strong evidence (${NOT_CAPTURED_EVIDENCE.join('|')})`, 400);
    }
    if (state !== 'NOT_CAPTURED' && evidence !== null) fail('VALIDATION_ERROR', 'evidence is only recorded with NOT_CAPTURED', 400);
    const now = nowIsoDefault();
    const err = errorCode ? String(errorCode).slice(0, 200) : null;
    try {
      return await db.transaction(async () => {
        const r = await rawById(paymentRequestId);
        if (!r || r.capture_claim !== claimId || r.capture_state !== 'IN_FLIGHT') return { ok: false, reason: 'STALE_CLAIM' };
        if (state === 'READY' && r.capture_post_sent_at) return { ok: false, reason: 'CAPTURE_OUTCOME_UNRESOLVED' };
        if (state === 'VERIFIED' && r.status === 'FAILED') return persistRecovery(paymentRequestId, captureId, now);
        const changed = (await db.prepare(
          `UPDATE paypal_payment_bindings
           SET capture_state = ?, capture_id = COALESCE(?, capture_id),
               capture_verified_at = CASE WHEN ? = 'VERIFIED' THEN ? ELSE capture_verified_at END,
               not_captured_evidence = COALESCE(?, not_captured_evidence),
               last_capture_error = ?, capture_claim = NULL, capture_claimed_at = NULL
           WHERE payment_request_id = ? AND capture_claim = ? AND capture_state = 'IN_FLIGHT'`
        ).run(state, captureId, state, now, evidence, err, paymentRequestId, claimId)).changes;
        return changed === 1 ? { ok: true } : { ok: false, reason: 'STALE_CLAIM' };
      })();
    } catch (e) {
      if (db.isUniqueViolation(e)) return { ok: false, reason: 'CAPTURE_ID_CONFLICT' };
      throw e;
    }
  }

  /**
   * Ghi nhận capture đã được PayPal xác minh qua kênh KHÔNG giữ quyền (webhook, worker GET, hoặc người
   * giữ quyền cũ có POST hoàn tất muộn sau khi nhận STALE_CLAIM). Không cần token; xoá mọi claim.
   *   { ok:true }                                  VERIFIED (lần đầu hoặc replay cùng capture ID).
   *   { ok:false, outcome:'RECOVERY_REQUIRED' }     request đã FAILED: bằng chứng được lưu, cần phục hồi.
   *   { ok:false, reason:'CAPTURE_ID_CONFLICT' }    khác capture ID đã lưu (hoặc ID đã thuộc request khác);
   *                                                 bằng chứng cũ giữ nguyên, ID mới ghi vào last_capture_error.
   *   { ok:false, reason:'NOT_READY'|'NOT_FOUND' }
   */
  async function markCaptureVerified(paymentRequestId, captureId) {
    if (!identifier(captureId)) fail('VALIDATION_ERROR', 'captureId is required', 400);
    const now = nowIsoDefault();
    let result;
    try {
      result = await db.transaction(async () => {
        const r = await rawById(paymentRequestId);
        if (!r) return { ok: false, reason: 'NOT_FOUND' };
        if (!r.order_id) return { ok: false, reason: 'NOT_READY' };
        if (r.capture_id && r.capture_id !== captureId) return { ok: false, reason: 'CAPTURE_ID_CONFLICT', conflict: true };
        if (r.capture_state === 'RECOVERY_REQUIRED') return { ok: false, outcome: 'RECOVERY_REQUIRED', reason: 'RECOVERY_REQUIRED', captureId };
        if (r.capture_state === 'VERIFIED') return { ok: true };
        if (r.status === 'FAILED') return persistRecovery(paymentRequestId, captureId, now);
        const changed = (await db.prepare(
          `UPDATE paypal_payment_bindings
           SET capture_state = 'VERIFIED', capture_id = ?, capture_verified_at = ?,
               capture_claim = NULL, capture_claimed_at = NULL
           WHERE payment_request_id = ? AND capture_id IS NULL AND capture_state NOT IN ('VERIFIED','RECOVERY_REQUIRED')`
        ).run(captureId, now, paymentRequestId)).changes;
        return changed === 1 ? { ok: true } : { ok: false, reason: 'CAPTURE_ID_CONFLICT', conflict: true };
      })();
    } catch (e) {
      if (!db.isUniqueViolation(e)) throw e;
      result = { ok: false, reason: 'CAPTURE_ID_CONFLICT', conflict: true };
    }
    if (result.conflict) {
      await recordConflict(paymentRequestId, captureId);
      delete result.conflict;
    }
    return result;
  }

  /**
   * Đóng FAILED một request PayPal CHỈ khi chắc chắn không có tiền nào đã/sẽ bị thu:
   *   - chưa từng gửi POST capture (READY, capture_post_sent_at null) và không ai giữ quyền; hoặc
   *   - đã có bằng chứng mạnh NOT_CAPTURED.
   * IN_FLIGHT (kể cả lease hết hạn), UNKNOWN, VERIFIED, RECOVERY_REQUIRED -> từ chối (cần đối soát).
   * Kiểm và cập nhật trong cùng transaction tuần tự với claimCapture. Root vẫn phải GET order trước.
   * @returns {{ closed: boolean, reason?: string }}
   */
  async function closeUncaptured(paymentRequestId, { nowIso, reason }) {
    if (!isoString(nowIso) || !identifier(reason)) fail('VALIDATION_ERROR', 'nowIso and reason are required', 400);
    return db.transaction(async () => {
      const r = await rawById(paymentRequestId);
      if (!r) return { closed: false, reason: 'NOT_FOUND' };
      if (r.status !== 'PENDING') return { closed: false, reason: `STATUS_${r.status}` };
      const neverPosted = r.capture_state === 'READY' && !r.capture_post_sent_at && !r.capture_claim;
      if (!neverPosted && r.capture_state !== 'NOT_CAPTURED') return { closed: false, reason: `CAPTURE_${r.capture_state}` };
      const upd = await db.prepare(
        `UPDATE payment_requests
         SET status = 'FAILED', version = version + 1, resolved_at = ?, resolved_by = 'RECONCILER',
             last_reconcile_error = ?, updated_at = ?
         WHERE id = ? AND status = 'PENDING' AND provider = 'PAYPAL_SANDBOX'
           AND EXISTS (SELECT 1 FROM paypal_payment_bindings b WHERE b.payment_request_id = payment_requests.id
                       AND ((b.capture_state = 'READY' AND b.capture_post_sent_at IS NULL AND b.capture_claim IS NULL)
                            OR b.capture_state = 'NOT_CAPTURED'))`
      ).run(nowIso, String(reason).slice(0, 200), nowIso, paymentRequestId);
      return upd.changes === 1 ? { closed: true } : { closed: false, reason: 'RACE_LOST' };
    })();
  }

  return Object.freeze({
    loadByRequestId,
    loadByOrderId,
    createBinding,
    claimCreateAttempt,
    bindOrder,
    claimCapture,
    markCapturePostSent,
    finishCaptureAttempt,
    markCaptureVerified,
    closeUncaptured,
  });
}

module.exports = {
  createPayPalPaymentStore,
  proposedSchema,
  providerSchema,
  bindingSchema,
  PayPalStoreError,
  CAPTURE_STATES,
  NOT_CAPTURED_EVIDENCE,
  PROVIDER,
};
