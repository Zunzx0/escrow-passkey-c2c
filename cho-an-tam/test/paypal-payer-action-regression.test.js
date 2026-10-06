'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createSandboxProvider,createQuote}=require('../src/lib/paypalSandboxProvider');
const {createCaptureCoordinator}=require('../src/lib/paypalCaptureCoordinator');
function fixture(status='CREATED',postGet='PAYER_ACTION_REQUIRED') {
 const quote=createQuote(100000,25000), calls=[], finishes=[];
 const order={id:'O1',intent:'CAPTURE',status,purchase_units:[{reference_id:'p1',custom_id:'p1',payee:{merchant_id:'M1'},amount:{currency_code:'USD',value:quote.usdValue}}],links:[{rel:'payer-action',href:'https://www.sandbox.paypal.com/checkoutnow?token=O1'}]};
 let posted=false,settled=0,mark=0;
 const provider=createSandboxProvider({enabled:true,clientId:'local',clientSecret:'local',merchantId:'M1',webhookId:'W1',frontendOrigin:'https://enclave.id.vn'}, {fetchImpl:async(url,opts)=>{
 calls.push({url,method:opts.method});let body=structuredClone(order),ok=true,http=200;
 if(url.endsWith('/token'))body={access_token:'local',token_type:'Bearer',expires_in:3600};
 else if(url.endsWith('/capture')) {posted=true;body={details:[{issue:'PAYER_ACTION_REQUIRED'}]};ok=false;http=422;}
 else if(posted) {if(postGet==='GET_ERROR')throw Error('offline');body.status=postGet;if(postGet==='MISMATCH')body.purchase_units[0].amount.value='99.00';if(postGet==='COMPLETED')body.purchase_units[0].payments={captures:[{id:'C1',final_capture:true,status:'COMPLETED',amount:{currency_code:'USD',value:quote.usdValue}}]};}
 return {ok,status:http,text:async()=>JSON.stringify(body)}; }});
 const row={paymentRequestId:'p1',userId:'u1',provider:'PAYPAL_SANDBOX',providerRef:'R1',amountVnd:100000,quote,orderId:'O1',status:'PENDING',capture:{state:'READY'}};
 const store={loadByRequestId:async()=>row,claimCapture:async()=>({outcome:'CLAIMED',row,mustVerifyFirst:false}),markCapturePostSent:async()=>{mark++;return{ok:true}},finishCaptureAttempt:async(id,token,value)=>{finishes.push(value);return{ok:true}}};
 const coordinator=createCaptureCoordinator({store,provider,settle:async()=>{settled++;return{status:'SUCCEEDED',outcome:'APPLIED'}}});
 return{coordinator,calls,finishes,mark:()=>mark,settled:()=>settled,store};
}
const owner={paymentRequestId:'p1',userId:'u1'};
for(const state of ['CREATED','SAVED','PAYER_ACTION_REQUIRED'])test(`preflight ${state} asks buyer without POST or marker`,async()=>{const f=fixture(state);assert.deepEqual(await f.coordinator.capture(owner),{status:'PENDING',outcome:'AWAITING_APPROVAL'});assert.equal(f.mark(),0);assert.equal(f.calls.filter(x=>x.url.endsWith('/capture')).length,0);assert.equal(f.settled(),0);assert.equal(f.finishes[0].state,'READY')});
test('422 after POST requires buyer action but retains UNKNOWN and durable marker',async()=>{const f=fixture('APPROVED');assert.deepEqual(await f.coordinator.capture(owner),{status:'PENDING',outcome:'AWAITING_APPROVAL'});assert.equal(f.mark(),1);assert.equal(f.calls.filter(x=>x.url.endsWith('/capture')).length,1);assert.equal(f.finishes[0].state,'UNKNOWN');assert.equal(f.finishes[0].errorCode,'PAYPAL_PAYER_ACTION_REQUIRED');assert.equal(f.settled(),0)});
test('422 followed by verified COMPLETED settles canonical capture once',async()=>{const f=fixture('APPROVED','COMPLETED');assert.deepEqual(await f.coordinator.capture(owner),{status:'SUCCEEDED',outcome:'APPLIED'});assert.equal(f.settled(),1);assert.equal(f.finishes.length,0);assert.equal(f.mark(),1)});
for(const state of ['GET_ERROR','MISMATCH'])test(`422 followed by ${state} cannot return approval or credit`,async()=>{const f=fixture('APPROVED',state);await assert.rejects(f.coordinator.capture(owner));assert.equal(f.finishes[0].state,'UNKNOWN');assert.equal(f.settled(),0);assert.equal(f.mark(),1)});
test('prior POST and buyer action never reset READY or issue another POST',async()=>{const f=fixture('PAYER_ACTION_REQUIRED');f.store.claimCapture=async()=>({outcome:'CLAIMED',row:await f.store.loadByRequestId(),mustVerifyFirst:true});assert.deepEqual(await f.coordinator.capture(owner),{status:'PENDING',outcome:'AWAITING_APPROVAL'});assert.equal(f.finishes[0].state,'UNKNOWN');assert.equal(f.calls.filter(x=>x.url.endsWith('/capture')).length,0);assert.equal(f.settled(),0)});
