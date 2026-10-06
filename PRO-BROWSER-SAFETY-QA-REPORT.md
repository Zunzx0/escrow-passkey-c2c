# Báo cáo QA an toàn trình duyệt (pro_browser_safety_qa)

## Giai đoạn 1: B5 (cấu hình nạp tiền công khai)

Phạm vi: Chrome thật (154.0.8037.98, playwright-core 1.63.0) chạy nguyên `public/js/app.js` với API FIXTURE. Không phải bằng chứng Sandbox, cookie, backend hay Windows Hello thật.

Tệp: `cho-an-tam/test/browser/paypal/config.browser.js` (id `B5`).

### Ca và assert (22 ca)
Cấu hình lỗi hoặc sai dạng, mỗi ca đóng cả hai cổng (14 ca phản hồi + 1 ca treo):
- 404, 500, `{}`, mảng, `null`, chuỗi JSON, HTML 200, JSON hỏng cú pháp.
- Thiếu `mockPayments`, thiếu `paypalSandbox`, `paypalSandbox.enabled="true"` (chuỗi), `mockPayments.enabled=1` (số), `mockPayments` là chuỗi, `paypalSandbox` là mảng.
- Treo (timeout 400 ms): fixture không trả lời GET config (`responded===0`).

Assert chung cho mỗi ca đóng:
- Không có `#topupAmount`, `topup-create`, `topup-preset`.
- Hiện "Nạp tiền chưa sẵn sàng".
- Không thẻ mô phỏng, không `.tag-info` (không fallback).
- `count()` của `POST /api/payments/paypal/topup`, `POST /api/payments/topup` và `/mock-provider/*` đều bằng 0.
- `s.navs` rỗng, `s.leaked()===0`.
- Riêng các ca lỗi có nút `paypal-config-retry`.

Ca phục hồi: config 500, rồi bấm "Tải lại cấu hình" với config hợp lệ, thì mở PayPal Sandbox. Trước và sau đó không có POST topup.

Config hợp lệ:
- paypal=true, mock=false, sandbox: PayPal Sandbox, nút "Tạo yêu cầu nạp PayPal", không thẻ mô phỏng.
- paypal=false, mock=true: cổng mô phỏng, không `.tag-info`, không "Tạo yêu cầu nạp PayPal", không nút `paypal-approve`.
- Cả hai tắt: "Hiện chưa có cổng nạp tiền nào được bật" (không có nút tải lại), đóng cả hai.
- paypal=true mode=live, mock=false: đóng cả hai.
- paypal=true mode=live, mock=true: chỉ cổng mô phỏng, không PayPal.
- Cả hai bật: PayPal được ưu tiên, không hiện hai cổng.

Điều kiện dựng (`c.precondition`): GET config thực sự tới fixture (`count>=1`), và với ca có phản hồi thì `responded>=1` trước khi assert. Ngoài ra chờ `waitForFunction` tới khi card "Nạp tiền vào ví" vẽ xong (có ô nhập hoặc thông báo chưa sẵn sàng). Không dùng sleep; dùng `s.until`, `waitForFunction`, `waitForSelector`. Mỗi ca có `c.cleanup(() => s.close())`.

### Lệnh tái lập
```
$env:NODE_PATH='C:\Users\tranq\tools\pw-runner\node_modules'; Set-Location '...\paypal-browser-acceptance\cho-an-tam'; node test/browser/paypal-wallet-browser.js --only=B5
```

### Kết quả (log thật, chạy 2 lần)
`Kết quả trình duyệt (fixture, 14.0s): PASS 239 · FAIL 0 · SKIP 0`, exit code 0 (lần đầu 11.4s, cùng kết quả).

### Request ngoài
`s.leaked()===0` ở mọi ca (đã assert). Không có điều hướng sang PayPal. Không gọi mạng ngoài.

### Lỗi sản phẩm nghi ngờ
Chưa phát hiện. Hành vi khớp `readPayConfig`/`loadPayConfig`/`walletTopupCard` (app.js ~2975-3012). Quan sát phụ: thẻ mô phỏng có câu "Hệ thống chưa nối PayPal…", nên "không nhãn PayPal" được kiểm bằng `.tag-info`, "PayPal Sandbox" và "Tạo yêu cầu nạp PayPal" chứ không bằng từ "PayPal" trần.

