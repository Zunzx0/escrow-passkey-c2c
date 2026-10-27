// Mobile regression for auth v3: readiness warns but must not exclude hybrid/security keys.
const assert=require('node:assert/strict');
const {wallet,json,sleep,logoutUi}=require('./paypal-wallet-ui');
let checks=0;
const ok=(value,message)=>{assert.ok(value,message);checks++;console.log('PASS '+message);};
const chrome='Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/124.0.0.0 Mobile Safari/537.36';
const webview='Mozilla/5.0 (Linux; Android 14; wv) AppleWebKit/537.36 Version/4.0 Chrome/124.0.0.0 Mobile Safari/537.36';
const iphone='Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1';
const desktop='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36';
const ipadDesktop='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15';
async function page({ua=chrome,platform=true,coarse=false}={}){
 const p=await wallet({hash:'#/wallet'});await logoutUi(p);
 Object.defineProperty(p.w.navigator,'userAgent',{value:ua,configurable:true});
 p.w.matchMedia=query=>({matches:coarse&&query==='(any-pointer: coarse)',media:query});
 Object.defineProperty(p.w.navigator,'credentials',{value:{create:async()=>({})},configurable:true});
 p.w.PublicKeyCredential=class {};
 p.w.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable=async()=>platform;
 p.routes['POST /api/passkeys/register/passkey/options']=()=>json(200,{registrationSessionId:'ready-enroll',options:{},expiresAt:new Date(Date.now()+300000).toISOString()});
 p.routes['POST /api/passkeys/login/options']=()=>json(200,{authenticationSessionId:'ready-login',options:{},expiresAt:new Date(Date.now()+300000).toISOString()});
 p.routes['POST /api/passkeys/register/account']=()=>json(201,{token:'mobile-basic',scope:'full',user:{id:'flow',displayName:'Mobile Test',role:'BUYER',accountStatus:'BASIC',emailVerified:false,email:'mobile@example.test',emailMask:'mo***@example.test'}});
 p.click(p.d.querySelector('[data-act="open-auth-register"]'));await sleep(220);return p;
}
async function register(p,onOtp){
 for(const [id,value] of Object.entries({regEmail:'mobile@example.test',regUsername:'mobile_test',regDisplayName:'Mobile Test',regPassword:'MatKhau-Test-2026!'}))p.d.getElementById(id).value=value;
 p.click(p.d.querySelector('[data-act="do-register"]'));await sleep(180);
 p.w.location.hash='#/wallet';await sleep(200);p.click(p.d.querySelector('[data-act="activate-wallet"]'));await sleep(120);
 onOtp?.(p);
 p.routes['POST /api/passkeys/email/verify']=()=>json(200,{token:'verified-mobile',scope:'full',user:{id:'flow',displayName:'Mobile Test',role:'BUYER',accountStatus:'VERIFIED',emailVerified:true}});
 p.d.getElementById('emailVerificationCode').value='123456';p.click(p.d.querySelector('[data-act="email-verify"]'));await sleep(200);
}
async function main(){
 let p=await page();
 try{await register(p);ok(/Thiết bị sẵn sàng/.test(p.d.getElementById('setupPasskeyReadiness').textContent),'supported Android reports readiness');}finally{p.close();}
 p=await page({ua:iphone});
 try{
  ok(p.d.activeElement.getAttribute('role')==='dialog','iPhone user agent opens registration with dialog focus rather than input focus');
  const heading=p.d.getElementById(p.d.activeElement.getAttribute('aria-labelledby'));
  ok(heading?.textContent==='Tạo tài khoản Enclave','focused dialog exposes its current title to assistive technology');
  p.d.getElementById('regEmail').focus();
  ok(p.d.activeElement.id==='regEmail','iPhone users can still focus an input themselves');
  await register(p,()=>ok(p.d.activeElement.getAttribute('role')==='dialog','opening email verification does not automatically focus the OTP input on iPhone'));
  ok(p.d.activeElement.getAttribute('role')==='dialog','email to Passkey transition does not focus the optional name input on iPhone');
  p.d.getElementById('activationDeviceName').focus();
  ok(p.d.activeElement.id==='activationDeviceName','optional Passkey name remains editable when selected');
 }finally{p.close();}
 // Safari chỉ mở Face ID khi create() chạy ngay trong lượt chạm: options phải có sẵn trước khi chạm.
 p=await page({ua:iphone});
 try{
  let n=0;p.routes['POST /api/passkeys/register/passkey/options']=()=>json(200,{registrationSessionId:'pre-'+(++n),options:{}});
  await register(p);await sleep(120);
  ok(p.count('POST /api/passkeys/register/passkey/options')===1,'activation screen prefetches registration options before the tap');
  const used=[];
  let errorScrolled=0;p.w.HTMLElement.prototype.scrollIntoView=function(){if(this.classList.contains('operation-error'))errorScrolled++;};
  p.w.SimpleWebAuthnBrowser.startRegistration=async({optionsJSON})=>{used.push(optionsJSON);const e=new Error('denied');e.name='NotAllowedError';throw e;};
  p.click(p.d.querySelector('[data-act="do-enroll-passkey"]'));
  ok(used.length===1,'tap calls WebAuthn synchronously, with no network wait inside the user gesture');
  await sleep(220);
  ok(p.d.querySelector('#modalRoot .operation-error')&&p.count('POST /api/passkeys/register/passkey/verify')===0,'denied ceremony shows an error and never verifies');
  ok(errorScrolled===1,'ceremony failure scrolls its inline error into view');
  ok(p.count('POST /api/passkeys/register/passkey/options')===2,'failed ceremony prefetches fresh options for the next tap');
  const verified=[];
  p.routes['POST /api/passkeys/register/passkey/verify']=(opts)=>{verified.push(JSON.parse(opts.body));return json(400,{error:'VERIFICATION_FAILED',message:'x'});};
  p.w.SimpleWebAuthnBrowser.startRegistration=async()=>{used.push(1);return {id:'cred'};};
  p.click(p.d.querySelector('[data-act="do-enroll-passkey"]'));
  ok(used.length===2,'retry tap is synchronous too');
  await sleep(220);
  ok(verified[0]?.registrationSessionId==='pre-2','verify uses the prefetched registration session, each one only once');
  ok(p.count('POST /api/passkeys/register/passkey/options')===3,'failed server verification also prepares a fresh one-use challenge');
 }finally{p.close();}
 // Đăng nhập bằng Passkey: get() cũng phải chạy ngay trong lượt chạm.
 p=await page({ua:iphone});
 try{
  let n=0;p.routes['POST /api/passkeys/login/options']=()=>json(200,{authenticationSessionId:'login-'+(++n),options:{}});
  p.click(p.d.querySelector('[data-act="auth-tab"][data-tab="login"]'));await sleep(150);
  const before=p.count('POST /api/passkeys/login/options');
  ok(before>=1,'login tab prefetches authentication options before the tap');
  const used=[];
  p.w.SimpleWebAuthnBrowser.startAuthentication=async({useBrowserAutofill})=>{if(useBrowserAutofill)return new Promise(()=>{});used.push(1);const e=new Error('denied');e.name='NotAllowedError';throw e;};
  p.click(p.d.querySelector('[data-act="do-login-passkey"]'));
  ok(used.length===1,'Passkey login tap calls WebAuthn synchronously');
  await sleep(220);
  ok(p.count('POST /api/passkeys/login/options')===before+1&&p.count('POST /api/passkeys/login/verify')===0,'failed login prefetches fresh options and never verifies');
  p.click(p.d.querySelector('[data-act="do-login-passkey"]'));
  ok(used.length===2,'login retry tap is synchronous too');
 }finally{p.close();}
 // Tạo Passkey khôi phục sau liên kết email: create() cũng phải chạy ngay trong lượt chạm.
 p=await page({ua:iphone});
 try{
  p.routes['POST /api/passkeys/recovery/email/authorize']=()=>json(200,{token:'recover-token',scope:'recover',recoveryMethod:'EMAIL',user:{id:'flow',displayName:'Mobile Test',role:'BUYER',accountStatus:'RECOVERING',emailVerified:true}});
  let n=0;p.routes['POST /api/passkeys/recovery/passkey/options']=()=>json(200,{registrationSessionId:'rec-'+(++n),options:{}});
  p.w.location.hash='#/account-action?purpose=recovery-finish&token=link-token';await sleep(200);
  p.click(p.d.querySelector('[data-act="recovery-link-confirm"]'));await sleep(250);
  ok(p.count('POST /api/passkeys/recovery/passkey/options')===1,'recovery Passkey screen prefetches registration options');
  const used=[];
  p.w.SimpleWebAuthnBrowser.startRegistration=async()=>{used.push(1);const e=new Error('denied');e.name='NotAllowedError';throw e;};
  p.click(p.d.querySelector('[data-act="recovery-passkey-create"]'));await sleep(30);
  ok(used.length===0&&p.count('POST /api/passkeys/recovery/passkey/verify')===0,'empty required recovery password never creates or verifies a device credential');
  ok(p.count('POST /api/passkeys/recovery/passkey/options')===1,'password validation preserves the prepared challenge for the corrected tap');
  p.d.getElementById('recoveryNewPassword').value='MatKhau-Moi-2026!';
  p.click(p.d.querySelector('[data-act="recovery-passkey-create"]'));
  ok(used.length===1,'recovery Passkey tap calls WebAuthn synchronously');
  await sleep(220);
  ok(p.count('POST /api/passkeys/recovery/passkey/options')===2&&p.count('POST /api/passkeys/recovery/passkey/verify')===0,'failed recovery ceremony prefetches again and never verifies');
 }finally{p.close();}
 // Slow preparation must never resume a ceremony automatically after the tap.
 p=await page({ua:iphone});
 try{
  let respond;const used=[];
  p.routes['POST /api/passkeys/register/passkey/options']=()=>new Promise(resolve=>{respond=resolve;});
  p.w.SimpleWebAuthnBrowser.startRegistration=async()=>{used.push(1);throw Object.assign(new Error('denied'),{name:'NotAllowedError'});};
  await register(p);
  const button=p.d.querySelector('[data-act="do-enroll-passkey"]');
  ok(button.disabled&&/Đang chuẩn bị/.test(button.textContent),'slow enrollment preparation has a visible disabled preparing state');
  p.click(button);ok(used.length===0&&p.count('POST /api/passkeys/register/passkey/options')===1,'early taps neither call WebAuthn nor duplicate an in-flight preparation');
  respond(json(200,{registrationSessionId:'slow-ready',options:{},expiresAt:new Date(Date.now()+300000).toISOString()}));await sleep(70);
  ok(used.length===0&&!button.disabled,'network completion enables the button without starting the ceremony');
  p.click(button);ok(used.length===1,'the separate ready tap starts enrollment synchronously');
 }finally{p.close();}
 // A missing or failed cache is prepared again, not awaited inside a ceremony tap.
 p=await page({ua:iphone});
 try{
  let fail=true;const used=[];
  p.routes['POST /api/passkeys/register/passkey/options']=()=>fail?json(503,{error:'TEMPORARY_ERROR'}):json(200,{registrationSessionId:'retry-ready',options:{}});
  await register(p);
  ok(/Chuẩn bị Passkey lại/.test(p.d.querySelector('[data-act="do-enroll-passkey"]').textContent),'failed preparation exposes an explicit retry');
  fail=false;p.w.SimpleWebAuthnBrowser.startRegistration=async()=>{used.push(1);throw Object.assign(new Error('denied'),{name:'NotAllowedError'});};
  p.click(p.d.querySelector('[data-act="do-enroll-passkey"]'));await sleep(50);
  ok(used.length===0,'successful retry fetch never continues automatically into WebAuthn');
  p.click(p.d.querySelector('[data-act="do-enroll-passkey"]'));ok(used.length===1,'retry requires a separate ready tap for WebAuthn');
 }finally{p.close();}
 // Honor explicit server expiry even before the conservative client cache cap.
 p=await page({ua:iphone});
 try{
  let count=0;const used=[];
  p.routes['POST /api/passkeys/register/passkey/options']=()=>json(200,{registrationSessionId:'expiry-'+(++count),options:{},expiresAt:new Date(Date.now()+(count===1?30000:300000)).toISOString()});
  await register(p);
  const realNow=p.w.Date.now;p.w.Date.now=()=>realNow()+60000;
  p.w.SimpleWebAuthnBrowser.startRegistration=async()=>{used.push(1);throw Object.assign(new Error('denied'),{name:'NotAllowedError'});};
  p.click(p.d.querySelector('[data-act="do-enroll-passkey"]'));await sleep(50);
  ok(count===2&&used.length===0,'expired server challenge is discarded and replaced without opening WebAuthn');
  p.click(p.d.querySelector('[data-act="do-enroll-passkey"]'));ok(used.length===1,'fresh replacement starts only on the next tap');
  p.w.Date.now=realNow;
 }finally{p.close();}
 // Old modal replies cannot populate another modal's preparation cache.
 p=await page({ua:iphone});
 try{
  let oldReply;const used=[];
  p.routes['POST /api/passkeys/register/passkey/options']=()=>new Promise(resolve=>{oldReply=resolve;});
  await register(p);p.click(p.d.querySelector('[data-act="activation-later"]'));await sleep(50);
  oldReply(json(200,{registrationSessionId:'stale-modal',options:{}}));await sleep(50);
  ok(!p.d.querySelector('#modalRoot .modal')&&!p.d.getElementById('enrollPasskeyPreparation'),'late preparation cannot reopen or mutate a dismissed modal');
  p.routes['POST /api/passkeys/register/passkey/options']=()=>json(200,{registrationSessionId:'current-modal',options:{}});
  p.click(p.d.querySelector('[data-act="activate-wallet"]'));await sleep(100);
  p.routes['POST /api/passkeys/register/passkey/verify']=()=>json(400,{error:'VERIFICATION_FAILED',message:'test failure'});
  p.w.SimpleWebAuthnBrowser.startRegistration=async()=>{used.push(1);return {id:'new-credential'};};
  p.click(p.d.querySelector('[data-act="do-enroll-passkey"]'));await sleep(70);
  ok(used.length===1&&p.bodies['POST /api/passkeys/register/passkey/verify'][0].registrationSessionId==='current-modal','reopened modal consumes only its own prepared session');
 }finally{p.close();}
 // A native ceremony may resolve after the user signs out; never verify it in a new session.
 p=await page({ua:iphone});
 try{
  await register(p);let finish;
  p.w.SimpleWebAuthnBrowser.startRegistration=()=>new Promise(resolve=>{finish=resolve;});
  p.click(p.d.querySelector('[data-act="do-enroll-passkey"]'));await sleep(30);
  await logoutUi(p);finish({id:'late-credential'});await sleep(70);
  ok(!p.authState().token&&p.count('POST /api/passkeys/register/passkey/verify')===0,'native result after logout cannot verify or reactivate the old account');
 }finally{p.close();}
 // Both delayed explicit and optional conditional login must honor modal/tab scope.
 p=await page({ua:iphone});
 try{
  const replies=[],used=[];
  p.w.SimpleWebAuthnBrowser.browserSupportsWebAuthnAutofill=async()=>true;
  p.routes['POST /api/passkeys/login/options']=()=>new Promise(resolve=>replies.push(resolve));
  p.w.SimpleWebAuthnBrowser.startAuthentication=async()=>{used.push(1);return {id:'stale-login'};};
  p.click(p.d.querySelector('[data-act="auth-tab"][data-tab="login"]'));await sleep(40);
  p.click(p.d.querySelector('[data-act="auth-tab"][data-tab="register"]'));await sleep(30);
  for(const resolve of replies)resolve(json(200,{authenticationSessionId:'stale-login',options:{}}));await sleep(70);
  ok(used.length===0&&p.count('POST /api/passkeys/login/verify')===0,'late login options after tab switch never start conditional or explicit authentication');
  ok(!p.d.getElementById('loginPasskeyPreparation'),'login preparation status does not leak into the registration tab');
 }finally{p.close();}
 p=await page({ua:ipadDesktop,coarse:true});
 try{await register(p);ok(p.d.activeElement.getAttribute('role')==='dialog','touch tablet with a desktop user agent avoids automatic input focus');}finally{p.close();}
 p=await page({ua:desktop});
 try{
  await register(p,()=>ok(p.d.activeElement.id==='emailVerificationCode','desktop retains immediate OTP keyboard entry'));
  ok(p.d.activeElement.id==='activationDeviceName','desktop retains input focus when the next setup dialog opens');
 }finally{p.close();}
 p=await page({ua:webview});
 try{
  await register(p);
  ok(/trình duyệt nhúng/.test(p.d.getElementById('setupPasskeyReadiness').textContent),'embedded browser receives clear warning');
  ok(!!p.d.querySelector('[data-act="copy-site-link"]'),'embedded browser can copy URL for external browser');
  ok(p.count('POST /api/passkeys/register/account')===1,'embedded browser warning does not hard-block registration');
  ok(!!p.d.querySelector('[data-act="do-enroll-passkey"]'),'verified email unlocks Passkey only at wallet activation');
 }finally{p.close();}
 p=await page({platform:false});
 try{
  await register(p);
  ok(/chưa cung cấp Passkey/.test(p.d.getElementById('setupPasskeyReadiness').textContent),'missing platform authenticator gets a soft warning');
  ok(p.count('POST /api/passkeys/register/account')===1,'platform probe does not exclude security key or another phone');
  p.routes['POST /api/passkeys/register/passkey/options']=()=>json(200,{registrationSessionId:'mobile-session',options:{}});
  p.w.SimpleWebAuthnBrowser.startRegistration=async()=>{const e=new Error('authenticator failure');e.name='UnknownError';e.code='ERROR_AUTHENTICATOR_GENERAL_ERROR';throw e;};
  p.click(p.d.querySelector('[data-act="do-enroll-passkey"]'));await sleep(220);
  ok(/Google Password Manager/.test(p.d.getElementById('modalRoot').textContent)&&p.count('POST /api/passkeys/register/passkey/verify')===0,'authenticator error is explained centrally and never activates account');
 }finally{p.close();}
 console.log(checks+' mobile readiness checks passed');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
