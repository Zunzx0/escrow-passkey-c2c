// Mock Payment Provider — đứng về PHÍA PROVIDER, không phải backend của hệ thống.
//
// Trong đời thực, module này là mã của Stripe/VNPay/MoMo — không nằm trong repo của người
// bán hàng. Nó chỉ được đặt ở đây vì đồ án cần tự đóng cả hai vai để chạy được offline. Mục
// tiêu (đã nêu ở kế hoạch): sau này thay bằng provider thật thì chỉ đổi module này, không
// đụng tới lib/paymentService.js hay Wallet/Escrow core.
//
// Provider có KHO TRẠNG THÁI RIÊNG, nằm ở một file cơ sở dữ liệu tách hẳn khỏi cơ sở dữ liệu
// nghiệp vụ (mặc định <DB_PATH>.mock-provider.db). Tách file là có chủ đích: backend không bao
// giờ đọc thẳng kho này để "biết trước" kết quả — nó chỉ biết kết quả qua đúng hai kênh mà
// một provider thật cung cấp: webhook đã ký, và API truy vấn trạng thái (queryStatus).
//
// Phân vai các hàm:
//   phía backend gọi : submitPayment (gửi yêu cầu sang provider), queryStatus (worker đối soát),
//                      verifyProviderSignature (webhook)
//   phía provider    : settlePayment (provider chốt kết quả và dựng webhook đã ký),
//                      setQueryMode (mô phỏng API truy vấn của provider bị sự cố),
//                      buildProviderCallback (ký một payload bất kỳ — bộ test dùng để dựng cả
//                      callback hợp lệ lẫn callback trái thứ tự)
const crypto = require('crypto');
const path = require('path');
const Database = require('./sqlite');
const { DB_PATH } = require('../db');

const SECRET = process.env.PAYMENT_WEBHOOK_SECRET || '';

const PROVIDER_DB_PATH = process.env.MOCK_PROVIDER_DB_PATH
  ? path.resolve(path.join(__dirname, '..', '..'), process.env.MOCK_PROVIDER_DB_PATH)
  : `${DB_PATH.replace(/\.db$/i, '')}.mock-provider.db`;

// Độ trễ mạng mô phỏng của API truy vấn trạng thái. Đọc ở mỗi lần gọi để bài kiểm thử đổi
// được theo từng process mà không phải sửa mã.
function latencyMs() {
  return Math.max(0, parseInt(process.env.MOCK_PROVIDER_LATENCY_MS || '0', 10) || 0);
}

class ProviderError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