### Giới hạn
- Chỉ chứng minh hành vi UI với fixture; không chứng minh backend thật trả đúng shape config.
- Ca treo chỉ chạy trong timeout 400 ms do harness đặt `ENCLAVE_API_TIMEOUT_MS`.
- Chưa kiểm mutation (cố tình làm app sai để xem test đỏ).
- `git status`: ở worktree chỉ có tệp mới `config.browser.js` (của tôi) và `session.browser.js` (agent khác). `git diff` của `public/` và `src/` rỗng tại thời điểm kiểm.

## Giai đoạn 2: review độc lập B1B2, B3B4 (chỉ đọc) và mutation

Lần chạy đầy đủ cả ba spec trên bản gốc: `PASS 452 · FAIL 0 · SKIP 0`, exit 0 (34.3s). 54 dòng assert "Không request ngoài lọt ra" đều ✅, 0 ❌.

### Mutation (bản sao ngoài worktree, chạy runner từ thư mục scratchpad; worktree không bị đụng)
| # | Mutation trên app.js (bản sao) | Kết quả | Assert/ca đỏ | Ghi chú |
|---|---|---|---|---|
| M0 | không đổi (đối chứng) | 452/0 xanh | không | |
| M1 | `validApprovalUrl` bỏ kiểm origin/scheme/userinfo/port | ĐỎ, 11 ca B1.2 | http, hậu tố, tiền tố, thiếu www, subdomain, LIVE, user:pass, `@evil`, :8443, javascript:, data: | 5 URL còn lại (khoảng trắng, `\`, rỗng, null, số) vẫn bị chặn bởi kiểm tra khác chưa gỡ nên xanh đúng. Đỏ qua ngoại lệ (đã điều hướng làm mất context hoặc quá hạn chờ toast), không qua `c.ok(s.navs.length===0)` |
| M2 | capture tự chạy khi return khớp ý định | ĐỎ, 9 ca | B2.1, B2.6x2, B2.7, B2.5 (precondition "chưa có POST capture"), B4.1 đến B4.4 | Phần lớn đỏ do nút xác nhận biến mất (timeout waitForSelector); B2.5 đỏ đúng bằng điều kiện dựng. Assert "Return KHÔNG tự capture" ở B2.1 không kịp chạy |
| M3 | bỏ `state.busy.has(key)` ở `guard` | XANH (đáng lẽ đỏ) | không | Nút bị `btn.disabled=true` ngay trong guard nên lần `click()` thứ hai vô hiệu; guard busy không được kiểm riêng |
| M3b | bỏ cả busy check lẫn `btn.disabled` | ĐỎ, B2.5 | `until(responded(POST_CAPTURE)===1)` quá hạn (có 2 POST) | Đỏ bằng timeout chứ không bằng `c.ok(count===1)` |
| M4 | POST 200 coi là thành công, toast ngay, không GET | ĐỎ, 5 ca | B2.5, B2.6x2, B2.7 (quá hạn chờ GET sau capture), B4.2 (assert "thành công dựa trên GET SUCCEEDED token mới") | B4.1 vẫn XANH dù đáng lẽ đỏ (xem F2) |
| M5 | config lỗi/sai dạng fallback sang mock | ĐỎ, 76 assert ở 15 ca B5 | 5 assert mỗi ca (không ô nhập, không nút, "chưa sẵn sàng", không fallback, nút tải lại) | Ca phục hồi cũng đỏ 1 assert. Không B1B2/B3B4 nào bị ảnh hưởng |
| M6 | bỏ dọn query (`replaceState`) | ĐỎ | B2.1 (4 assert), B2.2, B2.3, B2.4 (điều kiện dựng) | Bắt bằng assert đúng mục tiêu |
| M7 | cancel bị coi như return (hiện nút capture) | ĐỎ | B2.3 (điều kiện dựng "ở trạng thái cancel") | Chỉ bắt bằng precondition; assert "không nút capture" ở B2.3 không kịp chạy, B2.4 xanh |
| (Pro) | bỏ epoch phiên (B3B4) | ĐỎ 3 assert ở ca cùng tài khoản | | Pro tự chạy, tôi không lặp |

### Bảng finding (không sửa spec của người khác)
| ID | Mức | Spec/dòng | Vấn đề | Đề nghị |
|---|---|---|---|---|
| F1 | Trung bình | payment-flow B2.5 (dòng 172-196) | Mutation M3 xanh: assert "đúng MỘT POST capture" không kiểm chứng guard `busy`, vì `btn.disabled` che. Hai lớp bảo vệ chỉ được thử chung (M3b). Khi đỏ (M3b) lại đỏ do `until(responded===1)` timeout | Dispatch click bằng `dispatchEvent(new MouseEvent('click',{bubbles:true}))` lên phần tử gốc sau khi `btn.disabled` (hoặc gọi qua event delegation lên `#topupIntent`), và đổi assert thành so sánh tổng `fx.count` sau khi thả. Hoặc ghi rõ trong báo cáo là kiểm hành vi tổng hợp |
| F2 | Trung bình | session B4.1 dòng 119-122 | M4 (POST 200 coi là thành công, không GET) vẫn xanh ở B4.1 vì assert cuối là `successToasts.length===1 \|\| /đã vào ví/`, không kiểm có GET `STATUS` bằng token mới sau capture, trong khi tiêu đề ca nói "hiện thành công sau GET SUCCEEDED". `waitForFunction(...).catch(()=>{})` còn nuốt timeout | Thêm assert `reqs(s, STATUS).length` tăng sau capture và bearer của GET đó là token mới (như B4.2 đã làm); bỏ `.catch` hoặc assert kết quả của nó |
| F3 | Thấp-Trung bình | session B4.3/B4.4 dòng 157 | `/đăng nhập lại/i.test(toasts) \|\| await s.has('[data-act="open-auth"]')`: vế sau đã được đảm bảo bởi `waitForSelector` ở dòng 151, nên assert luôn đúng; thông điệp "đăng nhập lại" không thật sự được kiểm. Báo cáo B3B4 mô tả như đã kiểm toast | Chỉ assert toast hoặc vùng thông báo chứa "đăng nhập lại", bỏ vế `\|\|` |
| F4 | Thấp | payment-flow B1.2 dòng 85 | Regex `/không hợp lệ/` cũng khớp toast "Máy chủ trả về dữ liệu không hợp lệ nên chưa mở PayPal" (dòng 3277 app.js, dữ liệu dòng sai). Nếu fixture row hỏng vì lý do khác, ca vẫn qua dù không thử URL. Hiện fixture row hợp lệ (B1.1 dùng cùng row) nên chưa đạt giả | Dùng `/địa chỉ phê duyệt không hợp lệ/` |
| F5 | Thấp | payment-flow B1.2 | Đỏ ở M1 chủ yếu do ngoại lệ (`Execution context was destroyed`, timeout) chứ không do assert phủ định `navs/external` (chưa kịp chạy). Vẫn đỏ đúng ca, nhưng thông điệp lỗi khó đọc | Chấp nhận được; tuỳ chọn chờ `navs.length===0` bằng quan sát có hạn sau khi toast hiện (đã có toast thì app không điều hướng sau đó) |
| F6 | Thấp | session B3 `settle` (dòng 21-23) | 5x40 ms quan sát phủ định có hạn (đã ghi nhận trong báo cáo). Pro đã chứng minh đỏ bằng mutation epoch | Không cần làm thêm; giữ nguyên ghi chú giới hạn |
| F7 | Thấp | payment-flow B2.1/B2.3, B4 | Vài assert phủ định đọc ngay sau `waitForSelector` (không toast thành công, không POST) là quan sát ngắn; được bù bởi precondition GET đã trả lời. M2/M7 đỏ bằng precondition/timeout chứ không phải assert phủ định | Chấp nhận |
| F8 | Thông tin | PRO-BROWSER-PAYMENT-FLOW-REPORT.md dòng 20 | Ghi "1+16+7=24 ca" nhưng thực tế B1.1 (1) + B1.2 (16) + B2.1-B2.5 (5) + B2.6 (2) + B2.7 (1) = 25 ca. (số PASS 156 chưa đối chiếu độc lập) | Sửa số trong báo cáo |
| F9 | Thông tin | PRO-BROWSER-PAYMENT-FLOW-REPORT.md dòng 52 | Báo cáo nói "không kiểm tra mutation", nay đã có kết quả M1-M7 ở trên | Cập nhật |
| F10 | Thông tin | PRO-BROWSER-SESSION-REPORT.md | Khoảng "Chưa mutation-test B3" nay đã được Pro chạy (epoch) | Cập nhật |

Không phát hiện đạt giả kiểu "request chưa gửi" ở các ca chính: các ca đều có `c.precondition` chứng minh request đã tới và đã được trả lời trước assert phủ định (B2.5 còn kiểm POST đang treo; B3 kiểm response cũ đã giao). Không tìm thấy lỗi sản phẩm thật qua mutation: mọi hành vi lệch đều làm test đỏ, riêng M3 là đa lớp bảo vệ.

### Kiểm tra an toàn
- Request ngoài lọt ra: 54/54 assert `s.leaked()===0` đạt trong lần chạy đầy đủ.
- `git diff -- cho-an-tam/public cho-an-tam/src`: rỗng. `git status`: chỉ tệp chưa theo dõi (3 spec, 3 báo cáo PRO-BROWSER-*, thư mục `evidence/`).
- Token/secret: quét 4 báo cáo (3 PRO-BROWSER + PAYPAL-SESSION-TEST-BARRIER-REPORT) theo mẫu secret/Bearer/client_secret/password: 0 kết quả. Hai ảnh `evidence/*.png` đã mở xem: trang ví giả, số dư 5.000.000đ, số tiền 100000, nhãn PayPal Sandbox; không có thanh địa chỉ, không có token/PayerID. Các giá trị `TOKEN-RET-123` ... chỉ nằm trong mã spec fixture.
- Tiến trình: không còn Chrome của runner (không có tiến trình `--host-resolver-rules`); các Chrome/node còn lại có thời điểm khởi động từ trước (của người dùng/agent khác), tôi không động tới. Thư mục khoá `%TEMP%\enclave-paypal-browser.lock` không còn.
- Mutation chạy trên bản sao trong scratchpad; worktree chỉ có tệp của tôi được thêm.

### Phân loại bằng chứng
| Nhóm | Phân loại | Còn cần gì |
|---|---|---|
| B1 mở PayPal, kiểm approval URL (16 URL giả) | Browser+fixture đã chạy (điều hướng thật của Chrome, trang PayPal là stub của harness) | PayPal Sandbox thật, redirect/return thật |
| B2 return/cancel/dọn query/capture sau bấm | Browser+fixture đã chạy | Return thật từ PayPal Sandbox; backend capture thật |
| B2.5 bấm đúp | Browser+fixture, nhưng chưa tách riêng guard busy khỏi `disabled` (F1) | |
| B2.6/B2.7 kết quả sau capture | Browser+fixture (GET do fixture dựng); không phải thanh toán thật | Webhook/đối soát backend thật |
| B3 phản hồi muộn của phiên cũ | Browser+fixture đã chạy (Pro chứng minh đỏ bằng mutation epoch) | Cookie/refresh thật qua backend HTTPS |
| B4 refresh 401 | Browser+fixture, refresh là route giả; F2/F3 làm yếu một số assert | Cookie Secure/HttpOnly/SameSite thật; refresh thật |
| B5 cấu hình nạp tiền | Browser+fixture đã chạy | Backend thật trả đúng shape config |
| Windows Hello/passkey | Chưa kiểm ở đây | Thiết bị/passkey thật |
Không nhóm nào được gán nhãn thanh toán thật.

### Giới hạn giai đoạn 2
Mutation mỗi loại chỉ thử một dạng. Chưa thử mutation cho refresh-lệch-user, refresh song song, capture lỗi 5xx/429/409 (spec chưa phủ). Số ca/assert trong báo cáo của hai agent kia chưa đối chiếu từng dòng ngoài kết quả log.
