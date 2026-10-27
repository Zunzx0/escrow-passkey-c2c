const crypto = require('crypto');
const { db, uuid, nowIso } = require('../db');
const { AppError } = require('./errors');
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const keys = require('./authKeys');
const secretHash = value => keys.digest(value);
const verifySecret = (value, stored) => keys.matches(value, stored);
const after = seconds => new Date(Date.now() + seconds * 1000).toISOString();
const normalizeEmail = value => String(value || '').trim().normalize('NFC').toLowerCase();
function validEmail(value) {
  return value.includes('@') && require('./username').isValidUsername(value);
}
function maskEmail(value) { const [a,b] = String(value || '').split('@'); return b ? `${a.slice(0,2)}***@${b}` : ''; }
const reserved = new Set(['admin','support','enclave','root','system','moderator']);
function validateRegistration({ email, username, displayName, password }) {
  const e = normalizeEmail(email), u = String(username || '').trim().toLowerCase();
  const name = String(displayName || '').trim().replace(/\s+/g, ' ');
  if (!validEmail(e)) throw new AppError(400, 'INVALID_EMAIL', 'Hãy nhập email hợp lệ, tối đa 254 ký tự.');
  if (!/^[a-z0-9](?:[a-z0-9]|[._-](?=[a-z0-9])){1,30}[a-z0-9]$/.test(u) || reserved.has(u)) {
    throw new AppError(400, 'INVALID_USERNAME', 'Tên đăng nhập gồm 3–32 chữ thường, số, . _ -; không đặt dấu ở đầu, cuối hoặc liền nhau và không dùng tên dành riêng.');
  }
  const folded = name.normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/đ/gi,'d').toLowerCase();
  if ([...name].length < 2 || [...name].length > 40 || /[@\u0000-\u001f\u007f]/.test(name) || /\b(admin|support|enclave|root|system|moderator)\b|ho tro|quan tri/.test(folded)) {
    throw new AppError(400, 'INVALID_DISPLAY_NAME', 'Tên hiển thị từ 2–40 ký tự, không dùng email hoặc tên giả mạo quản trị, hỗ trợ.');
  }
  require('./password').assertPasswordPolicy(password, { username:u, email:e });
  return { email:e, username:u, displayName:name };
}

