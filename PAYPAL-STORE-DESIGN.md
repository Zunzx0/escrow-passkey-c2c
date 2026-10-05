# Store PayPal Sandbox — thiết kế và hợp đồng (Claude Max, đợt C1 + M1)

Phạm vi: `cho-an-tam/src/lib/paypalPaymentStore.js`, `cho-an-tam/test/paypal-store-concurrency-e2e.js` và tài liệu này. Không sửa `public/`, provider/service PayPal, route, `db.js`, schema/migration, `paymentService.js`, `reconciler.js`, `package.json` hay `run-suite.js`. Chưa có gì được nối vào ứng dụng.

Nền:
- `codex/combined-review@70b72ce`, merge thường vào `claude/paypal-store`.
- Đầu nhánh lúc nhận việc là `f48e313`. Nó chỉ thêm hai file giao việc `GIAO-VIEC-*.md`, nên tôi không lấy làm nền.

## 1. Đã chứng minh và chưa chứng minh

**Đã chứng minh** (store và lược đồ đề xuất, trên CSDL thật SQLite và PostgreSQL, fixture riêng `*_store_test`):

- **Liên kết và dữ liệu bất biến:**
  - liên kết tạo cùng transaction với request;
  - báo giá, merchant và provider bất biến;
  - timestamp create đầu không làm mới, kể cả qua restart;
  - order và capture ID duy nhất.
- **Quyền capture:**
  - đúng một người giữ quyền;
  - người giữ quyền cũ không ghi đè người mới.
- **Không đoán kết quả:**
  - đã gửi POST thì không quay về READY;
  - đóng hết hạn không thắng khi kết quả chưa rõ;
  - POST cũ thành công muộn vẫn được ghi nhận;
  - thu tiền trên request đã FAILED trả `RECOVERY_REQUIRED` và lưu bằng chứng.
- **Rollback:** VERIFIED rollback cùng một UPDATE mô phỏng bước credit.

**Chưa chứng minh:**
- **Sổ cái thật:** bài P8 chỉ mô phỏng credit bằng `UPDATE payment_requests`; chưa có ví hay ledger thật.
- **Luồng tích hợp:** route, adapter, `applyProviderResult`, webhook, worker và HTTP PayPal đều chưa có.

**Các mức đồng thời được kiểm:**
- **SQLite trong một process:** hai store dùng **chung một kết nối**. Hai kết nối SQLite đồng bộ trong một process Node khoá chết nhau, vì `BEGIN IMMEDIATE` chặn event loop mà transaction kia cần để commit.
- **PostgreSQL P1–P9, K1–K4:** **hai pool trong một process Node**, không phải hai process.
- **K5:** **hai process Node thật**, mỗi process mở kết nối riêng, bắt đầu cùng lúc bằng một file barrier, cả SQLite lẫn PostgreSQL.
  - Trên PostgreSQL hai process đan xen thật, mỗi bên thắng một phần.
  - Trên SQLite, process giữ khoá ghi trước thắng cả năm request. Kết quả đúng nhưng ít đan xen hơn.

## 2. Lược đồ đề xuất — root chép vào migration

Có sẵn trong `proposedSchema('sqlite' | 'pg')`; test áp đúng các câu đó lên CSDL riêng. Đề xuất là **migration PostgreSQL v4**, vì v2 (admin) và v3 (top-up) đã dùng.

**`payment_requests`:** thêm `provider TEXT NOT NULL DEFAULT 'MOCK' CHECK IN ('MOCK','PAYPAL_SANDBOX')`. Dữ liệu cũ thành MOCK, và trigger cấm đổi provider.

**Bảng mới `paypal_payment_bindings`,** khoá chính `payment_request_id` (FK `payment_requests`):

| Nhóm | Cột |
|---|---|
| Snapshot bất biến | `quote_json` (JSON chuẩn hoá), `amount_vnd`, `currency='USD'`, `usd_cents`, `rate_vnd_per_usd`, `merchant_id`, `created_at` |
| Create | `create_attempt_at` (ghi một lần), `order_id UNIQUE`, `order_bound_at` |
| Lease | `capture_state`, `capture_claim`, `capture_claimed_at`, `capture_attempts`, `first_capture_at` |
| **Mới (M1.1)** | `capture_post_sent_at` (ghi một lần, không xoá được), `capture_post_count` |
| Kết quả | `capture_id UNIQUE`, `capture_verified_at`, **`not_captured_evidence`**, **`recovery_required_at`**, `last_capture_error` |

