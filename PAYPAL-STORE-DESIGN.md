# Store PayPal Sandbox — thiết kế và hợp đồng (Claude Max: C1, M1, sửa theo phản hồi Codex)

Phạm vi: `cho-an-tam/src/lib/paypalPaymentStore.js`, `cho-an-tam/test/paypal-store-concurrency-e2e.js` và tài liệu này. Không sửa `public/`, provider/service PayPal, route, `db.js`, schema/migration, `paymentService.js`, `reconciler.js`, `package.json` hay `run-suite.js`.

Lịch sử nền của nhánh `claude/paypal-store` (đều là merge thường):
1. `codex/combined-review@70b72ce`.
2. `codex/payment-provider-isolation@ea752b3`: có migration v4 (provider) và v5 (binding) của Codex, và đã chứa M1 `5129ee3`.

## 1. Đã chứng minh và chưa chứng minh

**Đã chứng minh** (store trên CSDL thật, fixture riêng `*_store_test`, bốn tổ hợp):

| Nền | Lược đồ `migration` | Lược đồ `proposed` |
|---|---|---|
| SQLite | CSDL dựng bằng chính `db.js` khởi động trong process con (`migrate()`, `schema.sqlite.005`) | `bindingSchema()`; thêm `providerSchema()` chỉ khi nền thiếu |
| PostgreSQL | `PG_MIGRATIONS` v1→v5 thật | như trên |

**Chưa chứng minh:**
- **Sổ cái thật:** chưa có ví hay ledger thật; bước credit trong test được mô phỏng bằng `UPDATE payment_requests SET status='SUCCEEDED'`.
- **Luồng tích hợp:** chưa có route, adapter, `applyProviderResult`, webhook, worker hay HTTP PayPal.

**Các mức đồng thời được kiểm:**
- **SQLite:** hai store dùng chung một kết nối.
- **PostgreSQL:** hai pool trong **một** process Node.
- **K5:** **hai process Node thật**, bắt đầu cùng lúc bằng file barrier, trên cả hai nền.
  - PostgreSQL đan xen thật.
  - Trên SQLite, process lấy khoá ghi trước thắng hết.

## 2. Lược đồ

- **`providerSchema(dialect)`:** cột `payment_requests.provider` cùng trigger bất biến. **Đã có trong migration v4 của Codex**; chỉ dùng cho nền cũ chưa có v4.
- **`bindingSchema(dialect)`:** nội dung của v5, gồm bảng `paypal_payment_bindings` và trigger; không đụng cột provider.
- **`proposedSchema(dialect)`** = provider + binding, giữ lại cho tương thích.

Cột, CHECK và trigger như bản M1, với một thay đổi: **`not_captured_evidence` chỉ nhận `ORDER_VOIDED`** (bỏ `CAPTURE_DECLINED`, mục 3).

> **Khác biệt với v5 thật (`schema.pg.005-paypal-bindings.sql`, `schema.sqlite.005-paypal-bindings.sql`):** CHECK `not_captured_evidence IN ('ORDER_VOIDED','CAPTURE_DECLINED')` vẫn còn `CAPTURE_DECLINED`. Store chặn ở tầng ứng dụng, nhưng lớp CSDL nên đồng bộ: đổi thành `IN ('ORDER_VOIDED')`. Đó là file của Codex nên tôi không sửa. Test in cảnh báo `⚠` cho trường hợp này ở chế độ `migration` và kiểm CHECK chặt ở chế độ `proposed`.

## 3. Quyết định đã chốt (phản hồi Codex cho M1 `5129ee3`) và cách store thực hiện

| # | Chốt | Store |
|---|---|---|
| 1 | Commit dấu "có thể đã gửi" trước mỗi POST; marker không thành công thì không POST | `markCapturePostSent` trả `{ok:false, reason:'STALE_CLAIM'}` khi mất quyền |
| 2 | READY chỉ khi chưa từng POST; timeout hay GET PENDING/APPROVED không đóng request | `finish READY` sau POST → `CAPTURE_OUTCOME_UNRESOLVED`; CHECK CSDL READY ⇒ chưa POST; `closeUncaptured` chặn |
| 3 | `RECOVERY_REQUIRED` lưu bằng chứng, chờ người vận hành; không mở lại, không credit, không refund tự động | `persistRecovery`; không có đường mở lại nào |
| 4 | **`CAPTURE_DECLINED` không phải bằng chứng NOT_CAPTURED** | `NOT_CAPTURED_EVIDENCE = ['ORDER_VOIDED']` |
| 5 | Thứ tự settlement (dưới đây) | `claimCapture` trả **`SETTLEMENT_REQUIRED`** khi VERIFIED mà request còn PENDING |
| 6 | Lease 120 giây là mặc định khởi đầu | Store nhận `leaseCutoffIso` từ người gọi |
| 7 | v4 = provider, v5 = binding; v5 không ALTER provider | tách `providerSchema` / `bindingSchema` |

### Thứ tự settlement (mục 5)

```
transaction ngoài:
  finish VERIFIED (hoặc markCaptureVerified)   -- đọc request/binding MỚI NHẤT
    ok:true                -> settle request/ví/sổ cái CÙNG transaction -> commit
    RECOVERY_REQUIRED      -> commit bằng chứng, KHÔNG credit
    STALE_CLAIM / khác     -> rollback toàn bộ
STALE_CLAIM -> transaction ngoài MỚI: markCaptureVerified + settle
```

**Không ghi VERIFIED riêng trên request PENDING rồi giả định ví đã cộng.** Nếu lỗi tích hợp vẫn để lại VERIFIED + PENDING, `claimCapture` trả `SETTLEMENT_REQUIRED`, trước đây là `REPLAY`. Người gọi chạy lại settlement với cùng bằng chứng; `markCaptureVerified` idempotent nên cộng đúng một lần (K6).

