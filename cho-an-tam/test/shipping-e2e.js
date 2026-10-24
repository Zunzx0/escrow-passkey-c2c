'use strict';
// Vận chuyển mô phỏng: router thật, SQLite riêng, worker ở các tiến trình độc lập.
// Không đọc .env, không kế thừa DATABASE_URL/secret, không chạm DB của server đang chạy.
// Chạy trực tiếp: node test/shipping-e2e.js
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..');
const TEST_DIR = path.join(ROOT, 'data', 'test');
const mode = process.argv[2];

function safeEnv(dbPath, secret) {
  const env = {};
  for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return {
    ...env, APP_ENV: 'test', DATABASE_URL: '', DB_PATH: dbPath,
    JWT_SECRET: secret, MOCK_PROVIDER_SECRET: crypto.randomBytes(32).toString('hex'),
    RATE_LIMIT_AUTH_PER_MINUTE: '10000', RATE_LIMIT_API_PER_MINUTE: '10000', SHIPPING_WORKER_INTERVAL_MS: '0',
    WEBAUTHN_RP_ID: 'localhost', WEBAUTHN_ORIGIN: 'http://localhost',
  };
}

function execute(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [__filename, ...args], {
      cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('shipping child quá hạn 30 giây')); }, 30000);
    child.stdout.on('data', (v) => { stdout += v; });
    child.stderr.on('data', (v) => { stderr += v; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

function assertIsolated() {
  const file = path.resolve(process.env.DB_PATH || '');
  assert.equal(process.env.APP_ENV, 'test');
  assert.equal(process.env.DATABASE_URL, '');
  assert.ok(file.startsWith(TEST_DIR + path.sep));
  assert.match(path.basename(path.dirname(file)), /^shipping-[A-Za-z0-9_-]+$/);
  assert.equal(path.basename(file), 'shipping.db');
}

async function launch() {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const dir = fs.mkdtempSync(path.join(TEST_DIR, 'shipping-'));
  const dbPath = path.join(dir, 'shipping.db');
  try {
    const result = await execute(['--run'], safeEnv(dbPath, crypto.randomBytes(48).toString('hex')));
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exitCode = result.code === 0 ? 0 : 1;
  } finally {
    // Chỉ xóa các tệp có tên cố định trong thư mục do chính lần chạy này tạo.
    assert.ok(path.resolve(dir).startsWith(TEST_DIR + path.sep));
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(dbPath + suffix); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    fs.rmdirSync(dir);
  }
}

async function runWorker() {
  assertIsolated();
  const { db } = require('../src/db');
  try {
    const { reconcileShipping } = require('../src/lib/shipping');
    const result = await reconcileShipping({ now: Number(process.argv[3]) });
    console.log('SHIPPING_WORKER ' + JSON.stringify(result));
  } finally { await db.close(); }
}

async function runTests() {
  assertIsolated();
  const { db } = require('../src/db');
  const { createSession } = require('../src/lib/session');
  const { signAccessToken } = require('../src/lib/auth');
  const { verifyChain, appendAuditLog } = require('../src/lib/hash');
  const { checkInvariants } = require('../src/lib/invariants');
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/transactions', require('../src/routes/transactions'));
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.code || 'INTERNAL_ERROR', message: err.message }));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/transactions`;
  let passed = 0;
  const ok = (value, label) => { assert.ok(value, label); passed++; console.log('  ✅ ' + label); };
  const eq = (actual, expected, label) => { assert.deepEqual(actual, expected, label); passed++; console.log('  ✅ ' + label); };
  const section = (name) => console.log('\n' + name);
  const allIds = [];

  async function api(route, { token, method = 'GET', body } = {}) {
    const response = await fetch(base + route, {
      method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }
  const post = (route, actor, body) => api(route, { token: actor?.token, method: 'POST', body });
  const detail = async (id, actor) => (await api('/' + id, { token: actor.token })).body;
  async function account(role, name, balance = 0) {
    const id = crypto.randomUUID(); const now = new Date().toISOString();
    await db.prepare(`INSERT INTO users (id,username,display_name,role,password_hash,account_status,token_version,is_active,created_at,updated_at)
      VALUES (?,?,?,?,?,'ACTIVE',0,1,?,?)`).run(id, name, name, role, 'fixture-only', now, now);
    await db.prepare(`INSERT INTO passkey_credentials (id,user_id,credential_id,public_key,counter,transports,device_name,created_at)
      VALUES (?,?,?,?,0,'[]','shipping-fixture',?)`).run(crypto.randomUUID(), id, 'credential-' + id, Buffer.from('fixture-only'), now);
    await db.prepare(`INSERT INTO wallets (id,user_id,wallet_type,available_balance,locked_balance,version,created_at,updated_at)
      VALUES (?,?,'USER',?,0,0,?,?)`).run(crypto.randomUUID(), id, balance, now, now);
    const { sessionId } = await createSession(id,{authMethod:'passkey'});
    return { id, sessionId, token: signAccessToken({ id, username: name, role, account_status: 'ACTIVE', token_version: 0 }, 'full', sessionId) };
  }
  async function securedOrder(buyer, seller, label) {
    const made = await post('', buyer, { sellerId: seller.id, itemName: label, amount: 60000 });
    eq(made.status, 201, label + ': tạo đơn qua router thật');
    const id = made.body.id; allIds.push(id);
    // Trusted fixture for shipping tests only. Real signature issuance is covered by auth-redesign-e2e.
    const {issueGrant,ACTIONS}=require('../src/lib/reauth');
    const txn=await db.prepare('SELECT * FROM transactions WHERE id=?').get(id);
    const issuer=await db.prepare('SELECT id FROM passkey_credentials WHERE user_id=?').get(buyer.id);
    const context=await require('../src/routes/transactions').buildAuthorizationContext(txn,ACTIONS.LOCK,buyer.sessionId);
    const contextHash=crypto.createHash('sha256').update(JSON.stringify(context)).digest('hex');
    const grant=await issueGrant({userId:buyer.id,sessionId:buyer.sessionId,transactionId:id,action:ACTIONS.LOCK,credentialId:issuer.id,contextHash});
    eq((await post('/' + id + '/secure', buyer, { requestId: crypto.randomUUID(),reauthGrant:grant.rawToken })).status, 200, label + ': khóa tiền qua router thật');
    return id;
  }
  const money = async () => ({
    wallets: await db.prepare('SELECT id,available_balance,locked_balance,version FROM wallets ORDER BY id').all(),
    entries: await db.prepare('SELECT id,entry_type,available_delta,locked_delta FROM wallet_entries ORDER BY id').all(),
  });
  async function workers(now, count = 1) {
    const results = await Promise.all(Array.from({ length: count }, () => execute(['--worker', String(now)], process.env)));
    return results.map((result) => {
      assert.equal(result.code, 0, result.stderr || result.stdout);
      const line = result.stdout.split(/\r?\n/).find((v) => v.startsWith('SHIPPING_WORKER '));
      assert.ok(line, result.stdout);
      return JSON.parse(line.slice('SHIPPING_WORKER '.length));
    });
  }
  const countAction = async (id, action) => Number((await db.prepare('SELECT COUNT(*) AS n FROM audit_logs WHERE transaction_id=? AND action=?').get(id, action)).n);
  const total = (results, field) => results.reduce((sum, value) => sum + Number(value[field] || 0), 0);

  try {
    console.log('=== SHIPPING: isolated SQLite, real HTTP routes and independent worker processes ===');
    const buyer = await account('BUYER', 'shipping-buyer', 1000000);
    const seller = await account('SELLER', 'shipping-seller');
    const stranger = await account('SELLER', 'shipping-stranger');

    section('S1 — quyền sở hữu, xác nhận đơn và double click đóng gói');
    const id = await securedOrder(buyer, seller, 'shipping-main');
    eq((await post('/' + id + '/pack')).status, 401, 'không đăng nhập không được đóng gói');
    eq((await post('/' + id + '/pack', buyer)).status, 403, 'người mua không đóng gói thay người bán');
    eq((await post('/' + id + '/pack', stranger)).status, 403, 'người bán khác không được điều khiển đơn');
    const beforeAck = await post('/' + id + '/pack', seller);
    eq(beforeAck.status, 409, 'phải xác nhận đơn trước khi đóng gói');
    eq(beforeAck.body.error, 'ACKNOWLEDGEMENT_REQUIRED', 'thiếu xác nhận có mã lỗi nghiệp vụ rõ ràng');
    eq((await detail(id, buyer)).shipment, null, 'thao tác bị chặn không tạo shipment');
    eq((await post('/' + id + '/acknowledge', seller)).status, 200, 'người bán xác nhận đơn');
    const locked = await money();
    const packed = await Promise.all([post('/' + id + '/pack', seller), post('/' + id + '/pack', seller)]);
    ok(packed.every((r) => [200, 201].includes(r.status)), 'hai yêu cầu đóng gói trả kết quả thành công có tính chống lặp');
    const shipment = packed[0].body.shipment;
    ok(shipment?.id, 'đơn mang mã shipment bền');
    eq(packed[1].body.shipment.id, shipment.id, 'double click chỉ tạo một shipment');
    eq(packed[1].body.shipment.packedAt, shipment.packedAt, 'double click không đặt lại đồng hồ vận chuyển');
    eq(shipment.status, 'PICKUP_PENDING', 'đóng gói bắt đầu ở trạng thái chờ lấy hàng');
    eq(Date.parse(shipment.pickupDueAt) - Date.parse(shipment.packedAt), 4700, 'lịch lấy hàng đúng thời gian animation đã duyệt');
    eq(Date.parse(shipment.arrivalDueAt) - Date.parse(shipment.packedAt), 19200, 'lịch giao hàng đúng thời gian animation đã duyệt');
    ok(Number.isFinite(Date.parse(shipment.serverNow)), 'response có giờ máy chủ để hai thiết bị đồng bộ');
    const legacyBypass = await post('/' + id + '/ship', seller);
    eq(legacyBypass.status, 409, 'endpoint gửi hàng cũ không vượt qua shipment đang chờ');
    eq(legacyBypass.body.error, 'SHIPMENT_MANAGED', 'bypass lịch vận chuyển có mã lỗi rõ ràng');
    eq(await money(), locked, 'đóng gói không thay số dư hoặc bút toán');
    const list = await api('', { token: buyer.token });
    const rows = Array.isArray(list.body) ? list.body : list.body.transactions;
    eq(rows.find((row) => row.id === id).shipment.id, shipment.id, 'danh sách và chi tiết cùng serialize shipment');
    eq((await api('/' + id, { token: stranger.token })).status, 403, 'người ngoài không đọc được lịch vận chuyển của đơn');

    section('S2 — hai worker, phục hồi qua tiến trình mới và nhận hàng sớm');
    const pickupAt = Date.parse(shipment.pickupDueAt);
    const arrivalAt = Date.parse(shipment.arrivalDueAt);
    await workers(pickupAt - 1);
    eq((await detail(id, buyer)).shipment.status, 'PICKUP_PENDING', 'worker không lấy hàng trước lịch');
    const pickupResults = await workers(pickupAt, 2);
    eq(total(pickupResults, 'pickedUp'), 1, 'hai tiến trình worker chỉ ghi nhận lấy hàng một lần');
    const inTransit = await detail(id, buyer);
    eq(inTransit.shipment.status, 'IN_TRANSIT', 'shipment đã rời điểm lấy');
    eq(inTransit.status, 'SHIPPING', 'hệ thống tự chuyển đơn sang đang vận chuyển');
    eq(inTransit.escrowStatus, 'LOCKED', 'tiền vẫn khóa trong ký quỹ khi đang giao');
    eq(inTransit.shipment.packedAt, shipment.packedAt, 'worker tiến trình mới phục hồi đúng mốc đóng gói đã lưu');
    eq(inTransit.shipment.arrivalDueAt, shipment.arrivalDueAt, 'khởi động worker mới không đặt lại lịch giao');
    const earlyReceipt = await post('/' + id + '/wait-confirm', buyer);
    eq(earlyReceipt.status, 409, 'người mua không xác nhận nhận hàng trước khi xe đến');
    eq(earlyReceipt.body.error, 'SHIPMENT_NOT_ARRIVED', 'nhận hàng sớm bị chặn bằng mã lỗi nghiệp vụ');
    eq((await post('/' + id + '/ship', seller)).status, 409, 'người bán không ghi đè trạng thái do worker quản lý');
    await workers(arrivalAt - 1);
    eq((await detail(id, buyer)).shipment.status, 'IN_TRANSIT', 'không báo đã đến sớm một mili giây');
    const arrivalResults = await workers(arrivalAt, 2);
    eq(total(arrivalResults, 'arrived'), 1, 'hai worker chỉ ghi nhận xe đến một lần');
    const arrived = await detail(id, buyer);
    eq(arrived.shipment.status, 'ARRIVED', 'shipment đã đến địa chỉ người mua');
    eq(arrived.status, 'SHIPPING', 'xe đến không tự xác nhận người mua đã nhận');
    eq(arrived.escrowStatus, 'LOCKED', 'xe đến không tự giải ngân');
    eq(await money(), locked, 'toàn bộ vận chuyển không sinh thêm dòng tiền');
    const auditCount = (await db.prepare('SELECT COUNT(*) AS n FROM audit_logs WHERE transaction_id=?').get(id)).n;
    await workers(arrivalAt + 60000, 2);
    eq((await db.prepare('SELECT COUNT(*) AS n FROM audit_logs WHERE transaction_id=?').get(id)).n, auditCount, 'chạy lặp worker không nhân đôi nhật ký');
    eq((await post('/' + id + '/wait-confirm', seller)).status, 403, 'người bán không xác nhận nhận hàng thay người mua');
    eq((await post('/' + id + '/wait-confirm', buyer)).status, 200, 'sau xe đến người mua tự xác nhận đã nhận');
    eq((await detail(id, buyer)).status, 'WAIT_CONFIRM', 'chỉ thao tác người mua mở thời hạn kiểm tra hàng');

    section('S3 — tranh chấp dừng vận chuyển, không worker nào ghi đè nghiệp vụ');
    const [disputed] = await Promise.all([
      post('/' + id + '/dispute', buyer, { reason: 'Sản phẩm không đúng mô tả; kiểm thử chặn worker' }),
      workers(arrivalAt + 120000, 2),
    ]);
    eq(disputed.status, 201, 'người mua mở tranh chấp qua API thật');
    await workers(arrivalAt + 120000, 2);
    const disputeState = await detail(id, buyer);
    eq(disputeState.status, 'DISPUTED', 'worker không ghi đè trạng thái tranh chấp');
    eq(disputeState.escrowStatus, 'FROZEN', 'worker không mở khóa tiền đang tranh chấp');
    eq(disputeState.shipment.status, 'STOPPED', 'shipment đã đến cũng dừng khi đơn bị tranh chấp');
    eq(disputeState.shipment.arrivedAt, arrived.shipment.arrivedAt, 'dừng shipment giữ lại bằng chứng xe đã đến');
    eq((await post('/' + id + '/pack', seller)).status, 409, 'không đóng gói lại hoặc khởi động lại đơn tranh chấp');
    eq(await money(), locked, 'tranh chấp và worker không chuyển tiền');

    // Trạng thái phòng thủ: một quy trình nghiệp vụ khác đóng băng đơn ngay khi worker đến hạn.
    // Ghi cùng transaction + audit, chỉ trong DB tạm; không thêm endpoint chỉnh thời gian/trạng thái.
    const raceId = await securedOrder(buyer, seller, 'shipping-stop-race');
    await post('/' + raceId + '/acknowledge', seller);
    const racePack = await post('/' + raceId + '/pack', seller);
    const raceMoney = await money();
    await db.transaction(async () => {
      const now = new Date().toISOString();
      await db.prepare("INSERT INTO disputes (id,transaction_id,created_by,reason,status,created_at) VALUES (?,?,?,?,'OPEN',?)")
        .run(crypto.randomUUID(), raceId, buyer.id, 'fixture: concurrent business freeze', now);
      await db.prepare("UPDATE transactions SET status='DISPUTED',escrow_status='FROZEN',version=version+1,updated_at=? WHERE id=?").run(now, raceId);
      await appendAuditLog(db, { transactionId: raceId, actorId: buyer.id, action: 'DISPUTE_OPENED', oldStatus: 'SECURED', newStatus: 'DISPUTED', eventData: { fixture: 'business-freeze-before-worker' } });
    })();
    const stopped = await workers(Date.parse(racePack.body.shipment.arrivalDueAt), 2);
    eq(total(stopped, 'stopped'), 1, 'hai worker chỉ dừng shipment bị đóng băng một lần');
    const stoppedState = await detail(raceId, buyer);
    eq(stoppedState.shipment.status, 'STOPPED', 'shipment chờ lấy bị dừng khi giao dịch đã tranh chấp');
    eq(stoppedState.status, 'DISPUTED', 'worker đến hạn không kéo đơn tranh chấp về SHIPPING');
    eq(stoppedState.shipment.pickedUpAt, null, 'đơn bị đóng băng không phát sinh mốc lấy hàng giả');
    eq(await money(), raceMoney, 'dừng shipment giữ nguyên tất cả ví và bút toán');

    section('S4 — phục hồi sau downtime, legacy và bất biến');
    const lateId = await securedOrder(buyer, seller, 'shipping-offline-recovery');
    await post('/' + lateId + '/acknowledge', seller);
    const late = await post('/' + lateId + '/pack', seller);
    const lateMoney = await money();
    const recovered = await workers(Date.parse(late.body.shipment.arrivalDueAt) + 60000);
    eq(total(recovered, 'pickedUp'), 1, 'restart sau downtime phục hồi cả bước lấy hàng đã quá hạn');
    eq(total(recovered, 'arrived'), 1, 'restart sau downtime phục hồi bước xe đến');
    eq((await detail(lateId, buyer)).shipment.status, 'ARRIVED', 'downtime không làm kẹt đơn');
    eq((await detail(lateId, buyer)).status, 'SHIPPING', 'phục hồi muộn vẫn không tự nhận hàng hoặc giải ngân');
    eq(await money(), lateMoney, 'phục hồi muộn không đụng dòng tiền');
    await post('/' + lateId + '/wait-confirm', buyer);
    // Cấp grant fixture có phạm vi thật để kiểm terminal guard, không thay thế test WebAuthn.
    const { issueGrant, ACTIONS } = require('../src/lib/reauth');
    const issuer=await db.prepare('SELECT id FROM passkey_credentials WHERE user_id=? LIMIT 1').get(buyer.id);
    const context=await require('../src/routes/transactions').buildAuthorizationContext(await db.prepare('SELECT * FROM transactions WHERE id=?').get(lateId),ACTIONS.RELEASE,buyer.sessionId);
    const contextHash=crypto.createHash('sha256').update(JSON.stringify(context)).digest('hex');
    const grant = await issueGrant({ userId: buyer.id, sessionId: buyer.sessionId, transactionId: lateId, action: ACTIONS.RELEASE,credentialId:issuer.id,contextHash });
    eq((await post('/' + lateId + '/release', buyer, { requestId: crypto.randomUUID(), reauthGrant: grant.rawToken })).status, 200, 'tất toán qua endpoint giải ngân thật với grant test đúng phạm vi');
    const settledMoney = await money();
    await workers(Date.parse(late.body.shipment.arrivalDueAt) + 120000, 2);
    const completed = await detail(lateId, buyer);
    eq(completed.status, 'COMPLETED', 'worker không khôi phục đơn đã hoàn tất');
    eq(completed.escrowStatus, 'RELEASED', 'worker không khóa lại tiền đã giải ngân');
    eq(completed.shipment.status, 'STOPPED', 'shipment của đơn terminal được dừng');
    eq(await money(), settledMoney, 'worker không giải ngân thêm lần nữa sau khi tất toán');
    const legacyId = await securedOrder(buyer, seller, 'shipping-legacy');
    eq((await post('/' + legacyId + '/ship', seller)).status, 200, 'đơn legacy không shipment vẫn dùng luồng cũ');
    eq((await post('/' + legacyId + '/wait-confirm', buyer)).status, 200, 'đơn legacy vẫn xác nhận nhận hàng bình thường');
    for (const txnId of allIds) {
      ok((await verifyChain(db, txnId)).valid, 'chuỗi băm hợp lệ: ' + txnId);
      eq(await countAction(txnId, 'ESCROW_LOCKED'), 1, 'mỗi đơn chỉ khóa tiền một lần: ' + txnId);
    }
    const invariants = await checkInvariants(db);
    eq(invariants.checked, 9, 'chạy đủ chín bất biến tài chính và an toàn');
    ok(invariants.ok, 'không vi phạm bất biến: ' + JSON.stringify(invariants.violations));
    console.log(`\n[shipping-e2e] ${passed} đạt, 0 hỏng`);
  } finally {
    await new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });
    await db.close();
  }
}

(mode === '--worker' ? runWorker() : mode === '--run' ? runTests() : launch()).catch((error) => {
  console.error('  ❌ shipping-e2e:', error.stack || error);
  process.exitCode = 1;
});
