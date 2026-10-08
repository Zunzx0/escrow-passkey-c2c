# PayPal Sandbox cho Enclave: tích hợp và nghiệm thu

## 1. Trạng thái và phạm vi

Tài liệu này cập nhật mô tả theo nền tích hợp `c4ed8bc` do root giao để rà soát. Tính năng mặc định tắt. Code đã có route HTTP, lưu trữ bền vững trên SQLite/PostgreSQL, coordinator capture, settlement ví/sổ cái, webhook, worker đối soát và giao diện ví. Không còn ở giai đoạn hai module adapter/service độc lập.

Các bộ kiểm thử với HTTP provider giả lập đã có kết quả đạt trong quá trình duyệt nhánh tích hợp; kết quả UI độc lập trên bản bổ sung test của Pro là 208/208. Đây không phải bằng chứng PayPal Sandbox thật, redirect/cookie thật hoặc Windows Hello thật. Không suy ra tính năng đã triển khai hay được bật trên web chính từ trạng thái code/test.

Phạm vi chỉ gồm **nạp PayPal Sandbox vào ví nội bộ**. Hoàn tiền và giải ngân tranh chấp chuyển giữa các ví Enclave; không có payout, refund PayPal tự động hoặc thanh toán PayPal live. Sandbox và ví đồ án không đại diện một dịch vụ giữ tiền thật.

## 2. Các thành phần đã nối

- `src/lib/paypalSandboxProvider.js`: OAuth phía máy chủ, Orders v2, capture, GET order và xác minh webhook.
- `src/lib/paypalSandboxService.js`: kiểm owner, order/quote, tạo/mở lại order, webhook và đối soát.
- `src/lib/paypalPaymentStore.js`: binding bền vững, quyền create/capture, bằng chứng thu tiền và trạng thái phục hồi.
- `src/lib/paypalCaptureCoordinator.js`: claim và commit trước khi gọi mạng, xử lý kết quả chưa rõ, không giữ transaction qua mạng.
- `src/lib/paypalSettlement.js`: bằng chứng xác minh, request SUCCEEDED, ví và TOPUP_CREDIT trong cùng transaction.
- `src/lib/paypalRuntime.js`: đọc cấu hình, kiểm readiness, tạo request/báo giá và serialize trạng thái.
- `src/routes/paypal.js`: API công khai config, API có phiên/owner cho topup/checkout/capture, webhook riêng.
- `src/lib/reconciler.js`: đối soát theo provider; PayPal worker chỉ GET, không tự capture.
- Các migration SQLite/PostgreSQL trong `src/` và `src/db.js`: provider discriminator, binding, ràng buộc bằng chứng/order/capture.
- `public/js/app.js`: báo giá, approval, return/cancel, xác nhận GET, bảo vệ phiên và khôi phục ý định nạp.

Hợp đồng request/response chi tiết nằm trong `HOP-DONG-API-PAYPAL-P2-M2.md`; trạng thái store nằm trong `PAYPAL-STORE-DESIGN.md`. Khi thay đổi contract phải cập nhật code, test và tài liệu cùng nhau.

## 3. Tiền tệ và báo giá

Ví/sổ cái giữ số nguyên VND; bản tích hợp PayPal Sandbox sử dụng USD. Máy chủ tính `ceil(amountVnd * 100 / rateVndPerUsd)` bằng BigInt và lưu báo giá trước lần gọi provider đầu tiên. Tỷ lệ mặc định 25.000 VND/USD là tỷ lệ mô phỏng, không phải tỷ giá thị trường hay tỷ giá PayPal. Ví dụ 100.000 VND tương ứng 4,00 USD Sandbox với tỷ lệ này.

Báo giá, amount, provider, owner và merchant gắn với yêu cầu không được đổi sau tạo. Thay biến môi trường tỷ lệ không tính lại order cũ. UI chỉ hiển thị giá trị USD/VND từ server, không tự tính hoặc tự cộng số dư.

## 4. Luồng API và bằng chứng thành công