// Atomic, persistent buckets shared by all server processes. Do not put PII in keys.
async function takeLimit(key, limit, windowMs) {
  const now = Date.now(), bucket = hash(key);
  return db.transaction(async () => {
    let row = await db.prepare('SELECT * FROM auth_limits WHERE bucket_key=?').get(bucket);
    if (!row || Number(row.reset_at) <= now) {
      await db.prepare('INSERT INTO auth_limits(bucket_key,count,reset_at) VALUES(?,1,?) ON CONFLICT(bucket_key) DO UPDATE SET count=1,reset_at=excluded.reset_at').run(bucket,now+windowMs);
      return 0;
    }
    if (row.count >= limit) return Math.max(1,Math.ceil((Number(row.reset_at)-now)/1000));
    await db.prepare('UPDATE auth_limits SET count=count+1 WHERE bucket_key=?').run(bucket);
    return 0;
  })();
}
async function enforceLimit(key, limit, seconds) {
  const retry = await takeLimit(key,limit,seconds*1000);
  if (retry) { const e = new AppError(429,'RATE_LIMITED',`Thử quá nhiều lần. Vui lòng đợi ${retry} giây.`); e.retryAfter = retry; throw e; }
}
async function audit(userId, action, detail={}) {
  await db.prepare('INSERT INTO auth_audit(id,user_id,action,detail,created_at) VALUES(?,?,?,?,?)').run(uuid(),userId,action,JSON.stringify(detail),nowIso());
}
const encryptMail = body => keys.encrypt(body);
const decryptMail = body => keys.decrypt(body);
function mailConfigured() { return !!(process.env.RESEND_API_KEY && process.env.AUTH_EMAIL_FROM && process.env.AUTH_PUBLIC_URL); }
function assertMailConfigured() {
  if (process.env.AUTH_EMAIL_TRANSPORT==='test' && process.env.APP_ENV==='test') return;
  if (!mailConfigured()) throw new AppError(503,'EMAIL_NOT_CONFIGURED','Email xác minh chưa được cấu hình. Vui lòng liên hệ quản trị viên.');
}
async function queueMail(user, subject, body, recipient=user.email, {expiresAt=null}={}) {
  if (!recipient) return;
  const now=nowIso();
  await db.prepare('INSERT INTO auth_email_outbox(id,user_id,recipient,subject,body_cipher,next_attempt_at,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(uuid(),user.id,recipient,subject,encryptMail(body),now,now,expiresAt || after(86400));
}
async function securityNotice(userId, action, text) {
  const user=await db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  if (!user) return;
  await audit(userId,action);
  if (user.email_verified_at) await queueMail(user,`Enclave: ${text}`,`${text}. Nếu không phải bạn, hãy đăng nhập bằng Passkey và kiểm tra bảo mật tài khoản.`);
}
function linkUrl(purpose, token) {
  const base = new URL(process.env.AUTH_PUBLIC_URL || 'http://localhost:3000/');
  // Hash parameters are not sent to HTTP access logs or Referer headers.
  base.hash=`/account-action?purpose=${encodeURIComponent(purpose)}&token=${encodeURIComponent(token)}`;
  return base.toString();
}
async function makeLink(userId,purpose,seconds,context={}) {
  const token=crypto.randomBytes(32).toString('base64url');
  await db.prepare('INSERT INTO auth_links(id,user_id,token_hash,purpose,context_data,expires_at,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(uuid(),userId,hash(token),purpose,JSON.stringify(context),after(seconds),nowIso());
  return token;
}
async function getLink(token,purpose) {
  if (typeof token!=='string' || token.length>100) throw new AppError(400,'LINK_INVALID','Liên kết không hợp lệ hoặc đã hết hạn.');
  const row=await db.prepare('SELECT * FROM auth_links WHERE token_hash=? AND purpose=? AND used_at IS NULL AND expires_at>?').get(hash(token),purpose,nowIso());
  if (!row) throw new AppError(400,'LINK_INVALID','Liên kết không hợp lệ hoặc đã hết hạn.');
  return row;
}
async function consumeLink(row) {
  if ((await db.prepare('UPDATE auth_links SET used_at=? WHERE id=? AND used_at IS NULL AND expires_at>?').run(nowIso(),row.id,nowIso())).changes!==1) throw new AppError(400,'LINK_INVALID','Liên kết đã được dùng hoặc hết hạn.');
}
function newCode() { return String(crypto.randomInt(0,1000000)).padStart(6,'0'); }
async function sendVerification(user,options={}) { return require('./emailVerification').send(user,options); }
async function verifyEmailCode(userId,code) { return require('./emailVerification').verify(userId,code); }
async function generateRecoveryCodes(userId) {
  const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const codes=Array.from({length:8},()=>Array.from({length:10},()=>alphabet[crypto.randomInt(alphabet.length)]).join('')).map(v=>`${v.slice(0,5)}-${v.slice(5)}`);
  await db.prepare('DELETE FROM auth_recovery_codes WHERE user_id=?').run(userId);
  for(const code of codes) await db.prepare('INSERT INTO auth_recovery_codes(id,user_id,code_hash,created_at) VALUES(?,?,?,?)').run(uuid(),userId,secretHash(`${userId}:${code}`),nowIso());
  await db.prepare('UPDATE users SET recovery_acknowledged=0 WHERE id=?').run(userId);
  return codes;
}
async function ensureUserHandle(user) {
  if (!user.webauthn_user_id) {
    await db.prepare('UPDATE users SET webauthn_user_id=? WHERE id=? AND webauthn_user_id IS NULL').run(crypto.randomBytes(32).toString('base64url'),user.id);
    user.webauthn_user_id=(await db.prepare('SELECT webauthn_user_id FROM users WHERE id=?').get(user.id)).webauthn_user_id;
  }
  return new Uint8Array(Buffer.from(user.webauthn_user_id,'base64url'));
}
async function registrationIdentity(user,{replaceExisting=false}={}) {
  // Never exclude another account's credentials. Recovery replaces old keys only at commit.
  const own=replaceExisting?[]:await db.prepare('SELECT credential_id,transports FROM passkey_credentials WHERE user_id=?').all(user.id);
  return {
    userName:user.username,
    userDisplayName:`@${user.username} · ${user.display_name}`,
    userID:await ensureUserHandle(user),
    excludeCredentials:own.map(c=>({id:c.credential_id,transports:JSON.parse(c.transports||'[]')})),
  };
}
function assertEnrollmentProof(user,auth) {
  if(user.role==='ADMIN') return; // Existing audited bootstrap path has its own provenance checks.
  if(!user.email_verified_at || !auth.enrollmentVerifiedAt || Date.parse(auth.enrollmentVerifiedAt)+1800000<=Date.now()) throw new AppError(403,'EMAIL_VERIFICATION_REQUIRED','Hãy xác minh email trong phiên kích hoạt ví này trước khi tạo Passkey đầu tiên.');
}
async function assertMoneyAllowed(userId,action) {
  const user=await db.prepare('SELECT account_status,recovery_restricted_until,is_active FROM users WHERE id=?').get(userId);
  if(!user?.is_active || !['ACTIVE','RECOVERING'].includes(user.account_status)) throw new AppError(403,'USER_INACTIVE','Tài khoản chưa sẵn sàng thực hiện giao dịch tiền.');
  if (user?.account_status==='RECOVERING' || (user?.recovery_restricted_until && Date.parse(user.recovery_restricted_until)>Date.now())) {
    throw new AppError(403,'RECOVERY_MONEY_RESTRICTED','Tài khoản đang trong thời gian bảo vệ sau yêu cầu khôi phục. Chưa thể khóa tiền thanh toán, giải ngân hoặc phân xử tiền. Các thao tác nhận hàng, kiểm hàng, báo vấn đề và nhận hoàn tiền vẫn được phép.');
  }
}
async function assertReauthAvailable(userId,{count=true}={}) {
  const blocked=await db.prepare('SELECT count,reset_at FROM auth_limits WHERE bucket_key=?').get(hash(`reauth-failed:${userId}`));
  if(blocked && blocked.count>=3 && Number(blocked.reset_at)>Date.now()) throw new AppError(429,'REAUTH_TEMPORARILY_LOCKED','Xác thực thất bại quá nhiều lần. Vui lòng đợi 5 phút.');
  if(count) await enforceLimit(`reauth-options:${userId}`,Number(process.env.REAUTH_REQUESTS_PER_MINUTE||5),60);
}
async function recordReauthFailure(userId) { await takeLimit(`reauth-failed:${userId}`,3,300000); }
async function clearReauthFailures(userId) { await db.prepare('DELETE FROM auth_limits WHERE bucket_key=?').run(hash(`reauth-failed:${userId}`)); }
async function updateCredentialMetadata(id,info){
  if(typeof info?.credentialBackedUp!=='boolean'||!info.credentialDeviceType)return;
  await db.prepare('UPDATE passkey_credentials SET backup_eligible=?,backed_up=? WHERE id=?').run(info.credentialDeviceType==='multiDevice'?1:0,info.credentialBackedUp?1:0,id);
}
module.exports={hash,secretHash,verifySecret,after,normalizeEmail,validEmail,maskEmail,validateRegistration,takeLimit,enforceLimit,audit,queueMail,securityNotice,assertMailConfigured,decryptMail,mailConfigured,linkUrl,makeLink,getLink,consumeLink,newCode,sendVerification,verifyEmailCode,generateRecoveryCodes,ensureUserHandle,registrationIdentity,assertEnrollmentProof,assertMoneyAllowed,assertReauthAvailable,recordReauthFailure,clearReauthFailures,updateCredentialMetadata};
