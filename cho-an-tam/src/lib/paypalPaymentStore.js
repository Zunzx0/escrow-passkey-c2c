'use strict';

// Lưu trữ bền vững cho yêu cầu nạp tiền qua PayPal Sandbox (store của paypalSandboxService).
//
// Module độc lập: nhận `db` (API bất đồng bộ của lib/asyncDb.js) qua tham số, không require db.js,
// không đăng ký migration. Lược đồ đề xuất nằm ở proposedSchema() để root chép vào migration chính
// thức; bộ kiểm thử áp nó lên CSDL thử nghiệm riêng. Thiết kế đầy đủ: PAYPAL-STORE-DESIGN.md.
//
// Ba nguyên tắc:
//  1. Dữ liệu tin cậy chỉ đọc từ CSDL. Báo giá, số tiền, merchant, provider và timestamp lần create
//     đầu là bất biến — ứng dụng không có câu UPDATE nào chạm tới chúng, và trigger chặn mọi đường
//     khác.
//  2. Mọi chuyển trạng thái là UPDATE có điều kiện trên dữ liệu MỚI NHẤT; không tin snapshot của
//     người gọi. Quyền capture là lease có token: chỉ người giữ đúng token mới ghi được kết quả.
//  3. Không giữ transaction CSDL qua mạng. claimCapture commit trước khi gọi PayPal;
//     finishCaptureAttempt/markCaptureVerified ghi kết quả SAU khi có câu trả lời.
//
// Store KHÔNG cộng ví. Ghi VERIFIED nên chạy trong cùng db.transaction() với hàm tất toán
// (transaction lồng nhau dùng savepoint), để credit, sổ cái, trạng thái request và capture ID cùng
// commit hoặc cùng rollback.

const PROVIDER = 'PAYPAL_SANDBOX';
const CAPTURE_STATES = ['READY', 'IN_FLIGHT', 'UNKNOWN', 'VERIFIED'];
const FINISH_STATES = new Set(['READY', 'UNKNOWN', 'VERIFIED']);

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
// Viết lại ở đây để store không phụ thuộc nhánh adapter chưa gộp; service vẫn tự validateQuote().
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
  // Thứ tự khoá cố định: chuỗi JSON lưu trữ là một hàm của nội dung, không của cách client gửi.
  return Object.freeze({ version, amountVnd, currency, usdCents, usdValue, rateVndPerUsd });
}

const canonicalQuote = (q) => JSON.stringify({
  version: q.version, amountVnd: q.amountVnd, currency: q.currency,
  usdCents: q.usdCents, usdValue: q.usdValue, rateVndPerUsd: q.rateVndPerUsd,
});

