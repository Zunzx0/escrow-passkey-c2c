const express = require('express');
const crypto = require('crypto');
const { generateAuthenticationOptions, verifyAuthenticationResponse } = require('@simplewebauthn/server');

const { db, uuid, nowIso } = require('../db');
const { requireAuth } = require('../lib/auth');
const { appendAuditLog, verifyChain } = require('../lib/hash');
const { AppError } = require('../lib/errors');
const { serializeSellerRequest } = require('./users');
const {
  ACTIONS,
  DECISIONS,
  REAUTH_TTL_SECONDS,
  issueGrant,
  requireGrant,
  markGrantUsed,
  assertContextUnchanged,
} = require('../lib/reauth');
const { checkInvariants } = require('../lib/invariants');
const { rateLimit } = require('../lib/rateLimit');
const { logSecurityEvent, listSecurityEvents, EVENTS } = require('../lib/securityEvents');
const { assessCounter, reportCounterAnomaly } = require('../lib/credentialCounter');
const { RP_ID, ORIGIN } = require('../lib/webauthnConfig');
const { onDisputeResolved } = require('../lib/notifications');
const { isProvenAdmin, UNVERIFIED_ADMIN_ROLE } = require('../lib/adminProvenance');
const { settleListing } = require('../lib/listingLifecycle');

// Điểm cuối quản trị nhạy cảm: phân xử làm tiền rời khỏi ký quỹ, và mỗi lần xin
// challenge đều ghi một bản ghi vào cơ sở dữ liệu.
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

// ROLE không phải chứng cứ duy nhất về nguồn gốc tài khoản quản trị. Ba điều kiện độc lập:
//   1. users.role = 'ADMIN';
//   2. có dấu nguồn gốc trong admin_provenance (lib/adminProvenance.js) — chỉ bootstrap sinh ra,
//      nên tài khoản bị sửa role mà CHƯA có ví (lọt qua điều kiện 3) vẫn bị chặn ở đây;
//   3. không có ví USER — Buyer/Seller luôn có ví từ lúc kích hoạt (PR #13).
// lib/auth.js đã đổi role của ADMIN thiếu nguồn gốc thành role nội bộ; điều kiện 2 được kiểm lại
// ở đây để router quản trị tự đứng vững, không phụ thuộc hoàn toàn vào lớp xác thực.
// Người dùng thường (BUYER/SELLER) vẫn nhận 403 FORBIDDEN như trước; ADMIN_IDENTITY_INVALID chỉ dành
// cho tài khoản mang role ADMIN mà không chứng minh được nguồn gốc.
async function requireAdminIdentity(req, res, next) {
  try {
    const invalid = () => new AppError(403, 'ADMIN_IDENTITY_INVALID', 'Tài khoản này không có nguồn gốc quản trị hợp lệ.');
    if (req.user.role === UNVERIFIED_ADMIN_ROLE) throw invalid();
    if (req.user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'FORBIDDEN', message: 'Không đủ quyền thực hiện thao tác này' });
    }
    if (!(await isProvenAdmin(db, req.user.id))) throw invalid();
    const wallet = await db.prepare("SELECT 1 FROM wallets WHERE user_id = ? AND wallet_type = 'USER' LIMIT 1").get(req.user.id);
    if (wallet) {
      throw new AppError(403, 'ADMIN_IDENTITY_INVALID', 'Tài khoản có ví người dùng không được thực hiện chức năng quản trị.');
    }
    next();
  } catch (e) {
    next(e);
  }
}

router.use(requireAuth, requireAdminIdentity);

function serializeTxn(t) {
  if (!t) return null;
  return {
    id: t.id,
    buyerId: t.buyer_id,
    sellerId: t.seller_id,
    itemName: t.item_name,
    amount: t.amount,
    status: t.status,
    escrowStatus: t.escrow_status,
    version: t.version,
    listingId: t.listing_id || null,
    listingImage: t.listing_image || null,
    buyerName: t.buyer_name || null,
    sellerName: t.seller_name || null,
  };
}

