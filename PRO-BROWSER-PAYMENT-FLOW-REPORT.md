# Báo cáo B1–B2: luồng thanh toán PayPal Sandbox trong Chrome thật (API fixture)

Tệp spec: `cho-an-tam/test/browser/paypal/payment-flow.browser.js` (id `B1B2`).
Phạm vi: Chrome 154 thật (playwright-core 1.63.0) chạy nguyên `public/js/app.js`; API là fixture cục bộ. Không dùng `ENCLAVE_NAVIGATE` (ca B1.1 tự assert `typeof window.ENCLAVE_NAVIGATE === 'undefined'`).

## Lệnh tái lập

```powershell
$env:NODE_PATH='C:\Users\tranq\tools\pw-runner\node_modules'; Set-Location 'C:\Users\tranq\Downloads\đồ án\claude-wt\paypal-browser-acceptance\cho-an-tam'; node test/browser/paypal-wallet-browser.js --only=B1B2
```

## Kết quả thật

Exit code 0. Dòng cuối của log:

```
Kết quả trình duyệt (fixture, 16.7s): PASS 158 · FAIL 0 · SKIP 0
```

(Chạy lại sau sửa F1/F4. Tính cả các dòng "điều kiện dựng"; 25 ca = B1.1 + 16 B1.2 + B2.1..B2.4 + B2.5 + 2 B2.6 + B2.7, đếm từ log; không có ❌ nào.)

## Danh sách ca và assert

Mọi ca: `c.cleanup(() => s.close())`, `c.precondition` trước assert hành vi, cuối ca `s.leaked().length === 0`. Không sleep; chỉ `s.until`, `waitForSelector`, `waitForURL`, đếm `fx.count/responded`.

- **B1.1 Mở PayPal thật**: ý định lưu localStorage, bấm `topup-check` rồi `paypal-approve`. Precondition: không có hook ENCLAVE_NAVIGATE, chưa có GET checkout/điều hướng trước khi bấm. Assert: đúng 1 GET checkout; `s.navs` = 1 phần tử `https://www.sandbox.paypal.com/checkoutnow?token=ORDER1`; tab thật sự đổi sang host Sandbox; `s.external` chỉ có điều hướng chính tới host đó (bị thay bằng trang giả); không POST capture.
- **B1.2 x16 URL giả**: http, hậu tố, tiền tố, thiếu www, subdomain khác, PayPal live, userinfo `user:pass`, `https://www.sandbox.paypal.com@evil.example/...`, cổng :8443, `javascript:`, `data:`, khoảng trắng, gạch chéo ngược, chuỗi rỗng, null, số. Precondition: GET checkout đã được fixture trả lời. Assert: toast đặc thù "địa chỉ phê duyệt không hợp lệ" xuất hiện (không khớp các toast khác); `s.navs` rỗng; `page.url()` không đổi; `s.external` rỗng (không request/điều hướng ngoài); nút mở lại còn đó.
- **B2.1 Return**: `?paypal=return&paymentRequestId=ID&token=...&PayerID=...`. Precondition: GET `/payments/:id` đã trả lời, nút `paypal-capture` có mặt. Assert: URL sau xử lý chỉ còn `/#/wallet` (không token/PayerID); không POST capture, không toast thành công, không tạo yêu cầu mới. Reload: không có GET `/payments/:id` mới, không còn nút capture, URL vẫn sạch.
- **B2.2 Query không phải chứng cứ**: return mà không có ý định trên thiết bị: không có nút capture, không POST, không toast thành công, query vẫn dọn.
- **B2.3 Cancel**: query dọn sạch; không POST capture, không nút capture, không toast thành công; không bị diễn giải FAILED/đóng; ý định (paymentId, requestId, amount) còn trong localStorage; nút "Mở lại PayPal Sandbox" mở lại đúng approval URL.
- **B2.4 Cancel rồi reload**: không xử lý lại, ý định còn, không capture.
- **B2.5 Bấm đúp**: POST capture bị treo bằng `h.deferred()`; precondition: POST đã tới fixture và chưa được trả lời; click đồng bộ hai lần; rồi kiểm RIÊNG guard busy: lúc POST đang treo, nút vẫn còn trong DOM và đang disabled (c.ok), gỡ thuộc tính disabled rồi click lại thật, assert vẫn 1 POST; sau khi thả, GET sau capture đã chạy: `fx.count(POST capture) === 1`, hiện "Đang xác nhận", chưa báo thành công.
- **B2.6 x2**: POST capture 200 nhưng GET trả RECONCILING, và PENDING/AWAITING_APPROVAL: không toast/chữ "Nạp tiền thành công", ý định giữ, không POST lần hai.
- **B2.7**: POST capture 200 và GET SUCCEEDED khớp ý định: đúng 1 toast "Nạp tiền thành công", ý định bị dọn, `GET /api/wallets/me` được đọc lại, đúng 1 POST capture.

