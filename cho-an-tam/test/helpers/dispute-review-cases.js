'use strict';
const crypto=require('node:crypto');

// Real HTTP and isolated DB, including cryptographic WebAuthn with a software
// authenticator. This is not a Windows Hello or production acceptance test.
module.exports=async function(h){
  const {test,prepared,account,api,must,eq,ok,sql,rows,update,txn,dispute,grant,review,ACTIONS,allMoney,entries,db,issueGrant,adminRouter}=h;
  async function open(){const o=await prepared(),a=await account('ADMIN');must(await api('/transactions/'+o.id+'/dispute',o.b,{type:'NOT_RECEIVED',reason:'Tình huống mô phỏng chưa nhận được kiện hàng.'}),201);return {...o,a,d:await dispute(o.id)};}
  const post=(o,suffix,body,actor=o.a)=>api('/admin/disputes/'+o.d.id+suffix,actor,body);
  const saveBody=async(o,decision='REFUND')=>({decision,basis:'Đã đối chiếu lời trình bày và thông tin giao nhận trong tình huống kiểm thử; cần quyết định theo căn cứ ghi trong hồ sơ.',reviewed:true,receiptAcknowledged:true,expectedDisputeRevision:(await dispute(o.id)).revision,expectedOrderVersion:(await txn(o.id)).version});
  async function device(actor){
    const authenticator=require('../softwareAuthenticator').createAuthenticator();
    const challenge=crypto.randomBytes(32).toString('base64url');
    const registration=authenticator.register({rpId:'localhost',origin:'http://localhost',challenge,uv:true});
    const checked=await require('@simplewebauthn/server').verifyRegistrationResponse({response:registration,expectedChallenge:challenge,expectedOrigin:'http://localhost',expectedRPID:'localhost',requireUserVerification:true});
    ok(checked.verified,'software registration cryptographically verified');
    await update('UPDATE passkey_credentials SET credential_id=?,public_key=? WHERE id=?',authenticator.credentialId,Buffer.from(checked.registrationInfo.credential.publicKey),actor.credentialId);
    return authenticator;
  }
  async function options(o,decision='REFUND',reviewId){return post(o,'/reauth/options',{decision,reviewId});}
  async function verified(o,auth,opt,extra={}){return post(o,'/reauth/verify',{reauthSessionId:opt.reauthSessionId,response:auth.authenticate({rpId:'localhost',origin:'http://localhost',challenge:opt.options.challenge,uv:true,...extra})});}
  async function rawGrant(o,decision='REFUND'){
    const t=await txn(o.id),d=await dispute(o.id),context=adminRouter.buildAdjudicationContext(d,t,decision,o.a.id,o.a.sessionId);
    return issueGrant({userId:o.a.id,sessionId:o.a.sessionId,transactionId:o.id,disputeId:d.id,action:ACTIONS.ADJUDICATE,decision,credentialId:o.a.credentialId,contextHash:crypto.createHash('sha256').update(JSON.stringify(context)).digest('hex')});
  }
  await test('DR1','direct API cannot authorize unclaimed or unreviewed cases, even with a trusted grant',async()=>{
    const o=await open(),before=await allMoney();
    eq((await options(o)).data.error,'DISPUTE_CLAIM_REQUIRED');
    eq((await post(o,'/review',await saveBody(o))).data.error,'DISPUTE_CLAIM_REQUIRED');
    must(await post(o,'/claim',{}));
    eq((await options(o)).data.error,'DISPUTE_REVIEW_REQUIRED');
    const g=await rawGrant(o);
    eq((await post(o,'/refund',{requestId:crypto.randomUUID(),reauthGrant:g.rawToken})).data.error,'DISPUTE_REVIEW_REQUIRED');
    eq(Number((await sql('SELECT COUNT(*) n FROM auth_challenges WHERE transaction_id=?',o.id)).n),0);
    eq((await txn(o.id)).escrow_status,'FROZEN');eq(await allMoney(),before);
  });
  await test('DR2','review requires basis, reading confirmation, receipt acknowledgement and current versions',async()=>{
    const o=await open();must(await post(o,'/claim',{}));const base=await saveBody(o),before=await allMoney();
    for(const patch of [{basis:''},{basis:'short'},{basis:'x'.repeat(2001)},{reviewed:false},{receiptAcknowledged:false},{expectedOrderVersion:null}]){
      const r=await post(o,'/review',{...base,...patch});eq(r.status,400);ok(Object.keys(r.data.fields||{}).length>0);
    }
    const other=await account('ADMIN'),snapshot=await allMoney();eq((await post(o,'/review',base,other)).data.error,'DISPUTE_ASSIGNED');eq(await allMoney(),snapshot);
    eq(Number((await sql('SELECT COUNT(*) n FROM dispute_reviews WHERE dispute_id=?',o.d.id)).n),0);
    const r=must(await post(o,'/review',base),201);eq(r.review.decision,'REFUND');
    eq((await post(o,'/review',base)).data.error,'DISPUTE_REVIEW_STALE');
    eq(await allMoney(),snapshot);ok(before.entries.length<=snapshot.entries.length);
  });
  await test('DR3','request more information preserves money, blocks Passkey and is privately visible to both parties',async()=>{
    const o=await open();must(await post(o,'/claim',{}));const stranger=await account(),before=await allMoney();
    const r=must(await post(o,'/review',{...await saveBody(o,'REQUEST_MORE'),receiptAcknowledged:false}),201);
    eq((await options(o,'REFUND',r.review.id)).data.error,'DISPUTE_REVIEW_REQUIRED');
    for(const actor of [o.b,o.s]){const detail=must(await api('/transactions/'+o.id,actor));eq(detail.dispute.lastReview.id,r.review.id);eq(detail.dispute.lastReview.basis,r.review.basis);}
    eq((await api('/transactions/'+o.id,stranger)).status,403);
    eq((await txn(o.id)).escrow_status,'FROZEN');eq((await entries(o.id)).filter(e=>e.entry_type==='ESCROW_REFUND_DEBIT').length,0);
    const audit=await rows('SELECT event_data FROM audit_logs WHERE transaction_id=?',o.id);
    ok(audit.every(e=>!JSON.stringify(e).includes(r.review.basis)),'private basis never enters audit payload');
    eq(Number((await sql("SELECT COUNT(*) n FROM reauth_grants WHERE transaction_id=? AND action='ADJUDICATE'",o.id)).n),0);
    eq(await allMoney(),before);
  });
  await test('DR4','both decisions require saved review and valid UV signature; one canonical settlement survives replay',async()=>{
    for(const decision of ['REFUND','RELEASE']){
      const o=await open(),auth=await device(o.a);await review(o.a,o.id,decision);
      const r=await require('../../src/lib/disputeReview').latestReview(db,o.d.id);
      const opt=must(await options(o,decision,r.id));eq(opt.context.reviewId,r.id);ok(opt.context.reviewDigest.length===64);
      eq((await verified(o,auth,opt,{uv:false})).status,400);
      const token=must(await verified(o,auth,opt)),requestId=crypto.randomUUID();
      const path='/'+decision.toLowerCase(),body={requestId,reauthGrant:token.reauthGrant,reviewId:r.id};
      must(await post(o,path,body));must(await post(o,path,body));
      eq((await entries(o.id)).filter(e=>['ESCROW_RELEASE_DEBIT','ESCROW_REFUND_DEBIT'].includes(e.entry_type)).length,1);
      eq((await txn(o.id)).escrow_status,decision==='REFUND'?'REFUNDED':'RELEASED');
      const event=await sql("SELECT event_data FROM audit_logs WHERE transaction_id=? AND action=?",o.id,decision==='REFUND'?'ADMIN_REFUND':'ADMIN_RELEASE');
      ok(event.event_data.includes(r.id),'settlement links immutable review');
    }
  });
  await test('DR5','new evidence invalidates saved reviews, challenges and grants without moving money',async()=>{
    const o=await open(),auth=await device(o.a);await review(o.a,o.id,'REFUND');
    let r=await require('../../src/lib/disputeReview').latestReview(db,o.d.id),opt=must(await options(o,'REFUND',r.id));
    must(await api('/transactions/'+o.id+'/dispute/messages',o.b,{message:'Thông tin mới cần quản trị viên đọc lại trước khi xác thực.'}),201);
    eq((await verified(o,auth,opt)).data.error,'DISPUTE_REVIEW_STALE');
    eq((await options(o,'REFUND',r.id)).data.error,'DISPUTE_REVIEW_STALE');
    await review(o.a,o.id,'REFUND');r=await require('../../src/lib/disputeReview').latestReview(db,o.d.id);opt=must(await options(o,'REFUND',r.id));
    const issued=must(await verified(o,auth,opt)),before=await allMoney();
    must(await api('/transactions/'+o.id+'/dispute/messages',o.s,{message:'Bổ sung của người bán sau khi cấp phiếu; cần đọc lại.'}),201);
    eq((await post(o,'/refund',{requestId:crypto.randomUUID(),reauthGrant:issued.reauthGrant,reviewId:r.id})).data.error,'DISPUTE_REVIEW_STALE');
    eq(await allMoney(),before);eq((await txn(o.id)).escrow_status,'FROZEN');
    eq((await sql('SELECT used_at FROM reauth_grants WHERE token_hash=?',crypto.createHash('sha256').update(issued.reauthGrant).digest('hex'))).used_at,null);
  });
  await test('DR6','changed decision and request-more supersede earlier authorizations; concurrent saves have one winner',async()=>{
    const o=await open(),auth=await device(o.a);await review(o.a,o.id,'REFUND');
    const r=await require('../../src/lib/disputeReview').latestReview(db,o.d.id),opt=must(await options(o,'REFUND',r.id));
    const body=await saveBody(o,'RELEASE');
    const saves=await Promise.all([post(o,'/review',body),post(o,'/review',{...body,decision:'REQUEST_MORE'})]);
    eq(saves.filter(x=>x.status===201).length,1);eq(saves.filter(x=>x.status===409).length,1);
    eq((await verified(o,auth,opt)).status,409);
    await review(o.a,o.id,'REQUEST_MORE');eq((await options(o,'RELEASE',r.id)).data.error,'DISPUTE_REVIEW_REQUIRED');
    eq((await txn(o.id)).escrow_status,'FROZEN');
    let blocked=0;for(const query of ['UPDATE dispute_reviews SET basis=? WHERE id=?','DELETE FROM dispute_reviews WHERE id=?']){
      try{await (query.startsWith('UPDATE')?update(query,'Attempt to overwrite private immutable review',r.id):update(query,r.id));}catch(e){blocked++;}
    }eq(blocked,2);eq((await sql('SELECT basis FROM dispute_reviews WHERE id=?',r.id)).basis,r.basis);
  });
  await test('DR7','signature verification racing new messages cannot settle an obsolete review',async()=>{
    for(let i=0;i<5;i++){
      const o=await open(),auth=await device(o.a);await review(o.a,o.id,'REFUND');const r=await require('../../src/lib/disputeReview').latestReview(db,o.d.id),opt=must(await options(o,'REFUND',r.id));
      const [v,m]=await Promise.all([verified(o,auth,opt),api('/transactions/'+o.id+'/dispute/messages',o.b,{message:'Bổ sung đồng thời khi quản trị viên đang ký xác thực.'})]);
      must(m,201);ok([200,409].includes(v.status));
      if(v.status===200)eq((await post(o,'/refund',{requestId:crypto.randomUUID(),reauthGrant:v.data.reauthGrant,reviewId:r.id})).status,409);
      eq((await txn(o.id)).escrow_status,'FROZEN');eq((await entries(o.id)).filter(e=>e.entry_type==='ESCROW_REFUND_DEBIT').length,0);
    }
  });
  await test('DR8','review migration is repeat-safe and never invents reviews for historical outcomes',async()=>{
    const before=await rows('SELECT * FROM dispute_reviews ORDER BY id'),money=await allMoney();
    const historical=await rows("SELECT id,admin_id,admin_decision,status FROM disputes WHERE status<>'OPEN' AND id NOT IN (SELECT dispute_id FROM dispute_reviews) ORDER BY id");
    ok(historical.length>0,'historical decisions without a review remain represented honestly');
    for(let i=0;i<2;i++){
      if(require('../../src/db').DIALECT==='pg')await db.exec(require('node:fs').readFileSync(require('node:path').join(__dirname,'../../src/schema.pg.015-dispute-reviews.sql'),'utf8'));
      else await require('../../src/lib/disputeReview').migrateSqlite(db);
    }
    eq(await rows('SELECT * FROM dispute_reviews ORDER BY id'),before);
    eq(await rows("SELECT id,admin_id,admin_decision,status FROM disputes WHERE status<>'OPEN' AND id NOT IN (SELECT dispute_id FROM dispute_reviews) ORDER BY id"),historical);
    eq(await allMoney(),money);
  });
};
