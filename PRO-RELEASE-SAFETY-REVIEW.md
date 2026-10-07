# Review an toàn phát hành PayPal Sandbox (đọc code)

Nền mã: `5080e3a239b9935e22a35cc2c66e6e396f8cceda`, ứng dụng ở `cho-an-tam/`. Người review: agent cấp 3 `pro_release_acceptance_ba`.

**Phương pháp và giới hạn**: chỉ đọc code và tài liệu. Không chạy server, DB, trình duyệt, test, hay gọi PayPal. Mọi kết luận về hành vi là **suy ra từ đọc**, chưa kiểm chứng bằng chạy; mục "cách tái hiện" ghi rõ cái gì cần agent/Codex chạy. Bản vá của Codex chặn tạo top-up mock khi mock tắt chưa có trong hash này (xem F-01, đã biết).

Đường dẫn đều tương đối `cho-an-tam/` trừ khi nói khác.

## 0. Tóm tắt theo mức

| Mức | Finding |
|---|---|
| CHẶN phát hành | **Không có** finding nào chặn từ việc đọc code. Điều chặn là các bước thực nghiệm CHƯA CHẠY trong `CHECKLIST-NGHIEM-THU-PAYPAL-SANDBOX-PRO.md` (Sandbox thật, cookie/redirect thật, Windows Hello thật) |
| Đã biết (Codex đang vá) | F-01 mock topup bỏ qua `MOCK_PROVIDER_CHECKOUT` |
| Cần xử lý sau | F-02, F-03, F-04, F-05, F-06 |
| Thông tin | F-07, F-08, F-09, F-10, F-11, F-12, F-13 |

Không tìm thấy đường nào ghi tiền vào ví khi chưa có chứng cứ từ PayPal (mục 3). Không thấy token/secret lộ qua log/response/UI (mục 5).

---

## 1. Cấu hình làm UI và backend lệch provider

**Phạm vi đọc**: `src/lib/paypalRuntime.js` (toàn bộ), `src/routes/paypal.js`, `src/routes/payments.js`, `src/lib/mockPaymentProvider.js:246-248`, `src/routes/mockProvider.js:26-29`, `src/lib/reconciler.js`, `public/js/app.js:2966-3000` (`validApprovalUrl`, `readPayConfig`, `walletTopupCard`, `loadPayConfig`), `app.js:3204-3260` (tạo, mở approval).

Bảng quyết định (từ code):

| Cấu hình | `GET /paypal/config` (`paypalRuntime.js:91`) | UI | `POST /payments/paypal/topup` | `POST /payments/topup` (mock) |
|---|---|---|---|---|
| `PAYPAL_SANDBOX_ENABLED=1` và config hợp lệ | paypal=true, mock=false | thẻ PayPal | cho phép | 503 `MOCK_PAYMENTS_DISABLED` (`payments.js:78`) |
| `=1` nhưng thiếu/sai config (thiếu secret/merchant/webhook ID, origin không HTTPS thuần, lease < `4*timeout+10s`: `paypalRuntime.js:19-26`) | paypal=false, mock=false | "Nạp tiền chưa sẵn sàng" (`app.js:2997-3012`) | 503 `PAYPAL_DISABLED` (`paypalRuntime.js:42`) | 503 (cùng dòng 78) |
| không đặt, `MOCK_PROVIDER_CHECKOUT` khác `0` | paypal=false, mock=true | thẻ mock | 503 | cho phép |
| không đặt, `MOCK_PROVIDER_CHECKOUT=0` | paypal=false, mock=false | không cổng nào | 503 | **cho phép (lệch)**: F-01 |

Hai chiều "chặn lẫn nhau" đúng ở mọi dòng trừ dòng cuối. Giao diện đóng cổng khi config lỗi/404/sai dạng (`readPayConfig` `app.js:2976-2985`, `loadPayConfig` đặt `{paypal:false,mock:false}` khi lỗi), nên không có fallback âm thầm sang mock.

### F-01 (đã biết) `POST /api/payments/topup` không kiểm `MOCK_PROVIDER_CHECKOUT`

- **Mức**: đã biết, Codex đang vá, không tính phát hiện mới.
- **Tệp:dòng**: `src/routes/payments.js:78` chỉ kiểm `PAYPAL_SANDBOX_ENABLED==='1'`; `src/lib/mockPaymentProvider.js:247` (`isCheckoutEnabled`) và `src/lib/paypalRuntime.js:91` (`publicConfig`) mới tính `MOCK_PROVIDER_CHECKOUT!=='0'`.
- **Tái hiện**: cần chạy bởi Codex: server với `PAYPAL_SANDBOX_ENABLED` không đặt và `MOCK_PROVIDER_CHECKOUT=0`; gọi `GET /api/payments/paypal/config` (kỳ vọng mock=false) rồi `POST /api/payments/topup {"amount":100000,"requestId":"probe-0001"}` có token BUYER (kỳ vọng hiện tại 201, tạo hàng MOCK PENDING).
- **Tác động**: giao diện nói mock tắt nhưng backend vẫn nhận yêu cầu; hàng MOCK PENDING không thể tự tất toán (trang checkout mock trả 404). Chiếm hạn mức 5 pending/24h (`topupPolicy.js:8,41`).
- **Đề xuất**: Codex vá theo hướng đã có: dùng chung `provider.isCheckoutEnabled()` cho tạo mock.

### F-02 Mock webhook và quét đối soát mock vẫn chạy khi cờ PayPal bật

- **Mức**: cần xử lý sau (thông tin về độ tinh khiết khi nghiệm thu "mock tắt").
- **Tệp:dòng**: `src/routes/payments.js:157-187` (`/api/payments/webhook`, không kiểm cờ), `src/lib/reconciler.js:62-68` và `122-190` (vòng quét `provider='MOCK'` luôn chạy), `src/routes/payments.js:48-65` (`replayExisting` còn gửi lại hàng MOCK).
- **Đã đọc, giới hạn rủi ro**: webhook mock cần chữ ký HMAC từ `PAYMENT_WEBHOOK_SECRET` (rỗng thì luôn từ chối: `mockPaymentProvider.js:~110`, hàm `verifyProviderSignature`), và `applyProviderResult` chỉ cộng cho hàng `provider='MOCK'` (`paymentService.js:46-70`) khớp `provider_ref` và `amount`. Không thể dùng đường mock để cộng một yêu cầu PayPal (đã đọc `paymentService.js:62-65`: `Provider không khớp`).
- **Tái hiện**: cần chạy bởi Codex: cờ PayPal=1, có sẵn một hàng MOCK PENDING từ trước (tạo khi cờ tắt), gọi `/api/payments/webhook` với chữ ký hợp lệ (cần biết secret) hoặc chờ một lượt `reconcileOnce`; kỳ vọng hàng MOCK vẫn được tất toán.
- **Tác động**: nếu DB nghiệm thu từng chứa dữ liệu mock, số dư có thể đổi trong lúc nghiệm thu PayPal mà không do PayPal. Rủi ro thấp.
- **Đề xuất**: nghiệm thu trên DB không có MOCK PENDING (đã đưa vào PP-00), hoặc khoá hai đường này bằng cùng cờ.

