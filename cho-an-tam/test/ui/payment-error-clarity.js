/**
 * Kiểm thử giao diện: thông báo lỗi thanh toán rõ ràng, nút thao tác an toàn, không thành công giả.
 *
 * Khác test/ui/ui-flow-jsdom.js: bộ này KHÔNG cần máy chủ. Nó dựng DOM từ public/index.html và nạp
 * public/js/*.js thật vào jsdom, còn toàn bộ `fetch` do bộ kiểm thử mock — nên không có endpoint thử
 * nào thêm vào server, và mọi phản hồi lỗi (kể cả HTML 502, thân JSON lạ, mất kết nối, treo) đều dựng
 * được chính xác. Đây là kiểm thử logic giao diện, không phải bằng chứng Passkey hay thanh toán thật.
 *
 * Nhóm kiểm:
 *   E1  Thông báo cụ thể cho INVALID_AMOUNT, AMOUNT_OUT_OF_RANGE, LISTING_STATE_CONFLICT,
 *       REAUTH_REQUIRED (không bị coi là hết phiên), DISPUTE_NOT_OPEN (tải lại danh sách).
 *   E2  Fallback không lộ mã thô, stack, HTML hay thân phản hồi của lớp trung gian.
 *   E3  401 UNAUTHENTICATED vẫn là hết phiên (không bị phá bởi E1).
 *   E4  Nút đang xử lý không kích hoạt lặp, bật lại sau lỗi.
 *   E5  Timeout/mất kết nối: báo "chưa rõ", kiểm tra lại trạng thái, không khẳng định thất bại,
 *       không hiện thành công giả, nút bật lại.
 *
 * Cách chạy (cần jsdom — KHÔNG nằm trong package.json; cài không ghi vào package.json):
 *   cd cho-an-tam
 *   npm i --no-save jsdom
 *   node test/ui/payment-error-clarity.js
 * Cần Node >= 23 (dùng Response/fetch có sẵn). Không đọc .env, không chạm DB, không kết nối mạng.
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
const TIMEOUT_MS = 200; // hạn chờ rút ngắn qua window.ENCLAVE_API_TIMEOUT_MS

let fails = 0;
let checks = 0;
const ok = (c, m) => { checks++; console.log(`  ${c ? '✅' : '❌'} ${m}`); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const section = (t) => console.log(`\n${t}`);

const BUYER = { id: 'u-buyer', username: 'mua', displayName: 'Mua Thử', role: 'BUYER', accountStatus: 'ACTIVE' };
const ADMIN = { id: 'u-admin', username: 'adm', displayName: 'Quản Trị', role: 'ADMIN', accountStatus: 'ACTIVE' };
const WALLET = { availableBalance: 5000000, lockedBalance: 0, pendingTopupTotal: 0 };

const json = (status, body) => ({ status, body });
const html = (status, text) => ({ status, text, type: 'text/html' });
const HANG = Symbol('hang');

/** Dựng trang thật với `fetch` mock. routes: { 'METHOD /api/path': (opts, url) => json(...)|html(...)|HANG|Promise }. */
async function openPage({ hash, user, routes }) {
  const html0 = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8').replace(/<script\b[^>]*\bsrc=[^>]*><\/script>/g, '');
  const log = [];
  const table = { ...routes };
  const dom = new JSDOM(html0, {
    url: `${ORIGIN}/`,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    beforeParse(w) {
      w.ENCLAVE_API_TIMEOUT_MS = TIMEOUT_MS;
      w.scrollTo = () => {};
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
        if (r === HANG) return; // không bao giờ trả lời; chỉ kết thúc khi bị huỷ
        Promise.resolve(r).then((x) => {
          if (x === HANG) return;
          const body = x.text !== undefined ? x.text : JSON.stringify(x.body);
          resolve(new Response(body, { status: x.status, headers: { 'Content-Type': x.type || 'application/json' } }));
        }, reject);
      });
      // Nối thành MỘT lần eval: các tệp khai báo `const` ở mức script và dùng chung phạm vi đó khi nạp
      // bằng thẻ <script>, còn mỗi lần eval riêng lại có phạm vi riêng.
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
    close: () => w.close(),
  };
}

