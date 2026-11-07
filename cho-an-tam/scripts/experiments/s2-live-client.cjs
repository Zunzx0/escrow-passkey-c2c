'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const API = 'https://api.enclave.id.vn', WEB = 'https://enclave.id.vn';
const idPattern = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
function fail(message) { throw Object.assign(new Error(message), { safeMessage: message }); }
function decode(text) {
  if (typeof text !== 'string' || text.length > 32768 || !/^ENCLAVE-S2:[A-Za-z0-9+/]+=*$/.test(text)) fail('Dán gói xác nhận từ trang thực nghiệm trên Enclave.');
  let data;
  try { data = JSON.parse(Buffer.from(text.slice(11), 'base64').toString('utf8')); }
  catch { fail('Gói xác nhận không đọc được. Hãy sao chép lại trên Enclave.'); }
  if (data.version !== 'ENCLAVE-S2-1' || data.apiOrigin !== API || data.webOrigin !== WEB) fail('Gói không thuộc thực nghiệm Enclave.');
  for (const name of ['orderA', 'orderB']) if (!idPattern.test(data[name] || '')) fail('Gói thiếu mã đơn hợp lệ.');
  if (data.orderA === data.orderB) fail('Cần hai đơn khác nhau.');
  for (const name of ['accessToken', 'releaseGrant']) if (typeof data[name] !== 'string' || !/^[A-Za-z0-9._~-]{16,8192}$/.test(data[name])) fail('Gói thiếu phiên hoặc phiếu xác nhận.');
  const expiry = Date.parse(data.expiresAt);
  if (!Number.isFinite(expiry) || expiry - Date.now() < 10000 || expiry - Date.now() > 150000) fail('Phiếu đã hết hạn hoặc còn quá ít thời gian; hãy xác nhận lại trên Enclave.');
  if (!idPattern.test(data.assertionReplay?.reauthSessionId || '') || !data.assertionReplay?.response?.response?.signature) fail('Gói thiếu phản hồi WebAuthn đã xác minh.');
  return data;
}
async function http(token, route, body) {
  let r, data;
  try {
    r = await fetch(API + '/api' + route, { method: body === undefined ? 'GET' : 'POST',
      headers: { Origin: WEB, Authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(12000) });
    if (!/application\/json/i.test(r.headers.get('content-type') || '')) fail('Phản hồi máy chủ không phải JSON.');
    data = await r.json();
  } catch { fail('Kết nối bị gián đoạn. Không tự gửi lại lệnh tiền; kiểm tra đơn trên Enclave trước khi thử tiếp.'); }
  return { status: r.status, data };
}
function expect(reply, status, error) {
  const actual = /^[A-Z0-9_]{1,80}$/.test(reply.data?.error || '') ? reply.data.error : null;
  if (reply.status !== status || actual !== (error || null)) fail(`Phản hồi khác dự kiến: HTTP ${reply.status} / ${actual || 'không có mã lỗi'}. Dừng thực nghiệm.`);
  return reply.data;
}
async function open(packet, transport = http) {
  const data = decode(packet), trace = [];
  const ctx = { a: data.orderA, b: data.orderB, grant: data.releaseGrant, assertion: data.assertionReplay, trace };
  ctx.request = async (route, body) => {
    const response = await transport(data.accessToken, route, body);
    trace.push({ method: body === undefined ? 'GET' : 'POST', route, status: response.status,
      error: /^[A-Z0-9_]{1,80}$/.test(response.data?.error || '') ? response.data.error : null });
    return response;
  };
  ctx.post = async (name, route, body, status, error) => {
    const reply = await ctx.request(route, body);
    expect(reply, status, error);
    ctx.steps.push({ name, status: reply.status, error: error || null });
    return reply.data;
  };
  ctx.steps = [];
  const me = expect(await ctx.request('/users/me'), 200);
  if (!me.user?.id) fail('Không xác nhận được chủ phiên.');
  ctx.userId = me.user.id;
  ctx.steps.push({ name: 'Phiên người mua hợp lệ', status: 200, error: null });
  const initial = await inspect(ctx);
  for (const order of [initial.a, initial.b]) {
    if (order.buyerId !== ctx.userId || order.status !== 'WAIT_CONFIRM' || order.escrowStatus !== 'LOCKED' || !order.inspectedAt || order.blocked) fail('Hai đơn chưa đủ điều kiện hoặc không thuộc người mua đang đăng nhập.');
  }
  if (initial.releaseEvents !== 0) fail('Đơn A đã từng chuyển tiền.');
  return ctx;
}
const num = value => { const n = Number(value); if (value == null || value === '' || !Number.isSafeInteger(n) || n < 0) fail('Số liệu máy chủ không hợp lệ.'); return n; };
function state(order) { return { id: order.id, buyerId: order.buyerId, sellerId: order.sellerId, amount: num(order.amount), status: order.status,
  escrowStatus: order.escrowStatus, version: num(order.version), inspectedAt: order.inspectedAt, blocked: Boolean(order.integrityHold) }; }
async function inspect(ctx) {
  const [a, b, wallet, history] = await Promise.all([
    ctx.request('/transactions/' + ctx.a), ctx.request('/transactions/' + ctx.b),
    ctx.request('/wallets/me'), ctx.request('/transactions/' + ctx.a + '/logs'),
  ]);
  const wa = expect(wallet, 200), logs = expect(history, 200).logs;
  if (!Array.isArray(logs)) fail('Không đọc được nhật ký đơn A.');
  const snapshot = { a: state(expect(a, 200)), b: state(expect(b, 200)),
    wallet: { id: wa.id, available: num(wa.availableBalance), locked: num(wa.lockedBalance), version: num(wa.version) },
    releaseEvents: logs.filter(log => log.action === 'ESCROW_RELEASED').length };
  if (snapshot.a.id !== ctx.a || snapshot.b.id !== ctx.b) fail('Máy chủ trả sai đơn cần đối chiếu.');
  return snapshot;
}
const release = grant => ({ requestId: randomUUID(), reauthGrant: grant });
const reject = (ctx, name, route, body, status, error) => ctx.post(name, route, body, status, error);
async function unchanged(ctx, before) { try { assert.deepEqual(await inspect(ctx), before); } catch (e) { if (e.safeMessage) throw e; fail('Dữ liệu đơn hoặc ví đã thay đổi ngoài dự kiến. Dừng để đối chiếu.'); } }
function completed(before, after) {
  try {
    assert.deepEqual(after.b, before.b); assert.deepEqual(after.wallet, before.wallet);
    assert.equal(after.a.id, before.a.id); assert.equal(after.a.buyerId, before.a.buyerId);
    assert.equal(after.a.sellerId, before.a.sellerId); assert.equal(after.a.amount, before.a.amount);
    assert.equal(after.a.status, 'COMPLETED'); assert.equal(after.a.escrowStatus, 'RELEASED'); assert.equal(after.releaseEvents, 1);
  } catch { fail('Kết quả chuyển tiền A không khớp đối chứng. Cần kiểm tra trực tiếp trên Enclave.'); }
}
function finish(ctx, before, after) { return { complete: true, target: API, source: 'website session and Passkey grant', steps: ctx.steps,
  before, after, httpTrace: ctx.trace, limits: 'API quan sát ví người mua và sự kiện giải ngân; cần đối chiếu CSDL riêng để kết luận về mọi ví và cặp bút toán.' }; }
function report(result) {
  console.log('THỰC NGHIỆM 2 — ENCLAVE.ID.VN');
  for (const row of result.steps) console.log(`${row.name}: HTTP ${row.status}${row.error ? ' / ' + row.error : ''}`);
  console.log(`Đơn A: ${result.before.a.status}/${result.before.a.escrowStatus} -> ${result.after.a.status}/${result.after.a.escrowStatus}`);
  console.log(`Đơn B: ${result.after.b.status}/${result.after.b.escrowStatus}; vẫn giữ ${result.after.b.amount} VND.`);
  console.log(`Ví người mua: ${result.before.wallet.available} -> ${result.after.wallet.available} VND.`);
  console.log('Nhật ký A: đúng 1 sự kiện chuyển tiền.');
  const dir = path.join(__dirname, 'results'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'S2-' + randomUUID() + '.json');
  fs.writeFileSync(file, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log('Đã lưu kết quả không chứa token/phiếu: ' + file);
}
module.exports = { open, inspect, reject, release, unchanged, completed, finish, report, decode };
