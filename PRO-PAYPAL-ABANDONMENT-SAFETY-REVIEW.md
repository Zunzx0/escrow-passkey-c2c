# PRO-PAYPAL-ABANDONMENT-SAFETY-REVIEW

Agent cấp 3 số 3. Chỉ đọc code. Không chạy server/DB/Chrome. Mọi dòng dẫn chiếu là mã NỀN d7929d7 (bản nguyên vẹn), thư mục `cho-an-tam/`. Chưa đọc diff của backend/test (giai đoạn 2).

## Giai đoạn 1 — phản biện thiết kế trên mã nền

Tóm tắt: thiết kế của Pro đứng vững ở các điểm cốt lõi (1, 2, 3, 6, 7, 8). Có 2 điểm phải sửa trong thiết kế (5: audit; 4: nơi lưu reason) và 3 điểm nên thêm guard (A, B, C bên dưới).

### (1) PENDING không đồng nghĩa chưa capture — KẾT LUẬN: đúng, và `closeUncaptured` đủ atomic cho cổng "chưa từng POST"

Mọi cách một request PENDING đã/đang bị capture, và cách điều kiện đóng chặn chúng:

| Đường | Dấu vết trong DB | Chặn bởi |
|---|---|---|
| POST đã gửi, trả lời mất/timeout | `capture_post_sent_at` != null (ghi và commit TRƯỚC khi POST: `paypalCaptureCoordinator.js:45-49` gọi `markCapturePostSent` trong `beforeCapture`, `paypalPaymentStore.js:410-418`; adapter gọi `beforeCapture` ngay trước POST ở `paypalSandboxProvider.js:253-257`) | `neverPosted` (`paypalPaymentStore.js:544`) và vế `b.capture_post_sent_at IS NULL` trong UPDATE (dòng 552) |
| Lease đang giữ | `capture_state='IN_FLIGHT'`, `capture_claim` != null | dòng 544 và 552 (`capture_state='READY' AND capture_claim IS NULL`) |
| Lease HẾT HẠN | vẫn `IN_FLIGHT` + claim != null (không có đường tự nhả; chỉ claimCapture mới cướp, dòng 383/391) | cùng điều kiện trên: `closeUncaptured` không xét lease nên KHÔNG đóng nhầm lease hết hạn. Đúng ý. |
| UNKNOWN | `capture_state='UNKNOWN'` (người giữ khai) | dòng 545 (`CAPTURE_UNKNOWN`) |
| capture PENDING ở PayPal | order có `captures[0].status!=COMPLETED` -> adapter chuẩn hoá `status:'PENDING', captureId:id` (`paypalSandboxProvider.js:90`) | KHÔNG nằm trong DB nếu server chưa POST (ví dụ capture do người khác tạo bằng cùng credential). Chỉ chặn được bằng GET fresh: hợp đồng đã đòi `captureId == null` |
| Webhook / worker verify | `markCaptureVerified` (`paypalPaymentStore.js:494-528`) đặt `VERIFIED` | dòng 545; VERIFIED không phải READY/NOT_CAPTURED |
| Retry sau timeout | `claimCapture` cho `mustVerifyFirst` (dòng 398) | cùng dấu `post_sent_at` |
| RECOVERY_REQUIRED | state + capture_id | dòng 545 |

Atomic: kiểm và UPDATE nằm trong CÙNG `db.transaction` (dòng 540-556). Câu UPDATE tự lặp lại điều kiện READY/no POST/no claim bằng `EXISTS` (dòng 551-553) và `status='PENDING'`, nên kể cả khi tuần tự hoá hỏng thì điều kiện vẫn nằm ở mức một câu lệnh. `capture_post_sent_at` bất biến một chiều (trigger `paypalPaymentStore.js:174` SQLite, `:201` PG; CHECK `:119` cấm READY có post). Do đó "chưa từng POST" đơn điệu: một khi sai thì không bao giờ trở lại đúng, nên bằng chứng GET đọc trước đó không thể bị "hồi sinh".

Vì sao chỉ cần "chưa POST" mà không cần "capture_attempts không đổi từ lúc GET": chuỗi claim -> `finishCaptureAttempt(READY)` (dòng 467 chỉ cho READY khi chưa POST) giữa lúc GET và lúc close để lại trạng thái READY/no-POST/no-claim, và không có tiền nào có thể bị thu từ server trong cửa sổ đó (POST chưa gửi). Vẫn khuyến nghị guard thêm ở mục A.

Lỗ hổng cần backend không được làm:
- **[Cao nếu mắc] `closeUncaptured` hiện chấp nhận cả `NOT_CAPTURED` (`paypalPaymentStore.js:545` và `:553`).** Hợp đồng abandon CHỈ cho READY. Nếu backend gọi lại hàm này nguyên trạng, request NOT_CAPTURED (đã POST, order VOIDED) sẽ đóng được bằng USER_ABANDONED. Cần tham số kiểu `{ onlyNeverPosted: true }` ép cả vế `neverPosted` lẫn vế `EXISTS`, mặc định giữ nguyên cho caller cũ (xem g).
- **Mục A (nên thêm).** Close nên so thêm `order_id = <order đã GET>` (UPDATE `... AND b.order_id = ?`). Ràng buộc là `order_id` bất biến sau khi gắn nên rủi ro thấp, nhưng nó biến "bằng chứng GET thuộc đúng order" thành điều kiện của câu lệnh đóng chứ không chỉ của bước đọc trước.
- Dùng `loadByRequestId` + GET xong mới gọi close: không giữ transaction qua mạng (đúng hợp đồng). `closeUncaptured` hiện không gọi mạng trong transaction (xác nhận dòng 540-556).

### (2) Tuần tự hoá: claim và close không thể xen kẽ — KẾT LUẬN: xác nhận trên cả hai DB, có hai điều kiện tiên quyết

SQLite (`asyncDb.js`): giao dịch ngoài cùng `await mutex.acquire()` rồi `BEGIN IMMEDIATE` (dòng 167-170). Câu lệnh ngoài giao dịch chờ `mutex.locked` (dòng 116-120, `_gate`). Một process, một kết nối -> không câu lệnh nào của request khác chạy giữa BEGIN và COMMIT của `claimCapture` (`paypalPaymentStore.js:366`) hay `closeUncaptured` (`:540`).

