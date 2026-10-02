// Khoá tạm đăng nhập bằng mật khẩu theo TÊN ĐĂNG NHẬP, bổ sung cho giới hạn theo IP.
//
// Giới hạn theo IP không chặn được brute force phân tán (đổi IP liên tục) và có thể phạt oan
// nhiều người dùng chung một IP phía sau proxy. Đếm theo tài khoản thì kẻ tấn công đổi IP bao
// nhiêu cũng chỉ thử được vài mật khẩu trên một tài khoản trong một khoảng thời gian.
//
// Trong lúc bị khoá, MỌI lần thử mật khẩu đều bị từ chối, kể cả mật khẩu đúng — nếu không thì
// khoá vô nghĩa, vì lần đoán trúng vẫn lọt qua. Rủi ro đi kèm là kẻ tấn công cố ý khoá tài
// khoản của người khác; mô hình lai giảm rủi ro đó vì đăng nhập bằng Passkey không bị khoá,
// và một lần đăng nhập bằng Passkey thành công sẽ gỡ khoá mật khẩu.
//
// Khoá áp dụng như nhau cho tên đăng nhập có thật và không có thật, nên phản hồi 429 không tiết
// lộ tài khoản nào tồn tại. Trạng thái nằm trong bộ nhớ của tiến trình (đủ cho triển khai một
// tiến trình như hiện tại; nhiều tiến trình thì cần kho dùng chung).
const MAX_FAILURES = parseInt(process.env.LOGIN_MAX_FAILURES || '5', 10);
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const BASE_LOCK_SECONDS = parseInt(process.env.LOGIN_LOCK_BASE_SECONDS || '60', 10);
const MAX_LOCK_SECONDS = 15 * 60;
const FORGET_AFTER_MS = 24 * 3600 * 1000;

const entries = new Map();
let lastSweep = Date.now();

function sweep(now) {
  if (now - lastSweep < 5 * 60 * 1000) return;
  lastSweep = now;
  for (const [key, e] of entries) {
    if (e.lockedUntil < now && now - e.lastFailureAt > FORGET_AFTER_MS) entries.delete(key);
  }
}

function keyOf(username) {
  return String(username || '').trim().toLowerCase();
}

/** Số giây còn bị khoá, hoặc 0 nếu đang được phép thử. */
function lockedFor(username, now = Date.now()) {
  const e = entries.get(keyOf(username));
  if (!e || e.lockedUntil <= now) return 0;
  return Math.ceil((e.lockedUntil - now) / 1000);
}

/** Ghi một lần sai. Đủ ngưỡng thì khoá, thời gian khoá nhân đôi sau mỗi lần bị khoá lại. */
function recordFailure(username, now = Date.now()) {
  sweep(now);
  const key = keyOf(username);
  let e = entries.get(key);
  if (!e || now - e.lastFailureAt > FORGET_AFTER_MS) {
    e = { failures: [], lockedUntil: 0, lockCount: 0, lastFailureAt: now };
    entries.set(key, e);
  }
  e.lastFailureAt = now;
  e.failures = e.failures.filter((t) => now - t < FAILURE_WINDOW_MS);
  e.failures.push(now);
  if (e.failures.length >= MAX_FAILURES) {
    e.lockCount += 1;
    const seconds = Math.min(BASE_LOCK_SECONDS * 2 ** (e.lockCount - 1), MAX_LOCK_SECONDS);
    e.lockedUntil = now + seconds * 1000;
    e.failures = [];
    return { locked: true, seconds };
  }
  return { locked: false };
}

function recordSuccess(username) {
  entries.delete(keyOf(username));
}

function resetLoginThrottle() {
  entries.clear();
}

module.exports = { MAX_FAILURES, lockedFor, recordFailure, recordSuccess, resetLoginThrottle };
