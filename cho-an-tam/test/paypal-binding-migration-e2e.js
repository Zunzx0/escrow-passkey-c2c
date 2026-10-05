'use strict';
// Upgrade populated legacy schemas through real db.js; no production URLs.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),{spawnSync,execFileSync}=require('child_process');
const ROOT=path.resolve(__dirname,'..');
const pgArg=process.argv.find(a=>a.startsWith('--pg='));
let passes=0;
function ok(v,msg){if(!v)throw Error(msg);passes++;console.log('  ✅ '+msg);}
const legacySnapshot=rows=>JSON.stringify(rows.map(r=>{const x={...r};delete x.provider;return x;}));
const boot=urlOrFile=>{const env={...process.env,APP_ENV:'test',DATABASE_URL:pgArg?urlOrFile:'',DB_PATH:pgArg?'data/test/unused.db':urlOrFile,PGSSL:'disable'};const r=spawnSync(process.execPath,['-e',"const {db}=require('./src/db');(async()=>{await db.prepare('SELECT COUNT(*) n FROM paypal_payment_bindings').get();await db.close()})().catch(e=>{console.error(e);process.exit(1)})"],{cwd:ROOT,env,encoding:'utf8',timeout:30000});ok(r.status===0,'real application migration/startup succeeds');if(r.status!==0)throw Error(r.stderr);};
async function main(){
 let query,exec,close,target,cleanup;
 if(pgArg){target=pgArg.slice(5);const u=new URL(target),name=u.pathname.slice(1);if(!['127.0.0.1','localhost'].includes(u.hostname)||!/^[a-z][a-z0-9_]*_migration_test$/.test(name))throw Error('Only local *_migration_test allowed');const{Client}=require('pg');const adminUrl=new URL(u);adminUrl.pathname='/postgres';const admin=new Client({connectionString:adminUrl.toString(),ssl:false});await admin.connect();if(!(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[name])).rowCount)await admin.query('CREATE DATABASE "'+name+'"');await admin.end();const c=new Client({connectionString:target,ssl:false});await c.connect();await c.query('DROP SCHEMA IF EXISTS app CASCADE; DROP SCHEMA IF EXISTS mock_provider CASCADE;');for(const file of ['schema.pg.sql','schema.pg.002-admin-provenance.sql','schema.pg.003-topup-idempotency.sql'])await c.query(fs.readFileSync(path.join(ROOT,'src',file),'utf8'));await c.query('SET search_path TO app,public');await c.query('CREATE TABLE app.schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)');for(let i=1;i<=3;i++)await c.query('INSERT INTO app.schema_migrations VALUES($1,$2,$3)',[i,'fixture-v'+i,new Date().toISOString()]);query=async s=>(await c.query(s)).rows;exec=async s=>c.query(s);close=()=>c.end();cleanup=async()=>{};
 }else{const D=require('../src/lib/sqlite');target=path.join(ROOT,'data','test','binding-migration-'+crypto.randomUUID()+'.db');fs.mkdirSync(path.dirname(target),{recursive:true});const d=new D(target);const legacy=execFileSync('git',['show','f48e313:cho-an-tam/src/schema.sql'],{cwd:ROOT,encoding:'utf8'});d.exec(legacy);query=async s=>d.prepare(s).all();exec=async s=>d.exec(s);close=async()=>d.close();cleanup=async()=>{for(const suffix of['','-wal','-shm'])try{fs.unlinkSync(target+suffix)}catch(e){if(e.code!=='ENOENT')throw e;}};}
 try{
 await exec("INSERT INTO users(id,username,display_name,role,password_hash) VALUES ('legacy-u','legacy-user','Legacy','BUYER','fixture-not-a-login'); INSERT INTO wallets(id,user_id,wallet_type,available_balance,locked_balance) VALUES ('legacy-escrow',NULL,'SYSTEM_ESCROW',0,0)");
 await exec("INSERT INTO payment_requests(id,user_id,amount,status,provider_ref,version,submission_status,submit_attempts,submit_claim,submit_claimed_at) VALUES ('legacy-p','legacy-u',123456,'PENDING','legacy-ref',7,'SUBMITTING',3,'legacy-claim','2026-01-01T00:00:00.000Z')");
 await exec("INSERT INTO payment_requests(id,user_id,amount,status,provider_ref,version,resolved_by) VALUES ('legacy-f','legacy-u',654321,'FAILED','legacy-failed-ref',9,'RECONCILER'); INSERT INTO payment_requests(id,user_id,amount,status,provider_ref,version,resolved_by) VALUES ('legacy-s','legacy-u',10000,'SUCCEEDED','legacy-success-ref',8,'WEBHOOK')");
 await exec("INSERT INTO wallets(id,user_id,wallet_type,available_balance,locked_balance) VALUES ('legacy-wallet','legacy-u','USER',10000,0); INSERT INTO wallet_entries(id,wallet_id,request_id,entry_type,available_delta,locked_delta,available_after,locked_after,idempotency_key,description) VALUES ('legacy-entry','legacy-wallet','legacy-s','TOPUP_CREDIT',10000,0,10000,0,'topup:legacy-s','Legacy credit')");
 const before=legacySnapshot(await query('SELECT * FROM payment_requests ORDER BY id')),wallets=JSON.stringify(await query('SELECT * FROM wallets ORDER BY id')),ledger=JSON.stringify(await query('SELECT * FROM wallet_entries ORDER BY id'));
 boot(target);
 ok(legacySnapshot(await query('SELECT * FROM payment_requests ORDER BY id'))===before,'amount/status/ref/version/claim/timestamps preserved');
 ok(JSON.stringify(await query('SELECT * FROM wallets ORDER BY id'))===wallets,'wallet rows preserved');
 ok(JSON.stringify(await query('SELECT * FROM wallet_entries ORDER BY id'))===ledger,'ledger rows preserved');
 ok((await query('SELECT provider FROM payment_requests')).every(r=>r.provider==='MOCK'),'legacy provider defaults MOCK');
 ok(Number((await query('SELECT COUNT(*) n FROM paypal_payment_bindings'))[0].n)===0,'new binding table starts empty');
 const after=JSON.stringify(await query('SELECT * FROM payment_requests ORDER BY id'));
 boot(target);
 ok(JSON.stringify(await query('SELECT * FROM payment_requests ORDER BY id'))===after,'second startup is idempotent');
 if(pgArg)ok((await query('SELECT version FROM app.schema_migrations ORDER BY version')).map(x=>x.version).join(',')==='1,2,3,4,5,6','migration versions apply in order once');
 }finally{await close();await cleanup();}
 console.log('Migration checks passed: '+passes);
}
main().catch(e=>{console.error(e.stack);process.exitCode=1});
