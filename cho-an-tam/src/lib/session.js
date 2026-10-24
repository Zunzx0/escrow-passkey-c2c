// Phiên đăng nhập phía máy chủ.
//
// JWT vẫn là access token ngắn hạn (mặc định 15 phút) nhưng mang `sid`. Mỗi lần dùng, máy chủ
// kiểm phiên tương ứng: chưa bị thu hồi, chưa quá hạn tuyệt đối, chưa nhàn rỗi quá lâu. Nhờ vậy
// đăng xuất thu hồi được phiên ngay, không phải chờ JWT hết hạn.
//
// Access token hết hạn thì trình duyệt xin token mới bằng mã làm mới trong cookie HttpOnly
// (JavaScript của trang không đọc được, nên XSS không lấy được). Mỗi lần làm mới, mã làm mới
// được thay bằng mã mới, nên một mã cũ bị lộ không còn dùng được sau lần làm mới kế tiếp.
const crypto = require('crypto');
const { db, uuid, nowIso } = require('../db');

const SESSION_IDLE_SECONDS = parseInt(process.env.SESSION_IDLE_SECONDS || String(12 * 3600), 10);
const SESSION_ABSOLUTE_SECONDS = parseInt(process.env.SESSION_ABSOLUTE_SECONDS || String(7 * 24 * 3600), 10);
const PASSWORD_SESSION_IDLE_SECONDS = Number(process.env.PASSWORD_SESSION_IDLE_SECONDS || 7200);
const PASSWORD_SESSION_ABSOLUTE_SECONDS = Number(process.env.PASSWORD_SESSION_ABSOLUTE_SECONDS || 86400);
const TOUCH_EVERY_MS = 60 * 1000;

const COOKIE_NAME = 'cat_rt';
const COOKIE_PATH = '/api/passkeys/session';

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function newRefreshToken() {
  return crypto.randomBytes(32).toString('base64url');
}
function describeDevice(ua='') {
  const os=/Android/i.test(ua)?'Android':/iPhone|iPad/i.test(ua)?'iPhone / iPad':/Windows/i.test(ua)?'Windows':/Mac/i.test(ua)?'Mac':/Linux/i.test(ua)?'Linux':'Thiết bị';
  const browser=/Edg/i.test(ua)?'Edge':/Firefox/i.test(ua)?'Firefox':/Chrome|CriOS/i.test(ua)?'Chrome':/Safari/i.test(ua)?'Safari':'trình duyệt';
  return `${os}, ${browser}`;
}

