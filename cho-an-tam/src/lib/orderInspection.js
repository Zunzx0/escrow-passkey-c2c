// Expiry freezes escrow for human adjudication. It never releases money.
const {db,uuid,nowIso}=require('../db');
const {applyTransactionStatus}=require('./walletOps');
const {appendAuditLog}=require('./hash');
const {onDisputeOpened}=require('./notifications');
async function expireInspections(){
  const candidates=await db.prepare("SELECT id FROM transactions WHERE status='WAIT_CONFIRM' AND escrow_status='LOCKED' AND inspection_due_at<=?").all(nowIso());
  let opened=0;
  for(const candidate of candidates){
    const changed=await db.transaction(async()=>{
      const txn=await db.prepare('SELECT * FROM transactions WHERE id=?').get(candidate.id);
      if(!txn||txn.status!=='WAIT_CONFIRM'||txn.escrow_status!=='LOCKED'||!txn.inspection_due_at||txn.inspection_due_at>nowIso())return null;
      const reason='Hệ thống tự mở tranh chấp vì đã hết thời hạn kiểm tra hàng mà chưa xác nhận. Cần quản trị viên xem xét; tiền chưa được giải ngân.';
      await db.prepare("INSERT INTO disputes(id,transaction_id,created_by,reason,status,created_at) VALUES(?,?,?,?,'OPEN',?)").run(uuid(),txn.id,txn.buyer_id,reason,nowIso());
      await applyTransactionStatus(txn,{status:'DISPUTED',escrowStatus:'FROZEN'});
      await appendAuditLog(db,{transactionId:txn.id,actorId:null,action:'INSPECTION_EXPIRED',oldStatus:'WAIT_CONFIRM',newStatus:'DISPUTED',eventData:{reason,automatic:true}});
      return txn;
    })();
    if(changed){opened++;await onDisputeOpened(changed,changed.buyer_id);}
  }
  return {opened};
}
function startInspectionWorker(){
  const interval=Number(process.env.ORDER_INSPECTION_INTERVAL_MS||10000);if(!Number.isFinite(interval)||interval<=0)return null;
  let busy=false;
  async function tick(){if(busy)return;busy=true;try{await expireInspections();}catch{console.error('[order-inspection] maintenance failed');}finally{busy=false;}}
  const timer=setInterval(tick,interval);timer.unref();tick();return timer;
}
module.exports={expireInspections,startInspectionWorker};
