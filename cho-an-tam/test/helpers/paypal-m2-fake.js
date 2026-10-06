'use strict';
// Fake PayPal Sandbox transport cho M2. KHÔNG chạm mạng.
//
// - Trạng thái (đơn hàng, khoá idempotency, lệnh đang treo, nhật ký) nằm trong MỘT file JSON nên sống qua
//   restart tiến trình và được chia sẻ với tiến trình con.
// - Mỗi lệnh gọi đọc/ghi file đồng bộ; không có await giữa lúc đọc và lúc ghi trong cùng lệnh.
// - Mọi URL không phải https://api-m.sandbox.paypal.com bị chặn và được đếm.
// - Lỗi được lập trình theo kịch bản: 'ok' | 'status' (HTTP lỗi, không tác động) | 'drop' (chưa tới PayPal)
//   | 'lose' (PayPal đã tác động, phản hồi bị mất) | 'hold' (tác động bị treo đến khi completeEffect).
// - Một lệnh 'hold' có thể hoàn tất muộn bằng completeEffect(), kể cả sau khi tiến trình gọi đã chết.
const fs = require('fs');
const crypto = require('crypto');

const SANDBOX = 'https://api-m.sandbox.paypal.com';
const EMPTY = () => ({ seq: 0, orders: {}, keys: {}, plan: {}, effects: {}, calls: [], blocked: 0,
  approvalHref: null, signatureFailures: 0 });

function netError() {
  const e = new Error('fake: connection reset by peer');
  e.code = 'ECONNRESET';
  return e;
}
function abortError() {
  const e = new Error('The operation was aborted');
  e.name = 'AbortError';
  return e;
}

function view(st, o) {
  const unit = { reference_id: o.reference_id, custom_id: o.custom_id, payee: { merchant_id: o.merchant_id },
    amount: { currency_code: o.currency, value: o.value } };
  if (o.capture) unit.payments = { captures: [o.capture] };
  return { id: o.id, intent: 'CAPTURE', status: o.status, purchase_units: [unit],
    links: [{ rel: 'payer-action', href: st.approvalHref || `https://www.sandbox.paypal.com/checkoutnow?token=${o.id}` }] };
}

