/**
 * Kiểm thử bộ đếm kết quả của scripts/run-suite.js (scripts/count-marks.js).
 *
 * Lỗi cũ: đếm mọi ký tự ✅/❌ trong log, nên dòng tổng kết "=== KẾT QUẢ: TẤT CẢ PASS ✅ ===" bị
 * cộng thành một phép kiểm đạt (và "N TEST FAIL ❌" bị cộng thành một phép kiểm hỏng), làm báo
 * cáo cao hơn thực tế một đơn vị cho mỗi bộ.
 *
 * Không cần máy chủ hay cơ sở dữ liệu:  node test/count-marks-unit.js
 */
const { countMarks } = require('../scripts/count-marks');

let failures = 0;
function eq(actual, expected, label) {
  const ok = actual.pass === expected.pass && actual.fail === expected.fail;
  console.log(`  ${ok ? '✅' : '❌'} ${label}${ok ? '' : ` (nhận ${JSON.stringify(actual)}, cần ${JSON.stringify(expected)})`}`);
  if (!ok) failures++;
}

console.log('\nBộ đếm kết quả kiểm tra');

eq(countMarks('  ✅ a\n  ✅ b\n  ✅ c\n'), { pass: 3, fail: 0 }, 'chỉ phép kiểm đạt: đếm đúng số dòng');
eq(countMarks('  ✅ a\n  ❌ b\n  ❌ c\n'), { pass: 1, fail: 2 }, 'có phép kiểm thất bại: đếm riêng đạt và hỏng');

eq(countMarks('\n  ✅ a\n  ✅ b\n\n=== KẾT QUẢ: TẤT CẢ PASS ✅ ===\n\n'), { pass: 2, fail: 0 },
  'dòng tổng kết "TẤT CẢ PASS ✅" không bị tính là một phép kiểm đạt');
eq(countMarks('  ✅ a\n\n=== KẾT QUẢ: TẤT CẢ PASS ✅ (1 pass) ===\n'), { pass: 1, fail: 0 },
  'tổng kết có kèm "(N pass)" cũng không bị tính');
eq(countMarks('  ✅ a\n  ❌ b\n  ❌ c\n\n=== KẾT QUẢ: 2 TEST FAIL ❌ ===\n'), { pass: 1, fail: 2 },
  'tổng kết "N TEST FAIL ❌" không làm đếm lỗi hai lần');
eq(countMarks('  ❌ b\n=== KẾT QUẢ: 1 KIỂM THỬ THẤT BẠI ❌ ===\n'), { pass: 0, fail: 1 },
  'một lỗi duy nhất vẫn là một lỗi, không thành hai');

eq(countMarks(''), { pass: 0, fail: 0 }, 'log rỗng');
eq(countMarks('Khởi động…\nKhông có phép kiểm nào\n'), { pass: 0, fail: 0 }, 'log không có phép kiểm');
eq(countMarks('=== KẾT QUẢ: TẤT CẢ PASS ✅ ===\n'), { pass: 0, fail: 0 }, 'log chỉ có dòng tổng kết: 0 phép kiểm');
eq(countMarks(undefined), { pass: 0, fail: 0 }, 'đầu vào không phải chuỗi không làm hỏng bộ đếm');

eq(countMarks('✅ a\n    ✅ b\n\t✅ c\n'), { pass: 3, fail: 0 }, 'chấp nhận thụt lề bất kỳ (không thụt, bốn dấu cách, tab)');
eq(countMarks('  ✅ a\r\n  ✅ b\r\n=== KẾT QUẢ: TẤT CẢ PASS ✅ ===\r\n'), { pass: 2, fail: 0 }, 'xuống dòng kiểu Windows (CRLF)');
eq(countMarks('  ✅ nhãn nhắc tới ✅ và ❌ ở giữa dòng\n'), { pass: 1, fail: 0 },
  'emoji nằm giữa nhãn của một phép kiểm không bị đếm thêm');

// Mô phỏng đầu ra thật của một bộ: tiêu đề + 3 phép kiểm + tổng kết kèm "(3 pass)".
const realistic = [
  '◇ injected env (0) from .env', '', '=== E2E TEST: http://localhost:3000 ===', '',
  'P1-2: Giới hạn tần suất', '  ✅ Vài lần thử đầu trả 401', '  ✅ Bị chặn 429', '  ✅ Có Retry-After', '',
  '=== KẾT QUẢ: TẤT CẢ PASS ✅ (3 pass) ===', '',
].join('\n');
eq(countMarks(realistic), { pass: 3, fail: 0 }, 'log mô phỏng một bộ thật: 3 phép kiểm, không tính dòng tổng kết');

console.log(failures ? `\n${failures} FAIL\n` : '\nALL PASS\n');
process.exit(failures ? 1 : 0);
