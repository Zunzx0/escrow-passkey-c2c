'use strict';
const crypto=require('node:crypto');

// Real HTTP + isolated DB. Grants are trusted test fixtures, not hardware Passkeys.
module.exports=async function assignmentCases(h){
  const {test,prepared,account,api,must,eq,sql,txn,dispute,grant,ACTIONS,allMoney,entries}=h;
  async function open(){
    const order=await prepared();
    const result=must(await api('/transactions/'+order.id+'/dispute',order.b,{type:'DAMAGED_GOODS',reason:'Sản phẩm kiểm thử có lỗi cần xem xét.'}),201);
    return {...order,caseId:result.dispute.id};
  }
  const claim=(id,admin)=>api('/admin/disputes/'+id+'/claim',admin,{});
  async function settle(order,admin,decision,requestId=crypto.randomUUID()){
    const g=await grant(admin,order.id,ACTIONS.ADJUDICATE,decision);
    return {response:await api('/admin/disputes/'+order.caseId+'/'+decision.toLowerCase(),admin,{requestId,reauthGrant:g.rawToken}),g,requestId};
  }

  await test('DA1','claimed case rejects another administrator at options, verify and settlement',async()=>{
    const order=await open(),owner=await account('ADMIN'),other=await account('ADMIN');
    must(await claim(order.caseId,owner));
    const before=await allMoney(),profile=await dispute(order.id);
    for(const [suffix,body] of [
      ['/reauth/options',{decision:'REFUND'}],
      ['/reauth/verify',{reauthSessionId:'not-issued',response:{id:'not-issued'}}],
    ]){
      const result=await api('/admin/disputes/'+order.caseId+suffix,other,body);
      eq(result.status,409);eq(result.data.error,'DISPUTE_ASSIGNED');
    }
    for(const decision of ['REFUND','RELEASE']){
      const {response,g}=await settle(order,other,decision);
      eq(response.status,409);eq(response.data.error,'DISPUTE_ASSIGNED');
      eq((await sql('SELECT used_at FROM reauth_grants WHERE token_hash=?',crypto.createHash('sha256').update(g.rawToken).digest('hex'))).used_at,null,'denied settlement never consumes the fixture grant');
    }
    eq(await allMoney(),before,'non-owner cannot change any money');
    eq(await dispute(order.id),profile,'non-owner cannot rewrite the case owner or revision');
    eq((await txn(order.id)).escrow_status,'FROZEN');
    const own=await settle(order,owner,'REFUND');must(own.response);
    eq((await txn(order.id)).escrow_status,'REFUNDED');
    const replay=await api('/admin/disputes/'+order.caseId+'/refund',other,{requestId:own.requestId,reauthGrant:'not-issued'});
    eq(replay.status,409);eq(replay.data.error,'DISPUTE_ASSIGNED','an identical requestId is not a substitute for case assignment');
    eq((await entries(order.id)).filter(e=>e.entry_type==='ESCROW_REFUND_DEBIT').length,1);
  });

  await test('DA2','two administrators racing to claim have one owner and one settlement',async()=>{
    const order=await open(),admins=[await account('ADMIN'),await account('ADMIN')];
    const results=await Promise.all(admins.map(a=>claim(order.caseId,a)));
    eq(results.filter(r=>r.status===200).length,1);eq(results.filter(r=>r.status===409).length,1);
    const owner=(await dispute(order.id)).admin_id;
    const winner=admins.find(a=>a.id===owner),loser=admins.find(a=>a.id!==owner);
    const before=await allMoney();
    const denied=await settle(order,loser,'REFUND');eq(denied.response.status,409);eq(denied.response.data.error,'DISPUTE_ASSIGNED');
    eq(await allMoney(),before);
    const [valid,invalid]=await Promise.all([settle(order,winner,'RELEASE'),settle(order,loser,'REFUND')]);
    must(valid.response);eq(invalid.response.status,409);eq(invalid.response.data.error,'DISPUTE_ASSIGNED');
    eq((await txn(order.id)).status,'RELEASED');eq((await dispute(order.id)).admin_id,owner);
    eq((await entries(order.id)).filter(e=>['ESCROW_RELEASE_DEBIT','ESCROW_REFUND_DEBIT'].includes(e.entry_type)).length,1);
  });
};
