// Lưu và đối chiếu mật khẩu cho mô hình xác thực lai (mục 2.2.2 và 2.2.5).
//
// Mật khẩu chỉ mở được một PHIÊN làm việc. Nó không bao giờ đủ để phê duyệt một thao tác
// làm tiền rời khỏi ký quỹ hay thay đổi thông tin xác thực — những việc đó đòi phiếu uỷ
// quyền sinh từ một lần xác thực lại bằng Passkey. Tuy vậy phiên vẫn tạo được giao dịch
// và vẫn khoá được tiền vào ký quỹ, nên kho mật khẩu vẫn là mục tiêu đáng bảo vệ.
//
// Vì sao scrypt: đây là hàm dẫn xuất khoá chậm, tiêu tốn bộ nhớ, có sẵn trong Node nên
// không phải thêm phụ thuộc gốc (native dependency) vào một đồ án sắp đóng băng phiên
// bản để thực nghiệm. Tham số N=2^15, r=8, p=1 nằm trong khuyến nghị hiện hành và tốn
// khoảng 32 MB bộ nhớ cho mỗi lần thử — đủ để một lần đoán có chi phí đáng kể.
//
// Muối sinh riêng cho từng tài khoản nên không thể dựng trước một bảng tra dùng chung.
// Toàn bộ tham số được ghi kèm trong chuỗi lưu trữ, để sau này đổi tham số vẫn đọc được
// các bản ghi cũ.
const crypto = require('crypto');

const SCRYPT_N = 1 << 15; // 32768
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;
const SALT_LEN = 16;

// scrypt cần bộ nhớ khoảng 128 * N * r byte; mặc định của Node là 32 MB nên phải nới.
const SCRYPT_MAXMEM = 256 * SCRYPT_N * SCRYPT_R;

const MIN_LENGTH = 8;
const MAX_LENGTH = 200;

class PasswordPolicyError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
    this.code = 'WEAK_PASSWORD';
  }
}

function derive(plain, salt, { N = SCRYPT_N, r = SCRYPT_R, p = SCRYPT_P } = {}) {
  return crypto.scryptSync(Buffer.from(String(plain), 'utf8'), salt, KEY_LEN, {
    N,
    r,
    p,
    maxmem: SCRYPT_MAXMEM,
  });
}

/** Chuỗi lưu trong users.password_hash: scrypt$N=..,r=..,p=..$<muối>$<giá trị dẫn xuất>. */
function hashPassword(plain) {
  assertPasswordPolicy(plain);
  const salt = crypto.randomBytes(SALT_LEN);
  const key = derive(plain, salt);
  return `scrypt$N=${SCRYPT_N},r=${SCRYPT_R},p=${SCRYPT_P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

function parseStored(stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return null;
  const params = {};
  for (const kv of parts[1].split(',')) {
    const [k, v] = kv.split('=');
    params[k] = parseInt(v, 10);
  }
  if (!params.N || !params.r || !params.p) return null;
  try {
    return { params, salt: Buffer.from(parts[2], 'base64'), key: Buffer.from(parts[3], 'base64') };
  } catch (_) {
    return null;
  }
}

/**
 * So sánh mật khẩu với bản dẫn xuất đã lưu.
 *
 * Phép so cuối cùng dùng timingSafeEqual: so chuỗi thông thường dừng ở byte đầu tiên
 * khác nhau nên thời gian phản hồi rò rỉ thông tin về giá trị đúng.
 */
function verifyPassword(plain, stored) {
  const parsed = parseStored(stored);
  if (!parsed) return false;
  const candidate = derive(plain, parsed.salt, parsed.params);
  return candidate.length === parsed.key.length && crypto.timingSafeEqual(candidate, parsed.key);
}

// Bản dẫn xuất của một mật khẩu ngẫu nhiên, dùng khi tên đăng nhập KHÔNG tồn tại.
// Điểm cuối đăng nhập phải tốn đúng chừng ấy thời gian cho mọi tên đăng nhập, nếu không
// thời gian phản hồi sẽ tự tố cáo tài khoản nào có thật — đúng thứ mà thông báo lỗi đồng
// nhất được đặt ra để giấu. Tính một lần lúc nạp module.
const DUMMY_HASH = hashPassword(crypto.randomBytes(24).toString('base64url'));

/** Chạy một lần dẫn xuất giả để giữ thời gian phản hồi không phụ thuộc tài khoản có thật hay không. */
function burnVerify(plain) {
  verifyPassword(String(plain || ''), DUMMY_HASH);
}

function assertPasswordPolicy(plain) {
  const value = String(plain == null ? '' : plain);
  if (value.length < MIN_LENGTH) {
    throw new PasswordPolicyError(`Mật khẩu phải dài ít nhất ${MIN_LENGTH} ký tự.`);
  }
  if (value.length > MAX_LENGTH) {
    throw new PasswordPolicyError(`Mật khẩu dài quá ${MAX_LENGTH} ký tự.`);
  }
  if (/^\d+$/.test(value)) {
    throw new PasswordPolicyError('Mật khẩu không được chỉ gồm chữ số.');
  }
  if (/^(.)\1+$/.test(value)) {
    throw new PasswordPolicyError('Mật khẩu không được chỉ gồm một ký tự lặp lại.');
  }
  return value;
}

/** Mật khẩu tạm cấp cho quản trị viên lúc khởi tạo; người nhận buộc phải đổi ngay. */
function generateTemporaryPassword() {
  return `Tmp-${crypto.randomBytes(9).toString('base64url')}`;
}

module.exports = {
  hashPassword,
  verifyPassword,
  burnVerify,
  assertPasswordPolicy,
  generateTemporaryPassword,
  PasswordPolicyError,
  MIN_LENGTH,
};
