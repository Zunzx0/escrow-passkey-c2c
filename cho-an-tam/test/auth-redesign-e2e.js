// Real HTTP + real WebAuthn signature verification, isolated temporary SQLite DB.
// Email transport is an encrypted local outbox; never sends to Resend or real users.
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const net=require('node:net');
const root=path.resolve(__dirname,'..'),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'enclave-auth-v3-'));
const secret=process.env.AUTH_TEST_PG_URL&&process.env.AUTH_TEST_KEY||crypto.randomBytes(32).toString('hex');
const pgUrl=process.env.AUTH_TEST_PG_URL || '';
process.env.PGSSL='disable';
if(pgUrl){const url=new URL(pgUrl);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.pathname,'/enclave_auth_test');}
Object.assign(process.env,{APP_ENV:'test',NODE_ENV:'test',DATABASE_URL:pgUrl,DB_PATH:path.join(tmp,'test.db'),DOTENV_CONFIG_PATH:path.join(tmp,'absent.env'),JWT_SECRET:secret,PAYMENT_WEBHOOK_SECRET:secret,AUTH_SECRET_PEPPER:secret,AUTH_SECRET_PEPPER_KEYS:JSON.stringify({fixture:secret}),AUTH_SECRET_PEPPER_KEY_ID:'fixture',AUTH_MAIL_ENCRYPTION_KEY:secret,AUTH_MAIL_ENCRYPTION_KEYS:JSON.stringify({fixture:secret}),AUTH_MAIL_KEY_ID:'fixture',AUTH_EMAIL_TRANSPORT:'test',AUTH_PUBLIC_URL:'https://enclave.example/',AUTH_BACKGROUND_JOBS:'0',RECONCILE_INTERVAL_SECONDS:'0',CHALLENGE_CLEANUP_INTERVAL_SECONDS:'0',SHIPPING_WORKER_INTERVAL_MS:'0',RATE_LIMIT_AUTH_PER_MINUTE:'1000',AUTH_REGISTER_PER_IP_HOUR:'1000',REAUTH_REQUESTS_PER_MINUTE:'1000'});
let server,logs='',base,db,sec,checks=0;
const password='MatKhau-Rieng-2026!';
const shipping={recipientName:'Người nhận kiểm thử',phone:'0912345678',address:'Số 10 đường Kiểm Thử',ward:'Phường Một',district:'Quận Một',province:'Hà Nội'};
const {createAuthenticator}=require('./softwareAuthenticator');
function check(value,message){assert.ok(value,message);checks++;console.log('PASS '+message);}
async function port(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function start(){Object.assign(process.env,{PORT:base.split(':').pop(),WEBAUTHN_RP_ID:'localhost',WEBAUTHN_ORIGIN:base});console.log('Loading isolated test application…');const {app}=require('../src/server');({db}=require('../src/db'));await db.ready;await new Promise((resolve,reject)=>{server=app.listen(Number(process.env.PORT),resolve);server.once('error',reject);});console.log('Test HTTP server ready');}
async function stop(){if(server)await new Promise(r=>server.close(r));server=null;}
async function api(route,{token,body,method=body?'POST':'GET',cookie}={}){const headers={Connection:'close',Origin:base};if(token)headers.Authorization='Bearer '+token;if(body)headers['Content-Type']='application/json';if(cookie)headers.Cookie=cookie;const res=await fetch(base+'/api'+route,{method,headers,body:body?JSON.stringify(body):undefined});return {status:res.status,data:await res.json(),cookie:res.headers.get('set-cookie')?.split(';')[0]};}
function must(res,status=200){assert.equal(res.status,status,JSON.stringify(res.data));return res.data;}
async function mail(email,subject){const rows=await db.prepare('SELECT * FROM auth_email_outbox WHERE recipient=? ORDER BY created_at DESC').all(email);const row=rows.find(r=>!subject||r.subject.includes(subject));assert.ok(row,'email queued '+subject);return sec.decryptMail(row.body_cipher);}
async function otp(email,subject='Mã xác minh'){return (await mail(email,subject)).match(/\b\d{6}\b/)[0];}
async function emailLink(email,subject){const text=await mail(email,subject),url=text.match(/https?:\/\/\S+/)[0].replace(/[.,]$/,'');return new URLSearchParams(new URL(url).hash.split('?')[1]).get('token');}
async function register(name){const email=name+'@example.test';const registered=await api('/passkeys/register/account',{body:{email,username:name,displayName:'Người dùng thử',password}});must(registered,201);const verified=await api('/passkeys/email/verify',{token:registered.data.token,body:{code:await otp(email)}});must(verified);const auth=createAuthenticator();const opt=must(await api('/passkeys/register/passkey/options',{token:verified.data.token,body:{}}));const response=auth.register({rpId:'localhost',origin:base,challenge:opt.options.challenge,uv:true});const activated=await api('/passkeys/register/passkey/verify',{token:verified.data.token,body:{registrationSessionId:opt.registrationSessionId,response,deviceName:'Thiết bị thử',initialGrantVnd:99999999,INITIAL_GRANT_VND:99999999,availableBalance:99999999}});must(activated,201);return {...activated.data,auth,email,password,cookie:verified.cookie,registrationOptions:opt.options};}
async function login(user){return api('/passkeys/login/password',{body:{username:user.user.username,password:user.password}});}
async function passkeyLogin(user){const opt=must(await api('/passkeys/login/options',{body:{}}));const response=user.auth.authenticate({rpId:'localhost',origin:base,challenge:opt.options.challenge,uv:true});return api('/passkeys/login/verify',{body:{authenticationSessionId:opt.authenticationSessionId,response}});}
async function grant(user,action,details={},token=user.token){const opt=must(await api('/passkeys/reauth/options',{token,body:{action,...details}}));const response=user.auth.authenticate({rpId:'localhost',origin:base,challenge:opt.options.challenge,uv:true});return must(await api('/passkeys/reauth/verify',{token,body:{reauthSessionId:opt.reauthSessionId,response}}));}
async function lockGrant(user,id,token=user.token){const opt=must(await api('/transactions/'+id+'/reauth/options',{token,body:{action:'LOCK_ESCROW'}}));return must(await api('/transactions/'+id+'/reauth/verify',{token,body:{reauthSessionId:opt.reauthSessionId,response:user.auth.authenticate({rpId:'localhost',origin:base,challenge:opt.options.challenge,uv:true})}}));}
async function secure(user,id,token=user.token){const g=await lockGrant(user,id,token);return api('/transactions/'+id+'/secure',{token,body:{requestId:crypto.randomUUID(),reauthGrant:g.reauthGrant}});}
async function order(seller,buyer,price){const listing=must(await api('/listings',{token:seller.token,body:{title:'Sản phẩm thử '+crypto.randomBytes(3).toString('hex'),description:'Hàng mô phỏng kiểm thử',price,category:'DIEN_TU',condition:'GOOD',location:'Hà Nội'}}),201);return must(await api('/transactions/orders',{token:buyer.token,body:{listingId:listing.id,shipping,requestId:crypto.randomUUID()}}),201);}
async function deliver(seller,buyer,id){
  must(await api('/transactions/'+id+'/acknowledge',{token:seller.token,body:{}}));
  must(await api('/transactions/'+id+'/pack',{token:seller.token,body:{}}),201);
  const shipment=await db.prepare('SELECT * FROM shipments WHERE transaction_id=?').get(id);
  // Inject the carrier clock only in this isolated fixture. The public API has no skip switch.
  await require('../src/lib/shipping').reconcileShipping({now:Date.parse(shipment.arrival_due_at)});
  must(await api('/transactions/'+id+'/wait-confirm',{token:buyer.token,body:{}}));
}
async function main(){
  base='http://localhost:'+await port();await start();({db}=require('../src/db'));sec=require('../src/lib/accountSecurity');await db.ready;
  const baselineWallets=(await db.prepare('SELECT COUNT(*) AS n FROM wallets WHERE user_id IS NOT NULL').get()).n;
  if(pgUrl){check((await db.prepare("SELECT available_balance FROM wallets WHERE id='legacy-auth-wallet'").get()).available_balance===10000,'PostgreSQL upgrade preserves old balance');check((await db.prepare("SELECT email_verified_at FROM users WHERE id='legacy-auth-upgrade'").get()).email_verified_at===null,'migration does not falsely verify legacy email');}
  const first=await api('/passkeys/register/account',{body:{email:'first@example.test',username:'first_user',displayName:'Người dùng đầu',password}});must(first,201);
  check(first.data.scope==='full'&&first.data.user.accountStatus==='BASIC','registration enters marketplace as BASIC without forced Passkey');
  check((await api('/passkeys/register/passkey/options',{token:first.data.token,body:{}})).status===409,'unverified account cannot call Passkey API');
  check((await db.prepare('SELECT COUNT(*) AS n FROM wallets WHERE user_id IS NOT NULL').get()).n===baselineWallets,'no wallet before verified email and Passkey');
  check(!(await db.prepare('SELECT code_hash FROM auth_email_codes').get()).code_hash.includes(await otp('first@example.test')),'OTP is not stored in plain text');
  for(let i=0;i<5;i++)must(await api('/passkeys/email/verify',{token:first.data.token,body:{code:'invalid'}}),400);
  check((await api('/passkeys/email/verify',{token:first.data.token,body:{code:await otp('first@example.test')}})).status===400,'five wrong OTP attempts invalidate the code');
  const a=await register('buyer_test'),seller=await register('seller_test');await db.prepare("UPDATE users SET role='SELLER' WHERE id=?").run(seller.user.id);
  assert.equal(a.user.displayName,seller.user.displayName); // Deliberately identical public names.
  check(a.registrationOptions.user.name!==seller.registrationOptions.user.name,'two accounts with the same public name retain distinct WebAuthn user.name');
  check(a.registrationOptions.user.displayName!==seller.registrationOptions.user.displayName,'Passkey labels distinguish accounts with identical public display names');
  check(a.registrationOptions.user.id!==seller.registrationOptions.user.id&&Buffer.from(a.registrationOptions.user.id,'base64url').length===32,'WebAuthn user handles remain random 32-byte values per account');
  check(seller.registrationOptions.excludeCredentials.length===0,'new account does not exclude another account existing Passkey');
  check(a.user.authMethod==='passkey'&&a.recoveryCodes===undefined,'activation yields K session without forcing backup codes');
  check((await db.prepare('SELECT COUNT(*) AS n FROM auth_recovery_codes WHERE user_id=?').get(a.user.id)).n===0,'new account has no unsolicited backup codes');
  check((await db.prepare('SELECT COUNT(*) AS n FROM wallets WHERE user_id=?').get(a.user.id)).n===1,'activation creates exactly one wallet');
  for(const person of [a,seller]) {
    const wallet=await db.prepare('SELECT * FROM wallets WHERE user_id=?').get(person.user.id);
    const credits=await db.prepare("SELECT * FROM wallet_entries WHERE wallet_id=? AND entry_type='DEMO_TOPUP'").all(wallet.id);
    check(wallet.available_balance===10000000&&wallet.locked_balance===0,'server grants exactly 10m despite client-supplied credit amounts');
    check(credits.length===1&&credits[0].available_delta===10000000&&credits[0].available_after===10000000&&credits[0].locked_delta===0&&credits[0].idempotency_key==='demo-topup:'+person.user.id,'initial credit has one matching external ledger entry bound to the account');
  }
  const duplicate=await api('/passkeys/register/account',{body:{email:a.email,username:'different_name',displayName:'Người dùng thử',password}});must(duplicate,201);
  check(duplicate.data.scope===first.data.scope&&duplicate.data.message===first.data.message&&!duplicate.data.token.includes(a.user.id),'existing email gets indistinguishable verification flow');
  check((await api('/passkeys/email/verify',{token:duplicate.data.token,body:{code:await otp(a.email)}})).status===400,'duplicate-email flow cannot authorize existing account');
  const p=await login(a);must(p);check(p.data.user.authMethod==='password','password creates P session');
  const high=await order(seller,{...a,token:p.data.token},500001);
  const invalidShipping=await api('/transactions/orders',{token:p.data.token,body:{listingId:high.listingId,requestId:crypto.randomUUID(),shipping:{...shipping,phone:'123'}}});
  check(invalidShipping.status===400&&!!invalidShipping.data.details?.fields?.phone,'production error middleware exposes the server-authored shipping field error');
  check(!JSON.stringify(invalidShipping.data).includes(shipping.address),'shipping validation errors do not echo submitted private address values');
  const before=must(await api('/wallets/me',{token:p.data.token})).availableBalance;
  check((await api('/transactions/'+high.id+'/secure',{token:p.data.token,body:{requestId:crypto.randomUUID()}})).data.error==='REAUTH_REQUIRED','P session cannot lock any amount without G');
  check(must(await api('/wallets/me',{token:p.data.token})).availableBalance===before,'missing grant leaves wallet unchanged');
  const upgraded=await grant(a,'UPGRADE_SESSION',{},p.data.token);check(upgraded.user.authMethod==='passkey','UV assertion upgrades same P session to K');
  check((await api('/transactions/'+high.id+'/secure',{token:upgraded.token,body:{requestId:crypto.randomUUID()}})).data.error==='REAUTH_REQUIRED','K session still requires fresh G on each payment');
  must(await secure(a,high.id,upgraded.token));
  const wrongUv=must(await api('/passkeys/login/options',{body:{}}));check(wrongUv.options.userVerification==='required','login options explicitly require UV');
  const assertion=a.auth.authenticate({rpId:'localhost',origin:base,challenge:wrongUv.options.challenge,uv:false});
  check((await api('/passkeys/login/verify',{body:{authenticationSessionId:wrongUv.authenticationSessionId,response:assertion}})).status===400,'login assertion without UV rejected');
  const add=await grant(a,'ADD_CREDENTIAL'),second=createAuthenticator();
  const addOptions=must(await api('/passkeys/credentials/options',{token:a.token,body:{reauthGrant:add.reauthGrant,deviceName:'Dự phòng'}}));
  const ownCredentials=await db.prepare('SELECT credential_id FROM passkey_credentials WHERE user_id=?').all(a.user.id);
  const otherCredentials=await db.prepare('SELECT credential_id FROM passkey_credentials WHERE user_id=?').all(seller.user.id);
  check(JSON.stringify(addOptions.options.excludeCredentials.map(c=>c.id).sort())===JSON.stringify(ownCredentials.map(c=>c.credential_id).sort()),'excludeCredentials contains exactly the current account credentials');
  check(addOptions.options.excludeCredentials.every(c=>!otherCredentials.some(other=>other.credential_id===c.id)),'excludeCredentials never includes another account credentials');
  check(addOptions.options.user.id===a.registrationOptions.user.id,'adding a Passkey retains the same opaque account handle');
  const added=await api('/passkeys/credentials/verify',{token:a.token,body:{registrationSessionId:addOptions.registrationSessionId,response:second.register({rpId:'localhost',origin:base,challenge:addOptions.options.challenge,uv:true}),reauthGrant:add.reauthGrant}});must(added,201);
  const keys=must(await api('/passkeys/credentials',{token:a.token})).credentials,target=keys.find(c=>c.deviceName==='Dự phòng');
  check((await api('/passkeys/credentials/'+target.id,{token:a.token,method:'DELETE',body:{reauthGrant:add.reauthGrant}})).status===401,'ADD grant cannot delete a credential');
  const remove=await grant(a,'REMOVE_CREDENTIAL',{credentialId:target.id});
  check((await api('/passkeys/credentials/'+keys.find(c=>c.id!==target.id).id,{token:a.token,method:'DELETE',body:{reauthGrant:remove.reauthGrant}})).status===401,'REMOVE grant bound to target credential');
  must(await api('/passkeys/credentials/'+target.id,{token:a.token,method:'DELETE',body:{reauthGrant:remove.reauthGrant}}));
  check((await api('/users/me',{token:upgraded.token})).status===401,'deleting Passkey revokes other sessions');
  check((await api('/users/me',{token:a.token})).status===200,'deleting Passkey keeps current session');
  const change=await grant(a,'CHANGE_PASSWORD');
  check((await api('/users/me/password',{token:a.token,body:{currentPassword:'wrong',newPassword:'MatKhau-Moi-2026!',reauthGrant:change.reauthGrant}})).data.error==='INVALID_CURRENT_PASSWORD','password change requires old password');
  const changeOk=await api('/users/me/password',{token:a.token,body:{currentPassword:password,newPassword:'MatKhau-Moi-2026!',reauthGrant:change.reauthGrant}});must(changeOk);a.token=changeOk.data.token;a.password='MatKhau-Moi-2026!';
  check((await login(a)).status===200,'password change succeeds with correct password and G grant');
  // One grant used concurrently: only one transaction may regenerate the code set.
  const regen=await grant(a,'REGENERATE_RECOVERY');
  const simultaneous=await Promise.all([1,2].map(()=>api('/passkeys/recovery-codes/regenerate',{token:a.token,body:{reauthGrant:regen.reauthGrant}})));
  check(simultaneous.filter(r=>r.status===200).length===1,'concurrent reuse of same G grant succeeds exactly once');
  const otherGrant=await grant(a,'REGENERATE_RECOVERY');
  check((await api('/passkeys/recovery-codes/regenerate',{token:seller.token,body:{reauthGrant:otherGrant.reauthGrant}})).status===401,'another account cannot use G grant');
  const daily=await register('daily_test'),dailyP=must(await login(daily));
  const firstOrder=await order(seller,daily,1000),secondOrder=await order(seller,daily,2000);
  const lock=await lockGrant(daily,firstOrder.id,dailyP.token);
  check((await api('/transactions/'+secondOrder.id+'/secure',{token:dailyP.token,body:{requestId:crypto.randomUUID(),reauthGrant:lock.reauthGrant}})).status===401,'LOCK grant for order A cannot lock order B');
  const concurrent=await Promise.all([1,2].map(()=>api('/transactions/'+firstOrder.id+'/secure',{token:dailyP.token,body:{requestId:crypto.randomUUID(),reauthGrant:lock.reauthGrant}})));
  check(concurrent.filter(r=>r.status===200).length===1,'same LOCK grant cannot debit twice in parallel');
  const stale=await lockGrant(daily,secondOrder.id);
  await db.prepare('UPDATE listings SET price=price+1,version=version+1 WHERE id=?').run(secondOrder.listingId);
  check((await api('/transactions/'+secondOrder.id+'/secure',{token:daily.token,body:{requestId:crypto.randomUUID(),reauthGrant:stale.reauthGrant}})).data.error==='CONTEXT_MISMATCH','price change after G prevents locking stale order');
  const dailyBalance=await db.prepare('SELECT available_balance FROM wallets WHERE user_id=?').get(daily.user.id);
  const expensive=await order(seller,daily,dailyBalance.available_balance+1000);
  check((await api('/transactions/'+expensive.id+'/reauth/options',{token:daily.token,body:{action:'LOCK_ESCROW'}})).data.error==='INSUFFICIENT_FUNDS','balance failure is reported before invoking Passkey');
  const expiryOrder=await order(seller,daily,3000),expiredGrant=await lockGrant(daily,expiryOrder.id);
  await db.prepare('UPDATE reauth_grants SET expires_at=? WHERE token_hash=?').run(new Date(Date.now()-1000).toISOString(),sec.hash(expiredGrant.reauthGrant));
  check((await api('/transactions/'+expiryOrder.id+'/secure',{token:daily.token,body:{requestId:crypto.randomUUID(),reauthGrant:expiredGrant.reauthGrant}})).status===401,'expired LOCK grant cannot move money');
  const noCtx=await lockGrant(daily,expiryOrder.id);
  await db.prepare('UPDATE reauth_grants SET context_hash=NULL WHERE token_hash=?').run(sec.hash(noCtx.reauthGrant));
  check((await api('/transactions/'+expiryOrder.id+'/secure',{token:daily.token,body:{requestId:crypto.randomUUID(),reauthGrant:noCtx.reauthGrant}})).status===401,'LOCK grant without context fails closed');
  must(await secure(daily,expiryOrder.id,dailyP.token));
  const paidWallet=must(await api('/wallets/me',{token:daily.token}));
  assert.equal(paidWallet.availableBalance,dailyBalance.available_balance-3000,'wallet debit must equal the secured order amount');
  check(paidWallet.lockedBalance===0,'P session with correct G can pay; money is held in SYSTEM_ESCROW rather than buyer locked balance');
  const newEmail='changed@example.test',emailGrant=await grant(a,'CHANGE_EMAIL',{newEmail});
  check((await api('/passkeys/email/change/request',{token:a.token,body:{newEmail:'tampered@example.test',reauthGrant:emailGrant.reauthGrant}})).status===401,'change-email grant bound to new email');
  const requestedEmail=must(await api('/passkeys/email/change/request',{token:a.token,body:{newEmail,reauthGrant:emailGrant.reauthGrant}}));
  const oldCode=await otp(a.email,'Xác nhận đổi email'),newCode=await otp(newEmail,'Xác minh email mới');
  check((await api('/passkeys/email/change/verify',{token:a.token,body:{changeId:requestedEmail.changeId,oldCode:'wrong',newCode}})).status===400,'email change requires code from old mailbox');
  must(await api('/passkeys/email/change/verify',{token:a.token,body:{changeId:requestedEmail.changeId,oldCode,newCode}}));a.email=newEmail;
  check(must(await api('/users/me',{token:a.token})).user.email===newEmail,'both mailbox proofs complete email change');
  await deliver(seller,a,high.id);
  check((await api('/transactions/'+high.id+'/reauth/options',{token:a.token,body:{}})).data.error==='INSPECTION_REQUIRED','receipt alone cannot authorize release before inspection');
  must(await api('/transactions/'+high.id+'/inspected',{token:a.token,body:{}}));
  async function releaseGrant(){const opt=must(await api('/transactions/'+high.id+'/reauth/options',{token:a.token,body:{}}));const response=a.auth.authenticate({rpId:'localhost',origin:base,challenge:opt.options.challenge});return must(await api('/transactions/'+high.id+'/reauth/verify',{token:a.token,body:{reauthSessionId:opt.reauthSessionId,response}}));}
  const noContext=await releaseGrant();
  await db.prepare('UPDATE reauth_grants SET context_hash=NULL WHERE token_hash=?').run(sec.hash(noContext.reauthGrant));
  check((await api('/transactions/'+high.id+'/release',{token:a.token,body:{requestId:crypto.randomUUID(),reauthGrant:noContext.reauthGrant}})).status===401,'money grant missing context is rejected');
  const release=await releaseGrant(),releaseResults=await Promise.all([1,2].map(()=>api('/transactions/'+high.id+'/release',{token:a.token,body:{requestId:crypto.randomUUID(),reauthGrant:release.reauthGrant}})));
  check(releaseResults.filter(r=>r.status===200).length===1,'concurrent release with same G grant settles once');
  const refresh=await login(a);const rotated=await api('/passkeys/session/refresh',{method:'POST',cookie:refresh.cookie});must(rotated);
  await db.prepare('UPDATE auth_refresh_history SET created_at=? WHERE token_hash=?').run(new Date(Date.now()-11000).toISOString(),sec.hash(refresh.cookie.split('=')[1]));
  check((await api('/passkeys/session/refresh',{method:'POST',cookie:refresh.cookie})).status===401,'old refresh token reuse detected');
  check((await api('/users/me',{token:rotated.data.token})).status===401,'refresh reuse revokes its session family');
  const rec=await register('recover_test');const pRec=must(await login(rec));
  const backupGrant=await grant(rec,'REGENERATE_RECOVERY');
  rec.recoveryCodes=must(await api('/passkeys/recovery-codes/regenerate',{token:rec.token,body:{reauthGrant:backupGrant.reauthGrant}})).recoveryCodes;
  const recovered=await api('/passkeys/recovery/code',{token:pRec.token,body:{password,code:rec.recoveryCodes[0]}});must(recovered);
  check(recovered.data.scope==='recover','recovery code authorizes only restricted recovery session');
  check((await api('/wallets/me',{token:recovered.data.token})).status===403,'recovery session cannot access business actions');
  check((await api('/passkeys/recovery/code',{token:pRec.token,body:{password,code:rec.recoveryCodes[0]}})).status===400,'recovery code is one-use');
  const recoveryOpt=must(await api('/passkeys/recovery/passkey/options',{token:recovered.data.token,body:{}})),newAuth=createAuthenticator();
  check(recoveryOpt.options.user.name===rec.user.username&&recoveryOpt.options.user.displayName.startsWith('@'+rec.user.username+' · '),'recovery uses the same distinguishable account label');
  const replaced=await api('/passkeys/recovery/passkey/verify',{token:recovered.data.token,body:{registrationSessionId:recoveryOpt.registrationSessionId,response:newAuth.register({rpId:'localhost',origin:base,challenge:recoveryOpt.options.challenge}),deviceName:'Khôi phục'}});must(replaced);rec.token=replaced.data.token;
  check((await api('/users/me',{token:pRec.token})).status===401,'completed recovery revokes old sessions');
  check((await passkeyLogin(rec)).status===401,'old Passkey revoked by completed recovery');
  rec.auth=newAuth;
  must(await api('/passkeys/recovery/email/request',{body:{email:rec.email}}));const startToken=await emailLink(rec.email,'Xác nhận yêu cầu');
  must(await api('/passkeys/recovery/email/start',{body:{token:startToken}}));
  check((await api('/passkeys/reauth/options',{token:rec.token,body:{action:'RELEASE_ESCROW'}})).status===400,'generic account reauth cannot mint money grant');
  check((await db.prepare('SELECT account_status FROM users WHERE id=?').get(rec.user.id)).account_status==='RECOVERING','email confirmation starts recovery waiting period');
  const kp=await passkeyLogin(rec);must(kp);rec.token=kp.data.token;
  check((await db.prepare('SELECT account_status FROM users WHERE id=?').get(rec.user.id)).account_status==='ACTIVE','old Passkey login automatically cancels recovery');
  await db.prepare('DELETE FROM auth_limits WHERE bucket_key=?').run(sec.hash(`recovery-email-cooldown:${rec.email}`)); // advance the resend interval in this isolated fixture
  must(await api('/passkeys/recovery/email/request',{body:{email:rec.email}}));must(await api('/passkeys/recovery/email/start',{body:{token:await emailLink(rec.email,'Xác nhận yêu cầu')}}));
  const {processAuthMaintenance}=require('../src/lib/authJobs');await processAuthMaintenance();
  check(!(await db.prepare("SELECT 1 FROM auth_links WHERE user_id=? AND purpose='RECOVERY_FINISH'").get(rec.user.id)),'finish token not issued before 24h wait');
  await db.prepare('UPDATE account_recoveries SET available_at=?,expires_at=? WHERE user_id=? AND status=\'WAITING\'').run(new Date(Date.now()-1000).toISOString(),new Date(Date.now()+3600000).toISOString(),rec.user.id);
  await processAuthMaintenance();const finishToken=await emailLink(rec.email,'Đã đến thời điểm');
  check((await db.prepare('SELECT account_status FROM users WHERE id=?').get(rec.user.id)).account_status==='RECOVERING','elapsed 24h opens completion but does not reactivate account automatically');
  const authorized=must(await api('/passkeys/recovery/email/authorize',{body:{token:finishToken}}));
  const finalOpt=must(await api('/passkeys/recovery/passkey/options',{token:authorized.token,body:{}})),finalAuth=createAuthenticator();
  const final=await api('/passkeys/recovery/passkey/verify',{token:authorized.token,body:{registrationSessionId:finalOpt.registrationSessionId,response:finalAuth.register({rpId:'localhost',origin:base,challenge:finalOpt.options.challenge}),newPassword:'KhoiPhuc-Mail-2026!'}});must(final);
  check(Date.parse(final.data.recoveryRestrictedUntil)>Date.now()+71*3600000,'email recovery enforces 72h money restriction');
  await assert.rejects(()=>sec.assertMoneyAllowed(rec.user.id,'RELEASE_ESCROW'),e=>e.code==='RECOVERY_MONEY_RESTRICTED');checks++;console.log('PASS money guard rejects recovered account');
  for(const username of ['Admin','a..b','.dung','dũng'])check((await api('/passkeys/register/account',{body:{email:crypto.randomUUID()+'@example.test',username,displayName:'Tên thử',password}})).status===400,'invalid username rejected: '+username);
  const locked=await register('locked_test');for(let i=0;i<5;i++)await api('/passkeys/login/password',{body:{username:locked.user.username,password:'Incorrect!2026'}});
  check((await login(locked)).status===429,'five wrong passwords lock password login');
  const probe=require('node:child_process').spawnSync(process.execPath,['-e',"require('./src/lib/loginThrottle').lockedFor(process.argv[1]).then(async n=>{console.log('LOCK_SECONDS='+n);await require('./src/db').db.close()})",locked.user.id],{cwd:root,env:process.env,encoding:'utf8',windowsHide:true,timeout:30000});
  check(probe.status===0&&/LOCK_SECONDS=[1-9]\d*/.test(probe.stdout),'fresh server process reads persistent password lock');
  await stop();await start();check((await login(locked)).status===429,'password lock survives server listener restart');
  check((await passkeyLogin(locked)).status===200,'Passkey login still works while password locked');
  check((await login(locked)).status===200,'successful Passkey clears account password lock');
  // Audited administrator bootstrap, then real dispute decisions with fresh WebAuthn grants.
  const {createBootstrapAdmin}=require('../src/lib/adminBootstrap');
  const temporaryPassword='Temporary-Admin-2026!';
  await createBootstrapAdmin({username:'admin_auth_test',displayName:'Quản trị thử nghiệm',temporaryPassword,source:'BOOTSTRAP_CLI'});
  const adminLogin=must(await api('/passkeys/login/password',{body:{username:'admin_auth_test',password:temporaryPassword}}));
  const adminChanged=must(await api('/passkeys/bootstrap/password',{token:adminLogin.token,body:{currentPassword:temporaryPassword,newPassword:'Admin-Moi-2026!'}}));
  const adminAuth=createAuthenticator(),adminOpt=must(await api('/passkeys/register/passkey/options',{token:adminChanged.token,body:{}}));
  const admin=must(await api('/passkeys/register/passkey/verify',{token:adminChanged.token,body:{registrationSessionId:adminOpt.registrationSessionId,response:adminAuth.register({rpId:'localhost',origin:base,challenge:adminOpt.options.challenge})}}),201);
  check(admin.user.role==='ADMIN'&&admin.user.authMethod==='passkey','audited administrator bootstrap remains usable');
  check(!(await db.prepare('SELECT 1 FROM wallets WHERE user_id=?').get(admin.user.id)),'administrator activation never creates a wallet');
  for(const decision of ['REFUND','RELEASE']){
    const t=await order(seller,a,25000);must(await secure(a,t.id));
    await deliver(seller,a,t.id);
    const d=must(await api('/transactions/'+t.id+'/dispute',{token:a.token,body:{reason:'Hàng thử không đúng mô tả, yêu cầu quản trị phân xử.'}}),201).dispute;
    must(await api('/admin/disputes/'+d.id+'/claim',{token:admin.token,body:{}}));
    const detail=must(await api('/admin/disputes/'+d.id,{token:admin.token}));
    const review=must(await api('/admin/disputes/'+d.id+'/review',{token:admin.token,body:{decision,basis:'Đã xem thông tin và đối chiếu nội dung hai bên trong tình huống thử nghiệm xác thực; lưu căn cứ trước khi ra quyết định.',reviewed:true,receiptAcknowledged:true,expectedDisputeRevision:detail.dispute.revision,expectedOrderVersion:detail.transaction.version}}),201).review;
    const opt=must(await api('/admin/disputes/'+d.id+'/reauth/options',{token:admin.token,body:{decision,reviewId:review.id}}));
    const signed=must(await api('/admin/disputes/'+d.id+'/reauth/verify',{token:admin.token,body:{reauthSessionId:opt.reauthSessionId,response:adminAuth.authenticate({rpId:'localhost',origin:base,challenge:opt.options.challenge})}}));
    const other=decision==='REFUND'?'release':'refund';
    check((await api('/admin/disputes/'+d.id+'/'+other,{token:admin.token,body:{requestId:crypto.randomUUID(),reauthGrant:signed.reauthGrant}})).status===401,'adjudication grant cannot change decision '+decision);
    const settled=await api('/admin/disputes/'+d.id+'/'+decision.toLowerCase(),{token:admin.token,body:{requestId:crypto.randomUUID(),reauthGrant:signed.reauthGrant}});must(settled);
    check(settled.data.transaction.status===(decision==='REFUND'?'REFUNDED':'RELEASED'),'fresh G grant settles dispute '+decision);
  }
  const knownReset=must(await api('/passkeys/password-reset/request',{body:{email:a.email}}));
  const unknownReset=must(await api('/passkeys/password-reset/request',{body:{email:'unknown@example.test'}}));
  check(knownReset.message===unknownReset.message,'forgot-password request does not disclose existing email');
  const resetToken=await emailLink(a.email,'Đặt lại mật khẩu');
  must(await api('/passkeys/password-reset/complete',{body:{token:resetToken,newPassword:'Reset-MatKhau-2026!'}}));
  check((await api('/users/me',{token:a.token})).status===401,'password reset revokes all old sessions');
  check((await api('/passkeys/password-reset/complete',{body:{token:resetToken,newPassword:'Reset-Lai-2026!'}})).status===400,'password-reset link is one-use');
  const proofEmail='proof@example.test';
  const proofFlow=must(await api('/passkeys/register/account',{body:{email:proofEmail,username:'proof_user',displayName:'Người thử xác minh',password}}),201);
  const proofSession=must(await api('/passkeys/email/verify',{token:proofFlow.token,body:{code:await otp(proofEmail)}}));
  const passwordOnly=await require('../src/lib/session').createSession(proofSession.user.id);
  const proofUser=await db.prepare('SELECT * FROM users WHERE id=?').get(proofSession.user.id);
  const noProofToken=require('../src/lib/auth').signAccessToken(proofUser,'full',passwordOnly.sessionId);
  check((await api('/passkeys/register/passkey/options',{token:noProofToken,body:{}})).data.error==='EMAIL_VERIFICATION_REQUIRED','VERIFIED account still needs mailbox proof on a fresh activation session');
  const resumed=must(await api('/passkeys/login/password',{body:{username:'proof_user',password}}));
  check(resumed.scope==='full'&&resumed.user.accountStatus==='VERIFIED','password login resumes browsing for VERIFIED account without forced setup');
  check((await api('/passkeys/email/enroll/request',{token:resumed.token,body:{email:'attacker@example.test'}})).status===409,'password-only VERIFIED session cannot replace verified mailbox before first key');
  await db.prepare('UPDATE auth_email_codes SET sent_at=? WHERE user_id=?').run(new Date(Date.now()-61000).toISOString(),proofUser.id);
  must(await api('/passkeys/email/resend',{token:resumed.token,body:{}}));
  const renewed=must(await api('/passkeys/email/verify',{token:resumed.token,body:{code:await otp(proofEmail)}}));
  check((await api('/passkeys/register/passkey/options',{token:renewed.token,body:{}})).status===200,'fresh mailbox proof unlocks in-place wallet activation');
  const proofSid=require('jsonwebtoken').decode(renewed.token).sid;
  await db.prepare('UPDATE sessions SET enrollment_verified_at=? WHERE id=?').run(new Date(Date.now()-31*60000).toISOString(),proofSid);
  check((await api('/passkeys/register/passkey/options',{token:renewed.token,body:{}})).data.error==='EMAIL_VERIFICATION_REQUIRED','email proof older than 30 minutes cannot enroll first Passkey');
  await db.prepare("UPDATE users SET created_at=?,auth_last_active_at=? WHERE username='first_user'").run(new Date(Date.now()-31*86400000).toISOString(),new Date(Date.now()-31*86400000).toISOString());
  await require('../src/lib/authJobs').processAuthMaintenance();
  check(!(await db.prepare("SELECT 1 FROM users WHERE username='first_user'").get()),'BASIC account inactive 30 days expires without changing active wallets');
  await db.prepare("UPDATE users SET account_status='SUSPENDED' WHERE id=?").run(locked.user.id);
  check((await login(locked)).status===401,'SUSPENDED blocks password login even with is_active flag still set');
  check((await passkeyLogin(locked)).status===401,'SUSPENDED blocks Passkey login');
  check((await api('/users/me',{token:locked.token})).status===401,'SUSPENDED rejects existing access tokens');
  await db.prepare("UPDATE users SET account_status='ACTIVE' WHERE id=?").run(locked.user.id);
  const invariantResult=await require('../src/lib/invariants').checkInvariants();check(invariantResult.ok,'all nine money/account invariants hold after auth and concurrency scenarios');
  const lateOrder=await order(seller,daily,4000);must(await secure(daily,lateOrder.id));
  await deliver(seller,daily,lateOrder.id);
  await db.prepare('UPDATE transactions SET inspection_due_at=? WHERE id=?').run(new Date(Date.now()-1000).toISOString(),lateOrder.id);
  const balances=JSON.stringify(await db.prepare('SELECT id,available_balance,locked_balance FROM wallets ORDER BY id').all());
  const {expireInspections}=require('../src/lib/orderInspection');await Promise.all([expireInspections(),expireInspections()]);
  check((await db.prepare('SELECT status FROM transactions WHERE id=?').get(lateOrder.id)).status==='DISPUTED','inspection timeout opens dispute instead of automatically releasing');
  check((await db.prepare('SELECT COUNT(*) AS n FROM disputes WHERE transaction_id=?').get(lateOrder.id)).n===1,'parallel inspection workers open only one dispute');
  check(JSON.stringify(await db.prepare('SELECT id,available_balance,locked_balance FROM wallets ORDER BY id').all())===balances,'inspection expiry does not move any balance');
  check((await api('/transactions/'+lateOrder.id+'/reauth/options',{token:daily.token,body:{}})).status===409,'inspection timeout still cannot authorize release before explicit inspection');
  const expiring=await register('expire_test');
  const beforeExpiry=await db.prepare('SELECT password_hash FROM users WHERE id=?').get(expiring.user.id);
  const oldKeys=await db.prepare('SELECT credential_id FROM passkey_credentials WHERE user_id=? ORDER BY credential_id').all(expiring.user.id);
  must(await api('/passkeys/recovery/email/request',{body:{email:expiring.email}}));
  must(await api('/passkeys/recovery/email/start',{body:{token:await emailLink(expiring.email,'Xác nhận yêu cầu')}}));
  await db.prepare("UPDATE account_recoveries SET available_at=?,expires_at=? WHERE user_id=? AND status='WAITING'").run(new Date(Date.now()-1000).toISOString(),new Date(Date.now()+3600000).toISOString(),expiring.user.id);
  await processAuthMaintenance();const expiredToken=await emailLink(expiring.email,'Đã đến thời điểm');
  await db.prepare("UPDATE account_recoveries SET expires_at=? WHERE user_id=? AND status='READY'").run(new Date(Date.now()-1000).toISOString(),expiring.user.id);
  await processAuthMaintenance();
  check((await db.prepare('SELECT account_status FROM users WHERE id=?').get(expiring.user.id)).account_status==='ACTIVE','expired completion window restores ACTIVE rather than leaving RECOVERING stuck');
  check((await db.prepare('SELECT password_hash FROM users WHERE id=?').get(expiring.user.id)).password_hash===beforeExpiry.password_hash,'expired recovery keeps the old password unchanged');
  check(JSON.stringify(await db.prepare('SELECT credential_id FROM passkey_credentials WHERE user_id=? ORDER BY credential_id').all(expiring.user.id))===JSON.stringify(oldKeys),'expired recovery preserves old Passkeys');
  check((await api('/passkeys/recovery/email/authorize',{body:{token:expiredToken}})).status===403,'expired recovery request cannot authorize key replacement even if emailed link has time left');
  check((await passkeyLogin(expiring)).status===200,'old Passkey still logs in after abandoned recovery expires');
  console.log(`AUTH REDESIGN: ${checks} checks passed. Isolated DB: ${tmp}`);
}
main().catch(e=>{console.error(e);console.error(logs.slice(-12000));process.exitCode=1;}).finally(async()=>{await stop();if(db)await db.close();});