---

## 2. Đường mock còn xử lý PayPal, và ngược lại

**Phạm vi đọc**: `src/lib/paymentService.js` (toàn bộ, 278 dòng), `src/routes/mockProvider.js`, `src/lib/reconciler.js`, `src/lib/paypalPaymentStore.js:225-233,282-293`, `src/lib/paypalSettlement.js:15-22`, `src/routes/payments.js`.

**Đã đọc `paymentService.js` và `mockProvider.js`; không thấy đường mock tác động hàng PayPal**: mọi `UPDATE`/`SELECT` mock lọc `provider='MOCK'` (`paymentService.js:62,172,185,199,207,229,255`; `mockProvider.js:44`); `applyProviderResult` từ chối `expectedProvider!=='MOCK'` (`paymentService.js:48`); `replayExisting` trả 409 `PAYMENT_PROVIDER_MISMATCH` cho hàng không phải MOCK (`payments.js:49`).

**Chiều ngược lại không thấy**: store PayPal chỉ đọc qua `SELECT_JOINED … WHERE pr.provider='PAYPAL_SANDBOX'` (`paypalPaymentStore.js:233`), nên `loadByRequestId`/`loadByOrderId` trả `null` cho hàng MOCK; `claimCapture`, `claimCreateAttempt`, `bindOrder` đều lọc provider; settlement kiểm `pr.provider==='PAYPAL_SANDBOX'` và binding (`paypalSettlement.js:18-22`, UPDATE điều kiện `provider='PAYPAL_SANDBOX'` ở dòng 33). Provider không đổi được vì trigger DB (`paypalPaymentStore.js:128-149`).

Ngoại lệ duy nhất đã nêu: F-01, F-02. Không đọc `src/schema*.sql` ngoài các tên migration; chưa kiểm chạy trigger.

---

## 3. Request nào có thể ghi tiền vào ví khi chưa có chứng cứ

Điểm ghi ví duy nhất của PayPal: `createPayPalSettlement().settle` (`src/lib/paypalSettlement.js:47-60`, giao dịch ở `13-45`). Điều kiện trong giao dịch: `provider='PAYPAL_SANDBOX'`, `provider_ref`, `amount`, `orderId`, `captureId` khớp binding; `source` thuộc `WEBHOOK|RECONCILER` (dòng 18-22); bằng chứng `markCaptureVerified`/`finishCaptureAttempt(VERIFIED)` (23-29); `UPDATE … status='SUCCEEDED' WHERE status='PENDING' AND version=?` (33-34); `TOPUP_CREDIT` khoá `topup:<id>` (39-42). Không có route nào gọi `settle` với dữ liệu client; `settle` chỉ được truyền vào `createCaptureCoordinator` và `createSandboxPaymentService` ở `paypalRuntime.js:38-41`.

Bằng chứng `captureId` chỉ đến từ `verifyOrder` (`paypalSandboxProvider.js:57-91`), buộc: `order.id`, `intent=CAPTURE`, đúng một purchase unit, `reference_id`/`custom_id` = id yêu cầu, `payee.merchant_id` = merchant cấu hình, USD và số cent khớp báo giá đã lưu, đúng một capture, `final_capture=true`, `capture.status==='COMPLETED'` và `order.status==='COMPLETED'` (dòng 62-87). Capture `PENDING/DENIED/REFUNDED` hoặc order chưa COMPLETED trả `status:'PENDING'` (dòng 89-90), không bao giờ vào `settle`.

| Request / nguồn | Ghi ví? | Căn cứ |
|---|---|---|
| `POST /api/payments/paypal/topup` | Không. Chỉ INSERT yêu cầu PENDING + binding, rồi tạo order | `paypalRuntime.js:46-62`, `paypalSandboxService.js:73-112` ("creation, approval, or a return URL never credits") |
| `GET /api/payments/paypal/:id/checkout` | Không | `paypalRuntime.js:93`, `serializePayPal` không gọi `settle` |
| Return/cancel (URL frontend) | Không. Chỉ frontend đọc `kind`,`id`, rồi GET trạng thái | `app.js:3354-3366`, `processPaypalCallback` |
| `POST /api/payments/paypal/:id/capture` | Có, chỉ khi `provider.captureOrder`/`getOrder` xác minh COMPLETED; có kiểm owner, claim, ghi dấu POST trước khi gọi mạng | `paypalCaptureCoordinator.js:13-60`; `paypal.js:24`; `paypalRuntime.js:92` |
| `POST /api/payments/paypal/webhook` | Có, chỉ sau (1) `verify-webhook-signature` SUCCESS với webhook ID cấu hình và (2) GET order thực và `result.captureId===resource.id` | `paypalSandboxService.js:126-142`, `paypalSandboxProvider.js:281-299` |
| Worker `reconcileOne` | Có, chỉ từ GET order COMPLETED; không POST capture | `paypalRuntime.js:85-89`, `reconciler.js:192-213` |
| `GET /api/payments/:id`, `/me` | Không (serialize chỉ đọc; tối đa gọi `getOrder` để đoán gợi ý) | `payments.js:13-30,138-143`; `paypalRuntime.js:63-84` |
| Quản trị (`/api/admin/*`) | Không có tham chiếu PayPal | grep `paypal` trong `src/routes/admin.js`, `transactions.js`: không có kết quả |
| Mock webhook `/api/payments/webhook` | Có, nhưng chỉ cho hàng `MOCK` đã ký HMAC | F-02 |
| Đăng ký Passkey (`DEMO_TOPUP`) | Có, số dư khởi tạo demo 5.000.000 VND, không phải PayPal, không có chứng cứ ngoài | `src/routes/passkeys.js:64,355-370`. Thông tin: đây là nguồn tiền "không chứng cứ" đã có từ trước, nằm trong danh sách `EXTERNAL_INFLOW_ENTRY_TYPES` (`src/lib/invariants.js:26`) |

**Đã đọc `paypalSettlement.js`, `paypalSandboxService.js`, `paypalCaptureCoordinator.js`, `paypalSandboxProvider.js`, `paypalPaymentStore.js`, `paypalRuntime.js`, `routes/paypal.js`, `routes/payments.js`; không thấy đường nào ghi ví khi chưa có capture COMPLETED đã xác minh với PayPal.** Chưa kiểm chứng bằng chạy.

Điểm cần lưu ý (không phải lỗ hổng): **người phê duyệt không bị ràng buộc là Personal Sandbox cụ thể** — adapter không kiểm danh tính payer, chỉ kiểm payee/amount/order. Bất kỳ tài khoản PayPal Sandbox nào mở được link phê duyệt đều có thể trả. Đây là cách thiết kế bình thường; checklist PP-03 yêu cầu người dùng xác nhận bằng mắt.

---

## 4. Idempotency, race capture–webhook–reconcile, khoá, đối soát

