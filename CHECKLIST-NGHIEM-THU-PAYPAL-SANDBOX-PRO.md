# Checklist nghiệm thu PayPal Sandbox (người thao tác thật)

Nền mã: `5080e3a239b9935e22a35cc2c66e6e396f8cceda` (nhánh `claude/paypal-release-review`). Người lập: agent cấp 3 `pro_release_acceptance_ba`, chỉ ĐỌC code và tài liệu; **chưa chạy bất kỳ mục nào**. Mọi mục dưới đây có trạng thái mặc định **CHƯA CHẠY** cho đến khi người nghiệm thu điền kết quả.

Tài liệu này bổ sung, không thay `PAYPAL-SANDBOX-RELEASE-GATES.md` (Gate A–D, biên bản ký). Mục nào trùng gate thì ghi chéo, không chép lại.

## Quy ước chung

- **Che mã**: chỉ ghi 8 ký tự đầu của `id` nội bộ và `requestId` (ví dụ `req-3fa9…`), 4 ký tự cuối của order/capture ID (`…K7Q2`). Không ghi client secret, access token, `token`/`PayerID` trong URL quay lại, cookie, `cat_token`, email/mật khẩu Sandbox. Ảnh chụp chỉ lấy vùng giao diện cần thiết; **không chụp DevTools tab Application/Network có header** (access token JWT nằm ở `localStorage.cat_token`, `public/js/app.js:26,534`).
- **Ảnh sau khi dọn URL**: URL quay lại có `token` (chính là order ID) và `PayerID`; giao diện chỉ xoá query bằng `history.replaceState` sau khi JS chạy (`app.js:3354-3363`, gọi ở `app.js:4384`). Chụp màn hình thanh địa chỉ chỉ SAU khi query đã bị xoá.
- **Số dư gốc `B`**: tài khoản mới đăng ký Passkey có sẵn 5.000.000 VND demo (`src/routes/passkeys.js:64,355-370`, `DEMO_BUYER_INITIAL_BALANCE`). Ghi `B` ngay trước mục PP-04; mọi so sánh là `B` và `B + VND quote`.
- **Hạn mức tạo yêu cầu** (đã đọc trong code): tối đa 5 yêu cầu PENDING trong 24 giờ mỗi tài khoản (`src/lib/topupPolicy.js:8,41`), và yêu cầu PayPal PENDING không bao giờ tự đóng (xem finding F-03 trong `PRO-RELEASE-SAFETY-REVIEW.md`). Dự trù: **mỗi tài khoản nghiệm thu không quá 4 yêu cầu mới** trong một ngày; hết hạn mức thì dừng, không đổi tài khoản để lách trừ khi mục đó quy định.
- Cột "Tự động hiện có" chỉ nêu bằng chứng fixture/HTTP giả/jsdom; theo `PAYPAL-SANDBOX-INTEGRATION.md` mục 1 chúng **không** là bằng chứng Sandbox thật, redirect/cookie thật hay Windows Hello thật.
- **Phần PHẢI do người dùng thao tác** được đánh dấu **[NGƯỜI DÙNG]**: đăng nhập PayPal Sandbox, phê duyệt, Windows Hello/PIN, xác nhận HTTPS/cookie trên trình duyệt thật. Codex/agent không thay thế.

---

## PP-00. Tiền đề (làm một lần trước mọi mục)

