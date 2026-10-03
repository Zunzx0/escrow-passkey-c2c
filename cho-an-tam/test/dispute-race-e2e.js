/**
 * Kịch bản hồi quy cho race condition khi hai yêu cầu phân xử tranh chấp chạy đồng thời
 * (nhánh claude/fix-dispute-race).
 *
 * Trước khi sửa, dựng lại được bằng cách chạy server với DEBUG_RACE_DELAY_MS=300 (nới cửa sổ
 * đua giữa bước kiểm `dispute.status !== 'OPEN'` ngoài giao dịch và lúc giao dịch thật chạy):
 * bên thua nhận lỗi mơ hồ CONSTRAINT_VIOLATION (CHECK constraint của ví tình cờ chặn được) thay
 * vì một lý do rõ ràng. Sau khi sửa (`UPDATE disputes ... WHERE status='OPEN'` nguyên tử là câu
 * lệnh đầu tiên của giao dịch /refund và /release), kết quả giống nhau dù có độ trễ hay không:
 * đúng một quyết định thắng, bên thua nhận 409 DISPUTE_NOT_OPEN (hoặc 401 nếu phiếu đã bị tiêu
 * thụ trước), không có tiền sinh ra/mất đi, 9 bất biến luôn đúng.
 *
 * Yêu cầu server test đang chạy (`npm run start:test`).
 *
 * Hai kịch bản:
 *   R1: cùng một hồ sơ tranh chấp nhận được HAI phiếu uỷ quyền phân xử — một REFUND, một
 *       RELEASE — rồi gửi /refund và /release ĐỒNG THỜI (Promise.all). Kỳ vọng: chỉ một quyết
 *       định có hiệu lực, không có tiền sinh ra/mất đi, 9 bất biến vẫn đúng.
 *   R2: cùng một quyết định (REFUND), hai request với HAI requestId khác nhau (double-click),
 *       gửi ĐỒNG THỜI bằng CÙNG một phiếu uỷ quyền. Kỳ vọng: đúng một request thành công,
 *       request còn lại nhận lỗi rõ ràng (không phải tiền bị cộng/trừ hai lần).
 *
 * Sau mỗi kịch bản: đọc lại ví ký quỹ + ví hai bên, chạy /api/admin/invariants.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const crypto = require('crypto');
const { createAuthenticator } = require('./softwareAuthenticator');
const { flows, createAdmin, createSeller } = require('./helpers/accounts');

const BASE = process.env.BASE_URL || 'http://localhost:3100';
const RP_ID = process.env.WEBAUTHN_RP_ID || 'localhost';
const ORIGIN = process.env.WEBAUTHN_ORIGIN || BASE;

let failures = 0;
function assert(cond, label) {
  console.log(`  ${cond ? '✅' : '❌'} ${label}`);
  if (!cond) failures++;
}
function section(title) { console.log(`\n${title}`); }

async function api(path, opts = {}, retried = false) {
  const { method = 'GET', body, token } = opts;
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let data = {};
  try { data = await res.json(); } catch (_) {}
  if (res.status === 429 && !retried) {
    console.log('  ⏳ Chạm rate limit — chờ 60 giây rồi thử lại…');
    await new Promise((r) => setTimeout(r, 61000));
    return api(path, opts, true);
  }
  return { status: res.status, data };
}

async function wallet(token) {
  return (await api('/api/wallets/me', { token })).data;
}

async function getInvariants(adminToken) {
  return api('/api/admin/invariants', { token: adminToken });
}

/**
 * Kiểm chặt phản hồi của BÊN THUA trong cuộc đua phân xử.
 *
 * `allowed` là tập {mã lỗi -> status HTTP đúng của nó} — hai bên gọi dưới đây truyền tập khác
 * nhau vì R1 có đúng MỘT kết quả hợp lệ (xem lý do ở lời gọi), còn R2 có hai kết quả hợp lệ do
 * phụ thuộc thời điểm. Dù tập nào, CONSTRAINT_VIOLATION (lỗi chung, không nói rõ lý do nghiệp
 * vụ) không bao giờ được coi là hợp lệ — kiểm riêng để lần sau có ai nới `allowed` ra cũng
 * không vô tình nhét lỗi mơ hồ vào.
 */
function assertLoserOutcome(res, allowed, label) {
  const code = res.data && res.data.error;
  assert(code !== 'CONSTRAINT_VIOLATION', `${label}: không rơi vào lỗi mơ hồ CONSTRAINT_VIOLATION (nhận ${res.status} ${code})`);
  const expectedStatus = allowed[code];
  assert(
    expectedStatus !== undefined,
    `${label}: mã lỗi nằm trong tập đã định nghĩa {${Object.keys(allowed).join(', ')}} (thực tế: ${res.status} ${code})`
  );
  if (expectedStatus !== undefined) {
    assert(res.status === expectedStatus, `${label}: status HTTP khớp đúng mã lỗi ${code} (kỳ vọng ${expectedStatus}, nhận ${res.status})`);
  }
}

