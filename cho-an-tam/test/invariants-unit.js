/**
 * Kiểm thử bộ kiểm bất biến — chứng minh MỖI phép kiểm bắt được đúng vi phạm của nó.
 *
 * Các bộ e2e chỉ kiểm được chiều "dữ liệu đúng thì checker nói đúng". Một checker luôn trả OK
 * cũng qua được chiều đó. Bộ này kiểm chiều ngược lại: dựng một cơ sở dữ liệu tạm hợp lệ, rồi
 * với từng bất biến, cố tình gây ĐÚNG MỘT vi phạm và xác nhận:
 *   - checker báo sai ở đúng bất biến đó;
 *   - tám bất biến còn lại vẫn báo đúng (vi phạm không "lan" sang phép kiểm khác);
 *   - sau khi hoàn tác, checker trở lại sạch.
 *
 * Nhiều vi phạm bị ràng buộc lược đồ chặn ngay lúc ghi (CHECK, UNIQUE). Để kiểm phép đối chứng
 * độc lập, cơ sở dữ liệu tạm bật PRAGMA ignore_check_constraints và gỡ UNIQUE trên
 * disputes.transaction_id — mô phỏng đúng tình huống lớp ràng buộc đã bị vô hiệu hoá, là lúc
 * duy nhất phép đối chứng có ý nghĩa.
 *
 * Không cần máy chủ. Không đụng tới cơ sở dữ liệu dev/test/thực nghiệm.
 *   node test/invariants-unit.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Database = require('../src/lib/sqlite');
const { checkInvariants, CHECKS } = require('../src/lib/invariants');

let failures = 0;
function assert(cond, label) {
  console.log(`  ${cond ? '✅' : '❌'} ${label}`);
  if (!cond) failures++;
}

const tmp = path.join(os.tmpdir(), `invariants-unit-${process.pid}-${Date.now()}.db`);
const db = new Database(tmp);
db.pragma('foreign_keys = ON');

// Lược đồ thật của dự án, chỉ gỡ UNIQUE ở disputes.transaction_id (xem chú thích đầu tệp).
const schema = fs.readFileSync(path.join(__dirname, '..', 'src', 'schema.sql'), 'utf8');
const relaxed = schema.replace(
  /transaction_id TEXT NOT NULL UNIQUE REFERENCES transactions\(id\) ON DELETE CASCADE,\s*\n\s*created_by/,
  'transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,\n  created_by'
);
if (relaxed === schema) throw new Error('Không gỡ được UNIQUE của disputes.transaction_id — lược đồ đã đổi?');
db.exec(relaxed);

const id = () => crypto.randomUUID();
const now = new Date().toISOString();

// ---------------------------------------------------------------------------------------
// Dữ liệu nền hợp lệ
//   T1: B mua L1 của S, đã khoá 100 vào ký quỹ (SECURED/LOCKED)
//   T2: B mua L2 của S, khoá 50, tranh chấp, quản trị viên hoàn tiền có phiếu phân xử REFUND
// ---------------------------------------------------------------------------------------
const B = id(); const S = id(); const A = id();
for (const [uid, role] of [[B, 'BUYER'], [S, 'SELLER'], [A, 'ADMIN']]) {
  db.prepare(`INSERT INTO users (id, username, display_name, role, password_hash, account_status)
              VALUES (?, ?, ?, ?, 'x', 'ACTIVE')`).run(uid, `u_${uid.slice(0, 8)}`, role, role);
  db.prepare(`INSERT INTO passkey_credentials (id, user_id, credential_id, public_key, counter)
              VALUES (?, ?, ?, ?, 0)`).run(id(), uid, `cred_${uid}`, Buffer.from('pk'));
}
const ESC = id(); const WB = id(); const WS = id();
db.prepare(`INSERT INTO wallets (id, user_id, wallet_type, available_balance, locked_balance) VALUES (?, NULL, 'SYSTEM_ESCROW', 0, 100)`).run(ESC);
db.prepare(`INSERT INTO wallets (id, user_id, wallet_type, available_balance, locked_balance) VALUES (?, ?, 'USER', 900, 0)`).run(WB, B);
db.prepare(`INSERT INTO wallets (id, user_id, wallet_type, available_balance, locked_balance) VALUES (?, ?, 'USER', 0, 0)`).run(WS, S);

const L1 = id(); const L2 = id();
for (const [lid, st] of [[L1, 'LOCKED'], [L2, 'LOCKED']]) {
  db.prepare(`INSERT INTO listings (id, seller_id, title, category, price, status) VALUES (?, ?, 'Sản phẩm', 'DIEN_THOAI', 100, ?)`).run(lid, S, st);
}
const T1 = id(); const T2 = id();
db.prepare(`INSERT INTO transactions (id, buyer_id, seller_id, item_name, amount, status, escrow_status, listing_id)
            VALUES (?, ?, ?, 'Món 1', 100, 'SECURED', 'LOCKED', ?)`).run(T1, B, S, L1);
db.prepare(`INSERT INTO transactions (id, buyer_id, seller_id, item_name, amount, status, escrow_status, listing_id)
            VALUES (?, ?, ?, 'Món 2', 50, 'REFUNDED', 'REFUNDED', ?)`).run(T2, B, S, L2);

function entry(walletId, txnId, requestId, type, avail, locked) {
  db.prepare(`INSERT INTO wallet_entries (id, wallet_id, transaction_id, request_id, entry_type, available_delta, locked_delta,
              available_after, locked_after, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`)
    .run(id(), walletId, txnId, requestId, type, avail, locked, id());
}
entry(WB, T1, 'lock-1', 'ESCROW_LOCK_DEBIT', -100, 0);
entry(ESC, T1, 'lock-1', 'ESCROW_LOCK_CREDIT', 0, 100);
entry(WB, T2, 'lock-2', 'ESCROW_LOCK_DEBIT', -50, 0);
entry(ESC, T2, 'lock-2', 'ESCROW_LOCK_CREDIT', 0, 50);
entry(ESC, T2, 'refund-2', 'ESCROW_REFUND_DEBIT', 0, -50);
entry(WB, T2, 'refund-2', 'ESCROW_REFUND_CREDIT', 50, 0);
// Dòng tiền vào từ bên ngoài: một chân, không được làm hỏng bất biến số 2.
entry(WB, null, 'topup-1', 'TOPUP_CREDIT', 1000, 0);

const D2 = id();
db.prepare(`INSERT INTO disputes (id, transaction_id, created_by, reason, status, admin_id, admin_decision, resolved_at)
            VALUES (?, ?, ?, 'Không nhận được hàng', 'RESOLVED_REFUND', ?, 'REFUND', ?)`).run(D2, T2, B, A, now);
const G2 = id();
db.prepare(`INSERT INTO reauth_grants (id, user_id, transaction_id, dispute_id, action, decision, token_hash, expires_at, used_at)
            VALUES (?, ?, ?, ?, 'ADJUDICATE', 'REFUND', ?, ?, ?)`).run(G2, A, T2, D2, id(), now, now);

// ---------------------------------------------------------------------------------------

const TOTAL = CHECKS.length;

/** Gây vi phạm trong một giao dịch, kiểm, rồi ROLLBACK để trả lại dữ liệu sạch. */
function expectViolation(no, label, mutate) {
  const code = CHECKS.find((c) => c.no === no).code;
  console.log(`\nI${no}: ${CHECKS.find((c) => c.no === no).name} — ${label}`);
  db.exec('BEGIN');
  let result;
  try {
    db.pragma('ignore_check_constraints = ON');
    mutate();
    result = checkInvariants(db);
  } finally {
    db.exec('ROLLBACK');
    db.pragma('ignore_check_constraints = OFF');
  }
  const flagged = result.checks.filter((c) => !c.ok).map((c) => c.code);
  assert(flagged.includes(code), `Bất biến số ${no} (${code}) báo vi phạm`);
  assert(flagged.length === 1, `Chỉ đúng bất biến đó báo sai, ${TOTAL - 1} bất biến còn lại vẫn đúng (báo sai: ${flagged.join(', ') || 'không có'})`);
  assert(checkInvariants(db).ok, 'Hoàn tác xong thì checker trở lại sạch');
}

