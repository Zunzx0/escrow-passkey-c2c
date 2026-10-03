const express = require('express');
const crypto = require('crypto');
const { generateAuthenticationOptions, verifyAuthenticationResponse } = require('@simplewebauthn/server');

const { db, uuid, nowIso } = require('../db');
const { requireAuth, requireRole } = require('../lib/auth');
const { appendAuditLog, verifyChain } = require('../lib/hash');
const { AppError, ConflictError } = require('../lib/errors');
const { RESERVING_STATUSES } = require('../lib/catalog');
const { ACTIONS, REAUTH_TTL_SECONDS, issueGrant, requireGrant, markGrantUsed } = require('../lib/reauth');
const { rateLimit } = require('../lib/rateLimit');
const { assessCounter, reportCounterAnomaly } = require('../lib/credentialCounter');
const { RP_ID, ORIGIN } = require('../lib/webauthnConfig');
const {
  onOrderSecured, onOrderAcknowledged, onOrderShipped, onOrderWaitConfirm, onOrderCompleted, onDisputeOpened,
} = require('../lib/notifications');
const { settleListing } = require('../lib/listingLifecycle');

// Mỗi lần xin challenge đều ghi một bản ghi vào cơ sở dữ liệu, nên đây là điểm gửi ồ ạt
// rẻ tiền nếu không chặn. Mở tranh chấp cũng được giới hạn vì nó đóng băng tiền của
// người khác.
const sensitiveLimiter = rateLimit({
  perMinute: parseInt(process.env.RATE_LIMIT_AUTH_PER_MINUTE || '10', 10),
});
const {
  applyOrderedWalletUpdates,
  applyTransactionStatus,
  insertWalletEntry,
  checkIdempotency,
  fingerprintRequest,
  getUserWallet,
  getEscrowWallet,
} = require('../lib/walletOps');

const router = express.Router();

const RESERVING_PLACEHOLDERS = RESERVING_STATUSES.map(() => '?').join(',');

// Đơn mua bán kèm tên hai bên và ảnh/tiêu đề sản phẩm, để UI không phải gọi thêm API.
const TXN_SELECT = `
  SELECT t.*,
         b.display_name AS buyer_name,  b.username AS buyer_username,
         s.display_name AS seller_name, s.username AS seller_username,
         l.title  AS listing_title,
         l.image  AS listing_image,
         l.category AS listing_category,
         l.location AS listing_location
  FROM transactions t
  JOIN users b ON b.id = t.buyer_id
  JOIN users s ON s.id = t.seller_id
  LEFT JOIN listings l ON l.id = t.listing_id
`;

function serializeTxn(t) {
  return {
    id: t.id,
    buyerId: t.buyer_id,
    sellerId: t.seller_id,
    buyerName: t.buyer_name || null,
    sellerName: t.seller_name || null,
    itemName: t.item_name,
    itemDescription: t.item_description,
    amount: t.amount,
    status: t.status,
    escrowStatus: t.escrow_status,
    version: t.version,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
    // Thông tin tin đăng (null với các giao dịch tạo bằng API thủ công, không gắn listing)
    listingId: t.listing_id || null,
    listingTitle: t.listing_title || null,
    listingImage: t.listing_image || null,
    listingCategory: t.listing_category || null,
    listingLocation: t.listing_location || null,
    buyerNote: t.buyer_note || null,
    sellerAckAt: t.seller_ack_at || null,
  };
}

async function loadTxnOr404(id) {
  const t = await db.prepare(`${TXN_SELECT} WHERE t.id = ?`).get(id);
  if (!t) throw new AppError(404, 'TRANSACTION_NOT_FOUND', 'Không tìm thấy giao dịch');
  return t;
}

/**
 * Quyền trên MỘT giao dịch cụ thể: xét theo việc bạn có phải một bên của chính giao dịch
 * đó không, chứ không xét vai trò toàn cục.
 *
 * Đây là lý do các endpoint vòng đời giao dịch (secure / reauth / release) KHÔNG dùng
 * thêm requireRole('BUYER'): một tài khoản có thể được cấp thêm quyền bán hàng trong lúc
 * còn đơn dở dang, và nếu chặn theo vai trò hiện tại thì người đó không tất toán được
 * đơn cũ — tiền sẽ kẹt vĩnh viễn trong Escrow. Kiểm theo buyer_id vừa đúng nghiệp vụ hơn
 * vừa chặt hơn: người khác dù cũng mang vai trò BUYER vẫn không lọt.
 */
function assertOwnership(txn, user, allowed) {
  if (allowed.includes('BUYER') && txn.buyer_id === user.id) return;
  if (allowed.includes('SELLER') && txn.seller_id === user.id) return;
  if (allowed.includes('ADMIN') && user.role === 'ADMIN') return;
  throw new AppError(403, 'FORBIDDEN', 'Bạn không có quyền trên giao dịch này');
}