**Phạm vi đọc**: `paypalCaptureCoordinator.js` (63 dòng), `paypalPaymentStore.js:225-571`, `paypalSettlement.js`, `paypalSandboxService.js:56-145`, `paypalRuntime.js:43-62,85-95`, `asyncDb.js:8-25,104-181,256-290` (chỉ phần mô tả giao dịch/khoá), `reconciler.js:192-213`, `topupPolicy.js`.

Cơ chế (đã đọc):
- **requestId của client**: `UNIQUE (user_id, client_request_id) WHERE client_request_id IS NOT NULL` (`schema.pg.003-topup-idempotency.sql:14`); `create` kiểm lại trong giao dịch và từ chối khác số tiền/provider với 409 (`paypalRuntime.js:51-52`). Mọi giao dịch DB bị tuần tự hoá bằng mutex (SQLite) hoặc `pg_advisory_xact_lock` (PG) (`asyncDb.js:16-25,282-283`), nên hai request cùng khoá không lọt cùng lúc. **Đã đọc; không thấy lỗ hổng** (nên bỏ phỏng đoán "unique violation → 500").
- **PayPal-Request-Id**: hash cố định theo `phase`+`paymentRequestId` (`paypalSandboxProvider.js:185-188`), dùng cho create và capture. Retry sau timeout dùng cùng khoá; sau 5 phút chưa có order thì `PAYPAL_CREATE_RECOVERY_REQUIRED`, không tạo order mới (`paypalSandboxService.js:88-93`).
- **Ràng buộc DB**: `order_id UNIQUE`, `capture_id UNIQUE`, `CHECK` trạng thái (`paypalPaymentStore.js:99,109,115-120`); trigger bất biến (155-215); ledger khoá `topup:<id>` (`paypalSettlement.js:41`).
- **Race capture–webhook–reconcile**: cả ba đi vào `settle`. Người giữ claim dùng `finishCaptureAttempt` (kiểm token, `store.js:466`); webhook/worker dùng `markCaptureVerified` không token và xoá claim (`store.js:511-516`). Nếu holder cũ về sau, `STALE_CLAIM` làm `settle` ném `stale`, rollback, mở giao dịch mới ở chế độ không-claim (`paypalSettlement.js:23-27,49-50`) và nhận `DUPLICATE` (dòng 30). `UPDATE … WHERE status='PENDING' AND version=?` chốt đúng một người thắng (dòng 33-34).
- **Khoá/lease**: `claimCapture` giành lease có điều kiện trong một giao dịch (`store.js:383-393`); `markCapturePostSent` commit TRƯỚC lệnh POST (`coordinator.js:45-49`, `store.js:410-418`); đã POST rồi thì không quay READY (`store.js:467`); sau POST `UNKNOWN` buộc GET trước (`store.js:398`, `coordinator.js:37-44`).
- **Đối soát**: worker chỉ `getOrder`, không có đường gọi capture (`paypalRuntime.js:88`, `reconciler.js:201`).

**Đã đọc; không thấy lỗ hổng chia đôi tiền hoặc cộng hai lần.** Kiểm chứng bằng chạy do các suite `paypal-m2-settlement-e2e.js` T1/T6 và `paypal-store-concurrency-e2e.js` khẳng định (chưa tự chạy lại; số liệu là báo cáo của Codex/Max, không xác minh ở đây).

### F-03 Yêu cầu PayPal PENDING không bao giờ tự đóng, làm hết hạn mức tạo mới

- **Mức**: cần xử lý sau (không mất tiền; ảnh hưởng nghiệm thu lặp và vận hành).
- **Tệp:dòng**: `closeUncaptured` chỉ định nghĩa ở `src/lib/paypalPaymentStore.js:538-557` và chỉ được gọi trong test (`test/paypal-m2-settlement-e2e.js:182`, `test/paypal-store-concurrency-e2e.js:444-664`); `rg closeUncaptured src` không thấy lời gọi sản xuất. `finishCaptureAttempt` với `state:'NOT_CAPTURED'` cũng không được `coordinator` gọi (chỉ `UNKNOWN`/`READY`/`VERIFIED`: `coordinator.js:41,52,57`), nên giai đoạn `NOT_CAPTURED` (`paypalRuntime.js:79`) không đạt được từ code sản xuất. Hạn mức: `topupPolicy.js:8,41-42` (5 yêu cầu PENDING trong 24 giờ; thông báo lỗi bảo "hãy hoàn tất hoặc huỷ bớt" nhưng **không có API huỷ**), `topupPolicy.js:36,47` (`pending_total` cộng mọi PENDING không giới hạn tuổi vào trần số dư 200.000.000).
- **Tái hiện**: cần chạy bởi Codex (hoặc nghiệm thu thật): với một tài khoản, tạo 5 yêu cầu PayPal khác `requestId`, không phê duyệt; yêu cầu thứ 6 trong 24 giờ kỳ vọng 409 `TOPUP_LIMIT_EXCEEDED`. Kiểm tĩnh đã làm: `grep -rn closeUncaptured src` chỉ trả định nghĩa.
- **Tác động**: yêu cầu bỏ dở nằm PENDING mãi; worker còn GET chúng mỗi chu kỳ (`reconciler.js:196`, giới hạn 50/lượt, xoay vòng theo `last_reconciled_at`); người dùng bị khoá nạp tạm thời; `pending_total` làm giảm vĩnh viễn hạn mức số dư. Cũng giải thích vì sao `RECOVERY_REQUIRED` "sau FAILED" không đạt được trong sản xuất.
- **Đề xuất**: Codex quyết định chính sách hết hạn: ví dụ gọi `closeUncaptured` sau khi GET xác nhận order `VOIDED/EXPIRED` và chưa có POST (store đã hỗ trợ điều kiện an toàn), và/hoặc thêm API huỷ yêu cầu của chính chủ chưa POST. Trước đó, checklist giới hạn 4 yêu cầu/tài khoản/ngày.

### F-04 Người dùng phê duyệt xong nhưng không quay lại: không có nút capture, có thể không có link mở lại

- **Mức**: cần xử lý sau (liveness; an toàn tiền không bị ảnh hưởng vì không có capture nào xảy ra).
- **Tệp:dòng**: nút "Xác nhận…" chỉ hiện khi `notice.returned && !notice.unverified && matched` (`public/js/app.js:3116`); lịch sử cho giai đoạn `AWAITING_APPROVAL` chỉ có "Mở PayPal Sandbox" (`app.js:3076-3082`); link phê duyệt chỉ được cấp khi PayPal trả `payer-action`/`approve` (`paypalSandboxProvider.js:207-215`) và `current.status==='PENDING'` (`paypalRuntime.js:74`); nếu thiếu link UI báo "địa chỉ phê duyệt không hợp lệ" (`app.js:3284-3288`); worker không capture (`paypalRuntime.js:88`).
- **Chưa kiểm chứng**: PayPal có giữ link `approve/payer-action` cho order đã `APPROVED` hay không — không biết; cần Sandbox thật.
- **Tái hiện**: cần chạy bởi người dùng/Codex (mục PP-14): phê duyệt ở PayPal rồi đóng tab, mở lại ví, bấm các nút có sẵn.
- **Tác động**: nếu PayPal không trả link cho order APPROVED, người dùng chỉ hoàn tất được bằng cách vào lại URL `?paypal=return&paymentRequestId=<id>#/wallet` (gõ tay) trên đúng thiết bị có ý định; thiết bị khác thì `unverified` và không có nút capture (`app.js:3116`, thiết kế cố ý nhưng kẹt luồng).
- **Đề xuất**: Codex cân nhắc cho nút "Xác nhận…" xuất hiện cho mọi yêu cầu `AWAITING_APPROVAL` thuộc chính chủ khi GET order báo APPROVED (máy chủ đã kiểm trước POST: `provider.captureOrder` dòng 247-253 chỉ POST khi `APPROVED`).

