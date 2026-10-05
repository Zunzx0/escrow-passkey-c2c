/**
 * Hồi quy: kiểm số tiền của POST /api/transactions (tạo giao dịch thủ công, không gắn tin đăng).
 *
 * Trước khi sửa, route chỉ kiểm `!amount || amount <= 0`, nên lọt qua:
 *   - số lẻ (1000.5), chuỗi số ("100000", "1e5"), boolean true, số vượt Number.MAX_SAFE_INTEGER;
 * và hai nền lưu trữ xử lý KHÁC NHAU: SQLite (cột INTEGER, kiểu động) cất số lẻ/số khổng lồ thành
 * REAL và ép chuỗi số thành số, còn PostgreSQL (BIGINT) từ chối bằng lỗi SQL -> 500 chung chung.
 *
 * Quy tắc sau khi sửa (src/lib/money.js), cùng quy tắc số nguyên VND an toàn của hệ thống:
 *   - amount phải là SỐ JSON nguyên, an toàn (Number.isSafeInteger) — nếu không: 400 INVALID_AMOUNT
 *   - trong khoảng giá tin đăng 1.000đ – 100.000.000đ                 — nếu không: 400 AMOUNT_OUT_OF_RANGE
 * Không có bản ghi nào được tạo cho yêu cầu bị từ chối; giá trị hợp lệ được lưu đúng nguyên giá trị.
 *
 * Yêu cầu: server test đang chạy (`npm run start:test`).
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const crypto = require('crypto');
const { flows, createAdmin, createSeller } = require('./helpers/accounts');
const { checkInvariants } = require('../src/lib/invariants');
const { db, DIALECT } = require('../src/db');

const BASE = process.env.BASE_URL || 'http://localhost:3100';

let failures = 0;
function assert(cond, label) {
  console.log(`  ${cond ? '✅' : '❌'} ${label}`);
  if (!cond) failures++;
}
function section(title) { console.log(`\n${title}`); }

/** rawBody: gửi nguyên văn chuỗi JSON — cần cho số mà JS không biểu diễn được (vượt 2^53). */
async function api(p, { method = 'GET', body, rawBody, token } = {}, retried = false) {
  const headers = {};
  if (body !== undefined || rawBody !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(BASE + p, { method, headers, body: rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined });
  let data = {};
  try { data = await res.json(); } catch (_) {}
  if (res.status === 429 && !retried) {
    console.log('  ⏳ Chạm rate limit — chờ 60 giây rồi thử lại…');
    await new Promise((r) => setTimeout(r, 61000));
    return api(p, { method, body, rawBody, token }, true);
  }
  return { status: res.status, data };
}

async function main() {
  section('Chuẩn bị: quản trị viên, người bán, người mua');
  const stamp = Date.now();
  const admin = await createAdmin(null, { username: `amt-adm-${stamp}` });
  const seller = await createSeller(null, null, admin, { username: `amt-sel-${stamp}`, displayName: 'Người bán' });
  const buyer = await flows.registerUser({ username: `amt-buy-${stamp}`, displayName: 'Người mua' });
  assert(!!admin.token && !!seller.token && !!buyer.token, 'Ba tài khoản sẵn sàng');

  const countTxns = async () =>
    Number((await db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE buyer_id = ?').get(buyer.user.id)).n);
  const create = (amountJson) => api('/api/transactions', {
    method: 'POST', token: buyer.token,
    rawBody: `{"sellerId":${JSON.stringify(seller.user.id)},"itemName":"Kiểm thử số tiền","amount":${amountJson}}`,
  });

  // =======================================================================================
  section('A1: Sai KIỂU -> 400 INVALID_AMOUNT, không tạo bản ghi');
  // =======================================================================================
  const wrongType = [
    ['số lẻ 1000.5', '1000.5'],
    ['số lẻ 150000.01', '150000.01'],
    ['chuỗi số "100000"', '"100000"'],
    ['chuỗi "1e5"', '"1e5"'],
    ['chuỗi rỗng ""', '""'],
    ['boolean true', 'true'],
    ['boolean false', 'false'],
    ['mảng [100000]', '[100000]'],
    ['object {"v":100000}', '{"v":100000}'],
    ['vượt 2^53: 9007199254740993', '9007199254740993'],
    ['1e20', '1e20'],
  ];
  for (const [label, json] of wrongType) {
    const before = await countTxns();
    const r = await create(json);
    assert(r.status === 400 && r.data.error === 'INVALID_AMOUNT',
      `${label}: 400 INVALID_AMOUNT (nhận ${r.status} ${r.data.error || ''}${r.data.amount !== undefined ? `, lưu amount=${JSON.stringify(r.data.amount)}` : ''})`);
    assert((await countTxns()) === before, `${label}: không có giao dịch nào được tạo`);
  }

  // =======================================================================================
  section('A2: Đúng kiểu nhưng NGOÀI PHẠM VI -> 400 AMOUNT_OUT_OF_RANGE, không tạo bản ghi');
  // =======================================================================================
  for (const [label, json] of [['0', '0'], ['âm -1000', '-1000'], ['dưới mức tối thiểu 999', '999'], ['trên mức tối đa 100000001', '100000001'], ['9007199254740991 (MAX_SAFE_INTEGER)', '9007199254740991']]) {
    const before = await countTxns();
    const r = await create(json);
    assert(r.status === 400 && r.data.error === 'AMOUNT_OUT_OF_RANGE',
      `${label}: 400 AMOUNT_OUT_OF_RANGE (nhận ${r.status} ${r.data.error || ''})`);
    assert((await countTxns()) === before, `${label}: không có giao dịch nào được tạo`);
  }

  // =======================================================================================
  section('A3: Thiếu amount vẫn là lỗi thiếu trường');
  // =======================================================================================
  {
    const r = await api('/api/transactions', { method: 'POST', token: buyer.token, body: { sellerId: seller.user.id, itemName: 'Thiếu số tiền' } });
    assert(r.status === 400 && r.data.error === 'VALIDATION_ERROR', `Thiếu amount: 400 VALIDATION_ERROR (nhận ${r.status} ${r.data.error || ''})`);
  }

  // =======================================================================================
  section('A4: Giá trị hợp lệ được lưu ĐÚNG nguyên giá trị, kiểu số nguyên');
  // =======================================================================================
  for (const amount of [1000, 2000000, 100000000]) {
    const r = await create(String(amount));
    assert(r.status === 201 && r.data.amount === amount && r.data.status === 'CREATED',
      `${amount}: 201 CREATED, amount trả về ${r.data.amount} (nhận ${r.status} ${r.data.error || ''})`);
    if (r.status === 201) {
      const row = await db.prepare('SELECT amount FROM transactions WHERE id = ?').get(r.data.id);
      assert(Number.isSafeInteger(row.amount) && row.amount === amount, `${amount}: CSDL lưu đúng ${amount} (đọc lại ${row.amount})`);
      if (DIALECT === 'sqlite') {
        const t = await db.prepare('SELECT typeof(amount) AS t FROM transactions WHERE id = ?').get(r.data.id);
        assert(t.t === 'integer', `${amount}: SQLite lưu kiểu integer (thực tế ${t.t})`);
      }
    }
  }

  // =======================================================================================
  section('A5: Giao dịch hợp lệ vẫn đi tiếp được; không bản ghi nào mang amount sai kiểu');
  // =======================================================================================
  {
    const r = await create('150000');
    const lock = await api(`/api/transactions/${r.data.id}/secure`, { method: 'POST', token: buyer.token, body: { requestId: crypto.randomUUID() } });
    assert(lock.status === 200 && lock.data.escrowStatus === 'LOCKED', `Khoá tiền giao dịch thủ công hợp lệ được (nhận ${lock.status} ${lock.data.error || ''})`);
    const bad = DIALECT === 'sqlite'
      ? await db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE buyer_id = ? AND typeof(amount) <> 'integer'").get(buyer.user.id)
      : { n: 0 };
    assert(Number(bad.n) === 0, 'Không giao dịch nào của người mua này mang amount không phải số nguyên');
  }

  const inv = await checkInvariants(db);
  assert(inv.ok, `${inv.checked} bất biến đều đúng${inv.ok ? '' : ` (vi phạm: ${JSON.stringify(inv.violations)})`}`);

  console.log(failures ? `\n${failures} FAIL` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error('[manual-transaction-amount] lỗi:', e); process.exit(1); });
