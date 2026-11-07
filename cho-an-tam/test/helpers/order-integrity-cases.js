'use strict';
const crypto = require('node:crypto');

// Isolated HTTP/DB experiments. Trusted fixture grants exercise settlement
// guards; these cases do not claim to authenticate Windows Hello hardware.
module.exports = async function(h) {
  const { test, prepared, account, draft, lock, api, must, eq, ok, sql, rows,
    update, txn, dispute, grant, ACTIONS, allMoney, entries, db, lifecycle } = h;
  const hold = id => sql('SELECT * FROM order_integrity_holds WHERE transaction_id=?', id);
  const scan = (o, actor=o.b) => api('/transactions/'+o.id+'/logs/verify', actor, {});
  async function corrupt(o) {
    const log = await sql('SELECT * FROM audit_logs WHERE transaction_id=? ORDER BY sequence_no LIMIT 1', o.id);
    await update('UPDATE audit_logs SET event_data=? WHERE id=?', JSON.stringify({ tampered:true }), log.id);
    return log;
  }
  async function unchangedMoney(before) { eq(await allMoney(), before, 'detection never changes wallets or ledger'); }
  async function releaseReady() {
    const o = await prepared('WAIT_CONFIRM');
    must(await api('/transactions/'+o.id+'/inspected', o.b, {}));
    o.g = await grant(o.b,o.id,ACTIONS.RELEASE);
    return o;
  }
  const pay = o => api('/transactions/'+o.id+'/release',o.b,{requestId:crypto.randomUUID(),reauthGrant:o.g.rawToken});
  async function openCase(decision) {
    const o = await prepared('WAIT_CONFIRM'); o.a = await account('ADMIN');
    must(await api('/transactions/'+o.id+'/dispute',o.b,{type:'DAMAGED_GOODS',reason:'Tình huống tổng hợp cần kiểm tra dữ liệu và giữ tiền.'}),201);
    o.d=await dispute(o.id);o.g=await grant(o.a,o.id,ACTIONS.ADJUDICATE,decision);
    return o;
  }
  const decide = (o,decision) => api('/admin/disputes/'+o.d.id+'/'+decision.toLowerCase(),o.a,{requestId:crypto.randomUUID(),reauthGrant:o.g.rawToken});
  async function unused(g) {
    eq((await sql('SELECT used_at FROM reauth_grants WHERE token_hash=?',crypto.createHash('sha256').update(g.rawToken).digest('hex'))).used_at,null,'blocked settlement does not consume grant');
  }

  await test('OI01','healthy on-demand check preserves an existing release authorization',async()=>{
    const o=await releaseReady(),before=await txn(o.id),money=await allMoney();
    const r=must(await scan(o));eq(r.valid,true);eq(r.chainValid,true);eq(r.businessValid,true);eq(r.moneyBlocked,false);eq(r.coverage,'SNAPSHOT_AND_LEDGER');
    eq(await txn(o.id),before);eq(await hold(o.id),undefined);await unchangedMoney(money);
    must(await pay(o));eq((await txn(o.id)).status,'COMPLETED');eq(must(await scan(o)).valid,true);
  });
  await test('OI02','changed audit content creates a persistent per-order hold without moving money',async()=>{
    const o=await releaseReady(),log=await corrupt(o),money=await allMoney();
    const r=must(await scan(o));eq(r.valid,false);eq(r.reason,'HASH_MISMATCH');eq(r.invalidLogId,log.id);ok(r.integrityHold?.active);eq(r.moneyBlocked,true);
    ok(log.id!==log.sequence_no,'fixture distinguishes the database ID from chain position');
    eq(r.invalidSequenceNo,log.sequence_no);eq(r.expectedSequenceNo,log.sequence_no);
    eq(r.integrityHold.invalidSequenceNo,log.sequence_no);eq(r.integrityHold.expectedSequenceNo,log.sequence_no);
    eq((await txn(o.id)).escrow_status,'FROZEN');await unchangedMoney(money);
    const result=await pay(o);eq(result.status,409);eq(result.data.error,'ORDER_INTEGRITY_BLOCKED');await unused(o.g);await unchangedMoney(money);
    const repeated=must(await scan(o));eq(repeated.valid,false);eq(Number((await sql('SELECT COUNT(*) n FROM order_integrity_holds WHERE transaction_id=?',o.id)).n),1);
    eq(Number((await sql("SELECT COUNT(*) n FROM security_events WHERE event_type='ORDER_INTEGRITY_HOLD' AND detail LIKE ?",'%'+o.id+'%')).n),1);
  });
  await test('OI03','middle deletion reports the first observed sequence gap, not an invented deleted ID',async()=>{
    const o=await prepared('WAIT_CONFIRM');
    const list=await rows('SELECT * FROM audit_logs WHERE transaction_id=? ORDER BY sequence_no',o.id);ok(list.length>2);
    await update('DELETE FROM audit_logs WHERE id=?',list[1].id);
    const r=must(await scan(o));eq(r.valid,false);eq(r.reason,'SEQUENCE_BROKEN');eq(r.invalidLogId,list[2].id);ok((await hold(o.id)));
    eq(r.expectedSequenceNo,list[1].sequence_no);eq(r.invalidSequenceNo,list[2].sequence_no);
    eq(r.integrityHold.expectedSequenceNo,list[1].sequence_no);eq(r.integrityHold.invalidSequenceNo,list[2].sequence_no);
  });
  await test('OI04','middle insertion without recomputing hashes is detected',async()=>{
    const o=await prepared('WAIT_CONFIRM');
    const list=await rows('SELECT * FROM audit_logs WHERE transaction_id=? ORDER BY sequence_no DESC',o.id);
    for(const log of list)if(log.sequence_no>=2)await update('UPDATE audit_logs SET sequence_no=? WHERE id=?',log.sequence_no+1,log.id);
    await update("INSERT INTO audit_logs(transaction_id,sequence_no,action,event_data,previous_hash,current_hash,created_at) VALUES(?,2,'FORGED_EVENT','{}',?,?,?)",o.id,'0'.repeat(64),crypto.randomBytes(32).toString('hex'),new Date().toISOString());
    const money=await allMoney(),r=must(await scan(o));eq(r.valid,false);ok(['HASH_MISMATCH','SEQUENCE_BROKEN'].includes(r.reason));await unchangedMoney(money);ok(await hold(o.id));
  });
  await test('OI05','malformed JSON is a detected incident, not a parser 500 or lost evidence',async()=>{
    const o=await prepared(),log=await sql('SELECT id FROM audit_logs WHERE transaction_id=? ORDER BY sequence_no LIMIT 1',o.id);
    await update('UPDATE audit_logs SET event_data=? WHERE id=?','{broken-json',log.id);
    const r=must(await scan(o));eq(r.reason,'MALFORMED_EVENT_DATA');eq(r.valid,false);ok(r.integrityHold?.active);
    const history=must(await api('/transactions/'+o.id+'/logs',o.b));ok(history.logs.some(item=>item.eventDataMalformed));
    eq((await sql('SELECT event_data FROM audit_logs WHERE id=?',log.id)).event_data,'{broken-json','bad evidence is preserved');
  });
  await test('OI06','transaction amount change is caught even when the audit hash chain remains valid',async()=>{
    const o=await prepared();await update('UPDATE transactions SET amount=65000 WHERE id=?',o.id);const money=await allMoney();
    const r=must(await scan(o));eq(r.chainValid,true);eq(r.businessValid,false);eq(r.reason,'ORDER_DATA_MISMATCH');ok(r.fields.includes('amount'));await unchangedMoney(money);eq((await txn(o.id)).escrow_status,'FROZEN');
    eq(r.invalidSequenceNo,null,'a business mismatch does not label a valid hash record as corrupt');
    eq(r.referenceSequenceNo,1);eq(r.integrityHold.referenceSequenceNo,1);
  });
  await test('OI07','transaction state change without a corresponding event is detected',async()=>{
    const o=await prepared();await update("UPDATE transactions SET status='WAIT_CONFIRM' WHERE id=?",o.id);
    const r=must(await scan(o));eq(r.chainValid,true);eq(r.reason,'ORDER_STATE_MISMATCH');ok(r.integrityHold?.active);
  });
  await test('OI08','changed transfer delta is detected without changing any balances during the scan',async()=>{
    const o=await prepared();await update("UPDATE wallet_entries SET available_delta=available_delta-1 WHERE transaction_id=? AND entry_type='ESCROW_LOCK_DEBIT'",o.id);
    const money=await allMoney(),r=must(await scan(o));eq(r.chainValid,true);eq(r.reason,'LEDGER_DATA_MISMATCH');await unchangedMoney(money);ok(r.integrityHold?.active);
  });
  await test('OI09','new ledger commitments cover metadata as well as transfer amounts',async()=>{
    const o=await prepared();await update("UPDATE wallet_entries SET description='Edited outside the application' WHERE transaction_id=? AND entry_type='ESCROW_LOCK_DEBIT'",o.id);
    const r=must(await scan(o));eq(r.chainValid,true);eq(r.reason,'LEDGER_DATA_MISMATCH');eq(r.valid,false);
  });
  for(const decision of ['REFUND','RELEASE'])await test('OI'+(decision==='REFUND'?'10':'11'),'assigned admin cannot '+decision+' an incident-held case with a preissued grant',async()=>{
    const o=await openCase(decision);await corrupt(o);const money=await allMoney();
    const r=must(await api('/admin/transactions/'+o.id+'/logs/verify',o.a,{}));ok(r.integrityHold?.active);
    const denied=await decide(o,decision);eq(denied.status,409);eq(denied.data.error,'ORDER_INTEGRITY_BLOCKED');await unused(o.g);await unchangedMoney(money);
    ok(must(await api('/admin/disputes/'+o.d.id,o.a)).transaction.integrityHold?.active,'admin detail exposes the same incident hold');
    eq(must(await api('/admin/disputes/'+o.d.id,o.a)).transaction.integrityHold.invalidSequenceNo,1,'admin detail preserves incident chain position');
    ok(must(await api('/admin/disputes',o.a)).disputes.find(item=>item.id===o.d.id).transaction.integrityHold?.active,'admin list exposes the same incident hold');
    eq((await api('/admin/disputes/'+o.d.id+'/reauth/options',o.a,{decision})).data.error,'ORDER_INTEGRITY_BLOCKED');
    eq((await dispute(o.id)).status,'OPEN');
  });
  await test('OI12','held orders are not auto-refunded when the seller deadline expires',async()=>{
    const o=await prepared();await update('UPDATE transactions SET secured_at=? WHERE id=?',new Date(Date.now()-49*3600000).toISOString(),o.id);await corrupt(o);must(await scan(o));
    const money=await allMoney();await lifecycle();await lifecycle();await unchangedMoney(money);eq((await txn(o.id)).escrow_status,'FROZEN');eq((await entries(o.id)).filter(e=>e.entry_type==='ESCROW_REFUND_DEBIT').length,0);
  });
  await test('OI13','direct cancellation detects corruption and preserves the hold after business rollback',async()=>{
    const o=await prepared(),healthy=await draft(o.b,o.s);must(await lock(o.b,healthy));await corrupt(o);const money=await allMoney();
    const denied=await api('/transactions/'+o.id+'/cancel',o.b,{});eq(denied.status,409);eq(denied.data.error,'ORDER_INTEGRITY_FAILURE');ok(await hold(o.id));eq((await txn(o.id)).escrow_status,'FROZEN');await unchangedMoney(money);
    must(await api('/transactions/'+healthy+'/cancel',o.b,{}));eq((await txn(healthy)).escrow_status,'REFUNDED');eq(await hold(healthy),undefined,'other order of the same buyer is not quarantined');
  });
  await test('OI14','direct admin settlement detects corruption and preserves the hold after rollback',async()=>{
    const o=await openCase('REFUND');await corrupt(o);const money=await allMoney();
    const r=await decide(o,'REFUND');eq(r.status,409);eq(r.data.error,'ORDER_INTEGRITY_FAILURE');ok(await hold(o.id));await unused(o.g);await unchangedMoney(money);eq((await dispute(o.id)).status,'OPEN');
  });
  await test('OI15','restoring audit bytes alone never automatically clears a recorded incident',async()=>{
    const o=await releaseReady(),original=await corrupt(o);must(await scan(o));
    await update('UPDATE audit_logs SET event_data=? WHERE id=?',original.event_data,original.id);
    const r=must(await scan(o));eq(r.chainValid,true);eq(r.valid,false);eq(r.moneyBlocked,true);ok(r.integrityHold?.active);eq((await pay(o)).data.error,'ORDER_INTEGRITY_BLOCKED');await unused(o.g);
    eq(r.invalidSequenceNo,null,'restored chain is not reported as currently corrupt');
    eq(r.integrityHold.invalidSequenceNo,original.sequence_no,'the original observed incident position remains recorded');
    eq(must(await api('/transactions/'+o.id,o.b)).integrityHold.invalidSequenceNo,original.sequence_no,'order reload retains incident trace');
  });
  await test('OI16','a stranger cannot scan or quarantine another buyer order',async()=>{
    const o=await prepared(),stranger=await account();await corrupt(o);
    eq((await scan(o,stranger)).status,403);eq((await api('/transactions/'+o.id+'/logs/verify',stranger)).status,403);eq(await hold(o.id),undefined);eq((await txn(o.id)).escrow_status,'LOCKED');
    eq((await api('/transactions/'+o.id+'/logs/verify',null,{})).status,401);eq(await hold(o.id),undefined);
  });
  await test('OI17','GET diagnostics remain read-only; POST persists the incident',async()=>{
    const o=await prepared();await corrupt(o);const old=await txn(o.id);
    const r=must(await api('/transactions/'+o.id+'/logs/verify',o.b));eq(r.valid,false);eq(r.integrityHold,null);eq(await hold(o.id),undefined);eq(await txn(o.id),old);
    must(await scan(o));ok(await hold(o.id));eq((await txn(o.id)).escrow_status,'FROZEN');
  });
  await test('OI18','a discovered historical incident never creates escrow funds for an already completed order',async()=>{
    const o=await releaseReady();must(await pay(o));await corrupt(o);const money=await allMoney();
    const r=must(await scan(o));ok(r.integrityHold?.active);eq(r.escrowCurrentlyHeld,false);eq((await txn(o.id)).escrow_status,'RELEASED');await unchangedMoney(money);
    eq((await pay(o)).data.error,'ORDER_INTEGRITY_BLOCKED');
  });
  await test('OI19','later legitimate messages cannot launder an earlier modified ledger row',async()=>{
    const o=await prepared();must(await api('/transactions/'+o.id+'/dispute',o.b,{type:'NOT_RECEIVED',reason:'Tình huống tổng hợp cần kiểm tra lịch sử đơn.'}),201);
    await update("UPDATE wallet_entries SET description='Tampered historical receipt' WHERE transaction_id=? AND entry_type='ESCROW_LOCK_DEBIT'",o.id);
    must(await api('/transactions/'+o.id+'/dispute/messages',o.b,{message:'Người mua bổ sung thông tin hợp lệ sau khi dữ liệu đã bị sửa.'}),201);
    const r=must(await scan(o));eq(r.chainValid,true);eq(r.reason,'LEDGER_DATA_MISMATCH');ok(r.integrityHold?.active);
  });
  await test('OI20','failure to persist an incident is never returned as a successful freeze',async()=>{
    const o=await releaseReady();await corrupt(o);const money=await allMoney(),prepare=db.prepare.bind(db);
    db.prepare=sqlText=>/INSERT INTO order_integrity_holds/.test(sqlText)?{run:async()=>{throw new Error('synthetic incident storage failure');}}:prepare(sqlText);
    let r;try{r=await scan(o);}finally{db.prepare=prepare;}
    eq(r.status,500);eq(await hold(o.id),undefined);await unused(o.g);await unchangedMoney(money);
    ok(must(await scan(o)).integrityHold?.active,'a later successful write records the hold');
  });
  await test('OI21','legacy audit rows stay unchanged and get explicitly limited reconciliation',async()=>{
    const o=await prepared(),hash=require('../../src/lib/hash');
    let previous=hash.GENESIS_HASH;
    for(const log of await rows('SELECT * FROM audit_logs WHERE transaction_id=? ORDER BY sequence_no',o.id)){
      const event=JSON.parse(log.event_data);delete event.integritySnapshot;
      const current=hash.sha256Hex(hash.canonicalJson({transactionId:log.transaction_id,sequenceNo:log.sequence_no,actorId:log.actor_id||null,action:log.action,oldStatus:log.old_status||null,newStatus:log.new_status||null,eventData:event,createdAt:log.created_at,previousHash:previous}));
      await update('UPDATE audit_logs SET event_data=?,previous_hash=?,current_hash=? WHERE id=?',JSON.stringify(event),previous,current,log.id);previous=current;
    }
    // This fixture represents an older valid format; it is not presented as a
    // detected attack that recomputes all hashes, which is outside this scope.
    const old=await rows('SELECT * FROM audit_logs WHERE transaction_id=? ORDER BY sequence_no',o.id);
    const r=must(await scan(o));eq(r.valid,true);eq(r.coverage,'LEGACY_AMOUNT_STATE_AND_LEDGER');eq(await rows('SELECT * FROM audit_logs WHERE transaction_id=? ORDER BY sequence_no',o.id),old);
    await update('UPDATE transactions SET amount=65000 WHERE id=?',o.id);eq(must(await scan(o)).reason,'ORDER_DATA_MISMATCH');
  });
  await test('OI22','changing the recipient cannot redirect held money to another valid account',async()=>{
    const o=await prepared(),attacker=await account('SELLER');await update('UPDATE transactions SET seller_id=? WHERE id=?',attacker.id,o.id);const money=await allMoney();
    const r=must(await scan(o));eq(r.reason,'ORDER_DATA_MISMATCH');ok(r.fields.includes('sellerId'));await unchangedMoney(money);ok(r.integrityHold?.active);
  });
  await test('OI23','expiry worker itself detects corruption and records its hold after rollback',async()=>{
    const o=await prepared();await update('UPDATE transactions SET secured_at=? WHERE id=?',new Date(Date.now()-49*3600000).toISOString(),o.id);await corrupt(o);const money=await allMoney();
    await lifecycle();ok(await hold(o.id));eq((await txn(o.id)).escrow_status,'FROZEN');await unchangedMoney(money);eq((await entries(o.id)).filter(e=>e.entry_type==='ESCROW_REFUND_DEBIT').length,0);
  });
  await test('OI24','concurrent on-demand checks create one incident and no transfer',async()=>{
    const o=await prepared();await corrupt(o);const money=await allMoney();
    const result=await Promise.all([scan(o),scan(o,o.s),scan(o)]);for(const r of result){eq(r.status,200);eq(r.data.valid,false);ok(r.data.integrityHold?.active);}
    eq(Number((await sql('SELECT COUNT(*) n FROM order_integrity_holds WHERE transaction_id=?',o.id)).n),1);await unchangedMoney(money);
  });
  await test('OI25','buyer release detects corruption before any prior verification request',async()=>{
    const o=await releaseReady();await corrupt(o);const money=await allMoney();
    const r=await pay(o);eq(r.status,409);eq(r.data.error,'ORDER_INTEGRITY_FAILURE');ok(await hold(o.id));eq((await txn(o.id)).escrow_status,'FROZEN');await unused(o.g);await unchangedMoney(money);
  });
  await test('OI26','incident holds survive application startup and additive migrations',async()=>{
    const o=await releaseReady(),original=await corrupt(o);must(await scan(o));const saved=await hold(o.id),money=await allMoney();
    await update('UPDATE audit_logs SET event_data=? WHERE id=?',original.event_data,original.id);
    const restarted=await h.restart();eq(restarted.code,0,'independent application DB startup succeeds');
    eq(await hold(o.id),saved,'startup does not clear the incident');eq((await txn(o.id)).escrow_status,'FROZEN');await unchangedMoney(money);
    eq((await pay(o)).data.error,'ORDER_INTEGRITY_BLOCKED');
  });
  await test('OI27','integrity migration is repeat-safe and preserves existing incident evidence and money',async()=>{
    const before=await rows('SELECT * FROM order_integrity_holds ORDER BY transaction_id'),money=await allMoney();
    for(let i=0;i<2;i++){
      if(db.dialect==='pg')await db.exec(require('node:fs').readFileSync(require('node:path').join(__dirname,'../../src/schema.pg.016-order-integrity-holds.sql'),'utf8'));
      else require('../../src/lib/orderIntegrity').migrateSqlite(db.raw);
    }
    eq(await rows('SELECT * FROM order_integrity_holds ORDER BY transaction_id'),before);await unchangedMoney(money);
  });
  await test('OI28','falsely marking an unpaid-out escrow as settled cannot avoid freezing its held funds',async()=>{
    const o=await prepared(),money=await allMoney();await update("UPDATE transactions SET status='COMPLETED',escrow_status='RELEASED' WHERE id=?",o.id);
    const r=must(await scan(o));eq(r.valid,false);eq(r.chainValid,true);eq(r.referenceEscrowStatus,'LOCKED');eq(r.escrowStatus,'FROZEN');eq((await txn(o.id)).escrow_status,'FROZEN');await unchangedMoney(money);
    eq((await api('/transactions/'+o.id,o.b)).data.integrityHold.referenceEscrowStatus,'LOCKED');
  });
  await test('OI29','a deleted historical payout leg cannot manufacture a new frozen balance',async()=>{
    const o=await releaseReady();must(await pay(o));await update("DELETE FROM wallet_entries WHERE transaction_id=? AND entry_type='ESCROW_RELEASE_DEBIT'",o.id);
    const money=await allMoney(),r=must(await scan(o));eq(r.valid,false);eq(r.referenceEscrowStatus,'RELEASED');eq(r.escrowCurrentlyHeld,false);eq((await txn(o.id)).escrow_status,'RELEASED');await unchangedMoney(money);
  });
};