### F-05 `GET /api/payments/me` (và `/:id`) hỏng nguyên danh sách khi một dòng PayPal gọi PayPal lỗi

- **Mức**: cần xử lý sau (fail-safe: không báo thành công giả, nhưng mất lịch sử).
- **Tệp:dòng**: `src/routes/payments.js:138-143` (`Promise.all(rows.map(serializePaymentRequest))`), `payments.js:28-29`, `paypalRuntime.js:67-71` (dòng có `capture.state==='UNKNOWN'` và `lastError==='PAYPAL_PAYER_ACTION_REQUIRED'` gọi `adapter.getOrder` mỗi lần liệt kê). `PayPalSandboxError` chỉ có `statusCode`, không có `status` (`paypalSandboxProvider.js:8-15`), nên trình xử lý lỗi chung dùng `err.status||500` (`src/server.js:148`) → 500 `INTERNAL_ERROR` chung và `console.error(err)` (`server.js:154`).
- **Tái hiện**: cần chạy bởi Codex: tạo hàng có `capture_state='UNKNOWN'`, `last_capture_error='PAYPAL_PAYER_ACTION_REQUIRED'`; làm `getOrder` timeout (fake provider hoặc chặn mạng staging); gọi `GET /api/payments/me` bằng chính chủ: kỳ vọng 500 cho toàn danh sách, kể cả hàng không liên quan.
- **Tác động**: một đơn hỏng chặn người dùng thấy lịch sử; UI `loadTopupHistory` lỗi; các gọi tuần tự tới PayPal lên tới số hàng như vậy trong một lần liệt kê (200 hàng tối đa), ảnh hưởng độ trễ và hạn mức API PayPal.
- **Đề xuất**: bắt lỗi từng dòng (trả dòng với `stage` từ DB và cờ "chưa xác nhận"), hạn chế số lần gọi PayPal trong `/me`.

### F-06 Script/endpoint bất biến vận hành không gồm 3 bất biến PayPal

- **Mức**: cần xử lý sau.
- **Tệp:dòng**: `scripts/check-invariants.js:15,19` và `src/routes/admin.js:736-738` chỉ gọi `checkInvariants` (9 bất biến); `src/lib/paypalInvariants.js:3-10` chỉ được dùng ở `test/helpers/paypal-m2-harness.js:134-136` và `test/paypal-integration-e2e.js:165`. `PAYPAL-SANDBOX-INTEGRATION.md` mục 5 nói cố ý tách để không đổi "9 bất biến" của báo cáo đồ án; hậu quả: `npm run check:invariants` trên DB nghiệm thu không kiểm số `TOPUP_CREDIT` theo `capture_id`.
- **Tái hiện**: tĩnh (đã thực hiện): `rg checkPayPalInvariants` chỉ trả test và harness. Không cần chạy.
- **Tác động**: người nghiệm thu có thể tin `check:invariants` đạt là đủ.
- **Đề xuất**: thêm lệnh/endpoint riêng cho 3 bất biến PayPal (không đổi số 9); trước đó dùng SQL chỉ-đọc của PP-15.

---

## 5. Lộ token/secret trong log/response/UI

**Phạm vi đọc**: `paypalSandboxProvider.js` (toàn bộ), `routes/paypal.js`, `paypalRuntime.js:91` (config công khai), `server.js:132-166` (trình xử lý lỗi), `securityEvents.js:119-157`, `paypalSettlement.js:52-58`, `paypalCaptureCoordinator.js:55-59`, `reconciler.js:206-211,228-232`, `public/js/app.js:3039-3200,3354-3366`.

**Đã đọc; không thấy lộ secret/token qua log, response hay UI do server**:
- Adapter chỉ giữ `upstreamStatus` và `issue` trong danh sách trắng (`ORDER_ALREADY_CAPTURED`, `PAYER_ACTION_REQUIRED`), thông báo cố định "PayPal Sandbox request was rejected" (`paypalSandboxProvider.js:126-135`); mọi lỗi mạng đổi thành `PAYPAL_UNAVAILABLE` không mang lỗi gốc (dòng 145-148). Header `Authorization` chỉ nằm trong lời gọi `fetch` (dòng 151-175).
- Router rút gọn lỗi 5xx thành câu chung (`routes/paypal.js:14-20`); 4xx dùng thông báo tĩnh của store/adapter.
- Log vận hành chỉ in mã lỗi (`coordinator.js:58`, `settlement.js:55-57`, `reconciler.js:209,228-231`); cột `last_reconcile_error` lưu `error.code` (`reconciler.js:209`).
- `GET /paypal/config` chỉ có `enabled`, `mode`, `rateKind`, `mockPayments.enabled` (`paypalRuntime.js:91`).
- Log lỗi 500 chung dùng `console.error(err)` (`server.js:154`): object lỗi `PayPalSandboxError` không chứa body/headers (đã đọc lớp, dòng 8-15 và 126-135).
- Sự kiện bảo mật chỉ ghi `paymentRequestId`, `amount`, `source`, `provider` (`paypalSettlement.js:54`).

Chưa kiểm chứng bằng chạy: nội dung `console` thực của máy chủ khi PayPal thật trả lỗi; log của Railway/Vercel/proxy (ngoài code); UI không dùng SDK nên không có bí mật từ phía trình duyệt trừ F-08.

### F-08 URL quay lại có `token` (order ID) và `PayerID` trước khi bị dọn; access token JWT nằm ở `localStorage`

- **Mức**: thông tin.
- **Tệp:dòng**: `public/js/app.js:3354-3366` (đọc rồi `history.replaceState` xoá query), `app.js:4384` (gọi sớm trong `init`); `app.js:26,534` (`localStorage.cat_token`).
- **Tái hiện**: cần chạy bởi người dùng/Codex: mở URL `…/?paypal=return&paymentRequestId=<id>&token=T&PayerID=P#/wallet` và quan sát lịch sử/thanh địa chỉ trước khi JS xoá; xem log truy cập của máy chủ phục vụ frontend (ngoài code).
- **Tác động**: `token` là order ID (ID giao dịch Sandbox), `PayerID` là ID người mua; có thể nằm trong log truy cập của host frontend và trong ảnh chụp lúc tải. Không phải bằng chứng thu tiền (doc nêu, và code không dùng chúng). JWT ở localStorage lộ cho XSS cùng origin (đã chấp nhận ở thiết kế).
- **Đề xuất**: ghi vào quy ước bằng chứng (đã đưa vào checklist). Tuỳ chọn: Codex cân nhắc `Referrer-Policy: no-referrer` nếu chưa có (chưa đọc `securityHeaders`).

