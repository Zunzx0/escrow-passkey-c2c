const express = require('express');
const crypto = require('crypto');
const { generateAuthenticationOptions, verifyAuthenticationResponse:verifyAssertion } = require('@simplewebauthn/server');

const { db, uuid, nowIso } = require('../db');
const { requireAuth, requireWallet, requireRole } = require('../lib/auth');
const { appendAuditLog, verifyChain } = require('../lib/hash');
const { AppError, ConflictError } = require('../lib/errors');
async function verifyAuthenticationResponse(options){
  try{return await verifyAssertion(options);}
  catch{throw new AppError(400,'VERIFICATION_FAILED','Không xác minh được Passkey. Giao dịch chưa thay đổi.');}
}
const { RESERVING_STATUSES } = require('../lib/catalog');
const { ACTIONS, REAUTH_TTL_SECONDS, issueGrant, requireGrant, markGrantUsed } = require('../lib/reauth');
const { rateLimit } = require('../lib/rateLimit');
const { assessCounter, reportCounterAnomaly } = require('../lib/credentialCounter');
const { RP_ID, ORIGIN } = require('../lib/webauthnConfig');
const {
  onOrderSecured, onOrderAcknowledged, onOrderPacked, onOrderShipped, onOrderWaitConfirm, onOrderCompleted, onDisputeOpened,
} = require('../lib/notifications');
const { serializeShipment, createShipment } = require('../lib/shipping');
const { settleListing } = require('../lib/listingLifecycle');
const { parseVndAmount } = require('../lib/money');
const {readShipping,shippingHash,serializeShipping,loadShipping,insertShipping}=require('../lib/orderShipping');
const {orderPolicy,orderDeadline,afterHours}=require('../lib/orderPolicy');
const {transitionOrder,canReleaseBuyer,assertReleaseReady,serializeDispute,settleOrder,openOrderDispute,appendDisputeMessage,receiveOrder}=require('../lib/orderLifecycle');
const {notify}=require('../lib/notifications');
const media=require('../lib/mediaService');
const { MANUAL_TYPES, referenceFields } = require('../lib/disputeReference');

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
         l.location AS listing_location,
         sp.id AS shipment_id, sp.status AS shipment_status,
         sp.packed_at AS shipment_packed_at, sp.pickup_due_at AS shipment_pickup_due_at,
         sp.picked_up_at AS shipment_picked_up_at, sp.arrival_due_at AS shipment_arrival_due_at,
         sp.arrived_at AS shipment_arrived_at, sp.stopped_at AS shipment_stopped_at,
         sp.stop_reason AS shipment_stop_reason,
         dp.type AS dispute_type,dp.opened_by AS dispute_opened_by,dp.status AS dispute_status,
         dp.case_number AS dispute_case_number,dp.case_prefix AS dispute_case_prefix
  FROM transactions t
  JOIN users b ON b.id = t.buyer_id
  JOIN users s ON s.id = t.seller_id
  LEFT JOIN listings l ON l.id = t.listing_id
  LEFT JOIN shipments sp ON sp.transaction_id = t.id
  LEFT JOIN disputes dp ON dp.transaction_id = t.id
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
    disputeCaseCode: referenceFields({case_number:t.dispute_case_number,case_prefix:t.dispute_case_prefix,type:t.dispute_type}).caseCode,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
    inspectionDueAt:t.inspection_due_at||null,
    inspectedAt:t.inspected_at||null,inspectedBy:t.inspected_by||null,
    receivedConfirmedAt:t.received_confirmed_at||null,receivedConfirmedBy:t.received_confirmed_by||null,
    securedAt:t.secured_at||null,draftExpiresAt:t.draft_expires_at||null,
    cancelledAt:t.cancelled_at||null,cancelReason:t.cancel_reason||null,
    shippingFee:0,
    policy:orderPolicy(),
    deadlineAt:orderDeadline(t,t.shipment_id?{status:t.shipment_status,packed_at:t.shipment_packed_at,arrived_at:t.shipment_arrived_at}:null),
    canInspect:!t.inspected_at&&((t.status==='WAIT_CONFIRM'&&t.escrow_status==='LOCKED')||(t.status==='DISPUTED'&&t.escrow_status==='FROZEN'&&t.dispute_type==='INSPECTION_TIMEOUT'&&t.dispute_opened_by==='SYSTEM'&&t.dispute_status==='OPEN')),
    canBuyerRelease:!!t.inspected_at&&((t.status==='WAIT_CONFIRM'&&t.escrow_status==='LOCKED')||(t.status==='DISPUTED'&&t.escrow_status==='FROZEN'&&t.dispute_type==='INSPECTION_TIMEOUT'&&t.dispute_opened_by==='SYSTEM'&&t.dispute_status==='OPEN')),
    // Thông tin tin đăng (null với các giao dịch tạo bằng API thủ công, không gắn listing)
    listingId: t.listing_id || null,
    listingTitle: t.listing_title || null,
    listingImage: t.listing_image || null,
    listingCategory: t.listing_category || null,
    listingLocation: t.listing_location || null,
    buyerNote: t.buyer_note || null,
    sellerAckAt: t.seller_ack_at || null,
    shipment: serializeShipment(t.shipment_id ? {
      id: t.shipment_id, status: t.shipment_status,
      packed_at: t.shipment_packed_at, pickup_due_at: t.shipment_pickup_due_at,
      picked_up_at: t.shipment_picked_up_at, arrival_due_at: t.shipment_arrival_due_at,
      arrived_at: t.shipment_arrived_at, stopped_at: t.shipment_stopped_at,
      stop_reason: t.shipment_stop_reason,
    } : null),
  };
}

