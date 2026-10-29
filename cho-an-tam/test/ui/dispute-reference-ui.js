'use strict';
// Actual SPA + fake API only. Not a real payment, DB or device-authenticator test.
const assert=require('node:assert/strict');
const {wallet,json,sleep,BUYER}=require('./paypal-wallet-ui');
const {CATEGORIES}=require('../../src/lib/disputeReference');
const ADMIN={...BUYER,id:'reference-admin',role:'ADMIN'},now=new Date().toISOString();
let checks=0;
const ok=(c,m)=>{assert.ok(c,m);checks++;console.log('PASS '+m);};
const base=()=>({id:'reference-order',buyerId:BUYER.id,sellerId:'reference-seller',itemName:'Sản phẩm mẫu',amount:60000,status:'SECURED',escrowStatus:'LOCKED',createdAt:now});
async function click(p,act,ms=70){const el=p.d.querySelector('[data-act="'+act+'"]');assert.ok(el,act);p.click(el);await sleep(ms);}

async function main(){
  let row=base();
  let p=await wallet({hash:'#/tx/reference-order',extra:{
    'GET /api/transactions':()=>json(200,{transactions:[row]}),
    'GET /api/transactions/reference-order':()=>json(200,row),
    'GET /api/transactions/reference-order/logs':()=>json(200,{logs:[]}),
    'GET /api/notifications/todo':()=>json(200,{items:[]}),
    'POST /api/transactions/reference-order/dispute':opts=>{
      const body=JSON.parse(opts.body);
      row={...row,status:'DISPUTED',escrowStatus:'FROZEN',dispute:{id:'uuid-dispute',caseCode:'B12',caseNumber:12,casePrefix:'B',categoryCode:'B',type:body.type,reason:body.reason,status:'OPEN',openedBy:'BUYER',createdAt:now}};
      return json(201,{dispute:row.dispute,transaction:row});
    },
  }});
  try {
    await click(p,'open-dispute');
    const choices=[...p.d.getElementById('dsType').options];
    ok(choices.length===6&&choices[0].value==='','user must explicitly choose one of five complaint types');
    for(const [type,c] of Object.entries(CATEGORIES).filter(([type])=>!['DEFECT','INSPECTION_TIMEOUT','SHIPMENT_STALLED'].includes(type))) {
      const option=choices.find(v=>v.value===type);
      ok(option&&option.textContent===c.code+' — '+c.label,'FE/BE category mapping agrees: '+c.code);
    }
    ok(!choices.some(v=>['DEFECT','INSPECTION_TIMEOUT','SHIPMENT_STALLED'].includes(v.value)),'manual picker cannot file a legacy or automatic timeout category');
    p.d.getElementById('dsReason').value='Sản phẩm thực nhận khác mô tả trong tin đăng.';
    await click(p,'do-dispute');
    ok(p.count('POST /api/transactions/reference-order/dispute')===0,'missing classification never creates a case');
    p.d.getElementById('dsType').value='NOT_AS_DESCRIBED';await click(p,'do-dispute',140);
    const body=p.bodies['POST /api/transactions/reference-order/dispute'][0];
    ok(body.type==='NOT_AS_DESCRIBED'&&!('caseCode' in body)&&!('caseNumber' in body),'browser submits type, not an invented reference number');
    ok(p.d.getElementById('modalTitle').textContent==='Đã lưu hồ sơ B12','success dialog uses the reference returned by the API');
    await click(p,'modal-close');
    ok(/Hồ sơ B12/.test(p.viewText())&&/B — Hàng không đúng mô tả/.test(p.viewText()),'participant case card shows both readable code and full category');
    ok(p.log.filter(x=>x.startsWith('POST ')).every(x=>x==='POST /api/transactions/reference-order/dispute'),'naming a case never invokes a settlement operation');
  } finally {p.close();}

  const cases=[
    {id:'uuid-a',caseCode:'A1',casePrefix:'A',categoryCode:'A',type:'DAMAGED_GOODS'},
    {id:'uuid-b',caseCode:'B2',casePrefix:'B',categoryCode:'B',type:'NOT_AS_DESCRIBED'},
    {id:'uuid-converted',caseCode:'F3',casePrefix:'F',categoryCode:'B',type:'NOT_AS_DESCRIBED'},
    {id:'uuid-legacy',caseCode:'L4',casePrefix:'L',categoryCode:'L',type:'DEFECT'},
    {id:'uuid-system',caseCode:'G5',casePrefix:'G',categoryCode:'G',type:'SHIPMENT_STALLED',openedBy:'SYSTEM'},
  ].map(d=>({status:'OPEN',reason:'Nội dung cần xem xét <img src=x onerror=alert(1)>',openedBy:'BUYER',createdAt:now,transactionId:'reference-order',transaction:base(),...d}));
  p=await wallet({user:ADMIN,hash:'#/admin/disputes',extra:{
    'GET /api/admin/disputes':()=>json(200,{disputes:cases}),
    'GET /api/notifications/todo':()=>json(200,{items:[]}),
  }});
  try {
    const select=p.d.getElementById('disputeCategoryFilter');
    ok(select&&select.options.length===9,'admin can filter all seven explicit categories plus the legacy group');
    ok(/A — Hàng hỏng hoặc có lỗi \(1\)/.test(select.textContent)&&/B — Hàng không đúng mô tả \(2\)/.test(select.textContent),'counts use current category, including a converted system case');
    ok(!p.d.querySelector('#adminPanel img'),'untrusted case reason remains escaped');
    select.value='B';select.dispatchEvent(new p.w.Event('change',{bubbles:true}));await sleep(120);
    const cards=[...p.d.querySelectorAll('#adminPanel h3')].map(n=>n.textContent);
    ok(cards.length===2&&cards.some(v=>v.includes('B2'))&&cards.some(v=>v.includes('F3')),'filtering by current category does not rename the original reference');
    ok(/Mã hồ sơ được giữ nguyên/.test(p.viewText()),'converted case explains why the original prefix is retained');
    ok(p.count('POST /api/admin/disputes/uuid-b/reauth/options')===0,'filtering is read-only');
    const button=p.d.querySelector('[data-act="admin-refund"][data-id="uuid-b"]');
    ok(button&&button.dataset.id==='uuid-b','actions retain opaque IDs instead of substituting the display code');
    p.click(button);await sleep(40);
    ok(/Hồ sơ B2/.test(p.d.getElementById('modalTitle').textContent),'financial review identifies the correct case before Passkey');
    ok(p.count('POST /api/admin/disputes/uuid-b/reauth/options')===0,'opening review does not perform authentication or settlement');
    await click(p,'modal-close');
    const filter=p.d.getElementById('disputeCategoryFilter');filter.value='C';filter.dispatchEvent(new p.w.Event('change',{bubbles:true}));await sleep(120);
    ok(/Không có hồ sơ thuộc loại này/.test(p.viewText())&&p.d.getElementById('disputeCategoryFilter'),'an empty category keeps the filter available to return');
    const legacyFilter=p.d.getElementById('disputeCategoryFilter');legacyFilter.value='L';legacyFilter.dispatchEvent(new p.w.Event('change',{bubbles:true}));await sleep(120);
    ok(p.d.querySelector('#adminPanel h3').textContent.includes('L4')&&/chưa tách loại/.test(p.viewText()),'combined historical product complaints are not silently classified as damage');
  } finally {p.close();}
  console.log(`DISPUTE REFERENCE UI: ${checks} checks passed (JSDOM + fake API only)`);
}
main().catch(e=>{console.error(e);process.exitCode=1;});
