'use strict';
const {AppError}=require('./errors');
const TIMEOUT_MS=10000,PRIVACY_CACHE_MS=60000,MAX_OBJECT_BYTES=512*1024;
let testAdapter=null,realStore=null,realSignature=null;
function unavailable(){return new AppError(503,'MEDIA_STORAGE_UNAVAILABLE','Kho ảnh hiện chưa sẵn sàng. Hãy thử lại sau.');}
function setMediaStorageForTests(adapter){
  if(process.env.APP_ENV!=='test')throw new Error('MEDIA_TEST_ADAPTER_FORBIDDEN');
  if(adapter&&['put','get','remove','isPrivate'].some(k=>typeof adapter[k]!=='function'))throw new TypeError('Invalid media test adapter');
  testAdapter=adapter;
}
function configuredStore(){
  if(testAdapter){
    if(process.env.APP_ENV!=='test')throw unavailable();
    return testAdapter;
  }
  const raw=process.env.MEDIA_STORAGE_URL,key=process.env.MEDIA_STORAGE_SERVICE_KEY,bucket=process.env.MEDIA_STORAGE_BUCKET||'enclave-media';
  if(!raw||!key||!/^[a-z0-9][a-z0-9-]{0,62}$/.test(bucket))throw unavailable();
  let origin;
  try{
    const url=new URL(raw);
    if(url.protocol!=='https:'||!url.hostname.endsWith('.supabase.co')||url.username||url.password||url.search||url.hash||!['','/'].includes(url.pathname))throw unavailable();
    origin=url.origin;
  }catch{throw unavailable();}
  const signature=[origin,key,bucket].join('\n');
  if(realStore&&realSignature===signature)return realStore;
  const headers={apikey:key,Authorization:`Bearer ${key}`};
  const objectPath=objectKey=>{
    if(!/^(?:listing|evidence)\/[0-9a-f-]{36}\.webp$/.test(objectKey))throw unavailable();
    return `${origin}/storage/v1/object/${bucket}/${objectKey}`;
  };
  // Every call is bounded: connect + headers + body must finish inside the timeout, and a
  // redirect is an error (the service key must never follow a Location to another host).
  async function request(url,options={}){
    try{return await fetch(url,{...options,headers:{...headers,...options.headers},signal:AbortSignal.timeout(TIMEOUT_MS),redirect:'error'});}
    catch{throw unavailable();}
  }
  const discard=async response=>{try{await response.body?.cancel();}catch{/* body already closed */}};
  // The bucket privacy probe is cached briefly so image reads do not double every request,
  // but only a positive answer is cached and it expires quickly if the bucket is changed.
  let privateUntil=0;
  realSignature=signature;
  realStore={
    async isPrivate(){
      if(Date.now()<privateUntil)return true;
      const response=await request(`${origin}/storage/v1/bucket/${bucket}`);
      if(!response.ok){await discard(response);return false;}
      try{
        const isPrivate=(await response.json()).public===false;
        if(isPrivate)privateUntil=Date.now()+PRIVACY_CACHE_MS;
        return isPrivate;
      }catch{return false;}
    },
    async put(objectKey,buffer){
      const response=await request(objectPath(objectKey),{method:'POST',headers:{'Content-Type':'image/webp','x-upsert':'false','Cache-Control':'no-store'},body:buffer});
      await discard(response);
      if(!response.ok)throw unavailable();
    },
    async get(objectKey){
      // The authenticated route serves private-bucket objects with the service key.
      objectPath(objectKey);
      const response=await request(`${origin}/storage/v1/object/authenticated/${bucket}/${objectKey}`);
      if(!response.ok){await discard(response);throw unavailable();}
      const length=Number(response.headers.get('content-length')||0);
      if(length>MAX_OBJECT_BYTES){await discard(response);throw unavailable();}
      const chunks=[];let bytes=0;
      try{
        for await(const chunk of response.body){bytes+=chunk.length;if(bytes>MAX_OBJECT_BYTES)throw unavailable();chunks.push(chunk);}
      }catch(error){
        await discard(response);
        throw error instanceof AppError?error:unavailable();
      }
      return Buffer.concat(chunks);
    },
    async remove(objectKey){
      objectPath(objectKey);
      const response=await request(`${origin}/storage/v1/object/${bucket}`,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({prefixes:[objectKey]})});
      await discard(response);
      if(!response.ok&&response.status!==404)throw unavailable();
    },
  };
  return realStore;
}
async function getMediaStorage(){
  const adapter=configuredStore();
  try{if(!(await adapter.isPrivate()))throw unavailable();}catch{throw unavailable();}
  return adapter;
}
module.exports={getMediaStorage,setMediaStorageForTests};
