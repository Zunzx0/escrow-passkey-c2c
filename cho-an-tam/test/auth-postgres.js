// Starts/stops a dedicated PostgreSQL 17 cluster in a fresh temp directory.
// Never connects to the installed service, Supabase, or an inherited DATABASE_URL.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');const net=require('node:net');const {Client}=require('pg');
const root=path.resolve(__dirname,'..'),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'enclave-auth-pg-'));
// Pin one source snapshot so ongoing edits cannot alter modules halfway through startup.
const snapshot=path.join(tmp,'suite');fs.mkdirSync(path.join(snapshot,'test'),{recursive:true});
fs.cpSync(path.join(root,'src'),path.join(snapshot,'src'),{recursive:true});
for(const file of ['auth-redesign-e2e.js','auth-verification-e2e.js','email-recovery-e2e.js','softwareAuthenticator.js','minicbor.js'])fs.copyFileSync(path.join(root,'test',file),path.join(snapshot,'test',file));
const bin=process.env.AUTH_TEST_PG_BIN || 'C:/Program Files/PostgreSQL/17/bin';
let started=false;
function command(exe,args){
  // The postgres child inherits pg_ctl's pipes on Windows. Capturing those pipes
  // can keep spawnSync waiting after pg_ctl has already reported a successful start.
  const result=spawnSync(path.join(bin,exe),args,{encoding:'utf8',windowsHide:true,stdio:exe==='pg_ctl.exe'?'ignore':'pipe',timeout:180000});
  if(result.error||result.status!==0)throw new Error(exe+': '+(result.error?.message||'')+' '+(result.stdout||'')+(result.stderr||''));
  return result;
}
async function verifyExistingAuthTables(url){
  const adminUrl=new URL(url);adminUrl.pathname='/postgres';
  const admin=new Client({connectionString:adminUrl.toString()});await admin.connect();
  try{await admin.query('CREATE DATABASE enclave_auth_upgrade_test');}finally{await admin.end();}
  const priorUrl=new URL(url);priorUrl.pathname='/enclave_auth_upgrade_test';
  const prior=new Client({connectionString:priorUrl.toString()});await prior.connect();
  try{
    await prior.query('CREATE SCHEMA app; SET search_path TO app,public');
    for(const file of ['schema.pg.sql','schema.pg.002-admin-provenance.sql','schema.pg.003-topup-idempotency.sql','schema.pg.004-payment-provider.sql','schema.pg.005-paypal-bindings.sql','schema.pg.006-paypal-terminal-evidence.sql','schema.pg.007-simulated-shipping.sql','schema.pg.008-auth-redesign.sql','schema.auth.sql','schema.pg.010-progressive-auth.sql'])await prior.query(fs.readFileSync(path.join(root,'src',file),'utf8'));
    // Existing version-10 auth tables have neither these columns nor the new limit tables.
    await prior.query('ALTER TABLE auth_email_codes DROP COLUMN email; ALTER TABLE auth_email_outbox DROP COLUMN expires_at; DROP TABLE auth_otp_failures,auth_otp_locks,auth_email_sends');
    await prior.query("INSERT INTO users(id,username,display_name,role,password_hash,account_status) VALUES('old-auth','old_auth','Old user','BUYER','fixture-only','ACTIVE')");
    await prior.query("INSERT INTO auth_email_codes VALUES('old-auth','preserved-hash','2030-01-01',2,'2026-10-21')");
    await prior.query("INSERT INTO auth_email_outbox(id,user_id,recipient,subject,body_cipher,next_attempt_at,created_at) VALUES('old-mail','old-auth','old@example.test','Existing','preserved-cipher','2026-10-21','2026-10-21')");
    const upgrade=fs.readFileSync(path.join(root,'src/schema.pg.011-auth-verification-hardening.sql'),'utf8');
    await prior.query(upgrade);await prior.query(upgrade);
    assert.deepEqual((await prior.query("SELECT code_hash,attempts,email FROM auth_email_codes WHERE user_id='old-auth'")).rows[0],{code_hash:'preserved-hash',attempts:2,email:null});
    assert.deepEqual((await prior.query("SELECT body_cipher,expires_at FROM auth_email_outbox WHERE id='old-mail'")).rows[0],{body_cipher:'preserved-cipher',expires_at:null});
    console.log('POSTGRES existing auth-v10 tables: columns added, OTP/outbox preserved, repeat-safe PASS');
  }finally{await prior.end();}
}
async function main(){
  assert.ok(fs.existsSync(path.join(bin,'initdb.exe')),'PostgreSQL 17 binaries required');
  const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
  command('initdb.exe',['-D',path.join(tmp,'data'),'-U','enclave_auth_test','-A','trust','--no-locale','--encoding=UTF8','--no-sync']);
  started=true;
  command('pg_ctl.exe',['-D',path.join(tmp,'data'),'-l',path.join(tmp,'postgres.log'),'-o',`-h 127.0.0.1 -p ${port}`,'-w','start']);
  const admin=new Client({connectionString:`postgresql://enclave_auth_test@127.0.0.1:${port}/postgres`});await admin.connect();await admin.query('CREATE DATABASE enclave_auth_test');await admin.end();
  const url=`postgresql://enclave_auth_test@127.0.0.1:${port}/enclave_auth_test`,client=new Client({connectionString:url});await client.connect();
  const migrations=['schema.pg.sql','schema.pg.002-admin-provenance.sql','schema.pg.003-topup-idempotency.sql','schema.pg.004-payment-provider.sql','schema.pg.005-paypal-bindings.sql','schema.pg.006-paypal-terminal-evidence.sql','schema.pg.007-simulated-shipping.sql'];
  await client.query('CREATE SCHEMA IF NOT EXISTS app; SET search_path TO app,public');
  for(const file of migrations)await client.query(fs.readFileSync(path.join(root,'src',file),'utf8'));
  await client.query('CREATE TABLE app.schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)');
  for(let i=0;i<7;i++)await client.query('INSERT INTO app.schema_migrations VALUES($1,$2,$3)',[i+1,migrations[i],new Date().toISOString()]);
  await client.query("INSERT INTO app.users(id,username,display_name,role,password_hash,account_status) VALUES('legacy-auth-upgrade','legacy_pg','Người dùng cũ','BUYER','fixture-only','ACTIVE')");
  await client.query("INSERT INTO app.passkey_credentials(id,user_id,credential_id,public_key) VALUES('legacy-auth-key','legacy-auth-upgrade','legacy-credential',$1)",[Buffer.from([1,2,3])]);
  await client.query("INSERT INTO app.wallets(id,user_id,wallet_type,available_balance) VALUES('legacy-auth-wallet','legacy-auth-upgrade','USER',10000)");
  await client.query("INSERT INTO app.wallet_entries(id,wallet_id,request_id,entry_type,available_delta,available_after,locked_after,idempotency_key) VALUES('legacy-auth-entry','legacy-auth-wallet','original','DEMO_TOPUP',10000,10000,0,'legacy-auth-entry')");await client.end();
  const fixtureKey=require('node:crypto').randomBytes(32).toString('hex');
  for(const suite of ['auth-redesign-e2e.js','auth-verification-e2e.js','email-recovery-e2e.js']){
    const result=spawnSync(process.execPath,['test/'+suite],{cwd:snapshot,env:{...process.env,AUTH_TEST_PG_URL:url,AUTH_TEST_KEY:fixtureKey,NODE_PATH:path.join(root,'node_modules')},windowsHide:true,encoding:'utf8',timeout:180000,maxBuffer:1024*1024});
    process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');assert.equal(result.status,0,'PostgreSQL '+suite);
  }
  await verifyExistingAuthTables(url);
  console.log('POSTGRES AUTH UPGRADE + HTTP: PASS');
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{if(started&&fs.existsSync(path.join(tmp,'data','postmaster.pid')))command('pg_ctl.exe',['-D',path.join(tmp,'data'),'-m','fast','-w','stop']);});