**Ràng buộc CHECK:**
- `capture_state IN (READY, IN_FLIGHT, UNKNOWN, VERIFIED, NOT_CAPTURED, RECOVERY_REQUIRED)`.
- Có `capture_id` khi và chỉ khi trạng thái là VERIFIED hoặc RECOVERY_REQUIRED.
- IN_FLIGHT phải có claim.
- NOT_CAPTURED phải có evidence ∈ `ORDER_VOIDED`, `CAPTURE_DECLINED`.
- RECOVERY_REQUIRED phải có `recovery_required_at`.
- **READY thì `capture_post_sent_at` phải NULL.** Đây là lớp CSDL của nguyên tắc "đã POST thì không quay về READY".

**Trigger:**
- cấm đổi snapshot;
- cấm đổi `order_id`, `create_attempt_at`, `capture_post_sent_at`, `capture_id` khi đã có giá trị;
- VERIFIED và RECOVERY_REQUIRED là trạng thái cuối;
- NOT_CAPTURED chỉ được chuyển sang VERIFIED hoặc RECOVERY_REQUIRED, khi có bằng chứng thu tiền ngược lại.

## 3. Máy trạng thái capture

```
READY ──claim──> IN_FLIGHT ──markCapturePostSent──> IN_FLIGHT (đã POST, không bao giờ về READY)
IN_FLIGHT ──finish READY──> READY            CHỈ khi chưa từng POST
          ──finish UNKNOWN──> UNKNOWN        timeout / không rõ; request vẫn PENDING
          ──finish NOT_CAPTURED──> NOT_CAPTURED   bằng chứng mạnh: ORDER_VOIDED | CAPTURE_DECLINED
          ──finish VERIFIED──> VERIFIED      request PENDING; cùng transaction với credit
                             └─> RECOVERY_REQUIRED   request đã FAILED (lưu capture ID, không credit)
IN_FLIGHT (lease hết) / UNKNOWN ──claim──> IN_FLIGHT, mustVerifyFirst=true
bất kỳ có order ──markCaptureVerified──> VERIFIED (PENDING) | RECOVERY_REQUIRED (FAILED)
```

Quy tắc **M1.1**:
- **Lease hết hạn không chứng minh gì.** Lease hết hạn, timeout, hay GET order thấy APPROVED/PENDING/CREATED đều **không** chứng minh PayPal chưa thu tiền: POST cũ có thể hoàn tất sau lần GET.
- **Đã POST thì không quay về READY.** `finish READY` trả `CAPTURE_OUTCOME_UNRESOLVED` và vẫn giữ quyền. Người gọi phải ghi UNKNOWN, VERIFIED hoặc NOT_CAPTURED.
- **Khi nào được đóng FAILED:** `closeUncaptured` chỉ thắng khi chưa từng POST (READY và không ai giữ quyền) hoặc đã có NOT_CAPTURED.
- **POST cũ thành công muộn.** Holder cũ nhận `STALE_CLAIM` từ `finishCaptureAttempt` nhưng **phải** gọi `markCaptureVerified(captureId)` để bằng chứng không mất. Hàm này không cần token, và không ghi đè token của holder mới bằng một kết quả chưa xác minh.

Quy tắc **M1.2**:
- **Thu tiền khi request đã FAILED** (`markCaptureVerified` hoặc `finish VERIFIED`) trả `{ ok:false, outcome:'RECOVERY_REQUIRED', captureId }`, lưu bền capture ID và `recovery_required_at`. Store không ghi ví, không mở lại FAILED, không tự giải quyết tiền.
- **Cùng capture ID gửi lại:** vẫn `RECOVERY_REQUIRED` (idempotent).
- **Capture ID khác:** trả `CAPTURE_ID_CONFLICT`. Bằng chứng đầu giữ nguyên, ID mới ghi vào `last_capture_error`.

## 4. Hợp đồng từng phương thức

`createPayPalPaymentStore({ db })`. Lỗi đầu vào ném `PayPalStoreError`, có cả `status` lẫn `statusCode`.