console.log('\n=== KIỂM THỬ BỘ KIỂM BẤT BIẾN ===');
console.log('\nI0: Dữ liệu nền hợp lệ');
{
  const r = checkInvariants(db);
  assert(r.checked === 9, `Checker chạy đúng 9 phép kiểm (thực tế ${r.checked})`);
  assert(r.checks.map((c) => c.no).join(',') === '1,2,3,4,5,6,7,8,9', 'Đánh số liên tục 1..9');
  assert(r.ok, `Dữ liệu nền không vi phạm bất biến nào${r.ok ? '' : ': ' + JSON.stringify(r.violations)}`);
}

expectViolation(1, 'ví người mua có số dư âm', () => {
  db.prepare('UPDATE wallets SET available_balance = -1 WHERE id = ?').run(WB);
});

expectViolation(2, 'một nghiệp vụ chuyển tiền nội bộ chỉ có một chân', () => {
  entry(WB, T1, 'orphan-leg', 'ESCROW_LOCK_DEBIT', -10, 0);
});

expectViolation(3, 'tiền rời ký quỹ lần thứ hai cho cùng giao dịch', () => {
  entry(ESC, T2, 'refund-2-again', 'ESCROW_REFUND_DEBIT', 0, -50);
  entry(WB, T2, 'refund-2-again', 'ESCROW_REFUND_CREDIT', 50, 0);
});

