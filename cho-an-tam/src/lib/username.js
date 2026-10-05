// Tên đăng nhập có thể là bí danh ngắn hoặc địa chỉ email. Email ở đây chỉ là
// định danh đăng nhập; hệ thống chưa xác minh quyền sở hữu hộp thư.
const HANDLE = /^[a-z0-9._-]{3,32}$/;
const EMAIL_LOCAL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}$/;
const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase();
}

function isValidUsername(username) {
  if (HANDLE.test(username)) return true;
  if (username.length > 254) return false;

  const parts = username.split('@');
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  if (!EMAIL_LOCAL.test(local) || local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
  const labels = domain.split('.');
  return labels.length >= 2 && labels.every((label) => DOMAIN_LABEL.test(label));
}

// Tên email không được đưa vào hồ sơ/tin đăng công khai. Người dùng vẫn thấy
// địa chỉ đầy đủ của chính mình ở /api/users/me; quản trị viên có quyền xem ở API quản trị.
function publicUsername(username) {
  return String(username || '').includes('@') ? null : username;
}

const USERNAME_HINT = 'Dùng tên đăng nhập 3–32 ký tự (chữ, số, . _ -) hoặc địa chỉ email hợp lệ.';

module.exports = { normalizeUsername, isValidUsername, publicUsername, USERNAME_HINT };
