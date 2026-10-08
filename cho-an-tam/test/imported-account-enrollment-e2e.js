// HTTP + real WebAuthn verification with a software authenticator, isolated SQLite.
// Never loads .env or calls a provider. Run: node test/imported-account-enrollment-e2e.js
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const assert = require('node:assert/strict');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'enclave-import-enroll-'));
process.env.APP_ENV = 'test'; process.env.DB_PATH = path.join(temp, 'enrollment.sqlite');
delete process.env.DATABASE_URL;
process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
process.env.WEBAUTHN_RP_ID = 'localhost'; process.env.WEBAUTHN_ORIGIN = 'http://localhost:3999';
process.env.RATE_LIMIT_AUTH_PER_MINUTE = '1000'; process.env.DEMO_BUYER_INITIAL_BALANCE = '5000000';
const express = require('express');
const { db, uuid, nowIso } = require('../src/db');
const { hashPassword } = require('../src/lib/password');
const { recordBootstrapProvenance } = require('../src/lib/adminProvenance');
const { createAuthenticator } = require('./softwareAuthenticator');
const password = 'Only-Local-Test-2026!';
let base, checks = 0;
function eq(actual, expected, label) { assert.deepEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(expected)), label); checks++; console.log('✅ '+label); }
async function api(endpoint, body, token) {
 const response = await fetch(base+endpoint, {method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});
 return {status:response.status,body:await response.json()};
}
async function fixture({role='BUYER', wallet=false, receipt=false, receiptActor=null, outcome='ALLOWED', type='USER'}={}) {
 const id=uuid(), username='import-'+uuid(); const now=nowIso();
 await db.prepare('INSERT INTO users (id,username,display_name,role,password_hash,account_status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
  .run(id,username,'Local enrollment',role,hashPassword(password),role==='ADMIN'?'PENDING_BOOTSTRAP':'PENDING_PASSKEY',now,now);
 if(role==='ADMIN') { await recordBootstrapProvenance(db,{userId:id,username,source:'BOOTSTRAP_CLI',now}); await db.prepare("UPDATE users SET account_status='PENDING_PASSKEY' WHERE id=?").run(id); }
 const walletId=uuid();
 if(wallet) {
  await db.prepare('INSERT INTO wallets (id,user_id,wallet_type,available_balance,locked_balance,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(walletId,id,type,120000,10000,7,now,now);
  await db.prepare("INSERT INTO wallet_entries (id,wallet_id,request_id,entry_type,available_delta,locked_delta,available_after,locked_after,idempotency_key,created_at) VALUES (?,?,?,'DEMO_TOPUP',120000,0,120000,0,?,?)").run(uuid(),walletId,uuid(),uuid(),now);
 }
 if(receipt) await db.prepare("INSERT INTO security_events (event_type,outcome,actor_id) VALUES ('ACCOUNT_SANDBOX_IMPORTED',?,?)").run(outcome,receiptActor||id);
 const login=await api('/login/password',{username,password}); eq(login.status,200,'pending account password login');
 return {id,token:login.body.token};
}
async function prepare(user) {
 const options=await api('/register/passkey/options',{},user.token); eq(options.status,200,'registration options available');
 const auth=createAuthenticator();
 return {sessionId:options.body.registrationSessionId,response:auth.register({rpId:'localhost',origin:process.env.WEBAUTHN_ORIGIN,challenge:options.body.options.challenge})};
}
async function enroll(user, prepared) {return api('/register/passkey/verify',{registrationSessionId:prepared.sessionId,response:prepared.response},user.token);}
async function snapshot(id) {
 return {user:await db.prepare('SELECT id,role,account_status FROM users WHERE id=?').get(id),wallets:await db.prepare('SELECT * FROM wallets WHERE user_id=? ORDER BY id').all(id),entries:await db.prepare('SELECT e.* FROM wallet_entries e JOIN wallets w ON e.wallet_id=w.id WHERE w.user_id=? ORDER BY e.id').all(id),credentials:await db.prepare('SELECT id FROM passkey_credentials WHERE user_id=?').all(id)};
}
async function denied(options,label) {
 const user=await fixture(options), prepared=await prepare(user), before=await snapshot(user.id);
 const result=await enroll(user,prepared); eq(result.status,409,label+': denied'); eq(result.body.error,'ACCOUNT_WALLET_CONFLICT',label+': explicit error');
 eq(await snapshot(user.id),before,label+': user/credential/wallet/ledger rollback');
 eq((await db.prepare('SELECT used_at FROM auth_challenges WHERE id=?').get(prepared.sessionId)).used_at,null,label+': challenge remains unused');
}
async function main() {
 const app=express();app.use(express.json());app.use(require('../src/routes/passkeys'));app.use((e,req,res,next)=>res.status(e.status||500).json({error:e.code||'INTERNAL_ERROR'}));
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));}); base='http://127.0.0.1:'+server.address().port;
 try {
  for(const role of ['BUYER','SELLER']) {
   const user=await fixture({role,wallet:true,receipt:true}), before=await snapshot(user.id), prepared=await prepare(user), result=await enroll(user,prepared);
   eq(result.status,201,role+': imported enrollment succeeds');const after=await snapshot(user.id);
   eq(after.user,{id:user.id,role,account_status:'ACTIVE'},role+': ID/role preserved, activated');eq(after.wallets,before.wallets,role+': wallet ID/balances/version unchanged');eq(after.entries,before.entries,role+': ledger unchanged, no demo credit');eq(after.credentials.length,1,role+': one verified credential');
   eq((await enroll(user,prepared)).status,409,role+': enrollment replay rejected');eq((await snapshot(user.id)).wallets,before.wallets,role+': replay does not touch wallet');
  }
  const normal=await fixture(), p=await prepare(normal);eq((await enroll(normal,p)).status,201,'normal first enrollment succeeds');const state=await snapshot(normal.id);eq(state.wallets.length,1,'normal enrollment creates one wallet');eq(state.wallets[0].available_balance,5000000,'normal demo balance unchanged');eq(state.entries.length,1,'normal demo entry created once');
  await denied({wallet:true},'missing receipt');
  await denied({wallet:true,receipt:true,outcome:'DENIED'},'denied receipt');
  const other=await fixture();await denied({wallet:true,receipt:true,receiptActor:other.id},'other account receipt');
  await assert.rejects(()=>fixture({wallet:true,receipt:true,type:'SYSTEM_ESCROW'}), /CHECK constraint failed/); checks++; console.log('✅ schema rejects non-USER wallet owned by account');
  const admin=await fixture({role:'ADMIN'}), ap=await prepare(admin);eq((await enroll(admin,ap)).status,201,'bootstrap admin enrollment succeeds');eq((await snapshot(admin.id)).wallets.length,0,'admin gets no USER wallet');
  await denied({role:'ADMIN',wallet:true,receipt:true},'admin cannot reuse USER wallet even with receipt');
  console.log('PASS '+checks+' assertions, isolated SQLite HTTP; software authenticator only');
 } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await db.close();fs.rmSync(temp,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});


