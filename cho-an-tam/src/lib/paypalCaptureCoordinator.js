'use strict';
const crypto = require('crypto');
const { PayPalSandboxError, validateQuote } = require('./paypalSandboxProvider');
// No SQL credit here: settle must atomically finish/mark evidence + wallet + ledger + request.
function createCaptureCoordinator({store, provider, settle, now=Date.now, leaseMs=120000}) {
  if (!store || !provider || typeof settle !== 'function' || !Number.isSafeInteger(leaseMs) || leaseMs<1000) throw new TypeError('Store, provider, atomic settlement and valid lease required');
  const fail=(code,message,status=409)=>{throw new PayPalSandboxError(code,message,status);};
  function checked(result,row) {
    if (!result || result.orderId!==row.orderId || result.paymentRequestId!==row.paymentRequestId || result.amount!==row.amountVnd || !['PENDING','SUCCEEDED'].includes(result.status)) fail('PAYPAL_ORDER_MISMATCH','Verified result does not match persistent binding');
    if (result.status==='SUCCEEDED' && (typeof result.captureId!=='string'||!result.captureId)) fail('PAYPAL_ORDER_MISMATCH','Completed capture evidence is missing');
    return result;
  }
  return Object.freeze({async capture({paymentRequestId,userId}) {
    if (typeof paymentRequestId!=='string'||!paymentRequestId||typeof userId!=='string'||!userId) fail('VALIDATION_ERROR','Authenticated payment request owner required',400);
    const row=await store.loadByRequestId(paymentRequestId);
    if (!row) fail('PAYMENT_REQUEST_NOT_FOUND','Payment request not found',404);
    if (row.userId!==userId) fail('FORBIDDEN','Payment request belongs to another account',403);
    const quote=validateQuote(row.quote);
    if (row.provider!=='PAYPAL_SANDBOX'||row.paymentRequestId!==paymentRequestId||quote.amountVnd!==row.amountVnd) fail('PAYPAL_ORDER_MISMATCH','Invalid persistent binding');
    const time=now(), claimId=crypto.randomUUID();
    const claim=await store.claimCapture(paymentRequestId,userId,claimId,new Date(time).toISOString(),new Date(time-leaseMs).toISOString());
    if (claim.outcome==='FORBIDDEN') fail('FORBIDDEN','Payment request belongs to another account',403);
    if (claim.outcome==='NOT_FOUND') fail('PAYMENT_REQUEST_NOT_FOUND','Payment request not found',404);
    const current=claim.row||row;
    if (claim.outcome==='REPLAY') return {status:current.status,outcome:'DUPLICATE'};
    if (claim.outcome==='RECOVERY_REQUIRED') return {status:current.status,outcome:'RECOVERY_REQUIRED'};
    if (['CLOSED','NOT_CAPTURED'].includes(claim.outcome)) return {status:current.status,outcome:claim.outcome};
    const settlement=(result,token)=>settle({paymentRequestId,providerRef:current.providerRef,orderId:current.orderId,captureId:result.captureId,amount:current.amountVnd,status:'SUCCEEDED',source:'RECONCILER',claimId:token});
    if (claim.outcome==='SETTLEMENT_REQUIRED') {
      if (!current.capture||!current.capture.captureId) fail('PAYPAL_ORDER_MISMATCH','Stored capture evidence missing');
      return settlement({captureId:current.capture.captureId},null);
    }
    if (claim.outcome!=='CLAIMED') return {status:current.status,outcome:claim.outcome};
    const input={orderId:current.orderId,paymentRequestId,quote:current.quote};
    let posted=false;
    try {
      if (claim.mustVerifyFirst) {
        const previous=checked(await provider.getOrder(input),current);
        if (previous.status==='SUCCEEDED') return await settlement(previous,claimId);
        if (previous.payerActionRequired === true || previous.captureId) {
          await store.finishCaptureAttempt(paymentRequestId,claimId,{state:'UNKNOWN',errorCode:previous.payerActionRequired === true?'PAYPAL_PAYER_ACTION_REQUIRED':'PAYPAL_CAPTURE_UNRESOLVED'});
          return {status:'PENDING',outcome:previous.payerActionRequired === true?'AWAITING_APPROVAL':'RECONCILING'};
        }
      }
      const result=checked(await provider.captureOrder({...input,beforeCapture:async()=>{
        const mark=await store.markCapturePostSent(paymentRequestId,claimId,new Date(now()).toISOString());
        if (!mark.ok) fail('PAYPAL_CAPTURE_CLAIM_LOST','Capture claim no longer belongs to this process');
        posted=true;
      }}),current);
      if (result.status==='SUCCEEDED') return await settlement(result,claimId);
      const uncertain=posted||claim.mustVerifyFirst||!!result.captureId;
      await store.finishCaptureAttempt(paymentRequestId,claimId,{state:uncertain?'UNKNOWN':'READY',
        errorCode:result.payerActionRequired === true?'PAYPAL_PAYER_ACTION_REQUIRED':null});
      return {status:'PENDING',outcome:result.payerActionRequired === true?'AWAITING_APPROVAL':uncertain?'RECONCILING':'AWAITING_APPROVAL'};
    } catch (error) {
      // Unknown after POST stays pending; never infer FAILED from network error or timeout.
      try { await store.finishCaptureAttempt(paymentRequestId,claimId,{state:'UNKNOWN',errorCode:error.code||'PAYPAL_CAPTURE_UNRESOLVED'}); }
      catch(cleanupError) { console.error('[paypal-cleanup] failed to persist UNKNOWN',cleanupError.code||'CLEANUP_ERROR','original',error.code||'PAYPAL_CAPTURE_UNRESOLVED'); }
      throw error;
    }
  }});
}
module.exports={createCaptureCoordinator};