---

## 6. Finding thông tin khác

### F-07 Webhook trả 200 cho mọi kết quả hợp lệ về chữ ký, kể cả CONFLICT/RECOVERY_REQUIRED/STILL_PENDING

- **Mức**: thông tin / cần theo dõi.
- **Tệp:dòng**: `src/routes/paypal.js:25` (`res.json(await runtime.webhook(...))`), `paypalSandboxService.js:56-70,142`, `paypalSettlement.js:28-29,52-58` (chỉ `APPLIED` mới ghi sự kiện bảo mật/thông báo; không có `logSecurityEvent` cho `CONFLICT`/`RECOVERY_REQUIRED` bên PayPal, khác nhánh mock `reconciler.js:174-182`).
- **Tái hiện**: cần chạy bởi Codex: webhook COMPLETED hợp lệ cho yêu cầu có `capture_id` khác (CONFLICT) hoặc yêu cầu đã FAILED (RECOVERY_REQUIRED); kỳ vọng HTTP 200 và không có hàng `security_events`.
- **Tác động**: PayPal dừng giao lại khi nhận 2xx; sự cố đối soát chỉ lộ nếu người vận hành tự kiểm `last_capture_error`. Webhook với GET order đang `PENDING` (độ trễ nhất quán) trả 200 `STILL_PENDING` và dựa vào worker (an toàn vì worker GET lại, `reconciler.js:192-213`).
- **Đề xuất**: ghi `RECONCILE_CONFLICT` cho nhánh PayPal; đếm `conflict` trong `summary.paypal`.

### F-09 Giới hạn tần suất theo IP và `TRUST_PROXY`

- **Mức**: thông tin / xác nhận cấu hình.
- **Tệp:dòng**: `src/lib/rateLimit.js:46-52` (khoá theo `req.ip`), `routes/paypal.js:11-13` (bucket `paypal-auth-writes` 10/phút dùng chung cho tạo và capture; `paypal-checkout` 20/phút; `paypal-webhook` 60/phút), `src/server.js:76` (`trust proxy` chỉ bật khi `TRUST_PROXY=1`), `src/lib/session.js:111-115` (`Secure` chỉ khi `req.secure`).
- **Tác động**: nếu API sau proxy mà `TRUST_PROXY` chưa đặt, mọi người dùng và có thể cả webhook chung một IP proxy → 429 chéo, và cookie refresh có thể thiếu `Secure`. Gate A đã yêu cầu kiểm.
- **Tái hiện**: cần chạy ở staging có proxy: hai tài khoản từ hai máy thật; đếm 429; xem `Set-Cookie`.
- **Đề xuất**: giữ trong PP-00 và PP-11.

### F-10 Mặc định `PAYPAL_FRONTEND_ORIGIN` là origin production

- **Mức**: thông tin.
- **Tệp:dòng**: `src/lib/paypalRuntime.js:15` (`||'https://enclave.id.vn'`), `paypalRuntime.js:40` (URL return/cancel sinh từ đây).
- **Tái hiện**: cần chạy bởi Codex trên staging không đặt biến này: `POST /paypal/topup`, đọc `approvalUrl`/`return_url` từ phía PayPal (hoặc fixture) — kỳ vọng URL trỏ `enclave.id.vn`.
- **Tác động**: người nghiệm thu bị đưa về site production sau khi phê duyệt; yêu cầu không tồn tại ở DB đó (404). Không sai về tiền.
- **Đề xuất**: đã có trong PP-00; tuỳ chọn Codex bỏ giá trị mặc định (bắt buộc đặt khi bật).

### F-11 Lease capture có thể ngắn hơn thời gian tối đa của một lượt khi `PAYPAL_TIMEOUT_MS` lớn

- **Mức**: thông tin (mặc định an toàn).
- **Tệp:dòng**: ràng buộc `leaseMs >= 4*timeoutMs+10000` (`paypalRuntime.js:24`) trong khi lượt `mustVerifyFirst` có thể gồm lấy OAuth + `getOrder` + preflight GET + POST + GET cuối = 5 lời gọi (`coordinator.js:37-54`, `paypalSandboxProvider.js:151-175,241-275`).
- **Tái hiện**: tính toán: `timeout=30000`, `lease=130s` < 5×30s=150s. Mặc định 10s/120s thì 50s < 120s (an toàn). Cần chạy bởi Codex nếu muốn chứng minh.
- **Tác động**: nếu cấu hình sát giới hạn, holder thứ hai có thể giành lease khi holder đầu còn chạy. Giảm nhẹ nhờ `PayPal-Request-Id` cố định, `mustVerifyFirst` luôn đúng sau POST (`store.js:398`), và STALE_CLAIM (`store.js:466`).
- **Đề xuất**: dùng `5*timeout+10s` hoặc giữ mặc định khi nghiệm thu.

### F-12 Xác minh chữ ký webhook dựa trên JSON đã parse, chưa kiểm với sự kiện ký thật

- **Mức**: thông tin / chưa kiểm chứng.
- **Tệp:dòng**: `src/server.js:81` (`express.json`), `routes/paypal.js:25` truyền `req.body`; `paypalSandboxProvider.js:281-299` gửi `webhook_event: event` (đối tượng đã parse) tới `verify-webhook-signature`.
- **Tái hiện**: cần chạy bởi người dùng: Resend một event thật từ dashboard Sandbox (PP-08) và xem HTTP trả về.
- **Tác động**: nếu việc tuần tự lại JSON làm sai chữ ký, mọi webhook thật sẽ bị 401 và PayPal giao lại; tiền không sai (đường API/worker vẫn tất toán) nhưng bước "webhook được xác minh" chưa được chứng minh. Chưa biết kết quả với PayPal thật.
- **Đề xuất**: giữ trong PP-08; nếu 401, Codex lấy raw body.

### F-13 Callback `?paypal=…` còn chờ không bị xoá khi đăng xuất

- **Mức**: thông tin.
- **Tệp:dòng**: `public/js/app.js:47,4384` (gán `state.paypalCallback`), `app.js:3376-3378` (chỉ xoá khi đã xử lý, kể cả khi người dùng không đăng nhập thì `return` trước dòng 3378), `app.js:2587-2592` (`resetTopupFlow` không đụng `paypalCallback`).
- **Tái hiện**: cần chạy bởi Codex (jsdom/trình duyệt): mở URL return khi chưa đăng nhập, đăng nhập bằng tài khoản khác, vào ví; kỳ vọng `GET /api/payments/<id>` trả 403 và toast lỗi (xem `payments.js:195`). Không có tác động ví vì máy chủ kiểm chủ sở hữu.
- **Tác động**: toast lỗi gây nhầm lẫn; không rò dữ liệu (máy chủ trả 403).
- **Đề xuất**: xoá `state.paypalCallback` trong `clearSession`/`resetTopupFlow` hoặc gắn với `userId`.

