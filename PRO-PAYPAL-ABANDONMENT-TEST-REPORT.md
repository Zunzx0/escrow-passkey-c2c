# Báo cáo kiểm thử F-03: POST /api/payments/paypal/:id/abandon

Tác giả: agent cấp 3 số 2 (pro_abandon_tests). Tệp test: `cho-an-tam/test/paypal-abandonment-e2e.js` (không đăng ký vào suite chung). Trạng thái: test đã viết, lượt ĐỎ trên nền nguyên vẹn đã chạy (SQLite + PostgreSQL). Lượt XANH chưa chạy, chờ Pro báo backend sẵn sàng (mục 5 để trống có chủ đích).

## 1. Fixture
- Router PayPal thật (`createPayPalRouter`), runtime thật (`createPayPalRuntime`), store/settlement thật, router `payments` thật cho /me và detail (qua `serializePayPal` như paypal-history-isolation-e2e). Gọi qua HTTP local cổng tự cấp (cổng 0), token và phiên thật từ `H.createAccount`.
- Provider = adapter Sandbox thật (`createSandboxProvider`) + transport giả bền vững `paypal-m2-fake`, bọc thêm: nhật ký mọi lệnh (kind/method/orderId), chèn lỗi GET theo order (timeout/drop/404), giữ POST capture bằng deferred, và barrier sau `getOrder` (deferred, đếm số bên đến). Không dùng delay làm bằng chứng cạnh tranh; chỉ có thăm dò DB để chờ điều kiện.
- Hạn mức nạp mặc định sản phẩm (TOPUP_MAX_PENDING=5) được giữ nguyên trong test này.
- Không mock closeUncaptured. Hai ca dùng fixture DB trực tiếp (ghi rõ): RECOVERY_REQUIRED với request PENDING; READY nhưng còn claim (trạng thái này không đạt được qua đường sản phẩm, chỉ kiểm guard phòng thủ).
- Trigger test-only để ép lỗi INSERT audit: SQLite `RAISE(ABORT)`, PostgreSQL hàm + trigger trong schema app; chỉ cho event_type PAYPAL_REQUEST_ABANDONED, luôn gỡ trong `finally` và gỡ lại đầu ca.
- Mỗi ca có dòng `precond:` assert điều kiện trước khi assert hành vi.

## 2. Lệnh tái lập
```
# SQLite (từ cho-an-tam)
APP_ENV=test DB_PATH=data/test/paypal-abandon.db node test/paypal-abandonment-e2e.js
# PostgreSQL riêng của Pro (DB *_test, schema bị dựng lại)
APP_ENV=test DATABASE_URL='postgresql://postgres@127.0.0.1:55432/enclave_pro_abandon_test?sslmode=disable' node test/paypal-abandonment-e2e.js
```
Cuối log có khối "TÓM TẮT THEO CA" và dòng `RESULT {...}` (JSON số assertion mỗi ca). Exit code 1 nếu có assertion hỏng.
Dòng đề xuất cho Codex đăng ký (nếu muốn): `node test/paypal-abandonment-e2e.js` chạy với DB riêng, SQLite và PG (test tự reset, KHÔNG dùng chung DB suite).