| Trường | Nội dung |
|---|---|
| Đầu vào | Hash API và frontend triển khai; nhãn DB (staging/demo riêng, không production nếu root chưa chốt); nhãn app Sandbox, Merchant ID (che); 2 tài khoản BUYER ACTIVE đã có Passkey (`A`, `B2`) + 1 ADMIN đã có Passkey; 1 Personal Sandbox (người mua), 1 Business Sandbox (người nhận, thuộc đúng app) |
| Các bước | (1) Ghi hash và so với hash chứa bản vá chặn mock của Codex (nếu chưa vào hash thì ghi "chưa có bản vá" vào biên bản). (2) Kiểm biến môi trường chỉ bằng **tên và có/không có giá trị**, không in giá trị: `PAYPAL_SANDBOX_ENABLED`, `…_CLIENT_ID`, `…_CLIENT_SECRET`, `…_MERCHANT_ID`, `…_WEBHOOK_ID`, `PAYPAL_FRONTEND_ORIGIN`, `PAYPAL_DEMO_VND_PER_USD`, `MOCK_PROVIDER_CHECKOUT`, `RECONCILE_INTERVAL_SECONDS`, `TRUST_PROXY`, `FAULT_INJECT` (phải KHÔNG đặt), `PAYMENT_WEBHOOK_SECRET`. (3) Truy vấn chỉ-đọc: số hàng `payment_requests` provider `MOCK` đang `PENDING` của các tài khoản thử (phải 0, xem F-02). |
| Quan sát | Danh sách tên biến có/không; số MOCK PENDING; hash |
| Đạt | `PAYPAL_FRONTEND_ORIGIN` bằng đúng origin HTTPS đang dùng để nghiệm thu (nếu bỏ trống, mặc định là `https://enclave.id.vn`, `src/lib/paypalRuntime.js:15`, và người mua sẽ bị đưa về trang production); `FAULT_INJECT` không đặt; không có MOCK PENDING |
| Dừng | Origin lệch; có MOCK PENDING chưa rõ nguồn; `FAULT_INJECT` đặt; DB là production mà root chưa chốt |
| Bằng chứng | Bảng tên-biến có/không (che mọi giá trị), hash, nhãn DB |
| Tự động hiện có | `test/paypal-m2-api-e2e.js` A1 (config công khai không lộ bí mật) và A10 (cấu hình tắt không gọi mạng), fixture. **Không đủ**: không kiểm biến môi trường của máy chủ thật |
| Trạng thái | CHƯA CHẠY |

## PP-01. Sandbox bật, Live không dùng, mock tắt

| Trường | Nội dung |
|---|---|
| Đầu vào | Máy chủ đã khởi động lại sau khi đặt biến (runtime là singleton, `paypalRuntime.js:97-98`) |
| Các bước | (1) Mở `GET <API>/api/payments/paypal/config` bằng trình duyệt hoặc `curl` không kèm cookie. (2) Mở trang ví bằng tài khoản `A`. (3) Thử gọi tạo yêu cầu mock bằng `POST /api/payments/topup` với body `{"amount":100000,"requestId":"mockprobe-0001"}` và token của `A` (qua công cụ hoặc `curl`, không dán token vào báo cáo). (4) Mở `<API>/mock-provider/checkout/x` khi đã đăng nhập. |
| Quan sát | (1) JSON có `paypalSandbox.enabled=true`, `mode=sandbox`, `mockPayments.enabled=false`, không có trường nào khác chứa chuỗi bí mật. (2) Thẻ "Nạp tiền vào ví" mang nhãn "PayPal Sandbox"; không có thẻ mock. (3) HTTP 503 mã `MOCK_PAYMENTS_DISABLED` (`src/routes/payments.js:78`). (4) 404 `NOT_FOUND` (`src/routes/mockProvider.js:27`, `mockPaymentProvider.js:247`). |
| Đạt | Cả 4 đúng; sau bước 3 truy vấn không thấy hàng MOCK mới |
| Dừng | `enabled=true` nhưng ví vẫn hiện thẻ mock; bước 3 trả 200/201; bất kỳ URL nào trỏ tới `api-m.paypal.com` hoặc `www.paypal.com` (Live) trong lúc nghiệm thu |
| Bằng chứng | JSON config (không có gì nhạy cảm nên được lưu), ảnh thẻ ví, mã trạng thái bước 3-4 |
| Tự động hiện có | `test/ui/paypal-wallet-ui.js` mục C; `test/browser/paypal/config.browser.js`; `test/paypal-m2-api-e2e.js` A1; `test/payment-provider-isolation-e2e.js`; `test/paypal-sandbox-adapter.test.js` (host cố định Sandbox, adapter `SANDBOX_BASE` ở `paypalSandboxProvider.js:5`). **Không đủ**: không có biến môi trường để chọn Live (đọc code), nhưng "không dùng Live" trên máy chủ thật chỉ quan sát được từ đích mạng thật thấy trong PP-03. |
| Ghi chú | Mock bị chặn ở bước 3 CHỈ khi `PAYPAL_SANDBOX_ENABLED=1`. Nếu nghiệm thu phải chạy với flag PayPal tắt và `MOCK_PROVIDER_CHECKOUT=0`, đó là finding đã biết F-01, không phải phát hiện mới. |
| Trạng thái | CHƯA CHẠY |

## PP-02. Báo giá VND/USD và nhãn tỷ giá mô phỏng

