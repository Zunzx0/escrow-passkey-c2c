# Bàn giao lại cho Claude Max — M2

Git đã có tại `E:\Git\cmd\git.exe`. Không cần cài lại và không cần lấy token. Trong PowerShell gọi bằng `&` và đường dẫn đầy đủ.

1. Trong worktree paypal-integration, dùng Git ở đường dẫn trên để kiểm tra remote, HEAD, status và git diff. Không sửa worktree của Codex/Pro.
2. Tạo nhánh `claude/paypal-integration-tests` từ HEAD nền đang có; xác minh HEAD chứa b1b66a0. Nếu HEAD hoặc file khác ngoài phạm vi thì báo trước, không reset hay xóa dữ liệu.
3. Chỉ add đúng 7 file test/helper và PAYPAL-M2-REPORT.md liệt kê trong báo cáo. Không add toàn bộ thư mục. Kiểm tra staged không có env, DB, reports, node_modules hay secret.
4. Commit và push thường; gửi hash và link so sánh vào `codex/payment-provider-isolation`. Không merge/deploy.
5. Sửa nhận định “Git chưa cài” trong báo cáo thành Git không có trên PATH của phiên đó.

## Quyết định về PAYER_ACTION_REQUIRED

Chưa cho phép đổi UNKNOWN thành READY/NOT_CAPTURED chỉ dựa vào 422. Lệnh capture đã được gửi; cần giữ capture_post_sent_at, bằng chứng và cơ chế phục hồi. Không nới CHECK hay cho phép đóng yêu cầu dựa vào trạng thái này.

Ca đã biết phải hiện rõ trong báo cáo, không coi là tiêu chí đã đạt về UX. Codex sẽ kiểm hợp đồng PayPal để phân biệt thông báo cần người mua phê duyệt với trạng thái tài chính chưa xác định. M2 cần giữ test tái hiện và bổ sung kiểm không credit, không FAILED, không mất dấu POST, không POST tự động từ worker. Khoảng trống Retry-After cần được ghi rõ, không báo đã đạt.

Các số 1010/1001 của Max là báo cáo riêng, chưa phải kết quả Codex xác minh. Không cộng với 176 M2 để công bố tổng mới khi bộ runner chưa đăng ký M2 và chưa đối chiếu từng phép kiểm.

## Đối chiếu tài liệu chính thức

PayPal yêu cầu hướng người mua tới liên kết payer-action khi gặp PAYER_ACTION_REQUIRED, trước khi capture. Nguồn: https://developer.paypal.com/api/errors/overview/ . Codex sẽ tách thông báo hành động của người mua khỏi bằng chứng tài chính; không coi mọi 422 là bằng chứng chưa thu tiền.