/**
 * Sản phẩm đã bị một đơn khác giữ chỗ hoặc đã bán? (chống hai người cùng mua một món)
 *
 * Mỗi tin đăng là một sản phẩm đơn chiếc, nên chỉ cần tồn tại một đơn ở trạng thái giữ
 * chỗ là tin đăng ngừng nhận đơn mới. Bán xong là hết: COMPLETED và RELEASED cũng nằm
 * trong danh sách giữ chỗ.
 *
 * ĐÂY KHÔNG PHẢI hàng rào concurrency chính cho LOCK nữa — chỉ còn là kiểm tra nghiệp vụ
 * bổ sung, trả lỗi sớm và thân thiện trước khi chạm tới ví. Quyền sở hữu độc quyền tại
 * thời điểm LOCK do cập nhật có điều kiện trên `listings.status`/`version` bên trong
 * db.transaction() của route /secure quyết định (xem lockListingForOrder bên dưới).
 */
async function findReservingOrder(listingId, exceptTxnId) {
  return db
    .prepare(
      `SELECT id FROM transactions
       WHERE listing_id = ? AND id <> ? AND status IN (${RESERVING_PLACEHOLDERS}) LIMIT 1`
    )
    .get(listingId, exceptTxnId || '', ...RESERVING_STATUSES);
}

/**
 * Chiếm độc quyền một tin đăng đơn chiếc TẠI THỜI ĐIỂM LOCK, bằng đúng một cập nhật có
 * điều kiện trên listings.status + version — cùng khuôn mẫu optimistic locking đã dùng
 * cho wallets.version và transactions.version (xem walletOps.js). Đây là bất biến số 6:
 * "một tin đăng đơn chiếc chỉ một giao dịch khoá tiền thành công", và phải được cơ sở dữ
 * liệu ép buộc, không được suy ra ngầm từ việc dò transactions.listing_id.
 *
 * PHẢI gọi bên trong CÙNG db.transaction() với việc trừ/cộng ví: nếu cập nhật này thành
 * công nhưng bước ví sau đó lỗi, cả hai phải cùng rollback — không để tin đăng kẹt ở
 * LOCKED mà không có tiền nào thực sự bị khoá.
 */
async function lockListingForOrder(listingId) {
  const listing = await db.prepare('SELECT status, version FROM listings WHERE id = ?').get(listingId);
  if (!listing) throw new AppError(404, 'LISTING_NOT_FOUND', 'Tin đăng không còn tồn tại');
  const result = await db
    .prepare(
      `UPDATE listings SET status = 'LOCKED', version = version + 1, updated_at = ?
       WHERE id = ? AND status = 'AVAILABLE' AND version = ?`
    )
    .run(nowIso(), listingId, listing.version);
  if (result.changes !== 1) {
    throw new ConflictError('LISTING_SOLD', 'Sản phẩm vừa được người khác mua trước, đơn này không thể thanh toán');
  }
}

// ---------- Tạo giao dịch thủ công, không gắn tin đăng ----------
// Giữ lại để các kịch bản kiểm thử lõi escrow chạy được mà không cần lớp marketplace.

router.post('/', requireAuth, requireRole('BUYER'), async (req, res, next) => {
  try {
    const { sellerId, itemName, itemDescription, amount } = req.body || {};
    if (!sellerId || !itemName || !amount || amount <= 0) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Thiếu sellerId/itemName/amount hợp lệ');
    }
    if (sellerId === req.user.id) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Buyer và Seller phải khác nhau');
    }
    const seller = await db.prepare(`SELECT * FROM users WHERE id = ? AND role = 'SELLER'`).get(sellerId);
    if (!seller) throw new AppError(400, 'SELLER_NOT_FOUND', 'Seller không tồn tại');

    const id = uuid();
    const now = nowIso();
    await db.transaction(async () => {
      await db.prepare(
        `INSERT INTO transactions (id, buyer_id, seller_id, item_name, item_description, amount,
          status, escrow_status, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'CREATED', 'NONE', 0, ?, ?)`
      ).run(id, req.user.id, sellerId, itemName, itemDescription || null, amount, now, now);
      await appendAuditLog(db, {
        transactionId: id,
        actorId: req.user.id,
        action: 'TRANSACTION_CREATED',
        oldStatus: null,
        newStatus: 'CREATED',
        eventData: { itemName, amount, sellerId },
      });
    })();

    res.status(201).json(serializeTxn(await loadTxnOr404(id)));
  } catch (e) {
    next(e);
  }
});

// ---------- Đặt mua một sản phẩm từ storefront ----------

