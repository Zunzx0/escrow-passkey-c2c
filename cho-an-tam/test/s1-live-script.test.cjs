'use strict';
// Tool regression with synthetic data; no network or operating-system clipboard access.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { run } = require('../scripts/experiments/S1-Enclave.cjs');
const { decode, readClipboard, clearMatchingClipboard } = require('../scripts/experiments/s1-live-client.cjs');
const ID = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'synthetic.session.signature';
const packet = fields => 'ENCLAVE-S1:' + Buffer.from(JSON.stringify({
  version: 'ENCLAVE-S1-1', apiOrigin: 'https://api.enclave.id.vn', webOrigin: 'https://enclave.id.vn',
  transactionId: ID, accessToken: TOKEN, expiresAt: new Date(Date.now() + 120000).toISOString(), ...fields,
})).toString('base64');

function backend(mode = {}) {
  const calls = []; let attempted = false;
  const transport = async (token, route, body) => {
    assert.equal(token, TOKEN); calls.push({ route, body });
    const ok = data => ({ status: 200, data });
    if (mode.badSession) return { status: 401, data: { error: 'UNAUTHENTICATED' } };
    if (route === '/users/me') return ok({ user: { id: 'buyer' } });
    if (body !== undefined) {
      assert.equal(route, `/transactions/${ID}/release`);
      assert.match(body.requestId, /^[a-f0-9-]{36}$/);
      assert.equal(body.reauthGrant, 'S1_NO_VALID_PASSKEY_GRANT');
      attempted = true;
      return { status: mode.status ?? 401, data: { error: mode.error ?? 'REAUTH_REQUIRED' } };
    }
    if (route === '/wallets/me') return ok({ id: 'buyer-wallet', availableBalance: attempted && mode.walletChanged ? 899999 : 900000, lockedBalance: 0, version: 2 });
    if (route.endsWith('/logs')) return ok({ logs: attempted && mode.released ? [{ action: 'ESCROW_RELEASED' }] : [] });
    if (attempted && mode.afterReadFails) return { status: 503, data: { error: 'SERVICE_UNAVAILABLE' } };
    assert.equal(route, `/transactions/${ID}`);
    return ok({ id: ID, buyerId: mode.otherBuyer ? 'other' : 'buyer', sellerId: 'seller', amount: 100000,
      status: (attempted && mode.released) || mode.alreadyCompleted ? 'COMPLETED' : 'WAIT_CONFIRM',
      escrowStatus: attempted && mode.released ? 'RELEASED' : 'LOCKED', version: 5,
      inspectedAt: mode.notInspected ? null : 'synthetic-inspected', integrityHold: mode.hold ? {} : null });
  };
  return { calls, transport };
}

test('A valid copied session reaches RELEASE; blocked verdict requires unchanged data', async () => {
  const fake = backend(), result = await run(packet(), fake.transport);
  assert.equal(result.complete, true); assert.equal(result.unchanged, true);
  assert.equal(result.attempt.status, 401); assert.equal(result.attempt.error, 'REAUTH_REQUIRED');
  assert.equal(fake.calls.filter(c => c.body !== undefined).length, 1);
  assert.equal(result.httpTrace.filter(c => c.route === '/wallets/me').length, 2);
  assert.equal(result.ownerPasskeyPositiveControl, false);
  for (const secret of [TOKEN, 'S1_NO_VALID_PASSKEY_GRANT']) assert.equal(JSON.stringify(result).includes(secret), false);
});

test('Expired, wrong-domain, S2 and grant-bearing packets cannot reach transport', async () => {
  for (const fields of [{ expiresAt: new Date(Date.now() - 1000).toISOString() }, { expiresAt: 'invalid' },
    { apiOrigin: 'https://other.test' }, { webOrigin: 'http://enclave.id.vn' }, { transactionId: '../other' },
    { reauthGrant: 'synthetic-secret' }, { version: 'ENCLAVE-S2-1' }, { accessToken: 'not-a-token' }]) {
    const fake = backend(); await assert.rejects(run(packet(fields), fake.transport)); assert.equal(fake.calls.length, 0);
  }
  assert.throws(() => decode('ENCLAVE-S2:abc')); assert.throws(() => decode('not a packet'));
});

test('An expired server-side session is not a successful S1 result', async () => {
  const fake = backend({ badSession: true });
  await assert.rejects(run(packet(), fake.transport), /UNAUTHENTICATED/);
  assert.equal(fake.calls.length, 1);
});

for (const mode of [{ otherBuyer: true }, { notInspected: true }, { hold: true }, { alreadyCompleted: true }]) {
  test('Wrong owner or ineligible order stops before RELEASE: ' + JSON.stringify(mode), async () => {
    const fake = backend(mode); await assert.rejects(run(packet(), fake.transport));
    assert.equal(fake.calls.some(c => c.body !== undefined), false);
  });
}

for (const mode of [{ status: 400, error: 'VALIDATION_ERROR' }, { status: 401, error: 'UNAUTHENTICATED' },
  { status: 403, error: 'FORBIDDEN' }, { status: 404, error: 'NOT_FOUND' },
  { status: 200, error: '' }, { walletChanged: true }, { released: true }]) {
  test('Unexpected HTTP result or changed money is recorded as unsuccessful: ' + JSON.stringify(mode), async () => {
    const fake = backend(mode), result = await run(packet(), fake.transport);
    assert.equal(result.complete, false);
    assert.equal(fake.calls.filter(c => c.route.endsWith('/logs')).length, 2, 'Still reads after rejection/acceptance.');
    assert.equal(fake.calls.filter(c => c.body !== undefined).length, 1, 'Never retries RELEASE.');
  });
}

test('An interrupted after-snapshot cannot become a successful result', async () => {
  const fake = backend({ afterReadFails: true }); await assert.rejects(run(packet(), fake.transport), /503/);
  assert.equal(fake.calls.filter(c => c.body !== undefined).length, 1);
});

test('Clipboard reader is bounded and never places the session in process arguments', () => {
  const text = packet(), calls = [];
  const executor = (exe, args, options) => { calls.push({ exe, args, options }); return text + '\r\n'; };
  assert.equal(readClipboard(executor), text); clearMatchingClipboard(text, executor);
  assert.equal(calls.length, 2); assert.ok(calls[0].exe.endsWith('powershell.exe'));
  assert.ok(calls[0].args.includes('-NoProfile')); assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.timeout, 5000); assert.equal(calls[0].options.maxBuffer, 32768);
  assert.equal(calls[0].options.env.DATABASE_URL, undefined);
  for (const call of calls) assert.equal(JSON.stringify(call.args).includes(text), false);
  assert.match(calls[1].args.at(-1), /if\(\$s -eq '[a-f0-9]{64}'\)/);
});