PostgreSQL (`asyncDb.js:278-283`): `BEGIN` + `pg_advisory_xact_lock(72410001)` toàn cục, hai process cũng loại trừ nhau. Mỗi câu SELECT sau khi giữ khoá thấy dữ liệu đã commit của người giữ khoá trước (READ COMMITTED).

Điều kiện tiên quyết/chú ý:
1. **Isolation phải là READ COMMITTED.** Với REPEATABLE READ/SERIALIZABLE, snapshot được lấy ở câu `SELECT pg_advisory_xact_lock` TRƯỚC khi chờ xong, nên các SELECT sau đó đọc dữ liệu cũ (đọc "READY" trong khi claim kia vừa commit). Mã nền không đặt isolation nào (grep `isolation` chỉ trúng tên migration `src/db.js:371`) nên mặc định READ COMMITTED; test nên khẳng định `SHOW transaction_isolation` hoặc ít nhất ghi giả định vào báo cáo.
2. **Các ghi KHÔNG qua giao dịch không giữ advisory lock trên PG** (`prepare().run` đơn lẻ: `markCapturePostSent` `:412`, `claimCreateAttempt` `:318`, `recordConflict` `:438`, `markAttempt/recordError/clearError` `reconciler.js:25-41`). Không cái nào làm sai điều kiện đóng: `markCapturePostSent` đòi `capture_claim=? AND capture_state='IN_FLIGHT'` (loại trừ lẫn nhau với điều kiện close `claim IS NULL`, ở mức một dòng), phần còn lại không đụng `capture_state/post_sent_at/status`. Kết luận: an toàn nhờ điều kiện ở mức dòng, không nhờ khoá toàn cục. Nghĩa là test race trên PG vẫn phải chứng minh điều đó thật.
3. SQLite chỉ tuần tự hoá trong MỘT process (mutex trong bộ nhớ). Hai process cùng một file SQLite vẫn được `BEGIN IMMEDIATE` của SQLite bảo vệ cho giao dịch; production dùng PG nên đây chỉ là chú thích.

### (3) UPDATE giành claim không kiểm `payment_requests.status` — KẾT LUẬN: rủi ro thực tế thấp, nhưng hợp đồng nói "claim có kiểm status" nên nên vá

`paypalPaymentStore.js:386-392` chỉ kiểm bảng `paypal_payment_bindings`. Việc chặn claim trên request FAILED nằm ở đoạn SELECT `if (row.status==='FAILED') return CLOSED` (dòng 380), cùng transaction, nên với đường duy nhất hiện có ghi `FAILED` cho PayPal (`closeUncaptured`, `:547`; `paymentService.js:253` chỉ `provider='MOCK'`) và cả hai đều chạy trong giao dịch có khoá (mục 2), không có xen kẽ. Khoảng hở chỉ mở ra nếu sau này có ghi `status='FAILED'` cho PayPal bằng câu lệnh KHÔNG giao dịch, hoặc trên isolation mạnh hơn READ COMMITTED (mục 2.1).

Đề xuất (hợp đồng dòng 18 "mọi đường capture phải giành claim có kiểm status"): thêm vào UPDATE ở dòng 387-391 `AND EXISTS (SELECT 1 FROM payment_requests pr WHERE pr.id = paypal_payment_bindings.payment_request_id AND pr.status = 'PENDING')` và trả `BUSY` -> nên đổi thành đọc lại để trả `CLOSED` khi `changes=0` mà status đã FAILED. Đây là thay đổi nhỏ, không đổi hành vi caller cũ (chỉ thắt thêm trên đường đã bị loại ở dòng 380). `markCapturePostSent` (`:412-416`) nên cũng kiểm `pr.status='PENDING'` để là chốt cuối trước khi POST: nó là điểm THẬT SỰ quyết định "không POST sau close thắng". Hiện nó không kiểm status, nhưng vì close đòi `claim IS NULL` nên close không thể thắng khi claim đang giữ; cái cần là chiều ngược lại ở mục (g) test.

### (4) Hai tuyên bố của Pro

**4a. "Worker đối soát chỉ quét FAILED đã POST" — XÁC NHẬN MỘT PHẦN.**
- Đường quét theo lô: `reconciler.js:196` có `(pr.status='PENDING' OR (pr.status='FAILED' AND b.capture_post_sent_at IS NOT NULL AND b.recovery_required_at IS NULL))`. Request abandon (FAILED, chưa POST) KHÔNG bị quét theo lô. Đúng.
- Bác bỏ phần "chỉ": đường `paymentRequestId` cụ thể (`reconciler.js:195`) là `status IN ('PENDING','FAILED')` không điều kiện POST. Hiện chỉ test dùng (`reconcileOnce` không có caller ngoài `reconciler.js`; grep xác nhận). Nếu abandon, rồi test/công cụ vận hành gọi đối soát theo id, `reconcileOne` -> `service.reconcile` chỉ GET (`paypalRuntime.js:88`, `paypalSandboxService.js:122-125`) và nếu GET thấy COMPLETED thì `settle` -> `RECOVERY_REQUIRED`. Vẫn an toàn.
- **Phát hiện phụ (Trung bình): `clearError`/`recordError` (`reconciler.js:35-41`) ghi `last_reconcile_error` KHÔNG kiểm status.** Nếu reason `USER_ABANDONED` được lưu ở `last_reconcile_error` (như `closeUncaptured` làm ở `:549`) thì lượt đối soát theo id (dòng 205 `clearError`) xoá mất nó, và request abandon bị coi là "FAILED vì lý do khác": replay trả 409 thay vì `ALREADY_ABANDONED`. Cách tái hiện (test): abandon -> `reconcileOnce({paymentRequestId})` với runtime bật -> gọi abandon lại, kỳ vọng ALREADY_ABANDONED. Đề xuất: không dùng `last_reconcile_error` làm nguồn sự thật duy nhất cho replay; hoặc khẳng định bằng `security_events` ABANDON của chính owner (xem 5) hoặc chấp nhận và ghi rõ giới hạn. Phải nêu rõ trong tài liệu hợp đồng.