## 3. Danh sách ca và assert chính
| Ca | Nội dung |
|---|---|
| C1 | 5 ý định PayPal PENDING; ý định 6 = 409 TOPUP_LIMIT_EXCEEDED (precond). Abandon một request: 200 FAILED ABANDONED; số dư và số hàng wallet_entries bằng trước; 4 request còn lại PENDING; tạo mới với requestId mới thành công; lại đủ 5 PENDING thì ý định kế bị chặn (hạn mức không nới). |
| C2 | Thiếu token 401; người ngoài 403; ADMIN (có ví, vai trò ADMIN) 403; body có khoá userId/status/evidence/actor/foo/amount/requestId = 400; người ngoài giả userId chủ bị chặn; trạng thái không đổi, không audit; BUYER và SELLER chính chủ 200 ABANDONED; không gửi body vẫn hợp lệ. |
| C3a | Mismatch orderId/reference_id/custom_id/số tiền-quote USD/merchant/currency = 409 PAYPAL_ORDER_MISMATCH; GET timeout (503 PAYPAL_TIMEOUT), lỗi mạng (503 PAYPAL_UNAVAILABLE), order 404 (PAYPAL_API_ERROR, >=500); capture PENDING với order APPROVED/PAYER_ACTION_REQUIRED/VOIDED, capture COMPLETED, order COMPLETED không capture: không 2xx. Mọi trường hợp: snapshot payment_requests+binding y nguyên, không audit, không lệnh ghi (POST/PATCH) tới provider, ví không đổi. |
| C3b | orderStatus CREATED/SAVED/APPROVED/PAYER_ACTION_REQUIRED/VOIDED không capture: 200 ABANDONED stage FAILED, capture READY chưa POST giữ nguyên, 0 POST capture/void/refund, ví và sổ cái không đổi, order phía PayPal không đổi. |
| C3c | 9 trạng thái cục bộ: IN_FLIGHT (có/không POST), UNKNOWN (sau POST/chưa POST), VERIFIED, NOT_CAPTURED, RECOVERY_REQUIRED, READY còn claim, và chưa bind order (create mơ hồ): 409 PAYPAL_ABANDON_UNSAFE, đếm getOrder = 0, snapshot y nguyên, không audit. |
| C4a | Barrier thật: abandon GET xong và đứng sau getOrder; capture HTTP giành claim, ghi dấu POST, POST treo; thả close: 409 PAYPAL_ABANDON_UNSAFE, request vẫn PENDING/IN_FLIGHT, không audit; thả POST: capture APPLIED, đúng 1 POST, 1 credit, +số tiền, SUCCEEDED, không USER_ABANDONED. |
| C4b | Close thắng trước, sau đó capture: outcome CLOSED, 0 POST capture, không credit, ví không đổi, binding READY chưa claim. |
| C4b2 | 8 lần chạy song song abandon \|\| capture: mỗi lần hoặc (abandon 200, capture CLOSED, 0 POST, 0 credit) hoặc (abandon 409 UNSAFE, capture APPLIED, 1 POST, 1 credit); không lẫn. In phân bố. Lưu ý: ca này không có barrier, là kiểm nhất quán ngẫu nhiên, không chứng minh thứ tự. |
| C4c | Hai abandon song song, barrier chờ cả hai GET xong rồi mới thả: cả hai 200, đúng một ABANDONED + một ALREADY_ABANDONED, đúng 1 audit, version +1, 0 POST. |
| C5 | Abandon lại: 200 ALREADY_ABANDONED, snapshot và đếm audit/sổ cái/request/order/POST create y nguyên; requestId cũ gọi /topup: trả request FAILED cũ (cùng id), không order mới (đếm order và POST create), không request mới; FAILED vì ORDER_EXPIRED (closeUncaptured) và vì NOT_CAPTURED/ORDER_VOIDED: 409, không phải ALREADY_ABANDONED, không audit; SUCCEEDED: 409, credit giữ 1. |
| C6 | Sau abandon, PayPal thu muộn (fake): qua webhook thật, reconcileOne (GET), store.markCaptureVerified: outcome RECOVERY_REQUIRED, capture_id đúng, recovery_required_at có, request vẫn FAILED, USER_ABANDONED còn, không credit/ledger; capture HTTP sau đó RECOVERY_REQUIRED không POST thêm; bằng chứng không mất; đối soát lặp không tự credit. (finishCaptureAttempt không dựng được sau close vì không còn claim; đường này đã có trong paypal-m2-settlement T6.) |
| C7 | Đúng 1 hàng security_events PAYPAL_REQUEST_ABANDONED, outcome ALLOWED, actor_id = chủ (từ phiên), detail action=ABANDON, reason=USER_ABANDONED, source=OWNER; payment_requests FAILED, resolved_by=RECONCILER, last_reconcile_error=USER_ABANDONED, user_id=chủ, resolved_at có; audit không chứa token. Nguyên tử: trigger ép INSERT audit lỗi: API 5xx, request vẫn PENDING/READY, snapshot y nguyên, 0 audit, ví không đổi, không lệnh ghi provider; gỡ trigger rồi abandon lại thành ABANDONED với 1 audit. (Nếu backend dùng logSecurityEvent best-effort ngoài transaction, ca này sẽ đỏ và lộ giới hạn đó.) |
| C8 | /me trước/sau abandon: đếm GET provider = 0 (F-05); /me thấy FAILED stage FAILED, và PENDING khác; detail FAILED; checkout giữ xác minh fresh (đúng 1 GET); detail UNKNOWN+payer-action 1 GET; /me UNKNOWN không GET, stage RECONCILING; capture bình thường có GET fresh, 1 POST, APPLIED. |
| C10 | S3: sau abandon, UPDATE last_reconcile_error về NULL/chuỗi khác, rồi reconcileOne: abandon lại vẫn 200 ALREADY_ABANDONED (nguồn bền là security_events), không thêm audit/dữ liệu; FAILED lý do khác không audit (kể cả reason chữ "USER_ABANDONED" do closeUncaptured cũ): 409 PAYPAL_ABANDON_UNSAFE. S2: NOT_CAPTURED PENDING: abandon 409, không GET; closeUncaptured kiểu cũ vẫn đóng NOT_CAPTURED và READY/ORDER_EXPIRED (resolved_by RECONCILER, last_reconcile_error ORDER_EXPIRED), không sinh audit ABANDONED. S5: order_id trong binding là bất biến (trigger) nên KHÔNG dựng được "binding lệch" qua DB; dựng tương đương phía provider (order GET trả id khác): 409, không đóng. S4: sau abandon, claimCapture = CLOSED, markCapturePostSent không ok, không claim/dấu POST/attempts. S8: in `SHOW transaction_isolation` (không assert). |
| C9 | 9 bất biến tài chính (đã kiểm 9) + bất biến PayPal riêng sau toàn bộ kịch bản; không TOPUP_CREDIT nào gắn request FAILED. |

## 4. Lượt ĐỎ trên nền nguyên vẹn (d7929d7, bản sao abandon-base, chưa có backend)
Log thật: `scratchpad/red-sqlite.log`, `scratchpad/red-pg.log` (thư mục scratchpad của phiên). Kết quả giống nhau trên hai DB.

