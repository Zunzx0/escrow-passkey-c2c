/** PayPal abandonment UI: jsdom/fake fetch only; no real payment or Passkey evidence. Run with NODE_PATH pointing to existing jsdom. */
const fs = require('fs');
const path = require('path');

let JSDOM;
try {
  ({ JSDOM } = require('jsdom'));
} catch (_) {
  console.error('Thiếu jsdom. Cài bằng: npm i --no-save jsdom (không đổi package.json).');
  process.exit(2);
}

const PUBLIC = path.join(__dirname, '..', '..', 'public');
const ORIGIN = 'http://localhost:3999';
const TIMEOUT_MS = 200;
const INTENT_PREFIX = 'cat_topup_intent:';
const SANDBOX = 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER1';

let fails = 0;
let checks = 0;
const ok = (c, m) => { checks++; console.log(`  ${c ? '✅' : '❌'} ${m}`); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const section = (t) => console.log(`\n${t}`);
const delay = (ms, v) => new Promise((r) => setTimeout(() => r(v), ms));

const BUYER = { id: 'u-buyer', username: 'mua', displayName: 'Mua Thử', role: 'BUYER', accountStatus: 'ACTIVE' };
const OTHER = { id: 'u-other', username: 'khac', displayName: 'Người Khác', role: 'BUYER', accountStatus: 'ACTIVE' };
const WALLET = { availableBalance: 5000000, lockedBalance: 0, pendingTopupTotal: 0 };
const KEY = 'topup-test-key-0001';
const AMOUNT = 100000;

const json = (status, body) => ({ status, body });
const html = (status, text) => ({ status, text, type: 'text/html' });
const HANG = Symbol('hang');

const CFG = (paypal, mock, mode = 'sandbox') => ({ paypalSandbox: { enabled: paypal, mode, rateKind: 'DEMO_FIXED' }, mockPayments: { enabled: mock } });
const quote = (o = {}) => ({
  version: 1, amountVnd: AMOUNT, currency: 'USD', usdCents: 400, usdValue: '4.00', rateVndPerUsd: 25000,
  rateKind: 'DEMO_FIXED', rateLabel: 'Tỷ giá mô phỏng, không phải giá thị trường', ...o,
});
/** Dòng yêu cầu PayPal đúng shape của serializePayPal (hợp đồng §2, §5). */
const ppRow = (o = {}) => ({
  id: '5b1f0c52-7a3e-4c1d-9a55-0f1e2d3c4b5a', amount: AMOUNT, status: 'PENDING', requestId: KEY, providerRef: 'srv-1', provider: 'PAYPAL_SANDBOX',
  submissionStatus: 'SUBMITTED', createdAt: new Date().toISOString(), resolvedAt: null, sandbox: true, stage: 'AWAITING_APPROVAL',
  orderId: 'ORDER1', quote: quote(), approvalUrl: null, ...o,
});
const mockRow = (o = {}) => ({
  id: 'm1', amount: 150000, status: 'SUCCEEDED', providerRef: 'ref-m', provider: 'MOCK', requestId: null, submissionStatus: 'SUBMITTED',
  createdAt: new Date().toISOString(), resolvedAt: new Date().toISOString(), resolvedBy: 'WEBHOOK', ...o,
});
const intentJson = (o = {}) => JSON.stringify({
  userId: BUYER.id, requestId: KEY, amount: AMOUNT, provider: 'PAYPAL_SANDBOX', createdAt: new Date().toISOString(), paymentId: '5b1f0c52-7a3e-4c1d-9a55-0f1e2d3c4b5a', ...o,
});

/**
 * Dựng trang với fetch mock. routes: { 'METHOD /path': (opts, url) => json(...)|html(...)|HANG|Promise }.
 * options: user, hash, search (vd '?paypal=return&paymentRequestId=5b1f0c52-7a3e-4c1d-9a55-0f1e2d3c4b5a'), storage, timeoutMs.
 */
async function openPage({ hash = '#/wallet', search = '', user = BUYER, routes = {}, storage = {}, timeoutMs = TIMEOUT_MS }) {
  const html0 = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8').replace(/<script\b[^>]*\bsrc=[^>]*><\/script>/g, '');
  const log = [];
  const bodies = {};
  const navs = [];
  const pending = new Map();
  const table = { ...routes };
  const dom = new JSDOM(html0, {
    url: `${ORIGIN}/${search}`,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    beforeParse(w) {
      w.ENCLAVE_API_TIMEOUT_MS = timeoutMs;
      w.ENCLAVE_NAVIGATE = (u) => navs.push(u);
      w.scrollTo = () => {};
      const realSet = w.setTimeout.bind(w);
      const realClear = w.clearTimeout.bind(w);
      w.setTimeout = (fn, ms, ...a) => { const id = realSet((...x) => { pending.delete(id); fn(...x); }, ms, ...a); pending.set(id, ms); return id; };
      w.clearTimeout = (id) => { pending.delete(id); realClear(id); };
      for (const [k, v] of Object.entries(storage)) w.localStorage.setItem(k, v);
      w.localStorage.setItem('cat_token', 'tok-' + user.id);
      w.localStorage.setItem('cat_user', JSON.stringify(user));
      w.location.hash = hash;
      w.fetch = (url, opts = {}) => new Promise((resolve, reject) => {
        const u = new URL(url, ORIGIN);
        const key = `${opts.method || 'GET'} ${u.pathname}`;
        log.push(key);
        (bodies[key] = bodies[key] || []).push(opts.body ? JSON.parse(opts.body) : null);
        const abort = () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
        if (opts.signal) {
          if (opts.signal.aborted) return abort();
          opts.signal.addEventListener('abort', abort);
        }
        const handler = table[key];
        const r = handler ? handler(opts, u) : json(404, { error: 'NOT_FOUND', message: 'Không tìm thấy tài nguyên' });
        if (r === HANG) return;
        Promise.resolve(r).then((x) => {
          if (x === HANG) return;
          const body = x.text !== undefined ? x.text : JSON.stringify(x.body);
          resolve(new Response(body, { status: x.status, headers: { 'Content-Type': x.type || 'application/json' } }));
        }, reject);
      });
      w.eval(['config.js', 'icons.js', 'simplewebauthn-browser.js', 'app.js']
        .map((f) => fs.readFileSync(path.join(PUBLIC, 'js', f), 'utf8')).join('\n;\n'));
    },
  });
  await sleep(700);
  const w = dom.window;
  const d = w.document;
  return {
    w, d, log, bodies, navs, routes: table,
    toasts: () => [...d.querySelectorAll('#toasts .toast')].map((t) => ({ kind: t.className.replace('toast', '').trim(), text: t.textContent.trim() })),
    clearToasts: () => { d.querySelector('#toasts').innerHTML = ''; },
    click: (el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true })),
    count: (key) => log.filter((l) => l === key).length,
    store: () => Object.fromEntries(Array.from({ length: w.localStorage.length }, (_, i) => w.localStorage.key(i)).map((k) => [k, w.localStorage.getItem(k)])),
    intentKey: (u = BUYER) => INTENT_PREFIX + u.id,
    intent: (u = BUYER) => JSON.parse(w.localStorage.getItem(INTENT_PREFIX + u.id) || 'null'),
    amountInput: () => d.querySelector('#topupAmount'),
    btn: () => d.querySelector('.card-body [data-act="topup-create"]'),
    notice: () => (d.querySelector('#topupIntent') || { textContent: '' }).textContent.replace(/\s+/g, ' ').trim(),
    noticeBtn: (act) => d.querySelector(`#topupIntent [data-act="${act}"]`),
    viewText: () => (d.querySelector('#view') || { textContent: '' }).textContent.replace(/\s+/g, ' ').trim(),
    pollTimers: () => [...pending.values()].filter((ms) => [1000, 1500, 2250, 3400].includes(ms)).length,
    close: () => w.close(),
  };
}

