const express = require('express');
const crypto = require('crypto');
const { generateAuthenticationOptions, verifyAuthenticationResponse:verifyAssertion } = require('@simplewebauthn/server');

const { db, uuid, nowIso } = require('../db');
const { requireAuth } = require('../lib/auth');
const { appendAuditLog, verifyChain } = require('../lib/hash');
const { AppError } = require('../lib/errors');
async function verifyAuthenticationResponse(options){
  try{return await verifyAssertion(options);}
  catch{throw new AppError(400,'VERIFICATION_FAILED','Không xác minh được Passkey. Hồ sơ chưa thay đổi.');}
}
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
const {transitionOrder,settleOrder}=require('../lib/orderLifecycle');
const {serializeShipping,loadShipping}=require('../lib/orderShipping');
const media=require('../lib/mediaService');
const { referenceFields } = require('../lib/disputeReference');
const {latestReview,serializeReview,reviewDigest,validateReview,requireReview} = require('../lib/disputeReview');

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
    inspectedAt:t.inspected_at||null,inspectedBy:t.inspected_by||null,
    receivedConfirmedAt:t.received_confirmed_at||null,receivedConfirmedBy:t.received_confirmed_by||null,
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
    ...referenceFields(d),
    transactionId: d.transaction_id,
    createdBy: d.created_by,
    createdByName: d.created_by_name || null,
    openedBy:d.opened_by|| (d.created_by===d.buyer_id?'BUYER':'SELLER'),
    type:d.type,
    revision:d.revision,
    buyerNeverConfirmedReceipt:!!d.buyer_never_confirmed_receipt,
    evidenceDueAt:d.evidence_due_at||require('../lib/orderPolicy').afterHours(d.created_at,72),
    adminDueAt:d.admin_due_at||require('../lib/orderPolicy').afterHours(d.created_at,168),
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
  LEFT JOIN users u ON u.id = d.created_by
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
    const transaction=serializeTxn(await loadTxnDetail(dispute.transaction_id));
    transaction.shipping=dispute.admin_id===req.user.id?serializeShipping(await loadShipping(dispute.transaction_id)):null;
    const messages=await db.prepare('SELECT id,actor_id AS "actorId",message,created_at AS "createdAt" FROM dispute_messages WHERE dispute_id=? ORDER BY created_at,id').all(dispute.id);
    // Photos and evidence are listed only for the independent admin who claimed this case;
    // an unclaimed viewer gets empty arrays and the image routes answer 404 to them.
    transaction.images=await media.orderImagesFor({id:dispute.transaction_id,buyer_id:transaction.buyerId,seller_id:transaction.sellerId,listing_id:transaction.listingId,status:transaction.status,escrow_status:transaction.escrowStatus},req.user);
    const reviews=dispute.admin_id===req.user.id?await db.prepare('SELECT * FROM dispute_reviews WHERE dispute_id=? ORDER BY dispute_revision').all(dispute.id):[];
    res.json({dispute:{...serializeDispute(dispute),lastReview:serializeReview(reviews.at(-1))},reviews:reviews.map(serializeReview),transaction,messages,imageEvidence:await media.imageEvidence(dispute,req.user)});
  } catch (e) {
    next(e);
  }
});

