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
const { DB_PATH, DIALECT, db: mainDb } = require('../db');
const { SqliteAsyncDatabase, PgAsyncDatabase } = require('./asyncDb');

const SECRET = process.env.PAYMENT_WEBHOOK_SECRET || '';

// Trên PostgreSQL, kho của provider là schema riêng `mock_provider` trong cùng cơ sở dữ liệu
// (Railway không có ổ đĩa bền vững để giữ một file SQLite thứ hai).
const PROVIDER_DB_PATH = DIALECT === 'sqlite'
  ? (process.env.MOCK_PROVIDER_DB_PATH
    ? path.resolve(path.join(__dirname, '..', '..'), process.env.MOCK_PROVIDER_DB_PATH)
    : `${DB_PATH.replace(/\.db$/i, '')}.mock-provider.db`)
  : null;
const T = DIALECT === 'pg' ? 'mock_provider.provider_payments' : 'provider_payments';

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

// Kho của provider là một instance truy cập RIÊNG, kể cả khi dùng chung pool PostgreSQL: nó không
// bao giờ "nhập" vào giao dịch cơ sở dữ liệu đang mở của backend nghiệp vụ. Đúng như provider thật
// — ghi nhận phía provider không rollback theo giao dịch của merchant.
let providerDb = null;
function store() {
  if (providerDb) return providerDb;
  if (DIALECT === 'pg') {
    // Bảng đã được tạo trong migration PostgreSQL (schema.pg.sql).
    providerDb = new PgAsyncDatabase(mainDb.pool, { ready: mainDb.ready });
    return providerDb;
  }
  const Database = require('./sqlite');
  const raw = new Database(PROVIDER_DB_PATH);
  raw.pragma('journal_mode = WAL');
  raw.pragma('busy_timeout = 5000');
  raw.exec(`
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
  providerDb = new SqliteAsyncDatabase(raw);
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

/**
 * Phía BACKEND: gửi một yêu cầu thanh toán sang provider. Provider ghi nhận ở PENDING.
 *
 * IDEMPOTENT theo providerRef — đúng như API "create payment" của provider thật khi nhận cùng
 * idempotency key: gửi lại một yêu cầu provider đã có thì không tạo bản ghi thứ hai, không đổi
 * trạng thái đã có. Nhờ vậy backend gửi lại sau một lần gửi hỏng/không rõ kết quả mà không sợ
 * trùng. Cùng providerRef nhưng khác merchantRef/amount là xung đột thật -> báo lỗi.
 *
 * MOCK_PROVIDER_SUBMIT_FAIL=1 mô phỏng provider từ chối/không trả lời bước tạo thanh toán (đọc ở
 * mỗi lần gọi để bài kiểm thử bật theo từng process).
 */
async function submitPayment({ providerRef, merchantRef, amount }) {
  // Nhật ký mọi lệnh tạo thanh toán đến provider, KỂ CẢ lệnh trùng và lệnh bị từ chối. Chỉ dùng để
  // kiểm thử: đếm xem backend đã gọi provider bao nhiêu lần — điều mà bản ghi trong kho không cho biết.
  if (process.env.MOCK_PROVIDER_CALL_LOG) {
    require('fs').appendFileSync(process.env.MOCK_PROVIDER_CALL_LOG, JSON.stringify({ providerRef, merchantRef }) + '\n');
  }
  if (process.env.MOCK_PROVIDER_SUBMIT_FAIL === '1') {
    throw new ProviderError('PROVIDER_UNAVAILABLE', 'Provider không nhận yêu cầu tạo thanh toán (mô phỏng sự cố)');
  }
  // Độ trễ mô phỏng của lệnh tạo thanh toán. Bài kiểm thử dùng nó để các lượt gửi lại đồng thời
  // chồng lên lượt gửi đầu tiên — đúng khung thời gian mà lỗi gửi trùng xảy ra.
  const submitDelay = parseInt(process.env.MOCK_PROVIDER_SUBMIT_DELAY_MS || '0', 10) || 0;
  if (submitDelay > 0) await new Promise((r) => setTimeout(r, submitDelay));
  const now = new Date().toISOString();
  await store()
    .prepare(
      `INSERT INTO ${T} (provider_ref, merchant_ref, amount, status, created_at, updated_at)
       VALUES (?, ?, ?, 'PENDING', ?, ?)
       ON CONFLICT (provider_ref) DO NOTHING`
    )
    .run(providerRef, merchantRef, amount, now, now);
  const row = await findPayment(providerRef);
  if (!row || row.merchant_ref !== merchantRef || row.amount !== amount) {
    throw new ProviderError('PROVIDER_REF_CONFLICT', 'providerRef đã thuộc về một khoản thanh toán khác');
  }
  return { providerRef, status: row.status };
}

async function findPayment(providerRef) {
  return store().prepare(`SELECT * FROM ${T} WHERE provider_ref = ?`).get(providerRef);
}

/**
 * Phía PROVIDER: chốt kết quả của một khoản thanh toán, rồi trả về webhook đã ký mà provider
 * SẼ gửi. Việc có gửi webhook đó đi hay không (hay để nó "thất lạc") là lựa chọn của người gọi
 * — chính là cách mô phỏng webhook bị mất để worker đối soát phải tự phát hiện.
 */
async function settlePayment(providerRef, status, { onlyFromPending = false } = {}) {
  if (status !== 'SUCCEEDED' && status !== 'FAILED' && status !== 'PENDING') {
    throw new ProviderError('INVALID_STATUS', `Trạng thái provider không hợp lệ: ${status}`);
  }
  const row = await findPayment(providerRef);
  if (!row) throw new ProviderError('UNKNOWN_PAYMENT', `Provider không biết khoản thanh toán ${providerRef}`);
  // onlyFromPending: trang thanh toán của người dùng chỉ được chốt một khoản ĐANG chờ. Điều kiện nằm
  // ngay trong câu UPDATE nên hai lần bấm "thanh toán" đồng thời chỉ một lần thắng. Bộ kiểm thử vẫn
  // gọi không kèm cờ này để chủ động dựng kịch bản provider đổi kết quả.
  const r = await store()
    .prepare(`UPDATE ${T} SET status = ?, updated_at = ? WHERE provider_ref = ?${onlyFromPending ? " AND status = 'PENDING'" : ''}`)
    .run(status, new Date().toISOString(), providerRef);
  if (onlyFromPending && r.changes !== 1) {
    throw new ProviderError('ALREADY_SETTLED', 'Giao dịch đã có kết quả ở cổng thanh toán');
  }
  return buildProviderCallback({ paymentRequestId: row.merchant_ref, providerRef, status, amount: row.amount });
}

/** Phía PROVIDER: bật/tắt sự cố ở API truy vấn trạng thái cho một khoản thanh toán. */
async function setQueryMode(providerRef, mode) {
  if (mode !== 'NORMAL' && mode !== 'ERROR') throw new ProviderError('INVALID_MODE', `query_mode không hợp lệ: ${mode}`);
  await store()
    .prepare(`UPDATE ${T} SET query_mode = ?, updated_at = ? WHERE provider_ref = ?`)
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

  const row = await findPayment(providerRef);
  if (!row) throw new ProviderError('UNKNOWN_PAYMENT', `Provider không biết khoản thanh toán ${providerRef}`);
  if (row.query_mode === 'ERROR') {
    throw new ProviderError('PROVIDER_UNAVAILABLE', 'API truy vấn trạng thái của provider đang lỗi');
  }
  await store()
    .prepare(`UPDATE ${T} SET query_count = query_count + 1 WHERE provider_ref = ?`)
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
  return process.env.MOCK_PROVIDER_CHECKOUT !== '0' && process.env.PAYPAL_SANDBOX_ENABLED !== '1';
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
