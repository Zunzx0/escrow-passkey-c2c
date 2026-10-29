'use strict';
// Real temporary SQLite; no application DB, environment file or user data.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const Database=require('../src/lib/sqlite');
const {migrateSqlite}=require('../src/lib/disputeReferenceMigration');
const {referenceFields}=require('../src/lib/disputeReference');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'enclave-dispute-reference-')),file=path.join(dir,'migration.db');
let raw=new Database(file),checks=0;
function eq(a,b,label){assert.deepEqual(a,b,label);checks++;}
try {
  raw.exec(`CREATE TABLE disputes(id TEXT PRIMARY KEY,type TEXT NOT NULL,reason TEXT,status TEXT,created_at TEXT);
    CREATE TABLE wallet_entries(id TEXT PRIMARY KEY,amount INTEGER,idempotency_key TEXT);
    CREATE TABLE audit_logs(id INTEGER PRIMARY KEY,event_data TEXT,prev_hash TEXT,hash TEXT);`);
  for(const [id,type] of [['one','DEFECT'],['two','NOT_RECEIVED'],['three','INSPECTION_TIMEOUT'],['four','unknown']]) {
    raw.prepare('INSERT INTO disputes VALUES(?,?,?,?,?)').run(id,type,'Original description '+id,'OPEN','2026-10-29T00:00:0'+(['one','two','three','four'].indexOf(id)+1)+'Z');
  }
  raw.exec("INSERT INTO wallet_entries VALUES('unchanged',123456,'original-idempotency-key'); INSERT INTO audit_logs VALUES(1,'original-event','previous-hash','original-hash')");
  const old=raw.prepare('SELECT * FROM disputes ORDER BY id').all();
  const ledger=raw.prepare('SELECT * FROM wallet_entries').all(),audit=raw.prepare('SELECT * FROM audit_logs').all();
  migrateSqlite(raw);
  const rows=raw.prepare('SELECT * FROM disputes ORDER BY case_number').all();
  eq(rows.map(d=>referenceFields(d).caseCode),['L1','E2','F3','L4'],'legacy backfill is chronological and does not invent a specific product complaint');
  eq(referenceFields(rows[0]).categoryCode,'L','historical combined DEFECT remains unclassified');
  for(const row of old) for(const [key,value] of Object.entries(row)) eq(raw.prepare('SELECT * FROM disputes WHERE id=?').get(row.id)[key],value,'old field preserved: '+row.id+'.'+key);
  for(let i=0;i<3;i++)migrateSqlite(raw);
  eq(raw.prepare('SELECT * FROM disputes ORDER BY case_number').all(),rows,'repeated upgrade never renumbers existing cases');
  eq(raw.prepare('SELECT * FROM wallet_entries').all(),ledger,'ledger including idempotency key unchanged');
  eq(raw.prepare('SELECT * FROM audit_logs').all(),audit,'historical audit bytes unchanged');
  assert.throws(()=>raw.prepare("UPDATE disputes SET case_prefix='A' WHERE id='one'").run(),/DISPUTE_REFERENCE_IMMUTABLE/);checks++;
  assert.throws(()=>raw.prepare("UPDATE disputes SET case_number=99 WHERE id='one'").run(),/DISPUTE_REFERENCE_IMMUTABLE/);checks++;
  assert.throws(()=>raw.prepare("INSERT INTO disputes(id,type,case_number,case_prefix) VALUES('collision','DAMAGED_GOODS',1,'A')").run(),/UNIQUE/);checks++;
  assert.throws(()=>raw.prepare("INSERT INTO disputes(id,type,case_number) VALUES('incomplete','DAMAGED_GOODS',9)").run(),/DISPUTE_REFERENCE_INCOMPLETE/);checks++;
  const before=raw.prepare('SELECT last_number FROM dispute_case_counter WHERE id=1').get().last_number;
  assert.throws(()=>raw.transaction(()=>{
    raw.prepare('UPDATE dispute_case_counter SET last_number=last_number+1 WHERE id=1 RETURNING last_number').get();
    raw.prepare("INSERT INTO disputes(id,type,case_number,case_prefix) VALUES('rolled-back','DAMAGED_GOODS',?,'A')").run(before+1);
    throw new Error('ROLLBACK_FIXTURE');
  })(),/ROLLBACK_FIXTURE/);checks++;
  eq(raw.prepare('SELECT last_number FROM dispute_case_counter WHERE id=1').get().last_number,before,'allocation rolls back together with case creation');
  eq(raw.prepare("SELECT COUNT(*) n FROM disputes WHERE id='rolled-back'").get().n,0,'failed transaction leaves no case');
  // A counter must not be reconstructed from the visible list after deletion.
  raw.prepare("DELETE FROM disputes WHERE id='four'").run();migrateSqlite(raw);
  eq(raw.prepare('SELECT last_number FROM dispute_case_counter WHERE id=1').get().last_number,4,'migration never rewinds the saved counter');
  raw.close();raw=new Database(file);migrateSqlite(raw);
  eq({...raw.prepare("SELECT case_number,case_prefix FROM disputes WHERE id='one'").get()},{case_number:1,case_prefix:'L'},'reference survives close and reopen');
  eq(referenceFields({type:'__proto__',case_number:0,case_prefix:'X'}).caseCode,null,'invalid metadata cannot fabricate a public reference');
  eq(referenceFields({type:'constructor'}).categoryCode,'L','unknown legacy type uses safe unclassified category');
  for(const [type,prefix] of [['DEFECT','L'],['DAMAGED_GOODS','A'],['NOT_AS_DESCRIBED','B'],['MISSING_ITEMS','C'],['NOT_SHIPPED','D'],['NOT_RECEIVED','E'],['INSPECTION_TIMEOUT','F'],['SHIPMENT_STALLED','G']]) {
    const before=raw.prepare('SELECT last_number FROM dispute_case_counter WHERE id=1').get().last_number;
    raw.prepare('INSERT INTO disputes(id,type,created_at) VALUES(?,?,?)').run('runtime-'+type,type,'2026-10-29T01:00:00Z');
    const d=raw.prepare('SELECT * FROM disputes WHERE id=?').get('runtime-'+type);
    eq(referenceFields(d).caseCode,prefix+(before+1),'DB allocates the right category even when an older app omits reference fields: '+type);
  }
  console.log(`DISPUTE REFERENCE SQLITE MIGRATION: ${checks} assertions PASS`);
} finally {
  if(raw.open)raw.close();
  assert.ok(path.resolve(file).startsWith(path.resolve(dir)+path.sep));
  fs.unlinkSync(file);fs.rmdirSync(dir);
}
