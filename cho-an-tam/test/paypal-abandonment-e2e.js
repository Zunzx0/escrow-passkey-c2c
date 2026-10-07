'use strict';
// F-03 — POST /api/payments/paypal/:id/abandon: chủ ví chủ động bỏ ý định nạp PayPal chưa thu tiền.
// Fixture: router, runtime, store, settlement THẬT; provider = adapter Sandbox THẬT nói chuyện với một transport giả
// (fake PayPal bền vững + lớp bọc đếm lệnh, chèn lỗi theo order, barrier). KHÔNG chạm mạng, KHÔNG PayPal thật.
// Chạy (test tự reset DB riêng, KHÔNG nằm trong suite chung):
//   SQLite:     APP_ENV=test DB_PATH=data/test/paypal-abandon.db node test/paypal-abandonment-e2e.js
//   PostgreSQL: APP_ENV=test DATABASE_URL=postgresql://postgres@127.0.0.1:55432/enclave_pro_abandon_test?sslmode=disable node test/paypal-abandonment-e2e.js
// Hạn mức nạp theo mặc định sản phẩm (5 PENDING) được GIỮ NGUYÊN trong test này để ca quota là thật.
process.env.TOPUP_MAX_PENDING = '5';
const H = require('./helpers/paypal-m2-harness');
const { statePath } = H.init('abandonment');
H.resetFake(statePath);

const crypto = require('crypto');
const express = require('express');
const { createDurableFake, SANDBOX } = require('./helpers/paypal-m2-fake');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function defer() { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
async function until(fn, label, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await sleep(15); }
  return false;
}
const resp = (status, payload) => { const text = JSON.stringify(payload); return { ok: status >= 200 && status < 300, status, text: async () => text, headers: { get: () => null } }; };

