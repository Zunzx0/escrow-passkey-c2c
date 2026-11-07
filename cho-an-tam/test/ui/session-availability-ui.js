'use strict';
// Actual SPA in JSDOM with synthetic HTTP responses. No network, DB, account,
// real cookie, Windows Hello or production acceptance is involved.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const PUBLIC = path.join(__dirname, '../../public');
const USER = {id:'availability-buyer',username:'buyer',displayName:'Người mua mẫu',role:'BUYER',accountStatus:'ACTIVE',authMethod:'passkey',emailVerified:true,recoveryAcknowledged:true};
const WALLET = {availableBalance:1000000,lockedBalance:0,pendingTopupTotal:0};
const REFRESH = '/api/passkeys/session/refresh';
const PROTECTED = '/api/transactions/availability-order/release';
const json = (status, body) => ({status,body});
const HANG = Symbol('hang');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let checks = 0;
function ok(condition, message) {assert.ok(condition, message);checks++;console.log('PASS '+message);}
async function until(fn, message, limit=2000) {
  const end=Date.now()+limit;
  while(!fn()) {assert.ok(Date.now()<end,'Timed out: '+message);await sleep(10);}
}

async function page({startup,repeatStartup=false,timeoutMs=100}={}) {
  const log=[];
  let refreshCount=0,protectedCount=0;
  const routes={
    ['POST '+REFRESH]:()=>{refreshCount++;return startup&&(repeatStartup||refreshCount===1)?startup():json(200,{token:'initial-token',user:USER});},
    ['POST '+PROTECTED]:()=>{protectedCount++;return json(401,{error:'UNAUTHENTICATED'});},
    'GET /api/users/me':()=>json(200,{user:USER,wallet:WALLET}),
    'GET /api/users/me/seller-request':()=>json(200,{request:null}),
    'GET /api/listings/meta':()=>json(200,{categories:[],conditions:[],locations:[]}),
    'GET /api/listings':()=>json(200,{listings:[]}),
    'GET /api/notifications':()=>json(200,{notifications:[],unreadCount:0}),
    'GET /api/notifications/todo':()=>json(200,{items:[]}),
    'GET /api/transactions':()=>json(200,{transactions:[]}),
    'GET /api/wallets/me':()=>json(200,WALLET),
    'GET /api/wallets/me/entries':()=>json(200,{entries:[]}),
    'GET /api/payments/me':()=>json(200,{paymentRequests:[]}),
    'GET /api/payments/paypal/config':()=>json(200,{paypalSandbox:{enabled:false,mode:'sandbox'},mockPayments:{enabled:true}}),
  };
  const html=fs.readFileSync(path.join(PUBLIC,'index.html'),'utf8').replace(/<script\b[^>]*\bsrc=[^>]*><\/script>/g,'');
  const dom=new JSDOM(html,{
    url:'https://enclave.example.test/#/wallet',runScripts:'outside-only',pretendToBeVisual:true,
    beforeParse(w) {
      w.scrollTo=()=>{};
      w.ENCLAVE_API_TIMEOUT_MS=timeoutMs;
      w.fetch=(url,opts={})=>new Promise((resolve,reject)=>{
        const parsed=new URL(url,w.location.href),key=(opts.method||'GET')+' '+parsed.pathname;
        log.push({key,headers:{...opts.headers},body:opts.body,keepalive:opts.keepalive,credentials:opts.credentials});
        const abort=()=>reject(Object.assign(new Error('aborted'),{name:'AbortError'}));
        if(opts.signal?.aborted)return abort();
        opts.signal?.addEventListener('abort',abort,{once:true});
        Promise.resolve().then(()=>routes[key]?routes[key](opts):json(404,{error:'NOT_FOUND'})).then(result=>{
          if(result===HANG)return;
          resolve(new Response(result.text??JSON.stringify(result.body),{status:result.status,headers:{'Content-Type':result.text?'text/html':'application/json'}}));
        },reject);
      });
      const scripts=['config.js','icons.js','simplewebauthn-browser.js','shipping-motion.js','app.js'];
      w.eval(scripts.map(file=>fs.readFileSync(path.join(PUBLIC,'js',file),'utf8').replace('return { init };',
        'window.__availability={snapshot:()=>({token:state.token,user:state.user,epoch:state.sessionEpoch,pending:state.sessionRestorePending}),api,refreshSession,setSession}; return { init };')).join('\n;\n'));
    },
  });
  const w=dom.window;
  try {
    await until(()=>w.document.querySelector('#topupAmount')||w.document.querySelector('[data-act="session-restore-retry"]')||/Kích hoạt ví|Đăng nhập/.test(w.document.querySelector('#view')?.textContent||''),'startup settles');
  } catch(error) {w.close();throw error;}
  await sleep(30);
  return {w,d:w.document,routes,log,auth:()=>w.__availability.snapshot(),api:(...args)=>w.__availability.api(...args),setSession:(...args)=>w.__availability.setSession(...args),close:()=>w.close(),refreshCount:()=>refreshCount,protectedCount:()=>protectedCount};
}

