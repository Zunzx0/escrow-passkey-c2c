const express = require('express');

const { db, nowIso } = require('../db');
const { requireAuth } = require('../lib/auth');
const { AppError } = require('../lib/errors');
const { todoFor } = require('../lib/notifications');

const router = express.Router();
router.use(requireAuth);

function serialize(n) {
  return {
    id: n.id,
    type: n.type,
    title: n.title,
    body: n.body,
    transactionId: n.transaction_id,
    paymentRequestId: n.payment_request_id,
    read: !!n.read_at,
    readAt: n.read_at,
    createdAt: n.created_at,
  };
}

// Giao diện gọi định kỳ (polling) — không cần WebSocket cho phạm vi đồ án.
router.get('/', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '30', 10) || 30, 100);
  const rows = await db
    .prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?')
    .all(req.user.id, limit);
  const unread = (await db
    .prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL')
    .get(req.user.id)).n;
  res.json({ notifications: rows.map(serialize), unreadCount: unread });
});

// "Việc cần xử lý" — tính từ trạng thái thật, không từ bảng thông báo (xem lib/notifications.js).
router.get('/todo', async (req, res) => {
  res.json({ items: await todoFor(req.user) });
});

router.post('/read-all', async (req, res) => {
  const r = await db
    .prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL')
    .run(nowIso(), req.user.id);
  res.json({ marked: r.changes });
});

router.post('/:id/read', async (req, res, next) => {
  try {
    // Điều kiện user_id nằm trong WHERE: thông báo của người khác đơn giản là "không tìm thấy",
    // không lộ ra việc nó có tồn tại hay không.
    const row = await db.prepare('SELECT * FROM notifications WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!row) throw new AppError(404, 'NOTIFICATION_NOT_FOUND', 'Không tìm thấy thông báo');
    if (!row.read_at) {
      await db.prepare('UPDATE notifications SET read_at = ? WHERE id = ?').run(nowIso(), row.id);
    }
    res.json(serialize(await db.prepare('SELECT * FROM notifications WHERE id = ?').get(row.id)));
  } catch (e) {
    next(e);
  }
});

module.exports = router;
