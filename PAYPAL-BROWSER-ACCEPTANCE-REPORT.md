# Báo cáo kiểm chứng trình duyệt thật: luồng nạp PayPal Sandbox (API fixture)

Ngày 07/10/2026. Đây là bằng chứng "Chrome thật chạy nguyên `app.js` sản phẩm với API fixture". Không phải bằng chứng Sandbox, cookie backend HTTPS hay Windows Hello thật.

- Remote: https://github.com/Zunzx0/escrow-passkey-c2c.git
- Nền sản phẩm: `a75aab857b8a39eab1543b9f167d694532352862` (codex/payment-provider-isolation, trùng đầu nhánh lúc fetch, không có chênh lệch).
- Nhánh Pro: `claude/paypal-browser-acceptance`. PR vào `codex/payment-provider-isolation`. Chưa merge, chưa deploy.
- Cách làm: Pro (cấp 2) dựng harness/runner chung, giao ba agent cấp 3, mỗi agent sở hữu một spec và một báo cáo; agent QA review chéo; Pro tự chạy mutation độc lập và chạy lượt runner cuối. Không có agent cấp 4.

## Môi trường và tái lập

- Chrome 154.0.8037.98 (cài sẵn trên máy, không tải trình duyệt), `playwright-core` 1.63.0 đặt ngoài repo tại `C:\Users\tranq\tools\pw-runner` (không sửa `package.json`/lockfile), Node v26.4.0, Windows 11.
- Lệnh (PowerShell, cwd `cho-an-tam`):

```
$env:NODE_PATH = 'C:\Users\tranq\tools\pw-runner\node_modules'
node test/browser/paypal-wallet-browser.js [--only=B1B2,B3B4,B5]
```

- Runner giữ khoá tệp `%TEMP%\enclave-paypal-browser.lock`: mỗi lần chỉ một Chrome. Thoát 0 khi không có FAIL, 1 khi có FAIL, 2 khi thiếu công cụ. Số ca ở đây KHÔNG cộng vào 212 UI / 47 recovery / backend suite.
- Harness: server fixture cục bộ (cổng rảnh, 127.0.0.1) phục vụ `public/` và giả lập `/api/*`. Mọi origin khác bị chặn bằng hai lớp: cờ Chrome `--host-resolver-rules` và `context.route`. Điều hướng chính sang `www.sandbox.paypal.com` được ghi lại (`s.navs`) rồi trả trang giả; không bao giờ chạm PayPal thật. `s.leaked()` đếm request ngoài lọt qua route (phải bằng 0).

## Kết quả lượt runner cuối (bản ghép, tuần tự, code sản phẩm sạch)

```
node test/browser/paypal-wallet-browser.js     (cwd cho-an-tam, không --only)
Kết quả trình duyệt (fixture, 33.7s): PASS 458 · FAIL 0 · SKIP 0      exit code 0
```

54 ca: B1B2 25 ca, B3B4 7 ca, B5 22 ca. "PASS" đếm cả các dòng "điều kiện dựng", nên lớn hơn số ca. Assert "Không request ngoài lọt ra": 54 đạt, 0 thất bại. Khoá tạm không còn sau khi chạy.

## B1–B5