async function viewTxn(t,user) {
  const result=serializeTxn(t);
  const allowed=user&&(t.buyer_id===user.id||(t.seller_id===user.id&&!['CREATED','CANCELLED'].includes(t.status)&&t.escrow_status!=='NONE'));
  result.shipping=allowed?serializeShipping(await loadShipping(t.id)):null;
  // Photos the buyer saw at LOCK (frozen snapshot), or the live gallery while still a draft.
  // A later listing edit never changes what an existing order shows.
  result.images=await media.orderImagesFor(t,user);
  return result;
}

async function assertOrderActor(user) {
  if(!['BUYER','SELLER'].includes(user.role))throw new AppError(403,'FORBIDDEN','Tài khoản quản trị không được đặt mua hàng.');
  const actor=await db.prepare('SELECT is_active,account_status FROM users WHERE id=?').get(user.id);
  if(!actor?.is_active||actor.account_status!=='ACTIVE')throw new AppError(403,'WALLET_ACTIVATION_REQUIRED','Hãy kích hoạt tài khoản và ví trước khi đặt hàng.');
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
async function lockListingForOrder(listingId,expectedVersion) {
  const listing = await db.prepare('SELECT status, version FROM listings WHERE id = ?').get(listingId);
  if (!listing) throw new AppError(404, 'LISTING_NOT_FOUND', 'Tin đăng không còn tồn tại');
  const result = await db
    .prepare(
      `UPDATE listings SET status = 'LOCKED', version = version + 1, updated_at = ?
       WHERE id = ? AND status = 'AVAILABLE' AND version = ?`
    )
    .run(nowIso(), listingId, expectedVersion??listing.version);
  if (result.changes !== 1) {
    throw new ConflictError('LISTING_SOLD', 'Sản phẩm vừa được người khác mua trước, đơn này không thể thanh toán');
  }
}

function readRequestId(value,{required=true,normalize=false}={}) {
  if(value===undefined&&!required)return null;
  const clean=typeof value==='string'?value.trim():value;
  if(typeof value!=='string'||clean.length<1||clean.length>128||(!normalize&&clean!==value)||/[\u0000-\u001f\u007f]/u.test(value)){
    throw new AppError(400,'VALIDATION_ERROR','Mã yêu cầu phải là chuỗi từ 1 đến 128 ký tự, không có khoảng trắng ở hai đầu.');
  }
  return clean;
}

// Drafts do not reserve a listing or move money. Only the storefront requires a
// snapshot at creation; legacy manual drafts must add one before they can LOCK.
async function createDraft(req,{
  marketplace
}) {
  await assertOrderActor(req.user);
  const body=req.body||{};
  const requestId=readRequestId(body.requestId,{required:marketplace,normalize:true});
  if(body.note!==undefined&&body.note!==null&&(typeof body.note!=='string'||body.note.length>500||body.note.includes('\u0000')))throw new AppError(400,'VALIDATION_ERROR','Ghi chú phải là chuỗi tối đa 500 ký tự.');
  if(!marketplace){
    if(typeof body.sellerId!=='string'||!body.sellerId.trim()||body.sellerId.length>128||body.sellerId.includes('\u0000'))throw new AppError(400,'VALIDATION_ERROR','Mã người bán không hợp lệ.');
    if(typeof body.itemName!=='string'||!body.itemName.trim()||body.itemName.length>200||body.itemName.includes('\u0000'))throw new AppError(400,'VALIDATION_ERROR','Tên hàng phải là chuỗi từ 1 đến 200 ký tự.');
    if(body.itemDescription!==undefined&&body.itemDescription!==null&&(typeof body.itemDescription!=='string'||body.itemDescription.length>2000||body.itemDescription.includes('\u0000')))throw new AppError(400,'VALIDATION_ERROR','Mô tả hàng phải là chuỗi tối đa 2.000 ký tự.');
  }
  const shipping=body.shipping?readShipping(body.shipping):marketplace?readShipping(null):null;
  if(marketplace){
    if(typeof body.listingId!=='string'||!body.listingId.trim()||body.listingId.length>128||body.listingId.includes('\u0000'))throw new AppError(400,'VALIDATION_ERROR','Mã tin đăng không hợp lệ.');
  }
  const note=body.note?body.note.trim():null;
  const manualAmount=marketplace?null:parseVndAmount(body.amount);
  // Fingerprint the submitted intent, not mutable catalog fields. A retry of the
  // original request still identifies its order after payment or a price change.
  // The first marketplace creation always snapshots price/owner from the server.
  const intent=marketplace
    ? {v:1,kind:'MARKETPLACE',listingId:body.listingId,note,shipping}
    : {v:1,kind:'MANUAL',sellerId:body.sellerId,itemName:body.itemName,itemDescription:body.itemDescription||null,amount:manualAmount,note,shipping};
  const requestHash=shippingHash(intent);
  return db.transaction(async()=>{
    await db.prepare('INSERT INTO buyer_order_locks(buyer_id,version) VALUES(?,0) ON CONFLICT DO NOTHING').run(req.user.id);
    await db.prepare('UPDATE buyer_order_locks SET version=version+1 WHERE buyer_id=?').run(req.user.id);
    if(requestId){
      const existing=await db.prepare('SELECT * FROM transactions WHERE buyer_id=? AND order_request_id=?').get(req.user.id,requestId);
      if(existing){
        if(existing.order_request_hash!==requestHash)throw new AppError(409,'IDEMPOTENCY_KEY_REUSED','Mã yêu cầu đã dùng cho nội dung khác.');
        return {
          id:existing.id,created:false
        };
      }
    }
    let listing=null;
    let sellerId=body.sellerId,itemName=body.itemName,itemDescription=body.itemDescription||null,amount=manualAmount;
    if(marketplace){
      listing=await db.prepare('SELECT * FROM listings WHERE id=?').get(body.listingId);
      if(!listing||listing.visibility!=='PUBLIC')throw new AppError(404,'LISTING_NOT_FOUND','Sản phẩm không còn được bán.');
      if(listing.status!=='AVAILABLE')throw new AppError(409,'LISTING_SOLD','Sản phẩm chưa mở bán hoặc đã có người mua.');
      sellerId=listing.seller_id;
      itemName=listing.title;
      itemDescription=listing.description;
      amount=listing.price;
    }
    if(sellerId===req.user.id)throw new AppError(400,'SELF_PURCHASE','Không thể tự mua hàng của mình.');
    const seller=await db.prepare('SELECT is_active,account_status,role FROM users WHERE id=?').get(sellerId);
    if(!seller||!seller.is_active||seller.role==='ADMIN'||seller.account_status!=='ACTIVE')throw new AppError(409,'SELLER_UNAVAILABLE','Người bán chưa sẵn sàng nhận giao dịch.');
    const open=await db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE buyer_id=? AND status='CREATED'").get(req.user.id);
    if(open.n>=orderPolicy().maxOpenDrafts)throw new AppError(409,'DRAFT_LIMIT','Bạn đang có tối đa 5 đơn nháp. Hãy thanh toán hoặc hủy nháp trước.');
    const id=uuid(),at=nowIso();
    await db.prepare("INSERT INTO transactions(id,buyer_id,seller_id,item_name,item_description,amount,status,escrow_status,listing_id,buyer_note,version,created_at,updated_at,draft_expires_at,order_request_id,order_request_hash) VALUES(?,?,?,?,?,?,'CREATED','NONE',?,?,0,?,?,?,?,?)").run(id,req.user.id,sellerId,String(itemName).slice(0,200),itemDescription,amount,listing?.id||null,note,at,at,afterHours(at,orderPolicy().draftHours),requestId||null,requestId?requestHash:null);
    if(shipping)await insertShipping(id,shipping);
    await appendAuditLog(db,{
      transactionId:id,
      actorId:req.user.id,
      action:marketplace?'ORDER_CREATED':'TRANSACTION_CREATED',
      oldStatus:null,
      newStatus:'CREATED',
      eventData:{
        listingId:listing?.id||null,amount,shippingSnapshotVersion:shipping?0:null
      }
    });
    return {
      id,created:true
    };
  })();
}
router.post('/',requireAuth,requireWallet,async(req,res,next)=>{
  try{
    const r=await createDraft(req,{
      marketplace:false
    });
    res.status(r.created?201:200).json(await viewTxn(await loadTxnOr404(r.id),req.user));
  } catch(e){
    next(e);
  }
});
router.post('/orders',requireAuth,requireWallet,async(req,res,next)=>{
  try{
    const r=await createDraft(req,{
      marketplace:true
    });
    res.status(r.created?201:200).json(await viewTxn(await loadTxnOr404(r.id),req.user));
  } catch(e){
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
  } else if (perspective !== 'ADMIN') {
    // Mặc định là CHẶT: chỉ quản trị viên đã chứng minh nguồn gốc (lib/auth.js) mới thấy mọi đơn.
    // Trước đây mọi role không phải BUYER/SELLER đều rơi vào nhánh "không lọc" — một tài khoản bị
    // sửa role='ADMIN' (nay mang role nội bộ ADMIN_UNVERIFIED) sẽ đọc được toàn bộ giao dịch.
    where.push('(t.buyer_id = ? OR t.seller_id = ?)');
    params.push(req.user.id, req.user.id);
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
  res.json({ transactions: await Promise.all(rows.map(row=>viewTxn(row,req.user))),policy:orderPolicy() });
});

router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const txn = await loadTxnOr404(req.params.id);
    assertOwnership(txn, req.user, ['BUYER', 'SELLER', 'ADMIN']);
    // Hồ sơ tranh chấp (nếu có) đi kèm chi tiết giao dịch, để cả hai bên — không chỉ quản trị
    // viên — thấy được tiền đang bị đóng băng vì đâu và đã được phân xử ra sao.
    const d = await db.prepare('SELECT * FROM disputes WHERE transaction_id = ?').get(txn.id);
    const canReadReviews=d&&([txn.buyer_id,txn.seller_id].includes(req.user.id)||(req.user.role==='ADMIN'&&d.admin_id===req.user.id));
    const disputeReviews=canReadReviews?(await db.prepare('SELECT * FROM dispute_reviews WHERE dispute_id=? ORDER BY dispute_revision').all(d.id)).map(require('../lib/disputeReview').serializeReview):[];
    res.json({...await viewTxn(txn,req.user),dispute:d?{...serializeDispute(d),lastReview:disputeReviews.at(-1)||null}:null,disputeReviews,imageEvidence:await media.imageEvidence(d,req.user),disputeMessages:d?await db.prepare('SELECT id,actor_id AS "actorId",message,created_at AS "createdAt" FROM dispute_messages WHERE dispute_id=? ORDER BY created_at,id').all(d.id):[]});
  } catch (e) {
    next(e);
  }
});