| Trường | Nội dung |
|---|---|
| Đầu vào | Tài khoản `A`, số tiền 100.000 VND (kỳ vọng 4,00 USD nếu tỷ lệ 25.000 VND/USD; nếu tỷ lệ đã đổi thì tính `ceil(VND*100/tỷ_lệ)` cent rồi ghi lại công thức vào biên bản) |
| Các bước | Chọn 100.000, bấm "Tạo yêu cầu nạp PayPal". Ghi giá trị USD và nhãn trong hộp thông báo. Không tự điền số USD ở đâu. Thử một số khác (ví dụ 150.000: 6,00 USD; 100.001 nếu giao diện cho nhập: kỳ vọng làm tròn LÊN theo cent) ở một yêu cầu thứ hai nếu hạn mức cho phép |
| Quan sát | Hộp "Ghi vào ví (VND)", "PayPal Sandbox thu (USD)", dòng nhãn "Tỷ giá mô phỏng, không phải giá thị trường — N VND/USD"; số USD trên trang PayPal ở PP-03 |
| Đạt | USD khớp công thức máy chủ (`paypalSandboxProvider.js:36-46`); nhãn có chữ "mô phỏng"; USD trên trang PayPal bằng USD trong hộp |
| Dừng | USD ở PayPal khác USD ở giao diện; không có nhãn mô phỏng; giao diện có ô nhập USD |
| Bằng chứng | Ảnh hộp báo giá (che id), số USD trên trang PayPal |
| Tự động hiện có | `test/ui/paypal-wallet-ui.js` mục B; `test/paypal-sandbox-adapter.test.js`; `paypal-m2-api-e2e.js` A3. **Không đủ**: quote chỉ được đối chiếu với PayPal thật ở bước này. |
| Trạng thái | CHƯA CHẠY |

## PP-03. Người mua Personal, người nhận Business đã cấu hình

| Trường | Nội dung |
|---|---|
| Đầu vào | Yêu cầu từ PP-02 ở giai đoạn "Chờ phê duyệt PayPal Sandbox" |
| Các bước | **[NGƯỜI DÙNG]** Bấm "Mở PayPal Sandbox". Quan sát tên miền thanh địa chỉ; đăng nhập bằng Personal Sandbox (không nhập thông tin vào bất kỳ ô nào khác của Enclave). Trên trang PayPal đọc tên người nhận và số tiền. **Chưa bấm phê duyệt** ở mục này nếu muốn chạy PP-05 trước. |
| Quan sát | Tên miền đúng `www.sandbox.paypal.com`; tên người nhận khớp Business Sandbox của app; số USD khớp PP-02; môi trường có nhãn Sandbox |
| Đạt | Cả 3 khớp; không xuất hiện bất kỳ miền `paypal.com` không-Sandbox |
| Dừng | Miền khác (kể cả gần giống); người nhận khác Business đã cấu hình; PayPal đòi tài khoản thật/thẻ thật |
| Bằng chứng | Ảnh trang PayPal (che email); xác nhận bằng lời của người dùng "đã dùng Personal Sandbox" |
| Tự động hiện có | `test/ui/paypal-wallet-ui.js` mục U; `test/browser/paypal/payment-flow.browser.js` B1 (**fixture, trang PayPal bị thay bằng trang giả**, `harness.js:206`); `paypal-m2-api-e2e.js` A4. **Không đủ**: toàn bộ phía PayPal; kiểm payee chỉ do `verifyOrder` phía máy chủ (`paypalSandboxProvider.js:62-69`), cần đối chiếu thủ công trên dashboard Sandbox của chính người dùng |
| Trạng thái | CHƯA CHẠY |

## PP-04. Return không tự cộng; capture chủ động; GET cuối; ghi đúng một lần

| Trường | Nội dung |
|---|---|
| Đầu vào | Yêu cầu từ PP-02/03, số dư `B` đã ghi |
| Các bước | **[NGƯỜI DÙNG]** Phê duyệt ở PayPal bằng Personal Sandbox, để PayPal tự đưa về Enclave (không gõ tay URL). Khi vừa về trang ví, **chưa bấm gì**: ghi số dư và lịch sử. Bấm "Xác nhận và hoàn tất thanh toán". Chờ giao diện hiện "Nạp tiền thành công". Làm mới trang. |
| Quan sát | Trước khi bấm xác nhận: giai đoạn "Chờ phê duyệt" với dòng "Bạn đã quay lại từ PayPal", số dư vẫn `B`. Sau: thông báo thành công, số dư `B+100.000`. Truy vấn chỉ-đọc (Gate C bước 5-6): `payment_requests.status=SUCCEEDED`, `paypal_payment_bindings.capture_state=VERIFIED` có `capture_id` khớp 4 ký tự cuối trên dashboard Sandbox; **đúng một** `wallet_entries` `TOPUP_CREDIT`, `available_delta=100000`, `locked_delta=0`, `idempotency_key=topup:<id>` |
| Đạt | Đúng các điều trên; USD thu trên dashboard Sandbox khớp PP-02; số dư tăng đúng VND quote |
| Dừng | Số dư tăng trước khi bấm xác nhận; số dư tăng khác `100.000`; hơn một `TOPUP_CREDIT`; giao diện báo thành công trong khi GET `/api/payments/<id>` chưa `SUCCEEDED` |
| Bằng chứng | Ảnh trước/sau (che id), kết quả 3 truy vấn chỉ-đọc, ảnh dòng capture trên dashboard Sandbox (che email/ID đầy đủ) |
| Tự động hiện có | `test/ui/paypal-wallet-ui.js` mục R, X; `paypal-m2-api-e2e.js` A5; `paypal-m2-settlement-e2e.js` T1, T3; `paypal-integration-e2e.js` (capture+webhook+worker lặp: `posts` không tăng). **Không đủ**: capture COMPLETED thật, `final_capture`, số USD thật |
| Trạng thái | CHƯA CHẠY |

