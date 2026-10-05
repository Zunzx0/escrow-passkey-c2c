/**
 * Kiểm thử giao diện nạp tiền: requestId, ý định chưa rõ kết quả và trạng thái gửi sang cổng (mock).
 *
 * Giống test/ui/payment-error-clarity.js: dựng DOM từ public/index.html, nạp public/js/*.js thật vào jsdom,
 * còn `fetch` do bộ kiểm thử mock — KHÔNG cần máy chủ, DB hay mạng, và không thêm endpoint thử nào. Phản hồi mock
 * bám hợp đồng của POST /api/payments/topup và GET /api/payments/:id (src/routes/payments.js).
 *
 * Phạm vi: chỉ logic giao diện. Không phải bằng chứng Passkey, cổng thanh toán hay PayPal thật.
 *
 * Nhóm kiểm:
 *   R1  Một ý định = một requestId: bấm đúp một POST; timeout rồi thử lại giữ cùng khoá + cùng số tiền.
 *   R2  Tải lại trang phục hồi ý định (cùng khoá); đổi người dùng / đăng xuất không dùng lại khoá cũ; không lưu token.
 *   R3  Số tiền bị khoá khi chưa rõ; chủ động "lần nạp mới" mới tạo khoá mới (có cảnh báo xác nhận).
 *   R4  SUBMITTING không mở cổng và không báo lỗi; SUBMITTED mới mở cổng; SUBMIT_FAILED/503 giữ ý định, thử lại cùng khoá.
 *   R5  FAILED/SUCCEEDED không mở cổng; HTTP 200 / idempotentReplay không phải bằng chứng thành công.
 *   R6  200 mà thân hỏng (HTML, rỗng, mảng, sai số tiền, sai trạng thái) không bị coi là thành công.
 *   R7  Theo dõi có hạn, giãn dần, dừng khi rời trang / đăng xuất / kết thúc; có nút kiểm tra lại.
 *   R8  Kiểm tra trạng thái theo requestId; lịch sử chỉ cho mở cổng khi SUBMITTED.
 *
 * Cách chạy (cần jsdom — KHÔNG nằm trong package.json; cài không ghi vào package.json):
 *   cd cho-an-tam
 *   npm i --no-save jsdom
 *   node test/ui/topup-request-id-ui.js
 * Cần Node >= 23. Không đọc .env, không chạm DB, không kết nối mạng. Mất khoảng 40 giây (có chờ theo dõi thật).
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
const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{8,100}$/;

let fails = 0;
let checks = 0;
const ok = (c, m) => { checks++; console.log(`  ${c ? '✅' : '❌'} ${m}`); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const section = (t) => console.log(`\n${t}`);

const BUYER = { id: 'u-buyer', username: 'mua', displayName: 'Mua Thử', role: 'BUYER', accountStatus: 'ACTIVE' };
const OTHER = { id: 'u-other', username: 'khac', displayName: 'Người Khác', role: 'BUYER', accountStatus: 'ACTIVE' };
const WALLET = { availableBalance: 5000000, lockedBalance: 0, pendingTopupTotal: 0 };

const json = (status, body) => ({ status, body });
const html = (status, text) => ({ status, text, type: 'text/html' });
const HANG = Symbol('hang');

/** Dòng yêu cầu nạp đúng định dạng serializePaymentRequest của máy chủ. */
const row = (o = {}) => ({
  id: 'p1', amount: 150000, status: 'PENDING', providerRef: 'ref1', resolvedBy: null,
  createdAt: new Date().toISOString(), resolvedAt: null, requestId: o.requestId || null,
  submissionStatus: 'SUBMITTED', ...o,
});

