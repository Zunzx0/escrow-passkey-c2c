// Chín bất biến của hệ thống, phát biểu lại thành truy vấn chạy được.
//
// Mục đích: thay việc nhìn màn hình rồi kết luận "có vẻ đúng" bằng một phép kiểm trên dữ
// liệu thật. Bộ kiểm thử gọi checkInvariants() sau mỗi testcase, nên nếu một thay đổi mã
// nguồn làm hỏng một bất biến thì hỏng ở đâu cũng lộ ra ngay tại testcase kế tiếp, chứ
// không đợi tới lúc bảo vệ.
//
// Đây là NGUỒN DUY NHẤT của danh sách bất biến: số thứ tự, mã, tên và phát biểu đều nằm ở
// mảng CHECKS bên dưới. Điểm cuối /api/admin/invariants, script check-invariants và màn hình
// quản trị đều đọc lại từ đây — không nơi nào tự chép tay một danh sách riêng.
//
// Nhiều bất biến đã có ràng buộc ở lược đồ (CHECK, UNIQUE) chặn ngay lúc ghi. Phép kiểm ở đây
// là lớp ĐỐI CHỨNG ĐỘC LẬP: nếu nó bắt được gì thì ràng buộc ở lớp lưu trữ đã bị vô hiệu hoá
// bằng cách nào đó. Thực nghiệm không được chỉ "tin ràng buộc".
//
// Mỗi hàm trả về mảng các vi phạm. Mảng rỗng nghĩa là bất biến còn đúng.
const { RESERVING_STATUSES } = require('./catalog');

// Trạng thái ký quỹ mà tiền đang thực sự nằm trong ví ký quỹ.
const HOLDING_ESCROW_STATUSES = ['LOCKED', 'FROZEN'];

// Hai loại bút toán là dòng tiền ĐI VÀO hệ thống từ bên ngoài (seed lúc đăng ký, nạp tiền qua
// provider mô phỏng): chỉ có một chân ghi có, không có chân đối ứng nội bộ. Bất biến số 2 chỉ
// áp cho nghiệp vụ CHUYỂN TIỀN NỘI BỘ giữa các ví, nên loại hai loại này ra — không được hiểu
// thành "mọi wallet_entries cộng lại bằng 0".
const EXTERNAL_INFLOW_ENTRY_TYPES = ['DEMO_TOPUP', 'TOPUP_CREDIT'];

function placeholders(list) {
  return list.map(() => '?').join(',');
}

function violations(code, rows, detail) {
  return rows.map((r) => ({ invariant: code, detail: detail(r) }));
}

// --- 1. Số dư không âm ------------------------------------------------------------------
function nonNegativeBalances(db) {
  return violations(
    'NON_NEGATIVE_BALANCE',
    db.prepare(
      `SELECT id, wallet_type, available_balance, locked_balance
       FROM wallets WHERE available_balance < 0 OR locked_balance < 0`
    ).all(),
    (w) => `Ví ${w.id} (${w.wallet_type}) có số dư âm: available=${w.available_balance}, locked=${w.locked_balance}`
  );
}

// --- 2. Tổng biến động của một nghiệp vụ chuyển tiền nội bộ bằng 0 -----------------------
// Mỗi nghiệp vụ tài chính được nhận diện bằng request_id: tiền chỉ đổi chỗ giữa các ví.
function zeroSumPerTransfer(db) {
  return violations(
    'ZERO_SUM',
    db.prepare(
      `SELECT request_id, SUM(available_delta + locked_delta) AS net, COUNT(*) AS legs
       FROM wallet_entries
       WHERE entry_type NOT IN (${placeholders(EXTERNAL_INFLOW_ENTRY_TYPES)})
       GROUP BY request_id
       HAVING net <> 0`
    ).all(...EXTERNAL_INFLOW_ENTRY_TYPES),
    (r) => `Nghiệp vụ request_id=${r.request_id} có tổng biến động ${r.net} trên ${r.legs} bút toán, đáng lẽ phải bằng 0`
  );
}

// --- 3. Giao dịch chỉ tất toán một lần --------------------------------------------------
// Đếm các bút toán GHI NỢ ví ký quỹ, tức là các lần tiền thực sự rời khỏi ký quỹ.
function settleAtMostOnce(db) {
  return violations(
    'SETTLE_ONCE',
    db.prepare(
      `SELECT transaction_id, COUNT(*) AS n
       FROM wallet_entries
       WHERE entry_type IN ('ESCROW_RELEASE_DEBIT','ESCROW_REFUND_DEBIT') AND transaction_id IS NOT NULL
       GROUP BY transaction_id
       HAVING n > 1`
    ).all(),
    (r) => `Giao dịch ${r.transaction_id} có ${r.n} lần tiền rời ký quỹ, đáng lẽ nhiều nhất 1`
  );
}