## PP-05. Cancel: không capture, không cộng, mở lại được

| Trường | Nội dung |
|---|---|
| Đầu vào | Một yêu cầu MỚI (tài khoản `A` hoặc `B2`) ở giai đoạn chờ phê duyệt, **chưa** phê duyệt |
| Các bước | **[NGƯỜI DÙNG]** Mở PayPal Sandbox, đăng nhập, bấm "Cancel/Huỷ" để về Enclave. Quan sát. Bấm "Mở lại PayPal Sandbox" rồi quay về lại (hoặc đi tiếp sang PP-04 với cùng yêu cầu). Truy vấn chỉ-đọc `capture_state`, `capture_post_count`, `order_id` trước và sau. |
| Quan sát | Hộp "Bạn đã quay lại mà chưa hoàn tất phê duyệt… yêu cầu vẫn mở và chưa thu tiền"; không có nút "Xác nhận…"; số dư không đổi; `capture_post_count=0`; `order_id` không đổi; không có yêu cầu mới trong lịch sử |
| Đạt | Đúng các điều trên; mở lại dùng cùng order |
| Dừng | Có `capture_post_count>0`; trạng thái `FAILED`; có order thứ hai; có `TOPUP_CREDIT` |
| Bằng chứng | Ảnh hộp thông báo, trích `capture_*` và `order_id` (che) trước/sau |
| Tự động hiện có | `test/ui/paypal-wallet-ui.js` mục R; `test/browser/paypal/payment-flow.browser.js` B2; `paypal-m2-api-e2e.js` A5. **Không đủ**: hành vi trang Cancel và link phê duyệt khi mở lại trên PayPal thật |
| Trạng thái | CHƯA CHẠY |

## PP-06. Bấm lặp, reload, retry giữ requestId

| Trường | Nội dung |
|---|---|
| Đầu vào | Tài khoản `B2`, ý định mới |
| Các bước | (1) Bấm "Tạo yêu cầu nạp PayPal" hai lần liên tiếp thật nhanh. (2) Làm mới trang giữa chừng khi hộp "chờ" còn hiện. (3) Sau PP-04 hoặc PP-05, bấm nút "Thử lại cùng yêu cầu"/"Kiểm tra trạng thái". (4) Truy vấn chỉ-đọc: đếm `payment_requests` của `B2` theo `client_request_id`. |
| Quan sát | Một `requestId` duy nhất (mã `topup-…`) giữ qua reload; chỉ một hàng `payment_requests` và một `order_id`; số tiền ô nhập bị khoá khi ý định còn mở |
| Đạt | Đúng một yêu cầu, một order |
| Dừng | Hai hàng cùng ý định; `requestId` đổi sau reload; lỗi 409 `IDEMPOTENCY_KEY_REUSED` xuất hiện với cùng số tiền |
| Bằng chứng | Số hàng và `requestId` (8 ký tự đầu) trước/sau |
| Tự động hiện có | `test/ui/paypal-wallet-ui.js` mục Q; `test/ui/topup-request-id-ui.js`; `test/topup-idempotency-e2e.js`; `test/paypal-m2-api-e2e.js` A3. **Không đủ**: trình duyệt thật + localStorage thật + PayPal thật; "Bắt đầu lần nạp mới" cố ý tạo ý định mới nên KHÔNG dùng làm ca này |
| Trạng thái | CHƯA CHẠY |

## PP-07. Timeout / kết quả chưa rõ: chờ đối soát, không báo thành công giả

