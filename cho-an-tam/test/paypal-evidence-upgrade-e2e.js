'use strict';
// Upgrade a pre-fix v5 DB, including invalid old evidence. Local disposable DB only.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),{spawnSync}=require('child_process');
const ROOT=path.resolve(__dirname,'..');let n=0;
const ok=(v,m)=>{if(!v)throw Error(m);console.log('  ✅ '+m);n++;};
async function run(pgUrl){
 let target,exec,query,close,cleanup;
 if(pgUrl){const u=new URL(pgUrl),name=u.pathname.slice(1);if(u.hostname!=='127.0.0.1'||!/^enclave_[a-z_]+_evidence_test$/.test(name))throw Error('Local evidence_test DB only');const {Client}=require('pg');const a=new URL(u);a.pathname='/postgres';const admin=new Client({connectionString:a.toString(),ssl:false});await admin.connect();if(!(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[name])).rowCount)await admin.query('CREATE DATABASE "'+name+'"');await admin.end();const c=new Client({connectionString:pgUrl,ssl:false});await c.connect();await c.query('DROP SCHEMA IF EXISTS app CASCADE;DROP SCHEMA IF EXISTS mock_provider CASCADE');for(const f of ['schema.pg.sql','schema.pg.002-admin-provenance.sql','schema.pg.003-topup-idempotency.sql','schema.pg.004-payment-provider.sql','schema.pg.005-paypal-bindings.sql'])await c.query(fs.readFileSync(path.join(ROOT,'src',f),'utf8').replace("IN ('ORDER_VOIDED')","IN ('ORDER_VOIDED','CAPTURE_DECLINED')"));await c.query('SET search_path TO app,public');await c.query('CREATE TABLE app.schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)');for(let i=1;i<=5;i++)await c.query('INSERT INTO app.schema_migrations VALUES($1,$2,$3)',[i,'old-v'+i,new Date().toISOString()]);target=pgUrl;exec=s=>c.query(s);query=async s=>(await c.query(s)).rows;close=()=>c.end();cleanup=()=>{};
 }else{const D=require('../src/lib/sqlite');target=path.join(ROOT,'data/test','evidence-'+crypto.randomUUID()+'.db');fs.mkdirSync(path.dirname(target),{recursive:true});const d=new D(target);d.exec(fs.readFileSync(path.join(ROOT,'src/schema.sql'),'utf8'));d.exec(fs.readFileSync(path.join(ROOT,'src/schema.sqlite.005-paypal-bindings.sql'),'utf8').replace("IN ('ORDER_VOIDED')","IN ('ORDER_VOIDED','CAPTURE_DECLINED')"));exec=async s=>d.exec(s);query=async s=>d.prepare(s).all();close=async()=>d.close();cleanup=()=>{for(const x of['','-wal','-shm'])try{fs.unlinkSync(target+x)}catch(e){if(e.code!=='ENOENT')throw e;}};}
 const boot=()=>spawnSync(process.execPath,['-e',"const {db}=require('./src/db');db.ready.then(()=>db.close()).catch(e=>{console.error(e.message);process.exit(1)})"],{cwd:ROOT,encoding:'utf8',timeout:30000,env:{...process.env,APP_ENV:'test',DATABASE_URL:pgUrl||'',DB_PATH:pgUrl?'data/test/unused.db':target,PGSSL:'disable'}});
 try{
 await exec("INSERT INTO users(id,username,display_name,role,password_hash) VALUES('u','evidence-user','Evidence','BUYER','not-login');INSERT INTO payment_requests(id,user_id,amount,status,provider_ref,provider) VALUES('p','u',100000,'PENDING','ref','PAYPAL_SANDBOX');INSERT INTO paypal_payment_bindings(payment_request_id,quote_json,amount_vnd,currency,usd_cents,rate_vnd_per_usd,merchant_id,created_at,not_captured_evidence) VALUES('p','{}',100000,'USD',400,25000,'merchant','2026-01-01T00:00:00.000Z','CAPTURE_DECLINED')");
 ok((await query('SELECT not_captured_evidence FROM paypal_payment_bindings'))[0].not_captured_evidence==='CAPTURE_DECLINED','Old v5 permits declined evidence (bug reproduced)');
 ok(boot().status!==0,'Upgrade refuses invalid historical evidence');
 ok((await query('SELECT not_captured_evidence FROM paypal_payment_bindings'))[0].not_captured_evidence==='CAPTURE_DECLINED','Rejected upgrade preserves evidence; never relabels it');
 await exec("UPDATE paypal_payment_bindings SET not_captured_evidence=NULL");
 ok(boot().status===0,'Clean old v5 upgrades through actual db.js');
 let rejected=false;try{await exec("UPDATE paypal_payment_bindings SET not_captured_evidence='CAPTURE_DECLINED'")}catch(_){rejected=true;}ok(rejected,'Upgraded old table rejects declined evidence at DB layer');
 await exec("UPDATE paypal_payment_bindings SET not_captured_evidence='ORDER_VOIDED'");
 ok(boot().status===0,'Valid evidence survives idempotent restart');
 }finally{await close();cleanup();}
}
(async()=>{await run();const arg=process.argv.find(x=>x.startsWith('--pg='));if(arg)await run(arg.slice(5));console.log(n+' upgrade checks passed')})().catch(e=>{console.error(e.stack);process.exitCode=1});
