# Store PayPal Sandbox — thiết kế và hợp đồng (Claude Max, đợt C1)

Phạm vi: `cho-an-tam/src/lib/paypalPaymentStore.js` và `cho-an-tam/test/paypal-store-concurrency-e2e.js`. Không sửa route, `paymentService.js`, `reconciler.js`, `db.js`, schema/migration, `package.json`, `run-suite.js`, `public/` hay module PayPal của agent. Chưa có gì được nối vào ứng dụng.

Đối chiếu với: `codex/paypal-sandbox-integration@0b96ffd` (`paypalSandboxService.js`, `PAYPAL-SANDBOX-INTEGRATION.md`) và `HOP-DONG-PAYPAL-VONG-TIEP.md` (05/10/2026).

## 1. Đã chứng minh và chưa chứng minh

**Đã chứng minh** (store + lược đồ đề xuất, trên CSDL thật SQLite và PostgreSQL, fixture riêng):

- liên kết tạo cùng transaction với request, rollback không để lại gì;
- báo giá, merchant, provider bất biến, timestamp create đầu không làm mới, kể cả qua restart;
- order và capture ID duy nhất;
- đúng một người giữ quyền capture;
- người giữ quyền cũ không ghi đè người mới;
- timeout giữ PENDING;
- đóng hết hạn và capture không cùng thắng;
- VERIFIED rollback cùng bước ghi ví.

**Chưa chứng minh:** luồng ghi ví tích hợp thật (route, adapter, `applyProviderResult`), webhook, worker, HTTP PayPal. Bài P8 chỉ mô phỏng bước credit bằng một `UPDATE payment_requests` trong cùng transaction.

**Giới hạn của fixture SQLite:** hai store dùng chung một kết nối. Hai kết nối SQLite đồng bộ trong một process Node khoá chết nhau (`BEGIN IMMEDIATE` chặn event loop mà transaction kia cần để commit). Đồng thời giữa hai process thật chỉ được kiểm trên PostgreSQL (hai pool, khoá advisory).

## 2. Lược đồ đề xuất — root chép vào migration

Có sẵn trong `proposedSchema('sqlite' | 'pg')`. Test áp đúng các câu đó lên CSDL riêng.

- `payment_requests.provider TEXT NOT NULL DEFAULT 'MOCK' CHECK IN ('MOCK','PAYPAL_SANDBOX')`. Dữ liệu cũ thành MOCK. Trigger cấm đổi provider sau khi tạo.
- Bảng `paypal_payment_bindings`, khoá chính `payment_request_id` (FK `payment_requests`, ON DELETE CASCADE):
  - **snapshot bất biến:** `quote_json` (JSON chuẩn hoá, thứ tự khoá cố định), `amount_vnd`, `currency='USD'`, `usd_cents`, `rate_vnd_per_usd`, `merchant_id`, `created_at`;
  - **create:** `create_attempt_at` (ghi một lần), `order_id UNIQUE`, `order_bound_at`;
  - **capture:** `capture_state` (`READY|IN_FLIGHT|UNKNOWN|VERIFIED`), `capture_claim`, `capture_claimed_at`, `capture_attempts`, `first_capture_at`, `capture_id UNIQUE`, `capture_verified_at`, `last_capture_error`;
  - **CHECK:** VERIFIED phải có `capture_id`; IN_FLIGHT phải có claim; có `capture_id` thì phải có `order_id`.
- **Trigger chèn:** request phải là `PAYPAL_SANDBOX` và cùng số tiền.
- **Trigger sửa:** cấm đổi snapshot; cấm đổi `order_id`, `create_attempt_at`, `capture_id` đã có; cấm VERIFIED quay về trạng thái khác.

PostgreSQL dùng `app.`, plpgsql với `ERRCODE 42501`. Migration PostgreSQL nên là v4, vì v2 (admin) và v3 (top-up) đã dùng. Trên SQLite, cột `provider` thêm bằng `ALTER TABLE` trong `db.js#migrate()`; trigger nên chạy lại mỗi lần khởi động như admin-provenance.

