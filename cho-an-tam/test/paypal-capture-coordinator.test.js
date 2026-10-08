'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createCaptureCoordinator}=require('../src/lib/paypalCaptureCoordinator');
const {createQuote}=require('../src/lib/paypalSandboxProvider');
function fixture(outcome='CLAIMED',mustVerifyFirst=false){
 const events=[],row={paymentRequestId:'p1',userId:'u1',provider:'PAYPAL_SANDBOX',providerRef:'r1',amountVnd:100000,quote:createQuote(100000,25000),orderId:'O1',status:'PENDING',capture:{captureId:'C1'}};
 const result={paymentRequestId:'p1',orderId:'O1',amount:100000,status:'SUCCEEDED',captureId:'C1'};
 const store={async loadByRequestId(){return row},async claimCapture(){events.push('claim');return{outcome,row,mustVerifyFirst}},async markCapturePostSent(){events.push('marker');return{ok:true}},async finishCaptureAttempt(id,token,value){events.push(value.state);return{ok:true}}};
 const provider={async getOrder(){events.push('GET');return result},async captureOrder(input){await input.beforeCapture();events.push('POST');return result}};
 let payload; const coordinator=createCaptureCoordinator({store,provider,settle:async value=>{events.push('settle');payload=value;return{status:'SUCCEEDED',outcome:'APPLIED'}}});
 return{coordinator,events,row,result,store,provider,payload:()=>payload};
}
const owner={paymentRequestId:'p1',userId:'u1'};
test('claim + durable marker precede network; evidence and token carried to atomic settlement',async()=>{const f=fixture();await f.coordinator.capture(owner);assert.deepEqual(f.events,['claim','marker','POST','settle']);assert.equal(f.payload().captureId,'C1');assert.equal(f.payload().orderId,'O1');assert.ok(f.payload().claimId)});
test('wrong owner cannot claim or call provider',async()=>{const f=fixture();await assert.rejects(f.coordinator.capture({...owner,userId:'other'}),e=>e.code==='FORBIDDEN');assert.deepEqual(f.events,[])});
test('SETTLEMENT_REQUIRED settles recorded capture without fresh POST',async()=>{const f=fixture('SETTLEMENT_REQUIRED');await f.coordinator.capture(owner);assert.deepEqual(f.events,['claim','settle']);assert.equal(f.payload().captureId,'C1');assert.equal(f.payload().claimId,null)});
test('busy/recovery/closed/replay never call remote provider or settlement',async()=>{for(const outcome of ['BUSY','RECOVERY_REQUIRED','CLOSED','NOT_CAPTURED','REPLAY']){const f=fixture(outcome);await f.coordinator.capture(owner);assert.deepEqual(f.events,['claim'])}});
test('timeout after POST releases guarded claim UNKNOWN, not FAILED or READY',async()=>{const f=fixture();f.provider.captureOrder=async input=>{await input.beforeCapture();f.events.push('POST');throw Object.assign(Error('timeout'),{code:'TIMEOUT'})};await assert.rejects(f.coordinator.capture(owner));assert.deepEqual(f.events,['claim','marker','POST','UNKNOWN']);assert.equal(f.payload(),undefined)});
test('must verify first + known capture only queries and settles',async()=>{const f=fixture('CLAIMED',true);await f.coordinator.capture(owner);assert.deepEqual(f.events,['claim','GET','settle'])});
test('prior POST uncertainty is not reset READY if GET fails',async()=>{const f=fixture('CLAIMED',true);f.provider.getOrder=async()=>{throw Error('network')};await assert.rejects(f.coordinator.capture(owner));assert.deepEqual(f.events,['claim','UNKNOWN'])});
test('lost marker prevents POST, no settlement',async()=>{const f=fixture();f.store.markCapturePostSent=async()=>{f.events.push('marker');return{ok:false}};await assert.rejects(f.coordinator.capture(owner),e=>e.code==='PAYPAL_CAPTURE_CLAIM_LOST');assert.deepEqual(f.events,['claim','marker','UNKNOWN']);assert.equal(f.payload(),undefined)});
test('pending after POST remains reconciling',async()=>{const f=fixture();f.result.status='PENDING';assert.deepEqual(await f.coordinator.capture(owner),{status:'PENDING',outcome:'RECONCILING'});assert.deepEqual(f.events,['claim','marker','POST','UNKNOWN'])});
test('mismatching result never reaches settlement',async()=>{const f=fixture();f.result.amount=1234;await assert.rejects(f.coordinator.capture(owner),e=>e.code==='PAYPAL_ORDER_MISMATCH');assert.equal(f.payload(),undefined);assert.equal(f.events.at(-1),'UNKNOWN')});

test('known capture followed by settlement failure stays UNKNOWN even without local POST',async()=>{const f=fixture();f.provider.captureOrder=async()=>f.result;const c=createCaptureCoordinator({store:f.store,provider:f.provider,settle:async()=>{throw Error('DB rollback')}});await assert.rejects(c.capture(owner));assert.deepEqual(f.events,['claim','UNKNOWN'])});
