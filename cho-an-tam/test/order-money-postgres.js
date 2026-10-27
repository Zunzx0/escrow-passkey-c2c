'use strict';
// Dedicated temporary PostgreSQL 17 cluster; never uses installed service or .env.
// Source is copied before launch so parallel development cannot change a run.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawnSync}=require('node:child_process'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {Client}=require('pg');
const root=path.resolve(__dirname,'..'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'enclave-order-pg-'));
const bin=process.env.ORDER_TEST_PG_BIN||'C:/Program Files/PostgreSQL/17/bin';
const data=path.join(dir,'data'),snapshot=path.join(dir,'suite');let started=false;
function command(exe,args){const r=spawnSync(path.join(bin,exe),args,{encoding:'utf8',windowsHide:true,stdio:exe==='pg_ctl.exe'?'ignore':'pipe',timeout:120000});if(r.error||r.status!==0)throw new Error(exe+': '+(r.error?.message||'')+(r.stderr||'')+(r.stdout||''));return r;}
function environment(url){const env={};for(const k of ['SystemRoot','WINDIR','PATH','Path','TEMP','TMP','COMSPEC','PATHEXT'])if(process.env[k])env[k]=process.env[k];const key=crypto.randomBytes(32).toString('hex');return {...env,NODE_PATH:path.join(root,'node_modules'),APP_ENV:'test',NODE_ENV:'test',DATABASE_URL:url,ORDER_TEST_DEDICATED_PG:'1',JWT_SECRET:key,MOCK_PROVIDER_SECRET:key,AUTH_SECRET_PEPPER:key,AUTH_MAIL_ENCRYPTION_KEY:key,AUTH_EMAIL_TRANSPORT:'test',AUTH_PUBLIC_URL:'https://enclave.example/',AUTH_BACKGROUND_JOBS:'0',RECONCILE_INTERVAL_SECONDS:'0',CHALLENGE_CLEANUP_INTERVAL_SECONDS:'0',SHIPPING_WORKER_INTERVAL_MS:'0',ORDER_INSPECTION_INTERVAL_MS:'0',ORDER_LIFECYCLE_WORKER_SECONDS:'0',RATE_LIMIT_AUTH_PER_MINUTE:'100000',RATE_LIMIT_API_PER_MINUTE:'100000',AUTH_REGISTER_PER_IP_HOUR:'10000',WEBAUTHN_RP_ID:'localhost',WEBAUTHN_ORIGIN:'http://localhost',PGSSL:'disable'};}
async function availablePort(){const s=net.createServer();await new Promise((r,j)=>{s.once('error',j);s.listen(0,'127.0.0.1',r);});const port=s.address().port;await new Promise(r=>s.close(r));return port;}
async function prepareLegacy(url){
  const c=new Client({connectionString:url});await c.connect();
  try{
    await c.query('CREATE SCHEMA app; SET search_path TO app,public');
    const files=['schema.pg.sql','schema.pg.002-admin-provenance.sql','schema.pg.003-topup-idempotency.sql','schema.pg.004-payment-provider.sql','schema.pg.005-paypal-bindings.sql','schema.pg.006-paypal-terminal-evidence.sql','schema.pg.007-simulated-shipping.sql','schema.pg.008-auth-redesign.sql','schema.auth.sql','schema.pg.010-progressive-auth.sql','schema.pg.011-auth-verification-hardening.sql'];
    await c.query('CREATE TABLE app.schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)');
    for(let i=0;i<files.length;i++){await c.query(fs.readFileSync(path.join(snapshot,'src',files[i]),'utf8'));await c.query('INSERT INTO app.schema_migrations VALUES($1,$2,$3)',[i+1,files[i],new Date().toISOString()]);}
    await c.query("INSERT INTO users(id,username,display_name,role,password_hash,account_status) VALUES('order-legacy-buyer','order_legacy_buyer','Legacy buyer','BUYER','fixture','ACTIVE'),('order-legacy-seller','order_legacy_seller','Legacy seller','SELLER','fixture','ACTIVE')");
    await c.query("INSERT INTO passkey_credentials(id,user_id,credential_id,public_key) VALUES('order-legacy-buyer-key','order-legacy-buyer','order-legacy-buyer-credential',$1),('order-legacy-seller-key','order-legacy-seller','order-legacy-seller-credential',$1)",[Buffer.from('fixture-only')]);
    await c.query("INSERT INTO wallets(id,user_id,wallet_type,available_balance) VALUES('order-legacy-wallet','order-legacy-buyer','USER',10000)");
    await c.query("INSERT INTO wallet_entries(id,wallet_id,request_id,entry_type,available_delta,available_after,locked_after,idempotency_key) VALUES('order-legacy-entry','order-legacy-wallet','legacy-seed','DEMO_TOPUP',10000,10000,0,'old-key-must-preserve')");
    await c.query("INSERT INTO listings(id,seller_id,title,price,category,condition,visibility,status,version) VALUES('order-legacy-listing','order-legacy-seller','Legacy sold item',60000,'SACH','GOOD','PUBLIC','LOCKED',7)");
    await c.query("INSERT INTO transactions(id,buyer_id,seller_id,item_name,amount,status,escrow_status,listing_id) VALUES('order-legacy-refund','order-legacy-buyer','order-legacy-seller','Legacy sold item',60000,'REFUNDED','REFUNDED','order-legacy-listing')");
    console.log('POSTGRES legacy-v11 fixture prepared without fabricated address/inspection');
  }finally{await c.end();}
}
async function verifyMigration(url){const c=new Client({connectionString:url});await c.connect();try{await c.query('SET search_path TO app,public');const file=path.join(snapshot,'src','schema.pg.012-order-lifecycle.sql');assert.ok(fs.existsSync(file),'order migration file exists');await c.query(fs.readFileSync(file,'utf8'));await c.query(fs.readFileSync(file,'utf8'));assert.equal((await c.query("SELECT available_balance FROM wallets WHERE id='order-legacy-wallet'")).rows[0].available_balance,'10000');assert.equal((await c.query("SELECT idempotency_key FROM wallet_entries WHERE id='order-legacy-entry'")).rows[0].idempotency_key,'old-key-must-preserve');const order=(await c.query("SELECT inspected_at,received_confirmed_by FROM transactions WHERE id='order-legacy-refund'")).rows[0];assert.equal(order.inspected_at,null);assert.equal(order.received_confirmed_by,null);assert.equal((await c.query("SELECT COUNT(*) n FROM order_shipping_snapshot WHERE order_id='order-legacy-refund'")).rows[0].n,'0');const status=(await c.query("SELECT status FROM listings WHERE id='order-legacy-listing'")).rows[0].status;assert.notEqual(status,'AVAILABLE');console.log('POSTGRES T19 migration repeat-safe: balance/old key preserved; no fabricated shipping/receipt/inspection; refunded listing not reopened PASS');}finally{await c.end();}}
async function main(){
  assert.ok(fs.existsSync(path.join(bin,'initdb.exe')),'PostgreSQL 17 binaries required');
  fs.mkdirSync(path.join(snapshot,'test'),{recursive:true});fs.cpSync(path.join(root,'src'),path.join(snapshot,'src'),{recursive:true});
  for(const file of ['order-money-spec-e2e.js','softwareAuthenticator.js','minicbor.js'])fs.copyFileSync(path.join(root,'test',file),path.join(snapshot,'test',file));
  const port=await availablePort();command('initdb.exe',['-D',data,'-U','enclave_order_test','-A','trust','--no-locale','--encoding=UTF8','--no-sync']);
  started=true;command('pg_ctl.exe',['-D',data,'-l',path.join(dir,'postgres.log'),'-o',`-h 127.0.0.1 -p ${port}`,'-w','start']);
  const admin=new Client({connectionString:`postgresql://enclave_order_test@127.0.0.1:${port}/postgres`});await admin.connect();try{await admin.query('CREATE DATABASE enclave_order_test');}finally{await admin.end();}
  const url=`postgresql://enclave_order_test@127.0.0.1:${port}/enclave_order_test`;await prepareLegacy(url);
  const result=spawnSync(process.execPath,['test/order-money-spec-e2e.js','--run'],{cwd:snapshot,env:environment(url),windowsHide:true,encoding:'utf8',timeout:240000,maxBuffer:8*1024*1024});process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');assert.equal(result.status,0,'PostgreSQL real HTTP and DB suite');
  await verifyMigration(url);console.log('ORDER MONEY POSTGRES: PASS');
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{if(started&&fs.existsSync(path.join(data,'postmaster.pid')))command('pg_ctl.exe',['-D',data,'-m','fast','-w','stop']);console.log('Dedicated PostgreSQL stopped; evidence temp directory '+dir);});