| DB | Exit code | Assertion đạt | Assertion hỏng | Ngoại lệ không bắt |
|---|---|---|---|---|
| SQLite | 1 | 122 | 108 | 0 |
| PostgreSQL (read committed) | 1 | 122 | 108 | 0 |

Mọi precondition không liên quan đến route abandon đều đạt ở nền (không có lỗi dựng fixture): seed trạng thái, 6 ý định bị chặn quota, v.v. Mọi `precond:` hỏng đều có nguyên nhân là `nhận 404` (route chưa có).

**ĐỎ VÌ TÍNH NĂNG CHƯA CÓ (route abandon 404 ở nền)**: tất cả assert cần route abandon. Chỉ C1 là tái hiện một lỗi cũ có thật (quota); các ca còn lại không chứng minh lỗi cũ, chỉ cho thấy tính năng chưa tồn tại. (Lượt đỏ chạy trước khi thêm C4d/C4e/C11 và chỉnh C3a; các ca đó chưa có lượt đỏ riêng.)
- C1: tái hiện lỗi quota cũ. 5 PENDING chặn ý định 6 (precond đạt) và không có cách giải phóng: abandon 404, không tạo mới được sau đó.
- C2 (15 hỏng): 401/403/400/200 của route abandon (nền trả 404).
- C3a: 9 hỏng (mã lỗi 409/503/502 của route abandon); C3b: 10 hỏng; C3c: 9 hỏng (409 PAYPAL_ABANDON_UNSAFE, nền 404).
- C4a (barrier không đạt, abandon không GET), C4b, C4b2, C4c, C5 (6 hỏng), C6 (19 hỏng, mọi precond abandon), C7 (9 hỏng), C8 (3 hỏng), C10 (11 hỏng: S3 ALREADY/409, S2 NOT_CAPTURED 409, S5, S4 precond).

**GUARD MỚI, KHÔNG ÁP DỤNG Ở NỀN (đạt ở nền vì route chưa tồn tại nên không có gì bị đổi; không phải bằng chứng lỗi cũ)**: các assert "không đổi / không audit / không lệnh ghi provider / không GET / ví không đổi" trong C2, C3a (19 đạt), C3c (26 đạt), C5 (11 đạt), C10 (11 đạt), cộng C9 (3/3). Chúng chỉ có ý nghĩa khi lượt xanh chạy với route thật; ở nền chúng trùng hợp đúng vì 404.

**Hồi quy caller cũ (đạt ở nền và PHẢI đạt ở xanh)**: C10 S2 (closeUncaptured kiểu cũ đóng NOT_CAPTURED và ORDER_EXPIRED, không audit), C5 requestId cũ không tạo request mới (một phần), C8 /me không gọi provider (F-05), C9.

## 5. Lượt XANH trên worktree
Chạy sau khi Pro báo backend sẵn sàng (worktree, nhánh claude/paypal-abandon-request, mỗi lượt lấy khoá hàng đợi). Log: `scratchpad/green-sqlite.log`, `scratchpad/green-pg.log`.

| DB | Kết quả | Assertion đạt | Hỏng | Exit code |
|---|---|---|---|---|
| SQLite (data/test/paypal-abandon.db) | FAIL (1 assertion) | 240 | 1 | 1 |
| PostgreSQL enclave_pro_abandon_test (read committed) | FAIL (1 assertion) | 240 | 1 | 1 |

Theo ca (giống nhau trên hai DB): C1 12/12, C2 20/20, C3a 28/28, C3b 25/25, C3c 35/35, C4a 12/12, C4b 7/7, C4b2 1/1, C4c 7/7, C5 17/17, C6 25/25, C7 13/13, C8 14/14, C9 3/3, C10 21/22 PASS/FAIL. Ca 4 dùng barrier đồng thời thật (C4a: abandon giữ sau GET, capture giành claim và POST treo rồi mới thả close; C4c: hai abandon cùng đứng sau GET rồi mới thả); precond xác nhận trạng thái barrier trước khi assert. Không SKIP. Không có ngoại lệ ngoài dự kiến. 9 bất biến tài chính và bất biến PayPal đúng (C9). S8: PostgreSQL `transaction_isolation = read committed`.

**Assertion duy nhất ĐỎ (cả hai DB), chưa tái hiện riêng ngoài test, cần Pro quyết:** C10/S3 "FAILED reason=USER_ABANDONED không có hàng audit: 409 PAYPAL_ABANDON_UNSAFE". Fixture: `store.closeUncaptured(id,{nowIso,reason:'USER_ABANDONED'})` kiểu cũ (không audit), rồi abandon bởi chủ. Thực tế: 200 ALREADY_ABANDONED. Nguyên nhân khớp quy tắc replay Pro đã mô tả (FAILED và (last_reconcile_error='USER_ABANDONED' HOẶC có audit)): chuỗi lý do bị một caller server khác dùng trùng sẽ bị nhận là replay. Không phải lỗi mà người dùng gây ra được (không có đường HTTP nào ghi last_reconcile_error); là khe thiết kế. Hai hướng: (a) coi quy tắc là đúng, đổi kỳ vọng ca này thành ALREADY_ABANDONED và ghi giới hạn; (b) siết replay chỉ dựa vào hàng audit (khi đó bản ghi cũ không có audit sẽ không replay được, cần chấp nhận). Test được giữ đỏ để Pro chọn; các ca FAILED lý do khác (ORDER_EXPIRED, ORDER_VOIDED/NOT_CAPTURED) đều 409 đúng.

