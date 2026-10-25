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
