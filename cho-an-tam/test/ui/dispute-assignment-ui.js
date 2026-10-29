'use strict';
// Actual SPA with fake API. Authorization is verified separately through real HTTP.
const assert=require('node:assert/strict');
const {wallet,json,BUYER,sleep}=require('./paypal-wallet-ui');
const admin={...BUYER,id:'assignment-admin',role:'ADMIN'};
let checks=0;
const ok=(value,message)=>{assert.ok(value,message);checks++;console.log('PASS '+message);};
async function main(){
  const now=new Date().toISOString();
  const cases=[null,admin.id,'another-admin'].map((owner,i)=>({
    id:'assignment-case-'+i,caseCode:'A'+(i+1),type:'DAMAGED_GOODS',categoryCode:'A',status:'OPEN',adminId:owner,
    reason:'Sản phẩm mẫu có lỗi cần kiểm tra.',openedBy:'BUYER',createdAt:now,transactionId:'assignment-order-'+i,
    transaction:{id:'assignment-order-'+i,itemName:'Sản phẩm mẫu '+i,buyerId:'sample-buyer',sellerId:'sample-seller',amount:60000,status:'DISPUTED',escrowStatus:'FROZEN'},
  }));
  const p=await wallet({user:admin,hash:'#/admin/disputes',extra:{'GET /api/admin/disputes':()=>json(200,{disputes:cases})}});
  try{
    for(const i of [0,1]){
      ok(!!p.d.querySelector('[data-act="admin-refund"][data-id="assignment-case-'+i+'"]'),'eligible case offers refund: '+i);
      ok(!!p.d.querySelector('[data-act="admin-release"][data-id="assignment-case-'+i+'"]'),'eligible case offers release: '+i);
      ok(!!p.d.querySelector('[data-act="admin-claim-dispute"][data-id="assignment-case-'+i+'"]'),'eligible case offers claim/detail: '+i);
    }
    for(const action of ['admin-refund','admin-release','admin-claim-dispute'])ok(!p.d.querySelector('[data-act="'+action+'"][data-id="assignment-case-2"]'),'another administrator\'s case does not offer '+action);
    ok(p.viewText().includes('Hồ sơ đang do quản trị viên khác phụ trách'),'ownership restriction has a plain-language explanation');
    const open=p.d.querySelector('[data-act="admin-refund"][data-id="assignment-case-0"]');p.click(open);await sleep(70);
    p.w.SimpleWebAuthnBrowser.startAuthentication=async()=>{throw new Error('must not reach device');};
    p.routes['POST /api/admin/disputes/assignment-case-0/reauth/options']=()=>json(409,{error:'DISPUTE_ASSIGNED'});
    p.click(p.d.querySelector('[data-act="admin-confirm"]'));await sleep(90);
    ok(p.d.querySelector('.operation-error')?.textContent.includes('quản trị viên khác phụ trách'),'late assignment is explained inside the pending review');
    ok(!p.d.querySelector('[data-dialog-purpose="result"]')&&!p.toasts().length,'late assignment never creates a payment success or overlapping toast');
    ok(p.count('POST /api/admin/disputes/assignment-case-0/refund')===0,'late assignment blocks the settlement call before device verification');
  }finally{p.close();}
  console.log(`DISPUTE ASSIGNMENT UI: ${checks} checks passed (JSDOM + fake API only)`);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
