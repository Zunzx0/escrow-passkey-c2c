'use strict';
// Assemble machine-readable evidence from executed logs, never invent outcomes.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),dir=path.join(__dirname,'evidence','order-money-2026-10-26');
function result(file){const text=fs.readFileSync(path.join(dir,file),'utf8');const line=text.split(/\r?\n/).find(l=>l.startsWith('ORDER_MONEY_RESULTS '));assert.ok(line,'executed result missing '+file);return JSON.parse(line.slice('ORDER_MONEY_RESULTS '.length));}
function hashes(folder){const out={};function walk(where){for(const ent of fs.readdirSync(where,{withFileTypes:true})){const full=path.join(where,ent.name);if(ent.isDirectory())walk(full);else if(/\.(js|sql)$/.test(ent.name))out[path.relative(folder,full).replaceAll('\\','/')]=crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');}}walk(folder);return out;}
const sqlite=result('sqlite-final.log'),pg=result('postgres-final.log'),baseline=result('baseline-red.log'),x08Baseline=result('x08-baseline-red.log');
for(const r of [sqlite,pg]){assert.equal(r.failed,0,'cannot generate green evidence from failing suite');for(let n=1;n<=43;n++){const id='T'+String(n).padStart(2,'0');assert.equal(r.results.find(x=>x.id===id)?.result,'PASS',id+' missing');}for(let n=1;n<=8;n++){const id='X'+String(n).padStart(2,'0');assert.equal(r.results.find(x=>x.id===id)?.result,'PASS',id+' missing');}}
assert.equal(x08Baseline.results.find(r=>r.id==='X08')?.result,'FAIL','X08 old-source red evidence missing');
const pgLog=fs.readFileSync(path.join(dir,'postgres-final.log'),'utf8');assert.ok(pgLog.includes('ORDER MONEY POSTGRES: PASS'));assert.ok(pgLog.includes('Dedicated PostgreSQL stopped;'));
const snapshot=pgLog.split(/\r?\n/).find(l=>l.startsWith('Dedicated PostgreSQL stopped; evidence temp directory ')).slice('Dedicated PostgreSQL stopped; evidence temp directory '.length);
const git=spawnSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',windowsHide:true});assert.equal(git.status,0);
const sqliteVersion=(()=>{const {DatabaseSync}=require('node:sqlite'),d=new DatabaseSync(':memory:');try{return d.prepare('SELECT sqlite_version() v').get().v;}finally{d.close();}})();
const postgresVersion=spawnSync('C:/Program Files/PostgreSQL/17/bin/postgres.exe',['--version'],{encoding:'utf8',windowsHide:true});assert.equal(postgresVersion.status,0);
const sqliteMigration=fs.readFileSync(path.join(dir,'sqlite-migration.log'),'utf8');assert.ok(sqliteMigration.includes('33 assertions PASS'));
const evidence={
  capturedAt:new Date().toISOString(),baseCommit:git.stdout.trim(),sourceStatus:'Uncommitted working tree; not a published release',
  spec:'ORDER-MONEY-SPEC-2026-10-26.md plus user-approved 6e decisions and T42 draft/LOCK distinction',
  runtime:{node:process.version,sqlite:sqliteVersion,postgres:postgresVersion.stdout.trim()},
  testLayer:'Real HTTP routes and isolated databases; NOT production acceptance or physical Passkey-device proof',
  fixturePolicy:'Most monetary cases use trusted DB credentials/session/grant fixtures; T32 verifies software WebAuthn signatures. No .env read, no production DB, no real email.',
  baseline:{commit:git.stdout.trim(),result:baseline,meaning:'T01 rejects SELLER purchase; T03 accepts missing address before fixes. T02 already passed.'},
  reviewBaseline:{result:x08Baseline,meaning:'X08 run against retained prior PostgreSQL source snapshot in a separate SQLite fixture: paid-order replay returned 409 LISTING_SOLD; global invariants passed. No source-current mutation.'},
  sqlite,postgres:pg,
  extraCases:{
    X01:'Repeated/concurrent draft requestId gives same order; changed payload conflicts',
    X02:'Valid release grant issued before recovery cannot bypass later money restriction',
    X03:'Append-only participant messages preserve SYSTEM timeout type/reason/author and allow later buyer inspection/release; outsiders and invalid text denied',
    X04:'Explicit buyer or seller complaint converts SYSTEM timeout to human dispute and preserves the original SYSTEM reason as immutable message',
    X05:'Buyer and admin grants become stale after new dispute message/revision and cannot move money',
    X06:'Object/array/boolean/null/empty/whitespace/oversized requestId denied with 400 across order/lock/release/admin refund/admin release without money movement',
    X07:'Shipping worker and lifecycle worker both invocation orders after >24h downtime produce frozen stopped SHIPMENT_STALLED instead of synthetic delivery',
    X08:'Same original buyer requestId replays original order/current state after SECURED or CANCELLED and listing price/title changes; changed intent conflicts and foreign buyer cannot retrieve it',
  },
  repetition:{twoBuyersOneItem:100,cancelVersusAcknowledge:10,buyerTimeoutReleaseVersusAdminRefund:10,independentWorkerProcesses:2},
  migration:{sqlite:'33 assertions, populated legacy schema, four repeats including reopen; preserves balances/keys/index/FKs and does not fabricate address/inspection/receipt',postgres:'v11 populated database upgraded; v12 SQL executed twice more; preserves legacy values and hidden refunded listing'},
  sourceHashes:{postgresImmutableSnapshot:hashes(path.join(snapshot,'suite','src')),workingTreeAtEvidenceCapture:hashes(path.join(root,'src'))},
  limits:['No actual Safari/iPhone/Android biometrics proven by these API tests','No live PayPal Sandbox top-up or production migration performed','Time boundaries tested using injected worker clock and temporary DB timestamps; production durations unchanged','P1 manual returns are outside this suite','Baseline red samples cover T01/T03/X08; not a red baseline for every case','T25 checks persisted audit/security events; this isolated router harness does not prove every infrastructure log sink is redacted'],
};
const target=path.join(dir,'acceptance-results.json');fs.writeFileSync(target,JSON.stringify(evidence,null,2)+'\n');
console.log('Evidence saved: '+target);console.log(`SQLite ${sqlite.checks} assertions, PostgreSQL ${pg.checks} assertions; T01–T43 + X01–X08 + global checks PASS on each database.`);
