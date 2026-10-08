'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createDurableFake}=require('./helpers/paypal-m2-fake');
for(const code of ['EPERM','EACCES','EBUSY']) test('empty fake lock retries transient '+code,()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'enclave-fake-sharing-'));
  const state=path.join(dir,'state.json'),lock=state+'.lock';
  fs.mkdirSync(lock);
  const rename=fs.renameSync,rmdir=fs.rmdirSync;
  let renamed=false,injected=false,removals=0;
  fs.renameSync=(from,to)=>{
    if(to===lock&&!renamed){renamed=true;throw Object.assign(Error('controlled contention'),{code:'EEXIST'});}
    return rename(from,to);
  };
  fs.rmdirSync=target=>{
    if(target===lock){removals++;if(!injected){injected=true;throw Object.assign(Error('controlled sharing'),{code});}}
    return rmdir(target);
  };
  try {assert.equal(createDurableFake({statePath:state}).orderCount(),0);assert.equal(injected,true);assert.ok(removals>=2);assert.equal(fs.existsSync(lock),false);}
  finally {
    fs.renameSync=rename;fs.rmdirSync=rmdir;
    for(const name of fs.readdirSync(dir)){
      const target=path.join(dir,name);
      if(fs.statSync(target).isDirectory()){for(const entry of fs.readdirSync(target))fs.unlinkSync(path.join(target,entry));fs.rmdirSync(target);}else fs.unlinkSync(target);
    }
    fs.rmdirSync(dir);
  }
});