router.post('/orders', requireAuth, requireRole('BUYER'), async (req, res, next) => {
  try {
    const { listingId, note } = req.body || {};
    if (!listingId) throw new AppError(400, 'VALIDATION_ERROR', 'Thiếu listingId');

    const listing = await db.prepare('SELECT * FROM listings WHERE id = ?').get(listingId);
    if (!listing || listing.visibility !== 'PUBLIC') {
      throw new AppError(404, 'LISTING_NOT_FOUND', 'Sản phẩm không còn được bán');
    }
    if (listing.seller_id === req.user.id) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Không thể tự mua sản phẩm của chính mình');
    }
    if (await findReservingOrder(listing.id)) {
      throw new AppError(409, 'LISTING_SOLD', 'Sản phẩm này đã có người mua, vui lòng chọn sản phẩm khác');
    }

    // Server tự lấy giá từ listing trong DB — không bao giờ tin số tiền client gửi lên.
    const amount = listing.price;

    const id = uuid();
    const now = nowIso();
    const buyerNote = note ? String(note).trim().slice(0, 500) : null;

    await db.transaction(async () => {
      await db.prepare(
        `INSERT INTO transactions (id, buyer_id, seller_id, item_name, item_description, amount,
          status, escrow_status, listing_id, buyer_note, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'CREATED', 'NONE', ?, ?, 0, ?, ?)`
      ).run(
        id,
        req.user.id,
        listing.seller_id,
        listing.title,
        listing.description || null,
        amount,
        listing.id,
        buyerNote,
        now,
        now
      );

      await appendAuditLog(db, {
        transactionId: id,
        actorId: req.user.id,
        action: 'ORDER_CREATED',
        oldStatus: null,
        newStatus: 'CREATED',
        eventData: { listingId: listing.id, itemName: listing.title, amount },
      });
    })();

    res.status(201).json(serializeTxn(await loadTxnOr404(id)));
  } catch (e) {
    next(e);
  }
});

// ---------- Danh sách / chi tiết ----------

router.get('/', requireAuth, async (req, res) => {
  const { status, as } = req.query;
  const where = [];
  const params = [];

  // `as=buyer|seller` chọn GÓC NHÌN, không nới quyền: cả hai nhánh đều lọc theo đúng id
  // của người gọi, chỉ khác lọc ở cột nào. Cần tham số này vì một tài khoản đã được nâng
  // thêm quyền bán hàng vẫn còn những đơn mình từng đi mua — nếu chỉ lọc theo
  // vai trò hiện tại thì phần lịch sử đó biến mất khỏi giao diện.
  // Không truyền `as` thì giữ nguyên hành vi cũ: lọc theo vai trò hiện tại.
  const perspective = as === 'buyer' ? 'BUYER' : as === 'seller' ? 'SELLER' : req.user.role;

  if (perspective === 'BUYER') {
    where.push('t.buyer_id = ?');
    params.push(req.user.id);
  } else if (perspective === 'SELLER') {
    where.push('t.seller_id = ?');
    params.push(req.user.id);
  }
  if (status) {
    const wanted = String(status).split(',').map((s) => s.trim()).filter(Boolean);
    if (wanted.length) {
      where.push(`t.status IN (${wanted.map(() => '?').join(',')})`);
      params.push(...wanted);
    }
  }

  const sql = `${TXN_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t.created_at DESC LIMIT 200`;
  const rows = await db.prepare(sql).all(...params);
  res.json({ transactions: rows.map(serializeTxn) });
});

router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const txn = await loadTxnOr404(req.params.id);
    assertOwnership(txn, req.user, ['BUYER', 'SELLER', 'ADMIN']);
    // Hồ sơ tranh chấp (nếu có) đi kèm chi tiết giao dịch, để cả hai bên — không chỉ quản trị
    // viên — thấy được tiền đang bị đóng băng vì đâu và đã được phân xử ra sao.
    const d = await db.prepare('SELECT * FROM disputes WHERE transaction_id = ?').get(txn.id);
    res.json({
      ...serializeTxn(txn),
      dispute: d ? {
        id: d.id,
        status: d.status,
        reason: d.reason,
        openedBy: d.created_by === txn.buyer_id ? 'BUYER' : 'SELLER',
        adminDecision: d.admin_decision,
        createdAt: d.created_at,
        resolvedAt: d.resolved_at,
      } : null,
    });
  } catch (e) {
    next(e);
  }
});

// ---------- UC06: Khóa tiền vào Escrow ----------

