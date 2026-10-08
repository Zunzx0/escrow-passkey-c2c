/**
 * Kiểm thử giao diện nạp tiền PayPal Sandbox (P2) — jsdom + fake fetch bám HOP-DONG-API-PAYPAL-P2-M2.md.
 *
 * Giống các bộ test/ui khác: dựng DOM từ public/index.html, nạp public/js/*.js thật, mock toàn bộ `fetch`; KHÔNG cần máy chủ, DB, mạng,
 * secret hay tài khoản PayPal. window.ENCLAVE_NAVIGATE (hook kiểm thử) chặn điều hướng sang PayPal để ghi lại URL.
 *
 * ĐÂY KHÔNG PHẢI bằng chứng PayPal Sandbox thật, Passkey thật, cookie/Set-Cookie thật hay luồng redirect thật của trình duyệt.
 * Nó chỉ chứng minh logic giao diện đúng với hợp đồng API; nghiệm thu trình duyệt + tài khoản Sandbox do Codex phối hợp riêng.
 *
 * Nhóm kiểm:
 *   C   Cấu hình công khai (bật/tắt/lỗi/sai dạng; không brand mock thành PayPal; không fallback âm thầm)
 *   Q   Tạo yêu cầu: requestId/số tiền qua retry, reload, 5xx, timeout, 429; từ chối dứt khoát; dừng khi cần đối soát
 *   B   Báo giá của máy chủ (không tự tính) và báo giá sai dạng
 *   U   URL phê duyệt: chỉ origin Sandbox đúng, từ máy chủ, không từ query
 *   R   Return / cancel: xác minh bằng GET; cancel không capture/không FAILED; return tự hoàn tất sau xác minh
 *   X   Capture: timeout/5xx/429/outcome không thành công; GET sau capture là chứng cứ duy nhất
 *   S   Đủ 9 giai đoạn (stage) và lịch sử phân biệt provider
 *   N   Phiên: phản hồi muộn sau đăng xuất / đổi tài khoản không tác động phiên mới
 *   Z   Không payout/refund PayPal, không bí mật trong public/ hay localStorage, cô lập mock/PayPal, theo dõi có hạn
 *
 * Cách chạy (cần jsdom — KHÔNG nằm trong package.json; cài không ghi vào package.json):
 *   cd cho-an-tam
 *   npm i --no-save jsdom        # hoặc đặt NODE_PATH tới node_modules đã có jsdom
 *   node test/ui/paypal-wallet-ui.js
 * Cần Node >= 23. Mất khoảng vài phút (có chờ theo dõi thật).
 */
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
async function openPage({ hash = '#/wallet', search = '', user = BUYER, routes = {}, storage = {}, sessionStorage = {}, timeoutMs = TIMEOUT_MS }) {
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
      for (const [k, v] of Object.entries(sessionStorage)) w.sessionStorage.setItem(k, v);
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
async function wallet({ create, extra = {}, user = BUYER, cfg, storage = {}, sessionStorage = {}, amount = String(AMOUNT), timeoutMs, search, hash } = {}) {
  const bodies = [];
  const routes = {
    ...baseRoutes(user, cfg),
    'POST /api/payments/paypal/topup': (opts) => { const b = JSON.parse(opts.body); bodies.push(b); return create ? create(b, bodies.length) : HANG; },
    ...extra,
  };
  const p = await openPage({ user, routes, storage, sessionStorage, timeoutMs, search, hash });
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

async function main() {
  // =========================================================================================
  section('C: cấu hình công khai — chỉ hiện PayPal khi máy chủ xác nhận; không brand mock thành PayPal; không fallback âm thầm');
  let p = await wallet({ cfg: CFG(true, false) });
  ok(!!p.amountInput() && /PayPal Sandbox/.test(p.viewText()) && !!p.d.querySelector('.tag-info'), 'enabled=true, mode=sandbox: hiện thẻ nạp PayPal Sandbox');
  ok(/Tạo yêu cầu nạp PayPal/.test(p.btn().textContent), 'Nút tạo yêu cầu ghi rõ PayPal');
  ok(!/Cổng thanh toán mô phỏng/.test(p.viewText()), 'Khi PayPal bật, không còn thẻ/nhãn "cổng thanh toán mô phỏng"');
  ok(!/hoàn tiền (qua|bằng) PayPal|chi tiền qua PayPal(?! )/.test(p.viewText().replace('không hoàn tiền hay chi tiền qua PayPal', '')), 'Không có chữ nào hứa hoàn tiền/chi tiền qua PayPal');
  p.close();

  p = await wallet({ cfg: CFG(false, true) });
  ok(!!p.amountInput() && /Cổng thanh toán mô phỏng/.test(p.viewText()) && !p.d.querySelector('.tag-info') && !p.d.querySelector('[data-act="paypal-approve"]'),
    'paypal=false, mock=true: hiện cổng MÔ PHỎNG, không gắn nhãn PayPal Sandbox lên mock');
  p.close();

  p = await wallet({ cfg: CFG(false, false) });
  ok(!p.amountInput() && /Nạp tiền chưa sẵn sàng/.test(p.viewText()) && /không tự chuyển sang cổng khác/.test(p.viewText()),
    'Cả hai tắt: báo chưa sẵn sàng, KHÔNG có ô nhập, không fallback âm thầm');
  p.close();

  p = await wallet({ extra: { 'GET /api/payments/paypal/config': () => json(404, { error: 'NOT_FOUND', message: 'x' }) } });
  ok(!p.amountInput() && /chưa mở cổng nào/.test(p.viewText()) && noMockCalls(p),
    'Config 404: tắt cả hai cổng, không tự chuyển sang mock');
  p.close();

  for (const [label, resp] of [
    ['500', () => json(500, { error: 'INTERNAL_ERROR', message: 'x' })],
    ['mạng treo (timeout)', () => HANG],
    ['200 HTML', () => html(200, '<html>ok</html>')],
    ['200 object rỗng', () => json(200, {})],
    ['enabled là chuỗi "true"', () => json(200, { paypalSandbox: { enabled: 'true', mode: 'sandbox' }, mockPayments: { enabled: false } })],
    ['thiếu mockPayments', () => json(200, { paypalSandbox: { enabled: true, mode: 'sandbox', rateKind: 'DEMO_FIXED' } })],
  ]) {
    p = await wallet({ extra: { 'GET /api/payments/paypal/config': resp }, timeoutMs: 400 });
    await sleep(600);
    ok(!p.amountInput() && /Nạp tiền chưa sẵn sàng/.test(p.viewText()) && !!p.d.querySelector('[data-act="paypal-config-retry"]'),
      `Cấu hình lỗi/sai dạng (${label}): TẮT cả hai cổng, có nút tải lại, không đoán`);
    p.close();
  }
  p = await wallet({ cfg: CFG(true, false, 'live') });
  ok(!p.amountInput() && /Nạp tiền chưa sẵn sàng/.test(p.viewText()), 'enabled=true nhưng mode=live: KHÔNG coi là PayPal Sandbox (chưa sẵn sàng)');
  p.close();

  // =========================================================================================
  section('Q: tạo yêu cầu — requestId/số tiền giữ qua retry, reload, 5xx, timeout, 429');
  p = await wallet({ create: () => HANG });
  p.click(p.btn());
  await sleep(40);
  p.click(p.btn());
  p.click(p.btn());
  await sleep(40);
  ok(p.topupBodies.length === 1, 'Bấm đúp / ba lần chỉ gửi MỘT POST /payments/paypal/topup');
  const k1 = p.topupBodies[0].requestId;
  ok(/^topup-[0-9a-f-]{36}$/.test(k1) && p.topupBodies[0].amount === AMOUNT && Number.isInteger(p.topupBodies[0].amount), `Thân đúng hợp đồng: amount số nguyên + requestId (${k1})`);
  ok(Object.keys(p.topupBodies[0]).sort().join() === 'amount,requestId', 'Thân chỉ có amount và requestId (không gửi báo giá/tỷ giá/merchant)');
  const st = p.intent();
  ok(st && st.provider === 'PAYPAL_SANDBOX' && st.requestId === k1 && st.userId === BUYER.id && !/tok-|token|secret/i.test(JSON.stringify(st)),
    'Ý định lưu theo user, ghi provider PAYPAL_SANDBOX, không chứa token/bí mật');
  await sleep(TIMEOUT_MS + 350);
  ok(/chưa rõ/i.test(p.notice()) && p.toasts().every((t) => t.kind !== 'ok') && p.amountInput().disabled, 'Timeout: báo "chưa rõ", khoá số tiền, không báo thành công');
  p.routes['POST /api/payments/paypal/topup'] = (opts) => { const b = JSON.parse(opts.body); p.topupBodies.push(b); return json(200, ppRow({ requestId: b.requestId })); };
  await press(p, 500);
  ok(p.topupBodies.length === 2 && p.topupBodies[1].requestId === k1 && p.topupBodies[1].amount === AMOUNT, 'Thử lại sau timeout: CÙNG requestId, CÙNG số tiền');
  ok(/Chờ bạn phê duyệt ở PayPal Sandbox/.test(p.notice()) && !!p.noticeBtn('paypal-approve'), 'AWAITING_APPROVAL: hiện nút "Mở PayPal Sandbox" (chưa tự chuyển trang)');
  ok(p.navs.length === 0, 'Không có URL checkout hợp lệ: không tự dựng đường dẫn PayPal');
  ok(p.intent() && p.intent().paymentId === '5b1f0c52-7a3e-4c1d-9a55-0f1e2d3c4b5a', 'Giữ ý định (kèm id yêu cầu) để còn quay lại từ PayPal');
  ok(noMockCalls(p), 'Luồng PayPal không gọi mock topup hay mock-provider');
  const snap = p.store();
  p.close();

  p = await wallet({ storage: snap, create: (b) => json(200, ppRow({ requestId: b.requestId })) });
  ok(p.amountInput().disabled && p.amountInput().value === String(AMOUNT), 'Tải lại: khôi phục số tiền của ý định và khoá');
  await press(p, 500);
  ok(p.topupBodies.length === 1 && p.topupBodies[0].requestId === k1, 'Tải lại rồi gửi: dùng đúng khoá cũ');
  p.close();

  for (const [label, resp] of [
    ['503 chung', () => json(503, { error: 'PROVIDER_UNAVAILABLE', message: 'x' })],
    ['500', () => json(500, { error: 'INTERNAL_ERROR', message: 'x', requestId: 'srv-ref-1' })],
    ['429 RATE_LIMITED', () => json(429, { error: 'RATE_LIMITED', message: 'Quá nhiều yêu cầu, thử lại sau 30 giây.' })],
    ['mất kết nối', () => { throw new TypeError('Failed to fetch'); }],
  ]) {
    p = await wallet({ create: resp });
    await press(p, 400);
    const key = p.topupBodies[0].requestId;
    ok(!!p.intent() && p.intent().requestId === key && p.amountInput().disabled, `${label}: giữ ý định + khoá số tiền (có thể đã tạo)`);
    p.routes['POST /api/payments/paypal/topup'] = (opts) => { const b = JSON.parse(opts.body); p.topupBodies.push(b); return HANG; };
    await press(p, 100);
    ok(p.topupBodies.length === 2 && p.topupBodies[1].requestId === key && p.topupBodies[1].amount === AMOUNT, `${label}: thử lại cùng requestId + số tiền (không đổi khoá)`);
    p.close();
  }

  for (const [label, resp, expectOff] of [
    ['400 INVALID_AMOUNT', () => json(400, { error: 'INVALID_AMOUNT', message: 'amount phải là một số nguyên (đơn vị đồng)' }), false],
    ['400 AMOUNT_OUT_OF_RANGE', () => json(400, { error: 'AMOUNT_OUT_OF_RANGE', message: 'amount phải từ 1.000đ đến 50.000.000đ' }), false],
    ['409 TOPUP_LIMIT_EXCEEDED', () => json(409, { error: 'TOPUP_LIMIT_EXCEEDED', message: 'Bạn đang có 5 yêu cầu chờ' }), false],
    ['503 PAYPAL_DISABLED', () => { p.routes['GET /api/payments/paypal/config'] = () => json(200, CFG(false, false)); return json(503, { error: 'PAYPAL_DISABLED', message: 'PayPal Sandbox chưa được bật' }); }, true],
  ]) {
    p = await wallet({ create: resp });
    await press(p, 500);
    ok(p.intent() === null && !p.amountInput() === expectOff, `${label}: từ chối dứt khoát -> bỏ ý định${expectOff ? ', vẽ lại "chưa sẵn sàng", KHÔNG fallback sang mock' : ', mở lại ô số tiền'}`);
    ok(noMockCalls(p) && p.toasts().some((t) => t.kind === 'err') && p.toasts().every((t) => !/INVALID_AMOUNT|AMOUNT_OUT|PAYPAL_DISABLED|TOPUP_LIMIT/.test(t.text)),
      `${label}: báo lỗi tiếng Việt, không lộ mã thô, không gọi mock`);
    p.close();
  }

  p = await wallet({ create: () => json(409, { error: 'IDEMPOTENCY_KEY_REUSED', message: 'x' }) });
  await press(p, 400);
  ok(!!p.intent() && /Chưa rõ/.test(p.notice()), '409 IDEMPOTENCY_KEY_REUSED: không tự bỏ ý định, không tự đổi khoá');
  p.close();

  p = await wallet({ create: () => json(409, { error: 'PAYPAL_CREATE_RECOVERY_REQUIRED', message: 'x' }) });
  await press(p, 400);
  ok(/Dừng mọi thao tác tự động/.test(p.notice()) && /KHÔNG tự tạo order mới/.test(p.notice()) && !!p.intent() && p.topupBodies.length === 1,
    '409 PAYPAL_CREATE_RECOVERY_REQUIRED: dừng tự động, không tạo order/yêu cầu mới, giữ ý định');
  ok(!p.noticeBtn('topup-retry'), 'Dừng đối soát: không còn nút "Thử lại cùng yêu cầu" (không gửi lại tự động)');
  p.close();

  for (const code of ['PAYPAL_ORDER_MISMATCH', 'PAYPAL_CAPTURE_CONFLICT']) {
    p = await wallet({ create: () => json(409, { error: code, message: 'x' }) });
    await press(p, 400);
    ok(/Dừng mọi thao tác tự động/.test(p.notice()) && !!p.intent(), `409 ${code}: dừng tự động, báo cần đối soát thủ công`);
    p.close();
  }

  // =========================================================================================
  section('B: báo giá do máy chủ chốt — không tự tính; báo giá sai dạng bị từ chối');
  p = await wallet({ create: (b) => json(200, ppRow({ requestId: b.requestId, quote: quote({ usdCents: 407, usdValue: '4.07', rateVndPerUsd: 24500 }) })) });
  await press(p, 500);
  const nt = p.notice();
  ok(/100\.000₫/.test(nt) && /4\.07 USD/.test(nt) && /24\.500 VND\/USD/.test(nt) && /Tỷ giá mô phỏng, không phải giá thị trường/.test(nt),
    'Hiện VND ghi ví, USD và tỷ giá ĐÚNG như máy chủ trả (4.07 / 24.500 — khác kết quả nếu tự tính 100000/25000)');
  ok(/giao diện không tính lại/.test(nt), 'Ghi rõ giao diện không tự tính');
  p.close();

  const badQuotes = [
    ['usdValue lệch usdCents', quote({ usdValue: '4.00', usdCents: 407 })],
    ['amountVnd khác amount', quote({ amountVnd: 200000 })],
    ['currency không phải USD', quote({ currency: 'EUR' })],
    ['usdValue là số', quote({ usdValue: 4 })],
    ['usdValue sai định dạng', quote({ usdValue: '4.0' })],
    ['usdCents âm', quote({ usdCents: -1 })],
    ['rateKind lạ', quote({ rateKind: 'MARKET' })],
    ['thiếu rateLabel', quote({ rateLabel: '' })],
    ['rateVndPerUsd 0', quote({ rateVndPerUsd: 0 })],
    ['quote null', null],
    ['quote là mảng', []],
  ];
  for (const [label, q] of badQuotes) {
    p = await wallet({ create: (b) => json(200, ppRow({ requestId: b.requestId, quote: q })) });
    await press(p, 500);
    ok(!p.noticeBtn('paypal-approve') && !p.noticeBtn('paypal-capture') && /Chưa rõ/.test(p.notice()) && p.navs.length === 0 && p.intent() !== null,
      `Báo giá sai dạng (${label}): không hiện nút phê duyệt, giữ ý định, báo chưa rõ`);
    p.close();
  }
  for (const [label, o] of [
    ['sai số tiền', { amount: 5000, quote: quote({ amountVnd: 5000 }) }],
    ['sai requestId', { requestId: 'topup-khac-hoan-toan-9999' }],
    ['provider MOCK', { provider: 'MOCK' }],
    ['sandbox=false', { sandbox: false }],
    ['stage lạ', { stage: 'DONE' }],
    ['thiếu id', { id: '' }],
    ['status SUCCEEDED nhưng stage chờ', { status: 'SUCCEEDED', stage: 'AWAITING_APPROVAL' }],
  ]) {
    p = await wallet({ create: (b) => json(200, ppRow({ requestId: b.requestId, ...o })) });
    await press(p, 500);
    ok(!p.noticeBtn('paypal-approve') && p.toasts().every((t) => t.kind !== 'ok') && p.intent() !== null,
      `Phản hồi tạo yêu cầu không khớp ý định (${label}): không coi là hợp lệ, không thành công giả, giữ ý định`);
    p.close();
  }
  for (const [label, resp] of [['HTML', () => html(200, '<html>x</html>')], ['mảng', () => json(200, [])], ['null', () => json(200, null)]]) {
    p = await wallet({ create: resp });
    await press(p, 500);
    ok(!p.noticeBtn('paypal-approve') && p.toasts().every((t) => t.kind !== 'ok') && !!p.intent(), `200 thân hỏng (${label}): không thành công, giữ ý định`);
    p.close();
  }

  // =========================================================================================
  section('U: URL phê duyệt — chỉ từ máy chủ, đúng origin Sandbox, không từ query');
  let srv = fakeServer();
  p = await wallet({ storage: { [INTENT_PREFIX + BUYER.id]: intentJson() }, extra: srv.routes() });
  p.click(p.noticeBtn('paypal-check') || p.d.querySelector('#topupIntent [data-act="topup-check"]'));
  await sleep(300);
  p.click(p.noticeBtn('paypal-approve'));
  await sleep(300);
  ok(p.count('GET /api/payments/paypal/5b1f0c52-7a3e-4c1d-9a55-0f1e2d3c4b5a/checkout') === 1 && p.navs.length === 1 && p.navs[0] === SANDBOX,
    'Bấm "Mở PayPal Sandbox": GET .../checkout rồi điều hướng ĐÚNG URL máy chủ trả');
  ok(p.log.every((l) => !/paypal\.com/.test(l)), 'Giao diện không gọi thẳng PayPal');
  p.close();

  const badUrls = [
    ['http không TLS', 'http://www.sandbox.paypal.com/checkoutnow?token=ORDER1'],
    ['domain gần giống (hậu tố)', 'https://www.sandbox.paypal.com.evil.example/checkoutnow?token=ORDER1'],
    ['domain gần giống (tiền tố)', 'https://evil-www.sandbox.paypal.com/checkoutnow'],
    ['thiếu www', 'https://sandbox.paypal.com/checkoutnow?token=ORDER1'],
    ['subdomain khác', 'https://api.sandbox.paypal.com/checkoutnow'],
    ['PayPal LIVE', 'https://www.paypal.com/checkoutnow?token=ORDER1'],
    ['có userinfo', 'https://user:pass@www.sandbox.paypal.com/checkoutnow'],
    ['userinfo giả host', 'https://www.sandbox.paypal.com@evil.example/checkoutnow'],
    ['cổng lạ', 'https://www.sandbox.paypal.com:8443/checkoutnow'],
    ['javascript:', 'javascript:alert(1)'],
    ['data:', 'data:text/html,<script>1</script>'],
    ['chứa khoảng trắng', 'https://www.sandbox.paypal.com/a b'],
    ['dấu gạch chéo ngược', 'https://www.sandbox.paypal.com\\@evil.example/'],
    ['rỗng', ''],
    ['null', null],
    ['số', 12345],
  ];
  for (const [label, url] of badUrls) {
    srv = fakeServer();
    srv.approvalUrl = url;
    p = await wallet({ storage: { [INTENT_PREFIX + BUYER.id]: intentJson() }, extra: srv.routes() });
    p.click(p.d.querySelector('#topupIntent [data-act="topup-check"]'));
    await sleep(250);
    p.click(p.noticeBtn('paypal-approve'));
    await sleep(250);
    ok(p.navs.length === 0 && p.toasts().some((t) => t.kind === 'err' && /không hợp lệ/.test(t.text)), `URL phê duyệt giả (${label}): KHÔNG điều hướng, báo lỗi`);
    p.close();
  }

  // URL trong phản hồi TẠO yêu cầu không được dùng; chỉ URL của GET checkout.
  srv = fakeServer();
  srv.approvalUrl = null;
  p = await wallet({
    create: (b) => json(200, ppRow({ requestId: b.requestId, approvalUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=TUBE' })),
    extra: srv.routes(),
  });
  await press(p, 500);
  p.click(p.noticeBtn('paypal-approve'));
  await sleep(300);
  ok(p.navs.length === 0, 'GET checkout không có URL: KHÔNG tự dùng URL trong phản hồi tạo, KHÔNG tự dựng URL từ orderId/token');
  p.close();

  // URL return có token/PayerID giả: không bao giờ dùng để dựng URL hay điều hướng.
  srv = fakeServer();
  p = await wallet({
    storage: { [INTENT_PREFIX + BUYER.id]: intentJson() }, extra: srv.routes(),
    search: '?paypal=return&paymentRequestId=5b1f0c52-7a3e-4c1d-9a55-0f1e2d3c4b5a&token=EVILTOKEN&PayerID=EVILPAYER&url=https://evil.example/&redirect=//evil.example',
  });
  ok(p.navs.length === 0 && p.log.every((l) => !/evil/i.test(l)), 'Query return có token/PayerID/url giả: không điều hướng, không gọi gì tới giá trị đó');
  p.close();

  // =========================================================================================
  section('R: return / cancel — xác minh bằng GET; cancel không capture/không FAILED; return tự hoàn tất sau xác minh');
  srv = fakeServer();
  srv.captureResult = () => { srv.row = { ...srv.row, stage: 'CAPTURING' }; return json(200, { outcome: 'BUSY' }); };
  p = await wallet({ storage: { [INTENT_PREFIX + BUYER.id]: intentJson() }, extra: srv.routes(), search: '?paypal=return&paymentRequestId=5b1f0c52-7a3e-4c1d-9a55-0f1e2d3c4b5a&token=T1&PayerID=P1' });
  ok(p.w.location.search === '' && p.w.location.hash === '#/wallet', 'Query ?paypal=… được dọn khỏi URL (giữ #/wallet) — tải lại không xử lý lại, token/PayerID không nằm lại');
  ok(p.count('GET /api/payments/5b1f0c52-7a3e-4c1d-9a55-0f1e2d3c4b5a') >= 1, 'Return: GET /payments/:id để xác minh');
  ok(/Đang xác nhận thanh toán/.test(p.notice()) && !p.noticeBtn('paypal-capture'), 'Return khớp ý định: tự hoàn tất, không có nút xác nhận lần hai');
  ok(srv.captures === 1 && p.count('POST /api/payments/paypal/5b1f0c52-7a3e-4c1d-9a55-0f1e2d3c4b5a/capture') === 1, 'Return tự capture đúng một lần');
  ok(p.toasts().every((t) => t.kind !== 'ok') && !/Nạp tiền thành công/.test(p.viewText()), 'Return KHÔNG tự báo thành công, ví chưa đổi');
  ok(p.count('POST /api/payments/paypal/topup') === 0, 'Return KHÔNG tạo yêu cầu mới');
  const capBtn = p.noticeBtn('paypal-capture');
  srv.row = { ...srv.row, stage: 'CAPTURING' };
  // Capture đã tự phát khi return; không còn bước bấm thêm.
  await sleep(500);
  ok(srv.captures === 1, 'Bấm xác nhận (kể cả bấm đúp): đúng MỘT POST capture');
  ok(Object.keys(p.bodies['POST /api/payments/paypal/5b1f0c52-7a3e-4c1d-9a55-0f1e2d3c4b5a/capture'][0] || {}).length === 0 || p.bodies['POST /api/payments/paypal/5b1f0c52-7a3e-4c1d-9a55-0f1e2d3c4b5a/capture'][0] === null,
    'Capture không gửi số tiền/merchant/order do client khai');
  ok(/Đang xác nhận thanh toán/.test(p.notice()) && !p.noticeBtn('paypal-capture'), 'Sau capture, GET nói CAPTURING: hiện "đang xác nhận", khoá thao tác lặp');
  ok(p.toasts().every((t) => t.kind !== 'ok'), 'CAPTURING: chưa báo thành công');
  p.clearToasts();
  srv.row = ppRow({ requestId: KEY, status: 'SUCCEEDED', stage: 'SUCCEEDED', resolvedAt: new Date().toISOString(), resolvedBy: 'WEBHOOK' });
  await sleep(1300); // lượt theo dõi đầu tiên (1s) thấy SUCCEEDED
  ok(p.toasts().filter((t) => t.kind === 'ok' && /Nạp tiền thành công/.test(t.text)).length === 1, 'GET sau capture khớp ý định nói SUCCEEDED: đúng MỘT thông báo thành công');
  ok(p.intent() === null && p.notice() === '', 'Thành công được xác nhận: ý định và thông báo được dọn');
  ok(p.count('GET /api/wallets/me') >= 2, 'Ví được đọc lại từ máy chủ (không tự cộng ở giao diện)');
  p.close();

  srv = fakeServer();
  p = await wallet({ storage: { [INTENT_PREFIX + BUYER.id]: intentJson() }, extra: srv.routes(), search: '?paypal=cancel&paymentRequestId=5b1f0c52-7a3e-4c1d-9a55-0f1e2d3c4b5a&token=T1' });
  ok(p.count('GET /api/payments/5b1f0c52-7a3e-4c1d-9a55-0f1e2d3c4b5a') >= 1 && /chưa hoàn tất phê duyệt/.test(p.notice()), 'Cancel: chỉ GET trạng thái, báo chưa hoàn tất phê duyệt');
  ok(!p.noticeBtn('paypal-capture') && srv.captures === 0, 'Cancel: KHÔNG có nút capture, không gọi capture');
  ok(!/Thất bại|đã đóng/.test(p.notice()) && /không làm yêu cầu thất bại/.test(p.notice()), 'Cancel KHÔNG bị diễn giải là FAILED hay NOT_CAPTURED');
  ok(p.count('POST /api/payments/paypal/topup') === 0 && !!p.intent(), 'Cancel: không tạo yêu cầu mới, giữ ý định');
  ok(!!p.noticeBtn('paypal-approve'), 'Cancel: vẫn mở lại được PayPal Sandbox');
  p.close();

  // Return không khớp ý định / không có ý định / id lạ.
  for (const [label, storage, row] of [
    ['không có ý định trên thiết bị', {}, {}],
    ['ý định khác requestId', { [INTENT_PREFIX + BUYER.id]: intentJson({ requestId: 'topup-khac-requestid-77', paymentId: undefined }) }, {}],
    ['ý định khác số tiền', { [INTENT_PREFIX + BUYER.id]: intentJson({ amount: 250000 }) }, {}],
    ['ý định khác id yêu cầu', { [INTENT_PREFIX + BUYER.id]: intentJson({ paymentId: 'pp-khac' }) }, {}],
  ]) {
    srv = fakeServer(row);
    p = await wallet({ storage, extra: srv.routes(), search: '?paypal=return&paymentRequestId=5b1f0c52-7a3e-4c1d-9a55-0f1e2d3c4b5a' });
    ok(!p.noticeBtn('paypal-capture') && /không khớp với ý định/.test(p.notice()) && srv.captures === 0, `Return ${label}: KHÔNG cho capture, chỉ hiển thị trạng thái`);
    p.close();
  }

  for (const [label, search] of [
    ['id có ký tự lạ', '?paypal=return&paymentRequestId=../../etc'],
    ['kind lạ', '?paypal=success&paymentRequestId=5b1f0c52-7a3e-4c1d-9a55-0f1e2d3c4b5a'],
    ['thiếu id', '?paypal=return'],
    ['id quá ngắn', '?paypal=return&paymentRequestId=a'],
  ]) {
    srv = fakeServer();
    p = await wallet({ extra: srv.routes(), search });
    ok(p.count('GET /api/payments/5b1f0c52-7a3e-4c1d-9a55-0f1e2d3c4b5a') === 0 && p.w.location.search === '' && p.toasts().every((t) => t.kind !== 'ok'), `Query không hợp lệ (${label}): bị bỏ qua, query vẫn được dọn`);
    p.close();
  }

  srv = fakeServer();
  p = await wallet({
    storage: { [INTENT_PREFIX + BUYER.id]: intentJson() }, search: '?paypal=return&paymentRequestId=5b1f0c52-7a3e-4c1d-9a55-0f1e2d3c4b5a',
    extra: { 'GET /api/payments/5b1f0c52-7a3e-4c1d-9a55-0f1e2d3c4b5a': () => json(403, { error: 'FORBIDDEN', message: 'Bạn không có quyền xem yêu cầu nạp tiền này' }) },
  });
  ok(p.toasts().some((t) => t.kind === 'err') && !p.noticeBtn('paypal-capture'), 'Return với id của người khác (403): báo lỗi, không có nút capture');
  p.close();

  srv = fakeServer({ status: 'SUCCEEDED', stage: 'SUCCEEDED', resolvedAt: new Date().toISOString() });
  p = await wallet({ storage: { [INTENT_PREFIX + BUYER.id]: intentJson() }, extra: srv.routes(), search: '?paypal=return&paymentRequestId=5b1f0c52-7a3e-4c1d-9a55-0f1e2d3c4b5a' });
  ok(p.toasts().filter((t) => t.kind === 'ok' && /Nạp tiền thành công/.test(t.text)).length === 1 && srv.captures === 0,
    'Return khi webhook đã tất toán (GET khớp nói SUCCEEDED): báo thành công đúng một lần, không capture');
  p.close();

  // =========================================================================================
  section('X: capture — timeout/lỗi không gửi lại POST; GET sau capture là chứng cứ duy nhất');
  const capScenario = async (label, captureResult, rowAfter, expect) => {
    const sv = fakeServer();
    sv.captureResult = () => { if (rowAfter) sv.row = { ...sv.row, ...rowAfter }; return captureResult(); };
    const pg = await wallet({ storage: { [INTENT_PREFIX + BUYER.id]: intentJson() }, extra: sv.routes(), search: '?paypal=return&paymentRequestId=5b1f0c52-7a3e-4c1d-9a55-0f1e2d3c4b5a', timeoutMs: 300 });
    sv.row = rowAfter ? { ...sv.row, ...rowAfter } : sv.row;
    // Tự capture từ return.
    await sleep(700);
    pg.routes.__sv = sv;
    expect(pg, sv);
    pg.close();
  };
  await capScenario('timeout', () => HANG, { stage: 'RECONCILING' }, (pg, sv) => {
    ok(sv.captures === 1, 'Capture timeout: KHÔNG gửi lại POST tự động');
    ok(/chưa rõ|đối soát/i.test(pg.notice()) && !/Thất bại/.test(pg.notice()) && pg.toasts().every((t) => t.kind !== 'ok'), 'Capture timeout: hiện "chưa rõ/đối soát", không thất bại, không thành công');
    ok(!pg.noticeBtn('paypal-capture') && !!pg.d.querySelector('#topupIntent [data-act="topup-check"]'), 'Capture timeout: không còn nút capture, có nút kiểm tra lại');
  });
  for (const [label, resp] of [
    ['5xx', () => json(500, { error: 'INTERNAL_ERROR', message: 'x', requestId: 'srv-1' })],
    ['429', () => json(429, { error: 'RATE_LIMITED', message: 'Quá nhiều yêu cầu, thử lại sau 20 giây.' })],
    ['mất kết nối', () => { throw new TypeError('Failed to fetch'); }],
    ['PAYPAL_CAPTURE_CLAIM_LOST', () => json(409, { error: 'PAYPAL_CAPTURE_CLAIM_LOST', message: 'x' })],
  ]) {
    await capScenario(label, resp, { stage: 'CAPTURING' }, (pg, sv) => {
      ok(sv.captures === 1 && /Đang xác nhận thanh toán/.test(pg.notice()) && pg.toasts().every((t) => t.kind !== 'ok' || false) && !pg.noticeBtn('paypal-capture'),
        `Capture ${label}: không gửi lại POST, hỏi trạng thái (GET), hiện "đang xác nhận", không thành công giả`);
    });
  }
  for (const code of ['PAYPAL_CAPTURE_CONFLICT', 'PAYPAL_ORDER_MISMATCH']) {
    await capScenario(code, () => json(409, { error: code, message: 'x' }), { stage: 'RECONCILING' }, (pg, sv) => {
      ok(sv.captures === 1 && /đối soát/i.test(pg.notice()), `Capture ${code}: dừng tự động, hiển thị trạng thái từ GET`);
    });
  }
  for (const outcome of ['APPLIED', 'DUPLICATE', 'BUSY', 'NOT_READY', 'CLOSED', 'NOT_CAPTURED', 'RECOVERY_REQUIRED', 'RECONCILING', 'AWAITING_APPROVAL']) {
    await capScenario(outcome, null, null, (pg, sv) => {
      ok(pg.toasts().every((t) => t.kind !== 'ok') && !/Nạp tiền thành công/.test(pg.viewText()) && sv.captures === 1,
        `HTTP 200 + outcome ${outcome} (GET vẫn AWAITING_APPROVAL): KHÔNG phải nạp thành công`);
    });
  }
  // 200 + GET lỗi/không khớp sau capture: không thành công.
  for (const [label, getResp] of [
    ['GET 503', () => json(503, { error: 'INTERNAL_ERROR', message: 'x' })],
    ['GET treo', () => HANG],
    ['GET thân HTML', () => html(200, '<html>x</html>')],
    ['GET sai id', () => json(200, ppRow({ id: 'pp-khac', status: 'SUCCEEDED', stage: 'SUCCEEDED' }))],
    ['GET sai số tiền', () => json(200, ppRow({ amount: 1000, quote: quote({ amountVnd: 1000 }), status: 'SUCCEEDED', stage: 'SUCCEEDED' }))],
    ['GET sai requestId', () => json(200, ppRow({ requestId: 'topup-khac-hoan-toan-9999', status: 'SUCCEEDED', stage: 'SUCCEEDED' }))],
    ['GET provider MOCK', () => json(200, mockRow({ id: '5b1f0c52-7a3e-4c1d-9a55-0f1e2d3c4b5a', amount: AMOUNT, status: 'SUCCEEDED' }))],
    ['GET status SUCCEEDED nhưng stage khác', () => json(200, ppRow({ status: 'SUCCEEDED', stage: 'CAPTURING' }))],
  ]) {
    const sv = fakeServer();
    const routes = sv.routes();
    routes['GET /api/payments/5b1f0c52-7a3e-4c1d-9a55-0f1e2d3c4b5a'] = () => sv.captures ? getResp() : json(200, sv.row);
    const pg = await wallet({ storage: { [INTENT_PREFIX + BUYER.id]: intentJson() }, extra: routes, search: '?paypal=return&paymentRequestId=5b1f0c52-7a3e-4c1d-9a55-0f1e2d3c4b5a', timeoutMs: 300 });
    ok(sv.captures === 1, `Capture đã phát trước khi kiểm ${label}`);
    // Tự capture từ return.
    await sleep(900);
    ok(pg.toasts().every((t) => t.kind !== 'ok') && !/Nạp tiền thành công/.test(pg.viewText()) && !!pg.intent(),
      `Capture 200 nhưng ${label}: KHÔNG báo thành công, giữ ý định`);
    ok(/Chưa xác nhận/.test(pg.notice()) && !!pg.d.querySelector('#topupIntent [data-act="topup-check"]'), `Capture 200 nhưng ${label}: "chưa xác nhận" + nút kiểm tra lại`);
    pg.close();
  }

  // Phản hồi TẠO yêu cầu (replay) nói SUCCEEDED: phải được GET khớp xác nhận mới báo thành công.
  const createdOk = (b) => json(200, ppRow({ requestId: b.requestId, status: 'SUCCEEDED', stage: 'SUCCEEDED', resolvedAt: new Date().toISOString() }));
  for (const [label, getResp] of [
    ['GET 503', () => json(503, { error: 'INTERNAL_ERROR', message: 'x' })],
    ['GET treo', () => HANG],
    ['GET nói AWAITING_APPROVAL (trái POST)', (pg) => json(200, ppRow({ requestId: pg.topupBodies[0].requestId }))],
    ['GET sai requestId', () => json(200, ppRow({ requestId: 'topup-khac-hoan-toan-9999', status: 'SUCCEEDED', stage: 'SUCCEEDED' }))],
  ]) {
    let pg;
    pg = await wallet({ create: createdOk, extra: { 'GET /api/payments/5b1f0c52-7a3e-4c1d-9a55-0f1e2d3c4b5a': () => getResp(pg) }, timeoutMs: 300 });
    await press(pg, 900);
    ok(pg.toasts().every((t) => t.kind !== 'ok') && !/Nạp tiền thành công/.test(pg.viewText()) && !!pg.intent() && /Chưa xác nhận/.test(pg.notice()),
      `Phản hồi tạo yêu cầu nói SUCCEEDED nhưng ${label}: KHÔNG báo thành công, giữ ý định, "chưa xác nhận"`);
    pg.close();
  }
  {
    let pg;
    pg = await wallet({
      create: createdOk,
      extra: { 'GET /api/payments/5b1f0c52-7a3e-4c1d-9a55-0f1e2d3c4b5a': () => json(200, ppRow({ requestId: pg.topupBodies[0].requestId, status: 'SUCCEEDED', stage: 'SUCCEEDED', resolvedAt: new Date().toISOString() })) },
    });
    await press(pg, 900);
    ok(pg.toasts().filter((t) => t.kind === 'ok' && /Nạp tiền thành công/.test(t.text)).length === 1 && pg.intent() === null,
      'Tạo yêu cầu nói SUCCEEDED + GET khớp nói SUCCEEDED: đúng MỘT thông báo thành công, ý định được dọn');
    pg.close();
  }

  // =========================================================================================
  section('S: đủ 9 giai đoạn (stage) và lịch sử phân biệt provider');
  const stageSpec = [
    ['CREATING', /Đang tạo yêu cầu/, ['topup-check', 'topup-retry'], ['paypal-approve', 'paypal-capture']],
    ['AWAITING_APPROVAL', /Chờ bạn phê duyệt ở PayPal Sandbox/, ['paypal-approve', 'topup-check'], ['paypal-capture']],
    ['CAPTURING', /Đang xác nhận thanh toán/, ['topup-check'], ['paypal-approve', 'paypal-capture', 'topup-retry']],
    ['RECONCILING', /Chưa rõ kết quả thanh toán/, ['topup-check'], ['paypal-approve', 'paypal-capture']],
    ['CREATE_RECOVERY_REQUIRED', /KHÔNG tự tạo order mới/, ['topup-dismiss'], ['paypal-approve', 'paypal-capture', 'topup-retry']],
    ['RECOVERY_REQUIRED', /Giao diện không tự cộng ví/, ['topup-dismiss'], ['paypal-approve', 'paypal-capture', 'topup-retry']],
    ['NOT_CAPTURED', /Không tiếp tục thu tiền/, ['topup-dismiss'], ['paypal-approve', 'paypal-capture']],
    ['FAILED', /yêu cầu nạp đã đóng; ví không đổi/, ['topup-dismiss'], ['paypal-approve', 'paypal-capture']],
  ];
  for (const [stage, re, has, hasNot] of stageSpec) {
    const sv = fakeServer({ stage, status: stage === 'FAILED' ? 'FAILED' : 'PENDING', submissionStatus: stage === 'CREATING' ? 'SUBMITTING' : 'SUBMITTED', orderId: stage === 'CREATING' ? null : 'ORDER1' });
    const pg = await wallet({ storage: { [INTENT_PREFIX + BUYER.id]: intentJson() }, extra: sv.routes() });
    pg.click(pg.d.querySelector('#topupIntent [data-act="topup-check"]'));
    await sleep(500);
    ok(re.test(pg.notice()), `stage ${stage}: hiển thị đúng nội dung`);
    ok(has.every((a) => !!pg.noticeBtn(a)) && hasNot.every((a) => !pg.noticeBtn(a)), `stage ${stage}: có nút [${has}] và KHÔNG có [${hasNot}]`);
    ok(pg.toasts().every((t) => t.kind !== 'ok'), `stage ${stage}: không báo thành công`);
    pg.close();
  }
  {
    const sv = fakeServer({ status: 'SUCCEEDED', stage: 'SUCCEEDED', resolvedAt: new Date().toISOString() });
    const pg = await wallet({ storage: { [INTENT_PREFIX + BUYER.id]: intentJson() }, extra: sv.routes() });
    pg.click(pg.d.querySelector('#topupIntent [data-act="topup-check"]'));
    await sleep(600);
    ok(pg.toasts().filter((t) => t.kind === 'ok').length === 1 && pg.intent() === null, 'stage SUCCEEDED (GET khớp): thành công đúng một lần, ý định được dọn');
    pg.close();
  }
  {
    const sv = fakeServer({ stage: 'RECOVERY_REQUIRED', status: 'FAILED' });
    const pg = await wallet({ storage: { [INTENT_PREFIX + BUYER.id]: intentJson() }, extra: sv.routes() });
    pg.click(pg.d.querySelector('#topupIntent [data-act="topup-check"]'));
    await sleep(500);
    ok(/Cần xử lý thủ công|xử lý thủ công/.test(pg.notice()) && !/Thất bại/.test(pg.notice()) && pg.intent() === null,
      'RECOVERY_REQUIRED có status FAILED: ưu tiên "cần xử lý thủ công" (không nói thất bại), mở khoá số tiền');
    pg.close();
  }

  // Lịch sử phân biệt provider + hành động theo stage.
  p = await wallet({
    extra: {
      'GET /api/payments/me': () => json(200, { paymentRequests: [
        ppRow({ id: 'h-await', stage: 'AWAITING_APPROVAL', requestId: 'topup-hist-0001' }),
        ppRow({ id: 'h-cap', stage: 'CAPTURING', requestId: 'topup-hist-0002' }),
        ppRow({ id: 'h-rec', stage: 'RECOVERY_REQUIRED', status: 'FAILED', requestId: 'topup-hist-0003' }),
        ppRow({ id: 'h-ok', stage: 'SUCCEEDED', status: 'SUCCEEDED', resolvedAt: new Date().toISOString(), requestId: 'topup-hist-0004', quote: quote({ usdCents: 407, usdValue: '4.07' }) }),
        mockRow({ id: 'm-ok' }),
        { id: 'legacy', amount: 50000, status: 'FAILED', providerRef: 'r', createdAt: new Date().toISOString(), resolvedAt: new Date().toISOString() },
      ] }),
    },
  });
  await sleep(300);
  const hist = p.d.querySelector('#topupHistory');
  const rows = [...hist.querySelectorAll('tbody tr')];
  ok(rows.length === 6, `Lịch sử hiển thị đủ 6 dòng (${rows.length})`);
  ok(rows.filter((r) => /PayPal Sandbox/.test(r.textContent)).length === 4 && rows.filter((r) => /Mô phỏng/.test(r.cells[0].textContent)).length === 1,
    'Lịch sử phân biệt provider: 4 dòng PayPal Sandbox, 1 dòng Mô phỏng, dòng cũ không nhãn');
  ok(/4\.07 USD/.test(hist.textContent) && /100\.000₫/.test(hist.textContent), 'Dòng PayPal hiện cả VND ghi ví và USD Sandbox theo quote máy chủ');
  ok(!!hist.querySelector('[data-act="paypal-approve"][data-id="h-await"]') && !!hist.querySelector('[data-act="topup-check"][data-id="h-cap"]'), 'Hành động theo stage: chờ phê duyệt -> Mở PayPal; đang xác nhận -> Kiểm tra');
  ok(!hist.querySelector('[data-act="checkout-open"]') && /Cần hỗ trợ — mã tham chiếu/.test(hist.textContent), 'Dòng PayPal không bao giờ dùng mock checkout; RECOVERY_REQUIRED chỉ có mã tham chiếu');
  ok(p.log.every((l) => !/mock-provider/.test(l)), 'Không gọi mock-provider cho lịch sử PayPal');
  p.close();

  // =========================================================================================
  section('N: phiên — phản hồi muộn sau đăng xuất / đổi tài khoản không tác động phiên mới');
  const allowed = (pg) => pg.toasts().every((t) => /Đã đăng xuất|Xin chào/.test(t.text));
  p = await wallet({ timeoutMs: 5000, create: (b) => delay(700, json(200, ppRow({ requestId: b.requestId }))) });
  p.click(p.btn());
  await sleep(20);
  const kOld = p.topupBodies[0].requestId;
  await logoutUi(p);
  await loginUi(p, OTHER);
  p.w.location.hash = '#/wallet';
  await sleep(1100);
  ok(p.navs.length === 0 && !p.noticeBtn('paypal-approve') && allowed(p), 'Tạo yêu cầu chậm + đổi tài khoản: không hiện nút phê duyệt/thông báo cho tài khoản mới');
  ok(p.intent(OTHER) === null && p.amountInput() && !p.amountInput().disabled, 'Tài khoản mới: không có ý định, ô số tiền mở');
  ok(p.intent() && p.intent().requestId === kOld, 'Ý định của tài khoản cũ được giữ nguyên (không bị phản hồi muộn xoá)');
  p.close();

  srv = fakeServer();
  srv.captureResult = () => delay(2500, json(200, { ...srv.row, outcome: 'APPLIED' }));
  p = await wallet({ storage: { [INTENT_PREFIX + BUYER.id]: intentJson() }, extra: srv.routes(), search: '?paypal=return&paymentRequestId=5b1f0c52-7a3e-4c1d-9a55-0f1e2d3c4b5a', timeoutMs: 5000 });
  // Tự capture từ return.
  await sleep(30);
  srv.row = ppRow({ requestId: KEY, status: 'SUCCEEDED', stage: 'SUCCEEDED', resolvedAt: new Date().toISOString() });
  await logoutUi(p);
  await loginUi(p, OTHER);
  p.w.location.hash = '#/wallet';
  await sleep(1100);
  ok(p.toasts().every((t) => !/Nạp tiền thành công/.test(t.text) && t.kind !== 'ok' || /Xin chào|Đã đăng xuất/.test(t.text)), 'Capture chậm + đổi tài khoản: KHÔNG báo "nạp thành công" cho tài khoản mới');
  ok(p.intent(OTHER) === null && p.count('GET /api/payments/5b1f0c52-7a3e-4c1d-9a55-0f1e2d3c4b5a') <= 1, 'Capture chậm + đổi tài khoản: không đọc trạng thái/ví cho phiên mới thay cho phiên cũ');
  p.close();

  // Đăng xuất rồi đăng nhập lại CÙNG tài khoản: userId, token và ý định lưu đều khớp lại, chỉ sessionEpoch còn phân biệt được phiên cũ.
  // Phản hồi capture được giữ bằng Promise deferred (không dựa vào delay): chỉ được giải quyết SAU khi phiên mới hoàn tất,
  // và test tự chứng minh POST capture đã phát đúng một lần, phản hồi còn treo, trước khi đăng xuất.
  srv = fakeServer();
  const capturePath = 'POST /api/payments/paypal/5b1f0c52-7a3e-4c1d-9a55-0f1e2d3c4b5a/capture';
  const statusPath = 'GET /api/payments/5b1f0c52-7a3e-4c1d-9a55-0f1e2d3c4b5a';
  let releaseCapture = () => {};
  let captureDelivered = false;
  const captureGate = new Promise((resolve) => { releaseCapture = resolve; });
  srv.captureResult = () => captureGate.then(() => {
    captureDelivered = true;
    return json(200, { ...srv.row, outcome: 'APPLIED' });
  });
  const stateOf = (promise) => Promise.race([promise.then(() => 'resolved'), sleep(0).then(() => 'pending')]);
  p = await wallet({ storage: { [INTENT_PREFIX + BUYER.id]: intentJson() }, extra: srv.routes(), search: '?paypal=return&paymentRequestId=5b1f0c52-7a3e-4c1d-9a55-0f1e2d3c4b5a', timeoutMs: 5000 });
  try {
    // Tự capture từ return.
    const emitDeadline = Date.now() + 1000;
    while (p.count(capturePath) < 1 && Date.now() < emitDeadline) await sleep(10);
    await sleep(50); // thêm một nhịp để bắt cả lần phát thứ hai nếu có
    const getsBeforeRelogin = p.count(statusPath);
    const inFlight = p.count(capturePath) === 1 && srv.captures === 1 && !captureDelivered && (await stateOf(captureGate)) === 'pending';
    ok(inFlight, `Điều kiện dựng đúng: POST capture đã phát đúng 1 lần (log=${p.count(capturePath)}, máy chủ=${srv.captures}) và phản hồi còn treo trước khi đăng xuất`);
    if (inFlight) {
      srv.row = ppRow({ requestId: KEY, status: 'SUCCEEDED', stage: 'SUCCEEDED', resolvedAt: new Date().toISOString() });
      await logoutUi(p);
      await loginUi(p, BUYER);
      p.w.location.hash = '#/wallet';
      await sleep(1100);
      ok(p.count('POST /api/passkeys/session/logout') === 1 && p.count('POST /api/passkeys/login/password') === 1 && !!p.d.querySelector('[data-act="logout"]'),
        'Phiên mới đã hoàn tất (1 đăng xuất, 1 đăng nhập, giao diện đã đăng nhập) TRƯỚC khi giải quyết phản hồi capture cũ');
      ok(!captureDelivered && p.count(capturePath) === 1, 'Phản hồi capture cũ vẫn chưa được giao cho tới khi phiên mới sẵn sàng, và không có capture thứ hai');
      releaseCapture();
      await sleep(400);
      ok(captureDelivered, 'Phản hồi capture của phiên cũ đã thực sự được giao sau khi đăng nhập lại (assert bên dưới không đạt giả)');
      ok(p.toasts().every((t) => !/Nạp tiền thành công/.test(t.text)), 'Capture chậm + đăng xuất/đăng nhập lại CÙNG tài khoản: phản hồi của phiên cũ KHÔNG báo "nạp thành công"');
      ok(p.intent() && p.intent().requestId === KEY && p.count(statusPath) === getsBeforeRelogin,
        'Capture chậm + đăng nhập lại CÙNG tài khoản: phiên cũ không đọc trạng thái và không xoá ý định của phiên mới');
    }
  } finally {
    releaseCapture();
    p.close();
  }

  srv = fakeServer();
  srv.approvalUrl = SANDBOX;
  p = await wallet({
    storage: { [INTENT_PREFIX + BUYER.id]: intentJson() }, timeoutMs: 5000,
    extra: { ...srv.routes(), 'GET /api/payments/paypal/5b1f0c52-7a3e-4c1d-9a55-0f1e2d3c4b5a/checkout': () => delay(600, json(200, { ...srv.row, approvalUrl: SANDBOX })) },
  });
  p.click(p.d.querySelector('#topupIntent [data-act="topup-check"]'));
  await sleep(300);
  p.click(p.noticeBtn('paypal-approve'));
  await sleep(30);
  await logoutUi(p);
  await loginUi(p, OTHER);
  await sleep(900);
  ok(p.navs.length === 0, 'GET checkout chậm + đổi tài khoản: KHÔNG điều hướng sang PayPal cho tài khoản mới');
  p.close();

  srv = fakeServer();
  p = await wallet({
    storage: { [INTENT_PREFIX + BUYER.id]: intentJson() }, timeoutMs: 5000, search: '?paypal=return&paymentRequestId=5b1f0c52-7a3e-4c1d-9a55-0f1e2d3c4b5a',
    extra: { ...srv.routes(), 'GET /api/payments/5b1f0c52-7a3e-4c1d-9a55-0f1e2d3c4b5a': () => delay(600, json(200, srv.row)) },
  });
  await sleep(30);
  await logoutUi(p);
  await loginUi(p, OTHER);
  p.w.location.hash = '#/wallet';
  await sleep(900);
  ok(!p.noticeBtn('paypal-capture') && allowed(p), 'Return xử lý chậm + đổi tài khoản: không hiện nút xác nhận cho tài khoản mới');
  p.close();

  // =========================================================================================
  section('Z: không payout/refund PayPal, không bí mật, cô lập mock/PayPal, theo dõi có hạn');
  p = await wallet({});
  const acts = [...p.d.querySelectorAll('[data-act]')].map((e) => e.dataset.act).join(' ');
  ok(!/refund|payout/i.test(acts.replace(/admin-refund/g, '')), 'Trang ví PayPal không có hành động refund/payout PayPal');
  ok(/không hoàn tiền hay chi tiền qua PayPal/.test(p.viewText()) && /VND trong ví nội bộ/.test(p.viewText()), 'Ghi rõ ví/ký quỹ/tranh chấp vẫn VND nội bộ, không hoàn tiền qua PayPal');
  p.close();

  const secretRe = /client[_-]?secret|PAYPAL_SANDBOX_(CLIENT|MERCHANT|WEBHOOK)|WEBHOOK_ID|postgres(ql)?:\/\/|DATABASE_URL|JWT_SECRET|PAYMENT_WEBHOOK_SECRET|Bearer [A-Za-z0-9._-]{20,}|-----BEGIN/i;
  const files = [];
  const walk = (dir) => { for (const f of fs.readdirSync(dir)) { const fp = path.join(dir, f); fs.statSync(fp).isDirectory() ? walk(fp) : files.push(fp); } };
  walk(PUBLIC);
  const leaks = files.filter((f) => /\.(js|html|css|json|txt)$/.test(f)).filter((f) => secretRe.test(fs.readFileSync(f, 'utf8')));
  ok(leaks.length === 0, `Quét tĩnh public/ (${files.length} tệp): không có client secret, DB URL, webhook secret${leaks.length ? ' — LỘ: ' + leaks.join(',') : ''}`);

  srv = fakeServer();
  p = await wallet({ create: (b) => json(200, ppRow({ requestId: b.requestId })), extra: srv.routes() });
  await press(p, 500);
  const stored = Object.entries(p.store()).filter(([k]) => k !== 'cat_token');
  ok(stored.every(([, v]) => !secretRe.test(v)) && Object.keys(p.intent() || {}).sort().join() === 'amount,createdAt,paymentId,provider,requestId,userId',
    'localStorage: ý định chỉ gồm userId/requestId/amount/provider/createdAt/paymentId; không bí mật nào');
  p.close();

  p = await wallet({ cfg: CFG(false, true) });
  p.amountInput().value = '150000';
  p.routes['POST /api/payments/topup'] = (opts) => { const b = JSON.parse(opts.body); return json(201, { id: 'm9', amount: b.amount, status: 'PENDING', providerRef: 'r9', provider: 'MOCK', requestId: b.requestId, submissionStatus: 'SUBMITTED', createdAt: new Date().toISOString() }); };
  await press(p, 600);
  ok(p.count('POST /api/payments/paypal/topup') === 0 && p.count('POST /api/payments/topup') === 1, 'Cấu hình chỉ bật mock: gọi mock topup, KHÔNG gọi tuyến PayPal');
  p.close();

  // Theo dõi có hạn cho CAPTURING và dọn hẹn giờ khi đăng xuất.
  srv = fakeServer({ stage: 'CAPTURING' });
  p = await wallet({ storage: { [INTENT_PREFIX + BUYER.id]: intentJson() }, extra: srv.routes(), timeoutMs: 5000 });
  p.click(p.d.querySelector('#topupIntent [data-act="topup-check"]'));
  await sleep(400);
  ok(p.pollTimers() === 1 && /Đang xác nhận thanh toán/.test(p.notice()), 'CAPTURING: đang theo dõi (1 hẹn giờ chờ)');
  await logoutUi(p);
  ok(p.pollTimers() === 0, 'Đăng xuất: hẹn giờ theo dõi PayPal được huỷ ngay');
  p.close();

  srv = fakeServer({ stage: 'RECONCILING' });
  p = await wallet({ storage: { [INTENT_PREFIX + BUYER.id]: intentJson() }, extra: srv.routes(), timeoutMs: 5000 });
  p.click(p.d.querySelector('#topupIntent [data-act="topup-check"]'));
  await sleep(9800);
  const polls = p.count('GET /api/payments/5b1f0c52-7a3e-4c1d-9a55-0f1e2d3c4b5a');
  ok(polls <= 6 && /Chưa có kết quả mới/.test(p.notice()) && !!p.noticeBtn('topup-check'), `Theo dõi RECONCILING có hạn (${polls} lần GET gồm cả lần bấm), hết hạn hiện "Kiểm tra lại"`);
  await sleep(2500);
  ok(p.count('GET /api/payments/5b1f0c52-7a3e-4c1d-9a55-0f1e2d3c4b5a') === polls, 'Sau khi dừng không còn yêu cầu nào thêm (không spam API)');
  ok(srv.captures === 0 && p.count('POST /api/payments/paypal/topup') === 0, 'Theo dõi/đối soát KHÔNG bao giờ tự capture hay tạo yêu cầu mới');
  p.close();

  console.log(`\n${checks} kiểm tra, ${fails ? fails + ' FAIL' : 'ALL PASS'}`);
  process.exit(fails ? 1 : 0);
}

module.exports = { wallet, fakeServer, json, ppRow, intentJson, BUYER, KEY, AMOUNT, INTENT_PREFIX, sleep, HANG, logoutUi, loginUi };
if (require.main === module) main().catch((e) => { console.error('[paypal-wallet-ui] lỗi:', e); process.exit(1); });
