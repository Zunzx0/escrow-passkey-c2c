'use strict';
// Actual SPA in JSDOM, fake API. Money and permissions are covered separately
// through real HTTP on isolated SQLite/PostgreSQL, not by these render checks.
const assert=require('node:assert/strict');
const {wallet,json,sleep,BUYER}=require('./paypal-wallet-ui');
let checks=0;
const ok=(condition,message)=>{assert.ok(condition,message);checks++;console.log('PASS '+message);};
const now=new Date().toISOString();
const SELLER={...BUYER,id:'integrity-seller',role:'SELLER'};
const ADMIN={...BUYER,id:'integrity-admin',role:'ADMIN'};
const held={active:true,detectedAt:now,reason:'ORDER_DATA_MISMATCH',invalidLogId:null,referenceSequenceNo:2};
const row=patch=>({id:'integrity-order',buyerId:BUYER.id,sellerId:SELLER.id,buyerName:'Người mua',sellerName:'Người bán',itemName:'Món hàng tổng hợp',amount:60000,status:'WAIT_CONFIRM',escrowStatus:'LOCKED',version:4,createdAt:now,updatedAt:now,inspectedAt:now,canInspect:true,canBuyerRelease:true,...patch});
async function page(user,getRow,extra={}){
  return wallet({user,hash:'#/tx/integrity-order',timeoutMs:5000,extra:{
    'GET /api/transactions':()=>json(200,{transactions:[getRow()]}),
    'GET /api/transactions/integrity-order':()=>json(200,getRow()),
    'GET /api/transactions/integrity-order/logs':()=>json(200,{logs:[]}),
    'GET /api/notifications/todo':()=>json(200,{items:[]}),...extra
  }});
}
const find=(p,act)=>p.d.querySelector('[data-act="'+act+'"]');
async function click(p,act,wait=90){const button=find(p,act);assert.ok(button,'button '+act);p.click(button);await sleep(wait);}
async function waitFor(condition,label){
  const until=Date.now()+3000;
  while(!condition()){
    assert.ok(Date.now()<until,'timed out waiting for '+label);
    await sleep(20);
  }
}

