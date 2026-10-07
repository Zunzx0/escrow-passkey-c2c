# PRO-PAYPAL-ABANDONMENT-BACKEND-NOTES (agent cấp 3 số 1, backend)

Nền d7929d7, nhánh claude/paypal-abandon-request. Chưa commit. Script tạm nằm ngoài repo: `scratchpad/abandon-prov/` (repro-quota.js, selftest.js, các log).

## 1. Tái hiện lỗi quota (trên bản sao nguyên vẹn của nền, trước khi sửa)
Lệnh: `APP_ENV=test DATABASE_URL=...enclave_pro_abandon_prov_test node repro-quota.js <abandon-base/cho-an-tam>` (TOPUP_MAX_PENDING=5 mặc định sản phẩm; provider giả của harness M2). Kết quả (exit 0):
- topup 1..5: 200 AWAITING_APPROVAL; topup 6: **409 TOPUP_LIMIT_EXCEEDED**.
- capture chưa duyệt: 200, request vẫn PENDING; POST /:id/abandon: 404 (chưa có); trạng thái DB sau tất cả: 5 PENDING; topup 7: 409 lần nữa.
- Không có API production nào đóng request PayPal PENDING: `closeUncaptured` không có caller; `closeUnsubmitted` chỉ MOCK; reconciler chỉ markAttempt/recordError. Log: `repro-base.log`.

## 2. Diff theo tệp
- `src/routes/paypal.js`: thêm `POST /:id/abandon` = requireAuth + walletRole(BUYER/SELLER) + writes rate limit + `emptyBody` (body thiếu hoặc `{}`; khoá bất kỳ, mảng, chuỗi -> 400 VALIDATION_ERROR) + handler -> `runtime.abandon(id, req.user.id, req)`, HTTP 200.
- `src/lib/paypalRuntime.js`: dựng `createAbandonment`, thêm `abandon(id,userId,req)` = `ready()` + `owned()` (404/403/merchant 409) + abandonment.abandon.
- `src/lib/paypalAbandonment.js` (mới): luồng đọc store -> kiểm sơ bộ -> GET order fresh -> closeUncaptured (kèm audit) -> đọc lại.
- `src/lib/paypalPaymentStore.js`:
  - `closeUncaptured(id,{nowIso,reason,audit=null,onlyNeverPosted=false,expectedOrderId=null})`: mặc định không đổi caller cũ. `audit` ({sql,params}, bắt buộc là INSERT security_events) chạy trong cùng transaction khi và chỉ khi UPDATE changes===1; INSERT lỗi thì ném, transaction rollback. `onlyNeverPosted` loại NOT_CAPTURED (cả kiểm JS lẫn EXISTS của UPDATE). `expectedOrderId` đòi bindings.order_id khớp (cả JS lẫn UPDATE). Tham số null dùng `CAST(? AS TEXT)` để PostgreSQL suy kiểu được.
  - `claimCapture`: câu UPDATE giành claim thêm EXISTS payment_requests.status='PENDING' và provider PAYPAL_SANDBOX; nếu changes!==1 mà request đã FAILED thì trả CLOSED (trước là BUSY).
  - `markCapturePostSent`: thêm EXISTS status='PENDING' (S4).
- `src/lib/securityEvents.js`: `EVENTS.PAYPAL_REQUEST_ABANDONED`, `ERROR_TO_EVENT.PAYPAL_ABANDON_UNSAFE -> INVALID_STATE`, export `buildSecurityEventInsert(req,opts)` (sql+params qua đúng `sanitize`; `logSecurityEvent` dùng lại nó nên hành vi cũ không đổi).

