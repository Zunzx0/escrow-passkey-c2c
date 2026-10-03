// Chuẩn hoá trạng thái tin đăng cho dữ liệu tạo ra TRƯỚC khi có lib/listingLifecycle.js.
//
// Trước bản sửa đó, tất toán không đưa tin đăng rời LOCKED: đơn đã hoàn tiền để tin đăng kẹt
// LOCKED (không ai mua lại được), đơn đã giải ngân cũng chỉ LOCKED chứ không SOLD. db.js chạy hai
// câu lệnh dưới đây ở MỖI lần khởi động, trên cả SQLite lẫn PostgreSQL. Cả hai đều có điều kiện
// nên chạy lại không đổi gì (idempotent):
//   - có giao dịch đã giải ngân (COMPLETED/RELEASED)                 -> SOLD
//   - có giao dịch đã hoàn tiền và KHÔNG còn giao dịch nào giữ chỗ   -> AVAILABLE
// SOLD xét trước: tin đăng đã bán thật không bao giờ được mở bán lại chỉ vì nó còn một đơn cũ bị
// hoàn tiền. Điều kiện "không còn giao dịch giữ chỗ" giữ đúng bất biến 6(b).
//
// Module này KHÔNG được require('../db'): db.js gọi nó trong lúc chính db.js đang nạp.
const { RESERVING_STATUSES } = require('./catalog');

// Danh sách trạng thái là hằng số trong mã, không phải dữ liệu người dùng, nên nhúng thẳng vào
// SQL được — tránh khác biệt cú pháp tham số giữa hai nền (`?` và `$n`).
const quoted = (list) => list.map((s) => `'${s}'`).join(',');

/**
 * @param {string} schema tiền tố bảng: '' cho SQLite, 'app.' cho PostgreSQL
 * @param {string} nowExpr biểu thức SQL cho thời điểm hiện tại theo định dạng ISO của hệ thống
 * @returns {{ sold: string, reopened: string }}
 */
function normalizeSettledListingsSql(schema, nowExpr) {
  return {
    sold: `
      UPDATE ${schema}listings SET status = 'SOLD', version = version + 1, updated_at = ${nowExpr}
      WHERE status = 'LOCKED'
        AND EXISTS (SELECT 1 FROM ${schema}transactions t
                    WHERE t.listing_id = ${schema}listings.id AND t.status IN ('COMPLETED','RELEASED'))`,
    reopened: `
      UPDATE ${schema}listings SET status = 'AVAILABLE', version = version + 1, updated_at = ${nowExpr}
      WHERE status = 'LOCKED'
        AND EXISTS (SELECT 1 FROM ${schema}transactions t
                    WHERE t.listing_id = ${schema}listings.id AND t.status = 'REFUNDED')
        AND NOT EXISTS (SELECT 1 FROM ${schema}transactions t
                        WHERE t.listing_id = ${schema}listings.id AND t.status IN (${quoted(RESERVING_STATUSES)}))`,
  };
}

module.exports = { normalizeSettledListingsSql };
