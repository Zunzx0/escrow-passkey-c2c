# Codex review P1 fe2de3f

Đã merge bình thường Pro P1 vào codex/payment-provider-isolation. Diff merge từ parent tích hợp chỉ gồm public/js/app.js và test/ui/topup-request-id-ui.js; các file backend/migration/PayPal được giữ nguyên. Chưa merge migrate-postgres hoặc deploy.

## Bản Pro đã giải quyết
Giữ requestId khi retry, khôi phục ý định theo tài khoản, chặn phản hồi topup cũ, xác nhận terminal bằng GET đúng id/amount/requestId, không dùng lại POST khi GET hỏng, huỷ polling không treo Promise, không xoá ý định của người khác. Các giới hạn jsdom/Passkey thật được giữ trong báo cáo.

## Codex bổ sung sau kiểm tra độc lập
1. Trên fe2de3f: POST nhận 401 -> bắt đầu refresh; logout rồi login tài khoản khác khi refresh còn chờ. Refresh cũ vẫn cài token cũ và request cũ có thể retry rồi xoá phiên mới. Đã tái hiện bằng jsdom trước khi sửa.
2. Refresh job nay gắn sessionEpoch; kiểm lại sau fetch và parse JSON, chia sẻ job chỉ trong cùng phiên; finally của job cũ không được xoá job mới.
3. api và providerApi kiểm epoch sau khi chờ refresh, trước khi retry hoặc xử lý hết phiên. providerApi cũng bỏ kết quả/lỗi HTTP cũ trước khi kích hoạt refresh.
4. Refresh chỉ chấp nhận token kèm user.id khớp người khởi tạo; không được dùng cookie-derived response của tài khoản khác để tự chuyển tài khoản.
5. refreshWallet và refreshSellerRequest không cập nhật hoặc xoá dữ liệu phiên mới khi request phiên cũ bị bỏ.

## Kiểm thử
P1 thêm R12 với 3 kiểm tra refresh chậm (tổng 123). Bộ session-refresh-ui.js mới tái sử dụng harness P1 với 14 kiểm tra: refresh chậm sau logout/login, owner response khác, refresh cùng chủ không làm mất topup đang chờ, provider 401 cũ không refresh phiên mới; và hai ca stale rejection không xoá dữ liệu ví/yêu cầu seller của phiên mới. C2 và UI flow được chạy lại trên bản ghép. Kết quả cuối sẽ ghi dưới đây khi xong.
Không cài jsdom vào package.json; dùng phụ thuộc test hiện có qua NODE_PATH. UI flow dùng server test riêng localhost:3128 và DB data/test/pro-ui-integration.db; không gọi production.

## Giới hạn
Các kiểm thử này không chứng minh WebAuthn thật, PayPal thật hoặc thứ tự Set-Cookie trong trình duyệt thật. JS không ngăn trình duyệt áp header cookie của phản hồi cũ; chặn epoch và user.id giúp không tự chuyển tài khoản. Kiểm thử cookie/session đầu cuối trên trình duyệt thật cần làm riêng.
Backend giữ kết quả kiểm thử lần trước 954/954 SQLite và 945/945 PG, 9 bất biến đúng; không gọi đây là full suite chạy lại cho commit UI cuối.

## Việc tiếp theo của Pro
Không sửa lại nhánh P1 để chép các fix Codex. Chờ hash API PayPal để bắt đầu P2 từ nền tích hợp mới. Có thể chuẩn bị checklist P2 không phụ thuộc endpoint: Sandbox rõ ràng, hiển thị báo giá USD và ví VND; return/cancel không tự báo thành công; retry giữ requestId; trạng thái đang đối soát và cần xử lý thủ công không thành công giả; checkout chỉ lấy URL từ server và không đưa client secret vào public/. Chưa đoán endpoint hoặc bật feature.

## Kết quả bản cuối tại Codex
P1 123/123, session-refresh 14/14, C2 60/60, UI flow trên server test thật 23/23 — tất cả đạt. Không cộng các tổng này với full suite backend vì phạm vi khác và có thể trùng. Các test jsdom không chứng minh Passkey thật hoặc thứ tự cookie trên trình duyệt thật.
