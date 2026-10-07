# Pro: hủy ý định nạp PayPal bị bỏ dở (F-03), backend và kiểm chứng

Ngày 07/10/2026. Chỉ backend. Không sửa `public/`, schema/migration, adapter, `package.json`, lockfile, `run-suite.js`. Không đăng nhập PayPal/Railway, không dùng secret, không dùng DB production. Không merge/deploy. Fixture không phải bằng chứng Sandbox thật.

- Repository: https://github.com/Zunzx0/escrow-passkey-c2c.git
- Base: `d7929d72abcd47af4613e4b588b6839857155642` (`codex/payment-provider-isolation`, trùng đầu nhánh lúc fetch). Nhánh Pro: `claude/paypal-abandon-request`. Compare vào `codex/payment-provider-isolation`.
- Ba agent cấp 3 (backend, kiểm thử, review an toàn độc lập); Pro đối chiếu hợp đồng với mã nền trước khi cho viết code, tự đọc diff, tự chạy mutation và lượt kiểm tra ghép.

## 1. Hợp đồng API để Codex tích hợp UI

`POST /api/payments/paypal/:id/abandon` — chủ ví chủ động bỏ ý định CHƯA gửi thu tiền. Không phải hoàn tiền, không hủy order ở PayPal (link phê duyệt đã mở trước đó vẫn dùng được ở PayPal, nhưng server không bao giờ capture sau khi request FAILED), không chạm ví/sổ cái.

**Yêu cầu**
- Header phiên như các route ví PayPal; quyền BUYER hoặc SELLER (ADMIN bị từ chối); rate limit ghi 10 lần/phút/IP.
- Body PHẢI rỗng (không gửi body hoặc `{}`). Mọi khoá (kể cả `userId`, `status`, `evidence`, `actor`), mảng hay chuỗi → `400 VALIDATION_ERROR`, trạng thái không đổi. Owner lấy từ phiên.
- `:id` là id request (cùng id dùng ở `/:id/checkout` và `/:id/capture`).

**Thành công — HTTP 200**: payment DTO hiện có (cùng shape `serializePayPal`) cộng một trường `outcome`:

| `outcome` | Ý nghĩa | DTO |
| --- | --- | --- |
| `ABANDONED` | Lần này đóng thành công | `status:'FAILED'`, `stage:'FAILED'`, `approvalUrl:null`, `resolvedAt` có giá trị, ví/sổ cái không đổi |
| `ALREADY_ABANDONED` | Request đã được CHÍNH endpoint này đóng trước đó (replay hoặc hai lần bấm song song; bên thua đọc lại) | cùng DTO FAILED, không tạo dữ liệu/audit mới |

**Lỗi**

| HTTP | `error` | Khi nào | Trạng thái |
| --- | --- | --- | --- |
| 400 | `VALIDATION_ERROR` | body không rỗng | không đổi |
| 401 | (xác thực) | thiếu/hết hạn token | không đổi |
| 403 | `FORBIDDEN` | không phải chủ request, hoặc vai trò không được (ADMIN) | không đổi |
| 404 | `PAYMENT_REQUEST_NOT_FOUND` | id không phải request PayPal | không đổi |
| 409 | `PAYPAL_ABANDON_UNSAFE` | không thể bỏ an toàn: chưa bind order/create mơ hồ, đã có dấu POST capture hoặc claim, capture IN_FLIGHT/UNKNOWN/VERIFIED/NOT_CAPTURED/RECOVERY_REQUIRED, SUCCEEDED, FAILED vì lý do khác, order PayPal có capture hoặc trạng thái không thuộc nhóm chưa thu | không đổi; giữ requestId và chờ đối soát |
| 409 | `PAYPAL_ORDER_MISMATCH` | bằng chứng PayPal không khớp (order/request/số tiền/merchant) | không đổi |
| 429 | rate limit | quá 10 lần/phút/IP | không đổi |
| 503 | `PAYPAL_DISABLED` | PayPal Sandbox chưa bật/đủ cấu hình | không đổi |
| 5xx | lỗi provider đã được làm sạch (`Chưa xác nhận được kết quả PayPal...`) hoặc lỗi nội bộ | timeout/lỗi GET order, lỗi ghi audit | không đổi (request vẫn PENDING) |

