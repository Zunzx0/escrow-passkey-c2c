'use strict';
process.env.APP_ENV='test';process.env.DB_PATH='data/test/payer-action-runtime.sqlite';delete process.env.DATABASE_URL;
const {test}=require('node:test'),assert=require('node:assert/strict');
const {db,uuid}=require('../src/db');
const {createSandboxProvider,createQuote}=require('../src/lib/paypalSandboxProvider');
const {createPayPalRuntime}=require('../src/lib/paypalRuntime');
const config={enabled:true,mode:'sandbox',clientId:'local',clientSecret:'local',merchantId:'M1',webhookId:'W1',frontendOrigin:'https://enclave.id.vn',rateVndPerUsd:25000,timeoutMs:1000,leaseMs:120000};
test('checkout UNKNOWN hint requires verified GET, preserves evidence and never credits',async()=>{
 const id=uuid(),userId=uuid(),ref=uuid(),orderId='O'+uuid(),quote=createQuote(100000,25000);let state='PAYER_ACTION_REQUIRED',calls=0;
 const provider=createSandboxProvider(config,{fetchImpl:async(url)=>{
 if(url.endsWith('/token'))return{ok:true,status:200,text:async()=>JSON.stringify({access_token:'local',token_type:'Bearer',expires_in:3600})};
 calls++;if(state==='ERROR')throw Error('offline');
 const body={id:orderId,intent:'CAPTURE',status:state==='MISMATCH'?'PAYER_ACTION_REQUIRED':state,purchase_units:[{reference_id:id,custom_id:id,payee:{merchant_id:'M1'},amount:{currency_code:'USD',value:state==='MISMATCH'?'99.00':quote.usdValue}}],links:[{rel:'payer-action',href:'https://www.sandbox.paypal.com/checkoutnow?token='+orderId}]};
 if(state==='COMPLETED')body.purchase_units[0].payments={captures:[{id:'C1',status:'COMPLETED',final_capture:true,amount:{currency_code:'USD',value:quote.usdValue}}]};
 return{ok:true,status:200,text:async()=>JSON.stringify(body)};}});
 const runtime=createPayPalRuntime({config,provider});
 await db.prepare("INSERT INTO users (id,username,display_name,role,password_hash) VALUES (?,?,?,'BUYER','local')").run(userId,'review'+userId,'Review');
 await db.prepare("INSERT INTO payment_requests (id,user_id,amount,status,provider_ref,client_request_id,submission_status,provider) VALUES (?,?,?,'PENDING',?,?,'SUBMITTED','PAYPAL_SANDBOX')").run(id,userId,100000,ref,'review-'+uuid());
 await runtime.store.createBinding({paymentRequestId:id,quote,merchantId:'M1',nowIso:new Date().toISOString()});await runtime.store.bindOrder(id,orderId);
 await db.prepare("UPDATE paypal_payment_bindings SET capture_state='UNKNOWN',capture_post_sent_at=?,capture_post_count=1,last_capture_error='PAYPAL_PAYER_ACTION_REQUIRED' WHERE payment_request_id=?").run(new Date().toISOString(),id);
 let result=await runtime.checkout(id,userId);assert.equal(result.stage,'AWAITING_APPROVAL');assert.ok(result.approvalUrl);assert.equal(calls,1);assert.equal((await runtime.store.loadByRequestId(id)).capture.state,'UNKNOWN');
 state='COMPLETED';result=await runtime.checkout(id,userId);assert.equal(result.stage,'RECONCILING');assert.equal(result.approvalUrl,null);
 state='MISMATCH';await assert.rejects(runtime.checkout(id,userId),e=>e.code==='PAYPAL_ORDER_MISMATCH');
 state='ERROR';await assert.rejects(runtime.checkout(id,userId),e=>e.code==='PAYPAL_UNAVAILABLE');
 assert.equal((await runtime.store.loadByRequestId(id)).capture.state,'UNKNOWN');assert.equal((await db.prepare('SELECT status FROM payment_requests WHERE id=?').get(id)).status,'PENDING');assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM wallet_entries WHERE request_id=?').get(id)).n,0);
 await db.close();
});
