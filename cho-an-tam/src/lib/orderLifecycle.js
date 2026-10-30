const { db, uuid, nowIso } = require('../db');
const { AppError, ConflictError } = require('./errors');
const { appendAuditLog } = require('./hash');
const { applyOrderedWalletUpdates, insertWalletEntry, getUserWallet, getEscrowWallet, fingerprintRequest } = require('./walletOps');
const { settleListing } = require('./listingLifecycle');
const { orderPolicy, orderDeadline, afterHours } = require('./orderPolicy');
const { maybeFail } = require('./faultInjection');
const { referenceFields } = require('./disputeReference');
const { notify, onDisputeOpened, onOrderWaitConfirm } = require('./notifications');
// The transaction row is the first write for every order event, including audit-only
// events. CAS is the final authority even if another app process read an older row.
async function transitionOrder(txn,changes,{ at=nowIso() } = {}) {
  const allowed=new Set(['status','escrow_status','secured_at','draft_expires_at','cancelled_at','cancel_reason','seller_ack_at','inspection_due_at','inspected_at','inspected_by','received_confirmed_at','received_confirmed_by']);
  const keys=Object.keys(changes);
  if(keys.some(k=>!allowed.has(k)))throw new Error('Invalid order update');
  const op={
    SECURED:'lock',COMPLETED:'release',RELEASED:'admin-release',REFUNDED:'admin-refund'
  }[changes.status]||'any';
  maybeFail('before-status-change',op);
  const set=keys.map(k=>`${k}=?`).join(',');
  const r=await db.prepare(`UPDATE transactions SET ${set?set+',':''}version=version+1,updated_at=? WHERE id=? AND version=? AND status=? AND escrow_status=?`).run(...keys.map(k=>changes[k]),at,txn.id,txn.version,txn.status,txn.escrow_status);
  if(r.changes!==1)throw new ConflictError('TRANSACTION_VERSION_CONFLICT','Đơn vừa được xử lý ở nơi khác. Hãy tải lại trạng thái.');
  return db.prepare('SELECT * FROM transactions WHERE id=?').get(txn.id);
}

async function canReleaseBuyer(txn) {
  if(txn.status==='WAIT_CONFIRM'&&txn.escrow_status==='LOCKED')return true;
  if(txn.status!=='DISPUTED'||txn.escrow_status!=='FROZEN')return false;
  return !!(await db.prepare("SELECT 1 FROM disputes WHERE transaction_id=? AND type='INSPECTION_TIMEOUT' AND opened_by='SYSTEM' AND status='OPEN'").get(txn.id));
}

async function assertReleaseReady(txn,{ requireInspection=true } = {}) {
  if(!(await canReleaseBuyer(txn)))throw new AppError(409,'INVALID_STATE','Đơn không còn ở bước người mua được giải ngân.');
  if(requireInspection&&!txn.inspected_at)throw new AppError(409,'INSPECTION_REQUIRED','Hãy xác nhận đã kiểm hàng trước khi đồng ý giải ngân.');
}

