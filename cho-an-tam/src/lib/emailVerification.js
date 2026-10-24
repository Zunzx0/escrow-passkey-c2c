const {db,uuid,nowIso}=require('../db');
const {AppError}=require('./errors');
const sec=()=>require('./accountSecurity');
const DAY=86400000, HOUR=3600000;
const MESSAGE='Yêu cầu mã đã được tiếp nhận. Hãy kiểm tra hộp thư và thư rác; nếu đã có tài khoản với email này, hãy đăng nhập hoặc khôi phục tài khoản.';
function problem(code,message,retryAfter) {
  const e=new AppError(retryAfter?429:400,code,message);
  if(retryAfter)e.retryAfter=retryAfter;
  return e;
}
function metadata(user,row,nextAt=0) {
  const now=Date.now();
  const next=Math.max(nextAt,row?Date.parse(row.sent_at)+60000:now);
  const result={serverNow:new Date(now).toISOString(),nextRequestAt:new Date(next).toISOString(),expiresAt:row?.expires_at||null,
    resendAfterSeconds:Math.max(0,Math.ceil((next-now)/1000)),emailMask:sec().maskEmail(user.email)};
  return {...result,verification:result,message:MESSAGE};
}
// Called inside the same serialized write transaction as the outbox insertion.
async function reserveRecipient(email) {
  const now=Date.now(),key=sec().hash(sec().normalizeEmail(email));
  const recent=await db.prepare('SELECT sent_at FROM auth_email_sends WHERE recipient_hash=? AND sent_at>? ORDER BY sent_at').all(key,now-HOUR);
  if(recent.length>=5)return Number(recent[0].sent_at)+HOUR;
  await db.prepare('INSERT INTO auth_email_sends(id,recipient_hash,sent_at) VALUES(?,?,?)').run(uuid(),key,now);
  return 0;
}
async function linkFor(user,row) {
  return sec().makeLink(user.id,'VERIFY_EMAIL',Math.max(1,Math.floor((Date.parse(row.expires_at)-Date.now())/1000)),{email:user.email,codeHash:row.code_hash});
}
async function send(user,{resend=false,force=false,ensure=false,initial=false}={}) {
  return db.transaction(async()=>{
    if(!user.email || (user.email_verified_at&&!force))return metadata(user,null);
    const s=sec(),now=Date.now();
    const previous=await db.prepare('SELECT * FROM auth_email_codes WHERE user_id=?').get(user.id);
    const same=previous?.email===user.email;
    if(ensure&&same&&Date.parse(previous.expires_at)>now&&previous.attempts<5)return metadata(user,previous);
    if(same&&Date.parse(previous.sent_at)+60000>now) {
      if(initial||ensure||!resend)return metadata(user,previous);
      throw problem('EMAIL_RESEND_WAIT','Vui lòng đợi đủ thời gian trước khi yêu cầu lại mã.',Math.ceil((Date.parse(previous.sent_at)+60000-now)/1000));
    }
    const nextAt=await reserveRecipient(user.email);
    if(nextAt) {
      if(initial||ensure)return metadata(user,same?previous:null,nextAt);
      throw problem('EMAIL_SEND_LIMIT','Đã đạt giới hạn yêu cầu email. Vui lòng thử lại sau.',Math.max(1,Math.ceil((nextAt-now)/1000)));
    }
    const owner=await db.prepare('SELECT * FROM users WHERE email=? AND email_verified_at IS NOT NULL AND id<>?').get(user.email,user.id);
    const code=s.newCode(),sentAt=nowIso(),expiresAt=s.after(600);
    const codeHash=s.secretHash(`${user.id}:${user.email}:${code}`);
    await db.prepare('INSERT INTO auth_email_codes(user_id,code_hash,email,expires_at,attempts,sent_at) VALUES(?,?,?,?,0,?) ON CONFLICT(user_id) DO UPDATE SET code_hash=excluded.code_hash,email=excluded.email,expires_at=excluded.expires_at,attempts=0,sent_at=excluded.sent_at')
      .run(user.id,codeHash,user.email,expiresAt,sentAt);
    await db.prepare("UPDATE auth_links SET used_at=? WHERE user_id=? AND purpose='VERIFY_EMAIL' AND used_at IS NULL").run(sentAt,user.id);
    const row={code_hash:codeHash,sent_at:sentAt,expires_at:expiresAt};
    if(owner) {
      // Same public response and quota; never issue proof or expose the email's owner.
      await s.queueMail(owner,'Enclave: có yêu cầu đăng ký bằng email của bạn','Có người vừa thử đăng ký bằng email này. Nếu là bạn, hãy đăng nhập hoặc khôi phục tài khoản. Không chia sẻ mã hoặc xác nhận cho tài khoản không phải của bạn.');
    } else {
      const token=await linkFor(user,row);
      const name=/^[a-z0-9][a-z0-9._-]{1,30}[a-z0-9]$/.test(user.username)?`@${user.username}`:'tài khoản đang yêu cầu';
      await s.queueMail(user,'Mã xác minh email Enclave',`Yêu cầu xác minh cho tài khoản ${name}.\nMã xác minh của bạn: ${code}. Mã có hiệu lực 10 phút.\nHoặc mở liên kết, đăng nhập đúng tài khoản và bấm Xác nhận: ${s.linkUrl('verify-email',token)}\nChỉ xác nhận yêu cầu của chính bạn. Không chia sẻ mã với người khác.`,user.email,{expiresAt});
    }
    return metadata(user,row);
  })();
}
async function gate(userId) {
  const now=Date.now();
  const failures=await db.prepare('SELECT failed_at FROM auth_otp_failures WHERE user_id=? AND failed_at>? ORDER BY failed_at').all(userId,now-DAY);
  const lock=await db.prepare('SELECT locked_until FROM auth_otp_locks WHERE user_id=?').get(userId);
  const until=Math.max(Number(lock?.locked_until||0),failures.length>=20?Number(failures[failures.length-20].failed_at)+DAY:0);
  return Math.max(0,Math.ceil((until-now)/1000));
}
function locked(retry) {return problem('OTP_DAILY_LOCKED','Bước nhập mã đã tạm khóa để bảo vệ tài khoản. Bạn vẫn có thể đăng nhập, xem hàng hoặc xác minh bằng liên kết trong email.',retry);}
async function failed(user,row) {
  const now=Date.now();
  await db.prepare('INSERT INTO auth_otp_failures(id,user_id,failed_at) VALUES(?,?,?)').run(uuid(),user.id,now);
  const count=(await db.prepare('SELECT COUNT(*) AS n FROM auth_otp_failures WHERE user_id=? AND failed_at>?').get(user.id,now-DAY)).n;
  if(count<20)return null;
  await db.prepare('INSERT INTO auth_otp_locks(user_id,locked_until) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET locked_until=excluded.locked_until').run(user.id,now+HOUR);
  await sec().audit(user.id,'OTP_DAILY_LOCKED',{limit:20,windowSeconds:86400});
  // One notice per transition; shared recipient budget prevents spam through many BASIC accounts.
  if(user.email && !(await reserveRecipient(user.email))) {
    let body=`Có nhiều lần nhập mã sai cho tài khoản @${user.username}. Đăng nhập và xem hàng vẫn hoạt động. Hãy kiểm tra bảo mật nếu đây không phải thao tác của bạn.`;
    if(row){const token=await linkFor(user,row);body+=` Nếu đây là tài khoản của bạn, có thể xác minh bằng liên kết: ${sec().linkUrl('verify-email',token)}. Chỉ xác nhận cho tài khoản của chính bạn.`;}
    await sec().queueMail(user,'Enclave: bước nhập mã xác minh đã tạm khóa',body,user.email,{expiresAt:row?.expires_at||sec().after(3600)});
  }
  return locked(await gate(user.id));
}
async function eligible(userId) {
  const user=await db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  if(!user?.is_active||!['BASIC','VERIFIED','PENDING_EMAIL','PENDING_PASSKEY'].includes(user.account_status))return null;
  if(await db.prepare('SELECT 1 FROM users WHERE id<>? AND email=? AND email_verified_at IS NOT NULL').get(userId,user.email))return null;
  return user;
}
async function markVerified(user) {
  const time=nowIso();
  await db.prepare("UPDATE users SET email_verified_at=?,account_status='VERIFIED',updated_at=? WHERE id=?").run(time,time,user.id);
  await db.prepare('DELETE FROM auth_email_codes WHERE user_id=?').run(user.id);
  await db.prepare('UPDATE auth_registration_flows SET used_at=? WHERE user_id=? AND used_at IS NULL').run(time,user.id);
  await db.prepare("UPDATE auth_links SET used_at=? WHERE user_id=? AND purpose='VERIFY_EMAIL' AND used_at IS NULL").run(time,user.id);
}
async function verify(userId,code) {
  const error=await db.transaction(async()=>{
    const retry=await gate(userId);if(retry)return locked(retry);
    const user=await eligible(userId);
    const row=await db.prepare('SELECT * FROM auth_email_codes WHERE user_id=?').get(userId);
    if(!user||!row||row.email!==user.email||Date.parse(row.expires_at)<=Date.now()||row.attempts>=5)return problem('EMAIL_CODE_INVALID','Mã không đúng, hết hạn hoặc đã nhập sai quá nhiều lần. Hãy yêu cầu mã mới hoặc dùng liên kết trong email.');
    if(!sec().verifySecret(`${userId}:${user.email}:${String(code)}`,row.code_hash)) {
      const changed=await db.prepare('UPDATE auth_email_codes SET attempts=attempts+1 WHERE user_id=? AND code_hash=? AND attempts<5 AND expires_at>?').run(userId,row.code_hash,nowIso());
      if(changed.changes!==1)return problem('EMAIL_CODE_INVALID','Mã không còn sử dụng được.');
      const cap=await failed(user,row);if(cap)return cap;
      return problem('EMAIL_CODE_INVALID',`Mã không đúng. Bạn còn ${Math.max(0,4-row.attempts)} lần thử cho mã này.`);
    }
    await markVerified(user);
    await require('./session').revokeAllSessions(userId,'ENROLLMENT_EMAIL_VERIFIED');
    await sec().audit(userId,'EMAIL_VERIFIED');
    return null;
  })();
  if(error)throw error;
}
async function readLink(token) {
  const link=await sec().getLink(token,'VERIFY_EMAIL'),context=JSON.parse(link.context_data);
  const user=await eligible(link.user_id);
  const row=await db.prepare('SELECT * FROM auth_email_codes WHERE user_id=?').get(link.user_id);
  if(!user||!row||context.email!==user.email||row.email!==user.email||context.codeHash!==row.code_hash||Date.parse(row.expires_at)<=Date.now())throw problem('LINK_INVALID','Liên kết không hợp lệ hoặc đã hết hạn.');
  return {link,user};
}
async function preview(token) {
  const {link,user}=await readLink(token);
  return {username:user.username,emailMask:sec().maskEmail(user.email),expiresAt:link.expires_at};
}
async function confirm(auth,token,{device='',ip=''}={}) {
  return db.transaction(async()=>{
    const {link,user}=await readLink(token);
    if(user.id!==auth.id || auth.authMethod!=='password' || auth.scope!=='full')throw new AppError(403,'EMAIL_ACCOUNT_MISMATCH','Hãy đăng nhập bằng mật khẩu của đúng tài khoản trong liên kết rồi xác nhận.');
    const session=await require('./session').getSession(auth.sessionId);
    if(require('./session').sessionProblem(session)||session.user_id!==user.id)throw new AppError(401,'UNAUTHENTICATED','Phiên đăng nhập đã hết hạn.');
    await sec().consumeLink(link);
    await markVerified(user);
    const updated=await db.prepare('UPDATE sessions SET enrollment_verified_at=? WHERE id=? AND revoked_at IS NULL').run(nowIso(),session.id);
    if(updated.changes!==1)throw new AppError(401,'UNAUTHENTICATED','Phiên xác nhận đã bị thu hồi. Hãy đăng nhập lại.');
    await sec().audit(user.id,'EMAIL_VERIFIED_LINK',{sessionId:session.id,device:String(device).slice(0,200),ip:String(ip).slice(0,80)});
    return db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
  })();
}
module.exports={send,verify,preview,confirm,gate,recordFailure:failed,reserveRecipient,MESSAGE};
