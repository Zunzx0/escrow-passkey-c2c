#!/usr/bin/env node
/**
 * Bộ dữ liệu thực nghiệm cố định.
 *
 *   npm run seed:experiment
 *
 * Script CHẠY ĐƯỢC NHIỀU LẦN và mỗi lần chỉ làm phần còn thiếu. Lý do: khoá riêng của
 * Passkey do bộ xác thực trên thiết bị người dùng sinh ra, nên một tiến trình chạy ở máy
 * chủ không tạo nổi credential. Vì vậy quy trình là:
 *
 *   lần 1  script tạo bốn tài khoản (chưa có Passkey) và một yêu cầu bán hàng đang chờ
 *          -> người vận hành mở trình duyệt, đăng ký Passkey cho từng tài khoản
 *   lần 2  script thấy seller01 đã sẵn sàng thì tạo các tin đăng cố định
 *
 * Bộ tài khoản cố định để mọi lần đo đều đối chiếu được với nhau:
 *
 *   admin01   quản trị viên, đi đúng luồng bootstrap (mật khẩu tạm -> đổi -> Passkey)
 *   seller01  người bán, đi đúng quy trình xin và duyệt quyền bán
 *   buyer01   người mua chính
 *   buyer02   người mua thứ hai, DÀNH RIÊNG cho các kịch bản tranh đua
 *
 * Mật khẩu cố định và in ra ngay dưới đây. Đây là dữ liệu thực nghiệm trên máy cục bộ, cố
 * ý đặt biết trước để lần đo nào cũng lặp lại được — KHÔNG dùng bộ này ở môi trường thật.
 */
const { db, uuid, nowIso } = require('../src/db');
const { hashPassword } = require('../src/lib/password');
const { createBootstrapAdmin } = require('../src/lib/adminBootstrap');
const { checkInvariants } = require('../src/lib/invariants');

const ADMIN_TEMP_PASSWORD = 'Bootstrap-Admin-2026';
const PASSWORD = 'ThucNghiem-2026';

const ACCOUNTS = [
  { username: 'seller01', displayName: 'Cửa hàng Thực Nghiệm', role: 'BUYER', note: 'sẽ xin quyền bán' },
  { username: 'buyer01', displayName: 'Người Mua Một', role: 'BUYER', note: 'người mua chính' },
  { username: 'buyer02', displayName: 'Người Mua Hai', role: 'BUYER', note: 'dành cho kịch bản tranh đua' },
];

const LISTINGS = [
  { title: 'Điện thoại Samsung Galaxy S21 128GB', category: 'DIEN_THOAI', condition: 'LIKE_NEW', price: 1200000, location: 'Hà Nội',
    description: 'Máy đẹp, pin tốt, đủ hộp. Dùng cho kịch bản mua bán thông thường.' },
  { title: 'Tai nghe Bluetooth JBL Tune 760NC', category: 'DIEN_TU', condition: 'GOOD', price: 850000, location: 'Hà Nội',
    description: 'Dùng cho kịch bản tranh chấp và phân xử.' },
  { title: 'Đồng hồ cơ Orient Bambino sưu tầm', category: 'SUU_TAM', condition: 'GOOD', price: 640000, location: 'Hà Nội',
    description: 'Dùng cho kịch bản hai người mua cùng khoá tiền một tin đăng.' },
];

