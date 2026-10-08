'use strict';
// UI fixtures only: no external PayPal calls, credentials or money.
const assert=require('node:assert/strict');
const {wallet,fakeServer,json,ppRow,intentJson,BUYER,INTENT_PREFIX,sleep,HANG,logoutUi,loginUi}=require('./paypal-wallet-ui');
const id='5b1f0c52-7a3e-4c1d-9a55-0f1e2d3c4b5a';
const cap='POST /api/payments/paypal/'+id+'/capture';
const get='GET /api/payments/'+id;
const search='?paypal=return&paymentRequestId='+id;
const storage={ [INTENT_PREFIX+BUYER.id]:intentJson() };
let checks=0;
function ok(value,label){assert.ok(value,label); checks++; console.log('✅ '+label);}
(async()=>{
 let srv=fakeServer();
 srv.captureResult=()=>{srv.row=ppRow({status:'SUCCEEDED',stage:'SUCCEEDED',resolvedAt:new Date().toISOString()});return json(200,{outcome:'APPLIED'});};
 let p=await wallet({storage,extra:srv.routes(),search});
 try{
 ok(srv.captures===1,'Return matching intent automatically captures exactly once');
 ok(p.log.indexOf(get)<p.log.indexOf(cap),'GET verifies request before capture');
 ok(p.log.slice(p.log.indexOf(cap)+1).includes(get),'GET verifies result after capture');
 ok(p.toasts().filter(t=>/Nạp tiền thành công/.test(t.text)).length===1,'Exactly one success notification after verified success');
 ok(p.intent()===null && p.count('GET /api/wallets/me')>=2,'Clear intent and refresh server wallet');
 ok(!p.noticeBtn('paypal-capture'),'No second confirmation button');
 }finally{p.close();}
 for(const kind of ['cancel','return']){
 srv=fakeServer(); p=await wallet({storage:kind==='cancel'?storage:{},extra:srv.routes(),search:'?paypal='+kind+'&paymentRequestId='+id});
 try{ok(srv.captures===0,kind==='cancel'?'Cancel does not capture':'Missing intent does not capture');}finally{p.close();}
 }
 for(const change of [{paymentId:'other-id'},{amount:200000},{requestId:'topup-other-request-0001'}]){
 srv=fakeServer();p=await wallet({storage:{[INTENT_PREFIX+BUYER.id]:intentJson(change)},extra:srv.routes(),search});
 try{ok(srv.captures===0,'Mismatched intent never captures: '+Object.keys(change)[0]);}finally{p.close();}
 }
 for(const stage of ['SUCCEEDED','FAILED','RECOVERY_REQUIRED','RECONCILING','CAPTURING']){
 srv=fakeServer({stage,status:stage==='SUCCEEDED'?'SUCCEEDED':['FAILED','RECOVERY_REQUIRED'].includes(stage)?'FAILED':'PENDING'});
 p=await wallet({storage,extra:srv.routes(),search});
 try{ok(srv.captures===0,'No automatic capture in '+stage);}finally{p.close();}
 }
 for(const result of [()=>json(200,{outcome:'APPLIED'}),()=>json(500,{error:'INTERNAL_ERROR',message:'x'}),()=>HANG]){
 srv=fakeServer();srv.captureResult=result;p=await wallet({storage,extra:srv.routes(),search,timeoutMs:200});
 try{await sleep(400);ok(srv.captures===1,'Uncertain result does not retry capture');ok(!p.toasts().some(t=>/Nạp tiền thành công/.test(t.text))&&!!p.intent(),'POST result alone never declares success or clears intent');}finally{p.close();}
 }
 // Freeze capture across logout + login to the same user: prove the request is in flight.
 srv=fakeServer();let release;const gate=new Promise(r=>release=r);srv.captureResult=()=>gate;
 p=await wallet({storage,extra:srv.routes(),search,timeoutMs:5000});
 try{ok(srv.captures===1,'Capture in flight before session change');await logoutUi(p);await loginUi(p,BUYER);const before=p.count(get);
 release(json(200,{outcome:'APPLIED'}));await sleep(150);
 ok(p.count(get)===before&&!p.toasts().some(t=>/Nạp tiền thành công/.test(t.text)),'Old capture response cannot affect new session');
 }finally{release(json(200,{}));p.close();}
 let created; p=await wallet({create:b=>{created=ppRow({requestId:b.requestId});return json(200,created);},extra:{['GET /api/payments/paypal/'+id+'/checkout']:()=>json(200,{...created,approvalUrl:'https://www.sandbox.paypal.com/checkoutnow?token=TEST'})}});
 try{p.click(p.btn());await sleep(300);ok(p.navs.length===1 && p.navs[0].startsWith('https://www.sandbox.paypal.com/'),'Top-up click automatically opens validated Sandbox checkout');}finally{p.close();}
 console.log(checks+' assertions passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
