// Chèn lỗi chủ động để chứng minh tính nguyên tử của nghiệp vụ tài chính.
//
// Vì sao cần: nói "toàn bộ nghiệp vụ nằm trong một giao dịch cơ sở dữ liệu" là một lời khẳng
// định, không phải một bằng chứng. Cách mạnh nhất để chứng minh là cố tình làm hỏng nghiệp vụ
// ở giữa chừng — sau khi số dư đã đổi nhưng trước khi bút toán được ghi — rồi kiểm rằng mọi
// thứ quay về đúng trạng thái cũ.
//
// Cơ chế được canh bằng biến môi trường và MẶC ĐỊNH TẮT. Khi FAULT_INJECT không được đặt,
// maybeFail() chỉ là một phép so sánh chuỗi rồi trả về ngay; không có nhánh nào chạm tới dữ
// liệu. Khi thu kết quả chính thức thì biến này phải tắt, và máy chủ in cảnh báo lớn ở màn
// hình khởi động nếu nó đang bật.
//
// Điểm chèn được đặt tên để bài kiểm thử nêu đích danh nơi muốn hỏng:
//   after-wallet-update    số dư đã đổi, bút toán chưa ghi (lock / release / admin-refund /
//                          admin-release / topup)
//   before-status-change   bút toán đã ghi, trạng thái giao dịch chưa đổi
//   before-audit-log       trạng thái đã đổi, nhật ký chưa nối

const POINTS = new Set(['after-wallet-update', 'before-status-change', 'before-audit-log']);

class InjectedFault extends Error {
  constructor(point) {
    super(`Lỗi được chèn chủ động tại điểm "${point}" để kiểm thử rollback.`);
    this.status = 500;
    this.code = 'INJECTED_FAULT';
    this.point = point;
  }
}

/**
 * Ném lỗi nếu điểm này đang được chọn qua biến môi trường.
 *
 * Giá trị của FAULT_INJECT có hai dạng:
 *   "after-wallet-update"          bắn ở MỌI nghiệp vụ đi qua điểm đó
 *   "release:after-wallet-update"  chỉ bắn ở nghiệp vụ tên `release`
 *
 * Dạng có tên nghiệp vụ là dạng cần dùng khi kiểm thử: khoá tiền và giải ngân dùng chung
 * đúng một khung xử lý, nên nếu bắn ở mọi nghiệp vụ thì giao dịch hỏng ngay từ bước khoá
 * tiền và không bao giờ tới được bước cần kiểm.
 *
 * Đọc process.env ở mỗi lần gọi chứ không đọc một lần lúc nạp module, để đổi điểm chèn mà
 * không phải sửa mã.
 */
// FAULT_INJECT_MODE=crash thay việc ném lỗi bằng process.exit NGAY giữa giao dịch: không có
// nhánh catch nào chạy, không có ROLLBACK nào được gọi — đúng như máy chủ bị tắt ngang. Khi
// đó chỉ còn cơ chế nhật ký của SQLite bảo đảm phần đã ghi dở không bao giờ được coi là đã
// commit. Chế độ này CHỈ dùng cho process worker chạy riêng; bật trên máy chủ web thì máy chủ
// tự tắt theo.
const CRASH_EXIT_CODE = 97;

function maybeFail(point, op = 'any') {
  const selected = process.env.FAULT_INJECT;
  if (!selected) return;

  const idx = selected.indexOf(':');
  const selectedOp = idx === -1 ? 'any' : selected.slice(0, idx);
  const selectedPoint = idx === -1 ? selected : selected.slice(idx + 1);

  if (selectedPoint !== point) return;
  if (selectedOp !== 'any' && selectedOp !== op) return;
  if (process.env.FAULT_INJECT_MODE === 'crash') process.exit(CRASH_EXIT_CODE);
  throw new InjectedFault(`${op}:${point}`);
}

function isEnabled() {
  return Boolean(process.env.FAULT_INJECT);
}

module.exports = { maybeFail, isEnabled, InjectedFault, POINTS, CRASH_EXIT_CODE };
