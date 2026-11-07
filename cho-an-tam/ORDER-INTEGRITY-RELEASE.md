# Tạm dừng xử lý tiền khi thông tin đơn không khớp

Khi nhật ký, thông tin đơn hoặc bút toán không còn khớp, Enclave lưu dấu tạm dừng cho riêng đơn đó. Lệnh chuyển tiền và hoàn tiền đều bị chặn, kể cả khi quản trị viên đã xác nhận bằng Passkey trước đó. Những đơn hợp lệ khác tiếp tục hoạt động.

Dấu tạm dừng được lưu trong cơ sở dữ liệu và còn hiệu lực sau khi ứng dụng khởi động lại. Sửa lại một bản ghi không tự mở đơn. Gói này không có chức năng xóa dấu hoặc tự phục hồi sự cố. Với đơn đã chuyển tiền xong, việc phát hiện lỗi lịch sử không tạo lại tiền đang giữ và không thu hồi khoản đã trả.

## Thay đổi

- Migration 16 tạo bảng `app.order_integrity_holds`. Không viết lại số dư, bút toán hoặc nhật ký cũ.
- Nhật ký mới chứa phần đối chiếu đơn và dấu băm bút toán. Nhật ký cũ được giữ nguyên; mức đối chiếu cho dữ liệu cũ chỉ bao gồm những thông tin có thể kiểm tra được.
- Kiểm tra toàn vẹn được đặt trước tất toán và trước khi trả lại kết quả của một yêu cầu đã xử lý. Nếu giao dịch tiền bị hủy do lỗi toàn vẹn, dấu tạm dừng được lưu trong giao dịch CSDL riêng sau rollback.
- GET kiểm chứng tiếp tục chỉ đọc. Nút kiểm chứng dùng POST có xác thực, kiểm quyền với đúng đơn và lưu dấu khi phát hiện lỗi.
- Người mua, người bán và quản trị viên thấy cùng cảnh báo. Danh sách và chi tiết không trình bày số tiền đang nghi ngờ như một giá trị đã được xác nhận. Các nút xử lý tiền của đơn bị tạm dừng được ẩn; máy chủ vẫn là nơi thực thi quyền.

## Kiểm chứng

Node 24.22.1, HTTP thật trên localhost và dữ liệu tổng hợp: SQLite đạt 97 nhóm/3456 assertions; PostgreSQL 17 cách ly đạt 97 nhóm/3459 assertions. Bao gồm cạnh tranh tất toán, phiếu dùng một lần, rollback, phân xử độc lập, sửa/xóa/chèn nhật ký, sửa đơn/bút toán, chặn phiếu đã cấp trước, dấu tạm dừng qua khởi động lại và không ảnh hưởng đơn khác.

Kiểm giao diện trong JSDOM với API giả: 51 kiểm phong tỏa, 46 kiểm thông báo và 24 kiểm quy trình phân xử đạt. Không sử dụng các kết quả này làm nghiệm thu Windows Hello hoặc bố cục trình duyệt thật.

Một bộ hồi quy cũ `security-report-regression-e2e.js` dừng trong bước dựng tài khoản người bán. Đã tái hiện cùng lỗi trên mã gốc trước sửa; không tính bộ này là PASS. Các bộ HTTP/DB và UI nêu trên được ghi nhận riêng.

## Phát hành

1. Kiểm CI build Docker trên Linux. Không cần đưa bí mật hoặc DB vào CI.
2. Kiểm bản sao lưu và khả năng khôi phục trước khi đổi cấu trúc production. Kiểm chỉ đọc đã xác nhận schema production đang ở phiên bản 15, chưa có bảng hold, và các khóa tham chiếu đúng kiểu.
3. Triển khai đúng commit được duyệt. Railway hiện còn cấu hình ghim nguồn cũ; không giả định gộp PR sẽ tự đưa bản mới lên. Chỉ chỉnh nguồn của môi trường production sau khi được duyệt, không thay khóa hoặc origin.
4. Có khoảng ngừng dịch vụ để tránh bản cũ và bản mới cùng xử lý tiền. Sau đó kiểm migration 16, health, đăng nhập/phiên, hai hướng phân xử và Passkey thật.

Không quay về phiên bản chưa hiểu dấu tạm dừng sau khi đã có sự cố được ghi nhận. Khi cần xử lý lỗi, dừng thao tác tiền và đối soát; không xóa dấu hoặc phục hồi số dư tự động.

Các thao tác sửa trực tiếp CSDL để thực nghiệm phải chạy trong môi trường cách ly. Không sửa nhật ký, số tiền hoặc bút toán trên website đang phục vụ người dùng để tạo ảnh minh chứng.

## Giới hạn

Chuỗi băm nội bộ không chứng minh được tính toàn vẹn khi người có toàn quyền CSDL xóa đuôi hoặc tính lại cả chuỗi một cách nhất quán. Gói không thêm neo băm bên ngoài, không kiểm chứng chất lượng hàng hóa và không thay bên phân xử bằng thuật toán.

Không thay bố cục/CSS, cơ chế khôi phục phiên, cấu hình Render, chính sách Passkey, cổng nạp tiền hoặc chức năng hoàn hàng vật lý trong gói này.