**4b. "Capture muộn sau close -> RECOVERY_REQUIRED" — XÁC NHẬN.**
- `markCaptureVerified` (`paypalPaymentStore.js:494-528`): nhánh `r.status==='FAILED'` -> `persistRecovery` (dòng 510) đặt `capture_state='RECOVERY_REQUIRED'`, `capture_id`, `recovery_required_at` (dòng 421-430), giữ bằng chứng; trả `{ok:false,outcome:'RECOVERY_REQUIRED'}` KHÔNG throw, nên giao dịch commit và không rollback bằng chứng.
- `paypalSettlement.js:28` thấy `evidence.outcome==='RECOVERY_REQUIRED'` thì return trước khi chạm ví (dòng 33-44). Không credit.
- `finishCaptureAttempt` có đường tương tự (dòng 468) nhưng chỉ tới được khi còn `IN_FLIGHT` đúng token; sau close thắng thì claim không thể tồn tại, nên chỉ đường `markCaptureVerified` (webhook/worker) là khả dụng.
- Trigger cho phép READY -> RECOVERY_REQUIRED với capture_id mới (`paypalPaymentStore.js:176`: chỉ cấm đổi khi OLD đã VERIFIED/RECOVERY_REQUIRED; CHECK `:115` đòi capture_id cùng lúc, thoả). `persistRecovery` có điều kiện `capture_id IS NULL AND capture_state NOT IN (VERIFIED, RECOVERY_REQUIRED)`, nên webhook lặp là idempotent (state đã RECOVERY_REQUIRED -> dòng 504).
- Điểm tới webhook: `paypalSandboxService.js:126-143` -> `loadByOrderId` không lọc status -> GET -> `apply` -> `settle`. Request abandon vẫn nhận được webhook, đúng.
- Ghi chú vận hành: sau close chỉ có webhook (hoặc đối soát theo id) phát hiện capture muộn của request chưa POST; worker theo lô không (4a). Với chưa-từng-POST, capture muộn chỉ có thể do bên ngoài (cùng credential) nên chấp nhận được, nhưng phải ghi trong tài liệu.

### (5) `logSecurityEvent` best-effort, ngoài transaction — KẾT LUẬN: đề xuất của Pro ĐÚNG hướng, nhưng KHÔNG được tái dùng `logSecurityEvent` bên trong transaction; có rủi ro nghiêm trọng nếu làm vậy

Căn cứ: `securityEvents.js:119-140` bọc INSERT bằng `try/catch` nuốt lỗi (dòng 137-139), dùng `db` toàn cục. Trong `db.transaction` ALS thì INSERT đi qua client của giao dịch (`asyncDb.js:223-226`).

Rủi ro nếu gọi `logSecurityEvent` BÊN TRONG transaction đóng:
- **PostgreSQL (Cao): INSERT lỗi làm giao dịch ở trạng thái aborted; `catch` nuốt lỗi; `COMMIT` sau đó trả tag `ROLLBACK` mà node-pg KHÔNG ném lỗi** (`asyncDb.js:286` `await client.query('COMMIT')`). Kết quả: UPDATE đóng bị lùi âm thầm nhưng handler tưởng thành công và trả 200 ABANDONED, DB vẫn PENDING. Nguyên nhân INSERT có thể lỗi: bảng/cột sai, `actor_id` FK users bị xoá giữa chừng, `outcome` vi phạm CHECK (`schema.pg.sql:266`), JSON quá lớn, mất kết nối.
- SQLite: lỗi INSERT chỉ huỷ câu lệnh; giao dịch vẫn commit -> đóng thành công KHÔNG có audit, nuốt im. Trái hợp đồng "audit atomic".
- Đề xuất: viết hàm riêng (ví dụ `insertSecurityEventStrict(tx...)`) KHÔNG try/catch, gọi trong cùng `db.transaction` với `closeUncaptured`/UPDATE; lỗi INSERT -> throw -> rollback toàn bộ -> 5xx, trạng thái không đổi. Đừng sửa `logSecurityEvent` cho caller cũ (nhiều nơi cần best-effort: `paypalSettlement.js:54` cố tình ngoài giao dịch).
- Khoá/deadlock: không có rủi ro mới. Mọi giao dịch ghi PG đã tuần tự qua một advisory lock; INSERT vào `security_events` chỉ thêm `FOR KEY SHARE` trên dòng `users` (FK `actor_id`), không xung đột với UPDATE cột không khoá. Thêm 1 câu INSERT trong lúc giữ khoá toàn cục là chi phí nhỏ.
- Dùng savepoint (`db.transaction` lồng) quanh INSERT chỉ nên nếu muốn "bỏ audit mà vẫn đóng"; điều đó trái hợp đồng nên không khuyến nghị.
- Giới hạn schema: `outcome` chỉ `DENIED|ALLOWED`; `detail` chỉ cho qua `ALLOWED_DETAIL_KEYS` (`securityEvents.js:16-33`) = có `reason, action, source, paymentRequestId, amount`; KHÔNG có `provider`, `orderId`. Actor lấy từ `req.user` (`:129-130`), tức từ phiên, không từ body: tốt. `event_type` không có CHECK nên thêm loại mới (ví dụ `PAYPAL_ABANDONED`) chỉ cần `EVENTS` (hợp đồng cho phép). Không đưa order id/PayerID/token vào `detail`.
- Provenance: `resolved_by` phải giữ `'RECONCILER'` (CHECK `schema.pg.sql:98`, `closeUncaptured:548` đã ghi vậy). Vì thế audit row `ABANDON` với `actor_id=owner`, `detail.action='ABANDON'`, `detail.source='OWNER_REQUEST'` (hoặc tương đương), `paymentRequestId`, là NGUỒN DUY NHẤT phân biệt "owner chủ động" với "đối soát tự động đóng NOT_CAPTURED/ORDER_EXPIRED". Do đó audit phải bền và atomic; không có audit thì request FAILED trông như do worker đóng. Cần tài liệu nói rõ điều này.
- Ghi audit cho replay: chỉ ghi lần đóng thật; replay không nên tạo hàng mới (hợp đồng mục 5 test "không tạo dữ liệu mới").