// ---------------------------------------------------------------------------------------
// Lược đồ đề xuất (root chép vào migration; store không tự áp)
// ---------------------------------------------------------------------------------------
function proposedSchema(dialect) {
  if (dialect === 'sqlite') {
    return [
      `ALTER TABLE payment_requests ADD COLUMN provider TEXT NOT NULL DEFAULT 'MOCK'
         CHECK (provider IN ('MOCK','PAYPAL_SANDBOX'))`,
      `CREATE TABLE IF NOT EXISTS paypal_payment_bindings (
         payment_request_id TEXT PRIMARY KEY REFERENCES payment_requests(id) ON DELETE CASCADE,
         provider TEXT NOT NULL DEFAULT 'PAYPAL_SANDBOX' CHECK (provider = 'PAYPAL_SANDBOX'),
         quote_json TEXT NOT NULL,
         amount_vnd INTEGER NOT NULL CHECK (amount_vnd > 0),
         currency TEXT NOT NULL CHECK (currency = 'USD'),
         usd_cents INTEGER NOT NULL CHECK (usd_cents > 0),
         rate_vnd_per_usd INTEGER NOT NULL CHECK (rate_vnd_per_usd > 0),
         merchant_id TEXT NOT NULL,
         order_id TEXT UNIQUE,
         order_bound_at TEXT,
         create_attempt_at TEXT,
         capture_state TEXT NOT NULL DEFAULT 'READY'
           CHECK (capture_state IN ('READY','IN_FLIGHT','UNKNOWN','VERIFIED')),
         capture_claim TEXT,
         capture_claimed_at TEXT,
         capture_attempts INTEGER NOT NULL DEFAULT 0,
         first_capture_at TEXT,
         capture_id TEXT UNIQUE,
         capture_verified_at TEXT,
         last_capture_error TEXT,
         created_at TEXT NOT NULL,
         CHECK (capture_state <> 'VERIFIED' OR capture_id IS NOT NULL),
         CHECK (capture_state <> 'IN_FLIGHT' OR capture_claim IS NOT NULL),
         CHECK (capture_id IS NULL OR order_id IS NOT NULL)
       )`,
      `CREATE TRIGGER IF NOT EXISTS trg_payment_requests_provider_immutable
       BEFORE UPDATE OF provider ON payment_requests FOR EACH ROW WHEN NEW.provider IS NOT OLD.provider
       BEGIN SELECT RAISE(ABORT, 'PAYMENT_PROVIDER_IMMUTABLE'); END`,
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
         OR (OLD.capture_id IS NOT NULL AND NEW.capture_id IS NOT OLD.capture_id)
         OR (OLD.capture_state = 'VERIFIED' AND NEW.capture_state <> 'VERIFIED')
       BEGIN SELECT RAISE(ABORT, 'PAYPAL_BINDING_IMMUTABLE'); END`,
    ];
  }
  if (dialect === 'pg') {
    return [
      `ALTER TABLE app.payment_requests ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'MOCK'
         CHECK (provider IN ('MOCK','PAYPAL_SANDBOX'))`,
      `CREATE TABLE IF NOT EXISTS app.paypal_payment_bindings (
         payment_request_id TEXT PRIMARY KEY REFERENCES app.payment_requests(id) ON DELETE CASCADE,
         provider TEXT NOT NULL DEFAULT 'PAYPAL_SANDBOX' CHECK (provider = 'PAYPAL_SANDBOX'),
         quote_json TEXT NOT NULL,
         amount_vnd BIGINT NOT NULL CHECK (amount_vnd > 0),
         currency TEXT NOT NULL CHECK (currency = 'USD'),
         usd_cents BIGINT NOT NULL CHECK (usd_cents > 0),
         rate_vnd_per_usd BIGINT NOT NULL CHECK (rate_vnd_per_usd > 0),
         merchant_id TEXT NOT NULL,
         order_id TEXT UNIQUE,
         order_bound_at TEXT,
         create_attempt_at TEXT,
         capture_state TEXT NOT NULL DEFAULT 'READY'
           CHECK (capture_state IN ('READY','IN_FLIGHT','UNKNOWN','VERIFIED')),
         capture_claim TEXT,
         capture_claimed_at TEXT,
         capture_attempts INTEGER NOT NULL DEFAULT 0,
         first_capture_at TEXT,
         capture_id TEXT UNIQUE,
         capture_verified_at TEXT,
         last_capture_error TEXT,
         created_at TEXT NOT NULL,
         CHECK (capture_state <> 'VERIFIED' OR capture_id IS NOT NULL),
         CHECK (capture_state <> 'IN_FLIGHT' OR capture_claim IS NOT NULL),
         CHECK (capture_id IS NULL OR order_id IS NOT NULL)
       )`,
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
            OR (OLD.capture_id IS NOT NULL AND NEW.capture_id IS DISTINCT FROM OLD.capture_id)
            OR (OLD.capture_state = 'VERIFIED' AND NEW.capture_state <> 'VERIFIED') THEN
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

// ---------------------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------------------
const SELECT_JOINED = `
  SELECT pr.id AS pr_id, pr.user_id, pr.provider AS pr_provider, pr.provider_ref, pr.amount, pr.status,
         b.provider AS b_provider, b.quote_json, b.amount_vnd, b.currency, b.usd_cents, b.rate_vnd_per_usd,
         b.merchant_id, b.order_id, b.order_bound_at, b.create_attempt_at, b.capture_state, b.capture_claim,
         b.capture_claimed_at, b.capture_attempts, b.first_capture_at, b.capture_id, b.capture_verified_at,
         b.last_capture_error
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
        captureId: r.capture_id || null,
        verifiedAt: r.capture_verified_at || null,
        lastError: r.last_capture_error || null,
      }),
    };
  }

  const rawById = (id) => db.prepare(`${SELECT_JOINED} AND pr.id = ?`).get(id);

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
   * PHẢI gọi trong CÙNG db.transaction() với lệnh INSERT request và phép kiểm ví/hạn mức/chống lặp,
   * để không bao giờ tồn tại request PayPal thiếu báo giá. Trigger kiểm request đúng provider và
   * đúng số tiền.
   */
  async function createBinding({ paymentRequestId, quote, merchantId, nowIso }) {
    if (!identifier(paymentRequestId) || !identifier(merchantId) || !isoString(nowIso)) {
      fail('VALIDATION_ERROR', 'paymentRequestId, merchantId and nowIso are required', 400);
    }
    const q = checkQuote(quote);
    await db.prepare(
      `INSERT INTO paypal_payment_bindings
         (payment_request_id, provider, quote_json, amount_vnd, currency, usd_cents, rate_vnd_per_usd,
          merchant_id, capture_state, capture_attempts, created_at)
       VALUES (?, 'PAYPAL_SANDBOX', ?, ?, ?, ?, ?, ?, 'READY', 0, ?)`
    ).run(paymentRequestId, canonicalQuote(q), q.amountVnd, q.currency, q.usdCents, q.rateVndPerUsd, merchantId, nowIso);
    return loadByRequestId(paymentRequestId);
  }

  /**
   * Ghi timestamp lần thử create ĐẦU TIÊN nếu đang null; không bao giờ làm mới khi retry (kể cả qua
   * restart: giá trị nằm trong CSDL, trigger chặn mọi lệnh đổi giá trị đã có). Trả liên kết mới nhất.
   */
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

  /**
   * Gắn order PayPal. true: lần đầu gắn thành công, hoặc đã gắn ĐÚNG order này (replay idempotent).
   * false: đã gắn order khác, order đã thuộc request khác (UNIQUE), hoặc request không phải PayPal.
   */
  async function bindOrder(paymentRequestId, orderId, nowIso = new Date().toISOString()) {
    if (!identifier(paymentRequestId) || !identifier(orderId)) return false;
    let changed = 0;
    try {
      // Savepoint: vi phạm UNIQUE không làm hỏng giao dịch bao ngoài (nếu người gọi đang trong một).
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
   * Giành quyền capture (lease). Kiểm provider, chủ sở hữu, request PENDING, đã gắn order — trong một
   * transaction, trên dữ liệu mới nhất. Trả về:
   *   CLAIMED    giành được. mustVerifyFirst=true nếu trạng thái trước là IN_FLIGHT (lease cũ hết hạn)
   *              hoặc UNKNOWN: KHÔNG biết PayPal đã thu tiền chưa, người gọi phải GET order trước rồi
   *              mới quyết định POST capture (cùng PayPal-Request-Id).
   *   BUSY       tiến trình khác đang giữ quyền còn hạn.
   *   REPLAY     request đã SUCCEEDED hoặc capture đã VERIFIED: chỉ đọc lại, không capture nữa.
   *   CLOSED     request đã FAILED.
   *   NOT_READY  chưa gắn order.
   *   FORBIDDEN  request thuộc người khác.
   *   NOT_FOUND  không có hoặc không phải request PayPal.
   * userId=null là lời gọi tin cậy phía máy chủ (worker đối soát), bỏ qua kiểm chủ sở hữu.
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
      if (row.status === 'SUCCEEDED' || row.capture.state === 'VERIFIED') return { outcome: 'REPLAY', row };
      if (row.status === 'FAILED') return { outcome: 'CLOSED', row };
      if (!row.orderId) return { outcome: 'NOT_READY', row };
      if (r.capture_claim && r.capture_claimed_at >= leaseCutoffIso) return { outcome: 'BUSY', row };

      const previousState = r.capture_state;
      const upd = await db.prepare(
        `UPDATE paypal_payment_bindings
         SET capture_state = 'IN_FLIGHT', capture_claim = ?, capture_claimed_at = ?,
             capture_attempts = capture_attempts + 1, first_capture_at = COALESCE(first_capture_at, ?)
         WHERE payment_request_id = ? AND order_id IS NOT NULL AND capture_state <> 'VERIFIED'
           AND (capture_claim IS NULL OR capture_claimed_at < ?)`
      ).run(claimId, nowIso, nowIso, paymentRequestId, leaseCutoffIso);
      if (upd.changes !== 1) return { outcome: 'BUSY', row };
      return {
        outcome: 'CLAIMED',
        mustVerifyFirst: previousState === 'IN_FLIGHT' || previousState === 'UNKNOWN',
        previousState,
        row: toTrusted(await rawById(paymentRequestId)),
      };
    })();
  }

  /**
   * Ghi kết quả một lượt capture và nhả quyền — CHỈ khi còn giữ đúng token. Người giữ cũ (lease đã
   * hết hạn và bị giành) nhận STALE_CLAIM và không ghi đè gì.
   *   READY     PayPal xác nhận CHƯA thu tiền (ví dụ người mua chưa phê duyệt): có thể thử lại sau.
   *   UNKNOWN   timeout/không rõ: request giữ PENDING; lượt sau phải GET trước (mustVerifyFirst).
   *   VERIFIED  PayPal xác nhận đã thu (captureId bắt buộc). Nên gọi trong cùng transaction với hàm
   *             tất toán ghi ví.
   * @returns {{ ok: true } | { ok: false, reason: 'STALE_CLAIM'|'CAPTURE_ID_CONFLICT' }}
   */
  async function finishCaptureAttempt(paymentRequestId, claimId, { state, captureId = null, errorCode = null } = {}) {
    if (!FINISH_STATES.has(state)) fail('VALIDATION_ERROR', `Unsupported capture result state: ${state}`, 400);
    if (state === 'VERIFIED' && !identifier(captureId)) fail('VALIDATION_ERROR', 'captureId is required for VERIFIED', 400);
    if (state !== 'VERIFIED' && captureId !== null) fail('VALIDATION_ERROR', 'captureId is only recorded with VERIFIED', 400);
    const now = new Date().toISOString();
    try {
      const changed = await db.transaction(async () => (await db.prepare(
        `UPDATE paypal_payment_bindings
         SET capture_state = ?, capture_id = COALESCE(?, capture_id),
             capture_verified_at = CASE WHEN ? = 'VERIFIED' THEN ? ELSE capture_verified_at END,
             last_capture_error = ?, capture_claim = NULL, capture_claimed_at = NULL
         WHERE payment_request_id = ? AND capture_claim = ? AND capture_state = 'IN_FLIGHT'`
      ).run(state, captureId, state, now, errorCode ? String(errorCode).slice(0, 200) : null, paymentRequestId, claimId)).changes)();
      return changed === 1 ? { ok: true } : { ok: false, reason: 'STALE_CLAIM' };
    } catch (e) {
      if (db.isUniqueViolation(e)) return { ok: false, reason: 'CAPTURE_ID_CONFLICT' };
      throw e;
    }
  }

  /**
   * Ghi nhận capture đã được PayPal xác minh qua kênh KHÔNG giữ quyền (webhook, worker GET). Ghi
   * VERIFIED và xoá mọi claim đang có — người giữ quyền cũ sau đó nhận STALE_CLAIM. Idempotent với
   * cùng captureId; captureId khác với giá trị đã lưu -> CAPTURE_ID_CONFLICT.
   */
  async function markCaptureVerified(paymentRequestId, captureId) {
    if (!identifier(captureId)) fail('VALIDATION_ERROR', 'captureId is required', 400);
    const now = new Date().toISOString();
    try {
      const changed = await db.transaction(async () => (await db.prepare(
        `UPDATE paypal_payment_bindings
         SET capture_state = 'VERIFIED', capture_id = ?, capture_verified_at = COALESCE(capture_verified_at, ?),
             capture_claim = NULL, capture_claimed_at = NULL
         WHERE payment_request_id = ? AND order_id IS NOT NULL AND (capture_id IS NULL OR capture_id = ?)`
      ).run(captureId, now, paymentRequestId, captureId)).changes)();
      if (changed === 1) return { ok: true };
      const row = await db.prepare('SELECT capture_id, order_id FROM paypal_payment_bindings WHERE payment_request_id = ?').get(paymentRequestId);
      if (!row || !row.order_id) return { ok: false, reason: 'NOT_READY' };
      return { ok: false, reason: 'CAPTURE_ID_CONFLICT' };
    } catch (e) {
      if (db.isUniqueViolation(e)) return { ok: false, reason: 'CAPTURE_ID_CONFLICT' };
      throw e;
    }
  }

  /**
   * Đóng FAILED một request PayPal CHỈ khi chắc chắn không có lượt capture nào có thể đã thu tiền:
   * capture_state = READY (chưa từng gửi capture, hoặc PayPal đã xác nhận chưa thu) và không ai giữ
   * quyền. Trạng thái IN_FLIGHT/UNKNOWN/VERIFIED hoặc claim còn hạn -> từ chối (cần đối soát). Kiểm và
   * cập nhật trong cùng transaction với claimCapture (tuần tự hoá), nên đóng và capture không thể
   * cùng thắng. Root vẫn phải GET order trước khi gọi; store không gọi mạng.
   * @returns {{ closed: boolean, reason?: string }}
   */
  async function closeUncaptured(paymentRequestId, { nowIso, reason }) {
    if (!isoString(nowIso) || !identifier(reason)) fail('VALIDATION_ERROR', 'nowIso and reason are required', 400);
    return db.transaction(async () => {
      const r = await rawById(paymentRequestId);
      if (!r) return { closed: false, reason: 'NOT_FOUND' };
      if (r.status !== 'PENDING') return { closed: false, reason: `STATUS_${r.status}` };
      if (r.capture_state !== 'READY' || r.capture_claim) return { closed: false, reason: `CAPTURE_${r.capture_state}` };
      const upd = await db.prepare(
        `UPDATE payment_requests
         SET status = 'FAILED', version = version + 1, resolved_at = ?, resolved_by = 'RECONCILER',
             last_reconcile_error = ?, updated_at = ?
         WHERE id = ? AND status = 'PENDING' AND provider = 'PAYPAL_SANDBOX'
           AND EXISTS (SELECT 1 FROM paypal_payment_bindings b WHERE b.payment_request_id = payment_requests.id
                       AND b.capture_state = 'READY' AND b.capture_claim IS NULL)`
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
    finishCaptureAttempt,
    markCaptureVerified,
    closeUncaptured,
  });
}

module.exports = { createPayPalPaymentStore, proposedSchema, PayPalStoreError, CAPTURE_STATES, PROVIDER };
