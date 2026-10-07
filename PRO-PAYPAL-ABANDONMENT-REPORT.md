# Pro: hủy ý định nạp PayPal bị bỏ dở (F-03), backend và kiểm chứng

Ngày 07/10/2026. Chỉ backend. Không sửa `public/`, schema/migration, adapter, `package.json`, lockfile, `run-suite.js`. Không đăng nhập PayPal/Railway, không dùng secret, không dùng DB production. Không merge/deploy. Fixture không phải bằng chứng Sandbox thật.

- Repository: https://github.com/Zunzx0/escrow-passkey-c2c.git
- Base: `d7929d72abcd47af4613e4b588b6839857155642` (`codex/payment-provider-isolation`, trùng đầu nhánh lúc fetch). Nhánh Pro: `claude/paypal-abandon-request`. Compare vào `codex/payment-provider-isolation`.
- Ba agent cấp 3 (backend, kiểm thử, review an toàn độc lập); Pro đối chiếu hợp đồng với mã nền trước khi cho viết code, tự đọc diff, tự chạy mutation và lượt kiểm tra ghép.

## 0. Vòng R2 theo phản hồi của Codex tại `5e25f57`

Giữ nhánh `claude/paypal-abandon-request`, chỉ thêm commit (không force-push). Chỉ backend, test và báo cáo; không đụng `public/`, adapter, schema, migration, `package.json`, `run-suite.js`. Phạm vi mở rộng được cho phép: `src/lib/reconciler.js` (chỉ nhánh PayPal; đường MOCK không đổi). Kết quả PostgreSQL ở đây là kết quả tự chạy của Pro, không phải của Codex. Ba agent cấp 3 (backend, kiểm thử, review an toàn độc lập) đã làm hai vòng đọc/ghi riêng; Pro đọc diff, tự chạy mutation và chạy bản ghép.

**0.1 Thu tiền muộn sau abandon khi mất webhook (điểm 1).** Truy vấn lô của worker từng bỏ qua request FAILED chưa có `capture_post_sent_at`; ca C6 chỉ gọi `reconcileOne(id)` nên không chứng minh đường lô. R2 thêm MỘT truy vấn thứ hai ngay sau truy vấn lô cũ (không đổi truy vấn cũ), chỉ khi KHÔNG truyền `paymentRequestId`:
- Chọn request `PAYPAL_SANDBOX`, `FAILED`, đã bind order, `capture_post_sent_at IS NULL`, `capture_state='READY'`, `recovery_required_at IS NULL`, `created_at > now - WINDOW`, và (`last_reconciled_at IS NULL` hoặc `<= now - RESCAN`), xếp theo `COALESCE(last_reconciled_at, created_at)` tăng dần, `LIMIT SHARE`.
- Tham số (env, số nguyên dương có chặn trên, sai thì dùng mặc định): `PAYPAL_ABANDONED_SCAN_WINDOW_HOURS`=72, `PAYPAL_ABANDONED_RESCAN_SECONDS`=900, `SHARE = max(1, floor(limit/5))`.
- Công bằng: hạn mức `SHARE` CỘNG THÊM ngoài hạn mức của truy vấn PENDING cũ (tổng PayPal ≤ limit + SHARE), hai tập rời nhau, nên dòng đã đóng không chiếm được lượt của PENDING hay của FAILED-đã-POST. Test C16 dựng đúng trường hợp PENDING chiếm hết `limit`: chỉ `limit` dòng PENDING cũ nhất được quét cộng đúng `SHARE` dòng abandon.
- Không quét lặp vô hạn: dòng nào `reconcileOne` thấy capture COMPLETED sẽ được store ghi `RECOVERY_REQUIRED` + capture ID + `recovery_required_at` và tự rời tập quét; request VẪN `FAILED`, không credit ví/sổ cái, không mở lại. Dòng mà PayPal luôn trả PENDING bị chặn bởi cửa sổ và giãn cách (tối đa 72h/900s = 288 lần GET mỗi dòng).
- Nhóm này không gọi `clearError` (giữ `USER_ABANDONED` tham khảo); khi quét LỖI vẫn `recordError` nên cột có thể bị ghi đè bằng mã lỗi (vận hành cần thấy lỗi). Replay KHÔNG dựa vào cột này (chỉ dựa vào hàng audit). Nhóm này không áp `minAgeSeconds` vì request đã do chủ ví đóng.
- **Căn cứ cho cửa sổ 72 giờ (cần Codex xác nhận):** tìm kiếm tài liệu chính thức của PayPal cho thấy order ở trạng thái `CREATED` chỉ giữ 3 giờ, có thể gia hạn tối đa 72 giờ, và order đã duyệt mà không capture trong 3 giờ bị tự hoàn; adapter của ta không gia hạn order (`createOrder` không có expiration/PATCH). 72 giờ là cận trên đã ghi tài liệu, tính từ `created_at`; trang tham chiếu API tôi lấy được không chứa đoạn đó nên coi là CHƯA kiểm chứng trên Sandbox. Nếu Codex muốn cửa sổ khác, chỉ cần đặt `PAYPAL_ABANDONED_SCAN_WINDOW_HOURS`.
- Giới hạn còn lại: năng lực quét của nhóm này ≈ `SHARE × 900 / chu kỳ` dòng mỗi lượt; nhiều abandon từ nhiều IP có thể làm chu kỳ quét một dòng vượt 72h thì mất phát hiện. Truy vấn cũ cho FAILED-đã-POST không có cửa sổ thời gian (nợ có sẵn, không thuộc R2).

