/**
 * Hồi quy cho GitHub issue #5 (nhánh claude/fix-listing-lifecycle-role).
 *
 * Lỗi 1 — vòng đời tin đăng sau tất toán. /secure đưa tin đăng AVAILABLE -> LOCKED, nhưng trước
 * bản sửa không đường nào đưa nó ra: hoàn tiền xong tin đăng vẫn LOCKED (không ai mua lại được),
 * giải ngân xong cũng chỉ LOCKED chứ không SOLD. Nay (lib/listingLifecycle.js), trong CÙNG giao
 * dịch cơ sở dữ liệu với dòng tiền:
 *   hoàn tiền (admin-refund)                       -> AVAILABLE
 *   giải ngân (release của người mua / admin-release) -> SOLD
 *
 * Lỗi 2 — người mua được duyệt quyền bán trong lúc còn đơn dở dang. Duyệt đổi users.role
 * BUYER -> SELLER cho cả tài khoản, còn /wait-confirm đòi requireRole('BUYER'), nên chính người
 * mua của đơn không xác nhận nhận hàng được và tiền kẹt ở SHIPPING. Nay quyền trên đơn chỉ xét
 * buyer_id của chính đơn đó.
 *
 * Các kịch bản:
 *   L1  hoàn tiền -> tin đăng AVAILABLE -> người khác mua lại trọn vòng -> SOLD
 *   L2  người mua giải ngân -> SOLD; không đặt đơn mới, không thanh toán được đơn CREATED cũ
 *   L3  quản trị viên phân xử giải ngân -> SOLD
 *   L4  sau hoàn tiền, hai người mua cùng thanh toán đồng thời -> đúng một người giữ được tin đăng
 *   L5  chèn lỗi giữa nghiệp vụ (server con FAULT_INJECT=before-audit-log) ở cả ba đường tất toán
 *       -> tiền, giao dịch, hồ sơ tranh chấp, phiếu và tin đăng cùng rollback; thử lại thì đúng
 *   N1  chuẩn hoá dữ liệu cũ lúc khởi động (REFUNDED+LOCKED, COMPLETED+LOCKED) và chạy lại
 *       không đổi gì
 *   P1  người mua được nâng quyền bán vẫn xác nhận nhận hàng + giải ngân được đơn cũ; người
 *       ngoài, người bán của đơn và quản trị viên vẫn bị chặn
 *
 * Yêu cầu: server test đang chạy (`npm run start:test`). L5 và N1 tự spawn server con dùng CHUNG
 * cơ sở dữ liệu test (cổng 3182), tắt mọi tác vụ nền và gỡ ADMIN_BOOTSTRAP_*.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { flows, createAdmin, createSeller } = require('./helpers/accounts');
const { checkInvariants } = require('../src/lib/invariants');
const { db } = require('../src/db');

const ROOT = path.join(__dirname, '..');
const BASE = process.env.BASE_URL || 'http://localhost:3100';
const CHILD_PORT = Number(process.env.TEST_CHILD_PORT_BASE || '3180') + 2;
const CHILD_BASE = `http://localhost:${CHILD_PORT}`;
const PRICE = 200000;

let failures = 0;
function assert(cond, label) {
  console.log(`  ${cond ? '✅' : '❌'} ${label}`);
  if (!cond) failures++;
}
function section(title) { console.log(`\n${title}`); }

async function api(p, opts = {}, retried = false) {
  const { method = 'GET', body, token, base = BASE } = opts;
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(base + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let data = {};
  try { data = await res.json(); } catch (_) {}
  if (res.status === 429 && !retried) {
    console.log('  ⏳ Chạm rate limit — chờ 60 giây rồi thử lại…');
    await new Promise((r) => setTimeout(r, 61000));
    return api(p, opts, true);
  }
  return { status: res.status, data };
}

const rid = () => crypto.randomUUID();
const uniq = (p) => `${p}-${Date.now()}-${crypto.randomUUID().slice(0, 6)}`;

async function listingRow(id) {
  return db.prepare('SELECT status, version FROM listings WHERE id = ?').get(id);
}
async function txnRow(id) {
  return db.prepare('SELECT status, escrow_status, version FROM transactions WHERE id = ?').get(id);
}
async function escrowLocked() {
  return (await db.prepare("SELECT locked_balance FROM wallets WHERE wallet_type = 'SYSTEM_ESCROW'").get()).locked_balance;
}
async function available(userId) {
  return (await db.prepare("SELECT available_balance FROM wallets WHERE user_id = ? AND wallet_type = 'USER'").get(userId)).available_balance;
}
async function grantUsed(rawToken) {
  const hash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const row = await db.prepare('SELECT used_at FROM reauth_grants WHERE token_hash = ?').get(hash);
  return row ? row.used_at : undefined;
}

async function assertInvariantsOk(label) {
  const r = await checkInvariants(db);
  assert(r.ok, `${label}: ${r.checked} bất biến đều đúng${r.ok ? '' : ` (vi phạm: ${JSON.stringify(r.violations)})`}`);
}

async function createListing(seller, label) {
  const r = await api('/api/listings', {
    method: 'POST', token: seller.token,
    body: { title: `${label} ${crypto.randomUUID().slice(0, 8)}`, category: 'MAY_TINH', price: PRICE, location: 'Hà Nội' },
  });
  if (r.status !== 201) throw new Error(`tạo tin đăng thất bại: ${JSON.stringify(r.data)}`);
  return r.data.id;
}

async function placeOrder(buyer, listingId) {
  const r = await api('/api/transactions/orders', { method: 'POST', token: buyer.token, body: { listingId } });
  return r;
}

async function mustOk(res, what) {
  if (res.status >= 400) throw new Error(`${what} thất bại (${res.status}): ${JSON.stringify(res.data)}`);
  return res;
}

/** Đặt mua + thanh toán + giao hàng + xác nhận nhận hàng: đơn ở WAIT_CONFIRM + LOCKED. */
async function toWaitConfirm(buyer, seller, listingId) {
  const order = await mustOk(await placeOrder(buyer, listingId), 'đặt đơn');
  const txnId = order.data.id;
  await mustOk(await api(`/api/transactions/${txnId}/secure`, { method: 'POST', token: buyer.token, body: { requestId: rid() } }), 'secure');
  await mustOk(await api(`/api/transactions/${txnId}/ship`, { method: 'POST', token: seller.token }), 'ship');
  await mustOk(await api(`/api/transactions/${txnId}/wait-confirm`, { method: 'POST', token: buyer.token }), 'wait-confirm');
  return txnId;
}