// Giao dịch kèm tên hai bên + ảnh sản phẩm, để màn hình xử lý tranh chấp của Admin
// hiển thị đủ ngữ cảnh mà không phải gọi thêm API.
const TXN_DETAIL = `
  SELECT t.*, b.display_name AS buyer_name, s.display_name AS seller_name, l.image AS listing_image
  FROM transactions t
  JOIN users b ON b.id = t.buyer_id
  JOIN users s ON s.id = t.seller_id
  LEFT JOIN listings l ON l.id = t.listing_id
`;

async function loadTxnDetail(id) {
  return db.prepare(`${TXN_DETAIL} WHERE t.id = ?`).get(id);
}

function serializeDispute(d) {
  return {
    id: d.id,
    transactionId: d.transaction_id,
    createdBy: d.created_by,
    createdByName: d.created_by_name || null,
    openedBy: d.created_by === d.buyer_id ? 'BUYER' : 'SELLER',
    reason: d.reason,
    status: d.status,
    adminId: d.admin_id,
    adminDecision: d.admin_decision,
    resolvedAt: d.resolved_at,
    createdAt: d.created_at,
  };
}

const DISPUTE_SELECT = `
  SELECT d.*, u.display_name AS created_by_name, t.buyer_id AS buyer_id
  FROM disputes d
  JOIN users u ON u.id = d.created_by
  JOIN transactions t ON t.id = d.transaction_id
`;

router.get('/disputes', async (req, res) => {
  const { status } = req.query;
  const rows = status
    ? await db.prepare(`${DISPUTE_SELECT} WHERE d.status = ? ORDER BY d.created_at DESC`).all(status)
    : await db.prepare(`${DISPUTE_SELECT} ORDER BY d.created_at DESC`).all();
  const disputes = [];
  for (const d of rows) {
    disputes.push({
      ...serializeDispute(d),
      transaction: serializeTxn(await loadTxnDetail(d.transaction_id)),
    });
  }
  res.json({ disputes });
});

router.get('/disputes/:id', async (req, res, next) => {
  try {
    const dispute = await db.prepare(`${DISPUTE_SELECT} WHERE d.id = ?`).get(req.params.id);
    if (!dispute) throw new AppError(404, 'DISPUTE_NOT_FOUND');
    res.json({ dispute: serializeDispute(dispute), transaction: serializeTxn(await loadTxnDetail(dispute.transaction_id)) });
  } catch (e) {
    next(e);
  }
});

// ---------------------------------------------------------------------------
// Xác thực lại trước khi phân xử
//
// Quyết định phân xử làm tiền rời khỏi ký quỹ, nên nó phải kèm một phiếu uỷ quyền sinh từ
// một lần xác thực lại bằng Passkey của CHÍNH quản trị viên đang ra quyết định. Nguyên tắc
// này không phân biệt chủ thể là người mua hay quản trị viên.
//
// Ngữ cảnh uỷ quyền của quản trị viên mang thêm hồ sơ tranh chấp và QUYẾT ĐỊNH cụ thể. Nếu
// phiếu chỉ ràng buộc tới hồ sơ mà bỏ trống quyết định thì quản trị viên có thể xác thực
// trong lúc màn hình hiển thị "hoàn tiền cho người mua", còn yêu cầu gửi lên lại mang "giải
// ngân cho người bán", và máy chủ vẫn chấp nhận vì phiếu hợp lệ.
//
// Tập điều kiện của lệnh phân xử là một tập RIÊNG, không phải cách phát biểu tổng quát hơn
// của năm điều kiện ở lệnh giải ngân của người mua: lệnh của người mua đòi cặp trạng thái
// WAIT_CONFIRM + LOCKED, còn lệnh phân xử đòi DISPUTED + FROZEN. Hai điều kiện loại trừ
// lẫn nhau nên không gộp được.
// ---------------------------------------------------------------------------

// Thứ tự khoá trong object này là một phần của giao thức: JSON.stringify giữ nguyên thứ tự
// chèn, nên đổi thứ tự sẽ đổi giá trị băm. Đừng sắp xếp lại.
function buildAdjudicationContext(dispute, txn, decision, adminId) {
  return {
    v: 1,
    action: ACTIONS.ADJUDICATE,
    adminId,
    disputeId: dispute.id,
    transactionId: txn.id,
    buyerId: txn.buyer_id,
    sellerId: txn.seller_id,
    currency: 'VND',
    amount: txn.amount,
    decision,
  };
}