router.post('/:id/secure', requireAuth, async (req, res, next) => {
  try {
    const { requestId } = req.body || {};
    if (!requestId) throw new AppError(400, 'VALIDATION_ERROR', 'Thiếu requestId');

    const txn = await loadTxnOr404(req.params.id);
    assertOwnership(txn, req.user, ['BUYER']);

    // Dấu vân tay gắn khoá chống lặp với đúng chủ thể, hành động, giao dịch và số tiền.
    // Gửi lại đúng yêu cầu cũ thì trả kết quả cũ; trùng khoá nhưng khác nội dung thì
    // checkIdempotency ném xung đột thay vì trả nhầm kết quả của nghiệp vụ khác.
    const fingerprint = fingerprintRequest({
      actorId: req.user.id,
      action: 'ESCROW_LOCK',
      transactionId: txn.id,
      amount: txn.amount,
    });
    const buyerLegKey = `lock:${requestId}:buyer`;
    if (await checkIdempotency(buyerLegKey, fingerprint)) {
      return res.json(serializeTxn(await loadTxnOr404(txn.id)));
    }

    if (txn.status !== 'CREATED' || txn.escrow_status !== 'NONE') {
      throw new AppError(409, 'INVALID_STATE', 'Giao dịch không ở trạng thái CREATED + NONE');
    }
    // Nhiều người có thể cùng tạo đơn cho một sản phẩm; ai khóa tiền trước thì giữ chỗ.
    if (txn.listing_id && (await findReservingOrder(txn.listing_id, txn.id))) {
      throw new AppError(409, 'LISTING_SOLD', 'Sản phẩm vừa được người khác mua trước, đơn này không thể thanh toán');
    }

    const buyerWallet = await getUserWallet(req.user.id);
    const escrowWallet = await getEscrowWallet();
    if (buyerWallet.available_balance < txn.amount) {
      throw new AppError(400, 'INSUFFICIENT_FUNDS', 'Số dư khả dụng không đủ');
    }

    await db.transaction(async () => {
      // Chiếm độc quyền tin đăng TRƯỚC khi chạm tới ví — đúng thứ tự bước 3-4 của quy trình
      // LOCK đã chốt. Thua ở bước này thì không có delta ví nào phát sinh để phải rollback.
      if (txn.listing_id) await lockListingForOrder(txn.listing_id);

      const updated = await applyOrderedWalletUpdates([
        { wallet: buyerWallet, availableDelta: -txn.amount, lockedDelta: 0 },
        { wallet: escrowWallet, availableDelta: 0, lockedDelta: txn.amount },
      ], 'lock');

      await insertWalletEntry({
        walletId: buyerWallet.id,
        transactionId: txn.id,
        requestId,
        entryType: 'ESCROW_LOCK_DEBIT',
        availableDelta: -txn.amount,
        lockedDelta: 0,
        walletAfter: updated.get(buyerWallet.id),
        idempotencyKey: buyerLegKey,
        requestFingerprint: fingerprint,
        description: 'Khóa tiền mua hàng vào Escrow',
      });
      await insertWalletEntry({
        walletId: escrowWallet.id,
        transactionId: txn.id,
        requestId,
        entryType: 'ESCROW_LOCK_CREDIT',
        availableDelta: 0,
        lockedDelta: txn.amount,
        walletAfter: updated.get(escrowWallet.id),
        idempotencyKey: `lock:${requestId}:escrow`,
        requestFingerprint: fingerprint,
        description: 'Escrow giữ tiền của người mua',
      });

      await applyTransactionStatus(txn, { status: 'SECURED', escrowStatus: 'LOCKED' });

      await appendAuditLog(db, {
        transactionId: txn.id,
        actorId: req.user.id,
        action: 'ESCROW_LOCKED',
        oldStatus: 'CREATED',
        newStatus: 'SECURED',
        eventData: { amount: txn.amount, requestId },
      });
    })();
    await onOrderSecured(txn);

    res.json(serializeTxn(await loadTxnOr404(txn.id)));
  } catch (e) {
    next(e);
  }
});

// ---------- Người bán xác nhận đơn ----------
//
// Mốc sự kiện, không phải trạng thái: đơn vẫn SECURED + LOCKED, không có tiền nào di chuyển.
// Cho người mua biết người bán đã thấy đơn và sẽ gửi hàng. Không bắt buộc trước khi gửi hàng —
// thêm một điều kiện chặn chuyển trạng thái là đổi máy trạng thái đã chốt ở Chương 2.
router.post('/:id/acknowledge', requireAuth, requireRole('SELLER'), async (req, res, next) => {
  try {
    const txn = await loadTxnOr404(req.params.id);
    assertOwnership(txn, req.user, ['SELLER']);
    if (txn.status !== 'SECURED' || txn.escrow_status !== 'LOCKED') {
      throw new AppError(409, 'INVALID_STATE', 'Chỉ xác nhận được đơn đã thanh toán (SECURED + LOCKED)');
    }
    if (txn.seller_ack_at) throw new AppError(409, 'ALREADY_ACKNOWLEDGED', 'Đơn này đã được xác nhận');

    await db.transaction(async () => {
      // Điều kiện nằm trong WHERE: hai lần bấm gần như đồng thời chỉ một lần ghi được.
      const r = await db
        .prepare(`UPDATE transactions SET seller_ack_at = ?, updated_at = ? WHERE id = ? AND seller_ack_at IS NULL AND status = 'SECURED'`)
        .run(nowIso(), nowIso(), txn.id);
      if (r.changes !== 1) throw new AppError(409, 'ALREADY_ACKNOWLEDGED', 'Đơn này vừa được xác nhận');
      await appendAuditLog(db, {
        transactionId: txn.id,
        actorId: req.user.id,
        action: 'SELLER_ACKNOWLEDGED',
        oldStatus: 'SECURED',
        newStatus: 'SECURED',
        eventData: {},
      });
    })();
    await onOrderAcknowledged(txn);
    res.json(serializeTxn(await loadTxnOr404(txn.id)));
  } catch (e) {
    next(e);
  }
});

// ---------- UC07: Người bán giao hàng ----------