async function main() {
  const failures=[
    ['503 JSON',()=>json(503,{error:'SERVICE_UNAVAILABLE'})],
    ['502 proxy HTML',()=>({status:502,text:'<h1>Starting</h1>'})],
    ['429 rate limit',()=>json(429,{error:'RATE_LIMITED'})],
    ['network rejection',()=>Promise.reject(new TypeError('Failed to fetch'))],
    ['timeout',()=>HANG],
    ['malformed success',()=>({status:200,text:'<h1>Loading</h1>'})],
    ['untrusted 401 HTML',()=>({status:401,text:'<h1>Proxy unavailable</h1>'})],
    ['different account',()=>json(200,{token:'wrong-owner',user:{...USER,id:'other'}})],
  ];
  for(const [label,failure] of failures) {
    const p=await page();
    try {
      const before=p.auth();p.routes['POST '+REFRESH]=failure;
      await assert.rejects(p.api('/transactions/availability-order/release',{method:'POST',body:{requestId:'synthetic-request',reauthGrant:'synthetic-grant'}}),e=>e.code==='SESSION_REFRESH_UNAVAILABLE',label+' is temporary unavailability, not confirmed expiry');checks++;
      ok(p.auth().token===before.token&&p.auth().user.id===before.user.id&&p.auth().epoch===before.epoch,label+' preserves the existing account and session epoch');
      ok(p.protectedCount()===1,label+' never resubmits a financial request automatically');
      ok(p.w.localStorage.getItem('cat_token')===null&&p.w.localStorage.getItem('cat_user')===null,label+' does not persist access tokens or user identity');
      p.routes['POST '+REFRESH]=()=>json(200,{token:'renewed-token',user:USER});
      p.routes['POST '+PROTECTED]=opts=>{p.log.push({key:'protected-after-recovery',authorization:opts.headers.Authorization});return opts.headers.Authorization==='Bearer renewed-token'?json(200,{ok:true}):json(401,{error:'UNAUTHENTICATED'});};
      const result=await p.api('/transactions/availability-order/release',{method:'POST',body:{requestId:'synthetic-request',reauthGrant:'synthetic-grant'}});
      ok(result.ok&&p.auth().token==='renewed-token',label+' can recover on a later explicit attempt');
    } finally {p.close();}
  }

  let p=await page();
  try {
    p.routes['POST '+REFRESH]=()=>json(401,{error:'SESSION_EXPIRED'});
    await assert.rejects(p.api('/transactions/availability-order/release',{method:'POST',body:{}}),e=>e.code==='UNAUTHENTICATED');checks++;
    ok(p.auth().token===null&&p.auth().user===null,'confirmed server expiry still removes the local session');
    ok(p.protectedCount()===1,'confirmed expiry does not submit the operation twice');
  } finally {p.close();}

  p=await page();
  try {
    const before=p.auth(),refreshes=p.refreshCount();
    p.routes['POST '+PROTECTED]=()=>json(401,{error:'REAUTH_REQUIRED'});
    await assert.rejects(p.api('/transactions/availability-order/release',{method:'POST',body:{}}),e=>e.code==='REAUTH_REQUIRED');checks++;
    ok(p.auth().token===before.token&&p.refreshCount()===refreshes,'a missing financial Passkey grant stays rejected and is not treated as session renewal');
  } finally {p.close();}

  for(const [label,startup] of [['503',()=>json(503,{error:'SERVICE_UNAVAILABLE'})],['timeout',()=>HANG]]) {
    p=await page({startup});
    try {
      ok(p.auth().pending===true&&p.auth().token===null,label+' at startup shows an unresolved session, not a fabricated identity');
      ok(!/Phiên đăng nhập đã hết hạn/.test(p.d.querySelector('#view').textContent),'startup unavailability does not claim the session expired');
      ok(!p.log.some(x=>x.key==='GET /api/wallets/me'),'startup with unknown identity sends no protected wallet request');
      let finish;
      p.routes['POST '+REFRESH]=()=>new Promise(resolve=>{finish=resolve;});
      const button=p.d.querySelector('[data-act="session-restore-retry"]');
      button.click();button.click();await sleep(20);
      ok(p.d.querySelector('[data-act="session-restore-retry"]').disabled&&p.refreshCount()===1,'one manual restore attempt disables duplicate retry buttons');
      // A replaced handler does not use the default counter, so verify the actual requests.
      ok(p.log.filter(x=>x.key==='POST '+REFRESH).length===2,'double click issues one refresh request after startup');
      finish(json(200,{token:'after-startup',user:USER}));
      await until(()=>p.auth().token==='after-startup'&&!p.auth().pending,'manual restore succeeds');
      await until(()=>p.d.querySelector('#topupAmount'),'wallet route resumes');
      ok(p.auth().user.id===USER.id,'manual restore uses only the server-confirmed account');
      ok(!p.d.querySelector('[data-act="session-restore-retry"]'),'successful restore removes the connection gate');
      ok(!p.log.some(x=>/\/(secure|release|refund)$/.test(x.key)),'startup retry never performs a financial action');
    } finally {p.close();}
  }

  p=await page({startup:()=>json(401,{error:'SESSION_EXPIRED'})});
  try {ok(!p.auth().pending&&!p.auth().token&&!p.d.querySelector('[data-act="session-restore-retry"]'),'confirmed missing or expired startup cookie does not trap guests behind a retry gate');} finally {p.close();}

  p=await page({startup:()=>json(409,{error:'SESSION_REFRESH_ROTATED'}),repeatStartup:true});
  try {
    ok(p.auth().pending&&!p.auth().token,'unresolved rotation conflict at reload does not fabricate a user or claim expiry');
    ok(p.refreshCount()===3,'rotation conflict uses a bounded three attempts');
    ok(!!p.d.querySelector('[data-act="session-restore-retry"]'),'reload conflict offers an explicit connection retry');
    ok(!p.log.some(x=>/\/(secure|release|refund)$/.test(x.key)),'reload conflict never initiates a money action');
    ok(p.log.filter(x=>x.key==='POST '+REFRESH).every(x=>x.keepalive===true&&x.credentials==='include'),'refresh requests opt into unload keepalive and retain HttpOnly-cookie credentials');
    p.routes['POST '+REFRESH]=()=>json(200,{token:'after-conflict',user:USER});
    p.d.querySelector('[data-act="session-restore-retry"]').click();
    await until(()=>p.auth().token==='after-conflict'&&!p.auth().pending,'restore after rotation conflict');
    ok(p.auth().user.id===USER.id,'explicit retry restores only the API-confirmed identity');
    ok(p.log.filter(x=>x.key!=='POST '+REFRESH).every(x=>x.keepalive!==true),'keepalive is not added to financial or unrelated API requests');
  } finally {p.close();}

  p=await page();
  try {
    let release;
    p.routes['POST '+REFRESH]=()=>new Promise(resolve=>{release=resolve;});
    const old=p.api('/transactions/availability-order/release',{method:'POST',body:{}});
    await until(()=>release,'old refresh is in flight');
    const newer={...USER,id:'new-account'};p.setSession('new-account-token',newer);
    release(json(503,{error:'SERVICE_UNAVAILABLE'}));
    await assert.rejects(old,e=>e.stale===true);checks++;
    ok(p.auth().user.id===newer.id&&p.auth().token==='new-account-token','late unavailable refresh cannot erase a newer account');
  } finally {p.close();}
  console.log('SESSION AVAILABILITY UI: '+checks+' checks passed');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
