'use strict';
// M2 — lớp HTTP thật: router PayPal gắn vào Express, phiên và quyền đi qua middleware thật, quota, cấu hình tắt,
// lỗi báo cáo sau commit, và đối soát chỉ-GET của worker.
// Chạy: APP_ENV=test DB_PATH=data/test/... node test/paypal-m2-api-e2e.js
const H = require('./helpers/paypal-m2-harness');
const { statePath } = H.init('api');
H.resetFake(statePath);

// Lỗi báo cáo SAU commit (mục M2: không được báo tiền bị rollback). Phải vá TRƯỚC khi nạp paypalSettlement,
// vì module đó lấy hàm khi nạp.
const notifications = require('../src/lib/notifications');
const securityEvents = require('../src/lib/securityEvents');
let reportFailures = 0;
const realOnTopup = notifications.onTopupResolved;
notifications.onTopupResolved = async () => { reportFailures++; throw Object.assign(new Error('thông báo hỏng'), { code: 'NOTIFY_FAIL' }); };
const realLogSecurity = securityEvents.logSecurityEvent;
securityEvents.logSecurityEvent = async (...args) => {
  if (args[1] && args[1].type === securityEvents.EVENTS.TOPUP_SUCCEEDED) { reportFailures++; throw Object.assign(new Error('nhật ký hỏng'), { code: 'LOG_FAIL' }); }
  return realLogSecurity(...args);
};

const crypto = require('crypto');
const { createDurableFake, SANDBOX } = require('./helpers/paypal-m2-fake');