## Mutation độc lập do QA chạy trên bản sao (không phải tôi chạy)

- M1 bỏ kiểm origin/scheme/userinfo/port của `validApprovalUrl`: bắt 11 ca B1.2 (bằng assert thật).
- M2 capture tự chạy khi return: bắt 9 ca.
- M3 bỏ guard busy: vẫn xanh vì nút disabled che; đã sửa theo F1 (gỡ disabled rồi click lại, assert 1 POST).
- M3b bỏ cả busy lẫn disabled: bắt B2.5, nhưng QA ghi nhận chỉ qua timeout/ngoại lệ ở bản trước F1.
- M6 bỏ `replaceState`: bắt B2.1–B2.4.
- M7 cancel coi như return: chỉ bắt bằng precondition (trạng thái cancel không đạt), không bằng assert hành vi.
Chỗ chỉ bắt qua timeout/ngoại lệ/precondition (M3b, M7) là bắt gián tiếp, cần nhìn nhận đúng mức. Sau F1, Pro chạy lại M3 (bỏ `if (state.busy.has(key)) return;`): B2.5 đỏ nhưng ban đầu chỉ qua ngoại lệ timeout vì chờ `responded === 1`; đã đổi chờ thành `>= 1` để chỗ báo đỏ là `c.ok(fx.count(POST_CAPTURE) === 1)` sau khi thả POST. Tôi chưa chạy lại mutation sau sửa này.

## Request ngoài lọt ra

Không có: `s.leaked()` rỗng ở mọi ca. Ở 16 ca URL giả, `s.external` rỗng. Ở B1.1 và B2.3 (mở lại) chỉ có điều hướng chính tới `www.sandbox.paypal.com`, bị chặn và thay bằng trang giả của harness.

## Ảnh (2, không chứa token; chụp trang, không có thanh địa chỉ)

- `cho-an-tam/test/browser/paypal/evidence/B2-return-cho-xac-nhan.png`
- `cho-an-tam/test/browser/paypal/evidence/B2-cancel-giu-y-dinh.png`

## Lỗi sản phẩm nghi ngờ

Không phát hiện trong phạm vi các ca này; không sửa `app.js`.

## Ca chưa chạy / chưa làm

- Không có ca SKIP. Chưa làm: capture lỗi (timeout/5xx/429/409) trên trình duyệt thật (đã có trong bộ jsdom, ngoài phạm vi giao); GET sau capture sai id/số tiền/requestId; return khi webhook đã tất toán.
- Mutation do tôi tự chạy: không; xem mục mutation của QA ở trên. Các precondition chặn trường hợp "đạt vì chưa gửi request".

## Giới hạn

Fixture cục bộ: không chứng minh PayPal Sandbox thật, redirect/return thật từ PayPal, cookie/Set-Cookie thật, backend thật hay Windows Hello/Passkey. Trang PayPal là trang giả của harness. Số ca không cộng vào 212 UI / 47 recovery / backend suite.

## Ghi chú

Sau khi chạy, tiến trình của tôi đã thoát. Thư mục khoá `enclave-paypal-browser.lock` trong TEMP đang tồn tại tại thời điểm kiểm tra, không phải của tôi (runner của tôi đã thoát và tự dọn); có thể agent khác đang chạy.