### 5b. Lượt XANH 2 (SAU quyết định replay chỉ dựa vào hàng audit)
Lượt ở mục 5 là TRƯỚC quyết định (replay còn dựa vào last_reconcile_error; C10/S3 reason=USER_ABANDONED không audit trả 200, ca đỏ). Lượt 2 chạy sau khi backend áp quyết định: ALREADY_ABANDONED chỉ khi FAILED và có hàng security_events PAYPAL_REQUEST_ABANDONED của đúng request; FAILED không audit (kể cả closeUncaptured cũ với reason 'USER_ABANDONED') = 409 PAYPAL_ABANDON_UNSAFE; closeUncaptured chỉ nhận audit.sql===INSERT_SQL và 9 params. Test thêm ở C10: audit sql lạ, params thiếu/thừa/không phải mảng gọi store.closeUncaptured trực tiếp: 400 VALIDATION_ERROR, request không đóng, không hàng security_events mới (8 assert mới). Ca S3 cũ (ghi đè last_reconcile_error về NULL/chuỗi khác rồi abandon lại vẫn ALREADY_ABANDONED nhờ audit) giữ nguyên và xanh. Log: `scratchpad/green2-sqlite.log`, `scratchpad/green2-pg.log` (log lượt 1 giữ làm lịch sử).

| DB | Kết quả | Assertion đạt | Hỏng | Exit code |
|---|---|---|---|---|
| SQLite | PASS | 249 | 0 | 0 |
| PostgreSQL enclave_pro_abandon_test (read committed) | PASS | 249 | 0 | 0 |

Theo ca (cả hai DB, không SKIP): C1 12, C2 20, C3a 28, C3b 25, C3c 35, C4a 12, C4b 7, C4b2 1, C4c 7, C5 17, C6 25, C7 13, C8 14, C9 3, C10 30; tất cả PASS.

### 5c. Lượt XANH 3 (sau review mutation của Pro)
Thay đổi test theo review: (T6) C3a assert đúng mã cho request mang capture: 409 PAYPAL_ABANDON_UNSAFE (4 ca có captureId), 502 PAYPAL_RESPONSE_INVALID (order COMPLETED không capture, lỗi provider an toàn do adapter), bỏ dòng info gây nhầm; (T4) nhãn hai fixture C3c (RECOVERY_REQUIRED, READY còn claim) là "chỉ chạm tiền kiểm, không chạm guard atomic"; (T5) mục 4 đổi "ĐỎ THẬT" thành "đỏ vì tính năng chưa có", chỉ C1 là lỗi cũ; S4 bỏ assert markCapturePostSent với claim uuid() ngẫu nhiên (vô hiệu) và thay bằng C11(c) dùng claim đúng.

Ca mới:
- **C4d (barrier thật, "claim nhưng chưa POST")**: abandon đứng sau GET; capture claim rồi treo ở preflight GET (transport giữ); precond DB: IN_FLIGHT, có claim, capture_post_sent_at NULL, 0 POST. Thả close: 409 PAYPAL_ABANDON_UNSAFE, request PENDING; thả GET: capture APPLIED, 1 POST, 1 credit, 0 audit. 7 assert.
- **C4e (barrier thật, "claim rồi trả READY giữa GET và close")**: order chưa duyệt, capture claim rồi trả AWAITING_APPROVAL không POST (precond: READY, không claim, attempts=1). Thả close: ĐÓNG ĐƯỢC (200 ABANDONED, hợp lệ vì chưa từng POST và không còn claim), attempts=1 không bị reset, 0 POST, 1 audit. 6 assert.
- **C11 — guard chiều sâu Ở STORE (gọi thẳng store, fixture DB, không phải đường API)**: (a) READY còn capture_claim + onlyNeverPosted:true: closed:false; gọi kiểu cũ cũng closed:false; đối chứng READY sạch + onlyNeverPosted:true đóng được; NOT_CAPTURED + onlyNeverPosted:true: closed:false, nhưng gọi kiểu cũ vẫn đóng (hồi quy caller cũ). (b) expectedOrderId sai: {closed:false, reason:'ORDER_CHANGED'}, không đổi; đúng: closed:true. (c) markCapturePostSent với claim ĐÚNG (IN_FLIGHT, capture_post_sent_at NULL) nhưng payment_requests.status='FAILED' (UPDATE trực tiếp, trigger không cản): ok:false, capture_post_sent_at vẫn NULL, post_count=0; đối chứng trên PENDING: ok:true. (d) claimCapture trên FAILED: CLOSED, không tạo claim. 13 assert.
- Giới hạn trung thực: điều kiện `EXISTS pr.status` trong UPDATE của claimCapture (mutation M10) là phòng thủ chiều sâu; nhánh CLOSED nằm trong cùng transaction đã chặn trước, nên không tới được qua API store và KHÔNG có ca nào bắt; không khẳng định phủ.

