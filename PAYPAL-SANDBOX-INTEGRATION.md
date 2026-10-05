# PayPal Sandbox cho Enclave: bộ kết nối và ranh giới tích hợp

## 1. Trạng thái thực tế

Nhánh này bổ sung hai module độc lập, tắt theo mặc định:

- `cho-an-tam/src/lib/paypalSandboxProvider.js`: OAuth phía máy chủ, tạo Orders v2, capture, truy vấn, xác minh webhook qua API PayPal.
- `cho-an-tam/src/lib/paypalSandboxService.js`: kiểm tra chủ sở hữu, đọc báo giá đã lưu, gắn order với yêu cầu, chuyển kết quả đã xác minh tới hàm tất toán được truyền vào.

Chưa nối route HTTP, cơ sở dữ liệu, worker hay giao diện. Vì Claude Max đang sửa đúng các file thanh toán dùng chung, PR này không chỉnh `payments.js`, `paymentService.js`, `reconciler.js`, `mockPaymentProvider.js`, `db.js`, schema, `public/` hoặc bộ chạy test. Bộ kết nối độc lập chưa có nghĩa website đã thanh toán được bằng PayPal. Cần PR tích hợp tiếp theo sau khi hợp đồng của Claude Max được duyệt.

Không có thông tin ứng dụng Sandbox trong workspace này; kiểm thử độc lập dùng HTTP giả lập. Chưa gọi PayPal bằng thông tin của người dùng, chưa dùng DB production, chưa triển khai.

## 2. Chính sách tiền tệ của bản trình diễn

Ví và sổ cái Enclave vẫn dùng số nguyên VND. PayPal Sandbox nhận USD. VND không có trong danh sách tiền tệ REST PayPal được công bố tại thời điểm rà soát.

Máy chủ tạo báo giá thử nghiệm bằng `createQuote(amountVnd, rateVndPerUsd)`. Tỷ lệ mặc định trong bộ kết nối là **25.000 VND/USD**, chỉ là cấu hình trình diễn, không phải tỷ giá thị trường/PayPal, không được dùng cho tiền thật. Số cent USD bằng `ceil(amountVnd * 100 / rateVndPerUsd)` bằng số nguyên BigInt; không dùng số thực cho phép tính tiền. Ví dụ 100.000 VND ở tỷ lệ này tương ứng 4,00 USD Sandbox.

Một báo giá có dạng:

```json
{"version":1,"amountVnd":100000,"currency":"USD","usdCents":400,"usdValue":"4.00","rateVndPerUsd":25000}
```

Báo giá phải lưu nguyên vẹn cùng yêu cầu nạp trước lần gọi PayPal đầu tiên. Sau đó đổi biến tỷ giá không làm thay đổi yêu cầu đã có. Người dùng cần thấy cả số VND ghi ví, USD thử nghiệm phải trả và tỷ lệ trước khi phê duyệt. Làm tròn lên có thể tạo chênh nhỏ; giao diện phải hiển thị số USD đã chốt.

## 3. Hợp đồng bộ kết nối

```js
const { createSandboxProvider } = require('./src/lib/paypalSandboxProvider');
const provider = createSandboxProvider({
  enabled: false, // chỉ true sau khi hoàn tất các hook và cấu hình
  clientId: process.env.PAYPAL_SANDBOX_CLIENT_ID,
  clientSecret: process.env.PAYPAL_SANDBOX_CLIENT_SECRET,
  webhookId: process.env.PAYPAL_SANDBOX_WEBHOOK_ID,
  merchantId: process.env.PAYPAL_SANDBOX_MERCHANT_ID,
  rateVndPerUsd: 25000,
  frontendOrigin: 'https://enclave.id.vn',
  timeoutMs: 10000,
});
```

Đây là ví dụ hợp đồng, chưa phải đoạn khởi tạo chạy trong ứng dụng. `enabled` phải là boolean `true`; thiếu thông tin bắt buộc thì từ chối. Client Secret chỉ ở máy chủ. HTTP chỉ gửi tới `https://api-m.sandbox.paypal.com`; live hoặc endpoint tự chọn bị chặn. URL phê duyệt chỉ được dùng `https://www.sandbox.paypal.com`; URL quay lại phải cùng HTTPS origin của giao diện đã cấu hình. Không theo redirect HTTP tự động. Timeout áp dụng cả fetch và đọc body, tối đa 30 giây; phản hồi quá lớn hoặc sai JSON bị từ chối.

Các phương thức:

- `provider.createQuote(amountVnd)`.
- `provider.createOrder({paymentRequestId, quote, returnUrl, cancelUrl})`.
- `provider.captureOrder({orderId, paymentRequestId, quote})`.
- `provider.getOrder({orderId, paymentRequestId, quote})`.
- `provider.verifyWebhook({headers, event})`: chỉ `verification_status === 'SUCCESS'` là hợp lệ.