let providerDb = null;
function store() {
  if (providerDb) return providerDb;
  providerDb = new Database(PROVIDER_DB_PATH);
  providerDb.pragma('journal_mode = WAL');
  providerDb.pragma('busy_timeout = 5000');
  providerDb.exec(`
    CREATE TABLE IF NOT EXISTS provider_payments (
      provider_ref TEXT PRIMARY KEY,
      merchant_ref TEXT NOT NULL,
      amount INTEGER NOT NULL CHECK (amount > 0),
      status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SUCCEEDED','FAILED')),
      query_mode TEXT NOT NULL DEFAULT 'NORMAL' CHECK (query_mode IN ('NORMAL','ERROR')),
      query_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  return providerDb;
}

// ---------------------------------------------------------------------------------------
// Chữ ký webhook
// ---------------------------------------------------------------------------------------

// Thứ tự khoá là một phần của giao thức chữ ký — cùng nguyên tắc với buildAuthorizationContext
// ở routes/transactions.js: JSON.stringify giữ nguyên thứ tự chèn, đổi thứ tự là đổi chữ ký.
// LUÔN dựng lại từ các trường rời (destructuring) chứ không JSON.stringify thẳng object nhận
// từ client, để thứ tự khoá trên dây không quyết định được kết quả xác minh.
function canonicalPayload({ paymentRequestId, providerRef, status, amount }) {
  return { v: 1, paymentRequestId, providerRef, status, amount };
}

function sign(payload) {
  return crypto.createHmac('sha256', SECRET).update(JSON.stringify(payload), 'utf8').digest('hex');
}

/** Phía PROVIDER: ký một callback cho một kết quả cho trước. */
function buildProviderCallback({ paymentRequestId, providerRef, status, amount }) {
  const payload = canonicalPayload({ paymentRequestId, providerRef, status, amount });
  return { payload, signature: sign(payload) };
}

/**
 * Phía BACKEND: xác minh chữ ký bằng so sánh thời gian không đổi.
 *
 * Thiếu PAYMENT_WEBHOOK_SECRET thì luôn từ chối (an toàn khi cấu hình sai/thiếu, không bao
 * giờ coi thiếu khoá là "khỏi cần kiểm chữ ký"). Chữ ký sai định dạng hex hoặc sai độ dài thì
 * Buffer.from cho ra buffer khác độ dài, phép so `timingSafeEqual` không chạy tới và trả false
 * một cách an toàn — không throw, không rò rỉ thời gian xử lý.
 */
function verifyProviderSignature(payload, signature) {
  if (!SECRET || typeof signature !== 'string' || !signature) return false;
  const expected = sign(canonicalPayload(payload || {}));
  const expectedBuf = Buffer.from(expected, 'hex');
  let givenBuf;
  try {
    givenBuf = Buffer.from(signature, 'hex');
  } catch (_) {
    return false;
  }
  return expectedBuf.length === givenBuf.length && crypto.timingSafeEqual(expectedBuf, givenBuf);
}

// ---------------------------------------------------------------------------------------
// Kho trạng thái phía provider
// ---------------------------------------------------------------------------------------

/** Phía BACKEND: gửi một yêu cầu thanh toán mới sang provider. Provider ghi nhận ở PENDING. */
function submitPayment({ providerRef, merchantRef, amount }) {
  const now = new Date().toISOString();
  store()
    .prepare(
      `INSERT INTO provider_payments (provider_ref, merchant_ref, amount, status, created_at, updated_at)
       VALUES (?, ?, ?, 'PENDING', ?, ?)`
    )
    .run(providerRef, merchantRef, amount, now, now);
}

function findPayment(providerRef) {
  return store().prepare('SELECT * FROM provider_payments WHERE provider_ref = ?').get(providerRef);
}

/**
 * Phía PROVIDER: chốt kết quả của một khoản thanh toán, rồi trả về webhook đã ký mà provider
 * SẼ gửi. Việc có gửi webhook đó đi hay không (hay để nó "thất lạc") là lựa chọn của người gọi
 * — chính là cách mô phỏng webhook bị mất để worker đối soát phải tự phát hiện.
 */
function settlePayment(providerRef, status) {
  if (status !== 'SUCCEEDED' && status !== 'FAILED' && status !== 'PENDING') {
    throw new ProviderError('INVALID_STATUS', `Trạng thái provider không hợp lệ: ${status}`);
  }
  const row = findPayment(providerRef);
  if (!row) throw new ProviderError('UNKNOWN_PAYMENT', `Provider không biết khoản thanh toán ${providerRef}`);
  store()
    .prepare('UPDATE provider_payments SET status = ?, updated_at = ? WHERE provider_ref = ?')
    .run(status, new Date().toISOString(), providerRef);
  return buildProviderCallback({ paymentRequestId: row.merchant_ref, providerRef, status, amount: row.amount });
}

/** Phía PROVIDER: bật/tắt sự cố ở API truy vấn trạng thái cho một khoản thanh toán. */
function setQueryMode(providerRef, mode) {
  if (mode !== 'NORMAL' && mode !== 'ERROR') throw new ProviderError('INVALID_MODE', `query_mode không hợp lệ: ${mode}`);
  store()
    .prepare('UPDATE provider_payments SET query_mode = ?, updated_at = ? WHERE provider_ref = ?')
    .run(mode, new Date().toISOString(), providerRef);
}

/**
 * Phía BACKEND: hỏi provider trạng thái hiện tại của một khoản thanh toán.
 *
 * Bất đồng bộ và có độ trễ mô phỏng như một lần gọi mạng thật. Chính khoảng chờ này làm cuộc
 * đua giữa worker và webhook có thật: trong lúc worker đang chờ provider trả lời, webhook có
 * thể đã tất toán xong yêu cầu.
 */
async function queryStatus(providerRef) {
  const wait = latencyMs();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));

  const row = findPayment(providerRef);
  if (!row) throw new ProviderError('UNKNOWN_PAYMENT', `Provider không biết khoản thanh toán ${providerRef}`);
  if (row.query_mode === 'ERROR') {
    throw new ProviderError('PROVIDER_UNAVAILABLE', 'API truy vấn trạng thái của provider đang lỗi');
  }
  store()
    .prepare('UPDATE provider_payments SET query_count = query_count + 1 WHERE provider_ref = ?')
    .run(providerRef);
  return { providerRef, merchantRef: row.merchant_ref, status: row.status, amount: row.amount };
}

/**
 * Phía PROVIDER: gửi webhook đã ký về máy chủ của merchant qua HTTP thật — đúng như provider
 * thật làm, để đường webhook của backend được đi qua nguyên vẹn (kiểm chữ ký, tất toán...).
 */
async function deliverWebhook(callback) {
  const url = process.env.PAYMENT_WEBHOOK_URL
    || `http://127.0.0.1:${process.env.PORT || 3000}/api/payments/webhook`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(callback),
    });
    let data = {};
    try { data = await res.json(); } catch (_) {}
    return { delivered: true, status: res.status, response: data };
  } catch (e) {
    // Webhook không tới được máy chủ merchant: provider vẫn giữ kết quả của mình, worker đối
    // soát phía merchant sẽ tự hỏi lại sau.
    return { delivered: false, error: e.message };
  }
}

function isCheckoutEnabled() {
  return process.env.MOCK_PROVIDER_CHECKOUT !== '0';
}

module.exports = {
  PROVIDER_DB_PATH,
  deliverWebhook,
  isCheckoutEnabled,
  ProviderError,
  canonicalPayload,
  buildProviderCallback,
  verifyProviderSignature,
  submitPayment,
  findPayment,
  settlePayment,
  setQueryMode,
  queryStatus,
};
