'use strict';
// Synthetic fixtures only. Never reads the real account backup or connects to a network.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),zlib=require('node:zlib'),os=require('node:os');
const Sqlite=require('../src/lib/sqlite'),{SqliteAsyncDatabase}=require('../src/lib/asyncDb');
const I=require('../scripts/import-sandbox-account'),{createQuote}=require('../src/lib/paypalSandboxProvider');
let pass=0;function ok(v,label){assert.ok(v,label);pass++;console.log('  ✅ '+label);}const hash='a'.repeat(64),time='2026-01-01T00:00:00.000Z';
function fixture(){
 const user={id:'source-user',username:'fixture@example.test',display_name:'Fixture',role:'BUYER',password_hash:'fixture-only-not-a-real-password-hash-'.repeat(2),account_status:'ACTIVE',token_version:4,is_active:1,created_at:time,updated_at:time};
 const wallet={id:'source-wallet',user_id:user.id,wallet_type:'USER',available_balance:11000,locked_balance:0,version:1,created_at:time,updated_at:time};
 const payment={id:'source-payment',user_id:user.id,amount:10000,status:'SUCCEEDED',provider_ref:'source-provider-ref',version:1,resolved_at:time,resolved_by:'RECONCILER',reconcile_attempts:0,last_reconciled_at:null,last_reconcile_error:null,created_at:time,updated_at:time,client_request_id:'source-client-key',submission_status:'SUBMITTING',submit_attempts:0,last_submit_error:null,submit_claim:null,submit_claimed_at:null,provider:'PAYPAL_SANDBOX'};
 const q=createQuote(10000,25000);
 const binding={payment_request_id:payment.id,provider:'PAYPAL_SANDBOX',quote_json:JSON.stringify(q),amount_vnd:10000,currency:'USD',usd_cents:q.usdCents,rate_vnd_per_usd:25000,merchant_id:'FIXTUREMERCHANT',order_id:'FIXTUREORDER',order_bound_at:time,create_attempt_at:time,capture_state:'VERIFIED',capture_claim:null,capture_claimed_at:null,capture_attempts:1,first_capture_at:time,capture_post_sent_at:time,capture_post_count:1,capture_id:'FIXTURECAPTURE',capture_verified_at:time,not_captured_evidence:null,recovery_required_at:null,last_capture_error:null,created_at:time};
 const entries=[{id:'source-demo',wallet_id:wallet.id,transaction_id:null,request_id:'fixture-registration',entry_type:'DEMO_TOPUP',available_delta:1000,locked_delta:0,available_after:1000,locked_after:0,idempotency_key:'demo-topup:'+user.id,request_fingerprint:null,description:'fixture',created_at:time},{id:'source-credit',wallet_id:wallet.id,transaction_id:null,request_id:payment.id,entry_type:'TOPUP_CREDIT',available_delta:10000,locked_delta:0,available_after:11000,locked_after:0,idempotency_key:'topup:'+payment.id,request_fingerprint:crypto.createHash('sha256').update(JSON.stringify({actorId:user.id,action:'TOPUP',transactionId:null,amount:10000})).digest('hex'),description:'fixture',created_at:'2026-01-01T00:00:01.000Z'}];
 return {format:'enclave-data-snapshot-v1',tables:Object.entries({users:[user],wallets:[wallet],wallet_entries:entries,payment_requests:[payment],paypal_payment_bindings:[binding],transactions:[],listings:[],passkey_credentials:[{id:'MUST_NOT_IMPORT'}],sessions:[{id:'MUST_NOT_IMPORT'}]}).map(([name,rows])=>({schema:'app',name,rows}))};
}
const rows=(s,name)=>s.tables.find(t=>t.name===name).rows;
async function database(){const db=new SqliteAsyncDatabase(new Sqlite(':memory:'));for(const file of ['schema.sql','schema.sqlite.005-paypal-bindings.sql','schema.sqlite.006-paypal-terminal-evidence.sql'])await db.exec(fs.readFileSync(path.join(__dirname,'../src',file),'utf8'));await db.prepare("INSERT INTO users(id,username,display_name,role,password_hash,account_status) VALUES ('old-seller','fixture._example.test','Old seller','SELLER','old-hash','PENDING_PASSKEY')").run();await db.prepare("INSERT INTO wallets(id,user_id,wallet_type,available_balance) VALUES ('old-wallet','old-seller','USER',5000)").run();await db.prepare("INSERT INTO listings(id,seller_id,title,price,category) VALUES ('old-listing','old-seller','Existing item',1000,'Khác')").run();await db.prepare("INSERT INTO users(id,username,display_name,role,password_hash) VALUES ('old-buyer','old-buyer','Buyer','BUYER','old-hash')").run();await db.prepare("INSERT INTO wallets(id,wallet_type,available_balance,locked_balance) VALUES ('old-escrow','SYSTEM_ESCROW',0,0)").run();await db.prepare("INSERT INTO transactions(id,buyer_id,seller_id,item_name,amount,listing_id) VALUES ('old-order','old-buyer','old-seller','Existing order',1000,'old-listing')").run();return db;}
async function state(db){const result={};for(const table of Object.keys(I.COLS).concat(['security_events','listings','transactions','passkey_credentials','sessions']))result[table]=await db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all();return JSON.stringify(result);}
async function run(db,s,apply=false,fault){return I.importAccount({db,snapshot:s,username:'fixture@example.test',sourceSha256:hash,apply,fault,now:time});}
async function rejected(fn,code,label){await assert.rejects(fn,e=>e.code===code);ok(true,label);}
async function main(){
 let s=fixture();I.buildPlan(s,'fixture@example.test',hash);ok(true,'valid synthetic source accepts verified PayPal despite MOCK SUBMITTING field');
 for(const [label,mutate,code] of [
 ['unsafe BigInt',s=>rows(s,'wallets')[0].available_balance='9007199254740993','UNSAFE_INTEGER'],
 ['non integer amount',s=>rows(s,'payment_requests')[0].amount=1.5,'UNSAFE_INTEGER'],
 ['pending payment',s=>rows(s,'payment_requests')[0].status='PENDING','SOURCE_PAYMENT_UNSETTLED'],
 ['active capture claim',s=>rows(s,'paypal_payment_bindings')[0].capture_claim='claim','SOURCE_BINDING_UNSAFE'],
 ['recovery evidence',s=>rows(s,'paypal_payment_bindings')[0].recovery_required_at=time,'SOURCE_BINDING_UNSAFE'],
 ['wallet mismatch',s=>rows(s,'wallets')[0].available_balance=11001,'SOURCE_BALANCE_MISMATCH'],
 ['ledger after mismatch',s=>rows(s,'wallet_entries')[1].available_after=10999,'SOURCE_LEDGER_AFTER_MISMATCH'],
 ['foreign transaction leg',s=>rows(s,'wallet_entries')[1].transaction_id='tx','SOURCE_LEDGER_UNSAFE'],
 ['unlinked credit',s=>rows(s,'wallet_entries')[1].request_id='alien','SOURCE_CREDIT_MISMATCH'],
 ['extra SQL identifier',s=>rows(s,'users')[0]['x); DROP TABLE users;--']='x','UNEXPECTED_COLUMNS'],
 ['listing history',s=>rows(s,'listings').push({seller_id:'source-user'}),'SOURCE_HAS_MARKETPLACE_HISTORY'],
 ['marketplace order',s=>rows(s,'transactions').push({buyer_id:'source-user'}),'SOURCE_HAS_MARKETPLACE_HISTORY'],
 ['bad quote',s=>rows(s,'paypal_payment_bindings')[0].quote_json='{}','INVALID_SOURCE_QUOTE'],
 ['bad fingerprint',s=>rows(s,'wallet_entries')[1].request_fingerprint='bad','SOURCE_FINGERPRINT_MISMATCH'],
 ]){s=fixture();mutate(s);assert.throws(()=>I.buildPlan(s,'fixture@example.test',hash),e=>e.code===code);ok(true,label+' fails closed');}
 let db=await database();s=fixture();let before=await state(db);ok((await run(db,s)).outcome==='READY','default mode validates only');ok(await state(db)===before,'read-only check does not change any table');
 const oldOrder=await db.prepare("SELECT * FROM transactions WHERE id='old-order'").get();const old=await db.prepare("SELECT * FROM users WHERE id='old-seller'").get();ok((await run(db,s,true)).outcome==='IMPORTED','apply imports account atomically');
 const imported=await db.prepare("SELECT * FROM users WHERE id='source-user'").get();ok(imported.account_status==='PENDING_PASSKEY'&&imported.token_version===5&&imported.password_hash===rows(s,'users')[0].password_hash,'new domain requires enrollment, preserves password hash and increments token version');
 ok((await db.prepare('SELECT COUNT(*) n FROM passkey_credentials').get()).n===0&&(await db.prepare('SELECT COUNT(*) n FROM sessions').get()).n===0,'does not import source credentials or sessions');
 ok(JSON.stringify(await db.prepare("SELECT * FROM users WHERE id='old-seller'").get())===JSON.stringify(old),'old SELLER identity and login unchanged');
 ok((await db.prepare("SELECT * FROM wallets WHERE id='old-wallet'").get()).available_balance===5000&&(await db.prepare("SELECT * FROM listings WHERE id='old-listing'").get()).seller_id==='old-seller','old seller wallet and listing untouched');
 ok((await db.prepare("SELECT COUNT(*) n FROM security_events WHERE event_type=? AND actor_id='source-user'").get(I.EVENT)).n===1,'atomic audit receipt written once');
 ok(JSON.stringify(await db.prepare("SELECT * FROM transactions WHERE id='old-order'").get())===JSON.stringify(oldOrder),'old marketplace order unchanged');const inv=await require('../src/lib/invariants').checkInvariants(db);ok(inv.ok && inv.checked===9,'nine core invariants remain true after import');before=await state(db);ok((await run(db,s,true)).outcome==='ALREADY_IMPORTED','second apply reports replay');ok(await state(db)===before,'replay cannot duplicate money or audit');
 await db.prepare("UPDATE users SET password_hash='changed-after-enrollment',account_status='ACTIVE',token_version=9 WHERE id='source-user'").run();await db.prepare("INSERT INTO passkey_credentials(id,user_id,credential_id,public_key) VALUES ('new-key','source-user','domain-key',?)").run(Buffer.from('fixture'));
 ok((await run(db,s,true)).outcome==='ALREADY_IMPORTED','replay allowed after new domain enrollment/password change');ok((await db.prepare("SELECT password_hash FROM users WHERE id='source-user'").get()).password_hash==='changed-after-enrollment','replay does not overwrite current login');
 await db.prepare("DELETE FROM wallet_entries WHERE id='source-credit'").run();await rejected(()=>run(db,s,true),'IMPORTED_FINANCIAL_MISMATCH','receipt does not hide missing ledger');await db.close();
 for(const point of ['after-user','after-wallet','after-payments','after-bindings','after-ledger','after-receipt']){db=await database();before=await state(db);await assert.rejects(()=>run(db,fixture(),true,p=>{if(p===point)throw Error('injected');}),/injected/);ok(await state(db)===before,'rollback complete at '+point);await db.close();}
 db=await database();await db.prepare("UPDATE users SET username='fixture@example.test' WHERE id='old-seller'").run();before=await state(db);await rejected(()=>run(db,fixture(),true),'TARGET_ACCOUNT_COLLISION','exact username collision aborts, never merges SELLER');ok(await state(db)===before,'collision leaves original account unchanged');await db.close();
 db=await database();await db.prepare("INSERT INTO wallet_entries(id,wallet_id,request_id,entry_type,available_delta,available_after,locked_after,idempotency_key) VALUES ('collision','old-wallet','old-request','DEMO_TOPUP',1,5001,0,'topup:source-payment')").run();before=await state(db);await rejected(()=>run(db,fixture(),true),'TARGET_ENTRY_COLLISION','financial idempotency collision fails closed');ok(await state(db)===before,'financial collision preserves all rows');await db.close();
 db=await database();await run(db,fixture(),true);await db.prepare("UPDATE security_events SET detail='{}' WHERE event_type=?").run(I.EVENT);await rejected(()=>run(db,fixture(),true),'IMPORT_RECEIPT_MISMATCH','receipt hash mismatch rejects replay');await db.close();
 const file=path.join(os.tmpdir(),'import-synthetic-'+crypto.randomUUID()+'.json.gz');try{const bytes=zlib.gzipSync(JSON.stringify(fixture()));fs.writeFileSync(file,bytes);const sum=crypto.createHash('sha256').update(bytes).digest('hex');ok(I.loadSnapshot(file,sum).format==='enclave-data-snapshot-v1','offline file verifies SHA256 before parsing');assert.throws(()=>I.loadSnapshot(file,hash),e=>e.code==='SOURCE_HASH_MISMATCH');ok(true,'altered/source hash mismatch rejected');}finally{fs.unlinkSync(file);}
 ok(I.targetFingerprint('postgres://one:secret@localhost:5432/test')===I.targetFingerprint('postgresql://two:other@localhost:5432/test'),'target fingerprint excludes credentials and canonicalizes scheme');ok(I.targetFingerprint('postgresql://localhost:5432/test')!==I.targetFingerprint('postgresql://localhost:5432/prod'),'different target DB fingerprints differ');
 console.log(`Import checks: ${pass} PASS, 0 FAIL`);
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});



