// Email OTP starts the existing delayed recovery. It never grants a normal session.
const crypto=require('node:crypto');
const {db,nowIso}=require('../db');
const {AppError}=require('./errors');
const sec=require('./accountSecurity');
const verification=require('./emailVerification');
const PURPOSE='RECOVERY_EMAIL_OTP';
const MESSAGE='Nếu email này có tài khoản đủ điều kiện, yêu cầu mã đã được tiếp nhận. Hãy kiểm tra hộp thư và thư rác.';
const invalid=()=>new AppError(400,'RECOVERY_EMAIL_CODE_INVALID','Mã không đúng, đã hết hạn hoặc đã hết số lần thử. Hãy dùng mã mới nhất trong email.');
const digest=(userId,context,code)=>`${PURPOSE}:${userId}:${context.email}:${context.nonce}:${String(code)}`;
function locked(retry){const e=new AppError(429,'RECOVERY_EMAIL_CODE_LOCKED','Bước nhập mã khôi phục tạm khóa. Bạn có thể dùng liên kết xác nhận trong email hoặc thử lại khi hết thời gian chờ.');e.retryAfter=retry;return e;}
async function request(email){
  sec.assertMailConfigured();
  // Same quotas and response shape for known and unknown addresses.
  await sec.enforceLimit(`recovery-email-cooldown:${email}`,1,60);
  return db.transaction(async()=>{
    const now=Date.now(),expiresAt=sec.after(600);
    let requestToken=crypto.randomBytes(32).toString('base64url');
    const nextAt=await verification.reserveRecipient(email);
    const user=await db.prepare("SELECT * FROM users WHERE email=? AND email_verified_at IS NOT NULL AND is_active=1 AND account_status='ACTIVE'").get(email);
    if(user&&!nextAt){
      const code=sec.newCode(),context={email:user.email,nonce:crypto.randomBytes(16).toString('hex')};
      context.codeHash=sec.secretHash(digest(user.id,context,code));
      // Resending invalidates both old OTPs and the alternative start links.
      await db.prepare("UPDATE auth_links SET used_at=? WHERE user_id=? AND purpose IN ('RECOVERY_EMAIL_OTP','RECOVERY_START') AND used_at IS NULL").run(nowIso(),user.id);
      requestToken=await sec.makeLink(user.id,PURPOSE,600,context);
      const link=await sec.makeLink(user.id,'RECOVERY_START',1800,{email:user.email});
      await sec.queueMail(user,'Xác nhận yêu cầu khôi phục Enclave',
        `Mã xác nhận khôi phục của bạn: ${code}. Mã có hiệu lực 10 phút.\nNhập mã trên Enclave và bấm Xác nhận để bắt đầu thời gian chờ 24 giờ. Yêu cầu gửi mã chưa thay đổi tài khoản.\nHoặc mở liên kết và bấm Xác nhận: ${sec.linkUrl('recovery-start',link)}\nNếu không phải bạn, hãy bỏ qua email này. Không chia sẻ mã với người khác.`,user.email,{expiresAt});
      await sec.audit(user.id,'RECOVERY_EMAIL_REQUESTED');
    }
    return {message:MESSAGE,requestToken,emailMask:sec.maskEmail(email),serverNow:new Date(now).toISOString(),
      expiresAt,nextRequestAt:new Date(Math.max(now+60000,nextAt)).toISOString()};
  })();
}
async function verify(requestToken,code,startRecovery){
  const result=await db.transaction(async()=>{
    let link;
    try{link=await sec.getLink(requestToken,PURPOSE);}catch(e){if(e.code==='LINK_INVALID')return {error:invalid()};throw e;}
    const context=JSON.parse(link.context_data);
    const user=await db.prepare("SELECT * FROM users WHERE id=? AND email=? AND email_verified_at IS NOT NULL AND is_active=1 AND account_status='ACTIVE'").get(link.user_id,context.email);
    if(!user)return {error:invalid()};
    const retry=await verification.gate(user.id);
    if(retry)return {error:locked(retry)};
    const bucket=sec.hash(`recovery-otp-failed:${link.id}`);
    const attempts=await db.prepare('SELECT count,reset_at FROM auth_limits WHERE bucket_key=?').get(bucket);
    if(attempts&&attempts.count>=5&&Number(attempts.reset_at)>Date.now())return {error:invalid()};
    if(!/^\d{6}$/.test(String(code))||!sec.verifySecret(digest(user.id,context,code),context.codeHash)){
      await sec.takeLimit(`recovery-otp-failed:${link.id}`,5,Math.max(1,Date.parse(link.expires_at)-Date.now()));
      const daily=await verification.recordFailure(user,null);
      return {error:daily?locked(await verification.gate(user.id)):invalid()};
    }
    await sec.consumeLink(link);
    const recovery=await startRecovery(user.id);
    await sec.audit(user.id,'RECOVERY_EMAIL_CODE_VERIFIED');
    return {recovery};
  })();
  // Throw after commit so wrong-attempt counters cannot be rolled back by the error.
  if(result.error)throw result.error;
  return result.recovery;
}
module.exports={request,verify};