function contextDigest(context) {
  return crypto.createHash('sha256').update(JSON.stringify(context), 'utf8').digest('hex');
}

function parseDecision(raw) {
  const decision = String(raw || '').toUpperCase();
  if (!DECISIONS[decision]) {
    throw new AppError(400, 'VALIDATION_ERROR', 'decision phải là REFUND hoặc RELEASE');
  }
  return decision;
}

// Vai trò ADMIN có thể bị cấp nhầm hoặc bị leo thang. Bên mua/bán không được tự phân xử
// giao dịch của chính mình, kể cả khi tài khoản của họ đã mang vai trò ADMIN.
function assertIndependentAdjudicator(txn, actorId) {
  if (txn.buyer_id === actorId || txn.seller_id === actorId) {
    throw new AppError(403, 'ADJUDICATOR_CONFLICT', 'Một bên của giao dịch không được tự phân xử tranh chấp.');
  }
}

/** Nạp hồ sơ tranh chấp cùng giao dịch, và kiểm cặp trạng thái bắt buộc của luồng phân xử. */
async function loadOpenDisputeForAdjudication(disputeId, actorId) {
  const dispute = await db.prepare(`${DISPUTE_SELECT} WHERE d.id = ?`).get(disputeId);
  if (!dispute) throw new AppError(404, 'DISPUTE_NOT_FOUND', 'Không tìm thấy hồ sơ tranh chấp');
  if (dispute.status !== 'OPEN') throw new AppError(409, 'DISPUTE_NOT_OPEN', 'Hồ sơ tranh chấp phải đang mở');

  const txn = await db.prepare('SELECT * FROM transactions WHERE id = ?').get(dispute.transaction_id);
  if (!txn) throw new AppError(404, 'TRANSACTION_NOT_FOUND', 'Không tìm thấy giao dịch');
  assertIndependentAdjudicator(txn, actorId);
  if (txn.status !== 'DISPUTED' || txn.escrow_status !== 'FROZEN') {
    throw new AppError(409, 'INVALID_STATE', 'Giao dịch phải ở DISPUTED + FROZEN');
  }
  return { dispute, txn };
}

router.post('/disputes/:id/reauth/options', sensitiveLimiter, async (req, res, next) => {
  try {
    const decision = parseDecision((req.body || {}).decision);
    const { dispute, txn } = await loadOpenDisputeForAdjudication(req.params.id, req.user.id);

    const credentials = await db.prepare('SELECT * FROM passkey_credentials WHERE user_id = ?').all(req.user.id);
    if (credentials.length === 0) throw new AppError(400, 'NO_CREDENTIAL', 'Tài khoản quản trị chưa có Passkey');

    const context = buildAdjudicationContext(dispute, txn, decision, req.user.id);

    // Không truyền challenge: thư viện tự sinh giá trị ngẫu nhiên bằng nguồn ngẫu nhiên mật
    // mã. Thao tác làm tiền rời khỏi ký quỹ đòi mức xác minh người dùng bắt buộc.
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

    // Trả ngữ cảnh về để giao diện hiển thị ĐÚNG thứ quản trị viên sắp uỷ quyền.
    res.json({ reauthSessionId: sessionId, options, context });
  } catch (e) {
    next(e);
  }
});

