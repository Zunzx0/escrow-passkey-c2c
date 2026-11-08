'use strict';
// DOM and synthetic API only; no real clipboard, account or Passkey operation.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { test } = require('node:test'), { JSDOM } = require('jsdom');
const ROOT = path.join(__dirname, '../../public/experiments');
const ID = '11111111-1111-4111-8111-111111111111';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let i = 0; i < 100; i++) { if (fn()) return; await sleep(5); } throw new Error('UI did not settle.'); }
function page(mode = {}) {
  const origin = mode.origin || 'https://enclave.id.vn';
  const dom = new JSDOM(fs.readFileSync(path.join(ROOT, 's1.html'), 'utf8'), { url: origin + '/experiments/s1.html', runScripts: 'outside-only' });
  const w = dom.window, calls = [], copies = [];
  const exp = Math.floor(Date.now() / 1000) + (mode.expired ? -60 : 900);
  const token = 'fixture.' + Buffer.from(JSON.stringify({ exp })).toString('base64url') + '.signature';
  Object.defineProperty(w, 'isSecureContext', { value: true });
  w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder; w.AbortSignal = AbortSignal;
  Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: async text => { copies.push(text); } } });
  Object.defineProperty(w.navigator, 'credentials', { value: { get() { throw new Error('S1 preparation must not request Passkey.'); } } });
  w.fetch = async (url, options) => {
    assert.equal(new URL(url).origin, 'https://api.enclave.id.vn'); assert.equal(options.credentials, 'include');
    const route = new URL(url).pathname; calls.push({ route, options });
    assert.ok(!/\/(release|secure|refund|options|verify)$/.test(route), 'Preparation must only refresh/read.');
    const reply = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
    if (route.endsWith('/session/refresh')) return mode.badSession ? reply({ error: 'SESSION_EXPIRED' }, 401) : reply({ token, user: { id: 'buyer' } });
    if (route === '/api/users/me') return reply({ user: { id: 'buyer', displayName: 'Người mua tổng hợp' } });
    return reply({ id: ID, buyerId: mode.otherBuyer ? 'other' : 'buyer', amount: 100000, sellerName: 'Người bán tổng hợp',
      itemName: 'Sản phẩm tổng hợp', status: mode.completed ? 'COMPLETED' : 'WAIT_CONFIRM', escrowStatus: 'LOCKED',
      inspectedAt: mode.notInspected ? null : 'fixture-inspected', canBuyerRelease: !mode.cannotRelease, integrityHold: mode.hold ? {} : null });
  };
  if (mode.signedOut) w.localStorage.setItem('cat_signed_out', '1');
  w.eval(fs.readFileSync(path.join(ROOT, 's1.js'), 'utf8'));
  return { w, calls, copies, token, exp, $: id => w.document.getElementById(id), close: () => w.close() };
}
async function select(p) {
  p.$('order-a').value = 'https://enclave.id.vn/#/tx/' + ID;
  p.$('orders').dispatchEvent(new p.w.Event('submit', { cancelable: true }));
  await until(() => !p.$('check').disabled);
}

test('S1 exports only the current session and order, after explicit consent and copy', async () => {
  const p = page(); try {
    await select(p); assert.equal(p.$('details').hidden, false); assert.equal(p.$('copy').disabled, true); assert.equal(p.copies.length, 0);
    p.$('consent').checked = true; p.$('consent').dispatchEvent(new p.w.Event('change')); p.$('copy').click();
    await until(() => p.copies.length === 1);
    const data = JSON.parse(Buffer.from(p.copies[0].slice(11), 'base64').toString('utf8'));
    assert.deepEqual(Object.keys(data).sort(), ['accessToken', 'apiOrigin', 'expiresAt', 'transactionId', 'version', 'webOrigin']);
    assert.equal(data.version, 'ENCLAVE-S1-1'); assert.equal(data.accessToken, p.token); assert.equal(data.transactionId, ID);
    assert.equal(Date.parse(data.expiresAt), p.exp * 1000);
    assert.equal(p.w.document.body.textContent.includes(p.token), false);
    assert.equal(p.w.localStorage.length, 0); assert.equal(p.w.sessionStorage.length, 0);
    assert.equal(p.$('back').getAttribute('href'), '/#/tx/' + ID);
    assert.equal(p.calls.length, 3);
  } finally { p.close(); }
});

test('Wrong page origin cannot refresh the session', () => {
  const p = page({ origin: 'https://preview.example' }); try { assert.equal(p.$('check').disabled, true); assert.equal(p.calls.length, 0); } finally { p.close(); }
});

for (const mode of [{ badSession: true }, { otherBuyer: true }, { expired: true }, { completed: true },
  { notInspected: true }, { cannotRelease: true }, { hold: true }, { signedOut: true }]) {
  test('Ineligible session/order cannot export: ' + JSON.stringify(mode), async () => {
    const p = page(mode); try {
      await select(p); assert.equal(p.$('details').hidden, true); assert.equal(p.$('copy').disabled, true); assert.equal(p.copies.length, 0);
    } finally { p.close(); }
  });
}

test('Editing the selected order or leaving the page invalidates the export', async () => {
  for (const event of ['input', 'pagehide']) {
    const p = page(); try {
      await select(p); p.$('consent').checked = true; p.$('consent').dispatchEvent(new p.w.Event('change'));
      assert.equal(p.$('copy').disabled, false);
      if (event === 'input') p.$('order-a').dispatchEvent(new p.w.Event('input')); else p.w.dispatchEvent(new p.w.Event('pagehide'));
      assert.equal(p.$('details').hidden, true);
      p.$('copy').click(); await until(() => !p.$('check').disabled);
      assert.equal(p.copies.length, 0);
    } finally { p.close(); }
  }
});
