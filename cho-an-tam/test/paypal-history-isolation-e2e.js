'use strict';
// Real routes/runtime, local disposable DB, synthetic provider; no PayPal network.
const H=require('./helpers/paypal-m2-harness');
H.init('history-isolation');
const {db,uuid,nowIso}=require('../src/db');
const express=require('express');
const runtimeModule=require('../src/lib/paypalRuntime');
const {createQuote}=require('../src/lib/paypalSandboxProvider');
async function main(){
 const t=H.tally('PayPal history isolation'),cfg=H.config();
 let mode='offline',calls=0;
 const provider={getOrder:async input=>{calls++;if(mode==='offline')throw Error('controlled offline');if(mode==='mismatch')throw Object.assign(Error('controlled mismatch'),{code:'PAYPAL_ORDER_MISMATCH'});return{orderId:input.orderId,paymentRequestId:input.paymentRequestId,amount:input.quote.amountVnd,status:'PENDING',payerActionRequired:true,approvalUrl:'https://www.sandbox.paypal.com/checkoutnow?token='+input.orderId};}};
 const runtime=runtimeModule.createPayPalRuntime({config:cfg,provider});
 const original=runtimeModule.serializePayPal;
 runtimeModule.serializePayPal=(id,options)=>runtime.serializePayPal(id,options);
 const buyer=await H.createAccount(db,{label:'history'}),other=await H.createAccount(db,{label:'history-other'});
 const id=uuid(),key='history-'+uuid(),order='ORDER'+uuid();
 await db.prepare("INSERT INTO payment_requests (id,user_id,amount,status,provider_ref,client_request_id,submission_status,provider,created_at,updated_at) VALUES (?,?,10000,'PENDING',?,?,'SUBMITTED','PAYPAL_SANDBOX',?,?)").run(id,buyer.id,uuid(),key,nowIso(),nowIso());
 await runtime.store.createBinding({paymentRequestId:id,quote:createQuote(10000,25000),merchantId:cfg.merchantId,nowIso:nowIso()});await runtime.store.bindOrder(id,order);
 await db.prepare("UPDATE paypal_payment_bindings SET capture_state='UNKNOWN',capture_post_sent_at=?,capture_post_count=1,last_capture_error='PAYPAL_PAYER_ACTION_REQUIRED' WHERE payment_request_id=?").run(nowIso(),id);
 const mockId=uuid();
 await db.prepare("INSERT INTO payment_requests (id,user_id,amount,status,provider_ref,client_request_id,submission_status,provider,created_at,updated_at) VALUES (?,?,20000,'PENDING',?,?,'SUBMITTED','MOCK',?,?)").run(mockId,buyer.id,uuid(),'mock-'+uuid(),nowIso(),nowIso());
 const before=JSON.stringify(await runtime.store.loadByRequestId(id));
 const app=express();app.use(express.json());app.use('/api/payments',require('../src/routes/payments'));app.use((e,req,res,next)=>res.status(e.status||500).json({error:e.code||'INTERNAL_ERROR'}));
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});const base='http://127.0.0.1:'+server.address().port+'/api/payments';
 try{
  for(const failure of ['offline','mismatch','online']){
   mode=failure;const count=calls;const history=await H.http(base,'/me',{token:buyer.token});
   t.eq(history.status,200,failure+': history remains available');
   t.eq(calls,count,failure+': history performs no provider lookup');
   if(history.status===200){const rows=history.body.paymentRequests,row=rows.find(r=>r.id===id);t.eq(rows.length,2,failure+': unrelated mock row retained');t.ok(row&&row.status==='PENDING'&&row.stage==='RECONCILING'&&row.approvalUrl===null,failure+': unknown result remains unresolved, never approval or success');t.ok(row&&row.requestId===key&&row.amount===10000,failure+': stored identity/amount retained');}
  }
  mode='online';const count=calls;const detail=await H.http(base,'/'+id,{token:buyer.token});
  t.eq(detail.status,200,'detail still available');t.eq(calls,count+1,'detail still fetches fresh evidence');t.eq(detail.body.stage,'AWAITING_APPROVAL','detail shows verified payer action');
  mode='offline';t.eq((await H.http(base,'/'+id,{token:buyer.token})).status,500,'detail provider failure remains an error, no fake success');
  mode='mismatch';t.eq((await H.http(base,'/'+id,{token:buyer.token})).body.error,'PAYPAL_ORDER_MISMATCH','detail mismatch still rejected');
  t.eq((await H.http(base,'/'+id,{token:other.token})).status,403,'other account cannot read detail');
  t.eq((await H.http(base,'/me',{token:other.token})).body.paymentRequests.length,0,'history does not expose other account requests');
  t.eq((await H.http(base,'/me')).status,401,'history still requires authentication');
  t.eq(JSON.stringify(await runtime.store.loadByRequestId(id)),before,'history/detail do not mutate capture evidence');
  t.eq(Number((await H.wallet(db,buyer.id)).available_balance),0,'history/detail never credit wallet');t.eq((await H.credits(db,id)).length,0,'history/detail never create ledger credit');
  const invariant=await H.invariantSummary(db);t.ok(invariant.coreOk&&invariant.paypalOk,'nine financial and separate PayPal checks hold');
  const {fail}=t.summary();process.exitCode=fail?1:0;
 }finally{runtimeModule.serializePayPal=original;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await db.close();}
}
main().then(()=>process.exit(process.exitCode||0),e=>{console.error(e.stack);process.exit(1);});
