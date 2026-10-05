const { db } = require('../db');
const { AppError } = require('./errors');
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


module.exports={parseAmount,parseClientRequestId,assertTopupLimits};