Mọi lỗi từ chối không đóng request; không có đường catch-all coi lỗi là thành công.

**Hành vi UI cần biết**
- Sau `ABANDONED`/`ALREADY_ABANDONED`, request cũ hiện trong lịch sử/chi tiết với `stage:'FAILED'`. Dùng lại requestId cũ ở `POST /topup` KHÔNG tạo order mới (trả lại request FAILED cũ): ý định nạp mới PHẢI có `requestId` mới.
- DTO không có trường lý do đóng: `resolvedBy` vẫn là `'RECONCILER'` (schema chỉ cho `WEBHOOK`/`RECONCILER`) nên UI KHÔNG thể dùng nó để phân biệt "bỏ dở" với "đối soát đóng". Phân biệt bằng `outcome` của chính phản hồi abandon; nếu cần hiển thị lâu dài cho request cũ, cần một trường mới (đề xuất ở mục 7).
- Callback `?paypal=cancel` vẫn chỉ GET: không tự abandon. Nút "Bỏ ý định" phải là hành động riêng của người dùng, nên kèm giải thích rằng PayPal không bị hủy và không hoàn tiền.
- Hạn mức pending/ngày được giải phóng bởi cập nhật status như policy hiện có.

## 2. Cách nhận biết audit và provenance

Thành công ghi MỘT hàng `security_events` TRONG CÙNG transaction đóng request (INSERT lỗi thì rollback toàn bộ, API trả 5xx, request vẫn PENDING; không dùng `logSecurityEvent` vì hàm đó nuốt lỗi và chạy ngoài transaction):

| Cột | Giá trị |
| --- | --- |
| `event_type` | `PAYPAL_REQUEST_ABANDONED` |
| `outcome` | `ALLOWED` |
| `actor_id` | id chủ request (lấy từ phiên/DB, không từ body) |
| `username`, `ip`, `method`, `route`, `status_code` | từ request Express của chủ ví, `status_code` = 200 |
| `detail` (JSON qua `sanitize`) | `{"action":"ABANDON","reason":"USER_ABANDONED","source":"OWNER","paymentRequestId":"<id>","amount":<VND>}` |

Truy vấn nhận biết, ví dụ: `SELECT * FROM security_events WHERE event_type='PAYPAL_REQUEST_ABANDONED' AND detail LIKE '%"paymentRequestId":"<id>"%'`. Các lần bị từ chối (409 `PAYPAL_ABANDON_UNSAFE`) ghi best-effort một hàng `INVALID_STATE` (không phải audit của lần đóng).

Provenance trên `payment_requests` của request đã bỏ: `status='FAILED'`, `resolved_by='RECONCILER'` (bị CHECK schema, không đổi enum/migration trong PR này), `last_reconcile_error='USER_ABANDONED'` (chỉ để tham khảo, có thể bị đối soát ghi đè nên KHÔNG dùng làm bằng chứng). **Nguồn thẩm quyền** để biết "do endpoint abandon đóng, bởi ai, lúc nào": hàng audit atomic ở trên; chủ là `payment_requests.user_id` (endpoint chỉ cho chủ). Replay (`ALREADY_ABANDONED`) chỉ dựa vào request FAILED + hàng audit này. Giới hạn: nếu bảng `security_events` bị dọn thì replay thành 409 `PAYPAL_ABANDON_UNSAFE` (an toàn, request vẫn FAILED); code nền không có chính sách giữ/dọn `security_events`.

Capture COMPLETED thật xuất hiện SAU khi đã FAILED: đường store hiện có (webhook/GET xác minh) lưu `RECOVERY_REQUIRED` + capture_id, không credit ví, không rollback bằng chứng (đã có test).

## 3. Cách hoạt động (chống race, không giữ transaction qua mạng)

