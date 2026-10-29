// Thông báo cho người dùng và danh sách "Việc cần xử lý".
//
// Hai nguyên tắc không được phá:
//
// 1. Thông báo chỉ PHẢN ÁNH trạng thái. Hàm notify() được gọi SAU khi giao dịch cơ sở dữ liệu
//    của nghiệp vụ đã commit, và nuốt mọi lỗi của chính nó: một lần giải ngân hợp lệ không
//    được thất bại chỉ vì bảng thông báo gặp sự cố. Không route nào đọc bảng notifications để
//    quyết định được làm gì.
//
// 2. "Việc cần xử lý" (todoFor) KHÔNG đọc từ bảng notifications mà tính thẳng từ trạng thái
//    giao dịch, tranh chấp, yêu cầu nạp tiền. Nhờ vậy mất một thông báo (process chết ngay sau
//    commit, bảng thông báo lỗi...) không bao giờ làm mất một việc người dùng phải làm.
const { db, uuid, nowIso } = require('../db');
const { referenceFields } = require('./disputeReference');

/**
 * Ghi thông báo cho một hoặc nhiều người. Chỉ gọi SAU KHI nghiệp vụ đã commit.
 * @param {Array<{userId, type, title, body?, transactionId?, paymentRequestId?, key}>} items
 *        key: phân biệt sự kiện; cùng (type, key, userId) chỉ sinh một thông báo.
 */
async function notify(items) {
  for (const n of items) {
    if (!n || !n.userId) continue;
    try {
      // ON CONFLICT DO NOTHING (thay cho INSERT OR IGNORE chỉ SQLite hiểu): dedupe_key trùng thì bỏ qua.
      await db.prepare(
        `INSERT INTO notifications
           (id, user_id, type, title, body, transaction_id, payment_request_id, dedupe_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`
      ).run(
        uuid(),
        n.userId,
        n.type,
        n.title,
        n.body || null,
        n.transactionId || null,
        n.paymentRequestId || null,
        `${n.type}:${n.key}:${n.userId}`,
        nowIso()
      );
    } catch (e) {
      console.error('[notifications] không ghi được thông báo:', e.message);
    }
  }
}

async function adminIds() {
  // Chỉ quản trị viên có dấu nguồn gốc (lib/adminProvenance.js): tài khoản bị sửa role='ADMIN'
  // không được nhận thông báo về tranh chấp và yêu cầu bán hàng của người khác.
  return (await db.prepare(
    `SELECT u.id FROM users u JOIN admin_provenance p ON p.user_id = u.id
     WHERE u.role = 'ADMIN' AND u.account_status = 'ACTIVE'`
  ).all()).map((u) => u.id);
}

const money = (n) => `${Number(n).toLocaleString('vi-VN')}₫`;

// ---------- Các sự kiện nghiệp vụ -> thông báo ----------

async function onOrderSecured(txn) {
  await notify([{
    userId: txn.seller_id, type: 'ORDER_PAID', key: txn.id, transactionId: txn.id,
    title: 'Đơn hàng đã được thanh toán — cần xác nhận',
    body: `"${txn.item_name}" — ${money(txn.amount)} đang được giữ trong ký quỹ. Hãy xác nhận đơn rồi đóng gói để đơn vị vận chuyển mô phỏng tới lấy.`,
  }]);
}

async function onOrderAcknowledged(txn) {
  await notify([{
    userId: txn.buyer_id, type: 'ORDER_ACKNOWLEDGED', key: txn.id, transactionId: txn.id,
    title: 'Người bán đã xác nhận đơn hàng',
    body: `"${txn.item_name}" sẽ sớm được gửi đi. Tiền của bạn vẫn đang được giữ trong ký quỹ.`,
  }]);
}

async function onOrderPacked(txn) {
  await notify([{
    userId: txn.buyer_id, type: 'ORDER_PACKED', key: txn.id, transactionId: txn.id,
    title: 'Người bán đã đóng gói — chờ lấy hàng',
    body: `"${txn.item_name}" đang chờ đơn vị vận chuyển mô phỏng lấy hàng. Tiền vẫn được giữ trong ký quỹ.`,
  }]);
}

async function onShipmentPickedUp(txn) {
  await notify([txn.buyer_id, txn.seller_id].map((userId) => ({
    userId, type: 'SHIPMENT_PICKED_UP', key: txn.id, transactionId: txn.id,
    title: 'Đơn vị vận chuyển đã lấy hàng (mô phỏng)',
    body: `"${txn.item_name}" đang được vận chuyển tới người mua. Tiền vẫn được giữ trong ký quỹ.`,
  })));
}

async function onShipmentArrived(txn) {
  await notify([{
    userId: txn.buyer_id, type: 'SHIPMENT_ARRIVED', key: txn.id, transactionId: txn.id,
    title: 'Đơn hàng đã đến (mô phỏng)',
    body: `"${txn.item_name}" đã đến điểm giao. Hãy nhận kiện hàng rồi xác nhận đã nhận. Đây chưa phải xác nhận giải ngân.`,
  }]);
}