router.post('/disputes/:id/reauth/verify', sensitiveLimiter, async (req, res, next) => {
  try {
    const { reauthSessionId, response } = req.body || {};
    if (!reauthSessionId || !response) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Thiếu reauthSessionId hoặc response');
    }

    const { dispute, txn } = await loadOpenDisputeForAdjudication(req.params.id, req.user.id);

    const challengeRow = await db
      .prepare(`SELECT * FROM auth_challenges WHERE id = ? AND purpose = 'REAUTH' AND transaction_id = ? AND user_id = ?`)
      .get(reauthSessionId, txn.id, req.user.id);
    if (!challengeRow) throw new AppError(400, 'CHALLENGE_NOT_FOUND', 'Phiên xác thực lại không hợp lệ');
    if (challengeRow.used_at) throw new AppError(400, 'CHALLENGE_REPLAY', 'Challenge đã dùng');
    if (new Date(challengeRow.expires_at).getTime() < Date.now()) {
      throw new AppError(400, 'CHALLENGE_EXPIRED', 'Challenge đã hết hạn');
    }

    // Quyết định đọc lại từ bản ghi challenge phía máy chủ, KHÔNG nhận lại từ người gọi.
    const savedContext = JSON.parse(challengeRow.context_data || '{}');
    const decision = savedContext.decision;
    if (!DECISIONS[decision] || savedContext.action !== ACTIONS.ADJUDICATE) {
      throw new AppError(400, 'CHALLENGE_PURPOSE_MISMATCH', 'Challenge không dành cho thao tác phân xử');
    }

    // Đối chiếu ngữ cảnh lần MỘT: dựng lại từ dữ liệu hiện tại rồi so với bản đã lưu lúc
    // phát challenge. Hồ sơ hay giao dịch bị sửa trong lúc chờ ký thì hai bản lệch nhau và
    // yêu cầu bị chặn trước khi phiếu được cấp.
    const currentContext = buildAdjudicationContext(dispute, txn, decision, req.user.id);
    if (challengeRow.context_data !== JSON.stringify(currentContext)) {
      throw new AppError(409, 'CONTEXT_MISMATCH', 'Nội dung hồ sơ đã thay đổi kể từ lúc bắt đầu xác thực.');
    }

    const credential = await db
      .prepare('SELECT * FROM passkey_credentials WHERE user_id = ? AND credential_id = ?')
      .get(req.user.id, response.id);
    if (!credential) throw new AppError(400, 'NO_CREDENTIAL', 'Passkey này không thuộc tài khoản của bạn');

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
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
    } catch (e) {
      throw new AppError(400, 'VERIFICATION_FAILED', e.message);
    }
    if (!verification.verified) throw new AppError(401, 'VERIFICATION_FAILED', 'Xác thực lại thất bại');

    const counterCheck = assessCounter(credential, verification.authenticationInfo.newCounter);
    let issued;
    await db.transaction(async () => {
      // Tiêu thụ challenge NGUYÊN TỬ: hai request phát lại cùng challenge chạy song song thì chỉ
      // một request đổi được used_at. Phép kiểm used_at ở trên nằm TRƯỚC bước await xác minh
      // WebAuthn nên không đủ để chặn phát lại đồng thời.
      const consumed = await db
        .prepare('UPDATE auth_challenges SET used_at = ? WHERE id = ? AND used_at IS NULL')
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
        disputeId: dispute.id,
        action: ACTIONS.ADJUDICATE,
        decision,
        contextHash: contextDigest(currentContext),
      });
    })();
    await reportCounterAnomaly(req, credential, counterCheck);

    res.json({
      reauthGrant: issued.rawToken,
      expiresAt: issued.expiresAt,
      decision,
      signedContext: currentContext,
    });
  } catch (e) {
    next(e);
  }
});

/**
 * Điều kiện chung của một lệnh phân xử, kiểm ở MÁY CHỦ trước khi chạm vào tiền.
 *
 * Sáu điều kiện: (1) người gọi có quyền quản trị — đã do router.use ở đầu tệp bảo đảm;
 * (2) cặp trạng thái là DISPUTED + FROZEN; (3) hồ sơ tranh chấp đang mở; (4) phiếu còn hạn
 * và chưa tiêu thụ; (5) phiếu đúng quản trị viên, đúng giao dịch, đúng hồ sơ và ĐÚNG QUYẾT
 * ĐỊNH; (6) ngữ cảnh hiện tại khớp ngữ cảnh đã uỷ quyền.
 */
async function authorizeAdjudication(req, decision) {
  const { dispute, txn } = await loadOpenDisputeForAdjudication(req.params.id, req.user.id);

  const grant = await requireGrant({
    userId: req.user.id,
    sessionId: req.user.sessionId,
    transactionId: txn.id,
    disputeId: dispute.id,
    action: ACTIONS.ADJUDICATE,
    decision,
    rawToken: (req.body || {}).reauthGrant,
    message:
      'Lệnh phân xử cần một phiếu uỷ quyền còn hiệu lực, cấp cho đúng hồ sơ tranh chấp này và đúng quyết định này.',
  });

  // Đối chiếu ngữ cảnh lần HAI, độc lập với lần ở bước verify.
  assertContextUnchanged(grant, contextDigest(buildAdjudicationContext(dispute, txn, decision, req.user.id)));

  return { dispute, txn, grant };
}