// --- 4. Phiếu uỷ quyền dùng một lần và đúng phạm vi --------------------------------------
// (a) phiếu giải ngân gắn đúng một giao dịch, không mang quyết định; phiếu quản lý credential/
//     đổi mật khẩu không gắn đối tượng nào;
// (b) không giao dịch nào tiêu thụ nhiều hơn một phiếu cho cùng một hành động.
// Phạm vi của phiếu PHÂN XỬ tách riêng thành bất biến số 5.
function grantUsedOnceInScope(db) {
  const badScope = violations(
    'GRANT_SCOPE',
    db.prepare(
      `SELECT id, action, transaction_id, dispute_id, decision FROM reauth_grants
       WHERE (action = 'RELEASE_ESCROW' AND (transaction_id IS NULL OR decision IS NOT NULL OR dispute_id IS NOT NULL))
          OR (action IN ('MANAGE_CREDENTIAL','CHANGE_PASSWORD')
              AND (transaction_id IS NOT NULL OR dispute_id IS NOT NULL OR decision IS NOT NULL))`
    ).all(),
    (g) => `Phiếu ${g.id} hành động ${g.action} có phạm vi sai (txn=${g.transaction_id}, dispute=${g.dispute_id}, decision=${g.decision})`
  );
  const doubleUse = violations(
    'GRANT_SCOPE',
    db.prepare(
      `SELECT transaction_id, action, COUNT(*) AS n FROM reauth_grants
       WHERE used_at IS NOT NULL AND transaction_id IS NOT NULL
       GROUP BY transaction_id, action
       HAVING n > 1`
    ).all(),
    (g) => `Giao dịch ${g.transaction_id} đã tiêu thụ ${g.n} phiếu cho hành động ${g.action}, đáng lẽ nhiều nhất 1`
  );
  return badScope.concat(doubleUse);
}

// --- 5. Phiếu phân xử khớp đúng hồ sơ tranh chấp và đúng quyết định -----------------------
// (a) phiếu phân xử phải mang đủ giao dịch, hồ sơ tranh chấp và quyết định;
// (b) hồ sơ tranh chấp của phiếu phải thuộc đúng giao dịch của phiếu;
// (c) phiếu đã tiêu thụ thì hồ sơ phải đã được giải quyết theo ĐÚNG quyết định trên phiếu;
// (d) hồ sơ đã giải quyết thì phải có một phiếu phân xử đã tiêu thụ mang đúng quyết định đó.
// (c) và (d) là hai chiều của cùng một ràng buộc: không quyết định nào được thi hành nếu quản
// trị viên chưa ký cho chính quyết định đó.
function adjudicationGrantMatchesDecision(db) {
  const missing = violations(
    'ADJUDICATION_GRANT',
    db.prepare(
      `SELECT id FROM reauth_grants
       WHERE action = 'ADJUDICATE' AND (transaction_id IS NULL OR dispute_id IS NULL OR decision IS NULL)`
    ).all(),
    (g) => `Phiếu phân xử ${g.id} thiếu giao dịch, hồ sơ tranh chấp hoặc quyết định`
  );
  const wrongDispute = violations(
    'ADJUDICATION_GRANT',
    db.prepare(
      `SELECT g.id, g.transaction_id, d.transaction_id AS dispute_txn
       FROM reauth_grants g JOIN disputes d ON d.id = g.dispute_id
       WHERE g.action = 'ADJUDICATE' AND d.transaction_id <> g.transaction_id`
    ).all(),
    (g) => `Phiếu phân xử ${g.id} gắn giao dịch ${g.transaction_id} nhưng hồ sơ tranh chấp thuộc giao dịch ${g.dispute_txn}`
  );
  const usedButNotExecuted = violations(
    'ADJUDICATION_GRANT',
    db.prepare(
      `SELECT g.id, g.decision, d.id AS dispute_id, d.status
       FROM reauth_grants g JOIN disputes d ON d.id = g.dispute_id
       WHERE g.action = 'ADJUDICATE' AND g.used_at IS NOT NULL
         AND NOT ((g.decision = 'REFUND' AND d.status = 'RESOLVED_REFUND')
               OR (g.decision = 'RELEASE' AND d.status = 'RESOLVED_RELEASE'))`
    ).all(),
    (g) => `Phiếu phân xử ${g.id} (quyết định ${g.decision}) đã tiêu thụ nhưng hồ sơ ${g.dispute_id} đang ở ${g.status}`
  );
  const executedWithoutGrant = violations(
    'ADJUDICATION_GRANT',
    db.prepare(
      `SELECT d.id, d.status FROM disputes d
       WHERE d.status IN ('RESOLVED_REFUND','RESOLVED_RELEASE')
         AND NOT EXISTS (
           SELECT 1 FROM reauth_grants g
           WHERE g.dispute_id = d.id AND g.action = 'ADJUDICATE' AND g.used_at IS NOT NULL
             AND g.decision = CASE d.status WHEN 'RESOLVED_REFUND' THEN 'REFUND' ELSE 'RELEASE' END
         )`
    ).all(),
    (d) => `Hồ sơ ${d.id} đã giải quyết (${d.status}) nhưng không có phiếu phân xử đã tiêu thụ mang đúng quyết định`
  );
  return missing.concat(wrongDispute, usedButNotExecuted, executedWithoutGrant);
}

