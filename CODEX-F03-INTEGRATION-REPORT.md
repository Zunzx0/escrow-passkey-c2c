# F03 backend và giao diện bỏ yêu cầu nạp PayPal — 08/10/2026

## Thay đổi

Đã merge bình thường nhánh Pro ce95a289a3383f35570587e126d71b94fc72b342 vào codex/payment-provider-isolation (merge c579389). Nhánh bổ sung log claude/paypal-release-review không được gộp.

UI thêm nút Bỏ yêu cầu nạp ở dòng PayPal PENDING/AWAITING_APPROVAL có order; đọc chi tiết khớp id/requestId/số tiền/provider trước khi mở modal. Chỉ bấm xác nhận mới POST body {}. Máy chủ giữ quyền quyết định đủ an toàn để đóng. Return/cancel không tự abandon.

Sau POST, kể cả 409/timeout, UI GET lại chi tiết. FAILED + stage FAILED mới kết thúc ý định đang khớp. Chỉ phản hồi POST đúng hợp đồng cộng GET terminal khớp mới báo đã bỏ; GET FAILED sau lỗi chỉ báo yêu cầu đã đóng. RECOVERY_REQUIRED được ưu tiên và giữ ý định trong handler này; SUCCEEDED được xử lý theo luồng nạp đã xác nhận, không báo đã bỏ. Phiên cũ không báo kết quả/GET tiếp/xoá ý định phiên mới. Bỏ yêu cầu từ lịch sử không xoá ý định khác đang lưu.

API thêm tùy chọn allowAuthRetry=false chỉ dùng cho POST abandon; các lời gọi hiện có giữ mặc định refresh/retry cũ. Bộ test độc lập có lệnh npm run test:paypal-abandonment; không thêm bộ tự reset DB vào suite dùng chung. UI test dùng jsdom có sẵn ngoài repository, không thêm dependency.

## Kiểm chứng của Codex

- Full suite backend bản merge c579389: SQLite 1006 PASS, PostgreSQL 997 PASS, 0 FAIL, exit 0, 26 mục mỗi lượt. Số runner bao gồm 9 cộng cho check-invariants; assertion thật lần lượt 997 và 988. Chín bất biến đúng trên cả hai DB. UI/package bổ sung sau đó không sửa backend.
- Full suite bỏ qua bốn ca rate limit do cấu hình giới hạn cao. Đã chạy hardening riêng RATE_LIMIT_AUTH_PER_MINUTE=10: 27/27 assertion + 9 bất biến mỗi DB, exit 0; không cộng thêm vào tổng full suite.
- Abandonment backend bản vá C17 khớp byte sau chuẩn hoá newline với ce95a28: Codex đã chạy 399/399 trên mỗi DB ở lượt review trước. Không nhận kết quả Pro là lượt tự chạy của Codex.
- UI mới paypal-abandon-ui.js: 45/45, exit 0. Ca phiên cũ giữ Promise phản hồi tới khi đăng nhập lại cùng tài khoản hoàn tất; không dựa vào timeout để tình cờ bỏ phản hồi.
- Mutation trên bản sao: giữ GET nhưng cố ý bỏ chứng cứ GET, tin POST để đóng ý định. 45 assertion, 13 FAIL đúng các ca GET lỗi/sai id/key/amount/PENDING/recovery; exit 1. Bản sao đã khôi phục, repository không có code mutation.
- UI hồi quy: session-refresh 14/14, payment-error-clarity 60/60, topup-request-id 123/123, paypal-wallet 212/212; chạy tuần tự, mỗi process hạn heap 512 MB.
- Chrome fixture: 458 PASS, 0 FAIL, 0 SKIP, 54 ca, exit 0. Đây là hồi quy các ca hiện có, không phải bằng chứng PayPal thật hoặc browser coverage mới cho nút abandon.
- node --check app.js và git diff --check đạt.

## Môi trường và giới hạn

Bản sao kiểm thử nằm tại C:\Users\tranq\AppData\Local\Temp\enclave-f03-integrated-3f7be7c6347e4d72a648ddb1d55cec84. Báo cáo full SQLite suite-2026-10-07T18-50-02-864Z, PG suite-2026-10-07T18-57-55-904Z. Hardening riêng PG suite-2026-10-07T19-06-22-547Z, SQLite suite-2026-10-07T19-06-26-474Z. Log UI/Chrome lưu cạnh thư mục cho-an-tam của bản sao, không thêm toàn bộ log tạm vào repo.

Cluster Codex 54338 đã dừng; PostgreSQL hệ thống 5432 và cluster Pro không bị đụng. .env.test của repo không bị ghi đè. Lượt full SQLite đầu bị ngắt, chưa có summary và security log rỗng nên không được dùng làm kết quả. Lượt cấu hình PG đầu bị chờ pipe/dấu nháy PowerShell, chưa chạy suite; sửa tác vụ chạy tách stdout/stderr rồi mới có kết quả hoàn tất nêu trên. Không sửa mã sản phẩm để làm xanh các sự cố môi trường đó.

Chưa có nghiệm thu PayPal Sandbox thật, cookie HTTPS hoặc Passkey thiết bị thật. Railway hiện chỉ có production; không bật PayPal với DATABASE_URL production. Cần môi trường HTTPS biệt lập, cấu hình secret backend đúng đích và webhook Sandbox trước khi nghiệm thu. Cửa sổ quét 72h là chính sách dự phòng có hạn, không chứng minh tiền không thể được thu sau mốc đó.
