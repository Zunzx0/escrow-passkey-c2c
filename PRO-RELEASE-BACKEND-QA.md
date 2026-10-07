# PRO-RELEASE-BACKEND-QA

Agent cấp 3 `pro_release_backend_qa`, ngày 2026-10-07. Chỉ kiểm thử, không sửa mã. Bằng chứng: `cho-an-tam/test/evidence/pro-release/backend/` (đã quét: không chứa JWT_SECRET/PAYMENT_WEBHOOK_SECRET).

## 1. Môi trường
- Hash: `5080e3a239b9935e22a35cc2c66e6e396f8cceda` (nhánh claude/paypal-release-review). Không sửa file đã theo dõi; chỉ có file chưa theo dõi (báo cáo, evidence).
- Node v26.4.0, Windows 11. PostgreSQL 17.11 (Pro xác nhận bằng psql `show server_version` trên 127.0.0.1:55432, log không có; cổng 55432, DB `enclave_pro_release_test`, thêm `..._store_test` và `..._migration_test`).
- `.env.test` tự tạo (gitignored, không in): `APP_ENV=test`, `PORT=3910`, `BASE_URL=http://localhost:3910`, `WEBAUTHN_RP_ID=localhost`, `WEBAUTHN_ORIGIN=http://localhost:3910`, `SERVE_FRONTEND=1`, `MOCK_PROVIDER_CHECKOUT=1`, `RATE_LIMIT_AUTH_PER_MINUTE=1000`, hai secret ngẫu nhiên. DB truyền bằng biến tiến trình: SQLite `DB_PATH=data/test/pro-release-sqlite.db`; PG `DATABASE_URL=postgresql://postgres@127.0.0.1:55432/enclave_pro_release_test?sslmode=disable`. Không bật PayPal thật, không credential.
- Khoá hàng đợi nặng lấy/nhả bằng try/finally cho mọi lượt.

## 2. Cách runner hoạt động (đọc trước khi chạy)
- `test:suite` = `node --env-file=.env.test scripts/run-suite.js`. Từ chối nếu `APP_ENV!=test`; SQLite: `DB_PATH` phải trong `data/test/`; PG: tên DB phải kết thúc `_test` (rồi `DROP SCHEMA app, mock_provider CASCADE`). Không có `--keep-db` thì xoá DB mới. Không `--only`: từ chối nếu `SERVE_FRONTEND=0` hoặc `MOCK_PROVIDER_CHECKOUT=0`.
- Dựng server, chờ `/health`; `environment` khác `test` thì kill và thoát mã 2; nếu đã có server ở BASE thì từ chối.
- 24 bộ theo thứ tự: count-marks-unit, invariants-unit, e2e, market-e2e, security-e2e, hybrid-e2e, hardening-e2e, payment-e2e, reconcile-e2e, counter-e2e, cleanup-e2e, notification-e2e, checkout-e2e, dispute-race-e2e, security-report-regression-e2e, username-enumeration-e2e, listing-lifecycle-e2e, passkey-registration-race-e2e, topup-concurrency-e2e, manual-transaction-amount-e2e, topup-idempotency-e2e, payment-provider-isolation-e2e, paypal-integration-e2e, admin-provenance-e2e. Sau đó khởi động lại server với `FAULT_INJECT=release:after-wallet-update` chạy rollback-e2e, rồi `scripts/check-invariants.js`. Tổng 26 mục.
- Đếm: `countMarks` đếm dòng bắt đầu (cho phép thụt lề) bằng ✅ / ❌; dòng tổng "=== KẾT QUẢ" bị loại. Bộ PASS khi exit 0 và 0 ❌ (rollback còn đòi pass>0). Mục check-invariants được runner CỘNG GIẢ 9 PASS nếu exit 0 (không đếm từ log).
- SKIP theo cấu hình: `hardening-e2e` bỏ ca rate limit nếu `RATE_LIMIT_AUTH_PER_MINUTE>40`. Runner không đếm SKIP; chỉ có dòng log "(bỏ qua ...)".

## 3. Full suite theo backend (KHÔNG cộng lẫn)
Lượt đầu (SQLite, thiếu `BASE_URL`) ĐỎ: xem F1, giữ log `attempt0-*`. Hai lượt dưới là sau khi thêm `BASE_URL`.

| | SQLite | PostgreSQL |
|---|---|---|
| Lệnh | `node --env-file=.env.test scripts/run-suite.js` (DB_PATH như trên) | như trái, với DATABASE_URL như trên |
| Thời gian | 15:54:25-16:00:38 | 16:04:08-16:08:50 |
| Exit | 0 | 0 |
| Mục chạy | 26 (24 bộ + rollback + check-invariants) | 26 |
| PASS/FAIL do runner báo | 1006 / 0 | 997 / 0 |
| Trong đó assertion đếm từ log | 997 | 988 |
| Cộng giả 9 của check-invariants | 9 | 9 |
| SKIP | hardening: 4 ca rate limit (cấu hình 1000) | như trái; thêm topup-idempotency: khối "nâng cấp CSDL cũ" bị bỏ trên PG (log tự nêu) |