## 3. Máy trạng thái capture

```
READY --claimCapture--> IN_FLIGHT --finish READY------> READY     (PayPal xác nhận chưa thu, ví dụ chưa phê duyệt)
                                  --finish UNKNOWN----> UNKNOWN   (timeout/không rõ; request vẫn PENDING)
                                  --finish VERIFIED---> VERIFIED  (cùng transaction với ghi ví)
IN_FLIGHT (lease hết hạn) --claimCapture--> IN_FLIGHT, mustVerifyFirst=true
UNKNOWN                   --claimCapture--> IN_FLIGHT, mustVerifyFirst=true
bất kỳ (có order) --markCaptureVerified--> VERIFIED (xoá claim; người giữ cũ nhận STALE_CLAIM)
```

`mustVerifyFirst=true` nghĩa là không biết PayPal đã thu tiền chưa. Người gọi phải GET order trước, chỉ POST capture lại với cùng `PayPal-Request-Id`. Lease hết hạn không có nghĩa là chưa thu.

## 4. Hợp đồng từng phương thức

`createPayPalPaymentStore({ db })` nhận API của `lib/asyncDb.js`. Lỗi đầu vào ném `PayPalStoreError`, có cả `status` (cho AppError) lẫn `statusCode` (cho PayPalSandboxError).

| Phương thức | Trả về | Ghi chú |
|---|---|---|
| `loadByRequestId(id)` | dữ liệu tin cậy hoặc `null` | Chỉ request `PAYPAL_SANDBOX` có liên kết; MOCK trả `null`. Dữ liệu lệch nhau ném `PAYPAL_BINDING_INCONSISTENT` (không tự sửa). |
| `loadByOrderId(orderId)` | như trên | Tra theo order duy nhất. |
| `createBinding({paymentRequestId, quote, merchantId, nowIso})` | dữ liệu tin cậy | **Mới.** Phải gọi trong cùng `db.transaction()` với INSERT request và kiểm ví/hạn mức/chống lặp. |
| `claimCreateAttempt(id, nowIso)` | dữ liệu tin cậy mới nhất | Đúng hợp đồng service. Không ghi khi đã có timestamp hoặc đã gắn order. |
| `bindOrder(id, orderId, nowIso?)` | `true` / `false` | Đúng hợp đồng service. Vi phạm UNIQUE nằm trong savepoint, không làm hỏng transaction bao ngoài. |
| `claimCapture(id, userId, claimId, nowIso, leaseCutoffIso)` | `{outcome, row, mustVerifyFirst?, previousState?}` | outcome: `CLAIMED`, `BUSY`, `REPLAY`, `CLOSED`, `NOT_READY`, `FORBIDDEN`, `NOT_FOUND`. `userId=null` là lời gọi tin cậy phía máy chủ (worker). |
| `finishCaptureAttempt(id, claimId, {state, captureId, errorCode})` | `{ok:true}` hoặc `{ok:false, reason:'STALE_CLAIM'\|'CAPTURE_ID_CONFLICT'}` | Chỉ ghi khi còn đúng token và đang IN_FLIGHT. |
| `markCaptureVerified(id, captureId)` | `{ok}` hoặc `reason:'CAPTURE_ID_CONFLICT'\|'NOT_READY'` | **Mới.** Cho webhook/worker không giữ quyền; idempotent với cùng capture ID. |
| `closeUncaptured(id, {nowIso, reason})` | `{closed, reason?}` | **Mới.** Đóng FAILED chỉ khi capture READY và không ai giữ quyền; kiểm và cập nhật trong cùng transaction tuần tự với `claimCapture`. Root vẫn phải GET order trước. |

Dữ liệu tin cậy: `{ provider, paymentRequestId, userId, providerRef, amountVnd, quote, merchantId, status, orderId, orderBoundAt, createAttemptAt, capture: { state, attempts, claimedAt, firstAttemptAt, captureId, verifiedAt, lastError } }`. Token claim không bao giờ trả ra ngoài. `quote` là object đông cứng, thứ tự khoá cố định, nên `JSON.stringify` giữa hai lần đọc của service luôn trùng.

