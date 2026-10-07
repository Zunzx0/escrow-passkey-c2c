'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createLock, selectSpecs, makeT } = require('./paypal-wallet-browser');
const h = require('./paypal/harness');
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enclave-lock-unit-'));
  t.after(() => {
    for (const name of fs.readdirSync(dir)) {
      const entry = path.join(dir, name);
      if (fs.statSync(entry).isDirectory()) { for (const f of fs.readdirSync(entry)) fs.unlinkSync(path.join(entry, f)); fs.rmdirSync(entry); }
      else fs.unlinkSync(entry);
    }
    fs.rmdirSync(dir);
  });
  return path.join(dir, 'lock');
}
test('waiting runner cannot release another live owner; abort leaves lock intact', async t => {
  const lockPath = temp(t), holder = createLock(lockPath), waiter = createLock(lockPath);
  await holder.acquire();
  const original = fs.readdirSync(lockPath);
  const abort = new AbortController();
  const pending = waiter.acquire({signal:abort.signal});
  assert.equal(waiter.release(),false);
  abort.abort();
  await assert.rejects(pending,/cancelled/);
  assert.deepEqual(fs.readdirSync(lockPath),original);
  holder.release();
  assert.equal(fs.existsSync(lockPath),false);
});
test('two stale contenders fail without deleting any stale owner', async t => {
  const lockPath=temp(t); fs.mkdirSync(lockPath);
  const owner='owner-'+ 'a'.repeat(32)+'.json';
  fs.writeFileSync(path.join(lockPath,owner),JSON.stringify({pid:2147483647}));
  const a=createLock(lockPath,{isAlive:()=>false}),b=createLock(lockPath,{isAlive:()=>false});
  const outcomes=await Promise.allSettled([a.acquire(),b.acquire()]);
  assert.ok(outcomes.every(r=>r.status==='rejected'&&/Stale/.test(r.reason.message)));
  assert.equal(a.release(),false); assert.equal(b.release(),false);
  assert.deepEqual(fs.readdirSync(lockPath),[owner]);
});
test('former holder never deletes a newly acquired holder',async t=>{
  const lockPath=temp(t), a=createLock(lockPath), b=createLock(lockPath);
  await a.acquire(); a.release(); await b.acquire();
  assert.equal(a.release(),false); assert.equal(fs.readdirSync(lockPath).length,1); b.release();
});
test('empty/unknown groups and missing required specs reject before browser launch',()=>{
  const specs=[{id:'A',file:'a.js'},{id:'B',file:'b.js'}];
  for(const args of [['--only='],['--only=UNKNOWN'],['--only=A,'],['--only=A','--only=B']]) assert.throws(()=>selectSpecs(args,specs,()=>true));
  assert.throws(()=>selectSpecs([],specs,s=>s.id==='A'),/missing/);
  assert.deepEqual(selectSpecs(['--only=B'],specs,()=>true),[specs[1]]);
});
test('cleanup failure counts FAIL and all registered cleanups still run',async()=>{
  const totals={pass:0,fail:0,skip:0,cases:0}, failed=[], skipped=[], order=[];
  await makeT('unit',totals,failed,skipped).case('cleanup fault',async c=>{
    c.ok(true,'initial behavior');
    c.cleanup(async()=>{order.push('last');});
    c.cleanup(async()=>{order.push('error');throw Error('controlled cleanup failure');});
  });
  assert.equal(totals.fail,1); assert.deepEqual(order,['error','last']); assert.deepEqual(failed,['cleanup fault']);
});
test('failed context creation closes the already listening fixture server',async()=>{
  const original=http.Server.prototype.listen; let server;
  http.Server.prototype.listen=function(...args){server=this;return original.apply(this,args);};
  try {
    await assert.rejects(h.openSession({newContext:async()=>{throw Error('context setup failed');}}),/context setup failed/);
    assert.equal(server.listening,false);
  } finally {http.Server.prototype.listen=original;}
});
test('failed page creation closes context and fixture, preserving setup failure',async()=>{
  const original=http.Server.prototype.listen; let server,closed=0;
  http.Server.prototype.listen=function(...args){server=this;return original.apply(this,args);};
  const ctx={on(){},route:async()=>{},newPage:async()=>{throw Error('page setup failed');},close:async()=>{closed++;}};
  try {
    await assert.rejects(h.openSession({newContext:async()=>ctx}),/page setup failed/);
    assert.equal(closed,1); assert.equal(server.listening,false);
  }finally{http.Server.prototype.listen=original;}
});
test('cleanup deadline fails bounded instead of hanging',async()=>{
  await assert.rejects(h.withDeadline(new Promise(()=>{}),20,'test cleanup'),/timed out/);
});
test('context cleanup lasting beyond five seconds completes before setup error is returned',async()=>{
  let closed=false;
  const ctx={on(){},route:async()=>{},newPage:async()=>{throw Error('controlled page failure');},close:async()=>{await new Promise(resolve=>setTimeout(resolve,5200));closed=true;}};
  let failure;
  try {await h.openSession({newContext:async()=>ctx});} catch(error){failure=error;}
  assert.match(failure.message,/controlled page failure/);
  assert.equal(failure.cleanupError,undefined);
  assert.equal(closed,true);
});