### (6) Hạn mức, replay, owner — KẾT LUẬN: đạt, kèm 2 điểm chú ý

- `topupPolicy.js:34-37`: `pending_recent` và `pending_total` chỉ đếm `status='PENDING'`; `day_total` đếm `PENDING|SUCCEEDED`. Request FAILED giải phóng cả ba, chỉ bằng đổi status (đúng hợp đồng dòng 23, không nới hạn mức). Hệ quả cần ghi nhận: abandon cũng giải phóng `MAX_PER_DAY` (vòng tạo/abandon lặp lại tạo order PayPal mới không bị trần ngày; chỉ bị rate limit `paypal-auth-writes` 10/phút theo IP `rateLimit.js:79`, không theo user). Mức Thấp, chấp nhận theo hợp đồng nhưng nên ghi trong tài liệu và test không được khẳng định nó "không thể lặp".
- Replay `requestId` cũ: `paypalRuntime.js:51-52,60` — hàng cùng `(user_id, client_request_id)` được tìm lại, `if(row.status==='PENDING') createOrder` nên FAILED KHÔNG tạo order mới và trả `serializePayPal` (stage `FAILED`). `IDEMPOTENCY_KEY_REUSED` nếu số tiền khác. Đạt hợp đồng dòng 23.
- Owner từ phiên: `routes/paypal.js:22-24` truyền `req.user.id`; `runtime.owned` (`:43-45`) so `row.userId`. Với abandon, handler PHẢI dùng `req.user.id` và KHÔNG đọc `req.body` (hiện route `topup` đọc `req.body?.amount/requestId` có chủ đích; abandon không nên đọc gì). Khuyến nghị: nếu body khác `{}` rỗng thì 400 (hợp đồng "yêu cầu body rỗng"); không nên âm thầm bỏ qua `userId`/`actor` do client gửi mà trả 200 (khó phân biệt "bỏ qua" với "chấp nhận"). Test nên gửi body `{userId, actor, status}` và khẳng định kết quả/audit không thay đổi.
- Role: `requireRole('BUYER','SELLER')` (`routes/paypal.js:10,23`), ADMIN nhận 403 JSON (`auth.js:186-192`). Outsider: `owned()` trả 403 `FORBIDDEN` khi request tồn tại và 404 khi không tồn tại (existence oracle; id là UUID nên Thấp, đã là hành vi hiện có của `checkout/capture`).
- `ready()` (`paypalRuntime.js:42`): 503 khi Sandbox tắt/cấu hình lỗi; abandon bị khoá theo. Đúng hợp đồng "Giữ cấu hình merchant và Sandbox hợp lệ", nhưng nghĩa là khi PayPal bị tắt ở production người dùng không thể abandon request treo; ghi chú vận hành.
- Merchant: `owned()` đã đối chiếu `row.merchantId` với cấu hình (dòng 45) và adapter tự đòi `payee.merchant_id` (`paypalSandboxProvider.js:64-67`, `binding()` ghép `merchantId` ở `:204`). Abandon phải gọi `owned` rồi `adapter.getOrder` (không gọi `store.loadByRequestId` thô).

### (7) Callback `?paypal=cancel` — KẾT LUẬN: đạt, không tự abandon

`public/js/app.js:3353-3367` `readPaypalCallbackFromUrl` chỉ đọc `kind/id` rồi dọn query. `processPaypalCallback` (`:3375-3395`) chỉ `api('/payments/'+id)` (GET). Chú thích `:3370-3372` nói rõ cancel "không đánh FAILED, không tạo yêu cầu mới". Grep `abandon` trong `public/js/app.js` ở nền: không có kết quả. Test (nếu có phía UI) nên khẳng định: GET callback không phát sinh POST `/abandon`. Chỉ cần theo dõi khi Codex thêm UI sau: nút riêng, không gọi từ `processPaypalCallback`.

### (8) Order PayPal không bị hủy — KẾT LUẬN: an toàn về tiền, nhưng có hậu quả UX/vận hành phải nói rõ

- Link phê duyệt cũ vẫn dùng được ở phía PayPal (server không POST void/cancel). Người dùng hoàn toàn có thể phê duyệt sau khi abandon: order thành `APPROVED`.
- Nhưng order là `intent:'CAPTURE'` (`paypalSandboxProvider.js:224`); `user_action:'PAY_NOW'` chỉ đổi nhãn nút, và không có `processing_instruction` tự thu. Tiền chỉ dịch chuyển khi server POST `/capture`. Server có đúng một đường POST capture: `captureOrder` ở `paypalSandboxProvider.js:259`, chỉ tới được qua `coordinator.capture` -> `claimCapture` -> `CLAIMED`; request FAILED trả `CLOSED` (`paypalPaymentStore.js:380`, coordinator `:27`). Đường dự phòng `paypalSandboxService.capture` không dùng coordinator (`:115-119`) bị chặn bởi `openForCheckout` (`:50`), và runtime luôn truyền coordinator (`paypalRuntime.js:41`). Không có đường server nào capture sau FAILED.
- `checkout` sau abandon: `serializePayPal` chỉ trả `approvalUrl` khi `binding.status==='PENDING'` (`paypalRuntime.js:68`), nên API không đưa link mới; chỉ link người dùng đã mở/lưu từ trước còn sống. Hãy để Codex quyết thông điệp UI: "Đã đóng yêu cầu trên hệ thống; nếu bạn đã mở PayPal, đừng phê duyệt vì sẽ không có tiền nào được ghi nhận".
- Người dùng phê duyệt xong rồi không có gì xảy ra: order APPROVED treo ở PayPal tới khi hết hạn; không thu tiền, không có tiền thật bị mất. Chỉ rủi ro kỳ vọng sai của người dùng. Chỉ rủi ro tiền là capture từ bên ngoài (cùng credential), đã có đường RECOVERY_REQUIRED (4b).
- Điều NÊN kiểm: test khẳng định provider không nhận `POST /capture`, `/void`, `/cancel` hay bất cứ POST nào sau abandon; chỉ GET. Cũng khẳng định `getOrder` (GET) là lời gọi mạng duy nhất.

