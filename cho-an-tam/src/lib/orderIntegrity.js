const crypto = require('crypto');
const { AppError, ConflictError } = require('./errors');

// An incident hold is separate from a business dispute: even the assigned
// administrator cannot settle it. No application route clears these records.
const BLOCKED = 'ORDER_INTEGRITY_BLOCKED';
const FAILURE = 'ORDER_INTEGRITY_FAILURE';
const IMMUTABLE_ORDER_FIELDS = ['id', 'buyerId', 'sellerId', 'listingId', 'itemName', 'amount'];
const ENTRY_FIELDS = ['id', 'wallet_id', 'transaction_id', 'request_id', 'entry_type',
  'available_delta', 'locked_delta', 'available_after', 'locked_after',
  'idempotency_key', 'request_fingerprint', 'description', 'created_at'];

function migrateSqlite(raw) {
  raw.exec(`CREATE TABLE IF NOT EXISTS order_integrity_holds (
    transaction_id TEXT PRIMARY KEY REFERENCES transactions(id),
    detected_at TEXT NOT NULL,
    detected_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    reason_code TEXT NOT NULL,
    invalid_log_id INTEGER,
    details_json TEXT NOT NULL DEFAULT '{}'
  )`);
}

function digest(value) {
  return crypto.createHash('sha256').update(require('./hash').canonicalJson(value), 'utf8').digest('hex');
}

function projectOrder(row) {
  return { id: row.id, buyerId: row.buyer_id, sellerId: row.seller_id,
    listingId: row.listing_id || null, itemName: row.item_name,
    amount: Number(row.amount), status: row.status, escrowStatus: row.escrow_status };
}

function projectEntry(row) {
  return Object.fromEntries(ENTRY_FIELDS.map(key => [key, row[key] === undefined ? null : row[key]]));
}

