// Đơn vị vận chuyển mô phỏng. Thời gian do máy chủ chốt một lần khi đóng gói;
// animation chỉ trình bày lịch đó, không được chuyển trạng thái nghiệp vụ ở client.
const { db, uuid } = require('../db');
const { AppError, ConflictError } = require('./errors');
const { appendAuditLog } = require('./hash');
const { applyTransactionStatus } = require('./walletOps');
const { onShipmentPickedUp, onShipmentArrived } = require('./notifications');

const PICKUP_DELAY_MS = 4700;
const ARRIVAL_DELAY_MS = 19200;

function timeValue(now) {
  const value = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(value)) throw new TypeError('Invalid shipping clock');
  return value;
}

function serializeShipment(row, serverNow = new Date().toISOString()) {
  if (!row) return null;
  return {
    id: row.id, status: row.status,
    packedAt: row.packed_at, pickupDueAt: row.pickup_due_at,
    pickedUpAt: row.picked_up_at, arrivalDueAt: row.arrival_due_at,
    arrivedAt: row.arrived_at, stoppedAt: row.stopped_at,
    stopReason: row.stop_reason, serverNow,
  };
}

// Call within the same db.transaction as the seller's audit event. The transaction
// advisory lock (PG)/BEGIN IMMEDIATE (SQLite), unique transaction_id and version CAS
// make duplicate pack requests and concurrent worker processes harmless.
async function createShipment(txn, { now = Date.now() } = {}) {
  const existing = await db.prepare('SELECT * FROM shipments WHERE transaction_id = ?').get(txn.id);
  if (existing) {
    if (existing.status === 'STOPPED' || !['SECURED', 'SHIPPING', 'WAIT_CONFIRM'].includes(txn.status)
      || txn.escrow_status !== 'LOCKED') {
      throw new AppError(409, 'SHIPMENT_STOPPED', 'Vận chuyển của đơn này đã dừng. Không thể tạo lại lịch lấy hàng.');
    }
    return { shipment: existing, created: false };
  }
  if (txn.status !== 'SECURED' || txn.escrow_status !== 'LOCKED') {
    throw new AppError(409, 'INVALID_STATE', 'Chỉ đóng gói được đơn đã thanh toán và tiền đang ký quỹ.');
  }
  if (!txn.seller_ack_at) {
    throw new AppError(409, 'ACKNOWLEDGEMENT_REQUIRED', 'Hãy xác nhận đơn hàng trước khi đóng gói.');
  }
  const start = timeValue(now);
  const packedAt = new Date(start).toISOString();
  const id = uuid();
  const updated = await db.prepare(
    `UPDATE transactions SET version = version + 1, updated_at = ?
     WHERE id = ? AND version = ? AND status = 'SECURED' AND escrow_status = 'LOCKED'
       AND seller_ack_at IS NOT NULL`
  ).run(packedAt, txn.id, txn.version);
  if (updated.changes !== 1) throw new ConflictError('TRANSACTION_VERSION_CONFLICT');
  await db.prepare(
    `INSERT INTO shipments (id, transaction_id, status, packed_at, pickup_due_at, arrival_due_at)
     VALUES (?, ?, 'PICKUP_PENDING', ?, ?, ?)`
  ).run(id, txn.id, packedAt, new Date(start + PICKUP_DELAY_MS).toISOString(), new Date(start + ARRIVAL_DELAY_MS).toISOString());
  return { shipment: await db.prepare('SELECT * FROM shipments WHERE id = ?').get(id), created: true };
}

// A stopped shipment is never restarted. Preserve earlier timestamps as evidence.
async function stopShipment(txn, shipment, at) {
  const stopped = await db.prepare(
    `UPDATE shipments SET status = 'STOPPED', stopped_at = ?, stop_reason = ?, version = version + 1
     WHERE id = ? AND version = ? AND status <> 'STOPPED'`
  ).run(at, `TRANSACTION_${txn.status}_${txn.escrow_status}`, shipment.id, shipment.version);
  if (stopped.changes !== 1) return false;
  await appendAuditLog(db, {
    transactionId: txn.id, actorId: null, action: 'SIMULATED_SHIPMENT_STOPPED',
    oldStatus: txn.status, newStatus: txn.status,
    eventData: { shipmentId: shipment.id, reason: `TRANSACTION_${txn.status}_${txn.escrow_status}`, stoppedAt: at },
  });
  return true;
}

