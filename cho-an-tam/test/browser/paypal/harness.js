/**
 * Harness kiểm thử TRÌNH DUYỆT THẬT cho luồng nạp PayPal Sandbox (chỉ fixture, KHÔNG phải Sandbox/backend thật).
 *
 * - Chromium thật (Chrome cài sẵn qua playwright-core) chạy NGUYÊN app.js sản phẩm; không jsdom, không ENCLAVE_NAVIGATE.
 * - Máy chủ fixture cục bộ (cổng rảnh, 127.0.0.1) phục vụ public/ và giả lập /api/*. Mọi origin khác bị chặn:
 *   (1) cờ Chrome --host-resolver-rules làm DNS thất bại, (2) context.route chặn/ghi mọi request ngoài origin fixture.
 *   Điều hướng chính sang www.sandbox.paypal.com được GHI LẠI rồi trả trang giả; không bao giờ chạm PayPal thật.
 * - Request ngoài lọt ra (không đi qua route) = h.leaked(); mỗi ca phải assert bằng 0.
 *
 * Chữ ký spec (một lần, không đổi nếu không thông báo): xem phần "Hợp đồng" ở cuối tệp này.
 */
const fs = require('fs');
const http = require('http');
const path = require('path');
const CONTEXT_CLEANUP_MS = 30000;
const SESSION_CLEANUP_MS = 35000;
const activeSessions = new Set();
async function withDeadline(promise, ms, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer=setTimeout(() => reject(Error(label + ' timed out')), ms); })]); }
  finally { clearTimeout(timer); }
}
async function closeAllSessions() {
  const results = await Promise.allSettled([...activeSessions].map(close => close()));
  const errors = results.filter(r => r.status === 'rejected').map(r => r.reason);
  if (errors.length) throw new AggregateError(errors, 'Fixture cleanup failed');
}

const PUBLIC = path.join(__dirname, '..', '..', '..', 'public');
const EVIDENCE_DIR = path.join(__dirname, 'evidence');
const PAYPAL_HOST = 'www.sandbox.paypal.com';
const SANDBOX = `https://${PAYPAL_HOST}/checkoutnow?token=ORDER1`;
const INTENT_PREFIX = 'cat_topup_intent:';
const ID = '5b1f0c52-7a3e-4c1d-9a55-0f1e2d3c4b5a';
const KEY = 'topup-test-key-0001';
const AMOUNT = 100000;
const BUYER = { id: 'u-buyer', username: 'mua', displayName: 'Mua Thử', role: 'BUYER', accountStatus: 'ACTIVE' };
const OTHER = { id: 'u-other', username: 'khac', displayName: 'Người Khác', role: 'BUYER', accountStatus: 'ACTIVE' };
const WALLET = { availableBalance: 5000000, lockedBalance: 0, pendingTopupTotal: 0 };
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json', '.txt': 'text/plain', '.woff2': 'font/woff2' };

const json = (status, body, headers) => ({ status, body, headers });
const HANG = Symbol('hang');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Promise có thể giải quyết thủ công; dùng thay delay() để giữ phản hồi treo có kiểm soát. */
function deferred() {
  let resolve;
  let settled = false;
  const promise = new Promise((r) => { resolve = (v) => { settled = true; r(v); }; });
  return { promise, release: (v) => resolve(v), get settled() { return settled; } };
}

const CFG = (paypal, mock, mode = 'sandbox') => ({ paypalSandbox: { enabled: paypal, mode, rateKind: 'DEMO_FIXED' }, mockPayments: { enabled: mock } });
const quote = (o = {}) => ({
  version: 1, amountVnd: AMOUNT, currency: 'USD', usdCents: 400, usdValue: '4.00', rateVndPerUsd: 25000,
  rateKind: 'DEMO_FIXED', rateLabel: 'Tỷ giá mô phỏng, không phải giá thị trường', ...o,
});
/** Dòng yêu cầu PayPal đúng shape serializePayPal (hợp đồng API §2, §5). */
const ppRow = (o = {}) => ({
  id: ID, amount: AMOUNT, status: 'PENDING', requestId: KEY, providerRef: 'srv-1', provider: 'PAYPAL_SANDBOX',
  submissionStatus: 'SUBMITTED', createdAt: new Date().toISOString(), resolvedAt: null, sandbox: true, stage: 'AWAITING_APPROVAL',
  orderId: 'ORDER1', quote: quote(), approvalUrl: null, ...o,
});
const intentJson = (o = {}) => JSON.stringify({
  userId: BUYER.id, requestId: KEY, amount: AMOUNT, provider: 'PAYPAL_SANDBOX', createdAt: new Date().toISOString(), paymentId: ID, ...o,
});

