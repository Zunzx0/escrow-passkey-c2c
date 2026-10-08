'use strict';
const express=require('express');
const {requireAuth,requireRole}=require('../lib/auth');
const {AppError}=require('../lib/errors');
const {rateLimit}=require('../lib/rateLimit');
const {PayPalSandboxError}=require('../lib/paypalSandboxProvider');
const {PayPalStoreError}=require('../lib/paypalPaymentStore');
function createPayPalRouter(runtime=require('../lib/paypalRuntime').getRuntime()) {
  const router=express.Router();
  const walletRole=requireRole('BUYER','SELLER');
  const writes=rateLimit({perMinute:10,name:'paypal-auth-writes'});
  const reads=rateLimit({perMinute:20,name:'paypal-checkout'});
  const webhooks=rateLimit({perMinute:60,name:'paypal-webhook'});
  const handler=fn=>async(req,res,next)=>{try{await fn(req,res);}catch(error){
    if(error instanceof PayPalSandboxError||error instanceof PayPalStoreError) {
      const status=error.statusCode||error.status;
      // Only sanitized server-defined provider errors reach the browser.
      return next(new AppError(status,error.code,status>=500?'Chưa xác nhận được kết quả PayPal. Hãy giữ requestId và kiểm tra lại.':error.message));
    }next(error);
  }};
  router.get('/config',handler(async(req,res)=>res.json(runtime.publicConfig())));
  router.post('/topup',requireAuth,walletRole,writes,handler(async(req,res)=>res.status(200).json(await runtime.create({userId:req.user.id,...{amount:req.body?.amount,requestId:req.body?.requestId}}))));
  router.get('/:id/checkout',requireAuth,walletRole,reads,handler(async(req,res)=>res.json(await runtime.checkout(req.params.id,req.user.id))));
  router.post('/:id/capture',requireAuth,walletRole,writes,handler(async(req,res)=>res.json(await runtime.capture(req.params.id,req.user.id))));
  // Body PHẢI rỗng: owner lấy từ phiên, client không được gửi userId/status/evidence/actor.
  const emptyBody=(req,res,next)=>{const b=req.body;
    if(b===undefined||(b&&typeof b==='object'&&!Array.isArray(b)&&Object.keys(b).length===0))return next();
    next(new AppError(400,'VALIDATION_ERROR','Yêu cầu bỏ ý định nạp không nhận dữ liệu trong body'));};
  router.post('/:id/abandon',requireAuth,walletRole,writes,emptyBody,handler(async(req,res)=>res.status(200).json(await runtime.abandon(req.params.id,req.user.id,req))));
  router.post('/webhook',webhooks,handler(async(req,res)=>res.json(await runtime.webhook(req.headers,req.body))));
  return router;
}
module.exports={createPayPalRouter};