// --- 6. Tin đăng đơn chiếc chỉ có một giao dịch khoá tiền thành công ----------------------
// (a) không tin đăng nào có hơn một giao dịch đang giữ chỗ/đã bán;
// (b) tin đăng còn AVAILABLE thì không được có giao dịch nào đã khoá tiền trên nó — nếu có,
//     hàng rào listings.status + version đã bị vượt qua.
function singleLockPerListing(db) {
  const multiple = violations(
    'ONE_LOCK_PER_LISTING',
    db.prepare(
      `SELECT listing_id, COUNT(*) AS n FROM transactions
       WHERE listing_id IS NOT NULL AND status IN (${placeholders(RESERVING_STATUSES)})
       GROUP BY listing_id
       HAVING n > 1`
    ).all(...RESERVING_STATUSES),
    (r) => `Tin đăng ${r.listing_id} có ${r.n} giao dịch đã khoá tiền, đáng lẽ nhiều nhất 1`
  );
  const availableButLocked = violations(
    'ONE_LOCK_PER_LISTING',
    db.prepare(
      `SELECT l.id FROM listings l
       WHERE l.status = 'AVAILABLE'
         AND EXISTS (SELECT 1 FROM transactions t
                     WHERE t.listing_id = l.id AND t.status IN (${placeholders(RESERVING_STATUSES)}))`
    ).all(...RESERVING_STATUSES),
    (r) => `Tin đăng ${r.id} còn AVAILABLE nhưng đã có giao dịch khoá tiền trên nó`
  );
  return multiple.concat(availableButLocked);
}

// --- 7. Cân đối số tiền đang giữ trong ký quỹ ---------------------------------------------
function escrowBalanceMatchesObligations(db) {
  const wallet = db.prepare("SELECT id, locked_balance FROM wallets WHERE wallet_type = 'SYSTEM_ESCROW'").get();
  if (!wallet) return [{ invariant: 'ESCROW_BALANCE', detail: 'Không tìm thấy ví ký quỹ hệ thống' }];
  const obligation = db
    .prepare(`SELECT COALESCE(SUM(amount), 0) AS total FROM transactions WHERE escrow_status IN (${placeholders(HOLDING_ESCROW_STATUSES)})`)
    .get(...HOLDING_ESCROW_STATUSES).total || 0;
  if (wallet.locked_balance === obligation) return [];
  return [{
    invariant: 'ESCROW_BALANCE',
    detail: `Ví ký quỹ đang khoá ${wallet.locked_balance} nhưng tổng nghĩa vụ đang giữ là ${obligation}`,
  }];
}

// --- 8. Tài khoản ACTIVE luôn có ít nhất một Passkey ---------------------------------------
// Được giữ bằng hai quy tắc nghiệp vụ: chỉ kích hoạt tài khoản trong cùng giao dịch cơ sở dữ
// liệu ghi credential đầu tiên, và không cho xoá credential cuối cùng.
function activeAccountHasPasskey(db) {
  return violations(
    'ACTIVE_ACCOUNT_HAS_PASSKEY',
    db.prepare(
      `SELECT u.id, u.username FROM users u
       WHERE u.account_status = 'ACTIVE'
         AND NOT EXISTS (SELECT 1 FROM passkey_credentials c WHERE c.user_id = u.id)`
    ).all(),
    (u) => `Tài khoản ${u.username} (${u.id}) đang ACTIVE nhưng không còn credential nào`
  );
}

