'use strict';
// Real application SQL/store/ledger and authenticated HTTP routes; PayPal HTTP is simulated.
const assert=require('node:assert/strict'),path=require('node:path');
if(process.env.APP_ENV!=='test')throw Error('APP_ENV=test required');
if(process.env.DATABASE_URL){const u=new URL(process.env.DATABASE_URL);if(!['localhost','127.0.0.1'].includes(u.hostname)||!/_test$/.test(u.pathname))throw Error('Local *_test only');}
else if(!path.resolve(__dirname,'..',process.env.DB_PATH||'').startsWith(path.resolve(__dirname,'../data/test')+path.sep))throw Error('data/test only');
const {db,uuid,nowIso}=require('../src/db');
const {flows}=require('./helpers/accounts');
const {createSandboxProvider,SANDBOX_BASE}=require('../src/lib/paypalSandboxProvider');
const {createPayPalRuntime}=require('../src/lib/paypalRuntime');
const {createPayPalRouter}=require('../src/routes/paypal');
const {applyProviderResult}=require('../src/lib/paymentService');
const express=require('express');
let n=0,server;
const ok=(v,label)=>{assert.ok(v,label);n++;console.log('  ✅ '+label);};
const config={enabled:true,mode:'sandbox',clientId:'fixture-client',clientSecret:'fixture-secret',merchantId:'fixture-merchant',webhookId:'fixture-webhook',frontendOrigin:'https://enclave.id.vn',rateVndPerUsd:25000,timeoutMs:1000,leaseMs:120000};
const orders=new Map(),keys=new Map();let sequence=0,creates=0,posts=0,signatureCalls=0,failCapture=false,signature=true;
function response(body,status=200){return {ok:status<400,status,text:async()=>JSON.stringify(body)};}
async function transport(url,options={}) {
  assert.equal(new URL(url).origin,SANDBOX_BASE);
  const pathname=new URL(url).pathname,body=options.body?JSON.parse(options.body.startsWith('{')?options.body:'{}'):{};
  if(pathname==='/v1/oauth2/token')return response({access_token:'fixture-token',token_type:'Bearer',expires_in:300});
  if(pathname==='/v1/notifications/verify-webhook-signature'){signatureCalls++;return response({verification_status:signature?'SUCCESS':'FAILURE'});}
  if(pathname==='/v2/checkout/orders'&&options.method==='POST') {
    creates++;const key=options.headers['PayPal-Request-Id'];if(keys.has(key))return response({id:keys.get(key)});
    const id='ORDER-'+(++sequence),order={id,intent:'CAPTURE',status:'APPROVED',purchase_units:body.purchase_units,links:[{rel:'approve',href:'https://www.sandbox.paypal.com/checkoutnow?token='+id}]};
    orders.set(id,order);keys.set(key,id);return response({id});
  }
  const match=pathname.match(/^\/v2\/checkout\/orders\/([^/]+)(\/capture)?$/);
  if(!match||!orders.has(match[1]))return response({name:'RESOURCE_NOT_FOUND'},404);
  const order=orders.get(match[1]);
  if(match[2]) {
    posts++; if(failCapture)throw Error('simulated transport loss');
    order.status='COMPLETED';order.purchase_units[0].payments={captures:[{id:'CAPTURE-'+order.id,status:'COMPLETED',final_capture:true,amount:order.purchase_units[0].amount}]};
  }
  return response(order);
}
const runtime=createPayPalRuntime({config,provider:createSandboxProvider(config,{fetchImpl:transport})});
const wallet=id=>db.prepare('SELECT * FROM wallets WHERE user_id=?').get(id);
const entries=id=>db.prepare("SELECT * FROM wallet_entries WHERE request_id=? AND entry_type='TOPUP_CREDIT'").all(id);
async function account(){return flows.registerUser({username:'ppi'+uuid().replace(/-/g,'').slice(0,20),displayName:'PayPal integration'});}
const make=async user=>runtime.create({userId:user.user.id,amount:10000,requestId:'paypal-'+uuid()});
function event(row){return {id:'event-'+uuid(),event_type:'PAYMENT.CAPTURE.COMPLETED',resource:{id:'CAPTURE-'+row.orderId,supplementary_data:{related_ids:{order_id:row.orderId}}}};}
const headers={'paypal-auth-algo':'SHA256withRSA','paypal-cert-url':SANDBOX_BASE+'/v1/notifications/certs/test','paypal-transmission-id':'fixture-transmission','paypal-transmission-sig':'fixture-signature','paypal-transmission-time':nowIso()};
async function main(){
  const a=await account(),b=await account();const before=(await wallet(a.user.id)).available_balance;
  const row=await make(a);
  ok(row.provider==='PAYPAL_SANDBOX'&&row.stage==='AWAITING_APPROVAL','created request has persistent PayPal quote, stage and provider');
  ok(row.quote.usdValue==='0.40'&&row.quote.amountVnd===10000&&row.quote.rateKind==='DEMO_FIXED','server quote uses exact stored VND/USD and demo label');
  ok(row.approvalUrl.startsWith('https://www.sandbox.paypal.com/'),'approval URL comes from canonical Sandbox order');
  ok((await wallet(a.user.id)).available_balance===before&&(await entries(row.id)).length===0,'order creation never credits SQL wallet/ledger');
  const count=creates;const replay=await runtime.create({userId:a.user.id,amount:10000,requestId:row.requestId});
  ok(replay.id===row.id&&replay.orderId===row.orderId&&creates===count,'create replay keeps request/order/quote without another create POST');
  await assert.rejects(()=>runtime.create({userId:a.user.id,amount:11000,requestId:row.requestId}),e=>e.code==='IDEMPOTENCY_KEY_REUSED');ok(true,'same key different amount is rejected');
  const paid=await runtime.capture(row.id,a.user.id);
  ok(paid.status==='SUCCEEDED'&&paid.outcome==='APPLIED','authenticated capture settles actual request');
  ok((await wallet(a.user.id)).available_balance===before+10000,'wallet credited exactly VND quote');
  const ledger=await entries(row.id);ok(ledger.length===1&&ledger[0].available_delta===10000&&ledger[0].idempotency_key==='topup:'+row.id,'exactly one stable SQL TOPUP_CREDIT');
  const binding=await runtime.store.loadByRequestId(row.id);ok(binding.capture.state==='VERIFIED'&&binding.capture.captureId==='CAPTURE-'+row.orderId,'capture evidence committed with wallet');
  const beforePosts=posts;const duplicates=await Promise.all([runtime.capture(row.id,a.user.id),runtime.reconcileOne(row.id),runtime.webhook(headers,event(row))]);
  ok(duplicates.every(r=>r.outcome==='DUPLICATE')&&posts===beforePosts,'capture/webhook/reconciler replay never recharges');
  ok((await entries(row.id)).length===1&&(await wallet(a.user.id)).available_balance===before+10000,'three channels keep one real credit');
  await assert.rejects(()=>runtime.capture(row.id,b.user.id),e=>e.code==='FORBIDDEN');ok(true,'other user cannot capture request');
  signature=false;await assert.rejects(()=>runtime.webhook(headers,event(row)),e=>e.code==='INVALID_SIGNATURE');signature=true;ok(true,'unverified webhook cannot settle');
  const mock=await applyProviderResult({paymentRequestId:row.id,providerRef:row.providerRef,status:'SUCCEEDED',amount:10000,source:'WEBHOOK'});
  ok(mock.outcome==='CONFLICT','signed mock result cannot touch PayPal request');
  const r2=await make(b);const b0=(await wallet(b.user.id)).available_balance;
  process.env.FAULT_INJECT='paypal-topup:after-wallet-update';
  await assert.rejects(()=>runtime.capture(r2.id,b.user.id),e=>e.code==='INJECTED_FAULT');delete process.env.FAULT_INJECT;
  const failed=await runtime.store.loadByRequestId(r2.id);
  ok(failed.status==='PENDING'&&failed.capture.state==='UNKNOWN'&&!failed.capture.captureId,'fault rolls back request/evidence and leaves capture unresolved');
  ok((await wallet(b.user.id)).available_balance===b0&&(await entries(r2.id)).length===0,'fault rolls back SQL balance and ledger');
  const retried=await runtime.reconcileOne(r2.id);ok(retried.outcome==='APPLIED','GET reconciler recovers captured money after SQL rollback');
  ok((await wallet(b.user.id)).available_balance===b0+10000&&(await entries(r2.id)).length===1,'recovery writes evidence/credit exactly once');
  const c=await account(),r3=await make(c);failCapture=true;
  await assert.rejects(()=>runtime.capture(r3.id,c.user.id));failCapture=false;
  ok((await runtime.serializePayPal(r3.id)).stage==='RECONCILING'&&(await entries(r3.id)).length===0,'network uncertainty never produces fake success or FAILED');
  await runtime.capture(r3.id,c.user.id);ok((await entries(r3.id)).length===1,'same bound order can recover after ambiguous POST');
  const d=await account(),r4=await make(d),claim=uuid();
  await runtime.store.claimCapture(r4.id,d.user.id,claim,'2000-01-01T00:00:00.000Z','1999-01-01T00:00:00.000Z');
  await runtime.store.markCapturePostSent(r4.id,claim);
  await runtime.store.claimCapture(r4.id,d.user.id,uuid(),nowIso(),'2001-01-01T00:00:00.000Z');
  const stale=await runtime.settle({paymentRequestId:r4.id,providerRef:r4.providerRef,orderId:r4.orderId,captureId:'CAPTURE-'+r4.orderId,amount:10000,status:'SUCCEEDED',source:'RECONCILER',claimId:claim});
  ok(stale.outcome==='APPLIED'&&(await entries(r4.id)).length===1,'stale-holder rollback then evidence transaction recovers exactly one credit');
  const e=await account(),r5=await make(e),e0=(await wallet(e.user.id)).available_balance;await db.prepare("UPDATE payment_requests SET status='FAILED' WHERE id=?").run(r5.id);
  const recovery=await runtime.settle({paymentRequestId:r5.id,providerRef:r5.providerRef,orderId:r5.orderId,captureId:'CAPTURE-'+r5.orderId,amount:10000,status:'SUCCEEDED',source:'WEBHOOK'});
  ok(recovery.outcome==='RECOVERY_REQUIRED'&&(await runtime.store.loadByRequestId(r5.id)).capture.captureId==='CAPTURE-'+r5.orderId,'late capture on closed request preserves recovery evidence');
  ok((await entries(r5.id)).length===0&&(await wallet(e.user.id)).available_balance===e0,'manual recovery never auto-credits or reopens failed request');
  const f=await account(),r6=await make(f);await runtime.store.markCaptureVerified(r6.id,'CAPTURE-'+r6.orderId);
  ok((await runtime.capture(r6.id,f.user.id)).outcome==='APPLIED'&&(await entries(r6.id)).length===1,'VERIFIED/PENDING legacy state requires real settlement instead of false replay');
  const g=await account(),r7=await make(g),g0=(await wallet(g.user.id)).available_balance;
  await transport(SANDBOX_BASE+'/v2/checkout/orders/'+r7.orderId+'/capture',{method:'POST'});
  const concurrent=await Promise.all([runtime.capture(r7.id,g.user.id),runtime.reconcileOne(r7.id),runtime.webhook(headers,event(r7))]);
  ok(concurrent.filter(r=>r.outcome==='APPLIED').length===1,'three channels race on genuinely pending captured request: exactly one winner');
  ok((await entries(r7.id)).length===1&&(await wallet(g.user.id)).available_balance===g0+10000,'concurrent first settlement keeps exactly one real wallet/ledger credit');
  const h=await account(),r8=await make(h);
  const altered=createPayPalRuntime({config:{...config,merchantId:'other-merchant'},provider:createSandboxProvider({...config,merchantId:'other-merchant'},{fetchImpl:transport})});
  const postsBeforeMerchant=posts;await assert.rejects(()=>altered.capture(r8.id,h.user.id),e=>e.code==='PAYPAL_ORDER_MISMATCH');
  ok(posts===postsBeforeMerchant&&(await entries(r8.id)).length===0,'changed merchant blocks before capture or credit');
  const expId=uuid(),expKey=uuid(),time='2000-01-01T00:00:00.000Z';
  await db.transaction(async()=>{
    await db.prepare("INSERT INTO payment_requests (id,user_id,amount,status,provider_ref,provider,client_request_id,submission_status,created_at,updated_at) VALUES (?,?,10000,'PENDING',?,'PAYPAL_SANDBOX',?,'SUBMITTING',?,?)").run(expId,h.user.id,uuid(),expKey,time,time);
    await runtime.store.createBinding({paymentRequestId:expId,quote:require('../src/lib/paypalSandboxProvider').createQuote(10000,25000),merchantId:config.merchantId,nowIso:time});
    await runtime.store.claimCreateAttempt(expId,time);
  })();
  const createsBeforeExpiry=creates;await assert.rejects(()=>runtime.create({userId:h.user.id,amount:10000,requestId:expKey}),e=>e.code==='PAYPAL_CREATE_RECOVERY_REQUIRED');
  ok(creates===createsBeforeExpiry&&(await runtime.serializePayPal(expId)).stage==='CREATE_RECOVERY_REQUIRED','expired ambiguous create cannot mint a fresh order');
  // An old unbound row must not consume the worker limit ahead of a captured bound request.
  await transport(SANDBOX_BASE+'/v2/checkout/orders/'+r8.orderId+'/capture',{method:'POST'});
  await db.prepare("UPDATE payment_requests SET created_at='2000-01-02T00:00:00.000Z' WHERE id=?").run(r8.id);
  const worker=await require('../src/lib/reconciler').reconcileOnce({minAgeSeconds:0,limit:1,paypalRuntime:runtime});
  ok(worker.paypal.applied===1&&(await entries(r8.id)).length===1,'worker skips stale unbound head and recovers later captured payment under limit');
  const i=await account(),r9=await make(i);failCapture=true;
  await assert.rejects(()=>runtime.capture(r9.id,i.user.id));failCapture=false;
  await db.prepare("UPDATE payment_requests SET status='FAILED',created_at='2001-01-01T00:00:00.000Z' WHERE id=?").run(r9.id);
  const j=await account(),r10=await make(j);
  await transport(SANDBOX_BASE+'/v2/checkout/orders/'+r10.orderId+'/capture',{method:'POST'});
  await db.prepare("UPDATE payment_requests SET created_at='2010-01-01T00:00:00.000Z' WHERE id=?").run(r10.id);
  const firstPass=await require('../src/lib/reconciler').reconcileOnce({minAgeSeconds:0,limit:1,paypalRuntime:runtime});
  const failedHead=await db.prepare('SELECT last_reconciled_at FROM payment_requests WHERE id=?').get(r9.id);
  ok(firstPass.paypal.applied===0&&Boolean(failedHead.last_reconciled_at),'FAILED posted head records reconciliation time even when PayPal remains pending');
  const secondPass=await require('../src/lib/reconciler').reconcileOnce({minAgeSeconds:0,limit:1,paypalRuntime:runtime});
  ok(secondPass.paypal.applied===1&&(await entries(r10.id)).length===1,'FAILED head rotates so later captured request settles under small limit');
  // Authenticated HTTP contract through actual Express/auth/session middleware.
  const app=express();app.use(express.json());app.use('/api/payments/paypal',createPayPalRouter(runtime));app.use((err,req,res,next)=>res.status(err.status||500).json({error:err.code||'INTERNAL_ERROR'}));
  server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});const base='http://127.0.0.1:'+server.address().port;
  async function http(route,method='GET',token,body){const r=await fetch(base+route,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json()};}
  const cfg=await http('/api/payments/paypal/config');ok(cfg.status===200&&cfg.body.paypalSandbox.enabled&&!JSON.stringify(cfg.body).includes('fixture-secret'),'public config exposes enabled Sandbox mode without secrets');
  const unauth=await http('/api/payments/paypal/'+row.id+'/capture','POST');ok(unauth.status===401,'capture route requires real session token');
  const outsider=await http('/api/payments/paypal/'+row.id+'/capture','POST',b.token);ok(outsider.status===403,'HTTP owner check rejects other account');
  const own=await http('/api/payments/paypal/'+row.id+'/capture','POST',a.token);ok(own.status===200&&own.body.status==='SUCCEEDED'&&own.body.outcome==='DUPLICATE','authenticated HTTP replay returns durable status');
  const missing=await http('/api/payments/paypal/topup','POST',a.token,{amount:10000});ok(missing.status===400&&missing.body.error==='VALIDATION_ERROR','PayPal HTTP creation requires requestId');
  const disabled=createPayPalRuntime({config:{...config,enabled:false},provider:createSandboxProvider(config,{fetchImpl:transport})});
  ok(!disabled.publicConfig().paypalSandbox.enabled,'disabled configuration fails closed');
  await assert.rejects(()=>disabled.create({userId:a.user.id,amount:10000,requestId:uuid()}),e=>e.code==='PAYPAL_DISABLED');ok(true,'disabled runtime makes no remote payment call');
  require('../src/lib/rateLimit').resetRateLimits();
  const verifyBefore=signatureCalls;let lastWebhook;
  for(let i=0;i<61;i++)lastWebhook=await fetch(base+'/api/payments/paypal/webhook',{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(event(row))});
  ok(lastWebhook.status===429&&Number(lastWebhook.headers.get('retry-after'))>0,'webhook quota returns 429 and Retry-After');
  ok(signatureCalls-verifyBefore===60,'webhook limiter prevents additional provider verification calls');
  require('../src/lib/rateLimit').resetRateLimits();let lastCapture;
  for(let i=0;i<11;i++)lastCapture=await http('/api/payments/paypal/'+row.id+'/capture','POST',a.token);
  ok(lastCapture.status===429,'authenticated capture quota cannot be bypassed by repeats');
  const disabledApp=express();disabledApp.use(express.json());disabledApp.use('/api/payments/paypal',createPayPalRouter(disabled));disabledApp.use((err,req,res,next)=>res.status(err.status||500).json({error:err.code}));
  const disabledServer=await new Promise(resolve=>{const s=disabledApp.listen(0,'127.0.0.1',()=>resolve(s));});
  try {
    require('../src/lib/rateLimit').resetRateLimits();
    const dbase='http://127.0.0.1:'+disabledServer.address().port;
    for(const [route,method] of [['/topup','POST'],['/'+row.id+'/checkout','GET'],['/'+row.id+'/capture','POST'],['/webhook','POST']]) {
      const r=await fetch(dbase+'/api/payments/paypal'+route,{method,headers:{'content-type':'application/json',authorization:'Bearer '+a.token},body:method==='POST'?'{}':undefined});
      ok(r.status===503&&(await r.json()).error==='PAYPAL_DISABLED','disabled HTTP '+route+' makes no payment call');
    }
  } finally {await new Promise(r=>disabledServer.close(r));}
  const invariantResults=await require('../src/lib/paypalInvariants').checkPayPalInvariants(db);
  for(const result of invariantResults)ok(result.violations.length===0,'PayPal invariant '+result.code);
  console.log('PayPal integration: '+n+' checks passed');
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(async()=>{delete process.env.FAULT_INJECT;if(server)await new Promise(r=>server.close(r));await db.close();});