| Phương thức | Trả về | Ghi chú |
|---|---|---|
| `loadByRequestId(id)` / `loadByOrderId(orderId)` | dữ liệu tin cậy hoặc `null` | Chỉ request `PAYPAL_SANDBOX`. Dữ liệu lệch nhau ném `PAYPAL_BINDING_INCONSISTENT`. |
| `createBinding({paymentRequestId, quote, merchantId, nowIso})` | dữ liệu tin cậy | Gọi trong cùng transaction với INSERT request và kiểm ví/hạn mức/chống lặp. |
| `claimCreateAttempt(id, nowIso)` | dữ liệu tin cậy | Như hợp đồng service. |
| `bindOrder(id, orderId, nowIso?)` | `true` / `false` | Như hợp đồng service; vi phạm UNIQUE nằm trong savepoint. |
| `claimCapture(id, userId, claimId, nowIso, leaseCutoffIso)` | `{outcome, row, mustVerifyFirst?, previousState?}` | outcome: `CLAIMED`, `BUSY`, `REPLAY`, **`RECOVERY_REQUIRED`**, `CLOSED`, **`NOT_CAPTURED`**, `NOT_READY`, `FORBIDDEN`, `NOT_FOUND`. `mustVerifyFirst` = đã từng POST hoặc trạng thái trước là UNKNOWN. `userId=null` chỉ cho lời gọi nội bộ. |
| **`markCapturePostSent(id, claimId, nowIso?)`** | `{ok}` hoặc `STALE_CLAIM` | **Mới.** Gọi và commit NGAY TRƯỚC mỗi lần POST capture. |
| `finishCaptureAttempt(id, claimId, {state, captureId?, errorCode?, evidence?})` | `{ok:true}` hoặc `{ok:false, reason}` | state ∈ `READY`, `UNKNOWN`, `VERIFIED`, **`NOT_CAPTURED`**. reason ∈ `STALE_CLAIM`, **`CAPTURE_OUTCOME_UNRESOLVED`**, `CAPTURE_ID_CONFLICT`, **`RECOVERY_REQUIRED`**. |
| `markCaptureVerified(id, captureId)` | `{ok:true}`, `{ok:false, outcome:'RECOVERY_REQUIRED'}`, `{ok:false, reason:'CAPTURE_ID_CONFLICT'\|'NOT_READY'\|'NOT_FOUND'}` | Không cần token; idempotent với cùng capture ID. |
| `closeUncaptured(id, {nowIso, reason})` | `{closed, reason?}` | reason khi từ chối: `CAPTURE_IN_FLIGHT`, `CAPTURE_UNKNOWN`, `CAPTURE_VERIFIED`, `STATUS_FAILED`, ... |

Dữ liệu tin cậy giữ nguyên các trường cũ. `capture` có thêm `postSentAt`, `postCount`, `notCapturedEvidence`, `recoveryRequiredAt`. Token claim không bao giờ trả ra ngoài.

### Quy tắc khi gọi trong transaction settlement

- **`finish VERIFIED` trả `ok:true`:** commit cùng credit.
- **Trả `ok:false, reason:'STALE_CLAIM'`:** rollback credit, rồi gọi `markCaptureVerified` (ngoài transaction đó) với cùng capture ID đã xác minh.
- **Trả `RECOVERY_REQUIRED`:** **commit, không credit.** Bằng chứng đã nằm trong transaction này; rollback sẽ làm mất nó.

## 5. Khác biệt hợp đồng so với bản trước (C1 `4f6e9f1`) — cần Codex chốt

1. **Phương thức mới `markCapturePostSent`.** Lớp tích hợp phải gọi nó trước mỗi POST capture. Không gọi thì store coi như chưa từng POST, và `closeUncaptured` sẽ đóng được.
2. **Hai trạng thái mới:** `NOT_CAPTURED` và `RECOVERY_REQUIRED`.
3. **Outcome và reason mới:**
   - `claimCapture` có thêm `RECOVERY_REQUIRED` và `NOT_CAPTURED`;
   - `finishCaptureAttempt` có thêm `CAPTURE_OUTCOME_UNRESOLVED` và `RECOVERY_REQUIRED`;
   - `markCaptureVerified` trên request FAILED trả `RECOVERY_REQUIRED` thay vì `ok:true`.