## 3. Ma trận trạng thái -> kết quả
| Tình huống | Kết quả | Gọi provider |
|---|---|---|
| Không token / sai role | 401 / 403 | không |
| Request người khác, không tồn tại, merchant đổi | 403 / 404 / 409 PAYPAL_ORDER_MISMATCH | không |
| Body có khoá/mảng/chuỗi | 400 VALIDATION_ERROR | không |
| PENDING, có order, READY, chưa POST, không claim, GET: PENDING + không captureId + orderStatus in {CREATED,SAVED,APPROVED,PAYER_ACTION_REQUIRED,VOIDED} | 200 outcome ABANDONED, stage FAILED | 1 GET |
| FAILED + có hàng audit PAYPAL_REQUEST_ABANDONED của request (CHỈ audit; last_reconcile_error không dùng) | 200 ALREADY_ABANDONED, không audit mới | không |
| FAILED lý do khác (kể cả FAILED reason USER_ABANDONED mà không có audit); SUCCEEDED | 409 PAYPAL_ABANDON_UNSAFE | không |
| Chưa bind order/CREATING/CREATE_RECOVERY_REQUIRED; IN_FLIGHT; UNKNOWN; VERIFIED; NOT_CAPTURED; RECOVERY_REQUIRED; đã POST | 409 PAYPAL_ABANDON_UNSAFE | không |
| GET: mismatch orderId/paymentRequestId/amount | 409 PAYPAL_ORDER_MISMATCH, không đóng | 1 GET |
| GET: có captureId, status SUCCEEDED, orderStatus thiếu/khác | 409 PAYPAL_ABANDON_UNSAFE, không đóng | 1 GET |
| GET lỗi/timeout | lỗi provider sanitized (503 PAYPAL_UNAVAILABLE), không đóng | 1 GET |
| Thua race lúc close | đọc lại: đã abandon song song -> ALREADY_ABANDONED, ngược lại 409 UNSAFE | |
| INSERT audit lỗi | 5xx an toàn, request vẫn PENDING | |

Không có catch coi lỗi là thành công. Callback `?paypal=cancel` vẫn GET-only, không tự abandon.

## 4. Chống race
GET fresh ngoài transaction -> `closeUncaptured` là transaction ngắn recheck PENDING+READY+chưa POST+không claim+order_id khớp (UPDATE có điều kiện nên atomic). Mọi đường capture phải qua `claimCapture`, UPDATE giành claim kiểm status PENDING; `markCapturePostSent` cũng kiểm. Vậy hoặc close thắng (claim sau đó nhận CLOSED, không POST) hoặc claim thắng (close nhận RACE_LOST/CAPTURE_IN_FLIGHT). Không giữ transaction qua mạng.
S8: tính nối tiếp claim/close trên PostgreSQL dựa vào pg_advisory_xact_lock của asyncDb và isolation READ COMMITTED; SQLite dựa vào đơn luồng một kết nối. Selftest chỉ kiểm tuần tự (claim rồi close, close rồi claim), KHÔNG chứng minh đồng thời thật; việc đó thuộc test barrier của agent kiểm thử.

## 5. Provenance và audit
`resolved_by` giữ 'RECONCILER' (CHECK schema). Phân biệt yêu cầu chủ động bằng: (a) `last_reconcile_error='USER_ABANDONED'` (chuỗi dành riêng, nhưng cột này CÓ THỂ bị reconciler ghi đè: clearError/recordError ~dòng 35-41, đường quét theo id ~195); (b) actor = payment_requests.user_id (endpoint chỉ cho chủ); (c) hàng `security_events` PAYPAL_REQUEST_ABANDONED ghi ATOMIC cùng transaction đóng, outcome ALLOWED, actor_id/username/ip/method/route từ phiên/req, detail {action:ABANDON, reason:USER_ABANDONED, source:OWNER, paymentRequestId, amount}, status_code 200. Hàng audit là nguồn bền/thẩm quyền; replay CHỈ dùng (c) (quyết định Pro: (a) vẫn được ghi như thông tin nhưng không là bằng chứng, vì ghi đè được hoặc caller khác ghi trùng chuỗi) (so khớp `detail LIKE ?` tham số hoá với `"paymentRequestId":"<id>"`; id đã được owned() xác thực; selftest kiểm replay khi cột đã bị xoá). Giới hạn: khớp bằng LIKE trên text, không có chỉ mục theo request; cột bất biến sẵn có để làm nguồn thì chưa thấy (resolved_by bị CHECK, không có cột lý do riêng) nên nếu muốn chắc hơn cần cột/schema, chưa tự đổi. Giới hạn replay: nguồn bền là hàng security_events. Nếu bảng audit bị dọn/xoá thì replay thành 409 PAYPAL_ABANDON_UNSAFE (an toàn, request vẫn FAILED). Code nền không có chính sách giữ/dọn security_events. Guard audit của store: audit.sql phải bằng đúng hằng `INSERT_SQL` export từ securityEvents.js và params.length===9, nếu không VALIDATION_ERROR 400. Audit là atomic, không best-effort; nhật ký các lần BỊ TỪ CHỐI (UNSAFE) chỉ best-effort qua logFromError.

