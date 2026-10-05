'use strict';
// Reuse P1 jsdom harness; no server, credentials, DB or network.
const {wallet,delay,json,row,BUYER,OTHER,loginUi,logoutUi,sleep,press}=require('./topup-request-id-ui');
const assert=require('assert/strict');let n=0;
const ok=(v,m)=>{assert.ok(v,m);console.log('  ✅ '+m);n++;};
(async()=>{
 let p=await wallet({timeoutMs:5000,topup:()=>json(401,{error:'UNAUTHENTICATED'}),extra:{'POST /api/passkeys/session/refresh':()=>delay(1800,json(200,{token:'tok-old-refresh',user:BUYER}))}});
 p.click(p.btn());await sleep(40);await logoutUi(p);await loginUi(p,OTHER);await sleep(1600);
 ok(p.w.localStorage.getItem('cat_token')==='tok-'+OTHER.id,'Pending refresh cannot replace or clear new token');
 ok((JSON.parse(p.w.localStorage.getItem('cat_user')||'null')||{}).id===OTHER.id,'Pending refresh cannot restore previous account');
 ok(p.bodies.length===1,'Old operation never retries after refresh');p.close();
 p=await wallet({topup:()=>json(401,{error:'UNAUTHENTICATED'}),extra:{'POST /api/passkeys/session/refresh':()=>json(200,{token:'tok-wrong-owner',user:OTHER})}});
 p.w.document.dispatchEvent(new p.w.Event('visibilitychange'));await sleep(100);
 ok(p.w.localStorage.getItem('cat_token')==='tok-test','Refresh for another user never installs its token');
 ok(JSON.parse(p.w.localStorage.getItem('cat_user')).id===BUYER.id,'Refresh for another user never switches accounts');
 ok(p.count('POST /api/passkeys/session/refresh')===1,'Mismatching owner response exercised');p.close();
 p=await wallet({timeoutMs:5000,topup:b=>delay(250,json(201,row({requestId:b.requestId}))),extra:{'POST /api/passkeys/session/refresh':()=>json(200,{token:'tok-same-user-refresh',user:BUYER})}});
 p.click(p.btn());await sleep(20);p.w.document.dispatchEvent(new p.w.Event('visibilitychange'));await sleep(600);
 ok(p.w.localStorage.getItem('cat_token')==='tok-same-user-refresh','Same-user refresh still renews token');
 ok(!!p.d.querySelector('.modal [data-act="checkout-pay"]'),'Same-session refresh does not discard a valid pending topup');
 ok(p.bodies.length===1,'Same-user refresh does not duplicate topup');p.close();
 p=await wallet({timeoutMs:5000,topup:b=>json(201,row({requestId:b.requestId})),extra:{'GET /mock-provider/checkout/ref1':()=>delay(1800,json(401,{error:'UNAUTHENTICATED'})),'POST /api/passkeys/session/refresh':()=>json(200,{token:'tok-unwanted-refresh',user:BUYER})}});
 p.click(p.btn());await sleep(40);await logoutUi(p);await loginUi(p,OTHER);await sleep(1600);
 ok(p.count('POST /api/passkeys/session/refresh')===0,'Old provider 401 never refreshes new session');
 ok(p.w.localStorage.getItem('cat_token')==='tok-'+OTHER.id,'Old provider 401 preserves new token');
 ok(!p.d.querySelector('.modal [data-act="checkout-pay"]'),'Old provider response never opens checkout');p.close();
 // Exercise actual helper bodies with a controlled stale rejection.
 const source = require('fs').readFileSync(require('path').join(__dirname, '../../public/js/app.js'), 'utf8');
 for (const [fn, field] of [['refreshWallet', 'wallet'], ['refreshSellerRequest', 'sellerRequest']]) {
   const body = source.match(new RegExp('async function ' + fn + '\\(\\) \\{[\\s\\S]*?\\n  \\}'));
   assert.ok(body, 'Actual helper function found');
   let reject; const promise = new Promise((_, r) => { reject = r; });
   const state = { sessionEpoch: 1, token: 'A', user: {id:'A',role:'BUYER'}, [field]: {owner:'A'} };
   const context = require('vm').createContext({state, api: () => promise});
   require('vm').runInContext(body[0], context);
   const pending = require('vm').runInContext(fn + '()', context);
   state.sessionEpoch = 2; state.user = {id:'B',role:'BUYER'}; state.token = 'B'; state[field] = {owner:'B'};
   reject(Object.assign(new Error('stale'), {stale:true})); await pending;
   ok(state[field] && state[field].owner === 'B', fn + ' stale error does not clear newer account state');
 }
 console.log(n+' checks, ALL PASS');
})().catch(e=>{console.error(e);process.exitCode=1});
