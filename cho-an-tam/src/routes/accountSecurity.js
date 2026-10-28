const express=require('express');
const {db,uuid,nowIso}=require('../db');
const sec=require('../lib/accountSecurity');
const {AppError}=require('../lib/errors');
const {hashPassword,verifyPassword,assertPasswordPolicy,burnVerify}=require('../lib/password');
const {requireAuth,requireEnrollAuth,startSession,signAccessToken,loadUserFromToken,scopeForStatus}=require('../lib/auth');
const {revokeAllSessions,revokeSession,upgradeSession,setRefreshCookie}=require('../lib/session');
const {ACTIONS,requireGrant,markGrantUsed}=require('../lib/reauth');
const {generateRegistrationOptions,verifyRegistrationResponse}=require('../lib/webauthnRegistration');
const {RP_ID,ORIGIN}=require('../lib/webauthnConfig');
const crypto=require('crypto');
const router=express.Router();
const publicLimiter=require('../lib/rateLimit').rateLimit({perMinute:Number(process.env.RATE_LIMIT_AUTH_PER_MINUTE||10)});
const wrap=fn=>async(req,res,next)=>{try {await fn(req,res);} catch(e){if(e.retryAfter) res.set('Retry-After',String(e.retryAfter));next(e);}};
const generic='Nếu email này có tài khoản, chúng tôi đã gửi hướng dẫn. Vui lòng kiểm tra hộp thư và thư rác.';
async function freshSession(req,res,user,method='password',scope=scopeForStatus(user.account_status),emailProof=false,deferCookie=false) {
  const {token,sessionId,refreshToken}=await startSession(req,res,user,scope,method,{deferCookie});
  if(emailProof) await db.prepare('UPDATE sessions SET enrollment_verified_at=? WHERE id=?').run(nowIso(),sessionId);
  const payload={token,scope,user:{id:user.id,username:user.username,displayName:user.display_name,role:user.role,accountStatus:user.account_status,email:user.email,emailVerified:!!user.email_verified_at,emailProofFresh:emailProof,recoveryAcknowledged:!!user.recovery_acknowledged,authMethod:method,sessionId}};
  // Never serialize a refresh token. Deferring the header prevents rollback from replacing a valid cookie.
  if(deferCookie)Object.defineProperty(payload,'commitCookie',{value:()=>setRefreshCookie(req,res,refreshToken),enumerable:false});
  return payload;
}
async function makeVerificationFlow(user,display={}) {
  const id=uuid(),token='vrf_'+crypto.randomBytes(32).toString('base64url');
  const emailMask=sec.maskEmail(display.email || user?.email || '');
  await db.prepare('INSERT INTO auth_registration_flows(id,token_hash,user_id,email_mask,expires_at) VALUES(?,?,?,?,?)').run(id,sec.hash(token),user?.id || null,emailMask,sec.after(86400));
  return {token,scope:'verify',nextStep:'VERIFY_EMAIL',user:{id,username:display.username||user?.username,displayName:display.displayName||user?.display_name,role:'BUYER',accountStatus:'PENDING_EMAIL',emailMask},emailMask,resendAfterSeconds:60,message:'Đã gửi mã xác minh. Hãy kiểm tra hộp thư và thư rác.'};
}
async function verificationUser(req) {
  const token=String(req.body?.registrationToken || req.headers.authorization?.replace(/^Bearer /,'') || '');
  if(token.startsWith('vrf_')) {
    const flow=await db.prepare('SELECT * FROM auth_registration_flows WHERE token_hash=? AND used_at IS NULL AND expires_at>?').get(sec.hash(token),nowIso());
    if(!flow) throw new AppError(401,'VERIFICATION_SESSION_EXPIRED','Phiên xác minh hết hạn. Hãy đăng nhập lại để tiếp tục.');
    const user=flow.user_id ? await db.prepare('SELECT * FROM users WHERE id=?').get(flow.user_id) : null;
    if(user && !['BASIC','VERIFIED','PENDING_EMAIL','PENDING_PASSKEY'].includes(user.account_status)) throw new AppError(401,'VERIFICATION_SESSION_EXPIRED','Tài khoản đã hoàn tất thiết lập. Hãy đăng nhập lại.');
    return {flow,user};
  }
  let auth;try{auth=await loadUserFromToken(token);}catch{}
  if(!auth || !['BASIC','VERIFIED','PENDING_EMAIL'].includes(auth.accountStatus)) throw new AppError(401,'VERIFICATION_SESSION_EXPIRED','Hãy đăng nhập để xác minh email.');
  return {user:await db.prepare('SELECT * FROM users WHERE id=?').get(auth.id),sessionId:auth.sessionId};
}
router.post('/register/account',wrap(async(req,res)=>{
  sec.assertMailConfigured();
  const input=sec.validateRegistration(req.body || {});
  await sec.enforceLimit(`register-ip:${req.ip}`,Number(process.env.AUTH_REGISTER_PER_IP_HOUR||5),3600);
  await sec.enforceLimit(`register-email:${input.email}`,3,3600);
  const passwordHash=hashPassword(req.body.password);
  const result=await db.transaction(async()=>{
    if(await db.prepare('SELECT id FROM users WHERE username=?').get(input.username)) throw new AppError(409,'USERNAME_TAKEN','Tên đăng nhập đã có người dùng. Hãy chọn tên khác.');
    const user={id:uuid(),...input};
    const now=nowIso();
    await db.prepare("INSERT INTO users(id,username,display_name,role,password_hash,account_status,created_at,updated_at,email,webauthn_user_id) VALUES(?,?,?,'BUYER',?,'BASIC',?,?,?,?)")
      .run(user.id,input.username,input.displayName,passwordHash,now,now,input.email,crypto.randomBytes(32).toString('base64url'));
    const row=await db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
    const verification=await sec.sendVerification(row,{initial:true});
    const session=await freshSession(req,res,row,'password','full',false,true);
    return {session,verification};
  })();
  result.session.commitCookie();
  res.status(201).json({...result.session,...result.verification,message:'Tài khoản đã tạo. Bạn có thể xem hàng ngay; hãy kiểm tra email để xác minh trước khi mở ví.'});
}));
router.get('/username-availability',wrap(async(req,res)=>{
  await sec.enforceLimit(`username-check:${req.ip}`,15,60);
  const name=String(req.query.username||'').trim().toLowerCase();
  res.json({available:!!name && !(await db.prepare('SELECT 1 FROM users WHERE username=?').get(name))});
}));
router.post('/email/enroll/request',requireEnrollAuth,wrap(async(req,res)=>{
  sec.assertMailConfigured();
  if(!['BASIC','PENDING_PASSKEY'].includes(req.user.accountStatus) || req.user.role==='ADMIN') throw new AppError(409,'INVALID_ACCOUNT_STATUS','Email đã xác minh chỉ đổi được qua quy trình bảo mật.');
  const email=sec.normalizeEmail(req.body.email);
  if(!sec.validEmail(email)) throw new AppError(400,'INVALID_EMAIL','Hãy nhập email hợp lệ.');
  await sec.enforceLimit(`legacy-email:${req.user.id}`,3,3600);
  const result=await db.transaction(async()=>{
    const changed=await db.prepare("UPDATE users SET email=?,account_status='BASIC',updated_at=? WHERE id=? AND email_verified_at IS NULL AND account_status IN ('BASIC','PENDING_PASSKEY')").run(email,nowIso(),req.user.id);
    if(changed.changes!==1)throw new AppError(409,'INVALID_ACCOUNT_STATUS','Email đã được xác minh. Hãy tải lại trang.');
    const user=await db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
    return sec.sendVerification(user,{initial:true});
  })();res.json(result);
}));
router.post('/email/verify',publicLimiter,wrap(async(req,res)=>{
  const {flow,user,sessionId}=await verificationUser(req);
  await sec.enforceLimit(`otp-flow:${flow?.id || user.id}`,30,600);
  if(!user) { sec.secretHash(req.body.code||''); throw new AppError(400,'EMAIL_CODE_INVALID','Mã không đúng hoặc hết hạn. Hãy kiểm tra email hoặc đăng nhập nếu đã có tài khoản.'); }
  await sec.verifyEmailCode(user.id,req.body.code);
  if(flow) await db.prepare('UPDATE auth_registration_flows SET used_at=? WHERE id=?').run(nowIso(),flow.id);
  const fresh=await db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
  if(sessionId) await revokeSession(sessionId,'EMAIL_VERIFIED');
  res.json({...await freshSession(req,res,fresh,'password',scopeForStatus(fresh.account_status),true),nextStep:null});
}));
router.post('/email/resend',publicLimiter,wrap(async(req,res)=>{
  sec.assertMailConfigured();
  const {flow,user}=await verificationUser(req);
  if(!user) return res.json({message:require('../lib/emailVerification').MESSAGE,resendAfterSeconds:60,nextRequestAt:sec.after(60),serverNow:nowIso(),expiresAt:null});
  const result=await sec.sendVerification(user,{resend:true,force:true,ensure:req.body.ensure===true});
  res.json(result);
}));
router.post('/email/link/preview',publicLimiter,wrap(async(req,res)=>{
  res.json(await require('../lib/emailVerification').preview(req.body.token));
}));
router.post('/email/link/confirm',requireAuth,wrap(async(req,res)=>{
  const user=await require('../lib/emailVerification').confirm(req.user,req.body.token,{device:req.headers['user-agent'],ip:req.ip});
  res.json({verified:true,message:'Email đã được xác minh. Bạn có thể chủ động tiếp tục kích hoạt ví.',user:{id:user.id,username:user.username,displayName:user.display_name,role:user.role,accountStatus:user.account_status,email:user.email,emailVerified:true,emailProofFresh:true,recoveryAcknowledged:!!user.recovery_acknowledged,sessionId:req.user.sessionId,authMethod:req.user.authMethod}});
}));
router.post('/recovery-codes/acknowledge',requireAuth,wrap(async(req,res)=>{
  await db.prepare('UPDATE users SET recovery_acknowledged=1 WHERE id=?').run(req.user.id);
  res.json({ok:true});
}));
router.post('/recovery-codes/regenerate',requireAuth,wrap(async(req,res)=>{
  const codes=await db.transaction(async()=>{
    const grant=await requireGrant({userId:req.user.id,sessionId:req.user.sessionId,action:ACTIONS.REGENERATE_RECOVERY,rawToken:req.body.reauthGrant});
    const codes=await sec.generateRecoveryCodes(req.user.id);
    await markGrantUsed(grant.id);
    await sec.securityNotice(req.user.id,'RECOVERY_CODES_REGENERATED','Bộ mã khôi phục đã được tạo lại; bộ cũ đã hết hiệu lực');
    return codes;
  })();
  res.json({recoveryCodes:codes});
}));
router.get('/security',requireAuth,wrap(async(req,res)=>{
  const user=await db.prepare('SELECT email,email_verified_at,recovery_acknowledged,recovery_restricted_until FROM users WHERE id=?').get(req.user.id);
  const remaining=(await db.prepare('SELECT COUNT(*) AS n FROM auth_recovery_codes WHERE user_id=? AND used_at IS NULL').get(req.user.id)).n;
  const sessions=await db.prepare('SELECT id,device_name,auth_method,auth_at,created_at,last_seen_at,expires_at FROM sessions WHERE user_id=? AND revoked_at IS NULL AND expires_at>? ORDER BY created_at DESC').all(req.user.id,nowIso());
  const events=await db.prepare('SELECT action,detail,created_at FROM auth_audit WHERE user_id=? ORDER BY created_at DESC LIMIT 30').all(req.user.id);
  const recovery=await db.prepare("SELECT id,status,available_at FROM account_recoveries WHERE user_id=? AND status IN ('WAITING','READY')").get(req.user.id);
  res.json({...user,emailVerified:!!user.email_verified_at,recoveryAcknowledged:!!user.recovery_acknowledged,recoveryCodesRemaining:remaining,sessions:sessions.map(s=>({...s,current:s.id===req.user.sessionId})),events,recovery:recovery||null,authMethod:req.user.authMethod});
}));
router.post('/sessions/revoke-others',requireAuth,wrap(async(req,res)=>{
  await revokeAllSessions(req.user.id,'USER_REVOKED',req.user.sessionId);
  res.json({ok:true});
}));
router.delete('/sessions/:id',requireAuth,wrap(async(req,res)=>{
  const target=await db.prepare('SELECT id FROM sessions WHERE id=? AND user_id=?').get(req.params.id,req.user.id);
  if(!target) throw new AppError(404,'SESSION_NOT_FOUND','Không tìm thấy phiên.');
  await revokeSession(target.id,'USER_REVOKED');res.json({ok:true,current:target.id===req.user.sessionId});
}));
router.patch('/credentials/:id',requireAuth,wrap(async(req,res)=>{
  const name=String(req.body.deviceName||'').trim().slice(0,60);
  if(!name) throw new AppError(400,'VALIDATION_ERROR','Hãy nhập tên Passkey.');
  const result=await db.prepare('UPDATE passkey_credentials SET device_name=? WHERE id=? AND user_id=?').run(name,req.params.id,req.user.id);
  if(result.changes!==1) throw new AppError(404,'CREDENTIAL_NOT_FOUND','Không tìm thấy Passkey.');
  res.json({ok:true});
}));
router.post('/password-reset/request',wrap(async(req,res)=>{
  sec.assertMailConfigured();
  const email=sec.normalizeEmail(req.body.email);
  await sec.enforceLimit(`reset-ip:${req.ip}`,5,3600);await sec.enforceLimit(`reset-email:${email}`,3,3600);
  const user=await db.prepare("SELECT * FROM users WHERE email=? AND email_verified_at IS NOT NULL AND is_active=1 AND account_status IN ('VERIFIED','ACTIVE','RECOVERING')").get(email);
  if(user) await db.transaction(async()=>{
    const token=await sec.makeLink(user.id,'PASSWORD_RESET',1800);
    await sec.queueMail(user,'Đặt lại mật khẩu Enclave',`Mở liên kết sau để đặt lại mật khẩu trong 30 phút: ${sec.linkUrl('password-reset',token)}. Nếu không phải bạn, hãy bỏ qua email này.`,user.email,{expiresAt:sec.after(1800)});
  })();
  res.json({message:generic});
}));
router.post('/password-reset/complete',wrap(async(req,res)=>{
  await sec.enforceLimit(`reset-complete:${req.ip}`,10,60);
  const row=await sec.getLink(req.body.token,'PASSWORD_RESET');
  const user=await db.prepare('SELECT * FROM users WHERE id=? AND is_active=1').get(row.user_id);
  if(!user || user.account_status==='SUSPENDED') throw new AppError(400,'LINK_INVALID','Liên kết không còn hiệu lực.');
  assertPasswordPolicy(req.body.newPassword,{username:user.username,email:user.email});
  const passwordHash=hashPassword(req.body.newPassword);
  await db.transaction(async()=>{
    await sec.consumeLink(row);
    await db.prepare('UPDATE users SET password_hash=?,token_version=token_version+1,updated_at=? WHERE id=?').run(passwordHash,nowIso(),user.id);
    await db.prepare("UPDATE auth_links SET used_at=? WHERE user_id=? AND purpose='PASSWORD_RESET' AND used_at IS NULL").run(nowIso(),user.id);
    await revokeAllSessions(user.id,'PASSWORD_RESET');
    await sec.securityNotice(user.id,'PASSWORD_RESET','Mật khẩu đã được đặt lại; các phiên đăng nhập cũ đã bị thu hồi');
  })();
  res.json({ok:true,message:'Đã đặt lại mật khẩu. Hãy đăng nhập lại.'});
}));
router.post('/recovery/code',requireAuth,wrap(async(req,res)=>{
  await sec.enforceLimit(`recovery-code:${req.user.id}`,5,300);
  const code=String(req.body.code||'').trim().toUpperCase();
  const user=await db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if(!verifyPassword(req.body.password || '',user.password_hash)) throw new AppError(401,'INVALID_CREDENTIALS','Mật khẩu hoặc mã khôi phục không đúng.');
  const result=await db.transaction(async()=>{
    const unused=await db.prepare('SELECT id,code_hash FROM auth_recovery_codes WHERE user_id=? AND used_at IS NULL').all(user.id);
    const found=unused.find(row=>sec.verifySecret(`${user.id}:${code}`,row.code_hash));
    const result=found ? await db.prepare('UPDATE auth_recovery_codes SET used_at=? WHERE id=? AND user_id=? AND used_at IS NULL').run(nowIso(),found.id,user.id) : {changes:0};
    if(result.changes!==1) throw new AppError(400,'RECOVERY_CODE_INVALID','Mật khẩu hoặc mã khôi phục không đúng.');
    await sec.securityNotice(user.id,'RECOVERY_CODE_USED','Một mã khôi phục đã được sử dụng');
    const session=await freshSession(req,res,user,'recovery','recover',false,true);
    await db.prepare("INSERT INTO auth_challenges(id,user_id,challenge,purpose,context_data,expires_at) VALUES(?,?,?,'REGISTRATION',?,?)")
      .run(`recovery:${session.user.sessionId}`,user.id,uuid(),JSON.stringify({emailRecovery:false}),sec.after(600));
    return session;
  })();
  result.commitCookie();res.json({...result,recoveryMethod:'CODE'});
}));
router.post('/recovery/email/request',wrap(async(req,res)=>{
  sec.assertMailConfigured();
  const email=sec.normalizeEmail(req.body.email);
  await sec.enforceLimit(`recovery-ip:${req.ip}`,5,3600);await sec.enforceLimit(`recovery-email:${email}`,3,3600);
  if(!sec.validEmail(email))throw new AppError(400,'INVALID_EMAIL','Hãy nhập email hợp lệ.');
  res.json(await require('../lib/emailRecovery').request(email));
}));
async function startEmailRecovery(userId,expectedEmail=null){
    const user=await db.prepare("SELECT * FROM users WHERE id=? AND is_active=1 AND account_status='ACTIVE' AND email_verified_at IS NOT NULL").get(userId);
    if(!user||(expectedEmail&&user.email!==expectedEmail)) throw new AppError(409,'RECOVERY_UNAVAILABLE','Yêu cầu khôi phục đang tồn tại hoặc tài khoản không khả dụng.');
    const availableAt=sec.after(Number(process.env.EMAIL_RECOVERY_WAIT_SECONDS||86400)),id=uuid();
    await db.prepare("INSERT INTO account_recoveries(id,user_id,status,available_at,expires_at,created_at) VALUES(?,?,'WAITING',?,?,?)").run(id,user.id,availableAt,new Date(Date.parse(availableAt)+3600000).toISOString(),nowIso());
    await db.prepare("UPDATE users SET account_status='RECOVERING',updated_at=? WHERE id=?").run(nowIso(),user.id);
    await db.prepare("UPDATE auth_links SET used_at=? WHERE user_id=? AND purpose IN ('RECOVERY_START','RECOVERY_EMAIL_OTP') AND used_at IS NULL").run(nowIso(),user.id);
    const cancel=await sec.makeLink(user.id,'RECOVERY_CANCEL',Number(process.env.EMAIL_RECOVERY_WAIT_SECONDS||86400)+3600,{recoveryId:id});
    await sec.queueMail(user,'Cảnh báo: đang khôi phục tài khoản Enclave',`Có yêu cầu khôi phục tài khoản. Chỉ có thể tạo Passkey mới sau ${availableAt}. Nếu không phải bạn, hủy tại: ${sec.linkUrl('recovery-cancel',cancel)} hoặc đăng nhập bằng Passkey cũ.`);
    await sec.audit(user.id,'RECOVERY_STARTED');
    return {availableAt,message:'Đã xác nhận email và bắt đầu thời gian chờ khôi phục. Chúng tôi sẽ gửi email khi có thể tạo Passkey mới.'};
}
router.post('/recovery/email/verify',publicLimiter,wrap(async(req,res)=>{
  await sec.enforceLimit(`recovery-otp-ip:${req.ip}`,30,600);
  res.json(await require('../lib/emailRecovery').verify(req.body.requestToken,req.body.code,startEmailRecovery));
}));
router.post('/recovery/email/start',wrap(async(req,res)=>{
  await sec.enforceLimit(`recovery-start:${req.ip}`,10,60);
  const result=await db.transaction(async()=>{
    const link=await sec.getLink(req.body.token,'RECOVERY_START');
    await sec.consumeLink(link);
    return startEmailRecovery(link.user_id,JSON.parse(link.context_data).email);
  })();res.json(result);
}));
router.post('/recovery/cancel',publicLimiter,wrap(async(req,res)=>{
  if(req.body.token) {
    await db.transaction(async()=>{
      const link=await sec.getLink(req.body.token,'RECOVERY_CANCEL');await sec.consumeLink(link);
      await cancelRecovery(link.user_id,JSON.parse(link.context_data).recoveryId);
    })();
  } else {
    let auth;try{auth=await loadUserFromToken(req.headers.authorization?.replace(/^Bearer /,''));}catch{}
    if(!auth || auth.authMethod!=='passkey') throw new AppError(403,'PASSKEY_REQUIRED','Hãy đăng nhập bằng Passkey cũ để hủy khôi phục.');
    await db.transaction(()=>cancelRecovery(auth.id))();
  }
  res.json({ok:true,message:'Đã hủy yêu cầu khôi phục.'});
}));
async function cancelRecovery(userId,recoveryId=null) {
  const changed=await db.prepare("UPDATE account_recoveries SET status='CANCELLED' WHERE user_id=? AND status IN ('WAITING','READY') AND (CAST(? AS TEXT) IS NULL OR id=?)").run(userId,recoveryId,recoveryId);
  if(changed.changes) {
    await db.prepare("UPDATE users SET account_status='ACTIVE' WHERE id=? AND account_status='RECOVERING'").run(userId);
    await db.prepare("UPDATE auth_links SET used_at=? WHERE user_id=? AND purpose IN ('RECOVERY_START','RECOVERY_FINISH','RECOVERY_CANCEL','RECOVERY_EMAIL_OTP') AND used_at IS NULL").run(nowIso(),userId);
    await sec.securityNotice(userId,'RECOVERY_CANCELLED','Yêu cầu khôi phục đã được hủy');
  }
}
router.post('/recovery/email/authorize',wrap(async(req,res)=>{
  await sec.enforceLimit(`recovery-authorize:${req.ip}`,10,60);
  const link=await sec.getLink(req.body.token,'RECOVERY_FINISH');
  const context=JSON.parse(link.context_data);
  const recovery=await db.prepare("SELECT * FROM account_recoveries WHERE id=? AND user_id=? AND status='READY' AND available_at<=? AND expires_at>?").get(context.recoveryId,link.user_id,nowIso(),nowIso());
  if(!recovery) throw new AppError(403,'RECOVERY_WAIT_REQUIRED','Chưa đến thời điểm khôi phục, yêu cầu đã hủy hoặc đã hết hạn.');
  const user=await db.prepare("SELECT * FROM users WHERE id=? AND is_active=1 AND account_status='RECOVERING'").get(link.user_id);
  if(!user) throw new AppError(400,'LINK_INVALID','Liên kết không còn hiệu lực.');
  // The email link remains one-time; a session records its authorization context in a challenge.
  const result=await db.transaction(async()=>{
    await sec.consumeLink(link);
    const session=await freshSession(req,res,user,'recovery','recover',false,true);
    const sid=session.user.sessionId;
    await db.prepare("INSERT INTO auth_challenges(id,user_id,challenge,purpose,context_data,expires_at) VALUES(?,?,?,'REGISTRATION',?,?)")
      .run(`recovery:${sid}`,user.id,uuid(),JSON.stringify({emailRecovery:true,recoveryId:recovery.id}),sec.after(3600));
    return session;
  })();result.commitCookie();res.json({...result,recoveryMethod:'EMAIL'});
}));
async function recoveryAuth(req) {
  const auth=req.user;
  const actor=await db.prepare('SELECT is_active,account_status FROM users WHERE id=?').get(auth.id);
  if(!actor?.is_active || actor.account_status==='SUSPENDED') throw new AppError(403,'USER_INACTIVE','Tài khoản đã bị khóa.');
  if(auth.authMethod!=='recovery' || auth.scope!=='recover') throw new AppError(403,'RECOVERY_SESSION_REQUIRED','Hãy bắt đầu quy trình khôi phục trước.');
  const marker=await db.prepare('SELECT * FROM auth_challenges WHERE id=? AND user_id=?').get(`recovery:${auth.sessionId}`,auth.id);
  if(!marker || Date.parse(marker.expires_at)<=Date.now()) throw new AppError(403,'RECOVERY_SESSION_REQUIRED','Phiên khôi phục đã hết hạn. Hãy bắt đầu lại.');
  {
    const ctx=JSON.parse(marker.context_data);
    if(!ctx.emailRecovery) return ctx;
    const recovery=await db.prepare("SELECT * FROM account_recoveries WHERE id=? AND user_id=? AND status='READY' AND available_at<=? AND expires_at>?").get(ctx.recoveryId,auth.id,nowIso(),nowIso());
    if(!recovery) throw new AppError(403,'RECOVERY_UNAVAILABLE','Yêu cầu khôi phục đã bị hủy hoặc hết hạn.');
    return ctx;
  }
}
router.post('/recovery/passkey/options',requireEnrollAuth,wrap(async(req,res)=>{
  const context=await recoveryAuth(req);await sec.enforceLimit(`recovery-options:${req.user.id}`,5,60);
  const user=await db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  const options=await generateRegistrationOptions({rpName:'Enclave',rpID:RP_ID,...await sec.registrationIdentity(user,{replaceExisting:true}),attestationType:'none',authenticatorSelection:{residentKey:'required',userVerification:'required'}});
  const id=uuid(),expiresAt=sec.after(300);
  await db.prepare("INSERT INTO auth_challenges(id,user_id,challenge,purpose,context_data,expires_at) VALUES(?,?,?,'REGISTRATION',?,?)").run(id,user.id,options.challenge,JSON.stringify({...context,recoverySessionId:req.user.sessionId,userHandle:options.user.id}),expiresAt);
  res.json({registrationSessionId:id,options,expiresAt});
}));
router.post('/recovery/passkey/verify',requireEnrollAuth,wrap(async(req,res)=>{
  await recoveryAuth(req);await sec.enforceLimit(`recovery-verify:${req.user.id}`,10,60);
  const challenge=await db.prepare("SELECT * FROM auth_challenges WHERE id=? AND user_id=? AND purpose='REGISTRATION' AND used_at IS NULL AND expires_at>?").get(req.body.registrationSessionId,req.user.id,nowIso());
  if(!challenge) throw new AppError(400,'CHALLENGE_EXPIRED','Phiên tạo Passkey không hợp lệ hoặc hết hạn.');
  const context=JSON.parse(challenge.context_data);
  if(context.recoverySessionId!==req.user.sessionId) throw new AppError(403,'RECOVERY_SESSION_REQUIRED','Sai phiên khôi phục.');
  const user=await db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if(context.emailRecovery) assertPasswordPolicy(req.body.newPassword,{username:user.username,email:user.email});
  let verified;
  try{verified=await verifyRegistrationResponse({response:req.body.response,expectedChallenge:challenge.challenge,expectedOrigin:ORIGIN,expectedRPID:RP_ID,requireUserVerification:true});}
  catch{throw new AppError(400,'VERIFICATION_FAILED','Không xác minh được Passkey. Hãy thử lại bằng vân tay, khuôn mặt hoặc mã PIN thiết bị.');}
  if(!verified.verified) throw new AppError(400,'VERIFICATION_FAILED','Không xác minh được Passkey mới.');
  const info=verified.registrationInfo,c=info.credential;
  const newHash=context.emailRecovery?hashPassword(req.body.newPassword):null;
  await db.transaction(async()=>{
    await recoveryAuth(req);
    if((await db.prepare('UPDATE auth_challenges SET used_at=? WHERE id=? AND used_at IS NULL AND expires_at>?').run(nowIso(),challenge.id,nowIso())).changes!==1) throw new AppError(400,'CHALLENGE_REPLAY','Challenge đã được dùng.');
    if(await db.prepare('SELECT 1 FROM passkey_credentials WHERE credential_id=?').get(c.id)) throw new AppError(409,'CREDENTIAL_EXISTS','Passkey đã tồn tại.');
    // Replace all old keys only when the new UV-verified key can be committed atomically.
    await db.prepare('DELETE FROM passkey_credentials WHERE user_id=?').run(user.id);
    await db.prepare('INSERT INTO passkey_credentials(id,user_id,credential_id,public_key,counter,transports,device_name,created_at,backup_eligible,backed_up) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(uuid(),user.id,c.id,Buffer.from(c.publicKey),c.counter,JSON.stringify(c.transports||[]),String(req.body.deviceName||'Passkey khôi phục').slice(0,60),nowIso(),info.credentialDeviceType==='multiDevice'?1:0,info.credentialBackedUp?1:0);
    await db.prepare('UPDATE passkey_credentials SET user_handle=? WHERE credential_id=?').run(context.userHandle,c.id);
    const restricted=context.emailRecovery?sec.after(Number(process.env.EMAIL_RECOVERY_RESTRICT_SECONDS||259200)):user.recovery_restricted_until;
    await db.prepare("UPDATE users SET account_status='ACTIVE',password_hash=COALESCE(?,password_hash),token_version=token_version+1,recovery_restricted_until=?,updated_at=? WHERE id=?").run(newHash,restricted,nowIso(),user.id);
    await db.prepare("UPDATE account_recoveries SET status='COMPLETED' WHERE user_id=? AND status IN ('WAITING','READY')").run(user.id);
    await revokeAllSessions(user.id,'ACCOUNT_RECOVERED');
    await db.prepare('UPDATE reauth_grants SET used_at=? WHERE user_id=? AND used_at IS NULL').run(nowIso(),user.id);
    await db.prepare('UPDATE auth_links SET used_at=? WHERE user_id=? AND used_at IS NULL').run(nowIso(),user.id);
    await db.prepare('DELETE FROM auth_recovery_codes WHERE user_id=?').run(user.id);
    await db.prepare('UPDATE users SET recovery_acknowledged=0 WHERE id=?').run(user.id);
    await sec.securityNotice(user.id,'ACCOUNT_RECOVERED','Tài khoản đã được khôi phục; Passkey và các phiên cũ đã bị thu hồi');
  })();
  const fresh=await db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
  res.json({...await freshSession(req,res,fresh,'passkey'),recoveryRestrictedUntil:fresh.recovery_restricted_until});
}));
router.post('/email/change/request',requireAuth,wrap(async(req,res)=>{
  sec.assertMailConfigured();await sec.enforceLimit(`email-change:${req.user.id}`,3,3600);
  const email=sec.normalizeEmail(req.body.newEmail);
  if(!sec.validEmail(email)) throw new AppError(400,'INVALID_EMAIL','Hãy nhập email hợp lệ.');
  const user=await db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if(email===user.email) throw new AppError(400,'SAME_EMAIL','Hãy nhập email mới khác email hiện tại.');
  const id=uuid(),oldCode=sec.newCode(),newCode=sec.newCode();
  await db.transaction(async()=>{
    const grant=await requireGrant({userId:user.id,sessionId:req.user.sessionId,action:ACTIONS.CHANGE_EMAIL,targetId:email,rawToken:req.body.reauthGrant});
    for(const recipient of [...new Set([...(user.email_verified_at?[user.email]:[]),email])]){
      const next=await require('../lib/emailVerification').reserveRecipient(recipient);
      if(next){const error=new AppError(429,'EMAIL_SEND_LIMIT','Đã đạt giới hạn gửi mã tới địa chỉ email. Vui lòng thử lại sau.');error.retryAfter=Math.max(1,Math.ceil((next-Date.now())/1000));throw error;}
    }
    // Invalid or already used addresses get the same flow; never expose the account owner.
    await db.prepare('INSERT INTO auth_email_changes(id,user_id,session_id,new_email,old_code_hash,new_code_hash,expires_at) VALUES(?,?,?,?,?,?,?)').run(id,user.id,req.user.sessionId,email,user.email_verified_at?sec.secretHash(`${id}:${oldCode}`):null,sec.secretHash(`${id}:${newCode}`),sec.after(600));
    if(user.email_verified_at) await sec.queueMail(user,'Xác nhận đổi email Enclave',`Mã xác nhận đổi email: ${oldCode}. Hiệu lực 10 phút. Nếu không phải bạn, hãy kiểm tra tài khoản ngay.`,user.email,{expiresAt:sec.after(600)});
    if(!(await db.prepare('SELECT 1 FROM users WHERE email=? AND email_verified_at IS NOT NULL').get(email))) await sec.queueMail(user,'Xác minh email mới cho Enclave',`Mã xác minh email mới: ${newCode}. Hiệu lực 10 phút.`,email,{expiresAt:sec.after(600)});
    await markGrantUsed(grant.id);
  })();res.json({changeId:id,oldEmailRequired:!!user.email_verified_at,message:'Hãy nhập mã gửi tới email cũ và email mới (nếu email mới có thể sử dụng).'});
}));
router.post('/email/change/verify',requireAuth,wrap(async(req,res)=>{
  const result=await db.transaction(async()=>{
    const retry=await require('../lib/emailVerification').gate(req.user.id);
    if(retry)return {error:'Bước nhập mã đã tạm khóa. Bạn vẫn có thể đăng nhập và sử dụng các chức năng không cần mã email.',retry};
    const row=await db.prepare('SELECT * FROM auth_email_changes WHERE id=? AND user_id=? AND session_id=? AND used_at IS NULL AND expires_at>?').get(req.body.changeId,req.user.id,req.user.sessionId,nowIso());
    if(!row || row.attempts>=5) return {error:'Mã hết hạn hoặc đã nhập sai quá nhiều lần.'};
    if((row.old_code_hash && !sec.verifySecret(`${row.id}:${req.body.oldCode}`,row.old_code_hash)) || !sec.verifySecret(`${row.id}:${req.body.newCode}`,row.new_code_hash)) {
      await db.prepare('UPDATE auth_email_changes SET attempts=attempts+1 WHERE id=? AND attempts<5 AND used_at IS NULL').run(row.id);
      const user=await db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
      const cap=await require('../lib/emailVerification').recordFailure(user,null);
      return {error:cap?'Bước nhập mã đã tạm khóa. Hãy thử lại sau thời hạn bảo vệ.':'Mã xác minh không đúng.',retry:cap?.retryAfter};
    }
    if(await db.prepare('SELECT 1 FROM users WHERE email=? AND email_verified_at IS NOT NULL AND id<>?').get(row.new_email,req.user.id)) return {error:'Không thể sử dụng email mới này. Hãy kiểm tra lại.'};
    const old=await db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
    await db.prepare('UPDATE users SET email=?,email_verified_at=?,updated_at=? WHERE id=?').run(row.new_email,nowIso(),nowIso(),req.user.id);
    await db.prepare('UPDATE auth_email_changes SET used_at=? WHERE user_id=? AND used_at IS NULL').run(nowIso(),req.user.id);
    await cancelRecovery(req.user.id);
    await db.prepare('UPDATE auth_links SET used_at=? WHERE user_id=? AND used_at IS NULL').run(nowIso(),req.user.id);
    await db.prepare('DELETE FROM auth_email_codes WHERE user_id=?').run(req.user.id);
    await revokeAllSessions(req.user.id,'EMAIL_CHANGED',req.user.sessionId);
    if(old.email_verified_at) await sec.queueMail(old,'Email Enclave đã thay đổi','Email tài khoản đã được thay đổi. Nếu không phải bạn, hãy kiểm tra tài khoản ngay.');
    await sec.securityNotice(req.user.id,'EMAIL_CHANGED','Email tài khoản đã được thay đổi');
    return {ok:true};
  })();
  if(result.error){const error=new AppError(result.retry?429:400,result.retry?'OTP_DAILY_LOCKED':'EMAIL_CODE_INVALID',result.error);if(result.retry)error.retryAfter=result.retry;throw error;}
  res.json(result);
}));
module.exports={router,makeVerificationFlow,cancelRecovery};
