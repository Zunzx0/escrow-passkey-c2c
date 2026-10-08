# Codex — migration và cô lập provider, đợt P0

Nhánh: codex/payment-provider-isolation. Nền: codex/combined-review @f48e313. Chưa merge hoặc deploy.

## Thay đổi

- SQLite: thêm provider vào DB tạo mới và DB cũ, mặc định MOCK; CHECK chỉ nhận MOCK/PAYPAL_SANDBOX, trigger cấm đổi provider.
- PostgreSQL: migration v4 schema.pg.004-payment-provider.sql, cột và trigger tương đương. Giữ nguyên v1–v3.
- Settlement mock đọc dữ liệu hiện tại và kiểm provider/ref/amount/trạng thái trong cùng transaction, trước nhánh duplicate; UPDATE claim có điều kiện provider.
- Mock submission kiểm bản ghi thật và token trước gọi provider; claim/release/expire/close đều lọc MOCK.
- Worker hiện chỉ quét MOCK. Đây là giai đoạn cô lập, CHƯA có PayPal worker: request PayPal được giữ nguyên, không âm thầm đưa vào logic mock.
- Mock checkout kiểm owner kèm provider; replay topup cùng key thuộc PayPal trả409 PAYMENT_PROVIDER_MISMATCH.
- applyProviderResult chưa cho expectedProvider=PAYPAL_SANDBOX: trả PAYPAL_INTEGRATION_NOT_READY. Chỉ bỏ hàng rào này khi store/capture/settlement đã tích hợp và kiểm thử.
- Test provider isolation có16 kiểm tra SQL/HTTP thật, chỉ DB test; thêm vào runner.

## Chứng cứ

Đã dùng module paymentService nguyên bản ở f48e313 trên DB thử có discriminator để tái hiện hai lỗi: claimSubmission cấp lease mock cho PayPal; expireUnsubmitted đóng PayPal FAILED. Không sửa file code đang chạy để tạo bằng chứng.

DB SQLite cũ data/test/codex-combined.db và PostgreSQL enclave_combined_test đã được nâng cấp, đối chiếu số payment requests, số ledger entries và tổng balances trước/sau: không đổi; mọi payment cũ thành MOCK. PostgreSQL ghi migration1,2,3,4. Chỉ dùng dữ liệu test, không chạm production.

Full suite SQLite cuối:954 đạt,0 hỏng,9 bất biến đúng. Report reports/suite-2026-10-05T14-42-43-170Z. Bốn kiểm rate limit vẫn skipped trong full có threshold cao; hardening riêng chạy sau để bổ sung. Không cộng số test UI/module PayPal từ đợt trước vào tổng này.

Vòng full đầu có8 hỏng: username quota phụ thuộc cách thua cuộc đua; server con có token401 cần cô lập cổng. Sau tách race khỏi quota distinct-usernames và dùng TEST_CHILD_PORT_BASE riêng, vòng cuối SQLite đạt. Không sửa cơ chế rate-limit production để test đạt. Không xóa báo cáo vòng hỏng.

## Cập nhật cho Max và Pro

Max giữ phạm vi store/test/design, chưa merge nhánh này vào công việc khi chưa bàn giao hash được duyệt. Migration v4 nay dành riêng provider isolation; migration store sau đó là v5, hoặc Codex ghép phần schema store vào v4 trước phát hành nếu toàn bộ chưa áp ở môi trường chung. Max chỉ sửa proposedSchema, không đánh số hoặc sửa migration thật. proposedSchema store hiện có ALTER provider; Codex phải bỏ câu thêm cột đã có khi viết migration store.

Pro tiếp tục P1 requestId trên nền f48e313 như giao việc. Hợp đồng requestId/submissionStatus không đổi. Chưa làm UI PayPal như đã hoạt động; chưa bật feature.

Codex còn làm binding schema, API/capture, webhook, PayPal worker và atomic wallet/ledger/capture settlement sau khi hợp đồng capture của Max đạt review. Không diễn giải provider isolation thành PayPal đã tích hợp xong.

## Kết quả cuối và review

Full PostgreSQL cuối:945 đạt,0 hỏng,9 bất biến đúng; report reports/suite-2026-10-05T14-44-15-579Z. Hardening riêng ngưỡng10:27/27 trên PostgreSQL và27/27 trên SQLite, không bỏ qua, chín bất biến đúng; reports/suite-2026-10-05T14-45-55-500Z và reports/suite-2026-10-05T14-46-23-882Z. Cluster Codex54333 đã dừng.

Reviewer LEVEL2 đã đọc độc lập và không tìm thấy lỗi chặn trong phạm vi cô lập provider. LEVEL3 không khởi động lại được vì agent thread limit; đây không phải duyệt LEVEL3 mới. Reviewer không tự chạy lại test, số liệu chạy do Codex thực hiện.

Trước triển khai migration, cần lưu fixture nâng cấp v3 có dữ liệu và kiểm restart lặp một cách tái lập đầy đủ từng trường amount/status/ref/version/claim; kiểm thủ công hiện đối chiếu các số lượng và tổng tiền cùng default provider. Chưa coi phần store/capture PayPal đã nghiệm thu.
