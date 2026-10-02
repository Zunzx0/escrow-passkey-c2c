#!/usr/bin/env node
/**
 * Kiểm chín bất biến của hệ thống trên cơ sở dữ liệu hiện tại.
 *
 *   npm run check:invariants
 *
 * Dùng ở ba chỗ: sau mỗi testcase thủ công, trước khi chốt một lần đo, và ngay trước buổi
 * bảo vệ. Mã thoát khác 0 khi có vi phạm, nên script cũng cắm được vào một quy trình tự động.
 *
 * Cùng một hàm với điểm cuối GET /api/admin/invariants và với bộ kiểm thử tự động — cả ba
 * chỗ nhìn vào đúng một định nghĩa (src/lib/invariants.js), không có bản chép tay nào lệch đi
 * theo thời gian.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { db, describeDatabase } = require('../src/db');
const { checkInvariants } = require('../src/lib/invariants');

async function main() {
  const result = await checkInvariants(db);

  console.log('');
  console.log(`  Kiểm ${result.checked} bất biến hệ thống`);
  console.log(`  Cơ sở dữ liệu: ${describeDatabase()}`);
  console.log('  ' + '-'.repeat(70));
  for (const c of result.checks) {
    console.log(`   ${c.ok ? 'ĐÚNG' : 'SAI '}  ${c.no}. ${c.name}${c.ok ? '' : ` (${c.violations} vi phạm)`}`);
  }
  console.log('  ' + '-'.repeat(70));

  if (result.ok) {
    console.log(`  Không có vi phạm nào trên ${result.checked} bất biến.\n`);
    process.exit(0);
  }

  console.log(`  Có ${result.violations.length} vi phạm:\n`);
  for (const v of result.violations) console.log(`   - [${v.invariant}] ${v.detail}`);
  console.log('');
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});