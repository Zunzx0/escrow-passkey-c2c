/**
 * Kiểm tra luồng giao diện (public/js/app.js) bằng jsdom, chạy trên máy chủ test THẬT.
 *
 * Phạm vi — chỉ logic giao diện, KHÔNG phải bằng chứng Passkey thật:
 *   jsdom không có WebAuthn. Bước xác thực lại chỉ được chứng minh về THỨ TỰ gọi API
 *   (reauth/options chỉ phát sinh sau khi xác nhận), không chứng minh authenticator hoạt động.
 *   Passkey thật phải thử trên trình duyệt thật.
 *
 * Các nhóm kiểm:
 *   B1  Modal bắt buộc (dismissible:false) không đóng bằng Escape / bấm nền; không có nút đóng.
 *   B2  Thẻ người bán không khẳng định "xác minh danh tính".
 *   B3  Trang nạp tiền: không còn lựa chọn phương thức giả; ghi rõ mô phỏng, chưa nối PayPal.
 *   B4  Hoàn tiền / giải ngân tranh chấp: modal xem lại đúng người nhận + số tiền; modal thường
 *       đóng được bằng Escape; Huỷ không gọi reauth/refund/release; chỉ sau xác nhận mới gọi
 *       reauth/options; chưa gọi refund/release khi chưa qua Passkey.
 *
 * Cách chạy (cần jsdom — KHÔNG nằm trong package.json, cài không ghi vào package.json):
 *   cd cho-an-tam
 *   npm i --no-save jsdom
 *   # cửa sổ 1: máy chủ test, cổng khớp BASE_URL
 *   npm run start:test
 *   # cửa sổ 2:
 *   BASE_URL=http://localhost:3114 node --env-file=.env.test test/ui/ui-flow-jsdom.js
 *
 * .env.test cần: APP_ENV=test, SERVE_FRONTEND=1, WEBAUTHN_ORIGIN trùng BASE_URL, và giới hạn
 * xác thực đủ rộng (RATE_LIMIT_AUTH_PER_MINUTE, RATE_LIMIT_REGISTRATION_USERNAME_PER_MINUTE) vì
 * bộ này tạo vài tài khoản. Chỉ chạy trên DB test; tài khoản tạo ra có hậu tố ngẫu nhiên.
 */
const crypto = require('crypto');

let JSDOM;
try {
  ({ JSDOM } = require('jsdom'));
} catch (_) {
  console.error('Thiếu jsdom. Cài bằng: npm i --no-save jsdom (không đổi package.json).');
  process.exit(2);
}

const { api, flows, createAdmin, createSeller, DEFAULT_PASSWORD } = require('../helpers/accounts');

const BASE = process.env.BASE_URL || 'http://localhost:3000';
if (process.env.APP_ENV !== 'test') {
  console.error('Chỉ chạy với APP_ENV=test (nạp .env.test).');
  process.exit(2);
}

