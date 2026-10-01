/**
 * Kiểm thử ROLLBACK bằng lỗi chủ động.
 *
 * Nói "toàn bộ nghiệp vụ nằm trong một giao dịch cơ sở dữ liệu" là một lời khẳng định, không
 * phải một bằng chứng. Bài này cố tình làm hỏng lệnh giải ngân ở giữa chừng — sau khi số dư
 * đã đổi nhưng trước khi bút toán được ghi — rồi kiểm rằng SÁU thứ đều quay về trạng thái cũ:
 *
 *   1. số dư ví ký quỹ            5. phiếu uỷ quyền vẫn CHƯA bị tiêu thụ
 *   2. số dư ví người bán         6. chín bất biến vẫn đúng
 *   3. trạng thái giao dịch
 *   4. số bút toán và số bản ghi nhật ký
 *
 * Điểm 5 là điểm đáng giá nhất: nếu việc tiêu thụ phiếu nằm ngoài giao dịch cơ sở dữ liệu
 * thì sau lần hỏng này người dùng sẽ mất phiếu mà tiền vẫn chưa chuyển — mất tiền oan theo
 * đúng nghĩa đen. Phiếu còn dùng lại được chứng minh nó được tiêu thụ trong cùng giao dịch.
 *
 * CÁCH CHẠY — máy chủ phải được khởi động với biến môi trường chèn lỗi:
 *
 *   PowerShell:  $env:FAULT_INJECT="release:after-wallet-update"; npm start
 *   rồi cửa sổ khác:  node test/rollback-e2e.js
 *
 * Phải ghi rõ tên nghiệp vụ `release:` ở đầu. Khoá tiền và giải ngân dùng chung một khung xử
 * lý, nên nếu chèn lỗi cho mọi nghiệp vụ thì giao dịch hỏng ngay từ bước khoá tiền và không
 * bao giờ tới được bước cần kiểm.
 *
 * Nếu máy chủ không bật chèn lỗi, bài này DỪNG và nói rõ lý do thay vì báo pass giả.
 */
const crypto = require('crypto');
const { api, flows } = require('./helpers/accounts');

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const PRICE = 720000;

let pass = 0;
let fail = 0;

function assert(cond, label) {
  if (cond) { pass += 1; console.log(`  ✅ ${label}`); }
  else { fail += 1; console.log(`  ❌ ${label}`); }
}

async function snapshot(adminToken, txnId, buyerToken, sellerToken) {
  const [txn, escrowInv, sellerWallet] = await Promise.all([
    api(`/api/transactions/${txnId}`, { token: buyerToken }),
    api('/api/admin/invariants', { token: adminToken }),
    api('/api/wallets/me', { token: sellerToken }),
  ]);
  const logs = await api(`/api/transactions/${txnId}/logs`, { token: buyerToken });
  return {
    status: txn.data.status,
    escrowStatus: txn.data.escrowStatus,
    version: txn.data.version,
    sellerAvailable: sellerWallet.data.availableBalance,
    logCount: (logs.data.logs || []).length,
    invariantsOk: escrowInv.data.ok,
  };
}