Order phải có một purchase unit, `intent=CAPTURE`, `reference_id` và `custom_id` cùng bằng ID yêu cầu nội bộ, đúng merchant ID, đúng USD và đúng cent đã lưu. Create dùng POST rồi GET để đọc dữ liệu đầy đủ. Capture kiểm tra GET **trước** khi yêu cầu thu tiền, POST capture với khóa ổn định rồi GET lại để xác minh trạng thái. Chỉ một capture đầy đủ `final_capture=true`, capture `COMPLETED` và order `COMPLETED` mới trở thành `SUCCEEDED`. Pending, approved, denied, reversed/refunded không tạo lần ghi ví mới. Các trạng thái sau thanh toán như hoàn tiền PayPal/chargeback cần quy trình riêng; module này không triển khai xử lý chargeback.

`PayPal-Request-Id` là SHA-256 rút gọn 32 ký tự của phase + ID yêu cầu. Create và capture dùng khóa khác nhau, retry cùng thao tác dùng cùng khóa. Khi PayPal trả `ORDER_ALREADY_CAPTURED`, bộ kết nối đọc lại order và xác minh; không coi lỗi đó tự nó là thanh toán thành công.

## 4. Hợp đồng service và store bắt buộc

```js
const { createSandboxPaymentService } = require('./src/lib/paypalSandboxService');
const service = createSandboxPaymentService({
  provider, store, settle: applyProviderResult,
  returnUrl: 'https://enclave.id.vn/#/wallet',
  cancelUrl: 'https://enclave.id.vn/#/wallet',
});
```

`store` do PR tích hợp cung cấp, sử dụng CSDL ứng dụng:

- `loadByRequestId(paymentRequestId)` trả dữ liệu tin cậy hoặc null.
- `loadByOrderId(orderId)` tra liên kết order duy nhất, trả dữ liệu tin cậy hoặc null.
- `claimCreateAttempt(paymentRequestId, nowIso)` thực hiện cập nhật có điều kiện, ghi timestamp lần thử đầu nếu đang null; tuyệt đối không làm mới timestamp khi retry. Trả lại toàn bộ liên kết đã lưu mới nhất.
- `bindOrder(paymentRequestId, orderId)` thực hiện cập nhật có điều kiện nguyên tử. Trả true khi đã gắn cùng order hoặc lần đầu gắn thành công; false khi khác order/xung đột. Có chỉ mục UNIQUE cho order PayPal.

Dữ liệu tin cậy:

```js
{
  provider: 'PAYPAL_SANDBOX', paymentRequestId, userId, providerRef,
  amountVnd, quote, status: 'PENDING', orderId: null, createAttemptAt: null
}
```

`providerRef` là mã nội bộ đã lưu trong `payment_requests`; `orderId` là mã PayPal riêng, không được tráo hai mã. Quote/provider/user/amount phải bất biến sau tạo; đọc từ server, không nhận nguyên object từ client. `claimCreateAttempt` phải trả đúng yêu cầu/chủ sở hữu/báo giá/mã provider ban đầu. Cửa sổ retry create chưa biết order tối đa 5 phút, ngắn hơn thời gian lưu khóa mặc định của PayPal; hết cửa sổ, service trả `PAYPAL_CREATE_RECOVERY_REQUIRED` và không gửi thêm create. Timestamp này phải bền vững qua restart.

`status` là trạng thái yêu cầu nội bộ `PENDING|SUCCEEDED|FAILED`, bắt buộc lấy từ CSDL. FAILED chặn create/capture trước khi gọi provider; SUCCEEDED chỉ GET order đã gắn khi thử lại. Yêu cầu SUCCEEDED thiếu order binding bị từ chối. Kiểm tra trạng thái trước capture chưa đủ để chống một luồng khác đóng request trong lúc gọi mạng. PR tích hợp phải dành quyền capture trong state machine hoặc cấm chuyển FAILED/hết hạn khi chưa biết kết quả PayPal, rồi đối soát thay thế. **Không áp dụng logic hết hạn/mock expire của Claude Max cho yêu cầu PayPal.** Module độc lập không giữ transaction CSDL qua mạng; đây là điều kiện chặn bật feature trước khi nối hoàn chỉnh.

Khi order đã gắn, mọi lần mở lại dùng GET cùng order, kể cả nhiều giờ sau; không tạo order mới. Nếu timeout create làm mất order ID và đã quá cửa sổ retry, giữ yêu cầu để quản trị viên đối soát trong Sandbox Dashboard, phục hồi binding theo dữ liệu đã xác minh; không tự tạo order thay thế, không tự đánh dấu FAILED hoặc cộng ví.

Service cung cấp:

- `createOrder({paymentRequestId,userId})`: userId lấy từ phiên máy chủ; không cộng ví.
- `capture({paymentRequestId,userId})`: lấy order/quote từ store; xác minh chủ sở hữu; kết quả server capture dùng source `RECONCILER` vì đây là kênh server hỏi provider, tương thích enum hiện tại.
- `reconcile({paymentRequestId})`: API server truy vấn order; nguồn `RECONCILER`.
- `webhook({headers,event})`: xác minh chữ ký trước. Chỉ xử lý `PAYMENT.CAPTURE.COMPLETED`, tra order ID trong event qua store, GET order PayPal, kiểm tra capture ID rồi tất toán nguồn `WEBHOOK`. Payload webhook không tự quyết số VND ghi ví.

