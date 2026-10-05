'use strict';
// PayPal-specific audit checks; keep the thesis's existing nine invariants unchanged.
async function checkPayPalInvariants(db) {
  return [
    {code:'PAYPAL_SUCCEEDED_HAS_ONE_CREDIT_AND_CAPTURE',violations:await db.prepare(`SELECT pr.id FROM payment_requests pr LEFT JOIN paypal_payment_bindings b ON b.payment_request_id=pr.id WHERE pr.provider='PAYPAL_SANDBOX' AND pr.status='SUCCEEDED' AND (b.capture_id IS NULL OR b.capture_state<>'VERIFIED' OR (SELECT COUNT(*) FROM wallet_entries e WHERE e.request_id=pr.id AND e.entry_type='TOPUP_CREDIT')<>1 OR (SELECT COALESCE(SUM(e.available_delta),0) FROM wallet_entries e WHERE e.request_id=pr.id AND e.entry_type='TOPUP_CREDIT')<>pr.amount)`).all()},
    {code:'PAYPAL_CAPTURE_BOUND_ONCE',violations:await db.prepare('SELECT capture_id FROM paypal_payment_bindings WHERE capture_id IS NOT NULL GROUP BY capture_id HAVING COUNT(*)>1').all()},
    {code:'PAYPAL_CREDIT_REQUIRES_SUCCEEDED',violations:await db.prepare("SELECT e.id FROM wallet_entries e JOIN payment_requests pr ON pr.id=e.request_id WHERE pr.provider='PAYPAL_SANDBOX' AND e.entry_type='TOPUP_CREDIT' AND pr.status<>'SUCCEEDED'").all()}
  ];
}
module.exports={checkPayPalInvariants};