async function reconcileShipping({ now = Date.now() } = {}) {
  const atMs = timeValue(now);
  const at = new Date(atMs).toISOString();
  const counts = { pickedUp: 0, arrived: 0, stopped: 0 };
  // No historical backfill. Only persisted shipments may advance; re-read every
  // candidate inside a write transaction to avoid stale reads and dispute races.
  const candidates = await db.prepare(
    `SELECT sp.id FROM shipments sp JOIN transactions t ON t.id = sp.transaction_id
     WHERE sp.status <> 'STOPPED' AND (
       (sp.status = 'PICKUP_PENDING' AND
         (sp.pickup_due_at <= ? OR t.status <> 'SECURED' OR t.escrow_status <> 'LOCKED'))
       OR (sp.status = 'IN_TRANSIT' AND
         (sp.arrival_due_at <= ? OR t.status <> 'SHIPPING' OR t.escrow_status <> 'LOCKED'))
       OR (sp.status = 'ARRIVED' AND
         (t.status NOT IN ('SHIPPING','WAIT_CONFIRM') OR t.escrow_status <> 'LOCKED'))
     ) ORDER BY sp.packed_at`
  ).all(at, at);
  for (const candidate of candidates) {
    const events = await db.transaction(async () => {
      let shipment = await db.prepare('SELECT * FROM shipments WHERE id = ?').get(candidate.id);
      if (!shipment || shipment.status === 'STOPPED') return [];
      let txn = await db.prepare('SELECT * FROM transactions WHERE id = ?').get(shipment.transaction_id);
      if (!txn) return [];
      const allowed = shipment.status === 'PICKUP_PENDING' ? ['SECURED']
        : shipment.status === 'IN_TRANSIT' ? ['SHIPPING'] : ['SHIPPING', 'WAIT_CONFIRM'];
      if (txn.escrow_status !== 'LOCKED' || !allowed.includes(txn.status)) {
        if (await stopShipment(txn, shipment, at)) counts.stopped += 1;
        return [];
      }
      const emitted = [];
      if (shipment.status === 'PICKUP_PENDING' && shipment.pickup_due_at <= at) {
        const changed = await db.prepare(
          `UPDATE shipments SET status = 'IN_TRANSIT', picked_up_at = ?, version = version + 1
           WHERE id = ? AND status = 'PICKUP_PENDING' AND version = ?`
        ).run(at, shipment.id, shipment.version);
        if (changed.changes !== 1) throw new ConflictError('SHIPMENT_VERSION_CONFLICT');
        txn = await applyTransactionStatus(txn, { status: 'SHIPPING', escrowStatus: 'LOCKED' });
        await appendAuditLog(db, {
          transactionId: txn.id, actorId: null, action: 'SIMULATED_CARRIER_PICKED_UP',
          oldStatus: 'SECURED', newStatus: 'SHIPPING',
          eventData: { shipmentId: shipment.id, pickedUpAt: at, simulated: true },
        });
        shipment = await db.prepare('SELECT * FROM shipments WHERE id = ?').get(shipment.id);
        emitted.push({ kind: 'pickedUp', txn });
      }
      if (shipment.status === 'IN_TRANSIT' && shipment.arrival_due_at <= at) {
        const changed = await db.prepare(
          `UPDATE shipments SET status = 'ARRIVED', arrived_at = ?, version = version + 1
           WHERE id = ? AND status = 'IN_TRANSIT' AND version = ?`
        ).run(at, shipment.id, shipment.version);
        if (changed.changes !== 1) throw new ConflictError('SHIPMENT_VERSION_CONFLICT');
        await appendAuditLog(db, {
          transactionId: txn.id, actorId: null, action: 'SIMULATED_CARRIER_ARRIVED',
          oldStatus: 'SHIPPING', newStatus: 'SHIPPING',
          eventData: { shipmentId: shipment.id, arrivedAt: at, simulated: true },
        });
        emitted.push({ kind: 'arrived', txn });
      }
      return emitted;
    })();
    // Notifications describe committed state; they never govern receipt or money.
    for (const event of events) {
      counts[event.kind] += 1;
      if (event.kind === 'pickedUp') await onShipmentPickedUp(event.txn);
      else await onShipmentArrived(event.txn);
    }
  }
  return counts;
}

function startShippingWorker({ intervalMilliseconds = 1000 } = {}) {
  let busy = false;
  async function tick() {
    if (busy) return;
    busy = true;
    try { await reconcileShipping(); }
    catch (error) { console.error('[shipping] lượt vận chuyển mô phỏng hỏng:', error.message); }
    finally { busy = false; }
  }
  // Recover schedules immediately after process startup, including downtime.
  void tick();
  const timer = setInterval(tick, intervalMilliseconds);
  timer.unref();
  return timer;
}

module.exports = {
  PICKUP_DELAY_MS, ARRIVAL_DELAY_MS, serializeShipment, createShipment,
  reconcileShipping, startShippingWorker,
};