## Chấp nhận / điều kiện mở cho backend (tóm tắt để Pro chốt)

Mức, mã, hành động:

| Mức | Mã | Điều | Tham chiếu |
|---|---|---|---|
| Cao (nếu mắc) | S1 | Không gọi `logSecurityEvent` (nuốt lỗi) trong transaction đóng: PG commit-thành-ROLLBACK im lặng, SQLite đóng không audit | `securityEvents.js:137`, `asyncDb.js:286` |
| Cao (nếu mắc) | S2 | Tái dùng `closeUncaptured` nguyên trạng cho phép NOT_CAPTURED đóng, trái hợp đồng | `paypalPaymentStore.js:545,553` |
| Trung bình | S3 | `last_reconcile_error` là cột bị `clearError/recordError` ghi đè (không kiểm status); replay dựa vào đó có thể mất | `reconciler.js:35-41,195,205` |
| Trung bình | S4 | Không có claim nào kiểm `payment_requests.status` ở mức câu lệnh (`claimCapture` UPDATE và `markCapturePostSent`); an toàn hiện tại nhờ tuần tự hoá, nên thêm guard để khớp hợp đồng | `paypalPaymentStore.js:386-391,412-416` |
| Thấp | S5 | Close nên so `order_id` đã GET; tuỳ chọn so `capture_attempts` | `:546-553` |
| Thấp | S6 | Body không rỗng nên bị 400, không bỏ qua im lặng | `routes/paypal.js:22` mẫu hiện tại |
| Thấp | S7 | Trần ngày được giải phóng qua abandon; chỉ rate limit theo IP | `topupPolicy.js:35`, `rateLimit.js:79` |
| Thông tin | S8 | Isolation phải là READ COMMITTED (giả định của khoá advisory) | `asyncDb.js:282-283` |

Không có caller sản xuất của `closeUncaptured` ở nền (chỉ test `test/paypal-m2-settlement-e2e.js:182`, `test/paypal-store-concurrency-e2e.js:444-664`), nên thêm tham số tuỳ chọn mặc định giữ nguyên là an toàn cho (g); tuy vậy các test cũ ở đó dựa vào `reason: 'ORDER_EXPIRED'`/`'ORDER_VOIDED'` và `resolved_by='RECONCILER'`, không được đổi.

## Giai đoạn 2 — chờ

Chưa review diff backend và test. Cần Pro nhắn qua SendMessage để bắt đầu. Danh mục sẽ kiểm: (a) từng điều khoản hợp đồng; (b) đóng atomic sau mạng, không giữ transaction qua mạng, không POST sau close thắng; (c) owner/actor không từ body; (d) audit atomic (S1); (e) late completion giữ chứng cứ; (f) test barrier dựng thật trước assert, không dùng delay, assert không đạt giả, nhãn đỏ/xanh trung thực, không mock thẳng close; (g) caller cũ của `closeUncaptured`/`claimCapture` không đổi hành vi (S2).

## Giai đoạn 2 — backend (đọc `git diff` + `src/lib/paypalAbandonment.js`; chưa review test)

Dòng dẫn chiếu là tệp worktree hiện tại (`cho-an-tam/src/...`). Không chạy gì.

### Kiểm S1-S5 có thật trong code

| Mã | Kết luận | Bằng chứng |
|---|---|---|
| S1 audit atomic, không nuốt lỗi | ĐẠT | `closeUncaptured` chạy `await db.prepare(audit.sql).run(...audit.params)` NGAY trong `db.transaction` sau UPDATE `changes===1`, không try/catch (store ~dòng 570-575); lỗi ném ra -> `asyncDb` ROLLBACK (`asyncDb.js:287-290`), request vẫn PENDING. `buildSecurityEventInsert` (securityEvents.js) chỉ dựng SQL/params, `logSecurityEvent` vẫn nuốt lỗi và gọi lại nó, hành vi cũ không đổi. Audit chỉ ghi khi đóng thật, replay không ghi mới. Actor: `actorId: row.userId` (từ `owned()` đã so với `req.user.id`), username/ip/route từ `req` (phiên), không từ body. |
| S2 onlyNeverPosted | ĐẠT cả hai tầng | JS: `!neverPosted && (onlyNeverPosted || state!=='NOT_CAPTURED')` -> `CAPTURE_<state>`. UPDATE: `OR (b.capture_state='NOT_CAPTURED' AND ? = 0)` với tham số `onlyNeverPosted?1:0`. Abandon truyền `onlyNeverPosted:true`. |
| S3 replay qua audit | ĐẠT (có giới hạn, xem F3) | `isAbandoned`: `last_reconcile_error==='USER_ABANDONED'` HOẶC audit `PAYPAL_REQUEST_ABANDONED` khớp `detail LIKE %"paymentRequestId":"<id>"%`. FAILED lý do khác -> 409. |
| S4 status PENDING | ĐẠT cả hai | `claimCapture` UPDATE thêm `EXISTS (pr.status='PENDING' AND pr.provider='PAYPAL_SANDBOX')`, `changes!==1` đọc lại, FAILED -> `CLOSED`; `markCapturePostSent` thêm `EXISTS pr.status='PENDING'`. |
| S5 expectedOrderId | ĐẠT cả hai | JS `ORDER_CHANGED`; UPDATE `CAST(? AS TEXT) IS NULL OR b.order_id = CAST(? AS TEXT)`; abandon truyền `current.orderId` (đã so với `row.orderId`). Thứ tự tham số `.run(nowIso, reason, nowIso, id, flag, order, order)` khớp 7 dấu `?` (4 đầu giữ nguyên như cũ). |

### Hồi quy caller cũ của `closeUncaptured` — KHÔNG thấy hồi quy

