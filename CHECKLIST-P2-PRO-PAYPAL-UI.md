# Checklist P2 — Giao diện PayPal Sandbox (Claude Pro)

Trạng thái: **chuẩn bị, chưa bắt đầu code.** Không đoán endpoint, không bật tính năng, không chạm nhánh P1 (`claude/topup-ui-request-id` @fe2de3f).
Kiểm tra ngày 05/10/2026: `origin/codex/payment-provider-isolation` @69c42ab chưa có route PayPal nào trong `src/routes/` (0 kết quả), nên chưa có hợp đồng API.

## 1. Điều kiện bắt đầu
- Codex gửi **hash nền tích hợp** có route PayPal và **hợp đồng API bằng văn bản** (mục 2).
- Nhánh mới `claude/paypal-wallet-ui` từ đúng hash đó. Không cherry-pick P1 tùy ý: nền đã gồm P1 + bản vá của Codex (phiên/refresh). Đọc diff nền trước khi sửa `public/js/app.js`.
- Phạm vi file: `public/` (chủ yếu `public/js/app.js`, `public/css/style.css` nếu cần) và `test/ui/paypal-wallet-ui.js`. Không sửa `src/`, DB, `package.json`, `run-suite.js`, module PayPal của Codex/Max.

## 2. Câu hỏi hợp đồng cần Codex chốt (không tự suy ra)
1. **Cấu hình công khai:** endpoint/trường nào cho UI biết PayPal Sandbox đang bật (và chế độ `sandbox`, không phải live)? Thiếu hoặc lỗi thì UI mặc định hành vi nào?
2. **Tạo yêu cầu nạp PayPal:** đường dẫn, thân (có `requestId`, `amount` VND, `provider`?), phản hồi: id yêu cầu, **báo giá do server chốt** (VND ghi ví, USD thu, tỷ giá, mã/thời hạn quote), approval URL, trạng thái.
3. **Quy tắc kiểm URL approval:** host/giao thức/mẫu nào được coi là hợp lệ? UI chỉ dùng URL từ server.
4. **Return/cancel:** UI quay lại bằng cách nào (query token? route nội bộ?) và gọi endpoint nào để **hỏi trạng thái / capture** (xác thực, `requestId`/orderId nội bộ). Lưu ý: UI không tin `success=true` hay token trên URL.
5. **Bộ trạng thái đầy đủ** và nghĩa từng giá trị cho UI: PENDING/APPROVAL, đang capture, **đang đối soát**, **cần xử lý thủ công**, SUCCEEDED, FAILED, hết hạn, đã huỷ. Trường phân biệt `provider` (MOCK / PAYPAL_SANDBOX) trong `GET /payments/me` và `GET /payments/:id`.
6. **Mã lỗi/HTTP** của create/capture (timeout, 409 trùng key, quote hết hạn, provider không sẵn sàng) và cái nào là "từ chối dứt khoát" so với "chưa rõ".
7. **Retry:** cùng ý định giữ `requestId`/order nào? Quote hết hạn thì server tạo lại thế nào (UI không tự tính).
8. **Tỷ giá mô phỏng:** server trả kèm nhãn nào để UI ghi rõ "tỷ giá mô phỏng, không phải giá thị trường"?

## 3. Quy tắc UI (từ GIAO-VIEC-CLAUDE-PRO-UI.md và PHAN-HOI P1)
- Chỉ hiện PayPal Sandbox khi cấu hình công khai của server xác nhận bật. Thiếu cấu hình → giữ trạng thái mock trung thực, **không gắn logo/nhãn PayPal lên mock**.
- Hiển thị **VND được ghi ví** và **USD Sandbox phải trả** theo quote server, ghi rõ tỷ giá mô phỏng. Client không tính tỷ giá hay số tiền, không gọi giá thị trường.
- Không để client secret, DB URL, webhook secret trong `public/`, `localStorage`, log. Bản lưu ý định chỉ chứa requestId/số tiền (như P1).
- URL approval chỉ lấy từ phản hồi server và chỉ dùng khi qua kiểm hợp lệ; **không có redirect tùy ý từ query string**.
- Return/approve chỉ dẫn tới hỏi trạng thái/capture bằng API server có xác thực. Không cộng ví, không tin `success=true`, không báo thành công trước khi server xác nhận SUCCEEDED (GET khớp id/số tiền/requestId, như P1).
- Cancel / đóng cửa sổ **không** đồng nghĩa FAILED. Capture đã gửi mà chưa rõ → hiện "chờ xác minh" + nút kiểm tra lại, không "thất bại", không "thành công".
- Retry giữ cùng ý định/requestId/order; timeout không tạo order mới.
- Lịch sử phân biệt MOCK / PAYPAL_SANDBOX. Ví và ký quỹ vẫn VND, không hiển thị "số dư USD".
- "Đang đối soát" và "cần xử lý thủ công" là trạng thái trung thực, không giả thành công/thất bại; có hướng dẫn liên hệ khi cần thủ công.
- Hoàn tiền/giải ngân tranh chấp vẫn về ví nội bộ; **không** ghi UI rằng hệ thống refund/payout PayPal.
- Bản demo cuối dùng PayPal Sandbox; mock chỉ cho test riêng, không còn lựa chọn gây hiểu nhầm.

