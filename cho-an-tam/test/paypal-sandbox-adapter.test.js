'use strict';

// Fake HTTP transport only. Never uses credentials, PayPal network, or any database.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const adapterPath = process.env.PAYPAL_PROVIDER_MODULE || process.env.PAYPAL_ADAPTER_PATH || path.join(__dirname, '../src/lib/paypalSandboxProvider.js');
const { createSandboxProvider, createQuote, verifyOrder, parseUsdCents } = require(adapterPath);
const config = { enabled: true, clientId: 'fixture-client', clientSecret: 'fixture-secret', webhookId: 'fixture-webhook', merchantId: 'MERCHANT', rateVndPerUsd: 25000, timeoutMs: 100, frontendOrigin: 'https://enclave.id.vn' };
const quote = createQuote(100000, 25000);
const binding = { orderId: 'ORDER123', paymentRequestId: 'payment-123', quote, merchantId: 'MERCHANT' };
const clone = value => structuredClone(value);
function order(status = 'COMPLETED', captureStatus = 'COMPLETED') {
  return { id: 'ORDER123', status, intent: 'CAPTURE', purchase_units: [{ reference_id: 'payment-123', custom_id: 'payment-123', invoice_id: 'payment-123', payee: { merchant_id: 'MERCHANT' }, amount: { currency_code: 'USD', value: '4.00' }, payments: { captures: [{ id: 'CAPTURE123', status: captureStatus, final_capture: true, amount: { currency_code: 'USD', value: '4.00' } }] } }], links: [{ rel: 'approve', href: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER123' }] };
}
function transport(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, ...init });
    const result = await handler(url, init, calls);
    if (result instanceof Error) throw result;
    return { ok: (result.status || 200) < 400, status: result.status || 200, text: async () => JSON.stringify(result.body) };
  };
  return { fetchImpl, calls };
}
function authOr(url, next) {
  return url.endsWith('/v1/oauth2/token') ? { body: { access_token: 'fixture-access-token', token_type: 'Bearer', expires_in: 300 } } : next;
}

test('VND quote uses exact integer cents and preserves the VND ledger amount', () => {
  assert.equal(quote.usdCents, 400);
  assert.equal(quote.usdValue, '4.00');
  assert.equal(quote.amountVnd, 100000);
  assert.equal(createQuote(100001, 25000).usdCents, 401);
  assert.equal(createQuote(100001, 25000).amountVnd, 100001);
  assert.ok(Object.isFrozen(quote));
  for (const amount of [0, -1, 1.5, '100000', true, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => createQuote(amount, 25000));
  for (const rate of [0, -1, 0.5, '25000', NaN, Infinity]) assert.throws(() => createQuote(100000, rate));
});

test('USD parser rejects coercion, exponent, excess precision and unsafe values', () => {
  assert.equal(parseUsdCents('4.00'), 400);
  assert.equal(parseUsdCents('0.01'), 1);
  for (const raw of [4, '4.001', '-4.00', '4e0', ' 4.00', '4.00 ', '', 'NaN', '9007199254740991.00']) assert.throws(() => parseUsdCents(raw));
});

test('verified completed capture is the only successful provider outcome', () => {
  const result = verifyOrder(order(), binding);
  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(result.amount, 100000);
  assert.equal(result.captureId, 'CAPTURE123');
  for (const status of ['CREATED', 'APPROVED', 'PAYER_ACTION_REQUIRED']) {
    const response = order(status); delete response.purchase_units[0].payments;
    assert.equal(verifyOrder(response, binding).status, 'PENDING');
  }
  const pending = order('COMPLETED', 'PENDING');
  assert.notEqual(verifyOrder(pending, binding).status, 'SUCCEEDED');
});

test('mismatched order, merchant, local request, money and currency fail closed', () => {
  const changes = [
    o => { o.id = 'OTHER'; },
    o => { o.purchase_units[0].custom_id = 'other-user-request'; },
    o => { o.purchase_units[0].payee.merchant_id = 'ATTACKER'; },
    o => { o.purchase_units[0].amount.value = '4.01'; },
    o => { o.purchase_units[0].amount.currency_code = 'EUR'; },
    o => { o.purchase_units[0].payments.captures[0].amount.value = '4.01'; },
    o => { o.purchase_units[0].payments.captures[0].amount.currency_code = 'EUR'; },
    o => { delete o.purchase_units[0].payments; },
    o => { delete o.purchase_units[0].payee; },
    o => { o.purchase_units.push(clone(o.purchase_units[0])); },
    o => { o.purchase_units[0].payments.captures.push(clone(o.purchase_units[0].payments.captures[0])); },
  ];
  for (const mutate of changes) { const response = order(); mutate(response); assert.throws(() => verifyOrder(response, binding)); }
  assert.throws(() => verifyOrder(order(), { ...binding, quote: { ...quote, amountVnd: 200000 } }));
});

test('disabled/missing config and production host never send requests', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('must not request'); };
  for (const bad of [{ ...config, enabled: false }, { ...config, clientSecret: '' }, { ...config, merchantId: '' }, { ...config, webhookId: '' }, { ...config, baseUrl: 'https://api-m.paypal.com' }]) {
    await assert.rejects(async () => { const p = createSandboxProvider(bad, { fetchImpl }); await p.getOrder(binding); });
  }
  assert.equal(calls, 0);
});