router.post('/disputes/:id/refund', sensitiveLimiter, async (req, res, next) => {
  try {
    const { requestId } = req.body || {};
    if (!requestId) throw new AppError(400, 'VALIDATION_ERROR', 'Thiếu requestId');

    const dispute = await db.prepare(`${DISPUTE_SELECT} WHERE d.id = ?`).get(req.params.id);
    if (!dispute) throw new AppError(404, 'DISPUTE_NOT_FOUND');
    const parties = await db.prepare('SELECT buyer_id, seller_id FROM transactions WHERE id = ?').get(dispute.transaction_id);
    if (!parties) throw new AppError(404, 'TRANSACTION_NOT_FOUND');
    assertIndependentAdjudicator(parties, req.user.id);
    if (dispute.status !== 'OPEN') throw new AppError(409, 'DISPUTE_NOT_OPEN', 'Dispute phải OPEN');

    const fingerprint = fingerprintRequest({
      actorId: req.user.id,
      action: 'ADMIN_REFUND',
      transactionId: dispute.transaction_id,
      amount: null,
    });
    const escrowLegKey = `refund:${requestId}:escrow`;
    if (await checkIdempotency(escrowLegKey, fingerprint)) {
      return res.json({ dispute: serializeDispute(dispute), transaction: serializeTxn(await loadTxnDetail(dispute.transaction_id)) });
    }

    // Sáu điều kiện của lệnh phân xử, gồm cả phiếu uỷ quyền ràng buộc đúng quyết định REFUND.
    const { txn, grant } = await authorizeAdjudication(req, DECISIONS.REFUND);

    const runTxn = db.transaction(async () => {
      // Tiêu thụ hồ sơ tranh chấp NGUYÊN TỬ, là câu lệnh ĐẦU TIÊN của giao dịch: hai lệnh phân
      // xử đua nhau cho cùng một hồ sơ (dù cùng quyết định hay khác quyết định, dù đã qua được
      // bước kiểm `dispute.status !== 'OPEN'` ở ngoài vì đọc trước khi bên thắng commit) thì chỉ
      // một request đổi được status. Trước đây hồ sơ chỉ được bảo vệ GIÁN TIẾP qua version check
      // của applyTransactionStatus (hoặc tình cờ qua CHECK constraint của ví) — đúng nhưng mong
      // manh: bên thua vẫn kịp sửa ví trước khi bị rollback, và lỗi trả về là CONSTRAINT_VIOLATION
      // mơ hồ thay vì một lý do rõ ràng. Chốt chặn riêng ở đây làm bên thua dừng lại NGAY, trước
      // khi chạm tới ví.
      const claimed = await db
        .prepare(`UPDATE disputes SET status = 'RESOLVED_REFUND', admin_id = ?, admin_decision = 'REFUND', resolved_at = ?
                   WHERE id = ? AND status = 'OPEN'`)
        .run(req.user.id, nowIso(), dispute.id);
      if (claimed.changes !== 1) {
        throw new AppError(409, 'DISPUTE_NOT_OPEN', 'Hồ sơ tranh chấp đã được xử lý ở nơi khác');
      }

      // Đọc ví BÊN TRONG giao dịch: ví ký quỹ dùng chung cho mọi đơn, đọc ở ngoài thì một thao
      // tác khác chen vào giữa lúc đọc và lúc ghi sẽ làm version cũ, gây xung đột giả.
      const escrowWallet = await getEscrowWallet();
      const buyerWallet = await getUserWallet(txn.buyer_id);
      const updated = await applyOrderedWalletUpdates([
        { wallet: escrowWallet, availableDelta: 0, lockedDelta: -txn.amount },
        { wallet: buyerWallet, availableDelta: txn.amount, lockedDelta: 0 },
      ], 'admin-refund');
      await insertWalletEntry({
        walletId: escrowWallet.id,
        transactionId: txn.id,
        requestId,
        entryType: 'ESCROW_REFUND_DEBIT',
        availableDelta: 0,
        lockedDelta: -txn.amount,
        walletAfter: updated.get(escrowWallet.id),
        idempotencyKey: escrowLegKey,
        requestFingerprint: fingerprint,
        description: 'Admin hoàn tiền từ Escrow',
      });
      await insertWalletEntry({
        walletId: buyerWallet.id,
        transactionId: txn.id,
        requestId,
        entryType: 'ESCROW_REFUND_CREDIT',
        availableDelta: txn.amount,
        lockedDelta: 0,
        walletAfter: updated.get(buyerWallet.id),
        idempotencyKey: `refund:${requestId}:buyer`,
        requestFingerprint: fingerprint,
        description: 'Người mua nhận hoàn tiền',
      });

      await applyTransactionStatus(txn, { status: 'REFUNDED', escrowStatus: 'REFUNDED' });

      // Tiền đã về người mua thì sản phẩm mở bán lại — cùng giao dịch, nên rollback ở bất kỳ
      // bước nào phía sau cũng đưa tin đăng về LOCKED cùng với tiền.
      await settleListing(txn, 'REFUND');

      // Tiêu thụ phiếu trong CÙNG giao dịch cơ sở dữ liệu thực hiện việc chuyển tiền, nên
      // không có khoảnh khắc nào phiếu vừa còn hiệu lực vừa đã được dùng.
      await markGrantUsed(grant.id);

      await appendAuditLog(db, {
        transactionId: txn.id,
        actorId: req.user.id,
        action: 'ADMIN_REFUND',
        oldStatus: 'DISPUTED',
        newStatus: 'REFUNDED',
        eventData: { amount: txn.amount, requestId, disputeId: dispute.id, decision: 'REFUND' },
      });
    });
    await runTxn();
    await onDisputeResolved(txn, 'REFUND');

    await logSecurityEvent(req, {
      type: EVENTS.ADMIN_ADJUDICATION, outcome: 'ALLOWED', statusCode: 200,
      detail: { decision: 'REFUND', transactionId: txn.id, disputeId: dispute.id },
    });

    const updatedDispute = await db.prepare(`${DISPUTE_SELECT} WHERE d.id = ?`).get(dispute.id);
    res.json({ dispute: serializeDispute(updatedDispute), transaction: serializeTxn(await loadTxnDetail(txn.id)) });
  } catch (e) {
    next(e);
  }
});