// Áp MỘT lệnh lên trạng thái. Hàm thuần theo st (không I/O), nên lặp lại được khi hoàn tất muộn.
function applyDescriptor(st, d) {
  if (d.route === 'create') {
    if (d.key && st.keys[d.key]) return { status: 201, payload: { id: st.keys[d.key] } };
    const id = `ORD${String(++st.seq).padStart(6, '0')}${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const pu = d.body.purchase_units[0];
    st.orders[id] = { id, approved: false, captured: false, status: 'PAYER_ACTION_REQUIRED',
      reference_id: pu.reference_id, custom_id: pu.custom_id, merchant_id: pu.payee.merchant_id,
      currency: pu.amount.currency_code, value: pu.amount.value, capture: null };
    if (d.key) st.keys[d.key] = id;
    return { status: 201, payload: { id, status: 'PAYER_ACTION_REQUIRED' } };
  }
  if (d.route === 'get') {
    const o = st.orders[d.orderId];
    if (!o) return { status: 404, payload: { name: 'RESOURCE_NOT_FOUND' } };
    return { status: 200, payload: view(st, o) };
  }
  if (d.route === 'capture') {
    const o = st.orders[d.orderId];
    if (!o) return { status: 404, payload: { name: 'RESOURCE_NOT_FOUND' } };
    if (o.captured) return { status: 422, payload: { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_ALREADY_CAPTURED' }] } };
    if (!o.approved) return { status: 422, payload: { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'PAYER_ACTION_REQUIRED' }] } };
    o.captured = true;
    o.status = 'COMPLETED';
    o.capture = { id: `CAP${o.id}`, status: 'COMPLETED', final_capture: true,
      amount: { currency_code: o.currency, value: o.value } };
    return { status: 201, payload: view(st, o) };
  }
  if (d.route === 'verify') {
    const ok = d.body.transmission_sig !== 'bad-signature';
    if (!ok) st.signatureFailures += 1;
    return { status: 200, payload: { verification_status: ok ? 'SUCCESS' : 'FAILURE' } };
  }
  throw new Error(`fake: unknown route ${d.route}`);
}

function createDurableFake({ statePath }) {
  const waiters = new Map();
  const read = () => {
    try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch (_) { return EMPTY(); }
  };
  const write = (st) => {
    const tmp = `${statePath}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(st));
    fs.renameSync(tmp, statePath);
  };
  const mutate = (fn) => { const st = read(); const out = fn(st); write(st); return out; };

  function take(st, route) {
    const q = st.plan[route];
    if (!q || !q.length) return { kind: 'ok' };
    const next = q.shift();
    if (!q.length) delete st.plan[route];
    return typeof next === 'string' ? { kind: next } : next;
  }

  function holdUntilCompleted(effectId, signal) {
    return new Promise((resolve, reject) => {
      waiters.set(effectId, resolve);
      if (signal) {
        signal.addEventListener('abort', () => { waiters.delete(effectId); reject(abortError()); }, { once: true });
      }
    });
  }

  function perform(route, descriptor, signal) {
    const step = mutate((st) => {
      st.calls.push({ route, orderId: descriptor.orderId || null, key: descriptor.key || null, at: new Date().toISOString() });
      return take(st, route);
    });
    if (step.kind === 'status') {
      if(step.orderPatch) mutate(st=>{if(!st.orders[descriptor.orderId])throw Error('fake order missing');Object.assign(st.orders[descriptor.orderId],step.orderPatch);});
      return Promise.resolve({ status: step.code, payload: step.payload || { name: 'SIMULATED' } });
    }
    if (step.kind === 'drop') return Promise.reject(netError());
    if (step.kind === 'hold') {
      const effectId = `EFF-${crypto.randomBytes(5).toString('hex')}`;
      mutate((st) => { st.effects[effectId] = { status: 'pending', descriptor }; });
      return holdUntilCompleted(effectId, signal);
    }
    const result = mutate((st) => applyDescriptor(st, descriptor));
    if (step.kind === 'lose') return Promise.reject(netError());
    return Promise.resolve(result);
  }

  async function fetchImpl(url, options = {}) {
    const u = new URL(url);
    if (u.origin !== SANDBOX) {
      mutate((st) => { st.blocked += 1; });
      throw new Error(`fake: origin bị chặn ${u.origin}`);
    }
    if (options.signal && options.signal.aborted) throw abortError();
    const method = (options.method || 'GET').toUpperCase();
    if (u.pathname === '/v1/oauth2/token') {
      return toResponse({ status: 200, payload: { access_token: 'fake-access-token', token_type: 'Bearer', expires_in: 3600 } });
    }
    const text = typeof options.body === 'string' ? options.body : '';
    const body = text.startsWith('{') ? JSON.parse(text) : {};
    const headers = options.headers || {};
    const key = headers['PayPal-Request-Id'] || null;
    let route = null;
    let descriptor = { key, body };
    if (u.pathname === '/v1/notifications/verify-webhook-signature' && method === 'POST') {
      route = 'verify';
    } else if (u.pathname === '/v2/checkout/orders' && method === 'POST') {
      route = 'create';
    } else {
      const m = u.pathname.match(/^\/v2\/checkout\/orders\/([^/]+)(\/capture)?$/);
      if (m && method === 'GET' && !m[2]) { route = 'get'; descriptor = { orderId: m[1] }; }
      if (m && method === 'POST' && m[2]) { route = 'capture'; descriptor = { orderId: m[1], key }; }
    }
    if (!route) return toResponse({ status: 404, payload: { name: 'RESOURCE_NOT_FOUND' } });
    descriptor = { route, ...descriptor };
    const result = await perform(route, descriptor, options.signal);
    return toResponse(result);
  }

  // Hoàn tất một lệnh đang treo (kể cả khi tiến trình gọi đã chết). Trả về phản hồi đã áp.
  function completeEffect(effectId) {
    const result = mutate((st) => {
      const e = st.effects[effectId];
      if (!e || e.status !== 'pending') throw new Error(`fake: không có lệnh treo ${effectId}`);
      const r = applyDescriptor(st, e.descriptor);
      e.status = 'done';
      e.result = r;
      return r;
    });
    const w = waiters.get(effectId);
    if (w) { waiters.delete(effectId); w(result); }
    return result;
  }

  return Object.freeze({
    fetchImpl,
    completeEffect,
    plan(route, ...steps) {
      mutate((st) => { st.plan[route] = (st.plan[route] || []).concat(steps); });
    },
    approve(orderId) {
      mutate((st) => { const o = st.orders[orderId]; if (!o) throw new Error('no order'); o.approved = true; o.status = 'APPROVED'; });
    },
    tamper(orderId, patch) {
      mutate((st) => { const o = st.orders[orderId]; if (!o) throw new Error('no order'); Object.assign(o, patch); });
    },
    setApprovalHref(href) { mutate((st) => { st.approvalHref = href; }); },
    order(orderId) { return read().orders[orderId] || null; },
    orderCount() { return Object.keys(read().orders).length; },
    pendingEffects() {
      return Object.entries(read().effects).filter(([, e]) => e.status === 'pending').map(([id]) => id);
    },
    calls(route) { return read().calls.filter((c) => !route || c.route === route); },
    countCalls(route, orderId) {
      return read().calls.filter((c) => c.route === route && (!orderId || c.orderId === orderId)).length;
    },
    blocked() { return read().blocked; },
    signatureFailures() { return read().signatureFailures; },
    statePath,
  });
}

function toResponse({ status, payload }) {
  const text = JSON.stringify(payload);
  return { ok: status >= 200 && status < 300, status, text: async () => text, headers: { get: () => null } };
}

module.exports = { createDurableFake, SANDBOX, applyDescriptor };
