'use strict';
// Offline, single-account import. Never imports sessions or credentials from another RP.
// CLI default is read-only; it deliberately does NOT load src/db.js or run migrations.
const fs = require('node:fs');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { validateQuote } = require('../src/lib/paypalSandboxProvider');
const COLS = Object.freeze({
  users: 'id username display_name role password_hash account_status token_version is_active created_at updated_at'.split(' '),
  wallets: 'id user_id wallet_type available_balance locked_balance version created_at updated_at'.split(' '),
  wallet_entries: 'id wallet_id transaction_id request_id entry_type available_delta locked_delta available_after locked_after idempotency_key request_fingerprint description created_at'.split(' '),
  payment_requests: 'id user_id amount status provider_ref version resolved_at resolved_by reconcile_attempts last_reconciled_at last_reconcile_error created_at updated_at client_request_id submission_status submit_attempts last_submit_error submit_claim submit_claimed_at provider'.split(' '),
  paypal_payment_bindings: 'payment_request_id provider quote_json amount_vnd currency usd_cents rate_vnd_per_usd merchant_id order_id order_bound_at create_attempt_at capture_state capture_claim capture_claimed_at capture_attempts first_capture_at capture_post_sent_at capture_post_count capture_id capture_verified_at not_captured_evidence recovery_required_at last_capture_error created_at'.split(' '),
});
const NUM = new Set('token_version is_active available_balance locked_balance version available_delta locked_delta available_after locked_after amount reconcile_attempts submit_attempts amount_vnd usd_cents rate_vnd_per_usd capture_attempts capture_post_count'.split(' '));
const EVENT = 'ACCOUNT_SANDBOX_IMPORTED';
function fail(code) { const e = new Error(code); e.code = code; throw e; }
function ensure(v, code) { if (!v) fail(code); }
function integer(v) {
  ensure((typeof v === 'number' && Number.isSafeInteger(v)) || (typeof v === 'string' && /^-?\d+$/.test(v)), 'UNSAFE_INTEGER');
  const n = BigInt(v); ensure(n >= BigInt(Number.MIN_SAFE_INTEGER) && n <= BigInt(Number.MAX_SAFE_INTEGER), 'UNSAFE_INTEGER');
  return Number(n);
}
function row(table, input) {
  ensure(input && typeof input === 'object' && !Array.isArray(input), 'INVALID_ROW');
  const cols = COLS[table]; ensure(Object.keys(input).length === cols.length && cols.every(k => Object.hasOwn(input, k)), 'UNEXPECTED_COLUMNS');
  return Object.fromEntries(cols.map(k => { const v = input[k]; ensure(v === null || typeof v === 'string' || typeof v === 'number', 'INVALID_CELL'); return [k, NUM.has(k) && v !== null ? integer(v) : v]; }));
}
function canonical(value) { return JSON.stringify(value, (k,v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(key=>[key,v[key]])) : v); }
function digest(value) { return crypto.createHash('sha256').update(canonical(value)).digest('hex'); }
function unique(rows, key) { ensure(new Set(rows.map(r=>r[key])).size === rows.length && rows.every(r=>typeof r[key]==='string' && r[key]), 'DUPLICATE_SOURCE_IDENTIFIER'); }
function tableRows(snapshot, name) {
  const found = snapshot.tables.filter(t=>t.schema==='app' && t.name===name);
  ensure(found.length===1 && Array.isArray(found[0].rows), 'INVALID_SOURCE_TABLE'); return found[0].rows;
}
function buildPlan(snapshot, username, sourceSha256) {
  ensure(snapshot && snapshot.format==='enclave-data-snapshot-v1' && Array.isArray(snapshot.tables), 'INVALID_SNAPSHOT');
  ensure(typeof username==='string' && username===username.trim().toLowerCase() && username.length>0, 'INVALID_USERNAME');
  ensure(/^[a-f0-9]{64}$/.test(sourceSha256||''), 'INVALID_SOURCE_HASH');
  const matches = tableRows(snapshot,'users').filter(u=>u.username===username); ensure(matches.length===1, 'SOURCE_USER_NOT_UNIQUE');
  const user = row('users', matches[0]);
  ensure(user.role==='BUYER' && user.account_status==='ACTIVE' && user.is_active===1 && typeof user.password_hash==='string' && user.password_hash.length>=40 && user.token_version>=0, 'SOURCE_ACCOUNT_UNSAFE');
  integer(user.token_version+1);
  const wallets = tableRows(snapshot,'wallets').filter(w=>w.user_id===user.id); ensure(wallets.length===1, 'SOURCE_WALLET_NOT_UNIQUE');
  const wallet = row('wallets', wallets[0]); ensure(wallet.wallet_type==='USER' && wallet.locked_balance===0 && wallet.available_balance>=0 && wallet.version>=0, 'SOURCE_WALLET_UNSAFE');
  ensure(!tableRows(snapshot,'transactions').some(t=>t.buyer_id===user.id || t.seller_id===user.id) && !tableRows(snapshot,'listings').some(l=>l.seller_id===user.id), 'SOURCE_HAS_MARKETPLACE_HISTORY');
  const payments = tableRows(snapshot,'payment_requests').filter(p=>p.user_id===user.id).map(p=>row('payment_requests',p)).sort((a,b)=>a.id.localeCompare(b.id));
  const ids = new Set(payments.map(p=>p.id));
  const bindings = tableRows(snapshot,'paypal_payment_bindings').filter(b=>ids.has(b.payment_request_id)).map(b=>row('paypal_payment_bindings',b)).sort((a,b)=>a.payment_request_id.localeCompare(b.payment_request_id));
  const entries = tableRows(snapshot,'wallet_entries').filter(e=>e.wallet_id===wallet.id).map(e=>row('wallet_entries',e));
  for (const [rows,key] of [[payments,'id'],[payments,'provider_ref'],[payments,'client_request_id'],[bindings,'payment_request_id'],[bindings,'order_id'],[bindings,'capture_id'],[entries,'id'],[entries,'idempotency_key']]) unique(rows,key);
  ensure(bindings.length===payments.length, 'MISSING_BINDING');
  for (const p of payments) {
    ensure(p.status==='SUCCEEDED' && p.provider==='PAYPAL_SANDBOX' && p.amount>0 && ['SUBMITTING','SUBMITTED','SUBMIT_FAILED'].includes(p.submission_status) && !p.submit_claim && !p.submit_claimed_at && p.resolved_at && ['WEBHOOK','RECONCILER'].includes(p.resolved_by), 'SOURCE_PAYMENT_UNSETTLED');
    const b=bindings.find(b=>b.payment_request_id===p.id);
    ensure(b && b.provider==='PAYPAL_SANDBOX' && b.capture_state==='VERIFIED' && b.amount_vnd===p.amount && b.capture_id && b.order_id && b.capture_verified_at && b.currency==='USD' && !b.capture_claim && !b.capture_claimed_at && !b.recovery_required_at && !b.not_captured_evidence, 'SOURCE_BINDING_UNSAFE');
    let quote; try { quote=validateQuote(JSON.parse(b.quote_json)); } catch { fail('INVALID_SOURCE_QUOTE'); }
    ensure(quote.amountVnd===b.amount_vnd && quote.usdCents===b.usd_cents && quote.rateVndPerUsd===b.rate_vnd_per_usd, 'INVALID_SOURCE_QUOTE');
    const credits=entries.filter(e=>e.request_id===p.id && e.entry_type==='TOPUP_CREDIT');
    ensure(credits.length===1 && credits[0].available_delta===p.amount && credits[0].idempotency_key===`topup:${p.id}`, 'SOURCE_CREDIT_MISMATCH');
    const expected=crypto.createHash('sha256').update(JSON.stringify({actorId:user.id,action:'TOPUP',transactionId:null,amount:p.amount})).digest('hex');
    ensure(credits[0].request_fingerprint===expected, 'SOURCE_FINGERPRINT_MISMATCH');
  }
  ensure(entries.filter(e=>e.entry_type==='DEMO_TOPUP').length<=1, 'MULTIPLE_DEMO_SEEDS');
  let running=0;
  // Preserve export ordering; also require chronological ordering rather than sorting corrupt evidence.
  let previous='';
  for(const e of entries) {
    ensure(e.wallet_id===wallet.id && e.transaction_id===null && e.locked_delta===0 && e.locked_after===0 && e.available_delta>0 && ['DEMO_TOPUP','TOPUP_CREDIT'].includes(e.entry_type), 'SOURCE_LEDGER_UNSAFE');
    ensure(typeof e.created_at==='string' && e.created_at>=previous, 'SOURCE_LEDGER_ORDER'); previous=e.created_at;
    if(e.entry_type==='TOPUP_CREDIT') ensure(ids.has(e.request_id), 'ORPHAN_CREDIT');
    else ensure(e.idempotency_key===`demo-topup:${user.id}`, 'SOURCE_DEMO_KEY_MISMATCH');
    running=integer(BigInt(running).toString()); running=integer((BigInt(running)+BigInt(e.available_delta)).toString());
    ensure(e.available_after===running, 'SOURCE_LEDGER_AFTER_MISMATCH');
  }
  ensure(running===wallet.available_balance, 'SOURCE_BALANCE_MISMATCH');
  const financialDigest=digest({wallet,entries,payments,bindings});
  return {user,wallet,entries,payments,bindings,sourceSha256,financialDigest};
}
async function insert(db, table, value) {
  const cols=COLS[table]; await db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(()=>'?').join(',')})`).run(...cols.map(k=>value[k]));
}
function sameRow(table, actual, expected) { return actual && canonical(row(table,actual))===canonical(expected); }
async function verifyReceipt(db, plan, receipt) {
  let detail; try {detail=JSON.parse(receipt.detail);}catch{fail('IMPORT_RECEIPT_INVALID');}
  ensure(detail.sourceSha256===plan.sourceSha256 && detail.financialDigest===plan.financialDigest && detail.userId===plan.user.id && detail.walletId===plan.wallet.id && receipt.actor_id===plan.user.id && receipt.outcome==='ALLOWED', 'IMPORT_RECEIPT_MISMATCH');
  const user=await db.prepare('SELECT * FROM users WHERE id=?').get(plan.user.id);
  ensure(user && user.username===plan.user.username && ['BUYER','SELLER'].includes(user.role), 'IMPORTED_USER_MISMATCH');
  const wallet=await db.prepare('SELECT * FROM wallets WHERE id=?').get(plan.wallet.id);
  ensure(wallet && wallet.user_id===plan.user.id && wallet.wallet_type==='USER', 'IMPORTED_WALLET_MISMATCH');
  for(const [table, rows, key] of [['wallet_entries',plan.entries,'id'],['payment_requests',plan.payments,'id'],['paypal_payment_bindings',plan.bindings,'payment_request_id']]) {
    for(const expected of rows) ensure(sameRow(table, await db.prepare(`SELECT * FROM ${table} WHERE ${key}=?`).get(expected[key]), expected), 'IMPORTED_FINANCIAL_MISMATCH');
  }
  const sums=await db.prepare('SELECT COALESCE(SUM(available_delta),0) AS a,COALESCE(SUM(locked_delta),0) AS l FROM wallet_entries WHERE wallet_id=?').get(plan.wallet.id);
  ensure(integer(sums.a)===integer(wallet.available_balance) && integer(sums.l)===integer(wallet.locked_balance), 'IMPORTED_BALANCE_MISMATCH');
}
async function importAccount({db,snapshot,username,sourceSha256,apply=false,now=new Date().toISOString(),fault=()=>{}}) {
  const plan=buildPlan(snapshot,username,sourceSha256);
  return db.transaction(async()=>{
    const receipts=await db.prepare('SELECT * FROM security_events WHERE event_type=? AND actor_id=?').all(EVENT,plan.user.id);
    if(receipts.length) {ensure(receipts.length===1,'IMPORT_RECEIPT_NOT_UNIQUE');await verifyReceipt(db,plan,receipts[0]);return {outcome:'ALREADY_IMPORTED',userId:plan.user.id,balance:plan.wallet.available_balance,payments:plan.payments.length};}
    ensure(!(await db.prepare('SELECT id FROM users WHERE id=? OR username=?').get(plan.user.id,username)), 'TARGET_ACCOUNT_COLLISION');
    ensure(!(await db.prepare('SELECT id FROM wallets WHERE id=? OR user_id=?').get(plan.wallet.id,plan.user.id)), 'TARGET_WALLET_COLLISION');
    for(const p of plan.payments) ensure(!(await db.prepare('SELECT id FROM payment_requests WHERE id=? OR provider_ref=? OR (user_id=? AND client_request_id=?)').get(p.id,p.provider_ref,plan.user.id,p.client_request_id)), 'TARGET_PAYMENT_COLLISION');
    for(const b of plan.bindings) ensure(!(await db.prepare('SELECT payment_request_id FROM paypal_payment_bindings WHERE payment_request_id=? OR order_id=? OR capture_id=?').get(b.payment_request_id,b.order_id,b.capture_id)), 'TARGET_BINDING_COLLISION');
    for(const e of plan.entries) ensure(!(await db.prepare('SELECT id FROM wallet_entries WHERE id=? OR idempotency_key=?').get(e.id,e.idempotency_key)), 'TARGET_ENTRY_COLLISION');
    if(!apply) return {outcome:'READY',userId:plan.user.id,balance:plan.wallet.available_balance,payments:plan.payments.length};
    await insert(db,'users',{...plan.user,account_status:'PENDING_PASSKEY',token_version:plan.user.token_version+1,updated_at:now}); await fault('after-user');
    await insert(db,'wallets',plan.wallet); await fault('after-wallet');
    for(const p of plan.payments) await insert(db,'payment_requests',p); await fault('after-payments');
    for(const b of plan.bindings) await insert(db,'paypal_payment_bindings',b); await fault('after-bindings');
    for(const e of plan.entries) await insert(db,'wallet_entries',e); await fault('after-ledger');
    await db.prepare('INSERT INTO security_events (event_type,outcome,actor_id,username,detail,created_at) VALUES (?,?,?,?,?,?)').run(EVENT,'ALLOWED',plan.user.id,username,JSON.stringify({version:1,sourceSha256,financialDigest:plan.financialDigest,userId:plan.user.id,walletId:plan.wallet.id,passkeyEnrollmentRequired:true}),now);
    await fault('after-receipt');
    return {outcome:'IMPORTED',userId:plan.user.id,balance:plan.wallet.available_balance,payments:plan.payments.length,passkeyEnrollmentRequired:true};
  })();
}
function targetFingerprint(url) {const u=new URL(url);ensure(['postgres:','postgresql:'].includes(u.protocol),'TARGET_MUST_BE_POSTGRES');return crypto.createHash('sha256').update(`postgresql://${u.host}${u.pathname}`).digest('hex');}
function loadSnapshot(file, expectedSha256) {
  ensure(/^[a-f0-9]{64}$/.test(expectedSha256||''),'INVALID_SOURCE_HASH');const bytes=fs.readFileSync(file);
  ensure(crypto.createHash('sha256').update(bytes).digest('hex')===expectedSha256,'SOURCE_HASH_MISMATCH');
  return JSON.parse(zlib.gunzipSync(bytes).toString('utf8'));
}
async function cli() {
  const args=process.argv.slice(2), opts={};
  for(const arg of args) {if(arg==='--apply'||arg==='--check'||arg==='--source-frozen')opts[arg.slice(2)]=true;else{const m=/^--(source|username|expected-source-sha256|expected-target-sha256)=(.+)$/.exec(arg);ensure(m && !Object.hasOwn(opts,m[1]),'INVALID_ARGUMENT');opts[m[1]]=m[2];}}
  ensure(!(opts.apply&&opts.check),'INVALID_ARGUMENT');
  ensure(opts.source&&opts.username&&process.env.DATABASE_URL&&opts['expected-target-sha256'],'EXPLICIT_SOURCE_AND_TARGET_REQUIRED');
  ensure(targetFingerprint(process.env.DATABASE_URL)===opts['expected-target-sha256'],'TARGET_HASH_MISMATCH');
  ensure(!opts.apply || opts['source-frozen'],'SOURCE_FREEZE_ACK_REQUIRED');
  const snapshot=loadSnapshot(opts.source,opts['expected-source-sha256']);buildPlan(snapshot,opts.username,opts['expected-source-sha256']);
  const {Pool}=require('pg'),{PgAsyncDatabase}=require('../src/lib/asyncDb');
  // No schema initialization; operators deploy migrations separately before import.
  const pool=new Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path=app,public'}),db=new PgAsyncDatabase(pool);
  try {
    const versions=await db.prepare('SELECT version FROM schema_migrations ORDER BY version').all();ensure(versions.some(v=>Number(v.version)===6),'TARGET_SCHEMA_NOT_READY');
    console.log(JSON.stringify(await importAccount({db,snapshot,username:opts.username,sourceSha256:opts['expected-source-sha256'],apply:Boolean(opts.apply)})));
  }finally{await db.close();}
}
module.exports={importAccount,buildPlan,loadSnapshot,targetFingerprint,COLS,EVENT};
if(require.main===module)cli().catch(error=>{console.error('IMPORT_ABORTED '+(error.code && /^[A-Z_]+$/.test(error.code)?error.code:'OPERATION_FAILED'));process.exitCode=1;});


