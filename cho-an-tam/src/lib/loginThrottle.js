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
// lộ tài khoản nào tồn tại. Trạng thái nằm trong DB dùng chung, giữ được sau khởi động lại.
const MAX_FAILURES = parseInt(process.env.LOGIN_MAX_FAILURES || '5', 10);
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const BASE_LOCK_SECONDS = parseInt(process.env.LOGIN_LOCK_BASE_SECONDS || '900', 10);
const MAX_LOCK_SECONDS = 24 * 3600;
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
async function lockedFor(username, now = Date.now()) {
  const {db}=require('../db');
  const {hash}=require('./accountSecurity');
  const e=await db.prepare('SELECT locked_until FROM auth_login_throttles WHERE identity_hash=?').get(hash(keyOf(username)));
  return e && Number(e.locked_until)>now ? Math.ceil((Number(e.locked_until)-now)/1000) : 0;
}

/** Ghi một lần sai. Đủ ngưỡng thì khoá, thời gian khoá nhân đôi sau mỗi lần bị khoá lại. */
async function recordFailure(username, now = Date.now()) {
  const {db}=require('../db'); const {hash}=require('./accountSecurity'); const key=hash(keyOf(username));
  return db.transaction(async()=>{
    let e=await db.prepare('SELECT * FROM auth_login_throttles WHERE identity_hash=?').get(key);
    if (!e || now-Number(e.last_failure_at)>FORGET_AFTER_MS) e={failures:'[]',lock_count:0,locked_until:0};
    let failures=JSON.parse(e.failures).filter(t=>now-t<FAILURE_WINDOW_MS); failures.push(now);
    const locked=failures.length>=MAX_FAILURES;
    const count=e.lock_count+(locked?1:0), seconds=locked ? Math.min(BASE_LOCK_SECONDS*2**Math.min(count-1,20),MAX_LOCK_SECONDS) : 0;
    await db.prepare('INSERT INTO auth_login_throttles(identity_hash,failures,locked_until,lock_count,last_failure_at) VALUES(?,?,?,?,?) ON CONFLICT(identity_hash) DO UPDATE SET failures=excluded.failures,locked_until=excluded.locked_until,lock_count=excluded.lock_count,last_failure_at=excluded.last_failure_at')
      .run(key,JSON.stringify(locked?[]:failures),locked?now+seconds*1000:e.locked_until,count,now);
    return {locked,seconds};
  })();
}

async function recordSuccess(username) {
  const {db}=require('../db');const {hash}=require('./accountSecurity');
  await db.prepare('DELETE FROM auth_login_throttles WHERE identity_hash=?').run(hash(keyOf(username)));
}

async function resetLoginThrottle() {
  await require('../db').db.prepare('DELETE FROM auth_login_throttles').run();
}

module.exports = { MAX_FAILURES, lockedFor, recordFailure, recordSuccess, resetLoginThrottle };