Theo bộ (SQLite / PG): count-marks-unit 14/14, invariants-unit 39/39, e2e 39/39, market 63/63, security 38/38, hybrid 53/53, hardening 23/23 (đã bỏ rate limit), payment 40/40, reconcile 65/65, counter 30/30, cleanup 13/13, notification 44/44, checkout 19/19, dispute-race 29/29, security-report-regression 47/47, username-enumeration 12/12, listing-lifecycle 70/70, passkey-registration-race 41/41, topup-concurrency 43/43, **manual-transaction-amount 46/43**, **topup-idempotency 82/76**, payment-provider-isolation 16/16, paypal-integration 52/52, admin-provenance 69/69, rollback 10/10 (FAULT_INJECT), check-invariants 9/9 (giả). Mọi bộ 0 FAIL.

## 4. Đối chiếu bộ đếm và chênh lệch SQLite/PG
- `npm run test:count-marks` (test/count-marks-unit.js): exit 0, 14 PASS.
- Tính lại độc lập từ log từng bộ bằng chính `countMarks`: khớp 100% summary.json của cả 4 lượt (0 bộ lệch). Mỗi bộ có đúng 1 dòng ✅ thừa ở dòng "=== KẾT QUẢ" (15 bộ), đã được loại đúng.
- Chênh 1006 - 997 = 9, truy bằng diff dòng ✅ giữa hai log:
  - manual-transaction-amount (PG ít 3): 3 dòng chỉ có ở SQLite, "1000 / 2000000 / 100000000: SQLite lưu kiểu integer (thực tế integer)".
  - topup-idempotency (PG ít 6): 6 dòng chỉ SQLite trong khối nâng cấp CSDL cũ ("Khởi động trên CSDL cũ không lỗi", "Đủ các cột mới sau nâng cấp", "Yêu cầu cũ PENDING giữ nguyên...", "Yêu cầu cũ đã tất toán giữ nguyên", "Nhiều yêu cầu không có khoá (NULL)...", "Cùng người dùng + cùng khoá bị chỉ mục duy nhất chặn"); log PG ghi "(bỏ qua trên PostgreSQL: nâng cấp PostgreSQL được kiểm bằng migration v3 trên CSDL thử nghiệm riêng)". Kiểm riêng đó tôi chưa chạy (mục 9).
  - Các bộ còn lại bằng nhau.

## 5. Chín bất biến
`scripts/check-invariants.js` cuối runner: 9/9 ĐÚNG trên SQLite và PG (exit 0). Chạy lại độc lập sau các bộ PayPal: exit 0, "Không có vi phạm nào" (`sqlite-check-invariants.log`, `pg-check-invariants.log`). Định nghĩa không đổi. invariants-unit 39/39 cả hai.

## 6. Kiểm tra PayPal
| Kiểm tra | SQLite | PG |
|---|---|---|
| paypal-integration-e2e (trong suite) | 52/52 | 52/52 |
| payment-provider-isolation-e2e (trong suite) | 16/16 | 16/16 |
| `test:paypal-modules` (node --test, 5 file, không DB) | exit 0 | không phụ thuộc DB |
| paypal-store-concurrency | exit 0 (chế độ SQLite) | exit 0 (`--pg`, DB `enclave_pro_release_store_test`): 4 chế độ sqlite/pg x migration/proposed, mỗi chế độ 106 đạt, 0 hỏng, "ALL PASS" (106 là số của từng chế độ, không phải tổng; 4 chế độ nằm ở hai log: chế độ sqlite trong `sqlite-paypal-store.log`, cả bốn trong `pg-paypal-store-concurrency.log`) |
| paypal-binding-migration | exit 0 | exit 0 (`--pg`, DB `enclave_pro_release_migration_test`): 9 kiểm, migration 1..6 áp đúng thứ tự một lần |
| paypal-evidence-upgrade | exit 0 | exit 0 (`--pg`, DB `enclave_pro_release_evidence_test`; lượt chạy gồm SQLite và PG): 12 upgrade checks passed (gộp 6 SQLite + 6 PG, không tách trong log) |
| paypal-m2-settlement | exit 0 | exit 0 |
| paypal-m2-api | exit 0 | exit 0 |
| paypal-m2-recovery | ĐỎ ngắt quãng (F2) | đỏ 2/3 lần, xanh 1/3 |

m2-api/settlement in cảnh báo stderr `[paypal-report] ... LOG_FAIL/NOTIFY_FAIL` (ca kiểm "lỗi sau khi tất toán", assertion vẫn xanh) và DeprecationWarning của pg trên PG.

## 7. Rate limit / hardening riêng (không cộng vào tổng)
`run-suite.js --only=hardening-e2e` với `RATE_LIMIT_AUTH_PER_MINUTE=10`, DB mới mỗi nền: SQLite 27/27 PASS, PG 27/27 PASS; check-invariants 9/9 mỗi nền; exit 0. Không còn dòng "bỏ qua". 27 - 23 = 4 ca rate limit (401 trước trần, 429 sau trần, Retry-After, tuyến khác vẫn đi được). 23 phép kiểm còn lại trùng full suite nên không cộng. "36" trong console = 27 + 9 giả.

