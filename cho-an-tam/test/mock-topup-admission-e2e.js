'use strict';
// Run only on disposable local test storage. Provider is the existing mock, not PayPal.
const H=require('./helpers/paypal-m2-harness');
H.init('mock-topup-admission');
const fs=require('fs'),path=require('path');
const callLog=path.join(H.ROOT,'data','test','mock-topup-admission-calls.log');
try{fs.unlinkSync(callLog);}catch(e){if(e.code!=='ENOENT')throw e;}
process.env.MOCK_PROVIDER_CALL_LOG=callLog;
for(const key of ['MOCK_PROVIDER_CHECKOUT','PAYPAL_SANDBOX_ENABLED','MOCK_PROVIDER_SUBMIT_FAIL'])delete process.env[key];
const {db,uuid}=require('../src/db');
const express=require('express');
const router=require('../src/routes/payments');
const calls=()=>{try{return fs.readFileSync(callLog,'utf8').trim().split('\n').filter(Boolean).length;}catch(e){if(e.code==='ENOENT')return 0;throw e;}};
async function main(){
 const t=H.tally('Mock topup admission');
 const app=express();app.use(express.json());app.use('/api/payments',router);
 app.use((err,req,res,next)=>res.status(err.status||500).json({error:err.code||'INTERNAL_ERROR',message:err.message}));
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 const base='http://127.0.0.1:'+server.address().port+'/api/payments';
 const buyer=await H.createAccount(db,{label:'mock-admission'});
 const post=body=>H.http(base,'/topup',{method:'POST',token:buyer.token,body});
 const row=key=>db.prepare('SELECT * FROM payment_requests WHERE user_id=? AND client_request_id=?').get(buyer.id,key);
 try{
  const submittedKey='admission-submitted-'+uuid();
  const initialCalls=calls();
  const admitted=await post({amount:10000,requestId:submittedKey});
  t.eq(admitted.status,201,'flags unset: authenticated topup remains enabled');
  t.eq(calls(),initialCalls+1,'flags unset: exactly one mock provider submit');
  t.ok(admitted.body.provider==='MOCK'&&admitted.body.submissionStatus==='SUBMITTED','flags unset: original response contract unchanged');

  const failedKey='admission-failed-'+uuid();
  process.env.MOCK_PROVIDER_SUBMIT_FAIL='1';
  const failed=await post({amount:10000,requestId:failedKey});
  delete process.env.MOCK_PROVIDER_SUBMIT_FAIL;
  t.ok(failed.status===503&&failed.body.error==='PROVIDER_UNAVAILABLE','enabled fixture: provider failure persists pending retryable request');
  t.eq((await row(failedKey)).submission_status,'SUBMIT_FAILED','fixture is retryable SUBMIT_FAILED');

  for(const [label,checkout,paypal] of [['both-off','0','0'],['paypal-requested','1','1'],['both-flags-disabled','0','1']]){
   process.env.MOCK_PROVIDER_CHECKOUT=checkout;process.env.PAYPAL_SANDBOX_ENABLED=paypal;
   const countBefore=Number((await db.prepare('SELECT COUNT(*) AS n FROM payment_requests WHERE user_id=?').get(buyer.id)).n);
   const callsBefore=calls();
   const key='disabled-'+uuid();
   const denied=await post({amount:10000,requestId:key});
   t.ok(denied.status===503&&denied.body.error==='MOCK_PAYMENTS_DISABLED',label+': direct authenticated POST rejected by feature flag');
   t.ok(!(await row(key)),label+': rejected request not inserted');
   const malformed=await post({amount:'not-a-number',requestId:false});
   t.ok(malformed.status===503&&malformed.body.error==='MOCK_PAYMENTS_DISABLED',label+': guard precedes body/key parsing');
   const submittedBefore=JSON.stringify(await row(submittedKey));
   const replaySubmitted=await post({amount:10000,requestId:submittedKey});
   t.ok(replaySubmitted.status===503&&replaySubmitted.body.error==='MOCK_PAYMENTS_DISABLED',label+': submitted replay blocked');
   t.eq(JSON.stringify(await row(submittedKey)),submittedBefore,label+': submitted replay has no business mutation');
   const failedBefore=JSON.stringify(await row(failedKey));
   const replayFailed=await post({amount:10000,requestId:failedKey});
   t.ok(replayFailed.status===503&&replayFailed.body.error==='MOCK_PAYMENTS_DISABLED',label+': retryable replay blocked before claim/submit');
   t.eq(JSON.stringify(await row(failedKey)),failedBefore,label+': retryable replay retains status/claim/attempts');
   t.eq(calls(),callsBefore,label+': neither fresh nor replay nor malformed request calls provider');
   t.eq(Number((await db.prepare('SELECT COUNT(*) AS n FROM payment_requests WHERE user_id=?').get(buyer.id)).n),countBefore,label+': business request count unchanged');
   if(label==='both-off')t.ok(!/hãy dùng PayPal/i.test(denied.body.message||''),'both off: error does not tell user to use unavailable PayPal');
  }

  delete process.env.MOCK_PROVIDER_CHECKOUT;delete process.env.PAYPAL_SANDBOX_ENABLED;
  const callsBeforeRecovery=calls();
  const retry=await post({amount:10000,requestId:failedKey});
  t.ok(retry.status===200&&retry.body.idempotentReplay===true&&retry.body.submissionStatus==='SUBMITTED','unset flags restores existing retry without creating a new request');
  t.eq(calls(),callsBeforeRecovery+1,'enabled retry submits once');
  const beforeExplicit=calls();process.env.MOCK_PROVIDER_CHECKOUT='1';process.env.PAYPAL_SANDBOX_ENABLED='0';
  const explicit=await post({amount:10000,requestId:'explicit-'+uuid()});
  t.eq(explicit.status,201,'explicit mock on and PayPal off remains enabled');
  t.eq(calls(),beforeExplicit+1,'explicit mock on submits once');
  t.eq(Number((await H.wallet(db,buyer.id)).available_balance),0,'admission/retry never credits wallet before provider result');
  const invariant=await H.invariantSummary(db);
  t.ok(invariant.coreOk&&invariant.paypalOk,'existing nine invariants and separate PayPal checks hold');
  const {fail}=t.summary();process.exitCode=fail?1:0;
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await db.close();}
}
main().then(()=>process.exit(process.exitCode||0),error=>{console.error(error.stack);process.exit(1);});
