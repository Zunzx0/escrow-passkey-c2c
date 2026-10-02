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
const TOUCH_EVERY_MS = 60 * 1000;

const COOKIE_NAME = 'cat_rt';
const COOKIE_PATH = '/api/passkeys/session';

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function newRefreshToken() {
  return crypto.randomBytes(32).toString('base64url');
}

async function createSession(userId) {
  const id = uuid();
  const refreshToken = newRefreshToken();
  const now = new Date();
  await db.prepare(
    `INSERT INTO sessions (id, user_id, refresh_hash, created_at, last_seen_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    userId,
    sha256(refreshToken),
    now.toISOString(),
    now.toISOString(),
    new Date(now.getTime() + SESSION_ABSOLUTE_SECONDS * 1000).toISOString()
  );
  return { sessionId: id, refreshToken };
}

/** Lý do phiên không dùng được, hoặc null nếu phiên còn hiệu lực. */
function sessionProblem(row, now = Date.now()) {
  if (!row) return 'NOT_FOUND';
  if (row.revoked_at) return 'REVOKED';
  if (new Date(row.expires_at).getTime() <= now) return 'EXPIRED';
  if (new Date(row.last_seen_at).getTime() + SESSION_IDLE_SECONDS * 1000 <= now) return 'IDLE';
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
  const row = await db.prepare('SELECT * FROM sessions WHERE refresh_hash = ?').get(sha256(refreshToken));
  const problem = sessionProblem(row);
  if (problem) return { problem };

  const next = newRefreshToken();
  const now = nowIso();
  const changed = (await db
    .prepare('UPDATE sessions SET refresh_hash = ?, last_seen_at = ? WHERE id = ? AND refresh_hash = ? AND revoked_at IS NULL')
    .run(sha256(next), now, row.id, sha256(refreshToken))).changes;
  // Hai lần làm mới đồng thời bằng cùng một mã: chỉ một lần thắng, lần kia coi như mã đã cũ.
  if (changed !== 1) return { problem: 'REUSED' };
  return { session: { ...row, last_seen_at: now }, refreshToken: next };
}

async function revokeByRefreshToken(refreshToken, reason) {
  if (!refreshToken) return;
  await db.prepare('UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE refresh_hash = ? AND revoked_at IS NULL')
    .run(nowIso(), reason, sha256(refreshToken));
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
  if (req.secure) attrs.push('Secure');
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
  revokeByRefreshToken,
  rotateRefreshToken,
  setRefreshCookie,
  clearRefreshCookie,
  readRefreshCookie,
};
