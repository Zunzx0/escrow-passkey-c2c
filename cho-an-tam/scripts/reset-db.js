#!/usr/bin/env node
/**
 * Đưa cơ sở dữ liệu về trạng thái trắng đã biết.
 *
 *   npm run reset-db
 *   npm run reset-db -- --keep-backup=false
 *
 * Vì sao cần: mỗi testcase độc lập phải bắt đầu từ một trạng thái đã biết. Nếu một lần đo
 * để lại giao dịch COMPLETED, phiếu đã tiêu thụ hoặc challenge cũ rồi mang thẳng sang lần
 * đo sau, rất dễ tưởng hệ thống lỗi trong khi thực ra dữ liệu thực nghiệm bị bẩn.
 *
 * Mặc định giữ lại bản cũ dưới dạng thư mục data-backup-<mốc thời gian> thay vì xoá hẳn,
 * để một lần đo lỡ tay vẫn còn đường quay lại.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');

const args = new Set(process.argv.slice(2));
const keepBackup = !args.has('--keep-backup=false') && !args.has('--no-backup');

if (!fs.existsSync(DATA_DIR)) {
  console.log('\n  Chưa có thư mục data/ — cơ sở dữ liệu sẽ được tạo mới ở lần chạy `npm start` kế tiếp.\n');
  process.exit(0);
}

if (keepBackup) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(ROOT, `data-backup-${stamp}`);
  fs.renameSync(DATA_DIR, dest);
  console.log(`\n  Đã chuyển data/ thành ${path.basename(dest)}.`);
} else {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  console.log('\n  Đã xoá hẳn thư mục data/.');
}

console.log('  Chạy `npm start` để tạo lại cơ sở dữ liệu trống, rồi `npm run seed:experiment`.\n');
