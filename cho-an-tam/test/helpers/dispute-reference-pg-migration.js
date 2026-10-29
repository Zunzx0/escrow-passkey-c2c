'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');

module.exports=async function verifyReferenceMigration({Client,url,source}) {
  const parsed=new URL(url);assert.equal(parsed.hostname,'127.0.0.1');assert.equal(parsed.pathname,'/enclave_order_test');
  const schema='dispute_reference_check',c=new Client({connectionString:url});let checks=0;
  const eq=(a,b,label)=>{assert.deepEqual(a,b,label);checks++;};
  const migration=fs.readFileSync(path.join(source,'schema.pg.014-dispute-references.sql'),'utf8').replace(/\bapp\./g,schema+'.');
  await c.connect();
  try {
    await c.query(`CREATE SCHEMA ${schema}; CREATE TABLE ${schema}.disputes(id TEXT PRIMARY KEY,type TEXT NOT NULL,reason TEXT,status TEXT,created_at TEXT)`);
    for(const [i,type] of ['DEFECT','NOT_RECEIVED','INSPECTION_TIMEOUT','unknown'].entries())await c.query(`INSERT INTO ${schema}.disputes VALUES($1,$2,$3,'OPEN',$4)`,['old-'+i,type,'Original description '+i,'2026-10-29T00:00:0'+i+'Z']);
    const before=(await c.query(`SELECT * FROM ${schema}.disputes ORDER BY id`)).rows;
    await c.query(migration);
    const backfilled=(await c.query(`SELECT * FROM ${schema}.disputes ORDER BY case_number`)).rows;
    eq(backfilled.map(d=>d.case_prefix+d.case_number),['L1','E2','F3','L4'],'legacy metadata is classified without guessing a specific product defect');
    for(let i=0;i<before.length;i++)for(const key of Object.keys(before[i]))eq(backfilled[i][key],before[i][key],'old value preserved: '+key);
    await c.query(migration);eq((await c.query(`SELECT * FROM ${schema}.disputes ORDER BY case_number`)).rows,backfilled,'idempotent migration');
    await assert.rejects(c.query(`UPDATE ${schema}.disputes SET case_prefix='A' WHERE id='old-0'`),/DISPUTE_REFERENCE_IMMUTABLE/);checks++;
    await assert.rejects(c.query(`UPDATE ${schema}.disputes SET case_number=99 WHERE id='old-0'`),/DISPUTE_REFERENCE_IMMUTABLE/);checks++;
    await assert.rejects(c.query(`INSERT INTO ${schema}.disputes(id,type,case_number,case_prefix) VALUES('collision','DAMAGED_GOODS',1,'A')`),/unique/i);checks++;
    await assert.rejects(c.query(`INSERT INTO ${schema}.disputes(id,type,case_number) VALUES('partial','DAMAGED_GOODS',100)`),/DISPUTE_REFERENCE_INCOMPLETE/);checks++;
    const numbers=await Promise.all(Array.from({length:8},async()=>{
      const connection=new Client({connectionString:url});await connection.connect();
      try {
        await connection.query('BEGIN');
        const number=(await connection.query(`UPDATE ${schema}.dispute_case_counter SET last_number=last_number+1 WHERE id=1 RETURNING last_number`)).rows[0].last_number;
        await connection.query(`INSERT INTO ${schema}.disputes(id,type,case_number,case_prefix) VALUES($1,'DAMAGED_GOODS',$2,'A')`,[crypto.randomUUID(),number]);
        await connection.query('COMMIT');return number;
      } catch(e){await connection.query('ROLLBACK');throw e;}finally{await connection.end();}
    }));
    eq(numbers.sort((a,b)=>a-b),[5,6,7,8,9,10,11,12],'independent DB connections cannot allocate duplicate numbers');
    await c.query('BEGIN');await c.query(`UPDATE ${schema}.dispute_case_counter SET last_number=last_number+1 WHERE id=1`);
    await c.query(`INSERT INTO ${schema}.disputes(id,type,case_number,case_prefix) VALUES('rollback','DAMAGED_GOODS',13,'A')`);await c.query('ROLLBACK');
    eq((await c.query(`SELECT last_number FROM ${schema}.dispute_case_counter WHERE id=1`)).rows[0].last_number,12,'allocation rolls back with the case');
    eq((await c.query(`SELECT COUNT(*) n FROM ${schema}.disputes WHERE id='rollback'`)).rows[0].n,'0','no half-created case');
    await c.query(`DELETE FROM ${schema}.disputes WHERE case_number=12`);await c.query(migration);
    eq((await c.query(`SELECT last_number FROM ${schema}.dispute_case_counter WHERE id=1`)).rows[0].last_number,12,'counter never rewinds after removal and restart migration');
    for(const [type,prefix] of [['DEFECT','L'],['DAMAGED_GOODS','A'],['NOT_AS_DESCRIBED','B'],['MISSING_ITEMS','C'],['NOT_SHIPPED','D'],['NOT_RECEIVED','E'],['INSPECTION_TIMEOUT','F'],['SHIPMENT_STALLED','G']]) {
      const before=(await c.query(`SELECT last_number FROM ${schema}.dispute_case_counter WHERE id=1`)).rows[0].last_number;
      const d=(await c.query(`INSERT INTO ${schema}.disputes(id,type) VALUES($1,$2) RETURNING case_number,case_prefix`,[crypto.randomUUID(),type])).rows[0];
      eq(d.case_prefix+d.case_number,prefix+(before+1),'trigger allocates the correct category for unnumbered insert: '+type);
    }
    console.log(`DISPUTE REFERENCE POSTGRES MIGRATION: ${checks} assertions PASS (dedicated test schema only)`);
  } finally {await c.end();}
};