1. `GET /api/payments/paypal/config` xác nhận cổng được bật. Lỗi, dữ liệu sai dạng hoặc 404 làm UI tắt cả hai cổng. Mock chỉ mở khi cấu hình hợp lệ xác nhận `mockPayments.enabled=true`; không dùng fallback ngầm.
2. `POST /api/payments/paypal/topup` nhận `{amount, requestId}`; vai trò BUYER/SELLER và owner lấy từ phiên máy chủ. Cùng owner/key/amount/provider dùng lại một request, order và quote. Timeout không được đổi requestId để thử lại.
3. `GET /api/payments/paypal/:id/checkout` kiểm owner và lấy approval URL hiện tại qua provider khi phù hợp. UI không dựng URL từ token/order/query; chỉ nhận HTTPS đúng origin `https://www.sandbox.paypal.com`, không userinfo hoặc cổng lạ.
4. PayPal đưa người dùng về `/?paypal=return|cancel&paymentRequestId=<id>#/wallet`. `token`, `PayerID` và query không phải chứng cứ thu tiền. UI dọn query rồi GET request để xác nhận id, provider, amount, requestId.
5. Cancel không capture, không tự FAILED, không tạo order mới. Return cũng không tự capture; người dùng chủ động bấm xác nhận khi ý định khớp.
6. `POST /api/payments/paypal/:id/capture` dùng order/quote đã lưu phía server. HTTP 200, APPLIED, DUPLICATE hay BUSY không đủ để UI báo thành công. UI GET lại và chỉ báo/đọc ví khi dữ liệu khớp nói SUCCEEDED.
7. Webhook tại `POST /api/payments/paypal/webhook` xác minh chữ ký qua PayPal, GET order và kiểm merchant/metadata/amount/capture; payload không quyết VND credit. Chỉ PAYMENT.CAPTURE.COMPLETED được xử lý cho luồng này.
8. Worker đối soát chỉ truy vấn provider và tất toán bằng chứng hợp lệ, không chủ động gửi capture. Không có HTTP endpoint cho người dùng/admin gọi settlement trực tiếp.

### Ngoại lệ GET trạng thái có thể gọi mạng

`GET /api/payments/:id` và danh sách lịch sử thường serialize dữ liệu đã lưu; không được hiểu là luôn ngoại tuyến. Khi binding ở UNKNOWN với `lastError=PAYPAL_PAYER_ACTION_REQUIRED`, runtime GET order mới để xác minh người mua còn phải phê duyệt trước khi hiển thị AWAITING_APPROVAL. Lỗi cũ đã lưu chỉ là gợi ý phải kiểm lại, không tự cấp approval URL hoặc chứng minh trạng thái hiện tại.

Nếu GET mới timeout/lỗi thì API/UI giữ kết quả chưa xác nhận, không suy ra chưa thu tiền hoặc tự báo thành công. GET checkout mới là đường lấy approval URL cho thao tác mở cổng; lịch sử không phải nguồn URL cached để điều hướng.

## 5. Hàng rào tiền và phục hồi

- Mock và PayPal được phân biệt trong DB, route, worker và settlement; mock không tất toán PayPal và ngược lại.
- Capture claim cùng token ngăn holder cũ ghi đè holder mới. `markCapturePostSent` được commit trước POST. Đã từng POST mà kết quả chưa rõ không được quay READY hoặc đóng FAILED chỉ vì timeout.
- Chỉ ORDER_VOIDED là bằng chứng NOT_CAPTURED trong chính sách hiện tại; CAPTURE_DECLINED/PENDING/APPROVED không đủ để đóng một lần thu tiền chưa rõ.
- VERIFIED + request PENDING cần settlement phục hồi, không được hiểu là ví đã cộng. STALE_CLAIM rollback credit rồi mở transaction mới xác minh/tất toán.
- Bằng chứng thu đến sau request FAILED được giữ ở RECOVERY_REQUIRED, không tự credit, không mở lại request. Không sửa số dư bằng SQL để bỏ trạng thái này; cần quy trình đối soát do root chốt.
- Settlement kiểm provider/quote/capture và ghi TOPUP_CREDIT với key `topup:<requestId>` cùng request SUCCEEDED, ví và evidence trong một transaction. Lỗi giữa transaction phải rollback toàn bộ; callback sau commit hỏng không có nghĩa tiền rollback.

Chín bất biến tài chính gốc vẫn giữ nguyên ý nghĩa. Các kiểm tra PayPal bổ sung nằm riêng trong `src/lib/paypalInvariants.js`; không tự đổi số bất biến báo cáo đồ án từ 9 thành 12.

## 6. Cấu hình server đang được đọc

