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

## 6. Giới hạn
- Fixture, không phải PayPal thật: transport giả, status/capture do test dựng; adapter, store, DB, router là mã thật.
- Hai ca dùng fixture DB trực tiếp (RECOVERY_REQUIRED PENDING; READY còn claim); không chứng minh đường sản phẩm tạo ra các trạng thái đó.
- Mã lỗi/outcome cụ thể cho các từ chối do provider (capture-bearing) chỉ assert "không 2xx", mã in ở dòng info; 400 body cấm chỉ assert status.
- C4b2 là kiểm nhất quán ngẫu nhiên; thứ tự xác định nằm ở C4a/C4c (barrier). Trên PG mọi transaction ghi tuần tự qua advisory lock, trên SQLite qua BEGIN IMMEDIATE, nên cửa sổ tranh chấp thật nằm giữa GET (ngoài transaction) và bước đóng, đúng chỗ barrier đặt.
- Audit atomic chỉ chứng minh được khi INSERT audit nằm cùng transaction đóng; nếu không, ca C7 đỏ.
- S5 không dựng được trực tiếp (order_id bất biến); thay bằng provider trả id khác.
- Không kiểm UI, không browser, không rate-limit (limiter được reset trước mỗi lời gọi).
