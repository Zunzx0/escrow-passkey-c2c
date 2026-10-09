'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert/strict');
const source = fs.readFileSync(path.join(__dirname, '../../public/js/app.js'), 'utf8');
function fn(name) {
  const start = source.search(new RegExp('(?:async )?function ' + name + '\\('));
  assert.ok(start >= 0, name);
  const end = source.indexOf('\n  }', start);
  return source.slice(start, end + 4);
}
let checks = 0;
function ok(value, message) { assert.ok(value, message); checks++; console.log('PASS ' + message); }
function fixture() {
  let resolve, reject;
  const pending = new Promise((a,b) => {resolve=a;reject=b;});
  const state = {token:'old',user:{id:'old',accountStatus:'ACTIVE'},sessionEpoch:0};
  const context = vm.createContext({state, document:{addEventListener(){},visibilityState:'visible'},window:{addEventListener(){}},location:{},localStorage:{setItem(){}},STORAGE_USER:'user',
    $:()=>null,onDocumentClick(){},dismissModal(){},route:async()=>{},refreshSession(){},currentHead(){},resumePaypalAfterBack(){},readPaypalCallbackFromUrl:()=>null,
    setInterval(){},refreshSellerRequest:async()=>{},refreshUnread:async()=>{},renderChrome(){},openSetupModal(){context.setup=true;},
    api:()=>pending,clearSession(){state.token=null;state.user=null;state.sessionEpoch++;},
  });
  vm.runInContext(fn('init'),context);
  return {state,context,resolve,reject,run:()=>vm.runInContext('init()',context)};
}
(async()=>{
  for (const outcome of ['reject','resolve']) {
    const p=fixture(); const running=p.run();
    p.state.sessionEpoch++; p.state.token='new-enroll';p.state.user={id:'new',accountStatus:'PENDING_PASSKEY'};
    if(outcome==='reject') p.reject(Object.assign(new Error('old'),{silent:true,stale:true}));
    else p.resolve({user:{id:'old',accountStatus:'ACTIVE'},wallet:{owner:'old'}});
    await running;
    ok(p.state.token==='new-enroll','Late startup '+outcome+' preserves enrollment token');
    ok(p.state.user.id==='new','Late startup '+outcome+' preserves new account');
  }
  const restored=fixture();const restoring=restored.run();
  restored.resolve({user:{id:'old',accountStatus:'PENDING_PASSKEY'},wallet:null});await restoring;
  ok(restored.context.setup,'Reload restores pending Passkey setup');
  const offline=fixture();const loading=offline.run();offline.reject(Object.assign(new Error('offline'),{code:'NETWORK_ERROR'}));await loading;
  ok(offline.state.token==='old','Network failure does not erase session');
  const context=vm.createContext({state:{token:null,user:null},openAuthModal(){context.login=true;},toast(){},guard(){throw new Error('Enrollment must not call API without a session');}});
  vm.runInContext(fn('doEnrollPasskey'),context);await vm.runInContext('doEnrollPasskey(null)',context);
  ok(context.login,'Missing enrollment session opens sign-in instead of protected API');
  let sent;
  const sessionApi=vm.createContext({state:{sessionEpoch:0,token:'enroll-token'},API_BASE:'https://api.enclave.id.vn',fetchJson:async(url,options)=>{sent=options;return {res:{ok:true,status:200},data:{ok:true}};}});
  vm.runInContext(fn('api'),sessionApi);
  for (const endpoint of ['/passkeys/register/account','/passkeys/login/password','/passkeys/register/passkey/options']) {
    await vm.runInContext('api('+JSON.stringify(endpoint)+', {method:"POST",body:{}})',sessionApi);
    ok(sent.credentials==='include','Refresh cookie is accepted for '+endpoint);
    ok(sent.headers.Authorization==='Bearer enroll-token','Bearer remains required for '+endpoint);
  }
  console.log(checks+' checks passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