async function ledgerRows(db, id) {
  return (await db.prepare('SELECT * FROM wallet_entries WHERE transaction_id = ?').all(id))
    .map(projectEntry).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

// Called only while appending a new, legitimate audit event in its business
// transaction. Old audit rows are never backfilled with manufactured evidence.
async function captureAuditSnapshot(db, transactionId) {
  const row = await db.prepare('SELECT * FROM transactions WHERE id = ?').get(transactionId);
  // hash.js is also usable with minimal standalone audit fixtures.
  if (!row || row.amount === undefined || row.buyer_id === undefined) return null;
  const entries = await ledgerRows(db, transactionId);
  return { version: 1, order: projectOrder(row), ledger: {
    count: entries.length, sha256: digest(entries),
    entries: entries.map(entry => ({ id: entry.id, sha256: digest(entry) }))
  } };
}

function publicHold(row) {
  if (!row) return null;
  let details = {};
  try {
    const parsed = JSON.parse(row.details_json || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) details = parsed;
  } catch {}
  const positiveInteger = value => Number.isSafeInteger(value) && value > 0 ? value : null;
  return { active: true, detectedAt: row.detected_at, reason: row.reason_code,
    invalidLogId: row.invalid_log_id ?? null,
    invalidSequenceNo: positiveInteger(details.invalidSequenceNo),
    expectedSequenceNo: positiveInteger(details.expectedSequenceNo),
    referenceLogId: positiveInteger(details.referenceLogId),
    referenceSequenceNo: positiveInteger(details.referenceSequenceNo),
    referenceEscrowStatus: ['NONE','LOCKED','FROZEN','RELEASED','REFUNDED'].includes(details.referenceEscrowStatus)
      ? details.referenceEscrowStatus : null };
}

async function getHold(db, transactionId) {
  return publicHold(await db.prepare('SELECT * FROM order_integrity_holds WHERE transaction_id = ?').get(transactionId));
}

function invalid(reason, detail = {}) { return { valid: false, reason, ...detail }; }

async function checkBusinessData(db, txn, logs, entries) {
  const current = projectOrder(txn);
  const entryHashes = new Map(entries.map(entry => [entry.id, digest(entry)]));
  let latestSnapshot = null, snapshotCount = 0, lastStatus = null, lastStateLog = null;
  for (const log of logs) {
    const event = JSON.parse(log.event_data || '{}'); // verifyChain already validated JSON.
    if (lastStatus && log.old_status && log.old_status !== lastStatus) {
      return invalid('STATE_HISTORY_MISMATCH', { referenceLogId: log.id, referenceSequenceNo: log.sequence_no });
    }
    if (log.new_status) { lastStatus = log.new_status; lastStateLog = log; }
    if (['ORDER_CREATED', 'TRANSACTION_CREATED', 'ESCROW_LOCKED', 'ESCROW_RELEASED',
      'ADMIN_REFUND', 'ADMIN_RELEASE', 'BUYER_CANCELLED', 'SELLER_CANCELLED', 'ORDER_EXPIRED_REFUND'].includes(log.action)
      && event.amount !== undefined && Number(event.amount) !== current.amount) {
      return invalid('ORDER_DATA_MISMATCH', { referenceLogId: log.id, referenceSequenceNo: log.sequence_no, fields: ['amount'] });
    }
    const snapshot = event.integritySnapshot;
    if (!snapshot) continue;
    if (snapshot.version !== 1 || !snapshot.order || !Array.isArray(snapshot.ledger?.entries)) {
      return invalid('INTEGRITY_SNAPSHOT_INVALID', { referenceLogId: log.id, referenceSequenceNo: log.sequence_no });
    }
    snapshotCount++;
    const changed = IMMUTABLE_ORDER_FIELDS.filter(key => snapshot.order[key] !== current[key]);
    if (changed.length) return invalid('ORDER_DATA_MISMATCH', { referenceLogId: log.id, referenceSequenceNo: log.sequence_no, fields: changed });
    // Every earlier commitment remains binding, so a later legitimate event cannot
    // launder a previously edited ledger row by taking a fresh snapshot of it.
    for (const committed of snapshot.ledger.entries) {
      if (entryHashes.get(committed.id) !== committed.sha256) {
        return invalid('LEDGER_DATA_MISMATCH', { referenceLogId: log.id, referenceSequenceNo: log.sequence_no });
      }
    }
    latestSnapshot = { ...snapshot, logId: log.id, sequenceNo: log.sequence_no };
  }
  if (lastStatus && current.status !== lastStatus) return invalid('ORDER_STATE_MISMATCH', {
    referenceLogId: lastStateLog.id, referenceSequenceNo: lastStateLog.sequence_no });
  if (latestSnapshot) {
    if (latestSnapshot.order.status !== current.status || latestSnapshot.order.escrowStatus !== current.escrowStatus) {
      return invalid('ORDER_STATE_MISMATCH', { referenceLogId: latestSnapshot.logId, referenceSequenceNo: latestSnapshot.sequenceNo });
    }
    if (latestSnapshot.ledger.count !== entries.length || latestSnapshot.ledger.sha256 !== digest(entries)) {
      return invalid('LEDGER_DATA_MISMATCH', { referenceLogId: latestSnapshot.logId, referenceSequenceNo: latestSnapshot.sequenceNo });
    }
  }

  // Legacy records without snapshots still get a bounded check of their amount,
  // state and transfer legs. This does not retroactively authenticate every field.
  const wallets = await db.prepare("SELECT id,user_id,wallet_type FROM wallets WHERE user_id IN (?,?) OR wallet_type='SYSTEM_ESCROW'").all(txn.buyer_id, txn.seller_id);
  const buyer = wallets.find(wallet => wallet.user_id === txn.buyer_id);
  const seller = wallets.find(wallet => wallet.user_id === txn.seller_id);
  const escrow = wallets.find(wallet => wallet.wallet_type === 'SYSTEM_ESCROW');
  const rules = {
    ESCROW_LOCK_DEBIT: [buyer?.id, -current.amount, 0],
    ESCROW_LOCK_CREDIT: [escrow?.id, 0, current.amount],
    ESCROW_RELEASE_DEBIT: [escrow?.id, 0, -current.amount],
    ESCROW_RELEASE_CREDIT: [seller?.id, current.amount, 0],
    ESCROW_REFUND_DEBIT: [escrow?.id, 0, -current.amount],
    ESCROW_REFUND_CREDIT: [buyer?.id, current.amount, 0]
  };
  const byType = new Map();
  for (const entry of entries) {
    const rule = rules[entry.entry_type];
    if (!rule || !rule[0] || entry.wallet_id !== rule[0]
      || Number(entry.available_delta) !== rule[1] || Number(entry.locked_delta) !== rule[2]
      || Number(entry.available_after) < 0 || Number(entry.locked_after) < 0 || byType.has(entry.entry_type)) {
      return invalid('LEDGER_TRANSFER_MISMATCH');
    }
    byType.set(entry.entry_type, entry);
  }
  for (const kind of ['LOCK', 'RELEASE', 'REFUND']) {
    const debit = byType.get(`ESCROW_${kind}_DEBIT`), credit = byType.get(`ESCROW_${kind}_CREDIT`);
    if (!!debit !== !!credit || (debit && debit.request_id !== credit.request_id)) return invalid('LEDGER_TRANSFER_MISMATCH');
  }
  const locked = byType.has('ESCROW_LOCK_DEBIT');
  const released = byType.has('ESCROW_RELEASE_DEBIT'), refunded = byType.has('ESCROW_REFUND_DEBIT');
  if (released && refunded) return invalid('LEDGER_TRANSFER_MISMATCH');
  const expected = { NONE: [false, false, false], LOCKED: [true, false, false], FROZEN: [true, false, false],
    RELEASED: [true, true, false], REFUNDED: [true, false, true] }[txn.escrow_status];
  if (!expected || expected.some((value, index) => value !== [locked, released, refunded][index])) {
    return invalid('ESCROW_LEDGER_MISMATCH');
  }
  return { valid: true, coverage: snapshotCount ? 'SNAPSHOT_AND_LEDGER' : 'LEGACY_AMOUNT_STATE_AND_LEDGER', snapshotCount };
}

async function inspectOrder(db, transactionId) {
  const txn = await db.prepare('SELECT * FROM transactions WHERE id = ?').get(transactionId);
  if (!txn) throw new AppError(404, 'TRANSACTION_NOT_FOUND', 'Không tìm thấy đơn hàng.');
  const hold = await getHold(db, transactionId);
  const chain = await require('./hash').verifyChain(db, transactionId);
  const entries = await ledgerRows(db, transactionId);
  const logs = await db.prepare('SELECT * FROM audit_logs WHERE transaction_id=? ORDER BY sequence_no,id').all(transactionId);
  let referenceEscrowStatus=hold?.referenceEscrowStatus||null;
  if(chain.valid){
    for(const log of logs){
      const snapshot=JSON.parse(log.event_data||'{}').integritySnapshot;
      if(snapshot?.version===1&&['NONE','LOCKED','FROZEN','RELEASED','REFUNDED'].includes(snapshot.order?.escrowStatus))referenceEscrowStatus=snapshot.order.escrowStatus;
    }
  }
  const business = !chain.valid ? null : !logs.length ? invalid('AUDIT_HISTORY_MISSING')
    : hold ? null : await checkBusinessData(db, txn, logs, entries);
  const failure = !chain.valid ? chain : business && !business.valid ? business : null;
  return { ...chain, valid: !failure && !hold, chainValid: chain.valid,
    businessValid: business?.valid ?? null, coverage: business?.coverage || null,
    reason: failure?.reason || (hold ? BLOCKED : null),
    invalidLogId: failure?.invalidLogId ?? null,
    invalidSequenceNo: failure?.invalidSequenceNo ?? null,
    expectedSequenceNo: failure?.expectedSequenceNo ?? null,
    referenceLogId: failure?.referenceLogId ?? null,
    referenceSequenceNo: failure?.referenceSequenceNo ?? null,
    fields: failure?.fields || [], integrityHold: hold,
    escrowStatus: txn.escrow_status,
    referenceEscrowStatus,
    moneyBlocked: !!failure || !!hold,
    // No wallet is changed here. A known settled order is never made to hold
    // imaginary money again simply because its historical records are corrupt.
    escrowCurrentlyHeld: referenceEscrowStatus!==null?['LOCKED','FROZEN'].includes(referenceEscrowStatus)
      :entries.some(entry => entry.entry_type === 'ESCROW_LOCK_CREDIT')
        && !entries.some(entry => ['ESCROW_RELEASE_DEBIT','ESCROW_RELEASE_CREDIT','ESCROW_REFUND_DEBIT','ESCROW_REFUND_CREDIT'].includes(entry.entry_type)) };
}

async function assertOrderIntegrity(db, transactionId) {
  const report = await inspectOrder(db, transactionId);
  if (report.valid) return report;
  const error = new AppError(409, report.integrityHold ? BLOCKED : FAILURE,
    'Dữ liệu đơn chưa khớp với lịch sử. Enclave tạm dừng xử lý tiền của đơn này để kiểm tra.');
  if (!report.integrityHold) error.orderIntegrityFailure = { transactionId, report };
  throw error;
}

async function assertNotHeld(db, transactionId) {
  if (await getHold(db, transactionId)) throw new AppError(409, BLOCKED,
    'Dữ liệu đơn chưa khớp với lịch sử. Enclave tạm dừng xử lý tiền của đơn này để kiểm tra.');
}

async function recordHold(db, transactionId, report, actorId = null, req = null) {
  const txn = await db.prepare('SELECT * FROM transactions WHERE id=?').get(transactionId);
  if (!txn) throw new AppError(404, 'TRANSACTION_NOT_FOUND', 'Không tìm thấy đơn hàng.');
  const at = new Date().toISOString();
  const details = { chainValid: report.chainValid, businessValid: report.businessValid,
    invalidSequenceNo: report.invalidSequenceNo ?? null, expectedSequenceNo: report.expectedSequenceNo ?? null,
    referenceLogId: report.referenceLogId ?? null, referenceSequenceNo: report.referenceSequenceNo ?? null,
    fields: report.fields || [], referenceEscrowStatus:report.referenceEscrowStatus||null };
  const inserted = await db.prepare(`INSERT INTO order_integrity_holds
    (transaction_id,detected_at,detected_by,reason_code,invalid_log_id,details_json)
    VALUES(?,?,?,?,?,?) ON CONFLICT(transaction_id) DO NOTHING`)
    .run(transactionId, at, actorId, report.reason || FAILURE, report.invalidLogId ?? null, JSON.stringify(details));
  if (inserted.changes) {
    const frozen = report.referenceEscrowStatus!==null&&report.referenceEscrowStatus!==undefined
      ? ['LOCKED','FROZEN'].includes(report.referenceEscrowStatus)
      : report.escrowCurrentlyHeld || ['LOCKED', 'FROZEN'].includes(txn.escrow_status);
    // Terminal settlements keep their escrow result. The hold still prohibits
    // further financial requests, but cannot reverse money already transferred.
    const status = frozen ? 'FROZEN' : txn.escrow_status;
    const changed = await db.prepare('UPDATE transactions SET escrow_status=?,version=version+1,updated_at=? WHERE id=? AND version=?')
      .run(status, at, transactionId, txn.version);
    if (changed.changes !== 1) throw new ConflictError('TRANSACTION_VERSION_CONFLICT', 'Đơn vừa thay đổi. Hãy kiểm tra lại.');
    const { sql, params } = require('./securityEvents').buildSecurityEventInsert(req, {
      type: 'ORDER_INTEGRITY_HOLD', outcome: 'DENIED', statusCode: 409, actorId,
      detail: { transactionId, reason: report.reason || FAILURE }
    });
    await db.prepare(sql).run(...params);
  }
  return getHold(db, transactionId);
}

async function verifyAndHold(db, transactionId, actorId = null, req = null) {
  return db.transaction(async () => {
    const report = await inspectOrder(db, transactionId);
    if (!report.valid && !report.integrityHold) report.integrityHold = await recordHold(db, transactionId, report, actorId, req);
    const current = await db.prepare('SELECT escrow_status FROM transactions WHERE id=?').get(transactionId);
    return { ...report, escrowStatus: current.escrow_status, moneyBlocked: !report.valid || !!report.integrityHold };
  })();
}

// Must be called by a route/worker AFTER the failed money transaction rolled
// back. Otherwise the hold itself would be rolled back along with the refusal.
async function preserveIntegrityFailure(error, req = null) {
  if (!error?.orderIntegrityFailure) return false;
  const { db } = require('../db');
  const { transactionId, report } = error.orderIntegrityFailure;
  await db.transaction(() => recordHold(db, transactionId, report, req?.user?.id || null, req))();
  return true;
}

module.exports = { BLOCKED, FAILURE, migrateSqlite, captureAuditSnapshot, publicHold,
  getHold, inspectOrder, assertNotHeld, assertOrderIntegrity, verifyAndHold, preserveIntegrityFailure };