| Trường | Nội dung |
|---|---|
| Đầu vào | Môi trường diễn tập do root cho phép (staging); **không** thực hiện trên DB production. Cách gây timeout phải do Codex/root đề xuất và được duyệt (ví dụ chặn đường ra tới `api-m.sandbox.paypal.com` ở tầng mạng của staging trong thời gian ngắn, trong khi một capture đang chạy). Nếu không có cách an toàn, **đánh dấu CHƯA CHẠY và ghi lý do** |
| Các bước | Tạo yêu cầu, phê duyệt, bấm xác nhận trong khi chặn mạng; sau đó gỡ chặn; chờ ít nhất một chu kỳ worker (`RECONCILE_INTERVAL_SECONDS`, mặc định 60s, và min-age 30s); bấm "Kiểm tra lại". KHÔNG bấm xác nhận lần nữa. |
| Quan sát | Giao diện "Chưa rõ kết quả… hệ thống đang đối soát" (không phải thất bại, không phải thành công); số dư giữ `B`; `capture_post_count` không vượt 1 từ phía người dùng; sau khi gỡ chặn, worker/GET đưa về `SUCCEEDED` đúng một lần hoặc giữ `RECONCILING` kèm lỗi đã che |
| Đạt | Không có "thành công" trước chứng cứ; không có hơn một POST capture nào do người dùng bấm; cuối cùng chỉ một `TOPUP_CREDIT` hoặc không có nếu PayPal chưa thu |
| Dừng | Giao diện báo thành công trong lúc `status=PENDING`; trạng thái bị chuyển `FAILED`; `capture_post_count` tăng do bấm tay |
| Bằng chứng | Ảnh các giai đoạn, trích `capture_state/capture_post_count/last_capture_error`, log worker đã che (`[reconcile] …` không chứa secret theo `reconciler.js:228-229`) |
| Tự động hiện có | `paypal-m2-settlement-e2e.js` T5, T6; `paypal-m2-recovery-e2e.js` R1-R4 (kill process, fixture); `paypal-m2-api-e2e.js` A7, A12; `test/ui/paypal-wallet-ui.js` mục X. **Không đủ**: PayPal thật không bao giờ được thử timeout; đó là bằng chứng fixture |
| Trạng thái | CHƯA CHẠY |

## PP-08. Webhook được xác minh, gửi lặp không cộng lần hai

| Trường | Nội dung |
|---|---|
| Đầu vào | Webhook đã đăng ký trong **đúng app Sandbox**, URL `…/api/payments/paypal/webhook`, sự kiện `PAYMENT.CAPTURE.COMPLETED`; ít nhất một event thật từ PP-04 trong trang "Webhook events" của app Sandbox |
| Các bước | **[NGƯỜI DÙNG]** (1) Xác nhận trên dashboard Sandbox rằng event của PP-04 đã giao (HTTP 2xx) hoặc bấm "Resend" event thật đó. (2) Đối chiếu `wallet_entries` sau lần Resend. (3) Gửi một POST giả tới webhook từ máy của người kiểm (header PayPal giả, chữ ký sai) và ghi mã trả về. |
| Quan sát | Resend: HTTP 200, số `TOPUP_CREDIT` vẫn 1, số dư không đổi. POST giả: 401 `INVALID_SIGNATURE` (`paypalSandboxService.js:127-129`), không có hàng mới. Dashboard cho thấy lần giao thành công. |
| Đạt | Cả hai; không có secret/ID đầy đủ trong ảnh |
| Dừng | Resend tăng số dư; POST giả trả 200; không bao giờ thấy event giao thành công (chữ ký không xác minh được, xem F-12) |
| Bằng chứng | Ảnh trang Webhook events (che ID), mã trả về của POST giả, số `TOPUP_CREDIT` |
| Tự động hiện có | `paypal-m2-api-e2e.js` A9; `paypal-integration-e2e.js` dòng 60-61 (webhook lặp song song capture/worker); `paypal-sandbox-service.test.js`. **Không đủ**: chữ ký thật; chứng minh WEBHOOK thắng cuộc đua cần request thử riêng (xem Gate D). `webhook simulator` không có order do app tạo nên **không** là bằng chứng. |
| Ghi chú | Webhook trả 200 cả khi kết quả là `CONFLICT`/`RECOVERY_REQUIRED`/`STILL_PENDING` (F-07): "200" không chứng minh đã cộng ví; luôn đối chiếu `wallet_entries`. |
| Trạng thái | CHƯA CHẠY |

## PP-09. Worker đối soát chỉ GET