// ---------- UC06: Khóa tiền vào Escrow ----------

router.post('/:id/secure', requireAuth, requireWallet, async (req, res, next) => {
  try {
    await require('../lib/accountSecurity').assertMoneyAllowed(req.user.id,ACTIONS.LOCK);
    const { requestId,reauthGrant } = req.body || {};
    readRequestId(requestId);

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
      return res.json(await viewTxn(await loadTxnOr404(txn.id),req.user));
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

    const grant=await requireGrant({userId:req.user.id,sessionId:req.user.sessionId,transactionId:txn.id,action:ACTIONS.LOCK,rawToken:reauthGrant});
    await db.transaction(async () => {
      if(await checkIdempotency(buyerLegKey,fingerprint))return;
      const current=await loadTxnOr404(txn.id);
      await assertLockReady(current,req.user);
      const context=await buildAuthorizationContext(current,ACTIONS.LOCK,req.user.sessionId);
      const expected=contextDigest(context).toString('hex');
      if(!grant.context_hash || grant.context_hash!==expected) throw new AppError(409,'CONTEXT_MISMATCH','Giá hoặc nội dung đơn đã thay đổi. Hãy tải lại và xác nhận lại.');
      await transitionOrder(current,{status:'SECURED',escrow_status:'LOCKED',secured_at:nowIso()});
      await db.prepare('UPDATE order_shipping_snapshot SET locked_at=? WHERE order_id=?').run(nowIso(),txn.id);
      await markGrantUsed(grant.id);
      // Chiếm độc quyền tin đăng TRƯỚC khi chạm tới ví — đúng thứ tự bước 3-4 của quy trình
      // LOCK đã chốt. Thua ở bước này thì không có delta ví nào phát sinh để phải rollback.
      if (txn.listing_id) await lockListingForOrder(txn.listing_id,context.listing.version);
      // Freeze the exact photo IDs/hashes the buyer is paying for, in this same transaction.
      const mediaSnapshot=await media.snapshotOrderImages(current);

      const updated = await applyOrderedWalletUpdates([
        { wallet: await getUserWallet(req.user.id), availableDelta: -txn.amount, lockedDelta: 0 },
        { wallet: await getEscrowWallet(), availableDelta: 0, lockedDelta: txn.amount },
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



      await appendAuditLog(db, {
        transactionId: txn.id,
        actorId: req.user.id,
        action: 'ESCROW_LOCKED',
        oldStatus: 'CREATED',
        newStatus: 'SECURED',
        eventData: mediaSnapshot.count
          ? { amount: txn.amount, requestId, mediaSnapshot: { count: mediaSnapshot.count, sha256: mediaSnapshot.sha256, images: mediaSnapshot.images } }
          : { amount: txn.amount, requestId },
      });
      const recipient=await db.prepare('SELECT id,email,email_verified_at FROM users WHERE id=?').get(txn.buyer_id);
      if(recipient?.email_verified_at)await require('../lib/accountSecurity').queueMail(recipient,'Biên nhận thanh toán ký quỹ Enclave',`Đơn ${txn.id}: ${txn.item_name}. Đã giữ ${txn.amount} VND trong ký quỹ. Người bán chưa nhận tiền. Chỉ xác nhận giải ngân sau khi nhận và kiểm tra hàng.`);
    })();
    await onOrderSecured(txn);

    res.json(await viewTxn(await loadTxnOr404(txn.id),req.user));
  } catch (e) {
    next(e);
  }
});

// ---------- Người bán xác nhận đơn ----------
//
// Mốc sự kiện, không phải trạng thái: đơn vẫn SECURED + LOCKED, không có tiền nào di chuyển.
// Luồng mô phỏng mới bắt buộc mốc này trước khi đóng gói. /ship của đơn cũ vẫn giữ tương thích.
router.post('/:id/acknowledge', requireAuth, async (req, res, next) => {
  try {
    const txn = await loadTxnOr404(req.params.id);
    assertOwnership(txn, req.user, ['SELLER']);
    if (txn.status !== 'SECURED' || txn.escrow_status !== 'LOCKED') {
      throw new AppError(409, 'INVALID_STATE', 'Chỉ xác nhận được đơn đã thanh toán (SECURED + LOCKED)');
    }
    if(orderDeadline(txn,null)<=nowIso())throw new AppError(409,'ORDER_DEADLINE_PASSED','Đơn đã quá hạn xác nhận, đang chờ xử lý hủy.');
    if (txn.seller_ack_at) throw new AppError(409, 'ALREADY_ACKNOWLEDGED', 'Đơn này đã được xác nhận');

    await db.transaction(async () => {
      // Điều kiện nằm trong WHERE: hai lần bấm gần như đồng thời chỉ một lần ghi được.
      const r = await db
        .prepare(`UPDATE transactions SET seller_ack_at = ?, updated_at = ?, version = version + 1
          WHERE id = ? AND seller_ack_at IS NULL AND status = 'SECURED' AND escrow_status = 'LOCKED' AND version = ?`)
        .run(nowIso(), nowIso(), txn.id,txn.version);
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
    res.json(await viewTxn(await loadTxnOr404(txn.id),req.user));
  } catch (e) {
    next(e);
  }
});

// ---------- Đóng gói: đặt lịch đơn vị vận chuyển mô phỏng ----------
router.post('/:id/pack', requireAuth, async (req, res, next) => {
  try {
    const initial = await loadTxnOr404(req.params.id);
    assertOwnership(initial, req.user, ['SELLER']);
    let packed;
    let current;
    await db.transaction(async () => {
      current = await loadTxnOr404(initial.id);
      assertOwnership(current, req.user, ['SELLER']);
      packed = await createShipment(current);
      if (packed.created) {
        await appendAuditLog(db, {
          transactionId: current.id, actorId: req.user.id, action: 'SELLER_PACKED',
          oldStatus: 'SECURED', newStatus: 'SECURED',
          eventData: {
            shipmentId: packed.shipment.id, packedAt: packed.shipment.packed_at,
            pickupDueAt: packed.shipment.pickup_due_at, arrivalDueAt: packed.shipment.arrival_due_at,
            simulated: true,
          },
        });
      }
    })();
    if (packed.created) await onOrderPacked(current);
    res.status(packed.created ? 201 : 200).json(await viewTxn(await loadTxnOr404(initial.id),req.user));
  } catch (e) { next(e); }
});

// ---------- UC07: Người bán giao hàng ----------

router.post('/:id/ship',requireAuth,async(req,res,next)=>{try{const txn=await loadTxnOr404(req.params.id);assertOwnership(txn,req.user,['SELLER']);throw new AppError(409,'PACK_REQUIRED','Hãy đóng gói để hệ thống đặt lịch vận chuyển. Không thể bỏ qua đơn vị vận chuyển.');}catch(e){next(e);}});

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
router.post('/:id/wait-confirm',requireAuth,async(req,res,next)=>{
  try{
    const result=await db.transaction(async()=>{
      const txn=await loadTxnOr404(req.params.id);
      assertOwnership(txn,req.user,['BUYER']);
      if(txn.received_confirmed_by==='BUYER'&&['WAIT_CONFIRM','DISPUTED'].includes(txn.status))return {
        txn,changed:false
      };
      if(txn.status!=='SHIPPING'||txn.escrow_status!=='LOCKED')throw new AppError(409,'INVALID_STATE','Đơn không còn ở bước nhận kiện.');
      if(txn.shipment_id&&txn.shipment_status!=='ARRIVED')throw new AppError(409,'SHIPMENT_NOT_ARRIVED','Hãy đợi đơn đến trước khi xác nhận nhận kiện.');
      return {
        txn:await receiveOrder(txn),changed:true
      };
    })();
    if(result.changed)await onOrderWaitConfirm(result.txn);
    res.json(await viewTxn(await loadTxnOr404(req.params.id),req.user));
  } catch(e){
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
async function assertLockReady(txn,user) {
  assertOwnership(txn,user,['BUYER']);
  await require('../lib/accountSecurity').assertMoneyAllowed(user.id,ACTIONS.LOCK);
  if(!await loadShipping(txn.id))throw new AppError(400,'SHIPPING_REQUIRED','Hãy bổ sung thông tin nhận hàng trước khi thanh toán.');
  if((txn.draft_expires_at||afterHours(txn.created_at,orderPolicy().draftHours))<=nowIso())throw new AppError(409,'DRAFT_EXPIRED','Đơn nháp đã hết hạn. Hãy tạo đơn mới.');
  const buyer=await db.prepare('SELECT account_status,is_active FROM users WHERE id=?').get(user.id);
  if(!buyer?.is_active || !['ACTIVE','RECOVERING'].includes(buyer.account_status))throw new AppError(403,'WALLET_ACTIVATION_REQUIRED','Hãy kích hoạt ví trước khi thanh toán.');
  if(txn.buyer_id===txn.seller_id)throw new AppError(400,'SELF_PURCHASE','Không thể tự mua hàng của mình.');
  if(txn.status!=='CREATED'||txn.escrow_status!=='NONE')throw new AppError(409,'INVALID_STATE','Đơn không còn ở bước thanh toán.');
  const seller=await db.prepare('SELECT is_active,account_status FROM users WHERE id=?').get(txn.seller_id);
  if(!seller?.is_active || !['ACTIVE','RECOVERING'].includes(seller.account_status))throw new AppError(409,'SELLER_UNAVAILABLE','Người bán chưa sẵn sàng nhận giao dịch.');
  if(txn.listing_id){
    const listing=await db.prepare('SELECT * FROM listings WHERE id=?').get(txn.listing_id);
    if(!listing || listing.visibility!=='PUBLIC' || listing.seller_id!==txn.seller_id || listing.price!==txn.amount)throw new AppError(409,'CONTEXT_MISMATCH','Tin đăng hoặc giá đã thay đổi. Hãy quay lại sản phẩm để đặt đơn mới.');
    if(await findReservingOrder(txn.listing_id,txn.id))throw new AppError(409,'LISTING_SOLD','Sản phẩm vừa có người mua trước.');
  }
  const wallet=await getUserWallet(user.id);
  if(!wallet || wallet.available_balance<txn.amount)throw new AppError(400,'INSUFFICIENT_FUNDS','Số dư không đủ. Hãy nạp thêm trước khi xác nhận Passkey.');
}

async function buildAuthorizationContext(txn,action=ACTIONS.RELEASE,sessionId=null) {
  const seller = await db.prepare('SELECT display_name FROM users WHERE id = ?').get(txn.seller_id);
  if(action===ACTIONS.LOCK){
    const listing=txn.listing_id?await db.prepare('SELECT * FROM listings WHERE id=?').get(txn.listing_id):null;
    const snapshot=await loadShipping(txn.id);
    return {shippingSnapshot:snapshot?{version:snapshot.version,digest:shippingHash(serializeShipping(snapshot))}:null,v:4,action,transactionId:txn.id,buyerId:txn.buyer_id,sellerId:txn.seller_id,sellerName:seller?.display_name||'',amount:txn.amount,currency:'VND',itemName:txn.item_name,orderVersion:txn.version,sessionId,listing:listing?{id:listing.id,title:listing.title,price:listing.price,version:listing.version,visibility:listing.visibility}:null};
  }
  return {
    v: 3,
    orderVersion:txn.version,inspectedAt:txn.inspected_at||null,
    dispute:txn.status==='DISPUTED'?await db.prepare('SELECT id,type,status,revision FROM disputes WHERE transaction_id=?').get(txn.id):null,
    action: 'RELEASE_ESCROW',
    sessionId,
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
    const action=req.body?.action||ACTIONS.RELEASE;
    if(![ACTIONS.LOCK,ACTIONS.RELEASE].includes(action))throw new AppError(400,'INVALID_ACTION','Hành động xác nhận không hợp lệ.');
    await require('../lib/accountSecurity').assertMoneyAllowed(req.user.id,action);
    await require('../lib/accountSecurity').assertReauthAvailable(req.user.id);
    const txn = await loadTxnOr404(req.params.id);
    assertOwnership(txn, req.user, ['BUYER']);
    if(action===ACTIONS.LOCK)await assertLockReady(txn,req.user);
    else await assertReleaseReady(txn);

    const credentials = await userCredentials(req.user.id);
    if (credentials.length === 0) throw new AppError(400, 'NO_CREDENTIAL', 'Tài khoản chưa có Passkey');

    const context = await buildAuthorizationContext(txn,action,req.user.sessionId);

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
    await require('../lib/accountSecurity').assertReauthAvailable(req.user.id,{count:false});
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
    const action=JSON.parse(challengeRow.context_data).action;
    if(![ACTIONS.LOCK,ACTIONS.RELEASE].includes(action))throw new AppError(400,'INVALID_ACTION','Hành động xác nhận không hợp lệ.');
    if(action===ACTIONS.LOCK)await assertLockReady(txn,req.user);
    else {
      await require('../lib/accountSecurity').assertMoneyAllowed(req.user.id,action);
      await assertReleaseReady(txn);
    }

    // Người dùng có thể ký bằng BẤT KỲ thiết bị nào của họ — chọn đúng cái đã ký.
    const credential = await db
      .prepare('SELECT * FROM passkey_credentials WHERE user_id = ? AND credential_id = ?')
      .get(req.user.id, response.id);
    if (!credential) throw new AppError(400, 'NO_CREDENTIAL', 'Passkey này không thuộc tài khoản của bạn');

    // Đối chiếu ngữ cảnh uỷ quyền lần 1: dựng lại nội dung giao dịch từ dữ liệu HIỆN TẠI
    // và so với bản đã lưu lúc phát challenge. Đơn bị sửa trong lúc chờ ký thì hai bản
    // lệch nhau và yêu cầu bị chặn ngay, trước khi cấp phiếu uỷ quyền.
    const currentContext = await buildAuthorizationContext(txn,action,req.user.sessionId);
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
        action,
        contextHash,
        credentialId:credential.id,
      });
    })();
    await reportCounterAnomaly(req, credential, counterCheck);
    await require('../lib/accountSecurity').clearReauthFailures(req.user.id);

    res.json({ reauthGrant: issued.rawToken, expiresAt: issued.expiresAt, signedContext: currentContext });
  } catch (e) {
    if(['VERIFICATION_FAILED','NO_CREDENTIAL'].includes(e.code)) await require('../lib/accountSecurity').recordReauthFailure(req.user.id);
    next(e);
  }
});

// ---------- UC09: Người mua xác nhận đã nhận hàng và giải ngân ----------

router.post('/:id/release',requireAuth,async(req,res,next)=>{
  try{
    const {
      requestId,reauthGrant
    }
    =req.body||{};
    readRequestId(requestId);
    if(!reauthGrant)throw new AppError(400,'VALIDATION_ERROR','Thiếu phiếu xác thực.');
    let completed;
    await db.transaction(async()=>{
      const txn=await loadTxnOr404(req.params.id);
      assertOwnership(txn,req.user,['BUYER']);
      const replay=await db.prepare('SELECT request_id FROM wallet_entries WHERE idempotency_key=?').get(`release:${txn.id}:debit`);
      if(txn.status==='COMPLETED'&&replay?.request_id===requestId){
        completed=txn;
        return;
      }
      await assertReleaseReady(txn);
      const grant=await requireGrant({
        userId:req.user.id,sessionId:req.user.sessionId,transactionId:txn.id,action:ACTIONS.RELEASE,rawToken:reauthGrant
      });
      if(grant.context_hash!==contextDigest(await buildAuthorizationContext(txn,ACTIONS.RELEASE,req.user.sessionId)).toString('hex'))throw new AppError(409,'CONTEXT_MISMATCH','Nội dung đơn đã thay đổi. Hãy xác thực lại.');
      const dispute=txn.status==='DISPUTED'?await db.prepare("SELECT * FROM disputes WHERE transaction_id=? AND status='OPEN'").get(txn.id):null;
      completed=await settleOrder(txn,{
        decision:'RELEASE',actorId:req.user.id,requestId,grant,dispute,finalStatus:'COMPLETED',action:'ESCROW_RELEASED'
      });
    })();
    await onOrderCompleted(completed);
    res.json(await viewTxn(await loadTxnOr404(req.params.id),req.user));
  } catch(e){
    next(e);
  }
});

// ---------- UC10: Mở tranh chấp ----------
// Cả hai bên đều được mở. Người mua mở khi hàng không được giao hoặc giao không đúng mô
// tả. Người bán mở khi người mua đòi hoàn tiền không có căn cứ hoặc phủ nhận đã nhận
// hàng. Nội dung phán quyết thuộc chính sách nghiệp vụ, không phải trọng tâm ở đây.

router.post('/:id/dispute',requireAuth,sensitiveLimiter,async(req,res,next)=>{
  try{
    const reason=typeof req.body?.reason==='string'?req.body.reason.trim():'';
    const type=req.body?.type||'DEFECT';
    if(!reason||reason.length>1000||reason.includes('\u0000')||!MANUAL_TYPES.includes(type))throw new AppError(400,'VALIDATION_ERROR','Chọn loại vấn đề và nhập mô tả từ 1 đến 1.000 ký tự.');
    const imageIds=media.readImageIds(req.body?.imageIds,{max:6});
    if(imageIds?.length&&[...reason].length<10)throw new AppError(400,'VALIDATION_ERROR','Mô tả sự cố kèm ảnh cần từ 10 đến 1.000 ký tự.');
    let txn;
    const result=await db.transaction(async()=>{
      txn=await loadTxnOr404(req.params.id);
      assertOwnership(txn,req.user,['BUYER','SELLER']);
      const opened=await openOrderDispute(txn,{
        type,actorId:req.user.id,reason
      });
      // Same transaction: a bad/foreign/expired image rolls back the dispute itself, and
      // the dispute revision + order version were already bumped by openOrderDispute.
      await media.attachEvidenceImages(txn,opened.dispute,req.user.id,imageIds);
      return opened;
    })();
    if(result.created)await onDisputeOpened(txn,req.user.id,result.dispute);
    if(result.converted){
      const admins=await db.prepare("SELECT u.id FROM users u JOIN admin_provenance p ON p.user_id=u.id WHERE u.role='ADMIN' AND u.is_active=1").all();
      const recipients=new Set([txn.buyer_id,txn.seller_id,...admins.map(a=>a.id)]);
      await notify([...recipients].map(userId=>({
        userId,type:'DISPUTE_COMPLAINT_ADDED',key:`${result.dispute.id}:${result.dispute.revision}`,transactionId:txn.id,
        title:'Hồ sơ hệ thống đã có khiếu nại thực tế',
        body:'Một bên đã báo vấn đề với đơn hàng. Tiền tiếp tục bị đóng băng và cần quản trị viên phân xử.'
      })));
    }
    res.status(result.created?201:200).json({
      dispute:serializeDispute(result.dispute),transaction:await viewTxn(await loadTxnOr404(req.params.id),req.user),
      imageEvidence:await media.imageEvidence(result.dispute,req.user)
    });
  } catch(e){
    next(e);
  }
});
router.post('/:id/dispute/messages',requireAuth,sensitiveLimiter,async(req,res,next)=>{
  try{
    const raw=req.body?.message===undefined?req.body?.reason:req.body.message;
    const message=typeof raw==='string'?raw.trim():'';
    if(!message||message.length>1000||message.includes('\u0000'))throw new AppError(400,'VALIDATION_ERROR','Nội dung bổ sung phải là chuỗi từ 1 đến 1.000 ký tự.');
    const imageIds=media.readImageIds(req.body?.imageIds,{max:6});
    if(imageIds?.length&&[...message].length<5)throw new AppError(400,'VALIDATION_ERROR','Nội dung bổ sung kèm ảnh cần từ 5 đến 1.000 ký tự.');
    const result=await db.transaction(async()=>{
      const txn=await loadTxnOr404(req.params.id);
      assertOwnership(txn,req.user,['BUYER','SELLER']);
      // appendDisputeMessage bumps dispute.revision and orders.version exactly once; the
      // images ride in the same transaction so a stale admin/buyer authorization fails.
      const appended=await appendDisputeMessage(txn,{actorId:req.user.id,message});
      await media.attachEvidenceImages(txn,appended.dispute,req.user.id,imageIds);
      return appended;
    })();
    res.status(201).json({
      dispute:serializeDispute(result.dispute),
      transaction:await viewTxn(await loadTxnOr404(req.params.id),req.user),
      message:result.message,
      imageEvidence:await media.imageEvidence(result.dispute,req.user)
    });
  }catch(error){next(error);}
});

router.post('/:id/inspected',requireAuth,async(req,res,next)=>{
  try{
    await db.transaction(async()=>{
      const txn=await loadTxnOr404(req.params.id);
      assertOwnership(txn,req.user,['BUYER']);
      if(txn.inspected_at)return;
      await assertReleaseReady(txn,{
        requireInspection:false
      });
      const at=nowIso();
      await transitionOrder(txn,{
        inspected_at:at,inspected_by:req.user.id
      });
      await appendAuditLog(db,{
        transactionId:txn.id,
        actorId:req.user.id,
        action:'BUYER_INSPECTED',
        oldStatus:txn.status,
        newStatus:txn.status,
        eventData:{
          inspectedAt:at
        }
      });
    })();
    res.json(await viewTxn(await loadTxnOr404(req.params.id),req.user));
  } catch(e){
    next(e);
  }
});
async function cancelOrder(req,{ seller=false } = {}) {
  let result;
  await db.transaction(async()=>{
    const txn=await loadTxnOr404(req.params.id);
    assertOwnership(txn,req.user,[seller?'SELLER':'BUYER']);
    const reason=seller?'seller_reject':'buyer_cancel';
    if(txn.status==='CANCELLED'&&txn.cancel_reason===reason){
      result=txn;
      return;
    }
    if(txn.status==='CREATED'&&!seller){
      await transitionOrder(txn,{
        status:'CANCELLED',cancelled_at:nowIso(),cancel_reason:reason
      });
      await appendAuditLog(db,{
        transactionId:txn.id,
        actorId:req.user.id,
        action:'DRAFT_CANCELLED',
        oldStatus:'CREATED',
        newStatus:'CANCELLED',
        eventData:{
          reason
        }
      });
      result=txn;
      return;
    }
    if(txn.status!=='SECURED'||txn.escrow_status!=='LOCKED'||txn.shipment_id||(!seller&&txn.seller_ack_at))throw new AppError(409,'CANCELLATION_NOT_ALLOWED','Không thể hủy thường ở bước này. Hãy báo vấn đề hoặc mở tranh chấp.');
    if(seller&&(typeof req.body?.reason!=='string'||req.body.reason.trim().length<2||req.body.reason.trim().length>1000||req.body.reason.includes('\u0000')))throw new AppError(400,'VALIDATION_ERROR','Người bán cần nêu lý do từ chối/hủy đơn.');
    result=await settleOrder(txn,{
      decision:'REFUND',
      actorId:req.user.id,
      requestId:`cancel:${txn.id}`,
      reason,
      listingOutcome:seller&&txn.seller_ack_at?'REFUND':'CANCEL_BEFORE_SHIPMENT',
      finalStatus:'CANCELLED',
      action:seller?'SELLER_CANCELLED':'BUYER_CANCELLED'
    });
    // Free-form cancellation explanation is private dispute content, never an audit payload.
    if(seller)await db.prepare('INSERT INTO order_cancellation_notes(order_id,actor_id,note,created_at) VALUES(?,?,?,?)').run(txn.id,req.user.id,req.body.reason.trim(),nowIso());
  })();
  await notify([result.buyer_id,result.seller_id].map(userId=>({
    userId,type:'ORDER_CANCELLED',key:result.id,transactionId:result.id,title:'Đơn hàng đã được hủy',body:'Nếu đơn đã thanh toán, tiền ký quỹ đã hoàn về ví người mua.'
  })));
}
router.post('/:id/cancel',requireAuth,async(req,res,next)=>{
  try{
    await cancelOrder(req);
    res.json(await viewTxn(await loadTxnOr404(req.params.id),req.user));
  } catch(e){
    next(e);
  }
});
router.post('/:id/reject',requireAuth,async(req,res,next)=>{
  try{
    await cancelOrder(req,{
      seller:true
    });
    res.json(await viewTxn(await loadTxnOr404(req.params.id),req.user));
  } catch(e){
    next(e);
  }
});
router.post('/:id/shipping',requireAuth,async(req,res,next)=>{
  try{
    const shipping=readShipping(req.body?.shipping);
    await db.transaction(async()=>{
      const txn=await loadTxnOr404(req.params.id);
      assertOwnership(txn,req.user,['BUYER']);
      if(!['CREATED','SECURED'].includes(txn.status)||txn.shipment_picked_up_at||txn.shipment_status==='STOPPED')throw new AppError(409,'ADDRESS_LOCKED','Địa chỉ chỉ được thay đổi trước khi đơn vị vận chuyển lấy hàng.');
      const existing=await loadShipping(txn.id);
      await transitionOrder(txn,{});
      if(existing)await db.prepare('INSERT INTO order_shipping_history(order_id,version,snapshot_json,changed_by,created_at) VALUES(?,?,?,?,?)').run(txn.id,existing.version,JSON.stringify(serializeShipping(existing)),req.user.id,nowIso());
      if(existing){
        const r=await db.prepare('UPDATE order_shipping_snapshot SET recipient_name=?,phone=?,address=?,ward=?,district=?,province=?,version=version+1,updated_at=? WHERE order_id=? AND version=?').run(shipping.recipientName,shipping.phone,shipping.address,shipping.ward,shipping.district,shipping.province,nowIso(),txn.id,existing.version);
        if(r.changes!==1)throw new ConflictError('SHIPPING_VERSION_CONFLICT');
      } else await insertShipping(txn.id,shipping);
      await appendAuditLog(db,{
        transactionId:txn.id,
        actorId:req.user.id,
        action:'SHIPPING_SNAPSHOT_UPDATED',
        oldStatus:txn.status,
        newStatus:txn.status,
        eventData:{
          snapshotId:txn.id,version:existing?existing.version+1:0,afterPayment:txn.escrow_status==='LOCKED'
        }
      });
    })();
    res.json(await viewTxn(await loadTxnOr404(req.params.id),req.user));
  } catch(e){
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
module.exports.buildAuthorizationContext=buildAuthorizationContext;
