'use strict';

// SPA thật với API giả trong bộ nhớ. Không tài khoản/DB/mạng production.
const assert = require('node:assert/strict');
const { wallet, json, sleep, BUYER, logoutUi } = require('./paypal-wallet-ui');
const motion = require('../../public/js/shipping-motion');
let checks = 0;
function ok(value, message) { assert.ok(value, message); checks++; console.log('✅ ' + message); }
const SELLER = { ...BUYER, id: 'u-seller', role: 'SELLER', displayName: 'Người bán thử' };
const iso = (ms) => new Date(ms).toISOString();
const base = () => ({ id: 'tx-shipping', buyerId: BUYER.id, sellerId: SELLER.id, buyerName: 'Người mua', sellerName: 'Người bán',
  itemName: 'Túi vải canvas', amount: 60000, status: 'SECURED', escrowStatus: 'LOCKED', version: 0,
  createdAt: iso(Date.now()), sellerAckAt: null, shipment: null, dispute: null });
function shipment(status, age = 0) {
  const start = Date.now() - age;
  return { id: 'shipment-1', status, packedAt: iso(start), pickupDueAt: iso(start + 4700), arrivalDueAt: iso(start + 19200),
    pickedUpAt: status !== 'PICKUP_PENDING' ? iso(start + 4700) : null,
    arrivedAt: status === 'ARRIVED' ? iso(start + 19200) : null, serverNow: iso(Date.now()) };
}
async function page(user, getRow, extra = {}) {
  return wallet({ user, hash: '#/tx/tx-shipping', extra: {
    'GET /api/transactions': () => json(200, { transactions: [getRow()] }),
    'GET /api/transactions/tx-shipping': () => json(200, getRow()),
    'GET /api/transactions/tx-shipping/logs': () => json(200, { logs: [] }),
    'GET /api/notifications/todo': () => json(200, { items: [] }), ...extra,
  } });
}
const click = (p, act) => { const button = p.d.querySelector(`[data-act="${act}"]`); assert.ok(button, act + ' exists'); p.click(button); };