## 8. Finding
- **F1 (cấu hình, sau)**: thiếu `BASE_URL` trong `.env.test` thì các e2e mặc định `http://localhost:3000` trong khi runner dựng server ở `PORT`; 21/24 bộ + rollback đỏ `ECONNREFUSED` (log `attempt0-*`; 74 "PASS" của lượt đó = 14 + 39 + 12 (ba bộ không cần server hoặc chỉ cần hạ tầng) + 9 PASS cộng cứng của check-invariants, tức 65 phép kiểm thật). Tái hiện: `.env.test` không BASE_URL, PORT=3910. Đề xuất Codex: ghi vào README/.env.example, hoặc test suy BASE_URL từ PORT, hoặc runner truyền BASE_URL cho tiến trình con. Không phải lỗi sản phẩm. Không còn log từng bộ của lượt đỏ đầu, chỉ có console + summary (`attempt0-sqlite-console-no-BASE_URL.log`, `attempt0-summary.md`).
- **F2 (đã định vị, cần Codex vá helper; nghiêng về lỗi harness Windows, không có chứng cứ lỗi logic phục hồi sản phẩm)**: `m2-recovery` không ổn định trên máy này khi chạy trong thư mục Downloads. `test/paypal-m2-recovery-e2e.js` không nằm trong `test:suite` nhưng nằm trong `test:paypal-m2`. Tôi quan sát (giữ đủ log): SQLite 7/8 lần đỏ, PG 2/3 lần đỏ; kiểu lỗi: EPERM `rmdirSync(...paypal-m2-recovery-state.json.lock)` tại `test/helpers/paypal-m2-fake.js:98`, `child exited before durable POST barrier` (PAYPAL_UNAVAILABLE), `B acquired only after A released`.
  - Các lượt đỏ dừng sớm ở R3/R4 (hoặc ở ca lock-regression) nên KHÔNG phủ các assertion phục hồi phía sau điểm dừng. Nguyên nhân tiến trình con thoát sớm là suy luận (chưa có stack). Tài liệu cũ chỉ ghi một lần lỗi; số liệu mới (nhiều lượt đỏ) mâu thuẫn với ghi chép đó.
  - Pro kiểm độc lập (log thí nghiệm: `cho-an-tam/test/evidence/pro-release/backend/f2-pro-independent/`, có `README.md` kèm bảng, 60 tệp log): (a) helper gốc trong worktree (đường dẫn `Downloadsđồ án...`) đỏ 5/5; (b) cùng mã, bản sao ASCII tại `C:Users	ranqDownloadszz-f2-probe` đỏ 4/4; (c) cùng mã tại `AppDataLocalTemp`: đường dẫn ASCII 6/6 và không-ASCII 4/4 xanh 47/47, nên vị trí quyết định chứ không phải ký tự "đồ án" hay thư mục Downloads; (d) vá một dòng, dòng 98 đổi `fs.rmdirSync(lockPath)` thành `retrySharing(()=>fs.rmdirSync(lockPath))` (đồng bộ với dòng 107/108/118): bản sao trong Downloads xanh 5/5 (47/47), bản sao Temp 6/6.
  - Kết luận đúng mức: nguyên nhân gần là lỗi chia sẻ tệp tạm thời (EPERM) ở dòng 98 không đi qua `retrySharing`, xuất hiện khi thư mục nằm ở vị trí bị quét/lập chỉ mục (Defender realtime đang bật, chưa chứng minh là tác nhân). n nhỏ, một máy. Helper trong worktree KHÔNG bị sửa; đề xuất Codex áp dụng bản vá một dòng. Chưa chạy lại trên Linux.
- **F3 (đã biết, không kiểm)**: bản vá chặn tạo top-up mock khi mock tắt chưa nằm trong hash này.
- **F4 (ghi chú)**: tổng runner 1006/997 gồm 9 PASS giả của check-invariants; tách ra khi trích dẫn số assertion.
- **F5 (ghi chú)**: topup-idempotency bỏ ca nâng cấp CSDL cũ trên PG, dựa vào kiểm riêng.

## 9. CHƯA CHẠY
- Không còn mục PG nào chưa chạy trong nhóm PayPal store/migration/evidence-upgrade (xem mục 6; số riêng, không cộng vào tổng full suite).
- Không đo PayPal Sandbox thật, cookie HTTPS, Windows Hello/passkey thật, trình duyệt.

## 10. Dọn tài nguyên và giới hạn
- Không còn server cổng 3910; khoá `pro-release-heavy.lock` đã nhả; không còn process node của tôi (node.exe còn lại thuộc người khác). Dữ liệu còn lại: `data/test/*` (gitignored) và schema `app/mock_provider` trong `enclave_pro_release_test`. `reports/` và `.env.test` không commit; bản sao summary/log đã quét nằm trong evidence.
- Giới hạn: Windows + Node 26 + PG 17 cục bộ; PayPal chỉ là fake transport; không chứng minh Sandbox thật, cookie HTTPS, Windows Hello. Không commit/push.