async function createSession(userId, { authMethod='password', deviceName='' }={}) {
  const id = uuid();
  const refreshToken = newRefreshToken();
  const now = new Date();
  await db.prepare(
    `INSERT INTO sessions (id, user_id, refresh_hash, created_at, last_seen_at, expires_at,auth_method,auth_at,device_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    userId,
    sha256(refreshToken),
    now.toISOString(),
    now.toISOString(),
    new Date(now.getTime() + (authMethod==='passkey' ? SESSION_ABSOLUTE_SECONDS : PASSWORD_SESSION_ABSOLUTE_SECONDS) * 1000).toISOString(),
    authMethod,now.toISOString(),describeDevice(String(deviceName))
  );
  await db.prepare('UPDATE users SET auth_last_active_at=? WHERE id=?').run(now.toISOString(),userId);
  return { sessionId: id, refreshToken };
}

/** Lý do phiên không dùng được, hoặc null nếu phiên còn hiệu lực. */
function sessionProblem(row, now = Date.now()) {
  if (!row) return 'NOT_FOUND';
  if (row.revoked_at) return 'REVOKED';
  if (new Date(row.expires_at).getTime() <= now) return 'EXPIRED';
  const lifetime=row.auth_method==='passkey'?SESSION_ABSOLUTE_SECONDS:PASSWORD_SESSION_ABSOLUTE_SECONDS;
  if(Date.parse(row.created_at)+lifetime*1000<=now) return 'EXPIRED';
  if (new Date(row.last_seen_at).getTime() + (row.auth_method==='passkey' ? SESSION_IDLE_SECONDS : PASSWORD_SESSION_IDLE_SECONDS) * 1000 <= now) return 'IDLE';
  return null;
}

async function getSession(sessionId) {
  if (!sessionId) return null;
  return (await db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId)) || null;
}

/** Ghi nhận phiên vừa được dùng; ghi tối đa một lần mỗi phút để không ghi DB ở mọi request. */
async function touchSession(row) {
  if (Date.now() - new Date(row.last_seen_at).getTime() < TOUCH_EVERY_MS) return;
  await db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ? AND revoked_at IS NULL').run(nowIso(), row.id);
  await db.prepare('UPDATE users SET auth_last_active_at=? WHERE id=?').run(nowIso(),row.user_id);
}

async function revokeSession(sessionId, reason) {
  await db.prepare('UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE id = ? AND revoked_at IS NULL')
    .run(nowIso(), reason, sessionId);
}

async function revokeAllSessions(userId, reason, exceptSessionId = null) {
  await db.prepare(
    `UPDATE sessions SET revoked_at = ?, revoked_reason = ?
     WHERE user_id = ? AND revoked_at IS NULL AND id IS DISTINCT FROM ?`
  ).run(nowIso(), reason, userId, exceptSessionId);
}

/** Đổi mã làm mới lấy mã làm mới mới. Trả { problem } nếu phiên không còn làm mới được. */
async function rotateRefreshToken(refreshToken) {
  if (!refreshToken) return { problem: 'MISSING' };
  return db.transaction(async()=>{
  const row = await db.prepare('SELECT * FROM sessions WHERE refresh_hash = ?').get(sha256(refreshToken));
  if(!row) {
    const prior=await db.prepare('SELECT session_id,created_at FROM auth_refresh_history WHERE token_hash=?').get(sha256(refreshToken));
    // Two tabs may submit the old cookie before either receives Set-Cookie. The loser
    // gets no token/cookie; it may retry with the browser's new cookie. Never let this
    // immediate conflict destroy the winning session. Older replay still revokes it.
    const age=prior?Date.now()-Date.parse(prior.created_at):Infinity;
    if(prior && age>=0 && age<10000 && !sessionProblem(await getSession(prior.session_id)))return {problem:'ROTATED'};
    if(prior) await revokeSession(prior.session_id,'REFRESH_TOKEN_REUSE');
    return {problem:prior ? 'REUSED' : 'NOT_FOUND'};
  }
  const problem = sessionProblem(row);
  if (problem) return { problem };

  const next = newRefreshToken();
  const now = nowIso();
  const changed = (await db
    .prepare('UPDATE sessions SET refresh_hash = ?, last_seen_at = ? WHERE id = ? AND refresh_hash = ? AND revoked_at IS NULL')
    .run(sha256(next), now, row.id, sha256(refreshToken))).changes;
  // Defensive compare-and-swap; the serialized transaction normally resolves duplicates above.
  if (changed !== 1) return { problem: 'REUSED' };
  await db.prepare('INSERT INTO auth_refresh_history(token_hash,session_id,created_at) VALUES(?,?,?)').run(sha256(refreshToken),row.id,now);
  return { session: { ...row, last_seen_at: now }, refreshToken: next };
  })();
}

async function upgradeSession(sessionId) {
  const row=await getSession(sessionId);
  if(sessionProblem(row)) throw new Error('SESSION_NOT_AVAILABLE');
  await db.prepare("UPDATE sessions SET auth_method='passkey',auth_at=?,last_seen_at=?,expires_at=? WHERE id=? AND revoked_at IS NULL")
    .run(nowIso(),nowIso(),new Date(Date.parse(row.created_at)+SESSION_ABSOLUTE_SECONDS*1000).toISOString(),sessionId);
}

async function revokeByRefreshToken(refreshToken, reason) {
  if (!refreshToken) return;
  await db.transaction(async()=>{
    const tokenHash=sha256(refreshToken);
    const current=await db.prepare('SELECT id FROM sessions WHERE refresh_hash=?').get(tokenHash);
    const prior=current?null:await db.prepare('SELECT session_id FROM auth_refresh_history WHERE token_hash=?').get(tokenHash);
    const id=current?.id || prior?.session_id;
    if(id)await revokeSession(id,reason);
  })();
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

function cookieAttributes(req) {
  const attrs = [`Path=${COOKIE_PATH}`, 'HttpOnly', 'SameSite=Strict'];
  if (req.secure || process.env.APP_ENV==='production' || process.env.NODE_ENV==='production') attrs.push('Secure');
  return attrs;
}

function setRefreshCookie(req, res, refreshToken) {
  const attrs = cookieAttributes(req);
  attrs.push(`Max-Age=${SESSION_ABSOLUTE_SECONDS}`);
  res.append('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(refreshToken)}; ${attrs.join('; ')}`);
}

function clearRefreshCookie(req, res) {
  const attrs = cookieAttributes(req);
  attrs.push('Max-Age=0');
  res.append('Set-Cookie', `${COOKIE_NAME}=; ${attrs.join('; ')}`);
}

function readRefreshCookie(req) {
  return readCookie(req, COOKIE_NAME);
}

module.exports = {
  SESSION_IDLE_SECONDS,
  SESSION_ABSOLUTE_SECONDS,
  createSession,
  getSession,
  sessionProblem,
  touchSession,
  revokeSession,
  revokeAllSessions,
  upgradeSession,
  revokeByRefreshToken,
  rotateRefreshToken,
  setRefreshCookie,
  clearRefreshCookie,
  readRefreshCookie,
};