async function onOrderShipped(txn) {
  await notify([{
    userId: txn.buyer_id, type: 'ORDER_SHIPPED', key: txn.id, transactionId: txn.id,
    title: 'Người bán đã gửi hàng',
    body: `"${txn.item_name}" đang trên đường tới. Khi nhận được kiện hàng, hãy xác nhận đã nhận.`,
  }]);
}

async function onOrderWaitConfirm(txn) {
  const systemReceipt = txn.received_confirmed_by === 'SYSTEM';
  await notify([
    {
      userId: txn.buyer_id, type: 'ORDER_WAIT_CONFIRM', key: txn.id, transactionId: txn.id,
      title: 'Kiểm tra hàng rồi xác nhận giải ngân',
      body: `Nếu "${txn.item_name}" đúng mô tả, hãy xác nhận để giải ngân ${money(txn.amount)} cho người bán; nếu không, hãy mở tranh chấp.`,
    },
    {
      userId: txn.seller_id, type: 'ORDER_WAIT_CONFIRM', key: txn.id, transactionId: txn.id,
      title: systemReceipt ? 'Hệ thống đã mở thời hạn kiểm hàng' : 'Người mua đã nhận hàng',
      body: systemReceipt
        ? `"${txn.item_name}" đã quá hạn xác nhận nhận kiện. Người mua chưa tự xác nhận đã nhận; tiền vẫn ở ký quỹ.`
        : `"${txn.item_name}" đang chờ người mua kiểm hàng và đồng ý giải ngân.`,
    },
  ]);
}

async function onOrderCompleted(txn) {
  await notify([{
    userId: txn.seller_id, type: 'ORDER_COMPLETED', key: txn.id, transactionId: txn.id,
    title: 'Người mua đã xác nhận — tiền đã về ví',
    body: `${money(txn.amount)} cho "${txn.item_name}" đã được giải ngân vào ví của bạn.`,
  }]);
}

async function onDisputeOpened(txn, openedByUserId, dispute) {
  const reference=dispute?referenceFields(dispute):null;
  const name=reference?.caseCode?'Hồ sơ '+reference.caseCode:'Hồ sơ tranh chấp';
  const recipients = openedByUserId
    ? [openedByUserId === txn.buyer_id ? txn.seller_id : txn.buyer_id]
    : [txn.buyer_id, txn.seller_id];
  const admins = await adminIds();
  await notify([
    ...recipients.map(userId => ({
      userId, type: 'DISPUTE_OPENED', key: txn.id, transactionId: txn.id,
      title: name+(openedByUserId?' cần giải quyết':' do hệ thống tự mở'),
      body: `"${txn.item_name}": ${reference?.typeLabel||'cần xem xét vấn đề đơn hàng'}. Enclave đang giữ ${money(txn.amount)} trong khi chờ quản trị viên giải quyết.`,
    })),
    ...admins.map((adminId) => ({
      userId: adminId, type: 'DISPUTE_OPENED', key: txn.id, transactionId: txn.id,
      title: name+' mới cần xem xét',
      body: `"${txn.item_name}" — ${money(txn.amount)}${reference?' · '+reference.typeLabel:''}.`,
    })),
  ]);
}

async function onDisputeResolved(txn, decision) {
  const refund = decision === 'REFUND';
  const body = refund
    ? `Quản trị viên quyết định HOÀN TIỀN ${money(txn.amount)} cho người mua.`
    : `Quản trị viên quyết định GIẢI NGÂN ${money(txn.amount)} cho người bán.`;
  await notify([txn.buyer_id, txn.seller_id].map((userId) => ({
    userId, type: 'DISPUTE_RESOLVED', key: txn.id, transactionId: txn.id,
    title: `Tranh chấp "${txn.item_name}" đã được phân xử`, body,
  })));
}

async function onTopupResolved(paymentRequest, status) {
  const ok = status === 'SUCCEEDED';
  await notify([{
    userId: paymentRequest.user_id,
    type: ok ? 'TOPUP_SUCCEEDED' : 'TOPUP_FAILED',
    key: paymentRequest.id,
    paymentRequestId: paymentRequest.id,
    title: ok ? 'Nạp tiền thành công' : 'Nạp tiền thất bại',
    body: ok
      ? `${money(paymentRequest.amount)} đã được cộng vào ví.`
      : `Cổng thanh toán báo giao dịch nạp ${money(paymentRequest.amount)} không thành công. Ví không bị trừ gì.`,
  }]);
}

// ---------- Việc cần xử lý: tính thẳng từ trạng thái ----------

