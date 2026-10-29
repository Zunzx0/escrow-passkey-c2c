'use strict';
// UI-polish integration contracts: CSSOM + real app DOM with fake fetch.
// This is not proof of rendered desktop/mobile layout, font appearance or actual iOS behavior.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {JSDOM}=require('jsdom');
const {wallet,sleep,json}=require('./paypal-wallet-ui');
const PUBLIC=path.resolve(__dirname,'../../public');
let checks=0;
const ok=(condition,label)=>{assert.ok(condition,label);checks++;console.log('PASS '+label);};
async function until(fn,ms=2000){const end=Date.now()+ms;while(Date.now()<end){if(fn())return true;await sleep(15);}return !!fn();}

async function main(){
  const css=fs.readFileSync(path.join(PUBLIC,'css/style.css'),'utf8');
  const html=fs.readFileSync(path.join(PUBLIC,'index.html'),'utf8');
  const styleDOM=new JSDOM('<!doctype html><head></head><body></body>');
  try{
    const style=styleDOM.window.document.createElement('style');style.textContent=css;styleDOM.window.document.head.appendChild(style);
    const rules=[...style.sheet.cssRules];
    const rule=selector=>rules.find(entry=>entry.selectorText===selector);
    ok(rules.length>400,'merged stylesheet parses as CSSOM with existing application selectors');
    ok(rule(':root').style.getPropertyValue('--font').includes('Manrope'),'local Manrope is the primary font with system fallback');
    // JSDOM's font-face parser drops descriptors following a valid variable-weight range.
    // Assert those descriptors from the actual stylesheet, and verify the binary files below.
    const faces=[...css.matchAll(/@font-face\s*\{([^}]+)\}/g)].map(match=>match[1]);
    ok(rules.filter(entry=>entry.type===5).length===3&&faces.length===3&&faces.every(face=>/font-display:\s*swap\s*;/.test(face)),'all three local font subsets use font-display swap');
    ok(faces.every(face=>/src:\s*url\(\.\.\/fonts\/[a-z-]+\.woff2\)/.test(face)),'font-face URLs stay on the application origin');
    const expectedFonts={
      'manrope-vietnamese.woff2':'6bbb044ab420e07edb0a3042d2eb314b85e83a0182e945a15ab3b9092668dfd5',
      'manrope-latin.woff2':'a30ddcd349703aff7464c34bef3fffdff405ee50c113440d7c8693c02d210972',
      'manrope-latin-ext.woff2':'3911b66d9f2e005a4b989223405d0e5032619c668597ba467cc76a23c8fffcfb',
    };
    for(const [name,hash] of Object.entries(expectedFonts)){
      const data=fs.readFileSync(path.join(PUBLIC,'fonts',name));
      ok(data.toString('ascii',0,4)==='wOF2'&&crypto.createHash('sha256').update(data).digest('hex')===hash,'font bytes preserved from Claude UI: '+name);
    }
    const license=fs.readFileSync(path.join(PUBLIC,'fonts/OFL.txt'));
    ok(crypto.createHash('sha256').update(license).digest('hex')==='d826ab6583b12c26807d8716a545bdbbb672df04f48608a364ba9efdbe501c30'&&license.toString().includes('Copyright 2019 The Manrope Project Authors'),'original Manrope copyright and SIL OFL are preserved byte-for-byte');
    const index=new JSDOM(html);
    try{
      const preloads=[...index.window.document.querySelectorAll('link[rel="preload"][as="font"]')];
      ok(preloads.length===2&&preloads.every(link=>link.getAttribute('href').startsWith('fonts/')&&link.hasAttribute('crossorigin')),'only local Vietnamese and Latin font files are preloaded');
      ok(index.window.document.querySelector('meta[name="viewport"]').content==='width=device-width, initial-scale=1.0','viewport still allows user zoom');
    }finally{index.window.close();}
    ok(rule('.modal-backdrop').style.display==='flex'&&rule('.modal').style.getPropertyValue('margin-block')==='auto','short dialogs retain centered auto margins and tall-dialog scrolling');
    ok(rule('.modal-backdrop').style.getPropertyValue('overflow-y')==='auto'&&rule('.modal').style.getPropertyValue('flex-shrink')==='0','long dialogs can reach their heading and final action');
    ok(rule('#toasts').style.top.includes('--topbar-h')&&rule('#toasts').style.right==='var(--s-4)'&&rule('#toasts').style.transform==='none','brief notifications sit below the header at the right; dialogs remain centered');
    ok(!css.includes('modal-leaving')&&!css.includes('tấm trượt từ đáy'),'no copied-form exit ghost or bottom-sheet override is integrated');
    const coarse=rules.find(entry=>entry.conditionText==='(max-width: 860px), (any-pointer: coarse)');
    ok(coarse&&[...coarse.cssRules].some(entry=>entry.selectorText==='input, select, textarea'&&entry.style.getPropertyValue('font-size')==='max(16px, 1em)'),'the existing mobile input size protection survives the CSS merge');
    ok(rule('.field-error')&&rule('.order-shipping-form')&&rule('.media-picker')&&rule('.media-preview:disabled'),'address errors and photo-upload states survive typography changes');
    const reduced=rules.filter(entry=>entry.conditionText==='(prefers-reduced-motion: reduce)');
    ok(reduced.some(entry=>[...entry.cssRules].some(item=>item.selectorText?.includes('.modal-backdrop, .modal, .toast')&&item.style.getPropertyValue('animation')==='none'&&item.style.getPropertyPriority('animation')==='important')),'reduced-motion rules suppress page, modal and toast entrance animations');
    ok(reduced.some(entry=>[...entry.cssRules].some(item=>item.selectorText?.includes('a.pcard:hover')&&item.style.getPropertyValue('transform')==='none')),'reduced-motion rules also suppress card and button hover/press movement');
    ok(reduced.some(entry=>[...entry.cssRules].some(item=>item.selectorText?.includes('.icon-btn:active')&&item.style.getPropertyValue('transform')==='none'&&item.style.getPropertyPriority('transform')==='important')),'reduced-motion suppresses icon-button press scaling');
    ok(reduced.some(entry=>[...entry.cssRules].some(item=>item.selectorText?.includes('.cat:hover .ico-box')&&item.style.getPropertyValue('transform')==='none'&&item.style.getPropertyPriority('transform')==='important')),'reduced-motion suppresses category-icon hover movement');
  }finally{styleDOM.window.close();}

  let p=await wallet({timeoutMs:2000,create:()=>json(400,{error:'INVALID_AMOUNT'})});
  try{
    p.amountInput().value='100000';p.click(p.btn());await sleep(70);
    const first=p.d.querySelector('#toasts .toast');
    ok(first?.getAttribute('role')==='alert'&&first.className==='toast err','error toast keeps its existing kind and announces an alert');
    ok(first.querySelector('.toast-x')?.getAttribute('aria-label')==='Đóng thông báo','toast has a keyboard-focusable close button with an accessible name');
    p.click(p.btn());await sleep(70);const second=p.d.querySelectorAll('#toasts .toast')[1];
    p.click(first.querySelector('.toast-x'));p.click(first.querySelector('.toast-x'));
    ok(first.hasAttribute('data-leaving')&&first.isConnected,'closing a normal-motion toast starts one short exit');
    await sleep(240);
    ok(!first.isConnected&&second.isConnected,'double close removes only its own toast and leaves the next notification');
    p.w.matchMedia=media=>({matches:media==='(prefers-reduced-motion: reduce)',media});
    p.click(second.querySelector('.toast-x'));
    ok(!second.isConnected,'reduced-motion closes a toast immediately without a timed animation');
    p.w.location.hash='#/orders';await until(()=>/Giao dịch/.test(p.d.getElementById('view').textContent));await sleep(50);
    ok(!p.d.getElementById('view').hasAttribute('data-enter'),'reduced-motion navigation never starts the page entrance animation');
    p.w.matchMedia=media=>({matches:false,media});p.w.location.hash='#/';
    ok(await until(()=>p.d.getElementById('view').hasAttribute('data-enter')),'new-route navigation starts the normal page entrance');
    await sleep(1250);
    ok(!p.d.getElementById('view').hasAttribute('data-enter'),'page animation marker is removed after the entrance');
    p.click(p.d.querySelector('[data-act="go-home"]'));await sleep(120);
    ok(!p.d.getElementById('view').hasAttribute('data-enter'),'same-route redraw does not animate the whole page again');
  }finally{p.close();}

  const seller={id:'polish-seller',username:'seller',displayName:'Người bán',role:'SELLER',accountStatus:'ACTIVE'};
  p=await wallet({user:seller,hash:'#/shop',extra:{'GET /api/listings':()=>json(200,{listings:[]})}});
  try{
    const revoked=[];p.w.URL.createObjectURL=()=> 'blob:http://localhost:3999/polish-private-preview';p.w.URL.revokeObjectURL=url=>revoked.push(url);
    let shadowCalls=0;const attach=p.w.HTMLElement.prototype.attachShadow;
    p.w.HTMLElement.prototype.attachShadow=function(...args){shadowCalls++;return attach.apply(this,args);};
    p.click(p.d.querySelector('[data-act="new-listing"]'));
    const title=p.d.getElementById('lsTitle');title.value='Nội dung riêng tư không giữ trong ghost';
    const input=p.d.getElementById('mediaFiles');
    Object.defineProperty(input,'files',{configurable:true,value:[new p.w.File(['abcd'],'private.jpg',{type:'image/jpeg'})]});
    input.dispatchEvent(new p.w.Event('change',{bubbles:true}));
    const preview=p.d.querySelector('.media-preview img');
    ok(preview?.src.includes('polish-private-preview'),'cleanup scenario has a real selected-file preview before dismissal');
    p.d.dispatchEvent(new p.w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
    ok(!!p.d.querySelector('.media-discard')&&title.isConnected,'unsaved photo dismissal still requires an explicit confirmation');
    p.click(p.d.querySelector('[data-act="media-discard-confirm"]'));
    ok(!title.isConnected&&!preview.isConnected&&p.d.getElementById('modalRoot').innerHTML==='','confirmed close detaches the form and preview immediately');
    ok(revoked.includes('blob:http://localhost:3999/polish-private-preview'),'closing releases the selected photo URL immediately');
    ok(shadowCalls===0&&!p.d.querySelector('.modal-leaving'),'no closed shadow retains the form or its private photo after close');
    ok(p.d.body.style.position!=='fixed','final modal close still unlocks document scrolling');
    p.click(p.d.querySelector('[data-act="new-listing"]'));
    ok(p.d.getElementById('lsTitle').value===''&&!p.d.querySelector('.media-selected'),'opening a new form starts without prior text or photos');
  }finally{p.close();}
  console.log(`UI POLISH: ${checks} checks passed (CSSOM + JSDOM + fake API only)`);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