| Trường | Nội dung |
|---|---|
| Đầu vào | `RECONCILE_INTERVAL_SECONDS>0`; một yêu cầu đã `SUCCEEDED` và một yêu cầu `PENDING` đang chờ phê duyệt |
| Các bước | Chờ hai chu kỳ worker. So sánh `capture_post_count`, số `TOPUP_CREDIT`, và log `[reconcile]` trước/sau. |
| Quan sát | `capture_post_count` không tăng; không có `TOPUP_CREDIT` mới; yêu cầu PENDING chưa phê duyệt vẫn PENDING (worker không đóng, không thu) |
| Đạt | Đúng các điều trên |
| Dừng | Worker làm tăng `capture_post_count` hoặc ví |
| Bằng chứng | Trích `capture_post_count`, dòng log đã che |
| Tự động hiện có | `paypal-m2-api-e2e.js` A12; `paypal-integration-e2e.js`. **Không đủ**: chu kỳ thật với PayPal thật |
| Trạng thái | CHƯA CHẠY |

## PP-10. Đăng xuất / đăng nhập lại / đổi tài khoản khi phản hồi đang treo

| Trường | Nội dung |
|---|---|
| Đầu vào | Hai tài khoản `A`, `B2`; một yêu cầu của `A` ở giai đoạn chờ phê duyệt hoặc vừa quay lại |
| Các bước | (1) Ở trang ví của `A`, bấm "Xác nhận…" rồi đăng xuất ngay. Đăng nhập lại **cùng** `A` và vào ví. (2) Lặp lại, nhưng sau khi đăng xuất đăng nhập `B2`. (3) Khi vừa về từ PayPal (URL có `?paypal=return&paymentRequestId=…`) hãy đăng xuất trước khi trang xử lý, rồi đăng nhập `B2`. |
| Quan sát | (1) Ý định của `A` còn nguyên (khoá localStorage theo id người dùng, `app.js:2508-2549`); trạng thái lấy từ máy chủ; không có toast thành công cho phiên cũ. (2) `B2` không thấy ý định hay yêu cầu của `A`; không có tác động ví của `B2`. (3) `B2` có thể thấy toast lỗi 403 "không có quyền xem yêu cầu"; ví của `B2` không đổi (xem F-13: callback chờ không bị xoá khi đăng xuất). |
| Đạt | Không có tác động chéo tài khoản; số dư của `B2` không đổi; chỉ `A` có thể đạt `SUCCEEDED` cho yêu cầu của `A` |
| Dừng | Toast thành công hay thay đổi số dư xuất hiện ở tài khoản khác; `B2` thấy được số tiền/order của `A` |
| Bằng chứng | Ảnh ví của `A` và `B2`, số dư hai bên trước/sau |
| Tự động hiện có | `test/ui/paypal-wallet-ui.js` mục N; `test/browser/paypal/session.browser.js` B3, B4 (fixture); `test/ui/session-refresh-ui.js`. **Không đủ**: phiên thật qua cookie HttpOnly và PayPal thật |
| Trạng thái | CHƯA CHẠY |

## PP-11. Cookie và refresh qua HTTPS sau redirect — **[NGƯỜI DÙNG]**

| Trường | Nội dung |
|---|---|
| Đầu vào | Frontend và API trên HTTPS thật (website chính hoặc staging có cấu hình CORS/RP ID riêng đã duyệt); **không** dùng preview `*.vercel.app` mặc định (vẫn trỏ API chính, `PAYPAL-SANDBOX-INTEGRATION.md` mục 7) |
| Các bước | (1) Đăng nhập, mở PayPal, **ở lại trang PayPal hơn 15 phút** (access token JWT hết hạn), phê duyệt, quay về. (2) Quan sát có phải đăng nhập lại không. (3) Trong DevTools (chỉ để xem thuộc tính, không chụp giá trị) kiểm cookie refresh có `HttpOnly`, `Secure`, `SameSite=Strict`. |
| Quan sát | Phiên phục hồi qua `/api/passkeys/session/refresh` (`src/routes/passkeys.js:556`) và trang xử lý return chạy bình thường; hoặc nếu phải đăng nhập lại, trạng thái `?paypal=return…` vẫn được xử lý sau đăng nhập (xem F-13) |
| Đạt | Cookie có đủ 3 thuộc tính (cờ `Secure` chỉ có khi `req.secure`, `src/lib/session.js:111-115`, nên cần `TRUST_PROXY=1` đúng); capture chỉ xảy ra sau khi bấm xác nhận |
| Dừng | Cookie thiếu `Secure` trên HTTPS thật; return bị lặp xử lý; mất ý định |
| Bằng chứng | Ảnh danh sách thuộc tính cookie (không có giá trị), ghi chú thời gian chờ |
| Tự động hiện có | `test/ui/session-refresh-ui.js`, `test/browser/paypal/session.browser.js` B4: **fixture, không có cookie thật**. Không đủ cho mục này |
| Trạng thái | CHƯA CHẠY |