/** Các route nền để trang ví tải được; ghi đè/ thêm bằng routes của ca. */
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

/** Máy chủ PayPal giả có trạng thái (một yêu cầu ID, giai đoạn đổi được giữa các lần gọi). */
function paypalServer(initial = {}, { key = KEY } = {}) {
  const s = { row: ppRow({ requestId: key, ...initial }), approvalUrl: SANDBOX, captures: 0, captureResult: null };
  s.routes = () => ({
    [`GET /api/payments/${ID}`]: () => json(200, s.row),
    [`GET /api/payments/paypal/${ID}/checkout`]: () => json(200, { ...s.row, approvalUrl: s.approvalUrl }),
    [`POST /api/payments/paypal/${ID}/capture`]: () => {
      s.captures++;
      return s.captureResult ? s.captureResult() : json(200, { ...s.row, outcome: 'APPLIED' });
    },
  });
  return s;
}

function findChrome() {
  const cands = [process.env.CHROME_PATH, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe']
    .filter(Boolean);
  return cands.find((p) => fs.existsSync(p)) || null;
}

/** Máy chủ fixture: phục vụ public/ và /api/* theo bảng routes; ghi mọi request. */
function startFixture(routes) {
  const table = { ...routes };
  const requests = [];
  const unhandled = [];
  const sockets = new Set();
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname.startsWith('/api/') || u.pathname.startsWith('/mock-provider/')) {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const key = `${req.method} ${u.pathname}`;
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch (_) { body = raw; }
      const entry = { key, body, headers: req.headers, at: Date.now(), responded: false, respondedAt: null };
      requests.push(entry);
      const handler = table[key];
      if (!handler) unhandled.push(key);
      let r = handler ? handler({ body, headers: req.headers, url: u, method: req.method }) : json(404, { error: 'NOT_FOUND', message: 'Không tìm thấy tài nguyên' });
      if (r === HANG) return;
      try { r = await r; } catch (e) { r = json(500, { error: 'FIXTURE_ERROR', message: String(e && e.message) }); }
      if (r === HANG || res.destroyed) return;
      const text = r.text !== undefined ? r.text : JSON.stringify(r.body);
      res.writeHead(r.status, { 'Content-Type': r.type || 'application/json', 'Cache-Control': 'no-store', ...(r.headers || {}) });
      res.end(text);
      entry.responded = true;
      entry.respondedAt = Date.now();
      return;
    }
    // Tệp tĩnh trong public/ (chặn đi ra ngoài thư mục).
    let rel = decodeURIComponent(u.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const fx = {
        origin: `http://127.0.0.1:${port}`,
        port,
        routes: table,
        requests,
        unhandled,
        count: (key) => requests.filter((r) => r.key === key).length,
        responded: (key) => requests.filter((r) => r.key === key && r.responded).length,
        bodies: (key) => requests.filter((r) => r.key === key).map((r) => r.body),
        close: () => new Promise((r) => {
          for (const s of sockets) s.destroy();
          server.close(() => r());
        }),
      };
      resolve(fx);
    });
  });
}

/**
 * Mở một phiên trình duyệt độc lập (context mới + fixture mới) cho MỘT ca.
 * opts: { routes, user=BUYER, cfg, hash='#/wallet', search='', storage={}, timeoutMs=5000, topup }
 * Trả: { fx, ctx, page, navs, external, leaked(), hang, wallet... } — gọi s.close() hoặc để c.cleanup tự gọi.
 */
