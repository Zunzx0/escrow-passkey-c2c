# Codex review — Max M1 c1a60f1

Đã merge bình thường vào codex/payment-provider-isolation, chưa gộp migrate-postgres hoặc triển khai production.

## Đã tích hợp
- Store nhận SETTLEMENT_REQUIRED khi bằng chứng VERIFIED còn request PENDING; REPLAY chỉ dành cho SUCCEEDED.
- CAPTURE_DECLINED bị loại khỏi bằng chứng kết thúc không thu tiền; chỉ ORDER_VOIDED được chấp nhận.
- v5 mới của cả hai nền đã siết CHECK.
- PostgreSQL có migration v6 thêm CHECK cho DB đã áp v5 cũ. SQLite có trigger tương ứng và kiểm tra dữ liệu lịch sử trước khi chạy. Dữ liệu CAPTURE_DECLINED cũ khiến nâng cấp dừng rõ ràng; không tự sửa thành ORDER_VOIDED hoặc xoá bằng chứng.
- Test store trên migration thật nay phải assert DB từ chối CAPTURE_DECLINED thay vì chỉ in cảnh báo.

## Kiểm chứng độc lập tại Codex
- SQLite migration: 106/106; proposed: 106/106.
- PostgreSQL migration: 106/106; proposed: 106/106.
- Nâng cấp legacy giữ nguyên payment/wallet/ledger: SQLite 8/8, PostgreSQL 9/9.
- Nâng cấp từ v5 cũ: 6/6 mỗi nền. Tái hiện v5 cũ nhận evidence sai; nâng cấp từ chối nhưng giữ nguyên evidence; sau khi fixture bỏ evidence sai thì nâng cấp thành công và DB chặn ghi sai mới.
- Chỉ DB test riêng trên localhost được sử dụng. Không chạy PayPal thật.

## Hợp đồng tích hợp còn phải thực hiện
SETTLEMENT_REQUIRED phải đi vào transaction xác minh bằng chứng + credit + ledger + trạng thái request, không báo thành công hoặc POST capture thêm. RECOVERY_REQUIRED giữ bằng chứng và không tự credit/reopen/refund. Khi STALE_CLAIM, rollback settlement cũ và xử lý bằng chứng trong transaction mới. Marker POST phải được commit trước network capture; không giữ transaction qua mạng.

paypalSandboxService hiện vẫn là module chưa được expose qua route. Coordinator capture, settlement thực, route, webhook và worker chưa hoàn tất; tính năng vẫn tắt. Hash của nhánh này CHƯA phải hash nền M2 hoặc P2. Max có thể chuẩn bị checklist kiểm thử, nhưng không cần sửa tiếp store hoặc bắt đầu M2 từ một nền chưa nối đủ luồng.

## Chạy lại
Trong cho-an-tam, node test/paypal-store-concurrency-e2e.js --pg=<local *_store_test>; node test/paypal-binding-migration-e2e.js --pg=<local *_migration_test>; node test/paypal-evidence-upgrade-e2e.js --pg=<local enclave_*_evidence_test>. Các DB fixture được dựng lại, không dùng production.

## Ca bổ sung sau LEVEL2 review
Legacy FAILED + VERIFIED nay trả RECOVERY_REQUIRED ở cả claim và mark; giữ nguyên capture_id/state bất biến, ghi recovery_required_at và last_capture_error để đối soát. K7 thêm 3 kiểm tra cho mỗi chế độ; chạy store c1a60f1 cũ trong bộ nhớ làm đúng 3 kiểm tra này thất bại ở mỗi chế độ SQLite. Bản sửa đạt 106/106 ở cả bốn chế độ/nền.
SQLite full suite 954/954, 9 bất biến đúng (suite-2026-10-05T15-47-53-612Z). Lượt PostgreSQL đầu có 2 lỗi fixture admin khi áp lại v6; đã sửa migration drop/re-add constraint trong transaction, giữ báo cáo lỗi suite-2026-10-05T15-49-26-439Z.

PostgreSQL full suite sau sửa: 945/945, 9 bất biến đúng (suite-2026-10-05T15-51-43-234Z). LEVEL2 spot review không còn blocker cho thay đổi store/migration hiện tại; đây là review chỉ đọc, không thay thế kiểm thử root hoặc M2.

Hardening chạy riêng với RATE_LIMIT_AUTH_PER_MINUTE=10: 27/27 trên mỗi nền, không bỏ qua ca rate limit; 9 bất biến cũng đạt. Báo cáo PG suite-2026-10-05T15-53-57-359Z và SQLite suite-2026-10-05T15-54-07-346Z. Không cộng các số này vào tổng full suite vì có phép kiểm trùng.
