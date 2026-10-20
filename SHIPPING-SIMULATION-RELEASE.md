# Enclave Delivery — bản vận chuyển mô phỏng

Người bán xác nhận đơn rồi xác nhận đã đóng gói. Máy chủ lưu duy nhất một lịch lấy/giao cho đơn: lấy hàng sau 4,7 giây, đến điểm giao sau 19,2 giây. Đây là thời gian rút gọn cho buổi demo, không phải dịch vụ vận chuyển thật hoặc định vị GPS.

Popup dùng mẫu xe Enclave nền trắng đã duyệt: kiện hàng đi vào cửa sau và khuất trong thùng; xe di chuyển; khi tới nhà kiện hàng đi ra cửa sau và được đặt trước cửa. Người mua được báo tự động và có thể mở lại hành trình. Đóng/tạm dừng animation không hủy hoặc dừng lịch của máy chủ.

## Giới hạn nghiệp vụ

- Đóng gói yêu cầu đúng người bán, đã xác nhận đơn, `SECURED + LOCKED`.
- Chuyến đi là `PICKUP_PENDING → IN_TRANSIT → ARRIVED`. Worker đổi đơn sang `SHIPPING` khi lấy hàng; đến nơi vẫn giữ `SHIPPING + LOCKED`.
- Người mua tự xác nhận đã nhận hàng. Việc kiểm hàng, giải ngân và Passkey dùng luồng hiện có, không do animation thực hiện.
- Tranh chấp hoặc đơn kết thúc làm chuyến dừng. Worker kiểm lại trạng thái trong giao dịch DB, không tiếp tục từ kết quả đọc cũ.
- Gửi lặp giữ nguyên chuyến/lịch. Worker khôi phục lịch sau restart, chống ghi trùng bằng unique/CAS và khóa giao dịch.
- Đơn cũ không được tạo lịch tự động. Endpoint giao tay cũ vẫn tương thích cho đơn chưa có chuyến; không vượt được lịch mới.
- Frontend theo dõi bằng một vòng polling theo phiên, kiểm phản hồi muộn sau đăng xuất/đổi hộp thoại; không thay số dư và không tự chuyển trạng thái đơn.

## Triển khai

- Nhánh đích đang phục vụ web: `migrate-postgres`, frontend Vercel và API Railway.
- Migration PostgreSQL 7 chỉ thêm bảng `app.shipments` và chỉ mục. Không sửa/xóa đơn, ví hoặc dữ liệu hiện có. SQLite có bảng tương đương.
- Worker mặc định 1 giây; `SHIPPING_WORKER_INTERVAL_MS=0` chỉ dành cho test kiểm soát thời gian. Không cần thay biến triển khai hiện tại.
- Muốn rollback: khôi phục bản ứng dụng trước; bảng bổ sung có thể giữ nguyên. Không xóa bảng hoặc cập nhật lại số dư bằng tay.
- `EXPERIMENT_FREEZE.json` là snapshot thực nghiệm cũ; bản này thay đổi luồng demo và không tái sử dụng kết quả/screenshot của snapshot đó làm bằng chứng mới.

## Kiểm tra trước phát hành

- `test/shipping-e2e.js`: 82 assertions đạt trên SQLite riêng, HTTP/router thật, hai worker process, duplicate/restart/race, trước mốc 1ms, quyền truy cập, tranh chấp, legacy, hash chain và 9 bất biến.
- PostgreSQL 17 cluster riêng: nâng schema 1–6 lên 7; duplicate pack/concurrent worker, arrival, stop, hash và không có bút toán ví/reauth mới. Đã dừng và dọn cluster sau kiểm tra.
- `test/paypal-binding-migration-e2e.js`: 8 assertions migration SQLite đạt.
- `test/ui/shipping-ui.js`: 23 assertions về xác nhận/hủy, khóa thao tác, điều kiện máy chủ, popup, không tự nhận hàng/giải ngân, phản hồi cũ và đăng xuất.
- Hồi quy UI: home navigation 4, mobile Passkey readiness 8, PayPal return routing 18, payment error clarity 60 assertions đạt.
- Invariants unit: 40 assertions đạt. Syntax và `git diff --check` đạt.
- Trình duyệt thật: popup lấy hàng và parcel qua cửa sau; giao diện 375px không tràn ngang, các nút popup nằm trong màn hình, đóng/mở giữ đúng chặng đã giao. Dùng dữ liệu fixture riêng, không phải tài khoản/đơn production.

Kiểm tra sau phát hành: xác nhận asset frontend đúng bản, API health và route `/pack` tồn tại; không tạo hoặc sửa đơn/tài khoản production chỉ để kiểm tra triển khai.