test('create order sends server quote and bound request metadata only to sandbox', async () => {
  const t = transport(url => authOr(url, { body: order('CREATED') }));
  const provider = createSandboxProvider(config, { fetchImpl: t.fetchImpl });
  await provider.createOrder({ paymentRequestId: binding.paymentRequestId, quote, returnUrl: 'https://enclave.id.vn/#/wallet?paypal=return', cancelUrl: 'https://enclave.id.vn/#/wallet?paypal=cancel' });
  assert.ok(t.calls.every(c => new URL(c.url).hostname === 'api-m.sandbox.paypal.com'));
  const c = t.calls.find(c => c.url.endsWith('/v2/checkout/orders'));
  const body = JSON.parse(c.body);
  assert.equal(body.intent, 'CAPTURE');
  assert.equal(body.purchase_units[0].custom_id, binding.paymentRequestId);
  assert.deepEqual(body.purchase_units[0].amount, { currency_code: 'USD', value: '4.00' });
  assert.ok(c.headers['PayPal-Request-Id']);
  assert.ok(!c.body.includes(config.clientSecret));
});

test('ambiguous capture timeout retries use the same provider idempotency key', async () => {
  let first = true;
  let captured = false;
  const t = transport(url => {
    if (url.endsWith('/v1/oauth2/token')) return authOr(url);
    if (!url.endsWith('/capture')) { const o = order(captured ? 'COMPLETED' : 'APPROVED'); if (!captured) delete o.purchase_units[0].payments; return { body: o }; }
    if (first) { first = false; return new Error('socket disappeared after capture'); }
    captured = true;
    return { body: order() };
  });
  const provider = createSandboxProvider(config, { fetchImpl: t.fetchImpl });
  await assert.rejects(() => provider.captureOrder(binding));
  assert.equal((await provider.captureOrder(binding)).status, 'SUCCEEDED');
  const captures = t.calls.filter(c => c.url.endsWith('/capture'));
  assert.equal(captures.length, 2);
  assert.equal(captures[0].headers['PayPal-Request-Id'], captures[1].headers['PayPal-Request-Id']);
  assert.equal(captures[0].body, captures[1].body);
});

test('parallel capture calls bind same order/request without generating new payment IDs', async () => {
  let captured = false;
  const t = transport(url => {
    if (url.endsWith('/v1/oauth2/token')) return authOr(url);
    if (url.endsWith('/capture')) { captured = true; return { body: order() }; }
    const o = order(captured ? 'COMPLETED' : 'APPROVED'); if (!captured) delete o.purchase_units[0].payments; return { body: o };
  });
  const provider = createSandboxProvider(config, { fetchImpl: t.fetchImpl });
  const results = await Promise.all(Array.from({ length: 6 }, () => provider.captureOrder(binding)));
  assert.ok(results.every(r => r.status === 'SUCCEEDED'));
  const ids = t.calls.filter(c => c.url.endsWith('/capture')).map(c => c.headers['PayPal-Request-Id']);
  assert.equal(new Set(ids).size, 1);
});

test('webhook trusts only PayPal verification SUCCESS and configured webhook ID', async () => {
  const headers = { 'paypal-auth-algo': 'SHA256withRSA', 'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/fixture', 'paypal-transmission-id': 'transmission-1', 'paypal-transmission-sig': 'fixture-signature', 'paypal-transmission-time': '2026-10-05T00:00:00Z' };
  const event = { id: 'EVENT1', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'CAPTURE123' } };
  for (const status of ['SUCCESS', 'FAILURE', undefined]) {
    const t = transport(url => authOr(url, { body: { verification_status: status } }));
    const provider = createSandboxProvider(config, { fetchImpl: t.fetchImpl });
    assert.equal(await provider.verifyWebhook({ headers, event }), status === 'SUCCESS');
    const sent = JSON.parse(t.calls.find(c => c.url.endsWith('/verify-webhook-signature')).body);
    assert.equal(sent.webhook_id, config.webhookId);
    assert.deepEqual(sent.webhook_event, event);
    assert.ok(t.calls.every(c => new URL(c.url).hostname === 'api-m.sandbox.paypal.com'));
  }
});

test('provider failures do not expose credentials or raw sensitive provider data', async () => {
  const secretMarker = `${config.clientSecret} fixture-access-token payer@example.test`;
  const t = transport(url => authOr(url, { status: 500, body: { message: secretMarker, debug_id: 'private-debug' } }));
  const provider = createSandboxProvider(config, { fetchImpl: t.fetchImpl });
  await assert.rejects(() => provider.getOrder(binding), error => {
    const exposed = `${error.message} ${JSON.stringify(error)}`;
    assert.ok(!exposed.includes(config.clientSecret));
    assert.ok(!exposed.includes('fixture-access-token'));
    assert.ok(!exposed.includes('payer@example.test'));
    return true;
  });
});