async function openSession(browser, opts = {}) {
  const { routes = {}, user = BUYER, cfg, hash = '#/wallet', search = '', storage = {}, timeoutMs = 5000, seedAuth = true } = opts;
  const fx = await startFixture({ ...baseRoutes(user, cfg), ...routes });
  let ctx, closing;
  const close = () => closing ||= (async () => {
    const results = await Promise.allSettled([
      ctx ? withDeadline(ctx.close(), CONTEXT_CLEANUP_MS, 'context cleanup') : Promise.resolve(),
      withDeadline(fx.close(), 5000, 'fixture cleanup'),
    ]);
    const errors = results.filter(r => r.status === 'rejected').map(r => r.reason);
    if (errors.length) throw new AggregateError(errors, 'Session cleanup failed');
    activeSessions.delete(close);
  })();
  activeSessions.add(close);
  try {
  ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 }, locale: 'vi-VN' });
  const navs = [];
  const external = [];
  const seenExternal = new Set();
  const handledExternal = new Set();
  const pageErrors = [];
  const consoleErrors = [];

  ctx.on('request', (req) => {
    const u = new URL(req.url());
    if (u.origin !== fx.origin && u.protocol !== 'data:' && u.protocol !== 'about:' && u.protocol !== 'blob:') seenExternal.add(req);
  });
  await ctx.route('**/*', async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    if (u.origin === fx.origin) return route.continue();
    handledExternal.add(req);
    const isNav = req.isNavigationRequest() && req.frame() === page.mainFrame();
    external.push({ url: req.url(), method: req.method(), navigation: isNav, action: isNav && u.host === PAYPAL_HOST ? 'stub' : 'blocked' });
    if (isNav && u.host === PAYPAL_HOST) {
      navs.push(req.url());
      return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><title>PayPal Sandbox (fixture stub)</title><p>Trang giả của fixture, không phải PayPal.</p>' });
    }
    return route.abort('blockedbyclient');
  });

  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(String(e && e.message)));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  await page.addInitScript(({ timeoutMs: t, user: u, storage: st, seedAuth: sa, hash: hsh }) => {
    window.ENCLAVE_API_TIMEOUT_MS = t;
    // Seed một lần mỗi tab (reload/điều hướng sau đó giữ nguyên localStorage thật, không bị ghi đè).
    try {
      if (!sessionStorage.getItem('__fx_seeded')) {
        sessionStorage.setItem('__fx_seeded', '1');
        for (const [k, v] of Object.entries(st)) localStorage.setItem(k, v);
        if (sa) { localStorage.setItem('cat_token', 'tok-' + u.id); localStorage.setItem('cat_user', JSON.stringify(u)); }
        if (hsh) window.location.hash = hsh;
      }
    } catch (_) { /* ignore */ }
  }, { timeoutMs, user, storage, seedAuth, hash });

  const s = {
    fx, ctx, page, navs, external, pageErrors, consoleErrors, user,
    /** Request ngoài origin fixture đã thấy nhưng KHÔNG đi qua route chặn (phải = 0). */
    leaked: () => [...seenExternal].filter((r) => !handledExternal.has(r)).map((r) => r.url()),
    goto: (p = '/') => page.goto(fx.origin + p, { waitUntil: 'domcontentloaded' }),
    open: () => page.goto(`${fx.origin}/${search}`, { waitUntil: 'domcontentloaded' }),
    /** Chờ điều kiện đồng bộ phía Node (poll 10 ms, có hạn). Ném lỗi khi quá hạn; KHÔNG dùng để đoán request treo. */
    until: async (fn, ms = 4000, what = 'điều kiện') => {
      const end = Date.now() + ms;
      while (Date.now() < end) { if (await fn()) return true; await sleep(10); }
      throw new Error(`Quá hạn ${ms}ms chờ ${what}`);
    },
    toasts: () => page.$$eval('#toasts .toast', (els) => els.map((t) => ({ kind: t.className.replace('toast', '').trim(), text: t.textContent.trim() }))),
    viewText: () => page.$eval('#view', (el) => el.textContent.replace(/\s+/g, ' ').trim()).catch(() => ''),
    store: () => page.evaluate(() => Object.fromEntries(Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).map((k) => [k, localStorage.getItem(k)]))),
    intent: (u = user) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) || 'null'), INTENT_PREFIX + u.id),
    has: (sel) => page.$(sel).then((el) => !!el),
    click: (sel) => page.click(sel),
    /** Ảnh minh chứng (không chứa token; tên tệp do ca đặt). Tối đa 2 ảnh cho mỗi agent theo giao việc. */
    shot: async (name) => {
      fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
      const file = path.join(EVIDENCE_DIR, `${name}.png`);
      await page.screenshot({ path: file });
      return file;
    },
    /** Đăng xuất qua nút thật; chờ POST logout được fixture trả lời và giao diện về trạng thái khách. */
    logout: async () => {
      fx.routes['POST /api/passkeys/session/logout'] = fx.routes['POST /api/passkeys/session/logout'] || (() => json(200, { ok: true }));
      const before = fx.count('POST /api/passkeys/session/logout');
      await page.click('[data-act="logout"]');
      await s.until(() => fx.count('POST /api/passkeys/session/logout') > before && fx.responded('POST /api/passkeys/session/logout') > before, 4000, 'POST logout');
      await page.waitForSelector('[data-act="open-auth"]', { timeout: 4000 });
    },
    /** Đăng nhập bằng mật khẩu qua giao diện thật; chờ phiên mới có hiệu lực (nút đăng xuất xuất hiện). */
    login: async (u = user) => {
      fx.routes['POST /api/passkeys/login/password'] = () => json(200, { token: 'tok-' + u.id, user: u });
      await page.click('[data-act="open-auth"]');
      await page.waitForSelector('#loginUsername', { timeout: 4000 });
      await page.fill('#loginUsername', u.username);
      await page.fill('#loginPassword', 'mat-khau-gia');
      await page.click('[data-act="do-login-password"]');
      await page.waitForSelector('[data-act="logout"]', { timeout: 4000 });
    },
    close,
  };
  return s;
  } catch (error) {
    try { await close(); } catch (cleanupError) { error.cleanupError = cleanupError; }
    throw error;
  }
}

