# Hợp đồng API PayPal Sandbox — bàn giao P2 / M2

Trạng thái: API đã thực thi trên nhánh codex/payment-provider-isolation; mặc định tắt. Hash code nền được ghi trong BAN-GIAO-P2-M2-PAYPAL.md sau kiểm thử. Tài liệu này không xác nhận đã giao dịch với PayPal Sandbox thật. Chỉ Sandbox, không live, không payout/refund PayPal.

## 1. Cấu hình công khai

GET /api/payments/paypal/config, không cần phiên. HTTP 200:

```json
{"paypalSandbox":{"enabled":true,"mode":"sandbox","rateKind":"DEMO_FIXED"},"mockPayments":{"enabled":false}}
```

Không có client secret, merchant credential, DB URL hoặc webhook secret. enabled chỉ true khi flag và toàn bộ cấu hình server hợp lệ. UI thiếu cấu hình/lỗi/shape sai phải tắt PayPal, không đoán từ hostname. Chỉ mở mock nếu server trả mockPayments.enabled=true; khi flag PayPal bật, mock topup và checkout bị tắt ngay cả khi cấu hình PayPal thiếu.

## 2. Tạo và mở lại yêu cầu

POST /api/payments/paypal/topup, Authorization: Bearer accessToken. Body chỉ dùng amount (số nguyên JSON VND), requestId (bắt buộc 8–100 ký tự A-Za-z0-9._:-). Ví dụ:

```json
{"amount":100000,"requestId":"topup-<uuid>"}
```

HTTP 200 cho cả tạo mới và replay. Không dựa mã 200 để kết luận đã nạp thành công. Phản hồi dạng:

```json
{"id":"request-uuid","amount":100000,"status":"PENDING","requestId":"topup-<uuid>","providerRef":"server-uuid","provider":"PAYPAL_SANDBOX","submissionStatus":"SUBMITTED","createdAt":"ISO","resolvedAt":null,"sandbox":true,"stage":"AWAITING_APPROVAL","orderId":"PAYPAL_ORDER","quote":{"version":1,"amountVnd":100000,"currency":"USD","usdCents":400,"usdValue":"4.00","rateVndPerUsd":25000,"rateKind":"DEMO_FIXED","rateLabel":"Tỷ giá mô phỏng, không phải giá thị trường"},"approvalUrl":"https://www.sandbox.paypal.com/checkoutnow?token=PAYPAL_ORDER"}
```

amount và amountVnd là VND được ghi ví; usdValue là chuỗi thập phân chuẩn USD Sandbox, do server tính bằng số nguyên, làm tròn lên cent. Client không tính lại. Quote bất biến theo request; không có trường quoteExpiresAt vì quote không được đổi sau khi lưu. Cửa sổ 5 phút là thời hạn retry CREATE chưa gắn order, không phải thời hạn quote hoặc thời hạn trả tiền.

Cùng user + requestId + amount/provider giữ một request, order và quote. Đổi amount/provider với cùng key: 409 IDEMPOTENCY_KEY_REUSED. Gửi lại không tạo ý định mới sau timeout. Unbound CREATE quá 5 phút từ lần thử đầu: 409 PAYPAL_CREATE_RECOVERY_REQUIRED, không gọi create order mới; cần đối soát vận hành. Đã gắn order thì luôn GET order cũ, không create lại dù thời gian dài.

GET /api/payments/paypal/:id/checkout, có Bearer, chủ sở hữu: trả cùng shape với approvalUrl hiện tại nếu còn READY/PENDING. Dùng endpoint này để mở lại approval; lịch sử/GET trạng thái thường trả approvalUrl=null và không gọi mạng. Thiếu URL không được tự dựng URL PayPal.

## 3. Kiểm approval URL

Chỉ chấp nhận URL parse được, protocol=https:, origin chính xác https://www.sandbox.paypal.com, không username/password. Không chấp nhận domain gần giống, subdomain khác, javascript:, URL lấy trực tiếp từ query return hoặc người dùng. Server adapter kiểm tương tự. UI phải dùng URL do server trả, không tự ghép token/order.

## 4. Return, cancel và capture