let fails = 0;
let checks = 0;
const ok = (c, m) => { checks++; console.log(`  ${c ? '✅' : '❌'} ${m}`); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const section = (t) => console.log(`\n${t}`);

/** Mở trang thật từ máy chủ test; ghi lại mọi lời gọi fetch của trang để kiểm thứ tự. */
async function openPage(hash, session) {
  const calls = [];
  const dom = await JSDOM.fromURL(BASE + '/', {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    beforeParse(w) {
      w.fetch = (u, o) => { calls.push(`${(o && o.method) || 'GET'} ${String(u)}`); return fetch(new URL(u, BASE), o); };
      w.scrollTo = () => {};
      if (session) {
        w.localStorage.setItem('cat_token', session.token);
        w.localStorage.setItem('cat_user', JSON.stringify(session.user));
      }
      w.location.hash = hash;
    },
  });
  await sleep(2500);
  return { w: dom.window, d: dom.window.document, calls, close: () => dom.window.close() };
}

const pressEscape = (w) => w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
const click = (w, el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
const hasModal = (p) => !!p.d.querySelector('.modal');

async function main() {
  const stamp = String(Date.now() % 1e7);
  const rid = () => crypto.randomUUID();

  section('Chuẩn bị: admin, người bán, người mua, một tin đăng, một tranh chấp đang mở');
  const admin = await createAdmin(null, { username: `uia${stamp}` });
  const seller = await createSeller(null, null, admin, { username: `uis${stamp}`, displayName: 'Bán Thử' });
  const buyer = await flows.registerUser({ username: `uib${stamp}`, displayName: 'Mua Thử' });
  const listing = await api('/api/listings', {
    method: 'POST', token: seller.token,
    body: { title: `Tin kiểm thử ${stamp}`, category: 'MAY_TINH', price: 2000000, location: 'Hà Nội' },
  });
  const t = await api('/api/transactions', {
    method: 'POST', token: buyer.token,
    body: { sellerId: seller.user.id, itemName: 'Máy ảnh cũ', amount: 1500000 },
  });
  const id = t.data.id;
  const setup = [await api(`/api/transactions/${id}/secure`, { method: 'POST', token: buyer.token, body: { requestId: rid() } })];
  setup.push(await api(`/api/transactions/${id}/acknowledge`, { method: 'POST', token: seller.token }));
  setup.push(await api(`/api/transactions/${id}/ship`, { method: 'POST', token: seller.token }));
  setup.push(await api(`/api/transactions/${id}/wait-confirm`, { method: 'POST', token: buyer.token }));
  setup.push(await api(`/api/transactions/${id}/dispute`, { method: 'POST', token: buyer.token, body: { reason: 'Hàng sai mô tả' } }));
  ok(listing.status === 201 && t.status === 201 && setup.every((r) => r.status === 200 || r.status === 201),
    'Dữ liệu mẫu tạo xong (tin đăng, giao dịch, tranh chấp OPEN)');

  // ------------------------------------------------------------------------------------------
  section('B4: admin hoàn tiền / giải ngân — bước xem lại đứng TRƯỚC Passkey');
  let p = await openPage('#/admin/disputes', { token: admin.token, user: admin.user });
  ok(!!p.d.querySelector('[data-act="admin-refund"]'), 'Thấy nút hoàn tiền');
  click(p.w, p.d.querySelector('[data-act="admin-refund"]'));
  await sleep(200);
  let modal = p.d.querySelector('.modal');
  ok(modal && /không thể hoàn tác/.test(modal.textContent), 'Bấm hoàn tiền mở modal xem lại (cảnh báo không hoàn tác)');
  ok(modal && /Mua Thử/.test(modal.textContent) && /1\.500\.000/.test(modal.textContent) && /Hoàn toàn bộ tiền/.test(modal.textContent),
    'Hoàn tiền: nêu hành động, NGƯỜI MUA là bên nhận, đúng số tiền');
  const recipientRow = [...modal.querySelectorAll('.price-row')].find((r) => /nhận tiền/.test(r.textContent));
  ok(!!recipientRow && /Mua Thử/.test(recipientRow.textContent) && !/Bán Thử/.test(recipientRow.textContent),
    'Hoàn tiền: dòng "nhận tiền" là người mua, không phải người bán');
  ok(!p.calls.some((c) => /reauth|\/refund|\/release/.test(c)), 'Chưa có request reauth/refund/release trước khi xác nhận');

  pressEscape(p.w);
  await sleep(100);
  ok(!hasModal(p), 'Modal thường (xem lại) đóng được bằng Escape');

  click(p.w, p.d.querySelector('[data-act="admin-release"]'));
  await sleep(200);
  modal = p.d.querySelector('.modal');
  ok(modal && /Bán Thử/.test(modal.textContent) && /Chuyển toàn bộ tiền/.test(modal.textContent) && /1\.500\.000/.test(modal.textContent),
    'Giải ngân: NGƯỜI BÁN là bên nhận, đúng số tiền');

  const cancel = [...p.d.querySelectorAll('.modal-foot [data-act="modal-close"]')].find((b) => /Huỷ/.test(b.textContent));
  ok(!!cancel, 'Có nút Huỷ trong modal xem lại');
  click(p.w, cancel);
  await sleep(300);
  ok(!hasModal(p), 'Huỷ đóng modal');
  ok(!p.calls.some((c) => /reauth|\/refund|\/release/.test(c)), 'Huỷ: không gọi reauth, không gửi quyết định');

  click(p.w, p.d.querySelector('[data-act="admin-release"]'));
  await sleep(200);
  click(p.w, p.d.querySelector('[data-act="admin-confirm"]'));
  await sleep(800);
  ok(p.calls.some((c) => /POST .*\/disputes\/.*\/reauth\/options/.test(c)), 'Chỉ SAU xác nhận mới gọi reauth/options (bắt đầu xác thực lại)');
  ok(!p.calls.some((c) => /\/(release|refund)$/.test(c)), 'Chưa gọi /release hay /refund khi chưa qua Passkey (jsdom không có WebAuthn)');
  p.close();

  // ------------------------------------------------------------------------------------------
  section('B1: modal thiết lập bắt buộc — Escape / bấm nền / nút đóng');
  const reg = await api('/api/passkeys/register/account', {
    method: 'POST', body: { username: `uip${stamp}`, displayName: 'Chưa Passkey', password: DEFAULT_PASSWORD },
  });
  ok(reg.status === 201 || reg.status === 200, 'Tạo tài khoản chưa có Passkey (PENDING_PASSKEY)');
  p = await openPage('#/', null);
  const opener = [...p.d.querySelectorAll('[data-act]')].find((e) => /login|auth/i.test(e.dataset.act));
  click(p.w, opener);
  await sleep(200);
  p.d.querySelector('#loginUsername').value = `uip${stamp}`;
  p.d.querySelector('#loginPassword').value = DEFAULT_PASSWORD;
  click(p.w, p.d.querySelector('[data-act="do-login-password"]'));
  await sleep(1500);
  ok(hasModal(p), 'Modal thiết lập Passkey hiện sau khi đăng nhập bằng mật khẩu');
  ok(!p.d.querySelector('[data-act="modal-close"]'), 'Không có nút đóng');
  pressEscape(p.w);
  await sleep(100);
  ok(hasModal(p), 'Escape KHÔNG đóng modal bắt buộc');
  click(p.w, p.d.querySelector('.modal-backdrop'));
  await sleep(100);
  ok(hasModal(p), 'Bấm nền không đóng modal bắt buộc');
  p.close();

  // ------------------------------------------------------------------------------------------
  section('B2: thẻ người bán không khẳng định xác minh danh tính');
  p = await openPage(`#/listing/${listing.data.id}`, { token: buyer.token, user: buyer.user });
  const card = p.d.querySelector('.seller-card');
  ok(!!card && /Bán Thử/.test(card.textContent), 'Thẻ người bán hiển thị trên trang tin đăng');
  ok(!/xác minh danh tính/i.test(p.d.body.textContent), 'Không còn câu "Tài khoản đã xác minh danh tính"');
  p.close();

  // ------------------------------------------------------------------------------------------
  section('B3: trang nạp tiền — thanh toán mô phỏng, không phương thức giả');
  p = await openPage('#/wallet', { token: buyer.token, user: buyer.user });
  const txt = p.d.querySelector('#view').textContent;
  ok(!p.d.querySelector('input[name="payMethod"]'), 'Không còn lựa chọn phương thức thanh toán');
  ok(/thanh toán mô phỏng/i.test(txt) && /chưa nối PayPal/.test(txt), 'Ghi rõ thanh toán mô phỏng, chưa nối PayPal');
  ok(!/Thẻ ATM|Ví điện tử|Chuyển khoản ngân hàng/.test(txt), 'Không còn nhãn thẻ / ví / ngân hàng');
  p.close();

  console.log(`\n${checks} kiểm tra, ${fails ? fails + ' FAIL' : 'ALL PASS'}`);
  process.exit(fails ? 1 : 0);
}

main().catch((e) => { console.error('[ui-flow-jsdom] lỗi:', e); process.exit(1); });
