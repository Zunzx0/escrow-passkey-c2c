'use strict';
// M2 — phục hồi sau sự cố tiến trình thật: crash giữa commit, POST treo rồi tiến trình chết, khởi động lại
// và đối soát/nhận lại quyền. Trạng thái PayPal (fake) nằm trong file nên sống qua các tiến trình.
// Chạy: APP_ENV=test DB_PATH=data/test/... node test/paypal-m2-recovery-e2e.js
const H = require('./helpers/paypal-m2-harness');
const { statePath } = H.init('recovery');
H.resetFake(statePath);

const path = require('path');
const { spawnSync, spawn } = require('child_process');
const { createDurableFake } = require('./helpers/paypal-m2-fake');
const CHILD = path.join(__dirname, 'helpers', 'paypal-m2-child.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, label, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await sleep(25); }
  throw new Error(`hết thời gian chờ: ${label}`);
}

async function killAndWait(child) {
  if(child.exitCode!==null || child.signalCode!==null)return;
  let timer,onExit,onError;
  const exit=new Promise((resolve,reject)=>{
    onExit=resolve;onError=reject;
    child.once('exit',onExit);child.once('error',onError);
    timer=setTimeout(()=>reject(Error('capture child did not exit within cleanup deadline')),3000);
  });
  try {
    if(!child.kill('SIGKILL'))throw Error('capture child kill returned false');
    await exit;
  } finally {
    clearTimeout(timer);child.removeListener('exit',onExit);child.removeListener('error',onError);
    // If kill itself failed, suppress the orphan Promise rejection, then preserve the original error.
    exit.catch(()=>{});
  }
}
async function waitForPendingPost(child,condition) {
  let stderr='';
  child.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-4000);});
  try {
    await waitFor(async()=>{
      if(child.exitCode!==null || child.signalCode!==null)throw Error('capture child exited before durable POST barrier: '+child.exitCode+' '+child.signalCode+' '+stderr);
      return await condition();
    },'POST đã gửi và đang treo');
  } catch(error) {
    try{await killAndWait(child);}catch(cleanupError){error.cleanupError=cleanupError;}
    error.message+='; child stderr='+stderr;
    throw error;
  }
}
async function cleanupKids(children,original) {
  const outcomes=await Promise.allSettled(children.map(child=>killAndWait(child)));
  const errors=outcomes.filter(outcome=>outcome.status==='rejected').map(outcome=>outcome.reason);
  if(errors.length){if(original)original.cleanupErrors=errors;else throw new AggregateError(errors,'capture child cleanup failed');}
}

function checkDurableFakeFailures(t) {
  const fs=require('fs');
  const file=statePath+'.io-regression.json';
  try{fs.unlinkSync(file);}catch(e){if(e.code!=='ENOENT')throw e;}
  const fake=createDurableFake({statePath:file});
  fake.plan('capture','hold');
  const originalRename=fs.renameSync;
  let injected=false,writeError;
  fs.renameSync=(...args)=>{if(args[1]===file && !injected){injected=true;throw Object.assign(Error('controlled sharing failure'),{code:'EBUSY'});}return originalRename(...args);};
  try{fake.plan('get','lose');}catch(e){writeError=e;}finally{fs.renameSync=originalRename;}
  t.ok(!writeError && injected && JSON.stringify(JSON.parse(fs.readFileSync(file,'utf8')).plan)===JSON.stringify({capture:['hold'],get:['lose']}),'fake: rename EBUSY tạm thời giữ cả trạng thái cũ và mới');
  const before=fs.readFileSync(file,'utf8');
  const originalRead=fs.readFileSync;
  let readInjected=false,readError;
  fs.readFileSync=(...args)=>{if(args[0]===file && !readInjected){readInjected=true;throw Object.assign(Error('controlled read failure'),{code:'EIO'});}return originalRead(...args);};
  try{fake.plan('create','hold');}catch(e){readError=e;}finally{fs.readFileSync=originalRead;}
  t.ok(readInjected && readError && readError.code==='EIO','fake: lỗi đọc phải bị từ chối, không thay bằng EMPTY');
  t.eq(fs.readFileSync(file,'utf8'),before,'fake: lỗi đọc không ghi đè trạng thái bền');
  const originalUnlink=fs.unlinkSync;
  let writeFailure;
  fs.renameSync=(...args)=>{if(args[1]===file)throw Object.assign(Error('primary rename EIO'),{code:'EIO'});return originalRename(...args);};
  fs.unlinkSync=(...args)=>{if(String(args[0]).startsWith(file+'.')&&String(args[0]).endsWith('.tmp'))throw Object.assign(Error('secondary unlink EACCES'),{code:'EACCES'});return originalUnlink(...args);};
  try{fake.plan('write-failure','hold');}catch(e){writeFailure=e;}finally{fs.renameSync=originalRename;fs.unlinkSync=originalUnlink;}
  t.ok(writeFailure?.code==='EIO'&&writeFailure.message==='primary rename EIO'&&writeFailure.cleanupError?.code==='EACCES','rename EIO giữ lỗi gốc khi cleanup unlink EACCES');
  t.eq(fs.readFileSync(file,'utf8'),before,'rename thất bại không thay trạng thái đã commit');
  for(const name of fs.readdirSync(path.dirname(file))){if(name.startsWith(path.basename(file)+'.')&&name.endsWith('.tmp'))fs.unlinkSync(path.join(path.dirname(file),name));}
}

