'use strict';
// Browser logic only: synthetic fetch, clipboard and authenticator; no real Passkey.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {test}=require('node:test'),{JSDOM}=require('jsdom');
const ROOT=path.join(__dirname,'../../public/experiments');
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const signature={response:{signature:'synthetic-native-response'}};
const token='synthetic-browser-session-token',grant='synthetic-browser-grant';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn){for(let i=0;i<100;i++){if(fn())return;await sleep(5);}throw new Error('UI did not settle');}
function page({origin='https://enclave.id.vn',otherBuyer=false,cancel=false,wrongContext=false,expired=false,sessionFailure=false}={}){
  const dom=new JSDOM(fs.readFileSync(path.join(ROOT,'s2.html'),'utf8'),{url:origin+'/experiments/s2.html',runScripts:'outside-only'}),w=dom.window;
  const calls=[],copies=[];let nativeCalls=0,context=null;
  Object.defineProperty(w,'isSecureContext',{value:true});w.TextEncoder=TextEncoder;w.AbortSignal=AbortSignal;
  Object.defineProperty(w.navigator,'clipboard',{value:{writeText:async text=>{copies.push(text);}}});
  w.SimpleWebAuthnBrowser={startAuthentication:async()=>{nativeCalls++;if(cancel)throw Object.assign(new Error('cancel'),{name:'NotAllowedError'});return signature;},WebAuthnAbortService:{cancelCeremony(){}}};
  w.fetch=async(url,options)=>{
    assert.equal(new URL(url).origin,'https://api.enclave.id.vn');assert.equal(options.credentials,'include');
    const route=new URL(url).pathname;calls.push({route,options});
    const reply=(data,status=200)=>({ok:status<400,status,json:async()=>data});
    if(route.endsWith('/session/refresh'))return sessionFailure?reply({error:'SESSION_EXPIRED'},401):reply({token,user:{id:'buyer'}});
    if(route==='/api/users/me')return reply({user:{id:'buyer',displayName:'Người mua thử'}});
    if(route.endsWith('/reauth/options')){
      context={transactionId:A,action:'RELEASE_ESCROW',buyerId:'buyer',sellerId:'seller',amount:wrongContext?1:50000};
      return reply({reauthSessionId:A,options:{userVerification:'required'},context});
    }
    if(route.endsWith('/reauth/verify'))return reply({reauthGrant:grant,expiresAt:new Date(Date.now()+(expired?-1000:120000)).toISOString(),signedContext:context});
    const id=route.split('/').at(-1);return reply({id,buyerId:otherBuyer?'other':'buyer',sellerId:'seller',sellerName:'Người bán thử',itemName:'Sản phẩm thử',amount:id===A?50000:60000,status:'WAIT_CONFIRM',escrowStatus:'LOCKED',inspectedAt:'fixture-inspected',canBuyerRelease:true});
  };
  w.eval(fs.readFileSync(path.join(ROOT,'s2.js'),'utf8'));
  const $=id=>w.document.getElementById(id);
  return {w,$,calls,copies,nativeCalls:()=>nativeCalls,close:()=>w.close()};
}
async function select(p){p.$('order-a').value='https://enclave.id.vn/#/tx/'+A;p.$('order-b').value='https://enclave.id.vn/#/tx/'+B;p.$('orders').dispatchEvent(new p.w.Event('submit',{cancelable:true}));await until(()=>!p.$('check').disabled);}
async function prepare(p){p.$('consent').checked=true;p.$('consent').dispatchEvent(new p.w.Event('change'));p.$('prepare').click();await until(()=>!p.$('check').disabled);}
test('Web preparation uses the signed-in session and native UV, exports only on explicit copy',async()=>{
  const p=page();try{
    await select(p);assert.equal(p.$('details').hidden,false);assert.equal(p.$('prepare').disabled,true);
    await prepare(p);assert.equal(p.nativeCalls(),1);assert.equal(p.$('ready').hidden,false);assert.equal(p.copies.length,0);
    p.$('copy').click();await until(()=>p.copies.length===1);
    const data=JSON.parse(Buffer.from(p.copies[0].slice(11),'base64').toString('utf8'));
    assert.equal(data.accessToken,token);assert.equal(data.releaseGrant,grant);assert.equal(data.orderA,A);assert.equal(data.orderB,B);
    assert.deepEqual(data.assertionReplay.response,signature);
    assert.equal(p.calls.some(c=>/\/(release|secure|refund)$/.test(c.route)),false,'Preparing never settles money.');
    assert.equal(p.w.document.body.textContent.includes(token),false);assert.equal(p.w.document.body.textContent.includes(grant),false);
    assert.equal(p.w.localStorage.length,0);assert.equal(p.w.sessionStorage.length,0);
    const verify=p.calls.find(c=>c.route.endsWith('/reauth/verify'));assert.equal(verify.options.headers.Authorization,'Bearer '+token);
  }finally{p.close();}
});
test('Other origins cannot prepare or refresh a real session',async()=>{
  const p=page({origin:'https://preview.vercel.app'});try{assert.equal(p.$('check').disabled,true);assert.equal(p.calls.length,0);}finally{p.close();}
});
for(const mode of [{otherBuyer:true},{sessionFailure:true}])test('Invalid user/session prevents requesting a Passkey: '+JSON.stringify(mode),async()=>{
  const p=page(mode);try{await select(p);assert.equal(p.$('details').hidden,true);assert.equal(p.nativeCalls(),0);assert.equal(p.calls.some(c=>c.route.endsWith('/reauth/options')),false);}finally{p.close();}
});
for(const mode of [{cancel:true},{wrongContext:true},{expired:true}])test('No export on cancellation, changed context or expiry: '+JSON.stringify(mode),async()=>{
  const p=page(mode);try{await select(p);await prepare(p);assert.equal(p.$('ready').hidden,true);assert.equal(p.copies.length,0);assert.equal(p.calls.some(c=>/\/(release|secure|refund)$/.test(c.route)),false);}finally{p.close();}
});
test('Editing an order invalidates the prepared package',async()=>{
  const p=page();try{await select(p);await prepare(p);p.$('order-b').dispatchEvent(new p.w.Event('input'));assert.equal(p.$('ready').hidden,true);assert.equal(p.$('copy').disabled,true);}finally{p.close();}
});
