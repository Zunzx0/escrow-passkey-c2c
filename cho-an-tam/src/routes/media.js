'use strict';
const express=require('express');
const {requireAuth,optionalAuth}=require('../lib/auth');
const {AppError}=require('../lib/errors');
const {MIME_TYPES,MAX_INPUT_BYTES}=require('../lib/mediaImage');
const {getMediaStorage}=require('../lib/mediaStorage');
const media=require('../lib/mediaService');
const router=express.Router();
// At most this many request bodies (5 MiB each) are buffered at once across all users.
const configuredInFlight=Number(process.env.MEDIA_MAX_IN_FLIGHT??6);
// Invalid, non-finite or excessive values must never disable the RAM bound.
const MAX_IN_FLIGHT_UPLOADS=Number.isSafeInteger(configuredInFlight)&&configuredInFlight>=1&&configuredInFlight<=8?configuredInFlight:6;
let inFlight=0,maxInFlight=0;
router.use((req,res,next)=>{
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.append('Vary','Authorization');
  next();
});
function reserveSlot(req,res){
  if(req.aborted||res.destroyed)throw new AppError(400,'MEDIA_IMAGE_INVALID','Yêu cầu tải ảnh đã đóng.');
  if(inFlight>=MAX_IN_FLIGHT_UPLOADS){
    res.setHeader('Retry-After','3');
    throw new AppError(429,'MEDIA_PROCESSING_BUSY','Máy chủ đang nhận nhiều ảnh cùng lúc. Hãy thử lại sau ít giây.');
  }
  inFlight++;maxInFlight=Math.max(maxInFlight,inFlight);
  let released=false;
  const lease={processing:false,release:null};
  const release=()=>{
    if(released)return;
    released=true;inFlight--;
    res.removeListener('close',closed);req.removeListener('aborted',closed);
  };
  // A disconnect while reading can release the parser's lease. Once the handler
  // starts, the raw buffer/storage task still exists after res.close: only its
  // finally block may release the lease, even when the HTTP client has left.
  const closed=()=>{if(!lease.processing)release();};
  lease.release=release;req.mediaLease=lease;
  res.once('close',closed);req.once('aborted',closed);
}
async function prepareUpload(req,res,next){
  try{
    const {purpose,requestId,transactionId}=req.query;
    if(typeof requestId!=='string'||!media.UUID.test(requestId))throw new AppError(400,'MEDIA_REQUEST_INVALID','Mã tải ảnh không hợp lệ.');
    if(transactionId!==undefined&&typeof transactionId!=='string')throw new AppError(400,'MEDIA_TARGET_INVALID','Đơn hàng nhận bằng chứng không hợp lệ.');
    await media.assertUploadPurpose(req.user,purpose,transactionId||null);
    const mime=String(req.headers['content-type']||'').split(';')[0].trim().toLowerCase();
    if(!MIME_TYPES.has(mime))throw new AppError(415,'MEDIA_FORMAT_UNSUPPORTED','Chọn ảnh JPEG, PNG hoặc WebP.');
    const length=Number(req.headers['content-length']||0);
    if(length>MAX_INPUT_BYTES)throw new AppError(413,'MEDIA_FILE_TOO_LARGE','Ảnh không được lớn hơn 5 MiB.');
    await media.limitUploads(req.user.id);
    // Fail closed before reading an image body if durable private storage is absent.
    await getMediaStorage();
    reserveSlot(req,res);
    req.mediaInput={purpose,requestId,transactionId:transactionId||null,mime};
    next();
  }catch(error){
    if(error.status===429&&!res.getHeader('Retry-After'))res.setHeader('Retry-After','30');
    if(error.status===503)res.setHeader('Retry-After','30');
    next(error);
  }
}
const rawImageBody=express.raw({type:()=>true,limit:MAX_INPUT_BYTES,inflate:false});
function readImageBody(req,res,next){
  rawImageBody(req,res,error=>{
    if(error){req.body=null;req.mediaLease?.release();return next(error);}
    if(req.aborted||res.destroyed){req.body=null;req.mediaLease?.release();return;}
    req.mediaLease.processing=true;
    next();
  });
}
router.post('/uploads',requireAuth,prepareUpload,readImageBody,async(req,res,next)=>{
  try{
    if(!Buffer.isBuffer(req.body)||!req.body.length)throw new AppError(400,'MEDIA_IMAGE_INVALID','Chưa nhận được dữ liệu ảnh.');
    const result=await media.uploadMedia({user:req.user,...req.mediaInput,buffer:req.body});
    if(!res.destroyed)res.status(result.created?201:200).json(result.asset);
  }catch(error){
    if(!res.destroyed){
      if(!res.headersSent&&(error.status===429||error.status===503))res.setHeader('Retry-After','10');
      next(error);
    }
  }finally{
    req.body=null;
    req.mediaLease?.release();
  }
});
router.get('/uploads/:requestId',requireAuth,async(req,res,next)=>{
  try{
    if(!media.UUID.test(req.params.requestId))throw new AppError(404,'MEDIA_NOT_FOUND','Không tìm thấy lần tải ảnh.');
    const result=await media.lookupUpload(req.user.id,req.params.requestId);
    if(result.pending)res.setHeader('Retry-After','2');
    res.status(result.pending?202:200).json(result.asset);
  }catch(error){next(error);}
});
router.get('/images/:id',optionalAuth,async(req,res,next)=>{
  try{
    const buffer=await media.loadImage(req.params.id,req.user);
    res.setHeader('Content-Type','image/webp');
    res.setHeader('Content-Length',String(buffer.length));
    res.setHeader('Content-Disposition','inline; filename="enclave-image.webp"');
    res.setHeader('Content-Security-Policy',"default-src 'none'; sandbox");
    res.end(buffer);
  }catch(error){next(error);}
});
router.use((error,req,res,next)=>{
  if(error.type==='entity.too.large')return next(new AppError(413,'MEDIA_FILE_TOO_LARGE','Ảnh không được lớn hơn 5 MiB.'));
  if(error.type==='encoding.unsupported')return next(new AppError(415,'MEDIA_ENCODING_UNSUPPORTED','Không nhận dữ liệu ảnh nén qua Content-Encoding.'));
  if(error.type==='request.aborted'||error.type==='request.size.invalid')return next(new AppError(400,'MEDIA_IMAGE_INVALID','Dữ liệu ảnh nhận được không đầy đủ.'));
  next(error);
});
module.exports=router;
module.exports.getMediaUploadStatsForTests=()=>{
  if(process.env.APP_ENV!=='test')throw new Error('MEDIA_TEST_STATS_FORBIDDEN');
  return {active:inFlight,maxActive:maxInFlight,limit:MAX_IN_FLIGHT_UPLOADS};
};
