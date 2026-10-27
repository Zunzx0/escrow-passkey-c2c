'use strict';

// Actual SPA + fake API/authenticator in JSDOM. These assertions prove rendering,
// requests and interaction locks, NOT real ledger settlement, Safari or Passkeys.
const assert = require('node:assert/strict');
const {wallet,json,sleep,BUYER} = require('./paypal-wallet-ui');
let checks = 0;
function ok(condition,message) { assert.ok(condition,message); checks++; console.log('PASS '+message); }
const SELLER = {...BUYER,id:'seller-ui',role:'SELLER',displayName:'Người bán thử'};
const ADMIN = {...BUYER,id:'admin-ui',role:'ADMIN',displayName:'Quản trị thử'};
const iso = new Date().toISOString();
const shipping = {recipientName:'Nguyễn Văn An',phone:'0912345678',address:'Số 12 đường Nguyễn Trãi',ward:'Phường Hà Đông',district:'Hà Đông',province:'Hà Nội',version:1,createdAt:iso};
const listing = {id:'item-ui',sellerId:'other-seller',sellerName:'Người bán khác',title:'Túi C2C',price:60000,category:'THOI_TRANG',condition:'GOOD',status:'AVAILABLE',visibility:'PUBLIC',createdAt:iso};
const transaction = (patch = {}) => ({id:'order-ui',buyerId:BUYER.id,sellerId:SELLER.id,buyerName:'Người mua',sellerName:'Người bán',itemName:'Túi C2C',amount:60000,status:'SECURED',escrowStatus:'LOCKED',sellerAckAt:null,shipment:null,createdAt:iso,updatedAt:iso,version:1,shipping,...patch});
const find = (p,act) => p.d.querySelector('[data-act="'+act+'"]');
async function click(p,act,wait=70) {const button=find(p,act);assert.ok(button,'button '+act);p.click(button);await sleep(wait);}
function fill(p,id,value) {p.d.getElementById(id).value=value;}
function fillShipping(p,value=shipping) {for (const key of ['recipientName','phone','address','ward','district','province']) fill(p,'ship-'+key,value[key]);}
async function txPage(user,getRow,extra={}) {
  return wallet({user,hash:'#/tx/order-ui',timeoutMs:2000,extra:{
    'GET /api/transactions':()=>json(200,{transactions:[getRow()]}),
    'GET /api/transactions/order-ui':()=>json(200,getRow()),
    'GET /api/transactions/order-ui/logs':()=>json(200,{logs:[]}),
    'GET /api/notifications/todo':()=>json(200,{items:[]}),...extra,
  }});
}