## PP-12. Passkey / Windows Hello thật — **[NGƯỜI DÙNG]**

| Trường | Nội dung |
|---|---|
| Đầu vào | Máy Windows có Windows Hello (PIN/vân tay/khuôn mặt) đã bật; origin HTTPS đúng RP ID (`WEBAUTHN_RP_ID`/`WEBAUTHN_ORIGIN`, `enclave.id.vn` và `https://enclave.id.vn` với website chính; không dùng `api.…` làm origin Passkey; local dùng `localhost`, không `127.0.0.1`) |
| Các bước | Đăng ký một Passkey mới bằng Windows Hello; đăng xuất; đăng nhập bằng Passkey đó; thực hiện một thao tác cần xác nhận lại bằng Passkey (reauth ở PP-13). Việc này **độc lập với nạp PayPal** (nạp tiền không đòi Passkey, `src/routes/paypal.js:10-11`). |
| Quan sát | Hộp thoại Windows Hello của hệ điều hành xuất hiện và được người dùng chấp nhận; máy chủ nhận assertion |
| Đạt | Đăng ký, đăng nhập và reauth thành công bằng thiết bị thật |
| Dừng | Chỉ chạy được bằng software authenticator/fixture; lỗi origin/RP ID |
| Bằng chứng | Người dùng xác nhận; ảnh hộp thoại Windows Hello (không có dữ liệu sinh trắc) |
| Tự động hiện có | `test/softwareAuthenticator.js`, jsdom, passkey-registration-race-e2e: **software authenticator, không phải bằng chứng thiết bị thật** |
| Trạng thái | CHƯA CHẠY |

## PP-13. Tranh chấp: hoàn/giải ngân TRONG hệ thống, không phải PayPal

| Trường | Nội dung |
|---|---|
| Đầu vào | Một giao dịch thử có tranh chấp giữa hai tài khoản demo (người mua có tiền nạp từ PP-04); ADMIN có Passkey (PP-12) |
| Các bước | **[NGƯỜI DÙNG]** ADMIN mở tranh chấp, xác nhận lại bằng Passkey, chọn "Hoàn tiền" cho một giao dịch và "Giải ngân" cho giao dịch khác (`POST /api/admin/disputes/:id/refund`, `…/release`, `src/routes/admin.js:385,495`). Ghi số dư ví người mua, người bán, ví ký quỹ trước/sau. Kiểm không có yêu cầu mạng tới `api-m.sandbox.paypal.com` và không có thay đổi nào trên dashboard Sandbox. |
| Quan sát | Hoàn tiền: tiền ký quỹ về `available_balance` ví người mua trong hệ thống; giải ngân: về ví người bán trong hệ thống; dashboard Sandbox không có refund/payout; giao diện ghi "không hoàn tiền hay chi tiền qua PayPal" (`app.js:3035`) |
| Đạt | Số dư dịch chuyển đúng giữa các ví Enclave; không có refund/payout PayPal; chín bất biến đúng (`npm run check:invariants`) |
| Dừng | Xuất hiện refund/payout trên PayPal; tổng ví không bảo toàn |
| Bằng chứng | Số dư các ví trước/sau, kết quả `check:invariants`, ảnh dashboard Sandbox không có refund |
| Tự động hiện có | `test/dispute-race-e2e.js`, `test/e2e.js`, `test/invariants-unit.js` (ví nội bộ, **không** có ca PayPal-cụ thể trong `paypal-*`; grep `refund`/`release` trong `test/paypal-*` và `paypal-integration-e2e.js` không thấy). **Không đủ**: chưa có test nào chứng minh số VND từ PayPal-nạp được hoàn trong hệ thống; chỉ có đọc code (`admin.js` không tham chiếu PayPal, grep đã xác nhận). |
| Trạng thái | CHƯA CHẠY |

## PP-14. Phê duyệt xong nhưng không quay lại (kiểm hành vi liveness)

