# Giao việc Claude Max — PayPal capture và kiểm thử tài chính

Ngày: 05/10/2026. Vai trò: backend và kiểm thử thuật toán. Codex phụ trách tích hợp chung và duyệt cuối; Pro phụ trách giao diện. Người dùng chuyển file này cho bạn, không có kênh liên lạc trực tiếp giữa các phiên.

## 1. Nền code và cách làm

Repo: C:\Users\tranq\Downloads\đồ án\escrow-passkey-c2c. Xác minh git remote là Zunzx0/escrow-passkey-c2c; không dùng repo sport-store cũ.

Nền đã kiểm tra: origin/codex/combined-review @70b72ce. Nhánh này đã ghép các bản sửa top-up, số tiền, bộ đếm, UI, module và test PayPal; chưa ghép store của bạn, chưa deploy. Kết quả riêng: SQLite 937, PostgreSQL 928, UI 60 + 23, PayPal 27; chín bất biến đúng. Không cộng các số này thành một tổng chung.

Fetch, kiểm tra nhánh và worktree sạch. Nếu có thay đổi chưa commit thì giữ nguyên và dùng worktree riêng, không stash/reset/xóa thay đổi của người khác. Tiếp tục claude/paypal-store của bạn bằng merge thường origin/codex/combined-review; giữ nguyên ba file store của bạn. Không rebase/force push. Nếu nền đã có commit mới, báo hash và diff trước khi nhận nó; không âm thầm thay nền nghiệm thu.

PR cuối vẫn hướng đến migrate-postgres sau khi Codex cập nhật nền tích hợp vào đó. Không tự sửa nhánh chung, merge PR, bật feature hoặc deploy. Bạn được push nhánh riêng bình thường.

## 2. M1 — hoàn thiện store ngay, không chờ Pro

Chỉ sở hữu các file sau:
- cho-an-tam/src/lib/paypalPaymentStore.js
- cho-an-tam/test/paypal-store-concurrency-e2e.js
- PAYPAL-STORE-DESIGN.md

Không sửa public, provider/service PayPal, routes, db.js, schema, migration, paymentService, reconciler, package.json hoặc run-suite.js. Các file đó do Codex sở hữu.

### M1.1 Trạng thái capture chưa rõ

UNKNOWN hoặc lease IN_FLIGHT hết hạn không được quay READY chỉ vì GET order trả APPROVED/PENDING. Một POST cũ còn chạy có thể hoàn tất sau GET. Lựa chọn bảo thủ: giữ tình trạng chưa rõ cho đến khi có bằng chứng thu tiền hoặc bằng chứng kết thúc không thu tiền đủ mạnh, được định nghĩa trong hợp đồng.

Store phải phân biệt chưa hề gửi POST với đã gửi nhưng chưa rõ kết quả. Nếu cần cột/phương thức mới, cập nhật proposedSchema và tài liệu; không sửa migration thật. Không coi lease hết hạn là bằng chứng chưa thu tiền. Lease 120 giây chỉ là giá trị khởi đầu.

Viết barrier test trước sửa: A giữ quyền và gửi POST đang treo -> lease hết -> B tiếp quản và GET vẫn PENDING -> close không được thắng -> POST A thành công muộn -> kết quả vẫn được ghi nhận cho settlement/recovery. Điều khiển thứ tự bằng promise/barrier, không phụ thuộc sleep ngẫu nhiên. Token A không được ghi đè B.

### M1.2 Thu tiền sau khi request đã đóng

markCaptureVerified hiện có thể đánh VERIFIED trên request FAILED. Thiết kế kết quả tường minh: cần recovery, không trả thành công giả; không mất capture ID/bằng chứng. Store không tự ghi ví, không tự mở lại FAILED và không tự giải quyết tiền.

Có thể trả outcome RECOVERY_REQUIRED cùng bằng chứng bền vững theo thiết kế bạn đề xuất, nhưng phải báo hợp đồng và lược đồ cho Codex. Không chỉ reject rồi bỏ capture hợp lệ. Kiểm same-capture replay, capture khác ID, requestFAILED, và PENDING bình thường.

### M1.3 Giữ các đảm bảo hiện có

Báo giá/merchant/provider/create timestamp bất biến; order/capture unique; owner được kiểm; token chỉ máy chủ sử dụng; userId=null chỉ lời gọi nội bộ. Mọi đường kết thúc cần điều kiện trên dữ liệu mới nhất. Không giữ transaction qua network. Chứng minh rollback của store; ghi rõ đây chưa phải wallet/ledger thật.

Sửa diễn đạt: PostgreSQL test hiện hai pool trong một Node process, không phải hai process. SQLite dùng cùng kết nối. Nếu bổ sung test hai process thật, báo riêng bằng chứng mới.

### Nghiệm thu M1

Test tái hiện bản cũ và bản sửa; SQLite/PostgreSQL DB riêng *_store_test. Không dùng production hoặc DB của Pro/Codex. Không lấy mật khẩu từ phiên khác. Nếu thiếu DB, báo đúng phần thiếu, tiếp tục unit/SQLite; không giả kết quả PostgreSQL. Gửi diff hợp đồng ngay sau khi chốt, trước khi chờ full suite xong, để Codex tích hợp song song.

## 3. M2 — kiểm thử tích hợp tài chính sau khi Codex bàn giao API/hash

Không làm M2 trên API tự đoán. Codex sẽ cung cấp hash bản đã nối route/store/settlement/migration. Khi đó tạo nhánh test mới từ hash đó; không mang commit M1 chưa được duyệt vào một PR lẫn lộn.

Bạn sở hữu các file mới:
- cho-an-tam/test/paypal-settlement-integration-e2e.js
- cho-an-tam/test/paypal-recovery-integration-e2e.js
- báo cáo tương ứng trong reports theo quy ước repo.

Codex sở hữu test migration và danh sách runner. Không sửa sản phẩm để test dễ đạt; lỗi backend tìm được báo Codex kèm test tái hiện.

Bắt buộc kiểm trên DB thật, HTTP server test và fake transport provider được kiểm soát:
1. Capture/webhook/reconciler đồng thời chỉ một credit ví và một ledger entry.
2. Capture ID dùng lại cho request khác bị từ chối; order/amount/currency/merchant/request sai không ghi tiền.
3. Fault injection trong settlement rollback cùng wallet/ledger/request/binding; retry không mất tiền/cộng trùng.
4. Mock webhook/checkout không xử lý request PayPal; PayPal không xử lý request MOCK.
5. Mất phản hồi create; capture thu tiền nhưng mất phản hồi; crash trước commit; restart + retry + worker phục hồi cùng order.
6. Capture đang treo đối đầu expire/close; thu tiền muộn có recovery rõ.
7. Buyer/seller không gọi admin settlement, owner không lấy payment người khác; callback URL không tự cộng tiền.
8. Chín bất biến trước/sau; full suite cả hai DB từ DB rỗng. Không bỏ qua kiểm rate-limit mà không ghi rõ.

Đây vẫn fake HTTP PayPal; kiểm Sandbox thật do Codex và người dùng thực hiện sau, không được đổi tên chứng cứ.

## 4. Báo cáo bàn giao mỗi đợt

Nhánh/head/base; file thay đổi; hợp đồng API/store mới; lỗi tái hiện trước sửa; lệnh test + report + DB test + pass/fail/skip; chín bất biến nếu chạy full suite; giới hạn và rủi ro. Tắt server/cluster riêng sau dùng. Không ghi secrets trong file hoặc commit.