## 6. Kết quả tự kiểm và hồi quy hẹp (sau khi áp S1-S5), DB enclave_pro_abandon_prov_test / SQLite data/test
- selftest tạm (selftest.js): PostgreSQL exit 0 40 đạt/0 hỏng; SQLite exit 0 40 đạt/0 hỏng. Gồm: quota, abandon, audit, replay, 401/403/400/404, mismatch, order đã capture, timeout, IN_FLIGHT không gọi provider, claim/close tuần tự cả hai chiều, audit lỗi rollback, FAILED lý do khác, NOT_CAPTURED unsafe, expectedOrderId, replay qua audit, capture sau abandon (200, FAILED, 0 POST capture), bất biến.
- `node --test` 5 tệp (adapter, service, capture-coordinator, payer-action-regression, payer-action-runtime): exit 0, tests 50, pass 50, fail 0, skipped 0.
- `node test/paypal-store-concurrency-e2e.js` (SQLite): exit 0, migration 106/0 và proposed 106/0. Chưa chạy chế độ --pg.
- `run-suite.js --only=payment-provider-isolation-e2e` (PORT 3921, BASE_URL tương ứng): SQLite exit 0, PG exit 0, mỗi nền 16 đạt + chín bất biến, 25 phép kiểm.
- Chưa chạy full suite/test M2 (Pro làm).

## 7. Giới hạn đã biết (ghi cho Codex, không tự xử lý)
1. Worker quét LÔ chỉ quét FAILED đã POST (reconciler ~196); đường quét THEO ID (`scripts/reconcile.js --id`, ~195) quét mọi FAILED PayPal. Capture muộn sau abandon vì vậy chỉ lộ qua webhook/đường GET có xác minh hoặc quét theo id, không qua worker lô.
2. UNKNOWN+PAYER_ACTION_REQUIRED chưa POST không abandon được ở bản tối thiểu.
3. DTO không có trường lý do đóng nên UI chưa phân biệt FAILED do USER_ABANDONED.
4. (S7, mức thấp) Trần pending/ngày được giải phóng qua abandon; vòng create/abandon chỉ bị rate limit IP, mỗi vòng tốn một lần tạo order và một GET ở PayPal. Không đổi chính sách.
5. Request abandon rồi mới có capture COMPLETED muộn: store đã lưu RECOVERY_REQUIRED (K3 của test store); replay sau đó vẫn trả ALREADY_ABANDONED nhưng DTO có stage RECOVERY_REQUIRED.
6. `claimedAt` trong DTO được dùng làm dấu "có claim" ở bước kiểm sơ bộ (token claim không lộ ra); recheck thật là atomic ở UPDATE.

## 8. Cần Pro/Codex quyết
- Có muốn cột/bảng bất biến cho lý do đóng (cần schema) thay vì LIKE trên audit không.
- Chạy store-concurrency chế độ --pg trên DB `_store_test` (tôi chưa chạy).
- `pg_advisory_xact_lock`/READ COMMITTED: cần test barrier đồng thời thật.

## 9. Cập nhật F2/F3 và replay=audit-only (lượt hồi quy cuối)
Thay đổi: guard audit của store so `audit.sql === INSERT_SQL` (export mới từ securityEvents.js, require lười trong store) và `params.length===9`; `isAbandoned` chỉ dựa FAILED + hàng audit (bỏ last_reconcile_error); thêm ca selftest "FAILED reason USER_ABANDONED không audit -> 409" và "audit.sql lạ -> VALIDATION_ERROR".
Kết quả: selftest PG exit 0 42 đạt/0 hỏng; SQLite exit 0 42/0; `node --test` 5 tệp exit 0, 50/50, 0 skip; store-concurrency SQLite exit 0 (106/0 + 106/0); isolation qua run-suite SQLite exit 0 và PG exit 0 (25 phép kiểm mỗi nền).
