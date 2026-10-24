// Mobile regression for auth v3: readiness warns but must not exclude hybrid/security keys.
const assert=require('node:assert/strict');
const {wallet,json,sleep,logoutUi}=require('./paypal-wallet-ui');
let checks=0;
const ok=(value,message)=>{assert.ok(value,message);checks++;console.log('PASS '+message);};
const chrome='Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/124.0.0.0 Mobile Safari/537.36';
const webview='Mozilla/5.0 (Linux; Android 14; wv) AppleWebKit/537.36 Version/4.0 Chrome/124.0.0.0 Mobile Safari/537.36';
async function page({ua=chrome,platform=true}={}){
 const p=await wallet({hash:'#/wallet'});await logoutUi(p);
 Object.defineProperty(p.w.navigator,'userAgent',{value:ua,configurable:true});
 Object.defineProperty(p.w.navigator,'credentials',{value:{create:async()=>({})},configurable:true});
 p.w.PublicKeyCredential=class {};
 p.w.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable=async()=>platform;
 p.routes['POST /api/passkeys/register/account']=()=>json(201,{token:'mobile-basic',scope:'full',user:{id:'flow',displayName:'Mobile Test',role:'BUYER',accountStatus:'BASIC',emailVerified:false,email:'mobile@example.test',emailMask:'mo***@example.test'}});
 p.click(p.d.querySelector('[data-act="open-auth-register"]'));await sleep(220);return p;
}
async function register(p){
 for(const [id,value] of Object.entries({regEmail:'mobile@example.test',regUsername:'mobile_test',regDisplayName:'Mobile Test',regPassword:'MatKhau-Test-2026!'}))p.d.getElementById(id).value=value;
 p.click(p.d.querySelector('[data-act="do-register"]'));await sleep(180);
 p.w.location.hash='#/wallet';await sleep(200);p.click(p.d.querySelector('[data-act="activate-wallet"]'));await sleep(120);
 p.routes['POST /api/passkeys/email/verify']=()=>json(200,{token:'verified-mobile',scope:'full',user:{id:'flow',displayName:'Mobile Test',role:'BUYER',accountStatus:'VERIFIED',emailVerified:true}});
 p.d.getElementById('emailVerificationCode').value='123456';p.click(p.d.querySelector('[data-act="email-verify"]'));await sleep(200);
}
async function main(){
 let p=await page();
 try{await register(p);ok(/Thiết bị sẵn sàng/.test(p.d.getElementById('setupPasskeyReadiness').textContent),'supported Android reports readiness');}finally{p.close();}
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