async function todoFor(user) {
  const items = [];
  const txns = (sql, ...args) => db.prepare(sql).all(...args);

  for (const t of await txns(`SELECT * FROM transactions WHERE buyer_id = ? AND status = 'CREATED' ORDER BY created_at`, user.id)) {
    items.push({ kind: 'PAY_ORDER', role: 'BUYER', transactionId: t.id, title: 'Thanh toán đơn hàng',
      detail: `"${t.item_name}" — ${money(t.amount)} chưa được khoá vào ký quỹ.` });
  }
  for (const t of await txns(`SELECT t.*, sp.id AS shipment_id FROM transactions t
    LEFT JOIN shipments sp ON sp.transaction_id = t.id
    WHERE t.seller_id = ? AND t.status = 'SECURED' ORDER BY t.created_at`, user.id)) {
    if (t.shipment_id) continue; // Packed: the carrier now owns the next step.
    items.push(t.seller_ack_at
      ? { kind: 'SHIP_ORDER', role: 'SELLER', transactionId: t.id, title: 'Đóng gói đơn hàng',
        detail: `"${t.item_name}" — bạn đã xác nhận đơn. Đóng gói rồi bấm "Đã đóng gói" để đơn vị vận chuyển mô phỏng tới lấy.` }
      : { kind: 'ACK_ORDER', role: 'SELLER', transactionId: t.id, title: 'Xác nhận đơn hàng mới',
        detail: `"${t.item_name}" — người mua đã thanh toán ${money(t.amount)} vào ký quỹ.` });
  }
  for (const t of await txns(`SELECT t.*, sp.id AS shipment_id, sp.status AS shipment_status FROM transactions t
    LEFT JOIN shipments sp ON sp.transaction_id = t.id
    WHERE t.buyer_id = ? AND t.status = 'SHIPPING' ORDER BY t.created_at`, user.id)) {
    if (t.shipment_id && t.shipment_status !== 'ARRIVED') continue;
    items.push({ kind: 'CONFIRM_RECEIPT', role: 'BUYER', transactionId: t.id, title: 'Xác nhận đã nhận hàng',
      detail: t.shipment_id ? `"${t.item_name}" đã đến điểm giao (mô phỏng). Hãy nhận kiện hàng rồi xác nhận.`
        : `"${t.item_name}" đã được gửi đi.` });
  }
  for (const t of await txns(`SELECT t.* FROM transactions t
    LEFT JOIN disputes d ON d.transaction_id=t.id
    WHERE t.buyer_id = ? AND (t.status = 'WAIT_CONFIRM'
      OR (t.status='DISPUTED' AND d.status='OPEN' AND d.type='INSPECTION_TIMEOUT' AND d.opened_by='SYSTEM'))
    ORDER BY t.created_at`, user.id)) {
    items.push({ kind: 'RELEASE_OR_DISPUTE', role: 'BUYER', transactionId: t.id,
      title: t.inspected_at ? 'Đồng ý giải ngân hoặc báo vấn đề' : 'Kiểm hàng rồi ghi nhận đã kiểm',
      detail: `"${t.item_name}" — ${money(t.amount)} vẫn đang được giữ. ${t.inspected_at ? 'Bạn đã ghi nhận kiểm hàng; tiền chỉ chuyển khi có xác nhận giải ngân hợp lệ.' : 'Đã nhận kiện, đã kiểm hàng và giải ngân là ba bước riêng.'}` });
  }
  const pendingTopups = (await db.prepare(`SELECT COUNT(*) AS n FROM payment_requests WHERE user_id = ? AND status = 'PENDING'`).get(user.id)).n;
  if (pendingTopups > 0) {
    items.push({ kind: 'TOPUP_PENDING', role: user.role, title: 'Nạp tiền đang chờ xác nhận',
      detail: `${pendingTopups} yêu cầu nạp tiền chưa có kết quả từ cổng thanh toán.` });
  }

  if (user.role === 'ADMIN') {
    for (const d of await db.prepare(
      `SELECT d.id, d.transaction_id, t.item_name, t.amount FROM disputes d JOIN transactions t ON t.id = d.transaction_id
       WHERE d.status = 'OPEN' AND t.buyer_id<>? AND t.seller_id<>? ORDER BY d.created_at`
    ).all(user.id,user.id)) {
      items.push({ kind: 'ADJUDICATE_DISPUTE', role: 'ADMIN', transactionId: d.transaction_id, disputeId: d.id,
        title: 'Phân xử tranh chấp', detail: `"${d.item_name}" — ${money(d.amount)} đang bị đóng băng.` });
    }
    const pendingSellers = (await db.prepare(`SELECT COUNT(*) AS n FROM seller_requests WHERE status = 'PENDING'`).get()).n;
    if (pendingSellers > 0) {
      items.push({ kind: 'REVIEW_SELLER_REQUESTS', role: 'ADMIN', title: 'Duyệt yêu cầu mở cửa hàng',
        detail: `${pendingSellers} yêu cầu đang chờ duyệt.` });
    }
  }
  return items;
}

module.exports = {
  notify,
  todoFor,
  onOrderSecured,
  onOrderAcknowledged,
  onOrderPacked,
  onShipmentPickedUp,
  onShipmentArrived,
  onOrderShipped,
  onOrderWaitConfirm,
  onOrderCompleted,
  onDisputeOpened,
  onDisputeResolved,
  onTopupResolved,
};
