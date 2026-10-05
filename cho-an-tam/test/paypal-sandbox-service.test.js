'use strict';

// Contract tests with an injected in-memory store/atomic sink, not SQL concurrency proof.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const servicePath = process.env.PAYPAL_SERVICE_MODULE || path.join(__dirname, '../src/lib/paypalSandboxService.js');
const providerPath = process.env.PAYPAL_PROVIDER_MODULE || path.join(__dirname, '../src/lib/paypalSandboxProvider.js');
const { createSandboxPaymentService } = require(servicePath);
const { createQuote } = require(providerPath);

function harness(changes = {}, options = {}) {
  const row = { provider: 'PAYPAL_SANDBOX', paymentRequestId: 'request-1', userId: 'buyer-1', providerRef: 'ref-1', amountVnd: 100000, quote: createQuote(100000, 25000), orderId: 'ORDER1', status: 'PENDING', ...changes };
  const calls = { create: 0, capture: 0, query: 0, settle: [], credits: 0, balance: 0 };
  const result = { orderId: 'ORDER1', paymentRequestId: 'request-1', amount: 100000, status: 'SUCCEEDED', captureId: 'CAPTURE1', approvalUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER1' };
  let signatureValid = true; let settled = row.status === 'SUCCEEDED';
  const provider = {
    async createOrder() { calls.create++; return structuredClone(result); },
    async captureOrder() { calls.capture++; return structuredClone(result); },
    async getOrder() { calls.query++; return structuredClone(result); },
    async verifyWebhook() { return signatureValid; },
  };
  const store = {
    async loadByRequestId(id) { return id === row.paymentRequestId ? structuredClone(row) : null; },
    async loadByOrderId(id) { return id === row.orderId ? structuredClone(row) : null; },
    async bindOrder(id, orderId) { if (id !== row.paymentRequestId || row.orderId && row.orderId !== orderId) return false; row.orderId = orderId; return true; },
    async claimCreateAttempt(id, nowIso) { if (id !== row.paymentRequestId) return null; if (!row.createAttemptAt) row.createAttemptAt = nowIso; return structuredClone(row); },
  };
  const settle = async payload => {
    calls.settle.push(payload);
    // No await before claim: this is a model of the required atomic SQL claim only.
    if (settled) return { status: 'SUCCEEDED', outcome: 'DUPLICATE' };
    settled = true; calls.credits++; calls.balance += payload.amount;
    return { status: 'SUCCEEDED', outcome: 'APPLIED' };
  };
  const service = createSandboxPaymentService({ provider, store, settle, returnUrl: 'https://enclave.id.vn/', cancelUrl: 'https://enclave.id.vn/', ...options });
  const event = { id: 'EVENT1', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'CAPTURE1', supplementary_data: { related_ids: { order_id: 'ORDER1' } } } };
  return { row, calls, result, provider, store, service, event, denySignature: () => { signatureValid = false; } };
}
const owner = { paymentRequestId: 'request-1', userId: 'buyer-1' };

test('wrong owner cannot create or capture another account payment', async () => {
  const h = harness();
  for (const method of ['createOrder', 'capture']) await assert.rejects(() => h.service[method]({ ...owner, userId: 'attacker' }), e => e.code === 'FORBIDDEN');
  assert.equal(h.calls.create + h.calls.capture + h.calls.settle.length, 0);
});

test('server-stored quote and provider binding are mandatory before any network or credit', async () => {
  for (const changes of [{ quote: null }, { provider: 'MOCK' }, { amountVnd: 200000 }, { providerRef: '' }, { userId: '' }]) {
    const h = harness(changes);
    await assert.rejects(() => h.service.capture(owner));
    assert.equal(h.calls.capture + h.calls.settle.length, 0);
  }
  const missing = harness();
  await assert.rejects(() => missing.service.capture({ ...owner, paymentRequestId: 'not-stored' }), e => e.code === 'PAYMENT_REQUEST_NOT_FOUND');
  assert.equal(missing.calls.capture, 0);
});

test('creation persists binding and never credits wallet even if provider reports completion', async () => {
  const h = harness({ orderId: null });
  await h.service.createOrder(owner);
  assert.equal(h.row.orderId, 'ORDER1');
  assert.equal(h.calls.credits, 0);
  const bad = harness(); bad.result.orderId = 'OTHER';
  await assert.rejects(() => bad.service.createOrder(owner));
  assert.equal(bad.calls.credits, 0);
});

test('pending and forged normalized provider results cannot reach settlement', async () => {
  const pending = harness(); pending.result.status = 'PENDING';
  assert.equal((await pending.service.capture(owner)).outcome, 'STILL_PENDING');
  assert.equal(pending.calls.credits, 0);
  for (const field of [{ amount: 200000 }, { paymentRequestId: 'other' }, { orderId: 'OTHER' }, { captureId: null }, { status: 'FAILED' }]) {
    const h = harness(); Object.assign(h.result, field);
    await assert.rejects(() => h.service.capture(owner));
    assert.equal(h.calls.credits, 0);
  }
});