---

## 7. Danh sách "đã đọc, không thấy"

| Hạng mục | Đã đọc | Kết quả |
|---|---|---|
| Chọn Live/host tuỳ ý | `paypalSandboxProvider.js:5,93-111,119`, `paypalRuntime.js:12-26` | Không thấy. Host cố định `https://api-m.sandbox.paypal.com`; `validConfig` chỉ chấp nhận `baseUrl` rỗng hoặc Sandbox; approval chỉ `https://www.sandbox.paypal.com` ở cả server (`paypalSandboxProvider.js:207-215`) lẫn UI (`app.js:2966-2975`) |
| Tạo order thứ hai cho cùng yêu cầu | `paypalSandboxService.js:73-112`, `paypalPaymentStore.js:314-345` | Không thấy. `create_attempt_at` chỉ ghi một lần, có order thì chỉ GET, `bindOrder` idempotent cho cùng order |
| Bypass owner | `routes/paypal.js:21-24`, `paypalRuntime.js:43-45`, `coordinator.js:14-22`, `store.js:362-370` | Không thấy: `requireAuth`+`requireRole('BUYER','SELLER')`, chủ sở hữu kiểm ở runtime, coordinator và store |
| Tin dữ liệu client cho số tiền/báo giá | `paypalRuntime.js:46-62`, `paypalSandboxProvider.js:36-55`, `store.js:63-76` | Không thấy: số tiền VND parse từ body, báo giá do server tạo và lưu bất biến, verifyOrder so với báo giá lưu |
| Đổi merchant giữa chừng | `paypalRuntime.js:35-36,43-45` | Chặn bằng `merchantGuard` (409), kể cả worker/webhook |
| Webhook không ký | `paypalSandboxProvider.js:281-299`, `paypalSandboxService.js:126-142` | Không thấy: header đủ, `cert_url` thuộc origin PayPal và đường `/v1/notifications/certs/`, ký xác minh qua API PayPal, rồi GET order |

## 8. Những gì chưa kiểm chứng bằng chạy

- Toàn bộ finding F-01…F-13: **chưa tái hiện bằng chạy**; ghi rõ "cần chạy bởi Codex/người dùng" ở từng mục.
- Chưa đọc: `src/schema*.sql` (nội dung trigger/CHECK), `src/lib/securityHeaders`/CSP, `src/lib/walletOps.js`, `public/js/config.js`, `PAYPAL-STORE-DESIGN.md`, `HOP-DONG-API-PAYPAL-P2-M2.md`, `CHECKLIST-P2-PRO-PAYPAL-UI.md` (đã biết từ `PAYPAL-SANDBOX-RELEASE-GATES.md` mục 8 rằng hợp đồng cũ lỗi thời ở điểm GET có thể gọi mạng).
- Số liệu test (1006/997, 85/67/34, 50, 208/208) lấy từ tài liệu, không xác minh.
- Không đánh giá `PRO-RELEASE-BACKEND-QA.md` và `PRO-RELEASE-RUNNER-REVIEW.md` (giai đoạn 2, chưa được giao).

---

## 9. Review chéo runner (giai đoạn 2, phần 1)

Đối tượng: `PRO-RELEASE-RUNNER-REVIEW.md` (63 dòng). Phương pháp: tự đọc `cho-an-tam/test/browser/paypal-wallet-browser.js` (155 dòng) và `paypal/harness.js:16-25,170-183`; **không đọc** `runner-safety-unit.js`, không đọc log gốc của lượt chạy (báo cáo không đính log; log nằm ở scratchpad của agent kia, tôi không có). Không chạy gì.

### 9.1 Kết luận từng câu hỏi

1. **Kết luận có log/trích dẫn thật không?** Phần lớn là tóm tắt, không có log dán vào. Các con số (458/1/54/186,4 s, probe 17176/5288/2865 ms, 11/11 chrome.exe) là lời kể, tôi không kiểm được. Riêng thông điệp "Cleanup failed: browser cleanup timed out" **khớp với code**: chỉ `paypal-wallet-browser.js:122` tạo nhãn `'browser cleanup'` và `harness.js:18` ghép thành `"<nhãn> timed out"`; `paypal-wallet-browser.js:127` in `Cleanup failed:`. Mức vượt bằng chứng: câu "máy tải nên close chậm" là **suy luận** (probe 2/3 mẫu > 5 s, mẫu 2865 ms < 5 s; không có mẫu đo trong chính lượt FAIL).
2. **Có cộng lẫn tự chạy với lịch sử Codex không?** Không. Bảng cuối tách hai cột và ghi "tải máy cao nên thời gian không so được". Điểm cần diễn đạt chặt hơn: "458/458 assertion qua" đúng **chỉ khi** FAIL=1 là cleanup. Code xác nhận cơ chế: cleanup lỗi cộng `totals.fail++` (dòng 127) mà không phải assertion; báo cáo ghi "dòng ❌ trong ca: 0" nên nhất quán, nhưng đó là lời kể chưa có log.
3. **"FAIL duy nhất là browser cleanup timed out do hạn 5 s ở dòng 122" — XÁC NHẬN về cơ chế, CHƯA XÁC NHẬN về nguyên nhân gốc.**
   - Đã xác nhận bằng đọc code: dòng 122 đúng là `h.withDeadline(browser.close(), 5000, 'browser cleanup')`; chỉ nó sinh được thông điệp đó; lỗi cleanup làm `errors` khác rỗng nên `lock.release()` **không** được gọi (dòng 124-125), `totals.fail++` (127), `main` trả 1 (dòng cuối `totals.fail ? 1`); sau đó `process.exit(code)` làm tiến trình chết nhưng thư mục khoá còn nguyên, và `acquire` ném `Stale browser lock; verify manually` khi chủ không sống (dòng 40-46). Vậy việc khoá "còn lại với pid chết" là hệ quả đúng của code, khớp quan sát của Pro.
   - Nhãn "chặn vận hành" cho F1 là hợp lý (mọi lượt kế tiếp, kể cả của Codex, bị từ chối đến khi gỡ tay).
   - Chưa chứng minh: (a) `browser.close()` chậm vì tải; `closeAllSessions()` và `browser.close()` chạy **song song** (dòng 120-123), nên close có thể chậm một phần do đóng context đồng thời, chưa tách; (b) Chrome của runner đã thoát hẳn: báo cáo dựa vào kiểm command line, nhưng code cho phép giả định hợp lý vì `process.exit` làm đóng pipe playwright (dòng `launch` không dùng `--remote-debugging-port`); không tự kiểm.
   - Hạn 5 s ở dòng 122 chỉ áp cho **browser**, còn context/fixture cũng 5 s (`harness.js:176-177`); nếu các đóng này là điểm nghẽn thì chúng sẽ sinh thông điệp khác ("context cleanup"/"fixture cleanup") — báo cáo không thấy, nhất quán với kết luận.