router.post('/:id/ship', requireAuth, requireRole('SELLER'), async (req, res, next) => {
  try {
    const txn = await loadTxnOr404(req.params.id);
    assertOwnership(txn, req.user, ['SELLER']);
    if (txn.status !== 'SECURED' || txn.escrow_status !== 'LOCKED') {
      throw new AppError(409, 'INVALID_STATE', 'Giao dịch phải ở SECURED + LOCKED');
    }
    await db.transaction(async () => {
      await applyTransactionStatus(txn, { status: 'SHIPPING', escrowStatus: 'LOCKED' });
      await appendAuditLog(db, {
        transactionId: txn.id,
        actorId: req.user.id,
        action: 'SELLER_SHIPPED',
        oldStatus: 'SECURED',
        newStatus: 'SHIPPING',
        eventData: {},
      });
    })();
    await onOrderShipped(txn);
    res.json(serializeTxn(await loadTxnOr404(txn.id)));
  } catch (e) {
    next(e);
  }
});

// ---------- Người MUA xác nhận đã nhận được kiện hàng ----------
//
// Chủ thể của chuyển tiếp này là người mua, không phải người bán. Người bán chỉ có quyền
// báo đã gửi hàng; nếu để người bán tự đưa giao dịch sang "chờ xác nhận" thì người bán tự
// đẩy được giao dịch tới sát bước giải ngân chỉ dựa trên thông tin do chính mình cung cấp.
//
// Trạng thái WAIT_CONFIRM bắt đầu thời hạn kiểm tra hàng, nên nó phải khởi phát từ một sự
// kiện mà chỉ người mua quan sát được: kiện hàng đã tới tay.
//
// "Người mua" ở đây là buyer_id CỦA CHÍNH GIAO DỊCH NÀY (assertOwnership), không phải vai trò
// toàn cục: một người mua được duyệt quyền bán hàng trong lúc đơn đang SHIPPING đã mang role
// SELLER, và requireRole('BUYER') trước đây khiến họ không xác nhận nhận hàng được — tiền kẹt ở
// SHIPPING. Cùng lý do với secure / reauth / release (xem chú thích của assertOwnership).
router.post('/:id/wait-confirm', requireAuth, async (req, res, next) => {
  try {
    const txn = await loadTxnOr404(req.params.id);
    assertOwnership(txn, req.user, ['BUYER']);
    if (txn.status !== 'SHIPPING' || txn.escrow_status !== 'LOCKED') {
      throw new AppError(409, 'INVALID_STATE', 'Giao dịch phải ở SHIPPING + LOCKED');
    }
    await db.transaction(async () => {
      await applyTransactionStatus(txn, { status: 'WAIT_CONFIRM', escrowStatus: 'LOCKED' });
      await appendAuditLog(db, {
        transactionId: txn.id,
        actorId: req.user.id,
        action: 'BUYER_RECEIVED_PACKAGE',
        oldStatus: 'SHIPPING',
        newStatus: 'WAIT_CONFIRM',
        eventData: {},
      });
    })();
    await onOrderWaitConfirm(txn);
    res.json(serializeTxn(await loadTxnOr404(txn.id)));
  } catch (e) {
    next(e);
  }
});

// ---------- UC08: Xác thực lại bằng passkey trước khi giải ngân ----------
//
// Ràng buộc uỷ quyền với đúng MỘT giao dịch.
//
// Bản đầu lấy SHA-256 của nội dung giao dịch làm challenge. Cách đó SAI với mô hình
// WebAuthn vì hai lý do. Thứ nhất, challenge có nhiệm vụ bảo đảm tính MỚI của phản hồi
// nên phải là giá trị ngẫu nhiên từ nguồn ngẫu nhiên mật mã; nội dung giao dịch lại
// đoán được, và hai giao dịch cùng nội dung sẽ cho cùng một challenge, làm suy giảm khả năng
// chống phát lại. Thứ hai, chữ ký phủ lên một giá trị KHÔNG chứng minh người dùng đã
// nhìn thấy và hiểu giá trị đó; authenticator chỉ ký trên chuỗi byte nó nhận được.
//
// Cách đúng: tách hai vai trò.
//   - challenge: ngẫu nhiên, dùng một lần, có thời hạn  -> chống phát lại
//   - ngữ cảnh uỷ quyền: lưu ở SERVER cùng bản ghi challenge
// Sau khi chữ ký hợp lệ, server chỉ mở quyền cho đúng hành động đã lưu, và tiêu thụ
// challenge nguyên tử cùng nghiệp vụ giải ngân.
//
// Nội dung giao dịch vẫn được đối chiếu HAI LẦN độc lập (ở bước verify và ở bước
// release) để chặn kịch bản giao dịch bị sửa trong lúc chờ ký.
//
// Giới hạn phải nói rõ: WebAuthn thông thường không có giao diện hiển thị tin cậy, nên
// cơ chế này KHÔNG chứng minh được người dùng đã nhìn thấy đúng số tiền trên màn hình.