**0.2 Replay sau RECOVERY_REQUIRED (điểm 2).** `ALREADY_ABANDONED` giờ chỉ trả khi: request FAILED, CÓ hàng audit abandon, và binding đọc LẠI (sau truy vấn audit) có `capture.state` khác `RECOVERY_REQUIRED`/`VERIFIED`, `recoveryRequiredAt` và `captureId` rỗng, và `capture.lastError` không bắt đầu bằng `CONFLICTING_CAPTURE` hay `CAPTURED_AFTER_REQUEST_CLOSED`. Ngược lại trả `409 PAYPAL_ABANDON_UNSAFE`, không ghi gì, giữ nguyên bằng chứng và ví. Áp dụng cho CẢ nhánh FAILED ban đầu LẪN nhánh thua race sau `closeUncaptured`. Khe còn lại: recovery xuất hiện giữa lần đọc binding cuối và lúc trả lời không có transaction bao hai việc; hậu quả chỉ là nội dung DTO trả về (không ghi gì).

**0.3 Kết quả R2** (bản ghép, tuần tự trong cluster riêng, origin khớp cổng; log trong `test/evidence/pro-abandon-r2/`; cây `src/` và `test/` không đổi giữa lượt chạy và commit):

| Lượt | Kết quả | Exit |
| --- | --- | --- |
| Full suite SQLite | 1006 PASS / 0 FAIL (997 assertion thật + 9 runner cộng cho `check-invariants`), 26 mục | 0 |
| Full suite PostgreSQL | 997 PASS / 0 FAIL (988 thật + 9), 26 mục | 0 |
| 9 bất biến tài chính | đúng ở bước cuối mỗi full suite; `check-invariants.js` chạy độc lập sau suite: "Không có vi phạm nào trên 9 bất biến" trên SQLite và PostgreSQL | 0 |
| `paypal-abandonment-e2e` SQLite / PostgreSQL | 394 / 394 đạt, 0 hỏng mỗi nền (C1…C16 + C9 bất biến) | 0 / 0 |
| `paypal-history-isolation` (F-05) SQLite / PG | 27 / 27 | 0 / 0 |
| `node --test` module PayPal (6 tệp) | 53 pass, 0 fail, 0 skip | 0 |
| M2 HTTP / settlement / recovery, SQLite và PG | 67 / 85 / 47 đạt mỗi nền | 0 |
| store-concurrency (SQLite + `--pg`, 4 chế độ × 106) / binding-migration `--pg` / evidence-upgrade `--pg` | ALL PASS / 9 / 12 | 0 |
| `reconcile-e2e` (đường MOCK, trong full suite) | xanh cả hai nền (65 đạt), MOCK không đổi | 0 |

Không có skip. Đỏ/xanh của test mới: trên bản sao nguyên vẹn của `5e25f57` (trước R2) bộ test cuối cho 363 đạt / 31 hỏng (exit 1), tức C12 31/45, C13 18/22, C14 25/30, C15 8/12, C16 7/11; các lượt trung gian và lượt xanh có một assert đỏ (C14(4)) được giữ trong `agent-and-mutation-logs/`. Ca đỏ thật trên HEAD: worker lô không quét dòng FAILED chưa-POST (không thấy thu muộn), replay trả 200 thay vì 409 ở cả ba đường recovery và nhánh thua race, replay với `CONFLICTING_CAPTURE`. Các assert đạt trên HEAD vì chưa có hành vi tương ứng là guard mới, ghi riêng trong báo cáo test. Barrier ở C13(b) là barrier thật (hai abandon cùng đứng sau GET, bên thua bị giữ sau `closed:false`, recovery được lưu TRƯỚC khi thả), không dùng delay.

**Điều chỉnh do Pro quyết:** C14(4) từng kỳ vọng dòng `last_reconciled_at` NULL luôn được quét trước. Pro giữ `ORDER BY COALESCE(last_reconciled_at, created_at)` (cùng quy tắc "chờ lâu nhất đi trước" của truy vấn PENDING hiện có) và sửa kỳ vọng: dòng NULL có `created_at` cũ được quét trước; dòng NULL vừa tạo đứng sau dòng đã quét lâu hơn; SQLite và PostgreSQL cho cùng thứ tự. Đó là sửa kỳ vọng, không phải lỗi sản phẩm; log lượt đỏ giữ nguyên.