async function checkLockRecovery(t) {
  const fs=require('fs'),{EventEmitter}=require('events');
  const file=statePath+'.lock-regression.json',lock=file+'.lock';
  for(const role of ['A','B'])for(const suffix of ['stale','release-stale','owned','cleaned','release-owned']){
    try{fs.unlinkSync(file+'.'+role+'.'+suffix);}catch(e){if(e.code!=='ENOENT')throw e;}
  }
  try{fs.unlinkSync(file+'.crash-held');}catch(e){if(e.code!=='ENOENT')throw e;}
  const fake=createDurableFake({statePath:file});
  fake.plan('get','lose');
  const originalWrite=fs.writeFileSync;
  let injected=false,error;
  fs.writeFileSync=(...args)=>{if(String(args[0]).includes('.prepared-owner-')&&!injected){injected=true;throw Object.assign(Error('owner write failed'),{code:'EIO'});}return originalWrite(...args);};
  try{fake.plan('capture','hold');}catch(e){error=e;}finally{fs.writeFileSync=originalWrite;}
  t.ok(injected && error && error.code==='EIO' && !fs.existsSync(lock),'owner write failure never publishes ownerless lock');
  fake.plan('capture','hold');
  t.ok(JSON.parse(fs.readFileSync(file,'utf8')).plan.capture[0]==='hold','owner preparation failure leaves next acquisition usable');
  const stub=new EventEmitter();stub.exitCode=null;stub.signalCode=null;stub.kill=()=>false;
  await t.rejects(()=>killAndWait(stub),'Error','kill false fails promptly instead of waiting forever');
  let attempts=0;
  const failingKids=[0,1].map(()=>{const k=new EventEmitter();k.exitCode=null;k.signalCode=null;k.kill=()=>{attempts++;return false;};return k;});
  const originalBarrier=Error('original barrier failure');
  await cleanupKids(failingKids,originalBarrier);
  t.ok(attempts===2&&originalBarrier.cleanupErrors?.length===2&&originalBarrier.message==='original barrier failure','cleanup thử cả hai child và giữ lỗi barrier gốc');

  // Two stale contenders both observe the SAME dead owner before either cleans it.
  const oldName='owner-2147483647-'+('a'.repeat(32));
  fs.mkdirSync(lock);fs.writeFileSync(lock+'/'+oldName,'');
  const code=`const fs=require('fs'),{createDurableFake}=require(${JSON.stringify(path.join(__dirname,'helpers','paypal-m2-fake.js'))});
    const f=process.env.LOCK_TEST_FILE,r=process.env.LOCK_TEST_ROLE;
    const sleeper=new Int32Array(new SharedArrayBuffer(4));
    function wait(file){const end=Date.now()+5000;while(!fs.existsSync(file)){if(Date.now()>end)throw Error('test barrier '+file);Atomics.wait(sleeper,0,0,5);}}
    const fake=createDurableFake({statePath:f,lockHooks:{beforeStaleCleanup(){fs.writeFileSync(f+'.'+r+'.stale','');wait(f+'.'+r+'.release-stale');},afterStaleCleanup(){fs.writeFileSync(f+'.'+r+'.cleaned','');},afterAcquire(name){fs.writeFileSync(f+'.'+r+'.owned',name);wait(f+'.'+r+'.release-owned');}}});
    fake.plan(r,'hold');`;
  const kids=['A','B'].map(role=>spawn(process.execPath,['-e',code],{stdio:['ignore','pipe','pipe'],env:{...process.env,LOCK_TEST_FILE:file,LOCK_TEST_ROLE:role}}));
  const stderr=[];kids.forEach((k,i)=>k.stderr.on('data',c=>{stderr[i]=(stderr[i]||'')+c;}));
  let contenderError;
  try {
    await waitFor(()=>fs.existsSync(file+'.A.stale')&&fs.existsSync(file+'.B.stale'),'both stale contenders observed old owner');
    fs.writeFileSync(file+'.A.release-stale','');
    await waitFor(()=>fs.existsSync(file+'.A.owned'),'A acquired fresh lock');
    const fresh=fs.readFileSync(file+'.A.owned','utf8');
    fs.writeFileSync(file+'.B.release-stale','');
    await waitFor(()=>fs.existsSync(file+'.B.cleaned'),'B completed stale cleanup');
    t.ok(fs.existsSync(lock+'/'+fresh) && !fs.existsSync(file+'.B.owned'),'second stale contender cannot unlink fresh owner or acquire its lock');
    fs.writeFileSync(file+'.A.release-owned','');
    await waitFor(()=>fs.existsSync(file+'.B.owned'),'B acquired only after A released');
    fs.writeFileSync(file+'.B.release-owned','');
    await waitFor(()=>kids.every(k=>k.exitCode!==null),'both stale contenders exited');
    t.ok(kids.every(k=>k.exitCode===0),'both contenders complete without cleanup failure '+stderr.join(' '));
    const plans=JSON.parse(fs.readFileSync(file,'utf8')).plan;
    t.ok(plans.A?.[0]==='hold'&&plans.B?.[0]==='hold','both serialized contender mutations retained');
  } catch(error){contenderError=error;throw error;} finally {await cleanupKids(kids,contenderError);}

  const crashCode=`const fs=require('fs'),{createDurableFake}=require(${JSON.stringify(path.join(__dirname,'helpers','paypal-m2-fake.js'))});const f=process.env.LOCK_TEST_FILE;createDurableFake({statePath:f,lockHooks:{afterAcquire(){fs.writeFileSync(f+'.crash-held','');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}}}).plan('crash','hold');`;
  const crashed=spawn(process.execPath,['-e',crashCode],{stdio:['ignore','pipe','pipe'],env:{...process.env,LOCK_TEST_FILE:file}});
  let crashError;
  try{await waitFor(()=>fs.existsSync(file+'.crash-held'),'lock holder acquired before crash');}catch(error){crashError=error;throw error;}finally{await cleanupKids([crashed],crashError);}
  fake.plan('recovered','hold');
  t.ok(JSON.parse(fs.readFileSync(file,'utf8')).plan.recovered?.[0]==='hold'&&!fs.existsSync(lock),'dead holder lock recovers without losing persisted state');
}