## 4. Bài học từ P1/Codex phải áp dụng ngay từ đầu (đừng làm lại lỗi cũ)
- **Phiên:** mọi thao tác bất đồng bộ mang ngữ cảnh (sessionEpoch + userId + requestId/orderId) và kiểm lại sau **mỗi** `await`; phản hồi cũ không được mở cửa sổ approval, báo thông báo, đọc ví hay sửa ý định của phiên mới. So cả epoch (đăng xuất rồi đăng nhập lại cùng tài khoản).
- `api()` đã bỏ phản hồi/lỗi của phiên cũ và refresh gắn epoch (bản vá Codex). Không viết đường `fetch` mới né các lớp này.
- Xác nhận kết quả kết thúc bằng **GET khớp id/số tiền/requestId**; GET lỗi/timeout/hỏng/không khớp → "chưa xác nhận" + nút kiểm tra lại, **không** quay về dữ liệu của POST/redirect để báo thành công.
- Theo dõi có hạn, giãn dần, dừng khi rời trang/đăng xuất; hủy phải kết thúc Promise và dọn hẹn giờ.
- Ý định theo userId, không tự xoá ý định của tài khoản khác, không dùng chéo; không lưu token/bí mật.
- Nút: khóa khi đang xử lý, bật lại sau lỗi/hủy; lỗi dùng bảng thông điệp C2 (không lộ mã thô/stack/HTML).
- Dùng lại harness `test/ui/topup-request-id-ui.js` (fake fetch + đồng hồ hẹn giờ) thay vì viết harness mới.

## 5. Ma trận kiểm thử dự kiến `test/ui/paypal-wallet-ui.js` (jsdom + fake fetch bám hợp đồng)
| Nhóm | Ca |
|---|---|
| Cờ bật/tắt | cấu hình tắt/thiếu/lỗi → không hiện PayPal, không logo trên mock; bật → hiện Sandbox |
| Báo giá | hiện VND ghi ví + USD + tỷ giá mô phỏng đúng từ server; không tự tính; quote hết hạn → hỏi server, không tự tạo |
| URL approval | chỉ URL hợp lệ từ server mới mở; URL lạ/`javascript:`/host khác/thiếu → không mở, báo lỗi; không đọc URL từ query |
| Return/cancel | return chỉ gọi hỏi trạng thái/capture; `success=true`/token giả trên URL không báo thành công; cancel ≠ FAILED |
| Capture chưa rõ | timeout/mất kết nối khi capture → "chờ xác minh", không thất bại, không thành công; nút kiểm tra lại |
| Xác nhận kết quả | GET lỗi/hỏng/sai id/số tiền/requestId → "chưa xác nhận"; chỉ GET khớp SUCCEEDED mới báo; ví đọc lại từ server |
| Retry | cùng requestId/order sau timeout/503; không tạo order mới; khóa số tiền khi chưa rõ |
| Trạng thái | đang đối soát / cần xử lý thủ công / hết hạn / FAILED hiển thị đúng, không thành công giả |
| Lịch sử | phân biệt MOCK/PAYPAL_SANDBOX; không có số dư USD; không có UI refund/payout PayPal |
| Phiên | phản hồi/refresh/approval đến chậm sau đăng xuất hoặc đổi tài khoản không mở cửa sổ, không thông báo, không đổi ý định (dùng pattern R9 của P1) |
| Bí mật | không có chuỗi client secret/DB URL/webhook secret trong `public/` và `localStorage` (quét tĩnh + kiểm runtime) |
| Hồi quy | chạy lại P1 (123), session-refresh (14), C2 (60), UI flow (23) trên nền tích hợp |

## 6. Giới hạn phải nói rõ trong báo cáo P2
- jsdom + fake fetch không chứng minh PayPal Sandbox thật, Passkey thật, cookie/Set-Cookie thật hay luồng redirect thật của trình duyệt.
- Không tuyên bố "Sandbox chạy được" nếu chỉ có test giả lập; nghiệm thu trình duyệt thật + tài khoản Sandbox do Codex phối hợp với người dùng (credentials qua nơi quản lý secrets, không qua chat/GitHub).
- Không bật PayPal live, không payout.

## 7. Bàn giao mỗi PR (mẫu)
Nhánh/head/base; file; API đã dùng; số test pass/fail/skip + lệnh tái lập (ghi rõ NODE_PATH/jsdom); xung đột với `public/` hiện có (vùng nạp tiền); ảnh UI nếu có trình duyệt; giới hạn thử thật. Không merge/deploy.