function serializeDispute(d) {
  if(!d)return null;
  return {
    id:d.id,
    ...referenceFields(d),
    status:d.status,
    reason:d.reason,
    type:d.type,
    openedBy:d.opened_by,
    revision:d.revision,
    createdBy:d.created_by,
    adminId:d.admin_id,
    adminDecision:d.admin_decision,
    createdAt:d.created_at,
    resolvedAt:d.resolved_at,
    evidenceDueAt:d.evidence_due_at||afterHours(d.created_at,orderPolicy().evidenceHours),
    adminDueAt:d.admin_due_at||afterHours(d.created_at,orderPolicy().adminHours),
    buyerNeverConfirmedReceipt:!!d.buyer_never_confirmed_receipt
  };
}
// Caller owns db.transaction and authorizes the decision. This helper never accepts
// a caller-supplied amount or recipient. A single CAS precedes both money legs.
async function settleOrder(txn,{ decision,actorId=null,requestId,reason,listingOutcome,finalStatus,grant=null,dispute=null,review=null,at=nowIso(),action } = {}) {
  if(!['LOCKED','FROZEN'].includes(txn.escrow_status))throw new AppError(409,'INVALID_STATE','Khoản ký quỹ đã được xử lý.');
  const refund=decision==='REFUND';
  if(!refund&&decision!=='RELEASE')throw new Error('Invalid settlement');
  const target=finalStatus||(refund?'REFUNDED':'RELEASED');
  const current=await transitionOrder(txn,{
    status:target,escrow_status:refund?'REFUNDED':'RELEASED',...(reason?{
      cancel_reason:reason
    } : {}),...(target==='CANCELLED'?{
      cancelled_at:at
    } : {})
  },{
    at
  });
  if(dispute){
    const status=action==='ESCROW_RELEASED'?'RESOLVED_BY_BUYER_RELEASE':refund?'RESOLVED_REFUND':'RESOLVED_RELEASE';
    const claim=await db.prepare("UPDATE disputes SET status=?,admin_id=?,admin_decision=?,resolved_at=?,revision=revision+1 WHERE id=? AND status='OPEN' AND revision=?").run(status,action==='ESCROW_RELEASED'?null:actorId,decision,at,dispute.id,dispute.revision);
    if(claim.changes!==1)throw new AppError(409,'DISPUTE_NOT_OPEN','Hồ sơ vừa được xử lý ở nơi khác.');
  }
  const escrow=await getEscrowWallet(),recipient=await getUserWallet(refund?txn.buyer_id:txn.seller_id);
  if(!escrow||!recipient)throw new AppError(409,'WALLET_NOT_FOUND','Không tìm thấy ví đối ứng.');
  const operation=action==='ESCROW_RELEASED'?'release':refund?'admin-refund':'admin-release';
  const updated=await applyOrderedWalletUpdates([{
    wallet:escrow,availableDelta:0,lockedDelta:-txn.amount
  },{
    wallet:recipient,availableDelta:txn.amount,lockedDelta:0
  }],operation);
  const prefix=refund?'refund':'release';
  const fingerprint=fingerprintRequest({
    actorId,action:prefix.toUpperCase(),transactionId:txn.id,amount:txn.amount
  });
  await insertWalletEntry({
    walletId:escrow.id,
    transactionId:txn.id,
    requestId,
    entryType:refund?'ESCROW_REFUND_DEBIT':'ESCROW_RELEASE_DEBIT',
    availableDelta:0,
    lockedDelta:-txn.amount,
    walletAfter:updated.get(escrow.id),
    idempotencyKey:`${prefix}:${txn.id}:debit`,
    requestFingerprint:fingerprint,
    description:reason||decision
  });
  await insertWalletEntry({
    walletId:recipient.id,
    transactionId:txn.id,
    requestId,
    entryType:refund?'ESCROW_REFUND_CREDIT':'ESCROW_RELEASE_CREDIT',
    availableDelta:txn.amount,
    lockedDelta:0,
    walletAfter:updated.get(recipient.id),
    idempotencyKey:`${prefix}:${txn.id}:credit`,
    requestFingerprint:fingerprint,
    description:reason||decision
  });
  await settleListing(txn,listingOutcome||(refund?'REFUND':'RELEASE'));
  if(grant)await require('./reauth').markGrantUsed(grant.id);
  await appendAuditLog(db,{
    transactionId:txn.id,actorId,action:action||`ORDER_${decision}`,oldStatus:txn.status,newStatus:target,eventData:{
      amount:txn.amount,requestId,reason:reason||null,disputeId:dispute?.id||null,decision,...(review?{reviewId:review.id,reviewDigest:require('./disputeReview').reviewDigest(review)}:{})
    }
  });
  // Insert an encrypted outbox item atomically; the mail worker sends after commit.
  for(const userId of [txn.buyer_id,txn.seller_id]){
    const recipient=await db.prepare('SELECT id,email,email_verified_at FROM users WHERE id=?').get(userId);
    if(recipient?.email_verified_at)await require('./accountSecurity').queueMail(recipient,refund?'Đã hoàn tiền ký quỹ Enclave':'Đã hoàn tất giao dịch Enclave',`Đơn ${txn.id}: ${txn.item_name}. ${refund?'Đã hoàn':'Đã giải ngân'} ${txn.amount} VND ${refund?'về ví người mua':'cho người bán'}.`);
  }
  return current;
}