function childEnv(extra) {
  return { ...process.env, PPM2_STATE: statePath, ...extra };
}

async function main() {
  const { db, uuid } = require('../src/db');
  const { createSandboxProvider } = require('../src/lib/paypalSandboxProvider');
  const { createPayPalRuntime } = require('../src/lib/paypalRuntime');

  const t = H.tally('M2 phục hồi');
  t.section('Fixture bền — lỗi chia sẻ tệp được tiêm có kiểm soát');
  checkDurableFakeFailures(t);
  await checkLockRecovery(t);
  const cfg = H.config();                                  // timeout 500 ms
  const cfgLong = H.config({ timeoutMs: 5000, leaseMs: 30000 });
  const makeRuntime = (c = cfg) => createPayPalRuntime({ config: c,
    provider: createSandboxProvider(c, { fetchImpl: createDurableFake({ statePath }).fetchImpl }) });
  const fakeView = () => createDurableFake({ statePath });
  const buyer = await H.createAccount(db, { label: 'rc-buyer' });
  const balance = async () => Number((await H.wallet(db, buyer.id)).available_balance);
  const bindingRow = (id) => db.prepare('SELECT * FROM paypal_payment_bindings WHERE payment_request_id = ?').get(id);
  const requestRow = (id) => db.prepare('SELECT status FROM payment_requests WHERE id = ?').get(id);
  const expireLease = (id) => db.prepare('UPDATE paypal_payment_bindings SET capture_claimed_at = ? WHERE payment_request_id = ?')
    .run('2000-01-01T00:00:00.000Z', id);
  const newApproved = async (amount) => {
    const r = await makeRuntime().create({ userId: buyer.id, amount, requestId: 'rc-' + uuid() });
    fakeView().approve(r.orderId);
    return r;
  };

  // ===================================================================================
  t.section('R1 — tiến trình con crash ngay trước commit (sau khi ghi số dư và bút toán)');
  {
    const r = await newApproved(21000);
    const before = await balance();
    const child = spawnSync(process.execPath, [CHILD], { cwd: H.ROOT, encoding: 'utf8', timeout: 60000,
      env: childEnv({ PPM2_REQUEST: r.id, PPM2_USER: buyer.id, FAULT_INJECT: 'paypal-topup:before-status-change', FAULT_INJECT_MODE: 'crash' }) });
    t.eq(child.status, 97, 'tiến trình con thoát với mã 97 (crash giả lập trước commit)');
    t.eq(fakeView().order(r.orderId).status, 'COMPLETED', 'PayPal đã thu tiền trước khi crash');
    t.eq((await requestRow(r.id)).status, 'PENDING', 'sau crash: request vẫn PENDING, không SUCCEEDED dở dang');
    t.eq((await H.credits(db, r.id)).length, 0, 'sau crash: không có bút toán dở dang');
    t.eq(await balance(), before, 'sau crash: số dư không đổi');
    const b = await bindingRow(r.id);
    t.ok(b.capture_claim && b.capture_post_sent_at && b.capture_state === 'IN_FLIGHT',
      'sau crash: bằng chứng còn IN_FLIGHT với dấu đã POST (chưa ai xác nhận)');
    const restarted = makeRuntime();
    t.eq((await restarted.capture(r.id, buyer.id)).outcome, 'BUSY',
      'khởi động lại trong lúc lease còn hạn: capture trả BUSY, không POST lần hai');
    t.eq(fakeView().countCalls('capture', r.orderId), 1, 'vẫn đúng một lệnh thu ở PayPal');
    t.eq((await restarted.reconcileOne(r.id)).outcome, 'APPLIED', 'đối soát sau khởi động: tất toán đúng một lần');
    t.eq((await H.credits(db, r.id)).length, 1, 'đúng một bút toán');
    t.eq(await balance(), before + 21000, 'ví tăng đúng một lần');
    t.eq((await restarted.reconcileOne(r.id)).outcome, 'DUPLICATE', 'đối soát lần nữa: DUPLICATE, không cộng thêm');
    t.eq(await balance(), before + 21000, 'vẫn đúng một lần sau đối soát lặp');
  }

  t.section('R2 — tiến trình con crash sau khi ghi bút toán, trước commit (điểm thứ nhất)');
  {
    const r = await newApproved(22000);
    const before = await balance();
    const child = spawnSync(process.execPath, [CHILD], { cwd: H.ROOT, encoding: 'utf8', timeout: 60000,
      env: childEnv({ PPM2_REQUEST: r.id, PPM2_USER: buyer.id, FAULT_INJECT: 'paypal-topup:after-wallet-update', FAULT_INJECT_MODE: 'crash' }) });
    t.eq(child.status, 97, 'tiến trình con thoát với mã 97');
    t.eq((await H.credits(db, r.id)).length, 0, 'bút toán đã ghi trước crash bị rollback');
    t.eq(await balance(), before, 'số dư không đổi sau crash');
    t.eq((await makeRuntime().reconcileOne(r.id)).outcome, 'APPLIED', 'đối soát sau crash: tất toán đúng một lần');
    t.eq(await balance(), before + 22000, 'ví tăng đúng một lần sau phục hồi');
  }

  t.section('R3 — tiến trình con bị giết khi POST đang treo; khởi động lại; lệnh treo hoàn tất muộn');
  {
    const r = await newApproved(23000);
    const before = await balance();
    const child = spawn(process.execPath, [CHILD], { cwd: H.ROOT, stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv({ PPM2_REQUEST: r.id, PPM2_USER: buyer.id, PPM2_PLAN: 'hold', PPM2_TIMEOUT_MS: '5000', PPM2_LEASE_MS: '30000' }) });
    child.stdout.on('data',chunk=>console.log('[observe-child-stdout] '+String(chunk).trim()));
    child.stderr.on('data',chunk=>console.log('[observe-child-stderr] '+String(chunk).trim()));
    child.on('exit',(code,signal)=>console.log('[observe-child-exit] '+code+' '+signal));
    await waitForPendingPost(child,async () => fakeView().pendingEffects().length >= 1 && Boolean((await bindingRow(r.id))?.capture_post_sent_at));
    const orphan = fakeView().pendingEffects()[0];
    await killAndWait(child);
    t.ok(fakeView().pendingEffects().includes(orphan), 'lệnh treo còn trong trạng thái bền sau khi tiến trình chết (fake sống qua restart)');
    t.eq(fakeView().order(r.orderId).status, 'APPROVED', 'PayPal chưa thu khi lệnh treo còn treo');
    const restarted = makeRuntime(cfgLong);
    t.eq((await restarted.capture(r.id, buyer.id)).outcome, 'BUSY', 'khởi động lại khi lease cũ còn hạn: BUSY, không POST');
    t.eq(fakeView().countCalls('capture', r.orderId), 1, 'chỉ lệnh treo của tiến trình cũ');
    await expireLease(r.id);
    const winner = await restarted.capture(r.id, buyer.id);
    t.eq(winner.outcome, 'APPLIED', 'sau khi lease hết hạn: tiến trình mới thu và tất toán');
    t.eq(fakeView().countCalls('capture', r.orderId), 2, 'hai lệnh thu ở phía PayPal (cũ treo, mới)');
    fakeView().completeEffect(orphan);
    t.eq(fakeView().order(r.orderId).status, 'COMPLETED', 'lệnh cũ hoàn tất muộn không làm đổi trạng thái đã thu');
    t.eq((await H.credits(db, r.id)).length, 1, 'đúng một bút toán dù lệnh cũ hoàn tất muộn');
    t.eq(await balance(), before + 23000, 'ví tăng đúng một lần');
  }

  t.section('R4 — tiến trình con bị giết khi POST treo; lệnh treo hoàn tất; khởi động lại chỉ đối soát (GET)');
  {
    const r = await newApproved(24000);
    const before = await balance();
    const child = spawn(process.execPath, [CHILD], { cwd: H.ROOT, stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv({ PPM2_REQUEST: r.id, PPM2_USER: buyer.id, PPM2_PLAN: 'hold', PPM2_TIMEOUT_MS: '5000', PPM2_LEASE_MS: '30000' }) });
    child.stdout.on('data',chunk=>console.log('[observe-child-stdout] '+String(chunk).trim()));
    child.stderr.on('data',chunk=>console.log('[observe-child-stderr] '+String(chunk).trim()));
    child.on('exit',(code,signal)=>console.log('[observe-child-exit] '+code+' '+signal));
    await waitForPendingPost(child,async () => fakeView().pendingEffects().length >= 1 && Boolean((await bindingRow(r.id))?.capture_post_sent_at));
    const orphan = fakeView().pendingEffects()[0];
    await killAndWait(child);
    fakeView().completeEffect(orphan);
    t.eq(fakeView().order(r.orderId).status, 'COMPLETED', 'PayPal đã thu theo lệnh treo hoàn tất');
    const restarted = makeRuntime();
    const posts = fakeView().countCalls('capture', r.orderId);
    t.eq((await restarted.reconcileOne(r.id)).outcome, 'APPLIED', 'khởi động lại: đối soát bằng GET tất toán một lần');
    t.eq(fakeView().countCalls('capture', r.orderId), posts, 'đối soát không gửi lệnh thu nào');
    t.eq((await H.credits(db, r.id)).length, 1, 'đúng một bút toán');
    t.eq(await balance(), before + 24000, 'ví tăng đúng một lần');
  }

  t.section('Bất biến sau các sự cố');
  const inv = await H.invariantSummary(db);
  t.ok(inv.paypalOk, 'ba bất biến PayPal đúng sau mọi sự cố');
  t.ok(inv.coreOk, `chín bất biến cũ đúng (đã kiểm ${inv.coreChecked})`, JSON.stringify(inv.coreViolations).slice(0, 300));

  const { fail } = t.summary();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e.stack); process.exit(1); });
