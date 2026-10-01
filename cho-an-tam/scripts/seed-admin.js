#!/usr/bin/env node
/**
 * Thủ tục vận hành khởi tạo quản trị viên đầu tiên.
 *
 *   npm run seed:admin -- --username=admin01 --display="Quản trị viên"
 *   npm run seed:admin -- --username=admin01 --password="MatKhauTam-123"
 *
 * Script này CHẠY TRỰC TIẾP TRÊN MÁY CHỦ và không được phơi ra dưới dạng một điểm cuối
 * HTTP. Nó chỉ tạo tài khoản ở trạng thái chờ thiết lập; hai bước còn lại (đổi mật khẩu
 * tạm, đăng ký Passkey đầu tiên) phải làm trên trình duyệt, vì khoá riêng của Passkey do
 * bộ xác thực trên thiết bị người dùng sinh ra — một tiến trình chạy ở máy chủ không dựng
 * nổi một credential hợp lệ.
 */
const { createBootstrapAdmin, BootstrapError } = require('../src/lib/adminBootstrap');

function readArgs(argv) {
  const args = {};
  for (const raw of argv.slice(2)) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(raw);
    if (m) args[m[1]] = m[2] === undefined ? true : m[2];
  }
  return args;
}

function main() {
  const args = readArgs(process.argv);
  const username = args.username || args.u;
  if (!username || username === true) {
    console.error('Thiếu tham số. Ví dụ:');
    console.error('  npm run seed:admin -- --username=admin01 --display="Quản trị viên"');
    process.exit(1);
  }

  try {
    const { user, temporaryPassword } = createBootstrapAdmin({
      username,
      displayName: args.display || args.d,
      temporaryPassword: typeof args.password === 'string' ? args.password : undefined,
    });

    const origin = process.env.WEBAUTHN_ORIGIN || `http://localhost:${process.env.PORT || 3000}`;
    console.log('');
    console.log('  Đã khởi tạo tài khoản quản trị viên ở trạng thái chờ thiết lập.');
    console.log('');
    console.log(`     Tên đăng nhập : ${user.username}`);
    console.log(`     Tên hiển thị  : ${user.display_name}`);
    console.log(`     Mật khẩu tạm  : ${temporaryPassword}`);
    console.log(`     Trạng thái    : ${user.account_status}`);
    console.log('');
    console.log('  Còn hai bước phải làm trên trình duyệt, theo đúng thứ tự:');
    console.log(`     1. Mở ${origin} và đăng nhập bằng mật khẩu tạm ở trên.`);
    console.log('     2. Đổi mật khẩu tạm, rồi đăng ký Passkey đầu tiên.');
    console.log('');
    console.log('  Trước khi hoàn tất cả hai bước, tài khoản này KHÔNG gọi được chức năng quản trị nào.');
    console.log('  Mật khẩu tạm chỉ hiện đúng một lần ở đây — hãy chép lại ngay.');
    console.log('');
  } catch (e) {
    if (e instanceof BootstrapError) {
      console.error(`\n  Không khởi tạo được: [${e.code}] ${e.message}\n`);
      process.exit(2);
    }
    throw e;
  }
}

main();