// Ngữ cảnh uỷ quyền: đúng những gì người dùng đang cho phép hệ thống làm.
//
// Thứ tự khoá trong object này là một phần của giao thức: JSON.stringify giữ nguyên thứ
// tự chèn, nên đổi thứ tự sẽ đổi giá trị băm. Đừng sắp xếp lại.
async function buildAuthorizationContext(txn) {
  const seller = await db.prepare('SELECT display_name FROM users WHERE id = ?').get(txn.seller_id);
  return {
    v: 2,
    action: 'RELEASE_ESCROW',
    transactionId: txn.id,
    listingId: txn.listing_id || null,
    itemName: txn.item_name,
    buyerId: txn.buyer_id,
    sellerId: txn.seller_id,
    sellerName: seller ? seller.display_name : '',
    currency: 'VND',
    amount: txn.amount,
  };
}

function contextDigest(context) {
  return crypto.createHash('sha256').update(JSON.stringify(context), 'utf8').digest();
}

async function userCredentials(userId) {
  return db.prepare('SELECT * FROM passkey_credentials WHERE user_id = ?').all(userId);
}

router.post('/:id/reauth/options', requireAuth, sensitiveLimiter, async (req, res, next) => {
  try {
    const txn = await loadTxnOr404(req.params.id);
    assertOwnership(txn, req.user, ['BUYER']);
    if (txn.status !== 'WAIT_CONFIRM' || txn.escrow_status !== 'LOCKED') {
      throw new AppError(409, 'INVALID_STATE', 'Giao dịch phải ở WAIT_CONFIRM + LOCKED');
    }

    const credentials = await userCredentials(req.user.id);
    if (credentials.length === 0) throw new AppError(400, 'NO_CREDENTIAL', 'Tài khoản chưa có Passkey');

    const context = await buildAuthorizationContext(txn);

    // KHÔNG truyền challenge: để thư viện tự sinh giá trị ngẫu nhiên bằng nguồn ngẫu
    // nhiên mật mã. Thao tác chạm tới tiền nên đòi mức xác minh người dùng (PIN hoặc
    // sinh trắc học) chứ không chấp nhận mức hiện diện đơn thuần.
    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      userVerification: 'required',
      allowCredentials: credentials.map((c) => ({
        id: c.credential_id,
        transports: JSON.parse(c.transports || '[]'),
      })),
    });

    const sessionId = uuid();
    const expiresAt = new Date(Date.now() + REAUTH_TTL_SECONDS * 1000).toISOString();
    await db.prepare(
      `INSERT INTO auth_challenges (id, user_id, transaction_id, challenge, purpose, context_data, expires_at)
       VALUES (?, ?, ?, ?, 'REAUTH', ?, ?)`
    ).run(sessionId, req.user.id, txn.id, options.challenge, JSON.stringify(context), expiresAt);

    // Trả ngữ cảnh về để giao diện hiển thị ĐÚNG thứ người dùng sắp uỷ quyền.
    res.json({ reauthSessionId: sessionId, options, context });
  } catch (e) {
    next(e);
  }
});

router.post('/:id/reauth/verify', requireAuth, sensitiveLimiter, async (req, res, next) => {
  try {
    const { reauthSessionId, response } = req.body || {};
    if (!reauthSessionId || !response) throw new AppError(400, 'VALIDATION_ERROR', 'Thiếu reauthSessionId hoặc response');

    const txn = await loadTxnOr404(req.params.id);
    assertOwnership(txn, req.user, ['BUYER']);

    const challengeRow = await db
      .prepare(`SELECT * FROM auth_challenges WHERE id = ? AND purpose = 'REAUTH' AND transaction_id = ? AND user_id = ?`)
      .get(reauthSessionId, txn.id, req.user.id);
    if (!challengeRow) throw new AppError(400, 'CHALLENGE_NOT_FOUND', 'Phiên re-auth không hợp lệ');
    if (challengeRow.used_at) throw new AppError(400, 'CHALLENGE_REPLAY', 'Challenge đã dùng');
    if (new Date(challengeRow.expires_at).getTime() < Date.now()) {
      throw new AppError(400, 'CHALLENGE_EXPIRED', 'Challenge đã hết hạn');
    }

    // Người dùng có thể ký bằng BẤT KỲ thiết bị nào của họ — chọn đúng cái đã ký.
    const credential = await db
      .prepare('SELECT * FROM passkey_credentials WHERE user_id = ? AND credential_id = ?')
      .get(req.user.id, response.id);
    if (!credential) throw new AppError(400, 'NO_CREDENTIAL', 'Passkey này không thuộc tài khoản của bạn');

    // Đối chiếu ngữ cảnh uỷ quyền lần 1: dựng lại nội dung giao dịch từ dữ liệu HIỆN TẠI
    // và so với bản đã lưu lúc phát challenge. Đơn bị sửa trong lúc chờ ký thì hai bản
    // lệch nhau và yêu cầu bị chặn ngay, trước khi cấp phiếu uỷ quyền.
    const currentContext = await buildAuthorizationContext(txn);
    if (challengeRow.context_data !== JSON.stringify(currentContext)) {
      throw new AppError(409, 'CONTEXT_MISMATCH', 'Nội dung giao dịch đã thay đổi kể từ lúc bắt đầu xác thực. Hãy thử lại.');
    }

    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challengeRow.challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      requireUserVerification: true,
      credential: {
        id: credential.credential_id,
        publicKey: credential.public_key,
        counter: 0, // counter là tín hiệu rủi ro, xem lib/credentialCounter.js
        transports: JSON.parse(credential.transports || '[]'),
      },
    });
    if (!verification.verified) throw new AppError(401, 'VERIFICATION_FAILED', 'Xác thực lại thất bại');

    const contextHash = contextDigest(currentContext).toString('hex');
    const counterCheck = assessCounter(credential, verification.authenticationInfo.newCounter);

    let issued;
    await db.transaction(async () => {
      // Tiêu thụ challenge NGUYÊN TỬ: hai request phát lại cùng challenge chạy song song (cùng
      // qua được bước kiểm used_at ở trên vì phải chờ xác minh WebAuthn) thì chỉ một request
      // đổi được used_at; request còn lại bị chặn và không được cấp phiếu uỷ quyền.
      const consumed = await db
        .prepare(`UPDATE auth_challenges SET used_at = ? WHERE id = ? AND used_at IS NULL`)
        .run(nowIso(), challengeRow.id);
      if (consumed.changes !== 1) throw new AppError(400, 'CHALLENGE_REPLAY', 'Challenge đã dùng');
      await db.prepare('UPDATE passkey_credentials SET counter = ?, last_used_at = ? WHERE id = ?').run(
        counterCheck.stored,
        nowIso(),
        credential.id
      );
      issued = await issueGrant({
        userId: req.user.id,
        sessionId: req.user.sessionId,
        transactionId: txn.id,
        action: ACTIONS.RELEASE,
        contextHash,
      });
    })();
    await reportCounterAnomaly(req, credential, counterCheck);

    res.json({ reauthGrant: issued.rawToken, expiresAt: issued.expiresAt, signedContext: currentContext });
  } catch (e) {
    next(e);
  }
});

