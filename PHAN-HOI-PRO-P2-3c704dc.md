# Phản hồi Pro P2 — 3c704dc

Codex đã merge nhánh claude/paypal-wallet-ui vào nhánh tích hợp riêng codex/payment-provider-isolation. Chưa deploy hay bật feature.

## Quyết định root

Không chấp nhận fallback sang mock khi config trả 404. Không có cấu hình xác nhận thì cả hai cổng đều tắt. Codex đã sửa trên nhánh tích hợp và thêm assert vào test PayPal. Các harness P1/C2 được cập nhật để mock config trả enabled cho MOCK rõ ràng; không dùng 404 để ngầm bật cổng.

Không cần Pro sửa lại P1 hay push trùng bản vá này. Khi làm tiếp, fetch và tạo nhánh mới từ hash Codex giao, không mang lại fallback cũ.

## Việc bổ sung độc lập sau khi nhận hash bản ghép

Chạy kiểm tra “test có răng” từng ca một, không chạy 6 bộ jsdom song song: bỏ allowlist URL; bỏ kiểm sessionEpoch; bỏ xác nhận GET sau capture; cho config404 bật mock; cho cancel tự capture; bỏ kiểm paymentId khớp ý định. Mỗi ca phải fail đúng kiểm tra liên quan, sau đó khôi phục và kiểm diff. Không commit code đột biến. Chỉ gửi báo cáo hoặc sửa test nếu tìm khoảng trống, không sửa src/backend.

Nếu môi trường thiếu bộ nhớ, ghi rõ ca chưa chạy; không báo kiểm chứng mà không có kết quả. jsdom vẫn không chứng minh redirect/cookie/Passkey hoặc PayPal thật. Cần root kiểm trình duyệt và Sandbox trước khi deploy.