test('unsafe redirects and hostile certificate URLs are refused without fetching them', async () => {
  const t = transport(url => authOr(url, { body: order('CREATED') }));
  const provider = createSandboxProvider(config, { fetchImpl: t.fetchImpl });
  await assert.rejects(() => provider.createOrder({ paymentRequestId: binding.paymentRequestId, quote, returnUrl: 'https://attacker.test/', cancelUrl: 'https://enclave.id.vn/' }));
  assert.equal(t.calls.length, 0);
  assert.equal(await provider.verifyWebhook({ headers: { 'paypal-cert-url': 'http://127.0.0.1/private' }, event: { id: 'EVENT1' } }), false);
  assert.equal(t.calls.length, 0);
  const bad = order('CREATED'); bad.links[0].href = 'https://www.sandbox.paypal.com.attacker.test/';
  const unsafe = transport(url => authOr(url, { body: bad }));
  await assert.rejects(() => createSandboxProvider(config, { fetchImpl: unsafe.fetchImpl }).createOrder({ paymentRequestId: binding.paymentRequestId, quote, returnUrl: 'https://enclave.id.vn/', cancelUrl: 'https://enclave.id.vn/' }));
});

test('request timeout bounds a stuck transport and reports a sanitized error', async () => {
  const provider = createSandboxProvider(config, { fetchImpl: () => new Promise(() => {}) });
  const started = Date.now();
  await assert.rejects(() => provider.getOrder(binding), e => e.code === 'PAYPAL_TIMEOUT');
  assert.ok(Date.now() - started < 1500);
});

test('already captured retry queries and revalidates PayPal order instead of crediting blindly', async () => {
  const t = transport(url => authOr(url, url.endsWith('/capture')
    ? { status: 422, body: { details: [{ issue: 'ORDER_ALREADY_CAPTURED' }] } }
    : { body: order() }));
  const result = await createSandboxProvider(config, { fetchImpl: t.fetchImpl }).captureOrder(binding);
  assert.equal(result.status, 'SUCCEEDED');
  assert.ok(t.calls.some(c => c.method === 'GET' && c.url.endsWith('/ORDER123')));
  const forged = order(); forged.purchase_units[0].custom_id = 'other-request';
  const bad = transport(url => authOr(url, url.endsWith('/capture')
    ? { status: 422, body: { details: [{ issue: 'ORDER_ALREADY_CAPTURED' }] } }
    : { body: forged }));
  await assert.rejects(() => createSandboxProvider(config, { fetchImpl: bad.fetchImpl }).captureOrder(binding));
});

test('sparse capture response is queried before trusting success; bad preflight cannot capture', async () => {
  let captured = false;
  const t = transport(url => {
    if (url.endsWith('/v1/oauth2/token')) return authOr(url);
    if (url.endsWith('/capture')) { captured = true; return { body: { id: 'ORDER123', status: 'COMPLETED' } }; }
    const response = order(captured ? 'COMPLETED' : 'APPROVED'); if (!captured) delete response.purchase_units[0].payments;
    return { body: response };
  });
  assert.equal((await createSandboxProvider(config, { fetchImpl: t.fetchImpl }).captureOrder(binding)).status, 'SUCCEEDED');
  assert.equal(t.calls.filter(c => c.url.endsWith('/ORDER123') && c.method === 'GET').length, 2);
  const wrong = order('APPROVED'); wrong.purchase_units[0].custom_id = 'OTHER';
  const bad = transport(url => authOr(url, { body: wrong }));
  await assert.rejects(() => createSandboxProvider(config, { fetchImpl: bad.fetchImpl }).captureOrder(binding));
  assert.equal(bad.calls.filter(c => c.url.endsWith('/capture')).length, 0);
});


test('durable capture hook completes before capture POST transport starts', async () => {
  let posted=false, marked=false;
  const t=transport((url, init)=>{
    if (url.endsWith('/v1/oauth2/token')) return {body:{access_token:'fixture-token',token_type:'Bearer',expires_in:300}};
    if (init.method==='POST' && url.endsWith('/capture')) { assert.equal(marked,true);posted=true;return {body:{id:'ORDER123'}}; }
    const body=order(posted?'COMPLETED':'APPROVED');if(!posted)delete body.purchase_units[0].payments;return {body};
  });
  const p=createSandboxProvider(config,t);
  const result=await p.captureOrder({...binding,beforeCapture:async()=>{assert.equal(posted,false);marked=true;}});
  assert.equal(result.status,'SUCCEEDED');assert.equal(marked,true);assert.equal(posted,true);
});

test('lost durable capture claim aborts before any capture POST', async () => {
  const t=transport(url=>{
    if(url.endsWith('/v1/oauth2/token'))return {body:{access_token:'fixture-token',token_type:'Bearer',expires_in:300}};
    const body=order('APPROVED');delete body.purchase_units[0].payments;return {body};
  });
  const p=createSandboxProvider(config,t);
  await assert.rejects(p.captureOrder({...binding,beforeCapture:async()=>{throw Error('CLAIM_LOST')}}),/CLAIM_LOST/);
  assert.equal(t.calls.filter(c=>c.url.endsWith('/capture')).length,0);
});
