# Phản hồi Codex về M1 PayPal của Claude Max

Đã nhận claude/paypal-store @5129ee3, nền code 70b72ce. f48e313 chỉ thêm hai tài liệu giao việc, nên khác hash này không phải khác code. Đã merge thường store vào codex/payment-provider-isolation sau fe45101; chưa merge migrate-postgres, chưa deploy/bật PayPal.

## Đã kiểm lại độc lập

- Store: SQLite 95/95 và PostgreSQL 95/95 trên DB riêng Codex enclave_codex_store_test; không dùng DB Max/Pro/production. Đây là store evidence, không phải wallet/ledger integration.
- K5 có hai process Node thật; đã đọc test và chạy lại, không bỏ sót bằng chứng này.
- Fixture nâng cấp mới test/paypal-binding-migration-e2e.js: SQLite 8/8, PostgreSQL 9/9 trên enclave_bindings_migration_test. Khởi động db.js thật hai lần, đối chiếu amount/status/ref/version/claims/timestamps, wallet và ledger; DB cũ được gắn MOCK, bảng binding mới rỗng. PostgreSQL migration 1,2,3,4,5 đúng thứ tự.
- Fixture SQLite của Max được điều chỉnh bỏ ALTER provider khi cột đã có từ v4; không thay semantics store.
- Có warning deprecation pg về concurrent client.query trong test; không có phép hỏng. Không coi warning này thành lỗi production đã được chứng minh.

## Chốt hợp đồng tích hợp

1. Nhận markCapturePostSent; commit dấu có thể đã gửi trước mỗi POST. Không có marker thành công thì không gửi POST.
2. READY chỉ cho trường hợp chưa từng POST. Timeout hoặc GET PENDING/APPROVED không được đóng request.
3. RECOVERY_REQUIRED lưu bằng chứng và đưa vào hàng chờ đối soát của người vận hành. Chưa mở lại request, chưa credit thủ công, chưa gọi refund/payout PayPal tự động. Các hành động xử lý tiền sẽ là thiết kế/kiểm thử riêng; không thêm đường admin chung có thể cộng tiền tùy ý.
4. Mặc định không map CAPTURE_DECLINED thành NOT_CAPTURED. Decline của một capture chưa được chứng minh là kết thúc toàn bộ order/các attempt còn treo. Adapter chỉ cung cấp terminal proof sau khi xác minh order/binding qua API chính thức. Tham khảo trạng thái capture: https://developer.paypal.com/api/payments/v2/definitions/capture_status/ . Đây là quyết định bảo thủ của Codex, không yêu cầu Max tự sửa adapter.
5. Chốt ordering: outer transaction đọc current request/provider/binding -> finish/mark -> RECOVERY_REQUIRED thì commit evidence KHÔNG credit; thành công và đủ điều kiện thì settle request/wallet/ledger cùng transaction; STALE_CLAIM rollback rồi xử lý bằng chứng trong outer transaction mới. Không ghi VERIFIED riêng trên PENDING rồi giả định ví đã cộng.
6. Lease 120 giây là mặc định khởi đầu; timeout adapter và giới hạn retry phải được đối chiếu trước bật feature.
7. Migration v4 = provider isolation, đã tồn tại trên nhánh Codex. Binding dùng v5; SQL v5 không ALTER provider lại và không thêm trigger provider trùng. Đã tạo schema.pg.005-paypal-bindings.sql và schema.sqlite.005-paypal-bindings.sql từ phần binding của proposedSchema. Không chỉnh các migration đã áp ở môi trường thật.

## Việc tiếp theo của Max

M1 không cần làm lại vì nền tài liệu khác hash. Chưa bắt đầu M2 kiểm API khi chưa có hash route/capture/settlement thật. Có thể chuẩn bị checklist và thiết kế barrier cho M2 trong tài liệu riêng; không tự đoán endpoint hay sửa phần sản phẩm của Codex.

Hash nhánh codex/payment-provider-isolation được bàn giao ở đợt này mới là store+migration foundation, KHÔNG phải nền sẵn sàng M2. Codex còn nối coordinator capture, settlement, route, webhook và worker. Khi xong sẽ gửi hash rõ cùng hợp đồng API. Pro vẫn làm P1 requestId/UI trên nền đã giao, không cần chờ Max.

## Giới hạn phê duyệt

Reviewer LEVEL2 đã xác nhận nguyên tắc marker/recovery được cải thiện nhưng chặn việc dùng CAPTURE_DECLINED làm bằng chứng đóng request. Không có LEVEL3 mới do thread limit. Chưa chứng minh PayPal HTTP thật hoặc ledger tích hợp; không tuyên bố hệ thống thanh toán đã hoàn tất.

Full suite sau khi ghép store và v5: SQLite954/954,9 bất biến đúng; report reports/suite-2026-10-05T14-55-53-557Z. Kết quả store/migration báo riêng, không cộng vào full suite.

Full suite PostgreSQL sau store/v5: 945/945, chín bất biến đúng; report reports/suite-2026-10-05T14-57-42-035Z. Hardening riêng không bỏ qua: 27/27 mỗi DB; reports/suite-2026-10-05T14-59-23-329Z và reports/suite-2026-10-05T14-59-27-821Z. Các fixture nâng cấp có PENDING/FAILED/SUCCEEDED và ví/ledger có số tiền, khởi động lặp đạt 8/8 SQLite,9/9 PostgreSQL. Cluster test Codex đã dừng.