async function main() {
  console.log(`\n=== KIỂM THỬ ROLLBACK BẰNG LỖI CHỦ ĐỘNG: ${BASE} ===\n`);

  const health = await api('/health');
  const point = health.data && health.data.faultInject;
  if (!point) {
    console.log('  Máy chủ đang chạy KHÔNG bật chèn lỗi, nên bài này không kiểm được gì.');
    console.log('  Khởi động lại máy chủ với biến môi trường rồi chạy lại:\n');
    console.log('     $env:FAULT_INJECT="release:after-wallet-update"; npm start\n');
    console.log('  (Nhớ TẮT biến này trước khi thu kết quả chính thức.)\n');
    process.exit(2);
  }
  console.log(`  Máy chủ đang bật chèn lỗi tại điểm: ${point}\n`);

  const rand = crypto.randomBytes(4).toString('hex');
  const admin = await flows.createAdmin({ username: `rbadm_${rand}`, displayName: 'Quan Tri Rollback' });
  const seller = await flows.createSeller(admin, { username: `rbsel_${rand}`, displayName: 'Nguoi Ban' });
  const buyer = await flows.registerUser({ username: `rbbuy_${rand}`, displayName: 'Nguoi Mua' });

  const listing = await api('/api/listings', {
    method: 'POST', token: seller.token,
    body: { title: `Sản phẩm kiểm rollback ${rand}`, category: 'SACH', condition: 'GOOD', price: PRICE, location: 'Hà Nội' },
  });
  const order = await api('/api/transactions/orders', {
    method: 'POST', token: buyer.token, body: { listingId: listing.data.id },
  });
  const txnId = order.data.id;

  // Đưa giao dịch tới đúng trạng thái được phép giải ngân.
  await api(`/api/transactions/${txnId}/secure`, {
    method: 'POST', token: buyer.token, body: { requestId: crypto.randomUUID() },
  });
  await api(`/api/transactions/${txnId}/ship`, { method: 'POST', token: seller.token, body: {} });
  await api(`/api/transactions/${txnId}/wait-confirm`, { method: 'POST', token: buyer.token, body: {} });

  const grantResp = await flows.releaseGrant(buyer.token, buyer.auth, txnId);
  assert(grantResp.status === 200 && grantResp.data.reauthGrant, 'Lấy được phiếu uỷ quyền giải ngân');
  const reauthGrant = grantResp.data.reauthGrant;

  const before = await snapshot(admin.token, txnId, buyer.token, seller.token);
  console.log(`  Trước khi giải ngân: ${before.status}+${before.escrowStatus}, ví người bán ${before.sellerAvailable.toLocaleString('vi-VN')}₫, ${before.logCount} bản ghi nhật ký`);

  // ---- lệnh giải ngân sẽ hỏng giữa chừng ----
  const broken = await api(`/api/transactions/${txnId}/release`, {
    method: 'POST', token: buyer.token,
    body: { requestId: crypto.randomUUID(), reauthGrant },
  });
  assert(broken.status >= 500, `Lệnh giải ngân thất bại như dự kiến (nhận ${broken.status})`);
  assert(broken.data.error === 'INJECTED_FAULT', `Đúng là lỗi được chèn chủ động (${broken.data.error})`);

  const after = await snapshot(admin.token, txnId, buyer.token, seller.token);

  assert(after.status === before.status && after.escrowStatus === before.escrowStatus,
    `Cặp trạng thái giao dịch không đổi (${after.status}+${after.escrowStatus})`);
  assert(after.version === before.version,
    `Số phiên bản của giao dịch không tăng (${after.version})`);
  assert(after.sellerAvailable === before.sellerAvailable,
    `Số dư người bán KHÔNG bị cộng (vẫn ${after.sellerAvailable.toLocaleString('vi-VN')}₫)`);
  assert(after.logCount === before.logCount,
    `Không có bản ghi nhật ký nào bị nối thêm (vẫn ${after.logCount})`);
  assert(after.invariantsOk === true, 'Chín bất biến vẫn đúng sau khi nghiệp vụ hỏng giữa chừng');

  // Phiếu phải CHƯA bị tiêu thụ: nó chỉ được đánh dấu đã dùng trong cùng giao dịch cơ sở
  // dữ liệu với việc chuyển tiền, mà giao dịch đó đã bị huỷ.
  const retry = await api(`/api/transactions/${txnId}/release`, {
    method: 'POST', token: buyer.token,
    body: { requestId: crypto.randomUUID(), reauthGrant },
  });
  assert(retry.data.error === 'INJECTED_FAULT',
    `Phiếu uỷ quyền CHƯA bị tiêu thụ — vẫn qua được vòng kiểm và hỏng lại đúng ở điểm chèn (nhận ${retry.data.error})`);

  const final = await api('/api/admin/invariants', { token: admin.token });
  assert(final.data.ok === true, 'Bất biến vẫn đúng sau lần thử thứ hai');

  console.log(`\n=== KẾT QUẢ: ${fail === 0 ? 'TẤT CẢ PASS ✅' : `${fail} TEST FAIL ❌`} (${pass} pass) ===`);
  console.log('  Nhắc: TẮT FAULT_INJECT trước khi chạy các bộ test khác và trước khi thu kết quả.\n');
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error('LỖI KHÔNG MONG ĐỢI:', e);
  process.exit(1);
});
