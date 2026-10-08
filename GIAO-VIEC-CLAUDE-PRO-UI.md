# Giao việc Claude Pro — requestId, trạng thái nạp tiền và giao diện PayPal

Ngày: 05/10/2026. Vai trò: giao diện và kiểm thử luồng người dùng. Codex tích hợp API/DB, Max xử lý capture và kiểm thử tài chính. Làm song song được vì bạn chỉ sửa public/test UI.

## 1. Nền và quy trình bắt buộc

Repo C:\Users\tranq\Downloads\đồ án\escrow-passkey-c2c; kiểm git remote đúng escrow-passkey-c2c. Fetch và tạo worktree/nhánh mới claude/topup-ui-request-id từ origin/codex/combined-review @70b72ce. Không tiếp tục sửa trên nền843223b hoặc nhánh C2 cũ.

Nếu nền đã đổi, báo hash/diff thay đổi trước; không tự ghép nhánh Max. Nếu worktree đang có thay đổi chưa commit, giữ nguyên và làm ở worktree khác. Không reset/stash/xóa công việc người khác, force push, sửa main/migrate-postgres/codex/combined-review, gộp hoặc deploy.

C2@99704a5 và PR18 đã có trong nền. Codex bổ sung HTTP200 HTML/null/array không được coi là thành công; UI test60 đạt. Harness PR18 dùng AbortController Node để giữ timeout;23 đạt. Giữ các sửa này, không thay bằng bỏ signal.

PR cuối hướng migrate-postgres sau khi Codex cập nhật nền chung. Bạn có thể push nhánh riêng; chưa tự bật PayPal.

## 2. P1 — requestId và trạng thái mock, bắt đầu ngay

Sở hữu public/js/app.js, public/styles.css nếu cần (xác minh tên file thật trước), và test/ui/topup-request-id-ui.js mới. Không sửa backend, db/schema/migration, package.json/run-suite.js, test PayPal của Max/Codex. Không đổi brand Enclave.

### Hợp đồng API hiện đã có, không cần chờ Max

POST /api/payments/topup body {amount:number, requestId:string}; requestId 8–100 ký tự chữ/số/._:-, nên dùng UUID sinh một lần cho một ý định nạp. Server phản hồi id, amount, status(PENDING/SUCCEEDED/FAILED), providerRef, requestId, submissionStatus(SUBMITTING/SUBMITTED/SUBMIT_FAILED); replay có idempotentReplay=true. Cùng user/key nhưng khác amount:409 IDEMPOTENCY_KEY_REUSED. GET /api/payments/:id kiểm trạng thái thật. Đọc source trên nền để xác minh chính xác các trường/đường dẫn trước code.

### Hành vi cần làm

1. Sinh requestId một lần cho ý định nạp; double click và retry sau timeout/mất kết nối/503 giữ cùng key và amount. Không sinh key mới mỗi lần retry.
2. Lưu tạm key+amount gắn user, đủ để reload rồi phục hồi ý định chưa rõ. Không lưu token/secrets mới. Không đưa key của user cũ vào request user mới; logout/dổi tài khoản tách dữ liệu.
3. Khi kết quả chưa rõ, không cho sửa amount rồi gửi lại cùng key. Cho kiểm tra trạng thái hoặc chủ động tạo ý định mới với cảnh báo rõ, không tự tạo yêu cầu mới âm thầm.
4. SUBMITTING: đang gửi, không báo lỗi/thành công, không mở cổng. SUBMIT_FAILED: có thể thử lại cùng key nếu vẫn PENDING. SUBMITTED: chỉ mở mock checkout khi có đủ dữ liệu hợp lệ.
5. Không mở checkout khi FAILED/SUCCEEDED, không trả người dùng về success chỉ vì HTTP200 hoặc idempotentReplay. Lấy trạng thái request từ server.
6. Poll hữu hạn, có backoff; dừng khi rời trang/logout/terminal, không vòng lặp vô hạn hay spam API. Có nút kiểm tra lại khi hết thời gian theo dõi.
7. Phục hồi nút sau lỗi; giữ cảnh báo kết quả chưa rõ; không làm mất modal xác nhận tranh chấp hoặc các thông báo tiếng Việt C2.

### Nghiệm thu P1

Test jsdom fake fetch: doubleclick1POST; timeoutretry cùngkey; reloadcùngkey; logout/userkhác không dùng lại; khácamount không cùngkey; SUBMITTINGkhôngcheckout; SUBMITTED mớicheckout; FAILED/SUCCEEDED khôngcheckout;503giữýđịnh;200thânhỏngkhôngsuccess; polldừng. Chạy lại60testC2 và23testPR18trên server test riêng. Không tự sửa backend để mock phù hợp. Test browser thật chưa có thì ghi rõ.

Không thay dependency chính thức/package-lock/package.json. Nếu thiếu jsdom, dùng môi trường đã có hoặc cài trong thư mục thử riêng và báo cách chạy; Codex quyết định đăng ký dependency/runner.

## 3. P2 — giao diện PayPal Sandbox, phụ thuộc hợp đồng API Codex

Trong lúc chờ có thể viết checklist/khung kiểm thử riêng, không đoán endpoint hoặc ghi giao diện PayPal hoạt động trong sản phẩm. Sau khi Codex gửi hash API, tạo nhánh riêng claude/paypal-wallet-ui từ nền đó, giữ requestId P1 đã duyệt; không cherry-pick P1 chưa được duyệt tùy ý.

Sở hữu public và test/ui/paypal-wallet-ui.js. API, quote, rate, binding và feature flag đều do server quyết định.

Yêu cầu:
- Chỉ hiển thị PayPal Sandbox khi cấu hình công khai của server xác nhận bật; thiếu cấu hình giữ trạng thái mock trung thực, không gắn logo PayPal giả lên mock.
- Hiển thị số VND được ghi ví và USD Sandbox được thu theo quote server, tỷ giá mô phỏng được ghi rõ. Không tính tỷ giá hoặc số tiền tin cậy ở client; không gọi giá thị trường.
- Không đưa client secret, DB URL, webhook secret vào frontend/localStorage/log.
- Dùng approval URL chỉ khi hợp đồng xác minh URL hợp lệ. Không thêm redirect tùy ý từ querystring.
- Approve/return URL chỉ dẫn tới hỏi trạng thái/capture API của server; không tự cộng ví, không tin query success=true, không báo thành công trước SUCCEEDED xác minh.
- Cancel/đóng cửa sổ không đồng nghĩa FAILED; nếu capture đã gửi chưa rõ, hiện chờ xác minh.
- Retry giữ cùng ý định/requestId/order, không tạoorder mới do timeout.
- Lịch sử phân biệt MOCK/PAYPAL_SANDBOX, không biến ví thành USD:ví và escrow vẫn VND.
- Hoàn tiền/giải ngân tranh chấp vẫn về ví nội bộ người mua/người bán; không ghi UI rằng hệ thống refund/payout PayPal nếu backend chưa có chức năng đó.

Test frontend với phản hồi giả lập hợp đồng; browser thật/Passkey/PayPal thật là nghiệm thu khác do Codex phối hợp. Báo rõ phạm vi, không tuyên bố sandbox thành công từ jsdom.

## 4. Báo cáo mỗi PR

Nhánh/head/base; file; API đã dùng; số test pass/fail/skip và lệnh tái lập; ảnh UI nếu cóbrowser; xung đột với public hiện có; giới hạn thử thật. Không merge/deploy. Chỉ gửi user chuyển Codex, không khẳng định đã liên lạc trực tiếp Max.

