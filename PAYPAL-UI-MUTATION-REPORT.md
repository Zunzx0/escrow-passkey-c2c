# Báo cáo mutation kiểm chứng UI PayPal Sandbox

Ngày 06/10/2026. Đây là kiểm chứng bộ test UI (jsdom), không phải bằng chứng thanh toán PayPal/Passkey/cookie ngoài đời.

- Nền: `6d5abd644113a4f5a6c4449da931cf7aba6c7748` (codex/payment-provider-isolation). Nhánh làm việc: `claude/paypal-ui-mutation-review-v2`.
- Lý do đổi tên nhánh: `claude/paypal-ui-mutation-review` và worktree `mutation-review-wt` đã tồn tại sẵn, còn một thay đổi chưa commit trong test do phiên khác để lại. Không đụng vào, không dùng lại; làm trên worktree mới sạch từ đúng hash nền.
- Môi trường: Node v26.4.0, jsdom 30.1.2 (dùng chung `node_modules` của worktree cũ qua junction, chỉ đọc; không đổi manifest).
- Lệnh: `node test/ui/paypal-wallet-ui.js` (cwd `cho-an-tam`). Mỗi ca chạy tuần tự, một tiến trình.

## Baseline (code sạch, trước mutation)

206 kiểm tra, ALL PASS, 0 fail, 0 skip. Chạy mất khoảng 3–4 phút.

## Kết quả từng ca

Mỗi ca: ghi đè `public/js/app.js` bằng bản đột biến (một hàng rào, khớp chính xác 1 vị trí, nếu không khớp thì dừng), chạy test, khôi phục ngay bản sạch và so sánh từng byte. Cuối mỗi lượt `restored identical: true`.

| Ca | Hàng rào bỏ đi | Exit | Kết quả | Assertion bắt lỗi |
| --- | --- | --- | --- | --- |
| U1 | Dòng kiểm `protocol === 'https:'` và `origin === https://www.sandbox.paypal.com` trong `validApprovalUrl` | 1 | BẮT (198 pass / 8 fail) | 8 ca "URL phê duyệt giả (…): KHÔNG điều hướng, báo lỗi": http, hậu tố, tiền tố, thiếu www, subdomain khác, PayPal LIVE, `javascript:`, `data:` |
| U2a | Chỉ `state.sessionEpoch !== ctx.epoch` trong `ctxAlive` | 0 | SỐNG SÓT (lớp `api()` vẫn chặn) | không có |
| U2b | Chỉ ba kiểm `sessionEpoch !== epoch` trong `api()` (catch, sau fetch, sau refresh) | 0 | SỐNG SÓT (lớp `ctxAlive` vẫn chặn) | không có |
| U2c | Cả hai lớp: epoch trong `ctxAlive` cộng ba kiểm trong `api()` | 1 | BẮT (206 pass / 2 fail) bằng test mới | "Capture chậm + đăng xuất/đăng nhập lại CÙNG tài khoản: phản hồi của phiên cũ KHÔNG báo 'nạp thành công'" và "…phiên cũ không đọc trạng thái và không xoá ý định của phiên mới" |
| U3 | Sau POST capture, tin vào phản hồi POST (đọc thành dòng, báo kết quả) thay vì GET trong `refreshPaypalState` | 1 | BẮT (198 pass / 8 fail) | 8 ca "Capture 200 nhưng GET …: 'chưa xác nhận' + nút kiểm tra lại": 503, treo, thân HTML, sai id, sai số tiền, sai requestId, provider MOCK, status SUCCEEDED nhưng stage khác |
| U4 | Nhánh lỗi của `loadPayConfig` đặt `mock: true` thay vì tắt | 1 | BẮT (202 pass / 4 fail) | "Config 404: tắt cả hai cổng, không tự chuyển sang mock"; cấu hình lỗi/sai dạng 500, mạng treo, 200 HTML |
| U5 | `processPaypalCallback` tự POST capture khi `cb.kind === 'cancel'` | 1 | BẮT (205 pass / 1 fail) | "Cancel: KHÔNG có nút capture, không gọi capture" |
| U6 | Bỏ điều kiện `intent.paymentId === row.id` trong `paypalMatchesIntent` | 1 | BẮT (205 pass / 1 fail) | "Return ý định khác id yêu cầu: KHÔNG cho capture, chỉ hiển thị trạng thái" |

Không có ca nào bị tính là bắt chỉ vì crash, thiếu module hay timeout: mọi ca bắt đều có dòng `❌` của một assertion đúng mục tiêu, và tiến trình thoát bình thường bằng exit 1 do `fails > 0`.

### U2: khoảng trống và test bổ sung

Trước khi thêm test, U2a, U2b và U2c đều pass 206/206, tức là mất cả hai lớp kiểm phiên mà test không biết. Nguyên nhân: các ca "đổi tài khoản" sẵn có chuyển sang tài khoản KHÁC nên `userId` đã chặn, epoch chưa bao giờ là hàng rào duy nhất. Test mới (`cho-an-tam/test/ui/paypal-wallet-ui.js`, 2 assertion) đăng xuất rồi đăng nhập lại CÙNG tài khoản trong lúc capture còn treo, lúc đó userId, token và ý định lưu đều khớp, chỉ epoch phân biệt được phiên cũ.

- Test mới trên code sạch: 208 kiểm tra, ALL PASS, exit 0.
- U2c (cả hai lớp): thất bại đúng 2 assertion mới.
- U2a và U2b riêng lẻ: vẫn sống sót, 208 pass. Đúng như dự kiến, mỗi lớp độc lập đủ để chặn phản hồi phiên cũ trong kịch bản này, nên không thể chứng minh từng lớp riêng bằng test cấp UI này. Kết luận: phòng vệ phiên là hai lớp chồng nhau; test chỉ chứng minh được rằng mất cả hai thì bị bắt.

## Hồi quy cuối

Sau khi khôi phục, `node test/ui/paypal-wallet-ui.js`: 208 kiểm tra, ALL PASS, exit 0. `git status` chỉ còn file test thay đổi. Chưa chạy `topup-request-id-ui.js`, `payment-error-clarity.js`, bộ session-refresh và `ui-flow-jsdom.js` vì không sửa helper dùng chung; chỉ thêm khối test vào file PayPal.

## Giới hạn và rủi ro

- Mutation chỉ là chuỗi thay thế văn bản trên `app.js`, từng ca một hàng rào (riêng U2 nhiều điểm đã liệt kê ở trên). Chưa phân tích tính tương đương hay mutation tự động hoá.
- U3 cài đặt thành "đọc dòng từ phản hồi POST rồi báo kết quả không qua GET"; đó là một cách cụ thể để UI tin POST, không phải mọi cách.
- U6: test hiện có đã bắt được ca return mang id khác khi các hàng rào còn lại (khớp requestId và amount) vẫn nguyên, nên `paymentId` là hàng rào được kiểm riêng.
- Thư mục tạm `%TEMP%\mut` đã có sẵn tệp `case1..6.txt` từ trước (không phải của lượt này); log lượt này là `U*.log`, không thêm vào repo.
- Chưa phát hiện lỗi UI sản phẩm cần Codex sửa.