async function main(){
  let current=row({integrityHold:held,escrowStatus:'FROZEN'});
  let p=await page(BUYER,()=>current);
  try{
    ok(!find(p,'open-release')&&!find(p,'secure')&&!find(p,'open-order-cancel'),'held buyer order offers no payment, release or refund action');
    ok(p.viewText().includes('tạm dừng chuyển tiền và hoàn tiền'),'buyer sees the per-order money restriction');
    ok(p.viewText().includes('Đơn không tự mở lại'),'buyer is not promised automatic recovery');
    ok(p.viewText().includes('thông tin đã ghi nhận tại mốc nhật ký 2'),'a business mismatch identifies its reference without accusing a valid log row');
    ok(!p.d.querySelector('.escrow-box .amount'),'corrupt stored amount is not presented as a verified escrow balance');
    ok(p.count('POST /api/transactions/integrity-order/release')===0,'rendering a held order never sends a settlement');
  }finally{p.close();}

  p=await wallet({user:BUYER,hash:'#/orders',extra:{
    'GET /api/transactions':()=>json(200,{transactions:[row({integrityHold:held,escrowStatus:'FROZEN'})]})
  }});
  try{
    const card=p.d.querySelector('.order');
    ok(!!card,'held order remains accessible in the order list');
    ok(card.textContent.includes('Đang kiểm tra dữ liệu'),'order list identifies an integrity incident');
    ok(card.querySelector('.order-amount b').textContent==='Đang đối chiếu','order list does not present a suspect amount as verified money');
    ok(!find(p,'open-release')&&!find(p,'open-order-cancel'),'order list offers no settlement or cancellation on a held order');
    ok(card.textContent.includes('Việc chuyển tiền và hoàn tiền đã tạm dừng'),'order list gives the same restriction as the detail page');
  }finally{p.close();}

  current=row({status:'SECURED',escrowStatus:'FROZEN',integrityHold:held});
  p=await page(SELLER,()=>current);
  try{
    ok(!find(p,'open-order-reject')&&!find(p,'acknowledge')&&!find(p,'pack'),'held seller order does not offer ordinary cancellation or fulfillment steps');
    ok(p.viewText().includes('Tạm dừng xử lý tiền'),'seller sees the incident state');
  }finally{p.close();}

  const cases=[true,false].map((isHeld,index)=>({id:'integrity-case-'+index,caseCode:'A'+(index+1),status:'OPEN',type:'DAMAGED_GOODS',categoryCode:'A',openedBy:'BUYER',adminId:ADMIN.id,createdAt:now,reason:'Hồ sơ tổng hợp để kiểm tra giao diện.',transactionId:'integrity-case-order-'+index,transaction:row({id:'integrity-case-order-'+index,status:'DISPUTED',escrowStatus:'FROZEN',integrityHold:isHeld?held:null})}));
  p=await wallet({user:ADMIN,hash:'#/admin/disputes',extra:{'GET /api/admin/disputes':()=>json(200,{disputes:cases})}});
  try{
    for(const act of ['admin-refund','admin-release','admin-more']){
      ok(!p.d.querySelector('[data-act="'+act+'"][data-id="integrity-case-0"]'),'held case hides '+act);
      ok(!!p.d.querySelector('[data-act="'+act+'"][data-id="integrity-case-1"]'),'unrelated case retains '+act);
    }
    ok(p.viewText().includes('Đang đối chiếu'),'admin sees that the incident amount is unverified');
    ok(!!p.d.querySelector('[data-act="admin-claim-dispute"][data-id="integrity-case-0"]'),'incident case remains readable through assigned private detail');
  }finally{p.close();}

  current=row({});let finish;
  p=await page(BUYER,()=>current,{'POST /api/transactions/integrity-order/logs/verify':()=>new Promise(resolve=>{finish=resolve;})});
  try{
    ok(!!find(p,'open-release'),'healthy order initially offers release');
    await click(p,'tx-verify-chain',25);p.click(find(p,'tx-verify-chain'));await sleep(20);
    ok(p.count('POST /api/transactions/integrity-order/logs/verify')===1,'double click sends one authenticated POST verification');
    ok(p.count('GET /api/transactions/integrity-order/logs/verify')===0,'state-changing verification is not sent as GET');
    current=row({integrityHold:held,escrowStatus:'FROZEN'});
    finish(json(200,{valid:false,chainValid:true,businessValid:false,reason:'ORDER_DATA_MISMATCH',invalidLogId:null,integrityHold:held,escrowStatus:'FROZEN'}));
    await waitFor(()=>!find(p,'open-release'),'incident response to remove the release action');
    ok(!find(p,'open-release'),'newly detected incident removes the existing release control immediately');
    ok(p.d.getElementById('txChainResult').textContent.includes('tạm dừng'),'transaction page keeps the incident result visible');
    ok(!p.d.getElementById('txChainResult').textContent.includes('#null'),'data mismatch does not invent a corrupt log number');
    ok(p.d.querySelector('.escrow-box').textContent.includes('Tạm dừng xử lý tiền'),'escrow card updates together with the action card');
    ok(!p.d.querySelector('[data-dialog-purpose="result"]'),'verification does not invent a payment success dialog');
  }finally{p.close();}

  p=await wallet({user:BUYER,hash:'#/audit/integrity-order',extra:{
    'GET /api/transactions/integrity-order/logs':()=>json(200,{logs:[]}),
    'POST /api/transactions/integrity-order/logs/verify':()=>json(200,{valid:false,integrityHold:held,reason:'ORDER_DATA_MISMATCH',invalidLogId:null})
  }});
  try{
    await click(p,'audit-verify');
    const box=p.d.getElementById('auditVerification');
    ok(box.getAttribute('role')==='alert'&&box.classList.contains('note-danger'),'audit page presents a persistent error result');
    ok(box.textContent.includes('riêng đơn này')&&box.textContent.includes('không tự mở lại'),'audit page explains the scope and lack of automatic recovery');
    ok(!box.textContent.includes('#null'),'audit result has no fictional record position');
    ok(p.count('POST /api/transactions/integrity-order/logs/verify')===1,'audit page uses the POST verification endpoint');
  }finally{p.close();}

  for(const gap of [false,true]){
    const observed=gap?4:3,expected=3;
    const incident={active:true,reason:gap?'SEQUENCE_BROKEN':'HASH_MISMATCH',invalidLogId:987,invalidSequenceNo:observed,expectedSequenceNo:expected};
    p=await page(BUYER,()=>row({}),{'POST /api/transactions/integrity-order/logs/verify':()=>json(200,{valid:false,chainValid:false,...incident,integrityHold:incident,escrowStatus:'FROZEN'})});
    try{
      await click(p,'tx-verify-chain');
      const text=p.d.getElementById('txChainResult').textContent;
      ok(gap?text.includes('cần mốc 3, gặp mốc 4'):text.includes('mốc nhật ký 3'),'verification describes '+(gap?'expected and observed sequence':'the observed chain sequence'));
      ok(!text.includes('987'),'database primary key is not mislabeled as a chain position');
      ok(!find(p,'open-release'),'position reporting retains the money hold');
      ok(!/bản ghi.*đã bị xóa/.test(text),'an observed gap is not claimed to identify an original deleted row');
    }finally{p.close();}
  }

  p=await page(BUYER,()=>row({}),{'POST /api/transactions/integrity-order/logs/verify':()=>json(200,{valid:'true',checkedCount:2})});
  try{
    await click(p,'tx-verify-chain');
    ok(!p.d.getElementById('txChainResult').querySelector('.note-success'),'malformed verification response is never shown as success');
    ok(!!p.d.getElementById('txChainResult').querySelector('.note-warning'),'incomplete response has a neutral retry message');
  }finally{p.close();}

  p=await page(BUYER,()=>row({}),{'POST /api/transactions/integrity-order/logs/verify':()=>json(200,{valid:true,checkedCount:2,moneyBlocked:true,integrityHold:held})});
  try{
    await click(p,'tx-verify-chain');
    ok(!p.d.getElementById('txChainResult').querySelector('.note-success'),'a contradictory success flag cannot hide an explicit incident hold');
    ok(p.d.getElementById('txChainResult').querySelector('[role="alert"]'),'the contradictory result is announced as an incident');
    ok(!find(p,'open-release'),'an explicit hold still removes the release action despite contradictory fields');
  }finally{p.close();}

  p=await wallet({user:BUYER,hash:'#/audit/integrity-order',extra:{
    'GET /api/transactions/integrity-order/logs':()=>json(200,{logs:[]}),
    'POST /api/transactions/integrity-order/logs/verify':()=>json(200,{valid:true,checkedCount:2,moneyBlocked:true,integrityHold:held})
  }});
  try{
    await click(p,'audit-verify');
    const box=p.d.getElementById('auditVerification');
    ok(box.classList.contains('note-danger')&&!box.classList.contains('note-success'),'audit result gives an explicit hold priority over a conflicting success flag');
    ok(box.textContent.includes('không tự mở lại'),'the saved hold remains clear on the audit page');
  }finally{p.close();}

  let delayed;
  p=await page(BUYER,()=>row({}),{
    'POST /api/transactions/integrity-order/logs/verify':()=>new Promise(resolve=>{delayed=resolve;}),
    'GET /api/transactions/another-integrity-order':()=>json(200,row({id:'another-integrity-order',itemName:'Đơn khác vẫn hợp lệ'})),
    'GET /api/transactions/another-integrity-order/logs':()=>json(200,{logs:[]})
  });
  try{
    await click(p,'tx-verify-chain',25);p.w.location.hash='#/tx/another-integrity-order';
    await waitFor(()=>p.viewText().includes('Đơn khác vẫn hợp lệ'),'the other order to load');
    ok(p.viewText().includes('Đơn khác vẫn hợp lệ'),'navigation opens the other order while verification is pending');
    delayed(json(200,{valid:false,integrityHold:held,escrowStatus:'FROZEN'}));await sleep(90);
    ok(!!find(p,'open-release'),'late incident response does not hide another order release action');
    ok(!p.d.getElementById('txChainResult').textContent.includes('tạm dừng'),'late result is not applied to a different order');
  }finally{p.close();}
  console.log(`ORDER INTEGRITY UI: ${checks} checks passed (JSDOM + fake API; no hardware or live settlement)`);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