async function main() {
  const { db, uuid, nowIso } = require('../src/db');
  const { createSandboxProvider } = require('../src/lib/paypalSandboxProvider');
  const { createPayPalRuntime } = require('../src/lib/paypalRuntime');
  const { createPayPalRouter } = require('../src/routes/paypal');
  const rateLimit = require('../src/lib/rateLimit');

  const t = H.tally('M2 HTTP');
  const cfg = H.config();
  const fake = createDurableFake({ statePath });
  const provider = createSandboxProvider(cfg, { fetchImpl: fake.fetchImpl });
  const runtime = createPayPalRuntime({ config: cfg, provider });
  const buyer = await H.createAccount(db, { label: 'api-buyer', balance: 0 });
  const other = await H.createAccount(db, { label: 'api-other' });
  const seller = await H.createAccount(db, { label: 'api-seller', role: 'SELLER' });
  const hdr = () => ({ 'paypal-auth-algo': 'SHA256withRSA', 'paypal-cert-url': `${SANDBOX}/v1/notifications/certs/m2`,
    'paypal-transmission-id': 'tx-' + uuid(), 'paypal-transmission-sig': 'good-signature', 'paypal-transmission-time': nowIso() });
  const evt = (row) => ({ id: 'EVT-' + uuid(), event_type: 'PAYMENT.CAPTURE.COMPLETED',
    resource: { id: 'CAP' + row.orderId, supplementary_data: { related_ids: { order_id: row.orderId } } } });
  const balance = async (u) => Number((await H.wallet(db, u.id)).available_balance);
  const resetLimits = () => rateLimit.resetRateLimits();

  const srv = await H.startRouter(createPayPalRouter(runtime));
  const B = srv.base;

  // ===================================================================================
  t.section('A1 — cấu hình công khai không lộ bí mật');
  resetLimits();
  const cfgRes = await H.http(B, '/config');
  t.eq(cfgRes.status, 200, 'GET /config: 200 không cần phiên');
  t.ok(cfgRes.body.paypalSandbox.enabled === true && cfgRes.body.mockPayments.enabled === false,
    'PayPal bật, mock tắt');
  const raw = JSON.stringify(cfgRes.body);
  t.ok(!raw.includes(cfg.clientSecret) && !raw.includes(cfg.merchantId) && !raw.includes(cfg.webhookId) && !raw.includes(cfg.clientId),
    'cấu hình công khai không chứa client secret, merchant, webhook hay client ID');

  // ===================================================================================
  t.section('A2 — phiên và quyền: không đăng nhập, quản trị viên chưa chứng minh, người ngoài');
  resetLimits();
  t.eq((await H.http(B, '/topup', { method: 'POST', body: { amount: 10000, requestId: 'x-' + uuid() } })).status, 401,
    'topup không có token: 401');
  const adminBad = await H.createAccount(db, { role: 'BUYER', label: 'api-adm-bad', balance: 50000 });
  await require('./helpers/paypal-m2-db').withTriggerDisabled(db,'users',()=>db.prepare("UPDATE users SET role='ADMIN' WHERE id=?").run(adminBad.id));
  t.eq(await balance(adminBad),50000,'fixture: BUYER bị sửa role ADMIN vẫn giữ ví 50.000đ');
  for (const [label, route, method, body] of [
    ['topup', '/topup', 'POST', { amount: 10000, requestId: 'adm-' + uuid() }],
    ['checkout', `/${buyer.id}/checkout`, 'GET', undefined],
    ['capture', `/${buyer.id}/capture`, 'POST', {}],
  ]) {
    const r = await H.http(B, route, { method, token: adminBad.token, body });
    t.ok(r.status === 403 && r.body.error === 'FORBIDDEN', `quản trị viên chưa chứng minh (có ví) bị 403 ở ${label}`, `nhận ${r.status} ${r.body && r.body.error}`);
  }
  const mine = await H.http(B, '/topup', { method: 'POST', token: buyer.token, body: { amount: 10000, requestId: 'own-' + uuid() } });
  t.eq(mine.status, 200, 'người mua tạo được yêu cầu nạp PayPal');
  const sellerTopup = await H.http(B, '/topup', { method: 'POST', token: seller.token, body: { amount: 10000, requestId: 'sel-' + uuid() } });
  t.eq(sellerTopup.status, 200, 'người bán (SELLER) cũng được dùng tuyến nạp như người mua');
  resetLimits();
  t.eq((await H.http(B, `/${mine.body.id}/checkout`, { token: other.token })).status, 403,
    'người khác không mở được checkout của người mua');
  t.eq((await H.http(B, `/${mine.body.id}/capture`, { method: 'POST', token: other.token, body: {} })).status, 403,
    'người khác không capture được yêu cầu của người mua');
  t.eq(await balance(buyer), 0, 'các lần từ chối không đổi số dư');

  // ===================================================================================
  t.section('A3 — nạp: khoá chống lặp, kiểu dữ liệu, phản hồi');
  resetLimits();
  const key = 'idem-' + uuid();
  const first = await H.http(B, '/topup', { method: 'POST', token: buyer.token, body: { amount: 20000, requestId: key } });
  t.eq(first.status, 200, 'tạo mới: 200 (không dựa mã này để kết luận đã nạp)');
  t.ok(first.body.provider === 'PAYPAL_SANDBOX' && first.body.stage === 'AWAITING_APPROVAL' && first.body.orderId,
    'phản hồi có provider, stage AWAITING_APPROVAL và orderId');
  t.ok(first.body.quote && first.body.quote.usdValue === '0.80' && first.body.quote.rateKind === 'DEMO_FIXED',
    'báo giá do server tính: 20.000đ ở 25.000đ/USD = 0.80 USD');
  const replay = await H.http(B, '/topup', { method: 'POST', token: buyer.token, body: { amount: 20000, requestId: key } });
  t.ok(replay.status === 200 && replay.body.id === first.body.id && replay.body.orderId === first.body.orderId,
    'gửi lại cùng key: cùng request và cùng order');
  t.eq((await H.http(B, '/topup', { method: 'POST', token: buyer.token, body: { amount: 21000, requestId: key } })).body.error,
    'IDEMPOTENCY_KEY_REUSED', 'cùng key khác số tiền: IDEMPOTENCY_KEY_REUSED');
  t.eq((await H.http(B, '/topup', { method: 'POST', token: buyer.token, body: { amount: 20000 } })).body.error,
    'VALIDATION_ERROR', 'thiếu requestId: VALIDATION_ERROR');
  t.eq((await H.http(B, '/topup', { method: 'POST', token: buyer.token, body: { amount: '20000', requestId: 'str-' + uuid() } })).body.error,
    'INVALID_AMOUNT', 'số tiền dạng chuỗi: INVALID_AMOUNT');
  t.eq(await balance(buyer), 0, 'chưa có tiền nào được cộng khi chỉ tạo yêu cầu');

  // ===================================================================================
  t.section('A4 — URL phê duyệt: chỉ chấp nhận origin sandbox của PayPal');
  const checkout = await H.http(B, `/${first.body.id}/checkout`, { token: buyer.token });
  t.ok(checkout.status === 200 && checkout.body.approvalUrl && new URL(checkout.body.approvalUrl).origin === 'https://www.sandbox.paypal.com',
    'checkout trả URL phê duyệt đúng origin sandbox');
  fake.setApprovalHref('https://www.sandbox.paypal.com.attacker.example/checkoutnow?token=x');
  resetLimits();
  const unsafe = await H.http(B, '/topup', { method: 'POST', token: buyer.token, body: { amount: 30000, requestId: 'unsafe-' + uuid() } });
  fake.setApprovalHref(null);
  t.ok(unsafe.status >= 500 && unsafe.body.error === 'PAYPAL_RESPONSE_INVALID', 'URL phê duyệt không an toàn: từ chối tạo yêu cầu');
  const unsafeRow = await db.prepare('SELECT order_id FROM paypal_payment_bindings WHERE amount_vnd = 30000 AND merchant_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(cfg.merchantId);
  t.ok(!unsafeRow || unsafeRow.order_id === null, 'yêu cầu có URL không an toàn không được gắn order');

  // ===================================================================================
  t.section('A5 — return/cancel không tự cộng tiền');
  const before = await balance(buyer);
  const withToken = await H.http(B, `/${first.body.id}/checkout?paypal=return&paymentRequestId=${first.body.id}&token=FAKE-TOKEN&PayerID=ABC`, { token: buyer.token });
  t.eq(withToken.status, 200, 'trang quay về với query của PayPal: vẫn 200');
  t.eq(await balance(buyer), before, 'query token/PayerID không cộng tiền');
  t.eq((await H.credits(db, first.body.id)).length, 0, 'không có bút toán từ query');

  // ===================================================================================
  t.section('A6 — PayPal từ chối trước khi người mua phê duyệt');
  resetLimits();
  fake.approve(first.body.orderId);
  fake.plan('capture',{kind:'status',code:422,payload:{name:'UNPROCESSABLE_ENTITY',details:[{issue:'PAYER_ACTION_REQUIRED'}]},orderPatch:{status:'PAYER_ACTION_REQUIRED',approved:false}});
  const postsBeforeRefusal=fake.countCalls('capture',first.body.orderId);
  const unapproved = await H.http(B, `/${first.body.id}/capture`, { method: 'POST', token: buyer.token, body: {} });
  t.eq(unapproved.status,200,'422 upstream: phản hồi HTTP có kiểm soát, không báo thu thành công');
  t.eq(unapproved.body.outcome,'AWAITING_APPROVAL','422 upstream: yêu cầu người mua phê duyệt');
  t.eq(fake.countCalls('capture',first.body.orderId)-postsBeforeRefusal,1,'fixture422 đã thực sự gửi một POST capture');
  t.eq((await H.credits(db, first.body.id)).length, 0, 'không có bút toán khi PayPal chưa thu');
  const stageAfterRefusal = (await H.http(B, `/${first.body.id}/checkout`, { token: buyer.token })).body.stage;
  t.eq(stageAfterRefusal,'AWAITING_APPROVAL','GET checkout xác minh cần phê duyệt');
  const refusalBinding=await db.prepare('SELECT capture_state,capture_post_sent_at FROM paypal_payment_bindings WHERE payment_request_id=?').get(first.body.id);
  t.eq(refusalBinding.capture_state,'UNKNOWN','422 không được trở lại READY');
  t.ok(Boolean(refusalBinding.capture_post_sent_at),'giữ bằng chứng đã POST sau422');
  t.eq((await db.prepare('SELECT status FROM payment_requests WHERE id=?').get(first.body.id)).status,'PENDING','yêu cầu vẫn PENDING sau422');
  const refusalPosts=fake.countCalls('capture',first.body.orderId);
  await require('../src/lib/reconciler').reconcileOnce({minAgeSeconds:0,paymentRequestId:first.body.id,paypalRuntime:runtime});
  t.eq(fake.countCalls('capture',first.body.orderId),refusalPosts,'worker sau422 chỉ GET không POST capture');
  t.eq((await H.credits(db,first.body.id)).length,0,'worker sau422 không cộng ví');
  fake.approve(first.body.orderId);
  resetLimits();
  const approvedCapture = await H.http(B, `/${first.body.id}/capture`, { method: 'POST', token: buyer.token, body: {} });
  t.ok(approvedCapture.status === 200 && approvedCapture.body.status === 'SUCCEEDED' && approvedCapture.body.outcome === 'APPLIED',
    'sau khi phê duyệt: capture thành công một lần');
  t.eq(await balance(buyer), before + 20000, 'ví tăng đúng 20.000đ (VND theo báo giá)');

  // ===================================================================================
  t.section('A7 — PayPal trả 429 khi thu: đúng một lệnh POST, không lặp lại trong cùng lượt');
  const r429 = await H.http(B, '/topup', { method: 'POST', token: buyer.token, body: { amount: 15000, requestId: 'q429-' + uuid() } });
  fake.approve(r429.body.orderId);
  fake.plan('capture', { kind: 'status', code: 429 });
  resetLimits();
  const postsBefore = fake.countCalls('capture', r429.body.orderId);
  const quota = await H.http(B, `/${r429.body.id}/capture`, { method: 'POST', token: buyer.token, body: {} });
  t.ok(quota.status >= 500 && quota.body.error === 'PAYPAL_API_ERROR', 'PayPal 429: lỗi có kiểm soát, không thành công giả');
  t.eq(fake.countCalls('capture', r429.body.orderId) - postsBefore, 1, 'chỉ một POST trong lượt này');
  const after429 = await runtime.store.loadByRequestId(r429.body.id);
  t.ok(after429.capture.state === 'UNKNOWN' && after429.status === 'PENDING', 'sau 429: UNKNOWN, yêu cầu vẫn PENDING');
  t.eq((await H.credits(db, r429.body.id)).length, 0, 'không cộng tiền khi chưa xác minh');

  // ===================================================================================
  t.section('A8 — giới hạn tần suất của chính ứng dụng');
  resetLimits();
  let last = null;
  const callsBefore = fake.calls().length;
  for (let i = 0; i < 11; i++) last = await H.http(B, `/${uuid()}/capture`, { method: 'POST', token: buyer.token, body: {} });
  t.eq(last.status, 429, 'lần thứ 11 trong một phút: 429');
  t.ok(Number(last.headers.get('retry-after')) > 0, '429 có Retry-After');
  t.eq(fake.calls().length - callsBefore, 0, 'các lần bị chặn không tới PayPal (không lệnh nào)');
  resetLimits();

  // ===================================================================================
  t.section('A9 — webhook: chữ ký không hợp lệ không tất toán; quota webhook');
  resetLimits();
  const w = await H.createAccount(db, { label: 'api-web' });
  const wr = await H.http(B, '/topup', { method: 'POST', token: w.token, body: { amount: 16000, requestId: 'wh-' + uuid() } });
  fake.approve(wr.body.orderId);
  await runtime.capture(wr.body.id, w.id);
  const sigFailBefore = fake.signatureFailures();
  const badSig = await fetch(B + '/webhook', { method: 'POST', headers: { 'content-type': 'application/json', ...hdr(), 'paypal-transmission-sig': 'bad-signature' }, body: JSON.stringify(evt(wr.body)) });
  t.eq(badSig.status, 401, 'webhook chữ ký sai: 401');
  t.ok(fake.signatureFailures() - sigFailBefore === 1, 'PayPal xác minh chữ ký một lần và từ chối');
  t.eq((await H.credits(db, wr.body.id)).length, 1, 'đúng một bút toán từ lần thu thật (không do webhook sai)');
  resetLimits();
  let webhookLast = null;
  for (let i = 0; i < 61; i++) webhookLast = await fetch(B + '/webhook', { method: 'POST', headers: { 'content-type': 'application/json', ...hdr() }, body: JSON.stringify(evt(wr.body)) });
  t.eq(webhookLast.status, 429, 'webhook quá 60 lần/phút: 429');
  const localRetryAfter=Number(webhookLast.headers.get('retry-after'));
  t.ok(Number.isInteger(localRetryAfter)&&localRetryAfter>=1&&localRetryAfter<=60,'429 local limiter trả Retry-After hợp lệ 1–60 giây (không phải upstream PayPal)');
  resetLimits();

  // ===================================================================================
  t.section('A10 — cấu hình tắt: không có lệnh gọi mạng nào');
  const disabledRuntime = createPayPalRuntime({ config: { ...cfg, enabled: false }, provider: createSandboxProvider(cfg, { fetchImpl: fake.fetchImpl }) });
  const disabledSrv = await H.startRouter(createPayPalRouter(disabledRuntime));
  try {
    resetLimits();
    const callsBeforeOff = fake.calls().length;
    for (const [route, method, token] of [['/topup', 'POST', buyer.token], [`/${first.body.id}/checkout`, 'GET', buyer.token],
      [`/${first.body.id}/capture`, 'POST', buyer.token], ['/webhook', 'POST', undefined]]) {
      const r = await H.http(disabledSrv.base, route, { method, token, body: method === 'POST' ? {} : undefined });
      t.ok(r.status === 503 && r.body.error === 'PAYPAL_DISABLED', `tắt: ${method} ${route} trả 503 PAYPAL_DISABLED`, `nhận ${r.status}`);
    }
    t.eq(fake.calls().length - callsBeforeOff, 0, 'cấu hình tắt: không lệnh nào tới PayPal');
  } finally { await disabledSrv.close(); }

  // ===================================================================================
  t.section('A11 — lỗi báo cáo SAU commit không báo tiền bị rollback và không cộng lần nữa');
  resetLimits();
  const rep = await H.createAccount(db, { label: 'api-report' });
  const rr = await H.http(B, '/topup', { method: 'POST', token: rep.token, body: { amount: 17000, requestId: 'rep-' + uuid() } });
  fake.approve(rr.body.orderId);
  const repBefore = await balance(rep);
  const origError = console.error;
  const logged = [];
  console.error = (...args) => { logged.push(args.map(String).join(' ')); };
  let repOutcome;
  try { repOutcome = await runtime.capture(rr.body.id, rep.id); }
  finally { console.error = origError; }
  t.eq(repOutcome.outcome, 'APPLIED', 'tất toán đã commit: vẫn APPLIED dù báo cáo hỏng');
  t.eq(await balance(rep) - repBefore, 17000, 'ví tăng đúng một lần');
  t.ok(reportFailures >= 1 && logged.some((l) => /report|báo cáo/.test(l) || /NOTIFY_FAIL|LOG_FAIL/.test(l)),
    'lỗi báo cáo được ghi log, không làm rollback tiền');
  t.eq((await H.credits(db, rr.body.id)).length, 1, 'đúng một bút toán');

  // ===================================================================================
  t.section('A12 — worker đối soát: chỉ GET, không lệnh thu, không bị đói');
  resetLimits();
  const wk = await H.createAccount(db, { label: 'api-worker' });
  // Yêu cầu CŨ chưa bao giờ có order (create bị rớt): không được chặn lượt đối soát.
  fake.plan('create', 'drop');
  await runtime.create({ userId: wk.id, amount: 18000, requestId: 'stale-' + uuid() }).catch(() => null);
  await db.prepare("UPDATE payment_requests SET created_at = '2000-01-01T00:00:00.000Z' WHERE user_id = ? AND amount = 18000").run(wk.id);
  // Yêu cầu MỚI: PayPal đã thu nhưng phản hồi bị mất. Chỉ đối soát bằng GET mới tất toán được.
  const live = await runtime.create({ userId: wk.id, amount: 19000, requestId: 'live-' + uuid() });
  fake.approve(live.orderId);
  fake.plan('capture', 'lose');
  await runtime.capture(live.id, wk.id).catch(() => null);
  t.eq(fake.order(live.orderId).status, 'COMPLETED', 'PayPal đã thu, phía ta mất phản hồi');
  const { reconcileOnce } = require('../src/lib/reconciler');
  const postsBeforeWorker = fake.calls('capture').length;
  const workerRun = await reconcileOnce({ minAgeSeconds: 0, limit: 50, paypalRuntime: runtime });
  t.eq(fake.calls('capture').length, postsBeforeWorker, 'đối soát không gửi lệnh thu nào (chỉ GET)');
  t.eq((await H.credits(db, live.id)).length, 1, 'đối soát tất toán đúng một bút toán, dù có yêu cầu cũ không order');
  t.ok(workerRun.paypal && workerRun.paypal.applied >= 1, 'lượt đối soát báo đã tất toán ít nhất một yêu cầu PayPal');

  // ===================================================================================
  t.section('A13 — quyền ở mức tuyến: quản trị viên chưa chứng minh không dùng được tuyến ví');
  const adminOk = await H.http(B, '/config', { token: adminBad.token });
  t.eq(adminOk.status, 200, 'cấu hình công khai vẫn đọc được (không cần quyền ví)');

  await srv.close();
  const inv = await H.invariantSummary(db);
  t.ok(inv.paypalOk, 'ba bất biến PayPal đúng sau toàn bộ luồng HTTP');
  t.ok(inv.coreOk, `chín bất biến cũ đúng (đã kiểm ${inv.coreChecked})`, JSON.stringify(inv.coreViolations).slice(0, 300));
  const { fail, known } = t.summary();
  process.exitCode = fail ? 1 : 0;
  void known;
  await db.close();
}

main().then(() => process.exit(process.exitCode || 0), (e) => { console.error(e.stack); process.exit(1); });