1. Kiểm cục bộ (không gọi provider nếu đã không an toàn): PENDING, đã có order, `capture.state==='READY'`, chưa có dấu POST, không claim.
2. GET order fresh bằng adapter thật, kiểm identity/request/số tiền như hiện tại; chỉ chấp nhận `status==='PENDING'`, không `captureId`, `orderStatus` ∈ {CREATED, SAVED, APPROVED, PAYER_ACTION_REQUIRED, VOIDED}.
3. `closeUncaptured` trong một transaction ngắn: recheck atomic PENDING + READY + chưa POST + không claim + `onlyNeverPosted` + `order_id` khớp order đã GET, UPDATE sang FAILED và INSERT audit cùng transaction.
4. `claimCapture` và `markCapturePostSent` đều kiểm `payment_requests.status='PENDING'` trong chính câu UPDATE; mọi transaction đi qua mutex SQLite hoặc `pg_advisory_xact_lock` PostgreSQL (READ COMMITTED), nên close và claim không thể xen kẽ: một bên thắng. Close thắng thì capture sau đó nhận `CLOSED` và provider không nhận POST nào.

## 4. Danh sách tệp thay đổi

Sửa: `cho-an-tam/src/routes/paypal.js`, `cho-an-tam/src/lib/paypalRuntime.js`, `cho-an-tam/src/lib/paypalPaymentStore.js`, `cho-an-tam/src/lib/securityEvents.js`.
Mới: `cho-an-tam/src/lib/paypalAbandonment.js`, `cho-an-tam/test/paypal-abandonment-e2e.js`.
Báo cáo: `PRO-PAYPAL-ABANDONMENT-REPORT.md` (tệp này), `PRO-PAYPAL-ABANDONMENT-BACKEND-NOTES.md`, `PRO-PAYPAL-ABANDONMENT-TEST-REPORT.md`, `PRO-PAYPAL-ABANDONMENT-SAFETY-REVIEW.md`.
Bằng chứng: `cho-an-tam/test/evidence/pro-abandon/` (log lọc bí mật, summary suite, log lượt đỏ/xanh của agent và mutation; quét bí mật 0 khớp). Lưu ý: `cho-an-tam/.gitignore` có quy tắc `*.log` nên các tệp `.log` trong thư mục này được thêm bằng `git add -f` (không sửa `.gitignore`); nếu công cụ khác clone/checkout và lọc theo ignore thì cần giữ ý này.
Không đụng: `public/`, schema/migration, adapter, `paypalCaptureCoordinator.js`, `reconciler.js`, `package.json`, lockfile, `scripts/run-suite.js`.

Thay đổi trong `closeUncaptured`: thêm tham số tuỳ chọn `audit`, `onlyNeverPosted`, `expectedOrderId`, MẶC ĐỊNH giữ hành vi cũ (caller cũ/test cũ không đổi: reason `ORDER_EXPIRED`/`ORDER_VOIDED`, `resolved_by='RECONCILER'`, vẫn chấp nhận `NOT_CAPTURED`). `securityEvents.js` thêm `PAYPAL_REQUEST_ABANDONED`, ánh xạ `PAYPAL_ABANDON_UNSAFE`→`INVALID_STATE`, export `buildSecurityEventInsert` và `INSERT_SQL`; `logSecurityEvent` dùng lại helper, hành vi cũ không đổi.

## 5. Kết quả kiểm chứng (từng loại riêng, không cộng lẫn)

Cây nguồn/test đã băng (6 tệp, hash trong `_tree-hashes.txt`) không đổi giữa lượt chạy và commit. Node v26.4.0, Windows 11, PostgreSQL 17.11 riêng ở `127.0.0.1:55432`. Log: `test/evidence/pro-abandon/`.

| Lượt (chạy bởi Pro, trên bản ghép) | Kết quả | Exit |
| --- | --- | --- |
| Full suite SQLite (`run-suite.js`, 26 mục) | 1006 PASS / 0 FAIL | 0 |
| Full suite PostgreSQL (`enclave_pro_abandon_full_test`, 26 mục) | 997 PASS / 0 FAIL | 0 |
| 9 bất biến tài chính (bước cuối runner) | đúng trên cả hai nền; chạy độc lập `check-invariants.js` sau suite: "Không có vi phạm nào trên 9 bất biến" trên SQLite và PostgreSQL | 0 |
| `paypal-abandonment-e2e` (SQLite / PostgreSQL) | 274 / 274 đạt, 0 hỏng mỗi nền (C1…C11), kèm C9: bất biến tài chính (9) và PayPal đúng sau toàn bộ kịch bản | 0 / 0 |
| `paypal-history-isolation` (hồi quy F-05, SQLite / PG) | 27 / 27 mỗi nền | 0 / 0 |
| `node --test` module PayPal (adapter, service, coordinator, payer-action x2, fake-sharing) | 53 pass, 0 fail, 0 skip | 0 |
| M2 HTTP / settlement / recovery (SQLite) | 67 / 85 / 47 đạt, 0 hỏng | 0 |
| M2 HTTP / settlement / recovery (PostgreSQL) | 67 / 85 / 47 đạt, 0 hỏng | 0 |
| `paypal-store-concurrency` (SQLite + `--pg`, 4 chế độ, 106 mỗi chế độ) | ALL PASS | 0 |
| `paypal-binding-migration` (`--pg`) / `paypal-evidence-upgrade` (`--pg`, gồm SQLite) | 9 kiểm / 12 kiểm (gộp 6 + 6) | 0 / 0 |
| `test:count-marks` | ALL PASS | 0 |

