# Bàn giao C2/C1 và phạm vi vòng tiếp theo — 05/10/2026

## Trạng thái được kiểm chứng

Codex đang ghép trên nhánh riêng `codex/combined-review`, không sửa trực tiếp migrate-postgres và chưa deploy. Đã ghép các nhánh bộ đếm, số tiền thủ công, top-up idempotency, UI flow, UI payment error, adapter/service PayPal và test PayPal. Store Max chưa ghép vì cần hoàn thiện giao thức trạng thái trước.

Đã chạy trên bản ghép: 937 phép kiểm SQLite đạt, 9 bất biến đúng; 60 kiểm tra lỗi UI đạt; 23 kiểm tra luồng UI trên server test đạt; 27 test adapter/service PayPal đạt. Bốn kiểm tra rate-limit được bỏ qua trong full suite có ngưỡng cao; đã chạy hardening riêng ngưỡng 10: 27 kiểm tra đạt, không bỏ qua, cùng 9 bất biến đúng. PostgreSQL đạt 928 phép kiểm, 9 bất biến đúng trên cluster Codex riêng cổng 54333; cluster đã dừng, không dùng DB Max/Pro/production. Các số PayPal/UI được báo riêng, không cộng vào 937.

## Claude Max — C1 bổ sung, chỉ store/test/design của mình

Giữ nhánh claude/paypal-store, không sửa module service/provider, migration, route, paymentService, reconciler hay public. Không dùng Supabase production. Không sửa nhánh Codex hoặc Pro.

1. Không cho một lần capture từng UNKNOWN hoặc bị tiếp quản từ IN_FLIGHT quay READY chỉ vì GET order còn APPROVED/PENDING. GET tại thời điểm đó không chứng minh POST cũ không hoàn tất sau đó. Thiết kế bảo thủ: giữ UNKNOWN cho tình huống đã có POST chưa rõ; chỉ READY khi chưa gửi POST hoặc có bằng chứng kết thúc không thu tiền được định nghĩa rõ. Thêm dữ liệu/proof nếu cần và báo hợp đồng cho Codex trước khi ghép.
2. Thêm test barrier: holder cũ POST đang treo -> lease hết -> holder mới GET PENDING -> không được đóng request FAILED -> POST cũ thành công muộn -> ghi nhận được kết quả để tất toán/recovery. Test phải bắt được giao thức cũ, không chỉ dùng sleep hy vọng gặp race.
3. markCaptureVerified hiện UPDATE binding không kiểm trạng thái request. Khi request đã FAILED mà xuất hiện capture hợp lệ, không được trả kết quả thành công giả hoặc làm mất bằng chứng thu tiền. Chốt một kết quả rõ cần recovery, giữ capture ID/bằng chứng; không tự cộng ví hoặc tự mở lại request trong store. Codex xử lý settlement/recovery ở tầng tích hợp. Có test FAILED + capture muộn và same capture replay.
4. Sửa diễn đạt chứng cứ: PostgreSQL hiện hai pool trong một Node process, chưa phải hai process. SQLite dùng cùng kết nối. P8 chỉ mô phỏng UPDATE trạng thái request, chưa chứng minh wallet/ledger thật. Giữ giới hạn này trong báo cáo.
5. Chạy store tests SQLite/PostgreSQL riêng, gửi commit, base, file, hợp đồng phương thức mới, kết quả/skip và giới hạn. Không tự gộp/deploy. Lease đề xuất 120s được chấp nhận như thiết kế khởi đầu, không thay bằng chứng timeout/race.

Codex chấp nhận bổ sung createBinding, closeUncaptured, markCaptureVerified và object outcome của claimCapture; userId=null chỉ từ worker nội bộ, tuyệt đối không lấy từ body người dùng. VERIFIED phải cùng transaction với settlement hoặc cơ chế recovery tường minh. READY cần sửa ràng buộc như trên trước khi dùng.

## Claude Pro — C2 đã nhận, chưa yêu cầu làm lại

C2 @99704a5 đã ghép thử với PR18. Codex bổ sung xử lý HTTP 200 có HTML/null/array: báo kết quả chưa rõ, không thành công giả; thêm 12 kiểm tra (60 tổng). Codex sửa harness PR18 bằng AbortController của Node, giữ khả năng abort thay vì bỏ signal. Không sửa lại các đoạn này trên nhánh Pro cũ.

Việc tiếp theo E1: chờ hash nền Codex đã push và API PayPal được chốt. Chưa tự làm UI PayPal hoặc requestId trên base843223b vì dễ ghi đè bản ghép. Có thể chuẩn bị checklist chỉ đọc: trạng thái SUBMITTING/SUBMITTED/UNKNOWN, timeout chưa rõ, không mở checkout khi chưa có URL, callback không tự cộng số dư, chỉ hiển thị PayPal Sandbox khi feature bật. Sau khi nhận nền, tạo nhánh mới và chỉ sửa public cùng test/ui; không package.json/run-suite/backend/DB.

## Codex — tích hợp phần dùng chung

- Migration v4 và nâng cấp DB cũ sau v3 top-up.
- Mọi đường mock phải lọc provider=MOCK; worker dispatch trước logic timeout/UNKNOWN_PAYMENT.
- applyProviderResult kiểm expectedProvider nội bộ trong transaction, kể cả replay; capture ID unique và ghi ví/ledger/request/binding nguyên tử.
- Service dùng claim/finish của store, không giữ DB transaction qua mạng; xử lý captured-but-closed bằng recovery rõ, không báo thành công giả.
- HTTP/SQL integrated race, fault injection, restart và cả 9 bất biến trên hai DB.
- Cuối cùng mới cấu hình tài khoản Sandbox, webhook và thử trên trình duyệt thật; chưa bật PayPal hiện tại.

## Quy trình chung

Fetch trước, kiểm tra worktree sạch, nhánh riêng từ hash nền được bàn giao. Không force push, không sửa nhánh chung, không merge/deploy. Báo giới hạn kiểm thử trung thực; jsdom không chứng minh Passkey thật, fake transport không chứng minh PayPal thật. Hai Claude nhận việc qua file này do người dùng chuyển, không có kết nối trực tiếp từ Codex.

