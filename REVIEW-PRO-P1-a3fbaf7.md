# Review P1 — Claude Pro a3fbaf7

## Kết luận
Chưa gộp hoặc triển khai P1. Codex kiểm tra độc lập bằng jsdom với API giả lập và tái hiện được hai lỗi cần sửa. Không sử dụng production, PayPal thật hoặc dữ liệu tài chính thật.

## 1. Phản hồi POST đến sau khi đăng xuất vẫn mở checkout
Ca tái hiện: POST /payments/topup trả SUBMITTED sau 150 ms; đăng xuất sau 20 ms. Token đã bị xoá, nhưng phản hồi cũ vẫn gọi GET /mock-provider/checkout/ref1 và mở modal thanh toán.
Nguyên nhân: createTopup và settleRow không kiểm tra phiên/ý định còn thuộc người khởi tạo sau mỗi bước await. Kiểm tra generation hiện chỉ có trong polling.
Sửa trên chính nhánh claude/topup-ui-request-id: lấy dấu phiên, userId và requestId lúc bắt đầu; sau mỗi await kiểm tra còn cùng phiên và ý định. Phản hồi cũ không được sửa notice, xoá ý định của tài khoản mới, mở modal hoặc đọc ví cho phiên mới. Áp dụng cả createTopup, checkTopupStatus, settleRow, announceTerminal và openCheckout. Cần phát hiện cả đăng xuất rồi đăng nhập lại cùng tài khoản, không chỉ so userId.
Test: POST chậm + logout; POST chậm + đổi tài khoản; GET kiểm tra chậm + đổi tài khoản; xác nhận không có checkout/toast hoặc thay đổi ý định của phiên mới.

## 2. Bước GET xác nhận bị lỗi vẫn báo thành công
Ca tái hiện: POST trả SUCCEEDED; GET /payments/p1 trả 503. announceTerminal bắt lỗi và dùng lại dòng POST, nên vẫn hiện “Nạp tiền thành công”.
Sửa: nếu yêu cầu thiết kế là xác nhận qua GET thì GET thất bại/thân không hợp lệ không được quay lại dùng POST để báo thành công. Giữ trạng thái chưa xác nhận và cung cấp nút kiểm tra lại; kiểm tra id/amount/requestId khớp với yêu cầu đang theo dõi. Không tự cộng tiền phía giao diện.
Test: GET 503, timeout, thân hỏng, sai id/số tiền/requestId; chỉ GET hợp lệ đúng yêu cầu có SUCCEEDED mới được báo thành công.

## 3. Các điểm cần kiểm tra cùng lần sửa
- stopTopupPoll hiện clearTimeout nhưng không giải quyết Promise đang đợi timer. Hãy bảo đảm huỷ polling cũng kết thúc Promise, không để tác vụ treo.
- Dòng comment nói bản localStorage “không ai khác đọc được” là không chính xác: khoá theo userId chỉ phân tách logic giao diện, không phải cơ chế bảo mật của localStorage. Chỉnh mô tả.
- purgeTopupIntentsExcept xoá ý định của người khác khi đổi tài khoản, làm mất khả năng phục hồi khi người đó quay lại. Cần chốt và kiểm thử chính sách: không dùng ý định chéo tài khoản; nếu giữ ý định để phục hồi thì không tự xoá của tài khoản khác.
- Bộ full suite 937 không được mặc định gọi là bộ đếm cũ: nền 70b72ce đã có sửa bộ đếm. Ghi hash run-suite/count-marks thực tế và số bỏ qua. Không coi phỏng đoán cổng chưa nhả là nguyên nhân của 11 lỗi nếu chưa có bằng chứng.

## Phạm vi Pro
Chỉ sửa public/js/app.js và test/ui/topup-request-id-ui.js trong nhánh hiện có. Không sửa backend, migration, package.json/run-suite.js hoặc tích hợp PayPal. Không force-push. Giữ các kiểm thử P1/C2/UI flow và thêm kiểm thử tái hiện lỗi trước khi sửa. Bàn giao commit, file, kết quả và giới hạn trình duyệt thật.

## Phần Codex và Max
Codex tiếp tục nối route/service/store/settlement PayPal với migration và cô lập provider ở nhánh riêng. Max M2 chỉ bắt đầu từ hash đã nối đủ luồng ghi ví thật. Pro P2 cũng chờ hash hợp đồng API PayPal; không đoán endpoint. Hiện tính năng PayPal chưa được bật.

## Bằng chứng kiểm tra độc lập
Harness tạm: C:/Users/tranq/AppData/Local/Temp/enclave-p1-review-Ea5TKK/review.js.
Chạy trên app.js lấy trực tiếp từ origin/claude/topup-ui-request-id a3fbaf7: 3 kiểm tra, 2 thất bại; kiểm tra token đã xoá đạt, hai hành vi nêu ở mục 1 và 2 thất bại. Bộ P1 gốc được chạy riêng để đối chiếu, không thay thế hai ca bổ sung này.

Kết quả đối chiếu: Codex chạy độc lập bộ P1 gốc trên đúng app.js a3fbaf7: 73/73 đạt. Hai ca bổ sung vẫn thất bại, nên 73/73 chưa đủ để duyệt triển khai.
