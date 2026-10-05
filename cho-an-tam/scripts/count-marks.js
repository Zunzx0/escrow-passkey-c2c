// Đếm kết quả kiểm tra thực tế trong đầu ra của một bộ test.
//
// Mỗi phép kiểm in một dòng bắt đầu bằng ✅ hoặc ❌ (có thể thụt lề): "  ✅ nhãn". Dòng tổng
// kết của bộ test cũng chứa emoji nhưng bắt đầu bằng "=== KẾT QUẢ: …" ("TẤT CẢ PASS ✅",
// "N TEST FAIL ❌"), không phải một phép kiểm. Đếm mọi ký tự emoji sẽ cộng thừa đúng một
// dòng cho mỗi bộ, vì vậy chỉ đếm dòng mà emoji đứng ĐẦU dòng.
function countMarks(out) {
  const text = String(out || '');
  return {
    pass: (text.match(/^[ \t]*✅/gm) || []).length,
    fail: (text.match(/^[ \t]*❌/gm) || []).length,
  };
}

module.exports = { countMarks };