router.post('/disputes/:id/release', sensitiveLimiter, async (req, res, next) => {
  try {
    const { requestId } = req.body || {};
    if (!requestId) throw new AppError(400, 'VALIDATION_ERROR', 'Thiếu requestId');

    const dispute = await db.prepare(`${DISPUTE_SELECT} WHERE d.id = ?`).get(req.params.id);
    if (!dispute) throw new AppError(404, 'DISPUTE_NOT_FOUND');
    const parties = await db.prepare('SELECT buyer_id, seller_id FROM transactions WHERE id = ?').get(dispute.transaction_id);
    if (!parties) throw new AppError(404, 'TRANSACTION_NOT_FOUND');
    assertIndependentAdjudicator(parties, req.user.id);
    if (dispute.status !== 'OPEN') throw new AppError(409, 'DISPUTE_NOT_OPEN', 'Dispute phải OPEN');

    const fingerprint = fingerprintRequest({
      actorId: req.user.id,
      action: 'ADMIN_RELEASE',
      transactionId: dispute.transaction_id,
      amount: null,
    });
    const escrowLegKey = `release:${requestId}:escrow`;
    if (await checkIdempotency(escrowLegKey, fingerprint)) {
      return res.json({ dispute: serializeDispute(dispute), transaction: serializeTxn(await loadTxnDetail(dispute.transaction_id)) });
    }

    // Sáu điều kiện của lệnh phân xử, gồm cả phiếu uỷ quyền ràng buộc đúng quyết định RELEASE.
    // Một phiếu cấp cho hướng hoàn tiền KHÔNG lọt qua đây, vì decision nằm trong mệnh đề WHERE
    // của phép tra phiếu.
    const { txn, grant } = await authorizeAdjudication(req, DECISIONS.RELEASE);

    const runTxn = db.transaction(async () => {
      // Tiêu thụ hồ sơ tranh chấp NGUYÊN TỬ — xem chú thích tương ứng ở /refund phía trên.
      const claimed = await db
        .prepare(`UPDATE disputes SET status = 'RESOLVED_RELEASE', admin_id = ?, admin_decision = 'RELEASE', resolved_at = ?
                   WHERE id = ? AND status = 'OPEN'`)
        .run(req.user.id, nowIso(), dispute.id);
      if (claimed.changes !== 1) {
        throw new AppError(409, 'DISPUTE_NOT_OPEN', 'Hồ sơ tranh chấp đã được xử lý ở nơi khác');
      }

      // Đọc ví BÊN TRONG giao dịch, cùng lý do như ở lệnh hoàn tiền.
      const escrowWallet = await getEscrowWallet();
      const sellerWallet = await getUserWallet(txn.seller_id);
      const updated = await applyOrderedWalletUpdates([
        { wallet: escrowWallet, availableDelta: 0, lockedDelta: -txn.amount },
        { wallet: sellerWallet, availableDelta: txn.amount, lockedDelta: 0 },
      ], 'admin-release');
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
        description: 'Admin giải ngân từ Escrow',
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
        description: 'Người bán nhận giải ngân do Admin quyết định',
      });

      await applyTransactionStatus(txn, { status: 'RELEASED', escrowStatus: 'RELEASED' });
      await settleListing(txn, 'RELEASE');

      await markGrantUsed(grant.id);

      await appendAuditLog(db, {
        transactionId: txn.id,
        actorId: req.user.id,
        action: 'ADMIN_RELEASE',
        oldStatus: 'DISPUTED',
        newStatus: 'RELEASED',
        eventData: { amount: txn.amount, requestId, disputeId: dispute.id, decision: 'RELEASE' },
      });
    });
    await runTxn();
    await onDisputeResolved(txn, 'RELEASE');

    await logSecurityEvent(req, {
      type: EVENTS.ADMIN_ADJUDICATION, outcome: 'ALLOWED', statusCode: 200,
      detail: { decision: 'RELEASE', transactionId: txn.id, disputeId: dispute.id },
    });

    const updatedDispute = await db.prepare(`${DISPUTE_SELECT} WHERE d.id = ?`).get(dispute.id);
    res.json({ dispute: serializeDispute(updatedDispute), transaction: serializeTxn(await loadTxnDetail(txn.id)) });
  } catch (e) {
    next(e);
  }
});