| Biến | Ý nghĩa |
| --- | --- |
| PAYPAL_SANDBOX_ENABLED | Chỉ `1` mới yêu cầu bật; mặc định tắt |
| PAYPAL_SANDBOX_CLIENT_ID / PAYPAL_SANDBOX_CLIENT_SECRET | Ứng dụng Sandbox; secret chỉ phía server |
| PAYPAL_SANDBOX_MERCHANT_ID | Merchant business Sandbox khớp order |
| PAYPAL_SANDBOX_WEBHOOK_ID | Webhook của ứng dụng Sandbox |
| PAYPAL_FRONTEND_ORIGIN | HTTPS origin thuần, không path/query/userinfo; mặc định https://enclave.id.vn |
| PAYPAL_DEMO_VND_PER_USD | Số nguyên dương, mặc định 25000; tỷ lệ mô phỏng |
| PAYPAL_TIMEOUT_MS | 100–30000 ms, mặc định 10000 |
| PAYPAL_CAPTURE_LEASE_SECONDS | Mặc định 120; phải đủ ít nhất `(4*timeoutMs+10000)/1000` |

Thiếu/sai cấu hình khiến config công khai không bật PayPal. Khi flag PayPal được yêu cầu bật, mock topup/checkout không được dùng làm fallback dù thông tin PayPal thiếu. Cửa sổ retry CREATE chưa gắn order là 5 phút từ lần thử đầu; có order rồi không create order khác.

Adapter chỉ gọi API Sandbox cố định; không đổi base sang live, không bỏ certificate validation. Fake provider injection chỉ được cho phép APP_ENV=test với DB thử nghiệm cô lập theo kiểm tra runtime. Không có endpoint hoặc biến môi trường công khai cho người dùng chọn fake transport.

## 7. Origin, cookie, staging và thiết bị

Web chính dự kiến frontend `https://enclave.id.vn`, API `https://api.enclave.id.vn`: CORS exact origin, credentials cho refresh cookie, WebAuthn RP ID `enclave.id.vn` và expected origin `https://enclave.id.vn`. Cookie refresh HttpOnly, SameSite=Strict; Secure phụ thuộc server nhận HTTPS đúng qua proxy. Kiểm TRUST_PROXY theo hạ tầng triển khai trước nghiệm thu.

`public/js/config.js` hiện hướng cả hostname `*.vercel.app` tới API production. Vì vậy preview chỉ được dùng xem giao diện; không dùng làm staging DB riêng hoặc nghiệm thu Passkey nếu chưa chốt cấu hình API độc lập. Không cho thử đồng thời tác động DB production.

Local HTTP dùng API cùng origin và RP ID localhost, expected origin đúng cổng. Không dùng `127.0.0.1` thay localhost. PayPal frontend origin bắt buộc HTTPS; nghiệm thu Sandbox thật cần origin HTTPS đã cô lập, không giả định local HTTP được chấp nhận.

Sau redirect PayPal phải kiểm refresh cookie và khôi phục phiên trên trình duyệt thật, bao gồm access token hết hạn khi ở trang PayPal. Epoch/session/owner phải giữ ý nghĩa khi logout rồi login lại cùng tài khoản. Windows Hello/PIN/biometric do người dùng thực hiện; jsdom/software authenticator không thay thế bằng chứng thiết bị thật.

## 8. Checklist nghiệm thu còn lại trước bật feature

1. Duyệt bản ghép cuối, chạy suite SQLite/PostgreSQL và UI với số đếm đúng; đối chiếu migration và các bất biến.
2. Chuẩn bị ứng dụng, business và personal Sandbox, credentials phía server và webhook HTTPS; không chép secret vào Git/chat/báo cáo.
3. Trình duyệt thật: config, quote, approval URL, cancel, return, capture chủ động, GET xác nhận, reload, session refresh, logout/login lại cùng user.
4. Sandbox thật: đối chiếu order/capture/merchant, số USD thu thử và số VND vào ví; đúng một TOPUP_CREDIT dù capture/webhook/worker gửi lặp.
5. Thử mất webhook/GET timeout, restart giữ order/quote, tài khoản khác không truy cập/capture request, mock không xử lý PayPal.
6. Thực hiện Passkey thật cho các thao tác nhạy cảm độc lập với nạp tiền, rồi kiểm escrow/tranh chấp bằng dữ liệu thử.
7. Ghi hash, môi trường, kết quả và giới hạn; chỉ gộp/triển khai/bật theo quyết định root sau nghiệm thu. Không khẳng định đã hoạt động trên web chính khi chỉ có code và HTTP giả lập.

## 9. Tài liệu tham khảo của bộ kết nối

- https://developer.paypal.com/api/orders/v2
- https://developer.paypal.com/api/webhooks/v1
- https://developer.paypal.com/api/rest/reference/idempotency/

Các liên kết trên là tài liệu kỹ thuật tham khảo đã có trong bản cũ; bản cập nhật này tập trung đối chiếu code cục bộ, không chứng nhận đã kiểm dịch vụ PayPal hiện tại qua mạng.
