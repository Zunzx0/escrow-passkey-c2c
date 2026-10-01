# Triển khai công khai miễn phí

Dự án được đóng gói thành một dịch vụ Web duy nhất: Express phục vụ API và bản dựng React trên cùng miền HTTPS. Cách này giúp cookie phiên và WebAuthn/Passkey dùng chung origin, không cần cấu hình CORS giữa hai dịch vụ.

## Render + GitHub

1. Đưa thư mục này lên một repository GitHub riêng tư.
2. Trong Render, chọn **New → Blueprint** và kết nối repository.
3. Render đọc `render.yaml`, tạo Web Service và PostgreSQL ở Singapore.
4. Khi triển khai xong, website có địa chỉ công khai dự kiến là `https://choden.onrender.com`.

Backend tự lấy `RENDER_EXTERNAL_HOSTNAME` để cấu hình:

- `RP_ID=choden.onrender.com`
- `ORIGIN=https://choden.onrender.com`
- `CORS_ORIGIN=https://choden.onrender.com`
- cookie phiên có cờ `Secure`

Container tự chạy migration và dữ liệu chợ mẫu trước khi khởi động ứng dụng. Không đưa `.env`, mật khẩu hoặc chuỗi kết nối cơ sở dữ liệu lên GitHub.

## Kiểm tra sau triển khai

- `/api/health` trả về `{ "status": "ok" }`.
- Trang chủ hiển thị các sản phẩm mẫu.
- Đăng ký tài khoản mới và tạo Passkey trên đúng tên miền triển khai.
- Mở lại trang bằng máy hoặc điện thoại khác qua URL HTTPS công khai.

Passkey được ràng buộc với RP ID. Passkey đã tạo ở `localhost` không dùng được trên miền Render; mỗi tài khoản phải đăng ký Passkey mới trên miền công khai.