- Mặc định `onlyNeverPosted=false`: vế `? = 0` luôn đúng, NOT_CAPTURED vẫn đóng được; `expectedOrderId=null`: `CAST(? AS TEXT) IS NULL` đúng; `audit=null` bỏ qua. Chữ ký cũ `{nowIso, reason}` vẫn hợp lệ.
- `test/paypal-m2-settlement-e2e.js:182-184` kỳ vọng `closed===false` và `reason==='CAPTURE_IN_FLIGHT'`: nhánh JS không đổi cho trường hợp này (`!neverPosted && state!=='NOT_CAPTURED'`).
- `test/paypal-store-concurrency-e2e.js:444-664`: `resolved_by='RECONCILER'`, `reason` giữ nguyên.
- `claimCapture`/`markCapturePostSent` thắt thêm điều kiện chỉ khi request không PENDING; các test cũ tôi thấy (`:371` 1 CLAIMED + 5 BUSY, `:396,545,576,626,650`, `paypal-integration-e2e.js:81`) đều trên request PENDING. Rủi ro còn lại: một test cũ nào đó gọi `markCapturePostSent` trên request không PENDING; chưa chạy nên nhờ Pro xác nhận bằng suite (store-concurrency cả `--pg`, mà notes nói chưa chạy).
- PG: `? = 0` và `CAST(? AS TEXT)` suy kiểu được, nhưng chưa có bằng chứng chạy PG riêng cho `closeUncaptured` cũ ngoài selftest của tác giả; nhờ chạy `paypal-store-concurrency-e2e.js --pg`.

### Câu hỏi riêng

- **Đường đóng khi có dấu POST/claim?** Không còn. Có bốn lớp: (1) tiền kiểm `abandonment.js:42` (`state!=='READY' || postSentAt!==null || claimedAt!==null`); (2) JS trong transaction (`neverPosted`); (3) UPDATE có `capture_state='READY' AND post_sent_at IS NULL AND claim IS NULL`; (4) vì `post_sent_at` bất biến, GET cũ không thể "hồi sinh". Chỉ `NOT_CAPTURED` là lối thoát hợp lệ của hàm gốc, và đã bị `onlyNeverPosted` chặn.
- **Cạnh tranh còn lại giữa GET (ngoài transaction) và close:** (a) claim -> markPostSent -> POST giữa GET và close: close thấy `IN_FLIGHT/UNKNOWN/post_sent_at` -> từ chối (an toàn). (b) claim -> `finishCaptureAttempt(READY)` (chưa POST) giữa GET và close: vẫn READY/chưa POST, close thắng, an toàn vì chưa có POST nào. (c) Capture từ bên ngoài (cùng credential) sau GET và trước close: server không chặn được; kết thúc ở `RECOVERY_REQUIRED` khi webhook/đối soát tới (`markCaptureVerified` -> `persistRecovery`), không credit. Đây là rủi ro còn lại chấp nhận được, nên có trong tài liệu. (d) Hai abandon song song: một thắng, bên thua `closeUncaptured` trả `RACE_LOST`, đọc lại `isAbandoned` -> ALREADY_ABANDONED. Đúng.
- **`audit.sql` guard:** yếu. `/^INSERT INTO security_events /.test(audit.sql)` chỉ kiểm tiền tố, không kiểm phần còn lại hay độ dài `params`. Chỉ có mã nội bộ gọi (`buildSecurityEventInsert`), PG chạy qua tham số nên không nhiều câu lệnh; chưa phải lỗ hổng khai thác được, nhưng thiết kế "store nhận SQL thô từ ngoài" rộng hơn cần thiết. Xem F2.
- **LIKE trên `detail` bị giả mạo/xung đột?** Không giả mạo được từ client: hàng chỉ do mã này ghi, `event_type` lọc cố định, `id` là id DB đã qua `owned()` (UUID, không chứa `%`/`_`), mẫu có dấu `"` kết thúc nên không khớp tiền tố id khác; `detail` do `sanitize`+`JSON.stringify` dựng ổn định. Chi phí: không có chỉ mục theo request, quét theo `event_type`; chỉ chạy ở đường FAILED nên chấp nhận được. Rủi ro khác: nó trả "đã abandon" cho mọi request FAILED có audit, nhưng một request chỉ đóng một lần nên không mâu thuẫn.
- **Owner/actor không từ body:** ĐẠT. `emptyBody` đứng sau `requireAuth,walletRole,writes`, handler chỉ dùng `req.params.id`, `req.user.id`, `req` (không đọc `req.body`). Body có khoá/mảng/chuỗi -> 400 (`routes/paypal.js` +dòng mới). Lưu ý nhỏ: body không phải JSON (urlencoded/text) có thể được parser bỏ qua và coi là rỗng; không gây hại vì handler không đọc body.

### Finding

| Mức | Mã | Nội dung | Vị trí |
|---|---|---|---|
| Thấp-Trung | F1 | `claimCapture` đổi `BUSY` -> `CLOSED` khi `changes!==1` mà request FAILED: đúng ý, nhưng là thay đổi quan sát được với caller cũ. Test cần khẳng định cả hai nhánh (BUSY khi lease còn hạn; CLOSED khi đã FAILED) và cần chạy store-concurrency `--pg` làm bằng chứng không hồi quy. | `paypalPaymentStore.js` ~392-399 |
| Thấp | F2 | Guard `audit.sql` chỉ kiểm tiền tố. Nên so bằng đúng hằng `INSERT_SQL` (xuất từ securityEvents) và kiểm `params.length===9`, hoặc store tự dựng INSERT từ dữ liệu có cấu trúc. | store `audit` guard; `securityEvents.js` `INSERT_SQL` |
| Thấp | F3 | Replay dựa vào cột mutable `last_reconcile_error` HOẶC LIKE trên text; hàng audit mới là nguồn bền. Chấp nhận, nhưng nên ghi rõ trong tài liệu: nếu bảng `security_events` bị dọn, replay sau khi cột bị ghi đè sẽ thành 409. | `paypalAbandonment.js:25-34` |
| Thấp | F4 | Close không đòi `capture_attempts` không đổi từ lúc GET; an toàn (xem trên), chỉ nhắc để test không khẳng định điều ngược lại. | `closeUncaptured` |
| Thông tin | F5 | Capture ngoài (cùng credential) giữa GET và close chỉ kết thúc ở RECOVERY_REQUIRED; không có chặn phía server. Cần ghi trong tài liệu. | nt |
| Thông tin | F6 | Mỗi lần 409 UNSAFE ghi một hàng `INVALID_STATE` best-effort (đường `logFromError`); chủ ví tự sinh được vài hàng/phút (rate limit 10/phút IP). Không phải audit của lần đóng. | `securityEvents.js` ERROR_TO_EVENT |

