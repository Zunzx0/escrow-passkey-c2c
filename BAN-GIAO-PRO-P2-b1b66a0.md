# Bàn giao P2 cho Claude Pro — bắt đầu làm UI PayPal

Ngày 06/10/2026. **P2 được phép bắt đầu; không còn chờ API.**

## Nền cố định

Remote: https://github.com/Zunzx0/escrow-passkey-c2c.git
Nhánh nguồn: codex/payment-provider-isolation
**Hash code đã kiểm thử: b1b66a09c74dd9116ed939f0805dbb2e0247fd4d (b1b66a0).**

Tạo nhánh claude/paypal-wallet-ui và worktree riêng từ đúng hash này sau fetch. Đây là nền tích hợp được Codex chốt cho P2, thay cho việc bắt đầu từ migrate-postgres chưa chứa API. Không sửa worktree enclave-combined-review, P1, nhánh Max hoặc nhánh nguồn. Kiểm working tree và remote trước khi làm; không overwrite thay đổi chưa commit.

Đọc HOP-DONG-API-PAYPAL-P2-M2.md có trong hash này: trả lời đủ tám câu hỏi của CHECKLIST-P2-PRO-PAYPAL-UI.md. Không tự suy ra endpoint khác.

## Phạm vi

Chỉ public/ và test/ui/paypal-wallet-ui.js (có thể thêm fixture test/ui riêng nếu cần). Không src/, migration, package.json, scripts/run-suite.js, README hay test backend. Không secret, không thay flag/deploy/DNS.

1. Đọc GET /api/payments/paypal/config; chỉ hiện PayPal khi enabled=true/mode=sandbox. Không brand mock thành PayPal. Nếu cả PayPal và mock đều tắt thì báo chưa sẵn sàng, không fallback âm thầm.
2. Gửi POST /api/payments/paypal/topup giữ requestId/amount của cùng ý định qua retry, reload, 5xx và timeout. Lưu riêng theo user như P1, không lưu token/secret.
3. Hiển thị quote VND ghi ví, USD Sandbox phải trả và nhãn tỷ giá mô phỏng từ server. Không tự tính tỷ giá hoặc usdValue.
4. Approval lấy từ server; kiểm exact HTTPS sandbox origin, không userinfo; không dùng query token để dựng URL. GET checkout để mở lại URL, không dùng mock checkout cho PayPal.
5. Return/cancel theo mục 4 hợp đồng. Không tự báo thành công, không tự credit. Cancel chỉ hỏi trạng thái. Return được GET xác nhận chủ sở hữu, ý định và dữ liệu; người dùng tiếp tục xác nhận thì gọi capture. GET sau capture là chứng cứ hiển thị SUCCEEDED.
6. Hiển thị đầy đủ CREATING, AWAITING_APPROVAL, CAPTURING, RECONCILING, CREATE_RECOVERY_REQUIRED, RECOVERY_REQUIRED, NOT_CAPTURED, SUCCEEDED, FAILED. Không diễn giải 200/DUPLICATE/BUSY là nạp thành công. Lịch sử phân biệt provider.
7. Giữ sessionEpoch/userId sau mỗi await; phản hồi cũ không mở approval, retry bằng token mới, xoá ý định hay báo kết quả cho người khác. Giữ theo dõi có hạn và nút kiểm tra lại.
8. Không UI payout/refund PayPal. Phân xử vẫn tác động ví VND nội bộ. Không tự tạo request mới vì kết quả chưa rõ.

## Kiểm chứng và bàn giao

Viết test trước/sát từng thay đổi, dùng harness P1. Đủ ma trận checklist P2; bổ sung false config, malformed quote/body, approval giả, return/cancel giả, capture timeout, recovery, đổi phiên, 429 và HTTP 503. Giữ bộ P1 123, refresh 14, C2 60; UI-flow 23 cần server test riêng. Không khẳng định jsdom chứng minh browser/cookie/PayPal/Passkey thật.

Nền root đã đạt SQLite1006/PG997, chín bất biến; PayPal integration52 mỗi DB dùng HTTP giả và SQL thật. Pro không dùng số này thay cho test UI của mình.

Push nhánh thường. PR **vào codex/payment-provider-isolation** để diff chỉ gồm UI của Pro; không mở PR vào migrate-postgres lúc này vì sẽ kéo cả nền root vào diff. Nếu không mở được PR, gửi compare link với base đó. Codex sẽ ghép bản tích hợp vào migrate-postgres sau review và M2; không merge/deploy tự ý.

Báo nhánh/head/base, file, test pass/fail/skip, xung đột, API thiếu/sai và giới hạn còn lại. Nếu phát hiện API không khớp hợp đồng, gửi test tái hiện cho Codex, không sửa backend hoặc đoán workaround.