Kết quả lượt 3 (log `scratchpad/green3-sqlite.log`, `green3-pg.log`; lượt 1 và 2 giữ nguyên làm lịch sử):

| DB | Kết quả | Assertion đạt | Hỏng | Exit code |
|---|---|---|---|---|
| SQLite | PASS | 274 | 0 | 0 |
| PostgreSQL enclave_pro_abandon_test (read committed) | PASS | 274 | 0 | 0 |

Theo ca (cả hai DB, không SKIP): C1 12, C2 20, C3a 28, C3b 25, C3c 35, C4a 12, C4b 7, C4b2 1, C4c 7, C4d 7, C4e 6, C5 17, C6 25, C7 13, C8 14, C10 29, C11 13, C9 3; tất cả PASS. (C10 từ 30 xuống 29 do bỏ assert vô hiệu; C3a giữ 28 vì chỉ đổi điều kiện.) Mutation đối chứng chưa được tôi chạy lại; Pro cần chạy lại 5 mutation M2/M3/M6/M10/M11 để xác nhận C11 bắt được (M10 dự kiến vẫn không bắt, như đã nêu).

### 5d. Vòng R2 (review độc lập của Codex trên 5e25f57): thêm C12 và C13

**C12 — đường LÔ của worker** (`reconcileOnce({minAgeSeconds:0, limit, paypalRuntime})`, KHÔNG truyền paymentRequestId; đo bằng nhật ký transport, đếm GET order thật; mỗi ca đẩy request khác ra `created_at` 2999 để lô chỉ thấy dòng của ca; giá trị mặc định WINDOW 72h, RESCAN 900s, SHARE=max(1,floor(limit/5)), chỉnh dữ liệu DB, không chỉnh env):
(a) abandon, PayPal thu muộn (fake, không webhook), lô: FAILED giữ nguyên, RECOVERY_REQUIRED, capture_id, recovery_required_at, ví/sổ cái không đổi, summary.paypal.recoveryRequired=1; (b) lô thứ hai không GET lại; (c) cửa sổ: now-73h không quét, now-71h quét; (d) giãn cách: vừa quét thì không quét lại, last_reconciled_at now-600s không, now-1000s có; (e) công bằng: 4 PENDING + 6 abandon + 1 MOCK; limit=5 (SHARE=1): đủ 4 PENDING và đúng 1 dòng abandon cũ nhất; limit=10 (SHARE=2): đủ 4 PENDING và đúng 2 dòng cũ nhất còn đủ giãn cách; MOCK không bị nhóm PayPal đụng; (f) FAILED đã POST vẫn quét theo quy tắc cũ (late capture thành RECOVERY_REQUIRED); (g) provider timeout/lỗi mạng/404 trên dòng abandon: lô không ném, FAILED, không credit, `summary.paypal.errors=1`, last_reconcile_error = PAYPAL_TIMEOUT / PAYPAL_UNAVAILABLE / PAYPAL_API_ERROR.
**C13 — replay sau RECOVERY_REQUIRED** (hợp đồng Pro chốt): (a) abandon, thu muộn, recovery qua store.markCaptureVerified / webhook / reconcileOne, abandon lại: 409 PAYPAL_ABANDON_UNSAFE, evidence/ví/sổ cái/audit không đổi; (b) nhánh thua race: `createAbandonment` thật với store thật bọc mỏng (closeUncaptured gọi store thật rồi giữ bên thua ở barrier): hai lời gọi cùng đứng sau GET (barrier đếm 2), A thắng, B closed:false bị giữ; precond chứng minh B tới barrier, B chưa trả, A đã FAILED với 1 audit, recovery đã lưu (markCaptureVerified, capture_state RECOVERY_REQUIRED) TRƯỚC khi thả; thả B: 409, không ALREADY_ABANDONED, bằng chứng/ví giữ nguyên; (c) replay thường vẫn 200 ALREADY_ABANDONED.

**Lượt ĐỎ R2 trên bản sao nguyên vẹn HEAD 5e25f57 (abandon-head)** — log `scratchpad/red-r2-sqlite.log`, `red-r2-pg.log`. Cả hai DB giống nhau: 323 đạt, 18 hỏng, exit 1. C1–C11 và C9 không đỏ (không đổi so với lượt 3). Chi tiết:
- ĐỎ THẬT trên HEAD (hành vi sai/thiếu thật): C12(a) (scanned=0, recoveryRequired=0 vì dòng FAILED chưa-POST không được chọn; kéo theo 3 assert: trạng thái RECOVERY_REQUIRED/capture_id, GET transport), C12(c) now-71h không được quét, C12(d) lần quét đầu và quét lại khi đủ giãn cách, C12(e) nhóm abandon (limit=5 và limit=10), C12(g) cả 3 chế độ lỗi (không được quét nên không có lỗi ghi: last_reconcile_error vẫn USER_ABANDONED); C13(a) cả 3 đường recovery (HEAD trả 200 ALREADY_ABANDONED), C13(b) bên thua trả ALREADY_ABANDONED.
- Đạt trên HEAD vì chưa có hành vi tương ứng (GUARD MỚI, không chứng minh lỗi cũ): C12(b) (không quét lại: vốn không quét), C12(c) now-73h không quét, C12(d) "không quét lại trước RESCAN", C12(e) đủ 4 PENDING được quét và MOCK không bị đụng (hành vi cũ giữ nguyên, hồi quy), C12(f) FAILED đã POST (quy tắc cũ, hồi quy), C13(a/b) evidence/ví không đổi, C13(c) (hồi quy replay thường), mọi precond (kể cả barrier và recovery lưu trước khi thả).
Số assertion mới: C12 45, C13 22 (HEAD: C12 31/45 đạt, C13 18/22 đạt).

