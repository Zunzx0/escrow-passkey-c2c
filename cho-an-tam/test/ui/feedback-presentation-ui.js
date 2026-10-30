'use strict';
// Actual SPA, fake API/authenticator and a DOM. This does not settle real funds,
// send email, use Windows Hello, or prove production/mobile compatibility.
const assert=require('node:assert/strict');
const {wallet,json,sleep,BUYER,KEY,INTENT_PREFIX,intentJson,fakeServer,ppRow,logoutUi}=require('./paypal-wallet-ui');
let checks=0;
const ok=(value,message)=>{assert.ok(value,message);checks++;console.log('PASS '+message);};
const find=(p,act)=>p.d.querySelector('[data-act="'+act+'"]');
async function click(p,act,ms=75){const button=find(p,act);assert.ok(button,act);p.click(button);await sleep(ms);}
const result=p=>p.d.querySelector('[data-dialog-purpose="result"]');
const now=new Date().toISOString();
const row=(patch={})=>({id:'feedback-order',buyerId:BUYER.id,sellerId:'feedback-seller',buyerName:'Người mua mẫu',sellerName:'Người bán mẫu',itemName:'Sản phẩm mẫu',amount:60000,status:'SECURED',escrowStatus:'LOCKED',sellerAckAt:null,shipment:null,createdAt:now,version:1,...patch});
async function orderPage(getRow,extra={}){return wallet({hash:'#/tx/feedback-order',timeoutMs:2000,extra:{
  'GET /api/transactions':()=>json(200,{transactions:[getRow()]}),
  'GET /api/transactions/feedback-order':()=>json(200,getRow()),
  'GET /api/transactions/feedback-order/logs':()=>json(200,{logs:[]}),...extra,
}});}
function device(p){p.w.SimpleWebAuthnBrowser.startAuthentication=async()=>({id:'fake-authenticator'});}
async function main(){
  let p=await wallet();
  try{
    p.amountInput().value='1';await click(p,'topup-create');
    const error=p.d.getElementById('topupAmountError');
    ok(error&&!error.hidden&&p.amountInput().getAttribute('aria-invalid')==='true','invalid amount has a persistent error associated with its input');
    ok(p.count('POST /api/payments/paypal/topup')===0&&!p.toasts().length&&!result(p),'invalid input creates neither request, toast nor result dialog');
    p.amountInput().value='100000';p.amountInput().dispatchEvent(new p.w.Event('input',{bubbles:true}));
    ok(error.hidden&&!p.amountInput().hasAttribute('aria-invalid'),'editing the field clears its stale local error');
  }finally{p.close();}

  p=await wallet({create:()=>json(400,{error:'INVALID_AMOUNT'})});
  try{
    await click(p,'topup-create');const toast=p.d.querySelector('#toasts .toast');
    ok(toast?.getAttribute('role')==='alert'&&/Cần chú ý/.test(toast.textContent),'a routine backend rejection is an accessible brief alert');
    toast.dispatchEvent(new p.w.MouseEvent('mouseenter'));toast.querySelector('button').focus();
    await sleep(8200);
    ok(toast.isConnected&&!toast.hasAttribute('data-leaving'),'hover/focus pause dismissal beyond the normal eight-second error lifetime');
    toast.dispatchEvent(new p.w.MouseEvent('mouseleave'));await sleep(30);
    ok(toast.isConnected,'leaving the pointer does not dismiss a notification while its close button has focus');
    p.w.matchMedia=()=>({matches:true});p.click(toast.querySelector('button'));
    ok(!toast.isConnected,'explicit close remains available while the timer is paused');
  }finally{p.close();}

  let current=row(),rejectRead=false,finishCancel;
  p=await orderPage(()=>current,{
    'GET /api/transactions/feedback-order':()=>rejectRead?json(409,{error:'TEMPORARY_ERROR'}):json(200,current),
    'POST /api/transactions/feedback-order/cancel':()=>new Promise(resolve=>{finishCancel=resolve;}),
  });
  try{
    rejectRead=true;await click(p,'open-order-cancel');
    ok(p.toasts().length===1,'a rejected read before opening a form can show one brief error');
    rejectRead=false;await click(p,'open-order-cancel');
    ok(!p.toasts().length&&p.d.querySelector('[role="dialog"]'),'opening a confirmation removes brief feedback from over the dialog');
    await click(p,'order-cancel-confirm',20);
    ok(p.d.querySelector('.modal').getAttribute('aria-busy')==='true'&&[...p.d.querySelectorAll('.modal button')].every(b=>b.disabled),'pending money operation announces busy and locks confirmation/close buttons');
    p.d.dispatchEvent(new p.w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
    ok(!!p.d.querySelector('[data-act="order-cancel-confirm"]'),'Escape cannot close a pending money operation');
    finishCancel(json(200,{}));await sleep(100);
    ok(!result(p)&&p.d.querySelector('.operation-error[data-feedback-level="warn"]'),'incomplete HTTP 200 never becomes a green refund result');
    ok(!p.toasts().length&&!!find(p,'feedback-refresh'),'unknown outcome stays inside the form with a read-only status check');
    ok(find(p,'order-cancel-confirm').disabled,'unknown cancellation blocks a second write until the user checks the current status');
    current=row({status:'CANCELLED',escrowStatus:'REFUNDED'});
    await click(p,'feedback-refresh',130);
    ok(p.count('POST /api/transactions/feedback-order/cancel')===1&&!p.d.querySelector('[role="dialog"]'),'checking an uncertain result does not submit another cancellation');
    ok(/Đã hủy/.test(p.viewText()),'read-only refresh displays the canonical order state');
  }finally{p.close();}

  current=row();p=await orderPage(()=>current,{'POST /api/transactions/feedback-order/cancel':()=>{current=row({status:'CANCELLED',escrowStatus:'REFUNDED'});return json(200,current);}});
  try{
    await click(p,'open-order-cancel');await click(p,'order-cancel-confirm',140);
    ok(result(p)?.dataset.resultLevel==='ok'&&/Tiền đã hoàn vào ví người mua/.test(result(p).textContent),'confirmed cancellation has one centered refund receipt');
    ok(!p.toasts().length,'a confirmed refund has no duplicate success toast');
    await click(p,'modal-close');await sleep(50);
    ok(!p.toasts().length&&!result(p),'dismissing the final receipt does not restore old progress feedback');
  }finally{p.close();}

  current=row();p=await orderPage(()=>current,{'POST /api/transactions/feedback-order/cancel':()=>{current=row({status:'CANCELLED',escrowStatus:'REFUNDED'});return json(200,current);}});
  try{
    await click(p,'open-order-cancel');p.routes['GET /api/wallets/me']=()=>json(503,{error:'TEMPORARY_ERROR'});
    await click(p,'order-cancel-confirm',140);
    ok(result(p)?.dataset.resultLevel==='ok'&&/chưa tải lại được/.test(result(p).textContent),'a confirmed refund remains confirmed when the later balance refresh fails');
    ok(!!find(p,'feedback-refresh')&&p.count('POST /api/transactions/feedback-order/cancel')===1,'refresh failure offers a read-only check instead of another payment action');
  }finally{p.close();}

  current=row({status:'WAIT_CONFIRM',receivedConfirmedBy:'BUYER',receivedConfirmedAt:now,inspectedAt:now,canBuyerRelease:true});
  p=await orderPage(()=>current,{
    'POST /api/transactions/feedback-order/reauth/options':()=>json(200,{reauthSessionId:'fake-session',options:{}}),
    'POST /api/transactions/feedback-order/reauth/verify':()=>json(200,{reauthGrant:'fake-grant'}),
    'POST /api/transactions/feedback-order/release':()=>json(200,row({id:'different-order',status:'COMPLETED',escrowStatus:'RELEASED'})),
  });
  try{
    device(p);await click(p,'open-release');await click(p,'do-release',130);
    ok(!result(p)&&!!p.d.querySelector('.operation-error[data-feedback-level="warn"]'),'a success-shaped reply for another order cannot announce payment success');
    ok(find(p,'do-release').disabled,'uncertain release cannot be sent again directly from the old review');
    await click(p,'feedback-refresh',110);await click(p,'open-release');
    p.routes['POST /api/transactions/feedback-order/release']=()=>{current={...current,status:'COMPLETED',escrowStatus:'RELEASED'};return json(200,current);};
    await click(p,'do-release',130);
    ok(result(p)&&/Đã chuyển tiền cho người bán/.test(result(p).textContent)&&!p.toasts().length,'matching release result uses a single centered payment receipt');
  }finally{p.close();}

  const admin={...BUYER,id:'feedback-admin',role:'ADMIN'};
  for(const kind of ['refund','release']){
    current=row({status:'DISPUTED',escrowStatus:'FROZEN'});
    const dispute={id:'feedback-case',adminId:admin.id,revision:1,transactionId:current.id,transaction:current,status:'OPEN',type:'DAMAGED_GOODS',caseCode:'A1',reason:'Hàng có lỗi cần xử lý',createdAt:now,openedBy:'BUYER'};
    p=await wallet({user:admin,hash:'#/admin/disputes',extra:{
      'GET /api/admin/disputes':()=>json(200,{disputes:[dispute]}),
      'GET /api/admin/disputes/feedback-case':()=>json(200,{dispute,transaction:current,messages:[]}),
      'POST /api/admin/disputes/feedback-case/review':opts=>{const body=JSON.parse(opts.body);return json(201,{review:{id:'saved-review',decision:body.decision,basis:body.basis,createdAt:now},dispute,transaction:current});},
      'POST /api/admin/disputes/feedback-case/reauth/options':()=>json(200,{reauthSessionId:'admin-session',options:{}}),
      'POST /api/admin/disputes/feedback-case/reauth/verify':()=>json(200,{reauthGrant:'admin-grant'}),
      ['POST /api/admin/disputes/feedback-case/'+kind]:()=>{current={...current,status:kind==='refund'?'REFUNDED':'RELEASED',escrowStatus:kind==='refund'?'REFUNDED':'RELEASED'};dispute.status=kind==='refund'?'RESOLVED_REFUND':'RESOLVED_RELEASE';return json(200,{dispute,transaction:current});},
    }});
    try{
      device(p);await click(p,'admin-'+kind);
      p.d.getElementById('disputeReviewBasis').value='Đã xem hồ sơ và thông tin bổ sung của cả hai bên; ghi căn cứ phục vụ kiểm tra giao diện.';
      p.d.getElementById('disputeReviewRead').checked=true;p.d.getElementById('disputeReviewReceipt').checked=true;
      p.click(p.d.querySelector('[data-act="admin-review-save"][data-decision="'+(kind==='refund'?'REFUND':'RELEASE')+'"]'));await sleep(70);await click(p,'admin-confirm',140);
      ok(result(p)?.dataset.resultLevel==='ok'&&!p.toasts().length,'admin '+kind+' uses the API-confirmed result dialog without a second toast');
      const body=p.bodies['POST /api/admin/disputes/feedback-case/reauth/options'][0];
      ok(body.decision===(kind==='refund'?'REFUND':'RELEASE'),'presentation keeps the correct Passkey adjudication decision: '+kind);
    }finally{p.close();}
  }

  const srv=fakeServer();let completeRead;
  p=await wallet({storage:{[INTENT_PREFIX+BUYER.id]:intentJson()},extra:srv.routes(),timeoutMs:2000});
  try{
    p.routes['GET /api/payments/'+srv.row.id]=()=>new Promise(resolve=>{completeRead=resolve;});
    await click(p,'topup-check',20);await click(p,'open-sell',35);
    ok(p.d.getElementById('modalTitle').textContent==='Đăng ký bán hàng','an unrelated form can be active while an already-started status read completes');
    completeRead(json(200,ppRow({requestId:KEY,status:'SUCCEEDED',stage:'SUCCEEDED',resolvedAt:now})));await sleep(90);
    ok(!result(p)&&p.d.getElementById('modalTitle').textContent==='Đăng ký bán hàng'&&!p.toasts().length,'confirmed top-up waits without replacing or covering an unrelated form');
    await click(p,'modal-close',100);
    ok(result(p)&&/Nạp tiền thành công/.test(result(p).textContent),'deferred top-up receipt opens when the user finishes the current form');
    await click(p,'modal-close');p.w.location.hash='#/wallet';await sleep(60);
    ok(!result(p)&&!p.toasts().length,'the same completed top-up is not announced repeatedly on redraw');
  }finally{p.close();}

  const abandonServer=fakeServer();let finishAbandon,finishAbandonRead;
  p=await wallet({storage:{[INTENT_PREFIX+BUYER.id]:intentJson()},extra:abandonServer.routes(),timeoutMs:2000});
  try{
    await click(p,'topup-check');
    await click(p,'paypal-abandon');
    p.routes['POST /api/payments/paypal/'+abandonServer.row.id+'/abandon']=()=>new Promise(resolve=>{finishAbandon=resolve;});
    p.routes['GET /api/payments/'+abandonServer.row.id]=()=>new Promise(resolve=>{finishAbandonRead=resolve;});
    await click(p,'paypal-abandon-confirm',20);
    ok(p.d.querySelector('.modal')?.getAttribute('aria-busy')==='true','top-up cancellation keeps its confirmation open and busy during the POST');
    const failed=ppRow({status:'FAILED',stage:'FAILED',resolvedAt:now});
    finishAbandon(json(200,{...failed,outcome:'ABANDONED'}));await sleep(25);
    ok([...p.d.querySelectorAll('.modal button')].every(b=>b.disabled)&&!result(p),'buttons remain locked until the independent status GET completes');
    p.d.dispatchEvent(new p.w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
    ok(!!find(p,'paypal-abandon-confirm'),'Escape cannot close the cancellation while canonical status is pending');
    finishAbandonRead(json(200,failed));await sleep(100);
    ok(result(p)?.dataset.resultLevel==='info'&&/Đã hủy yêu cầu nạp/.test(result(p).textContent)&&!p.toasts().length,'confirmed top-up cancellation has one neutral result, not a payment-success toast');
    ok(p.count('POST /api/payments/paypal/'+abandonServer.row.id+'/abandon')===1,'the cancellation presentation sends only one explicit POST');
  }finally{p.close();}

  const confirmedServer=fakeServer();
  p=await wallet({storage:{[INTENT_PREFIX+BUYER.id]:intentJson()},extra:confirmedServer.routes()});
  try{
    confirmedServer.row=ppRow({status:'SUCCEEDED',stage:'SUCCEEDED',resolvedAt:now});
    p.routes['GET /api/wallets/me']=()=>json(503,{error:'TEMPORARY_ERROR'});
    await click(p,'topup-check',130);
    ok(result(p)&&/Nạp tiền thành công/.test(result(p).textContent)&&/chưa tải lại được số dư/.test(result(p).textContent),'canonical top-up success remains clear if the later wallet refresh fails');
  }finally{p.close();}

  let finishVerify;
  p=await wallet({hash:'#/audit/feedback-order',extra:{
    'GET /api/transactions/feedback-order/logs':()=>json(200,{logs:[{id:1,action:'ESCROW_LOCKED',createdAt:now,currentHash:'abc',previousHash:'genesis'}]}),
    'GET /api/transactions/feedback-order/logs/verify':()=>json(200,{valid:true,checkedCount:1}),
  }});
  try{
    await click(p,'audit-verify');const box=p.d.getElementById('auditVerification');
    ok(!box.hidden&&box.classList.contains('note-success')&&/1 bản ghi/.test(box.textContent),'audit verification has a persistent inline result beside the history');
    ok(!p.toasts().length&&!result(p)&&p.d.querySelector('.log-row'),'history/verification do not open automatic popups or disappear with a toast');
    p.routes['GET /api/transactions/feedback-order/logs/verify']=()=>json(200,{valid:false,invalidLogId:'<script>bad</script>'});await click(p,'audit-verify');
    ok(box.classList.contains('note-danger')&&box.textContent.includes('<script>bad</script>')&&!box.querySelector('script'),'an invalid history result is persistent and safely rendered as text');
    p.routes['GET /api/transactions/feedback-order/logs/verify']=()=>json(503,{error:'TEMPORARY_ERROR'});await click(p,'audit-verify');
    ok(box.classList.contains('note-warning')&&/Chưa kiểm tra được/.test(box.textContent)&&!p.toasts().length,'network/server errors do not falsely classify the history as corrupted');
    p.routes['GET /api/transactions/feedback-order/logs/verify']=()=>new Promise(resolve=>{finishVerify=resolve;});
    await click(p,'audit-verify',20);const input=p.d.getElementById('auditTxId');input.value='another-order';input.dispatchEvent(new p.w.Event('input',{bubbles:true}));
    finishVerify(json(200,{valid:true,checkedCount:99}));await sleep(70);
    ok(box.hidden&&!/99/.test(box.textContent),'late verification for the previous input cannot be shown under a different order ID');
    input.value='';await click(p,'audit-verify');
    ok(p.d.getElementById('auditTxIdError')?.textContent&&!p.toasts().length,'missing lookup ID is explained beside the lookup field');
  }finally{p.close();}

  p=await wallet({create:()=>json(400,{error:'INVALID_AMOUNT'})});
  try{
    await click(p,'topup-create');await click(p,'open-sell');
    ok(!p.toasts().length,'brief feedback is suppressed while a form is active');
    await logoutUi(p);await sleep(70);
    ok(!p.authState().token&&!result(p)&&p.toasts().every(t=>t.text.includes('Đã đăng xuất')),'signing out clears old-account feedback while allowing its own sign-out notice');
  }finally{p.close();}
  console.log(`FEEDBACK PRESENTATION UI: ${checks} checks passed (JSDOM + fake API/authenticator only)`);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
