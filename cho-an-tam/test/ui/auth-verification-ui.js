const assert=require('node:assert/strict');
const {wallet,json,sleep,logoutUi}=require('./paypal-wallet-ui');
let checks=0;
const ok=(v,m)=>{assert.ok(v,m);checks++;console.log('PASS '+m);};
const basic={id:'verify-user',username:'mail_user',displayName:'Người dùng',role:'BUYER',accountStatus:'BASIC',authMethod:'password',sessionId:'p-session',email:'mail@example.test',emailVerified:false,emailProofFresh:false,recoveryAcknowledged:false};
const path='#/account-action?purpose=verify-email&token=opaque-one-time-fixture';
async function click(p,act,ms=160){const b=p.d.querySelector('[data-act="'+act+'"]');assert.ok(b,'button '+act);p.click(b);await sleep(ms);}
const preview=()=>json(200,{username:basic.username,emailMask:'ma***@example.test',expiresAt:new Date(Date.now()+600000).toISOString()});
async function main(){
 let p=await wallet({user:basic,hash:path,extra:{'POST /api/passkeys/email/link/preview':preview,'POST /api/passkeys/email/link/confirm':()=>json(200,{verified:true,message:'Đã xác minh.',user:{...basic,accountStatus:'VERIFIED',emailVerified:true,emailProofFresh:true}})}});
 try{
  ok(p.count('POST /api/passkeys/email/link/preview')===1&&p.count('POST /api/passkeys/email/link/confirm')===0,'opening link previews without confirmation POST');
  ok(!p.w.location.hash.includes('opaque-one-time')&&!JSON.stringify(p.store()).includes('opaque-one-time'),'link token removed from URL and never stored');
  ok(/mail_user/.test(p.d.getElementById('modalRoot').textContent)&&/ma\*\*\*/.test(p.d.getElementById('modalRoot').textContent),'confirmation shows target username and masked email');
  const before=p.authState();await click(p,'email-link-confirm');
  ok(p.authState().token===before.token&&p.authState().user.sessionId===before.user.sessionId&&p.authState().user.authMethod==='password','confirmation keeps same P token/session');
  ok(p.authState().user.emailVerified&&p.authState().user.emailProofFresh,'confirmation updates only current session email evidence');
  ok(p.count('POST /api/passkeys/register/passkey/options')===0&&p.count('POST /api/payments/paypal/topup')===0,'link does not create Passkey or initiate topup');
 }finally{p.close();}
 p=await wallet({user:{...basic,id:'other',username:'other_user',sessionId:'other-session'},hash:path,extra:{'POST /api/passkeys/email/link/preview':preview}});
 try{
  ok(!p.d.querySelector('[data-act="email-link-confirm"]')&&!!p.d.querySelector('[data-act="email-link-switch"]'),'wrong account cannot see a confirmation action');
  await click(p,'email-link-switch');
  ok(!p.authState().token&&!p.d.querySelector('[data-act="email-link-confirm"]'),'switch requires explicit logout before normal login');
  p.routes['POST /api/passkeys/login/password']=()=>json(200,{token:'target-p',scope:'full',user:basic});
  await click(p,'email-link-login');p.d.getElementById('loginUsername').value=basic.username;p.d.getElementById('loginPassword').value='fixture-password';await click(p,'do-login-password',240);
  ok(!!p.d.querySelector('[data-act="email-link-confirm"]')&&p.count('POST /api/passkeys/email/link/confirm')===0,'link intent survives account switch and login without auto-confirm');
  ok(!JSON.stringify(p.store()).includes('opaque-one-time'),'account switch does not persist link secret');
 }finally{p.close();}
 const now=Date.now(),meta={serverNow:new Date(now).toISOString(),nextRequestAt:new Date(now+30000).toISOString(),expiresAt:new Date(now+600000).toISOString(),resendAfterSeconds:30,emailMask:'ma***@example.test'};
 p=await wallet({user:basic,hash:'#/wallet',extra:{'POST /api/passkeys/email/resend':()=>json(200,meta)}});
 try{
  await click(p,'activate-wallet');
  const first=p.d.getElementById('emailResend').textContent;
  ok(p.bodies['POST /api/passkeys/email/resend'][0].ensure===true,'BASIC activation ensures current code on server');
  ok(!first.includes('60')&&p.d.getElementById('emailResend').disabled,'cooldown uses server deadline rather than hardcoded 60 seconds');
  await click(p,'activation-later');await click(p,'activate-wallet');
  ok(!p.d.getElementById('emailResend').textContent.includes('60'),'reopening email step does not reset cooldown to sixty');
  ok(!/Chúng tôi đã gửi/.test(p.d.getElementById('modalRoot').textContent),'UI does not claim email delivery from metadata');
 }finally{p.close();}
 p=await wallet({user:basic,hash:'#/wallet',extra:{'POST /api/passkeys/email/resend':()=>json(503,{error:'EMAIL_NOT_CONFIGURED',message:'Chưa gửi được mã.'})}});
 try{
  await click(p,'activate-wallet');
  ok(p.d.querySelectorAll('.operation-error').length===1&&p.d.getElementById('emailResend').textContent==='Thử lại','failed ensure gives one inline error and retry');
  p.routes['POST /api/passkeys/email/resend']=()=>({...json(429,{error:'EMAIL_SEND_LIMIT',message:'Thử lại sau.'}),headers:{'Retry-After':'42'}});
  await click(p,'email-resend');
  ok(p.d.getElementById('emailResend').disabled&&/4[12]/.test(p.d.getElementById('emailResend').textContent),'429 retry follows exposed Retry-After');
  ok(!!p.d.querySelector('[data-act="activation-later"]'),'send failure retains a clear defer option');
 }finally{p.close();}
 p=await wallet({user:basic,hash:'#/wallet'});
 try{
  p.routes['POST /api/passkeys/email/verify']=()=>json(200,{token:'verified-p',scope:'full',user:{...basic,accountStatus:'VERIFIED',emailVerified:true,emailProofFresh:true}});
  await click(p,'activate-wallet');p.d.getElementById('emailVerificationCode').value='123456';await click(p,'email-verify');
  const codes=['ABCDE-FGHJK','LMNPQ-RSTUV','WXYZA-BCDEF','GHJKL-MNPQR','STUVW-XYZAB','CDEFG-HJKLM','NPQRS-TUVWX','YZABC-DEFGH'];
  p.routes['POST /api/passkeys/register/passkey/options']=()=>json(200,{registrationSessionId:'fixture',options:{}});
  // An old server may still include codes during a rolling deployment; activation must ignore them.
  p.routes['POST /api/passkeys/register/passkey/verify']=()=>json(201,{token:'active-k',scope:'full',user:{...basic,accountStatus:'ACTIVE',emailVerified:true,authMethod:'passkey'},recoveryCodes:codes});
  p.w.SimpleWebAuthnBrowser.startRegistration=async()=>({id:'key'});await click(p,'do-enroll-passkey',240);
  p.d.dispatchEvent(new p.w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
  ok(!p.d.querySelector('.recovery-code-grid'),'activation does not force backup codes even when an older server includes them');
  ok(!!p.d.getElementById('topupAmount'),'successful activation immediately resumes the original wallet route');
  ok(p.count('POST /api/passkeys/recovery-codes/acknowledge')===0,'omitting optional backup setup never falsely marks codes saved');
 }finally{p.close();}
 console.log('AUTH VERIFICATION UI: '+checks+' checks passed');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