4. **Nhãn "chưa kiểm chứng" cho SIGINT/SIGTERM/kill: GIỮ ĐÚNG.** Code có handler (`onSignal`, dòng 129-131) nhưng không ai đã chạy tín hiệu thật; nhận xét Windows (kill từ tiến trình khác là cưỡng bức, không gọi handler) là đúng về nguyên lý, tôi không kiểm. Unit chỉ phủ huỷ chờ khoá và lỗi cleanup theo báo cáo; tôi không đọc unit.
5. **Bằng chứng mềm "chrome.exe 11/11" cho exit 2: đủ ở mức "không mở Chrome", nhưng chính đếm process là phần yếu.** Đếm tổng trong khi người dùng có Chrome riêng dễ bỏ sót một lần mở headless ngắn. Bằng chứng đủ nhờ thứ tự code: `selectSpecs` là lệnh đầu của `main` (dòng 106 trở đi) và ném trước `findChrome`, trước khi tạo `createLock`; mọi mã thoát 2 trong bảng CLI đều đến từ nhánh `selectSpecs` (kiểm: `--only=`, `--only=B5,` rơi vào `!id`; `--bogus` vào `Invalid runner arguments`; spec thiếu vào `exists`). Tôi khuyên bỏ "11/11" khỏi luận cứ, giữ thứ tự code + "không có khoá TEMP mới".

### 9.2 Finding review (theo mức)

| Mức | Finding |
|---|---|
| CHẶN (đúng nhãn của tác giả) | R-1: khoá `%TEMP%\enclave-paypal-browser.lock` bị giữ khi cleanup lỗi dù không có Chrome sống; xác nhận bằng code (`paypal-wallet-browser.js:40-46,122-127`) và bằng Pro (pid 19068 chết, đã gỡ). Nguyên nhân gốc "máy tải" **chưa chứng minh**, là giả thuyết khả dĩ. Đề xuất giống tác giả: nâng hạn dòng 122 (30-60 s) và/hoặc, khi timeout, kiểm Chrome con đã thoát trước khi quyết giữ khoá; in đường dẫn khoá và pid trong thông điệp. Lượt xanh chỉ có giá trị khi chạy lại trên máy ít tải |
| Cần xử lý sau | R-2: báo cáo không đính log; nên dán dòng kết quả cuối và dòng `Cleanup failed` nguyên văn. R-3: cleanup chạy song song `closeAllSessions` và `browser.close` (dòng 120-123); tác giả đã nêu là F3 chưa tái hiện; tôi đồng ý đó là một nguyên nhân cạnh tranh cần tách khi chẩn đoán R-1 |
| Thông tin | R-4: câu "458/458 qua, lượt không xanh" đúng nhưng nên ghi rõ FAIL=1 là cleanup (không phải assertion), vì `totals.fail` cộng cả hai loại. R-5: không lẫn tự chạy với lịch sử Codex; con số lịch sử (73,2 s, exit 0) là lời kể của tài liệu khác, chưa kiểm. R-6: SIGINT/SIGTERM/kill vẫn chưa kiểm chứng (nhãn đúng). R-7: đếm `chrome.exe` 11/11 không nên làm luận cứ |

Giới hạn review chéo: không có log gốc, không đọc `runner-safety-unit.js`, không chạy lại; mọi chữ "xác nhận" ở trên chỉ nói về điều đọc được trong hai tệp runner/harness ở hash 5080e3a.

---

## 10. Review chéo backend (giai đoạn 2, phần 2)

Đối tượng: `PRO-RELEASE-BACKEND-QA.md` (78 dòng) và `cho-an-tam/test/evidence/pro-release/backend/` (131 tệp: 92 .log, 25 .err, 9 .txt, 5 .md, 4 .json; 646 KB). Chỉ đọc; tôi chạy duy nhất một đoạn node đọc log (không server/DB/Chrome) để đếm lại bằng chính `scripts/count-marks.js`.

### 10.1 Đối chiếu số với log

| Số trong báo cáo | Log đối chiếu | Kết quả |
|---|---|---|
| SQLite 1006 PASS, exit 0, 26 mục | `sqlite-suite-console.log` ("1006 phép kiểm đạt, 0 hỏng", 25 dòng bộ + dòng check-invariants), `sqlite-suite-exit.txt` (`exit=0`, 15:54:25 đến 16:00:38) | Khớp |
| PG 997 PASS, exit 0 | `pg-suite-console.log`, `pg-suite-exit.txt` (`exit=0`, 16:04:08 đến 16:08:50) | Khớp |
| 27/27 hardening, rate limit 10 | `sqlite-hardening10-console.log`, `pg-hardening10-console.log` (27 ✓ 0 ✗), `hardening10-exit.txt` (cả hai exit=0); `reports-*-hardening10/hardening-e2e.log` không còn dòng "bỏ qua" | Khớp. "36" trong console = 27 + 9 giả, như báo cáo nói |
| 106 store-concurrency | `sqlite-paypal-store.log`: `[sqlite/migration] 106`, `[sqlite/proposed] 106`, ALL PASS; `pg-paypal-store-concurrency.log`: `[pg/migration] 106`, `[pg/proposed] 106`, ALL PASS; exit 0 trong `extra-exit.txt` và `pg3-exit.txt` | Khớp. Lưu ý: "4 chế độ" là tổng hai log (mỗi log 2 chế độ), không phải một log có 4 |
| 9 migration (PG) | `pg-paypal-binding-migration.log` "Migration checks passed: 9" (gồm hai lần khởi động); SQLite log là 8 | Khớp; số 9 chỉ của PG |
| 12 evidence-upgrade | `pg-paypal-evidence-upgrade.log`: 12 dòng ✅ = 6 SQLite + 6 PG trong một lượt; `sqlite-...log` 6; `pg-evidence-exit.txt` exit=0 | Khớp; 12 gồm cả SQLite, không nên đọc là "12 trên PG" |
| 47/47 m2-recovery | `pg-paypal-m2-recovery.log` và `sqlite-m2-recovery-freshdb-run2.log` kết thúc bằng "47 đạt, 0 hỏng, 0 lỗi đã biết" | Khớp cho các lượt xanh |

### 10.2 Cách tính 1006 / 997 / 988 (tự kiểm)
- `run-suite.js:204` cộng cứng `pass: 9` khi `check-invariants` exit 0 (không đếm từ log). Xác nhận.
- Tôi đếm lại mọi `*.log` trong `reports-*-full` bằng `countMarks` (đếm dòng bắt đầu bằng ✅/❌, `count-marks.js:8-15`): SQLite **997**, PG **988**, hardening10 mỗi nền **27**, 0 ❌ ở cả bốn thư mục; chỉ `check-invariants` lệch (JSON 9, log 0) đúng như dự báo.
- Tổng cộng từng bộ trong `sqlite-suite-console.log` = 997; thêm 9 = 1006. PG: `manual-transaction-amount` 43 (ít 3) và `topup-idempotency` 76 (ít 6) so với SQLite = 988; thêm 9 = 997. Trùng hợp "chênh 9" giữa backend (3+6) và "9 PASS giả" là **hai đại lượng độc lập**; báo cáo tách đúng. Không cộng lẫn khác loại/khác backend.
- Dòng "bỏ qua" có thật: `reports-sqlite-full/hardening-e2e.log`, `reports-pg-full/hardening-e2e.log`, `reports-pg-full/topup-idempotency-e2e.log` (mỗi tệp 1 dòng).

