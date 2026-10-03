// Vòng đời của một tin đăng đơn chiếc SAU khi tiền đã khoá:
//
//   AVAILABLE --(lock, /secure)--> LOCKED --(giải ngân: release / admin-release)--> SOLD
//                                        \--(hoàn tiền: admin-refund)------------> AVAILABLE
//
// Chiều đi (AVAILABLE -> LOCKED) nằm ở lockListingForOrder trong routes/transactions.js. Module
// này lo chiều về. Trước đây chiều về không tồn tại: đơn đã hoàn tiền vẫn để tin đăng kẹt ở
// LOCKED (không ai mua lại được dù tiền đã trả về người mua), còn đơn đã giải ngân cũng chỉ
// LOCKED chứ không SOLD.
//
// PHẢI gọi bên trong CÙNG db.transaction() với việc chuyển tiền và đổi trạng thái giao dịch: tin
// đăng chỉ được rời LOCKED khi đúng nghiệp vụ đó commit, và rollback ở bất kỳ bước nào (kể cả
// lỗi chèn chủ động) thì tin đăng quay về LOCKED cùng với tiền.
const { db, nowIso } = require('../db');
const { ConflictError } = require('./errors');

const LISTING_STATUS_AFTER = {
  RELEASE: 'SOLD',
  REFUND: 'AVAILABLE',
};

/**
 * Đưa tin đăng của giao dịch rời khỏi LOCKED theo kết cục tất toán (RELEASE -> SOLD, REFUND ->
 * AVAILABLE). Giao dịch không gắn tin đăng (tạo thủ công qua POST /api/transactions) thì bỏ qua.
 *
 * Cập nhật có điều kiện `status = 'LOCKED'`, cùng khuôn mẫu với lockListingForOrder: nếu tin đăng
 * không ở LOCKED thì dữ liệu đã lệch với tiền, và nghiệp vụ bị huỷ cả khối thay vì tất toán tiền
 * trong khi tin đăng mang trạng thái sai.
 */
async function settleListing(txn, outcome) {
  if (!txn.listing_id) return null;
  const target = LISTING_STATUS_AFTER[outcome];
  if (!target) throw new Error(`Kết cục tất toán không hợp lệ: ${outcome}`);
  const result = await db
    .prepare(
      `UPDATE listings SET status = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND status = 'LOCKED'`
    )
    .run(target, nowIso(), txn.listing_id);
  if (result.changes !== 1) {
    throw new ConflictError(
      'LISTING_STATE_CONFLICT',
      'Trạng thái tin đăng không khớp với giao dịch đang tất toán, nghiệp vụ đã được huỷ toàn bộ'
    );
  }
  return target;
}

// Dữ liệu tạo ra TRƯỚC bản sửa này (tin đăng còn LOCKED dù giao dịch đã tất toán) được chuẩn hoá
// lúc khởi động — xem lib/listingNormalize.js.

module.exports = { settleListing, LISTING_STATUS_AFTER };