4. **`finish READY` sau khi đã POST bị từ chối.** Trước đây nó được chấp nhận.
5. **`closeUncaptured` chặt hơn:** chỉ đóng khi chưa từng POST hoặc đã có NOT_CAPTURED.
6. **Lược đồ** thêm 4 cột, các CHECK và trigger ở mục 2.

Bên root cần quyết định:
- **Quy trình xử lý `RECOVERY_REQUIRED`:** mở lại request, credit thủ công có duyệt, hay hoàn tiền Sandbox. Store chỉ giữ bằng chứng.
- **Cách lớp tích hợp suy ra `ORDER_VOIDED` / `CAPTURE_DECLINED`** từ phản hồi adapter.
- **Giá trị lease thật:** 120 giây chỉ là giá trị khởi đầu, phải lớn hơn tổng timeout adapter cộng thời gian ghi CSDL.

## 6. Việc root phải làm ở phần dùng chung (không đổi so với C1)

- **Cô lập provider:** mọi đường mock (`claimSubmission`, expire/`closeUnsubmitted`, `submitToProvider`, `replayExisting`, mock checkout/webhook) lọc `provider = 'MOCK'`. Worker phân tuyến theo provider trước khi đọc `submission_status` hay xử lý `UNKNOWN_PAYMENT`.
- **`applyProviderResult`:** nhận `expectedProvider` nội bộ, kiểm provider trong transaction trước nhánh duplicate.
- **Service phải dùng quyền capture:** `paypalSandboxService.capture()` hiện gọi thẳng `provider.captureOrder`, chưa qua `claimCapture` / `markCapturePostSent` / `finishCaptureAttempt`. Đây là điều kiện chặn trước khi bật feature.

## 7. Kiểm thử

```
node test/paypal-store-concurrency-e2e.js                                   # SQLite
node test/paypal-store-concurrency-e2e.js --pg=<url CSDL tên *_store_test>  # + PostgreSQL
```

Bộ test xoá schema `app`/`mock_provider` của CSDL `*_store_test` rồi dựng lại; tên CSDL khác thì từ chối chạy. Bộ test chưa đăng ký vào `run-suite.js` (root sở hữu).

Kết quả lần chạy cuối: **SQLite 95/95, PostgreSQL 95/95** (`enclave_paypal_store_test`).

- **P1–P9:** như C1.
- **K1:** barrier. POST của A treo → lease hết → B tiếp quản, GET vẫn PENDING → B không về READY → đóng không thắng → POST A thành công muộn → A nhận `STALE_CLAIM`, `markCaptureVerified` ghi VERIFIED, request PENDING.
- **K2:** bằng chứng muộn đến khi B còn giữ quyền. Finish của A không ghi đè token B; `markCaptureVerified` ghi nhận, B ghi sau bị từ chối.
- **K3:** thu tiền trên request FAILED → `RECOVERY_REQUIRED`, gồm cùng capture gửi lại, capture khác, `claimCapture`, request PENDING bình thường, và holder bị đóng ngang bởi đường khác.
- **K4:** bằng chứng mạnh mới ra NOT_CAPTURED; chưa từng POST thì READY hợp lệ; dấu POST không xoá được.
- **K5:** hai process Node thật cùng giành quyền trên năm request.

**Tái hiện trên bản C1 (`4f6e9f1`)** bằng K1–K4 (K5 thêm sau): 10 phép kiểm hỏng.
- K1: B về READY, lượt đóng thắng, request FAILED trong khi POST của A vẫn chạy.
- K3: thu tiền trên FAILED trả `ok:true` mà không giữ bằng chứng.

**Lỗi cố ý để xác nhận test bắt được** (sau mỗi lần đều khôi phục bản gốc):

| Lỗi cố ý | Kết quả |
|---|---|
| Bỏ chặn READY sau POST ở JS | Vẫn bị CHECK của CSDL chặn: test hỏng, hai lớp |
| Cho đóng khi đã POST/UNKNOWN | 4 phép hỏng |
| Coi thu tiền trên FAILED là VERIFIED | 5 phép hỏng |
| Bỏ lease, bỏ kiểm token, bỏ kiểm capture khi đóng (từ C1) | Đã kiểm ở C1 |
