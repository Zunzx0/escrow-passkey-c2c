'use strict';
// SQL + HTTP provider isolation. Only disposable test DBs; no PayPal network.
const assert = require('node:assert/strict');
const path = require('node:path');
if (process.env.APP_ENV !== 'test') throw Error('APP_ENV=test required');
if (process.env.DATABASE_URL) {
  if (!/_test$/.test(new URL(process.env.DATABASE_URL).pathname)) throw Error('Only *_test databases allowed');
} else {
  const dir = path.resolve(__dirname, '../data/test') + path.sep;
  if (!path.resolve(__dirname, '..', process.env.DB_PATH || '').startsWith(dir)) throw Error('DB_PATH must be inside data/test');
}
const { db, uuid, nowIso } = require('../src/db');
const provider = require('../src/lib/mockPaymentProvider');
const { applyProviderResult, claimSubmission, submitToProvider, expireUnsubmitted } = require('../src/lib/paymentService');
const { reconcileOnce } = require('../src/lib/reconciler');
const { flows, api } = require('./helpers/accounts');
let count = 0;
function ok(value, label) { assert.ok(value, label); count++; console.log(`  ✅ ${label}`); }
async function main() {
  const account = await flows.registerUser({ username: 'piso' + Date.now().toString(36), displayName: 'Provider test' });
  const id = uuid(), ref = uuid(), claim = uuid(), key = uuid();
  await db.prepare(`INSERT INTO payment_requests
    (id,user_id,amount,status,provider_ref,provider,client_request_id,submission_status,submit_attempts,submit_claim,submit_claimed_at,created_at,updated_at)
    VALUES (?, ?, 1000, 'PENDING', ?, 'PAYPAL_SANDBOX', ?, 'SUBMIT_FAILED', 5, ?, '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z', ?)`)
    .run(id, account.user.id, ref, key, claim, nowIso());
  const load = () => db.prepare('SELECT * FROM payment_requests WHERE id = ?').get(id);
  const before = await db.prepare('SELECT available_balance FROM wallets WHERE user_id = ?').get(account.user.id);
  const forged = { ...(await load()), provider: 'MOCK' };
  ok(await claimSubmission(forged) === null, 'SQL claim rejects PayPal even with forged MOCK snapshot');
  ok((await submitToProvider(forged, claim)).busy, 'mock submit refuses actual PayPal row before provider call');
  ok((await provider.findPayment(ref)) == null, 'no mock provider payment was created');
  ok((await expireUnsubmitted(forged)).outcome === 'SKIPPED', 'mock expiry refuses PayPal');
  ok((await load()).status === 'PENDING', 'expiry did not close PayPal request');
  let queried = 0;
  const summary = await reconcileOnce({ minAgeSeconds: 0, paymentRequestId: id, onQuery: () => queried++ });
  ok(summary.scanned === 0 && queried === 0, 'mock worker never scans or queries PayPal');
  const result = await applyProviderResult({ paymentRequestId: id, providerRef: ref, status: 'SUCCEEDED', amount: 1000, source: 'WEBHOOK' });
  ok(result.outcome === 'CONFLICT', 'mock settlement rejects matching PayPal ID/ref/amount');
  ok((await load()).status === 'PENDING', 'cross-provider webhook leaves request pending');
  const after = await db.prepare('SELECT available_balance FROM wallets WHERE user_id = ?').get(account.user.id);
  ok(after.available_balance === before.available_balance, 'cross-provider result never changes wallet');
  const entries = await db.prepare("SELECT COUNT(*) AS n FROM wallet_entries WHERE request_id = ? AND entry_type = 'TOPUP_CREDIT'").get(id);
  ok(Number(entries.n) === 0, 'cross-provider result has no ledger credit');
  await assert.rejects(() => applyProviderResult({ paymentRequestId: id, providerRef: ref, status: 'SUCCEEDED', amount: 1000, source: 'WEBHOOK' }, { expectedProvider: 'PAYPAL_SANDBOX' }), e => e.code === 'PAYPAL_INTEGRATION_NOT_READY');
  ok(true, 'PayPal settlement stays disabled until capture integration is approved');
  await provider.submitPayment({ providerRef: ref, merchantRef: id, amount: 1000 });
  const checkout = await api('/mock-provider/checkout/' + ref, { token: account.token });
  ok(checkout.status === 404, 'mock checkout rejects same-owner PayPal request');
  const replay = await api('/api/payments/topup', { method: 'POST', token: account.token, body: { amount: 1000, requestId: key } });
  ok(replay.status === 409, 'mock topup replay rejects PayPal request key');
  await db.prepare("UPDATE payment_requests SET status = 'FAILED' WHERE id = ?").run(id);
  const duplicate = await applyProviderResult({ paymentRequestId: id, providerRef: ref, status: 'FAILED', amount: 1000, source: 'WEBHOOK' });
  ok(duplicate.outcome === 'CONFLICT', 'provider is checked before terminal duplicate acceptance');
  await assert.rejects(() => db.prepare("UPDATE payment_requests SET provider = 'MOCK' WHERE id = ?").run(id));
  ok(true, 'DB trigger rejects changing provider');
  ok((await load()).provider === 'PAYPAL_SANDBOX', 'provider remains unchanged after rejected update');
  await db.prepare('DELETE FROM payment_requests WHERE id = ?').run(id);
  console.log(`\nProvider isolation: ${count} checks passed`);
}
main().catch(e => { console.error(e.stack); process.exitCode = 1; }).finally(async () => { if (db.close) await db.close(); });
