'use strict';
const {db,uuid,nowIso,DB_PATH}=require('../db');
const path=require('node:path');
const {AppError}=require('./errors');
const {createSandboxProvider}=require('./paypalSandboxProvider');
const {createPayPalPaymentStore}=require('./paypalPaymentStore');
const {createPayPalSettlement}=require('./paypalSettlement');
const {createCaptureCoordinator}=require('./paypalCaptureCoordinator');
const {createSandboxPaymentService}=require('./paypalSandboxService');
const {parseAmount,parseClientRequestId,assertTopupLimits}=require('./topupPolicy');
const {getUserWallet}=require('./walletOps');
function configFromEnvironment() {
  return {enabled:process.env.PAYPAL_SANDBOX_ENABLED==='1',mode:'sandbox',clientId:process.env.PAYPAL_SANDBOX_CLIENT_ID,
    clientSecret:process.env.PAYPAL_SANDBOX_CLIENT_SECRET,merchantId:process.env.PAYPAL_SANDBOX_MERCHANT_ID,
    webhookId:process.env.PAYPAL_SANDBOX_WEBHOOK_ID,frontendOrigin:process.env.PAYPAL_FRONTEND_ORIGIN||'https://enclave.id.vn',
    rateVndPerUsd:Number(process.env.PAYPAL_DEMO_VND_PER_USD||25000),timeoutMs:Number(process.env.PAYPAL_TIMEOUT_MS||10000),
    leaseMs:Number(process.env.PAYPAL_CAPTURE_LEASE_SECONDS||120)*1000};
}
function validConfig(c) {
  try {const u=new URL(c.frontendOrigin);return c.enabled===true && c.mode==='sandbox' && (!c.baseUrl||c.baseUrl==='https://api-m.sandbox.paypal.com') && u.protocol==='https:' && u.href===u.origin+'/' &&
    !u.username&&!u.password&&typeof c.clientId==='string'&&!!c.clientId&&typeof c.clientSecret==='string'&&!!c.clientSecret&&
    /^[A-Za-z0-9._:-]{1,127}$/.test(c.merchantId||'')&&/^[A-Za-z0-9._:-]{1,127}$/.test(c.webhookId||'')&&
    Number.isSafeInteger(c.rateVndPerUsd)&&c.rateVndPerUsd>0&&Number.isInteger(c.timeoutMs)&&c.timeoutMs>=100&&c.timeoutMs<=30000&&
    Number.isInteger(c.leaseMs)&&c.leaseMs>=c.timeoutMs*4+10000;
  } catch(_){return false;}
}
function createPayPalRuntime({config=configFromEnvironment(),provider=null}={}) {
  if(provider) {
    if(process.env.APP_ENV!=='test')throw new Error('Provider injection is allowed only in test');
    if(process.env.DATABASE_URL){const u=new URL(process.env.DATABASE_URL);if(!['127.0.0.1','localhost'].includes(u.hostname)||!/_test$/.test(u.pathname))throw new Error('Fake provider requires local *_test database');}
    else if(!DB_PATH.startsWith(path.resolve(__dirname,'../../data/test')+path.sep))throw new Error('Fake provider requires data/test database');
  }
  const enabled=validConfig(config);
  const store=createPayPalPaymentStore({db});
  const merchantGuard=row=>{if(row&&row.merchantId!==config.merchantId)throw new AppError(409,'PAYPAL_ORDER_MISMATCH','Merchant đã thay đổi; cần đối soát thủ công');return row;};
  const secureStore={...store,loadByRequestId:async id=>merchantGuard(await store.loadByRequestId(id)),loadByOrderId:async id=>merchantGuard(await store.loadByOrderId(id))};
  const adapter=provider||createSandboxProvider(config);
  const settle=createPayPalSettlement({db,store:secureStore});
  const coordinator=createCaptureCoordinator({store:secureStore,provider:adapter,settle,leaseMs:enabled?config.leaseMs:120000});
  const callback=(kind,id)=>{const u=new URL(config.frontendOrigin);u.searchParams.set('paypal',kind);u.searchParams.set('paymentRequestId',id);u.hash='/wallet';return u.href;};
  const service=createSandboxPaymentService({store:secureStore,provider:adapter,settle,captureCoordinator:coordinator,returnUrl:id=>callback('return',id),cancelUrl:id=>callback('cancel',id)});
  const ready=()=>{if(!enabled)throw new AppError(503,'PAYPAL_DISABLED','PayPal Sandbox chưa được bật hoặc chưa đủ cấu hình');};
  async function owned(id,userId) {const row=await store.loadByRequestId(id);if(!row)throw new AppError(404,'PAYMENT_REQUEST_NOT_FOUND','Không tìm thấy yêu cầu');
    if(userId && row.userId!==userId)throw new AppError(403,'FORBIDDEN','Bạn không có quyền với yêu cầu này');
    if(row.merchantId!==config.merchantId)throw new AppError(409,'PAYPAL_ORDER_MISMATCH','Merchant đã thay đổi; cần đối soát thủ công');return row;}
  async function create({userId,amount:raw,requestId:rawKey}) {
    ready();const amount=parseAmount(raw),requestId=parseClientRequestId(rawKey);
    if(!requestId)throw new AppError(400,'VALIDATION_ERROR','Nạp PayPal bắt buộc có requestId');
    const id=uuid(),time=nowIso();let row;
    await db.transaction(async()=>{
      row=await db.prepare('SELECT * FROM payment_requests WHERE user_id=? AND client_request_id=?').get(userId,requestId);
      if(row){if(row.provider!=='PAYPAL_SANDBOX'||row.amount!==amount)throw new AppError(409,'IDEMPOTENCY_KEY_REUSED','requestId đã dùng cho số tiền hoặc provider khác');return;}
      const wallet=await getUserWallet(userId);if(!wallet)throw new AppError(400,'WALLET_NOT_FOUND','Tài khoản này không có ví để nạp');
      await assertTopupLimits(userId,wallet,amount);
      await db.prepare("INSERT INTO payment_requests (id,user_id,amount,status,provider_ref,version,client_request_id,submission_status,provider,created_at,updated_at) VALUES (?,?,?,'PENDING',?,0,?,'SUBMITTING','PAYPAL_SANDBOX',?,?)").run(id,userId,amount,uuid(),requestId,time,time);
      await store.createBinding({paymentRequestId:id,quote:adapter.createQuote(amount),merchantId:config.merchantId,nowIso:time});
      row=await db.prepare('SELECT * FROM payment_requests WHERE id=?').get(id);
    })();
    await owned(row.id,userId);
    if(row.status==='PENDING') await service.createOrder({paymentRequestId:row.id,userId});
    return serializePayPal(row.id,{approval:true});
  }
  async function serializePayPal(id,{approval=false}={}) {
    const binding=await store.loadByRequestId(id);if(!binding)return {};
    const pr=await db.prepare('SELECT * FROM payment_requests WHERE id=?').get(id);
    let approvalUrl=null;
    if(approval && enabled && binding.status==='PENDING'&&binding.orderId && binding.capture.state==='READY') {
      await owned(id,binding.userId);
      approvalUrl=(await adapter.getOrder({orderId:binding.orderId,paymentRequestId:id,quote:binding.quote})).approvalUrl||null;
    }
    const stage=binding.capture.recoveryRequiredAt || binding.capture.state==='RECOVERY_REQUIRED'?'RECOVERY_REQUIRED':
      binding.status==='SUCCEEDED'?'SUCCEEDED':binding.status==='FAILED'?'FAILED':
      binding.capture.state==='VERIFIED'?'RECONCILING':binding.capture.state==='IN_FLIGHT'?'CAPTURING':
      binding.capture.state==='UNKNOWN'?'RECONCILING':binding.capture.state==='NOT_CAPTURED'?'NOT_CAPTURED':
      binding.orderId?'AWAITING_APPROVAL':binding.createAttemptAt && Date.now()-Date.parse(binding.createAttemptAt)>=300000?'CREATE_RECOVERY_REQUIRED':'CREATING';
    return {id,amount:binding.amountVnd,status:binding.status,requestId:pr.client_request_id,providerRef:binding.providerRef,
      provider:'PAYPAL_SANDBOX',submissionStatus:binding.orderId?'SUBMITTED':'SUBMITTING',createdAt:pr.created_at,resolvedAt:pr.resolved_at,
      sandbox:true,stage,orderId:binding.orderId,quote:{...binding.quote,rateKind:'DEMO_FIXED',rateLabel:'Tỷ giá mô phỏng, không phải giá thị trường'},approvalUrl};
  }
  async function reconcileOne(id) {
    ready();const row=await owned(id,null);
    if(!row.orderId)return {status:row.status,outcome:row.createAttemptAt && Date.now()-Date.parse(row.createAttemptAt)>=300000?'CREATE_RECOVERY_REQUIRED':'NOT_READY'};
    return service.reconcile({paymentRequestId:id}); // GET only: worker never initiates capture.
  }
  return Object.freeze({store,settle,service,
    publicConfig:()=>({paypalSandbox:{enabled,mode:'sandbox',rateKind:'DEMO_FIXED'},mockPayments:{enabled:config.enabled!==true && process.env.MOCK_PROVIDER_CHECKOUT!=='0'}}),create,serializePayPal,reconcileOne,
    async capture(id,userId){ready();await owned(id,userId);const outcome=await coordinator.capture({paymentRequestId:id,userId});if(outcome.outcome==='CONFLICT')throw new AppError(409,'PAYPAL_CAPTURE_CONFLICT','Bằng chứng thu tiền cần được đối soát thủ công');return {...await serializePayPal(id),outcome:outcome.outcome};},
    async checkout(id,userId){ready();await owned(id,userId);return serializePayPal(id,{approval:true});},
    async webhook(headers,event){ready();return service.webhook({headers,event});}
  });
}
let singleton;
const getRuntime=()=>singleton||(singleton=createPayPalRuntime());
module.exports={createPayPalRuntime,configFromEnvironment,serializePayPal:(id)=>getRuntime().serializePayPal(id),getRuntime};
