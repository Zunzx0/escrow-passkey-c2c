'use strict';
// Real SPA under jsdom; all payment responses are synthetic and no PayPal is contacted.
const assert = require('node:assert/strict');
const { wallet, fakeServer, json, ppRow, intentJson, BUYER, INTENT_PREFIX } = require('./paypal-wallet-ui');
const id = '5b1f0c52-7a3e-4c1d-9a55-0f1e2d3c4b5a';
const storage = { [INTENT_PREFIX + BUYER.id]: intentJson() };
let checks = 0;
function ok(value, label) { assert.ok(value, label); checks++; console.log('✅ ' + label); }
async function main() {
  for (const hash of ['#/wallet&token=FAKE_ORDER&PayerID=FAKE_PAYER', '#/wallet?token=FAKE_ORDER&PayerID=FAKE_PAYER']) {
    const server = fakeServer({ status: 'SUCCEEDED', stage: 'SUCCEEDED', resolvedAt: new Date().toISOString() });
    const page = await wallet({ hash, search: '?paypal=return&paymentRequestId=' + id, storage, extra: server.routes() });
    try {
      ok(page.viewText().includes('Ví & nạp tiền') && !page.viewText().includes('Không có trang này'), 'PayPal return opens wallet directly for ' + hash.split('token=')[0]);
      ok(page.w.location.hash === '#/wallet' && page.w.location.search === '', 'Callback metadata and provider identifiers are removed from the address');
      ok(page.toasts().filter((t) => /Nạp tiền thành công/.test(t.text)).length === 1, 'Server-confirmed payment shows success exactly once');
      ok(server.captures === 0 && page.count('POST /api/payments/paypal/topup') === 0, 'Already-paid return neither recaptures nor creates a new topup');
    } finally { page.close(); }
  }
  {
    const server = fakeServer();
    server.captureResult = () => { server.row = ppRow({ status: 'SUCCEEDED', stage: 'SUCCEEDED', resolvedAt: new Date().toISOString() }); return json(200, { outcome: 'APPLIED' }); };
    const page = await wallet({ hash: '', search: '?paypal=return&paymentRequestId=' + id + '&token=FAKE_ORDER&PayerID=FAKE_PAYER', storage, extra: server.routes() });
    try {
      ok(page.w.location.hash === '#/wallet' && page.viewText().includes('Ví & nạp tiền'), 'Callback without a fragment navigates to wallet');
      ok(server.captures === 1 && page.count('GET /api/payments/' + id) >= 2, 'Matched unpaid intent is verified, completed once and verified again');
    } finally { page.close(); }
  }
  {
    const server = fakeServer();
    const page = await wallet({ hash: '#/wallet&token=FAKE_ORDER', search: '?paypal=cancel&paymentRequestId=' + id, storage, extra: server.routes() });
    try {
      ok(page.w.location.hash === '#/wallet' && page.viewText().includes('Ví & nạp tiền'), 'Cancel also returns directly to wallet');
      ok(server.captures === 0 && !page.toasts().some((t) => /Nạp tiền thành công/.test(t.text)), 'Cancel never initiates capture or claims success');
    } finally { page.close(); }
  }
  {
    const page = await wallet({ hash: '#/wallet&token=FAKE_ORDER&PayerID=FAKE_PAYER' });
    try {
      ok(page.viewText().includes('Ví & nạp tiền') && page.w.location.hash === '#/wallet', 'Reloading the old broken return address recovers the wallet');
      ok(!page.log.some((key) => /\/capture$/.test(key)), 'Provider identifiers alone cannot authorize payment');
    } finally { page.close(); }
  }
  for (const role of ['BUYER', 'SELLER']) {
    const page = await wallet({ user: { ...BUYER, role } });
    try {
      const items = [...page.d.querySelectorAll('#sidebar .nav-item')].map((el) => el.getAttribute('href'));
      ok(items.indexOf('#/wallet') >= 0 && items.indexOf('#/wallet') < items.indexOf('#/notifications'), role + ': wallet is before notifications');
      ok(items[0] === '#/orders', role + ': orders remain the first marketplace action');
    } finally { page.close(); }
  }
  console.log(checks + ' return-routing assertions passed');
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
