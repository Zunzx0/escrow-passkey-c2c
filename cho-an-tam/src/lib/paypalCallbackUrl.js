'use strict';

function paypalCallbackUrl(origin, kind, paymentRequestId) {
  const url = new URL(origin);
  url.searchParams.set('paypal', kind);
  url.searchParams.set('paymentRequestId', paymentRequestId);
  // No fragment: provider-added query parameters must remain in the query string,
  // rather than becoming part of the SPA route after #/wallet.
  url.hash = '';
  return url.href;
}

module.exports = { paypalCallbackUrl };