### 10.3 Lượt đỏ đầu (thiếu BASE_URL)
Được giữ: `attempt0-summary.md` và `attempt0-sqlite-console-no-BASE_URL.log`; bảng kết quả dán đủ (74 PASS, nhiều FAIL). Hai điểm chưa chính xác:
- "22/24 bộ đỏ" nên là **21/24 bộ + rollback-e2e = 22 mục FAIL**; 3 bộ xanh là count-marks-unit, invariants-unit, username-enumeration-e2e (chạy server riêng).
- "74 PASS chỉ từ các bộ không cần server" gồm **9 PASS giả của check-invariants**: 14+39+12 = 65 thật, +9 giả = 74.
Cũng chưa có: log từng bộ của lượt đỏ (chỉ có summary và console), nên số "ECONNREFUSED" trong F1 không đối chiếu được từ evidence. Không thấy dấu hiệu giấu lượt đỏ.

### 10.4 F2 (m2-recovery): mức bằng chứng và kết luận
- Số lượt khớp `*-exit.txt`: SQLite 8 lượt, 7 đỏ (`extra-exit.txt`=1, `rerun-exit.txt` 3×1, `rerun-clean-exit.txt` 2×1, `rerun2-exit.txt` run1=1/run2=0); PG 3 lượt, 2 đỏ (`extra-exit.txt`=0, `rerun2-exit.txt` 2×1). Khớp báo cáo.
- Thông điệp lỗi có thật: `pg-m2-recovery-run2.log.err` có `EPERM … rmdir …paypal-m2-recovery-state.json.lock` tại `helpers/paypal-m2-fake.js:98` (qua `read` → `pendingEffects`) và `capture child exited before durable POST barrier: 0 null` kèm `CHILD_ERROR PAYPAL_UNAVAILABLE` trong log.
- Mức ghi trong báo cáo (n nhỏ, một máy, chưa Linux, Defender chưa chứng minh) là đúng và đủ; nhãn "nguyên nhân tác nhân quét chưa chứng minh" được giữ.
- **Vượt bằng chứng / chưa được chứng minh bằng evidence**:
  1. Các thí nghiệm phân biệt vị trí và vá một dòng (gốc 5/5 đỏ, bản sao ASCII 4/4 đỏ, Temp 6/6 và 4/4 xanh, sau vá 5/5 và 6/6 xanh) **không có log nào trong thư mục evidence**; chỉ là lời kể. Kết luận "vị trí quyết định chứ không phải ký tự đồ án" và "vá dòng 98 là đủ" cần log hoặc để Codex tái hiện.
  2. Các lượt đỏ dừng sớm ở R3/R4 (log kết thúc ngay sau `[observe-child-exit]`), nên các assertion phục hồi phía sau **không được chạy** trong các lượt đó; đỏ không nói gì về logic phục hồi, nhưng cũng không chứng minh logic ấy đúng ở các lượt đỏ. Bằng chứng cho logic là các lượt xanh 47/47 (3 lượt: SQLite 1, PG 1, cộng lượt Temp theo lời kể).
  3. Việc `PAYPAL_UNAVAILABLE` trong tiến trình con cũng do EPERM tương tự là suy luận hợp lý, chưa có stack của tiến trình con (`child stderr=` rỗng).
  4. Kết luận "harness, không phải logic phục hồi sản phẩm": **được hỗ trợ ở mức hợp lý** (stack nằm trong `test/helpers/paypal-m2-fake.js`, một tệp test; khoá thư mục đó là khoá của fake) nhưng nên diễn đạt là "lỗi nằm ở helper test; không có chứng cứ lỗi logic sản phẩm", không phải "đã chứng minh sản phẩm đúng". Bất kể, mâu thuẫn với tài liệu cũ (`PAYPAL-SANDBOX-RELEASE-GATES.md` §1 chỉ nhắc một lần R3 lỗi barrier rồi chạy lại đạt) cho thấy bộ này **không ổn định trên máy này**; gate "M2 xanh" nên ghi đây là điều kiện môi trường.
- Cosmetic: các đường dẫn trong F2 của báo cáo mất dấu `\` (hiển thị `Downloadsđồ án`, `C:Users	ranq`).

### 10.5 Secret/token/chuỗi kết nối
Quét toàn bộ thư mục evidence (đệ quy) bằng các mẫu: URL postgres có mật khẩu, `password=`/`secret=`, `JWT_SECRET`, `PAYMENT_WEBHOOK_SECRET`, `Bearer …`, `eyJ…` (JWT), `client_secret`, `access_token`, `PGPASSWORD`, `-----BEGIN`, `DATABASE_URL`/`postgresql://`: **0 khớp**. Lời báo cáo "không chứa JWT_SECRET/PAYMENT_WEBHOOK_SECRET" đúng. Ghi chú nhỏ: log chứa đường dẫn tuyệt đối có tên người dùng Windows (`C:\Users\tranq\…`) và tên DB test; không phải bí mật nhưng nên lưu ý nếu đẩy lên PR.

### 10.6 Tệp rác
Không có `.env*`, `.db`/`.sqlite*`, `.dump`, `.sql`, `.bak`, `.png` trong evidence (chỉ .log/.err/.txt/.md/.json). `git status` thấy `?? test/evidence/` chưa theo dõi (đúng như báo cáo nói). 25 tệp `.err` rỗng hoặc chỉ cảnh báo, không nhạy cảm.

### 10.7 Finding review (theo mức)

| Mức | Finding |
|---|---|
| CHẶN | Không có finding review chặn: tổng suite, đếm, tách backend và dòng exit đều khớp log |
| Cần xử lý sau | B-1: log các thí nghiệm F2 (gốc/ASCII/Temp/vá một dòng) không có trong evidence; kết luận vị trí và vá chỉ là lời kể. B-2: lượt đỏ dừng sớm không phủ phần assertion sau R3/R4; nên ghi "bộ m2-recovery không ổn định trên máy này, chưa kết luận về logic phục hồi từ lượt đỏ". B-3: lượt đỏ attempt0 thiếu log từng bộ |
| Thông tin | B-4: "22/24 bộ đỏ" nên là 21/24 + rollback; "74 PASS" gồm 9 PASS giả. B-5: "4 chế độ" của store-concurrency là tổng hai log; "12 evidence-upgrade" gồm 6 SQLite + 6 PG. B-6: đường dẫn trong F2 mất dấu `\`. B-7: log chứa đường dẫn/tên người dùng cục bộ. B-8: phiên bản PG 17.11, Node 26.4 là lời kể (có Node trong `summary.json`, PG trong `database`: chỉ ghi tên DB, không ghi phiên bản) |

Giới hạn review: không chạy lại test nào; không đọc `run-suite.js` ngoài dòng 82 và 201-204; không kiểm các lượt xanh của bản sao Temp (không có log).