// Address access is limited to the independent admin who explicitly claims the case.
router.post('/disputes/:id/claim',async(req,res,next)=>{
  try{
    await db.transaction(async()=>{
      const d=await db.prepare('SELECT * FROM disputes WHERE id=?').get(req.params.id);
      if(!d)throw new AppError(404,'DISPUTE_NOT_FOUND');
      const txn=await db.prepare('SELECT * FROM transactions WHERE id=?').get(d.transaction_id);
      assertIndependentAdjudicator(txn,req.user.id);
      if(d.status!=='OPEN')throw new AppError(409,'DISPUTE_NOT_OPEN','Hồ sơ đã được xử lý.');
      if(d.admin_id===req.user.id)return;
      if(d.admin_id)throw new AppError(409,'DISPUTE_ASSIGNED','Hồ sơ đã có quản trị viên phụ trách.');
      await transitionOrder(txn,{});
      const r=await db.prepare("UPDATE disputes SET admin_id=?,revision=revision+1 WHERE id=? AND admin_id IS NULL AND status='OPEN' AND revision=?").run(req.user.id,d.id,d.revision);
      if(r.changes!==1)throw new AppError(409,'DISPUTE_ASSIGNED','Hồ sơ vừa được tiếp nhận ở nơi khác.');
      await appendAuditLog(db,{
        transactionId:txn.id,
        actorId:req.user.id,
        action:'DISPUTE_CLAIMED',
        oldStatus:txn.status,
        newStatus:txn.status,
        eventData:{
          disputeId:d.id
        }
      });
    })();
    const d=await db.prepare(`${DISPUTE_SELECT} WHERE d.id=?`).get(req.params.id),transaction=serializeTxn(await loadTxnDetail(d.transaction_id));
    transaction.shipping=serializeShipping(await loadShipping(d.transaction_id));
    transaction.images=await media.orderImagesFor({id:d.transaction_id,buyer_id:transaction.buyerId,seller_id:transaction.sellerId,listing_id:transaction.listingId,status:transaction.status,escrow_status:transaction.escrowStatus},req.user);
    res.json({
      dispute:serializeDispute(d),transaction,imageEvidence:await media.imageEvidence(d,req.user)
    });
  } catch(e){
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
function buildAdjudicationContext(dispute, txn, decision, adminId,sessionId=null,review=null) {
  return {
    v: 3,
    reviewId:review?.id||null,
    reviewDigest:review?reviewDigest(review):null,
    orderVersion:txn.version,disputeRevision:dispute.revision||0,disputeType:dispute.type||null,
    action: ACTIONS.ADJUDICATE,
    adminId,
    sessionId,
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

function assertCaseAssignee(dispute, actorId) {
  if (dispute.admin_id && dispute.admin_id !== actorId) {
    throw new AppError(409,'DISPUTE_ASSIGNED','Hồ sơ đã có quản trị viên khác phụ trách. Bạn không thể quyết định trả tiền cho hồ sơ này.');
  }
}

/** Nạp hồ sơ tranh chấp cùng giao dịch, và kiểm cặp trạng thái bắt buộc của luồng phân xử. */
async function loadOpenDisputeForAdjudication(disputeId, actorId) {
  const dispute = await db.prepare(`${DISPUTE_SELECT} WHERE d.id = ?`).get(disputeId);
  if (!dispute) throw new AppError(404, 'DISPUTE_NOT_FOUND', 'Không tìm thấy hồ sơ tranh chấp');
  assertCaseAssignee(dispute,actorId);
  if (dispute.status !== 'OPEN') throw new AppError(409, 'DISPUTE_NOT_OPEN', 'Hồ sơ tranh chấp phải đang mở');

  const txn = await db.prepare('SELECT * FROM transactions WHERE id = ?').get(dispute.transaction_id);
  if (!txn) throw new AppError(404, 'TRANSACTION_NOT_FOUND', 'Không tìm thấy giao dịch');
  assertIndependentAdjudicator(txn, actorId);
  if (txn.status !== 'DISPUTED' || txn.escrow_status !== 'FROZEN') {
    throw new AppError(409, 'INVALID_STATE', 'Giao dịch phải ở DISPUTED + FROZEN');
  }
  return { dispute, txn };
}

// Saving a review never moves money. Every change creates a new immutable record
// and changes the authorization context, including a request for more information.
router.post('/disputes/:id/review',sensitiveLimiter,async(req,res,next)=>{
  try {
    let saved,transaction,dispute;
    await db.transaction(async()=>{
      ({dispute,txn:transaction}=await loadOpenDisputeForAdjudication(req.params.id,req.user.id));
      if(dispute.admin_id!==req.user.id)throw new AppError(409,'DISPUTE_CLAIM_REQUIRED','Hãy nhận xử lý hồ sơ trước khi ghi căn cứ.');
      const body=req.body||{}, value=validateReview(body,transaction);
      if(body.expectedDisputeRevision!==dispute.revision||body.expectedOrderVersion!==transaction.version)throw new AppError(409,'DISPUTE_REVIEW_STALE','Hồ sơ vừa thay đổi. Hãy tải lại và đọc thông tin mới trước khi lưu.');
      transaction=await transitionOrder(transaction,{});
      const changed=await db.prepare("UPDATE disputes SET revision=revision+1 WHERE id=? AND status='OPEN' AND revision=? AND admin_id=?").run(dispute.id,dispute.revision,req.user.id);
      if(changed.changes!==1)throw new AppError(409,'DISPUTE_REVIEW_STALE','Hồ sơ vừa thay đổi. Hãy tải lại.');
      saved={id:uuid(),dispute_id:dispute.id,admin_id:req.user.id,decision:value.decision,basis:value.basis,reviewed:1,receipt_acknowledged:value.receiptAcknowledged?1:0,dispute_revision:dispute.revision+1,order_version:transaction.version,created_at:nowIso()};
      await db.prepare('INSERT INTO dispute_reviews(id,dispute_id,admin_id,decision,basis,reviewed,receipt_acknowledged,dispute_revision,order_version,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(saved.id,saved.dispute_id,saved.admin_id,saved.decision,saved.basis,saved.reviewed,saved.receipt_acknowledged,saved.dispute_revision,saved.order_version,saved.created_at);
      await appendAuditLog(db,{transactionId:transaction.id,actorId:req.user.id,action:value.decision==='REQUEST_MORE'?'DISPUTE_MORE_INFORMATION_REQUESTED':'DISPUTE_REVIEW_SAVED',oldStatus:transaction.status,newStatus:transaction.status,eventData:{disputeId:dispute.id,reviewId:saved.id,decision:saved.decision,reviewDigest:reviewDigest(saved)}});
    })();
    if(saved.decision==='REQUEST_MORE')await require('../lib/notifications').notify([transaction.buyer_id,transaction.seller_id].map(userId=>({userId,type:'DISPUTE_MORE_INFORMATION_REQUESTED',key:saved.id,transactionId:transaction.id,title:'Hồ sơ cần bổ sung thông tin',body:'Quản trị viên đã ghi nội dung cần bổ sung trong chi tiết đơn. Tiền vẫn được Enclave giữ.'})));
    res.status(201).json({review:serializeReview(saved),dispute:{...serializeDispute({...dispute,revision:saved.dispute_revision}),lastReview:serializeReview(saved)},transaction:serializeTxn(transaction)});
  }catch(e){next(e);}
});

router.post('/disputes/:id/reauth/options', sensitiveLimiter, async (req, res, next) => {
  try {
    await require('../lib/accountSecurity').assertMoneyAllowed(req.user.id,ACTIONS.ADJUDICATE);
    await require('../lib/accountSecurity').assertReauthAvailable(req.user.id);
    const decision = parseDecision((req.body || {}).decision);
    const { dispute, txn } = await loadOpenDisputeForAdjudication(req.params.id, req.user.id);

    const review=await requireReview(db,dispute,txn,req.user.id,decision,(req.body||{}).reviewId);

    const credentials = await db.prepare('SELECT * FROM passkey_credentials WHERE user_id = ?').all(req.user.id);
    if (credentials.length === 0) throw new AppError(400, 'NO_CREDENTIAL', 'Tài khoản quản trị chưa có Passkey');

    const context = buildAdjudicationContext(dispute, txn, decision, req.user.id,req.user.sessionId,review);

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
    await require('../lib/accountSecurity').assertMoneyAllowed(req.user.id,ACTIONS.ADJUDICATE);
    await require('../lib/accountSecurity').assertReauthAvailable(req.user.id,{count:false});
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
    const review=await requireReview(db,dispute,txn,req.user.id,decision,savedContext.reviewId);
    const currentContext = buildAdjudicationContext(dispute, txn, decision, req.user.id,req.user.sessionId,review);
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
      // WebAuthn verification yields. Re-read under the business transaction lock
      // so evidence arriving during signature verification cannot get a stale grant.
      const fresh=await loadOpenDisputeForAdjudication(req.params.id,req.user.id);
      const freshReview=await requireReview(db,fresh.dispute,fresh.txn,req.user.id,decision,savedContext.reviewId);
      if(JSON.stringify(buildAdjudicationContext(fresh.dispute,fresh.txn,decision,req.user.id,req.user.sessionId,freshReview))!==challengeRow.context_data)throw new AppError(409,'CONTEXT_MISMATCH','Hồ sơ vừa thay đổi. Hãy xem lại trước khi xác thực.');
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
        credentialId:credential.id,
      });
    })();
    await reportCounterAnomaly(req, credential, counterCheck);
    await require('../lib/accountSecurity').clearReauthFailures(req.user.id);

    res.json({
      reauthGrant: issued.rawToken,
      expiresAt: issued.expiresAt,
      decision,
      signedContext: currentContext,
    });
  } catch (e) {
    if(['VERIFICATION_FAILED','NO_CREDENTIAL'].includes(e.code)) await require('../lib/accountSecurity').recordReauthFailure(req.user.id);
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
  const review=await requireReview(db,dispute,txn,req.user.id,decision,(req.body||{}).reviewId||(await latestReview(db,dispute.id))?.id);
  assertContextUnchanged(grant, contextDigest(buildAdjudicationContext(dispute, txn, decision, req.user.id,req.user.sessionId,review)));

  return { dispute, txn, grant,review };
}

async function adjudicate(req,decision) {
  const {
    requestId
  }
  =req.body||{};
  if(typeof requestId!=='string'||!requestId||requestId.length>128||requestId.trim()!==requestId||/[\u0000-\u001f\u007f]/u.test(requestId))throw new AppError(400,'VALIDATION_ERROR','Thiếu mã yêu cầu hợp lệ.');
  let txn;
  await db.transaction(async()=>{
    const {
      dispute,current
    }
    =await (async()=>{
      const d=await db.prepare(`${DISPUTE_SELECT} WHERE d.id=?`).get(req.params.id);
      if(!d)throw new AppError(404,'DISPUTE_NOT_FOUND');
      // Check inside the settlement transaction too, including the replay path.
      assertCaseAssignee(d,req.user.id);
      const t=await loadTxnDetail(d.transaction_id);
      assertIndependentAdjudicator(t,req.user.id);
      return {
        dispute:d,current:t
      };
    })();
    txn=current;
    const key=`${decision==='REFUND'?'refund':'release'}:${txn.id}:debit`,entry=await db.prepare('SELECT request_id FROM wallet_entries WHERE idempotency_key=?').get(key);
    if(dispute.status===`RESOLVED_${decision}`&&entry?.request_id===requestId)return;
    const authorized=await authorizeAdjudication(req,decision);
    await settleOrder(txn,{
      decision,actorId:req.user.id,requestId,grant:authorized.grant,dispute:authorized.dispute,review:authorized.review,finalStatus:decision==='REFUND'?'REFUNDED':'RELEASED',reason:decision==='REFUND'?'admin_refund':null,action:decision==='REFUND'?'ADMIN_REFUND':'ADMIN_RELEASE'
    });
  })();
  await onDisputeResolved(txn,decision);
  await logSecurityEvent(req,{
    type:EVENTS.ADMIN_ADJUDICATION,outcome:'ALLOWED',statusCode:200,detail:{
      decision,transactionId:txn.id,disputeId:req.params.id
    }
  });
  const d=await db.prepare(`${DISPUTE_SELECT} WHERE d.id=?`).get(req.params.id);
  return {
    dispute:serializeDispute(d),transaction:serializeTxn(await loadTxnDetail(txn.id))
  };
}
router.post('/disputes/:id/refund',sensitiveLimiter,async(req,res,next)=>{
  try{
    res.json(await adjudicate(req,DECISIONS.REFUND));
  } catch(e){
    next(e);
  }
});
router.post('/disputes/:id/release',sensitiveLimiter,async(req,res,next)=>{
  try{
    res.json(await adjudicate(req,DECISIONS.RELEASE));
  } catch(e){
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

module.exports.buildAdjudicationContext=buildAdjudicationContext;