function findUser(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

function createPendingAccount({ username, displayName }) {
  const id = uuid();
  const now = nowIso();
  db.prepare(
    `INSERT INTO users (id, username, display_name, role, password_hash, account_status, token_version, created_at, updated_at)
     VALUES (?, ?, ?, 'BUYER', ?, 'PENDING_PASSKEY', 0, ?, ?)`
  ).run(id, username, displayName, hashPassword(PASSWORD), now, now);
  return findUser(username);
}

function ensureSellerRequest(seller) {
  const existing = db
    .prepare("SELECT * FROM seller_requests WHERE user_id = ? AND status = 'PENDING'")
    .get(seller.id);
  if (existing) return { created: false, request: existing };
  if (seller.role === 'SELLER') return { created: false, request: null };

  const now = nowIso();
  const id = uuid();
  db.prepare(
    `INSERT INTO seller_requests (id, user_id, shop_name, pitch, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'PENDING', ?, ?)`
  ).run(id, seller.id, 'Cửa hàng Thực Nghiệm', 'Tài khoản phục vụ bộ dữ liệu thực nghiệm cố định.', now, now);
  return { created: true, request: db.prepare('SELECT * FROM seller_requests WHERE id = ?').get(id) };
}

function ensureListings(seller) {
  const created = [];
  for (const spec of LISTINGS) {
    const existing = db.prepare('SELECT id FROM listings WHERE seller_id = ? AND title = ?').get(seller.id, spec.title);
    if (existing) continue;
    const now = nowIso();
    db.prepare(
      `INSERT INTO listings (id, seller_id, title, description, category, condition, location, price, visibility, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PUBLIC', 0, ?, ?)`
    ).run(uuid(), seller.id, spec.title, spec.description, spec.category, spec.condition, spec.location, spec.price, now, now);
    created.push(spec.title);
  }
  return created;
}

function main() {
  console.log('\n  Bộ dữ liệu thực nghiệm cố định');
  console.log('  ' + '='.repeat(64));

  // --- quản trị viên: đi đúng thủ tục bootstrap, không tạo tay ---
  let admin = findUser('admin01');
  if (!admin) {
    createBootstrapAdmin({
      username: 'admin01',
      displayName: 'Quản trị viên Thực Nghiệm',
      temporaryPassword: ADMIN_TEMP_PASSWORD,
    });
    admin = findUser('admin01');
    console.log(`   + admin01   đã tạo, mật khẩu tạm: ${ADMIN_TEMP_PASSWORD}`);
  } else {
    console.log(`   = admin01   đã có, trạng thái ${admin.account_status}`);
  }

  // --- ba tài khoản còn lại ---
  for (const spec of ACCOUNTS) {
    const existing = findUser(spec.username);
    if (!existing) {
      createPendingAccount(spec);
      console.log(`   + ${spec.username.padEnd(9)} đã tạo, mật khẩu: ${PASSWORD}   (${spec.note})`);
    } else {
      console.log(`   = ${spec.username.padEnd(9)} đã có, trạng thái ${existing.account_status}, vai trò ${existing.role}`);
    }
  }

  // --- yêu cầu quyền bán của seller01, để quản trị viên duyệt qua giao diện ---
  const seller = findUser('seller01');
  const sr = ensureSellerRequest(seller);
  if (sr.created) console.log('   + yêu cầu cấp quyền bán của seller01 đang chờ quản trị viên duyệt');

  // --- tin đăng: chỉ tạo được khi seller01 đã là người bán ---
  const sellerReady = seller && seller.role === 'SELLER' && seller.account_status === 'ACTIVE';
  if (sellerReady) {
    const made = ensureListings(seller);
    if (made.length) made.forEach((t) => console.log(`   + tin đăng: ${t}`));
    else console.log('   = ba tin đăng cố định đã có đủ');
  }

  // --- việc còn lại phải làm trên trình duyệt ---
  const pending = [];
  if (admin.account_status !== 'ACTIVE') {
    pending.push(
      `admin01: đăng nhập bằng mật khẩu tạm "${ADMIN_TEMP_PASSWORD}" -> đổi mật khẩu -> đăng ký Passkey`
    );
  }
  for (const spec of ACCOUNTS) {
    const u = findUser(spec.username);
    if (u.account_status !== 'ACTIVE') {
      pending.push(`${spec.username}: đăng nhập bằng mật khẩu "${PASSWORD}" -> đăng ký Passkey`);
    }
  }
  if (seller && seller.role !== 'SELLER') {
    pending.push('admin01: duyệt yêu cầu cấp quyền bán của seller01, rồi chạy lại script này để tạo tin đăng');
  }

  console.log('  ' + '='.repeat(64));
  if (pending.length === 0) {
    console.log('   Bộ dữ liệu đã đầy đủ. Có thể bắt đầu thu kết quả.');
  } else {
    console.log('   Còn phải làm trên trình duyệt (khoá riêng Passkey chỉ sinh được ở thiết bị):');
    pending.forEach((p, i) => console.log(`     ${i + 1}. ${p}`));
  }

  const inv = checkInvariants(db);
  console.log(`   Bất biến: ${inv.ok ? 'cả bảy đều đúng' : `${inv.violations.length} VI PHẠM`}`);
  if (!inv.ok) inv.violations.forEach((v) => console.log(`     - [${v.invariant}] ${v.detail}`));
  console.log('');
}

main();