Lưu ý khi trích số: runner cộng cứng 9 PASS cho `check-invariants`; số assertion thật là 997 (SQLite) và 988 (PostgreSQL). Chênh 9 giữa hai nền nằm ở `manual-transaction-amount` (-3) và `topup-idempotency` (-6) như đã truy ở lượt trước. Skips: không có.

**Lượt đỏ do origin sai — giữ nguyên làm lịch sử.** Lần chạy full suite đầu cho SQLite 1000 PASS / 6 FAIL và PostgreSQL 991 PASS / 6 FAIL (`sqlite-full-suite.log`, `pg-full-suite.log`, `reports/suite-2026-10-07T13-09-40-880Z`, `...13-10-50-590Z`). Cả sáu assert đỏ nằm ở bộ `e2e`, khâu cấp phiếu phân xử bằng Passkey, và log server ghi "Unexpected authentication response origin". Nguyên nhân: `.env.test` đặt `WEBAUTHN_ORIGIN=http://localhost:3910` nhưng Pro chạy suite ở cổng 3930/3931. Đây là lỗi cấu hình chạy của Pro, không phải lỗi sản phẩm hay của PR. Chạy lại với `WEBAUTHN_ORIGIN` khớp cổng (`*-rerun1.log`) cho kết quả xanh ở bảng trên. Bài học cho tái lập: `WEBAUTHN_ORIGIN` phải khớp cổng suite.

**Đỏ/xanh của test mới (lượt do agent kiểm thử chạy, log trong `agent-and-mutation-logs/`):**
- Trên bản nền nguyên vẹn: 122 đạt / 108 hỏng ở lượt đầu. Chỉ C1 (quota 5 PENDING không có cách giải phóng) tái hiện đúng lỗi cũ; các ca khác đỏ vì tính năng chưa có (route trả 404). Các assert "không đổi/không audit/không gọi provider" đạt ở nền chỉ vì 404, không phải bằng chứng lỗi cũ. C4d/C4e/C11 viết sau lượt đỏ nên chưa có lượt đỏ riêng.
- Lượt xanh 1 (trước quyết định replay): 240 đạt, 1 hỏng (C10/S3). Lượt xanh 2: 249/249. Lượt xanh 3: 274/274 mỗi nền.

**Mutation do Pro tự chạy** (từng mutation riêng biệt trên bản sao, SQLite, mỗi lần từ mã sạch; bản sao không mutation xanh):
- Bị bắt đúng assert: bỏ kiểm `captureId`; bỏ kiểm owner; bỏ `emptyBody`; bỏ kiểm cục bộ POST/claim trước GET; audit nuốt lỗi; replay dựa vào cột `last_reconcile_error`; `closeUncaptured` bỏ kiểm claim; bỏ `EXISTS status` ở `markCapturePostSent`.
- KHÔNG bị bắt, mutant tương đương về hành vi qua API công khai (phòng thủ chiều sâu bị tầng kiểm trước che): `onlyNeverPosted` ở phía gọi (NOT_CAPTURED đã bị kiểm `capture.state==='READY'` chặn), `expectedOrderId` ở phía gọi (`order_id` bất biến), `EXISTS status` trong UPDATE của `claimCapture` (nhánh `CLOSED` cùng transaction chặn trước, không tới được qua API store). Ghi rõ, không báo là đã phủ. Ở mức store, `onlyNeverPosted`/`expectedOrderId`/READY còn claim được kiểm trực tiếp ở C11.

