'use strict';
const { db: appDb, nowIso } = require('../db');
const { AppError } = require('./errors');
const walletOps = require('./walletOps');
const { maybeFail } = require('./faultInjection');
const { logSecurityEvent, EVENTS } = require('./securityEvents');
const { onTopupResolved } = require('./notifications');

// Only the verified server adapter/coordinator may invoke this sink. Never mount it as an API.
function createPayPalSettlement({db=appDb,store}) {
  if(db!==appDb)throw new TypeError('Settlement and walletOps must use the same application DB');
  const stale = Symbol('STALE_CAPTURE_CLAIM');
  async function transaction(result, useClaim) {
    return db.transaction(async()=> {
      const pr=await db.prepare('SELECT * FROM payment_requests WHERE id = ?').get(result.paymentRequestId);
      const binding=await store.loadByRequestId(result.paymentRequestId);
      if (!pr || !binding) throw new AppError(404,'PAYMENT_REQUEST_NOT_FOUND','Không tìm thấy yêu cầu nạp tiền');
      if (pr.provider!=='PAYPAL_SANDBOX' || pr.provider_ref!==result.providerRef || pr.amount!==result.amount ||
          binding.orderId!==result.orderId || binding.amountVnd!==result.amount || result.status!=='SUCCEEDED' ||
          typeof result.captureId!=='string' || !result.captureId || !['WEBHOOK','RECONCILER'].includes(result.source)) {
        throw new AppError(409,'PAYPAL_ORDER_MISMATCH','Bằng chứng thanh toán không khớp yêu cầu');
      }
      let evidence=useClaim
        ? await store.finishCaptureAttempt(pr.id,result.claimId,{state:'VERIFIED',captureId:result.captureId})
        : await store.markCaptureVerified(pr.id,result.captureId);
      if (evidence.reason==='STALE_CLAIM') throw stale;
      if(evidence.reason==='CAPTURE_ID_CONFLICT') evidence=await store.markCaptureVerified(pr.id,result.captureId);
      if (evidence.outcome==='RECOVERY_REQUIRED') return {outcome:'RECOVERY_REQUIRED',status:pr.status};
      if (!evidence.ok) return {outcome:'CONFLICT',status:pr.status,reason:evidence.reason};
      if (pr.status==='SUCCEEDED') return {outcome:'DUPLICATE',status:pr.status};
      if (pr.status!=='PENDING') throw new AppError(409,'PAYPAL_PAYMENT_CLOSED','Yêu cầu nạp đã đóng');
      const time=nowIso();
      const claim=await db.prepare("UPDATE payment_requests SET status='SUCCEEDED', version=version+1, resolved_at=?, resolved_by=?, updated_at=? WHERE id=? AND provider='PAYPAL_SANDBOX' AND status='PENDING' AND version=?").run(time,result.source,time,pr.id,pr.version);
      if (claim.changes!==1) throw new AppError(409,'PAYPAL_SETTLEMENT_CONFLICT','Trạng thái nạp đã thay đổi; hãy kiểm tra lại');
      const wallet=await walletOps.getUserWallet(pr.user_id);
      if (!wallet) throw new AppError(404,'WALLET_NOT_FOUND','Không tìm thấy ví');
      const updated=await walletOps.applyWalletDelta(wallet,pr.amount,0);
      maybeFail('after-wallet-update','paypal-topup');
      await walletOps.insertWalletEntry({walletId:wallet.id,transactionId:null,requestId:pr.id,
        entryType:'TOPUP_CREDIT',availableDelta:pr.amount,lockedDelta:0,walletAfter:updated,
        idempotencyKey:`topup:${pr.id}`,requestFingerprint:walletOps.fingerprintRequest({actorId:pr.user_id,action:'TOPUP',transactionId:null,amount:pr.amount}),
        description:'Nạp tiền qua PayPal Sandbox (mô phỏng)'});
      maybeFail('before-status-change','paypal-topup'); // Last rollback gate before committing all evidence + money.
      return {outcome:'APPLIED',status:'SUCCEEDED',request:pr};
    })();
  }
  return async function settle(result) {
    let outcome;
    try { outcome=await transaction(result,Boolean(result.claimId)); }
    catch(error) { if(error!==stale) throw error; outcome=await transaction(result,false); }
    // A reporting failure after COMMIT must never report the money transaction as rolled back.
    if(outcome.outcome==='APPLIED') {
      const pr=outcome.request; delete outcome.request;
      try { await logSecurityEvent(null,{type:EVENTS.TOPUP_SUCCEEDED,outcome:'ALLOWED',detail:{paymentRequestId:pr.id,amount:pr.amount,source:result.source,provider:'PAYPAL_SANDBOX'}}); }
      catch(error) { console.error('[paypal-report] security event failed after committed settlement',error.code||'REPORT_ERROR'); }
      try { await onTopupResolved(pr,'SUCCEEDED'); }
      catch(error) { console.error('[paypal-report] notification failed after committed settlement',error.code||'REPORT_ERROR'); }
    }
    return outcome;
  };
}
module.exports={createPayPalSettlement};