`settle` phải là hàm tất toán hiện có, bảo đảm conditional claim PENDING, tăng ví, ledger trong cùng transaction và idempotency chống lặp. Service không thay thế hàng rào CSDL. Production hook cần thêm kiểm tra provider discriminator để đường mock không thể tất toán yêu cầu PayPal.

## 5. Những hook còn phải tích hợp sau PR Claude Max

1. Thêm migration có provider discriminator (`MOCK` mặc định cho dữ liệu cũ), báo giá bất biến, order ID UNIQUE và create-attempt timestamp; kiểm tra trên SQLite/PostgreSQL. Có thể dùng bảng riêng `paypal_payment_bindings` gắn FK với `payment_requests`; chưa chốt schema vì cần phối hợp Max.
2. Tạo request PayPal và snapshot báo giá trong cùng transaction với kiểm tra ví/hạn mức/chống lặp theo hợp đồng Max. Khóa chống lặp cùng user không được đổi amount/provider. Client không quyết định quote hoặc order ID.
3. Nối routes có xác thực cho create/capture, kiểm tra owner phía máy chủ. Một route webhook PayPal riêng có giới hạn body/rate và verify qua API. Chỉ trả mã lỗi an toàn; không trả/log OAuth token, Secret hoặc nguyên upstream body.
4. Worker chọn adapter theo provider đã lưu. Với PayPal, truy vấn binding/order; với mock giữ đường cũ. Không đưa `provider_ref` PayPal vào kho mock.
5. Mock checkout và mock webhook bắt buộc từ chối request `PAYPAL_SANDBOX`. PayPal webhook/service không nhận request MOCK. Hàm settlement kiểm tra provider đúng với kênh được gọi trong chính transaction.
6. UI chọn PayPal Sandbox, hiển thị báo giá, mở URL phê duyệt đã kiểm tra, quay lại gọi capture có xác thực theo request ID nội bộ. Return URL, query `token`, nút client báo thành công không được dùng làm bằng chứng để cộng ví.
7. Xác minh kết quả toàn luồng với HTTP PayPal giả lập, SQLite/PostgreSQL và 9 bất biến; tiếp đó test tài khoản PayPal Sandbox thật bằng credentials người dùng nhập tại host. Chỉ triển khai sau khi webhook/order/capture được kiểm tra.

## 6. Cấu hình và thử nghiệm Sandbox thật (sau khi nối xong)

1. Trong PayPal Developer Dashboard tạo app **Sandbox**, dùng tài khoản business Sandbox nhận tiền và personal Sandbox phê duyệt.
2. Lấy Client ID, Secret, merchant ID của business Sandbox. Tạo webhook HTTPS của API ứng dụng cho `PAYMENT.CAPTURE.COMPLETED`, lưu webhook ID cùng app Sandbox. Không đăng Secret trong Git/PR/chat công khai.
3. Đặt các biến `PAYPAL_SANDBOX_CLIENT_ID`, `PAYPAL_SANDBOX_CLIENT_SECRET`, `PAYPAL_SANDBOX_WEBHOOK_ID`, `PAYPAL_SANDBOX_MERCHANT_ID`; PR tích hợp sẽ đọc chúng và bật feature rõ ràng. Các tên env này là hợp đồng đề xuất, chưa có server đọc hiện tại.
4. Test số VND/USD chốt, huỷ phê duyệt, PENDING, capture thành công, retry capture, hai capture đồng thời, webhook trùng, webhook giả, webhook mất và worker đối soát; kiểm tra ledger chỉ một credit.
5. Test restart giữ quote/order/timestamp; đổi cấu hình tỷ lệ không đổi quote cũ; một user khác không capture được request; mock không xử lý request PayPal.
6. Số tiền Sandbox chỉ phục vụ trình diễn, không rút/chuyển tiền thật. Giải ngân/hoàn tiền tranh chấp hiện vẫn chuyển giữa ví nội bộ Enclave; không có payout PayPal hoặc refund PayPal tự động.

## 7. Nguồn chính thức đã đối chiếu

- [Orders v2](https://developer.paypal.com/api/orders/v2)
- [Create order](https://developer.paypal.com/api/orders/v2/orders-create)
- [Capture order](https://developer.paypal.com/api/orders/v2/orders-capture)
- [Webhook signature verification](https://developer.paypal.com/api/webhooks/v1/verify-webhook-signature-post)
- [PayPal currencies](https://developer.paypal.com/api/codes/currency)
- [Idempotency](https://developer.paypal.com/api/rest/reference/idempotency/)

Các bài kiểm thử độc lập nằm ở nhánh agent kiểm thử. Thành công với HTTP giả lập không thay thế chạy Sandbox thật sau khi có credentials và hook đầy đủ.