async function openDispute(txnId, token) {
  const r = await mustOk(
    await api(`/api/transactions/${txnId}/dispute`, { method: 'POST', token, body: { reason: 'Kiểm thử vòng đời tin đăng' } }),
    'mở tranh chấp'
  );
  return r.data.dispute.id;
}

async function buyerRelease(buyer, txnId, opts = {}) {
  const grant = await flows.releaseGrant(buyer.token, buyer.auth, txnId);
  if (grant.status !== 200) throw new Error(`xin phiếu giải ngân thất bại: ${JSON.stringify(grant.data)}`);
  const res = await api(`/api/transactions/${txnId}/release`, {
    method: 'POST', token: buyer.token, base: opts.base,
    body: { requestId: rid(), reauthGrant: grant.data.reauthGrant },
  });
  return { res, grant: grant.data.reauthGrant };
}

/**
 * Server con dùng CHUNG cơ sở dữ liệu test với server chính. Tắt đối soát và dọn challenge (khoảng
 * chạy = 0), gỡ ADMIN_BOOTSTRAP_*: việc duy nhất nó làm với DB ngoài các request do bài test gửi
 * là bước khởi tạo lúc khởi động (migration đã áp thì bỏ qua, chuẩn hoá tin đăng — xem N1).
 */
async function startChild(extraEnv = {}) {
  const env = {
    ...process.env,
    PORT: String(CHILD_PORT),
    RECONCILE_INTERVAL_SECONDS: '0',
    CHALLENGE_CLEANUP_INTERVAL_SECONDS: '0',
  };
  for (const k of Object.keys(env)) {
    if (k.startsWith('ADMIN_BOOTSTRAP_') || k === 'FAULT_INJECT' || k === 'FAULT_INJECT_MODE') delete env[k];
  }
  Object.assign(env, extraEnv);

  const child = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const state = { out: '' };
  child.stdout.on('data', (d) => { state.out += d; });
  child.stderr.on('data', (d) => { state.out += d; });

  let health = null;
  for (let i = 0; i < 60 && !health && child.exitCode === null; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try { health = await (await fetch(`${CHILD_BASE}/health`)).json(); } catch (_) {}
  }

  async function stop() {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      const timedOut = await Promise.race([exited.then(() => false), new Promise((r) => setTimeout(() => r(true), 5000))]);
      if (timedOut) {
        child.kill('SIGKILL');
        await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
      }
    }
    return child.exitCode !== null || child.signalCode !== null;
  }

  return { health, state, stop };
}

