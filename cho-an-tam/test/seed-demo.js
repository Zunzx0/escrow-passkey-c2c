/**
 * Dựng sẵn dữ liệu để xem giao diện: một người bán kèm 8 tin đăng mẫu và một người mua.
 *
 * Chạy khi server đang bật:  node test/seed-demo.js
 * In ra mã phiên của hai tài khoản để dán vào localStorage nếu muốn xem nhanh.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fetch = globalThis.fetch || require('node-fetch');
const { createAuthenticator } = require('./softwareAuthenticator');
const { createAdmin, createSeller, flows } = require('./helpers/accounts');

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const RP_ID = process.env.WEBAUTHN_RP_ID || 'localhost';
const ORIGIN = process.env.WEBAUTHN_ORIGIN || BASE;

async function api(path, opts = {}) {
  const { method = 'GET', body, token } = opts;
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let data = {};
  try { data = await res.json(); } catch (_) {}
  return { status: res.status, data };
}

// Đăng ký gồm HAI bước: tạo tài khoản bằng mật khẩu, rồi đăng ký Passkey bắt buộc.
// Chỉ sau bước thứ hai tài khoản mới ACTIVE và mới có ví.
const registerUser = flows.registerUser;

async function main() {
  const stamp = Date.now().toString(36);
  // Không còn mã mời: quyền bán phải đi qua đúng quy trình xin và duyệt, nên script
  // tự dựng một quản trị viên tạm bằng thủ tục vận hành rồi dùng tài khoản đó để duyệt.
  const admin = await createAdmin(registerUser, {
    username: `seed_admin_${stamp}`, displayName: 'Quản trị seed',
  });
  const seller = await createSeller(api, registerUser, admin, {
    username: `shop_${stamp}`, displayName: 'Trần Thu Thảo', shopName: 'Đồ cũ nhà Thảo',
  });
  const seeded = await api('/api/listings/demo-seed', { method: 'POST', token: seller.token });
  const buyer = await registerUser({ username: `khach_${stamp}`, displayName: 'Khách demo' });

  console.log(`Đã tạo ${seeded.data.created} tin đăng mẫu.`);
  console.log(`\nQuản trị  : ${admin.user.username}`);
  console.log(`Người bán : ${seller.user.username}`);
  console.log(`Người mua : ${buyer.user.username}`);
  console.log('\nDán vào Console của trình duyệt để đăng nhập với tư cách người mua:');
  console.log(`localStorage.setItem('cat_token', ${JSON.stringify(buyer.token)});`);
  console.log(`localStorage.setItem('cat_user',${JSON.stringify(JSON.stringify(buyer.user))}); location.reload();`);
}

main().catch((e) => { console.error(e); process.exit(1); });
