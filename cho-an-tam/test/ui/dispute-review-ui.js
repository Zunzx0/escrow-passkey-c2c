'use strict';
// Actual SPA in JSDOM, API and device are fake. Real money guards are tested over HTTP.
const assert=require('node:assert/strict');
const {wallet,json,sleep,BUYER}=require('./paypal-wallet-ui');
const admin={...BUYER,id:'review-admin',role:'ADMIN'},now=new Date().toISOString();
let checks=0;const ok=(value,message)=>{assert.ok(value,message);checks++;console.log('PASS '+message);};
const selector=(p,act)=>p.d.querySelector('[data-act="'+act+'"]');
async function click(p,act){const b=selector(p,act);assert.ok(b,act);p.click(b);await sleep(65);}
async function page(){
  const transaction={id:'review-order',buyerId:'review-buyer',sellerId:'review-seller',buyerName:'Người mua mẫu',sellerName:'Người bán mẫu',itemName:'Sản phẩm mô phỏng',amount:60000,status:'DISPUTED',escrowStatus:'FROZEN',version:8,receivedConfirmedBy:null};
  const dispute={id:'review-case',caseCode:'E8',status:'OPEN',adminId:admin.id,transactionId:transaction.id,transaction,revision:4,reason:'Chưa nhận được hàng trong tình huống mô phỏng.',openedBy:'BUYER',buyerNeverConfirmedReceipt:true,createdAt:now};
  const p=await wallet({user:admin,hash:'#/admin/disputes',extra:{
    'GET /api/admin/disputes':()=>json(200,{disputes:[dispute]}),
    'GET /api/admin/disputes/review-case':()=>json(200,{dispute,transaction,messages:[{actorId:transaction.buyerId,message:'Thông tin bổ sung <script>bad()</script>',createdAt:now}],imageEvidence:[]}),
    'POST /api/admin/disputes/review-case/review':opts=>{const body=JSON.parse(opts.body),review={id:'immutable-review',decision:body.decision,basis:body.basis,createdAt:now,disputeRevision:5,orderVersion:9};return json(201,{review,dispute:{...dispute,revision:5,lastReview:review},transaction:{...transaction,version:9}});},
    'POST /api/admin/disputes/review-case/reauth/options':()=>json(409,{error:'DISPUTE_REVIEW_STALE'}),
  }});return p;
}
function complete(p){p.d.getElementById('disputeReviewBasis').value='Đã đối chiếu diễn biến giao nhận và lời trình bày của hai bên; cần ghi rõ căn cứ xử lý tình huống mô phỏng.';p.d.getElementById('disputeReviewRead').checked=true;const r=p.d.getElementById('disputeReviewReceipt');if(r)r.checked=true;}
async function main(){
  let p=await page();
  try{
    await click(p,'admin-release');
    ok(!selector(p,'admin-confirm'),'Passkey decision is absent before a saved review');
    ok(!p.d.querySelector('.modal-body script'),'untrusted evidence is escaped');
    ok(p.d.querySelector('.modal-body').textContent.includes('Thông tin bổ sung'),'fresh case messages are available before review');
    const save=p.d.querySelector('[data-act="admin-review-save"][data-decision="RELEASE"]');
    p.click(save);await sleep(30);
    for(const field of ['basis','reviewed','receiptAcknowledged'])ok(!!p.d.querySelector('[data-review-error="'+field+'"]').textContent,'validation appears at '+field);
    ok(p.count('POST /api/admin/disputes/review-case/review')===0,'incomplete review never reaches the server');
    complete(p);let done;p.routes['POST /api/admin/disputes/review-case/review']=opts=>new Promise(resolve=>{done=()=>resolve(json(201,{review:{id:'immutable-review',decision:'RELEASE',basis:JSON.parse(opts.body).basis,createdAt:now},dispute:{revision:5},transaction:{version:9,buyerName:null,sellerName:null}}));});
    p.click(save);await sleep(25);
    ok([...p.d.querySelectorAll('.modal button,.modal input,.modal textarea')].every(e=>e.disabled),'all controls including cancel are locked while saving');
    ok(p.count('POST /api/admin/disputes/review-case/reauth/options')===0,'saving does not start device authentication');
    done();await sleep(80);
    ok(!!selector(p,'admin-confirm')&&p.d.querySelector('.modal-body').textContent.includes('Đã đối chiếu'),'saved immutable basis is shown in separate final review');
    ok(p.d.querySelector('.modal-body').textContent.includes('Người bán mẫu'),'sparse review response cannot erase the recipient name from the reviewed case');
    ok(p.count('POST /api/admin/disputes/review-case/reauth/options')===0,'separate final click is required');
    let deviceCalls=0;p.w.SimpleWebAuthnBrowser.startAuthentication=async()=>{deviceCalls++;throw new Error('should not call');};
    await click(p,'admin-confirm');
    ok(p.bodies['POST /api/admin/disputes/review-case/reauth/options'][0].reviewId==='immutable-review','challenge request identifies saved review');
    ok(deviceCalls===0,'stale review blocks device prompt');
    ok(p.d.querySelector('.operation-error')?.textContent.includes('Hồ sơ hoặc quyết định đã thay đổi'),'stale decision stays in the dialog with a clear message');
    ok(p.count('POST /api/admin/disputes/review-case/release')===0,'stale review never calls settlement');
  }finally{p.close();}
  p=await page();try{
    await click(p,'admin-refund');complete(p);
    p.click(p.d.querySelector('[data-act="admin-review-save"][data-decision="REFUND"]'));await sleep(65);
    p.routes['POST /api/admin/disputes/review-case/reauth/options']=()=>json(200,{reauthSessionId:'software-ui-session',options:{}});
    p.w.SimpleWebAuthnBrowser.startAuthentication=async()=>{throw new p.w.DOMException('Cancelled by user','NotAllowedError');};
    await click(p,'admin-confirm');
    ok(p.count('POST /api/admin/disputes/review-case/reauth/verify')===0&&p.count('POST /api/admin/disputes/review-case/refund')===0,'device cancellation never verifies a grant or settles money');
    ok(!!selector(p,'admin-confirm')&&!selector(p,'admin-confirm').disabled,'cancelled authentication can be retried without silently paying');
    ok(p.d.querySelector('.modal-body').textContent.includes('Đã đối chiếu'),'saved basis stays visible after device cancellation');
    ok(!p.d.querySelector('[data-dialog-purpose="result"]'),'cancellation never creates a successful receipt');
  }finally{p.close();}
  p=await page();try{
    await click(p,'admin-more');complete(p);await click(p,'admin-review-save');
    ok(p.d.querySelector('.modal-body').textContent.includes('chưa trả cho bên nào'),'request-more confirms money remains held');
    ok(p.bodies['POST /api/admin/disputes/review-case/review'][0].decision==='REQUEST_MORE','request-more is an explicit server decision');
    ok(p.count('POST /api/admin/disputes/review-case/reauth/options')===0&&!selector(p,'admin-confirm'),'request-more cannot invoke Passkey or settle');
  }finally{p.close();}
  p=await page();try{
    let finish;const original=p.routes['GET /api/admin/disputes/review-case'];let reads=0;p.routes['GET /api/admin/disputes/review-case']=()=>++reads===1?new Promise(resolve=>{finish=resolve;}):original();
    p.click(selector(p,'admin-refund'));await sleep(20);await click(p,'modal-close');await click(p,'admin-more');
    const title=p.d.getElementById('modalTitle').textContent;finish(json(200,{dispute:{id:'review-case',status:'OPEN',adminId:admin.id},transaction:{}}));await sleep(65);
    ok(p.d.getElementById('modalTitle').textContent===title&&p.d.querySelector('[data-act="admin-review-save"][data-decision="REQUEST_MORE"]')&&!p.d.querySelector('[data-decision="REFUND"]'),'late case load does not replace a newer modal');
  }finally{p.close();}
  console.log('DISPUTE REVIEW UI: '+checks+' checks passed (JSDOM + fake API only)');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