Không tìm thấy lỗi mức Cao/Trung bình ở backend sau khi S1-S5 áp dụng. Phần test (`test/paypal-abandonment-e2e.js`) CHƯA review: chờ Pro nhắn lần nữa. Danh mục sẽ kiểm: barrier thật trước assert, không dùng delay, assert không đạt giả, nhãn đỏ/xanh trung thực, không mock thẳng close, và hai test cũ nói trên.

## Giai đoạn 2 — test (đọc `test/paypal-abandonment-e2e.js` 644 dòng + `PRO-PAYPAL-ABANDONMENT-TEST-REPORT.md`; không chạy)

Tham chiếu dòng là tệp test hiện tại. Mục 5 của báo cáo test (lượt xanh: 1 assertion đỏ ở C10/S3) đã CŨ so với quyết định "replay = audit-only"; cần chạy lại trước khi chốt.

### (1) Barrier — ĐẠT, dựng thật
- **C4a (dòng 307-341):** `gate` bọc `providerLong.getOrder` (83-93): barrier nằm SAU khi adapter thật GET xong, trước khi `abandon` đi sang close. Precondition trước khi assert hành vi: `first==='hit'` (317); DB còn PENDING/READY (320); `inj.holdArrived` đã resolve, nghĩa là POST capture ĐÃ tới transport giả và đang treo (323, `wrapped` dòng 72); DB đọc thấy `IN_FLIGHT` + `capture_post_sent_at` + PENDING (325). Chỉ sau đó mới `g.release.resolve()` (326). `sleep(10000)` chỉ là timeout bảo vệ, không phải bằng chứng cạnh tranh; `until()` (dòng 20) khai báo nhưng không dùng. Thứ tự GET -> capture claim -> POST bay -> close được ép bằng deferred, không bằng thời gian.
- **C4c (375-394):** `need:2`, barrier mở khi cả hai abandon đã qua `getOrder`; precondition `first==='hit'` và request còn PENDING (383-384) trước khi thả. Đúng một ABANDONED + một ALREADY_ABANDONED, 1 audit, version +1, 0 POST.
- **C4b2 (359-373):** song song, KHÔNG barrier; không assert nào yêu cầu cả hai phía từng thắng, phân bố chỉ `info` (372). Chỉ là kiểm nhất quán bổ trợ, báo cáo cũng ghi vậy. Đạt.
- **Không phủ:** "capture giành claim nhưng CHƯA POST" giữa GET và close, và "claim rồi `finishCaptureAttempt(READY)` giữa GET và close thì close vẫn thắng an toàn" (T3). C4a chỉ phủ `IN_FLIGHT + đã POST`.

### (2) Assert không đạt giả — phần lớn ĐẠT, 1 ca RỖNG
- Đếm POST lấy từ nhật ký `net[]` của transport (52-76), ghi trước khi giữ/chuyển tiếp, không phải biến test tự đặt. `mutations(orderId)` đếm mọi phương thức khác GET. Status/evidence/audit/credit đều đọc từ DB (`snap`, `abandonEvents`, `H.credits`, `balance`, `ledger`).
- Các ca capture-PENDING ở C3a (235-250) là thật: `fake.order` có `currency/value` nên amount capture khớp, adapter trả `PENDING + captureId` (provider dòng 90) thay vì mismatch; do đó chỉ guard `!current.captureId` chặn được. `status>=400` hơi lỏng (mã chỉ in `info`).
- **T-F1 (Trung bình) — assert rỗng:** C10/S4 `markCapturePostSent` (616-617) gọi với `uuid()` ngẫu nhiên trên request READY không claim. `ok:false` xảy ra do `capture_claim=? AND capture_state='IN_FLIGHT'` không khớp, KHÔNG phụ thuộc EXISTS `pr.status='PENDING'` mới thêm. Bỏ EXISTS test vẫn xanh.
- `claimCapture` CLOSED ở C10/S4 (614-615) và C4b (350) đi qua nhánh JS `status==='FAILED' -> CLOSED` (store:380) nên cũng không chứng minh EXISTS mới trong UPDATE (M4).
- Dòng 604: `await allAbandonEvents() >= 0 && ...` luôn đúng ở vế đầu; assert vẫn có nghĩa nhưng gây nhầm.

### (3) Mock/fixture — ĐẠT; hai fixture DB làm yếu có giới hạn
- Router, runtime, store, settlement, adapter, DB đều thật; chỉ transport giả. Không mock `closeUncaptured` (gọi thật ở C5, C10).
- Hai fixture DB ở C3c (279-280, `RECOVERY_REQUIRED` PENDING và `READY` còn claim) bị chặn ở TIỀN KIỂM (`paypalAbandonment.js:42`; `count('get')-g0===0` ở 289 xác nhận không tới GET) nên chỉ chứng minh lớp tiền kiểm, KHÔNG chứng minh guard atomic của `closeUncaptured`. Không sai kết quả, nhưng yếu hơn nhãn "guard".

### (4) Nhãn đỏ/xanh — ĐẠT, cần hiệu chỉnh nhẹ
- Báo cáo mục 4 phân biệt đúng: phần lớn ca đỏ vì route chưa có (404); assert "không đổi/không audit/không POST" đạt ở nền chỉ vì 404 và được gắn nhãn "guard mới, không phải bằng chứng lỗi cũ"; caller cũ (C10 S2, C8, C9) đạt ở nền và phải đạt ở xanh. Không nói "tất cả đỏ".
- Hiệu chỉnh: chỉ **C1** (5 PENDING chặn ý định 6, precond đạt ở nền, không giải phóng được) thực sự tái hiện lỗi quota cũ. C2-C8, C10 đỏ ở nền là "tính năng chưa có"; C4a, C4c, C6 đỏ vì abandon 404 nên phần race/recovery CHƯA được thực thi ở nền. Tiêu đề "ĐỎ THẬT ở nền" dễ bị đọc là "tái hiện lỗi"; nên đổi.
- Mục 5 (xanh) phải chạy lại sau quyết định audit-only.