/** Mở một đơn mới ở đúng trạng thái WAIT_CONFIRM + LOCKED, sẵn sàng để mở tranh chấp. */
async function setupDisputableOrder(buyer, seller, label) {
  const listing = await api('/api/listings', {
    method: 'POST', token: seller.token,
    body: { title: `${label} ${crypto.randomUUID().slice(0, 8)}`, category: 'MAY_TINH', price: 300000, location: 'Hà Nội' },
  });
  const order = await api('/api/transactions/orders', { method: 'POST', token: buyer.token, body: { listingId: listing.data.id } });
  const txnId = order.data.id;
  const secured = await api(`/api/transactions/${txnId}/secure`, { method: 'POST', token: buyer.token, body: { requestId: crypto.randomUUID() } });
  if (secured.status !== 200) throw new Error(`secure thất bại: ${JSON.stringify(secured.data)}`);
  await api(`/api/transactions/${txnId}/ship`, { method: 'POST', token: seller.token });
  await api(`/api/transactions/${txnId}/wait-confirm`, { method: 'POST', token: buyer.token });
  return txnId;
}

async function openDispute(txnId, byToken, reason) {
  const r = await api(`/api/transactions/${txnId}/dispute`, { method: 'POST', token: byToken, body: { reason } });
  if (r.status !== 201) throw new Error(`mở tranh chấp thất bại: ${JSON.stringify(r.data)}`);
  return r.data.dispute.id;
}