async function openOrderDispute(txn,{ type='DEFECT',actorId=null,reason,at=nowIso() } = {}) {
  const existing=await db.prepare('SELECT * FROM disputes WHERE transaction_id=?').get(txn.id);
  const system=actorId===null;
  if(existing){
    if(existing.status!=='OPEN'||txn.status!=='DISPUTED'||txn.escrow_status!=='FROZEN')throw new AppError(409,'DISPUTE_NOT_OPEN','Đơn đã được xử lý, không thể đóng băng tiền lại.');
    if(system)return {
      dispute:existing,created:false
    };
    await transitionOrder(txn,{}, {
      at
    });
    const openedBy=actorId===txn.buyer_id?'BUYER':'SELLER';
    const u=await db.prepare("UPDATE disputes SET revision=revision+1,type=?,opened_by=?,reason=?,created_by=? WHERE id=? AND status='OPEN' AND revision=?").run(existing.opened_by==='SYSTEM'?type:existing.type,existing.opened_by==='SYSTEM'?openedBy:existing.opened_by,existing.opened_by==='SYSTEM'?reason:existing.reason,existing.opened_by==='SYSTEM'?actorId:existing.created_by,existing.id,existing.revision);
    if(u.changes!==1)throw new ConflictError('DISPUTE_VERSION_CONFLICT');
    // Explicitly opening a complaint changes the financial workflow. Preserve the
    // original system explanation before replacing the case's headline reason.
    // Append-only messages use appendDisputeMessage and never enter this branch.
    let originMessageId=null;
    if(existing.opened_by==='SYSTEM'){
      originMessageId=uuid();
      await db.prepare('INSERT INTO dispute_messages(id,dispute_id,actor_id,message,created_at) VALUES(?,?,NULL,?,?)')
        .run(originMessageId,existing.id,existing.reason,at);
    }
    const messageId=uuid();
    await db.prepare('INSERT INTO dispute_messages(id,dispute_id,actor_id,message,created_at) VALUES(?,?,?,?,?)').run(messageId,existing.id,actorId,reason,at);
    await appendAuditLog(db,{
      transactionId:txn.id,actorId,action:existing.opened_by==='SYSTEM'?'SYSTEM_CASE_CONVERTED_TO_COMPLAINT':'DISPUTE_CONTENT_ADDED',oldStatus:txn.status,newStatus:txn.status,eventData:{
        disputeId:existing.id,messageId,originMessageId,originType:existing.opened_by==='SYSTEM'?existing.type:null
      }
    });
    return {
      dispute:await db.prepare('SELECT * FROM disputes WHERE id=?').get(existing.id),created:false,converted:existing.opened_by==='SYSTEM'
    };
  }
  if(!['SECURED','SHIPPING','WAIT_CONFIRM'].includes(txn.status)||txn.escrow_status!=='LOCKED')throw new AppError(409,'INVALID_STATE','Chỉ báo vấn đề khi đơn đang giữ tiền ký quỹ.');
  await transitionOrder(txn,{
    status:'DISPUTED',escrow_status:'FROZEN'
  },{
    at
  });
  const id=uuid(),openedBy=system?'SYSTEM':actorId===txn.buyer_id?'BUYER':'SELLER',p=orderPolicy();
  await db.prepare("INSERT INTO disputes(id,transaction_id,created_by,reason,status,type,opened_by,buyer_never_confirmed_receipt,evidence_due_at,admin_due_at,created_at) VALUES(?,?,?,?,'OPEN',?,?,?,?,?,?)").run(id,txn.id,actorId,reason,type,openedBy,txn.received_confirmed_by==='BUYER'?0:1,afterHours(at,p.evidenceHours),afterHours(at,p.adminHours),at);
  const created=await db.prepare('SELECT * FROM disputes WHERE id=?').get(id);
  await appendAuditLog(db,{
    transactionId:txn.id,
    actorId,
    action:type==='INSPECTION_TIMEOUT'?'INSPECTION_EXPIRED':'DISPUTE_OPENED',
    oldStatus:txn.status,
    newStatus:'DISPUTED',
    eventData:{
      disputeId:id,type,openedBy,automatic:system,caseCode:referenceFields(created).caseCode
    }
  });
  return {
    dispute:created,created:true
  };
}

// Supplementing a case is deliberately distinct from filing a complaint. In
// particular, a SYSTEM timeout remains eligible for the buyer's release path.
// Caller owns the database transaction; neither message text nor PII enters audit.
async function appendDisputeMessage(txn,{actorId,message,at=nowIso()}={}) {
  if(actorId!==txn.buyer_id&&actorId!==txn.seller_id)throw new AppError(403,'FORBIDDEN','Bạn không phải một bên của đơn hàng.');
  const dispute=await db.prepare('SELECT * FROM disputes WHERE transaction_id=?').get(txn.id);
  if(!dispute||dispute.status!=='OPEN'||txn.status!=='DISPUTED'||txn.escrow_status!=='FROZEN'){
    throw new AppError(409,'DISPUTE_NOT_OPEN','Hồ sơ không còn mở để bổ sung nội dung.');
  }
  await transitionOrder(txn,{}, {at});
  const changed=await db.prepare("UPDATE disputes SET revision=revision+1 WHERE id=? AND status='OPEN' AND revision=?")
    .run(dispute.id,dispute.revision);
  if(changed.changes!==1)throw new ConflictError('DISPUTE_VERSION_CONFLICT','Hồ sơ vừa thay đổi. Hãy tải lại.');
  const id=uuid();
  await db.prepare('INSERT INTO dispute_messages(id,dispute_id,actor_id,message,created_at) VALUES(?,?,?,?,?)')
    .run(id,dispute.id,actorId,message,at);
  await appendAuditLog(db,{
    transactionId:txn.id,actorId,action:'DISPUTE_CONTENT_ADDED',oldStatus:txn.status,newStatus:txn.status,
    eventData:{disputeId:dispute.id,messageId:id}
  });
  return {
    dispute:await db.prepare('SELECT * FROM disputes WHERE id=?').get(dispute.id),
    message:{id,actorId,message,createdAt:at}
  };
}