## 5. Khác biệt so với hợp đồng đề xuất — cần Codex chốt

1. **Ba phương thức mới:** `createBinding`, `markCaptureVerified`, `closeUncaptured`. Không có chúng thì root phải tự viết SQL vào bảng của store.
2. **`claimCapture` trả object chứ không trả chuỗi**, để kèm `row` và `mustVerifyFirst`. `userId=null` là lời gọi của máy chủ.
3. **`finishCaptureAttempt` nhận trạng thái `READY`/`UNKNOWN`/`VERIFIED`.** Hợp đồng đề xuất chỉ nêu UNKNOWN và VERIFIED; READY cần cho trường hợp PayPal trả lời rõ là chưa thu.
4. **`bindOrder` có thêm tham số `nowIso` tuỳ chọn** để ghi `order_bound_at`; tương thích với lời gọi hai tham số của service.
5. **Service hiện tại chưa dùng quyền capture:** `capture()` gọi `provider.captureOrder` không qua `claimCapture`/`finishCaptureAttempt`. Trước khi bật feature, service hoặc lớp tích hợp phải:
   - gọi `claimCapture`;
   - nếu `mustVerifyFirst` thì GET trước;
   - gọi `settle` và `finishCaptureAttempt(VERIFIED)` trong cùng một `db.transaction()`, và rollback nếu `ok:false`;
   - khi timeout thì `finish UNKNOWN`.

## 6. Việc root phải làm ở phần dùng chung (store không tự làm)

- **Cô lập provider ở mọi đường mock:**
  - `claimSubmission`, `closeUnsubmitted` (expire), `submitToProvider`, `replayExisting`, mock checkout và mock webhook phải thêm `provider = 'MOCK'` vào điều kiện SQL;
  - worker phải phân tuyến theo provider TRƯỚC khi đọc `submission_status` hay xử lý `UNKNOWN_PAYMENT`.
  - Nếu không, yêu cầu PayPal có thể bị đóng FAILED bởi logic hết hạn của mock.
- **`applyProviderResult`:** nhận `expectedProvider` nội bộ, kiểm `provider` ngay trong transaction trước cả nhánh duplicate. Lệnh claim nên thêm `AND provider = ?`.
- **Thứ tự migration:** v1 → v2 (admin) → v3 (top-up) → v4 (PayPal store). Kiểm nâng cấp CSDL có sẵn, không chỉ CSDL mới.
- **Chọn lease capture:** đặt `leaseCutoffIso` lớn hơn tổng timeout của adapter (fetch + đọc body, tối đa 30 s) cộng thời gian ghi CSDL. Gợi ý 120 s.

## 7. Kiểm thử

```
node test/paypal-store-concurrency-e2e.js                                   # SQLite
node test/paypal-store-concurrency-e2e.js --pg=<url CSDL tên *_store_test>  # + PostgreSQL
```

Bộ test xoá schema `app`/`mock_provider` của CSDL `*_store_test` rồi dựng lại; tên khác thì từ chối chạy. Bộ test chưa đăng ký vào `run-suite.js` (root sở hữu). Đề xuất đăng ký sau khi root có biến cấu hình cho CSDL PostgreSQL riêng.

Nhóm kiểm thử:

- **P1:** tạo, cô lập provider, tạo nguyên tử.
- **P2:** timestamp create.
- **P3:** order duy nhất, savepoint.
- **P4:** quyền capture, sáu lượt đồng thời.
- **P5:** người giữ cũ, timeout → UNKNOWN.
- **P6:** webhook giữa lúc capture, capture ID duy nhất.
- **P7:** đóng và capture, sáu cuộc đua đồng thời.
- **P8:** VERIFIED cùng transaction với credit.
- **P9:** khởi động lại.

Ba lỗi cố ý được dùng để xác nhận test bắt được: bỏ điều kiện lease, bỏ kiểm token khi finish, bỏ kiểm capture khi đóng.
