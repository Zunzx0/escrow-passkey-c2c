# Báo cáo rào chắn test phiên PayPal (đăng xuất rồi đăng nhập lại cùng tài khoản)

Kiểm chứng bằng bộ test UI (jsdom). Đây không phải bằng chứng cho Sandbox, cookie, redirect hay Windows Hello thật.

- Nền: `c4ed8bc197958f2542f78cf6de031a381771486f` (codex/payment-provider-isolation). Nhánh làm việc: `claude/paypal-session-test-barrier`.
- Worktree mới sạch tạo từ đúng hash nền; `git status` trống trước khi sửa. Không dùng lại worktree cũ, không reset/clean/stash/force-push.
- Môi trường: Node v26.4.0, jsdom 30.1.2 (dùng chung `node_modules` của worktree `paypal-ui` qua `NODE_PATH`, chỉ đọc; không đổi manifest).
- Lệnh: `node test/ui/paypal-wallet-ui.js` (cwd `cho-an-tam`).

## Vấn đề

Test "đăng xuất rồi đăng nhập lại cùng tài khoản" (nhóm N) đã bắt được U2c, nhưng chờ phản hồi capture bằng `delay(700)`. Test không tự chứng minh POST capture đã phát và phản hồi còn treo lúc đăng xuất. Nếu nút capture không phát request, các assert "không báo nạp thành công" vẫn đạt giả. Thời điểm phản hồi muộn rơi cũng phụ thuộc đồng hồ (đăng xuất 60 ms + đăng nhập ~650 ms so với 700 ms).

## Thay đổi (chỉ `cho-an-tam/test/ui/paypal-wallet-ui.js`)

Chỉ sửa đúng khối "CÙNG tài khoản"; không đổi helper dùng chung, không đổi timeout chung.

1. Phản hồi capture giữ bằng Promise deferred (`captureGate`); chỉ được giải quyết khi test gọi `releaseCapture()`.
2. Chờ tối đa 1 s (vòng lặp 10 ms) cho POST capture phát ra, thêm một nhịp 50 ms để bắt lần phát thứ hai. Sau đó, trước khi đăng xuất, assert đồng thời: log ghi đúng 1 POST capture, máy chủ giả nhận đúng 1 lần, phản hồi chưa được giao, và Promise vẫn `pending` (thăm dò bằng `Promise.race`). Nếu sai, báo ❌ và bỏ qua phần còn lại (không tiếp tục như thể kịch bản đã dựng đúng).
3. Đăng xuất, đăng nhập lại cùng tài khoản, đặt `#/wallet`, chờ ổn định. Assert phiên mới đã hoàn tất (đúng 1 POST logout, 1 POST login, có nút đăng xuất) và phản hồi cũ vẫn chưa được giao, không có capture thứ hai.
4. Chỉ sau đó mới `releaseCapture()`, chờ 400 ms, assert phản hồi cũ đã thực sự được giao (`captureDelivered`) để các assert sau không đạt giả.
5. Giữ nguyên hai assert gốc: không toast "Nạp tiền thành công"; ý định của phiên mới còn nguyên và số lần GET trạng thái không tăng.
6. `try/finally`: luôn `releaseCapture()` và `p.close()` kể cả khi assertion thất bại.

Diff: 1 file, 40 dòng thêm, 13 dòng xoá.

## Baseline (code sạch, trước khi sửa test)

`208 kiểm tra, ALL PASS`, exit code 0.

## Sau khi sửa test (code sạch)

`212 kiểm tra, ALL PASS`, exit code 0 (thêm 4 assert). Trích log:

- ✅ Điều kiện dựng đúng: POST capture đã phát đúng 1 lần (log=1, máy chủ=1) và phản hồi còn treo trước khi đăng xuất
- ✅ Phiên mới đã hoàn tất (1 đăng xuất, 1 đăng nhập, giao diện đã đăng nhập) TRƯỚC khi giải quyết phản hồi capture cũ
- ✅ Phản hồi capture cũ vẫn chưa được giao cho tới khi phiên mới sẵn sàng, và không có capture thứ hai
- ✅ Phản hồi capture của phiên cũ đã thực sự được giao sau khi đăng nhập lại
- ✅ Capture chậm + đăng xuất/đăng nhập lại CÙNG tài khoản: phản hồi của phiên cũ KHÔNG báo "nạp thành công"
- ✅ Capture chậm + đăng nhập lại CÙNG tài khoản: phiên cũ không đọc trạng thái và không xoá ý định của phiên mới

## Kiểm U2c (bỏ cả hai lớp epoch)

Làm trên bản sao riêng (`public/` và `test/ui/` chép ra thư mục tạm); `app.js` trong worktree không bị đụng. Mỗi vị trí sửa khớp đúng 1 lần, nếu không khớp thì dừng.

- Lớp 1, `api()`: bỏ so `sessionEpoch` ở nhánh bắt lỗi fetch, sau fetch, và sau `refreshSession()`.
- Lớp 2, `ctxAlive()`: bỏ so sánh `state.sessionEpoch !== ctx.epoch`.

Kết quả: exit code 1, `212 kiểm tra, 2 FAIL`. Đúng hai assert dự kiến thất bại:

- ❌ Capture chậm + đăng xuất/đăng nhập lại CÙNG tài khoản: phản hồi của phiên cũ KHÔNG báo "nạp thành công"
- ❌ Capture chậm + đăng nhập lại CÙNG tài khoản: phiên cũ không đọc trạng thái và không xoá ý định của phiên mới

Các assert điều kiện in-flight (POST phát 1 lần, phản hồi treo, phiên mới hoàn tất, phản hồi được giao) vẫn đạt trong bản đột biến, nên thất bại là do hành vi phiên, không do dựng kịch bản sai.

Hash `public/js/app.js` của worktree (không bị sửa, `git diff -- cho-an-tam/public` rỗng): `sha256 08C70DCAC116138C500EB53471BB62C9470E629DEAEAE879AB96DDC67A6462FA`. Bản đột biến (chỉ nằm ở thư mục tạm): `2820D591C3CBE7ABB29E5FE46DDE5954C7FA70B693DFFCC01DF769C2D352378A`. Vì không ghi đè app.js thật nên không cần khôi phục; đã so hash trước và sau.

Không chạy lại năm mutation khác (theo giao việc).

## Giới hạn

- jsdom với `fetch` giả; không chứng minh Sandbox, cookie, redirect hoặc Windows Hello thật.
- Không sửa helper dùng chung, `public/`, `src/`, schema, `package.json`, `run-suite.js`, env hay deploy, nên không chạy full suite backend.
- Chờ cố định (50 ms, 400 ms, 1100 ms) vẫn còn để UI render xong; thứ tự sự kiện quan trọng (thời điểm giải quyết phản hồi cũ) thì không còn phụ thuộc đồng hồ.
- Khối N bên trên (đổi sang tài khoản khác) vẫn dùng `delay(700)`; chưa nằm trong phạm vi giao việc này.