Server cấu hình PAYPAL_FRONTEND_ORIGIN=https://enclave.id.vn. Return:
https://enclave.id.vn/?paypal=return&paymentRequestId=<id>#/wallet
Cancel: tương tự paypal=cancel. PayPal có thể thêm token/PayerID; các trường này không phải chứng cứ thành công, không dùng làm identity/ownership.

P2 đọc query trước hash, giữ requestId đã lưu theo user, GET /api/payments/:id để xác nhận ownership/id/amount/requestId/provider. Return rồi người dùng chọn tiếp tục xác nhận thì POST /api/payments/paypal/:id/capture có Bearer; body không cần dữ liệu thu tiền. Server không nhận số tiền, merchant hoặc order do client khai để capture.

Cancel chỉ GET trạng thái và hiện chưa hoàn tất/chờ xác minh; không tự capture, không tự đánh FAILED, không tạo request mới. Capture endpoint trả shape payment + outcome. Success chỉ khi GET trạng thái sau đó khớp ý định và nói SUCCEEDED. Không cộng số dư ở client.

Luồng redirect rời trang về lại có thể cần khôi phục phiên bằng cookie refresh; vẫn áp dụng sessionEpoch/userId sau từng await, không để phản hồi của phiên cũ mở approval cho phiên mới. Không đưa token đăng nhập vào URL.

## 5. Trạng thái / lịch sử

GET /api/payments/me -> {paymentRequests:[...]}; GET /api/payments/:id -> một request. Cả hai có Bearer và quyền server. MOCK giữ shape cũ và thêm provider=MOCK. PAYPAL_SANDBOX thêm sandbox, stage, orderId, quote, approvalUrl (thường null). submissionStatus chỉ nói đã gắn order, không chứng minh đã thu tiền.

| stage | UI |
|---|---|
| CREATING | Đang tạo yêu cầu; retry cùng key |
| AWAITING_APPROVAL | Mở approval qua checkout nếu URL hợp lệ |
| CAPTURING | Đang xác nhận, khoá thao tác lặp |
| RECONCILING | Chưa rõ kết quả; chờ/hỏi trạng thái, không báo thất bại/thành công |
| CREATE_RECOVERY_REQUIRED | Không tạo order mới; yêu cầu hỗ trợ đối soát |
| RECOVERY_REQUIRED | Có bằng chứng thu nhưng request đã đóng; cần xử lý thủ công, không tự credit |
| NOT_CAPTURED | Không tiếp tục thu; không diễn giải cancel trình duyệt là trạng thái này |
| SUCCEEDED | GET đã xác nhận tiền đã ghi ví |
| FAILED | Request nội bộ đã đóng; ưu tiên RECOVERY_REQUIRED nếu có bằng chứng capture muộn |

outcome capture có APPLIED, DUPLICATE, BUSY, NOT_READY, CLOSED, NOT_CAPTURED, RECOVERY_REQUIRED, RECONCILING, AWAITING_APPROVAL. Mọi outcome chưa SUCCEEDED đều không phải thành công nạp. stage là thông tin mới nhất sau thao tác; HTTP 200/DUPLICATE đơn lẻ không đủ. Worker chỉ GET, không chủ động capture, không đóng FAILED từ timeout/DECLINED.

## 6. Lỗi / rate limit

Error shape của ứng dụng {error,message,requestId?}; requestId trong lỗi 5xx là mã tham chiếu vận hành, không phải client requestId để retry.