// ---------- UC09: Người mua xác nhận đã nhận hàng và giải ngân ----------

router.post('/:id/release', requireAuth, async (req, res, next) => {
  try {
    const { requestId, reauthGrant } = req.body || {};
    if (!requestId || !reauthGrant) throw new AppError(400, 'VALIDATION_ERROR', 'Thiếu requestId hoặc reauthGrant');

    const txn = await loadTxnOr404(req.params.id);
    assertOwnership(txn, req.user, ['BUYER']);

    const fingerprint = fingerprintRequest({
      actorId: req.user.id,
      action: 'ESCROW_RELEASE',
      transactionId: txn.id,
      amount: txn.amount,
    });
    const escrowLegKey = `release:${requestId}:escrow`;
    if (await checkIdempotency(escrowLegKey, fingerprint)) {
      return res.json(serializeTxn(await loadTxnOr404(txn.id)));
    }

    if (txn.status !== 'WAIT_CONFIRM' || txn.escrow_status !== 'LOCKED') {
      throw new AppError(409, 'INVALID_STATE', 'Giao dịch phải ở WAIT_CONFIRM + LOCKED');
    }

    // Phiếu phải đúng user, đúng giao dịch, đúng hành động, còn hạn và chưa dùng.
    const grant = await requireGrant({
      userId: req.user.id,
      sessionId: req.user.sessionId,
      transactionId: txn.id,
      action: ACTIONS.RELEASE,
      rawToken: reauthGrant,
      message: 'Phiếu uỷ quyền không hợp lệ, hết hạn, hoặc thuộc giao dịch khác',
    });

    // Đối chiếu ngữ cảnh lần HAI, độc lập với lần ở bước verify. Phiếu chỉ chứng minh
    // "người này đã uỷ quyền MỘT nội dung nào đó". Ở đây kiểm nội dung ấy có đúng là nội
    // dung đang sắp thực thi không — chặn kịch bản giao dịch bị sửa số tiền trong khoảng
    // thời gian giữa lúc ký và lúc lệnh giải ngân thực sự chạy.
    const currentContextHash = contextDigest(await buildAuthorizationContext(txn)).toString('hex');
    if (grant.context_hash && grant.context_hash !== currentContextHash) {
      throw new AppError(
        409,
        'CONTEXT_MISMATCH',
        'Nội dung giao dịch đã thay đổi sau khi bạn xác thực. Vì an toàn, hãy xác thực lại.'
      );
    }

    // Một dòng tiền duy nhất: toàn bộ số tiền đang bị khóa chuyển sang ví người bán.
    const escrowWallet = await getEscrowWallet();
    const sellerWallet = await getUserWallet(txn.seller_id);

    await db.transaction(async () => {
      const updated = await applyOrderedWalletUpdates([
        { wallet: escrowWallet, availableDelta: 0, lockedDelta: -txn.amount },
        { wallet: sellerWallet, availableDelta: txn.amount, lockedDelta: 0 },
      ], 'release');

      await insertWalletEntry({
        walletId: escrowWallet.id,
        transactionId: txn.id,
        requestId,
        entryType: 'ESCROW_RELEASE_DEBIT',
        availableDelta: 0,
        lockedDelta: -txn.amount,
        walletAfter: updated.get(escrowWallet.id),
        idempotencyKey: escrowLegKey,
        requestFingerprint: fingerprint,
        description: 'Escrow giải ngân cho người bán',
      });
      await insertWalletEntry({
        walletId: sellerWallet.id,
        transactionId: txn.id,
        requestId,
        entryType: 'ESCROW_RELEASE_CREDIT',
        availableDelta: txn.amount,
        lockedDelta: 0,
        walletAfter: updated.get(sellerWallet.id),
        idempotencyKey: `release:${requestId}:seller`,
        requestFingerprint: fingerprint,
        description: 'Nhận tiền bán hàng',
      });

      await applyTransactionStatus(txn, { status: 'COMPLETED', escrowStatus: 'RELEASED' });
      // Đã giải ngân thì sản phẩm đã bán hẳn: LOCKED -> SOLD trong cùng giao dịch với dòng tiền.
      await settleListing(txn, 'RELEASE');
      await markGrantUsed(grant.id);

      await appendAuditLog(db, {
        transactionId: txn.id,
        actorId: req.user.id,
        action: 'ESCROW_RELEASED',
        oldStatus: 'WAIT_CONFIRM',
        newStatus: 'COMPLETED',
        eventData: { amount: txn.amount, payoutToSeller: txn.amount, requestId },
      });
    })();
    await onOrderCompleted(txn);

    res.json(serializeTxn(await loadTxnOr404(txn.id)));
  } catch (e) {
    next(e);
  }
});

