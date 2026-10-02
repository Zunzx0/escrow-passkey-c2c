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
 *
 * Khi DATABASE_URL có giá trị (PostgreSQL), không có thư mục data/ nào để chuyển đi: script
 * xoá hai schema `app` và `mock_provider` (ứng dụng tự tạo lại ở lần khởi động kế tiếp). Bản
 * PostgreSQL KHÔNG giữ bản sao lưu, nên chỉ chạy khi APP_ENV là dev hoặc test VÀ tên cơ sở dữ
 * liệu kết thúc bằng _dev hoặc _test — không bao giờ chạm tới Supabase thật.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');

const args = new Set(process.argv.slice(2));
const keepBackup = !args.has('--keep-backup=false') && !args.has('--no-backup');

async function resetPostgres(databaseUrl) {
  function refuse(msg) {
    console.error(`\n  Không reset: ${msg}\n`);
    process.exit(1);
  }

  // Cùng quy ước với máy chủ: APP_ENV không đặt nghĩa là dev.
  const appEnv = process.env.APP_ENV || 'dev';
  if (appEnv !== 'dev' && appEnv !== 'test') {
    refuse(`APP_ENV=${appEnv}. Chỉ reset PostgreSQL ở môi trường dev hoặc test.`);
  }

  let url;
  try {
    url = new URL(databaseUrl);
  } catch (_) {
    refuse('DATABASE_URL không đọc được.'); // không in chuỗi kết nối: có thể chứa mật khẩu
  }
  const dbName = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!/_(dev|test)$/.test(dbName)) {
    refuse(`cơ sở dữ liệu "${dbName}" không kết thúc bằng _dev hoặc _test.`);
  }
  const label = `PostgreSQL ${url.hostname}${url.port ? `:${url.port}` : ''}/${dbName}`;

  const pg = require('pg');
  const sslOff = process.env.PGSSL === 'disable' || /sslmode=disable/.test(databaseUrl);
  const client = new pg.Client({ connectionString: databaseUrl, ssl: sslOff ? false : { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query('DROP SCHEMA IF EXISTS app CASCADE');
    await client.query('DROP SCHEMA IF EXISTS mock_provider CASCADE');
  } finally {
    await client.end();
  }
  console.log(`\n  Đã xoá schema app và mock_provider trên ${label}.`);
  console.log('  Chạy `npm start` để tạo lại cơ sở dữ liệu trống, rồi `npm run seed:experiment`.\n');
}

if (process.env.DATABASE_URL) {
  resetPostgres(process.env.DATABASE_URL).then(
    () => process.exit(0),
    (e) => {
      // Lỗi của pg không chứa mật khẩu, nhưng vẫn chỉ in thông điệp chứ không in cả đối tượng.
      console.error(`\n  Reset PostgreSQL thất bại: ${e && e.message}\n`);
      process.exit(1);
    }
  );
  return;
}

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
