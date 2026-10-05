// Quy tắc số tiền VND dùng chung: số nguyên đồng, kiểu SỐ của JSON, nằm trong phạm vi số nguyên an
// toàn của JavaScript và trong khoảng nghiệp vụ.
//
// Vì sao phải chặt về KIỂU chứ không chỉ `amount > 0`: hai nền lưu trữ xử lý giá trị lạc kiểu khác
// nhau. SQLite (kiểu động) cất 1000.5 hay 1e20 thành REAL và ép chuỗi "1e5" thành 100000; PostgreSQL
// (BIGINT) từ chối chính những giá trị đó bằng lỗi SQL -> 500. Cùng một request cho hai kết quả khác
// nhau tuỳ nơi triển khai, và bên SQLite thì để lọt số tiền lẻ vào sổ cái. Kiểm ở tầng ứng dụng,
// TRƯỚC khi chạm CSDL, cho một kết quả duy nhất trên cả hai nền.
const { AppError } = require('./errors');

const VND_MIN = 1000;
// Trùng giới hạn giá tin đăng (routes/listings.js): giao dịch thủ công là phiên bản không gắn tin
// đăng của một đơn mua, nên không được mang số tiền mà một đơn mua thật không thể có.
const ITEM_AMOUNT_MAX = 100000000;

const vnd = (n) => `${Number(n).toLocaleString('vi-VN')}đ`;

/**
 * @param raw giá trị lấy thẳng từ body JSON
 * @param opts.min, opts.max khoảng hợp lệ (mặc định khoảng giá một món hàng)
 * @param opts.field tên trường dùng trong thông báo
 * @returns {number} số nguyên an toàn trong khoảng
 * @throws AppError 400 INVALID_AMOUNT (sai kiểu: số lẻ, chuỗi, boolean, mảng, vượt 2^53)
 *         AppError 400 AMOUNT_OUT_OF_RANGE (đúng kiểu nhưng ngoài khoảng, kể cả 0 và số âm)
 */
function parseVndAmount(raw, { min = VND_MIN, max = ITEM_AMOUNT_MAX, field = 'amount' } = {}) {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw)) {
    throw new AppError(400, 'INVALID_AMOUNT', `${field} phải là một số nguyên (đơn vị đồng)`);
  }
  if (raw < min || raw > max) {
    throw new AppError(400, 'AMOUNT_OUT_OF_RANGE', `${field} phải từ ${vnd(min)} đến ${vnd(max)}`);
  }
  return raw;
}

module.exports = { parseVndAmount, VND_MIN, ITEM_AMOUNT_MAX };