const baseRoutes = (user) => ({
  'GET /api/users/me': () => json(200, { user, wallet: WALLET }),
  'GET /api/users/me/seller-request': () => json(200, { request: null }),
  'GET /api/listings/meta': () => json(200, { categories: [], conditions: [], locations: [] }),
  'GET /api/wallets/me': () => json(200, WALLET),
  'GET /api/transactions': () => json(200, { transactions: [] }),
  'GET /api/payments/me': () => json(200, { paymentRequests: [] }),
  'GET /api/notifications': () => json(200, { notifications: [], unreadCount: 0 }),
  'GET /api/wallets/me/entries': () => json(200, { entries: [] }),
});

const NO_RAW = /INVALID_AMOUNT|AMOUNT_OUT_OF_RANGE|LISTING_STATE_CONFLICT|REAUTH_REQUIRED|DISPUTE_NOT_OPEN|INTERNAL_ERROR|SQLITE|undefined|\[object/;

/** Mở trang ví và bấm "Tiếp tục thanh toán" với số tiền hợp lệ; trả về nút để kiểm tra trạng thái. */
async function walletPage(extraRoutes) {
  const p = await openPage({ hash: '#/wallet', user: BUYER, routes: { ...baseRoutes(BUYER), ...extraRoutes } });
  p.d.querySelector('#topupAmount').value = '150000';
  return Object.assign(p, { topupBtn: () => p.d.querySelector('[data-act="topup-create"]') });
}
const submitTopup = async (p, wait = 250) => { p.click(p.topupBtn()); await sleep(wait); };

async function main() {
  // ------------------------------------------------------------------------------------------
  section('E1: thông báo cụ thể theo mã lỗi');
  let p = await walletPage({});
  ok(!!p.topupBtn(), 'Trang ví (mock) dựng được, có nút nạp tiền');

  const cases = [
    ['INVALID_AMOUNT', json(400, { error: 'INVALID_AMOUNT', message: 'amount phải là một số nguyên (đơn vị đồng)' }),
      (t) => /số nguyên đồng/.test(t) && !/amount/.test(t)],
    ['AMOUNT_OUT_OF_RANGE', json(400, { error: 'AMOUNT_OUT_OF_RANGE', message: 'amount phải từ 1.000đ đến 50.000.000đ' }),
      (t) => /từ 1\.000đ đến 50\.000\.000đ/.test(t) && !/amount/.test(t)],
    ['LISTING_STATE_CONFLICT', json(409, { error: 'LISTING_STATE_CONFLICT', message: 'Trạng thái tin đăng không khớp với giao dịch đang tất toán, nghiệp vụ đã được huỷ toàn bộ' }),
      (t) => /Tiền chưa được chuyển/.test(t) && /quản trị viên/.test(t)],
    ['REAUTH_REQUIRED', json(401, { error: 'REAUTH_REQUIRED', message: 'Phiếu uỷ quyền vừa được dùng ở nơi khác' }),
      (t) => /xác thực lại bằng Passkey/.test(t) && /vẫn đang đăng nhập/.test(t)],
  ];
  for (const [code, response, check] of cases) {
    p.routes['POST /api/payments/topup'] = () => response;
    p.clearToasts();
    await submitTopup(p);
    const t = p.toasts();
    ok(t.length === 1 && t[0].kind === 'err' && check(t[0].text), `${code}: thông báo tiếng Việt cụ thể (“${(t[0] || {}).text || ''}”)`);
    ok(!NO_RAW.test((t[0] || {}).text || ''), `${code}: không lộ mã lỗi thô`);
  }
  ok(p.w.localStorage.getItem('cat_token') === 'tok-test', 'REAUTH_REQUIRED KHÔNG đăng xuất (token còn nguyên)');
  ok(p.count('POST /api/passkeys/session/refresh') === 0, 'REAUTH_REQUIRED không kích hoạt làm mới phiên như một 401 hết hạn');
  ok(p.d.querySelector('#topupAmount') !== null, 'Vẫn ở trang ví sau REAUTH_REQUIRED (không bị đẩy về đăng nhập)');
  p.close();

  // DISPUTE_NOT_OPEN thật trên màn hình quản trị: báo rõ và tải lại danh sách.
  let listCalls = 0;
  let handledElsewhere = false; // chỉ đổi sau khi máy chủ từ chối vì tranh chấp không còn mở
  const dispute = (status) => ({
    id: 'd1', transactionId: 't1', status, openedBy: 'BUYER', reason: 'Sai mô tả', createdAt: new Date().toISOString(),
    createdByName: 'Mua Thử', transaction: { id: 't1', itemName: 'Máy ảnh', amount: 1500000, buyerName: 'Mua Thử', sellerName: 'Bán Thử' },
  });
  p = await openPage({
    hash: '#/admin/disputes', user: ADMIN,
    routes: {
      ...baseRoutes(ADMIN),
      'GET /api/admin/disputes': () => { listCalls++; return json(200, { disputes: [dispute(handledElsewhere ? 'RESOLVED_REFUND' : 'OPEN')] }); },
      'POST /api/admin/disputes/d1/reauth/options': () => { handledElsewhere = true; return json(409, { error: 'DISPUTE_NOT_OPEN', message: 'Dispute phải OPEN' }); },
    },
  });
  const refundBtn = p.d.querySelector('[data-act="admin-refund"]');
  ok(!!refundBtn, 'Admin thấy nút hoàn tiền của tranh chấp đang mở');
  p.click(refundBtn);
  await sleep(500);
  const tAdmin = p.toasts();
  ok(tAdmin.length === 1 && /không còn ở trạng thái chờ xử lý/.test(tAdmin[0].text) && !/Dispute phải OPEN/.test(tAdmin[0].text),
    'DISPUTE_NOT_OPEN: thông báo tiếng Việt, không dùng câu thô của máy chủ');
  ok(/Không có khoản tiền nào được chuyển thêm/.test((tAdmin[0] || {}).text || ''), 'DISPUTE_NOT_OPEN: nói rõ không có tiền nào bị chuyển');
  const callsAfterError = listCalls;
  ok(handledElsewhere && callsAfterError >= 2, `Danh sách tranh chấp được tải lại sau lỗi (${callsAfterError} lần gọi)`);
  ok(!p.d.querySelector('[data-act="admin-refund"]'), 'Sau khi tải lại, nút hoàn tiền không còn cho tranh chấp đã xử lý');
  p.close();

  // ------------------------------------------------------------------------------------------
  section('E2: fallback không lộ mã thô, stack, HTML hay thân phản hồi trung gian');
  p = await walletPage({});
  const stack = 'SQLITE_CONSTRAINT: failed at Statement.run (/app/src/db.js:12:3)';
  const fallbacks = [
    ['500 INTERNAL_ERROR kèm requestId', json(500, { error: 'INTERNAL_ERROR', message: 'Lỗi hệ thống, vui lòng thử lại sau', requestId: '3f2a9c1e-1111-4222-8333-944455556666' }),
      (t) => /Hệ thống gặp lỗi/.test(t) && /Mã tham chiếu: 3f2a9c1e\./.test(t)],
    ['500 chứa dấu vết stack', json(500, { error: 'SQLITE_CONSTRAINT', message: stack }),
      (t) => /Hệ thống gặp lỗi/.test(t) && !/SQLITE|Statement|db\.js/.test(t)],
    ['502 HTML của lớp trung gian', html(502, '<html><body><h1>Bad Gateway</h1>at Object.<anonymous> (/srv/proxy.js:10:5)</body></html>'),
      (t) => /Máy chủ tạm thời không phản hồi/.test(t) && !/<|Bad Gateway|proxy\.js/.test(t)],
    ['503 không phải JSON', html(503, 'Service Unavailable'),
      (t) => /Máy chủ tạm thời không phản hồi/.test(t) && !/Service Unavailable/.test(t)],
    ['400 thân JSON lạ', json(400, { foo: 'bar', trace: stack }),
      (t) => /Yêu cầu không hợp lệ/.test(t) && !/bar|SQLITE|trace/.test(t)],
    ['4xx có mã nhưng thông báo là HTML', json(400, { error: 'BAD_REQUEST', message: '<script>alert(1)</script>' }),
      (t) => /Yêu cầu không hợp lệ/.test(t) && !/script|alert/.test(t)],
    ['mã HTTP lạ 418', html(418, 'teapot'),
      (t) => /mã HTTP 418/.test(t) && !/teapot/.test(t)],
    ['429 RATE_LIMITED giữ câu của máy chủ', json(429, { error: 'RATE_LIMITED', message: 'Quá nhiều yêu cầu, thử lại sau 42 giây.' }),
      (t) => /thử lại sau 42 giây/.test(t)],
  ];
  for (const [label, response, check] of fallbacks) {
    p.routes['POST /api/payments/topup'] = () => response;
    p.clearToasts();
    await submitTopup(p);
    const t = p.toasts();
    ok(t.length === 1 && t[0].kind === 'err' && check(t[0].text), `${label}: “${(t[0] || {}).text || ''}”`);
  }
  p.close();

  // ------------------------------------------------------------------------------------------
  section('E3: 401 UNAUTHENTICATED vẫn là hết phiên');
  p = await walletPage({
    'POST /api/payments/topup': () => json(401, { error: 'UNAUTHENTICATED', message: 'Token không hợp lệ hoặc đã hết hạn' }),
    'POST /api/passkeys/session/refresh': () => json(401, { error: 'UNAUTHENTICATED', message: 'Không có phiên làm mới' }),
  });
  await submitTopup(p, 500);
  ok(p.count('POST /api/passkeys/session/refresh') === 1, 'Thử làm mới phiên đúng một lần');
  ok(p.w.localStorage.getItem('cat_token') === null, 'Làm mới thất bại -> xoá phiên (đăng xuất)');
  ok(p.toasts().some((t) => /Phiên đăng nhập đã hết hạn/.test(t.text)), 'Báo hết phiên bằng câu riêng, khác với REAUTH_REQUIRED');
  p.close();

  // ------------------------------------------------------------------------------------------
  section('E4: nút đang xử lý không kích hoạt lặp, bật lại sau lỗi');
  let release;
  const gate = new Promise((r) => { release = r; });
  p = await walletPage({ 'POST /api/payments/topup': () => gate });
  const btn = p.topupBtn();
  const label = btn.innerHTML;
  p.click(btn);
  await sleep(50);
  p.click(btn);
  p.click(btn);
  await sleep(50);
  ok(btn.disabled && /Đang xử lý/.test(btn.textContent), 'Trong lúc chờ: nút bị khoá và hiện "Đang xử lý"');
  ok(p.count('POST /api/payments/topup') === 1, 'Bấm ba lần chỉ gửi MỘT yêu cầu');
  release(json(400, { error: 'INVALID_AMOUNT', message: 'amount phải là một số nguyên (đơn vị đồng)' }));
  await sleep(200);
  ok(!btn.disabled && btn.innerHTML === label, 'Sau lỗi: nút bật lại, nhãn trở về như cũ');
  ok(p.toasts().filter((t) => t.kind === 'ok').length === 0, 'Bấm lặp / lỗi không sinh thông báo thành công');
  p.routes['POST /api/payments/topup'] = () => json(400, { error: 'INVALID_AMOUNT', message: 'x' });
  p.click(btn);
  await sleep(150);
  ok(p.count('POST /api/payments/topup') === 2, 'Sau khi bật lại, người dùng gửi lại được (yêu cầu thứ hai)');
  p.close();

  // Mở checkout rồi người dùng đóng ("hủy") không để lại nút bị khoá.
  p = await walletPage({
    'GET /api/payments/me': () => json(200, { paymentRequests: [{ id: 'pr1', providerRef: 'ref1', amount: 150000, status: 'PENDING', createdAt: new Date().toISOString() }] }),
    'GET /mock-provider/checkout/ref1': () => json(200, { providerRef: 'ref1', amount: 150000, status: 'PENDING' }),
  });
  await sleep(300);
  p.click(p.d.querySelector('[data-act="checkout-open"]'));
  await sleep(300);
  ok(!!p.d.querySelector('.modal [data-act="checkout-pay"]'), 'Cổng thanh toán (mô phỏng) mở ra');
  p.click(p.d.querySelector('.modal [data-act="modal-close"]'));
  await sleep(100);
  ok(!p.d.querySelector('.modal'), 'Đóng cổng ("Để sau") -> modal đóng');
  ok(!p.topupBtn().disabled, 'Sau khi đóng, nút nạp tiền không bị kẹt ở trạng thái khoá');
  p.close();

  // ------------------------------------------------------------------------------------------
  section('E5: timeout / mất kết nối — chưa rõ kết quả, không thất bại giả, không thành công giả');
  p = await walletPage({ 'POST /api/payments/topup': () => HANG });
  const tBtn = p.topupBtn();
  const tLabel = tBtn.innerHTML;
  const historyBefore = p.count('GET /api/payments/me');
  p.click(tBtn);
  await sleep(TIMEOUT_MS + 400);
  const tt = p.toasts();
  ok(tt.length === 1 && tt[0].kind === 'err' && /chưa rõ thao tác đã được thực hiện hay chưa/.test(tt[0].text), `Timeout khi tạo yêu cầu nạp: báo "chưa rõ" (“${(tt[0] || {}).text || ''}”)`);
  ok(!/thất bại|không thành công/i.test((tt[0] || {}).text || ''), 'Timeout không khẳng định thất bại');
  ok(tt.every((x) => x.kind !== 'ok'), 'Timeout không hiện thông báo thành công');
  ok(p.count('GET /api/payments/me') > historyBefore, 'Sau timeout, giao diện hỏi lại Lịch sử nạp tiền để biết yêu cầu có được tạo không');
  ok(!tBtn.disabled && tBtn.innerHTML === tLabel, 'Sau timeout: nút bật lại, nhãn như cũ');
  ok(!p.d.querySelector('.modal'), 'Timeout không tự mở cổng thanh toán (không có yêu cầu hợp lệ để mở)');
  p.close();

  p = await walletPage({ 'POST /api/payments/topup': () => { throw new TypeError('Failed to fetch'); } });
  await submitTopup(p);
  const net = p.toasts();
  ok(net.length === 1 && /chưa rõ thao tác/.test(net[0].text) && !/Failed to fetch|TypeError/.test(net[0].text),
    'Mất kết nối khi ghi: câu tiếng Việt "chưa rõ", không lộ "Failed to fetch"');
  p.close();

  // Timeout đúng lúc bấm "Thanh toán thành công" ở cổng: kiểm tra lại trạng thái, không tự coi là xong.
  p = await walletPage({
    'GET /api/payments/me': () => json(200, { paymentRequests: [{ id: 'pr1', providerRef: 'ref1', amount: 150000, status: 'PENDING', createdAt: new Date().toISOString() }] }),
    'GET /mock-provider/checkout/ref1': () => json(200, { providerRef: 'ref1', amount: 150000, status: 'PENDING' }),
    'POST /mock-provider/checkout/ref1/pay': () => HANG,
    'GET /api/payments/pr1': () => json(200, { id: 'pr1', amount: 150000, status: 'PENDING' }),
  });
  await sleep(300);
  p.click(p.d.querySelector('[data-act="checkout-open"]'));
  await sleep(300);
  p.click(p.d.querySelector('.modal [data-act="checkout-pay"][data-outcome="SUCCEEDED"][data-deliver="1"]'));
  await sleep(TIMEOUT_MS + 400);
  ok(p.toasts().some((x) => x.kind === 'err' && /chưa rõ thao tác/.test(x.text)), 'Timeout ở bước thanh toán: báo "chưa rõ"');
  ok(!p.d.querySelector('.modal'), 'Modal cổng đóng để người dùng thấy trạng thái thật');
  await sleep(9500); // vòng hỏi lại trạng thái: tối đa 8 lần, mỗi lần 1 giây
  ok(p.count('GET /api/payments/pr1') >= 1, `Giao diện hỏi lại máy chủ trạng thái yêu cầu nạp (${p.count('GET /api/payments/pr1')} lần)`);
  const finalToasts = p.toasts();
  ok(finalToasts.every((x) => !/Nạp tiền thành công/.test(x.text)) && finalToasts.every((x) => x.kind !== 'ok'),
    'Máy chủ vẫn PENDING -> KHÔNG hiện "Nạp tiền thành công"');
  ok(finalToasts.some((x) => /Chưa có xác nhận từ cổng thanh toán/.test(x.text) && !/thất bại/.test(x.text)),
    'Kết luận trung thực: chưa có xác nhận, số dư chỉ đổi khi có kết quả');
  p.close();

  console.log(`\n${checks} kiểm tra, ${fails ? fails + ' FAIL' : 'ALL PASS'}`);
  process.exit(fails ? 1 : 0);
}

main().catch((e) => { console.error('[payment-error-clarity] lỗi:', e); process.exit(1); });