async function main() {
  section('Chuẩn bị: quản trị viên, người bán, bốn người mua');
  const admin = await createAdmin(null, { username: uniq('admin-ll') });
  const seller = await createSeller(null, null, admin, { username: uniq('seller-ll'), displayName: 'Người bán LL' });
  const buyerA = await flows.registerUser({ username: uniq('buyer-a'), displayName: 'Người mua A' });
  const buyerB = await flows.registerUser({ username: uniq('buyer-b'), displayName: 'Người mua B' });
  const buyerC = await flows.registerUser({ username: uniq('buyer-c'), displayName: 'Người mua C' });
  const buyerD = await flows.registerUser({ username: uniq('buyer-d'), displayName: 'Người mua D' });
  assert([admin, seller, buyerA, buyerB, buyerC, buyerD].every((u) => !!u.token), 'Sáu tài khoản sẵn sàng');

  // =======================================================================================
  section('L1: Hoàn tiền -> tin đăng AVAILABLE -> người khác mua lại trọn vòng -> SOLD');
  // =======================================================================================
  {
    const listingId = await createListing(seller, 'L1');
    const txn1 = await toWaitConfirm(buyerA, seller, listingId);
    assert((await listingRow(listingId)).status === 'LOCKED', 'Đơn đã khoá tiền: tin đăng LOCKED');

    const disputeId = await openDispute(txn1, buyerA.token);
    const grant = await flows.adjudicationGrant(admin.token, admin.auth, disputeId, 'REFUND');
    const refund = await api(`/api/admin/disputes/${disputeId}/refund`, {
      method: 'POST', token: admin.token, body: { requestId: rid(), reauthGrant: grant.data.reauthGrant },
    });
    assert(refund.status === 200 && refund.data.transaction.status === 'REFUNDED', `Hoàn tiền thành công (nhận ${refund.status} ${refund.data.error || ''})`);
    assert((await listingRow(listingId)).status === 'AVAILABLE', 'Sau hoàn tiền: tin đăng trở về AVAILABLE');

    const reorder = await placeOrder(buyerB, listingId);
    assert(reorder.status === 201, `Người mua khác đặt lại được đơn mới (nhận ${reorder.status} ${reorder.data.error || ''})`);
    const txn2 = reorder.data.id;
    const sec = await api(`/api/transactions/${txn2}/secure`, { method: 'POST', token: buyerB.token, body: { requestId: rid() } });
    assert(sec.status === 200, `Đơn mua lại thanh toán được (nhận ${sec.status} ${sec.data.error || ''})`);
    assert((await listingRow(listingId)).status === 'LOCKED', 'Đơn mua lại khoá tiền: tin đăng LOCKED lần nữa');
    await mustOk(await api(`/api/transactions/${txn2}/ship`, { method: 'POST', token: seller.token }), 'ship');
    await mustOk(await api(`/api/transactions/${txn2}/wait-confirm`, { method: 'POST', token: buyerB.token }), 'wait-confirm');
    const { res } = await buyerRelease(buyerB, txn2);
    assert(res.status === 200 && res.data.status === 'COMPLETED', `Đơn mua lại giải ngân xong (nhận ${res.status} ${res.data.error || ''})`);
    assert((await listingRow(listingId)).status === 'SOLD', 'Đơn mua lại hoàn tất: tin đăng SOLD');
    await assertInvariantsOk('Sau L1');
  }

  // =======================================================================================
  section('L2: Người mua giải ngân -> SOLD; không mua lại được bằng đơn mới lẫn đơn CREATED cũ');
  // =======================================================================================
  {
    const listingId = await createListing(seller, 'L2');
    // Đơn CREATED của người thứ hai, tạo TRƯỚC khi đơn thứ nhất khoá tiền (CREATED chưa giữ chỗ).
    const early = await placeOrder(buyerB, listingId);
    assert(early.status === 201, 'Đơn CREATED của người thứ hai được tạo trước');

    const txn = await toWaitConfirm(buyerA, seller, listingId);
    const { res } = await buyerRelease(buyerA, txn);
    assert(res.status === 200 && res.data.status === 'COMPLETED', `Giải ngân thành công (nhận ${res.status} ${res.data.error || ''})`);
    const row = await listingRow(listingId);
    assert(row.status === 'SOLD', `Sau giải ngân: tin đăng SOLD (thực tế ${row.status})`);

    const late = await placeOrder(buyerC, listingId);
    assert(late.status === 409 && late.data.error === 'LISTING_SOLD', `Đặt đơn mới vào tin đã bán bị 409 LISTING_SOLD (nhận ${late.status} ${late.data.error})`);
    const lateSecure = await api(`/api/transactions/${early.data.id}/secure`, { method: 'POST', token: buyerB.token, body: { requestId: rid() } });
    assert(lateSecure.status === 409 && lateSecure.data.error === 'LISTING_SOLD',
      `Thanh toán đơn CREATED cũ vào tin đã bán bị 409 LISTING_SOLD (nhận ${lateSecure.status} ${lateSecure.data.error})`);
    assert((await txnRow(early.data.id)).status === 'CREATED', 'Đơn CREATED cũ không bị khoá tiền');
    await assertInvariantsOk('Sau L2');
  }

  // =======================================================================================
  section('L3: Quản trị viên phân xử giải ngân -> SOLD');
  // =======================================================================================
  {
    const listingId = await createListing(seller, 'L3');
    const txn = await toWaitConfirm(buyerA, seller, listingId);
    const disputeId = await openDispute(txn, seller.token);
    const grant = await flows.adjudicationGrant(admin.token, admin.auth, disputeId, 'RELEASE');
    const rel = await api(`/api/admin/disputes/${disputeId}/release`, {
      method: 'POST', token: admin.token, body: { requestId: rid(), reauthGrant: grant.data.reauthGrant },
    });
    assert(rel.status === 200 && rel.data.transaction.status === 'RELEASED', `Phân xử giải ngân thành công (nhận ${rel.status} ${rel.data.error || ''})`);
    assert((await listingRow(listingId)).status === 'SOLD', 'Sau phân xử giải ngân: tin đăng SOLD');
    const late = await placeOrder(buyerC, listingId);
    assert(late.status === 409 && late.data.error === 'LISTING_SOLD', `Không đặt mua được tin đã bán (nhận ${late.status} ${late.data.error})`);
    await assertInvariantsOk('Sau L3');
  }

  // =======================================================================================
  section('L4: Sau hoàn tiền, hai người mua cùng thanh toán ĐỒNG THỜI tin đăng vừa mở bán lại');
  // =======================================================================================
  {
    const listingId = await createListing(seller, 'L4');
    const txn = await toWaitConfirm(buyerA, seller, listingId);
    const disputeId = await openDispute(txn, buyerA.token);
    const grant = await flows.adjudicationGrant(admin.token, admin.auth, disputeId, 'REFUND');
    await mustOk(await api(`/api/admin/disputes/${disputeId}/refund`, {
      method: 'POST', token: admin.token, body: { requestId: rid(), reauthGrant: grant.data.reauthGrant },
    }), 'hoàn tiền');
    assert((await listingRow(listingId)).status === 'AVAILABLE', 'Tin đăng mở bán lại (AVAILABLE)');

    const oC = await mustOk(await placeOrder(buyerC, listingId), 'đơn của C');
    const oD = await mustOk(await placeOrder(buyerD, listingId), 'đơn của D');
    const escrowBefore = await escrowLocked();
    const [sC, sD] = await Promise.all([
      api(`/api/transactions/${oC.data.id}/secure`, { method: 'POST', token: buyerC.token, body: { requestId: rid() } }),
      api(`/api/transactions/${oD.data.id}/secure`, { method: 'POST', token: buyerD.token, body: { requestId: rid() } }),
    ]);
    console.log(`  [L4] C -> ${sC.status} ${sC.data.error || sC.data.status}   D -> ${sD.status} ${sD.data.error || sD.data.status}`);
    const winners = [sC, sD].filter((r) => r.status === 200);
    const loser = sC.status === 200 ? sD : sC;
    assert(winners.length === 1, `Đúng một người thanh toán được (thực tế ${winners.length})`);
    assert(loser.status === 409 && loser.data.error === 'LISTING_SOLD', `Người còn lại nhận 409 LISTING_SOLD (nhận ${loser.status} ${loser.data.error})`);
    assert((await listingRow(listingId)).status === 'LOCKED', 'Tin đăng LOCKED cho đúng người thắng');
    assert((await escrowLocked()) - escrowBefore === PRICE, 'Ký quỹ chỉ tăng đúng một lần giá sản phẩm');
    await assertInvariantsOk('Sau L4');
  }

  // =======================================================================================
  section('L5: Chèn lỗi giữa nghiệp vụ tất toán -> tin đăng rollback cùng với tiền');
  // =======================================================================================
  {
    // Chuẩn bị TRÊN SERVER CHÍNH: ba đơn ở đúng trạng thái trước tất toán, kèm phiếu uỷ quyền.
    const lRefund = await createListing(seller, 'L5-refund');
    const tRefund = await toWaitConfirm(buyerA, seller, lRefund);
    const dRefund = await openDispute(tRefund, buyerA.token);
    const gRefund = (await flows.adjudicationGrant(admin.token, admin.auth, dRefund, 'REFUND')).data.reauthGrant;

    const lAdminRel = await createListing(seller, 'L5-admin-release');
    const tAdminRel = await toWaitConfirm(buyerA, seller, lAdminRel);
    const dAdminRel = await openDispute(tAdminRel, seller.token);
    const gAdminRel = (await flows.adjudicationGrant(admin.token, admin.auth, dAdminRel, 'RELEASE')).data.reauthGrant;

    const lRel = await createListing(seller, 'L5-release');
    const tRel = await toWaitConfirm(buyerA, seller, lRel);
    const gRelRes = await flows.releaseGrant(buyerA.token, buyerA.auth, tRel);
    const gRel = gRelRes.data.reauthGrant;
    assert(!!gRefund && !!gAdminRel && !!gRel, 'Có đủ ba phiếu uỷ quyền (REFUND, RELEASE phân xử, giải ngân của người mua)');

    const snapshot = async () => ({
      escrow: await escrowLocked(),
      buyer: await available(buyerA.user.id),
      seller: await available(seller.user.id),
      listings: [await listingRow(lRefund), await listingRow(lAdminRel), await listingRow(lRel)].map((l) => `${l.status}/${l.version}`),
      txns: [await txnRow(tRefund), await txnRow(tAdminRel), await txnRow(tRel)].map((t) => `${t.status}/${t.escrow_status}/${t.version}`),
    });
    const before = await snapshot();

    // Điểm before-audit-log nằm SAU khi ví, bút toán, trạng thái giao dịch, hồ sơ tranh chấp VÀ
    // tin đăng đều đã ghi trong giao dịch — đúng chỗ phải chứng minh tin đăng rollback cùng tiền.
    const child = await startChild({ FAULT_INJECT: 'before-audit-log' });
    try {
      assert(!!child.health && child.health.faultInject === 'before-audit-log',
        `Server con chạy với FAULT_INJECT=before-audit-log (health=${JSON.stringify(child.health)})`);

      const fRefund = await api(`/api/admin/disputes/${dRefund}/refund`, {
        method: 'POST', token: admin.token, base: CHILD_BASE, body: { requestId: rid(), reauthGrant: gRefund },
      });
      const fAdminRel = await api(`/api/admin/disputes/${dAdminRel}/release`, {
        method: 'POST', token: admin.token, base: CHILD_BASE, body: { requestId: rid(), reauthGrant: gAdminRel },
      });
      const fRel = await api(`/api/transactions/${tRel}/release`, {
        method: 'POST', token: buyerA.token, base: CHILD_BASE, body: { requestId: rid(), reauthGrant: gRel },
      });
      for (const [name, r] of [['admin-refund', fRefund], ['admin-release', fAdminRel], ['release', fRel]]) {
        assert(r.status === 500 && r.data.error === 'INJECTED_FAULT', `${name}: lỗi chèn chủ động bắn đúng (nhận ${r.status} ${r.data.error})`);
      }
    } finally {
      assert(await child.stop(), 'Server con chèn lỗi đã thoát hẳn');
    }

    const after = await snapshot();
    assert(JSON.stringify(after.listings) === JSON.stringify(before.listings),
      `Ba tin đăng giữ nguyên LOCKED và version (trước ${before.listings.join(', ')} | sau ${after.listings.join(', ')})`);
    assert(JSON.stringify(after.txns) === JSON.stringify(before.txns), 'Ba giao dịch giữ nguyên trạng thái và version');
    assert(after.escrow === before.escrow && after.buyer === before.buyer && after.seller === before.seller,
      'Ký quỹ, ví người mua, ví người bán không đổi một đồng');
    const disputes = await db.prepare('SELECT status FROM disputes WHERE id IN (?, ?)').all(dRefund, dAdminRel);
    assert(disputes.every((d) => d.status === 'OPEN'), 'Hai hồ sơ tranh chấp vẫn OPEN');
    assert((await grantUsed(gRefund)) === null && (await grantUsed(gAdminRel)) === null && (await grantUsed(gRel)) === null,
      'Ba phiếu uỷ quyền chưa bị tiêu thụ');
    await assertInvariantsOk('Sau L5 (đã chèn lỗi)');

    // Thử lại trên server chính bằng ĐÚNG ba phiếu đó: tất toán đi trọn và tin đăng ra đúng chỗ.
    const rRefund = await api(`/api/admin/disputes/${dRefund}/refund`, {
      method: 'POST', token: admin.token, body: { requestId: rid(), reauthGrant: gRefund },
    });
    const rAdminRel = await api(`/api/admin/disputes/${dAdminRel}/release`, {
      method: 'POST', token: admin.token, body: { requestId: rid(), reauthGrant: gAdminRel },
    });
    const rRel = await api(`/api/transactions/${tRel}/release`, {
      method: 'POST', token: buyerA.token, body: { requestId: rid(), reauthGrant: gRel },
    });
    assert(rRefund.status === 200 && rAdminRel.status === 200 && rRel.status === 200,
      `Thử lại sau lỗi: cả ba tất toán thành công (${rRefund.status}/${rAdminRel.status}/${rRel.status})`);
    assert((await listingRow(lRefund)).status === 'AVAILABLE', 'Hoàn tiền thử lại: tin đăng AVAILABLE');
    assert((await listingRow(lAdminRel)).status === 'SOLD', 'Phân xử giải ngân thử lại: tin đăng SOLD');
    assert((await listingRow(lRel)).status === 'SOLD', 'Người mua giải ngân thử lại: tin đăng SOLD');
    await assertInvariantsOk('Sau L5 (thử lại)');
  }

  // =======================================================================================
  section('N1: Chuẩn hoá dữ liệu cũ lúc khởi động, chạy lại không đổi gì');
  // =======================================================================================
  {
    // Dựng bốn tin đăng bằng luồng thật, rồi đưa hai tin về đúng hình dạng dữ liệu tạo TRƯỚC bản
    // sửa (đã tất toán nhưng còn LOCKED) bằng SQL — đây là thứ phép chuẩn hoá phải sửa.
    const lRefunded = await createListing(seller, 'N1-refunded');
    const t1 = await toWaitConfirm(buyerA, seller, lRefunded);
    const d1 = await openDispute(t1, buyerA.token);
    const g1 = await flows.adjudicationGrant(admin.token, admin.auth, d1, 'REFUND');
    await mustOk(await api(`/api/admin/disputes/${d1}/refund`, {
      method: 'POST', token: admin.token, body: { requestId: rid(), reauthGrant: g1.data.reauthGrant },
    }), 'hoàn tiền N1');

    const lCompleted = await createListing(seller, 'N1-completed');
    const t2 = await toWaitConfirm(buyerA, seller, lCompleted);
    await mustOk((await buyerRelease(buyerA, t2)).res, 'giải ngân N1');

    // Tin đăng đang có đơn giữ chỗ hợp lệ: phải giữ nguyên LOCKED.
    const lActive = await createListing(seller, 'N1-active');
    const t3 = await mustOk(await placeOrder(buyerA, lActive), 'đơn N1-active');
    await mustOk(await api(`/api/transactions/${t3.data.id}/secure`, { method: 'POST', token: buyerA.token, body: { requestId: rid() } }), 'secure N1-active');

    // Tin đăng có đơn cũ bị hoàn tiền NHƯNG đã có người khác khoá tiền lại: phải giữ LOCKED.
    const lResold = await createListing(seller, 'N1-resold');
    const t4 = await toWaitConfirm(buyerA, seller, lResold);
    const d4 = await openDispute(t4, buyerA.token);
    const g4 = await flows.adjudicationGrant(admin.token, admin.auth, d4, 'REFUND');
    await mustOk(await api(`/api/admin/disputes/${d4}/refund`, {
      method: 'POST', token: admin.token, body: { requestId: rid(), reauthGrant: g4.data.reauthGrant },
    }), 'hoàn tiền N1-resold');
    const t4b = await mustOk(await placeOrder(buyerB, lResold), 'đơn mua lại N1-resold');
    await mustOk(await api(`/api/transactions/${t4b.data.id}/secure`, { method: 'POST', token: buyerB.token, body: { requestId: rid() } }), 'secure N1-resold');

    await db.prepare(`UPDATE listings SET status = 'LOCKED' WHERE id IN (?, ?)`).run(lRefunded, lCompleted);
    assert((await listingRow(lRefunded)).status === 'LOCKED' && (await listingRow(lCompleted)).status === 'LOCKED',
      'Đã dựng lại dữ liệu cũ: REFUNDED+LOCKED và COMPLETED+LOCKED');

    const first = await startChild();
    assert(!!first.health, 'Server con khởi động (lần 1) — bước khởi tạo chạy phép chuẩn hoá');
    assert(await first.stop(), 'Server con lần 1 đã thoát hẳn');
    assert(/chuẩn hoá \d+ tin đăng đã bán -> SOLD, \d+ tin đăng đã hoàn tiền -> AVAILABLE/.test(first.state.out),
      'Log khởi động báo đã chuẩn hoá tin đăng');

    const afterFirst = {
      refunded: await listingRow(lRefunded), completed: await listingRow(lCompleted),
      active: await listingRow(lActive), resold: await listingRow(lResold),
    };
    assert(afterFirst.refunded.status === 'AVAILABLE', `REFUNDED+LOCKED -> AVAILABLE (thực tế ${afterFirst.refunded.status})`);
    assert(afterFirst.completed.status === 'SOLD', `COMPLETED+LOCKED -> SOLD (thực tế ${afterFirst.completed.status})`);
    assert(afterFirst.active.status === 'LOCKED', 'Tin đăng có đơn SECURED giữ nguyên LOCKED');
    assert(afterFirst.resold.status === 'LOCKED', 'Tin đăng có đơn cũ hoàn tiền nhưng đã bị khoá lại giữ nguyên LOCKED');
    await assertInvariantsOk('Sau N1 (lần 1)');

    const second = await startChild();
    assert(!!second.health, 'Server con khởi động (lần 2)');
    assert(await second.stop(), 'Server con lần 2 đã thoát hẳn');
    const afterSecond = [lRefunded, lCompleted, lActive, lResold];
    const rows2 = await Promise.all(afterSecond.map(listingRow));
    const rows1 = [afterFirst.refunded, afterFirst.completed, afterFirst.active, afterFirst.resold];
    assert(rows2.every((r, i) => r.status === rows1[i].status && r.version === rows1[i].version),
      'Chạy lại lần 2 không đổi status lẫn version của tin đăng nào (idempotent)');

    const reorder = await placeOrder(buyerC, lRefunded);
    assert(reorder.status === 201, `Tin đăng vừa được chuẩn hoá về AVAILABLE đặt mua lại được (nhận ${reorder.status})`);
  }

  // =======================================================================================
  section('P1: Người mua được duyệt quyền bán trong lúc còn đơn SHIPPING vẫn tất toán được đơn cũ');
  // =======================================================================================
  {
    // Dùng lại hai người mua đã tạo ở phần chuẩn bị: đăng ký thêm tài khoản ở cuối bộ dễ chạm giới
    // hạn tần suất đăng ký. P1 là kịch bản cuối nên đổi vai trò của C không ảnh hưởng kịch bản khác.
    const promoted = buyerC;
    const outsider = buyerD;
    const listingId = await createListing(seller, 'P1');
    const order = await mustOk(await placeOrder(promoted, listingId), 'đặt đơn P1');
    const txnId = order.data.id;
    await mustOk(await api(`/api/transactions/${txnId}/secure`, { method: 'POST', token: promoted.token, body: { requestId: rid() } }), 'secure P1');
    await mustOk(await api(`/api/transactions/${txnId}/ship`, { method: 'POST', token: seller.token }), 'ship P1');

    const req = await mustOk(await api('/api/users/me/seller-request', {
      method: 'POST', token: promoted.token, body: { shopName: 'Shop P1', pitch: 'Kiểm thử đổi vai trò khi còn đơn dở dang.' },
    }), 'gửi yêu cầu bán hàng');
    const requestId = (req.data.sellerRequest || req.data.request).id;
    await mustOk(await api(`/api/admin/seller-requests/${requestId}/approve`, { method: 'POST', token: admin.token, body: {} }), 'duyệt quyền bán');
    const me = await db.prepare('SELECT role FROM users WHERE id = ?').get(promoted.user.id);
    assert(me.role === 'SELLER', `Người mua đã được nâng lên SELLER (role=${me.role})`);

    // Người ngoài, người bán của đơn, quản trị viên: vẫn bị chặn — không nới quyền ngoài phạm vi sở hữu.
    for (const [who, token] of [['Người ngoài (BUYER)', outsider.token], ['Người bán của đơn', seller.token], ['Quản trị viên', admin.token]]) {
      const r = await api(`/api/transactions/${txnId}/wait-confirm`, { method: 'POST', token });
      assert(r.status === 403 && r.data.error === 'FORBIDDEN', `${who} gọi /wait-confirm bị 403 FORBIDDEN (nhận ${r.status} ${r.data.error})`);
    }
    assert((await txnRow(txnId)).status === 'SHIPPING', 'Đơn vẫn SHIPPING sau các lần gọi bị chặn');

    const wc = await api(`/api/transactions/${txnId}/wait-confirm`, { method: 'POST', token: promoted.token });
    assert(wc.status === 200 && wc.data.status === 'WAIT_CONFIRM',
      `Người mua (nay mang role SELLER) xác nhận nhận hàng được (nhận ${wc.status} ${wc.data.error || wc.data.status})`);

    const outsiderRel = await api(`/api/transactions/${txnId}/reauth/options`, { method: 'POST', token: outsider.token, body: {} });
    assert(outsiderRel.status === 403, `Người ngoài không xin được phiếu giải ngân đơn này (nhận ${outsiderRel.status})`);

    const sellerBefore = await available(seller.user.id);
    const { res } = await buyerRelease(promoted, txnId);
    assert(res.status === 200 && res.data.status === 'COMPLETED', `Người mua (role SELLER) giải ngân được đơn cũ (nhận ${res.status} ${res.data.error || ''})`);
    assert((await available(seller.user.id)) - sellerBefore === PRICE, 'Người bán của đơn nhận đúng số tiền');
    assert((await listingRow(listingId)).status === 'SOLD', 'Tin đăng của đơn chuyển SOLD');

    const asBuyer = await api('/api/transactions?as=buyer', { token: promoted.token });
    assert(asBuyer.status === 200 && asBuyer.data.transactions.some((t) => t.id === txnId), 'Đơn cũ vẫn hiện trong góc nhìn người mua của tài khoản đã nâng quyền');
    await assertInvariantsOk('Sau P1');
  }

  const inv = await api('/api/admin/invariants', { token: admin.token });
  assert(inv.status === 200 && inv.data.ok === true, `Cuối bộ: /api/admin/invariants báo ${inv.data.checked} bất biến đều đúng`);

  console.log(failures ? `\n${failures} FAIL` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error('[listing-lifecycle] lỗi:', e); process.exit(1); });