## 6. Ca kiểm thử (tóm tắt)

C1 quota 5 PENDING rồi abandon một và tạo mới được (số dư và sổ cái không đổi); C2 auth/role/owner/body; C3 provider không cho đóng (timeout, mismatch, order lạ, có captureId, capture PENDING) và từng trạng thái capture/dấu POST/claim; C4 race bằng barrier thật (abandon giữ sau GET, capture giành claim và POST treo rồi mới thả close; hai abandon song song; capture claim chưa POST; capture claim rồi trả READY); C5 replay và key cũ không tạo order mới; C6 capture muộn sau close lưu `RECOVERY_REQUIRED`, không credit; C7 audit actor/atomic (ép INSERT audit lỗi bằng trigger test-only: API 5xx, request vẫn PENDING); C8 lịch sử/`/me` không gọi provider/detail-checkout-capture giữ xác minh fresh; C9 chín bất biến và bất biến PayPal; C10 hồi quy caller cũ; C11 guard store gọi trực tiếp.

## 7. Giới hạn đã biết và đề xuất cho Codex (không làm trong PR này)

1. Worker đối soát quét LÔ chỉ lấy request FAILED đã POST (`reconciler.js` ~dòng 196) nên capture muộn sau abandon (không thể xảy ra nếu server không POST, nhưng nếu xảy ra ngoài luồng) chỉ lộ qua webhook/GET xác minh/đường quét theo id (`scripts/reconcile.js --id`, ~dòng 195), không qua worker lô.
2. Request `UNKNOWN` + `PAYPAL_PAYER_ACTION_REQUIRED` chưa từng POST (người dùng bấm xác nhận trước khi phê duyệt) chưa abandon được ở bản tối thiểu (409). Có thể mở rộng sau với bằng chứng chưa POST.
3. DTO chưa có trường lý do đóng; `resolvedBy` vẫn `RECONCILER`. Nếu UI cần phân biệt lâu dài, cân nhắc thêm trường lý do/`closedBy` vào DTO hoặc cột/enum bền (cần schema, ngoài PR này).
4. Vòng tạo rồi abandon liên tục chỉ bị rate limit theo IP (10 lần/phút): mỗi vòng tốn một lần tạo order và một lần GET ở PayPal; hạn mức pending/ngày được giải phóng đúng như policy hiện có. Mức thấp.
5. Replay phụ thuộc hàng audit; không có chính sách giữ/dọn `security_events` trong code nền.
6. Tính nối tiếp claim/close dựa vào mutex SQLite / `pg_advisory_xact_lock` và isolation READ COMMITTED (test ghi nhận `transaction_isolation=read committed` trên PostgreSQL).
7. Chưa kiểm chứng với PayPal Sandbox thật: hành vi order sau abandon (link phê duyệt cũ còn mở được; server không capture) và `orderStatus` thật; cần trong nghiệm thu Sandbox của Codex.
8. C4b2 (8 lần song song, không barrier) chỉ là bổ trợ; hai fixture DB ở C3c chỉ chạm tiền kiểm; C3a mã lỗi provider-lỗi chỉ assert không 2xx ở một vài ca đã ghi trong báo cáo test.

**Dòng đề xuất đăng ký test (Codex thêm vào `package.json`, Pro không sửa manifest):**
`"test:paypal-abandonment": "node --env-file=.env.test test/paypal-abandonment-e2e.js"` (SQLite với `DB_PATH=data/test/<tên>.db`; PostgreSQL với `DATABASE_URL=postgresql://.../<tên>_test`). Test tự reset DB riêng, KHÔNG đăng ký vào `run-suite` dùng chung DB; cần `APP_ENV=test`.

## 8. Tài nguyên đã dọn

Cluster PostgreSQL riêng (cổng 55432) tắt khi bàn giao; khoá hàng đợi và server test (3930/3931) không còn; không còn tiến trình runner/node của lượt này. `.env.test`, `reports/`, `data/test/*` còn trong worktree nhưng gitignore, không commit. Thư mục thăm dò nằm ở scratchpad (có junction `node_modules`, không xoá đệ quy). Cluster của Codex (54338) và PostgreSQL hệ thống (5432) không bị đụng.
