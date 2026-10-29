'use strict';
// Real SPA with fake API/authenticator. No production account, database or money.
const assert=require('node:assert/strict');
const {wallet,json,sleep,BUYER}=require('./paypal-wallet-ui');
const motion=require('../../public/js/shipping-motion');
const fs=require('node:fs');
const path=require('node:path');
let checks=0;
const ok=(value,message)=>{assert.ok(value,message);checks++;console.log('PASS '+message);};
const base=()=>({id:'retry-order',buyerId:BUYER.id,sellerId:'retry-seller',sellerName:'Người bán',itemName:'Sản phẩm thử',amount:60000,status:'CREATED',escrowStatus:'NONE',version:0,createdAt:new Date().toISOString()});
async function click(p,act,ms=90){const button=p.d.querySelector('[data-act="'+act+'"]');assert.ok(button,act);p.click(button);await sleep(ms);}
async function page(getRow,routes){return wallet({hash:'#/tx/retry-order',timeoutMs:1500,extra:{
 'GET /api/transactions':()=>json(200,{transactions:[getRow()]}),
 'GET /api/transactions/retry-order':()=>json(200,getRow()),
 'GET /api/transactions/retry-order/logs':()=>json(200,{logs:[]}),
 'GET /api/notifications/todo':()=>json(200,{items:[]}),...routes,
}});}
async function main(){
 let row=base(),options=0,verifications=0,nativeCalls=0;
 let p=await page(()=>row,{
  'POST /api/transactions/retry-order/reauth/options':()=>json(200,{reauthSessionId:'context-'+(++options),options:{},context:{...row}}),
  'POST /api/transactions/retry-order/reauth/verify':()=>{verifications++;if(verifications===1){row={...row,amount:70000,version:1};return json(409,{error:'CONTEXT_MISMATCH',message:'Nội dung đã thay đổi. Hãy xem lại.'});}return json(200,{reauthGrant:'fresh-grant'});},
  'POST /api/transactions/retry-order/secure':()=>{row={...row,status:'SECURED',escrowStatus:'LOCKED',version:2};return json(200,row);},
 });
 try{
  p.w.SimpleWebAuthnBrowser.startAuthentication=async()=>{nativeCalls++;return{id:'test-key'};};
  await click(p,'secure');
  const review = p.d.getElementById('modalRoot').textContent;
  ok(review.includes('Người bán:') && review.includes('Số tiền Enclave sẽ giữ') && review.includes('Người bán chưa nhận được tiền.'),'payment review separates the seller identity from money held by Enclave');
  await click(p,'secure-confirm');
  ok(nativeCalls===1&&p.count('POST /api/transactions/retry-order/secure')===0,'context mismatch never submits the stale payment');
  ok(/Kiểm tra lại trạng thái/.test(p.d.getElementById('modalRoot').textContent),'context mismatch offers canonical-state checking instead of reusing the old challenge');
  await click(p,'secure-confirm');
  ok(options===2&&nativeCalls===1,'retry refreshes context and requires another review tap before Passkey');
  ok(/70.000/.test(p.d.getElementById('modalRoot').textContent),'refreshed review shows the new server amount');
  await click(p,'secure-confirm',170);
  ok(p.bodies['POST /api/transactions/retry-order/reauth/verify'][1].reauthSessionId==='context-2','second ceremony uses the newly prepared session');
  ok(p.count('POST /api/transactions/retry-order/secure')===1&&nativeCalls===2,'only the reviewed new context reaches payment');
 }finally{p.close();}

 row=base();nativeCalls=0;
 p=await page(()=>row,{
  'POST /api/transactions/retry-order/reauth/options':()=>json(200,{reauthSessionId:'lost-result',options:{},context:row}),
  'POST /api/transactions/retry-order/reauth/verify':()=>json(200,{reauthGrant:'lost-grant'}),
  'POST /api/transactions/retry-order/secure':()=>{row={...row,status:'SECURED',escrowStatus:'LOCKED',version:1};return Promise.reject(new Error('response lost after commit'));},
 });
 try{
  p.w.SimpleWebAuthnBrowser.startAuthentication=async()=>{nativeCalls++;return{id:'test-key'};};
  await click(p,'secure');await click(p,'secure-confirm',180);
  ok(/Đã thanh toán — tiền đang được giữ an toàn/.test(p.d.getElementById('modalRoot').textContent),'lost payment response is reconciled from canonical server state');
  ok(nativeCalls===1&&p.count('POST /api/transactions/retry-order/secure')===1,'confirmed committed payment never invokes another ceremony or payment');
  ok(!p.d.querySelector('#view [data-act="secure"]'),'reconciled secured order no longer offers payment');
 }finally{p.close();}

 row=base();nativeCalls=0;let readable=true;
 p=await page(()=>row,{
  'GET /api/transactions/retry-order':()=>readable?json(200,row):Promise.reject(new Error('temporarily offline')),
  'POST /api/transactions/retry-order/reauth/options':()=>json(200,{reauthSessionId:'uncertain',options:{},context:row}),
  'POST /api/transactions/retry-order/reauth/verify':()=>json(200,{reauthGrant:'uncertain-grant'}),
  'POST /api/transactions/retry-order/secure':()=>{row={...row,status:'SECURED',escrowStatus:'LOCKED',version:1};readable=false;return Promise.reject(new Error('lost response'));},
 });
 try{
  p.w.SimpleWebAuthnBrowser.startAuthentication=async()=>{nativeCalls++;return{id:'test-key'};};
  await click(p,'secure');await click(p,'secure-confirm',140);
  ok(/Kiểm tra lại trạng thái/.test(p.d.getElementById('modalRoot').textContent),'unreadable payment outcome stays unresolved with a check action');
  await click(p,'secure-confirm',100);
  ok(nativeCalls===1&&p.count('POST /api/transactions/retry-order/reauth/options')===1&&p.count('POST /api/transactions/retry-order/secure')===1,'retry while canonical state is unavailable cannot issue a new Passkey challenge or charge');
  readable=true;await click(p,'secure-confirm',150);
  ok(/Đã thanh toán — tiền đang được giữ an toàn/.test(p.d.getElementById('modalRoot').textContent)&&nativeCalls===1,'restored canonical read resolves success without a second Passkey ceremony');
 }finally{p.close();}

 const at=new Date().toISOString(),system={...base(),status:'WAIT_CONFIRM',escrowStatus:'LOCKED',receivedConfirmedBy:'SYSTEM',receivedConfirmedAt:at,shipment:{id:'motion-system',status:'ARRIVED',packedAt:at,pickedUpAt:at,arrivedAt:at,serverNow:at}};
 ok(motion.snapshot(system).phase==='received_system','shipping motion has a distinct SYSTEM receipt phase');
 ok(!motion.render(system).includes('Người mua đã nhận hàng')&&motion.render(system).includes('Chưa có xác nhận nhận kiện'),'shipping tracking never describes SYSTEM transition as buyer-confirmed receipt');
 ok(motion.snapshot({...system,receivedConfirmedBy:'BUYER'}).phase==='received','actual buyer receipt retains the buyer-confirmed phase');
 // Test-only observation of the shared step model; production source is never edited.
 const originalRead=fs.readFileSync,appPath=path.resolve(__dirname,'../../public/js/app.js');
 fs.readFileSync=function(file,...args){const value=originalRead.call(this,file,...args);if(typeof file==='string'&&path.resolve(file)===appPath&&typeof value==='string')return value.replace('return { init };','window.__reviewStepActions=()=>JSON.stringify(TX_STEPS.map(step=>step.actions)); window.__reviewStepActionsAtBoot=window.__reviewStepActions(); return { init };');return value;};
 try{p=await page(()=>system,{});}finally{fs.readFileSync=originalRead;}
 try{
  p.w.dispatchEvent(new p.w.HashChangeEvent('hashchange'));await sleep(90);
  p.w.dispatchEvent(new p.w.HashChangeEvent('hashchange'));await sleep(90);
  ok(p.w.__reviewStepActions()===p.w.__reviewStepActionsAtBoot,'repeated SYSTEM timeline renders do not mutate the shared action model');
 }finally{p.close();}
 console.log(`ORDER MONEY RETRY UI: ${checks} checks passed (fake API/authenticator only)`);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
