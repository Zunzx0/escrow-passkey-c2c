// Product DOM with fake API/mail only; no real account or browser credentials.
const assert=require('node:assert/strict');
const {wallet,json,sleep,logoutUi}=require('./paypal-wallet-ui');
let checks=0;
const ok=(value,message)=>{assert.ok(value,message);checks++;console.log('PASS '+message);};
async function click(p,act,ms=180){const btn=p.d.querySelector('[data-act="'+act+'"]');assert.ok(btn,'button '+act);p.click(btn);await sleep(ms);}
const metadata=(token,delay=60000)=>({message:'Yêu cầu mã đã được tiếp nhận.',requestToken:token,emailMask:'ma***@example.test',serverNow:new Date().toISOString(),nextRequestAt:new Date(Date.now()+delay).toISOString(),expiresAt:new Date(Date.now()+600000).toISOString()});
async function until(condition,timeout=4000){const end=Date.now()+timeout;while(Date.now()<end){if(condition())return;await sleep(25);}assert.fail('Timed out waiting for the visible UI state');}
async function main(){
 const p=await wallet({hash:'#/'});
 try{
  await logoutUi(p);await click(p,'open-auth');await click(p,'lost-passkey');
  ok(!!p.d.getElementById('recoveryEmail')&&!p.d.getElementById('recoveryCode'),'lost Passkey starts with email instead of asking for saved codes');
  ok(/24 giờ/.test(p.d.getElementById('modalRoot').textContent)&&/72 giờ/.test(p.d.getElementById('modalRoot').textContent),'waiting and post-recovery limits are explained before requesting mail');
  p.d.getElementById('recoveryEmail').value='mail@example.test';
  let respond;p.routes['POST /api/passkeys/recovery/email/request']=()=>new Promise(resolve=>{respond=resolve;});
  await click(p,'recovery-email-request',25);
  ok([...p.d.querySelectorAll('#modalRoot button')].every(b=>b.disabled),'requesting recovery mail locks all modal actions');
  respond(json(200,metadata('private-request-one',1200)));await sleep(200);
  ok(p.d.getElementById('recoveryEmailCode')?.getAttribute('autocomplete')==='one-time-code','email recovery supports OTP autofill');
  ok(p.d.getElementById('recoveryEmailResend').disabled,'recovery resend starts with server cooldown');
  ok(p.count('POST /api/passkeys/recovery/email/verify')===0,'receiving a code request never starts recovery automatically');
  ok(!JSON.stringify(p.store()).includes('private-request-one')&&!JSON.stringify({...p.w.sessionStorage}).includes('private-request-one'),'recovery flow token stays out of persistent storage');
  await until(()=>!p.d.getElementById('recoveryEmailResend').disabled);
  p.routes['POST /api/passkeys/recovery/email/request']=()=>({...json(429,{error:'RATE_LIMITED',message:'Vui lòng chờ để gửi lại mã.'}),headers:{'Retry-After':'3'}});
  await click(p,'recovery-email-resend');await sleep(1050);
  ok(p.d.getElementById('recoveryEmailResend').disabled&&!!p.d.querySelector('.operation-error'),'resend 429 remains inline and honors Retry-After');
  p.d.getElementById('recoveryEmailCode').value='123456';
  p.routes['POST /api/passkeys/recovery/email/verify']=()=>json(400,{error:'RECOVERY_EMAIL_CODE_INVALID',message:'Mã không đúng hoặc đã hết hạn.'});
  await click(p,'recovery-email-code-verify');
  ok(!!p.d.getElementById('recoveryEmailCode')&&p.d.querySelectorAll('.operation-error').length===1,'wrong code preserves the form with one inline error');
  const sent=p.bodies['POST /api/passkeys/recovery/email/verify'][0];
  ok(sent.requestToken==='private-request-one'&&sent.code==='123456','verification sends the code with its opaque request context');
  p.routes['POST /api/passkeys/recovery/email/verify']=()=>json(200,{availableAt:new Date(Date.now()+86400000).toISOString(),message:'Đã xác nhận email. Chờ đến thời điểm tiếp tục khôi phục.'});
  await click(p,'recovery-email-code-verify');
  ok(/Đã xác nhận yêu cầu khôi phục/.test(p.d.querySelector('.modal-head').textContent)&&/Có thể tiếp tục từ/.test(p.d.querySelector('.modal-body').textContent),'successful verification shows the server recovery availability time');
  ok(!p.d.getElementById('recoveryNewPassword')&&p.count('POST /api/passkeys/recovery/passkey/options')===0,'OTP acceptance does not bypass the wait or create a Passkey');
  ok(!p.authState().token,'email OTP does not log the user in');
  await click(p,'modal-close');await click(p,'open-auth');await click(p,'forgot-password');
  p.d.getElementById('recoveryEmail').value='mail@example.test';
  p.routes['POST /api/passkeys/password-reset/request']=()=>json(200,{message:'Hãy kiểm tra hộp thư.'});
  await click(p,'recovery-email-request');
  ok(/Kiểm tra hộp thư/.test(p.d.querySelector('.modal-head').textContent)&&p.count('POST /api/passkeys/password-reset/request')===1,'forgot-password link flow remains separate and usable');
  await click(p,'modal-close');await click(p,'open-auth');await click(p,'lost-passkey');
  p.d.getElementById('recoveryEmail').value='mail@example.test';
  p.routes['POST /api/passkeys/recovery/email/request']=()=>json(200,{message:'Hãy kiểm tra liên kết trong email.'});
  await click(p,'recovery-email-request');
  ok(/Kiểm tra hộp thư/.test(p.d.querySelector('.modal-head').textContent),'new UI also supports a previous server during rolling deployment');
  console.log('EMAIL RECOVERY UI: '+checks+' checks passed');
 }finally{p.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
