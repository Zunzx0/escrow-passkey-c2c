'use strict';
const assert=require('node:assert/strict');
const {wallet,fakeServer,json,ppRow,intentJson,BUYER,KEY,AMOUNT,INTENT_PREFIX,sleep}=require('./paypal-wallet-ui');
const id='5b1f0c52-7a3e-4c1d-9a55-0f1e2d3c4b5a';
const marker=JSON.stringify({userId:BUYER.id,id,requestId:KEY,amount:AMOUNT});
const storage={ [INTENT_PREFIX+BUYER.id]:intentJson() };
let n=0;function ok(v,m){assert.ok(v,m);n++;console.log('✅ '+m);}
(async()=>{
 for(const mode of ['reload','bfcache']){
 const srv=fakeServer();const p=await wallet({storage,extra:srv.routes(),sessionStorage:mode==='reload'?{cat_paypal_departure:marker}:{}});
 try{
 if(mode==='bfcache'){p.w.sessionStorage.setItem('cat_paypal_departure',marker);p.w.dispatchEvent(new p.w.PageTransitionEvent('pageshow',{persisted:true}));await sleep(100);}
 ok(/chưa hoàn tất phê duyệt/.test(p.notice()),mode+': show unpaid pending request after Back');
 ok(!!p.noticeBtn('paypal-approve')&&!!p.noticeBtn('paypal-abandon'),mode+': continue and cancel buttons available');
 ok(/Huỷ yêu cầu nạp/.test(p.notice()),mode+': cancellation label clear');
 ok(srv.captures===0&&p.count('POST /api/payments/paypal/topup')===0,mode+': Back never captures or creates new request');
 ok(p.intent().requestId===KEY,mode+': preserve original intent');
 }finally{p.close();}}
 for(const stage of ['CAPTURING','RECONCILING','SUCCEEDED','RECOVERY_REQUIRED']){
 const srv=fakeServer({stage,status:stage==='SUCCEEDED'?'SUCCEEDED':stage==='RECOVERY_REQUIRED'?'FAILED':'PENDING'});
 const p=await wallet({storage,extra:srv.routes(),sessionStorage:{cat_paypal_departure:marker}});
 try{ok(srv.captures===0&&!p.noticeBtn('paypal-abandon'),'No cancel or capture when server reports '+stage);}finally{p.close();}}
 const srv=fakeServer();const p=await wallet({storage,extra:srv.routes(),sessionStorage:{cat_paypal_departure:JSON.stringify({userId:'other',id,requestId:KEY,amount:AMOUNT})}});
 try{ok(srv.captures===0&&p.count('GET /api/payments/'+id)===0,'Other user departure marker ignored');}finally{p.close();}
 console.log(n+' checks, ALL PASS');
})().catch(e=>{console.error(e);process.exitCode=1;});
