# Hướng dẫn triển khai lên Render

Hệ thống chỉ gồm một dịch vụ Node.js/Express duy nhất (thư mục `cho-an-tam/`), dùng SQLite làm cơ sở dữ liệu, phục vụ cả API và giao diện web trên cùng một domain. Nhờ dùng chung origin, cookie phiên và WebAuthn/Passkey hoạt động trực tiếp mà không cần cấu hình CORS.

## Quy trình Render + GitHub

1. Đẩy code lên repository GitHub (có thể để public hoặc private).
2. Trên Render, tạo Blueprint từ repository này — Render sẽ tự đọc `render.yaml` ở gốc và dựng dịch vụ web `choden` theo `Dockerfile` (build từ thư mục `cho-an-tam/`).
3. Các biến môi trường nhạy cảm (`JWT_SECRET`, `PAYMENT_WEBHOOK_SECRET`) được Render tự sinh giá trị ngẫu nhiên, không cần nhập tay.
4. Domain công khai do Render cấp theo dạng `https://<tên-dịch-vụ>-<hậu-tố-ngẫu-nhiên>.onrender.com` (ví dụ domain đang dùng: `https://choden-dsky.onrender.com`).

## Kiểm tra sau khi triển khai

- Gọi `GET /health` — kỳ vọng trả về `{"status":"OK", ...}`.
- Mở trang chủ, kiểm tra danh sách tin đăng demo hiển thị đúng.
- Tạo tài khoản mới và đăng ký Passkey trực tiếp trên domain đã triển khai.

**Lưu ý:** Passkey tạo trên `localhost` khi phát triển sẽ không dùng được trên domain Render, vì Passkey bị ràng buộc theo RP ID cụ thể — cần tạo lại Passkey trên domain thật sau khi triển khai.