- 400 INVALID_AMOUNT / AMOUNT_OUT_OF_RANGE / VALIDATION_ERROR: sửa đầu vào; VND mặc định 1.000–50.000.000 mỗi lần.
- 409 TOPUP_LIMIT_EXCEEDED: từ chối tạo mới bởi hạn mức chung cho cả hai provider.
- 409 IDEMPOTENCY_KEY_REUSED: không tái sử dụng key cho ý định khác.
- 401 UNAUTHENTICATED, 403 FORBIDDEN: xử lý phiên/quyền, không retry bằng user mới.
- 404 PAYMENT_REQUEST_NOT_FOUND: không có request thuộc luồng này.
- 503 PAYPAL_DISABLED: feature chưa đủ cấu hình/bị tắt; không tạo fallback mock âm thầm.
- 409 PAYPAL_CREATE_RECOVERY_REQUIRED / PAYPAL_ORDER_MISMATCH / PAYPAL_CAPTURE_CONFLICT: dừng tự động, GET và báo cần đối soát.
- PAYPAL_CAPTURE_CLAIM_LOST: không gửi thêm POST; kiểm tra trạng thái.
- Lỗi mạng, timeout, 429 hoặc 5xx từ provider: kết quả có thể chưa rõ. Giữ requestId/amount/order, hỏi lại lịch sử/GET. Không đổi key để thử lại.
- 429 RATE_LIMITED có Retry-After. Quota prototype trong một process, theo IP và nhóm tuyến cố định: 10 POST topup/capture/phút, 20 GET checkout/phút, 60 webhook/phút. Đổi id không tạo xô mới. Triển khai nhiều process cần kho limiter chung; không khẳng định hạn mức toàn cụm.

## 7. Webhook và dữ liệu không nằm trong UI

POST /api/payments/paypal/webhook nhận event nguyên bản + các PayPal transmission headers; không dùng cookie của người dùng. Server xác minh chữ ký qua PayPal rồi GET order, kiểm metadata/merchant/amount/capture ID và gọi cùng settlement. Chỉ PAYMENT.CAPTURE.COMPLETED được xử lý; các event khác không credit.

Cùng transaction: finish/mark bằng chứng + request SUCCEEDED + ví + TOPUP_CREDIT, key topup:<requestId>. STALE_CLAIM rollback transaction đầu, transaction mới ghi bằng chứng xác minh và tất toán. RECOVERY_REQUIRED commit bằng chứng nhưng không credit. Chưa có API cho admin ghi tiền phục hồi thủ công: không tự sửa số dư bằng SQL để bỏ trạng thái này.

## 8. Cấu hình server và thử nghiệm

PAYPAL_SANDBOX_ENABLED mặc định tắt; PAYPAL_SANDBOX_CLIENT_ID, CLIENT_SECRET, MERCHANT_ID, WEBHOOK_ID (tất cả có prefix PAYPAL_SANDBOX_). PAYPAL_FRONTEND_ORIGIN HTTPS origin; PAYPAL_DEMO_VND_PER_USD mặc định 25000; PAYPAL_TIMEOUT_MS mặc định 10000 (100–30000); PAYPAL_CAPTURE_LEASE_SECONDS mặc định 120, phải >= (4*timeoutMs+10000)/1000. Khoảng retry CREATE cố định 5 phút. Không chuyển base API sang live.

Fake transport không có endpoint/biến môi trường công khai. Trong test dùng createSandboxProvider(config,{fetchImpl}) rồi createPayPalRuntime({config,provider}); runtime chỉ cho injection khi APP_ENV=test và DB local *_test hoặc SQLite data/test. Adapter luôn dựng URL chính xác https://api-m.sandbox.paypal.com; fake transport chặn mọi origin khác. Worker test truyền paypalRuntime vào reconcileOnce, bị từ chối ngoài APP_ENV=test. Không dùng production DB, không ghi secret vào repo.

Điểm fault injection: paypal-topup:after-wallet-update; điểm cuối transaction paypal-topup:before-status-change (được gọi sau ledger, trước commit, tên dùng lại từ bộ fault chung). Cả hai phải chứng minh rollback cả request/evidence/wallet/ledger. Post-commit lỗi log/thông báo không có nghĩa tiền rollback.

Bút toán là TOPUP_CREDIT, available_delta=quote.amountVnd, locked_delta=0, request_id=id, idempotency_key=topup:<id>. Ba kiểm tra PayPal trong src/lib/paypalInvariants.js tách khỏi chín bất biến cũ; không tự đổi số liệu luận văn từ 9 thành 12.

Tài liệu API chính thức: https://developer.paypal.com/api/orders/v2 và https://developer.paypal.com/api/webhooks/v1. Chưa kiểm chứng approval/cookie/PayPal/Passkey thật bằng trình duyệt.