async function openPage({ hash = '#/wallet', user = BUYER, routes = {}, storage = {}, timeoutMs = TIMEOUT_MS }) {
  const html0 = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8').replace(/<script\b[^>]*\bsrc=[^>]*><\/script>/g, '');
  const log = [];
  const pending = new Map(); // id hẹn giờ -> số ms
  const table = { ...routes };
  const dom = new JSDOM(html0, {
    url: `${ORIGIN}/`,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    beforeParse(w) {
      w.ENCLAVE_API_TIMEOUT_MS = timeoutMs;
      // Theo dõi các hẹn giờ đang chờ (để kiểm tra việc huỷ theo dõi thật sự dọn hẹn giờ).
      const realSet = w.setTimeout.bind(w);
      const realClear = w.clearTimeout.bind(w);
      w.setTimeout = (fn, ms, ...a) => { const id = realSet((...x) => { pending.delete(id); fn(...x); }, ms, ...a); pending.set(id, ms); return id; };
      w.clearTimeout = (id) => { pending.delete(id); realClear(id); };
      w.scrollTo = () => {};
      for (const [k, v] of Object.entries(storage)) w.localStorage.setItem(k, v);
      w.localStorage.setItem('cat_token', 'tok-test');
      w.localStorage.setItem('cat_user', JSON.stringify(user));
      w.location.hash = hash;
      w.fetch = (url, opts = {}) => new Promise((resolve, reject) => {
        const u = new URL(url, ORIGIN);
        const key = `${opts.method || 'GET'} ${u.pathname}`;
        log.push(key);
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
  await sleep(600);
  const w = dom.window;
  const d = w.document;
  return {
    w, d, log, routes: table,
    toasts: () => [...d.querySelectorAll('#toasts .toast')].map((t) => ({ kind: t.className.replace('toast', '').trim(), text: t.textContent.trim() })),
    clearToasts: () => { d.querySelector('#toasts').innerHTML = ''; },
    click: (el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true })),
    count: (key) => log.filter((l) => l === key).length,
    store: () => Object.fromEntries(Array.from({ length: w.localStorage.length }, (_, i) => w.localStorage.key(i)).map((k) => [k, w.localStorage.getItem(k)])),
    intentKey: (u = BUYER) => INTENT_PREFIX + u.id,
    amountInput: () => d.querySelector('#topupAmount'),
    btn: () => d.querySelector('.card-body [data-act="topup-create"]'),
    notice: () => (d.querySelector('#topupIntent') || { textContent: '' }).textContent.replace(/\s+/g, ' ').trim(),
    modalText: () => (d.querySelector('.modal') || { textContent: '' }).textContent.replace(/\s+/g, ' ').trim(),
    pollTimers: () => [...pending.values()].filter((ms) => [1000, 1500, 2250, 3400].includes(ms)).length,
    close: () => w.close(),
  };
}

const delay = (ms, value) => new Promise((r) => setTimeout(() => r(value), ms));

/** Đăng xuất bằng nút trên giao diện. */
async function logoutUi(p) {
  p.routes['POST /api/passkeys/session/logout'] = () => json(200, { ok: true });
  p.click(p.d.querySelector('[data-act="logout"]'));
  await sleep(60);
}

/** Đăng nhập lại bằng mật khẩu qua giao diện (mock): có thể là cùng tài khoản hoặc tài khoản khác. */
async function loginUi(p, user) {
  p.routes['POST /api/passkeys/login/password'] = () => json(200, { token: 'tok-' + user.id, user });
  p.click(p.d.querySelector('[data-act="open-auth"]'));
  await sleep(150);
  p.d.querySelector('#loginUsername').value = user.username;
  p.d.querySelector('#loginPassword').value = 'mat-khau-gia';
  p.click(p.d.querySelector('[data-act="do-login-password"]'));
  await sleep(500);
}

const baseRoutes = (user = BUYER) => ({
  'GET /api/users/me': () => json(200, { user, wallet: WALLET }),
  'GET /api/users/me/seller-request': () => json(200, { request: null }),
  'GET /api/listings/meta': () => json(200, { categories: [], conditions: [], locations: [] }),
  'GET /api/wallets/me': () => json(200, WALLET),
  'GET /api/transactions': () => json(200, { transactions: [] }),
  'GET /api/payments/me': () => json(200, { paymentRequests: [] }),
  'GET /api/notifications': () => json(200, { notifications: [], unreadCount: 0 }),
  'GET /api/wallets/me/entries': () => json(200, { entries: [] }),
  'GET /mock-provider/checkout/ref1': () => json(200, { providerRef: 'ref1', amount: 150000, status: 'PENDING' }),
});

/** Trang ví với bộ ghi các thân POST /api/payments/topup. `topup(body, n)` trả phản hồi cho lần gọi thứ n. */
async function wallet({ topup, extra = {}, user = BUYER, storage = {}, amount = '150000', timeoutMs }) {
  const bodies = [];
  const routes = {
    ...baseRoutes(user),
    'POST /api/payments/topup': (opts) => {
      const body = JSON.parse(opts.body);
      bodies.push(body);
      return topup(body, bodies.length);
    },
    ...extra,
  };
  const p = await openPage({ user, routes, storage, timeoutMs });
  p.bodies = bodies;
  if (p.amountInput() && !p.amountInput().disabled) p.amountInput().value = amount;
  return p;
}
const press = async (p, wait = 300) => { p.click(p.btn()); await sleep(wait); };

async function main() {
  // ------------------------------------------------------------------------------------------
  section('R1: một ý định = một requestId; bấm đúp và thử lại giữ cùng khoá');
  let p = await wallet({ topup: () => HANG });
  p.click(p.btn());
  await sleep(40);
  p.click(p.btn());
  p.click(p.btn());
  await sleep(40);
  ok(p.bodies.length === 1, 'Bấm đúp / bấm ba lần chỉ gửi MỘT yêu cầu POST');
  const key1 = p.bodies[0] && p.bodies[0].requestId;
  ok(REQUEST_ID_RE.test(String(key1)), `POST kèm requestId đúng định dạng máy chủ (8–100 ký tự [A-Za-z0-9._:-]): ${key1}`);
  ok(p.bodies[0].amount === 150000 && Number.isInteger(p.bodies[0].amount), 'POST kèm amount là số nguyên 150000 (kiểu số, không phải chuỗi)');
  const stored = JSON.parse(p.store()[p.intentKey()] || 'null');
  ok(!!stored && stored.requestId === key1 && stored.amount === 150000 && stored.userId === BUYER.id,
    'Ý định được lưu TRƯỚC khi có phản hồi (gắn với id người dùng)');
  ok(!/tok-test|token|secret/i.test(p.store()[p.intentKey()] || ''), 'Bản lưu ý định không chứa token hay bí mật');
  await sleep(TIMEOUT_MS + 300); // chờ hết hạn: timeout, kết quả chưa rõ
  ok(/chưa rõ/i.test(p.notice()) && p.toasts().every((t) => t.kind !== 'ok'), 'Timeout: báo "chưa rõ", không báo thành công');
  ok(!p.btn().disabled && /Tiếp tục thanh toán/.test(p.btn().textContent), 'Timeout: nút bật lại, nhãn như cũ');
  ok(p.amountInput().disabled && p.amountInput().value === '150000', 'Timeout: ô số tiền bị khoá ở 150000');
  p.routes['POST /api/payments/topup'] = (opts) => { const b = JSON.parse(opts.body); p.bodies.push(b); return json(201, row({ requestId: b.requestId })); };
  await press(p, 700);
  ok(p.bodies.length === 2 && p.bodies[1].requestId === key1 && p.bodies[1].amount === 150000,
    'Thử lại sau timeout dùng CÙNG requestId và CÙNG số tiền');
  ok(!!p.d.querySelector('.modal [data-act="checkout-pay"]'), 'Phản hồi SUBMITTED hợp lệ -> mở cổng thanh toán');
  ok(p.store()[p.intentKey()] === undefined, 'Đã có yêu cầu SUBMITTED -> ý định được xoá');
  ok(!p.amountInput().disabled, 'Ý định kết thúc -> ô số tiền mở khoá lại');
  p.close();

  // ------------------------------------------------------------------------------------------
  section('R2: tải lại phục hồi ý định; đổi người dùng / đăng xuất không dùng lại khoá');
  p = await wallet({ topup: () => HANG });
  await press(p, TIMEOUT_MS + 400);
  const keyA = p.bodies[0].requestId;
  const snapshot = p.store();
  p.close();

  let r2 = await wallet({
    storage: snapshot,
    topup: (b) => json(201, row({ requestId: b.requestId })),
  });
  ok(r2.amountInput().disabled && r2.amountInput().value === '150000', 'Sau khi tải lại: số tiền của ý định cũ được khôi phục và khoá');
  ok(/Chưa rõ/.test(r2.notice()) && /Kiểm tra trạng thái/.test(r2.notice()), 'Sau khi tải lại: hiện cảnh báo "chưa rõ" kèm nút kiểm tra trạng thái');
  await press(r2, 600);
  ok(r2.bodies.length === 1 && r2.bodies[0].requestId === keyA && r2.bodies[0].amount === 150000, 'Gửi lại sau khi tải lại dùng đúng khoá cũ');
  r2.close();

  // Người dùng khác trên cùng trình duyệt: không thấy, không dùng khoá của người trước.
  let r3 = await wallet({
    user: OTHER, storage: snapshot, amount: '200000',
    topup: (b) => json(201, row({ requestId: b.requestId, amount: b.amount })),
  });
  ok(!r3.amountInput().disabled && r3.notice() === '', 'Người dùng khác: không thấy ý định của người trước');
  await press(r3, 600);
  ok(r3.bodies.length === 1 && r3.bodies[0].requestId !== keyA && r3.bodies[0].amount === 200000,
    'Người dùng khác gửi với khoá MỚI và số tiền của chính họ (không dùng lại khoá của người trước)');
  r3.close();

  // Đăng xuất: dừng theo dõi và bỏ trạng thái trong bộ nhớ; không cuộc gọi thừa.
  let r4 = await wallet({
    topup: (b) => json(200, row({ requestId: b.requestId, submissionStatus: 'SUBMITTING' })),
    extra: { 'GET /api/payments/p1': () => json(200, row({ submissionStatus: 'SUBMITTING' })), 'POST /api/passkeys/session/logout': () => json(200, { ok: true }) },
  });
  await press(r4, 300);
  ok(/Đang gửi yêu cầu nạp/.test(r4.notice()), 'SUBMITTING: hiện "đang gửi" (chuẩn bị kiểm đăng xuất)');
  const logoutBtn = r4.d.querySelector('[data-act="logout"]');
  ok(!!logoutBtn, 'Có nút đăng xuất');
  r4.click(logoutBtn);
  const pollsAtLogout = r4.count('GET /api/payments/p1');
  await sleep(3000);
  ok(r4.count('GET /api/payments/p1') === pollsAtLogout, `Đăng xuất dừng theo dõi (không còn GET /payments/p1 nào sau đó; ${pollsAtLogout} lần trước đó)`);
  ok(r4.w.localStorage.getItem('cat_token') === null, 'Đăng xuất xoá token');
  r4.close();

  // ------------------------------------------------------------------------------------------
  section('R3: số tiền bị khoá khi chưa rõ; "lần nạp mới" cần xác nhận rồi mới tạo khoá mới');
  p = await wallet({ topup: () => HANG });
  await press(p, TIMEOUT_MS + 400);
  const lockedKey = p.bodies[0].requestId;
  p.amountInput().disabled = false; // giả lập người dùng cố ép sửa ô số tiền
  p.amountInput().value = '999000';
  p.routes['POST /api/payments/topup'] = (opts) => { const b = JSON.parse(opts.body); p.bodies.push(b); return HANG; };
  await press(p, 150);
  ok(p.bodies.length === 2 && p.bodies[1].requestId === lockedKey && p.bodies[1].amount === 150000,
    'Cố sửa số tiền rồi gửi: vẫn đi với số tiền CŨ + khoá cũ (không bao giờ khác số tiền cùng khoá)');
  await sleep(TIMEOUT_MS + 300);
  p.click(p.d.querySelector('[data-act="topup-preset"]'));
  ok(p.amountInput().value === '150000', 'Bấm số tiền gợi ý khi đang khoá: không đổi số tiền');
  p.click(p.d.querySelector('[data-act="topup-new"]'));
  await sleep(100);
  ok(/chưa rõ kết quả/.test(p.modalText()) && /hai lần/.test(p.modalText()), 'Bắt đầu lần mới: có cảnh báo rõ (có thể đã được tạo / nạp hai lần)');
  ok(p.store()[p.intentKey()] !== undefined, 'Chưa xác nhận: ý định cũ vẫn còn (không tạo yêu cầu mới âm thầm)');
  p.click(p.d.querySelector('.modal-foot [data-act="modal-close"]'));
  await sleep(100);
  ok(p.store()[p.intentKey()] !== undefined && p.amountInput().disabled, 'Chọn "Giữ lần nạp cũ": không đổi gì');
  p.click(p.d.querySelector('[data-act="topup-new"]'));
  await sleep(100);
  p.click(p.d.querySelector('[data-act="topup-new-confirm"]'));
  await sleep(100);
  ok(!p.amountInput().disabled && p.store()[p.intentKey()] === undefined, 'Xác nhận: ý định cũ bị bỏ, ô số tiền mở khoá');
  p.amountInput().value = '300000';
  p.routes['POST /api/payments/topup'] = (opts) => { const b = JSON.parse(opts.body); p.bodies.push(b); return json(201, row({ requestId: b.requestId, amount: b.amount })); };
  await press(p, 600);
  const fresh = p.bodies[2];
  ok(fresh.requestId !== lockedKey && fresh.amount === 300000 && REQUEST_ID_RE.test(fresh.requestId),
    'Lần nạp mới: khoá MỚI và số tiền mới');
  p.close();

  // ------------------------------------------------------------------------------------------
  section('R4: SUBMITTING / SUBMITTED / SUBMIT_FAILED / 503');
  let polls = 0;
  p = await wallet({
    topup: (b) => json(200, row({ requestId: b.requestId, submissionStatus: 'SUBMITTING', idempotentReplay: true })),
    extra: {
      'GET /api/payments/p1': () => { polls++; return json(200, row({ submissionStatus: polls >= 2 ? 'SUBMITTED' : 'SUBMITTING' })); },
    },
  });
  await press(p, 400);
  ok(/Đang gửi yêu cầu nạp/.test(p.notice()) && /không phải lỗi/.test(p.notice()), 'SUBMITTING: hiện "đang gửi", nói rõ không phải lỗi');
  ok(p.toasts().every((t) => t.kind !== 'err' && t.kind !== 'ok'), 'SUBMITTING: không có thông báo lỗi hay thành công');
  ok(!p.d.querySelector('.modal') && p.count('GET /mock-provider/checkout/ref1') === 0, 'SUBMITTING: KHÔNG mở cổng thanh toán');
  ok(p.store()[p.intentKey()] !== undefined, 'SUBMITTING: ý định được giữ');
  await sleep(3200); // lượt theo dõi 1 (1s) = SUBMITTING, lượt 2 (+1,5s) = SUBMITTED
  ok(p.count('GET /api/payments/p1') === 2, `Theo dõi giãn dần: 2 lượt hỏi trạng thái (nhận ${p.count('GET /api/payments/p1')})`);
  ok(!!p.d.querySelector('.modal [data-act="checkout-pay"]') && p.count('GET /mock-provider/checkout/ref1') === 1,
    'Khi chuyển sang SUBMITTED mới mở cổng thanh toán (đúng một lần)');
  ok(p.store()[p.intentKey()] === undefined && p.notice() === '', 'SUBMITTED: ý định và thông báo được dọn');
  p.close();

  // SUBMIT_FAILED trả về trong thân 200: giữ ý định, thử lại cùng khoá.
  let attempt = 0;
  p = await wallet({
    topup: (b) => {
      attempt++;
      return attempt === 1 ? json(200, row({ requestId: b.requestId, submissionStatus: 'SUBMIT_FAILED' })) : json(200, row({ requestId: b.requestId, idempotentReplay: true }));
    },
  });
  await press(p, 400);
  ok(/chưa gửi được sang cổng/.test(p.notice()) && /Thử lại cùng yêu cầu/.test(p.notice()), 'SUBMIT_FAILED: báo đã lưu nhưng chưa gửi được, có nút thử lại');
  ok(!p.d.querySelector('.modal') && p.count('GET /mock-provider/checkout/ref1') === 0, 'SUBMIT_FAILED: không mở cổng');
  const failKey = p.bodies[0].requestId;
  p.click(p.d.querySelector('#topupIntent [data-act="topup-retry"]'));
  await sleep(600);
  ok(p.bodies.length === 2 && p.bodies[1].requestId === failKey, 'Thử lại SUBMIT_FAILED dùng CÙNG khoá');
  ok(!!p.d.querySelector('.modal [data-act="checkout-pay"]'), 'Thử lại thành công (SUBMITTED) -> mở cổng');
  p.close();

  // 503 PROVIDER_UNAVAILABLE: yêu cầu đã được lưu; giữ ý định, thử lại cùng khoá.
  attempt = 0;
  p = await wallet({
    topup: (b) => {
      attempt++;
      return attempt === 1
        ? json(503, { error: 'PROVIDER_UNAVAILABLE', message: 'Cổng thanh toán tạm thời không nhận yêu cầu...', requestId: 'srv-1' })
        : json(200, row({ requestId: b.requestId, idempotentReplay: true }));
    },
  });
  await press(p, 400);
  const t503 = p.toasts();
  ok(t503.length === 1 && /đã được lưu, chưa bị mất/.test(t503[0].text), `503: thông báo nói yêu cầu đã được lưu, chưa mất (“${(t503[0] || {}).text || ''}”)`);
  ok(/chưa gửi được sang cổng/.test(p.notice()) && p.store()[p.intentKey()] !== undefined, '503: giữ ý định và hiện nút thử lại');
  const key503 = p.bodies[0].requestId;
  await press(p, 600);
  ok(p.bodies.length === 2 && p.bodies[1].requestId === key503, '503 rồi thử lại: CÙNG khoá');
  ok(!!p.d.querySelector('.modal [data-act="checkout-pay"]'), '503 rồi thử lại thành công -> mở cổng');
  p.close();

  // ------------------------------------------------------------------------------------------
  section('R5: FAILED / SUCCEEDED không mở cổng; HTTP 200 và idempotentReplay không phải bằng chứng thành công');
  p = await wallet({
    topup: (b) => json(200, row({ requestId: b.requestId, status: 'FAILED', resolvedAt: new Date().toISOString(), idempotentReplay: true })),
    extra: { 'GET /api/payments/p1': () => json(200, row({ status: 'FAILED', requestId: (p.bodies[0] || {}).requestId, resolvedAt: new Date().toISOString() })) },
  });
  await press(p, 700);
  const tf = p.toasts();
  ok(tf.some((t) => t.kind === 'err' && /đã thất bại/.test(t.text)) && tf.every((t) => t.kind !== 'ok'), 'FAILED: báo thất bại, ví không đổi, không có thông báo thành công');
  ok(!p.d.querySelector('.modal') && p.count('GET /mock-provider/checkout/ref1') === 0, 'FAILED: không mở cổng');
  ok(p.store()[p.intentKey()] === undefined, 'FAILED: ý định kết thúc, được xoá');
  p.close();

  // Thân POST nói SUCCEEDED nhưng GET (máy chủ) nói vẫn PENDING: KHÔNG được báo thành công.
  p = await wallet({
    topup: (b) => json(200, row({ requestId: b.requestId, status: 'SUCCEEDED', idempotentReplay: true })),
    extra: { 'GET /api/payments/p1': () => json(200, row({ status: 'PENDING', requestId: (p.bodies[0] || {}).requestId })) },
  });
  await press(p, 700);
  ok(p.toasts().every((t) => !/Nạp tiền thành công/.test(t.text) && t.kind !== 'ok'), 'POST nói SUCCEEDED nhưng máy chủ (GET) nói PENDING -> KHÔNG báo thành công');
  ok(!p.d.querySelector('.modal') && /Chưa xác nhận/.test(p.notice()), 'SUCCEEDED trong thân POST mà máy chủ nói khác: không mở cổng, hiện "chưa xác nhận"');
  p.close();

  // SUCCEEDED được máy chủ xác nhận bằng GET: báo thành công một lần, không mở cổng.
  let walletReads = 0;
  p = await wallet({
    topup: (b) => json(200, row({ requestId: b.requestId, status: 'SUCCEEDED', resolvedBy: 'WEBHOOK', idempotentReplay: true })),
    extra: {
      'GET /api/payments/p1': () => json(200, row({ status: 'SUCCEEDED', resolvedBy: 'WEBHOOK', requestId: (p.bodies[0] || {}).requestId, resolvedAt: new Date().toISOString() })),
      'GET /api/wallets/me': () => { walletReads++; return json(200, WALLET); },
    },
  });
  const before = walletReads;
  await press(p, 800);
  ok(p.toasts().filter((t) => t.kind === 'ok' && /Nạp tiền thành công/.test(t.text)).length === 1, 'SUCCEEDED được máy chủ xác nhận: đúng MỘT thông báo thành công');
  ok(!p.d.querySelector('.modal') && p.count('GET /mock-provider/checkout/ref1') === 0, 'SUCCEEDED: không mở cổng');
  ok(walletReads > before, 'SUCCEEDED: ví được đọc lại từ máy chủ (không tự cộng ở giao diện)');
  p.close();

  // ------------------------------------------------------------------------------------------
  section('R6: HTTP 200 mà thân hỏng không phải thành công');
  const malformed = [
    ['HTML', () => html(200, '<html><body>Welcome to nginx</body></html>')],
    ['thân rỗng', () => html(200, '')],
    ['mảng', () => json(200, [])],
    ['null', () => json(200, null)],
    ['object rỗng', () => json(200, {})],
    ['sai số tiền', (b) => json(201, row({ requestId: b.requestId, amount: 1 }))],
    ['sai requestId', () => json(201, row({ requestId: 'khac-hoan-toan-12345' }))],
    ['trạng thái lạ', (b) => json(201, row({ requestId: b.requestId, status: 'DONE' }))],
    ['thiếu providerRef', (b) => json(201, row({ requestId: b.requestId, providerRef: '' }))],
    ['thiếu submissionStatus', (b) => { const r = row({ requestId: b.requestId }); delete r.submissionStatus; return json(201, r); }],
  ];
  for (const [label, make] of malformed) {
    p = await wallet({ topup: make });
    await press(p, 600);
    const t = p.toasts();
    ok(t.every((x) => x.kind !== 'ok') && !p.d.querySelector('.modal') && p.count('GET /mock-provider/checkout/ref1') === 0
      && p.store()[p.intentKey()] !== undefined && /Chưa rõ/.test(p.notice()),
    `200 ${label}: không thành công, không mở cổng, giữ ý định, báo "chưa rõ"`);
    p.close();
  }

  // ------------------------------------------------------------------------------------------
  section('R7: theo dõi có hạn, giãn dần, dừng đúng lúc, có nút kiểm tra lại');
  const keyOf = () => (p.bodies[0] || {}).requestId; // máy chủ thật trả đúng requestId của dòng khi đọc lại
  p = await wallet({
    topup: (b) => json(200, row({ requestId: b.requestId, submissionStatus: 'SUBMITTING' })),
    extra: { 'GET /api/payments/p1': () => json(200, row({ requestId: keyOf(), submissionStatus: 'SUBMITTING' })) },
  });
  const t0 = Date.now();
  await press(p, 300);
  await sleep(9000);
  const n = p.count('GET /api/payments/p1');
  ok(n === 4, `Theo dõi dừng sau đúng 4 lượt, không vòng lặp vô hạn (nhận ${n} lượt trong ${Math.round((Date.now() - t0) / 100) / 10}s)`);
  ok(/Chưa có kết quả mới/.test(p.notice()) && !!p.d.querySelector('#topupIntent [data-act="topup-check"]'), 'Hết thời gian theo dõi: hiện nút "Kiểm tra lại"');
  ok(!p.d.querySelector('.modal'), 'Hết thời gian theo dõi: vẫn không mở cổng');
  await sleep(2500);
  ok(p.count('GET /api/payments/p1') === n, 'Sau khi dừng không còn yêu cầu nào thêm (không spam API)');
  p.routes['GET /api/payments/p1'] = () => json(200, row({ requestId: keyOf() }));
  p.click(p.d.querySelector('#topupIntent [data-act="topup-check"]'));
  await sleep(700);
  ok(p.count('GET /api/payments/p1') === n + 1 && !!p.d.querySelector('.modal [data-act="checkout-pay"]'),
    'Bấm "Kiểm tra lại": đúng MỘT yêu cầu; nếu đã SUBMITTED thì mở cổng');
  p.close();

  // Rời trang ví khi đang theo dõi: dừng ngay.
  p = await wallet({
    topup: (b) => json(200, row({ requestId: b.requestId, submissionStatus: 'SUBMITTING' })),
    extra: { 'GET /api/payments/p1': () => json(200, row({ submissionStatus: 'SUBMITTING' })) },
  });
  await press(p, 1300); // lượt 1 đã chạy (ở 1s)
  const before2 = p.count('GET /api/payments/p1');
  p.w.location.hash = '#/';
  await sleep(6500);
  ok(before2 === 1 && p.count('GET /api/payments/p1') === 1, `Rời trang ví: dừng theo dõi (chỉ ${p.count('GET /api/payments/p1')} lượt, trước đó ${before2})`);
  p.close();

  // ------------------------------------------------------------------------------------------
  section('R8: kiểm tra trạng thái theo requestId; lịch sử chỉ mở cổng khi SUBMITTED');
  // Chưa biết id: tìm theo requestId trong danh sách của chính mình.
  let listed = null;
  p = await wallet({
    topup: () => HANG,
    extra: { 'GET /api/payments/me': () => json(200, { paymentRequests: listed ? [listed] : [] }) },
  });
  await press(p, TIMEOUT_MS + 400);
  const ck = p.bodies[0].requestId;
  p.click(p.d.querySelector('#topupIntent [data-act="topup-check"]'));
  await sleep(400);
  ok(/Chưa thấy yêu cầu nạp nào/.test(p.notice()) && /Thử lại cùng yêu cầu/.test(p.notice()), 'Không có dòng nào khớp requestId: "chưa thấy", đề nghị gửi lại cùng yêu cầu (an toàn)');
  ok(ck !== undefined && p.store()[p.intentKey()] !== undefined, 'Không tìm thấy: ý định vẫn được giữ để gửi lại cùng khoá');
  p.close();

  p = await wallet({
    topup: () => HANG,
    extra: { 'GET /api/payments/me': () => json(200, { paymentRequests: listed ? [listed] : [] }) },
  });
  await press(p, TIMEOUT_MS + 400);
  const ck2 = p.bodies[0].requestId;
  listed = row({ requestId: ck2 });
  p.click(p.d.querySelector('#topupIntent [data-act="topup-check"]'));
  await sleep(600);
  ok(!!p.d.querySelector('.modal [data-act="checkout-pay"]'), 'Kiểm tra trạng thái thấy dòng khớp requestId, đã SUBMITTED -> mở cổng');
  ok(p.store()[p.intentKey()] === undefined, 'Tìm thấy và đã SUBMITTED -> ý định kết thúc');
  p.close();

  // Lịch sử theo submissionStatus.
  p = await wallet({
    topup: () => HANG,
    extra: {
      'GET /api/payments/me': () => json(200, { paymentRequests: [
        row({ id: 'h1', providerRef: 'r1', submissionStatus: 'SUBMITTED' }),
        row({ id: 'h2', providerRef: 'r2', submissionStatus: 'SUBMITTING' }),
        row({ id: 'h3', providerRef: 'r3', submissionStatus: 'SUBMIT_FAILED', requestId: 'khong-trung-khoa-1234' }),
        row({ id: 'h4', providerRef: 'r4', status: 'FAILED' }),
      ] }),
    },
  });
  await sleep(300);
  const histOpen = [...p.d.querySelectorAll('#topupHistory [data-act="checkout-open"]')].map((b) => b.dataset.id);
  ok(histOpen.length === 1 && histOpen[0] === 'h1', 'Lịch sử: CHỈ dòng SUBMITTED có nút "Mở lại cổng thanh toán"');
  const histText = p.d.querySelector('#topupHistory').textContent;
  ok(/Đang gửi sang cổng thanh toán/.test(histText) && /hệ thống sẽ tự gửi lại/.test(histText), 'Lịch sử: SUBMITTING báo đang gửi; SUBMIT_FAILED báo sẽ tự gửi lại (không có nút mở cổng)');
  p.close();

  // ------------------------------------------------------------------------------------------
  section('R9: phản hồi đến chậm sau khi đăng xuất / đổi tài khoản không được tác động vào phiên mới');
  const slowSubmitted = (ms) => (b) => delay(ms, json(201, row({ requestId: b.requestId })));
  const allowedToasts = (p) => p.toasts().every((t) => /Đã đăng xuất|Xin chào/.test(t.text));

  // R9.1: POST chậm + đăng xuất.
  p = await wallet({ timeoutMs: 5000, topup: slowSubmitted(250) });
  p.click(p.btn());
  await sleep(20);
  await logoutUi(p);
  await sleep(600);
  ok(p.w.localStorage.getItem('cat_token') === null, 'Đã đăng xuất (token đã xoá)');
  ok(!p.d.querySelector('.modal') && p.count('GET /mock-provider/checkout/ref1') === 0,
    'POST SUBMITTED đến sau đăng xuất: KHÔNG mở cổng thanh toán, không gọi checkout');
  ok(allowedToasts(p), `Phản hồi cũ không sinh thông báo nào cho phiên mới (${JSON.stringify(p.toasts().map((t) => t.text))})`);
  ok(!!p.store()[p.intentKey()], 'Phản hồi cũ không xoá ý định chưa rõ của tài khoản');
  p.close();

  // R9.2: POST chậm + đăng xuất rồi đăng nhập lại CÙNG tài khoản (không chỉ so userId).
  p = await wallet({ timeoutMs: 5000, topup: slowSubmitted(700) });
  p.click(p.btn());
  await sleep(20);
  const keySame = p.bodies[0].requestId;
  await logoutUi(p);
  await loginUi(p, BUYER);
  p.w.location.hash = '#/wallet';
  await sleep(1000);
  ok(!p.d.querySelector('.modal') && p.count('GET /mock-provider/checkout/ref1') === 0,
    'Đăng xuất rồi đăng nhập lại cùng tài khoản: phản hồi POST cũ KHÔNG mở cổng');
  ok(allowedToasts(p), 'Cùng tài khoản đăng nhập lại: phản hồi cũ không sinh thông báo');
  const keptSame = JSON.parse(p.store()[p.intentKey()] || 'null');
  ok(!!keptSame && keptSame.requestId === keySame, 'Ý định của chính tài khoản đó nguyên vẹn (không bị phản hồi cũ xoá)');
  ok(p.amountInput() && p.amountInput().disabled && /Chưa rõ/.test(p.notice()), 'Trang ví của phiên mới hiện đúng trạng thái "chưa rõ" của ý định, không bị phản hồi cũ đổi');
  p.close();

  // R9.3: POST chậm + đổi sang tài khoản khác. Chính sách: không dùng chéo; không xoá ý định của người khác.
  p = await wallet({ timeoutMs: 5000, topup: slowSubmitted(700) });
  p.click(p.btn());
  await sleep(20);
  const keyA2 = p.bodies[0].requestId;
  await logoutUi(p);
  await loginUi(p, OTHER);
  p.w.location.hash = '#/wallet';
  await sleep(1000);
  ok(!p.d.querySelector('.modal') && p.count('GET /mock-provider/checkout/ref1') === 0,
    'Đổi tài khoản: phản hồi POST cũ KHÔNG mở cổng cho tài khoản mới');
  ok(allowedToasts(p), 'Đổi tài khoản: phản hồi cũ không sinh thông báo cho tài khoản mới');
  ok(p.store()[p.intentKey(OTHER)] === undefined && p.notice() === '' && !p.amountInput().disabled,
    'Tài khoản mới: không có ý định, không có thông báo, ô số tiền không bị khoá');
  const snapAfterSwitch = p.store();
  ok(JSON.parse(snapAfterSwitch[p.intentKey()] || 'null') && JSON.parse(snapAfterSwitch[p.intentKey()]).requestId === keyA2,
    'Chính sách: ý định của tài khoản cũ được GIỮ (không tự xoá) để họ phục hồi khi quay lại');
  p.close();
  // Tài khoản cũ quay lại: phục hồi đúng ý định; không bao giờ dùng chéo cho tài khoản khác.
  p = await wallet({ storage: snapAfterSwitch, topup: (b) => json(201, row({ requestId: b.requestId })) });
  ok(p.amountInput().disabled && p.amountInput().value === '150000' && /Chưa rõ/.test(p.notice()),
    'Tài khoản cũ quay lại: ý định được phục hồi (số tiền khoá, báo "chưa rõ")');
  await press(p, 600);
  ok(p.bodies.length === 1 && p.bodies[0].requestId === keyA2, 'Tài khoản cũ gửi lại với đúng khoá của mình');
  p.close();
  p = await wallet({ storage: snapAfterSwitch, user: OTHER, topup: (b) => json(201, row({ requestId: b.requestId })) });
  await press(p, 600);
  ok(p.bodies.length === 1 && p.bodies[0].requestId !== keyA2, 'Tài khoản khác trên cùng trình duyệt không bao giờ dùng khoá của người kia');
  p.close();

  // R9.4: GET kiểm tra chậm + đổi tài khoản.
  let slowNext = false;
  p = await wallet({
    timeoutMs: 5000, topup: () => HANG,
    extra: {
      'GET /api/payments/me': () => {
        if (!slowNext) return json(200, { paymentRequests: [] });
        slowNext = false; // chỉ lần gọi của "Kiểm tra trạng thái" chậm và có dòng khớp
        return delay(700, json(200, { paymentRequests: [row({ requestId: (p.bodies[0] || {}).requestId })] }));
      },
    },
  });
  p.w.ENCLAVE_API_TIMEOUT_MS = 200;
  await press(p, 400); // POST treo -> hết hạn -> chưa rõ
  p.w.ENCLAVE_API_TIMEOUT_MS = 5000;
  const keyChk = p.bodies[0].requestId;
  p.clearToasts(); // bỏ thông báo timeout hợp lệ của bước POST trước đó
  slowNext = true;
  p.click(p.d.querySelector('#topupIntent [data-act="topup-check"]'));
  await sleep(40);
  await logoutUi(p);
  await loginUi(p, OTHER);
  p.w.location.hash = '#/wallet';
  await sleep(1200);
  ok(!p.d.querySelector('.modal') && p.count('GET /mock-provider/checkout/ref1') === 0,
    'GET kiểm tra chậm + đổi tài khoản: KHÔNG mở cổng cho tài khoản mới');
  ok(allowedToasts(p), 'GET kiểm tra chậm + đổi tài khoản: không có thông báo nào từ kết quả cũ');
  ok(p.store()[p.intentKey(OTHER)] === undefined && p.notice() === '', 'GET kiểm tra chậm + đổi tài khoản: ý định/thông báo của tài khoản mới không bị đụng');
  ok(JSON.parse(p.store()[p.intentKey()] || 'null') && JSON.parse(p.store()[p.intentKey()]).requestId === keyChk,
    'GET kiểm tra chậm: ý định của tài khoản cũ không bị kết quả cũ xoá');
  p.close();

  // R9.5: request của phiên cũ nhận 401 sau khi người khác đăng nhập: không làm mới phiên, không thử lại bằng token mới.
  p = await wallet({ timeoutMs: 5000, topup: () => delay(700, json(401, { error: 'UNAUTHENTICATED', message: 'Token không hợp lệ hoặc đã hết hạn' })) });
  p.routes['POST /api/passkeys/session/refresh'] = () => json(200, { token: 'tok-bi-lam-moi', user: BUYER });
  p.click(p.btn());
  await sleep(20);
  await logoutUi(p);
  await loginUi(p, OTHER);
  await sleep(1000);
  ok(p.bodies.length === 1, 'Request cũ nhận 401: KHÔNG được thử lại bằng token của người dùng mới (chỉ 1 POST)');
  ok(p.count('POST /api/passkeys/session/refresh') === 0, 'Request cũ nhận 401: không kích hoạt làm mới phiên của người dùng mới');
  ok(p.w.localStorage.getItem('cat_token') === 'tok-' + OTHER.id, 'Người dùng mới vẫn đăng nhập, token nguyên vẹn');
  ok(allowedToasts(p), 'Request cũ nhận 401: không có thông báo hết phiên nào cho người dùng mới');
  p.close();

  // ------------------------------------------------------------------------------------------
  section('R10: bước GET xác nhận SUCCEEDED lỗi/không khớp thì KHÔNG báo thành công');
  const keyOfPage = (pg) => (pg.bodies[0] || {}).requestId;
  const confirmCases = [
    ['GET 503', () => json(503, { error: 'INTERNAL_ERROR', message: 'x' })],
    ['GET treo (timeout)', () => HANG],
    ['GET 200 thân HTML', () => html(200, '<html>ok</html>')],
    ['GET 200 mảng', () => json(200, [])],
    ['GET sai id', (pg) => json(200, row({ id: 'p-khac', status: 'SUCCEEDED', requestId: keyOfPage(pg) }))],
    ['GET sai số tiền', (pg) => json(200, row({ amount: 1000, status: 'SUCCEEDED', requestId: keyOfPage(pg) }))],
    ['GET sai requestId', () => json(200, row({ status: 'SUCCEEDED', requestId: 'khac-hoan-toan-9999' }))],
    ['GET nói PENDING (trái POST)', (pg) => json(200, row({ status: 'PENDING', requestId: keyOfPage(pg) }))],
    ['GET nói FAILED (trái POST)', (pg) => json(200, row({ status: 'FAILED', requestId: keyOfPage(pg) }))],
  ];
  for (const [label, make] of confirmCases) {
    let pg;
    pg = await wallet({
      topup: (b) => json(200, row({ requestId: b.requestId, status: 'SUCCEEDED', resolvedBy: 'WEBHOOK', idempotentReplay: true })),
      extra: { 'GET /api/payments/p1': () => make(pg) },
    });
    await press(pg, TIMEOUT_MS + 700);
    const tt = pg.toasts();
    ok(tt.every((x) => x.kind !== 'ok' && !/Nạp tiền thành công/.test(x.text)) && !pg.d.querySelector('.modal')
      && pg.count('GET /mock-provider/checkout/ref1') === 0,
    `${label}: không báo thành công, không mở cổng`);
    ok(/Chưa xác nhận/.test(pg.notice()) && !!pg.d.querySelector('#topupIntent [data-act="topup-check"]') && !!pg.store()[pg.intentKey()],
      `${label}: giữ trạng thái "chưa xác nhận", có nút kiểm tra lại, giữ ý định`);
    pg.close();
  }
  // Chỉ GET hợp lệ, đúng yêu cầu, nói SUCCEEDED mới được báo thành công — kể cả khi bấm "Kiểm tra lại" sau đó.
  let pg2;
  let mode = 'bad';
  pg2 = await wallet({
    topup: (b) => json(200, row({ requestId: b.requestId, status: 'SUCCEEDED', resolvedBy: 'WEBHOOK', idempotentReplay: true })),
    extra: {
      'GET /api/payments/p1': () => (mode === 'bad'
        ? json(503, { error: 'INTERNAL_ERROR', message: 'x' })
        : json(200, row({ status: 'SUCCEEDED', resolvedBy: 'WEBHOOK', requestId: keyOfPage(pg2), resolvedAt: new Date().toISOString() }))),
    },
  });
  await press(pg2, 700);
  ok(pg2.toasts().every((x) => x.kind !== 'ok'), 'GET lỗi lần đầu: chưa có thông báo thành công');
  mode = 'good';
  pg2.click(pg2.d.querySelector('#topupIntent [data-act="topup-check"]'));
  await sleep(700);
  ok(pg2.toasts().filter((x) => x.kind === 'ok' && /Nạp tiền thành công/.test(x.text)).length === 1, 'Kiểm tra lại, GET hợp lệ SUCCEEDED đúng yêu cầu: đúng MỘT thông báo thành công');
  ok(!pg2.store()[pg2.intentKey()] && pg2.notice() === '', 'Sau khi được xác nhận: ý định và thông báo được dọn');
  pg2.close();

  // ------------------------------------------------------------------------------------------
  section('R11: huỷ theo dõi dọn hẹn giờ và không để tác vụ treo');
  p = await wallet({
    timeoutMs: 5000,
    topup: (b) => json(200, row({ requestId: b.requestId, submissionStatus: 'SUBMITTING' })),
    extra: { 'GET /api/payments/p1': () => json(200, row({ submissionStatus: 'SUBMITTING' })) },
  });
  await press(p, 300);
  ok(p.pollTimers() === 1, `Đang theo dõi: có đúng 1 hẹn giờ chờ lượt hỏi (nhận ${p.pollTimers()})`);
  await logoutUi(p);
  ok(p.pollTimers() === 0, `Đăng xuất: hẹn giờ theo dõi được huỷ ngay (còn ${p.pollTimers()})`);
  p.close();
  p = await wallet({
    timeoutMs: 5000,
    topup: (b) => json(200, row({ requestId: b.requestId, submissionStatus: 'SUBMITTING' })),
    extra: { 'GET /api/payments/p1': () => json(200, row({ submissionStatus: 'SUBMITTING' })) },
  });
  await press(p, 300);
  p.w.location.hash = '#/';
  await sleep(300);
  ok(p.pollTimers() === 0, `Rời trang ví: hẹn giờ theo dõi được huỷ ngay (còn ${p.pollTimers()})`);
  p.close();

  console.log(`\n${checks} kiểm tra, ${fails ? fails + ' FAIL' : 'ALL PASS'}`);
  process.exit(fails ? 1 : 0);
}

main().catch((e) => { console.error('[topup-request-id-ui] lỗi:', e); process.exit(1); });
