'use strict';
const {AppError}=require('./errors');
const sharp=require('sharp');
const MAX_INPUT_BYTES=5*1024*1024,MAX_OUTPUT_BYTES=512*1024,MAX_PIXELS=20000000;
const MIME_TYPES=new Set(['image/jpeg','image/png','image/webp']);
const MAX_CONCURRENT=2;
let processing=0,maxActive=0;
// Sharp's own pools are bounded too: one libvips thread per decode, no result cache.
sharp.concurrency(1);sharp.cache(false);
function detectedFormat(buffer){
  if(buffer.length>=3&&buffer[0]===0xff&&buffer[1]===0xd8&&buffer[2]===0xff)return 'jpeg';
  if(buffer.length>=8&&buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'png';
  if(buffer.length>=12&&buffer.toString('ascii',0,4)==='RIFF'&&buffer.toString('ascii',8,12)==='WEBP')return 'webp';
  return null;
}
async function normalizeImage(buffer,mime){
  if(!Buffer.isBuffer(buffer)||!buffer.length||buffer.length>MAX_INPUT_BYTES)throw new AppError(413,'MEDIA_FILE_TOO_LARGE','Ảnh phải có dung lượng không quá 5 MiB.');
  const format=detectedFormat(buffer);
  if(!format||!MIME_TYPES.has(mime)||`image/${format}`!==mime)throw new AppError(415,'MEDIA_FORMAT_UNSUPPORTED','Chỉ nhận ảnh JPEG, PNG hoặc WebP hợp lệ.');
  if(processing>=MAX_CONCURRENT)throw new AppError(429,'MEDIA_PROCESSING_BUSY','Máy chủ đang xử lý ảnh khác. Hãy thử lại sau ít giây.');
  processing++;maxActive=Math.max(maxActive,processing);
  try{
    const metadata=await sharp(buffer,{limitInputPixels:MAX_PIXELS,failOn:'error',animated:false}).metadata();
    if(metadata.format!==format||!metadata.width||!metadata.height||metadata.width>10000||metadata.height>10000||metadata.width*metadata.height>MAX_PIXELS||(metadata.pages||1)>1){
      throw new AppError(415,'MEDIA_IMAGE_INVALID','Ảnh không hợp lệ, quá lớn hoặc có chuyển động. Hãy chọn ảnh tĩnh tối đa 20 megapixel.');
    }
    // No withMetadata/keepMetadata: decode, orient and re-encode new pixel data.
    // This intentionally is a normalized display copy, not a forensic original.
    for(const quality of [82,68,52,36]){
      const result=await sharp(buffer,{limitInputPixels:MAX_PIXELS,failOn:'error',animated:false})
        .rotate().resize({width:1600,height:1600,fit:'inside',withoutEnlargement:true})
        .toColourspace('srgb').webp({quality,effort:3}).toBuffer({resolveWithObject:true});
      if(result.data.length<=MAX_OUTPUT_BYTES)return {buffer:result.data,width:result.info.width,height:result.info.height,bytes:result.data.length};
    }
    throw new AppError(413,'MEDIA_OUTPUT_TOO_LARGE','Ảnh có quá nhiều chi tiết. Hãy chọn ảnh nhỏ hơn.');
  }catch(error){
    if(error instanceof AppError)throw error;
    throw new AppError(415,'MEDIA_IMAGE_INVALID','Không đọc được ảnh. Hãy chọn tệp JPEG, PNG hoặc WebP khác.');
  }finally{processing--;}
}
const getMediaImageStatsForTests=()=>({active:processing,maxActive});
module.exports={MAX_INPUT_BYTES,MAX_OUTPUT_BYTES,MAX_PIXELS,MIME_TYPES,normalizeImage,getMediaImageStatsForTests};