const baseRoutes = (user = BUYER, cfg = CFG(true, false)) => ({
  'GET /api/users/me': () => json(200, { user, wallet: WALLET }),
  'GET /api/users/me/seller-request': () => json(200, { request: null }),
  'GET /api/listings/meta': () => json(200, { categories: [], conditions: [], locations: [] }),
  'GET /api/wallets/me': () => json(200, WALLET),
  'GET /api/transactions': () => json(200, { transactions: [] }),
  'GET /api/payments/me': () => json(200, { paymentRequests: [] }),
  'GET /api/notifications': () => json(200, { notifications: [], unreadCount: 0 }),
  'GET /api/wallets/me/entries': () => json(200, { entries: [] }),
  'GET /api/payments/paypal/config': () => json(200, cfg),
});

/** Trang ví PayPal. `create(body, n)` trả phản hồi POST /payments/paypal/topup lần n. */
async function wallet({ create, extra = {}, user = BUYER, cfg, storage = {}, amount = String(AMOUNT), timeoutMs, search, hash } = {}) {
  const bodies = [];
  const routes = {
    ...baseRoutes(user, cfg),
    'POST /api/payments/paypal/topup': (opts) => { const b = JSON.parse(opts.body); bodies.push(b); return create ? create(b, bodies.length) : HANG; },
    ...extra,
  };
  const p = await openPage({ user, routes, storage, timeoutMs, search, hash });
  p.topupBodies = bodies;
  if (p.amountInput() && !p.amountInput().disabled) p.amountInput().value = amount;
  return p;
}
const press = async (p, wait = 300) => { p.click(p.btn()); await sleep(wait); };
const noMockCalls = (p) => p.log.every((l) => !/POST \/api\/payments\/topup$|\/mock-provider\//.test(l));

async function logoutUi(p) {
  p.routes['POST /api/passkeys/session/logout'] = () => json(200, { ok: true });
  p.click(p.d.querySelector('[data-act="logout"]'));
  await sleep(60);
}
async function loginUi(p, user) {
  p.routes['POST /api/passkeys/login/password'] = () => json(200, { token: 'tok-' + user.id, user });
  p.click(p.d.querySelector('[data-act="open-auth"]'));
  await sleep(150);
  p.d.querySelector('#loginUsername').value = user.username;
  p.d.querySelector('#loginPassword').value = 'mat-khau-gia';
  p.click(p.d.querySelector('[data-act="do-login-password"]'));
  await sleep(500);
}

/** Máy chủ PayPal giả có trạng thái: một yêu cầu 5b1f0c52-7a3e-4c1d-9a55-0f1e2d3c4b5a với giai đoạn có thể đổi giữa các lần gọi. */
function fakeServer(initial = {}, { key = KEY } = {}) {
  const s = { row: ppRow({ requestId: key, ...initial }), approvalUrl: SANDBOX, captures: 0, captureResult: null };
  s.routes = () => ({
    'GET /api/payments/5b1f0c52-7a3e-4c1d-9a55-0f1e2d3c4b5a': () => json(200, s.row),
    'GET /api/payments/paypal/5b1f0c52-7a3e-4c1d-9a55-0f1e2d3c4b5a/checkout': () => json(200, { ...s.row, approvalUrl: s.approvalUrl }),
    'POST /api/payments/paypal/5b1f0c52-7a3e-4c1d-9a55-0f1e2d3c4b5a/capture': () => {
      s.captures++;
      return s.captureResult ? s.captureResult() : json(200, { ...s.row, outcome: 'APPLIED' });
    },
  });
  return s;
}


const ID=ppRow().id;
const ABANDON='POST /api/payments/paypal/'+ID+'/abandon';
const DETAIL='GET /api/payments/'+ID;
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function until(fn,label){for(let i=0;i<100;i++){if(fn())return;await sleep(20);}throw Error('Fixture condition not reached: '+label);}
async function page(row=ppRow(),extra={},storage,timeoutMs=TIMEOUT_MS){
 const p=await wallet({timeoutMs,storage:storage||{[INTENT_PREFIX+BUYER.id]:intentJson()},extra:{[DETAIL]:()=>json(200,row),'GET /api/payments/me':()=>json(200,{paymentRequests:[row]}),...extra}});
 await until(()=>p.d.querySelector('[data-act="paypal-abandon"]'),'abandon button');return p;
}
async function open(p){p.click(p.d.querySelector('[data-act="paypal-abandon"]'));await until(()=>p.d.querySelector('[data-act="paypal-abandon-confirm"]'),'confirmation');}
async function confirm(p){const b=p.d.querySelector('[data-act="paypal-abandon-confirm"]');p.click(b);return b;}
async function main(){
 let p;
 section('Explicit confirmation and terminal GET');
 let row=ppRow();
 p=await page(row,{[ABANDON]:()=>{row=ppRow({status:'FAILED',stage:'FAILED'});return json(200,{...row,outcome:'ABANDONED'});},[DETAIL]:()=>json(200,row)});
 try{
  ok(p.count(ABANDON)===0,'Rendering/callback does not abandon automatically');
  await open(p);ok(p.count(ABANDON)===0,'Opening modal does not POST');
  p.click(p.d.querySelector('#modalRoot [data-act="modal-close"]'));
  ok(p.count(ABANDON)===0 && !!p.intent(),'Cancelling confirmation keeps intent and sends no POST');
  await open(p);await confirm(p);await until(()=>p.intent()===null,'verified FAILED releases intent');
  ok(p.count(ABANDON)===1,'Exactly one explicit abandon POST');
  ok(JSON.stringify(p.bodies[ABANDON][0])==='{}','Body is empty object');
  ok(p.count(DETAIL)>=2,'Fresh GET before and after abandon');
  ok(p.toasts().some(x=>x.text.includes('Đã bỏ yêu cầu')),'Only validated terminal GET allows abandoned message');
 }finally{p.close();}
 section('Double click and no automatic auth retry');
 const hold=deferred();row=ppRow();
 p=await page(row,{[ABANDON]:()=>hold.promise,[DETAIL]:()=>json(200,row)},undefined);
 try{
  await open(p);const b=await confirm(p);p.click(b);await until(()=>p.count(ABANDON)===1,'POST in flight');
  ok(p.count(ABANDON)===1,'Double click while in flight sends one POST');
  hold.resolve(json(401,{error:'UNAUTHENTICATED',message:'Hết phiên'}));
  await until(()=>p.count(DETAIL)>=2,'GET after rejected POST');await sleep(80);
  ok(p.count(ABANDON)===1,'401 does not replay abandon POST');
 }finally{hold.resolve(json(500,{}));p.close();}
 section('POST never substitutes for GET evidence');
 for(const mode of ['get-error','wrong-id','wrong-key','wrong-amount','pending','recovery','timeout','conflict']){
  row=ppRow();let didPost=false;
  const closed=ppRow({status:'FAILED',stage:'FAILED'});
  p=await page(row,{
   [ABANDON]:()=>{didPost=true;return mode==='timeout'?HANG:mode==='conflict'?json(409,{error:'PAYPAL_ABANDON_UNSAFE',message:'Chưa thể bỏ'}):json(200,{...closed,outcome:'ABANDONED'});},
   [DETAIL]:()=>{if(!didPost)return json(200,row);if(mode==='get-error')return json(503,{error:'UNAVAILABLE'});return json(200,mode==='wrong-id'?{...closed,id:'other-id'}:mode==='wrong-key'?{...closed,requestId:'topup-other-key-123'}:mode==='wrong-amount'?{...closed,amount:AMOUNT+1}:mode==='recovery'?{...closed,stage:'RECOVERY_REQUIRED'}:row);},
  });
  try{await open(p);await confirm(p);await until(()=>didPost,'POST started');await until(()=>p.count(DETAIL)>=2,'follow-up GET');await sleep(80);
   ok(!!p.intent(),mode+': unconfirmed/recovery keeps intent');
   ok(!p.toasts().some(x=>x.text.includes('Đã bỏ yêu cầu')),mode+': no false abandoned toast');
   ok(p.count(ABANDON)===1,mode+': no automatic POST retry');
   if(mode==='recovery')ok(p.notice().includes('cần xử lý thủ công'), 'Recovery takes precedence over FAILED');
  }finally{p.close();}
 }
 section('Stale response after logout/login of same account');
 row=ppRow();const stale=deferred();let delivered=false;
 p=await page(row,{[ABANDON]:()=>stale.promise.then(r=>{delivered=true;return r;})},undefined,5000);
 try{
  await open(p);await confirm(p);await until(()=>p.count(ABANDON)===1,'held POST');
  ok(!delivered,'Precondition: old POST response is still pending before logout');
  await logoutUi(p);await loginUi(p,BUYER);const beforeGet=p.count(DETAIL);p.clearToasts();
  ok(!delivered,'Precondition: response remains held until same-account new login completes');
  stale.resolve(json(200,{...ppRow({status:'FAILED',stage:'FAILED'}),outcome:'ABANDONED'}));await until(()=>delivered,'old response actually delivered');await sleep(150);
  ok(!p.toasts().some(x=>x.text.includes('Đã bỏ yêu cầu')),'Same-account new session ignores old response');
  ok(p.count(DETAIL)===beforeGet && !!p.intent(),'Old response neither GETs nor clears current intent');
 }finally{stale.resolve(json(500,{}));p.close();}
 section('Cancel callback never abandons or captures automatically');
 p=await wallet({storage:{[INTENT_PREFIX+BUYER.id]:intentJson()},search:'?paypal=cancel&paymentRequestId='+ID,extra:{[DETAIL]:()=>json(200,ppRow()),[ABANDON]:()=>json(500,{})}});
 try{ok(p.count(ABANDON)===0,'PayPal cancel callback sends no abandon POST');ok(p.count('POST /api/payments/paypal/'+ID+'/capture')===0,'Cancel callback sends no capture POST');}finally{p.close();}
 section('Only eligible stage offers abandon');
 for(const [status,stage] of [['PENDING','CAPTURING'],['PENDING','RECONCILING'],['FAILED','FAILED'],['FAILED','RECOVERY_REQUIRED']]){
  const r=ppRow({status,stage});p=await wallet({storage:{[INTENT_PREFIX+BUYER.id]:intentJson()},extra:{[DETAIL]:()=>json(200,r),'GET /api/payments/me':()=>json(200,{paymentRequests:[r]})}});
  try{ok(!p.d.querySelector('[data-act="paypal-abandon"]'),stage+': no abandon button');}finally{p.close();}
 }
 section('History request does not clear a different active intent');
 row=ppRow();let closed=false;
 p=await page(row,{[ABANDON]:()=>{closed=true;return json(200,{...row,status:'FAILED',stage:'FAILED',outcome:'ABANDONED'});},[DETAIL]:()=>json(200,closed?{...row,status:'FAILED',stage:'FAILED'}:row)}, {[INTENT_PREFIX+BUYER.id]:intentJson({requestId:'topup-different-intent-01',paymentId:'different-id'})});
 try{await open(p);await confirm(p);await until(()=>closed && p.count(DETAIL)>=2,'history close confirmed');await sleep(80);
  ok(p.intent()?.requestId==='topup-different-intent-01','Closing old history request preserves other intent');
 }finally{p.close();}
 console.log(`\n${checks} checks, ${fails} FAIL`);process.exit(fails?1:0);
}
main().catch(e=>{console.error(e);process.exit(1)});
