'use strict';
// M2 — tầng tất toán trong tiến trình: T1, T2, T3, T4 (cô lập provider), T5 (kết quả không rõ), T6 (barrier giữ quyền cũ,
// hết lease, RECOVERY_REQUIRED) và ba bất biến PayPal có fixture bị rollback.
// Chạy: APP_ENV=test DB_PATH=data/test/... (hoặc DATABASE_URL=...*_test) node test/paypal-m2-settlement-e2e.js
const H = require('./helpers/paypal-m2-harness');
const { statePath } = H.init('settlement');
H.resetFake(statePath);

const crypto = require('crypto');
const { createDurableFake, SANDBOX } = require('./helpers/paypal-m2-fake');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, label, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await sleep(20); }
  throw new Error(`hết thời gian chờ: ${label}`);
}

async function main() {
  const { db, uuid, nowIso } = require('../src/db');
  const { createSandboxProvider } = require('../src/lib/paypalSandboxProvider');
  const { createPayPalRuntime } = require('../src/lib/paypalRuntime');
  const { applyProviderResult } = require('../src/lib/paymentService');
  const { withTriggerDisabled } = require('./helpers/paypal-m2-db');

  const t = H.tally('M2 tất toán');
  const cfg = H.config();                       // timeout 500 ms, lease 12 s
  const cfgLong = H.config({ timeoutMs: 5000, leaseMs: 30000 }); // holder vẫn sống khi hết thời gian chờ
  const fake = createDurableFake({ statePath });
  const runtime = createPayPalRuntime({ config: cfg, provider: createSandboxProvider(cfg, { fetchImpl: fake.fetchImpl }) });
  const runtimeLong = createPayPalRuntime({ config: cfgLong, provider: createSandboxProvider(cfgLong, { fetchImpl: fake.fetchImpl }) });

  const buyer = await H.createAccount(db, { label: 'st-buyer' });
  const other = await H.createAccount(db, { label: 'st-other' });
  const hdr = () => ({ 'paypal-auth-algo': 'SHA256withRSA', 'paypal-cert-url': `${SANDBOX}/v1/notifications/certs/m2`,
    'paypal-transmission-id': 'tx-' + uuid(), 'paypal-transmission-sig': 'good-signature', 'paypal-transmission-time': nowIso() });
  const evt = (row) => ({ id: 'EVT-' + uuid(), event_type: 'PAYMENT.CAPTURE.COMPLETED',
    resource: { id: 'CAP' + row.orderId, supplementary_data: { related_ids: { order_id: row.orderId } } } });
  const newRequest = async (user, amount = 10000) => runtime.create({ userId: user.id, amount, requestId: 'st-' + uuid() });
  const approvedRequest = async (user, amount = 10000) => { const r = await newRequest(user, amount); fake.approve(r.orderId); return r; };
  const bindingRow = (id) => db.prepare('SELECT * FROM paypal_payment_bindings WHERE payment_request_id = ?').get(id);
  const postSent = async (id) => { const b = await bindingRow(id); return Boolean(b && b.capture_post_sent_at); };
  const expireLease = (id) => db.prepare('UPDATE paypal_payment_bindings SET capture_claimed_at = ? WHERE payment_request_id = ?')
    .run('2000-01-01T00:00:00.000Z', id);
  const balance = async (u) => Number((await H.wallet(db, u.id)).available_balance);
  const requestRow = (id) => db.prepare('SELECT status, version FROM payment_requests WHERE id = ?').get(id);

  // ===================================================================================
  t.section('T1 — đồng thời: hai capture, hai webhook trùng, hai đối soát, cùng một khoản');
  const a = await approvedRequest(buyer);
  const beforeA = await balance(buyer);
  const raced = await Promise.allSettled([
    runtime.capture(a.id, buyer.id), runtime.capture(a.id, buyer.id),
    runtime.webhook(hdr(), evt(a)), runtime.webhook(hdr(), evt(a)),
    runtime.reconcileOne(a.id), runtime.reconcileOne(a.id),
  ]);
  t.ok(raced.every((r) => r.status === 'fulfilled' || r.reason?.code), 'mọi nhánh đều kết thúc có kết quả hoặc mã lỗi rõ ràng');
  t.ok(raced.some((r) => r.status === 'fulfilled' && r.value.outcome === 'APPLIED'), 'đúng một nhánh tất toán (APPLIED)');
  t.eq((await H.credits(db, a.id)).length, 1, 'đúng một bút toán TOPUP_CREDIT');
  t.eq(await balance(buyer) - beforeA, 10000, 'ví tăng đúng một lần số VND đã báo giá');
  t.eq(fake.countCalls('capture', a.orderId), 1, 'PayPal chỉ nhận đúng một lệnh thu');
  t.eq((await requestRow(a.id)).status, 'SUCCEEDED', 'request SUCCEEDED đúng một lần');

  // ===================================================================================
  t.section('T2 — dữ liệu sai không ghi tiền');
  const s = await approvedRequest(buyer);
  const good = { paymentRequestId: s.id, providerRef: s.providerRef, orderId: s.orderId, captureId: 'CAP' + s.orderId,
    amount: 10000, status: 'SUCCEEDED', source: 'WEBHOOK' };
  for (const [label, patch] of [['orderId khác', { orderId: 'ORD-LA' }], ['số tiền khác', { amount: 9999 }],
    ['providerRef khác', { providerRef: 'ref-la' }], ['trạng thái không phải SUCCEEDED', { status: 'PENDING' }],
    ['nguồn không hợp lệ', { source: 'MOCK' }], ['captureId rỗng', { captureId: '' }]]) {
    await t.rejects(() => runtime.settle({ ...good, ...patch }), undefined, `settle với ${label}: bị từ chối`);
  }
  t.eq((await H.credits(db, s.id)).length, 0, 'không bút toán nào sau các lần sai');
  t.eq((await requestRow(s.id)).status, 'PENDING', 'request vẫn PENDING');

  const x = await approvedRequest(buyer);
  const y = await approvedRequest(other);
  t.eq((await runtime.capture(y.id, other.id)).outcome, 'APPLIED', 'y thu thật, có capture ID riêng');
  const reuse = await runtime.settle({ paymentRequestId: x.id, providerRef: x.providerRef, orderId: x.orderId,
    captureId: 'CAP' + y.orderId, amount: 10000, status: 'SUCCEEDED', source: 'WEBHOOK' });
  t.eq(reuse.outcome, 'CONFLICT', 'capture ID của đơn khác bị từ chối (CONFLICT)');
  t.eq((await H.credits(db, x.id)).length, 0, 'đơn x không được cộng tiền bằng capture của y');
  t.eq((await requestRow(x.id)).status, 'PENDING', 'x vẫn PENDING');

  for (const [label, patch] of [['số tiền PayPal khác', { value: '9.99' }], ['tiền tệ khác', { currency: 'EUR' }],
    ['reference_id khác', { reference_id: 'other-request' }], ['merchant khác', { merchant_id: 'OTHER-MERCHANT' }]]) {
    const z = await approvedRequest(buyer);
    fake.tamper(z.orderId, patch);
    const before = fake.countCalls('capture', z.orderId);
    await t.rejects(() => runtime.capture(z.id, buyer.id), 'PAYPAL_ORDER_MISMATCH', `${label}: chặn trước khi gửi lệnh thu`);
    t.eq(fake.countCalls('capture', z.orderId) - before, 0, `${label}: không POST capture`);
    t.eq((await H.credits(db, z.id)).length, 0, `${label}: không có bút toán`);
  }

  // ===================================================================================
  t.section('T3 — lỗi chèn giữa tất toán: rollback đủ, retry đúng một lần');
  for (const point of ['after-wallet-update', 'before-status-change']) {
    const f = await approvedRequest(buyer);
    const b0 = await balance(buyer);
    process.env.FAULT_INJECT = `paypal-topup:${point}`;
    try { await t.rejects(() => runtime.capture(f.id, buyer.id), 'INJECTED_FAULT', `${point}: lỗi chèn được ném ra`); }
    finally { delete process.env.FAULT_INJECT; }
    const row = await runtime.store.loadByRequestId(f.id);
    t.ok(row.status === 'PENDING' && row.capture.state !== 'VERIFIED' && !row.capture.captureId,
      `${point}: request PENDING, bằng chứng chưa VERIFIED (state=${row.capture.state})`);
    t.eq((await H.credits(db, f.id)).length, 0, `${point}: không có bút toán`);
    t.eq(await balance(buyer), b0, `${point}: số dư không đổi`);
    t.eq((await runtime.reconcileOne(f.id)).outcome, 'APPLIED', `${point}: đối soát (GET) tất toán đúng một lần`);
    t.eq((await H.credits(db, f.id)).length, 1, `${point}: đúng một bút toán sau khi phục hồi`);
    t.eq(await balance(buyer) - b0, 10000, `${point}: ví tăng đúng một lần`);
  }

  // ===================================================================================
  t.section('T4 — cô lập provider: request MOCK không vào nhánh PayPal và ngược lại');
  const mockId = uuid();
  const now = nowIso();
  await db.prepare(`INSERT INTO payment_requests (id,user_id,amount,status,provider_ref,version,provider,created_at,updated_at)
    VALUES (?,?,10000,'PENDING','mock-ref-t4',0,'MOCK',?,?)`).run(mockId, buyer.id, now, now);
  await t.rejects(() => runtime.settle({ paymentRequestId: mockId, providerRef: 'mock-ref-t4', orderId: 'ORD-MOCK',
    captureId: 'CAP-MOCK', amount: 10000, status: 'SUCCEEDED', source: 'WEBHOOK' }),
  undefined, 'settle PayPal trên request MOCK: bị từ chối');
  t.eq((await requestRow(mockId)).status, 'PENDING', 'request MOCK không đổi trạng thái');
  const p = await approvedRequest(buyer);
  const mockResult = await applyProviderResult({ paymentRequestId: p.id, providerRef: p.providerRef, status: 'SUCCEEDED', amount: 10000, source: 'WEBHOOK' });
  t.ok(mockResult.outcome !== 'APPLIED', 'kết quả có chữ ký MOCK không tất toán request PayPal');
  t.eq((await H.credits(db, p.id)).length, 0, 'request PayPal không có bút toán từ đường MOCK');

  // ===================================================================================
  t.section('T5 — kết quả không rõ ràng: mất phản hồi, timeout sau khi thu, lỗi trước khi POST');
  const creq = 'amb-' + uuid();
  fake.plan('create', 'lose');
  await t.rejects(() => runtime.create({ userId: buyer.id, amount: 12000, requestId: creq }), 'PAYPAL_UNAVAILABLE',
    'mất phản hồi create: báo lỗi rõ, không tạo request giả');
  const ordersBeforeRetry = fake.orderCount();
  const retried = await runtime.create({ userId: buyer.id, amount: 12000, requestId: creq });
  t.eq(fake.orderCount(), ordersBeforeRetry, 'retry cùng requestId: không tạo order mới (idempotency key)');
  t.ok(retried.orderId && (await bindingRow(retried.id)).order_id === retried.orderId, 'retry gắn đúng order đã tạo');

  // Lệnh create bị rớt trước khi tới PayPal; rồi giả lập đồng hồ đã qua 6 phút (tắt tạm trigger bất biến của fixture).
  const agedKey = 'old-' + uuid();
  fake.plan('create', 'drop');
  await t.rejects(() => runtime.create({ userId: buyer.id, amount: 14000, requestId: agedKey }), 'PAYPAL_UNAVAILABLE',
    'create bị rớt trước khi tới PayPal: lỗi mạng');
  const agedRow = await db.prepare('SELECT id FROM payment_requests WHERE client_request_id = ?').get(agedKey);
  await withTriggerDisabled(db, 'paypal_payment_bindings', async () => {
    await db.prepare('UPDATE paypal_payment_bindings SET create_attempt_at = ? WHERE payment_request_id = ?')
      .run('2000-01-01T00:00:00.000Z', agedRow.id);
  });
  const createsBeforeExpiry = fake.calls('create').length;
  await t.rejects(() => runtime.create({ userId: buyer.id, amount: 14000, requestId: agedKey }),
    'PAYPAL_CREATE_RECOVERY_REQUIRED', 'quá cửa sổ 5 phút khi chưa gắn order: không tạo order mới');
  t.eq(fake.calls('create').length, createsBeforeExpiry, 'không có lệnh create nào sau cửa sổ');

  const g = await approvedRequest(buyer);
  fake.plan('capture', 'lose');
  await t.rejects(() => runtime.capture(g.id, buyer.id), 'PAYPAL_UNAVAILABLE', 'mất phản hồi capture: báo lỗi');
  t.eq(fake.order(g.orderId).status, 'COMPLETED', 'PayPal đã thu tiền (phía nhà cung cấp)');
  t.eq((await H.credits(db, g.id)).length, 0, 'phía ta chưa cộng tiền khi chưa xác minh');
  t.eq((await runtime.serializePayPal(g.id)).stage, 'RECONCILING', 'hiển thị RECONCILING, không thành công giả');
  t.eq((await runtime.reconcileOne(g.id)).outcome, 'APPLIED', 'GET xác minh rồi tất toán');
  t.eq((await H.credits(db, g.id)).length, 1, 'đúng một bút toán sau khi xác minh');

  const h = await approvedRequest(buyer);
  fake.plan('capture', { kind: 'hold' });
  const timeoutErr = await runtime.capture(h.id, buyer.id).then(() => null, (e) => e);
  t.eq(timeoutErr && timeoutErr.code, 'PAYPAL_TIMEOUT', 'POST treo quá thời gian chờ: PAYPAL_TIMEOUT');
  const [effectH] = fake.pendingEffects().filter(Boolean).slice(-1);
  t.ok(effectH, 'lệnh thu vẫn đang treo phía nhà cung cấp');
  fake.completeEffect(effectH);
  t.eq(fake.order(h.orderId).status, 'COMPLETED', 'lệnh muộn hoàn tất: PayPal đã thu');
  t.eq((await runtime.reconcileOne(h.id)).outcome, 'APPLIED', 'đối soát sau timeout: tất toán một lần');
  t.eq((await H.credits(db, h.id)).length, 1, 'một bút toán dù có timeout');

  // ===================================================================================
  t.section('T6 — barrier: holder cũ đang treo, hết lease, holder mới, đóng/webhook/GET, rồi POST cũ hoàn tất muộn');
  const k = await approvedRequest(buyer);
  fake.plan('capture', { kind: 'hold' });
  const holderA = runtimeLong.capture(k.id, buyer.id).then((r) => ({ r }), (e) => ({ e }));
  await waitFor(async () => fake.pendingEffects().length >= 1 && (await postSent(k.id)), 'holder A gửi POST và treo');
  const effectK = fake.pendingEffects().slice(-1)[0];
  const closeByOthers = await runtime.store.closeUncaptured(k.id, { nowIso: nowIso(), reason: 'ORDER_EXPIRED' });
  t.ok(closeByOthers.closed === false && closeByOthers.reason === 'CAPTURE_IN_FLIGHT',
    `đóng hết hạn khi holder A đang giữ quyền: không thắng (${closeByOthers.reason})`);
  await expireLease(k.id);
  // Webhook báo "đã thu" nhưng GET chưa thấy capture: service từ chối (409), không tất toán. PayPal sẽ gửi lại.
  await t.rejects(() => runtime.webhook(hdr(), evt(k)), 'PAYPAL_ORDER_MISMATCH',
    'webhook báo đã thu khi GET chưa thấy capture: từ chối 409, không tất toán (PayPal gửi lại)');
  t.eq((await H.credits(db, k.id)).length, 0, 'chưa có bút toán khi holder A còn treo');
  const holderB = await runtime.capture(k.id, buyer.id);
  t.eq(holderB.outcome, 'APPLIED', 'holder mới sau khi hết lease: thu và tất toán');
  t.eq(fake.countCalls('capture', k.orderId), 2, 'hai lệnh thu ở phía nhà cung cấp (A treo, B thu)');
  fake.completeEffect(effectK);
  const aOutcome = await holderA;
  t.eq(aOutcome.r && aOutcome.r.outcome, 'DUPLICATE',
    'holder A đến muộn (422 ORDER_ALREADY_CAPTURED, GET xác minh): đầu ra DUPLICATE, không ghi đè');
  t.eq((await H.credits(db, k.id)).length, 1, 'đúng một bút toán dù holder cũ hoàn tất muộn');
  t.eq((await requestRow(k.id)).status, 'SUCCEEDED', 'request SUCCEEDED đúng một lần');

  const m = await approvedRequest(buyer);
  fake.plan('capture', { kind: 'hold' });
  const holderM = runtimeLong.capture(m.id, buyer.id).then((r) => ({ r }), (e) => ({ e }));
  await waitFor(async () => fake.pendingEffects().length >= 1 && (await postSent(m.id)), 'holder M gửi POST và treo');
  const effectM = fake.pendingEffects().slice(-1)[0];
  await db.prepare("UPDATE payment_requests SET status='FAILED' WHERE id=?").run(m.id);
  fake.completeEffect(effectM);
  const lateM = await holderM;
  const rowM = await runtime.store.loadByRequestId(m.id);
  t.eq(lateM.r && lateM.r.outcome, 'RECOVERY_REQUIRED', 'thu tiền muộn trên request đã FAILED: RECOVERY_REQUIRED');
  t.ok(rowM.capture.state === 'RECOVERY_REQUIRED' && rowM.capture.captureId === 'CAP' + m.orderId,
    'bằng chứng thu muộn được giữ bền (capture ID đúng), không thành thành công giả');
  t.eq((await H.credits(db, m.id)).length, 0, 'không cộng tiền vào request đã đóng');
  t.eq((await requestRow(m.id)).status, 'FAILED', 'request FAILED không được mở lại');
  const recovery = await runtime.reconcileOne(m.id);
  t.eq(recovery.outcome, 'RECOVERY_REQUIRED', 'đối soát trên request đã đóng: vẫn RECOVERY_REQUIRED, không tự credit');
  t.eq((await H.credits(db, m.id)).length, 0, 'vẫn không có bút toán sau đối soát');

  // ===================================================================================
  t.section('Bất biến PayPal: dữ liệu sai bị phát hiện trong giao dịch có rollback');
  const sample = await approvedRequest(buyer);
  const walletRow = await H.wallet(db, buyer.id);
  const fixtures = [
    ['SUCCEEDED không có bút toán', async () => {
      await db.prepare("UPDATE payment_requests SET status='SUCCEEDED' WHERE id=?").run(sample.id);
    }, 'PAYPAL_SUCCEEDED_HAS_ONE_CREDIT_AND_CAPTURE'],
    ['bút toán TOPUP_CREDIT cho request PENDING', async () => {
      await db.prepare(`INSERT INTO wallet_entries (id,wallet_id,transaction_id,request_id,entry_type,available_delta,locked_delta,available_after,locked_after,idempotency_key,description,created_at)
        VALUES (?,?,NULL,?,'TOPUP_CREDIT',10000,0,10000,0,?,'fixture',?)`).run(uuid(), walletRow.id, sample.id, 'fixture-' + uuid(), nowIso());
    }, 'PAYPAL_CREDIT_REQUIRES_SUCCEEDED'],
  ];
  for (const [label, inject, code] of fixtures) {
    let found = null;
    await db.transaction(async () => {
      await inject();
      const inv = await H.invariantSummary(db);
      found = inv.paypal.find((p) => p.code === code && p.count > 0) || null;
      throw Object.assign(new Error('rollback fixture'), { fixtureRollback: true });
    })().catch((e) => { if (!e.fixtureRollback) throw e; });
    t.ok(Boolean(found), `fixture "${label}" bị bất biến ${code} phát hiện`);
  }
  const clean = await H.invariantSummary(db);
  t.ok(clean.paypalOk, 'sau rollback, ba bất biến PayPal đều đúng');
  t.ok(clean.coreOk, `chín bất biến cũ đều đúng (đã kiểm ${clean.coreChecked})`, JSON.stringify(clean.coreViolations).slice(0, 300));
  t.eq((await H.credits(db, sample.id)).length, 0, 'fixture không để lại bút toán');
  t.eq((await requestRow(sample.id)).status, 'PENDING', 'fixture không để lại trạng thái SUCCEEDED');

  const { pass, fail } = t.summary();
  process.exitCode = fail ? 1 : 0;
  await db.close();
}

main().catch((e) => { console.error(e.stack); process.exitCode = 1; });
