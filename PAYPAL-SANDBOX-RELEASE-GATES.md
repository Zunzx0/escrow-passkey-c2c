# Enclave — cổng nghiệm thu PayPal Sandbox và triển khai

Ngày rà soát: 06/10/2026. Nền mã đã kiểm tra: `c4ed8bc197958f2542f78cf6de031a381771486f`.
Người thực hiện tài liệu này chỉ đọc mã/cấu hình/tài liệu và đã kiểm thử cục bộ ở lượt trước. Chưa đọc giá trị bí mật, chưa mở tài khoản PayPal/Railway/Vercel, chưa gọi Sandbox thật, chưa thay production DB, chưa bật tính năng hay triển khai.

## 1. Phạm vi nghiệm thu

PayPal Sandbox chỉ nạp tiền thử nghiệm vào ví VND nội bộ. Giải ngân/hoàn tiền tranh chấp vẫn là chuyển giữa ví Enclave. Không có payout/refund PayPal tự động; không bật PayPal Live hoặc thử tiền thật. Sandbox dùng tài khoản thử nghiệm riêng theo [hướng dẫn chính thức](https://developer.paypal.com/sandbox-testing/overview).

Các bộ đã đạt trên nền này: full suite SQLite 1006 và PostgreSQL 997, hardening 27 riêng mỗi DB; M2 85/67/34 mỗi DB và module 50. Đây là các lượt riêng, không cộng làm một tổng duy nhất. HTTP PayPal giả chưa chứng minh redirect/cookie/webhook/Sandbox thật. Một lần M2 SQLite R3 có lỗi barrier fixture, chạy lại quan sát đạt; giữ log và không giấu lần thất bại.

## 2. Gate A — cấu hình và môi trường được root phê duyệt

- [ ] Root chốt môi trường viết dữ liệu demo: ưu tiên staging/demo riêng. Checklist không tự cho phép ghi production DB. Nếu dùng website chính, root phải chốt rõ tài khoản thử nghiệm, dữ liệu demo và phạm vi ghi trước.
- [ ] API và giao diện triển khai cùng bản tích hợp đã duyệt vào nhánh chung đúng quy trình PR; không đổi `main` hay nhánh deploy ngoài quyết định root.
- [ ] API HTTPS hoạt động, chứng chỉ hợp lệ, `/health` trả OK. `SERVE_FRONTEND=0` trên Railway API là cấu hình production hợp lệ; frontend do Vercel phục vụ.
- [ ] Giao diện gọi đúng API qua `public/js/config.js`; `CORS_ORIGIN` đúng origin frontend HTTPS và hỗ trợ credentials.
- [ ] `WEBAUTHN_RP_ID`/`WEBAUTHN_ORIGIN` đúng frontend. Với website chính: `enclave.id.vn` và `https://enclave.id.vn`. Không lấy `api.enclave.id.vn` làm origin Passkey.
- [ ] Không dùng preview `*.vercel.app` mặc định làm bằng chứng toàn luồng: nó vẫn trỏ API chính, thường bị CORS/Passkey/cookie khác site. Staging khác hostname cần cấu hình API mapping, CORS và WebAuthn riêng được duyệt.
- [ ] `TRUST_PROXY` đúng Railway để cookie refresh có `Secure`; kiểm trên trình duyệt cookie HttpOnly/SameSite và khả năng phục hồi phiên sau redirect từ PayPal. Không đổi SameSite để vượt lỗi trước khi chẩn đoán.
- [ ] Dùng app Sandbox và business Sandbox nhận tiền, personal Sandbox phê duyệt. Merchant ID phải thuộc business của chính app, không phải Client ID, email người mua hoặc webhook ID.
- [ ] Bí mật nhập trong môi trường máy chủ; không đưa vào chat công khai, Git, frontend, URL, ảnh chụp hoặc log. Rà names/presence, không xuất giá trị để báo cáo.

| Biến máy chủ | Quy tắc mã hiện tại |
|---|---|
| `PAYPAL_SANDBOX_ENABLED` | `1` mới yêu cầu bật; mặc định tắt. Đặt `0` trong giai đoạn deploy chưa nghiệm thu. |
| `PAYPAL_SANDBOX_CLIENT_ID` | Client ID app Sandbox, phải có. |
| `PAYPAL_SANDBOX_CLIENT_SECRET` | Secret app Sandbox, chỉ máy chủ, phải có. |
| `PAYPAL_SANDBOX_MERCHANT_ID` | Merchant business Sandbox của app, phải có. |
| `PAYPAL_SANDBOX_WEBHOOK_ID` | ID đăng ký webhook của cùng app Sandbox, phải có. |
| `PAYPAL_FRONTEND_ORIGIN` | HTTPS origin thuần, không path/query/hash/userinfo; website chính `https://enclave.id.vn`. HTTP localhost không bật runtime PayPal thật. |
| `PAYPAL_DEMO_VND_PER_USD` | Số nguyên dương, mặc định 25000; tỷ giá trình diễn, không tỷ giá thị trường. |
| `PAYPAL_TIMEOUT_MS` | Số nguyên 100–30000 ms; mặc định 10000. |
| `PAYPAL_CAPTURE_LEASE_SECONDS` | Số nguyên giây; mặc định 120. Phải bảo đảm `leaseMs >= 4*timeoutMs + 10000`. Timeout 30s cần ít nhất 130s lease. |
| `MOCK_PROVIDER_CHECKOUT` | Đặt `0` nếu nghiệm thu chỉ PayPal hoặc cần tắt cả hai cổng. Flag PayPal `1` tự chặn mock, kể cả cấu hình PayPal thiếu. |
| `RECONCILE_INTERVAL_SECONDS` | Mặc định 60s; phải >0 để đối soát nền hoạt động trong nghiệm thu. `0` tắt worker. |
| `RECONCILE_MIN_AGE_SECONDS` | Mặc định 30s; lưu vào biên bản để xác định cửa sổ quan sát. |

API host cố định `https://api-m.sandbox.paypal.com`; approval origin chính xác `https://www.sandbox.paypal.com`. Không có env chuyển sang Live hay arbitrary host. Không thêm PayPal SDK/CDN vào CSP: UI hiện dùng redirect top-level, không iframe/SDK.

### URL phải đối chiếu

- Webhook PayPal: `https://api.enclave.id.vn/api/payments/paypal/webhook` khi dùng website chính. Đăng ký event `PAYMENT.CAPTURE.COMPLETED` cho **đúng app Sandbox**. Đây không phải webhook mock `/api/payments/webhook`; `PAYMENT_WEBHOOK_SECRET` cũng không phải `PAYPAL_SANDBOX_WEBHOOK_ID`.
- Return do server sinh: `https://enclave.id.vn/?paypal=return&paymentRequestId=<id>#/wallet`.
- Cancel tương tự với `paypal=cancel`. `token`/`PayerID` PayPal thêm vào không phải chứng cứ được thu tiền hoặc ownership.
- PayPal webhook là HTTPS POST tới API; không dùng JWT/cookie người dùng. Server xác minh chữ ký rồi GET order và kiểm đúng merchant/currency/amount/order/capture. Chỉ receipt chưa phải verification. [Nguồn webhook](https://developer.paypal.com/api/rest/webhooks/).

Sau khi nhập đủ cấu hình và deploy backend, chỉ khi root cho bật flag mới kiểm `GET /api/payments/paypal/config`: `paypalSandbox.enabled=true`, `mode=sandbox`, `mockPayments.enabled=false`. Response không được có secret. Nếu config thiếu/sai/404, giao diện đóng các cổng, không fallback mock âm thầm.

## 3. Gate B — migration và bản sao trước phát hành

- [ ] Backup/export theo quy trình được root cho phép; không tin mặc định Free có backup sẵn. Không xuất bí mật hoặc dữ liệu khách hàng vào PR.
- [ ] Migration PostgreSQL ở `app.schema_migrations` phải áp v1–v6 đúng thứ tự. v4 phân biệt provider, v5 durable bindings, v6 giới hạn terminal evidence `ORDER_VOIDED`.
- [ ] Nếu có dữ liệu cũ `not_captured_evidence` khác `ORDER_VOIDED`, dừng phát hành và đối soát; không tự đổi DECLINED thành VOIDED, xóa hàng hoặc nới CHECK để migration chạy.
- [ ] Dữ liệu mock cũ mang provider MOCK; unique order/capture và quote bất biến tồn tại. Đây là gate schema, không sửa dữ liệu production bằng tay.
- [ ] Có điểm khôi phục code tương thích provider/schema. Không downgrade hoặc drop schema v4–v6 sau khi đã có yêu cầu PayPal; bản cũ trước provider isolation có thể xử lý PayPal như mock.
- [ ] Tắt PayPal/mock trước khi deploy core; backend xong và config endpoint hợp lệ mới deploy UI. Webhook/worker phải trỏ cùng database và cùng merchant cấu hình.

## 4. Gate C — bước thử tối thiểu: một request Sandbox

Đăng nhập tài khoản BUYER/SELLER demo ACTIVE đã có Passkey; admin không dùng tuyến nạp. Ghi số dư ban đầu `B`, thời gian, requestId, ID nội bộ; dùng một ý định duy nhất. Số gợi ý dễ đối chiếu: **100.000 VND = 4,00 USD Sandbox** khi tỷ giá cố định 25000; không lấy số này làm tiền thật hoặc tỷ giá PayPal.

1. Tạo yêu cầu qua UI. Ghi `id`, `requestId`, provider PAYPAL_SANDBOX, quote VND/USD và order ID. Chưa phê duyệt thì request PENDING, ví bằng B, không có TOPUP_CREDIT.
2. Bấm mở PayPal; xác nhận browser đi đúng `www.sandbox.paypal.com`, đúng merchant/app và 4,00 USD thử nghiệm. Không dùng tài khoản Live.
3. **Hủy tại PayPal rồi quay lại**: không tự capture, không tự FAILED, không credit. UI giữ cùng requestId/amount/order. Mở lại cùng ý định, không tạo order mới.
4. Phê duyệt bằng personal Sandbox và quay lại. UI hỏi trạng thái; chỉ sau người dùng xác nhận mới gọi capture. Không dùng return query hoặc HTTP 200 làm bằng chứng nạp.
5. GET trạng thái phải xác nhận đúng owner/id/requestId/amount/provider và SUCCEEDED. Ví đúng B+100.000; request SUCCEEDED, binding VERIFIED/capture ID khớp order.
6. Đối chiếu chỉ đọc sổ cái theo request: đúng một TOPUP_CREDIT, `available_delta=100000`, `locked_delta=0`, `idempotency_key=topup:<id>`. Capture ID chỉ gắn một request. Không chỉnh ví/ledger để đạt tiêu chí.
7. Kiểm bản ghi PayPal Sandbox completed, số USD đã chốt, merchant và capture ID khớp. Lưu ảnh không có secret/access token/cookie/PII ngoài tài khoản demo.

Ví dụ truy vấn nghiệm thu **chỉ đọc**, chỉ chạy sau root cho phép đúng môi trường:

```sql
SELECT id, user_id, amount, provider, status, client_request_id, resolved_at
FROM app.payment_requests WHERE id = :request_id;
SELECT order_id, capture_id, capture_state, capture_post_count, last_capture_error
FROM app.paypal_payment_bindings WHERE payment_request_id = :request_id;
SELECT entry_type, available_delta, locked_delta, idempotency_key
FROM app.wallet_entries WHERE request_id = :request_id;
```

`:request_id` là tham số của công cụ query, không gửi nguyên văn nếu công cụ không hỗ trợ placeholder. Không SELECT secret hoặc dump mọi tài khoản.

## 5. Gate D — duplicate, webhook và worker

### Duplicate trên chính request đã thành công

- [ ] Mở lại/status/reload và retry capture cùng request thuộc chính tài khoản demo: vẫn một order/capture/credit, ví không tăng lần nữa; outcome DUPLICATE không tự thay thế GET xác nhận.
- [ ] Retry create cùng requestId/amount/provider giữ ID/báo giá/order. Không đổi key để vượt lỗi timeout.
- [ ] Gửi lại **event thật** đã có từ Webhook Events của app Sandbox nếu root cho phép: server xác minh signature, GET canonical order và trả hợp lệ/duplicate; không thêm credit. Không coi webhook simulator đơn lẻ là bằng chứng nạp thật vì nó không có canonical order do app tạo. Hạn mức hiện là 60 webhook/phút/process.

Webhook và API có thể tranh nhau tất toán nên nguồn ledger WEBHOOK hoặc RECONCILER đều có thể đúng. Nếu muốn chứng minh riêng webhook ghi ví, cần **request thử bổ sung** kiểm soát thứ tự để API chưa commit; không thể ép nguồn của request đã thành công bằng sửa DB.

### Worker bằng GET, không gửi capture mới

- [ ] Với request đã thành công, quan sát một lượt worker/đối soát chỉ đọc, ví/credit không tăng thêm và không phát sinh capture POST mới.
- [ ] Để chứng minh **worker phục hồi** thay cho webhook/response mất, cần request riêng trên môi trường diễn tập: capture Sandbox đã completed nhưng settlement địa phương chưa commit; dùng điểm fault/network control được root cho phép ở staging, không fault production. Sau phục hồi kết nối, GET đối soát tất toán đúng một lần, quote/capture không đổi. Nếu không có môi trường kiểm soát an toàn, đánh dấu ca này CHƯA CHẠY; bộ HTTP giả đã kiểm nhưng chưa là bằng chứng Sandbox thật.
- [ ] Worker mặc định mỗi 60s, min-age30s; chờ ít nhất một cửa sổ hợp lý theo cấu hình thực. Hết cửa sổ không kết luận tự động FAILED; ghi request ID và lỗi sanitized để đối soát.

Khóa provider `PayPal-Request-Id` ổn định khi retry; [tài liệu chính thức](https://developer.paypal.com/api/rest/reference/idempotency/) không biến HTTP 200/duplicate thành quyền tự cộng ví. Capture lại chỉ qua đường owner/claim/GET đã có.

## 6. Tiêu chí dừng ngay

- Domain PayPal/API sai hoặc Live; merchant/currency/amount/order/request/capture không khớp.
- Config enabled nhưng thiếu credentials cần thiết, migration lỗi, CORS/cookie/Passkey sai origin, frontend/API khác phiên bản có hợp đồng không tương thích.
- Hủy/timeout/PENDING/HTTP 200 đơn lẻ làm UI báo thành công, ví tăng khi canonical capture chưa COMPLETED, hoặc request chưa SUCCEEDED có credit.
- Hai credit/capture ID gắn sai request, ví tăng khác VND quote, transaction rollback mất bằng chứng, hoặc worker gửi POST capture.
- UNKNOWN sau POST bị đổi READY/FAILED mà không terminal proof; lịch sử POST/evidence bị xóa. AWAITING_APPROVAL có thể chỉ là thông báo cần buyer action trong khi state tài chính vẫn UNKNOWN, không phải chứng cứ không thu tiền.
- RECOVERY_REQUIRED/CREATE_RECOVERY_REQUIRED/conflict: dừng tự động, lưu bằng chứng, root đối soát. Chưa có API admin tự credit thủ công; không sửa SQL để cho hết lỗi.

Lỗi từng lệnh chỉ ghi mã an toàn/request ID và thời gian; không ghi raw OAuth, secret, headers Authorization hoặc cookie. PayPal yêu cầu buyer qua link payer-action trước capture; code kiểm GET trước và sau để giữ bằng chứng. [Nguồn lỗi](https://developer.paypal.com/api/errors/overview/).

## 7. Quay lui tính năng — giới hạn quan trọng của mã hiện tại

1. Root đặt `PAYPAL_SANDBOX_ENABLED=0` và `MOCK_PROVIDER_CHECKOUT=0`, redeploy/restart backend để singleton đọc lại môi trường. Kiểm config hai cổng đều false và UI đóng cổng, không tạo ý định mới.
2. **Flag-off hiện tắt cả create/capture, webhook và PayPal worker**. Pending/UNKNOWN không được coi là đã hủy/hoàn tiền; có thể đã thu Sandbox nhưng chưa ghi ví. Giữ webhook ID/credentials/binding/order/capture/ledger; PayPal có cơ chế giao lại webhook không-2xx, nhưng không dựa retry để xóa evidence.
3. Khi sửa xong, re-enable **cùng app/merchant/credentials** theo quyết định root rồi đối soát các ID cũ bằng GET. Không tạo order thay thế, không tự cộng ví hoặc đổi merchant để bỏ lỗi.
4. Không đổi schema/migration xuống bản trước và không restore backup đè dữ liệu đã thu chỉ để frontend hết lỗi. Nếu cần rollback code, chọn build đã có provider isolation và hiểu v4–v6; root phải kiểm compatibility với pending PayPal.
5. Nếu cần dừng nhận nạp mới nhưng vẫn webhook/worker hoạt động, mã hiện tại chưa có admission flag riêng; đó là một cải tiến vận hành tùy chọn, không giả vờ đã có trong checklist này.

## 8. Tài liệu đang lỗi thời cần cập nhật, không sửa lịch sử bàn giao

- `PAYPAL-SANDBOX-INTEGRATION.md` mục 1/3/5/6 vẫn mô tả chỉ hai module, chưa route/DB/worker/UI, env đề xuất chưa server đọc. Đây không còn trạng thái code c4ed8bc.
- `PAYPAL-STORE-DESIGN.md` mục trạng thái luồng tích hợp vẫn nói chưa route/adapter/webhook/worker/HTTP. Phải phân biệt giới hạn bộ store test với code toàn hệ thống đã nối.
- `HOP-DONG-API-PAYPAL-P2-M2.md` mô tả checkout chỉ READY/PENDING và GET status/history không gọi mạng. c4ed8bc cho UNKNOWN với action hint truy vấn PayPal mới; URL chỉ cấp sau canonical GET. Cần cập nhật đoạn này và ghi rằng GET mismatch/network có thể trả lỗi sanitized.
- `DEPLOY-VERCEL-RAILWAY-SUPABASE.md` là hướng dẫn migration cũ, thiếu env PayPal/webhook riêng/flag gates; tổng 489 cũ không dùng làm kết quả hiện tại. Các câu về main/Render/nhánh deploy là thời điểm viết, cần kiểm dashboard/Git mới trước khi thao tác.
- Các `PHAN-HOI-MAX-M1-*`, `CHOT-P2-VA-TIEN-DO-PAYPAL.md`, checklist chờ hash là lịch sử bàn giao theo hash; không sửa giả lịch sử. Thêm trang trạng thái hiện tại trỏ đúng nền/PR đã duyệt.

## 9. Biên bản để root ký nghiệm thu

Ghi commit API/frontend; môi trường/database label; thời gian; app Sandbox label/merchant ID không secret; event/capture/request ID; số dư B và B+VND; số credit; kết quả cancel/duplicate/webhook/worker; ảnh UI/PayPal chỉ dữ liệu demo; ca chưa chạy và lý do. Chỉ root chốt bật trên web chính sau khi credentials, migration, browser thật và các gate được đối chiếu. Không dùng checklist này như chứng nhận rằng Sandbox thật đã chạy.
