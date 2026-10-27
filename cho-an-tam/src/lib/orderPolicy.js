// Durations are production policy, never shortened by a public demo switch.
function hours(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isFinite(value) || value <= 0 || value > 87600) throw new Error(`Invalid ${name}`);
  return value;
}

function orderPolicy() {
  return {
    draftHours: hours('ORDER_DRAFT_TTL_HOURS', 24),
    sellerConfirmHours: hours('SELLER_CONFIRM_HOURS', 48),
    sellerPackHours: hours('SELLER_PACK_HOURS', 72),
    shippingMaxHours: hours('SHIPPING_MAX_HOURS', 24),
    buyerReceiveHours: hours('BUYER_RECEIVE_HOURS', 72),
    inspectionHours: hours('INSPECTION_HOURS', 72),
    evidenceHours: 72, adminHours: 168, maxOpenDrafts: 5, shippingFee: 0,
  };
}

function afterHours(at, count) {
  return new Date(new Date(at).getTime() + count * 3600000).toISOString();
}

function orderDeadline(txn, shipment) {
  const p = orderPolicy();
  if (txn.status === 'CREATED') return txn.draft_expires_at || afterHours(txn.created_at, p.draftHours);
  if (txn.status === 'SECURED') return shipment
  ? afterHours(shipment.packed_at, p.shippingMaxHours)
  : txn.seller_ack_at ? afterHours(txn.seller_ack_at, p.sellerPackHours)
  : afterHours(txn.secured_at || txn.created_at, p.sellerConfirmHours);
  if (txn.status === 'SHIPPING') return shipment?.status === 'ARRIVED'
  ? afterHours(shipment.arrived_at, p.buyerReceiveHours)
  : afterHours(shipment?.packed_at || txn.created_at, p.shippingMaxHours);
  if (txn.status === 'WAIT_CONFIRM') return txn.inspection_due_at || afterHours(txn.received_confirmed_at || txn.created_at, p.inspectionHours);
  return null;
}
module.exports = {
  orderPolicy, afterHours, orderDeadline
};
