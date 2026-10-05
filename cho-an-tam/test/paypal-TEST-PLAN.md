# PayPal Sandbox: kế hoạch kiểm thử độc lập

## Phạm vi và cách chạy

Nhánh `codex/paypal-sandbox-tests`, nền `843223b`. Bộ kiểm thử mới chỉ dùng fake HTTP transport và fixture; không truy cập PayPal, Supabase, Railway, dữ liệu production hay dữ liệu thí nghiệm.

Sau khi ghép nhánh triển khai:

```powershell
node --test cho-an-tam/test/paypal-sandbox-adapter.test.js cho-an-tam/test/paypal-sandbox-service.test.js
```

Trong quá trình hai agent làm song song, có thể trỏ tới module của checkout triển khai để đọc và chạy, không sửa checkout đó:

```powershell
$env:PAYPAL_PROVIDER_MODULE = 'C:\Users\tranq\Downloads\đồ án\escrow-passkey-c2c\backend\paypal-integration-work\cho-an-tam\src\lib\paypalSandboxProvider.js'
$env:PAYPAL_SERVICE_MODULE = 'C:\Users\tranq\Downloads\đồ án\escrow-passkey-c2c\backend\paypal-integration-work\cho-an-tam\src\lib\paypalSandboxService.js'
node --test cho-an-tam/test/paypal-sandbox-adapter.test.js cho-an-tam/test/paypal-sandbox-service.test.js
Remove-Item Env:PAYPAL_PROVIDER_MODULE
Remove-Item Env:PAYPAL_SERVICE_MODULE
```

## Các hàng rào phải kiểm tra

1. Tiền VND là số nguyên an toàn; không chấp nhận chuỗi, boolean, số lẻ, số ngoài giới hạn. Quote USD dùng số cent nguyên và làm tròn lên theo chính sách demo, vẫn giữ nguyên số VND cộng vào sổ cái.
2. Chỉ capture `COMPLETED` được ánh xạ thành `SUCCEEDED`; phê duyệt đơn hàng, redirect thành công hoặc capture `PENDING` chưa đủ điều kiện cộng ví.
3. Order ID, local payment request, merchant, currency và số tiền phải khớp dữ liệu máy chủ. Không nhận nhiều purchase unit/capture để bỏ sót kiểm tra một phần số tiền.
4. Tắt provider hoặc thiếu cấu hình phải từ chối trước kết nối. Endpoint cố định Sandbox; cấu hình host live bị từ chối.
5. Create và capture gửi idempotency key ổn định. Khi mất phản hồi sau capture, retry không tạo khóa mới.
6. Webhook chỉ được tin sau khi PayPal trả `verification_status=SUCCESS` cho đúng webhook ID cấu hình. Endpoint verify cố định; không tự tải certificate URL do người gửi chọn.
7. Lỗi provider không lộ Secret, access token, thông tin người thanh toán hoặc raw body nhạy cảm.
8. Lớp service phải kiểm user sở hữu yêu cầu, quote đã lưu và provider order trước mọi capture/settlement. Sáu request đồng thời hoặc webhook lặp vẫn chỉ cộng đúng một lần.
9. Thời điểm thử tạo order đầu tiên phải được lưu bền vững và không làm mới khi retry. Order chưa được gắn sau cửa sổ 5 phút cần phục hồi có kiểm soát; không tự tạo mới sau khi PayPal có thể đã quên idempotency key. Order đã gắn chỉ được đọc lại, kể cả thời điểm thử cũ đã hết hạn.

## Kết quả đã chạy

Ngày 05/10/2026: 27/27 kịch bản `node:test` đạt khi đọc trực tiếp hai module checkout triển khai. Có 14 kịch bản adapter và 13 kịch bản service. Không có request mạng hay kết nối DB trong lần chạy này. Một lần chạy ban đầu dùng fixture OAuth thiếu `token_type=Bearer` bị từ chối; fixture đã được sửa rồi chạy lại sạch.

Đã khóa thêm: yêu cầu local FAILED không thể create/capture; yêu cầu SUCCEEDED chỉ dùng GET và sink duplicate, không tạo giao dịch PayPal mới; trạng thái local được kiểm lại sau atomic create claim.

Service concurrency sử dụng sink nguyên tử giả lập trong bộ test; đây là bằng chứng service gọi cùng một điểm tất toán với binding đúng, không phải bằng chứng giao dịch SQL production. Không thể suy ra chống cộng ví hai lần chỉ từ `PayPal-Request-Id`.

## Giới hạn của bằng chứng

Fake transport kiểm tra hợp đồng và hành vi adapter, không chứng minh PayPal Sandbox đang chấp nhận yêu cầu thật. Injected service store kiểm tra phối hợp nghiệp vụ, không thay thế kiểm thử SQL concurrency.

Các bước sau vẫn bắt buộc trước triển khai:

- Ghép route/persistence/reconciler thực tế rồi kiểm thử ví, ledger và 9 bất biến trên SQLite lẫn PostgreSQL bằng DB test riêng.
- Cổng mock không được phép tất toán yêu cầu PayPal bằng callback mock. Điểm cộng ví phải kiểm tra loại provider và binding đã lưu, chứ không chỉ `provider_ref`; quote, merchant, order và capture phải được xác minh trước khi gọi điểm đó.
- Chạy Sandbox thật với tài khoản Business/Personal thử nghiệm, Client ID, Secret và Webhook ID riêng. Không đưa Secret vào Git hay frontend.
- Tạo order, approve, capture và đối soát sau mất mạng; kiểm tra order/capture trên PayPal dashboard khớp một bút toán nạp trong Enclave.
- Replay webhook hợp lệ, gửi webhook giả và thử sai tài khoản, sai order, sai số tiền; ví không được thay đổi với yêu cầu sai.
- Kiểm tra tài khoản admin không có ví và không thể dùng quyền tranh chấp để nạp tiền.

## Nguồn chính thức

- Orders v2: https://developer.paypal.com/api/orders/v2
- Idempotency: https://developer.paypal.com/api/rest/reference/idempotency/
- Webhook verification: https://developer.paypal.com/api/rest/webhooks/rest/

PayPal webhook simulator không hỗ trợ phương thức postback verification; kiểm thử webhook thật của ứng dụng Sandbox là bước riêng.
