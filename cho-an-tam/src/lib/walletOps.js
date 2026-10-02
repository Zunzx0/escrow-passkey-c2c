const crypto = require('crypto');
const { db, nowIso, uuid } = require('../db');
const { ConflictError } = require('./errors');
const { maybeFail } = require('./faultInjection');

// Cập nhật một wallet có điều kiện version (optimistic locking).
// CHECK (available_balance >= 0) và CHECK (locked_balance >= 0) của schema sẽ tự
// chặn số dư âm; lỗi ràng buộc SQLite được bắt ở tầng gọi và dịch thành 400.
function applyWalletDelta(wallet, availableDelta, lockedDelta) {
  const result = db
    .prepare(
      `UPDATE wallets SET available_balance = available_balance + ?, locked_balance = locked_balance + ?,
       version = version + 1, updated_at = ? WHERE id = ? AND version = ?`
    )
    .run(availableDelta, lockedDelta, nowIso(), wallet.id, wallet.version);
  if (result.changes !== 1) throw new ConflictError('WALLET_VERSION_CONFLICT', 'Wallet version cũ (đã có thao tác khác)');
  return db.prepare('SELECT * FROM wallets WHERE id = ?').get(wallet.id);
}

// Cập nhật NHIỀU wallet trong một nghiệp vụ, LUÔN theo thứ tự wallet.id tăng dần
// (đúng quy ước ở 4_system_design.md mục 10) để tránh deadlock khi có giao dịch
// khác chạm cùng cặp wallet theo thứ tự ngược lại.
// updates: [{ wallet, availableDelta, lockedDelta }]
// Trả về Map(walletId -> wallet đã cập nhật)
// `op` đặt tên cho nghiệp vụ đang chạy (lock / release / admin-refund / admin-release), chỉ
// dùng để bài kiểm thử rollback khoanh đúng nghiệp vụ cần làm hỏng. Bốn nghiệp vụ này dùng
// chung một khung xử lý, nên không có tên thì không chèn lỗi riêng cho một cái được.
function applyOrderedWalletUpdates(updates, op = 'any') {
  const sorted = [...updates].sort((a, b) => (a.wallet.id < b.wallet.id ? -1 : a.wallet.id > b.wallet.id ? 1 : 0));
  const result = new Map();
  for (const u of sorted) {
    const updated = applyWalletDelta(u.wallet, u.availableDelta, u.lockedDelta);
    result.set(u.wallet.id, updated);
  }
  // Số dư đã đổi, bút toán chưa ghi — điểm hỏng nguy hiểm nhất nếu không có giao dịch CSDL.
  maybeFail('after-wallet-update', op);
  return result;
}

// Tên nghiệp vụ suy từ trạng thái đích, để FAULT_INJECT="release:before-status-change" chỉ bắn
// ở bước giải ngân chứ không bắn luôn ở bước khoá tiền đi trước nó.
const OP_BY_TARGET_STATUS = { SECURED: 'lock', COMPLETED: 'release', RELEASED: 'admin-release', REFUNDED: 'admin-refund' };

function applyTransactionStatus(txn, { status, escrowStatus }) {
  maybeFail('before-status-change', OP_BY_TARGET_STATUS[status] || 'any');
  const result = db
    .prepare(
      `UPDATE transactions SET status = ?, escrow_status = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND version = ?`
    )
    .run(status, escrowStatus, nowIso(), txn.id, txn.version);
  if (result.changes !== 1) throw new ConflictError('TRANSACTION_VERSION_CONFLICT', 'Transaction version cũ (đã có thao tác khác)');
  return db.prepare('SELECT * FROM transactions WHERE id = ?').get(txn.id);
}

function insertWalletEntry({ walletId, transactionId, requestId, entryType, availableDelta, lockedDelta, walletAfter, idempotencyKey, requestFingerprint, description }) {
  db.prepare(
    `INSERT INTO wallet_entries
      (id, wallet_id, transaction_id, request_id, entry_type, available_delta, locked_delta,
       available_after, locked_after, idempotency_key, request_fingerprint, description, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    uuid(),
    walletId,
    transactionId || null,
    requestId,
    entryType,
    availableDelta,
    lockedDelta,
    walletAfter.available_balance,
    walletAfter.locked_balance,
    idempotencyKey,
    requestFingerprint || null,
    description || null,
    nowIso()
  );
}

/**
 * Băm các tham số QUYẾT ĐỊNH kết quả của một nghiệp vụ tài chính.
 *
 * Chỉ có khoá chống lặp thì không đủ: hai yêu cầu khác hẳn nhau vẫn có thể mang cùng
 * một requestId, do người gọi sinh trùng hoặc do cố ý. Khi đó trả về kết quả của yêu
 * cầu trước là sai — nó khiến người gọi tin rằng yêu cầu thứ hai đã được thực hiện.
 * Dấu vân tay cho phép phân biệt "gửi lại đúng yêu cầu cũ" với "yêu cầu khác trùng khoá".
 */
function fingerprintRequest({ actorId, action, transactionId, amount }) {
  const canonical = JSON.stringify({ actorId, action, transactionId, amount });
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Tra một khoá chống lặp đã ghi.
 *
 * Trả về null nếu chưa từng ghi. Nếu đã ghi và dấu vân tay khớp thì đây là một lần gửi
 * lại hợp lệ, người gọi trả về kết quả cũ. Nếu dấu vân tay lệch thì ném xung đột, vì
 * hai nghiệp vụ khác nhau đang tranh nhau cùng một khoá.
 */
function checkIdempotency(idempotencyKey, fingerprint) {
  const row = db
    .prepare('SELECT id, request_fingerprint FROM wallet_entries WHERE idempotency_key = ?')
    .get(idempotencyKey);
  if (!row) return null;
  if (fingerprint && row.request_fingerprint && row.request_fingerprint !== fingerprint) {
    throw new ConflictError(
      'IDEMPOTENCY_KEY_REUSED',
      'Mã yêu cầu này đã dùng cho một nghiệp vụ khác. Hãy tạo mã yêu cầu mới.'
    );
  }
  return row;
}

function isIdempotentReplay(idempotencyKey) {
  return !!db.prepare('SELECT id FROM wallet_entries WHERE idempotency_key = ?').get(idempotencyKey);
}

function getUserWallet(userId) {
  return db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(userId);
}

function getEscrowWallet() {
  return db.prepare(`SELECT * FROM wallets WHERE wallet_type = 'SYSTEM_ESCROW'`).get();
}

module.exports = {
  applyWalletDelta,
  applyOrderedWalletUpdates,
  applyTransactionStatus,
  insertWalletEntry,
  isIdempotentReplay,
  checkIdempotency,
  fingerprintRequest,
  getUserWallet,
  getEscrowWallet,
};