// --- 9. Một giao dịch có tối đa một hồ sơ tranh chấp --------------------------------------
// Lược đồ đã có UNIQUE(disputes.transaction_id); đây là phép đối chứng độc lập với ràng buộc đó.
function atMostOneDisputePerTransaction(db) {
  return violations(
    'ONE_DISPUTE_PER_TRANSACTION',
    db.prepare(
      `SELECT transaction_id, COUNT(*) AS n FROM disputes GROUP BY transaction_id HAVING n > 1`
    ).all(),
    (r) => `Giao dịch ${r.transaction_id} có ${r.n} hồ sơ tranh chấp, đáng lẽ nhiều nhất 1`
  );
}

const CHECKS = [
  { no: 1, code: 'NON_NEGATIVE_BALANCE', name: 'Số dư không âm',
    statement: 'Mọi ví luôn có available_balance >= 0 và locked_balance >= 0.', fn: nonNegativeBalances },
  { no: 2, code: 'ZERO_SUM', name: 'Tổng biến động của nghiệp vụ chuyển tiền bằng 0',
    statement: 'Trong một nghiệp vụ chuyển tiền nội bộ giữa các ví, tổng thay đổi số dư bằng 0. Dòng tiền đi vào từ bên ngoài (seed, nạp tiền) chỉ có một chân nên không thuộc phạm vi bất biến này.',
    fn: zeroSumPerTransfer },
  { no: 3, code: 'SETTLE_ONCE', name: 'Giao dịch chỉ tất toán một lần',
    statement: 'Mỗi giao dịch có nhiều nhất một lần tiền rời khỏi ký quỹ (giải ngân hoặc hoàn tiền).', fn: settleAtMostOnce },
  { no: 4, code: 'GRANT_SCOPE', name: 'Phiếu uỷ quyền dùng một lần và đúng phạm vi',
    statement: 'Phiếu chỉ dùng một lần và chỉ mang đúng đối tượng mà hành động của nó cho phép.', fn: grantUsedOnceInScope },
  { no: 5, code: 'ADJUDICATION_GRANT', name: 'Phiếu phân xử đúng hồ sơ tranh chấp và đúng quyết định',
    statement: 'Mỗi quyết định phân xử đã thi hành có đúng một phiếu phân xử đã tiêu thụ, gắn đúng hồ sơ và đúng quyết định đó.',
    fn: adjudicationGrantMatchesDecision },
  { no: 6, code: 'ONE_LOCK_PER_LISTING', name: 'Tin đăng đơn chiếc chỉ một lần khoá tiền thành công',
    statement: 'Một tin đăng có nhiều nhất một giao dịch đã khoá tiền, và tin đăng còn AVAILABLE thì chưa có giao dịch nào khoá tiền trên nó.',
    fn: singleLockPerListing },
  { no: 7, code: 'ESCROW_BALANCE', name: 'Cân đối số tiền đang giữ',
    statement: 'locked_balance của ví ký quỹ bằng tổng amount của các giao dịch có escrow_status LOCKED hoặc FROZEN.',
    fn: escrowBalanceMatchesObligations },
  { no: 8, code: 'ACTIVE_ACCOUNT_HAS_PASSKEY', name: 'Tài khoản ACTIVE luôn có Passkey',
    statement: 'Mọi tài khoản ở trạng thái ACTIVE có ít nhất một Passkey đã đăng ký.', fn: activeAccountHasPasskey },
  { no: 9, code: 'ONE_DISPUTE_PER_TRANSACTION', name: 'Một giao dịch tối đa một hồ sơ tranh chấp',
    statement: 'Mỗi giao dịch có nhiều nhất một hồ sơ tranh chấp.', fn: atMostOneDisputePerTransaction },
];

/**
 * Chạy cả chín phép kiểm.
 * @returns {{ ok: boolean, checked: number, violations: Array<{invariant, detail}>,
 *             checks: Array<{no, code, name, statement, ok, violations: number}> }}
 */
function checkInvariants(dbInstance) {
  const database = dbInstance || require('../db').db;
  const allViolations = [];
  const checks = CHECKS.map(({ no, code, name, statement, fn }) => {
    const found = fn(database);
    allViolations.push(...found);
    return { no, code, name, statement, ok: found.length === 0, violations: found.length };
  });
  return { ok: allViolations.length === 0, checked: CHECKS.length, violations: allViolations, checks };
}

/** Dùng trong bộ kiểm thử: ném lỗi kèm mô tả đầy đủ nếu có bất biến bị vi phạm. */
function assertInvariants(label, dbInstance) {
  const result = checkInvariants(dbInstance);
  if (!result.ok) {
    const lines = result.violations.map((v) => `  - [${v.invariant}] ${v.detail}`).join('\n');
    throw new Error(`Vi phạm bất biến sau "${label}":\n${lines}`);
  }
  return result;
}

module.exports = { checkInvariants, assertInvariants, CHECKS, EXTERNAL_INFLOW_ENTRY_TYPES };