| Trường | Nội dung |
|---|---|
| Đầu vào | Yêu cầu mới, `A` hoặc `B2` (dành 1 trong 4 yêu cầu của ngày) |
| Các bước | **[NGƯỜI DÙNG]** Phê duyệt ở PayPal rồi **đóng tab** trước khi PayPal đưa về. Mở lại Enclave bằng tay, vào ví, xem Lịch sử nạp tiền; bấm "Mở PayPal Sandbox" ở dòng đó; bấm "Kiểm tra". |
| Quan sát | Ghi lại mọi nút có sẵn, mọi thông báo, `capture_state`, `capture_post_count`, và giai đoạn. Ghi cả việc link phê duyệt có được cấp lại hay giao diện báo "địa chỉ phê duyệt không hợp lệ" (`app.js:3284-3288`) |
| Đạt | Ghi nhận trung thực: **không có tiêu chí đạt/trượt cố định**; mục này tìm xác nhận hoặc bác bỏ finding F-04 bằng Sandbox thật. Bắt buộc: số dư không đổi khi chưa có capture |
| Dừng | Ví tăng mà chưa capture |
| Bằng chứng | Ảnh các nút/thông báo, các trường `capture_*` |
| Tự động hiện có | Không có. Không đủ để kết luận |
| Trạng thái | CHƯA CHẠY |

## PP-15. Đối chiếu cuối và rà bí mật

| Trường | Nội dung |
|---|---|
| Đầu vào | Cuối đợt nghiệm thu |
| Các bước | (1) Chạy `npm run check:invariants` (9 bất biến; **không** gồm 3 bất biến PayPal, F-06). (2) Chạy chỉ-đọc bản SQL tương đương ba bất biến PayPal (mã trong `src/lib/paypalInvariants.js:5-8`): mọi `PAYPAL_SANDBOX`/`SUCCEEDED` phải có một `TOPUP_CREDIT` đúng `amount`, `capture_state=VERIFIED`, `capture_id` không NULL; `capture_id` không trùng giữa hai request; không có `TOPUP_CREDIT` cho request chưa `SUCCEEDED`. (3) Rà tất cả ảnh/log/báo cáo đã lưu bằng tìm kiếm chuỗi: `Bearer`, `access_token`, `client_secret`, `PayerID`, `token=`, `Authorization`, `cat_token`, email Sandbox, `eyJ` (đầu JWT). |
| Quan sát | Số hàng vi phạm; số lần khớp chuỗi nhạy cảm |
| Đạt | 0 vi phạm; 0 khớp chuỗi nhạy cảm trong tệp lưu |
| Dừng | Bất kỳ vi phạm bất biến; bất kỳ bí mật trong tệp đã lưu (xoá tệp, thông báo root, coi secret là lộ và xoay) |
| Bằng chứng | Kết quả truy vấn (số, không dữ liệu khách), kết quả tìm chuỗi |
| Tự động hiện có | `test/helpers/paypal-m2-harness.js:134-136`, `paypal-integration-e2e.js:165` chạy bất biến PayPal trong **test**, không phải trên DB nghiệm thu |
| Trạng thái | CHƯA CHẠY |

---

## Biên bản tổng

| Mục | Trạng thái | Người thực hiện | Giờ | Ghi chú/mã tham chiếu đã che |
|---|---|---|---|---|
| PP-00 | CHƯA CHẠY | | | |
| PP-01 | CHƯA CHẠY | | | |
| PP-02 | CHƯA CHẠY | | | |
| PP-03 | CHƯA CHẠY | | | |
| PP-04 | CHƯA CHẠY | | | |
| PP-05 | CHƯA CHẠY | | | |
| PP-06 | CHƯA CHẠY | | | |
| PP-07 | CHƯA CHẠY | | | |
| PP-08 | CHƯA CHẠY | | | |
| PP-09 | CHƯA CHẠY | | | |
| PP-10 | CHƯA CHẠY | | | |
| PP-11 | CHƯA CHẠY | | | |
| PP-12 | CHƯA CHẠY | | | |
| PP-13 | CHƯA CHẠY | | | |
| PP-14 | CHƯA CHẠY | | | |
| PP-15 | CHƯA CHẠY | | | |

Thứ tự đề xuất: PP-00 → PP-01 → PP-02 → PP-03 (chưa phê duyệt) → PP-05 (cancel, cùng yêu cầu) → PP-04 (phê duyệt, capture) → PP-06 → PP-08 → PP-09 → PP-10 → PP-14 (yêu cầu mới) → PP-11 → PP-12 → PP-13 → PP-07 (chỉ nếu có môi trường diễn tập) → PP-15.

Giới hạn của chính tài liệu này: các số dòng code trỏ vào hash `5080e3a`; mọi quan sát mong đợi được suy ra từ ĐỌC code, chưa kiểm bằng chạy; chưa đọc kết quả của `PRO-RELEASE-BACKEND-QA.md` hay `PRO-RELEASE-RUNNER-REVIEW.md` (thuộc giai đoạn 2).