**Lượt XANH R2: chưa chạy** (chờ Pro báo backend sửa xong reconciler.js/paypalAbandonment.js).

Giới hạn thêm của R2: (i) WINDOW/RESCAN/SHARE theo mặc định mô tả trong giao việc (72h, 900s, max(1,floor(limit/5))); nếu backend chọn khác, các assert (c)(d)(e) phải chỉnh; (ii) C12(f) chỉ kiểm lô chọn dòng FAILED-đã-POST và chuyển RECOVERY_REQUIRED, không ràng buộc việc rescan liên tiếp; (iii) fixture: provider giả, FAILED-đã-POST dựng bằng UPDATE trực tiếp như paypal-m2-settlement T6; MOCK dùng một dòng DB trực tiếp.

### 5e. R2b: bổ sung theo review R2 (ca C14, chỉnh nhãn C6/C7)
Ca C14 (26 assert, chạy trên cả SQLite và PG):
1. Replay 409 khi `capture.lastError` = CONFLICTING_CAPTURE: dựng qua store THẬT: B đã giữ capture_id X; `markCaptureVerified(A, X)` = CAPTURE_ID_CONFLICT, A để lại READY, capture_id NULL, recovery_required_at NULL, last_capture_error `CONFLICTING_CAPTURE:...`; abandon A lần nữa: 409 PAYPAL_ABANDON_UNSAFE; bằng chứng/ví/sổ cái/audit không đổi.
2. VERIFIED cũ trên request FAILED (có recovery_required_at, CAPTURED_AFTER_REQUEST_CLOSED qua persistLegacyRecovery): dựng bằng FIXTURE DB (UPDATE binding sang VERIFIED sau khi đã abandon, rồi `store.markCaptureVerified` cùng capture_id); abandon lại: 409.
3. last_reconcile_error không phải nguồn replay: ngay sau abandon cột = USER_ABANDONED (assert C6/C7 đã sửa nhãn: chỉ đúng khi chưa qua lượt quét lô); sau lượt quét lỗi (và UPDATE ghi đè chắc chắn thành PAYPAL_TIMEOUT) replay vẫn 200 ALREADY_ABANDONED nhờ audit, không thêm dữ liệu.
4. Thứ tự: dòng last_reconciled_at NULL được GET TRƯỚC dòng cũ nhất rồi dòng mới hơn (nhật ký transport thật, `limit=25`), kiểm trên cả hai DB (NULL không xếp cuối).
5. Biên: created_at = now-72h+10s quét, now-72h-10s không; last_reconciled_at now-890s không, now-910s có; request FAILED có capture_state UNKNOWN hoặc IN_FLIGHT (không READY) không bị nhóm abandon quét; FAILED đã POST (truy vấn cũ): đúng 1 GET và 1 kết quả trong một lượt (không quét hai lần).

Lượt ĐỎ trên HEAD 5e25f57 (`scratchpad/red-r2b-sqlite.log`, `red-r2b-pg.log`), hai DB giống nhau: 345 đạt, 22 hỏng, exit 1 (C12 31/45, C13 18/22, C14 22/26, C9 đạt).
- ĐỎ THẬT trên HEAD ở C14: (1) HEAD trả 200 ALREADY_ABANDONED; (2) HEAD trả 200 ALREADY_ABANDONED; (4) HEAD không quét dòng nào; (5) biên cửa sổ/RESCAN: không dòng nào được quét ([0,0,0,0] thay vì [1,0,0,1]).
- GUARD (đạt trên HEAD): C14(3) replay sau ghi đè cột (trên HEAD cột không bị đụng nên chưa chứng minh gì cho nhánh lỗi, chỉ chặn hồi quy), C14(5) state không READY không bị quét, FAILED đã POST đúng một lần (hồi quy quy tắc cũ), mọi precond.
Ghi chú (3): trên HEAD, sau lượt quét lỗi cột vẫn là USER_ABANDONED vì dòng không được quét; assert dùng UPDATE ghi đè để kiểm điều kiện bất kể backend.

### 5f. Lượt XANH R2 (SAU backend R2b: quét lô FAILED chưa-POST, replay 409 mở rộng)
Log: `scratchpad/green-r2-sqlite.log`, `green-r2-pg.log` (các lượt đỏ/xanh trước giữ làm lịch sử).

| DB | Kết quả | Assertion đạt | Hỏng | Exit code |
|---|---|---|---|---|
| SQLite | FAIL (1 assertion) | 366 | 1 | 1 |
| PostgreSQL enclave_pro_abandon_test (read committed) | FAIL (1 assertion) | 366 | 1 | 1 |