### (5) Mutation — đánh giá bằng đọc

| # | Mutation | Ca bắt | Kết luận |
|---|---|---|---|
| M1 | Bỏ `!current.captureId` (`paypalAbandonment.js:48`) | C3a capture-PENDING x3 (APPROVED / PAYER_ACTION_REQUIRED / VOIDED) sẽ thành 200 | BẮT |
| M2 | Bỏ kiểm `capture_claim` trong UPDATE (kể cả JS) của `closeUncaptured` | Không ca nào: `capture_state='READY'` vẫn chặn IN_FLIGHT (C4a); READY+claim (fixture C3c) bị tiền kiểm chặn trước khi tới close | KHÔNG CÓ CA BẮT |
| M3 | Bỏ `onlyNeverPosted` | Không ca nào: NOT_CAPTURED bị tiền kiểm `c.state!=='READY'` chặn, C10/S2 vẫn xanh | KHÔNG CÓ CA BẮT |
| M4 | Bỏ `EXISTS pr.status` khỏi UPDATE của `claimCapture` | Không ca nào: nhánh JS store:380 đứng trước (C4b, C10/S4) | KHÔNG CÓ CA BẮT |
| M4b | Bỏ `EXISTS pr.status` khỏi `markCapturePostSent` | Không ca nào (T-F1) | KHÔNG CÓ CA BẮT |
| M5 | Ghi audit SAU commit | C7 (trigger ép INSERT lỗi): kỳ vọng PENDING/READY, 5xx, 0 audit; mutation để request FAILED | BẮT |
| M6 | `last_reconcile_error` làm bằng chứng replay | C10/S3: ghi đè cột về NULL/chuỗi khác vẫn phải ALREADY_ABANDONED; `closeUncaptured` cũ reason `USER_ABANDONED` không audit phải 409 | BẮT |
| M7 | Bỏ `expectedOrderId`/`ORDER_CHANGED` | C10/S5 dùng provider trả `id` khác, bị adapter chặn (`PAYPAL_ORDER_MISMATCH`) trước khi tới store | KHÔNG CÓ CA BẮT |
| M8 | Bỏ allowlist `UNCAPTURED_ORDER_STATUS` | Mọi trạng thái adapter nhận không capture đều nằm trong tập; COMPLETED không capture adapter đã ném | KHÔNG CÓ CA BẮT (dư thừa, thấp) |
| M9 | Bỏ GET fresh hoặc đóng trước GET | C3a (timeout/mismatch/404) | BẮT |
| M10 | Bỏ `emptyBody` hoặc lấy actor từ body | C2 (7 khoá body, giả userId) | BẮT |
| M11 | Bỏ lọc IN_FLIGHT/post trong close (JS và UPDATE) | C4a | BẮT |

Gốc rễ M2/M3/M4/M7: guard atomic ở store bị tiền kiểm và nhánh JS đứng trước che, còn các ca "guard" đi qua đường ngoài. Cần ca mức store (gọi `closeUncaptured` thẳng, không qua tiền kiểm) hoặc chạy mutation thật trên bản sao.

### Finding test

| Mức | Mã | Nội dung | Vị trí |
|---|---|---|---|
| Trung bình | T1 | Khoảng trống M2, M3, M4/M4b, M7: không ca nào chạm trực tiếp guard atomic của `closeUncaptured` (claim, `onlyNeverPosted`, `expectedOrderId`) hay EXISTS status của claim/markPostSent. Đề xuất ca store-level: `closeUncaptured(id,{onlyNeverPosted:true})` trên (a) NOT_CAPTURED, (b) READY có claim (fixture), (c) `expectedOrderId` sai; mỗi ca kỳ vọng `closed:false` và request giữ nguyên. | C3c, C10 |
| Trung bình | T-F1 | Assert rỗng `markCapturePostSent` (claim ngẫu nhiên); xanh dù bỏ EXISTS. Cần claim thật + ép FAILED bằng fixture DB, hoặc bỏ nhãn S4 cho hàm này. | 616-617 |
| Thấp-Trung | T2 | Mục 5 báo cáo cũ so với quyết định audit-only; chạy lại SQLite và PG. | báo cáo mục 5 |
| Thấp | T3 | Chưa phủ barrier "claim nhưng chưa POST" và "claim rồi trả READY giữa GET và close". Thêm giữ preflight GET của capture để dừng giữa claim và `markCapturePostSent`. | C4a |
| Thấp | T4 | Hai fixture DB ở C3c chỉ chạm tiền kiểm; ghi rõ, không dùng làm chứng guard atomic. | 279-280 |
| Thấp | T5 | Đổi nhãn "ĐỎ THẬT" thành "đỏ vì tính năng chưa có"; chỉ C1 tái hiện lỗi cũ. | báo cáo mục 4 |
| Thấp | T6 | C3a capture-PENDING chỉ assert `status>=400`; nên assert `PAYPAL_ABANDON_UNSAFE`. Dòng 604 gây nhầm. | 248, 604 |

### (6) Hai test cũ
Test mới không sửa `paypal-m2-settlement-e2e.js` hay `paypal-store-concurrency-e2e.js`, không đăng ký vào suite chung, dùng DB riêng, khôi phục `runtimeModule.serializePayPal` (634) và gỡ trigger test-only trong `finally`. Ảnh hưởng lên test cũ chỉ có thể đến từ backend, đã đọc ở mục Giai đoạn 2 — backend: `paypal-m2-settlement-e2e.js:182` vẫn nhận `CAPTURE_IN_FLIGHT`; `paypal-store-concurrency-e2e.js` không bị ảnh hưởng về mặt đọc code, vẫn cần chạy thật cả `--pg`.