// ---------- UC10: Mở tranh chấp ----------
// Cả hai bên đều được mở. Người mua mở khi hàng không được giao hoặc giao không đúng mô
// tả. Người bán mở khi người mua đòi hoàn tiền không có căn cứ hoặc phủ nhận đã nhận
// hàng. Nội dung phán quyết thuộc chính sách nghiệp vụ, không phải trọng tâm ở đây.

router.post('/:id/dispute', requireAuth, requireRole('BUYER', 'SELLER'), sensitiveLimiter, async (req, res, next) => {
  try {
    const { reason } = req.body || {};
    if (!reason || !String(reason).trim()) throw new AppError(400, 'VALIDATION_ERROR', 'Thiếu lý do tranh chấp');

    const txn = await loadTxnOr404(req.params.id);
    assertOwnership(txn, req.user, ['BUYER', 'SELLER']);
    if (txn.status !== 'WAIT_CONFIRM' || txn.escrow_status !== 'LOCKED') {
      throw new AppError(409, 'INVALID_STATE', 'Chỉ mở tranh chấp khi WAIT_CONFIRM + LOCKED');
    }

    const disputeId = uuid();
    const openedBy = txn.buyer_id === req.user.id ? 'BUYER' : 'SELLER';
    const trimmed = String(reason).trim().slice(0, 1000);

    await db.transaction(async () => {
      await db.prepare(
        `INSERT INTO disputes (id, transaction_id, created_by, reason, status, created_at)
         VALUES (?, ?, ?, ?, 'OPEN', ?)`
      ).run(disputeId, txn.id, req.user.id, trimmed, nowIso());

      await applyTransactionStatus(txn, { status: 'DISPUTED', escrowStatus: 'FROZEN' });

      await appendAuditLog(db, {
        transactionId: txn.id,
        actorId: req.user.id,
        action: 'DISPUTE_OPENED',
        oldStatus: 'WAIT_CONFIRM',
        newStatus: 'DISPUTED',
        eventData: { reason: trimmed, openedBy },
      });
    })();
    await onDisputeOpened(txn, req.user.id);

    res.status(201).json({
      dispute: { id: disputeId, status: 'OPEN', openedBy },
      transaction: serializeTxn(await loadTxnOr404(txn.id)),
    });
  } catch (e) {
    next(e);
  }
});

// ---------- UC12: Kiểm chứng nhật ký cho chính người trong cuộc ----------
// /api/admin/... vẫn giữ nguyên cho Admin; hai route dưới đây cho phép người mua và
// người bán tự kiểm chứng nhật ký giao dịch của mình mà không cần quyền Admin.

router.get('/:id/logs', requireAuth, async (req, res, next) => {
  try {
    const txn = await loadTxnOr404(req.params.id);
    assertOwnership(txn, req.user, ['BUYER', 'SELLER', 'ADMIN']);
    const logs = await db.prepare('SELECT * FROM audit_logs WHERE transaction_id = ? ORDER BY id ASC').all(txn.id);
    res.json({
      logs: logs.map((l) => ({
        id: l.id,
        actorId: l.actor_id,
        action: l.action,
        oldStatus: l.old_status,
        newStatus: l.new_status,
        eventData: JSON.parse(l.event_data || '{}'),
        previousHash: l.previous_hash,
        currentHash: l.current_hash,
        createdAt: l.created_at,
      })),
    });
  } catch (e) {
    next(e);
  }
});

router.get('/:id/logs/verify', requireAuth, async (req, res, next) => {
  try {
    const txn = await loadTxnOr404(req.params.id);
    assertOwnership(txn, req.user, ['BUYER', 'SELLER', 'ADMIN']);
    res.json(await verifyChain(db, txn.id));
  } catch (e) {
    next(e);
  }
});

module.exports = router;