async function main() {
  section('Chuẩn bị: quản trị viên, người bán, hai người mua');
  const admin = await createAdmin(null, { username: `admin-race-${Date.now()}` });
  const buyer = await flows.registerUser({ username: `buyer-race-${Date.now()}`, displayName: 'Người mua' });
  const seller = await createSeller(null, null, admin, { username: `seller-race-${Date.now()}`, displayName: 'Người bán' });
  assert(!!buyer.token && !!seller.token && !!admin.token, 'Ba tài khoản sẵn sàng');

  // =======================================================================================
  section('R1: Một hồ sơ tranh chấp nhận HAI phiếu phân xử (REFUND và RELEASE), gửi đồng thời');
  // =======================================================================================
  const txn1 = await setupDisputableOrder(buyer, seller, 'R1');
  const disputeId1 = await openDispute(txn1, seller.token, 'R1: kiểm tra race hai quyết định');

  const grantRefund = await flows.adjudicationGrant(admin.token, admin.auth, disputeId1, 'REFUND');
  const grantRelease = await flows.adjudicationGrant(admin.token, admin.auth, disputeId1, 'RELEASE');
  assert(grantRefund.status === 200 && grantRelease.status === 200, 'Cấp được cả hai phiếu (REFUND + RELEASE) cho cùng một hồ sơ');

  const [escrowBefore1, buyerBefore1, sellerBefore1] = await Promise.all([
    wallet(admin.token).catch(() => null), wallet(buyer.token), wallet(seller.token),
  ]);

  const [refundRes, releaseRes] = await Promise.all([
    api(`/api/admin/disputes/${disputeId1}/refund`, {
      method: 'POST', token: admin.token,
      body: { requestId: crypto.randomUUID(), reauthGrant: grantRefund.data.reauthGrant },
    }),
    api(`/api/admin/disputes/${disputeId1}/release`, {
      method: 'POST', token: admin.token,
      body: { requestId: crypto.randomUUID(), reauthGrant: grantRelease.data.reauthGrant },
    }),
  ]);
  console.log(`  [R1] refund -> ${refundRes.status} ${refundRes.data.error || refundRes.data.transaction?.status}`);
  console.log(`  [R1] release -> ${releaseRes.status} ${releaseRes.data.error || releaseRes.data.transaction?.status}`);

  const succeeded1 = [refundRes, releaseRes].filter((r) => r.status === 200);
  assert(succeeded1.length === 1, `Đúng một trong hai quyết định thành công (thực tế: ${succeeded1.length})`);
  const loser1 = refundRes.status === 200 ? releaseRes : refundRes;
  // R1: hai quyết định dùng HAI phiếu khác nhau — phiếu của bên thua không hề bị bên thắng tiêu
  // thụ, nên bên thua LUÔN thất bại ở đúng một chỗ: bước tiêu thụ hồ sơ tranh chấp nguyên tử
  // (UPDATE disputes ... WHERE status='OPEN'), không phụ thuộc thời điểm. Đúng MỘT mã lỗi hợp
  // lệ, không phải một tập.
  assertLoserOutcome(loser1, { DISPUTE_NOT_OPEN: 409 }, 'R1 bên thua');

  const buyerAfter1 = await wallet(buyer.token);
  const sellerAfter1 = await wallet(seller.token);
  const buyerDelta1 = buyerAfter1.availableBalance - buyerBefore1.availableBalance;
  const sellerDelta1 = sellerAfter1.availableBalance - sellerBefore1.availableBalance;
  console.log(`  [R1] Δbuyer=${buyerDelta1}  Δseller=${sellerDelta1}  (giá đơn = 300000)`);
  assert(
    (buyerDelta1 === 300000 && sellerDelta1 === 0) || (buyerDelta1 === 0 && sellerDelta1 === 300000),
    'Tổng tiền di chuyển đúng MỘT LẦN 300.000đ, cho đúng MỘT bên (không mất, không sinh ra, không nhân đôi)'
  );

  const txnDetail1 = await api(`/api/transactions/${txn1}/logs`, { token: seller.token });
  assert(txnDetail1.status === 200, 'Vẫn đọc được chuỗi nhật ký sau race (dữ liệu không hỏng)');

  const inv1 = await getInvariants(admin.token);
  assert(inv1.status === 200 && inv1.data.ok === true, `9 bất biến còn đúng sau R1 (violations=${JSON.stringify(inv1.data.violations || [])})`);

  // =======================================================================================
  section('R2: Cùng một quyết định (REFUND), hai requestId khác nhau, cùng một phiếu, gửi đồng thời');
  // =======================================================================================
  const txn2 = await setupDisputableOrder(buyer, seller, 'R2');
  const disputeId2 = await openDispute(txn2, buyer.token, 'R2: kiểm tra race double-click');
  const grant2 = await flows.adjudicationGrant(admin.token, admin.auth, disputeId2, 'REFUND');
  assert(grant2.status === 200, 'Cấp được phiếu REFUND');

  const buyerBefore2 = await wallet(buyer.token);

  const [resA, resB] = await Promise.all([
    api(`/api/admin/disputes/${disputeId2}/refund`, {
      method: 'POST', token: admin.token,
      body: { requestId: crypto.randomUUID(), reauthGrant: grant2.data.reauthGrant },
    }),
    api(`/api/admin/disputes/${disputeId2}/refund`, {
      method: 'POST', token: admin.token,
      body: { requestId: crypto.randomUUID(), reauthGrant: grant2.data.reauthGrant },
    }),
  ]);
  console.log(`  [R2] request A -> ${resA.status} ${JSON.stringify(resA.data).slice(0, 160)}`);
  console.log(`  [R2] request B -> ${resB.status} ${JSON.stringify(resB.data).slice(0, 160)}`);

  const succeeded2 = [resA, resB].filter((r) => r.status === 200);
  assert(succeeded2.length === 1, `Đúng một trong hai request thành công (thực tế: ${succeeded2.length})`);
  const loser2 = resA.status === 200 ? resB : resA;
  // R2: cả hai request dùng CÙNG một phiếu cho CÙNG một quyết định — bên thua có thể bị chặn ở
  // một trong hai chỗ tuỳ thời điểm: (a) bước tiêu thụ hồ sơ tranh chấp nguyên tử, nếu bên thắng
  // đã commit xong trước khi bên thua đọc được trạng thái hồ sơ; (b) bước tra phiếu uỷ quyền,
  // nếu bên thắng đã tiêu thụ phiếu trước khi bên thua tra tới. CẢ HAI là hành vi đúng theo
  // thiết kế — nhưng không được là bất kỳ mã lỗi nào khác, đặc biệt không phải lỗi chung
  // CONSTRAINT_VIOLATION (đây chính là lỗi đã quan sát được TRƯỚC KHI sửa, dựng lại bằng
  // DEBUG_RACE_DELAY_MS — xem chú thích đầu tệp).
  assertLoserOutcome(loser2, { DISPUTE_NOT_OPEN: 409, REAUTH_REQUIRED: 401 }, 'R2 bên thua');

  const buyerAfter2 = await wallet(buyer.token);
  const buyerDelta2 = buyerAfter2.availableBalance - buyerBefore2.availableBalance;
  console.log(`  [R2] Δbuyer=${buyerDelta2} (giá đơn = 300000)`);
  assert(buyerDelta2 === 300000, 'Người mua chỉ được hoàn tiền ĐÚNG MỘT LẦN, không nhân đôi');

  const inv2 = await getInvariants(admin.token);
  assert(inv2.status === 200 && inv2.data.ok === true, `9 bất biến còn đúng sau R2 (violations=${JSON.stringify(inv2.data.violations || [])})`);

  console.log(failures ? `\n${failures} FAIL` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error('[dispute-race] lỗi:', e); process.exit(1); });
