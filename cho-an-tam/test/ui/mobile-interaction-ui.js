// DOM regression for mobile focus, asynchronous validation and modal scrolling.
// Uses the real application with fake fetch. This is not an iOS/WebKit zoom test:
// JSDOM has no virtual keyboard, visual viewport, touch gestures or layout engine.
const assert = require('node:assert/strict');
const { wallet, json, sleep, logoutUi } = require('./paypal-wallet-ui');

const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1';
let checks = 0;
let failures = 0;
function ok(condition, message) {
  checks++;
  console.log((condition ? 'PASS ' : 'FAIL ') + message);
  if (!condition) failures++;
}
async function click(p, action, wait = 35) {
  const el = p.d.querySelector('[data-act="' + action + '"]');
  assert.ok(el, 'missing action ' + action);
  p.click(el);
  await sleep(wait);
}
function edit(p, input, value) {
  input.value = value;
  input.dispatchEvent(new p.w.Event('input', { bubbles: true }));
}
function describedError(p, input) {
  return (input.getAttribute('aria-describedby') || '').split(/\s+/)
    .map(id => p.d.getElementById(id))
    .filter(node => node && !node.hidden && node.getAttribute('aria-hidden') !== 'true')
    .map(node => node.textContent.trim()).filter(Boolean).join(' ');
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function page() {
  const p = await wallet({ hash: '#/', timeoutMs: 3000 });
  await logoutUi(p);
  Object.defineProperty(p.w.navigator, 'userAgent', { value: iphone, configurable: true });
  p.w.matchMedia = media => ({ matches: media === '(any-pointer: coarse)', media });
  p.validityReports = [];
  // JSDOM normally only returns a boolean. Browser interactive validation can
  // focus an invalid field, which was the source of the focus-stealing defect.
  p.w.HTMLInputElement.prototype.reportValidity = function () {
    const valid = this.checkValidity();
    p.validityReports.push({ input: this, valid, connected: this.isConnected });
    if (!valid) this.focus();
    return valid;
  };
  await click(p, 'open-auth-register');
  return p;
}
async function scenario(name, fn) {
  console.log('\n' + name);
  let p;
  try { p = await page(); await fn(p); }
  catch (error) { failures++; console.error('FAIL scenario: ' + error.stack); }
  finally { if (p) p.close(); }
}

async function main() {
  await scenario('Invalid email on blur must not steal focus', async p => {
    const input = p.d.getElementById('regEmail');
    const next = p.d.getElementById('regDisplayName');
    input.focus(); edit(p, input, 'a@'); next.focus(); await sleep(35);
    ok(p.validityReports.length === 0, 'blur does not invoke native interactive validity reporting');
    ok(p.d.activeElement === next, 'invalid email leaves focus on the field selected by the user');
    ok(input.getAttribute('aria-invalid') === 'true' && describedError(p, input).length > 0,
      'email error is visible inline and linked to its field for assistive technology');
    edit(p, input, 'valid@example.test');
    ok(input.getAttribute('aria-invalid') !== 'true' && input.checkValidity(),
      'editing an invalid email clears the stale error and permits a valid value');
    input.focus(); next.focus(); await sleep(20);
    ok(input.getAttribute('aria-invalid') !== 'true' && p.d.activeElement === next,
      'a corrected email remains valid when the user moves on');
  });

  await scenario('Invalid username syntax is an inline error', async p => {
    const input = p.d.getElementById('regUsername');
    const next = p.d.getElementById('regDisplayName');
    input.focus(); edit(p, input, '__'); next.focus(); await sleep(25);
    ok(p.count('GET /api/passkeys/username-availability') === 0,
      'syntactically invalid username does not query availability');
    ok(!input.checkValidity() && input.getAttribute('aria-invalid') === 'true' && describedError(p, input).length > 0,
      'invalid username has an accessible inline error');
    ok(p.validityReports.length === 0 && p.d.activeElement === next,
      'username syntax validation neither reports a native popup nor changes focus');
    edit(p, input, 'valid_person');
    ok(input.checkValidity() && input.getAttribute('aria-invalid') !== 'true',
      'editing the username clears its custom validation error');
  });

  await scenario('Delayed username rejection must not focus its old field', async p => {
    const gate = deferred();
    p.routes['GET /api/passkeys/username-availability'] = () => gate.promise;
    const input = p.d.getElementById('regUsername');
    const next = p.d.getElementById('regDisplayName');
    input.focus(); edit(p, input, 'taken_person'); next.focus(); await sleep(20);
    ok(p.count('GET /api/passkeys/username-availability') === 1, 'availability request is genuinely pending');
    gate.resolve(json(200, { available: false })); await sleep(35);
    ok(!input.checkValidity() && input.getAttribute('aria-invalid') === 'true' && describedError(p, input).length > 0,
      'a current availability rejection produces an accessible inline error');
    ok(p.validityReports.length === 0 && p.d.activeElement === next,
      'delayed rejection leaves the user in the field they selected');
  });

  await scenario('Delayed username response after edit must be ignored', async p => {
    const gate = deferred();
    p.routes['GET /api/passkeys/username-availability'] = () => gate.promise;
    const input = p.d.getElementById('regUsername');
    const next = p.d.getElementById('regDisplayName');
    input.focus(); edit(p, input, 'old_person'); next.focus(); await sleep(20);
    ok(p.count('GET /api/passkeys/username-availability') === 1, 'old username request starts before editing');
    edit(p, input, 'new_person');
    gate.resolve(json(200, { available: false })); await sleep(30);
    ok(input.value === 'new_person' && input.checkValidity() && input.getAttribute('aria-invalid') !== 'true',
      'response for a different value does not invalidate the edited username');
    ok(p.validityReports.length === 0 && p.d.activeElement === next,
      'stale availability response does not call reportValidity or move focus');
  });

  await scenario('A to B to A editing invalidates the original request', async p => {
    const gate = deferred();
    p.routes['GET /api/passkeys/username-availability'] = () => gate.promise;
    const input = p.d.getElementById('regUsername');
    const next = p.d.getElementById('regDisplayName');
    input.focus(); edit(p, input, 'original_person'); next.focus(); await sleep(20);
    ok(p.count('GET /api/passkeys/username-availability') === 1, 'original request predates the edit sequence');
    edit(p, input, 'another_person'); edit(p, input, 'original_person');
    gate.resolve(json(200, { available: false })); await sleep(30);
    ok(input.checkValidity() && input.getAttribute('aria-invalid') !== 'true',
      'matching text after two edits does not revive a superseded availability response');
    ok(p.validityReports.length === 0 && p.d.activeElement === next,
      'superseded response never activates interactive validation');
  });

  for (const replacement of ['tab', 'close']) {
    await scenario('Late response after ' + replacement + ' must not affect detached controls', async p => {
      const gate = deferred();
      p.routes['GET /api/passkeys/username-availability'] = () => gate.promise;
      const oldInput = p.d.getElementById('regUsername');
      oldInput.focus(); edit(p, oldInput, 'detached_person');
      p.d.getElementById('regDisplayName').focus(); await sleep(20);
      ok(p.count('GET /api/passkeys/username-availability') === 1, 'pending request exists before ' + replacement);
      if (replacement === 'tab') {
        const loginTab = p.d.querySelector('[data-act="auth-tab"][data-tab="login"]');
        p.click(loginTab); await sleep(20);
        p.d.getElementById('loginUsername').focus();
      } else {
        await click(p, 'modal-close');
        p.d.getElementById('topSearchInput').focus();
      }
      const expectedFocus = p.d.activeElement;
      ok(!oldInput.isConnected, 'original username control has actually been detached');
      gate.resolve(json(200, { available: false })); await sleep(35);
      ok(p.validityReports.length === 0 && oldInput.checkValidity(),
        'late response neither mutates nor reports validity on the detached username');
      ok(p.d.activeElement === expectedFocus && !p.d.querySelector('#regUsername[aria-invalid="true"]'),
        'late response keeps the current page and focus intact');
    });
  }

  await scenario('Submit still performs native invalid reporting and blocks registration', async p => {
    const email = p.d.getElementById('regEmail');
    edit(p, email, 'a@');
    edit(p, p.d.getElementById('regUsername'), 'valid_person');
    edit(p, p.d.getElementById('regDisplayName'), 'Mobile Test');
    edit(p, p.d.getElementById('regPassword'), 'MatKhau-Test-2026!');
    await click(p, 'do-register');
    ok(p.validityReports.some(report => report.input === email && !report.valid),
      'explicit submit invokes native reporting for the invalid email');
    ok(p.count('POST /api/passkeys/register/account') === 0 && p.d.activeElement === email,
      'invalid submit focuses the offending field and never sends registration');
  });

  await scenario('Modal replacement keeps scroll locked and final close restores page state', async p => {
    await click(p, 'modal-close');
    const body = p.d.body;
    const html = p.d.documentElement;
    const original = { position: 'relative', top: '7px', left: '3px', right: '4px', width: '92%', overflow: 'auto' };
    Object.assign(body.style, original);
    html.style.overflow = 'scroll';
    let scrollX = 12, scrollY = 420;
    const moves = [];
    Object.defineProperty(p.w, 'scrollX', { get: () => scrollX, configurable: true });
    Object.defineProperty(p.w, 'scrollY', { get: () => scrollY, configurable: true });
    p.w.scrollTo = (x, y) => {
      const target = typeof x === 'object' ? { x: x.left ?? scrollX, y: x.top ?? scrollY } : { x, y };
      moves.push(target); scrollX = target.x; scrollY = target.y;
    };
    await click(p, 'open-auth-register');
    ok(body.style.position === 'fixed' && body.style.top === '-420px' && html.style.overflow === 'hidden',
      'opening a modal fixes the body at the saved scroll offset and locks the root');
    const lockedStyle = body.style.cssText;
    await click(p, 'auth-terms');
    ok(p.d.getElementById('modalTitle').textContent.includes('Điều khoản'), 'terms actually replaces the registration modal');
    ok(body.style.cssText === lockedStyle && html.style.overflow === 'hidden' && moves.length === 0,
      'modal to modal replacement keeps the same lock without a transient scroll restoration');
    p.d.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await sleep(25);
    ok(!p.d.querySelector('#modalRoot .modal') && Object.entries(original).every(([key, value]) => body.style[key] === value) && html.style.overflow === 'scroll',
      'final close restores every existing body/root style and removes the dialog');
    ok(moves.length === 1 && moves[0].x === 12 && moves[0].y === 420,
      'final close restores the original horizontal and vertical position exactly once');
  });

  console.log('\nMOBILE INTERACTION UI: ' + checks + ' checks, ' + failures + ' failures');
  if (failures) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