test('capture plus duplicate webhook/reconciler uses one injected atomic credit sink', async () => {
  const h = harness();
  const results = await Promise.all([
    h.service.capture(owner), h.service.capture(owner),
    h.service.webhook({ headers: {}, event: h.event }), h.service.webhook({ headers: {}, event: h.event }),
    h.service.reconcile({ paymentRequestId: owner.paymentRequestId }),
  ]);
  assert.equal(results.filter(r => r.outcome === 'APPLIED').length, 1);
  assert.equal(results.filter(r => r.outcome === 'DUPLICATE').length, 4);
  assert.equal(h.calls.credits, 1); assert.equal(h.calls.balance, 100000);
  assert.ok(h.calls.settle.every(r => r.paymentRequestId === 'request-1' && r.providerRef === 'ref-1' && r.amount === 100000 && r.status === 'SUCCEEDED'));
  assert.ok(h.calls.settle.some(r => r.source === 'WEBHOOK'));
});

test('unverified webhook and unrelated verified event never settle', async () => {
  const invalid = harness(); invalid.denySignature();
  await assert.rejects(() => invalid.service.webhook({ headers: {}, event: invalid.event }), e => e.code === 'INVALID_SIGNATURE');
  assert.equal(invalid.calls.query + invalid.calls.credits, 0);
  const unrelated = harness(); unrelated.event.event_type = 'CHECKOUT.ORDER.APPROVED';
  assert.equal((await unrelated.service.webhook({ headers: {}, event: unrelated.event })).ignored, true);
  assert.equal(unrelated.calls.query + unrelated.calls.credits, 0);
});

test('signed webhook still requires stored order, authoritative query and matching capture', async () => {
  const wrong = harness(); wrong.event.resource.id = 'OTHER-CAPTURE';
  await assert.rejects(() => wrong.service.webhook({ headers: {}, event: wrong.event }));
  assert.equal(wrong.calls.query, 1); assert.equal(wrong.calls.credits, 0);
  const unknown = harness(); unknown.event.resource.supplementary_data.related_ids.order_id = 'UNBOUND';
  await assert.rejects(() => unknown.service.webhook({ headers: {}, event: unknown.event }));
  assert.equal(unknown.calls.query + unknown.calls.credits, 0);
});

test('expired unbound create attempt cannot renew idempotency window or create another PayPal order', async () => {
  const now = Date.parse('2026-10-05T01:00:00Z');
  const first = new Date(now - 300000).toISOString();
  const h = harness({ orderId: null, createAttemptAt: first }, { now: () => now });
  for (let i = 0; i < 2; i++) await assert.rejects(() => h.service.createOrder(owner), e => e.code === 'PAYPAL_CREATE_RECOVERY_REQUIRED');
  assert.equal(h.row.createAttemptAt, first);
  assert.equal(h.calls.create + h.calls.query + h.calls.credits, 0);
});

test('bound create replay recovers same approval URL after retention without issuing create', async () => {
  const h = harness({ createAttemptAt: '2025-01-01T00:00:00Z' }, { now: () => Date.parse('2026-10-05T01:00:00Z') });
  const result = await h.service.createOrder(owner);
  assert.equal(result.orderId, 'ORDER1');
  assert.equal(result.approvalUrl, h.result.approvalUrl);
  assert.equal(h.calls.query, 1); assert.equal(h.calls.create + h.calls.credits, 0);
});

test('failed first create keeps original durable timestamp for subsequent retry', async () => {
  const now = Date.parse('2026-10-05T01:00:00Z');
  const h = harness({ orderId: null }, { now: () => now });
  h.provider.createOrder = async () => { throw new Error('ambiguous create response'); };
  await assert.rejects(() => h.service.createOrder(owner));
  const first = h.row.createAttemptAt;
  await assert.rejects(() => h.service.createOrder(owner));
  assert.equal(first, new Date(now).toISOString());
  assert.equal(h.row.createAttemptAt, first); assert.equal(h.calls.credits, 0);
});

test('closed local payment cannot initiate creation or capture before any provider call', async () => {
  for (const orderId of [null, 'ORDER1']) {
    const h = harness({ status: 'FAILED', orderId });
    for (const method of ['createOrder', 'capture']) await assert.rejects(() => h.service[method](owner), e => e.code === 'PAYPAL_PAYMENT_CLOSED');
    assert.equal(h.calls.create + h.calls.capture + h.calls.query + h.calls.credits, 0);
  }
  const missing = harness({ status: undefined });
  await assert.rejects(() => missing.service.capture(owner));
  assert.equal(missing.calls.capture, 0);
});

test('already settled request recovers with GET and duplicate sink without new money-taking operation', async () => {
  const h = harness({ status: 'SUCCEEDED' });
  const created = await h.service.createOrder(owner);
  const captured = await h.service.capture(owner);
  assert.equal(created.orderId, 'ORDER1');
  assert.equal(captured.outcome, 'DUPLICATE');
  assert.equal(h.calls.query, 2); assert.equal(h.calls.create + h.calls.capture + h.calls.credits, 0);
  const corrupt = harness({ status: 'SUCCEEDED', orderId: null });
  await assert.rejects(() => corrupt.service.capture(owner));
  assert.equal(corrupt.calls.query + corrupt.calls.capture, 0);
});

test('create claim rechecks a request closed during the atomic claim', async () => {
  const h = harness({ orderId: null });
  h.store.claimCreateAttempt = async () => ({ ...h.row, status: 'FAILED', createAttemptAt: new Date().toISOString() });
  await assert.rejects(() => h.service.createOrder(owner), e => e.code === 'PAYPAL_PAYMENT_CLOSED');
  assert.equal(h.calls.create + h.calls.query + h.calls.credits, 0);
});
