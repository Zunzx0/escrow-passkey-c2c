'use strict';
const crypto=require('crypto');
const {db,uuid,nowIso}=require('../db');
const {AppError}=require('./errors');
const {appendAuditLog}=require('./hash');
const {getMediaStorage}=require('./mediaStorage');
const {normalizeImage,MAX_OUTPUT_BYTES}=require('./mediaImage');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OWNER_QUOTA=32*1024*1024,GLOBAL_QUOTA=128*1024*1024;
const STAGING_MS=24*3600*1000,STALE_UPLOAD_MS=5*60*1000,MAX_STAGED=12,MAX_LISTING_IMAGES=6;
// Orders in these states are, or were, reserved/sold: their listing gallery is immutable.
const RESERVING_ORDER_STATUSES=['SECURED','SHIPPING','WAIT_CONFIRM','DISPUTED','COMPLETED','RELEASED'];
function digest(buffer){return crypto.createHash('sha256').update(buffer).digest('hex');}
function iso(ms){return new Date(ms).toISOString();}
function notFound(){return new AppError(404,'MEDIA_NOT_FOUND','Không tìm thấy ảnh.');}
// uploadedBy + createdAt describe who uploaded the file and when. They are NOT proof of
// when/where a photo was captured or that the object shown is authentic.
function metadata(asset){
  return {id:asset.id,url:`/api/media/images/${asset.id}`,width:asset.width,height:asset.height,bytes:asset.bytes,purpose:asset.purpose,createdAt:asset.created_at,uploadedBy:asset.owner_id};
}
// undefined => key omitted (caller preserves state). Anything else must be a valid list.
function readImageIds(value,{max=MAX_LISTING_IMAGES}={}){
  if(value===undefined)return null;
  if(!Array.isArray(value)||value.length>max||value.some(id=>typeof id!=='string'||!UUID.test(id))||new Set(value).size!==value.length){
    throw new AppError(400,'MEDIA_IMAGE_IDS_INVALID',`Chọn tối đa ${max} ảnh hợp lệ, không trùng nhau.`);
  }
  return value;
}
async function assertEvidenceTarget(user,transactionId){
  if(typeof transactionId!=='string'||!UUID.test(transactionId))throw new AppError(400,'MEDIA_TARGET_INVALID','Đơn hàng nhận bằng chứng không hợp lệ.');
  const txn=await db.prepare('SELECT * FROM transactions WHERE id=?').get(transactionId);
  if(!txn)throw new AppError(404,'TRANSACTION_NOT_FOUND','Không tìm thấy đơn hàng.');
  if(![txn.buyer_id,txn.seller_id].includes(user.id))throw new AppError(403,'FORBIDDEN','Bạn không phải một bên của đơn hàng.');
  if(['SECURED','SHIPPING','WAIT_CONFIRM'].includes(txn.status)&&txn.escrow_status==='LOCKED')return txn;
  const open=txn.status==='DISPUTED'&&txn.escrow_status==='FROZEN'&&await db.prepare("SELECT 1 FROM disputes WHERE transaction_id=? AND status='OPEN'").get(txn.id);
  if(!open)throw new AppError(409,'MEDIA_TARGET_CLOSED','Đơn không còn ở bước nhận bằng chứng.');
  return txn;
}
async function assertUploadPurpose(user,purpose,transactionId){
  if(!['LISTING','EVIDENCE'].includes(purpose))throw new AppError(400,'MEDIA_PURPOSE_INVALID','Mục đích tải ảnh không hợp lệ.');
  if(purpose==='LISTING'){
    if(user.role!=='SELLER')throw new AppError(403,'FORBIDDEN','Chỉ người bán được tải ảnh sản phẩm.');
    if(transactionId)throw new AppError(400,'MEDIA_TARGET_INVALID','Ảnh sản phẩm không được gắn với yêu cầu bằng chứng.');
  }else await assertEvidenceTarget(user,transactionId);
}
async function limitUploads(userId){
  const at=nowIso(),window=at.slice(0,16);
  const accepted=await db.transaction(async()=>{
    await db.prepare('INSERT INTO media_upload_rates(user_id,window_start,attempts) VALUES(?,?,0) ON CONFLICT DO NOTHING').run(userId,window);
    return db.prepare('UPDATE media_upload_rates SET window_start=?,attempts=CASE WHEN window_start=? THEN attempts+1 ELSE 1 END WHERE user_id=? AND (window_start<>? OR attempts<18)').run(window,window,userId,window);
  })();
  if(accepted.changes!==1)throw new AppError(429,'MEDIA_UPLOAD_RATE_LIMIT','Bạn tải ảnh quá nhanh. Hãy thử lại sau một phút.');
}
// Same owner+requestId must mean the same raw bytes, purpose and target. Returns the
// action: 'replay' (finished/pending result), 'retry' (a FAILED attempt may be re-reserved).
function assertReplay(asset,{purpose,transactionId,inputHash}){
  if(asset.purpose!==purpose||(asset.transaction_id||null)!==(transactionId||null)||asset.input_sha256!==inputHash){
    throw new AppError(409,'MEDIA_REQUEST_REUSED','Mã tải ảnh đã dùng cho ảnh hoặc ngữ cảnh khác.');
  }
  if(asset.status==='UPLOADING')throw new AppError(409,'MEDIA_UPLOAD_IN_PROGRESS','Ảnh đang được xử lý. Hãy kiểm tra lại sau.');
  if(asset.status==='EXPIRED'||(asset.status==='STAGED'&&asset.expires_at<=nowIso()))throw new AppError(410,'MEDIA_UPLOAD_EXPIRED','Ảnh chờ đã hết hạn. Hãy chọn ảnh và tải lại với mã mới.');
  return asset.status==='FAILED'?'retry':'replay';
}
const SUM_SQL="SELECT COALESCE(SUM(CASE WHEN status='UPLOADING' OR status IN ('FAILED','EXPIRED') THEN reserved_bytes ELSE bytes END),0) AS total FROM media_assets WHERE (status IN ('UPLOADING','STAGED','ATTACHED') OR (status IN ('FAILED','EXPIRED') AND storage_deleted_at IS NULL))";
// Do not count a key twice while its current asset row already reserves it. A
// rotated old key is independent storage debt, even if its asset now points at B.
const CLEANUP_DEBT_SQL="SELECT COALESCE(SUM(j.reserved_bytes),0) AS total FROM media_cleanup_jobs j WHERE j.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM media_assets a WHERE a.storage_key=j.storage_key AND (a.status IN ('UPLOADING','STAGED','ATTACHED') OR (a.status IN ('FAILED','EXPIRED') AND a.storage_deleted_at IS NULL)))";
async function uploadMedia({user,purpose,transactionId=null,requestId,buffer,mime}){
  const inputHash=digest(buffer),store=await getMediaStorage();
  const reserved=await db.transaction(async()=>{
    const existing=await db.prepare('SELECT * FROM media_assets WHERE owner_id=? AND request_id=?').get(user.id,requestId);
    let action='new';
    if(existing){
      action=assertReplay(existing,{purpose,transactionId,inputHash});
      if(action==='replay')return {asset:existing,replay:true};
      // A FAILED attempt keeps its requestId so a retry cannot duplicate work. The old
      // object must be confirmed deleted first, otherwise it could be deleted under us.
      if(!existing.storage_deleted_at)throw new AppError(409,'MEDIA_CLEANUP_PENDING','Lần tải trước đang được dọn. Hãy thử lại sau ít giây.');
    }
    await assertUploadPurpose(user,purpose,transactionId);
    // One row is rewritten per reservation, so concurrent reservations serialize and the
    // staging-count and byte-quota checks below cannot both pass on stale counts.
    await db.prepare("INSERT INTO media_quota_locks(id,version) VALUES('GLOBAL',0) ON CONFLICT DO NOTHING").run();
    await db.prepare("UPDATE media_quota_locks SET version=version+1 WHERE id='GLOBAL'").run();
    const pending=await db.prepare("SELECT COUNT(*) AS n FROM media_assets WHERE owner_id=? AND status IN ('UPLOADING','STAGED')").get(user.id);
    if(pending.n>=MAX_STAGED)throw new AppError(409,'MEDIA_STAGING_LIMIT','Bạn đang có 12 ảnh chưa gắn. Hãy dùng hoặc chờ ảnh cũ hết hạn.');
    const owner=await db.prepare(SUM_SQL+' AND owner_id=?').get(user.id),global=await db.prepare(SUM_SQL).get();
    const ownerDebt=await db.prepare(CLEANUP_DEBT_SQL+' AND j.owner_id=?').get(user.id),globalDebt=await db.prepare(CLEANUP_DEBT_SQL).get();
    if(owner.total+ownerDebt.total+MAX_OUTPUT_BYTES>OWNER_QUOTA)throw new AppError(413,'MEDIA_OWNER_QUOTA','Dung lượng ảnh của tài khoản đã đạt giới hạn 32 MiB.');
    if(global.total+globalDebt.total+MAX_OUTPUT_BYTES>GLOBAL_QUOTA)throw new AppError(503,'MEDIA_GLOBAL_QUOTA','Kho ảnh đã đạt giới hạn dung lượng. Hãy thử lại sau.');
    const at=nowIso(),expiresAt=iso(Date.now()+STAGING_MS);
    if(action==='retry'){
      const id=existing.id,key=`${purpose.toLowerCase()}/${uuid()}.webp`;
      const changed=await db.prepare("UPDATE media_assets SET status='UPLOADING',storage_key=?,storage_deleted_at=NULL,reserved_bytes=?,bytes=0,width=NULL,height=NULL,output_sha256=NULL,expires_at=?,updated_at=?,version=version+1 WHERE id=? AND status='FAILED' AND version=? AND storage_deleted_at IS NOT NULL").run(key,MAX_OUTPUT_BYTES,expiresAt,at,id,existing.version);
      if(changed.changes!==1)throw new AppError(409,'MEDIA_UPLOAD_IN_PROGRESS','Ảnh đang được xử lý. Hãy kiểm tra lại sau.');
      return {asset:await db.prepare('SELECT * FROM media_assets WHERE id=?').get(id),replay:false};
    }
    const id=uuid(),key=`${purpose.toLowerCase()}/${id}.webp`;
    await db.prepare("INSERT INTO media_assets(id,owner_id,purpose,transaction_id,request_id,input_sha256,reserved_bytes,status,storage_key,created_at,expires_at,updated_at) VALUES(?,?,?,?,?,?,?,'UPLOADING',?,?,?,?)").run(id,user.id,purpose,transactionId,requestId,inputHash,MAX_OUTPUT_BYTES,key,at,expiresAt,at);
    return {asset:await db.prepare('SELECT * FROM media_assets WHERE id=?').get(id),replay:false};
  })();
  if(reserved.replay)return {asset:metadata(reserved.asset),created:false};
  const asset=reserved.asset;let attempted=false;
  try{
    const image=await normalizeImage(buffer,mime);
    // Storage is outside any DB transaction. The UPLOADING row reserves the quota and
    // owns the key; only the finalize CAS below can publish the asset.
    attempted=true;
    await store.put(asset.storage_key,image.buffer);
    const completed=await db.transaction(async()=>{
      await assertUploadPurpose(user,purpose,transactionId);
      const at=nowIso();
      const changed=await db.prepare("UPDATE media_assets SET status='STAGED',output_sha256=?,width=?,height=?,bytes=?,updated_at=?,version=version+1 WHERE id=? AND owner_id=? AND status='UPLOADING' AND version=? AND expires_at>?").run(digest(image.buffer),image.width,image.height,image.bytes,at,asset.id,user.id,asset.version,at);
      if(changed.changes!==1)throw new AppError(409,'MEDIA_UPLOAD_EXPIRED','Lần tải ảnh đã đóng trước khi hoàn tất.');
      return db.prepare('SELECT * FROM media_assets WHERE id=?').get(asset.id);
    })();
    return {asset:metadata(completed),created:true};
  }catch(error){
    const outcome=await abandonUpload(asset,store,attempted);
    if(outcome)return {asset:metadata(outcome),created:true};
    if(error instanceof AppError)throw error;
    throw new AppError(503,'MEDIA_STORAGE_UNAVAILABLE','Không lưu được ảnh. Hãy thử lại sau.');
  }
}
// Close the reservation FIRST (CAS on UPLOADING+version). Only the winner of that CAS may
// delete the object; if the finalize actually committed, the published asset is kept
// and returned, so an ambiguous commit error can never delete a referenced object.
async function abandonUpload(asset,store,attempted){
  let closed=false;
  try{
    const r=await db.prepare("UPDATE media_assets SET status='FAILED',updated_at=?,version=version+1 WHERE id=? AND storage_key=? AND status='UPLOADING' AND version=?").run(nowIso(),asset.id,asset.storage_key,asset.version);
    closed=r.changes===1;
  }catch{return null;/* DB unavailable: stale-reservation cleanup closes it later */}
  if(!closed){
    try{
      const row=await db.prepare('SELECT * FROM media_assets WHERE id=?').get(asset.id);
      if(row&&row.storage_key===asset.storage_key&&['STAGED','ATTACHED'].includes(row.status))return row;
    }catch{/* outcome unknown; the client reconciles with GET /uploads/:requestId */}
  }
  if(attempted){
    // A successful/lost-response PUT can outlive a cleanup that already retired
    // this key. Reopen a durable, key-scoped obligation before compensating it.
    // It must survive even when a retry has rotated the asset row to another key.
    try{
      const compensation=await registerLatePutCleanup(asset);
      if(compensation.job){try{await retireCleanupJob(compensation.job,store,nowIso());}catch{/* durable job keeps quota and is retried */}}
      return compensation.published||null;
    }catch{return null;/* the current reservation remains for recovery if DB is unavailable */}
  }
  if(closed){
    try{
      // The close CAS above advances exactly this attempt's version. A parallel
      // cleanup may have finished and a retry may already own a different key;
      // a late DELETE acknowledgement must not tombstone that newer attempt.
      await markAttemptDeleted({...asset,version:asset.version+1},nowIso());
    }catch{/* cleanup retries */}
  }
  return null;
}
async function registerLatePutCleanup(asset){
  return db.transaction(async()=>{
    const row=await db.prepare('SELECT * FROM media_assets WHERE id=?').get(asset.id);
    if(!row)throw new AppError(503,'MEDIA_STORAGE_UNAVAILABLE','Không đối soát được lần tải ảnh.');
    if(row.storage_key===asset.storage_key&&['STAGED','ATTACHED'].includes(row.status))return {published:row};
    if(row.storage_key===asset.storage_key&&row.status==='UPLOADING')return {};
    let assetVersion=-1;
    const at=nowIso();
    if(row.storage_key===asset.storage_key){
      const reopened=await db.prepare(`UPDATE media_assets SET storage_deleted_at=NULL,version=version+1,updated_at=? WHERE id=? AND storage_key=? AND version=? AND status IN ('FAILED','EXPIRED') AND ${UNREFERENCED}`)
        .run(at,row.id,asset.storage_key,row.version);
      if(reopened.changes!==1)throw new AppError(409,'MEDIA_ASSET_CHANGED','Lần tải ảnh vừa thay đổi.');
      assetVersion=row.version+1;
    }
    await db.prepare(`INSERT INTO media_cleanup_jobs(storage_key,asset_id,owner_id,asset_version,reserved_bytes,created_at,updated_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(storage_key) DO UPDATE SET asset_version=excluded.asset_version,deleted_at=NULL,updated_at=excluded.updated_at,version=media_cleanup_jobs.version+1`)
      .run(asset.storage_key,asset.id,asset.owner_id,assetVersion,MAX_OUTPUT_BYTES,at,at);
    const job=await db.prepare('SELECT * FROM media_cleanup_jobs WHERE storage_key=?').get(asset.storage_key);
    return {job,published:row.storage_key!==asset.storage_key&&['STAGED','ATTACHED'].includes(row.status)?row:null};
  })();
}
async function lookupUpload(userId,requestId){
  const row=await db.prepare('SELECT * FROM media_assets WHERE owner_id=? AND request_id=?').get(userId,requestId);
  if(!row)throw notFound();
  if(row.status==='FAILED')throw new AppError(410,'MEDIA_UPLOAD_FAILED','Lần tải ảnh không thành công. Có thể thử lại với cùng mã và cùng tệp.');
  if(row.status==='EXPIRED'||(row.status==='STAGED'&&row.expires_at<=nowIso()))throw new AppError(410,'MEDIA_UPLOAD_EXPIRED','Lần tải ảnh đã đóng. Hãy tải lại ảnh với mã mới.');
  return {asset:{...metadata(row),status:row.status},pending:row.status==='UPLOADING'};
}
async function listingImages(listingId){
  if(!listingId)return [];
  return (await db.prepare("SELECT a.* FROM listing_media m JOIN media_assets a ON a.id=m.asset_id WHERE m.listing_id=? AND a.status='ATTACHED' ORDER BY m.position").all(listingId)).map(metadata);
}
// One query for many listings (list/card views); order preserved, first image is the cover.
async function imagesForListings(listingIds){
  const map=new Map();
  for(let i=0;i<listingIds.length;i+=200){
    const chunk=listingIds.slice(i,i+200);
    if(!chunk.length)continue;
    const rows=await db.prepare(`SELECT m.listing_id AS gallery_listing_id,a.* FROM listing_media m JOIN media_assets a ON a.id=m.asset_id WHERE a.status='ATTACHED' AND m.listing_id IN (${chunk.map(()=>'?').join(',')}) ORDER BY m.listing_id,m.position`).all(...chunk);
    for(const row of rows){
      if(!map.has(row.gallery_listing_id))map.set(row.gallery_listing_id,[]);
      map.get(row.gallery_listing_id).push(metadata(row));
    }
  }
  return map;
}
async function transactionImages(txn){
  // A draft has no snapshot yet and shows the live gallery; from LOCK on, only the frozen
  // order snapshot is used, never a join against the listing's current gallery.
  if(txn.escrow_status==='NONE'&&txn.status==='CREATED')return listingImages(txn.listing_id);
  return (await db.prepare("SELECT a.* FROM order_media_snapshot s JOIN media_assets a ON a.id=s.asset_id WHERE s.transaction_id=? AND a.status='ATTACHED' ORDER BY s.position").all(txn.id)).map(metadata);
}
async function isClaimedAdmin(user,dispute){
  if(!user||user.role!=='ADMIN'||!dispute||dispute.admin_id!==user.id)return false;
  const txn=await db.prepare('SELECT buyer_id,seller_id FROM transactions WHERE id=?').get(dispute.transaction_id);
  if(!txn||[txn.buyer_id,txn.seller_id].includes(user.id))return false;
  return !!(await db.prepare("SELECT 1 FROM audit_logs WHERE transaction_id=? AND actor_id=? AND action='DISPUTE_CLAIMED' LIMIT 1").get(dispute.transaction_id,user.id));
}
// Order photos (snapshot or draft gallery) for a viewer who may see this order: a party,
// or the independent admin who explicitly claimed its dispute. Everyone else gets [].
async function orderImagesFor(txn,user){
  if(!user)return [];
  if(user.id===txn.buyer_id||user.id===txn.seller_id)return transactionImages(txn);
  if(user.role==='ADMIN'){
    const dispute=await db.prepare('SELECT * FROM disputes WHERE transaction_id=?').get(txn.id);
    if(dispute&&await isClaimedAdmin(user,dispute))return transactionImages(txn);
  }
  return [];
}
async function detachListingAsset(assetId){
  // A referenced image is never deleted: images frozen in an order snapshot or attached to
  // a dispute stay ATTACHED forever; others return to 24h staging and may be re-used.
  await db.prepare("UPDATE media_assets SET status='STAGED',expires_at=?,version=version+1,updated_at=? WHERE id=? AND purpose='LISTING' AND status='ATTACHED' AND NOT EXISTS(SELECT 1 FROM order_media_snapshot s WHERE s.asset_id=media_assets.id) AND NOT EXISTS(SELECT 1 FROM dispute_media d WHERE d.asset_id=media_assets.id)").run(iso(Date.now()+STAGING_MS),nowIso(),assetId);
}
// Caller owns the DB transaction and has already CAS-bumped listings.version (so any
// LOCK authorization built from the older version is stale) in that same transaction.
async function attachListingImages(listing,userId,ids){
  if(ids===null||ids===undefined)return;
  if(listing.seller_id!==userId)throw new AppError(403,'FORBIDDEN');
  if(!['AVAILABLE','PENDING_SELLER_REVIEW'].includes(listing.status))throw new AppError(409,'MEDIA_LISTING_LOCKED','Không thể đổi ảnh khi sản phẩm đang có đơn giữ tiền hoặc đã bán.');
  const open=await db.prepare(`SELECT 1 FROM transactions WHERE listing_id=? AND status IN (${RESERVING_ORDER_STATUSES.map(()=>'?').join(',')}) LIMIT 1`).get(listing.id,...RESERVING_ORDER_STATUSES);
  if(open)throw new AppError(409,'MEDIA_LISTING_LOCKED','Không thể đổi ảnh của sản phẩm đang có đơn mua.');
  const assets=[],at=nowIso();
  for(const id of ids){
    const asset=await db.prepare('SELECT * FROM media_assets WHERE id=?').get(id);
    if(!asset||asset.owner_id!==userId||asset.purpose!=='LISTING'||!['STAGED','ATTACHED'].includes(asset.status))throw new AppError(403,'MEDIA_NOT_OWNED','Chỉ được dùng ảnh sản phẩm do chính bạn tải lên.');
    if(asset.status==='STAGED'&&asset.expires_at<=at)throw new AppError(410,'MEDIA_UPLOAD_EXPIRED','Ảnh chờ đã hết hạn. Hãy tải lại.');
    const other=await db.prepare('SELECT listing_id FROM listing_media WHERE asset_id=?').get(id);
    if(other&&other.listing_id!==listing.id)throw new AppError(409,'MEDIA_ALREADY_ATTACHED','Ảnh đã gắn với tin khác.');
    assets.push(asset);
  }
  const previous=(await db.prepare('SELECT asset_id FROM listing_media WHERE listing_id=?').all(listing.id)).map(r=>r.asset_id);
  await db.prepare('DELETE FROM listing_media WHERE listing_id=?').run(listing.id);
  const keep=new Set(ids);
  for(const old of previous)if(!keep.has(old))await detachListingAsset(old);
  for(let i=0;i<assets.length;i++){
    const asset=assets[i];
    const changed=await db.prepare("UPDATE media_assets SET status='ATTACHED',version=version+1,updated_at=? WHERE id=? AND owner_id=? AND version=? AND (status='ATTACHED' OR (status='STAGED' AND expires_at>?))").run(nowIso(),asset.id,userId,asset.version,at);
    if(changed.changes!==1)throw new AppError(409,'MEDIA_ASSET_CHANGED','Ảnh vừa được dùng ở thao tác khác.');
    await db.prepare('INSERT INTO listing_media(listing_id,asset_id,position) VALUES(?,?,?)').run(listing.id,asset.id,i);
  }
}
// Used when a listing with no order history is deleted: images go back to staging
// (and are removed by cleanup after expiry) unless a snapshot/dispute references them.
async function releaseListingImages(listingId){
  const previous=(await db.prepare('SELECT asset_id FROM listing_media WHERE listing_id=?').all(listingId)).map(r=>r.asset_id);
  await db.prepare('DELETE FROM listing_media WHERE listing_id=?').run(listingId);
  for(const id of previous)await detachListingAsset(id);
}
// Called inside the LOCK transaction, after the listing CAS succeeded. Freezes the IDs and
// per-image hashes the buyer is paying for. Returns a digest for the audit entry.
async function snapshotOrderImages(txn){
  const empty={count:0,sha256:null,images:[]};
  if(!txn.listing_id)return empty;
  const assets=await db.prepare("SELECT a.id,a.output_sha256,m.position FROM listing_media m JOIN media_assets a ON a.id=m.asset_id WHERE m.listing_id=? AND a.status='ATTACHED' ORDER BY m.position").all(txn.listing_id);
  if(!assets.length)return empty;
  const images=[];
  for(let i=0;i<assets.length;i++){
    const asset=assets[i];
    await db.prepare('INSERT INTO order_media_snapshot(transaction_id,asset_id,position,sha256) VALUES(?,?,?,?)').run(txn.id,asset.id,i,asset.output_sha256);
    images.push({id:asset.id,sha256:asset.output_sha256});
  }
  return {count:images.length,sha256:digest(Buffer.from(JSON.stringify(images))),images};
}
// Caller owns the DB transaction AND has already bumped dispute.revision + orders.version
// (openOrderDispute / appendDisputeMessage). Attaching alone never changes status, type,
// decision or money. Append-only: no replace or delete path exists.
async function attachEvidenceImages(txn,dispute,actorId,ids){
  if(!ids?.length)return {attached:0};
  const current=await db.prepare('SELECT * FROM transactions WHERE id=?').get(txn.id);
  const profile=await db.prepare('SELECT * FROM disputes WHERE id=? AND transaction_id=?').get(dispute.id,txn.id);
  if(!current||![current.buyer_id,current.seller_id].includes(actorId))throw new AppError(403,'FORBIDDEN');
  if(current.status!=='DISPUTED'||current.escrow_status!=='FROZEN'||profile?.status!=='OPEN')throw new AppError(409,'DISPUTE_NOT_OPEN','Hồ sơ không còn nhận thêm ảnh.');
  const assets=[],at=nowIso();
  for(const id of ids){
    const a=await db.prepare('SELECT * FROM media_assets WHERE id=?').get(id);
    if(!a||a.owner_id!==actorId||a.purpose!=='EVIDENCE'||a.transaction_id!==txn.id)throw new AppError(403,'MEDIA_NOT_OWNED','Ảnh bằng chứng phải do bạn tải lên cho đúng đơn này.');
    const existing=await db.prepare('SELECT dispute_id FROM dispute_media WHERE asset_id=?').get(id);
    if(existing?.dispute_id===dispute.id)continue;
    if(a.status!=='STAGED'||a.expires_at<=at)throw new AppError(409,'MEDIA_ALREADY_ATTACHED','Ảnh không còn ở bước chờ gắn vào hồ sơ.');
    assets.push(a);
  }
  if(!assets.length)return {attached:0};
  const count=await db.prepare('SELECT COUNT(*) AS total,COALESCE(SUM(CASE WHEN actor_id=? THEN 1 ELSE 0 END),0) AS mine FROM dispute_media WHERE dispute_id=?').get(actorId,dispute.id);
  if(count.total+assets.length>12||count.mine+assets.length>6)throw new AppError(409,'MEDIA_EVIDENCE_LIMIT','Mỗi bên được gắn tối đa 6 ảnh, tổng hồ sơ tối đa 12 ảnh.');
  for(const asset of assets){
    const claimed=await db.prepare("UPDATE media_assets SET status='ATTACHED',version=version+1,updated_at=? WHERE id=? AND version=? AND status='STAGED' AND expires_at>?").run(nowIso(),asset.id,asset.version,at);
    if(claimed.changes!==1)throw new AppError(409,'MEDIA_ASSET_CHANGED','Ảnh vừa được dùng ở thao tác khác.');
    await db.prepare('INSERT INTO dispute_media(dispute_id,asset_id,actor_id,attached_at) VALUES(?,?,?,?)').run(dispute.id,asset.id,actorId,at);
  }
  const images=assets.map(a=>({id:a.id,sha256:a.output_sha256}));
  await appendAuditLog(db,{transactionId:txn.id,actorId,action:'DISPUTE_IMAGES_ATTACHED',oldStatus:current.status,newStatus:current.status,eventData:{disputeId:dispute.id,disputeRevision:profile.revision,orderVersion:current.version,images,sha256:digest(Buffer.from(JSON.stringify(images)))}});
  return {attached:assets.length,images};
}
async function imageEvidence(dispute,user){
  if(!dispute||!user)return [];
  const txn=await db.prepare('SELECT buyer_id,seller_id FROM transactions WHERE id=?').get(dispute.transaction_id);
  if(!txn||(![txn.buyer_id,txn.seller_id].includes(user.id)&&!(await isClaimedAdmin(user,dispute))))return [];
  return (await db.prepare("SELECT a.*,m.actor_id,m.attached_at FROM dispute_media m JOIN media_assets a ON a.id=m.asset_id WHERE m.dispute_id=? AND a.status='ATTACHED' ORDER BY m.attached_at,a.id").all(dispute.id)).map(a=>({...metadata(a),actorId:a.actor_id,attachedAt:a.attached_at}));
}
async function canReadAsset(asset,user){
  if(user?.id===asset.owner_id)return true;
  if(asset.purpose==='LISTING'){
    if(await db.prepare("SELECT 1 FROM listing_media m JOIN listings l ON l.id=m.listing_id WHERE m.asset_id=? AND l.visibility='PUBLIC' AND l.status<>'PENDING_SELLER_REVIEW'").get(asset.id))return true;
    if(!user)return false;
    // Historical order read comes from the frozen snapshot, never the listing's live gallery.
    if(await db.prepare('SELECT 1 FROM order_media_snapshot s JOIN transactions t ON t.id=s.transaction_id WHERE s.asset_id=? AND (t.buyer_id=? OR t.seller_id=?) LIMIT 1').get(asset.id,user.id,user.id))return true;
    if(user.role==='ADMIN'){
      const rows=await db.prepare('SELECT d.* FROM order_media_snapshot s JOIN disputes d ON d.transaction_id=s.transaction_id WHERE s.asset_id=? AND d.admin_id=?').all(asset.id,user.id);
      for(const d of rows)if(await isClaimedAdmin(user,d))return true;
    }
    return false;
  }
  if(!user)return false;
  const d=await db.prepare('SELECT d.* FROM dispute_media m JOIN disputes d ON d.id=m.dispute_id WHERE m.asset_id=?').get(asset.id);
  if(!d)return false;
  const txn=await db.prepare('SELECT buyer_id,seller_id FROM transactions WHERE id=?').get(d.transaction_id);
  return !!txn&&([txn.buyer_id,txn.seller_id].includes(user.id)||await isClaimedAdmin(user,d));
}
// Every denial is the same 404 so existence of a private asset cannot be probed.
async function loadImage(id,user){
  if(typeof id!=='string'||!UUID.test(id))throw notFound();
  const asset=await db.prepare("SELECT * FROM media_assets WHERE id=? AND status IN ('STAGED','ATTACHED')").get(id);
  if(!asset||(asset.status==='STAGED'&&asset.expires_at<=nowIso()))throw notFound();
  if(!(await canReadAsset(asset,user)))throw notFound();
  let buffer;
  try{
    const store=await getMediaStorage();
    buffer=await store.get(asset.storage_key);
  }catch{
    // Storage adapters (including body streams and isolated test adapters) may
    // reject with provider-specific errors. Never expose those errors or turn an
    // authorized image read into an unexplained 500. ACL denials above stay 404.
    throw new AppError(503,'MEDIA_STORAGE_UNAVAILABLE','Không đọc được bản ảnh đã lưu. Hãy thử lại sau.');
  }
  if(!Buffer.isBuffer(buffer)||buffer.length!==asset.bytes||digest(buffer)!==asset.output_sha256)throw new AppError(503,'MEDIA_STORAGE_UNAVAILABLE','Không đọc được bản ảnh đã lưu. Hãy thử lại sau.');
  return buffer;
}
const UNREFERENCED="NOT EXISTS(SELECT 1 FROM listing_media x WHERE x.asset_id=media_assets.id) AND NOT EXISTS(SELECT 1 FROM dispute_media x WHERE x.asset_id=media_assets.id) AND NOT EXISTS(SELECT 1 FROM order_media_snapshot x WHERE x.asset_id=media_assets.id)";
async function markAttemptDeleted(asset,at){
  return db.prepare(`UPDATE media_assets SET storage_deleted_at=?,version=version+1 WHERE id=? AND storage_key=? AND version=? AND status IN ('FAILED','EXPIRED') AND storage_deleted_at IS NULL AND ${UNREFERENCED}`)
    .run(at,asset.id,asset.storage_key,asset.version);
}
async function retireCleanupJob(job,store,at){
  // Never delete an image which actually published under this same key. A new
  // retry uses a different key; its references do not make the obsolete key live.
  const published=await db.prepare(`SELECT 1 FROM media_assets WHERE id=? AND storage_key=? AND
    (status IN ('STAGED','ATTACHED') OR NOT (${UNREFERENCED}))`).get(job.asset_id,job.storage_key);
  if(published)return false;
  await store.remove(job.storage_key);
  const retired=await db.prepare('UPDATE media_cleanup_jobs SET deleted_at=?,updated_at=?,version=version+1 WHERE storage_key=? AND version=? AND deleted_at IS NULL')
    .run(at,at,job.storage_key,job.version);
  if(retired.changes!==1)return false;
  // The metadata tombstone belongs to the exact version reopened with this job.
  // If B replaced A, or another late writer reopened the debt, this CAS is a no-op.
  await markAttemptDeleted({id:job.asset_id,storage_key:job.storage_key,version:job.asset_version},at);
  return true;
}
// Safe to run repeatedly and from several processes: every statement is a CAS, and an
// object is only deleted once its row is FAILED/EXPIRED AND nothing references it.
async function cleanupMediaAssets({now=Date.now()}={}){
  const at=iso(now);
  await db.prepare("UPDATE media_assets SET status='FAILED',version=version+1,updated_at=? WHERE status='UPLOADING' AND (updated_at<=? OR expires_at<=?)").run(at,iso(now-STALE_UPLOAD_MS),at);
  await db.prepare(`UPDATE media_assets SET status='EXPIRED',version=version+1,updated_at=? WHERE status='STAGED' AND expires_at<=? AND ${UNREFERENCED}`).run(at,at);
  const assets=await db.prepare(`SELECT * FROM media_assets WHERE status IN ('FAILED','EXPIRED') AND storage_deleted_at IS NULL AND ${UNREFERENCED}
    AND NOT EXISTS(SELECT 1 FROM media_cleanup_jobs j WHERE j.storage_key=media_assets.storage_key AND j.deleted_at IS NULL) LIMIT 200`).all();
  const jobs=await db.prepare('SELECT * FROM media_cleanup_jobs WHERE deleted_at IS NULL LIMIT 200').all();
  if(!assets.length&&!jobs.length)return {removed:0,failed:0};
  const store=await getMediaStorage();let removed=0,failed=0;
  for(const asset of assets){
    try{
      await store.remove(asset.storage_key);
      const marked=await markAttemptDeleted(asset,at);
      if(marked.changes===1)removed++;
    }
    catch{failed++;}
  }
  for(const job of jobs){
    try{if(await retireCleanupJob(job,store,at))removed++;}
    catch{failed++;}
  }
  return {removed,failed};
}
function startMediaCleanup(){
  const seconds=Number(process.env.MEDIA_WORKER_SECONDS??process.env.MEDIA_CLEANUP_INTERVAL_SECONDS??600);
  if(!Number.isFinite(seconds)||seconds<=0)return null;
  let busy=false;
  const tick=async()=>{if(busy)return;busy=true;try{await cleanupMediaAssets();}catch{console.error('[media] cleanup unavailable');}finally{busy=false;}};
  const first=setTimeout(tick,5000);first.unref();
  const timer=setInterval(tick,seconds*1000);timer.unref();return timer;
}
module.exports={UUID,metadata,readImageIds,assertUploadPurpose,limitUploads,uploadMedia,lookupUpload,listingImages,imagesForListings,transactionImages,orderImagesFor,attachListingImages,releaseListingImages,snapshotOrderImages,attachEvidenceImages,imageEvidence,loadImage,cleanupMediaAssets,startMediaCleanup};
