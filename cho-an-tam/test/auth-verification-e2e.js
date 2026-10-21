// Actual HTTP and WebAuthn signatures; isolated DB, no real mail or inherited secrets.
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'enclave-verification-'));
const pgUrl=process.env.AUTH_TEST_PG_URL||'';
if(pgUrl){const url=new URL(pgUrl);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.pathname,'/enclave_auth_test');}
const secret=pgUrl&&process.env.AUTH_TEST_KEY||crypto.randomBytes(32).toString('hex');
Object.assign(process.env,{APP_ENV:'test',NODE_ENV:'test',DATABASE_URL:pgUrl,PGSSL:'disable',DB_PATH:path.join(tmp,'test.db'),DOTENV_CONFIG_PATH:path.join(tmp,'absent.env'),JWT_SECRET:secret,PAYMENT_WEBHOOK_SECRET:secret,AUTH_SECRET_PEPPER:secret,AUTH_SECRET_PEPPER_KEYS:JSON.stringify({fixture:secret}),AUTH_SECRET_PEPPER_KEY_ID:'fixture',AUTH_MAIL_ENCRYPTION_KEY:secret,AUTH_MAIL_ENCRYPTION_KEYS:JSON.stringify({fixture:secret}),AUTH_MAIL_KEY_ID:'fixture',AUTH_EMAIL_TRANSPORT:'test',AUTH_PUBLIC_URL:'https://enclave.example/',AUTH_BACKGROUND_JOBS:'0',RECONCILE_INTERVAL_SECONDS:'0',CHALLENGE_CLEANUP_INTERVAL_SECONDS:'0',SHIPPING_WORKER_INTERVAL_MS:'0',RATE_LIMIT_AUTH_PER_MINUTE:'10000',AUTH_REGISTER_PER_IP_HOUR:'1000',REAUTH_REQUESTS_PER_MINUTE:'1000'});
const {createAuthenticator}=require('./softwareAuthenticator');
let app,server,db,sec,base,checks=0;
const password='MatKhau-Rieng-2026!';
function check(value,message){assert.ok(value,message);checks++;console.log('PASS '+message);}
function must(r,status=200){assert.equal(r.status,status,JSON.stringify(r.data));return r.data;}
async function api(route,{token,body,method=body?'POST':'GET',cookie,origin,host,forwardedFor}={}){
  const headers={Connection:'close',Origin:origin===undefined?base:origin};
  if(token)headers.Authorization='Bearer '+token;if(cookie)headers.Cookie=cookie;
  if(body)headers['Content-Type']='application/json';if(host)headers.Host=host;
  if(forwardedFor)headers['X-Forwarded-For']=forwardedFor;
  const res=await fetch(base+'/api'+route,{method,headers,body:body?JSON.stringify(body):undefined});
  return {status:res.status,data:await res.json(),cookie:res.headers.get('set-cookie')?.split(';')[0],retry:res.headers.get('retry-after')};
}
async function mail(email,subject='Mã xác minh'){
  const rows=await db.prepare('SELECT * FROM auth_email_outbox WHERE recipient=? ORDER BY created_at DESC').all(email);
  const row=rows.find(row=>row.subject.includes(subject));assert.ok(row,'queued mail');return sec.decryptMail(row.body_cipher);
}
async function contents(user){const text=await mail(user.email);return {code:text.match(/\b\d{6}\b/)[0],link:new URL(text.match(/https:\/\/\S+/)[0])};}
const linkToken=link=>new URLSearchParams(link.hash.split('?')[1]).get('token');
async function signup(name,email=name+'@example.test'){
  const r=await api('/passkeys/register/account',{body:{email,username:name,displayName:'Người dùng thử',password}});
  must(r,201);return {...r.data,email,cookie:r.cookie,password};
}
async function login(user){return api('/passkeys/login/password',{body:{username:user.user.username,password}});}
async function activate(user){
  const verified=must(await api('/passkeys/email/verify',{token:user.token,body:{code:(await contents(user)).code}}));
  const options=must(await api('/passkeys/register/passkey/options',{token:verified.token,body:{}}));
  const auth=createAuthenticator();
  const response=auth.register({rpId:'localhost',origin:base,challenge:options.options.challenge,userHandle:options.options.user.id});
  const active=must(await api('/passkeys/register/passkey/verify',{token:verified.token,body:{registrationSessionId:options.registrationSessionId,response}}),201);
  return {...user,...active,auth,handle:options.options.user.id};
}
async function keyLogin(user,override){
  const options=must(await api('/passkeys/login/options',{body:{}}));
  const response=user.auth.authenticate({rpId:'localhost',origin:base,challenge:options.options.challenge,...(override===undefined?{}:{userHandle:override})});
  return api('/passkeys/login/verify',{body:{authenticationSessionId:options.authenticationSessionId,response}});
}
async function main(){
  const net=require('node:net'),probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  base='http://localhost:'+port;Object.assign(process.env,{PORT:String(port),WEBAUTHN_RP_ID:'localhost',WEBAUTHN_ORIGIN:base});
  ({app}=require('../src/server'));({db}=require('../src/db'));sec=require('../src/lib/accountSecurity');await db.ready;
  server=app.listen(port);await new Promise(r=>server.once('listening',r));
  const squat=await signup('squat_user','shared@example.test'),owner=await signup('real_owner','shared@example.test');
  const ownerCode=(await contents(owner)).code;
  must(await api('/passkeys/email/verify',{token:owner.token,body:{code:ownerCode}}));
  check((await db.prepare('SELECT email_verified_at FROM users WHERE id=?').get(owner.user.id)).email_verified_at,'mailbox owner can verify despite an older unverified registration');
  check((await api('/passkeys/email/verify',{token:squat.token,body:{code:ownerCode}})).status===400,'older unverified account cannot claim email after owner verification');
  check(sec.normalizeEmail(' A.Name+tag@EXAMPLE.TEST ')==='a.name+tag@example.test','email normalization preserves dots and plus tag');
  const quotaEmail='quota@example.test';
  const recipients=Array.from({length:20},(_,i)=>({id:crypto.randomUUID(),username:'quota_'+i,display_name:'<script>not used</script>',email:quotaEmail}));
  for(const user of recipients)await db.prepare("INSERT INTO users(id,username,display_name,role,password_hash,account_status,email) VALUES(?,?,?,'BUYER',?,'BASIC',?)").run(user.id,user.username,user.display_name,'fixture-only',user.email);
  await Promise.all(recipients.map(user=>sec.sendVerification(user,{initial:true})));
  check((await db.prepare('SELECT COUNT(*) AS n FROM auth_email_outbox WHERE recipient=?').get(quotaEmail)).n===5,'20 pending accounts share a hard five-email recipient/hour budget');
  check(!(await mail(quotaEmail)).includes('<script>'),'public display name is absent from verification email');
  const stable=await signup('stable_otp');
  const beforeEnsure=await db.prepare('SELECT * FROM auth_email_codes WHERE user_id=?').get(stable.user.id);
  const countBeforeEnsure=(await db.prepare('SELECT COUNT(*) AS n FROM auth_email_outbox WHERE user_id=?').get(stable.user.id)).n;
  const ensured=must(await api('/passkeys/email/resend',{token:stable.token,body:{ensure:true},host:'attacker.example'}));
  const afterEnsure=await db.prepare('SELECT * FROM auth_email_codes WHERE user_id=?').get(stable.user.id);
  check(afterEnsure.code_hash===beforeEnsure.code_hash&&(await db.prepare('SELECT COUNT(*) AS n FROM auth_email_outbox WHERE user_id=?').get(stable.user.id)).n===countBeforeEnsure,'reopening verification reuses a live code without another email');
  check(ensured.nextRequestAt===new Date(Date.parse(beforeEnsure.sent_at)+60000).toISOString(),'cooldown uses original server deadline');
  const early=await api('/passkeys/email/resend',{token:stable.token,body:{}});
  check(early.status===429&&Number(early.retry)>0,'explicit early resend returns retry-after without rotating code');
  check((await contents(stable)).link.origin==='https://enclave.example','verification link uses fixed public URL despite forged Host');
  const staleToken=linkToken((await contents(stable)).link);
  await db.prepare('UPDATE auth_email_codes SET sent_at=? WHERE user_id=?').run(new Date(Date.now()-61000).toISOString(),stable.user.id);
  must(await api('/passkeys/email/resend',{token:stable.token,body:{}}));
  check((await api('/passkeys/email/link/preview',{body:{token:staleToken}})).status===400,'a new code invalidates the old email link');
  const expiringToken=linkToken((await contents(stable)).link);
  await db.prepare("UPDATE auth_links SET expires_at=? WHERE user_id=? AND purpose='VERIFY_EMAIL'").run(new Date(Date.now()-1000).toISOString(),stable.user.id);
  check((await api('/passkeys/email/link/confirm',{token:stable.token,body:{token:expiringToken}})).status===400&&!(await db.prepare('SELECT email_verified_at FROM users WHERE id=?').get(stable.user.id)).email_verified_at,'expired link cannot verify an account');
  const burst=await signup('burst_otp');
  const parallel=await Promise.all(Array.from({length:50},()=>api('/passkeys/email/verify',{token:burst.token,body:{code:'not-a-code'}})));
  check(parallel.every(r=>[400,429].includes(r.status))&&(await db.prepare('SELECT attempts FROM auth_email_codes WHERE user_id=?').get(burst.user.id)).attempts===5,'50 concurrent guesses spend at most five code attempts');
  check((await db.prepare('SELECT COUNT(*) AS n FROM auth_otp_failures WHERE user_id=?').get(burst.user.id)).n===5,'rejected requests do not add guesses or bypass the attempt gate');
  const target=await signup('locked_otp'),sibling=must(await login(target));
  for(let round=0;round<4;round++){
    if(round){await db.prepare('UPDATE auth_email_codes SET sent_at=? WHERE user_id=?').run(new Date(Date.now()-61000).toISOString(),target.user.id);
    must(await api('/passkeys/email/resend',{token:target.token,body:{}}));}
    for(let i=0;i<5;i++){const result=await api('/passkeys/email/verify',{token:target.token,body:{code:'not-a-code'}});assert.ok([400,429].includes(result.status));}
  }
  check((await db.prepare('SELECT COUNT(*) AS n FROM auth_otp_failures WHERE user_id=?').get(target.user.id)).n===20,'resends do not reset rolling 24h failures');
  const blocked=await api('/passkeys/email/verify',{token:target.token,body:{code:'not-a-code'}});
  check(blocked.status===429&&blocked.data.error==='OTP_DAILY_LOCKED'&&Number(blocked.retry)>=3600,'hard rolling cap returns durable lock and retry-after');
  const until=(await db.prepare('SELECT locked_until FROM auth_otp_locks WHERE user_id=?').get(target.user.id)).locked_until;
  await api('/passkeys/email/verify',{token:target.token,body:{code:'not-a-code'}});
  check((await db.prepare('SELECT locked_until FROM auth_otp_locks WHERE user_id=?').get(target.user.id)).locked_until===until,'blocked guesses do not prolong the lock');
  await db.prepare('UPDATE auth_otp_locks SET locked_until=? WHERE user_id=?').run(Date.now()-1000,target.user.id);
  check((await api('/passkeys/email/verify',{token:target.token,body:{code:'not-a-code'}})).status===429,'one-hour elapsed does not bypass twenty failures still inside 24h');
  await db.prepare('UPDATE auth_otp_failures SET failed_at=? WHERE user_id=?').run(Date.now()-86401000,target.user.id);
  await db.prepare('UPDATE auth_otp_locks SET locked_until=? WHERE user_id=?').run(Date.now()+3600000,target.user.id);
  check(await require('../src/lib/emailVerification').gate(target.user.id)>0,'rolling failures expiring does not bypass the minimum one-hour lock');
  await db.prepare('UPDATE auth_otp_locks SET locked_until=? WHERE user_id=?').run(Date.now()-1000,target.user.id);
  check(await require('../src/lib/emailVerification').gate(target.user.id)===0,'OTP unlocks only after both the rolling cap and minimum lock clear');
  await db.prepare('UPDATE auth_otp_failures SET failed_at=? WHERE user_id=?').run(Date.now(),target.user.id);
  const url=(await contents(target)).link,token=linkToken(url);
  must(await api('/passkeys/email/link/preview',{body:{token}}));
  check(!(await db.prepare('SELECT email_verified_at FROM users WHERE id=?').get(target.user.id)).email_verified_at,'link preview does not verify or consume');
  check((await api('/passkeys/email/link/confirm',{body:{token}})).status===401,'link cannot confirm without ordinary login');
  check((await api('/passkeys/email/link/confirm',{token:squat.token,body:{token}})).status===403,'link cannot confirm for a different account');
  const sessionsBefore=(await db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id=?').get(target.user.id)).n;
  const confirmed=must(await api('/passkeys/email/link/confirm',{token:target.token,body:{token}}));
  check(confirmed.user.authMethod==='password'&&!confirmed.token&&confirmed.user.sessionId===target.user.sessionId,'matching login confirms link and retains same P session');
  check((await db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id=?').get(target.user.id)).n===sessionsBefore&&!(await db.prepare('SELECT 1 FROM wallets WHERE user_id=?').get(target.user.id)),'link does not create session, wallet or financial privilege');
  check((await api('/passkeys/email/link/confirm',{token:target.token,body:{token}})).status===400,'confirmation token is one use');
  check((await api('/passkeys/register/passkey/options',{token:sibling.token,body:{}})).data.error==='EMAIL_VERIFICATION_REQUIRED','confirmation does not grant evidence to a sibling session');
  must(await api('/passkeys/register/passkey/options',{token:target.token,body:{}}));
  check((await db.prepare('SELECT COUNT(*) AS n FROM auth_otp_failures WHERE user_id=?').get(target.user.id)).n===20,'valid link bypasses short-code lock without erasing guess history');
  const audit=await db.prepare("SELECT detail FROM auth_audit WHERE user_id=? AND action='EMAIL_VERIFIED_LINK'").get(target.user.id);
  check(audit&&!audit.detail.includes(token),'link audit exists and omits token');
  const active=await activate(await signup('legacy_handle'));
  check(must(await keyLogin(active)).user.id===active.user.id,'known non-null user handle authenticates');
  check((await keyLogin(active,'wrong-account-handle')).status===400,'known credential rejects mismatched handle');
  await db.prepare('UPDATE passkey_credentials SET user_handle=NULL WHERE user_id=?').run(active.user.id);
  await db.prepare('UPDATE users SET webauthn_user_id=NULL WHERE id=?').run(active.user.id);
  const grantOptions=must(await api('/passkeys/reauth/options',{token:active.token,body:{action:'ADD_CREDENTIAL'}}));
  const grant=must(await api('/passkeys/reauth/verify',{token:active.token,body:{reauthSessionId:grantOptions.reauthSessionId,response:active.auth.authenticate({rpId:'localhost',origin:base,challenge:grantOptions.options.challenge})}}));
  const add=must(await api('/passkeys/credentials/options',{token:active.token,body:{reauthGrant:grant.reauthGrant}}));
  const newKey=createAuthenticator(),newResponse=newKey.register({rpId:'localhost',origin:base,challenge:add.options.challenge,userHandle:add.options.user.id});
  must(await api('/passkeys/credentials/verify',{token:active.token,body:{registrationSessionId:add.registrationSessionId,response:newResponse,reauthGrant:grant.reauthGrant}}),201);
  check(add.options.user.id!==active.handle&&must(await keyLogin(active)).user.id===active.user.id,'legacy key survives a new account handle and added credential');
  check(must(await keyLogin({...active,auth:newKey})).user.id===active.user.id,'new key with new handle also authenticates');
  const raceLogin=await login(active);
  const refreshPair=await Promise.all([1,2].map(()=>api('/passkeys/session/refresh',{method:'POST',body:{},cookie:raceLogin.cookie})));
  const refreshWinner=refreshPair.find(r=>r.status===200),refreshLoser=refreshPair.find(r=>r.status===409);
  check(refreshWinner&&refreshLoser?.data.error==='SESSION_REFRESH_ROTATED','parallel refresh accepts one request and identifies a harmless rotation conflict');
  check(!refreshLoser.cookie&&!refreshLoser.data.token,'rotation conflict never clears a winning cookie or issues a token');
  check((await api('/users/me',{token:refreshWinner.data.token})).status===200,'parallel refresh does not revoke the valid winning session');
  must(await api('/passkeys/session/refresh',{method:'POST',body:{},cookie:refreshWinner.cookie}));
  await db.prepare('UPDATE auth_refresh_history SET created_at=? WHERE token_hash=?').run(new Date(Date.now()-11000).toISOString(),sec.hash(raceLogin.cookie.split('=')[1]));
  check((await api('/passkeys/session/refresh',{method:'POST',body:{},cookie:raceLogin.cookie})).status===401&&(await api('/users/me',{token:refreshWinner.data.token})).status===401,'old refresh replay outside the conflict window still revokes its session family');
  const logged=await login(active),rotated=await api('/passkeys/session/refresh',{method:'POST',body:{},cookie:logged.cookie});must(rotated);
  must(await api('/passkeys/session/logout',{method:'POST',body:{},cookie:logged.cookie}));
  check((await api('/passkeys/session/refresh',{method:'POST',body:{},cookie:rotated.cookie})).status===401,'logout by pre-rotation token revokes the rotated session');
  const trusted=await login(active);
  check((await api('/passkeys/session/refresh',{method:'POST',body:{},cookie:trusted.cookie,origin:'https://evil.enclave.example'})).status===403,'untrusted same-site origin cannot refresh cookie');
  check((await api('/passkeys/session/logout',{method:'POST',body:{},cookie:trusted.cookie,origin:'https://evil.enclave.example'})).status===403,'untrusted origin cannot log out cookie session');
  must(await api('/passkeys/session/refresh',{method:'POST',body:{},cookie:trusted.cookie}));
  const recovery=must(await api('/passkeys/recovery/code',{token:active.token,body:{password,code:active.recoveryCodes[0]}}));
  const recoveryOptions=must(await api('/passkeys/recovery/passkey/options',{token:recovery.token,body:{}}));
  const recoveredKey=createAuthenticator();
  const recovered=must(await api('/passkeys/recovery/passkey/verify',{token:recovery.token,body:{registrationSessionId:recoveryOptions.registrationSessionId,response:recoveredKey.register({rpId:'localhost',origin:base,challenge:recoveryOptions.options.challenge,userHandle:recoveryOptions.options.user.id})}}));
  check(recovered.recoveryCodes.length===8&&!recovered.recoveryCodes.includes(active.recoveryCodes[1]),'code recovery rotates all remaining recovery codes');
  check((await api('/passkeys/recovery/code',{token:recovered.token,body:{password,code:active.recoveryCodes[1]}})).status===400,'unused code from old recovery set is invalid');
  check(!recovered.recoveryRestrictedUntil,'code recovery does not gain the email-only 72-hour restriction');
  let proxyProbe;
  for(let i=0;i<16;i++)proxyProbe=await api('/passkeys/username-availability?username=proxy_probe',{forwardedFor:'198.51.100.'+(i+1)});
  check(proxyProbe.status===429&&Number(proxyProbe.retry)>0,'default direct-server mode ignores forged X-Forwarded-For when limiting the real client');
  console.log('AUTH VERIFICATION: '+checks+' checks passed; isolated '+tmp);
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(server)await new Promise(r=>server.close(r));if(db)await db.close();});