| Nhóm | Spec | Nội dung chính |
| --- | --- | --- |
| B1 | `payment-flow.browser.js` | Bấm "Mở PayPal Sandbox" thật: một GET checkout, điều hướng thật tới đúng approval URL của fixture (không dùng `ENCLAVE_NAVIGATE`; ca tự assert hook không tồn tại). 16 URL giả (http, hậu tố, tiền tố, thiếu www, subdomain khác, PayPal live, userinfo, `@evil`, cổng lạ, `javascript:`, `data:`, khoảng trắng, `\`, rỗng, null, số): không rời trang, toast "địa chỉ phê duyệt không hợp lệ", không request/điều hướng ngoài. |
| B2 | `payment-flow.browser.js` | Return: dọn token/PayerID khỏi thanh địa chỉ, chỉ GET xác minh, không tự capture, reload không xử lý lại. Return không có ý định trên thiết bị: không có nút capture. Cancel: không capture, không toast thành công, giữ ý định, mở lại được PayPal; cancel rồi reload không xử lý lại. Bấm xác nhận kể cả bấm đúp và gỡ `disabled` rồi bấm lại khi POST đang treo: đúng 1 POST capture. POST 200 mà GET nói RECONCILING hoặc AWAITING_APPROVAL: không báo thành công. POST 200 + GET SUCCEEDED khớp ý định: đúng 1 toast, dọn ý định, đọc lại ví. |
| B3 | `session.browser.js` | Capture treo bằng `h.deferred()`: POST tới đúng 1 lần, phản hồi còn pending trước logout; logout rồi login lại (cùng tài khoản, và tài khoản khác) xong mới release phản hồi cũ, xác nhận phản hồi cũ đã được giao thật. Phản hồi cũ không toast thành công, không GET trạng thái thay cho phiên mới, không xoá ý định phiên mới. |
| B4 | `session.browser.js` | Access token bị từ chối lúc return (GET hoặc capture 401): refresh rồi retry đúng 1 lần bằng token mới, thành công chỉ tính sau GET SUCCEEDED nằm sau POST capture. Refresh thất bại (401/500): không retry, không thành công giả, có toast "Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại" và nút đăng nhập. GET 401 + refresh 401: không có nút capture. |
| B5 | `config.browser.js` | Config 404, 500, `{}`, mảng, `null`, chuỗi, HTML, JSON hỏng, thiếu trường, sai kiểu, treo (timeout): đóng cả hai cổng, không ô nhập, không fallback sang mock, 0 POST topup, 0 mock-provider, 0 điều hướng. Config hợp lệ mở đúng provider: PayPal-only, mock-only, cả hai tắt, `mode=live`, cả hai bật (ưu tiên PayPal); tải lại config sau lỗi mở đúng cổng. |

Mỗi ca có điều kiện dựng (`c.precondition`) chứng minh request đã phát/đã được trả lời trước khi assert hành vi; không dùng sleep để đoán request treo; dọn `finally`/`c.cleanup`. Ảnh: 2 ảnh trong `cho-an-tam/test/browser/paypal/evidence/` (`B2-return-cho-xac-nhan.png`, `B2-cancel-giu-y-dinh.png`), chụp nội dung trang, không có thanh địa chỉ, không có token.

## Request ngoài lọt ra

0. Chỉ có điều hướng chính tới `www.sandbox.paypal.com` ở B1.1 và lúc mở lại ở B2.3, đều bị thay bằng trang giả của harness.

## Bằng chứng mutation (bản sao ngoài worktree; `app.js` trong worktree không bị sửa)

`app.js` worktree: `sha256 08C70DCAC116138C500EB53471BB62C9470E629DEAEAE879AB96DDC67A6462FA`; `git diff` của `cho-an-tam/public`, `src`, `package.json`, lockfile, `scripts`: rỗng.

| Mutation (do ai chạy) | Kết quả |
| --- | --- |
| Bỏ cả hai lớp `sessionEpoch` (`api()` và `ctxAlive`) (Pro) | B3B4: 54 đạt / 3 FAIL, đều ở B3.1 cùng tài khoản: có toast thành công; có thêm 1 GET trạng thái (trước=1, sau đăng nhập=1, cuối=2); ý định phiên mới bị xoá. B3.2 (tài khoản khác) vẫn xanh vì lớp kiểm userId còn. |
| M1 bỏ kiểm origin/scheme/userinfo/port trong `validApprovalUrl` (QA) | 11 ca B1.2 đỏ. 5 URL còn lại (khoảng trắng, `\`, rỗng, null, số) xanh đúng vì kiểm tra khác chưa gỡ. Đỏ qua ngoại lệ/timeout, không qua assert `s.navs`. |
| M2 capture tự chạy khi return (QA) | 9 ca đỏ (B2.1, B2.5, B2.6 x2, B2.7, B4.1–B4.4); phần lớn vì nút xác nhận biến mất, B2.5 đỏ bằng điều kiện dựng. |
| M3 bỏ guard `state.busy` (QA lần đầu: xanh, bị `btn.disabled` che; sau F1, Pro chạy lại) | Sau F1: B2.5 đỏ bằng assert đúng mục tiêu "Đúng MỘT POST capture" (157 đạt / 1 FAIL). |
| M3b bỏ cả `busy` lẫn `disabled` (QA, trước F1) | B2.5 đỏ nhưng qua timeout; đã siết ở F1. |
| M4 tin POST 200 là thành công, không GET lại (QA lần đầu; Pro chạy lại sau F2) | Lần đầu bỏ sót B4.1. Sau F2 và siết B4.2: B4.1 và B4.2 đều đỏ (48 đạt / 2 FAIL), qua điều kiện chờ GET trạng thái MỚI sau capture (ngoại lệ chờ quá hạn, không phải assert đếm). |
| M5 config lỗi fallback sang mock (QA) | 76 assert đỏ ở 15 ca B5. |
| M6 bỏ `replaceState` dọn query (QA) | Bắt bằng assert đúng mục tiêu (B2.1, B2.2, B2.3, B2.4). |
| M7 cancel bị coi như return (QA) | Chỉ bắt bằng điều kiện dựng ở B2.3; assert "không nút capture" không kịp chạy. |

Mỗi loại mutation chỉ thử một dạng. Không mutation nào làm lộ lỗi sản phẩm thật.

## Finding QA đã xử lý

- F1 (B2.5, guard `busy` bị `disabled` che): đã sửa (gỡ `disabled` rồi click lại khi POST đang treo; đổi điều kiện chờ sang `>= 1` để lỗi hiện bằng assert). Xác nhận bằng M3 ở trên.
- F2 (B4.1 assert cuối yếu, nuốt timeout): đã sửa; xác nhận bằng M4. F3 (B4.3/B4.4 assert luôn đúng): đã tách thành assert nút đăng nhập và assert toast đúng chuỗi.
- F4 (B1.2 regex quá rộng): đã đổi sang `/địa chỉ phê duyệt không hợp lệ/`.
- Cũng đã siết B4.2 theo yêu cầu của Pro sau khi M4 còn bỏ sót.
- F8–F10 (số ca, câu về mutation trong báo cáo con): đã cập nhật.
- Còn mở, chấp nhận có chủ ý: F5 (M1 đỏ qua ngoại lệ, thông báo khó đọc) và F6/F7 (xem "Giới hạn B3").

## Giới hạn B3: quan sát có hạn

Các assert phủ định của B3 ("không toast thành công", "không GET trạng thái thay cho phiên mới", "ý định không bị xoá") được đánh giá sau khi phản hồi cũ đã được giao thật, với thời gian quan sát có hạn: nhường 5 lần × 40 ms (khoảng 200 ms) rồi mới assert. Vì vậy không phải bằng chứng tuyệt đối rằng không bao giờ có tác dụng muộn. Độ tin cậy dựa trên hai điều: (1) điều kiện dựng chứng minh POST capture đã tới đúng 1 lần, phản hồi còn pending lúc đăng xuất, phiên mới đã hiệu lực rồi mới release, và phản hồi cũ đã được giao thật (assert không đạt giả); (2) mutation bỏ lớp epoch làm đúng 3 assert của B3.1 đỏ (bảng trên). Các assert phủ định đọc ngay sau `waitForSelector` ở B2.1/B2.3/B4 cũng cùng tính chất quan sát có hạn (F7).

## Phân loại bằng chứng

- Đã chạy bằng Chrome thật + fixture (điều hướng của Chrome là thật, trang PayPal là trang giả của harness, API là fixture): toàn bộ B1–B5 ở trên.
- Chưa chứng minh, còn cần môi trường thật: Sandbox thật (redirect/return thật từ PayPal, tài khoản Sandbox); backend (capture, webhook, đối soát, shape config thật); cookie Secure/HttpOnly/SameSite và refresh qua backend HTTPS thật (cookie fixture chỉ chứng minh logic UI); Windows Hello/passkey thật.
- Không gán nhãn thanh toán thật cho fake API.

## Chưa làm (theo phạm vi giao, chưa phát hiện lỗi mới nên không mở thêm)

Refresh trả user khác userId, refresh song song, nhánh checkout lỗi, capture timeout/5xx/429/409 trên Chrome thật (đã có trong bộ jsdom). Chạy lại sau khi có Sandbox/backend thật là bước kế tiếp.

## Tiến trình đã dọn

Runner thoát sạch, không còn tiến trình Chrome của runner, khoá `%TEMP%\enclave-paypal-browser.lock` không tồn tại sau lượt cuối, thư mục mutation tạm nằm ngoài worktree. Chrome và node khởi động từ trước (của người dùng) không bị đụng.

## Phạm vi commit

Chỉ `cho-an-tam/test/browser/**` (runner, harness, 3 spec, 2 ảnh) và bốn báo cáo: `PAYPAL-BROWSER-ACCEPTANCE-REPORT.md`, `PRO-BROWSER-PAYMENT-FLOW-REPORT.md`, `PRO-BROWSER-SESSION-REPORT.md`, `PRO-BROWSER-SAFETY-QA-REPORT.md`. Không có dependency, bí mật, DB hay bản đột biến.
