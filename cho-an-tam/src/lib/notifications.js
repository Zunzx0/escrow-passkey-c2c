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

/**
 * Ghi thông báo cho một hoặc nhiều người. Chỉ gọi SAU KHI nghiệp vụ đã commit.
 * @param {Array<{userId, type, title, body?, transactionId?, paymentRequestId?, key}>} items
 *        key: phân biệt sự kiện; cùng (type, key, userId) chỉ sinh một thông báo.
 */
function notify(items) {
  for (const n of items) {
    if (!n || !n.userId) continue;
    try {
      db.prepare(
        `INSERT OR IGNORE INTO notifications
           (id, user_id, type, title, body, transaction_id, payment_request_id, dedupe_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
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

function adminIds() {
  return db.prepare(`SELECT id FROM users WHERE role = 'ADMIN' AND account_status = 'ACTIVE'`).all().map((u) => u.id);
}

const money = (n) => `${Number(n).toLocaleString('vi-VN')}₫`;

// ---------- Các sự kiện nghiệp vụ -> thông báo ----------

function onOrderSecured(txn) {
  notify([{
    userId: txn.seller_id, type: 'ORDER_PAID', key: txn.id, transactionId: txn.id,
    title: 'Đơn hàng đã được thanh toán — cần giao hàng',
    body: `"${txn.item_name}" — ${money(txn.amount)} đang được giữ trong ký quỹ. Hãy gửi hàng cho người mua.`,
  }]);
}

function onOrderAcknowledged(txn) {
  notify([{
    userId: txn.buyer_id, type: 'ORDER_ACKNOWLEDGED', key: txn.id, transactionId: txn.id,
    title: 'Người bán đã xác nhận đơn hàng',
    body: `"${txn.item_name}" sẽ sớm được gửi đi. Tiền của bạn vẫn đang được giữ trong ký quỹ.`,
  }]);
}

function onOrderShipped(txn) {
  notify([{
    userId: txn.buyer_id, type: 'ORDER_SHIPPED', key: txn.id, transactionId: txn.id,
    title: 'Người bán đã gửi hàng',
    body: `"${txn.item_name}" đang trên đường tới. Khi nhận được kiện hàng, hãy xác nhận đã nhận.`,
  }]);
}

function onOrderWaitConfirm(txn) {
  notify([
    {
      userId: txn.buyer_id, type: 'ORDER_WAIT_CONFIRM', key: txn.id, transactionId: txn.id,
      title: 'Kiểm tra hàng rồi xác nhận giải ngân',
      body: `Nếu "${txn.item_name}" đúng mô tả, hãy xác nhận để giải ngân ${money(txn.amount)} cho người bán; nếu không, hãy mở tranh chấp.`,
    },
    {
      userId: txn.seller_id, type: 'ORDER_WAIT_CONFIRM', key: txn.id, transactionId: txn.id,
      title: 'Người mua đã nhận hàng',
      body: `"${txn.item_name}" đang chờ người mua xác nhận để giải ngân.`,
    },
  ]);
}

function onOrderCompleted(txn) {
  notify([{
    userId: txn.seller_id, type: 'ORDER_COMPLETED', key: txn.id, transactionId: txn.id,
    title: 'Người mua đã xác nhận — tiền đã về ví',
    body: `${money(txn.amount)} cho "${txn.item_name}" đã được giải ngân vào ví của bạn.`,
  }]);
}

function onDisputeOpened(txn, openedByUserId) {
  const counterparty = openedByUserId === txn.buyer_id ? txn.seller_id : txn.buyer_id;
  notify([
    {
      userId: counterparty, type: 'DISPUTE_OPENED', key: txn.id, transactionId: txn.id,
      title: 'Giao dịch bị mở tranh chấp',
      body: `"${txn.item_name}" đang tranh chấp; ${money(txn.amount)} bị đóng băng chờ quản trị viên phân xử.`,
    },
    ...adminIds().map((adminId) => ({
      userId: adminId, type: 'DISPUTE_OPENED', key: txn.id, transactionId: txn.id,
      title: 'Có hồ sơ tranh chấp mới cần phân xử',
      body: `"${txn.item_name}" — ${money(txn.amount)}.`,
    })),
  ]);
}

function onDisputeResolved(txn, decision) {
  const refund = decision === 'REFUND';
  const body = refund
    ? `Quản trị viên quyết định HOÀN TIỀN ${money(txn.amount)} cho người mua.`
    : `Quản trị viên quyết định GIẢI NGÂN ${money(txn.amount)} cho người bán.`;
  notify([txn.buyer_id, txn.seller_id].map((userId) => ({
    userId, type: 'DISPUTE_RESOLVED', key: txn.id, transactionId: txn.id,
    title: `Tranh chấp "${txn.item_name}" đã được phân xử`, body,
  })));
}

function onTopupResolved(paymentRequest, status) {
  const ok = status === 'SUCCEEDED';
  notify([{
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

function todoFor(user) {
  const items = [];
  const txns = (sql, ...args) => db.prepare(sql).all(...args);

  for (const t of txns(`SELECT * FROM transactions WHERE buyer_id = ? AND status = 'CREATED' ORDER BY created_at`, user.id)) {
    items.push({ kind: 'PAY_ORDER', role: 'BUYER', transactionId: t.id, title: 'Thanh toán đơn hàng',
      detail: `"${t.item_name}" — ${money(t.amount)} chưa được khoá vào ký quỹ.` });
  }
  for (const t of txns(`SELECT * FROM transactions WHERE seller_id = ? AND status = 'SECURED' ORDER BY created_at`, user.id)) {
    items.push(t.seller_ack_at
      ? { kind: 'SHIP_ORDER', role: 'SELLER', transactionId: t.id, title: 'Giao hàng cho người mua',
        detail: `"${t.item_name}" — bạn đã xác nhận đơn, hãy gửi hàng và bấm "Xác nhận giao hàng".` }
      : { kind: 'ACK_ORDER', role: 'SELLER', transactionId: t.id, title: 'Xác nhận đơn hàng mới',
        detail: `"${t.item_name}" — người mua đã thanh toán ${money(t.amount)} vào ký quỹ.` });
  }
  for (const t of txns(`SELECT * FROM transactions WHERE buyer_id = ? AND status = 'SHIPPING' ORDER BY created_at`, user.id)) {
    items.push({ kind: 'CONFIRM_RECEIPT', role: 'BUYER', transactionId: t.id, title: 'Xác nhận đã nhận hàng',
      detail: `"${t.item_name}" đã được gửi đi.` });
  }
  for (const t of txns(`SELECT * FROM transactions WHERE buyer_id = ? AND status = 'WAIT_CONFIRM' ORDER BY created_at`, user.id)) {
    items.push({ kind: 'RELEASE_OR_DISPUTE', role: 'BUYER', transactionId: t.id, title: 'Xác nhận giải ngân hoặc mở tranh chấp',
      detail: `"${t.item_name}" — ${money(t.amount)} đang chờ quyết định của bạn.` });
  }
  const pendingTopups = db.prepare(`SELECT COUNT(*) AS n FROM payment_requests WHERE user_id = ? AND status = 'PENDING'`).get(user.id).n;
  if (pendingTopups > 0) {
    items.push({ kind: 'TOPUP_PENDING', role: user.role, title: 'Nạp tiền đang chờ xác nhận',
      detail: `${pendingTopups} yêu cầu nạp tiền chưa có kết quả từ cổng thanh toán.` });
  }

  if (user.role === 'ADMIN') {
    for (const d of db.prepare(
      `SELECT d.id, d.transaction_id, t.item_name, t.amount FROM disputes d JOIN transactions t ON t.id = d.transaction_id
       WHERE d.status = 'OPEN' ORDER BY d.created_at`
    ).all()) {
      items.push({ kind: 'ADJUDICATE_DISPUTE', role: 'ADMIN', transactionId: d.transaction_id, disputeId: d.id,
        title: 'Phân xử tranh chấp', detail: `"${d.item_name}" — ${money(d.amount)} đang bị đóng băng.` });
    }
    const pendingSellers = db.prepare(`SELECT COUNT(*) AS n FROM seller_requests WHERE status = 'PENDING'`).get().n;
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
  onOrderShipped,
  onOrderWaitConfirm,
  onOrderCompleted,
  onDisputeOpened,
  onDisputeResolved,
  onTopupResolved,
};