expectViolation(4, 'phiếu giải ngân mang quyết định (sai phạm vi)', () => {
  db.prepare(`INSERT INTO reauth_grants (id, user_id, transaction_id, action, decision, token_hash, expires_at)
              VALUES (?, ?, ?, 'RELEASE_ESCROW', 'REFUND', ?, ?)`).run(id(), B, T1, id(), now);
});

expectViolation(4, 'một giao dịch tiêu thụ hai phiếu giải ngân', () => {
  for (let i = 0; i < 2; i++) {
    db.prepare(`INSERT INTO reauth_grants (id, user_id, transaction_id, action, token_hash, expires_at, used_at)
                VALUES (?, ?, ?, 'RELEASE_ESCROW', ?, ?, ?)`).run(id(), B, T1, id(), now, now);
  }
});

expectViolation(5, 'phiếu phân xử ký REFUND nhưng hồ sơ được thi hành RELEASE', () => {
  db.prepare(`UPDATE disputes SET status = 'RESOLVED_RELEASE', admin_decision = 'RELEASE' WHERE id = ?`).run(D2);
});

expectViolation(5, 'hồ sơ đã giải quyết nhưng không có phiếu phân xử nào', () => {
  db.prepare('DELETE FROM reauth_grants WHERE id = ?').run(G2);
});

expectViolation(6, 'tin đăng đã có giao dịch khoá tiền nhưng status vẫn AVAILABLE', () => {
  db.prepare(`UPDATE listings SET status = 'AVAILABLE' WHERE id = ?`).run(L1);
});

expectViolation(6, 'hai giao dịch cùng khoá tiền trên một tin đăng', () => {
  db.prepare(`INSERT INTO transactions (id, buyer_id, seller_id, item_name, amount, status, escrow_status, listing_id)
              VALUES (?, ?, ?, 'Món 1 lần hai', 100, 'COMPLETED', 'RELEASED', ?)`).run(id(), B, S, L1);
});

expectViolation(7, 'ví ký quỹ khoá lệch với tổng nghĩa vụ đang giữ', () => {
  db.prepare('UPDATE wallets SET locked_balance = 999 WHERE id = ?').run(ESC);
});

expectViolation(8, 'tài khoản ACTIVE mất hết Passkey', () => {
  db.prepare('DELETE FROM passkey_credentials WHERE user_id = ?').run(B);
});

expectViolation(9, 'một giao dịch có hai hồ sơ tranh chấp', () => {
  db.prepare(`INSERT INTO disputes (id, transaction_id, created_by, reason, status) VALUES (?, ?, ?, 'Mở lần hai', 'OPEN')`)
    .run(id(), T2, S);
});

db.close();
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(tmp + suffix); } catch (_) {}
}

console.log(failures === 0 ? '\n=== KẾT QUẢ: TẤT CẢ PASS ✅ ===\n' : `\n=== KẾT QUẢ: ${failures} KIỂM THỬ THẤT BẠI ❌ ===\n`);
process.exit(failures === 0 ? 0 : 1);