async function receiveOrder(txn,{ by='BUYER',at=nowIso() } = {}) {
  const p=orderPolicy();
  const current=await transitionOrder(txn,{
    status:'WAIT_CONFIRM',
    escrow_status:'LOCKED',
    received_confirmed_at:at,
    received_confirmed_by:by,
    inspection_due_at:afterHours(at,p.inspectionHours)
  },{
    at
  });
  await appendAuditLog(db,{
    transactionId:txn.id,
    actorId:by==='BUYER'?txn.buyer_id:null,
    action:by==='BUYER'?'BUYER_RECEIVED_PACKAGE':'SYSTEM_RECEIPT_WINDOW_STARTED',
    oldStatus:txn.status,
    newStatus:'WAIT_CONFIRM',
    eventData:{
      receivedConfirmedBy:by,inspectionDueAt:current.inspection_due_at
    }
  });
  return current;
}

async function reminders(txn,shipment,dispute,at) {
  const p=orderPolicy(),items=[];
  const hoursSince=from=>(new Date(at)-new Date(from))/3600000;
  if(txn.status==='SECURED'&&!txn.seller_ack_at&&!shipment){
    for(const h of [24,44])if(hoursSince(txn.secured_at||txn.updated_at)>=h&&h<p.sellerConfirmHours)items.push({
      kind:`seller-confirm-${h}`,userId:txn.seller_id,title:'Đơn hàng sắp hết hạn xác nhận'
    });
  }
  if(txn.status==='SHIPPING'&&shipment?.status==='ARRIVED'){
    for(const h of [24,60])if(hoursSince(shipment.arrived_at)>=h&&h<p.buyerReceiveHours)items.push({
      kind:`buyer-receive-${h}`,userId:txn.buyer_id,title:'Hãy xác nhận nhận kiện hoặc báo chưa nhận được hàng'
    });
  }
  if(txn.status==='WAIT_CONFIRM'&&txn.inspection_due_at&&new Date(txn.inspection_due_at)-new Date(at)<=12*3600000)items.push({
    kind:'inspection-due',userId:txn.buyer_id,title:'Sắp hết hạn kiểm hàng; bạn vẫn có thể báo vấn đề'
  });
  if(dispute?.status==='OPEN'){
    const evidenceDue=dispute.evidence_due_at||afterHours(dispute.created_at,p.evidenceHours);
    if(new Date(evidenceDue)-new Date(at)<=12*3600000){
      for(const userId of [txn.buyer_id,txn.seller_id])items.push({
        kind:`evidence-due-${userId}`,userId,title:'Hạn bổ sung mô tả cho hồ sơ tranh chấp sắp hoặc đã đến'
      });
    }
  }
  if(dispute?.status==='OPEN'&&(dispute.admin_due_at||afterHours(dispute.created_at,p.adminHours))<=at){
    const admins=await db.prepare("SELECT u.id FROM users u JOIN admin_provenance p ON p.user_id=u.id WHERE u.role='ADMIN' AND u.is_active=1").all();
    for(const a of admins)items.push({
      kind:`dispute-overdue-${a.id}`,userId:a.id,title:'Hồ sơ tranh chấp đã quá hạn xử lý'
    });
  }
  const result=[];
  for(const item of items){
    const r=await db.prepare('INSERT INTO order_reminders(order_id,kind,created_at) VALUES(?,?,?) ON CONFLICT DO NOTHING').run(txn.id,item.kind,at);
    if(r.changes)result.push({
      ...item,type:'ORDER_DEADLINE',key:`${txn.id}:${item.kind}`,transactionId:txn.id
    });
  }
  return result;
}