const hang = HANG;

module.exports = {
  // hằng số và dựng dữ liệu
  PUBLIC, SANDBOX, PAYPAL_HOST, INTENT_PREFIX, ID, KEY, AMOUNT, BUYER, OTHER, WALLET,
  json, HANG: hang, hang, sleep, deferred, CFG, quote, ppRow, intentJson, baseRoutes, paypalServer,
  // hạ tầng
  findChrome, startFixture, openSession, withDeadline, closeAllSessions, SESSION_CLEANUP_MS,
};

/*
 * Hợp đồng helper cho spec (một lần, không tự đoán thêm):
 *
 *   module.exports = {
 *     id: 'B1B2',                       // chuỗi ngắn, dùng cho --only=
 *     title: 'Luồng thanh toán...',
 *     async run({ h, t, browser }) {
 *       await t.case('B1.1 mô tả ca', async (c) => {
 *         const s = await h.openSession(browser, { routes: {...}, search: '?paypal=return&paymentRequestId=' + h.ID, storage: {...}, user, cfg, timeoutMs });
 *         c.cleanup(() => s.close());                       // LUÔN đăng ký dọn; chạy trong finally kể cả khi assert thất bại
 *         await s.open();                                    // điều hướng tới trang (origin fixture)
 *         c.precondition(cond, 'điều kiện dựng đúng');       // sai => ca FAIL ngay, KHÔNG chạy assert hành vi
 *         c.ok(cond, 'mô tả assert');                        // ghi PASS/FAIL, không ném lỗi
 *         c.ok(s.leaked().length === 0, 'Không request ngoài lọt ra');
 *       });
 *     },
 *   };
 *
 * Quy ước:
 *   - Không dùng sleep/delay để đoán request còn treo; dùng h.deferred() và s.until(...) / s.fx.count(...).
 *   - Handler route trả json(...), HANG, hoặc Promise (vd deferred.promise.then(() => json(...))).
 *   - s.fx.count('POST /api/...') đếm request tới fixture; s.fx.responded(key) đếm request đã được trả lời.
 *   - s.navs là danh sách URL điều hướng chính sang PayPal (đã bị chặn thành trang giả); s.external ghi mọi request ngoài.
 *   - Không sửa harness.js/runner; cần thêm hàm thì báo Pro.
 */
