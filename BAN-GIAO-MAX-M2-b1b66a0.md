# Bàn giao M2 cho Claude Max — bắt đầu kiểm thử PayPal tích hợp

Ngày 06/10/2026. **M2 được phép bắt đầu; không còn chờ nền tích hợp.**

Remote https://github.com/Zunzx0/escrow-passkey-c2c.git
Nguồn codex/payment-provider-isolation
**Hash code đã kiểm thử: b1b66a09c74dd9116ed939f0805dbb2e0247fd4d (b1b66a0).**

Fetch, kiểm remote/status, tạo claude/paypal-integration-tests và worktree riêng từ đúng hash. Không sửa enclave-combined-review, P1/P2 Pro, nhánh root hoặc store cũ. Không cần merge đồng bộ claude/paypal-store: hash mới đã chứa store sửa cuối và migration v4–v6. Checklist PAYPAL-M2-CHECKLIST.md trên nhánh claude/paypal-m2-checklist được dùng làm ma trận; không kéo toàn bộ nhánh nền cũ vào M2.

## Sáu câu hỏi đã chốt

Đọc HOP-DONG-API-PAYPAL-P2-M2.md có trong nền này.

1. Create: POST /api/payments/paypal/topup {amount,requestId}, 200. Capture: POST /api/payments/paypal/:id/capture, 200. Checkout: GET /api/payments/paypal/:id/checkout. Config: GET /api/payments/paypal/config. Status/history giữ GET /api/payments/:id và /me. Topup/checkout/capture cần phiên đầy đủ và BUYER/SELLER. Webhook: POST /api/payments/paypal/webhook, nguyên event + transmission headers; không JWT. Lỗi/outcome xem hợp đồng. Không có HTTP settlement hoặc reconcile.
2. Fake transport: createSandboxProvider(config,{fetchImpl}) -> createPayPalRuntime({config,provider}) -> createPayPalRouter(runtime) trên app test. Adapter vẫn dựng origin Sandbox cố định; fake phải kiểm exact origin. Injection chỉ APP_ENV=test + DB local *_test hoặc SQLite data/test; không có biến/HTTP đổi host production. Worker test truyền paypalRuntime vào reconcileOnce, không được ngoài test. Tham khảo test/paypal-integration-e2e.js; viết transport bền + barrier độc lập của Max, không thay sản phẩm để test dễ đạt.
3. Bút toán TOPUP_CREDIT, request_id=request.id, available_delta=VND quote, locked_delta=0, idempotency_key=topup:<id>. Evidence/request/wallet/entry cùng transaction.
4. Fault paypal-topup:after-wallet-update và paypal-topup:before-status-change (điểm cuối sau ledger, trước commit). Chèn crash process test riêng nếu cần. Không bật fault trên production.
5. Lease mặc định120s, timeout mặc định10s tối đa30s; cấu hình phải bảo đảm leaseMs>=4*timeoutMs+10000. Cửa sổ CREATE unbound5 phút kể từ attempt đầu bất biến; đã bound không create order mới, quote không expire/đổi tự động.
6. Worker setInterval trong process server, mặc định60s/minAge30s, RECONCILE_INTERVAL_SECONDS=0 tắt. scripts/reconcile.js chạy một lượt cùng function. Worker chỉ GET, không capture; loại unbound/manual recovery, quay vòng cả FAILED đã POST để không starvation.

## Phạm vi và ưu tiên

Chỉ test backend/fixture test cùng PAYPAL-M2-REPORT.md. Không public/, source sản phẩm, migration, package.json hoặc run-suite.js; Codex đăng ký bộ mới khi tích hợp. Lỗi tìm thấy: test tái hiện + thông tin cho root, không âm thầm sửa store/API khi Pro đang viết UI.

Thực hiện T1–T8 trong checklist, đặc biệt:
- Barrier POST cũ đang treo, hết lease, holder mới, webhook/GET; chứng minh bằng authoritative adapter/SQL thật, không chỉ gọi private sink với capture ID dựng.
- Timeout đã thu nhưng mất response; crash/restart giữa remote capture và commit. Fake provider phải sống qua restart.
- Rollback đủ evidence/request/wallet/entry; stale claim rollback rồi transaction mới; VERIFIED/PENDING phải settlement; RECOVERY_REQUIRED commit bằng chứng và không credit.
- Conflict capture ID, merchant/order/money/request/currency, mock isolation, 429 chặn thêm calls, CREATE hết cửa sổ không create mới.
- Worker bound/unbound/FAILED head không làm request sau bị đói; API chỉ đúng owner, ADMIN_UNVERIFIED bị chặn cả ba tuyến ví.
- Post-commit log/notification lỗi không được báo tiền rollback hoặc cộng lần nữa.

Ba bất biến PayPal đã có ở src/lib/paypalInvariants.js; gọi trong M2, thêm fixture kiểm chúng bắt được sai dữ liệu, rollback fixture sau kiểm. Giữ nguyên chín bất biến cũ, không sửa invariants.js hay báo luận văn thành12 bất biến.

## Môi trường / báo cáo

DB PostgreSQL riêng localhost *_test, không enclave_combined_test của Codex, không DB Pro/Supabase. SQLite riêng data/test, cổng HTTP riêng; không dùng .env.test/credential của phiên khác. Không log secret, không commit .env.test hoặc data/node_modules. Dừng đúng cluster/server do Max khởi động sau test.

Nền root: fullSQLite1006/PG997, 9 bất biến; chênh9 là 3 typeof SQLite +6 nâng cấp SQLite. Integration52 mỗi DB; 40 module fake; hardening27 riêng mỗi DB (full suite cấu hình quota cao có4 rate checks bỏ qua, đã kiểm riêng). Reports cuối: suite-2026-10-05T17-10-13-588Z SQLite, 17-10-17-132Z PG; hardening17-04-18-483Z/17-04-20-969Z. Không cộng các lần chạy lặp thành số kiểm duy nhất. Reviewer cấp2 đọc nguồn, không chạy test.

Đó chưa phải bằng chứng Sandbox thật/browser/Passkey/cookie. M2 độc lập cần báo T1–T8 pass/fail/skip từng nhóm, test tái hiện đỏ nếu có, full suite hai DB từ trống, chín bất biến và ba kiểm riêng PayPal. Không bỏ skip rate âm thầm.

Push thường, PR **vào codex/payment-provider-isolation** để diff chỉ test Max. Không rebase/force/merge/deploy. Nếu thiếu gh, gửi compare link với base này. Codex duyệt và ghép trước khi tạo PR bản tích hợp vào migrate-postgres.