async function main() {
  const { db, uuid, nowIso } = require('../src/db');
  const { createSandboxProvider } = require('../src/lib/paypalSandboxProvider');
  const runtimeModule = require('../src/lib/paypalRuntime');
  const { createPayPalRuntime } = runtimeModule;
  const { createPayPalRouter } = require('../src/routes/paypal');
  const rateLimit = require('../src/lib/rateLimit');
  const { withTriggerDisabled } = require('./helpers/paypal-m2-db');

  const t = H.tally('F-03 abandon');
  const results = {};
  let cur = null;
  function section(id, title) { cur = { id, title, pass: 0, fail: 0, fails: [] }; results[id] = cur; t.section(`${id} — ${title}`); }
  function ok(cond, label, detail) { t.ok(cond, label, detail); if (cond) cur.pass++; else { cur.fail++; cur.fails.push(label); } }
  const eq = (a, b, label) => ok(JSON.stringify(a) === JSON.stringify(b), label, `nhận ${JSON.stringify(a)}, kỳ vọng ${JSON.stringify(b)}`);
  const info = (label) => console.log(`  ℹ ${label}`);
  async function runCase(id, title, fn) {
    section(id, title);
    try { await fn(); } catch (e) { ok(false, `ngoại lệ không bắt được: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`); }
  }

  // ------------------------------------------------------------------ transport giả có đếm, chèn lỗi, barrier
  const fake = createDurableFake({ statePath });
  const net = [];                 // mọi lệnh tới "PayPal" (trừ OAuth): {kind, method, orderId}
  const inject = {};              // orderId -> { get: 'timeout'|'drop'|'404', holdCapture, holdArrived, holdRelease }
  const wrapped = async (url, options = {}) => {
    const u = new URL(url);
    const method = (options.method || 'GET').toUpperCase();
    const m = u.pathname.match(/^\/v2\/checkout\/orders\/([^/]+)(\/[a-z]+)?$/);
    let kind = 'other'; let orderId = null;
    if (u.pathname === '/v1/oauth2/token') kind = 'token';
    else if (u.pathname === '/v2/checkout/orders' && method === 'POST') kind = 'create';
    else if (u.pathname === '/v1/notifications/verify-webhook-signature') kind = 'verify';
    else if (m) { orderId = m[1]; kind = !m[2] ? (method === 'GET' ? 'get' : 'other') : (m[2] === '/capture' && method === 'POST' ? 'capture' : 'other'); }
    if (kind !== 'token') net.push({ kind, method, orderId });
    const inj = orderId && inject[orderId];
    if (inj && kind === 'get' && inj.get) {
      if (inj.get === 'drop') throw Object.assign(new Error('fake: connection reset'), { code: 'ECONNRESET' });
      if (inj.get === '404') return resp(404, { name: 'RESOURCE_NOT_FOUND' });
      if (inj.get === 'hold') { inj.getArrived.resolve(); await inj.getRelease.promise; return fake.fetchImpl(url, options); }
      if (inj.get === 'timeout') {
        return new Promise((_, rej) => {
          if (options.signal) options.signal.addEventListener('abort', () => rej(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })), { once: true });
        });
      }
    }
    if (inj && kind === 'capture' && inj.holdCapture) { inj.holdArrived.resolve(); await inj.holdRelease.promise; }
    return fake.fetchImpl(url, options);
  };
  const count = (kind, orderId) => net.filter((e) => e.kind === kind && (orderId === undefined || e.orderId === orderId)).length;
  const mutations = (orderId) => net.filter((e) => e.orderId === orderId && e.method !== 'GET').length; // capture/void/PATCH...

  const cfgShort = H.config();                                   // timeout 500 ms
  const cfgLong = H.config({ timeoutMs: 5000, leaseMs: 30000 }); // giữ được barrier lâu
  const providerShort = createSandboxProvider(cfgShort, { fetchImpl: wrapped });
  const rtShort = createPayPalRuntime({ config: cfgShort, provider: providerShort });
  const baseLong = createSandboxProvider(cfgLong, { fetchImpl: wrapped });
  const gate = { armed: null };   // barrier SAU khi getOrder trả về (adapter thật đã GET xong), trước khi người gọi đi tiếp
  const providerLong = { ...baseLong, getOrder: async (input) => {
    const result = await baseLong.getOrder(input);
    const g = gate.armed;
    if (g && g.orderId === input.orderId) {
      g.arrived++;
      if (g.arrived >= g.need) { gate.armed = null; g.hit.resolve(); }
      await g.release.promise;
    }
    return result;
  } };
  const rtLong = createPayPalRuntime({ config: cfgLong, provider: providerLong });

  // F-05: lịch sử/chi tiết đi qua singleton -> trỏ về runtime ngắn của test (như paypal-history-isolation-e2e).
  const originalSerialize = runtimeModule.serializePayPal;
  runtimeModule.serializePayPal = (id, options) => rtShort.serializePayPal(id, options);

  async function startApp(runtime, { withPayments }) {
    const app = express();
    app.use(express.json());
    app.use('/api/payments/paypal', createPayPalRouter(runtime));
    if (withPayments) app.use('/api/payments', require('../src/routes/payments'));
    app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.code || 'INTERNAL_ERROR', message: err.message }));
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    return { base: `http://127.0.0.1:${server.address().port}/api/payments`, close: () => new Promise((r) => { server.closeAllConnections && server.closeAllConnections(); server.close(r); }) };
  }
  const S = await startApp(rtShort, { withPayments: true });
  const L = await startApp(rtLong, { withPayments: false });
  const PP = S.base + '/paypal'; const PAY = S.base; const LP = L.base + '/paypal';
  const call = (base, route, opts) => { rateLimit.resetRateLimits(); return H.http(base, route, opts); };
  const abandon = (base, user, id, body = {}) => call(base, `/${id}/abandon`, { method: 'POST', token: user && user.token, body });

  // ------------------------------------------------------------------ tiện ích dữ liệu
  const cnt = async (sql, ...p) => Number((await db.prepare(sql).get(...p)).n);
  const snap = async (id) => ({ pr: await db.prepare('SELECT * FROM payment_requests WHERE id=?').get(id),
    b: await db.prepare('SELECT * FROM paypal_payment_bindings WHERE payment_request_id=?').get(id) });
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const balance = async (u) => Number((await H.wallet(db, u.id)).available_balance);
  const ledger = async (u) => cnt('SELECT COUNT(*) AS n FROM wallet_entries WHERE wallet_id=?', (await H.wallet(db, u.id)).id);
  const abandonEvents = (u) => db.prepare("SELECT * FROM security_events WHERE event_type='PAYPAL_REQUEST_ABANDONED' AND actor_id=? ORDER BY id").all(u.id);
  const allAbandonEvents = () => cnt("SELECT COUNT(*) AS n FROM security_events WHERE event_type='PAYPAL_REQUEST_ABANDONED'");
  const fresh = (label, role = 'BUYER') => H.createAccount(db, { label, role });
  async function mk(u, { amount = 10000, approve = false } = {}) {
    const row = await rtShort.create({ userId: u.id, amount, requestId: 'ab-' + uuid() });
    if (approve) fake.approve(row.orderId);
    return { id: row.id, orderId: row.orderId, amount, requestId: row.requestId, user: u };
  }
  const mkNew = async (label = 'ab', opts) => { const u = await fresh(label); return { u, r: await mk(u, opts) }; };
  const hdr = () => ({ 'paypal-auth-algo': 'SHA256withRSA', 'paypal-cert-url': `${SANDBOX}/v1/notifications/certs/m2`,
    'paypal-transmission-id': 'tx-' + uuid(), 'paypal-transmission-sig': 'good-signature', 'paypal-transmission-time': nowIso() });
  const evt = (orderId) => ({ id: 'EVT-' + uuid(), event_type: 'PAYMENT.CAPTURE.COMPLETED',
    resource: { id: 'CAP' + orderId, supplementary_data: { related_ids: { order_id: orderId } } } });
  const cutoff = () => new Date(Date.now() - 30000).toISOString();
  const claim = async (r) => {
    const claimId = uuid();
    const c = await rtShort.store.claimCapture(r.id, r.user.id, claimId, nowIso(), cutoff());
    return { claimId, outcome: c.outcome };
  };
  const bindingOf = (id) => rtShort.store.loadByRequestId(id);
  const isOk = (res, outcome) => res.status === 200 && res.body && res.body.status === 'FAILED' && res.body.outcome === outcome;

  // =====================================================================================================
  await runCase('C1', '5 ý định PENDING chặn hạn mức; abandon một request rồi tạo mới được', async () => {
    const u = await fresh('c1');
    const ids = [];
    for (let i = 0; i < 5; i++) {
      const r = await call(PP, '/topup', { method: 'POST', token: u.token, body: { amount: 10000, requestId: 'c1-' + i + '-' + uuid() } });
      if (r.status === 200) ids.push(r.body.id);
    }
    eq(ids.length, 5, 'precond: tạo được 5 ý định PayPal PENDING có order');
    const sixth = await call(PP, '/topup', { method: 'POST', token: u.token, body: { amount: 10000, requestId: 'c1-6-' + uuid() } });
    ok(sixth.status === 409 && sixth.body.error === 'TOPUP_LIMIT_EXCEEDED', 'precond: ý định thứ 6 bị 409 TOPUP_LIMIT_EXCEEDED', `nhận ${sixth.status} ${sixth.body && sixth.body.error}`);
    const bal0 = await balance(u); const led0 = await ledger(u);
    const target = await snap(ids[0]);
    const ab = await abandon(PP, u, ids[0]);
    ok(isOk(ab, 'ABANDONED'), 'abandon hợp lệ một ý định: 200, status FAILED, outcome ABANDONED', `nhận ${ab.status} ${JSON.stringify(ab.body).slice(0, 160)}`);
    eq(await balance(u), bal0, 'số dư ví trước/sau abandon bằng nhau');
    eq(await ledger(u), led0, 'số hàng sổ cái trước/sau abandon bằng nhau');
    const after = await snap(ids[0]);
    ok(after.pr.status === 'FAILED' && target.pr.status === 'PENDING', 'request đích chuyển PENDING -> FAILED, các request khác không đổi');
    for (const id of ids.slice(1)) eq((await snap(id)).pr.status, 'PENDING', `request ${id.slice(0, 8)} khác vẫn PENDING`);
    const again = await call(PP, '/topup', { method: 'POST', token: u.token, body: { amount: 10000, requestId: 'c1-new-' + uuid() } });
    ok(again.status === 200 && again.body.id && !ids.includes(again.body.id) && again.body.status === 'PENDING', 'sau abandon: tạo được ý định mới với requestId mới', `nhận ${again.status} ${again.body && again.body.error}`);
    const seventh = await call(PP, '/topup', { method: 'POST', token: u.token, body: { amount: 10000, requestId: 'c1-7-' + uuid() } });
    ok(seventh.status === 409 && seventh.body.error === 'TOPUP_LIMIT_EXCEEDED', 'hạn mức KHÔNG bị nới: lại đủ 5 PENDING thì ý định kế tiếp lại bị chặn');
  });

  // =====================================================================================================
  await runCase('C2', 'Xác thực, vai trò, chủ sở hữu, body bị cấm', async () => {
    const buyer = await fresh('c2-buyer'); const seller = await fresh('c2-seller', 'SELLER'); const outsider = await fresh('c2-out');
    const adminAcc = await H.createAccount(db, { label: 'c2-admin', balance: 50000 });
    await withTriggerDisabled(db, 'users', () => db.prepare("UPDATE users SET role='ADMIN' WHERE id=?").run(adminAcc.id));
    const rb = await mk(buyer); const rs = await mk(seller);
    const sb = await snap(rb.id);
    const ev0 = await allAbandonEvents();
    const noTok = await call(PP, `/${rb.id}/abandon`, { method: 'POST', body: {} });
    eq(noTok.status, 401, 'thiếu token: 401');
    const out = await abandon(PP, outsider, rb.id);
    ok(out.status === 403, 'người ngoài (BUYER khác): 403', `nhận ${out.status}`);
    const adm = await abandon(PP, adminAcc, rb.id);
    ok(adm.status === 403, 'ADMIN (có ví nhưng sai vai trò) không dùng được endpoint ví: 403', `nhận ${adm.status}`);
    ok(same(await snap(rb.id), sb) && await allAbandonEvents() === ev0, 'các lần từ chối không đổi trạng thái và không ghi audit thành công');
    for (const [label, body] of [['userId', { userId: buyer.id }], ['status', { status: 'FAILED' }], ['evidence', { evidence: { orderStatus: 'VOIDED' } }],
      ['actor', { actor: 'SYSTEM' }], ['khoá bất kỳ', { foo: 1 }], ['amount', { amount: 1 }], ['requestId', { requestId: 'whatever-1' }]]) {
      const r = await abandon(PP, buyer, rb.id, body);
      ok(r.status === 400, `body có khoá "${label}": 400`, `nhận ${r.status} ${r.body && r.body.error}`);
    }
    ok(same(await snap(rb.id), sb), 'sau mọi body bị cấm: trạng thái request không đổi');
    eq(await allAbandonEvents(), ev0, 'body bị cấm: không có audit PAYPAL_REQUEST_ABANDONED');
    const forged = await abandon(PP, outsider, rb.id, { userId: buyer.id });
    ok(forged.status === 400 || forged.status === 403, 'người ngoài giả userId chủ trong body: bị chặn (400/403), không thành chủ', `nhận ${forged.status}`);
    ok(same(await snap(rb.id), sb), 'giả userId: không đổi trạng thái');
    const okBuyer = await abandon(PP, buyer, rb.id);
    ok(isOk(okBuyer, 'ABANDONED'), 'BUYER chính chủ: 200 ABANDONED', `nhận ${okBuyer.status}`);
    const okSeller = await abandon(PP, seller, rs.id);
    ok(isOk(okSeller, 'ABANDONED'), 'SELLER chính chủ: 200 ABANDONED', `nhận ${okSeller.status}`);
    const rn = await mk(await fresh('c2-nobody'));
    const nobody = await call(PP, `/${rn.id}/abandon`, { method: 'POST', token: rn.user.token });
    ok(isOk(nobody, 'ABANDONED'), 'không gửi body (undefined) cũng hợp lệ', `nhận ${nobody.status}`);
    eq((await abandonEvents(buyer)).length, 1, 'chủ BUYER có đúng 1 audit; người ngoài/admin 0');
    eq((await abandonEvents(outsider)).length + (await abandonEvents(adminAcc)).length, 0, 'người ngoài và admin không có audit ABANDONED');
  });

  // =====================================================================================================
  await runCase('C3a', 'Provider không cho phép đóng: lỗi/mismatch/capture -> request giữ nguyên', async () => {
    const denyCases = [];
    const tamperCase = (label, patch, code) => denyCases.push({ label, patch, code });
    tamperCase('orderId khác', { id: 'ORD-OTHER-1' }, 'PAYPAL_ORDER_MISMATCH');
    tamperCase('paymentRequestId khác (reference_id)', { reference_id: 'other-request' }, 'PAYPAL_ORDER_MISMATCH');
    tamperCase('paymentRequestId khác (custom_id)', { custom_id: 'other-request' }, 'PAYPAL_ORDER_MISMATCH');
    tamperCase('số tiền/quote USD khác', { value: '9.99' }, 'PAYPAL_ORDER_MISMATCH');
    tamperCase('merchant khác', { merchant_id: 'OTHER-MERCHANT' }, 'PAYPAL_ORDER_MISMATCH');
    tamperCase('tiền tệ khác', { currency: 'EUR' }, 'PAYPAL_ORDER_MISMATCH');
    for (const dc of denyCases) {
      const { u, r } = await mkNew('c3a');
      fake.tamper(r.orderId, dc.patch);
      const before = await snap(r.id); const m0 = mutations(r.orderId); const ev0 = await allAbandonEvents();
      const res = await abandon(PP, u, r.id);
      ok(res.status === 409 && res.body.error === dc.code, `mismatch ${dc.label}: 409 ${dc.code}, không đóng`, `nhận ${res.status} ${res.body && res.body.error}`);
      ok(same(await snap(r.id), before) && (await allAbandonEvents()) === ev0 && mutations(r.orderId) === m0, `mismatch ${dc.label}: request/binding nguyên vẹn, không audit, không lệnh ghi tới provider`);
    }
    for (const [label, mode, wantStatus, wantCodes] of [['GET timeout', 'timeout', 503, ['PAYPAL_TIMEOUT']], ['GET lỗi mạng', 'drop', 503, ['PAYPAL_UNAVAILABLE']],
      ['order không tồn tại (404 PayPal)', '404', 502, ['PAYPAL_API_ERROR']]]) {
      const { u, r } = await mkNew('c3a');
      const before = await snap(r.id); const m0 = mutations(r.orderId); const ev0 = await allAbandonEvents();
      inject[r.orderId] = { get: mode };
      let res;
      try { res = await abandon(PP, u, r.id); } finally { delete inject[r.orderId]; }
      ok(res.status >= 500 && wantCodes.includes(res.body.error), `${label}: lỗi an toàn ${wantStatus}/${wantCodes[0]}`, `nhận ${res.status} ${res.body && res.body.error}`);
      ok(same(await snap(r.id), before) && (await allAbandonEvents()) === ev0 && mutations(r.orderId) === m0, `${label}: request vẫn PENDING/READY, không audit, không lệnh ghi`);
    }
    // orderStatus bất kỳ nhưng đã có capture -> không đóng
    // Mã lỗi xác định: có captureId -> 409 PAYPAL_ABANDON_UNSAFE (service từ chối); order COMPLETED không capture -> adapter
    // báo 502 PAYPAL_RESPONSE_INVALID (lỗi provider an toàn, không phải từ chối nghiệp vụ).
    for (const [label, orderPatch, wantStatus, wantCode] of [
      ['capture PENDING, order APPROVED', { status: 'APPROVED', approved: true, capture: { id: 'CAPPEND1', status: 'PENDING', final_capture: true } }, 409, 'PAYPAL_ABANDON_UNSAFE'],
      ['capture PENDING, order PAYER_ACTION_REQUIRED', { capture: { id: 'CAPPEND2', status: 'PENDING', final_capture: true } }, 409, 'PAYPAL_ABANDON_UNSAFE'],
      ['capture PENDING, order VOIDED', { status: 'VOIDED', capture: { id: 'CAPPEND3', status: 'PENDING', final_capture: true } }, 409, 'PAYPAL_ABANDON_UNSAFE'],
      ['capture COMPLETED (đã thu thật)', { status: 'COMPLETED', captured: true, capture: { id: 'CAPDONE1', status: 'COMPLETED', final_capture: true } }, 409, 'PAYPAL_ABANDON_UNSAFE'],
      ['order COMPLETED nhưng không có capture', { status: 'COMPLETED', capture: null }, 502, 'PAYPAL_RESPONSE_INVALID']]) {
      const { u, r } = await mkNew('c3a');
      const o = fake.order(r.orderId);
      const patch = { ...orderPatch };
      if (patch.capture) patch.capture = { ...patch.capture, amount: { currency_code: o.currency, value: o.value } };
      fake.tamper(r.orderId, patch);
      const before = await snap(r.id); const m0 = mutations(r.orderId); const ev0 = await allAbandonEvents(); const bal0 = await balance(u);
      const res = await abandon(PP, u, r.id);
      ok(res.status === wantStatus && res.body.error === wantCode, `${label}: ${wantStatus} ${wantCode}, không đóng`, `nhận ${res.status} ${res.body && res.body.error}`);
      ok(same(await snap(r.id), before) && (await allAbandonEvents()) === ev0 && mutations(r.orderId) === m0 && (await balance(u)) === bal0, `${label}: request vẫn PENDING, không audit, không lệnh ghi, không cộng ví`);
    }
  });

  // =====================================================================================================
  await runCase('C3b', 'orderStatus được chấp nhận: CREATED/SAVED/APPROVED/PAYER_ACTION_REQUIRED/VOIDED', async () => {
    for (const st of ['CREATED', 'SAVED', 'APPROVED', 'PAYER_ACTION_REQUIRED', 'VOIDED']) {
      const { u, r } = await mkNew('c3b');
      fake.tamper(r.orderId, { status: st, approved: st === 'APPROVED' });
      const bal0 = await balance(u); const led0 = await ledger(u); const m0 = mutations(r.orderId); const caps0 = count('capture');
      const res = await abandon(PP, u, r.id);
      ok(isOk(res, 'ABANDONED') && res.body.stage === 'FAILED', `orderStatus=${st}: 200 ABANDONED, stage FAILED`, `nhận ${res.status} ${res.body && res.body.error}`);
      const s = await snap(r.id);
      ok(s.pr.status === 'FAILED' && s.b.capture_state === 'READY' && !s.b.capture_post_sent_at, `orderStatus=${st}: FAILED, bằng chứng capture giữ nguyên (READY, chưa POST)`);
      ok(mutations(r.orderId) === m0 && count('capture') === caps0, `orderStatus=${st}: không có POST capture/void/refund tới provider`);
      ok((await balance(u)) === bal0 && (await ledger(u)) === led0, `orderStatus=${st}: ví và sổ cái không đổi`);
      eq(fake.order(r.orderId).status, st, `orderStatus=${st}: order phía PayPal không bị hủy/đổi`);
    }
  });

  // =====================================================================================================
  await runCase('C3c', 'Trạng thái cục bộ không an toàn -> 409 PAYPAL_ABANDON_UNSAFE và KHÔNG gọi getOrder', async () => {
    const seeds = [
      ['IN_FLIGHT (có claim, chưa POST)', async (r) => { const c = await claim(r); return c.outcome === 'CLAIMED'; }],
      ['IN_FLIGHT + đã POST', async (r) => { const c = await claim(r); await rtShort.store.markCapturePostSent(r.id, c.claimId); return c.outcome === 'CLAIMED'; }],
      ['UNKNOWN sau khi POST', async (r) => { const c = await claim(r); await rtShort.store.markCapturePostSent(r.id, c.claimId); return (await rtShort.store.finishCaptureAttempt(r.id, c.claimId, { state: 'UNKNOWN', errorCode: 'X' })).ok; }],
      ['UNKNOWN (khai UNKNOWN, chưa POST)', async (r) => { const c = await claim(r); return (await rtShort.store.finishCaptureAttempt(r.id, c.claimId, { state: 'UNKNOWN', errorCode: 'X' })).ok; }],
      ['VERIFIED (PENDING chờ tất toán)', async (r) => { const c = await claim(r); await rtShort.store.markCapturePostSent(r.id, c.claimId); return (await rtShort.store.finishCaptureAttempt(r.id, c.claimId, { state: 'VERIFIED', captureId: 'CAPSEED' + r.id })).ok; }],
      ['NOT_CAPTURED (order VOIDED sau POST)', async (r) => { const c = await claim(r); await rtShort.store.markCapturePostSent(r.id, c.claimId); return (await rtShort.store.finishCaptureAttempt(r.id, c.claimId, { state: 'NOT_CAPTURED', evidence: 'ORDER_VOIDED' })).ok; }],
      ['RECOVERY_REQUIRED (fixture DB; chỉ chạm tiền kiểm, không chạm guard atomic)', async (r) => { await db.prepare("UPDATE paypal_payment_bindings SET capture_state='RECOVERY_REQUIRED', capture_id=?, recovery_required_at=? WHERE payment_request_id=?").run('CAPREC' + r.id, nowIso(), r.id); return true; }],
      ['READY nhưng còn claim (fixture DB; chỉ chạm tiền kiểm, không chạm guard atomic; guard atomic ở C11)', async (r) => { await db.prepare("UPDATE paypal_payment_bindings SET capture_claim=?, capture_claimed_at=? WHERE payment_request_id=?").run(uuid(), nowIso(), r.id); return true; }],
    ];
    for (const [label, seed] of seeds) {
      const { u, r } = await mkNew('c3c');
      const seeded = await seed(r);
      ok(seeded === true, `precond: dựng được trạng thái ${label}`);
      const before = await snap(r.id); const g0 = count('get', r.orderId); const m0 = mutations(r.orderId); const ev0 = await allAbandonEvents();
      const res = await abandon(PP, u, r.id);
      ok(res.status === 409 && res.body.error === 'PAYPAL_ABANDON_UNSAFE', `${label}: 409 PAYPAL_ABANDON_UNSAFE`, `nhận ${res.status} ${res.body && res.body.error}`);
      eq(count('get', r.orderId) - g0, 0, `${label}: KHÔNG gọi provider.getOrder (kiểm cục bộ đã từ chối)`);
      ok(same(await snap(r.id), before) && (await allAbandonEvents()) === ev0 && mutations(r.orderId) === m0, `${label}: request/binding nguyên vẹn, không audit, không lệnh ghi`);
    }
    // Create mơ hồ / chưa gắn order
    const u = await fresh('c3c-unbound');
    const key = 'unb-' + uuid();
    fake.plan('create', 'drop');
    await rtShort.create({ userId: u.id, amount: 10000, requestId: key }).then(() => null, (e) => e);
    const row = await db.prepare('SELECT id FROM payment_requests WHERE client_request_id=?').get(key);
    const b = row && await bindingOf(row.id);
    ok(b && !b.orderId && b.status === 'PENDING', 'precond: request PENDING chưa gắn order (create mơ hồ)');
    const before = await snap(row.id); const g0 = count('get'); const ev0 = await allAbandonEvents();
    const res = await abandon(PP, u, row.id);
    ok(res.status === 409 && res.body.error === 'PAYPAL_ABANDON_UNSAFE', 'chưa bind order / create mơ hồ: 409 PAYPAL_ABANDON_UNSAFE', `nhận ${res.status} ${res.body && res.body.error}`);
    ok(count('get') === g0 && same(await snap(row.id), before) && (await allAbandonEvents()) === ev0, 'chưa bind order: không GET, không đổi, không audit');
  });

  // =====================================================================================================
  await runCase('C4a', 'Race: abandon GET xong, capture giành claim (POST đang bay), rồi thả close -> close KHÔNG thắng', async () => {
    const { u, r } = await mkNew('c4a', { approve: true });
    const g = { orderId: r.orderId, need: 1, arrived: 0, hit: defer(), release: defer() };
    gate.armed = g;
    const inj = { holdCapture: true, holdArrived: defer(), holdRelease: defer() };
    inject[r.orderId] = inj;
    const bal0 = await balance(u); const led0 = await ledger(u);
    try {
      const abP = abandon(LP, u, r.id);
      const first = await Promise.race([g.hit.promise.then(() => 'hit'), abP.then(() => 'done'), sleep(10000).then(() => 'timeout')]);
      ok(first === 'hit', 'precond: abandon đã GET xong và đang đứng ở barrier (chưa đóng)', `kết quả ${first}`);
      if (first !== 'hit') { g.release.resolve(); await abP; return; }
      const mid = await snap(r.id);
      ok(mid.pr.status === 'PENDING' && mid.b.capture_state === 'READY', 'precond: trong lúc barrier request còn PENDING/READY');
      const capP = call(LP, `/${r.id}/capture`, { method: 'POST', token: u.token, body: {} });
      const arrived = await Promise.race([inj.holdArrived.promise.then(() => 'arrived'), capP.then(() => 'done'), sleep(10000).then(() => 'timeout')]);
      ok(arrived === 'arrived', 'precond: capture đã giành claim, đã ghi dấu POST và POST đang treo ở provider', `kết quả ${arrived}`);
      const held = await snap(r.id);
      ok(held.b.capture_state === 'IN_FLIGHT' && !!held.b.capture_post_sent_at && held.pr.status === 'PENDING', 'precond: DB: IN_FLIGHT, capture_post_sent_at có, request PENDING');
      g.release.resolve();
      const ab = await abP;
      ok(ab.status === 409 && ab.body.error === 'PAYPAL_ABANDON_UNSAFE', 'thả close sau khi capture đã claim: 409 PAYPAL_ABANDON_UNSAFE (close KHÔNG thắng)', `nhận ${ab.status} ${ab.body && ab.body.error}`);
      const afterAb = await snap(r.id);
      ok(afterAb.pr.status === 'PENDING' && afterAb.b.capture_state === 'IN_FLIGHT' && (await abandonEvents(u)).length === 0, 'close thua: request vẫn PENDING, claim còn nguyên, không audit');
      inj.holdRelease.resolve();
      const cap = await capP;
      ok(cap.status === 200 && cap.body.outcome === 'APPLIED' && cap.body.status === 'SUCCEEDED', 'capture tiếp tục bình thường và tất toán (APPLIED)', `nhận ${cap.status} ${JSON.stringify(cap.body).slice(0, 120)}`);
      eq(count('capture', r.orderId), 1, 'đúng một POST capture tới provider');
      eq((await H.credits(db, r.id)).length, 1, 'đúng một bút toán TOPUP_CREDIT');
      eq((await balance(u)) - bal0, r.amount, 'ví tăng đúng một lần số tiền');
      const end = await snap(r.id);
      ok(end.pr.status === 'SUCCEEDED' && end.pr.last_reconcile_error !== 'USER_ABANDONED' && !!end.b.capture_id, 'kết thúc SUCCEEDED, có capture_id, không bị ghi USER_ABANDONED');
      ok((await ledger(u)) - led0 === 1, 'sổ cái chỉ thêm đúng một hàng (từ capture)');
    } finally { gate.armed = null; g.release.resolve(); inj.holdRelease.resolve(); delete inject[r.orderId]; }
  });

  await runCase('C4b', 'Race: close thắng trước -> capture sau nhận CLOSED và provider.captureOrder KHÔNG bị gọi', async () => {
    const { u, r } = await mkNew('c4b', { approve: true });
    const bal0 = await balance(u);
    const ab = await abandon(LP, u, r.id);
    ok(isOk(ab, 'ABANDONED'), 'precond: abandon thắng (FAILED)', `nhận ${ab.status}`);
    const posts0 = count('capture', r.orderId);
    const cap = await call(LP, `/${r.id}/capture`, { method: 'POST', token: u.token, body: {} });
    ok(cap.status === 200 && cap.body.outcome === 'CLOSED' && cap.body.status === 'FAILED', 'capture sau close: outcome CLOSED, status FAILED', `nhận ${cap.status} ${cap.body && cap.body.outcome}`);
    eq(count('capture', r.orderId) - posts0, 0, 'provider POST capture = 0 sau khi close thắng');
    eq(count('capture', r.orderId), 0, 'tổng POST capture của order = 0');
    eq((await H.credits(db, r.id)).length, 0, 'không có bút toán');
    eq(await balance(u), bal0, 'ví không đổi');
    const s = await snap(r.id);
    ok(s.pr.status === 'FAILED' && s.b.capture_state === 'READY' && !s.b.capture_post_sent_at && s.b.capture_attempts === 0, 'DB: FAILED, capture READY, chưa claim/POST lần nào');
  });

  await runCase('C4b2', 'Race song song abandon || capture: luôn nhất quán (chỉ một bên thắng), lặp 8 lần', async () => {
    const outcomes = { close: 0, capture: 0, bad: [] };
    for (let i = 0; i < 8; i++) {
      const { u, r } = await mkNew('c4b2', { approve: true });
      const bal0 = await balance(u);
      const [ab, cap] = await Promise.all([abandon(LP, u, r.id), call(LP, `/${r.id}/capture`, { method: 'POST', token: u.token, body: {} })]);
      const s = await snap(r.id); const posts = count('capture', r.orderId); const credits = (await H.credits(db, r.id)).length; const bal1 = await balance(u);
      const closeWon = ab.status === 200 && ab.body.outcome === 'ABANDONED' && cap.status === 200 && cap.body.outcome === 'CLOSED' && s.pr.status === 'FAILED' && posts === 0 && credits === 0 && bal1 === bal0;
      const captureWon = ab.status === 409 && ab.body.error === 'PAYPAL_ABANDON_UNSAFE' && cap.status === 200 && cap.body.outcome === 'APPLIED' && s.pr.status === 'SUCCEEDED' && posts === 1 && credits === 1 && bal1 - bal0 === r.amount;
      if (closeWon) outcomes.close++; else if (captureWon) outcomes.capture++;
      else outcomes.bad.push({ ab: [ab.status, ab.body && (ab.body.error || ab.body.outcome)], cap: [cap.status, cap.body && (cap.body.error || cap.body.outcome)], st: s.pr.status, posts, credits });
    }
    eq(outcomes.bad, [], 'mọi lần chạy: hoặc (close thắng, POST=0, không credit) hoặc (capture thắng, POST=1, 1 credit); không lẫn');
    info(`phân bố: close thắng ${outcomes.close}, capture thắng ${outcomes.capture}`);
  });

  await runCase('C4c', 'Race: hai abandon song song (barrier chờ cả hai GET xong) -> một ABANDONED, một ALREADY_ABANDONED, một audit', async () => {
    const { u, r } = await mkNew('c4c');
    const g = { orderId: r.orderId, need: 2, arrived: 0, hit: defer(), release: defer() };
    gate.armed = g;
    const v0 = (await snap(r.id)).pr.version;
    try {
      const a1 = abandon(LP, u, r.id); const a2 = abandon(LP, u, r.id);
      const first = await Promise.race([g.hit.promise.then(() => 'hit'), Promise.all([a1, a2]).then(() => 'done'), sleep(10000).then(() => 'timeout')]);
      ok(first === 'hit', 'precond: cả hai abandon đã GET xong và cùng đứng ở barrier (chưa bên nào đóng)', `kết quả ${first}`);
      eq((await snap(r.id)).pr.status, 'PENDING', 'precond: request còn PENDING khi cả hai đang giữ');
      g.release.resolve();
      const [x, y] = await Promise.all([a1, a2]);
      eq([x.status, y.status], [200, 200], 'cả hai trả 200');
      eq([x.body && x.body.outcome, y.body && y.body.outcome].sort(), ['ABANDONED', 'ALREADY_ABANDONED'], 'đúng một ABANDONED và một ALREADY_ABANDONED');
      eq((await abandonEvents(u)).length, 1, 'đúng MỘT hàng audit');
      const s = await snap(r.id);
      ok(s.pr.status === 'FAILED' && Number(s.pr.version) === Number(v0) + 1, 'đóng đúng một lần (version tăng 1)');
      eq(count('capture', r.orderId), 0, 'provider POST capture = 0');
    } finally { gate.armed = null; g.release.resolve(); }
  });

  // =====================================================================================================
  await runCase('C5', 'Replay: abandon lại, key cũ, FAILED vì lý do khác', async () => {
    const u = await fresh('c5');
    const key = 'c5-' + uuid();
    const created = await call(PP, '/topup', { method: 'POST', token: u.token, body: { amount: 10000, requestId: key } });
    ok(created.status === 200 && created.body.id, 'precond: tạo request PayPal');
    const id = created.body.id;
    const first = await abandon(PP, u, id);
    ok(isOk(first, 'ABANDONED'), 'precond: abandon lần đầu 200 ABANDONED', `nhận ${first.status}`);
    const s1 = await snap(id);
    const n1 = { ev: await cnt('SELECT COUNT(*) AS n FROM security_events'), led: await cnt('SELECT COUNT(*) AS n FROM wallet_entries'), pr: await cnt('SELECT COUNT(*) AS n FROM payment_requests'), ab: await allAbandonEvents(), ord: fake.orderCount(), cre: count('create'), mut: mutations(created.body.orderId) };
    const again = await abandon(PP, u, id);
    ok(isOk(again, 'ALREADY_ABANDONED'), 'abandon lại: 200 ALREADY_ABANDONED', `nhận ${again.status} ${again.body && (again.body.outcome || again.body.error)}`);
    ok(same(await snap(id), s1), 'replay: payment_requests và binding không đổi (không đổi version/updated_at)');
    const n2 = { ev: await cnt('SELECT COUNT(*) AS n FROM security_events'), led: await cnt('SELECT COUNT(*) AS n FROM wallet_entries'), pr: await cnt('SELECT COUNT(*) AS n FROM payment_requests'), ab: await allAbandonEvents(), ord: fake.orderCount(), cre: count('create'), mut: mutations(created.body.orderId) };
    eq(n2, n1, 'replay: không thêm hàng audit/sổ cái/request, không order mới, không lệnh ghi provider');
    const reuse = await call(PP, '/topup', { method: 'POST', token: u.token, body: { amount: 10000, requestId: key } });
    ok(reuse.status === 200 && reuse.body.id === id && reuse.body.status === 'FAILED' && reuse.body.stage === 'FAILED', 'requestId cũ gọi create lại: trả lại request FAILED cũ (cùng id)', `nhận ${reuse.status} ${reuse.body && (reuse.body.id === id ? 'cùng id' : reuse.body.error)} ${reuse.body && reuse.body.status}`);
    eq([fake.orderCount(), count('create')], [n1.ord, n1.cre], 'requestId cũ KHÔNG tạo order mới (đếm order và POST create)');
    eq(await cnt('SELECT COUNT(*) AS n FROM payment_requests'), n1.pr, 'requestId cũ không tạo request mới');
    // FAILED vì lý do khác
    const o = await mkNew('c5-other');
    const closed = await rtShort.store.closeUncaptured(o.r.id, { nowIso: nowIso(), reason: 'ORDER_EXPIRED' });
    ok(closed.closed === true, 'precond: request FAILED vì lý do khác (ORDER_EXPIRED) bằng closeUncaptured');
    const so = await snap(o.r.id); const evo = await allAbandonEvents();
    const ro = await abandon(PP, o.u, o.r.id);
    ok(ro.status === 409 && !(ro.body && ro.body.outcome === 'ALREADY_ABANDONED') && !(ro.status === 200), 'FAILED vì ORDER_EXPIRED: 409, KHÔNG phải replay thành công', `nhận ${ro.status} ${ro.body && (ro.body.error || ro.body.outcome)}`);
    ok(same(await snap(o.r.id), so) && (await allAbandonEvents()) === evo, 'FAILED lý do khác: không đổi, không audit ABANDONED');
    const n = await mkNew('c5-nc');
    const c = await claim(n.r); await rtShort.store.markCapturePostSent(n.r.id, c.claimId);
    await rtShort.store.finishCaptureAttempt(n.r.id, c.claimId, { state: 'NOT_CAPTURED', evidence: 'ORDER_VOIDED' });
    const closedN = await rtShort.store.closeUncaptured(n.r.id, { nowIso: nowIso(), reason: 'ORDER_VOIDED' });
    ok(closedN.closed === true, 'precond: request FAILED qua đường NOT_CAPTURED (ORDER_VOIDED)');
    const sn = await snap(n.r.id);
    const rn = await abandon(PP, n.u, n.r.id);
    ok(rn.status === 409 && !(rn.body && rn.body.outcome === 'ALREADY_ABANDONED'), 'FAILED qua NOT_CAPTURED: 409, không phải replay', `nhận ${rn.status} ${rn.body && (rn.body.error || rn.body.outcome)}`);
    ok(same(await snap(n.r.id), sn), 'NOT_CAPTURED đã đóng: không đổi');
    // SUCCEEDED
    const sc = await mkNew('c5-sc', { approve: true });
    const cap = await call(PP, `/${sc.r.id}/capture`, { method: 'POST', token: sc.u.token, body: {} });
    ok(cap.status === 200 && cap.body.status === 'SUCCEEDED', 'precond: request SUCCEEDED qua capture thật');
    const ss = await snap(sc.r.id); const bal = await balance(sc.u);
    const rs = await abandon(PP, sc.u, sc.r.id);
    ok(rs.status === 409 && !(rs.status === 200), 'abandon request đã SUCCEEDED: 409', `nhận ${rs.status}`);
    ok(same(await snap(sc.r.id), ss) && (await balance(sc.u)) === bal && (await H.credits(db, sc.r.id)).length === 1, 'SUCCEEDED không đổi, vẫn đúng một credit');
  });

  // =====================================================================================================
  await runCase('C6', 'Capture muộn sau close: RECOVERY_REQUIRED, lưu capture_id, không credit/ledger', async () => {
    const lateCapture = async (orderId) => { // PayPal thu tiền ngoài tầm kiểm soát của ta (phía fake), sau khi request đã đóng
      fake.approve(orderId);
      const r = await fake.fetchImpl(`${SANDBOX}/v2/checkout/orders/${orderId}/capture`, { method: 'POST', headers: { 'PayPal-Request-Id': 'late-' + orderId }, body: '{}' });
      return r.status;
    };
    const paths = [
      ['webhook PAYMENT.CAPTURE.COMPLETED', async (r) => rtShort.webhook(hdr(), evt(r.orderId))],
      ['đối soát worker (reconcileOne, GET)', async (r) => rtShort.reconcileOne(r.id)],
      ['store.markCaptureVerified trực tiếp', async (r) => rtShort.store.markCaptureVerified(r.id, 'CAP' + r.orderId)],
    ];
    for (const [label, run] of paths) {
      const { u, r } = await mkNew('c6');
      const ab = await abandon(PP, u, r.id);
      ok(isOk(ab, 'ABANDONED'), `[${label}] precond: request đã USER_ABANDONED`, `nhận ${ab.status}`);
      eq(await lateCapture(r.orderId), 201, `[${label}] precond: PayPal thu tiền muộn (order COMPLETED phía fake)`);
      const bal0 = await balance(u); const led0 = await ledger(u); const credits0 = await cnt('SELECT COUNT(*) AS n FROM wallet_entries WHERE entry_type=?', 'TOPUP_CREDIT');
      const out = await run(r);
      ok(out && (out.outcome === 'RECOVERY_REQUIRED'), `[${label}] kết quả RECOVERY_REQUIRED`, JSON.stringify(out));
      const s = await snap(r.id);
      ok(s.b.capture_state === 'RECOVERY_REQUIRED' && s.b.capture_id === 'CAP' + r.orderId && !!s.b.recovery_required_at, `[${label}] binding: RECOVERY_REQUIRED, capture_id lưu đúng, recovery_required_at có`);
      ok(s.pr.status === 'FAILED' && s.pr.last_reconcile_error === 'USER_ABANDONED', `[${label}] request vẫn FAILED (không mở lại), last_reconcile_error=USER_ABANDONED (chỉ đúng khi chưa qua lượt quét lô)`);
      ok((await balance(u)) === bal0 && (await ledger(u)) === led0 && (await H.credits(db, r.id)).length === 0, `[${label}] KHÔNG credit ví, KHÔNG ghi ledger`);
      eq(await cnt('SELECT COUNT(*) AS n FROM wallet_entries WHERE entry_type=?', 'TOPUP_CREDIT'), credits0, `[${label}] tổng bút toán TOPUP_CREDIT toàn DB không đổi`);
    }
    // Sau RECOVERY_REQUIRED: capture HTTP không POST, bằng chứng còn
    const { u, r } = await mkNew('c6b');
    await abandon(PP, u, r.id);
    await lateCapture(r.orderId);
    await rtShort.webhook(hdr(), evt(r.orderId));
    const posts0 = count('capture', r.orderId);
    const cap = await call(PP, `/${r.id}/capture`, { method: 'POST', token: u.token, body: {} });
    ok(cap.status === 200 && cap.body.outcome === 'RECOVERY_REQUIRED' && cap.body.stage === 'RECOVERY_REQUIRED', 'capture HTTP sau RECOVERY_REQUIRED: outcome/stage RECOVERY_REQUIRED', `nhận ${cap.status} ${cap.body && cap.body.outcome}`);
    eq(count('capture', r.orderId), posts0, 'không POST capture thêm');
    const s = await snap(r.id);
    ok(s.b.capture_id === 'CAP' + r.orderId && s.b.capture_state === 'RECOVERY_REQUIRED', 'bằng chứng không bị mất sau lần capture HTTP');
    const rec = await rtShort.reconcileOne(r.id);
    ok(rec.outcome === 'RECOVERY_REQUIRED' && (await H.credits(db, r.id)).length === 0, 'đối soát lặp: vẫn RECOVERY_REQUIRED, không tự credit');
  });

  // =====================================================================================================
  await runCase('C7', 'Audit actor/source và tính nguyên tử khi INSERT audit lỗi', async () => {
    const { u, r } = await mkNew('c7');
    const ab = await abandon(PP, u, r.id);
    ok(isOk(ab, 'ABANDONED'), 'precond: abandon thành công', `nhận ${ab.status}`);
    const evs = await abandonEvents(u);
    eq(evs.length, 1, 'ĐÚNG MỘT hàng security_events PAYPAL_REQUEST_ABANDONED của chủ');
    const e = evs[0] || {}; let detail = {};
    try { detail = JSON.parse(e.detail || '{}'); } catch (_) { /* */ }
    eq([e.event_type, e.outcome, e.actor_id], ['PAYPAL_REQUEST_ABANDONED', 'ALLOWED', u.id], 'event_type, outcome=ALLOWED, actor_id = chủ (lấy từ phiên)');
    eq([detail.action, detail.reason, detail.source], ['ABANDON', 'USER_ABANDONED', 'OWNER'], 'detail: action=ABANDON, reason=USER_ABANDONED, source=OWNER');
    const s = await snap(r.id);
    eq([s.pr.status, s.pr.resolved_by, s.pr.last_reconcile_error, s.pr.user_id], ['FAILED', 'RECONCILER', 'USER_ABANDONED', u.id], 'payment_requests ngay sau abandon (chưa qua lượt quét): FAILED, resolved_by=RECONCILER, last_reconcile_error=USER_ABANDONED, user_id=chủ');
    ok(!!s.pr.resolved_at, 'resolved_at có giá trị');
    info(`audit: username=${e.username} route=${e.route} method=${e.method} status_code=${e.status_code} detail=${e.detail}`);
    ok(!/Bearer|eyJ/.test(JSON.stringify(e)), 'audit không chứa token/bí mật');

    // Nguyên tử: ép INSERT audit lỗi
    const dropTrigger = async () => {
      if (db.dialect === 'pg') await db.exec('DROP TRIGGER IF EXISTS trg_test_block_abandon_audit ON app.security_events; DROP FUNCTION IF EXISTS app.test_block_abandon_audit()');
      else await db.exec('DROP TRIGGER IF EXISTS trg_test_block_abandon_audit');
    };
    await dropTrigger();
    const f = await mkNew('c7f');
    const before = await snap(f.r.id); const ev0 = await allAbandonEvents(); const bal0 = await balance(f.u);
    if (db.dialect === 'pg') {
      await db.exec(`CREATE OR REPLACE FUNCTION app.test_block_abandon_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type = 'PAYPAL_REQUEST_ABANDONED' THEN RAISE EXCEPTION 'TEST_AUDIT_FAIL'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER trg_test_block_abandon_audit BEFORE INSERT ON app.security_events FOR EACH ROW EXECUTE FUNCTION app.test_block_abandon_audit()`);
    } else {
      await db.exec("CREATE TRIGGER trg_test_block_abandon_audit BEFORE INSERT ON security_events WHEN NEW.event_type = 'PAYPAL_REQUEST_ABANDONED' BEGIN SELECT RAISE(ABORT, 'TEST_AUDIT_FAIL'); END");
    }
    try {
      const bad = await abandon(PP, f.u, f.r.id);
      ok(bad.status >= 500, 'INSERT audit lỗi: API trả 5xx', `nhận ${bad.status} ${bad.body && bad.body.error}`);
      const mid = await snap(f.r.id);
      ok(mid.pr.status === 'PENDING' && mid.b.capture_state === 'READY', 'INSERT audit lỗi: request vẫn PENDING/READY (không đóng nửa vời)');
      ok(same(mid, before) && (await allAbandonEvents()) === ev0 && (await balance(f.u)) === bal0, 'INSERT audit lỗi: payment_requests/binding nguyên vẹn, không có hàng audit, ví không đổi');
      eq(mutations(f.r.orderId), 0, 'INSERT audit lỗi: không lệnh ghi tới provider');
    } finally { await dropTrigger(); }
    const retry = await abandon(PP, f.u, f.r.id);
    ok(isOk(retry, 'ABANDONED'), 'sau khi gỡ trigger: abandon lại thành công (ABANDONED)', `nhận ${retry.status}`);
    eq((await abandonEvents(f.u)).length, 1, 'sau retry: đúng một hàng audit');
  });

  // =====================================================================================================
  await runCase('C8', 'Hồi quy: lịch sử/chi tiết thấy FAILED, /me không gọi provider, xác minh fresh còn nguyên', async () => {
    const { u, r } = await mkNew('c8', { approve: true });
    const live = await mk(u, { amount: 12000 });                     // một request PENDING khác để kiểm /me, checkout
    const g0 = count('get');
    const meBefore = await call(PAY, '/me', { token: u.token });
    eq(count('get') - g0, 0, 'precond: /me khi còn request PENDING không gọi provider (đếm GET = 0)');
    ok(meBefore.status === 200 && meBefore.body.paymentRequests.some((p) => p.id === r.id && p.status === 'PENDING'), 'precond: /me thấy request PENDING');
    const ab = await abandon(PP, u, r.id);
    ok(isOk(ab, 'ABANDONED'), 'precond: abandon thành công', `nhận ${ab.status}`);
    const g1 = count('get');
    const me = await call(PAY, '/me', { token: u.token });
    eq(count('get') - g1, 0, '/me sau abandon: getOrder = 0 (F-05)');
    const row = me.body && me.body.paymentRequests && me.body.paymentRequests.find((p) => p.id === r.id);
    ok(me.status === 200 && row && row.status === 'FAILED' && row.stage === 'FAILED', '/me vẫn thấy request cũ ở trạng thái FAILED, stage FAILED', `nhận ${row && row.status}/${row && row.stage}`);
    ok(me.body.paymentRequests.some((p) => p.id === live.id && p.status === 'PENDING'), '/me vẫn thấy request PENDING khác');
    const detail = await call(PAY, '/' + r.id, { token: u.token });
    ok(detail.status === 200 && detail.body.status === 'FAILED' && detail.body.stage === 'FAILED' && detail.body.requestId === r.requestId, 'detail thấy request FAILED (stage FAILED, requestId cũ)', `nhận ${detail.status} ${detail.body && detail.body.status}`);
    const co = await call(PP, `/${live.id}/checkout`, { token: u.token });
    ok(co.status === 200 && co.body.stage === 'AWAITING_APPROVAL', 'checkout request PENDING: 200 AWAITING_APPROVAL');
    const g2 = count('get');
    await call(PP, `/${live.id}/checkout`, { token: u.token });
    eq(count('get') - g2, 1, 'checkout giữ xác minh fresh (đúng 1 GET provider)');
    // detail với gợi ý payer-action cần GET fresh (F-05)
    await db.prepare("UPDATE paypal_payment_bindings SET capture_state='UNKNOWN', capture_post_sent_at=?, capture_post_count=1, last_capture_error='PAYPAL_PAYER_ACTION_REQUIRED' WHERE payment_request_id=?").run(nowIso(), live.id);
    const g3 = count('get');
    const d2 = await call(PAY, '/' + live.id, { token: u.token });
    eq(count('get') - g3, 1, 'detail (UNKNOWN + payer-action) giữ xác minh fresh (1 GET)');
    ok(d2.status === 200 && d2.body.status === 'PENDING', 'detail PENDING 200');
    const g4 = count('get'); const meAgain = await call(PAY, '/me', { token: u.token });
    ok(count('get') === g4 && meAgain.body.paymentRequests.find((p) => p.id === live.id).stage === 'RECONCILING', '/me với UNKNOWN: không GET, stage RECONCILING (F-05)');
    // capture: preflight GET fresh
    const t0 = await mkNew('c8cap', { approve: true });
    const gc = count('get', t0.r.orderId);
    const cap = await call(PP, `/${t0.r.id}/capture`, { method: 'POST', token: t0.u.token, body: {} });
    ok(cap.status === 200 && cap.body.outcome === 'APPLIED' && count('get', t0.r.orderId) - gc >= 1, 'capture bình thường vẫn xác minh fresh (>=1 GET) rồi APPLIED');
    eq(count('capture', t0.r.orderId), 1, 'capture bình thường: đúng một POST');
  });

  // =====================================================================================================
  await runCase('C10', 'Review an toàn: replay bền (S3), NOT_CAPTURED + caller cũ (S2), order lệch (S5), claim sau close (S4), isolation (S8)', async () => {
    // S3: replay không phụ thuộc cột mutable last_reconcile_error
    const a = await mkNew('c10a');
    ok(isOk(await abandon(PP, a.u, a.r.id), 'ABANDONED'), 'S3 precond: abandon thành công');
    for (const v of [null, 'SOME_OTHER_ERROR']) {
      await db.prepare('UPDATE payment_requests SET last_reconcile_error=? WHERE id=?').run(v, a.r.id);
      const s1 = await snap(a.r.id); const ev = await allAbandonEvents(); const led = await cnt('SELECT COUNT(*) AS n FROM wallet_entries'); const pr = await cnt('SELECT COUNT(*) AS n FROM payment_requests');
      const again = await abandon(PP, a.u, a.r.id);
      ok(isOk(again, 'ALREADY_ABANDONED'), `S3: đối soát ghi đè last_reconcile_error=${v}: abandon lại vẫn 200 ALREADY_ABANDONED (nguồn bền là security_events)`, `nhận ${again.status} ${again.body && (again.body.outcome || again.body.error)}`);
      ok(same(await snap(a.r.id), s1) && (await allAbandonEvents()) === ev && (await cnt('SELECT COUNT(*) AS n FROM wallet_entries')) === led && (await cnt('SELECT COUNT(*) AS n FROM payment_requests')) === pr, `S3 (${v}): không thêm audit/dữ liệu, không đổi hàng`);
    }
    const rec = await rtShort.reconcileOne(a.r.id).then((x) => x, (e) => ({ err: e.code }));
    const again2 = await abandon(PP, a.u, a.r.id);
    ok(isOk(again2, 'ALREADY_ABANDONED'), 'S3: sau reconcileOne theo id vẫn ALREADY_ABANDONED', `reconcile=${JSON.stringify(rec)}`);
    // FAILED lý do khác, KHÔNG audit -> 409 PAYPAL_ABANDON_UNSAFE (kể cả khi lý do chữ giống USER_ABANDONED)
    for (const reason of ['ORDER_EXPIRED', 'USER_ABANDONED']) {
      const o = await mkNew('c10b');
      ok((await rtShort.store.closeUncaptured(o.r.id, { nowIso: nowIso(), reason })).closed === true, `S3 precond: FAILED reason=${reason} bằng closeUncaptured cũ, không có audit`);
      const so = await snap(o.r.id); const ev = await allAbandonEvents();
      const res = await abandon(PP, o.u, o.r.id);
      ok(res.status === 409 && res.body.error === 'PAYPAL_ABANDON_UNSAFE', `S3: FAILED reason=${reason} không có hàng audit: 409 PAYPAL_ABANDON_UNSAFE`, `nhận ${res.status} ${res.body && (res.body.error || res.body.outcome)}`);
      ok(same(await snap(o.r.id), so) && (await allAbandonEvents()) === ev, `S3 (${reason}): không đổi, không audit`);
    }
    // S2: NOT_CAPTURED không abandon được dù closeUncaptured cũ chấp nhận; caller cũ giữ nguyên hành vi
    const n = await mkNew('c10n');
    const c = await claim(n.r); await rtShort.store.markCapturePostSent(n.r.id, c.claimId);
    ok((await rtShort.store.finishCaptureAttempt(n.r.id, c.claimId, { state: 'NOT_CAPTURED', evidence: 'ORDER_VOIDED' })).ok, 'S2 precond: NOT_CAPTURED dựng qua store.finishCaptureAttempt(ORDER_VOIDED)');
    const sn = await snap(n.r.id); const g0 = count('get', n.r.orderId);
    const rn = await abandon(PP, n.u, n.r.id);
    ok(rn.status === 409 && count('get', n.r.orderId) === g0 && same(await snap(n.r.id), sn), 'S2: NOT_CAPTURED PENDING: abandon 409, không GET, không đổi');
    const oldNc = await rtShort.store.closeUncaptured(n.r.id, { nowIso: nowIso(), reason: 'ORDER_VOIDED' });
    ok(oldNc.closed === true, 'S2: closeUncaptured kiểu cũ vẫn đóng được NOT_CAPTURED (caller cũ không đổi)');
    const old = await mkNew('c10old');
    const oc = await rtShort.store.closeUncaptured(old.r.id, { nowIso: nowIso(), reason: 'ORDER_EXPIRED' });
    const so = await snap(old.r.id);
    ok(oc.closed === true && so.pr.status === 'FAILED' && so.pr.resolved_by === 'RECONCILER' && so.pr.last_reconcile_error === 'ORDER_EXPIRED', 'S2: closeUncaptured(READY, ORDER_EXPIRED) cũ: FAILED, resolved_by=RECONCILER, last_reconcile_error=ORDER_EXPIRED');
    eq(await allAbandonEvents() >= 0 && (await db.prepare("SELECT COUNT(*) AS n FROM security_events WHERE event_type='PAYPAL_REQUEST_ABANDONED' AND actor_id=?").get(old.u.id)).n * 1, 0, 'S2: caller cũ không sinh audit ABANDONED');
    // S5: binding.order_id bất biến sau khi gắn nên không dựng được "order_id lệch" qua DB; tương đương: provider trả order id khác
    const m = await mkNew('c10m');
    fake.tamper(m.r.orderId, { id: 'ORD-DIFFERENT' });
    const sm = await snap(m.r.id);
    const rm = await abandon(PP, m.u, m.r.id);
    ok(rm.status === 409 && same(await snap(m.r.id), sm), 'S5: order GET được mang id khác binding: 409, không đóng (order_id trong binding bất biến nên chỉ dựng được phía provider)');
    // S4: sau abandon, claim/POST mark không tạo gì
    const z = await mkNew('c10z', { approve: true });
    ok(isOk(await abandon(PP, z.u, z.r.id), 'ABANDONED'), 'S4 precond: đã abandon');
    const cl = await rtShort.store.claimCapture(z.r.id, z.u.id, uuid(), nowIso(), cutoff());
    ok(cl.outcome === 'CLOSED', 'S4: claimCapture trên request FAILED: outcome CLOSED', `nhận ${cl.outcome}`);
    // (markCapturePostSent với claim ĐÚNG trên request FAILED nằm ở C11(c); claim uuid() ngẫu nhiên vô hiệu nên đã bỏ.)
    const bz = (await snap(z.r.id)).b;
    ok(!bz.capture_claim && !bz.capture_post_sent_at && Number(bz.capture_attempts) === 0 && Number(bz.capture_post_count) === 0 && bz.capture_state === 'READY', 'S4: không có claim, không dấu POST, attempts/post_count = 0');
    // Hợp đồng audit của store.closeUncaptured: chỉ nhận INSERT_SQL chuẩn + 9 tham số
    {
      const { INSERT_SQL, buildSecurityEventInsert } = require('../src/lib/securityEvents');
      const good = buildSecurityEventInsert(null, { type: 'PAYPAL_REQUEST_ABANDONED', outcome: 'ALLOWED', actorId: null, detail: { action: 'ABANDON' } });
      const bads = [['sql lạ', { sql: "INSERT INTO security_events (event_type) VALUES ('X')", params: good.params }],
        ['params thiếu', { sql: INSERT_SQL, params: good.params.slice(0, 8) }], ['params thừa', { sql: INSERT_SQL, params: [...good.params, 'x'] }],
        ['params không phải mảng', { sql: INSERT_SQL, params: 'x' }]];
      for (const [label, audit] of bads) {
        const w = await mkNew('c10v');
        const sw = await snap(w.r.id); const ev = await cnt('SELECT COUNT(*) AS n FROM security_events');
        const err = await rtShort.store.closeUncaptured(w.r.id, { nowIso: nowIso(), reason: 'USER_ABANDONED', audit }).then(() => null, (e) => e);
        ok(err && err.code === 'VALIDATION_ERROR' && (err.status === 400 || err.statusCode === 400), `closeUncaptured audit ${label}: 400 VALIDATION_ERROR`, `nhận ${err && err.code}`);
        ok(same(await snap(w.r.id), sw) && (await cnt('SELECT COUNT(*) AS n FROM security_events')) === ev, `audit ${label}: request không đóng, không hàng security_events mới`);
      }
    }
    // S8: thông tin isolation
    if (db.dialect === 'pg') {
      const iso = await db.prepare('SHOW transaction_isolation').get();
      info(`S8: PostgreSQL transaction_isolation = ${iso && (iso.transaction_isolation || JSON.stringify(iso))} (kỳ vọng read committed; không assert cứng)`);
    } else info('S8: SQLite — không áp dụng transaction_isolation');
  });

  await runCase('C4d', 'Race barrier: capture đã claim nhưng CHƯA ghi dấu POST (preflight GET treo) khi thả close -> close KHÔNG thắng', async () => {
    const { u, r } = await mkNew('c4d', { approve: true });
    const g = { orderId: r.orderId, need: 1, arrived: 0, hit: defer(), release: defer() };
    gate.armed = g;
    const inj = { get: null, getArrived: defer(), getRelease: defer() };
    try {
      const abP = abandon(LP, u, r.id);
      const first = await Promise.race([g.hit.promise.then(() => 'hit'), abP.then(() => 'done'), sleep(10000).then(() => 'timeout')]);
      ok(first === 'hit', 'precond: abandon đã GET xong, đứng ở barrier', `kết quả ${first}`);
      if (first !== 'hit') { g.release.resolve(); await abP; return; }
      inj.get = 'hold'; inject[r.orderId] = inj;       // từ giờ GET kế tiếp (preflight của capture) bị giữ ở transport
      const capP = call(LP, `/${r.id}/capture`, { method: 'POST', token: u.token, body: {} });
      const arrived = await Promise.race([inj.getArrived.promise.then(() => 'arrived'), capP.then(() => 'done'), sleep(10000).then(() => 'timeout')]);
      ok(arrived === 'arrived', 'precond: capture đã claim và đang treo ở preflight GET', `kết quả ${arrived}`);
      const mid = await snap(r.id);
      ok(mid.b.capture_state === 'IN_FLIGHT' && !!mid.b.capture_claim && !mid.b.capture_post_sent_at && count('capture', r.orderId) === 0, 'precond: DB IN_FLIGHT có claim, CHƯA có capture_post_sent_at, chưa POST');
      g.release.resolve();
      const ab = await abP;
      ok(ab.status === 409 && ab.body.error === 'PAYPAL_ABANDON_UNSAFE', 'thả close khi capture đã claim (chưa POST): 409 PAYPAL_ABANDON_UNSAFE', `nhận ${ab.status} ${ab.body && ab.body.error}`);
      eq((await snap(r.id)).pr.status, 'PENDING', 'close thua: request vẫn PENDING');
      inj.getRelease.resolve();
      const cap = await capP;
      ok(cap.status === 200 && cap.body.outcome === 'APPLIED', 'capture tiếp tục và APPLIED', `nhận ${cap.status} ${cap.body && cap.body.outcome}`);
      eq([count('capture', r.orderId), (await H.credits(db, r.id)).length, (await abandonEvents(u)).length], [1, 1, 0], '1 POST, 1 credit, 0 audit');
    } finally { gate.armed = null; g.release.resolve(); inj.getRelease.resolve(); delete inject[r.orderId]; }
  });

  await runCase('C4e', 'Race barrier: capture claim rồi trả READY (order chưa duyệt, chưa POST) giữa GET và close -> close hợp lệ thắng, không POST', async () => {
    const { u, r } = await mkNew('c4e');            // KHÔNG approve: coordinator thấy chưa APPROVED, không POST, trả READY
    const g = { orderId: r.orderId, need: 1, arrived: 0, hit: defer(), release: defer() };
    gate.armed = g;
    try {
      const abP = abandon(LP, u, r.id);
      const first = await Promise.race([g.hit.promise.then(() => 'hit'), abP.then(() => 'done'), sleep(10000).then(() => 'timeout')]);
      ok(first === 'hit', 'precond: abandon đã GET xong, đứng ở barrier', `kết quả ${first}`);
      if (first !== 'hit') { g.release.resolve(); await abP; return; }
      const cap = await call(LP, `/${r.id}/capture`, { method: 'POST', token: u.token, body: {} });
      ok(cap.status === 200 && cap.body.outcome === 'AWAITING_APPROVAL', 'precond: capture claim rồi trả AWAITING_APPROVAL (không POST)', `nhận ${cap.status} ${cap.body && cap.body.outcome}`);
      const mid = await snap(r.id);
      ok(mid.b.capture_state === 'READY' && !mid.b.capture_claim && !mid.b.capture_post_sent_at && Number(mid.b.capture_attempts) === 1 && count('capture', r.orderId) === 0, 'precond: DB trở lại READY, không claim, không POST, capture_attempts=1');
      g.release.resolve();
      const ab = await abP;
      ok(isOk(ab, 'ABANDONED'), 'thả close: vẫn đóng được (chưa từng POST, không claim): 200 ABANDONED', `nhận ${ab.status} ${ab.body && ab.body.error}`);
      const end = await snap(r.id);
      ok(end.pr.status === 'FAILED' && end.b.capture_state === 'READY' && Number(end.b.capture_attempts) === 1 && !end.b.capture_post_sent_at, 'bằng chứng capture giữ nguyên (attempts=1 không bị reset)');
      eq([count('capture', r.orderId), (await abandonEvents(u)).length], [0, 1], '0 POST capture, 1 audit');
    } finally { gate.armed = null; g.release.resolve(); }
  });

  await runCase('C11', 'Guard chiều sâu Ở STORE (gọi thẳng store, fixture DB): onlyNeverPosted, expectedOrderId, markCapturePostSent trên request FAILED', async () => {
    const st = rtShort.store;
    // (a) onlyNeverPosted
    const a = await mkNew('c11a');
    await db.prepare('UPDATE paypal_payment_bindings SET capture_claim=?, capture_claimed_at=? WHERE payment_request_id=?').run(uuid(), nowIso(), a.r.id);
    const sa = await snap(a.r.id);
    const ra = await st.closeUncaptured(a.r.id, { nowIso: nowIso(), reason: 'X_TEST', onlyNeverPosted: true });
    ok(ra.closed === false && same(await snap(a.r.id), sa), '(a) READY còn capture_claim + onlyNeverPosted:true: closed:false, không đổi', JSON.stringify(ra));
    const ra2 = await st.closeUncaptured(a.r.id, { nowIso: nowIso(), reason: 'X_TEST' });
    ok(ra2.closed === false && same(await snap(a.r.id), sa), '(a) READY còn claim, gọi kiểu cũ: cũng closed:false (không đóng khi còn claim)', JSON.stringify(ra2));
    const ctl = await mkNew('c11ctl');
    ok((await st.closeUncaptured(ctl.r.id, { nowIso: nowIso(), reason: 'X_TEST', onlyNeverPosted: true })).closed === true, '(a) đối chứng: READY sạch + onlyNeverPosted:true đóng được');
    const nc = await mkNew('c11nc');
    const c1 = await claim(nc.r); await st.markCapturePostSent(nc.r.id, c1.claimId);
    ok((await st.finishCaptureAttempt(nc.r.id, c1.claimId, { state: 'NOT_CAPTURED', evidence: 'ORDER_VOIDED' })).ok, '(a) precond: NOT_CAPTURED qua store');
    const snc = await snap(nc.r.id);
    const rnc = await st.closeUncaptured(nc.r.id, { nowIso: nowIso(), reason: 'X_TEST', onlyNeverPosted: true });
    ok(rnc.closed === false && same(await snap(nc.r.id), snc), '(a) NOT_CAPTURED + onlyNeverPosted:true: closed:false, không đổi', JSON.stringify(rnc));
    const rnc2 = await st.closeUncaptured(nc.r.id, { nowIso: nowIso(), reason: 'ORDER_VOIDED' });
    ok(rnc2.closed === true && (await snap(nc.r.id)).pr.status === 'FAILED', '(a) hồi quy caller cũ: NOT_CAPTURED gọi kiểu cũ (không onlyNeverPosted) vẫn đóng được');
    // (b) expectedOrderId
    const b = await mkNew('c11b');
    const sb = await snap(b.r.id);
    const rb = await st.closeUncaptured(b.r.id, { nowIso: nowIso(), reason: 'X_TEST', expectedOrderId: 'ORD-NOT-BOUND' });
    ok(rb.closed === false && rb.reason === 'ORDER_CHANGED' && same(await snap(b.r.id), sb), '(b) expectedOrderId khác order_id đang bind: {closed:false, reason:ORDER_CHANGED}, không đổi', JSON.stringify(rb));
    const rb2 = await st.closeUncaptured(b.r.id, { nowIso: nowIso(), reason: 'X_TEST', expectedOrderId: b.r.orderId });
    ok(rb2.closed === true, '(b) expectedOrderId đúng: closed:true', JSON.stringify(rb2));
    // (c) markCapturePostSent với claim ĐÚNG nhưng payment_requests.status='FAILED'
    const c = await mkNew('c11c');
    const cc = await claim(c.r);
    ok(cc.outcome === 'CLAIMED', '(c) precond: binding IN_FLIGHT với claim X');
    await db.prepare("UPDATE payment_requests SET status='FAILED' WHERE id=?").run(c.r.id);   // fixture DB (không bị trigger cản, như paypal-m2-settlement T6)
    const sc0 = await snap(c.r.id);
    ok(sc0.pr.status === 'FAILED' && sc0.b.capture_state === 'IN_FLIGHT' && !sc0.b.capture_post_sent_at, '(c) precond: request FAILED, binding IN_FLIGHT, capture_post_sent_at NULL');
    const mp = await st.markCapturePostSent(c.r.id, cc.claimId);
    const sc1 = await snap(c.r.id);
    ok(mp.ok === false && sc1.b.capture_post_sent_at === null && Number(sc1.b.capture_post_count) === 0, '(c) markCapturePostSent với claim ĐÚNG trên request FAILED: ok:false, capture_post_sent_at vẫn NULL, post_count=0', JSON.stringify(mp));
    const c2 = await mkNew('c11c2');
    const cc2 = await claim(c2.r);
    ok((await st.markCapturePostSent(c2.r.id, cc2.claimId)).ok === true && !!(await snap(c2.r.id)).b.capture_post_sent_at, '(c) đối chứng: cùng thao tác trên request PENDING: ok:true và có dấu POST');
    // (d) claimCapture trên FAILED: CLOSED; EXISTS(pr.status) trong UPDATE của claimCapture KHÔNG tới được qua API store
    const d = await mkNew('c11d');
    await st.closeUncaptured(d.r.id, { nowIso: nowIso(), reason: 'X_TEST' });
    const cd = await st.claimCapture(d.r.id, d.u.id, uuid(), nowIso(), cutoff());
    ok(cd.outcome === 'CLOSED' && !(await snap(d.r.id)).b.capture_claim, '(d) claimCapture trên request FAILED: CLOSED, không tạo claim');
    info('(d) điều kiện EXISTS pr.status trong UPDATE của claimCapture là phòng thủ chiều sâu: đã có nhánh CLOSED trong cùng transaction trước đó, nên không có ca nào bắt được qua API store; KHÔNG được báo là có phủ.');
  });

  // ---------------------------------------------------------------------------------------------------
  // R2: đường LÔ của worker (C12) và replay sau RECOVERY_REQUIRED (C13)
  const { reconcileOnce } = require('../src/lib/reconciler');
  const { createAbandonment } = require('../src/lib/paypalAbandonment');
  const FUTURE = '2999-01-01T00:00:00.000Z';
  const ago = (sec) => new Date(Date.now() - sec * 1000).toISOString();
  // Cô lập chặt: mọi request PayPal/MOCK khác bị đẩy ra created_at 2999 VÀ last_reconciled_at 2999 (không thoả created_at<=cutoff của nhóm PENDING,
  // cũng không thoả last_reconciled_at<=cutoff của nhóm abandon), nên không còn dòng sót nào chiếm SHARE hay làm sai số đếm.
  async function isolate(keepIds) {
    const q = keepIds.length ? `AND id NOT IN (${keepIds.map(() => '?').join(',')})` : '';
    await db.prepare(`UPDATE payment_requests SET created_at = ?, last_reconciled_at = ? WHERE provider IN ('PAYPAL_SANDBOX','MOCK') ${q}`).run(FUTURE, FUTURE, ...keepIds);
  }
  const batch = (limit = 10) => reconcileOnce({ minAgeSeconds: 0, limit, paypalRuntime: rtShort });
  const lateCap = async (orderId) => {
    fake.approve(orderId);
    return (await fake.fetchImpl(`${SANDBOX}/v2/checkout/orders/${orderId}/capture`, { method: 'POST', headers: { 'PayPal-Request-Id': 'late-' + orderId }, body: '{}' })).status;
  };
  const gets = (r) => count('get', r.orderId);
  async function abandoned(label) {
    const x = await mkNew(label);
    const ab = await abandon(PP, x.u, x.r.id);
    ok(isOk(ab, 'ABANDONED'), `precond: request ${label} đã USER_ABANDONED`, `nhận ${ab.status}`);
    return x;
  }

  await runCase('C12', 'Worker LÔ (reconcileOnce không paymentRequestId): quét dòng FAILED chưa-POST để bắt thu muộn', async () => {
    // (a) thu muộn, không webhook
    const A = await abandoned('c12a');
    await isolate([A.r.id]);
    eq(await lateCap(A.r.orderId), 201, 'precond: PayPal thu muộn (fake), KHÔNG webhook');
    const pa = await snap(A.r.id);
    ok(pa.pr.status === 'FAILED' && !pa.b.capture_post_sent_at && pa.b.capture_state === 'READY', 'precond: request FAILED, binding READY, chưa từng POST');
    const bal0 = await balance(A.u); const led0 = await ledger(A.u); const g0 = gets(A.r);
    const s1 = await batch();
    ok(s1.paypal && s1.paypal.recoveryRequired === 1, '(a) summary.paypal.recoveryRequired = 1 [ĐỎ trên HEAD: dòng FAILED chưa-POST không được chọn]', JSON.stringify(s1.paypal));
    const a1 = await snap(A.r.id);
    ok(a1.pr.status === 'FAILED' && a1.b.capture_state === 'RECOVERY_REQUIRED' && a1.b.capture_id === 'CAP' + A.r.orderId && !!a1.b.recovery_required_at, '(a) FAILED giữ nguyên, capture_state=RECOVERY_REQUIRED, capture_id lưu, recovery_required_at có');
    ok((await balance(A.u)) === bal0 && (await ledger(A.u)) === led0 && (await H.credits(db, A.r.id)).length === 0, '(a) ví và số hàng sổ cái KHÔNG đổi, không credit');
    ok(gets(A.r) - g0 >= 1, '(a) transport thấy GET order thật trong lượt lô');
    // (b) không quét lại dòng đã RECOVERY_REQUIRED
    const g1 = gets(A.r);
    const s2 = await batch();
    eq([gets(A.r) - g1, s2.paypal && s2.paypal.scanned], [0, 0], '(b) lượt lô thứ hai: không GET lại dòng RECOVERY_REQUIRED, scanned=0');

    // (c) cửa sổ
    const Wo = await abandoned('c12co'); const Wi = await abandoned('c12ci');
    await isolate([Wo.r.id, Wi.r.id]);
    await db.prepare('UPDATE payment_requests SET created_at=? WHERE id=?').run(ago(73 * 3600), Wo.r.id);
    await db.prepare('UPDATE payment_requests SET created_at=? WHERE id=?').run(ago(71 * 3600), Wi.r.id);
    const go = gets(Wo.r); const gi = gets(Wi.r);
    await batch();
    eq([gets(Wo.r) - go, gets(Wi.r) - gi], [0, 1], '(c) chỉ dòng trong cửa sổ 72h (now-71h) được quét; dòng now-73h không [ĐỎ trên HEAD: không dòng nào được chọn]');

    // (d) giãn cách RESCAN (900 s)
    const D = await abandoned('c12d');
    await isolate([D.r.id]);
    let gd = gets(D.r);
    await batch();
    eq(gets(D.r) - gd, 1, '(d) lần đầu (last_reconciled_at NULL): quét 1 lần [ĐỎ trên HEAD]');
    gd = gets(D.r); await batch();
    eq(gets(D.r) - gd, 0, '(d) vừa quét xong: KHÔNG quét lại trước RESCAN');
    await db.prepare('UPDATE payment_requests SET last_reconciled_at=? WHERE id=?').run(ago(600), D.r.id);
    gd = gets(D.r); await batch();
    eq(gets(D.r) - gd, 0, '(d) last_reconciled_at = now-600s (< 900s): vẫn không quét');
    await db.prepare('UPDATE payment_requests SET last_reconciled_at=? WHERE id=?').run(ago(1000), D.r.id);
    gd = gets(D.r); await batch();
    eq(gets(D.r) - gd, 1, '(d) last_reconciled_at = now-1000s (> 900s): quét lại');

    // (e) công bằng: PENDING không bị dòng đã đóng chiếm; nhóm abandon tối đa SHARE = max(1, floor(limit/5)), cũ nhất trước
    const P = []; for (let i = 0; i < 4; i++) P.push((await mkNew('c12p')).r);
    const M = []; for (let i = 1; i <= 6; i++) { const x = await abandoned('c12m'); M.push(x.r); }
    const mockId = uuid();
    await db.prepare("INSERT INTO payment_requests (id,user_id,amount,status,provider_ref,version,provider,created_at,updated_at) VALUES (?,?,10000,'PENDING',?,0,'MOCK',?,?)")
      .run(mockId, M[0].user.id, 'mock-ref-' + uuid(), ago(3600), ago(3600));
    await isolate([...P.map((x) => x.id), ...M.map((x) => x.id), mockId]);
    await db.prepare('UPDATE payment_requests SET created_at=? WHERE id=?').run(ago(3600), mockId);
    for (let i = 0; i < 6; i++) await db.prepare('UPDATE payment_requests SET last_reconciled_at=? WHERE id=?').run(ago(1000 + 100 * (i + 1)), M[i].id); // M[5] cũ nhất
    const scannedOf = (rows, before) => rows.map((r, i) => gets(r) - before[i] > 0);
    let bp = P.map(gets); let bm = M.map(gets);
    const e1 = await batch(5);
    ok(scannedOf(P, bp).every(Boolean), '(e) limit=5: TẤT CẢ 4 dòng PENDING đều được quét (không bị dòng đã đóng chiếm chỗ)');
    eq(scannedOf(M, bm), [false, false, false, false, false, true], '(e) limit=5 (SHARE=1): nhóm abandon quét đúng 1 dòng, là dòng last_reconciled_at cũ nhất [ĐỎ trên HEAD]');
    ok(!(e1.results || []).some((x) => x.id === mockId && x.provider === 'PAYPAL_SANDBOX'), '(e) dòng MOCK không bị nhóm PayPal đụng tới');
    bp = P.map(gets); bm = M.map(gets);
    await batch(10);
    ok(scannedOf(P, bp).every(Boolean), '(e) limit=10: 4 dòng PENDING vẫn đều được quét');
    eq(scannedOf(M, bm), [false, false, false, true, true, false], '(e) limit=10 (SHARE=2): quét đúng 2 dòng cũ nhất còn đủ giãn cách (M[4], M[3]); M[5] vừa quét nên bị giãn cách [ĐỎ trên HEAD]');
    eq((await snap(mockId)).pr.provider, 'MOCK', '(e) dòng MOCK vẫn là MOCK');

    // (f) FAILED đã POST: quy tắc cũ
    const F = await mkNew('c12f', { approve: true });
    const cf = await claim(F.r); await rtShort.store.markCapturePostSent(F.r.id, cf.claimId);
    await db.prepare("UPDATE payment_requests SET status='FAILED' WHERE id=?").run(F.r.id);   // fixture DB (như paypal-m2-settlement T6)
    await isolate([F.r.id]);
    await db.prepare('UPDATE paypal_payment_bindings SET capture_claim=NULL, capture_claimed_at=NULL, capture_state=? WHERE payment_request_id=?').run('UNKNOWN', F.r.id);
    ok((await snap(F.r.id)).b.capture_post_sent_at && (await snap(F.r.id)).pr.status === 'FAILED', 'precond: FAILED đã POST (UNKNOWN)');
    await lateCap(F.r.orderId);
    const sf = await batch();
    ok(sf.paypal && sf.paypal.recoveryRequired === 1 && (await snap(F.r.id)).b.capture_state === 'RECOVERY_REQUIRED', '(f) FAILED đã POST: vẫn được quét và chuyển RECOVERY_REQUIRED như quy tắc cũ', JSON.stringify(sf.paypal));

    // (g) lỗi provider khi quét dòng abandon
    for (const [mode, code] of [['timeout', 'PAYPAL_TIMEOUT'], ['drop', 'PAYPAL_UNAVAILABLE'], ['404', 'PAYPAL_API_ERROR']]) {
      const G = await abandoned('c12g');
      await isolate([G.r.id]);
      const bal = await balance(G.u); const gg = gets(G.r);
      inject[G.r.orderId] = { get: mode };
      let sg; let thrown = null;
      try { sg = await batch(); } catch (e) { thrown = e; } finally { delete inject[G.r.orderId]; }
      ok(!thrown, `(g) ${mode}: lượt lô không ném lỗi`, thrown && thrown.message);
      const s = await snap(G.r.id);
      ok(gets(G.r) - gg >= 1 && sg && sg.paypal.errors === 1, `(g) ${mode}: dòng abandon được quét (transport có GET) và đếm 1 lỗi [ĐỎ trên HEAD]`, sg && JSON.stringify(sg.paypal));
      ok(s.pr.status === 'FAILED' && (await H.credits(db, G.r.id)).length === 0 && (await balance(G.u)) === bal, `(g) ${mode}: request vẫn FAILED, không credit`);
      eq(s.pr.last_reconcile_error, code, `(g) ${mode}: lỗi được ghi (recordError) = ${code} [ĐỎ trên HEAD]`);
    }
  });

  await runCase('C13', 'Replay sau RECOVERY_REQUIRED: 409 PAYPAL_ABANDON_UNSAFE, giữ bằng chứng; nhánh thua race; replay thường vẫn 200', async () => {
    const paths = [
      ['store.markCaptureVerified', async (r) => rtShort.store.markCaptureVerified(r.id, 'CAP' + r.orderId)],
      ['webhook', async (r) => rtShort.webhook(hdr(), evt(r.orderId))],
      ['reconcileOne (worker)', async (r) => rtShort.reconcileOne(r.id)],
    ];
    for (const [label, run] of paths) {
      const { u, r } = await abandoned('c13a');
      await lateCap(r.orderId);
      const out = await run(r);
      const mid = await snap(r.id);
      ok(mid.b.capture_state === 'RECOVERY_REQUIRED' && mid.pr.status === 'FAILED', `(a/${label}) precond: RECOVERY_REQUIRED sau capture muộn`, JSON.stringify(out));
      const bal = await balance(u); const led = await ledger(u); const ev = await allAbandonEvents();
      const again = await abandon(PP, u, r.id);
      ok(again.status === 409 && again.body.error === 'PAYPAL_ABANDON_UNSAFE', `(a/${label}) abandon lại sau RECOVERY_REQUIRED: 409 PAYPAL_ABANDON_UNSAFE, KHÔNG 200 [ĐỎ trên HEAD: trả 200 ALREADY_ABANDONED]`, `nhận ${again.status} ${again.body && (again.body.outcome || again.body.error)}`);
      ok(same(await snap(r.id), mid) && (await balance(u)) === bal && (await ledger(u)) === led && (await allAbandonEvents()) === ev, `(a/${label}) evidence, ví, sổ cái, audit không đổi`);
    }
    // (b) nhánh thua race, dựng createAbandonment với store thật bọc mỏng
    const { u, r } = await mkNew('c13b');
    const row = await rtLong.store.loadByRequestId(r.id);
    const bArrived = defer(); const bRelease = defer();
    let lost = 0;
    const thin = { ...rtLong.store, closeUncaptured: async (id, o) => {
      const res = await rtLong.store.closeUncaptured(id, o);
      if (res.closed === false) { lost++; bArrived.resolve(); await bRelease.promise; }
      return res;
    } };
    const svc = createAbandonment({ store: thin, provider: providerLong, db, serialize: (id, o) => rtLong.serializePayPal(id, o) });
    const fakeReq = { user: { id: u.id, username: u.username }, method: 'POST', baseUrl: '/api/payments/paypal', route: { path: '/:id/abandon' }, path: `/${r.id}/abandon`, ip: '127.0.0.1' };
    const g = { orderId: r.orderId, need: 2, arrived: 0, hit: defer(), release: defer() };
    gate.armed = g;
    const settle = (p) => p.then((v) => ({ v }), (e) => ({ e }));
    try {
      const p1 = settle(svc.abandon(row, { req: fakeReq, nowIso: nowIso() })); const p2 = settle(svc.abandon(row, { req: fakeReq, nowIso: nowIso() }));
      const first = await Promise.race([g.hit.promise.then(() => 'hit'), Promise.all([p1, p2]).then(() => 'done'), sleep(10000).then(() => 'timeout')]);
      ok(first === 'hit', '(b) precond: cả hai lời gọi abandon đã GET xong và cùng đứng ở barrier', `kết quả ${first}`);
      g.release.resolve();
      const arrived = await Promise.race([bArrived.promise.then(() => 'arrived'), sleep(10000).then(() => 'timeout')]);
      ok(arrived === 'arrived' && lost === 1, '(b) precond: bên thua (closed:false) đã tới barrier và đang bị giữ', `kết quả ${arrived}, lost=${lost}`);
      const states = await Promise.race([Promise.all([p1, p2]).then(() => 'both-done'), sleep(300).then(() => 'one-held')]);
      eq(states, 'one-held', '(b) precond: bên thua vẫn bị giữ (chưa trả kết quả)');
      const w = await snap(r.id);
      ok(w.pr.status === 'FAILED' && (await abandonEvents(u)).length === 1, '(b) precond: bên thắng đã đóng FAILED với đúng 1 audit');
      await lateCap(r.orderId);
      const rec = await rtLong.store.markCaptureVerified(r.id, 'CAP' + r.orderId);
      const afterRec = await snap(r.id);
      ok(rec.outcome === 'RECOVERY_REQUIRED' && afterRec.b.capture_state === 'RECOVERY_REQUIRED' && afterRec.b.capture_id === 'CAP' + r.orderId, '(b) precond: recovery đã được lưu TRƯỚC khi thả bên thua', JSON.stringify(rec));
      const bal = await balance(u); const led = await ledger(u);
      bRelease.resolve();
      const [x1, x2] = await Promise.all([p1, p2]);
      const winner = [x1, x2].find((x) => x.v && x.v.outcome === 'ABANDONED'); const loser = [x1, x2].find((x) => x !== winner);
      ok(!!winner, '(b) một bên trả ABANDONED');
      ok(loser && loser.e && loser.e.status === 409 && loser.e.code === 'PAYPAL_ABANDON_UNSAFE', '(b) bên thua sau khi có recovery: 409 PAYPAL_ABANDON_UNSAFE, KHÔNG ALREADY_ABANDONED [ĐỎ trên HEAD]', loser && JSON.stringify(loser.v ? { outcome: loser.v.outcome } : { code: loser.e && loser.e.code }));
      ok(same(await snap(r.id), afterRec) && (await balance(u)) === bal && (await ledger(u)) === led && (await abandonEvents(u)).length === 1, '(b) evidence, ví, sổ cái giữ nguyên; vẫn đúng 1 audit');
    } finally { gate.armed = null; g.release.resolve(); bRelease.resolve(); }
    // (c) hồi quy: replay thường (không có bằng chứng thu)
    const n = await abandoned('c13c');
    const sn = await snap(n.r.id);
    const rn = await abandon(PP, n.u, n.r.id);
    ok(isOk(rn, 'ALREADY_ABANDONED') && same(await snap(n.r.id), sn), '(c) replay thường (không có capture): vẫn 200 ALREADY_ABANDONED, không đổi', `nhận ${rn.status} ${rn.body && (rn.body.outcome || rn.body.error)}`);
  });

  await runCase('C17', 'Codex: recovery between final binding read and DTO serialization', async () => {
    const {u,r}=await abandoned('codex-c17');
    const row=await rtLong.store.loadByRequestId(r.id);
    const arrived=defer(),release=defer();
    let held=false;
    const svc=createAbandonment({store:rtLong.store,provider:providerLong,db,serialize:async(id,o)=>{
      held=true;arrived.resolve();await release.promise;return rtLong.serializePayPal(id,o);
    }});
    const pending=svc.abandon(row,{req:{user:{id:u.id},method:'POST',ip:'127.0.0.1'},nowIso:nowIso()}).then(v=>({v}),e=>({e}));
    try {
      const at=await Promise.race([arrived.promise.then(()=>true),pending.then(()=>false),sleep(5000).then(()=>false)]);
      ok(at && held,'C17 precondition: replay passed fresh binding check and waits before serialize');
      if(!at)return;
      const balanceBefore=await balance(u),ledgerBefore=await ledger(u);
      await lateCap(r.orderId);
      const rec=await rtLong.store.markCaptureVerified(r.id,'CAP'+r.orderId);
      ok(rec.outcome==='RECOVERY_REQUIRED','C17 precondition: recovery persisted before DTO read');
      release.resolve();const result=await pending;
      ok(result.e && result.e.status===409 && result.e.code==='PAYPAL_ABANDON_UNSAFE','C17 must refuse replay when final DTO shows recovery',JSON.stringify(result.v || {code:result.e && result.e.code}));
      ok((await balance(u))===balanceBefore && (await ledger(u))===ledgerBefore,'C17 preserves wallet and ledger');
    } finally {release.resolve();await pending;}
  });

  await runCase('C14', 'R2b: replay 409 khi bằng chứng xung đột/VERIFIED cũ; cột last_reconcile_error không phải nguồn; thứ tự và biên của nhóm quét abandon', async () => {
    // (1) CAPTURE_ID_CONFLICT trên request đã abandon: A giữ lastError CONFLICTING_CAPTURE, state READY, capture_id NULL
    const A = await abandoned('c14a');
    const B = await mkNew('c14b', { approve: true });
    const capB = await call(PP, `/${B.r.id}/capture`, { method: 'POST', token: B.u.token, body: {} });
    ok(capB.status === 200 && capB.body.outcome === 'APPLIED', '(1) precond: request B khác đã giữ capture_id X (capture thật)');
    const X = (await snap(B.r.id)).b.capture_id;
    const cf = await rtShort.store.markCaptureVerified(A.r.id, X);
    const a0 = await snap(A.r.id);
    ok(cf.ok === false && cf.reason === 'CAPTURE_ID_CONFLICT', '(1) precond: markCaptureVerified(A, X) = CAPTURE_ID_CONFLICT', JSON.stringify(cf));
    ok(a0.b.capture_state === 'READY' && a0.b.capture_id === null && a0.b.recovery_required_at === null && /^CONFLICTING_CAPTURE:/.test(a0.b.last_capture_error || ''), '(1) precond: A vẫn READY, capture_id NULL, recovery_required_at NULL, last_capture_error CONFLICTING_CAPTURE:...');
    const balA = await balance(A.u); const ledA = await ledger(A.u); const evA = await allAbandonEvents();
    const again = await abandon(PP, A.u, A.r.id);
    ok(again.status === 409 && again.body.error === 'PAYPAL_ABANDON_UNSAFE', '(1) abandon lại khi capture.lastError=CONFLICTING_CAPTURE: 409 PAYPAL_ABANDON_UNSAFE [ĐỎ trên HEAD: trả 200]', `nhận ${again.status} ${again.body && (again.body.outcome || again.body.error)}`);
    ok(same(await snap(A.r.id), a0) && (await balance(A.u)) === balA && (await ledger(A.u)) === ledA && (await allAbandonEvents()) === evA, '(1) bằng chứng, ví, sổ cái, audit không đổi');

    // (2) VERIFIED cũ trên request FAILED (persistLegacyRecovery): fixture DB (dữ liệu legacy), có audit abandon từ trước
    const V = await abandoned('c14v');
    await db.prepare("UPDATE paypal_payment_bindings SET capture_state='VERIFIED', capture_id=?, capture_verified_at=? WHERE payment_request_id=?").run('CAPLEG' + V.r.id, nowIso(), V.r.id);
    const lv = await rtShort.store.markCaptureVerified(V.r.id, 'CAPLEG' + V.r.id);
    const v0 = await snap(V.r.id);
    ok(lv.outcome === 'RECOVERY_REQUIRED' && v0.b.capture_state === 'VERIFIED' && !!v0.b.recovery_required_at && v0.b.last_capture_error === 'CAPTURED_AFTER_REQUEST_CLOSED', '(2) precond (fixture DB): VERIFIED cũ trên request FAILED + recovery_required_at + CAPTURED_AFTER_REQUEST_CLOSED', JSON.stringify(lv));
    const balV = await balance(V.u); const evV = await allAbandonEvents();
    const rv = await abandon(PP, V.u, V.r.id);
    ok(rv.status === 409 && rv.body.error === 'PAYPAL_ABANDON_UNSAFE', '(2) abandon lại với VERIFIED cũ trên FAILED: 409 PAYPAL_ABANDON_UNSAFE [ĐỎ trên HEAD: trả 200]', `nhận ${rv.status} ${rv.body && (rv.body.outcome || rv.body.error)}`);
    ok(same(await snap(V.r.id), v0) && (await balance(V.u)) === balV && (await allAbandonEvents()) === evV, '(2) bằng chứng/ví/audit không đổi');

    // (3) cột last_reconcile_error bị ghi đè bởi lượt quét LỖI: replay vẫn dựa vào audit
    const E = await abandoned('c14e');
    await isolate([E.r.id]);
    eq((await snap(E.r.id)).pr.last_reconcile_error, 'USER_ABANDONED', '(3) precond: ngay sau abandon (chưa qua lượt quét) cột = USER_ABANDONED');
    inject[E.r.orderId] = { get: 'timeout' };
    try { await batch(); } finally { delete inject[E.r.orderId]; }
    info(`(3) sau lượt quét LỖI cột last_reconcile_error = ${(await snap(E.r.id)).pr.last_reconcile_error} (có thể bị ghi đè bằng mã lỗi; USER_ABANDONED chỉ đảm bảo khi chưa quét hoặc quét thành công theo backend)`);
    await db.prepare("UPDATE payment_requests SET last_reconcile_error='PAYPAL_TIMEOUT' WHERE id=?").run(E.r.id);     // đảm bảo ghi đè, bất kể backend
    const se = await snap(E.r.id); const evE = await allAbandonEvents();
    const re = await abandon(PP, E.u, E.r.id);
    ok(isOk(re, 'ALREADY_ABANDONED') && same(await snap(E.r.id), se) && (await allAbandonEvents()) === evE, '(3) cột đã bị ghi đè bằng mã lỗi nhưng chưa có bằng chứng thu: replay vẫn 200 ALREADY_ABANDONED nhờ audit, không thêm dữ liệu', `nhận ${re.status} ${re.body && (re.body.outcome || re.body.error)}`);

    // (4) thứ tự quét theo chính sách hiệu dụng ORDER BY COALESCE(last_reconciled_at, created_at) ASC ("nhìn lần cuối hoặc tạo, cái nào sớm hơn đi trước").
    // Mục tiêu: NULL không bị xếp cuối theo từng loại DB. Kỳ vọng "NULL luôn đứng trước" ban đầu mạnh hơn yêu cầu; Pro đã đính chính (sửa kỳ vọng, không phải lỗi sản phẩm).
    const orderOfGets = async (rows, limit) => {
      const mark = net.length;
      await batch(limit);
      const seq = [];
      for (const e of net.slice(mark)) if (e.kind === 'get' && rows.some((x) => x.r.orderId === e.orderId) && !seq.includes(e.orderId)) seq.push(e.orderId);
      return seq.map((id) => rows.findIndex((x) => x.r.orderId === id));
    };
    {
      // (i) dòng NULL có created_at CŨ HƠN thời điểm quét của các dòng kia -> được GET ĐẦU TIÊN (NULL không bị đẩy cuối)
      const O = [await abandoned('c14o1'), await abandoned('c14o2'), await abandoned('c14o3')];
      await isolate(O.map((x) => x.r.id));
      await db.prepare('UPDATE payment_requests SET created_at=? WHERE id=?').run(ago(9000), O[0].r.id);                 // NULL, tạo từ now-9000s
      await db.prepare('UPDATE payment_requests SET last_reconciled_at=? WHERE id=?').run(ago(5000), O[1].r.id);
      await db.prepare('UPDATE payment_requests SET last_reconciled_at=? WHERE id=?').run(ago(1500), O[2].r.id);
      ok((await snap(O[0].r.id)).pr.last_reconciled_at === null, '(4i) precond: dòng O0 có last_reconciled_at NULL');
      eq(await orderOfGets(O, 25), [0, 1, 2], `(4i) NULL (created now-9000s) được GET trước dòng quét now-5000s rồi now-1500s [${db.dialect}]`);
      // (ii) dòng NULL có created_at MỚI hơn thời điểm quét của dòng khác -> đứng SAU dòng đó (chính sách hiệu dụng COALESCE)
      const Q = [await abandoned('c14q1'), await abandoned('c14q2')];
      await isolate(Q.map((x) => x.r.id));
      await db.prepare('UPDATE payment_requests SET last_reconciled_at=? WHERE id=?').run(ago(3000), Q[1].r.id);          // Q0 NULL, created ~now; Q1 quét now-3000s
      eq(await orderOfGets(Q, 25), [1, 0], `(4ii) NULL tạo gần đây đứng SAU dòng đã quét now-3000s (chính sách hiệu dụng: lần nhìn cuối hoặc tạo, cái nào sớm hơn đi trước) [${db.dialect}]`);
      info(`(4iii) thứ tự GET tin cậy trên ${db.dialect}: (i) [0,1,2], (ii) [1,0]; so sánh chéo SQLite/PG qua hai log`);
    }

    // (5) biên cửa sổ và RESCAN
    const W = [await abandoned('c14w1'), await abandoned('c14w2'), await abandoned('c14w3'), await abandoned('c14w4')];
    await isolate(W.map((x) => x.r.id));
    await db.prepare('UPDATE payment_requests SET created_at=? WHERE id=?').run(ago(72 * 3600 - 10), W[0].r.id);   // trong cửa sổ 10s
    await db.prepare('UPDATE payment_requests SET created_at=? WHERE id=?').run(ago(72 * 3600 + 10), W[1].r.id);   // ngoài cửa sổ 10s
    await db.prepare('UPDATE payment_requests SET last_reconciled_at=? WHERE id=?').run(ago(900 - 10), W[2].r.id); // chưa đủ giãn cách 10s
    await db.prepare('UPDATE payment_requests SET last_reconciled_at=? WHERE id=?').run(ago(900 + 10), W[3].r.id); // đủ giãn cách 10s
    const bw = W.map((x) => gets(x.r));
    await batch(25);
    eq(W.map((x, i) => gets(x.r) - bw[i]), [1, 0, 0, 1], '(5) biên: created_at now-72h+10s quét, now-72h-10s không; last_reconciled_at now-890s không, now-910s có [ĐỎ trên HEAD]');
    // state không READY không bị quét
    const NR = [await abandoned('c14n1'), await abandoned('c14n2')];
    await isolate(NR.map((x) => x.r.id));
    await db.prepare("UPDATE paypal_payment_bindings SET capture_state='UNKNOWN' WHERE payment_request_id=?").run(NR[0].r.id);
    await db.prepare("UPDATE paypal_payment_bindings SET capture_state='IN_FLIGHT', capture_claim=?, capture_claimed_at=? WHERE payment_request_id=?").run(uuid(), nowIso(), NR[1].r.id);
    const bn = NR.map((x) => gets(x.r));
    await batch(25);
    eq(NR.map((x, i) => gets(x.r) - bn[i]), [0, 0], '(5) request FAILED có capture_state UNKNOWN/IN_FLIGHT (không READY) không bị nhóm abandon quét');
    // FAILED đã POST thuộc truy vấn cũ: không quét hai lần trong một lượt
    const FP = await mkNew('c14fp', { approve: true });
    const cfp = await claim(FP.r); await rtShort.store.markCapturePostSent(FP.r.id, cfp.claimId);
    await rtShort.store.finishCaptureAttempt(FP.r.id, cfp.claimId, { state: 'UNKNOWN', errorCode: 'X' });
    await db.prepare("UPDATE payment_requests SET status='FAILED' WHERE id=?").run(FP.r.id);   // fixture DB
    await isolate([FP.r.id]);
    const bf = gets(FP.r);
    const sfp = await batch(25);
    const ids = (sfp.results || []).filter((x) => x.provider === 'PAYPAL_SANDBOX').map((x) => x.id);
    eq([gets(FP.r) - bf, ids.filter((i) => i === FP.r.id).length], [1, 1], '(5) FAILED đã POST (truy vấn cũ): đúng 1 GET và 1 kết quả trong một lượt (không quét hai lần)');
  });

  await runCase('C15', 'R9/R10: theo id không kích hoạt nhóm quét mới; quét lô thành công không clearError dòng abandon', async () => {
    // R9
    const A = await abandoned('c15a'); const R = await abandoned('c15r');
    await isolate([A.r.id, R.r.id]);
    const gA = gets(A.r); const gR = gets(R.r);
    const [byId, lot] = await Promise.all([reconcileOnce({ minAgeSeconds: 0, limit: 10, paymentRequestId: A.r.id, paypalRuntime: rtShort }), batch(10)]);
    ok(byId.paypal && byId.paypal.abandonedScanned === 0, '(R9) reconcileOnce({paymentRequestId}) KHÔNG kích hoạt nhóm quét mới: abandonedScanned === 0 [ĐỎ trên HEAD: chưa có trường abandonedScanned]', JSON.stringify(byId.paypal));
    eq(byId.paypal && byId.paypal.scanned, 1, '(R9) theo id: hành vi cũ giữ nguyên (scanned=1, chọn theo id) [guard hồi quy: đạt cả trên HEAD]');
    ok(lot.paypal && lot.paypal.abandonedScanned >= 1, '(R9) lượt lô riêng cùng lúc vẫn quét nhóm mới (abandonedScanned >= 1) [ĐỎ trên HEAD]', JSON.stringify(lot.paypal));
    ok(gets(R.r) - gR >= 1 && gets(A.r) - gA >= 1, '(R9) transport: dòng R (chỉ qua lô) và dòng A (theo id) đều có GET thật [R: ĐỎ trên HEAD]');
    // R10
    const Z = await abandoned('c15z'); const P = await mkNew('c15p');
    await isolate([Z.r.id, P.r.id]);
    await db.prepare("UPDATE payment_requests SET last_reconcile_error='STALE_ERR' WHERE id=?").run(P.r.id);
    eq((await snap(Z.r.id)).pr.last_reconcile_error, 'USER_ABANDONED', '(R10) precond: dòng abandon có last_reconcile_error=USER_ABANDONED');
    const gz = gets(Z.r); const gp = gets(P.r);
    const s = await batch(10);
    ok(gets(Z.r) - gz >= 1 && gets(P.r) - gp >= 1, '(R10) precond: lượt lô quét thành công CẢ dòng abandon và dòng PENDING (provider trả PENDING, không thu) [dòng abandon: ĐỎ trên HEAD]', JSON.stringify(s.paypal));
    eq((await snap(Z.r.id)).pr.last_reconcile_error, 'USER_ABANDONED', '(R10) dòng abandon: sau quét thành công cột VẪN là USER_ABANDONED (không bị clearError) [guard mới; trên HEAD đạt vì không quét]');
    eq((await snap(P.r.id)).pr.last_reconcile_error, null, '(R10) dòng PENDING: vẫn bị clearError như cũ (STALE_ERR -> NULL) [guard hồi quy]');
    eq((await snap(Z.r.id)).pr.status, 'FAILED', '(R10) dòng abandon vẫn FAILED, không credit');
  });

  await runCase('C16', 'Hạn mức lô: số PENDING >= limit vẫn quét ĐÚNG limit dòng PENDING cũ nhất, SHARE abandon CỘNG THÊM NGOÀI hạn mức', async () => {
    // Có chủ ý: nhóm abandon (SHARE=max(1,floor(limit/5))) được cộng THÊM ngoài hạn mức của truy vấn PENDING cũ, nên tổng có thể > limit.
    for (const [limit, nP, nA, share] of [[5, 6, 2, 1], [10, 11, 3, 2]]) {
      const P = []; for (let i = 0; i < nP; i++) P.push((await mkNew('c16p')).r);
      const A = []; for (let i = 0; i < nA; i++) A.push((await abandoned('c16a')).r);
      await isolate([...P.map((x) => x.id), ...A.map((x) => x.id)]);
      for (let i = 0; i < nP; i++) await db.prepare('UPDATE payment_requests SET last_reconciled_at=? WHERE id=?').run(ago(8000 - 100 * i), P[i].id);   // P[0] cũ nhất ... P[nP-1] mới nhất
      for (let i = 0; i < nA; i++) await db.prepare('UPDATE payment_requests SET last_reconciled_at=? WHERE id=?').run(ago(3000 - 100 * i), A[i].id);   // A[0] cũ nhất, đều > RESCAN
      const bp = P.map(gets); const ba = A.map(gets);
      const s = await batch(limit);
      const sp = P.map((r, i) => gets(r) - bp[i] > 0); const sa = A.map((r, i) => gets(r) - ba[i] > 0);
      eq(sp, P.map((_, i) => i < limit), `(limit=${limit}) ${nP} dòng PENDING đủ tuổi: ĐÚNG ${limit} dòng PENDING cũ nhất được GET, dòng thứ ${nP} KHÔNG (hạn mức cũ giữ nguyên, không bị cắt vì có dòng abandon) [guard mới; trên HEAD phần PENDING đạt]`);
      eq(sa, A.map((_, i) => i < share), `(limit=${limit}) nhóm abandon quét ĐÚNG SHARE=${share} dòng cũ nhất, cộng thêm NGOÀI hạn mức (tổng ${limit + share} > limit) [ĐỎ trên HEAD: không có nhóm abandon]`);
      eq([s.paypal && s.paypal.scanned, s.paypal && s.paypal.abandonedScanned], [limit, share], `(limit=${limit}) summary.paypal: scanned=${limit} (PENDING), abandonedScanned=${share} [abandonedScanned: ĐỎ trên HEAD]`);
    }
  });

  await runCase('C9', 'Bất biến tài chính (9) và bất biến PayPal sau toàn bộ kịch bản', async () => {
    const inv = await H.invariantSummary(db);
    ok(inv.coreOk, `chín bất biến tài chính đúng (đã kiểm ${inv.coreChecked})`, JSON.stringify(inv.coreViolations).slice(0, 400));
    ok(inv.paypalOk, 'ba bất biến PayPal riêng đúng', JSON.stringify(inv.paypal.filter((p) => p.count > 0)).slice(0, 400));
    eq(await cnt("SELECT COUNT(*) AS n FROM wallet_entries w WHERE w.entry_type='TOPUP_CREDIT' AND w.request_id IN (SELECT id FROM payment_requests WHERE status='FAILED')"), 0, 'không có bút toán TOPUP_CREDIT nào gắn với request FAILED (kể cả đã abandon)');
  });

  runtimeModule.serializePayPal = originalSerialize;
  await S.close(); await L.close();
  const { pass, fail } = t.summary();
  console.log('\nTÓM TẮT THEO CA');
  for (const c of Object.values(results)) console.log(`  ${c.id} ${c.fail ? 'FAIL' : 'PASS'} ${c.pass}/${c.pass + c.fail} — ${c.title}${c.fail ? '\n      hỏng: ' + c.fails.join(' | ') : ''}`);
  console.log(`RESULT ${JSON.stringify({ pass, fail, cases: Object.fromEntries(Object.values(results).map((c) => [c.id, { pass: c.pass, fail: c.fail }])) })}`);
  process.exitCode = fail ? 1 : 0;
  await db.close();
}

main().then(() => process.exit(process.exitCode || 0), (e) => { console.error(e.stack); process.exit(1); });