Theo ca (cả hai DB giống nhau, không SKIP): C1 12/12, C2 20/20, C3a 28/28, C3b 25/25, C3c 35/35, C4a 12/12, C4b 7/7, C4b2 1/1, C4c 7/7, C4d 7/7, C4e 6/6, C5 17/17, C6 25/25, C7 13/13, C8 14/14, C10 29/29, C11 13/13, **C12 45/45**, **C13 22/22**, **C14 25/26 FAIL**, C9 3/3.

**Assertion duy nhất đỏ (cả hai DB, tái hiện ổn định):** C14(4) "thứ tự GET thật: NULL trước, rồi cũ nhất, rồi mới hơn". Thực tế (đo bằng nhật ký transport thật): dòng cũ nhất (last_reconciled_at = now-5000s), rồi dòng now-1500s, rồi dòng last_reconciled_at NULL LAST. Cả SQLite lẫn PG cho cùng thứ tự, nên không phải khác biệt NULLS FIRST/LAST của DB. Nguyên nhân khớp mã: truy vấn nhóm abandon dùng `ORDER BY COALESCE(pr.last_reconciled_at, pr.created_at) ASC`; dòng mới abandon (NULL) bị thay bằng created_at (gần hiện tại) nên xếp SAU dòng đã quét từ lâu. Hệ quả: với giới hạn SHARE nhỏ, dòng abandon mới chưa từng quét có thể bị dòng đã quét lâu hơn chiếm suất trước. Đây là khác biệt so với kỳ vọng "dòng mới (NULL) được chọn TRƯỚC" mà Pro nêu; nếu thiết kế thực sự muốn COALESCE theo created_at thì cần Pro đổi kỳ vọng và ghi lại; nếu không thì sắp xếp nên đặt NULL trước (ví dụ `ORDER BY (pr.last_reconciled_at IS NOT NULL), pr.last_reconciled_at, pr.created_at`). Nhãn "[ĐỎ trên HEAD]" trong tên assert này là nhãn lượt đỏ, không còn đúng nghĩa ở lượt xanh. Không sửa src/.
Mọi assert R2 khác xanh: C12 (a)–(g), C13 (a)(b)(c), C14 (1)(2)(3)(5) trên cả hai DB. Isolation PG: read committed.

### 5g. R2b cuối: sửa kỳ vọng C14(4) theo quyết định của Pro, cô lập chặt hơn, thêm C15
**C14(4) sửa kỳ vọng (không phải lỗi sản phẩm):** Pro chốt giữ `ORDER BY COALESCE(last_reconciled_at, created_at) ASC` (cùng quy tắc "chờ lâu nhất đi trước" với truy vấn PENDING). Kỳ vọng "NULL luôn đứng trước" ban đầu mạnh hơn yêu cầu thật (NULL không bị xếp cuối theo từng loại DB). Test mới: (4i) dòng NULL có created_at now-9000s được GET ĐẦU TIÊN trước dòng quét now-5000s rồi now-1500s; (4ii) dòng NULL tạo gần đây đứng SAU dòng đã quét now-3000s (chính sách hiệu dụng: "lần nhìn cuối hoặc lúc tạo, cái nào sớm hơn đi trước"); (4iii) SQLite và PG cho cùng thứ tự GET (so bằng nhật ký transport: mỗi DB đều [0,1,2] và [1,0]). Nhãn "[ĐỎ trên HEAD]" của assert này đã bỏ. Lượt xanh có 1 assertion đỏ (5f) giữ làm lịch sử.
**T-R2-2 cô lập:** `isolate()` nay đặt cả `created_at` và `last_reconciled_at` của mọi request PayPal/MOCK ngoài ca về 2999 (không thoả điều kiện nhóm PENDING lẫn nhóm abandon), nên không dòng sót nào chiếm SHARE hay làm lệch số đếm (C12(g) errors===1, v.v.). Đã kiểm lại mọi ca C12/C14 dùng isolate().
**C15 (12 assert):** (R9) `reconcileOnce({paymentRequestId})` không kích hoạt nhóm quét mới (`abandonedScanned===0`, theo id vẫn `scanned=1` như cũ), và lượt lô riêng chạy cùng lúc (Promise.all) vẫn quét nhóm mới (abandonedScanned>=1, GET transport thật cho dòng chỉ-qua-lô); (R10) sau lượt lô quét THÀNH CÔNG (provider trả PENDING, không thu) dòng abandon VẪN có last_reconcile_error=USER_ABANDONED, trong khi dòng PENDING (STALE_ERR) vẫn bị clearError về NULL như cũ.
**Nhãn đỏ/guard của vòng này (chạy lại trên HEAD 5e25f57, `red-r2c-*.log`, hai DB giống nhau: 356 đạt, 27 hỏng, exit 1; C12 31/45, C13 18/22, C14 25/30, C15 8/12, C9 đạt):** ĐỎ trên HEAD: R9 abandonedScanned===0 (HEAD không có trường), R9 lô riêng quét nhóm mới, R9 transport dòng R, R10 precond (dòng abandon không được quét), cùng các assert C12/C13/C14 đã nêu ở 5d/5e. GUARD/hồi quy (đạt trên HEAD): R9 theo id scanned=1, R10 "cột vẫn USER_ABANDONED" (trên HEAD đạt vì dòng không bị quét; chỉ có nghĩa ở lượt xanh) và "dòng PENDING vẫn bị clearError".