## 4. Hợp đồng từng phương thức

| Phương thức | Trả về |
|---|---|
| `loadByRequestId` / `loadByOrderId` | dữ liệu tin cậy hoặc `null` (chỉ `PAYPAL_SANDBOX`) |
| `createBinding({paymentRequestId, quote, merchantId, nowIso})` | dữ liệu tin cậy; gọi cùng transaction với INSERT request |
| `claimCreateAttempt(id, nowIso)` / `bindOrder(id, orderId, nowIso?)` | như hợp đồng service |
| `claimCapture(id, userId, claimId, nowIso, leaseCutoffIso)` | outcome ∈ `CLAIMED` (kèm `mustVerifyFirst`, `previousState`), `BUSY`, `REPLAY` (request SUCCEEDED), **`SETTLEMENT_REQUIRED`** (VERIFIED + PENDING), `RECOVERY_REQUIRED`, `CLOSED`, `NOT_CAPTURED`, `NOT_READY`, `FORBIDDEN`, `NOT_FOUND` |
| `markCapturePostSent(id, claimId, nowIso?)` | `{ok}` hoặc `STALE_CLAIM` |
| `finishCaptureAttempt(id, claimId, {state, captureId?, errorCode?, evidence?})` | state ∈ READY, UNKNOWN, VERIFIED, NOT_CAPTURED (evidence chỉ `ORDER_VOIDED`). Lỗi trả `{ok:false, reason}` với reason ∈ `STALE_CLAIM`, `CAPTURE_OUTCOME_UNRESOLVED`, `CAPTURE_ID_CONFLICT`, `RECOVERY_REQUIRED` |
| `markCaptureVerified(id, captureId)` | `{ok:true}`, `RECOVERY_REQUIRED`, `CAPTURE_ID_CONFLICT`, `NOT_READY`, `NOT_FOUND`; idempotent |
| `closeUncaptured(id, {nowIso, reason})` | `{closed}`; chỉ khi chưa từng POST hoặc đã NOT_CAPTURED |

## 5. Khác biệt hợp đồng so với M1 `5129ee3`

1. **`claimCapture` có outcome mới `SETTLEMENT_REQUIRED`.** VERIFIED + request PENDING trước đây trả `REPLAY`; giờ `REPLAY` chỉ dành cho request SUCCEEDED.
2. **`finishCaptureAttempt(NOT_CAPTURED)` không nhận `CAPTURE_DECLINED` nữa**: ném `VALIDATION_ERROR`.
3. **Export mới `providerSchema` và `bindingSchema`;** `proposedSchema` giữ nguyên ý nghĩa.

Không có thay đổi lược đồ ngoài CHECK evidence. v5 thật cần đổi CHECK đó (mục 2).

## 6. Việc root còn phải làm (không đổi)

- **Cô lập provider:** mọi đường mock lọc `provider='MOCK'`; worker phân tuyến theo provider trước.
- **`applyProviderResult`:** nhận `expectedProvider` nội bộ, kiểm trong transaction.
- **Service phải dùng quyền capture:** `paypalSandboxService.capture()` phải đi qua `claimCapture` → (GET nếu `mustVerifyFirst`) → `markCapturePostSent` → POST → finish/settle theo mục 3. Nếu `SETTLEMENT_REQUIRED` thì chạy settlement với bằng chứng đã lưu; không POST lại.
- **Adapter:** chỉ báo `ORDER_VOIDED` sau khi xác minh order/binding qua API chính thức.

## 7. Kiểm thử

```
node test/paypal-store-concurrency-e2e.js                                   # SQLite: migration + proposed
node test/paypal-store-concurrency-e2e.js --pg=<url CSDL tên *_store_test>  # + PostgreSQL: migration + proposed
```

Chế độ `migration` khởi động `db.js` thật trong process con để dựng CSDL. Test PostgreSQL đặt `search_path` bằng tham số kết nối nên không còn `DeprecationWarning` về concurrent `client.query`.

Kết quả lần chạy cuối:

| Nền | `migration` | `proposed` |
|---|---|---|
| SQLite | 102/102 | 103/103 |
| PostgreSQL (`enclave_paypal_store_test`) | 102/102 (log áp v1–v5) | 103/103 |

Chế độ `proposed` nhiều hơn 1 phép, là kiểm CHECK chặn `CAPTURE_DECLINED`. Ở chế độ `migration`, phép đó thay bằng dòng cảnh báo `⚠`.

Nhóm kiểm thử:

- **P1–P9:** như C1. P6 nay kỳ vọng `SETTLEMENT_REQUIRED` sau VERIFIED trên PENDING.
- **K1–K2:** chạy theo thứ tự settlement đã chốt.
  - Holder cũ: finish + settle → `STALE_CLAIM` → rollback.
  - Transaction mới: bằng chứng + settle → `VERIFIED` và `SUCCEEDED` cùng commit.
- **K3:** `RECOVERY_REQUIRED`.
- **K4:** chỉ `ORDER_VOIDED`; APPROVED và CAPTURE_DECLINED đều bị từ chối.
- **K5:** hai process thật.
- **K6:** VERIFIED đứng riêng → `SETTLEMENT_REQUIRED` → settlement phục hồi cộng một lần → settle lần hai không cộng thêm.

Lỗi cố ý (SQLite), sau mỗi lần đều khôi phục:

| Lỗi cố ý | Kết quả |
|---|---|
| VERIFIED + PENDING trả `REPLAY` như cũ | 2 phép hỏng mỗi chế độ |
| Nhận lại `CAPTURE_DECLINED` | 2 phép hỏng (`migration`), 3 phép hỏng (`proposed`) |
| Các lỗi cố ý của M1 và C1 | Không đổi |
