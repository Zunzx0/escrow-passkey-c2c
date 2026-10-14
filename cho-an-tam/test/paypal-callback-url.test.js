'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { paypalCallbackUrl } = require('../src/lib/paypalCallbackUrl');

for (const kind of ['return', 'cancel']) {
  test(kind + ': callback keeps provider parameters out of SPA fragment', () => {
    const callback = paypalCallbackUrl('https://enclave.id.vn', kind, 'synthetic-payment-id');
    const redirected = new URL(callback + '&token=SYNTHETIC&PayerID=SYNTHETIC');
    assert.equal(redirected.hash, '');
    assert.equal(redirected.origin, 'https://enclave.id.vn');
    assert.equal(redirected.pathname, '/');
    assert.equal(redirected.searchParams.get('paypal'), kind);
    assert.equal(redirected.searchParams.get('paymentRequestId'), 'synthetic-payment-id');
    assert.equal(redirected.searchParams.get('token'), 'SYNTHETIC');
    assert.equal(redirected.searchParams.get('PayerID'), 'SYNTHETIC');
  });
}