async function main() {
  let attempts=0,finishCreate,createdBody;
  let p=await wallet({user:SELLER,hash:'#/listing/item-ui',timeoutMs:2000,extra:{
    'GET /api/listings/item-ui':()=>json(200,listing),
    'POST /api/transactions/orders':opts=>{
      attempts++;createdBody=JSON.parse(opts.body);
      return attempts===1?json(503,{error:'TEMPORARY_ERROR'}):new Promise(resolve=>{finishCreate=resolve;});
    },
  }});
  try {
    ok(!!find(p,'do-order'),'seller can buy a different seller listing');
    ok(p.d.querySelectorAll('[data-shipping-field]').length===6,'checkout asks for six structured shipping fields');
    ok(/Miễn phí/.test(p.viewText()),'simulated shipping fee is explicitly free');
    await click(p,'do-order');
    ok(p.count('POST /api/transactions/orders')===0,'missing address never sends an order request');
    ok(p.d.querySelectorAll('[data-shipping-field][aria-invalid="true"]').length===6,'invalid address reports errors at each field');
    fillShipping(p,{...shipping,phone:'123'});await click(p,'do-order');
    ok(p.count('POST /api/transactions/orders')===0&&p.d.getElementById('ship-phone').getAttribute('aria-invalid')==='true','invalid Vietnamese phone blocks checkout locally');
    fillShipping(p);await click(p,'do-order');
    const first=p.bodies['POST /api/transactions/orders'][0];
    ok(first.requestId&&first.shipping.recipientName===shipping.recipientName,'order request carries structured address and idempotency requestId');
    await click(p,'do-order',25);
    ok(p.d.getElementById('ship-address').disabled&&find(p,'do-order').disabled,'pending order locks its address form and submit');
    p.click(find(p,'do-order'));await sleep(15);
    ok(attempts===2,'double click does not create a competing order request');
    ok(createdBody.requestId===first.requestId,'retry after server failure retains the same order requestId');
    finishCreate(json(201,transaction({status:'CREATED',escrowStatus:'NONE',buyerId:SELLER.id,sellerId:'other-seller',shipping:createdBody.shipping,draftExpiresAt:'2026-10-28T00:00:00Z'})));await sleep(90);
    ok(/Đã tạo đơn hàng/.test(p.d.getElementById('modalRoot').textContent)&&/chưa trừ tiền/.test(p.d.getElementById('modalRoot').textContent),'created draft has a centered outcome explaining no debit');
    ok(p.d.getElementById('modalRoot').textContent.includes(shipping.address),'order confirmation displays the actual shipping snapshot');
    ok(!JSON.stringify(p.store()).includes(shipping.phone),'shipping phone is not persisted in localStorage');
  } finally {p.close();}

  let row=transaction({status:'CREATED',escrowStatus:'NONE',listingId:'item-ui',shipping:null});
  p=await txPage(BUYER,()=>row,{
    'POST /api/transactions/order-ui/shipping':opts=>{row={...row,shipping:{...JSON.parse(opts.body).shipping,version:1},version:2};return json(200,row);},
    'POST /api/transactions/order-ui/cancel':()=>{row={...row,status:'CANCELLED',version:3};return json(200,row);},
  });
  try {
    ok(!!find(p,'open-order-cancel')&&!find(p,'secure'),'old draft offers cancellation and requires shipping before payment');
    ok(/chưa có bản chụp địa chỉ/.test(p.viewText())&&!p.viewText().includes(shipping.phone),'old draft does not receive a fake shipping address');
    await click(p,'edit-order-shipping');
    ok([...p.d.querySelectorAll('[data-shipping-field]')].every(input=>input.value===''),'old draft shipping form starts empty');
    await click(p,'save-order-shipping');
    ok(p.count('POST /api/transactions/order-ui/shipping')===0,'missing old-draft shipping cannot be submitted');
    fillShipping(p);await click(p,'save-order-shipping',130);await click(p,'modal-close');
    ok(!!find(p,'secure')&&p.viewText().includes(shipping.address),'saving the server shipping snapshot unlocks payment on the draft');
    await click(p,'open-order-cancel');
    ok(/không tạo bút toán hay khoản hoàn tiền/.test(p.d.getElementById('modalRoot').textContent),'draft cancellation explicitly explains there is no refund');
    await click(p,'order-cancel-confirm',140);
    ok(/Đã hủy đơn nháp/.test(p.d.getElementById('modalRoot').textContent)&&/Ví không thay đổi/.test(p.d.getElementById('modalRoot').textContent),'draft cancellation outcome never claims a monetary refund');
  } finally {p.close();}

  let finishCancel;
  row=transaction();
  p=await txPage(BUYER,()=>row,{'POST /api/transactions/order-ui/cancel':()=>new Promise(resolve=>{finishCancel=resolve;})});
  try {
    ok(!!find(p,'open-order-cancel')&&!!find(p,'open-dispute'),'secured buyer can cancel or report a problem before seller acknowledgment');
    await click(p,'open-order-cancel');await click(p,'modal-close');
    ok(p.count('POST /api/transactions/order-ui/cancel')===0,'dismissed cancellation confirmation never cancels the order');
    await click(p,'open-order-cancel');await click(p,'order-cancel-confirm',20);
    ok([...p.d.querySelectorAll('#modalRoot button')].every(button=>button.disabled),'cancellation in progress disables confirm, cancel and close buttons');
    p.d.dispatchEvent(new p.w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
    ok(!!find(p,'order-cancel-confirm'),'Escape cannot dismiss a running cancellation');
    row=transaction({status:'CANCELLED',escrowStatus:'REFUNDED',version:2});finishCancel(json(200,row));await sleep(160);
    ok(/Đã hủy đơn hàng/.test(p.d.getElementById('modalRoot').textContent),'confirmed cancellation has centered success outcome');
    ok(!p.d.querySelector('#view [data-act="open-order-cancel"]'),'cancelled order no longer offers a second cancellation');
  } finally {p.close();}

  row=transaction({sellerAckAt:iso});
  p=await txPage(SELLER,()=>row);
  try {
    ok(!!find(p,'pack')&&!!find(p,'open-order-reject'),'acknowledged seller can pack or cancel because unable to deliver');
    await click(p,'open-order-reject');
    ok(/Tin sẽ được ẩn/.test(p.d.getElementById('modalRoot').textContent),'post-acknowledgment cancellation explains seller-review listing status');
    await click(p,'order-cancel-confirm');
    ok(p.count('POST /api/transactions/order-ui/reject')===0,'seller cancellation requires a reason');
  } finally {p.close();}

  row=transaction({sellerAckAt:iso,shipment:{id:'shipment-ui',status:'PICKUP_PENDING',packedAt:iso,pickupDueAt:iso,arrivalDueAt:iso,serverNow:iso}});
  p=await txPage(SELLER,()=>row);
  try {
    ok(!p.d.querySelector('#view [data-act="open-order-reject"]'),'packed order cannot offer ordinary seller cancellation');
    ok(!!p.d.querySelector('#view [data-act="open-dispute"]'),'packed order retains a problem-reporting path');
  } finally {p.close();}

  row=transaction({status:'WAIT_CONFIRM',receivedConfirmedBy:'BUYER',receivedConfirmedAt:iso,canInspect:true,canBuyerRelease:false,inspectedAt:null});
  p=await txPage(BUYER,()=>row,{
    'POST /api/transactions/order-ui/inspected':()=>{row={...row,inspectedAt:iso,inspectedBy:BUYER.id,canInspect:false,canBuyerRelease:true,version:2};return json(200,row);},
  });
  try {
    ok(!!find(p,'open-inspected')&&!find(p,'open-release'),'received package offers inspection before release');
    await click(p,'open-inspected');await click(p,'modal-close');
    ok(p.count('POST /api/transactions/order-ui/inspected')===0,'dismissed inspection does not record an inspection');
    await click(p,'open-inspected');await click(p,'inspected-confirm',150);
    ok(p.count('POST /api/transactions/order-ui/inspected')===1,'explicit inspection sends exactly one inspection request');
    ok(p.log.every(key=>!key.endsWith('/release')&&!key.endsWith('/secure')),'recording inspection never invokes a money operation');
    ok(!p.d.querySelector('#view [data-act="open-inspected"]')&&!!p.d.querySelector('#view [data-act="open-release"]'),'server inspection result replaces inspection action with release');
    await click(p,'open-release');
    ok(!!find(p,'do-release')&&p.count('POST /api/transactions/order-ui/reauth/options')===0,'release has a review dialog before invoking Passkey');
    p.w.SimpleWebAuthnBrowser.startAuthentication=async()=>({id:'software-key-ui'});
    p.routes['POST /api/transactions/order-ui/reauth/options']=()=>json(200,{reauthSessionId:'session-ui',options:{}});
    p.routes['POST /api/transactions/order-ui/reauth/verify']=()=>json(200,{reauthGrant:'grant-ui'});
    p.routes['POST /api/transactions/order-ui/release']=opts=>{const body=JSON.parse(opts.body);row={...row,status:'COMPLETED',escrowStatus:'RELEASED',version:3};return json(200,{...row,requestId:body.requestId});};
    await click(p,'do-release',170);
    ok(p.bodies['POST /api/transactions/order-ui/reauth/options'][0].action==='RELEASE_ESCROW','release explicitly requests the correct transaction action');
    ok(p.bodies['POST /api/transactions/order-ui/release'][0].reauthGrant==='grant-ui','release uses a fresh server-issued grant');
  } finally {p.close();}

  row=transaction({status:'REFUNDED',escrowStatus:'REFUNDED',sellerAckAt:null,inspectedAt:null,receivedConfirmedAt:null});
  p=await txPage(BUYER,()=>row);
  try {
    const inspection=[...p.d.querySelectorAll('.steps .step')].find(step=>/Người mua đã kiểm hàng/.test(step.textContent));
    ok(inspection&&inspection.classList.contains('pending'),'refund does not fabricate a completed inspection milestone');
    const receipt=[...p.d.querySelectorAll('.steps .step')].find(step=>/Người mua đã nhận hàng/.test(step.textContent));
    ok(receipt&&receipt.classList.contains('pending'),'refund before delivery does not fabricate buyer receipt');
  } finally {p.close();}

  const systemDispute={id:'dispute-ui',type:'INSPECTION_TIMEOUT',openedBy:'SYSTEM',status:'OPEN',reason:'Quá hạn kiểm hàng',buyerNeverConfirmedReceipt:true,createdAt:iso,evidenceDueAt:'2026-10-30T00:00:00Z',adminDueAt:'2026-11-03T00:00:00Z'};
  row=transaction({status:'DISPUTED',escrowStatus:'FROZEN',receivedConfirmedBy:'SYSTEM',receivedConfirmedAt:iso,canInspect:true,canBuyerRelease:false,dispute:systemDispute});
  p=await txPage(BUYER,()=>row,{'POST /api/transactions/order-ui/dispute/messages':opts=>{row={...row,disputeMessages:[{id:'message-ui',actorId:BUYER.id,message:JSON.parse(opts.body).message,createdAt:iso}]};return json(201,{dispute:row.dispute,transaction:row,message:row.disputeMessages[0]});}});
  try {
    ok(!!find(p,'open-inspected')&&!find(p,'open-release'),'system inspection-timeout dispute still allows inspection but not premature release');
    ok(/không phải lời khiếu nại/.test(p.viewText())&&/Người mua chưa từng tự xác nhận/.test(p.viewText()),'SYSTEM dispute does not blame a participant or pretend the buyer confirmed receipt');
    ok(!!find(p,'open-dispute'),'timeout dispute retains a path to supplement the case');
    ok(!!find(p,'open-dispute-message')&&/Báo vấn đề và yêu cầu phân xử/.test(find(p,'open-dispute').textContent),'system case separates append-only information from an actual complaint');
    await click(p,'open-dispute-message');fill(p,'disputeMessage','Thông tin bổ sung <img src=x onerror=alert(1)>');
    await click(p,'send-dispute-message',120);await click(p,'modal-close');
    ok(p.count('POST /api/transactions/order-ui/dispute/messages')===1&&p.count('POST /api/transactions/order-ui/dispute')===0,'information supplement uses the append-only endpoint without converting the SYSTEM case');
    ok(p.viewText().includes('Thông tin bổ sung <img')&&!p.d.querySelector('.card-body .note img'),'participant sees escaped stored dispute messages');
    await click(p,'open-dispute');
    ok(/đường tự giải ngân.*không còn áp dụng/.test(p.d.getElementById('modalRoot').textContent),'actual complaint explains that admin adjudication replaces unilateral timeout release');
    ok(p.d.getElementById('dsReason').maxLength===1000,'complaint length matches the server limit');
  } finally {p.close();}
  row={...row,inspectedAt:iso,canInspect:false,canBuyerRelease:true};
  p=await txPage(BUYER,()=>row);
  try {ok(!!find(p,'open-release'),'inspected system timeout dispute offers buyer release while still open');} finally {p.close();}
  row={...row,canBuyerRelease:false,dispute:{...systemDispute,type:'DEFECT',openedBy:'BUYER'}};
  p=await txPage(BUYER,()=>row);
  try {ok(!find(p,'open-release'),'participant complaint never offers unilateral buyer release');} finally {p.close();}

  row=transaction({status:'SHIPPING',receivedConfirmedBy:null,shipment:{id:'shipment-ui',status:'ARRIVED',arrivedAt:iso,serverNow:iso,packedAt:iso,pickupDueAt:iso,arrivalDueAt:iso}});
  p=await txPage(BUYER,()=>row);
  try {
    if(find(p,'modal-close')) await click(p,'modal-close');
    ok(!!find(p,'wait-confirm')&&!!find(p,'open-dispute'),'arrived order allows receipt or not-received problem reporting');
    await click(p,'wait-confirm');
    ok(!!find(p,'wait-confirm-confirm')&&p.count('POST /api/transactions/order-ui/wait-confirm')===0,'receipt is an explicit confirmation before starting inspection');
  } finally {p.close();}

  const adminDispute={...systemDispute,transactionId:'order-ui',transaction:transaction({status:'DISPUTED',escrowStatus:'FROZEN'})};
  p=await wallet({user:ADMIN,hash:'#/admin/disputes',timeoutMs:2000,extra:{
    'GET /api/admin/disputes':()=>json(200,{disputes:[adminDispute]}),
    'POST /api/admin/disputes/dispute-ui/claim':()=>json(200,{dispute:{...adminDispute,adminId:ADMIN.id},transaction:adminDispute.transaction}),
    'GET /api/admin/disputes/dispute-ui':()=>json(200,{dispute:{...adminDispute,adminId:ADMIN.id},transaction:transaction({shipping:{...shipping,address:'Số 10 <img src=x onerror=alert(1)>'}}),messages:[{id:'admin-message',actorId:BUYER.id,message:'Nội dung cho admin <script>bad()</script>',createdAt:iso}]}),
    'GET /api/notifications/todo':()=>json(200,{items:[]}),
  }});
  try {
    ok(/Người mua chưa từng tự xác nhận/.test(p.viewText()),'admin sees missing buyer receipt warning before adjudication');
    ok(!p.viewText().includes(shipping.phone),'admin dispute list does not invent or display shipping details');
    await click(p,'admin-claim-dispute');
    ok(p.count('POST /api/admin/disputes/dispute-ui/claim')===0,'claiming address access requires explicit confirmation');
    await click(p,'admin-claim-confirm',110);
    ok(p.d.getElementById('modalRoot').textContent.includes(shipping.phone),'claimed detail shows only the authorized API shipping snapshot');
    ok(!p.d.querySelector('#modalRoot .order-address img')&&p.d.getElementById('modalRoot').textContent.includes('<img'),'shipping fields are escaped rather than inserted as HTML');
    ok(p.d.getElementById('modalRoot').textContent.includes('Nội dung cho admin <script>')&&!p.d.querySelector('#modalRoot script'),'claimed admin detail renders escaped message history');
  } finally {p.close();}

  let own={...listing,sellerId:SELLER.id,status:'PENDING_SELLER_REVIEW',visibility:'HIDDEN'};
  p=await wallet({user:SELLER,hash:'#/shop',extra:{
    'GET /api/listings':()=>json(200,{listings:[own]}),
    'GET /api/notifications/todo':()=>json(200,{items:[]}),
    'POST /api/listings/item-ui/relist':()=>{own={...own,status:'AVAILABLE',visibility:'PUBLIC'};return json(200,own);},
  }});
  try {
    ok(!!find(p,'open-relist')&&/Chờ kiểm tra trước khi bán lại/.test(p.viewText()),'seller-review listing is distinct from ordinary hidden listing');
    await click(p,'open-relist');
    ok(p.count('POST /api/listings/item-ui/relist')===0&&/Hàng đã về/.test(p.d.getElementById('modalRoot').textContent),'relisting requires explicit goods custody and condition confirmation');
    await click(p,'relist-confirm',150);
    ok(p.bodies['POST /api/listings/item-ui/relist'][0].confirmed===true,'relist sends explicit seller confirmation');
    ok(!p.d.querySelector('#view [data-act="open-relist"]'),'available listing does not offer redundant relist action');
  } finally {p.close();}
  console.log(`ORDER MONEY UI: ${checks} checks passed (JSDOM + fake API/authenticator only)`);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
