'use strict';
const crypto = require('node:crypto');
const { AppError } = require('./errors');

function migrateSqlite(db) {
  return db.exec(`CREATE TABLE IF NOT EXISTS dispute_reviews (
    id TEXT PRIMARY KEY, dispute_id TEXT NOT NULL REFERENCES disputes(id),
    admin_id TEXT NOT NULL REFERENCES users(id),
    decision TEXT NOT NULL CHECK(decision IN ('REFUND','RELEASE','REQUEST_MORE')),
    basis TEXT NOT NULL CHECK(length(basis) BETWEEN 30 AND 2000),
    reviewed INTEGER NOT NULL CHECK(reviewed=1),
    receipt_acknowledged INTEGER NOT NULL CHECK(receipt_acknowledged IN (0,1)),
    dispute_revision INTEGER NOT NULL, order_version INTEGER NOT NULL, created_at TEXT NOT NULL,
    UNIQUE(dispute_id,dispute_revision));
    CREATE INDEX IF NOT EXISTS dispute_reviews_case ON dispute_reviews(dispute_id,dispute_revision DESC);
    CREATE TRIGGER IF NOT EXISTS dispute_reviews_no_update BEFORE UPDATE ON dispute_reviews
      BEGIN SELECT RAISE(ABORT,'dispute_reviews is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS dispute_reviews_no_delete BEFORE DELETE ON dispute_reviews
      BEGIN SELECT RAISE(ABORT,'dispute_reviews is append-only'); END;`);
}
function serializeReview(r) {
  return r ? {id:r.id,adminId:r.admin_id,decision:r.decision,basis:r.basis,
    reviewed:r.reviewed===1,receiptAcknowledged:r.receipt_acknowledged===1,
    disputeRevision:r.dispute_revision,orderVersion:r.order_version,createdAt:r.created_at} : null;
}
async function latestReview(db, disputeId) {
  return db.prepare('SELECT * FROM dispute_reviews WHERE dispute_id=? ORDER BY dispute_revision DESC LIMIT 1').get(disputeId);
}
function reviewDigest(r) {
  return crypto.createHash('sha256').update(JSON.stringify(serializeReview(r))).digest('hex');
}
function validateReview(body, txn) {
  const fields = {}, decision = body.decision;
  const basis = typeof body.basis==='string' ? body.basis.trim() : '';
  if(!['REFUND','RELEASE','REQUEST_MORE'].includes(decision)) fields.decision='Hãy chọn cách xử lý hồ sơ.';
  if(basis.length<30 || basis.length>2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(basis)) fields.basis='Ghi thông tin đã xem và lý do xử lý, từ 30 đến 2.000 ký tự.';
  if(body.reviewed!==true) fields.reviewed='Hãy đọc hồ sơ và xác nhận đã xem thông tin hai bên.';
  if(decision!=='REQUEST_MORE' && txn.received_confirmed_by!=='BUYER' && body.receiptAcknowledged!==true) fields.receiptAcknowledged='Hồ sơ chưa có xác nhận nhận hàng của người mua. Hãy kiểm tra thông tin giao nhận và xác nhận đã hiểu điểm này.';
  if(!Number.isSafeInteger(body.expectedDisputeRevision)||!Number.isSafeInteger(body.expectedOrderVersion)) fields.version='Hãy tải lại hồ sơ trước khi lưu.';
  if(Object.keys(fields).length) {const e=new AppError(400,'VALIDATION_ERROR','Chưa ghi đủ căn cứ xử lý hồ sơ.');e.fields=fields;throw e;}
  return {decision,basis,receiptAcknowledged:body.receiptAcknowledged===true};
}
async function requireReview(db, dispute, txn, actorId, decision, reviewId) {
  if(dispute.admin_id!==actorId) throw new AppError(409,'DISPUTE_CLAIM_REQUIRED','Hãy nhận xử lý hồ sơ trước khi đưa ra quyết định.');
  const r=await latestReview(db,dispute.id);
  if(!r || r.decision==='REQUEST_MORE') throw new AppError(409,'DISPUTE_REVIEW_REQUIRED','Hãy xem hồ sơ và lưu căn cứ quyết định trước. Tiền vẫn được giữ.');
  if(r.id!==reviewId || r.admin_id!==actorId || r.decision!==decision || r.dispute_revision!==dispute.revision || r.order_version!==txn.version || r.reviewed!==1 || (txn.received_confirmed_by!=='BUYER' && r.receipt_acknowledged!==1)) throw new AppError(409,'DISPUTE_REVIEW_STALE','Hồ sơ hoặc quyết định đã thay đổi. Hãy xem lại thông tin và lưu căn cứ mới; tiền vẫn được giữ.');
  return r;
}
module.exports={migrateSqlite,serializeReview,latestReview,reviewDigest,validateReview,requireReview};
