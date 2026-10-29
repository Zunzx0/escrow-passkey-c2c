'use strict';
const crypto=require('node:crypto');

// Called by the existing isolated SQLite/PostgreSQL HTTP + ledger suite.
module.exports=async function referenceCases(h) {
  const {test,prepared,account,api,must,eq,ok,sql,txn,dispute,lifecycle,update,allMoney}=h;
  const counter=async()=>Number((await sql('SELECT last_number FROM dispute_case_counter WHERE id=1')).last_number);
  const post=(id,b,type,extra={})=>api('/transactions/'+id+'/dispute',b,{type,reason:'Thông tin kiểm thử loại vấn đề riêng biệt.',...extra});

  await test('REF1','five specific complaint types share one durable sequence',async()=>{
    const admin=await account('ADMIN');
    for(const [type,prefix] of [['DAMAGED_GOODS','A'],['NOT_AS_DESCRIBED','B'],['MISSING_ITEMS','C'],['NOT_SHIPPED','D'],['NOT_RECEIVED','E']]) {
      const {id,b}=await prepared();const before=await counter(),money=await allMoney();
      const r=must(await post(id,b,type,{caseCode:'Z99999',caseNumber:99999,casePrefix:'Z'}),201);
      eq(r.dispute.caseCode,prefix+(before+1));eq(r.dispute.caseNumber,before+1);eq(r.dispute.categoryCode,prefix);eq(r.dispute.type,type);
      eq(await allMoney(),money,'classifying a complaint never moves money again');
      const detail=must(await api('/transactions/'+id,b));eq(detail.dispute.caseCode,r.dispute.caseCode);
      eq(detail.disputeCaseCode,r.dispute.caseCode,'transaction DTO exposes the same display reference');
      const ad=must(await api('/admin/disputes/'+r.dispute.id,admin));eq(ad.dispute.caseCode,r.dispute.caseCode);
      ok((await sql("SELECT title FROM notifications WHERE transaction_id=? AND type='DISPUTE_OPENED' LIMIT 1",id)).title.includes(r.dispute.caseCode),'new notification carries the same case code');
    }
  });

  await test('REF2','parallel cases have unique references without extra debits',async()=>{
    const orders=[];for(let i=0;i<6;i++)orders.push(await prepared());
    const before=await counter(),money=await allMoney();
    const responses=await Promise.all(orders.map((o,i)=>post(o.id,o.b,i%2?'NOT_AS_DESCRIBED':'DAMAGED_GOODS')));
    const numbers=responses.map(r=>must(r,201).dispute.caseNumber);
    eq(numbers.slice().sort((a,b)=>a-b),Array.from({length:6},(_,i)=>before+i+1));
    eq(new Set(responses.map(r=>r.data.dispute.caseCode)).size,6);eq(await allMoney(),money);
  });

  await test('REF3','same-order retries preserve reference and initial complaint type',async()=>{
    const {id,b,s}=await prepared(),before=await counter(),money=await allMoney();
    const r=await Promise.all([post(id,b,'DAMAGED_GOODS'),post(id,s,'NOT_AS_DESCRIBED')]);
    ok(r.every(v=>[200,201].includes(v.status)));eq(new Set(r.map(v=>v.data.dispute.caseCode)).size,1);
    eq(await counter(),before+1);eq(await allMoney(),money);eq(r[0].data.dispute.type,r[1].data.dispute.type);
  });

  await test('REF4','failed or unauthorized requests allocate no case and retain money',async()=>{
    const {id,b}=await prepared(),outsider=await account(),before=await counter(),money=await allMoney();
    for(const type of ['INSPECTION_TIMEOUT','SHIPMENT_STALLED','__proto__','UNRECOGNIZED'])eq((await post(id,b,type)).status,400);
    eq((await post(id,outsider,'DAMAGED_GOODS')).status,403);
    eq((await post(id,b,'NOT_AS_DESCRIBED',{imageIds:[crypto.randomUUID()]})).status,403);
    eq(await counter(),before,'attachment failure rolls allocation back with the dispute');
    eq(await dispute(id),undefined);eq((await txn(id)).status,'SECURED');eq((await txn(id)).escrow_status,'LOCKED');eq(await allMoney(),money);
    const d=must(await post(id,b,'NOT_AS_DESCRIBED'),201).dispute;eq(d.caseNumber,before+1);
    eq((await api('/transactions/'+id,outsider)).status,403);
    eq((await api('/admin/disputes/'+d.id,outsider)).status,403);
    eq((await api('/transactions/'+d.caseCode,outsider)).status,404,'display code is not a replacement authorization identifier');
  });

  await test('REF5','system case conversion keeps its public reference and records the new category',async()=>{
    const {id,b}=await prepared('WAIT_CONFIRM');
    await update('UPDATE transactions SET inspection_due_at=? WHERE id=?',new Date(Date.now()-1).toISOString(),id);await lifecycle();
    const initial=must(await api('/transactions/'+id,b)).dispute;ok(/^F[1-9]\d*$/.test(initial.caseCode));eq(initial.categoryCode,'F');
    const before=await counter(),money=await allMoney();
    const converted=must(await post(id,b,'DAMAGED_GOODS')).dispute;
    eq(converted.id,initial.id);eq(converted.caseCode,initial.caseCode);eq(converted.casePrefix,'F');eq(converted.categoryCode,'A');eq(converted.type,'DAMAGED_GOODS');
    eq(await counter(),before);eq(await allMoney(),money);eq((await txn(id)).escrow_status,'FROZEN');
    const d=must(await api('/transactions/'+id,b));ok(d.disputeMessages.some(m=>m.message===initial.reason),'original system explanation is retained');
  });

  await test('REF6','older combined complaint remains explicitly unclassified',async()=>{
    const {id,b}=await prepared();const d=must(await post(id,b,'DEFECT'),201).dispute;
    ok(/^L[1-9]\d*$/.test(d.caseCode));eq(d.categoryCode,'L');ok(d.typeLabel.includes('chưa tách loại'));
  });
};
