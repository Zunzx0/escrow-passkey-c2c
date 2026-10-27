'use strict';
// Run the existing PayPal regressions with a fresh, explicit environment and
// private SQLite files. Never inherit DATABASE_URL or read the developer .env.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const testRoot=path.join(root,'data','test');
fs.mkdirSync(testRoot,{recursive:true});
const dir=fs.mkdtempSync(path.join(testRoot,'order-paypal-'));
const evidence=path.join(__dirname,'evidence','order-money-2026-10-26');
fs.mkdirSync(evidence,{recursive:true});
const inherited={};
for(const key of ['SystemRoot','WINDIR','PATH','Path','TEMP','TMP','COMSPEC','PATHEXT']) {
  if(process.env[key])inherited[key]=process.env[key];
}
let failed=false;
for(const suite of ['paypal-m2-settlement-e2e','paypal-abandonment-e2e']) {
  const secret=crypto.randomBytes(32).toString('hex');
  const env={...inherited,APP_ENV:'test',NODE_ENV:'test',DATABASE_URL:'',DB_PATH:path.join(dir,suite+'.db'),
    DOTENV_CONFIG_PATH:path.join(dir,'absent.env'),JWT_SECRET:secret,PAYMENT_WEBHOOK_SECRET:secret,
    AUTH_SECRET_PEPPER:secret,AUTH_MAIL_ENCRYPTION_KEY:secret,AUTH_EMAIL_TRANSPORT:'test',
    AUTH_PUBLIC_URL:'https://enclave.example/',AUTH_BACKGROUND_JOBS:'0',
    SHIPPING_WORKER_INTERVAL_MS:'0',ORDER_LIFECYCLE_WORKER_SECONDS:'0',
    RECONCILE_INTERVAL_SECONDS:'0',CHALLENGE_CLEANUP_INTERVAL_SECONDS:'0'};
  const result=spawnSync(process.execPath,['test/'+suite+'.js'],{cwd:root,env,windowsHide:true,
    encoding:'utf8',timeout:180000,maxBuffer:4*1024*1024});
  const log=(result.stdout||'')+(result.stderr||'')+(result.error?'\n'+result.error.message:'');
  fs.writeFileSync(path.join(evidence,suite+'.log'),log);
  console.log(suite+': exit '+result.status);
  console.log(log.trim().split(/\r?\n/).slice(-4).join('\n'));
  if(result.error||result.status!==0)failed=true;
}
// Preserve logs, remove only the fixed SQLite filenames created by this run.
assert.ok(path.resolve(dir).startsWith(testRoot+path.sep));
for(const suite of ['paypal-m2-settlement-e2e','paypal-abandonment-e2e']) {
  for(const suffix of ['','-wal','-shm']) {
    try{fs.unlinkSync(path.join(dir,suite+'.db')+suffix);}catch(e){if(e.code!=='ENOENT')throw e;}
  }
}
fs.rmdirSync(dir);
process.exitCode=failed?1:0;