// ---------- Yêu cầu cấp quyền bán hàng ----------
//
// Đây là con đường DUY NHẤT để một tài khoản có được năng lực bán. Hệ thống không có
// cơ chế cấp quyền nào khác đi qua đường mạng: luồng đăng ký luôn tạo ra người mua, còn
// quyền quản trị chỉ được cấp bằng script vận hành `npm run seed:admin` chạy trên máy chủ.
//
// Duyệt = NÂNG CẤP tài khoản tại chỗ: users.role BUYER -> SELLER. Không tạo tài khoản mới,
// nên ví, passkey và mọi giao dịch người đó từng mua đều còn nguyên. Vì lib/auth.js đọc lại
// role từ DB ở mỗi request, quyền mới có hiệu lực ngay — không phải chờ JWT cũ hết hạn.

const SELLER_REQUEST_SELECT = `
  SELECT sr.*, u.display_name AS user_name, u.username AS user_username,
         rv.display_name AS reviewed_by_name
  FROM seller_requests sr
  JOIN users u ON u.id = sr.user_id
  LEFT JOIN users rv ON rv.id = sr.reviewed_by
`;

router.get('/seller-requests', async (req, res) => {
  const rows = await db
    .prepare(
      `${SELLER_REQUEST_SELECT}
       ORDER BY CASE sr.status WHEN 'PENDING' THEN 0 ELSE 1 END, sr.created_at DESC
       LIMIT 200`
    )
    .all();
  res.json({
    requests: rows.map(serializeSellerRequest),
    pendingCount: rows.filter((r) => r.status === 'PENDING').length,
  });
});