**Lượt XANH R2b cuối (`green-r2c-sqlite.log`, `green-r2c-pg.log`):** SQLite PASS 383 đạt, 0 hỏng, exit 0; PostgreSQL (read committed) PASS 383 đạt, 0 hỏng, exit 0; không SKIP. Theo ca (hai DB giống nhau): C1 12, C2 20, C3a 28, C3b 25, C3c 35, C4a 12, C4b 7, C4b2 1, C4c 7, C4d 7, C4e 6, C5 17, C6 25, C7 13, C8 14, C10 29, C11 13, C12 45, C13 22, C14 30, C15 12, C9 3: tất cả PASS. (Lượt xanh trung gian trước C15 và cô lập chặt: 371/0 mỗi DB, `green-r2b-*.log`.)

### 5h. R2c: C16 (khe mutation R4b)
Pro chạy mutation thật trên src: mọi mutation bị bắt trừ R1/R8 (tương đương/thừa) và **R4b**: gộp hạng mục `[...abandoned,...rows].slice(0,limit)` vẫn xanh vì ở C12(e) số PENDING + SHARE không bao giờ vượt limit. C16 dựng đúng điều kiện (số PENDING >= limit): limit=5 với 6 PENDING đủ tuổi + 2 dòng abandon đủ điều kiện; limit=10 với 11 PENDING + 3 dòng abandon. Kỳ vọng đo bằng nhật ký transport: ĐÚNG limit dòng PENDING cũ nhất được GET (dòng PENDING thứ limit+1 không), nhóm abandon quét ĐÚNG SHARE (1; 2) dòng cũ nhất, tổng GET = limit+SHARE > limit; đây là thiết kế có chủ ý: SHARE được CỘNG THÊM NGOÀI hạn mức của truy vấn PENDING cũ. summary.paypal.scanned=limit, abandonedScanned=SHARE. 11 assert.
Nhãn trên HEAD 5e25f57 (`red-r2d-*.log`, hai DB giống nhau: 363 đạt, 31 hỏng, exit 1; C16 7/11): phần PENDING (ĐÚNG limit dòng, dòng cuối không) ĐẠT trên HEAD = guard hồi quy hạn mức cũ, cũng là assert sẽ đỏ nếu bị cắt ở limit (R4b); phần abandon và abandonedScanned ĐỎ trên HEAD vì chưa có nhóm abandon.
Lượt XANH R2c (`green-r2d-sqlite.log`, `green-r2d-pg.log`): SQLite PASS 394 đạt, 0 hỏng, exit 0; PostgreSQL PASS 394 đạt, 0 hỏng, exit 0; không SKIP. Theo ca (hai DB giống nhau): C1 12, C2 20, C3a 28, C3b 25, C3c 35, C4a 12, C4b 7, C4b2 1, C4c 7, C4d 7, C4e 6, C5 17, C6 25, C7 13, C8 14, C10 29, C11 13, C12 45, C13 22, C14 30, C15 12, C16 11, C9 3: tất cả PASS. Pro tự chạy lại R4b để xác nhận C16 bắt được (tôi chưa chạy mutation).

Mutant/khoảng trống Pro chấp nhận, ghi tại đây (không thêm ca): R1 (bỏ `recovery_required_at IS NULL` ở nhóm abandon) gần như mutant tương đương vì `capture_state='READY'` đã loại; R8 (bỏ chặn trùng id giữa hai truy vấn) là mã thừa vì hai truy vấn rời nhau; R11 (đảo thứ tự kiểm replay) và R12 (bỏ riêng kiểm VERIFIED/captureId) mức thấp, dư thừa; T-R2-5: C13(b) dựng `createAbandonment` với `fakeReq` không qua router (router đã được kiểm ở C2/C5).

## 6. Giới hạn
- Fixture, không phải PayPal thật: transport giả, status/capture do test dựng; adapter, store, DB, router là mã thật.
- Hai ca dùng fixture DB trực tiếp (RECOVERY_REQUIRED PENDING; READY còn claim); không chứng minh đường sản phẩm tạo ra các trạng thái đó.
- Mã lỗi/outcome cụ thể cho các từ chối do provider (capture-bearing) chỉ assert "không 2xx", mã in ở dòng info; 400 body cấm chỉ assert status.
- C4b2 là kiểm nhất quán ngẫu nhiên; thứ tự xác định nằm ở C4a/C4c (barrier). Trên PG mọi transaction ghi tuần tự qua advisory lock, trên SQLite qua BEGIN IMMEDIATE, nên cửa sổ tranh chấp thật nằm giữa GET (ngoài transaction) và bước đóng, đúng chỗ barrier đặt.
- Audit atomic chỉ chứng minh được khi INSERT audit nằm cùng transaction đóng; nếu không, ca C7 đỏ.
- S5 không dựng được trực tiếp (order_id bất biến); thay bằng provider trả id khác.
- Không kiểm UI, không browser, không rate-limit (limiter được reset trước mỗi lời gọi).
