'use strict';
// Tool regression with synthetic responses; never sends HTTP to production.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { run } = require('../scripts/experiments/S2-Enclave.cjs');
const { decode } = require('../scripts/experiments/s2-live-client.cjs');
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const grant='fixture-release-grant-only',token='fixture-session-token-only';
function payload(fields={}) {return {version:'ENCLAVE-S2-1',apiOrigin:'https://api.enclave.id.vn',webOrigin:'https://enclave.id.vn',orderA:A,orderB:B,
  releaseGrant:grant,accessToken:token,expiresAt:new Date(Date.now()+120000).toISOString(),
  assertionReplay:{reauthSessionId:A,response:{response:{signature:'fixture-signature'}}},...fields};}
const packet=data=>'ENCLAVE-S2:'+Buffer.from(JSON.stringify(data)).toString('base64');
function backend(mode={}) {
  const calls=[];let released=false,key=null,balance=1000000;
  async function transport(access,route,body){
    assert.equal(access,token);calls.push({route,body});
    const ok=data=>({status:200,data});
    if(mode.unauthenticated)return {status:401,data:{error:'UNAUTHENTICATED'}};
    if(route==='/users/me')return ok({user:{id:'buyer'}});
    if(route==='/wallets/me')return ok({id:'wallet',availableBalance:balance,lockedBalance:0,version:5});
    if(route.endsWith('/logs'))return ok({logs:released?[{action:'ESCROW_RELEASED'}]:[]});
    if(body===undefined){const id=route.split('/').at(-1),done=released&&id===A;return ok({id,buyerId:mode.otherBuyer?'other':'buyer',sellerId:'seller',amount:id===A?50000:60000,status:done?'COMPLETED':'WAIT_CONFIRM',escrowStatus:done?'RELEASED':'LOCKED',version:done?9:8,inspectedAt:'fixture-inspected',integrityHold:null});}
    if(route.endsWith('/reauth/verify'))return {status:400,data:{error:'CHALLENGE_REPLAY'}};
    if(route===`/transactions/${B}/release`){if(mode.changeWallet)balance--;return {status:mode.notFound?404:mode.acceptWrong?200:401,data:mode.acceptWrong?{}:{error:mode.notFound?'NOT_FOUND':'REAUTH_REQUIRED'}};}
    assert.equal(route,`/transactions/${A}/release`);
    if(!released){released=true;key=body.requestId;return ok({});}
    return key===body.requestId?ok({}):{status:409,data:{error:'INVALID_STATE'}};
  }
  return {transport,calls};
}
test('S2 script: correct sequence, same-id idempotency and sanitized result',async()=>{
  const fake=backend(),result=await run(packet(payload()),fake.transport);
  assert.equal(result.complete,true);assert.equal(result.steps.length,6);
  const releases=fake.calls.filter(x=>x.route.endsWith('/release'));
  assert.equal(releases.length,4);assert.equal(releases[1].body.requestId,releases[2].body.requestId);assert.notEqual(releases[2].body.requestId,releases[3].body.requestId);
  for(const secret of [grant,token,'fixture-signature'])assert.equal(JSON.stringify(result).includes(secret),false);
  assert.equal(result.target,'https://api.enclave.id.vn');
});
test('Expired/malformed/wrong-origin packages stop before transport',async()=>{
  for(const fields of [{apiOrigin:'https://other.test'},{orderB:A},{expiresAt:'bad-date'},{expiresAt:new Date(Date.now()-1000).toISOString()}]){
    const fake=backend();await assert.rejects(run(packet(payload(fields)),fake.transport));assert.equal(fake.calls.length,0);
  }
  assert.throws(()=>decode('not-a-package'));
});
test('A failed session preflight never sends attack requests',async()=>{
  const fake=backend({unauthenticated:true});await assert.rejects(run(packet(payload()),fake.transport),/UNAUTHENTICATED/);assert.equal(fake.calls.length,1);
});
test('Wrong ownership blocks all mutation requests',async()=>{
  const fake=backend({otherBuyer:true});await assert.rejects(run(packet(payload()),fake.transport));assert.equal(fake.calls.filter(c=>c.body!==undefined).length,0);
});
for(const mode of [{notFound:true},{acceptWrong:true},{changeWallet:true}])test('Unexpected backend behavior is not reported as success: '+JSON.stringify(mode),async()=>{
  const fake=backend(mode);await assert.rejects(run(packet(payload()),fake.transport));
  assert.equal(fake.calls.some(c=>c.route===`/transactions/${A}/release`),false);
});