async function reviewSellerRequest(req, decision) {
  const row = await db.prepare('SELECT * FROM seller_requests WHERE id = ?').get(req.params.id);
  if (!row) throw new AppError(404, 'REQUEST_NOT_FOUND', 'Không tìm thấy yêu cầu');
  if (row.status !== 'PENDING') {
    throw new AppError(409, 'REQUEST_ALREADY_REVIEWED', 'Yêu cầu này đã được xử lý trước đó');
  }

  const note = String((req.body && req.body.note) || '').trim().slice(0, 500) || null;
  if (decision === 'REJECTED' && !note) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Vui lòng nêu lý do từ chối để người gửi biết cần sửa gì');
  }

  const now = nowIso();
  await db.transaction(async () => {
    // Điều kiện đặt hết trong WHERE: hai admin bấm duyệt cùng lúc thì chỉ một người thắng.
    const updated = await db
      .prepare(
        `UPDATE seller_requests
         SET status = ?, review_note = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ?
         WHERE id = ? AND status = 'PENDING'`
      )
      .run(decision, note, req.user.id, now, now, row.id);
    if (updated.changes !== 1) {
      throw new AppError(409, 'REQUEST_ALREADY_REVIEWED', 'Yêu cầu này vừa được người khác xử lý');
    }

    if (decision === 'APPROVED') {
      // Chỉ nâng đúng tài khoản đang là BUYER. Nếu vì lý do nào đó họ đã là SELLER/ADMIN
      // thì bỏ qua, không hạ quyền ai.
      const promoted = await db
        .prepare(`UPDATE users SET role = 'SELLER', updated_at = ? WHERE id = ? AND role = 'BUYER'`)
        .run(now, row.user_id);
      if (promoted.changes !== 1) {
        throw new AppError(409, 'ROLE_NOT_ELIGIBLE', 'Tài khoản này không còn ở vai trò Người mua');
      }
    }
  })();

  return db.prepare(`${SELLER_REQUEST_SELECT} WHERE sr.id = ?`).get(row.id);
}

router.post('/seller-requests/:id/approve', async (req, res, next) => {
  try {
    res.json({ request: serializeSellerRequest(await reviewSellerRequest(req, 'APPROVED')) });
  } catch (e) {
    next(e);
  }
});

router.post('/seller-requests/:id/reject', async (req, res, next) => {
  try {
    res.json({ request: serializeSellerRequest(await reviewSellerRequest(req, 'REJECTED')) });
  } catch (e) {
    next(e);
  }
});

// ---------- Danh sách người dùng (để Admin nắm ai đang có vai trò gì) ----------

router.get('/users', async (req, res) => {
  const rows = await db
    .prepare(
      `SELECT u.id, u.username, u.display_name, u.role, u.is_active, u.created_at,
              (SELECT COUNT(*) FROM listings l WHERE l.seller_id = u.id) AS listing_count
       FROM users u ORDER BY u.created_at DESC LIMIT 300`
    )
    .all();
  res.json({
    users: rows.map((u) => ({
      id: u.id,
      username: u.username,
      displayName: u.display_name,
      role: u.role,
      isActive: !!u.is_active,
      listingCount: u.listing_count,
      createdAt: u.created_at,
    })),
  });
});

// ---------- UC11: Hash Chain ----------

router.get('/transactions/:id/logs', async (req, res) => {
  const logs = await db
    .prepare('SELECT * FROM audit_logs WHERE transaction_id = ? ORDER BY id ASC')
    .all(req.params.id);
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
});

router.get('/transactions/:id/logs/verify', async (req, res) => {
  const result = await verifyChain(db, req.params.id);
  res.json(result);
});

// ---------- Chín bất biến của hệ thống ----------
//
// Cùng một hàm mà bộ kiểm thử gọi sau mỗi testcase, mở thêm ở đây để buổi bảo vệ có thể
// chứng minh trạng thái hệ thống bằng dữ liệu ngay trên màn hình thay vì bằng lời.
router.get('/invariants', async (req, res) => {
  res.json(await checkInvariants(db));
});

// ---------- Nhật ký sự kiện an toàn ----------
//
// Tách khỏi nhật ký giao dịch vì trả lời câu hỏi khác: ai đã THỬ làm gì mà bị từ chối. Phần
// lớn sự kiện ở đây không gắn với giao dịch nào, nên không thuộc về chuỗi băm của giao dịch.
router.get('/security-events', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '100', 10) || 100, 500);
  const type = req.query.type ? String(req.query.type) : null;
  res.json({ events: await listSecurityEvents({ limit, type }) });
});

module.exports = router;
