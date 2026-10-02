const crypto = require('crypto');

const GENESIS_HASH = '0'.repeat(64);

// Canonical JSON: sắp xếp key theo thứ tự bảng chữ cái, đệ quy cho object lồng nhau.
// Bảo đảm cùng một dữ liệu luôn cho ra cùng một chuỗi JSON, không phụ thuộc thứ tự insert.
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
}

function sha256Hex(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

/**
 * Ghi một log vào chuỗi Hash Chain RIÊNG của transactionId (đúng 4_system_design.md mục 9).
 * PHẢI được gọi bên trong db.transaction() để đảm bảo nguyên tử cùng với thay đổi nghiệp
 * vụ (ví dụ cùng lock/release).
 *
 * Ghi chú quan trọng về concurrency: đọc bản ghi cuối rồi mới ghi bản ghi kế tiếp là một cặp
 * đọc-rồi-ghi. Tính chất "không phân nhánh chuỗi hash" (tương đương TC26) dựa vào việc mọi
 * db.transaction() được tuần tự hoá — pg_advisory_xact_lock trên PostgreSQL, mutex trong process
 * trên SQLite (xem lib/asyncDb.js). UNIQUE(transaction_id, sequence_no) là lưới an toàn thứ hai:
 * hai bản ghi cùng số thứ tự không thể cùng tồn tại dù cơ chế tuần tự hoá có lỗi.
 */
const OP_BY_AUDIT_ACTION = {
  ESCROW_LOCKED: 'lock',
  ESCROW_RELEASED: 'release',
  ADMIN_RELEASE: 'admin-release',
  ADMIN_REFUND: 'admin-refund',
};

async function appendAuditLog(db, { transactionId, actorId, action, oldStatus, newStatus, eventData }) {
  require('./faultInjection').maybeFail('before-audit-log', OP_BY_AUDIT_ACTION[action] || 'any');
  const last = await db
    .prepare(
      'SELECT sequence_no, current_hash FROM audit_logs WHERE transaction_id = ? ORDER BY sequence_no DESC LIMIT 1'
    )
    .get(transactionId);
  const previousHash = last ? last.current_hash : GENESIS_HASH;
  const sequenceNo = last ? last.sequence_no + 1 : 1;

  // sequenceNo và previousHash đều nằm BÊN TRONG payload được băm. Nhờ vậy việc sửa số
  // thứ tự hay sửa liên kết móc xích cũng làm sai giá trị băm của chính bản ghi, chứ
  // không chỉ làm lệch bản ghi kế tiếp.
  const payload = {
    transactionId,
    sequenceNo,
    actorId: actorId || null,
    action,
    oldStatus: oldStatus || null,
    newStatus: newStatus || null,
    eventData: eventData || {},
    createdAt: new Date().toISOString(),
    previousHash,
  };

  const currentHash = sha256Hex(canonicalJson(payload));

  await db.prepare(
    `INSERT INTO audit_logs
      (transaction_id, sequence_no, actor_id, action, old_status, new_status, event_data,
       previous_hash, current_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    transactionId,
    sequenceNo,
    actorId || null,
    action,
    oldStatus || null,
    newStatus || null,
    JSON.stringify(eventData || {}),
    previousHash,
    currentHash,
    payload.createdAt
  );

  return currentHash;
}

/**
 * Verify toàn bộ chuỗi hash của một transaction theo id ASC.
 * Trả về { valid: true } hoặc { valid: false, invalidLogId } — đúng UC11 (13_diagrams.md).
 */
async function verifyChain(db, transactionId) {
  const logs = await db
    .prepare('SELECT * FROM audit_logs WHERE transaction_id = ? ORDER BY sequence_no ASC, id ASC')
    .all(transactionId);

  let expectedPrevious = GENESIS_HASH;
  let expectedSequence = 1;
  for (const log of logs) {
    // Số thứ tự đứt quãng là dấu hiệu có bản ghi bị chèn thêm hoặc bị xoá ở giữa chuỗi,
    // kể cả khi kẻ can thiệp đã tính lại liên kết băm cho phần còn lại.
    if (log.sequence_no !== expectedSequence) {
      return { valid: false, invalidLogId: log.id, reason: 'SEQUENCE_BROKEN' };
    }

    const payload = {
      transactionId: log.transaction_id,
      sequenceNo: log.sequence_no,
      actorId: log.actor_id || null,
      action: log.action,
      oldStatus: log.old_status || null,
      newStatus: log.new_status || null,
      eventData: JSON.parse(log.event_data || '{}'),
      createdAt: log.created_at,
      previousHash: expectedPrevious,
    };
    const recomputed = sha256Hex(canonicalJson(payload));

    if (log.previous_hash !== expectedPrevious || recomputed !== log.current_hash) {
      return { valid: false, invalidLogId: log.id, reason: 'HASH_MISMATCH' };
    }
    expectedPrevious = log.current_hash;
    expectedSequence += 1;
  }
  // headSequence và headHash là hai giá trị cần được lưu tách biệt hoặc công bố ra ngoài
  // nếu muốn phát hiện việc tính lại toàn chuỗi hay xoá các bản ghi ở cuối chuỗi. Trong
  // phạm vi hiện tại chúng chỉ được trả ra để người kiểm tự đối chiếu.
  return {
    valid: true,
    checkedCount: logs.length,
    headSequence: logs.length ? logs[logs.length - 1].sequence_no : 0,
    headHash: logs.length ? logs[logs.length - 1].current_hash : GENESIS_HASH,
  };
}

module.exports = { canonicalJson, sha256Hex, appendAuditLog, verifyChain, GENESIS_HASH };
