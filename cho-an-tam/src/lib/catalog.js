// Danh mục ngành hàng của sàn C2C. Dùng chung cho form đăng tin và bộ lọc trang chủ.
//
// Đúng loại hàng hoá C2C đã nêu ở Chương 1: đồ đã qua sử dụng, hàng sưu tầm, vật dụng cá nhân.
// `icon` là tên icon trong public/js/icons.js — giao diện không dùng emoji.
const CATEGORIES = [
  { key: 'DIEN_THOAI', label: 'Điện thoại & Máy tính bảng', icon: 'smartphone' },
  { key: 'MAY_TINH', label: 'Laptop & Máy tính', icon: 'laptop' },
  { key: 'DIEN_TU', label: 'Âm thanh & Thiết bị điện tử', icon: 'headphones' },
  { key: 'MAY_ANH', label: 'Máy ảnh & Máy quay', icon: 'camera' },
  { key: 'THOI_TRANG', label: 'Thời trang & Phụ kiện', icon: 'shirt' },
  { key: 'GIA_DUNG', label: 'Đồ gia dụng & Nội thất', icon: 'sofa' },
  { key: 'SACH', label: 'Sách & Văn phòng phẩm', icon: 'book-open' },
  { key: 'THE_THAO', label: 'Thể thao & Xe đạp', icon: 'bike' },
  { key: 'SUU_TAM', label: 'Đồ sưu tầm', icon: 'gem' },
];

const CATEGORY_KEYS = CATEGORIES.map((c) => c.key);

const CONDITIONS = [
  { key: 'NEW', label: 'Mới, chưa sử dụng' },
  { key: 'LIKE_NEW', label: 'Như mới' },
  { key: 'GOOD', label: 'Đã sử dụng, còn tốt' },
  { key: 'FAIR', label: 'Đã sử dụng nhiều' },
];

const CONDITION_KEYS = CONDITIONS.map((c) => c.key);

// Khu vực của người bán — như các sàn C2C, người mua lọc và cân nhắc theo nơi giao nhận.
const LOCATIONS = ['Hà Nội', 'TP. Hồ Chí Minh', 'Đà Nẵng', 'Hải Phòng', 'Cần Thơ', 'Tỉnh/thành khác'];

// Mỗi tin đăng là ĐÚNG MỘT sản phẩm đơn chiếc. Các trạng thái dưới đây là những trạng
// thái mà sản phẩm đã được một đơn "giữ chỗ" hoặc đã bán hẳn, nên tin đăng không nhận
// thêm đơn nào khác nữa.
//
// COMPLETED và RELEASED nằm TRONG danh sách, vì bán xong là sản phẩm rời khỏi sàn vĩnh
// viễn chứ không quay lại.
//
// CREATED cố ý KHÔNG nằm trong danh sách: đơn mới tạo chưa khoá tiền nên chưa được phép
// chiếm chỗ của người khác.
const RESERVING_STATUSES = ['SECURED', 'SHIPPING', 'WAIT_CONFIRM', 'DISPUTED', 'COMPLETED', 'RELEASED'];

module.exports = {
  CATEGORIES,
  CATEGORY_KEYS,
  CONDITIONS,
  CONDITION_KEYS,
  LOCATIONS,
  RESERVING_STATUSES,
};