async function runOrderLifecycle({ now=Date.now() } = {}) {
  const date=new Date(now);
  if(!Number.isFinite(date.getTime()))throw new TypeError('Invalid lifecycle clock');
  const at=date.toISOString();
  const counts={
    cancelled:0,received:0,opened:0,reminders:0
  };
  const candidates=await db.prepare("SELECT id FROM transactions WHERE status IN ('CREATED','SECURED','SHIPPING','WAIT_CONFIRM','DISPUTED') ORDER BY created_at").all();
  for(const candidate of candidates){
    let event;
    try {
      event=await db.transaction(async()=>{
        const txn=await db.prepare('SELECT * FROM transactions WHERE id=?').get(candidate.id);
        if(!txn)return null;
        const shipment=await db.prepare('SELECT * FROM shipments WHERE transaction_id=?').get(txn.id),dispute=await db.prepare('SELECT * FROM disputes WHERE transaction_id=?').get(txn.id);
        const deadline=orderDeadline(txn,shipment);
        if(!deadline||deadline>at)return {
          items:await reminders(txn,shipment,dispute,at)
        };
        if(txn.status==='CREATED'){
          await transitionOrder(txn,{
            status:'CANCELLED',cancelled_at:at,cancel_reason:'draft_expired'
          },{
            at
          });
          await appendAuditLog(db,{
            transactionId:txn.id,
            actorId:null,
            action:'DRAFT_EXPIRED',
            oldStatus:'CREATED',
            newStatus:'CANCELLED',
            eventData:{
              deadline
            }
          });
          return {
            kind:'cancelled',txn
          };
        }
        if(txn.status==='SECURED'&&!shipment){
          const reason=txn.seller_ack_at?'seller_pack_timeout':'seller_confirm_timeout';
          await settleOrder(txn,{
            decision:'REFUND',
            requestId:`auto:${reason}:${txn.id}`,
            reason,
            listingOutcome:'CANCEL_BEFORE_SHIPMENT',
            finalStatus:'CANCELLED',
            at,
            action:'ORDER_EXPIRED_REFUND'
          });
          return {
            kind:'cancelled',txn
          };
        }
        if(txn.status==='SHIPPING'&&shipment?.status==='ARRIVED'){
          return {
            kind:'received',txn:await receiveOrder(txn,{
              by:'SYSTEM',at
            })
          };
        }
        const type=txn.status==='WAIT_CONFIRM'?'INSPECTION_TIMEOUT':'SHIPMENT_STALLED';
        const reason=type==='INSPECTION_TIMEOUT'?'Hết hạn kiểm hàng. Hệ thống giữ tiền để chờ người mua xác nhận hoặc quản trị viên phân xử.':'Vận chuyển đã quá hạn; cần quản trị viên kiểm tra. Tiền vẫn được bảo vệ.';
        const result=await openOrderDispute(txn,{
          type,reason,at
        });
        return {
          kind:result.created?'opened':null,txn,dispute:result.dispute
        };
      })();
    } catch(error){
      if(error.status===409)continue;
      throw error;
    }
    if(!event)continue;
    if(event.kind)counts[event.kind]++;
    // A failed notification must never cause the business transaction to run twice.
    try{
      if(event.kind==='opened')await onDisputeOpened(event.txn,null,event.dispute);
      if(event.kind==='received')await onOrderWaitConfirm(event.txn);
      if(event.kind==='cancelled')await notify([event.txn.buyer_id,event.txn.seller_id].map(userId=>({
        userId,type:'ORDER_CANCELLED',key:event.txn.id,transactionId:event.txn.id,title:'Đơn đã hết hạn và được hủy',body:event.txn.status==='CREATED'?'Đơn nháp không giữ tiền.':'Tiền ký quỹ đã hoàn về ví người mua.'
      })));
      if(event.items?.length){
        counts.reminders+=event.items.length;
        await notify(event.items);
      }
    } catch{
      console.error('[order-lifecycle] notification failed after commit');
    }
  }
  return counts;
}

function startOrderLifecycleWorker(){
  const seconds=Number(process.env.ORDER_LIFECYCLE_WORKER_SECONDS||60);
  if(!Number.isFinite(seconds)||seconds<0)throw new Error('Invalid ORDER_LIFECYCLE_WORKER_SECONDS');
  if(seconds===0)return null;
  let busy=false;
  const tick=async()=>{
    if(busy)return;
    busy=true;
    try{
      await runOrderLifecycle();
    } catch{
      console.error('[order-lifecycle] maintenance failed');
    } finally{
      busy=false;
    }
  };
  void tick();
  const timer=setInterval(tick,seconds*1000);
  timer.unref();
  return timer;
}
module.exports={
  transitionOrder,canReleaseBuyer,assertReleaseReady,serializeDispute,settleOrder,openOrderDispute,appendDisputeMessage,receiveOrder,runOrderLifecycle,startOrderLifecycleWorker
};