async function main() {
  const clock = Date.now();
  let t = { ...base(), shipment: shipment('PICKUP_PENDING', 50000) };
  ok(motion.snapshot(t, clock + 50000).phase === 'pickup_wait', 'Đồng hồ client hết thời gian vẫn chờ máy chủ xác nhận lấy hàng');
  t = { ...t, status: 'SHIPPING', shipment: shipment('IN_TRANSIT', 50000) };
  ok(motion.snapshot(t, clock + 50000).phase === 'arrival_wait', 'Không báo giao đến khi chưa có arrivedAt');
  ok(motion.snapshot({ ...t, status: 'DISPUTED', escrowStatus: 'FROZEN' }, clock).running === false, 'Tranh chấp dừng chuyển động dù worker chưa đánh STOPPED');
  ok(!/data-act="shipping-open"/.test(motion.render(base())), 'Đơn chưa đóng gói không có chuyến giả để mở');

  let row = base(), resolvePack;
  let p = await page(SELLER, () => row, {
    'POST /api/transactions/tx-shipping/acknowledge': () => { row = { ...row, sellerAckAt: iso(Date.now()), version: 1 }; return json(200, row); },
    'POST /api/transactions/tx-shipping/pack': () => new Promise((resolve) => { resolvePack = resolve; }),
  });
  try {
    ok(!!p.d.querySelector('[data-act="acknowledge"]') && !p.d.querySelector('[data-act="pack"]'), 'Người bán phải xác nhận đơn trước khi đóng gói');
    click(p, 'acknowledge'); await sleep(120);
    ok(!!p.d.querySelector('[data-act="pack"]') && !p.d.querySelector('[data-act="ship"]'), 'Sau xác nhận chỉ có bước Đã đóng gói, không còn nút giao tay');
    click(p, 'pack'); await sleep(25);
    ok(/Kiện hàng đã sẵn sàng/.test(p.d.querySelector('#modalRoot').textContent), 'Đóng gói có popup xác nhận giữa màn hình');
    click(p, 'modal-close'); await sleep(25);
    ok(p.count('POST /api/transactions/tx-shipping/pack') === 0, 'Hủy popup không tạo chuyến');
    click(p, 'pack'); await sleep(20); click(p, 'pack-confirm'); await sleep(25);
    ok([...p.d.querySelectorAll('#modalRoot button')].every((button) => button.disabled), 'Khóa toàn bộ nút popup khi tạo chuyến đang xử lý');
    p.d.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    p.click(p.d.querySelector('.modal-backdrop'));
    click(p, 'pack-confirm'); await sleep(20);
    ok(p.count('POST /api/transactions/tx-shipping/pack') === 1 && !!p.d.querySelector('[data-act="pack-confirm"]'), 'Escape, nền và click lặp không đóng hoặc gửi lại thao tác đang xử lý');
    row = { ...row, version: 2, shipment: shipment('PICKUP_PENDING') };
    resolvePack(json(201, row)); await sleep(130);
    ok(!!p.d.querySelector('.shipping-motion-scene'), 'Máy chủ tạo chuyến xong mới mở animation lấy hàng');
    ok(!p.d.querySelector('#view [data-act="pack"]') && /Chờ xe lấy hàng/.test(p.viewText()), 'Đã đóng gói thì không cho đóng gói lần nữa');
    const pickup = p.d.querySelector('[data-shipping-part="pickup-parcel"]');
    const truck = p.d.querySelector('[data-shipping-part="pickup-truck"]');
    ok(!!pickup && !!truck && (pickup.compareDocumentPosition(truck) & p.w.Node.DOCUMENT_POSITION_FOLLOWING), 'Kiện hàng được vẽ sau lớp thùng xe để khuất khi đi qua cửa sau');
    click(p, 'modal-close'); await sleep(20);
    ok(p.d.querySelector('#modalRoot').children.length === 0, 'Đóng animation không hủy chuyến vận chuyển');
    row = { ...row, status: 'SHIPPING', version: 3, shipment: shipment('IN_TRANSIT', 6000) };
    await sleep(1400);
    ok(!p.d.querySelector('#view [data-act="wait-confirm"]') && /Đang giao/.test(p.viewText()), 'Phía người bán tự cập nhật trạng thái lấy hàng');
  } finally { p.close(); }

  row = { ...row, shipment: shipment('IN_TRANSIT', 7000) };
  p = await page(BUYER, () => row);
  try {
    ok(!!p.d.querySelector('.shipping-motion-scene'), 'Người mua tự nhận popup khi kiện hàng đang được vận chuyển');
    ok(!p.d.querySelector('#view [data-act="wait-confirm"]'), 'Chưa giao đến thì không mời người mua xác nhận nhận hàng');
    click(p, 'modal-close'); await sleep(30);
    row = { ...row, shipment: shipment('ARRIVED', 24000) };
    await sleep(1450);
    ok(!!p.d.querySelector('.shipping-motion-scene') && /Đơn hàng đã đến/.test(p.d.querySelector('#modalRoot').textContent), 'Máy chủ báo đến thì popup thông báo hàng đã đến xuất hiện');
    ok(!!p.d.querySelector('#view [data-act="wait-confirm"]'), 'Chỉ sau ARRIVED mới cho xác nhận đã nhận hàng');
    ok(p.log.every((entry) => !/^POST .*\/(wait-confirm|release|reauth|secure)$/.test(entry)), 'Animation và polling không tự xác nhận nhận hàng hoặc giải ngân');
    click(p, 'modal-close'); await sleep(1400);
    ok(p.d.querySelector('#modalRoot').children.length === 0, 'Đóng thông báo đã đến thì không bật lại cùng thông báo ở lần poll sau');
  } finally { p.close(); }

  let finishOldPoll;
  p = await page(BUYER, base, { 'GET /api/transactions': () => new Promise((resolve) => { finishOldPoll = resolve; }) });
  try {
    await logoutUi(p);
    finishOldPoll(json(200, { transactions: [row] })); await sleep(80);
    ok(!p.d.querySelector('.shipping-motion-scene'), 'Phản hồi vận chuyển đến sau đăng xuất không mở popup của phiên cũ');
  } finally { p.close(); }
  let finishOldOpen, delayDetail = false;
  row = { ...row, status: 'WAIT_CONFIRM', version: 4 };
  p = await page(BUYER, () => row, {
    'GET /api/transactions/tx-shipping': () => !delayDetail ? json(200, row) : new Promise((resolve) => { finishOldOpen = resolve; }),
  });
  try {
    delayDetail = true;
    click(p, 'shipping-open'); await sleep(20);
    click(p, 'open-dispute'); await sleep(20);
    finishOldOpen(json(200, row)); await sleep(60);
    ok(/Mở tranh chấp/.test(p.d.querySelector('#modalRoot h2').textContent) && !p.d.querySelector('.shipping-motion-scene'), 'Phản hồi mở hành trình cũ không thay hộp thoại người dùng vừa mở');
  } finally { p.close(); }
  console.log(`${checks} kiểm tra giao diện vận chuyển đã đạt`);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
