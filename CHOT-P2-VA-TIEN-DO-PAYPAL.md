# Chốt checklist P2 và tiến độ nối PayPal

Ngày 05/10/2026. Nền trước thay đổi: codex/payment-provider-isolation @69c42ab.

## Quyết định dành cho Pro

Checklist CHECKLIST-P2-PRO-PAYPAL-UI.md được chấp nhận làm tiêu chí bàn giao. File nằm ngay trong worktree enclave-combined-review; được lưu vào Git cùng bản bàn giao này. Pro chưa bắt đầu P2, không đoán endpoint, không sửa P1. Không yêu cầu Pro làm lại checklist.

Codex phải cung cấp hash chứa API thực thi và hợp đồng bằng văn bản trả lời đủ tám câu hỏi trước khi Pro tạo claude/paypal-wallet-ui. Module coordinator riêng lẻ chưa đáp ứng điều kiện này.

## Phần Codex đã bổ sung

- paypalCaptureCoordinator.js kiểm chủ yêu cầu, provider và báo giá đã lưu trước khi giành quyền thu tiền.
- Adapter chờ ghi dấu POST bằng token hiện hành trước khi gửi capture; mất quyền thì không gửi POST.
- Kết quả chưa rõ giữ UNKNOWN để đối soát; không suy diễn thất bại từ timeout.
- SETTLEMENT_REQUIRED sử dụng bằng chứng đã lưu, không gửi POST thu tiền mới.
- Trường hợp đã biết capture thành công nhưng ghi ví lỗi cũng giữ UNKNOWN, không mở lại trạng thái READY.

Kiểm thử độc lập: 40/40 đạt, không bỏ qua, gồm adapter 16, service 13 và coordinator 11. Đây là HTTP giả lập và settlement giả lập, chưa chứng minh ví/sổ cái SQL hay PayPal Sandbox thực tế. Reviewer cấp 2 kiểm tra mã nguồn và chấp nhận bổ sung module chưa được công khai; reviewer không chạy test.

## Công việc còn lại của Codex trước bàn giao P2/M2

1. Nối settlement SQL: bằng chứng capture, yêu cầu nạp, ví và sổ cái trong cùng transaction; xử lý STALE_CLAIM và RECOVERY_REQUIRED đúng hợp đồng store.
2. Nối route có xác thực, cấu hình công khai, phản hồi báo giá/trạng thái và callback return/cancel; không dùng đường capture service cũ bỏ qua coordinator.
3. Nối webhook xác minh và worker đối soát, giữ cô lập MOCK/PAYPAL_SANDBOX.
4. Kiểm thử tích hợp trên SQLite/PostgreSQL riêng, viết hợp đồng API từ mã thực tế rồi gửi hash cho cả Max và Pro.

Max làm M2 kiểm thử độc lập ví/sổ cái, đồng thời và phục hồi từ hash đó. Pro làm P2 trong public/ và test/ui/paypal-wallet-ui.js từ cùng hash. Hai người không sửa phạm vi của nhau.

## Điều kiện chưa được bật tính năng

Chưa có route PayPal công khai, chưa nối settlement thật, chưa có hợp đồng API để Pro bắt đầu. Không bật PayPal hay đưa thay đổi này lên production. Full suite hai DB chưa được chạy lại cho module bổ sung lần này; số liệu full suite trước đó không phải bằng chứng cho settlement chưa được viết.