**0.4 Mutation do Pro tự chạy cho hành vi R2** (từng mutation riêng biệt trên bản sao, SQLite, mỗi lần từ mã sạch, baseline xanh):
- Bị bắt đúng ca: bỏ cận cửa sổ (C12, C14); bỏ giãn cách (C12, C14); `SHARE = limit` (C12, C16); bỏ `capture_state='READY'` (C14); replay không đọc lại binding (C13); bỏ điều kiện `lastError` (C14); `paymentRequestId` kích hoạt nhóm mới (C15); `clearError` cho nhóm abandon (C15); `ORDER BY` không `COALESCE` (C14); gộp hạn mức làm PENDING bị cắt ở `limit` (C16).
- Khe đã vá trong vòng này: mutation gộp hạn mức (cắt PENDING ở `limit`) ban đầu KHÔNG bị bắt vì ca công bằng chưa bao giờ để PENDING chiếm hết `limit`; sau khi thêm C16, mutation đó đỏ (2 assert).
- Không bị bắt, ghi nhận: bỏ `recovery_required_at IS NULL` (gần như mutant tương đương vì `capture_state='READY'` đã loại các hàng đó); bỏ chặn trùng id (mã thừa vì hai truy vấn rời nhau nhờ `capture_post_sent_at`); đảo thứ tự replay và bỏ riêng `VERIFIED`/`captureId` (dư thừa, mức thấp); C13(b) dựng `createAbandonment` với request giả không qua router (router đã được kiểm ở C2/C5).

**0.5 Tệp thay đổi trong R2:** `cho-an-tam/src/lib/reconciler.js`, `cho-an-tam/src/lib/paypalAbandonment.js`, `cho-an-tam/test/paypal-abandonment-e2e.js`, `PRO-PAYPAL-ABANDONMENT-BACKEND-NOTES.md`, `PRO-PAYPAL-ABANDONMENT-TEST-REPORT.md`, `PRO-PAYPAL-ABANDONMENT-SAFETY-REVIEW.md`, `PRO-PAYPAL-ABANDONMENT-REPORT.md` (tệp này) và `cho-an-tam/test/evidence/pro-abandon-r2/` (các tệp `.log` thêm bằng `git add -f` do quy tắc `*.log` của `.gitignore`). Bằng chứng vòng 1 ở `test/evidence/pro-abandon/` giữ nguyên.

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
| `ALREADY_ABANDONED` | Request đã được CHÍNH endpoint này đóng trước đó (replay hoặc hai lần bấm song song; bên thua đọc lại) VÀ binding đọc lại ngay lúc trả lời chưa có bằng chứng thu tiền (xem mục 0.2) | cùng DTO FAILED, không tạo dữ liệu/audit mới |

**Lỗi**

| HTTP | `error` | Khi nào | Trạng thái |
| --- | --- | --- | --- |
| 400 | `VALIDATION_ERROR` | body không rỗng | không đổi |
| 401 | (xác thực) | thiếu/hết hạn token | không đổi |
| 403 | `FORBIDDEN` | không phải chủ request, hoặc vai trò không được (ADMIN) | không đổi |
| 404 | `PAYMENT_REQUEST_NOT_FOUND` | id không phải request PayPal | không đổi |
| 409 | `PAYPAL_ABANDON_UNSAFE` | không thể bỏ an toàn: chưa bind order/create mơ hồ, đã có dấu POST capture hoặc claim, capture IN_FLIGHT/UNKNOWN/VERIFIED/NOT_CAPTURED/RECOVERY_REQUIRED, SUCCEEDED, FAILED vì lý do khác, FAILED do abandon nhưng đã có bằng chứng thu tiền sau đó (RECOVERY_REQUIRED, VERIFIED, có capture ID, hoặc lỗi capture xung đột `CONFLICTING_CAPTURE`/`CAPTURED_AFTER_REQUEST_CLOSED`), order PayPal có capture hoặc trạng thái không thuộc nhóm chưa thu | không đổi; giữ requestId, bằng chứng và ví nguyên, chờ xử lý thủ công/đối soát |
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

1. (Đã xử lý ở vòng R2, xem mục 0.1.) Từ R2 worker lô quét thêm request đã abandon trong cửa sổ có hạn. Còn lại: request abandon cũ hơn cửa sổ (mặc định 72 giờ tính từ `created_at`) không còn được worker lô quét, chỉ còn webhook, GET xác minh hoặc quét theo id; năng lực quét của nhóm này bị chặn bởi hạn mức riêng và giãn cách (mục 0.1).
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
