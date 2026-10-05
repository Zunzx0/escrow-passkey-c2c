# Checklist M2 — kiểm thử tích hợp tài chính PayPal Sandbox (Claude Max)

Trạng thái: **CHUẨN BỊ. M2 CHƯA BẮT ĐẦU.** Tài liệu này không chứa mã kiểm thử. Mọi mục chờ hash nền tích hợp và hợp đồng API từ Codex.

Nền tham chiếu: `codex/payment-provider-isolation@69c42ab`. Các file store (`paypalPaymentStore.js`, `paypal-store-concurrency-e2e.js`) không đổi từ `8d7d18a`. Commit `69c42ab` chỉ thêm UI nạp tiền, nên không ảnh hưởng kết luận M1.

## 0. Điều kiện bắt đầu (tất cả phải đạt)

- [ ] Codex gửi hash nhánh đã nối **đủ** luồng: coordinator capture, settlement thật, route create/capture có xác thực, route webhook PayPal, worker đối soát theo provider, migration đã áp.
- [ ] Hợp đồng API được Codex chốt bằng văn bản: endpoint, body, response, HTTP status (200/201/202), mã lỗi.
- [ ] Cách đưa fake transport vào: danh sách host chỉ dành cho test, biến môi trường; production không chọn được host.
- [ ] Loại bút toán ví/sổ cái cho PayPal được xác nhận (entry_type mới hay tái dùng TOPUP_CREDIT với request_id).
- [ ] Thời gian chờ được đối chiếu: lease capture (mặc định 120 giây), cửa sổ create (mặc định 5 phút), timeout adapter.
- [ ] Tên điểm fault injection cho settlement PayPal do Codex đặt.

Hiện trạng nền 69c42ab, để tham khảo: store và migration v4–v6 đã có; `paypalSandboxService` **chưa** được expose qua route; tính năng tắt. Không dùng các điểm này làm bằng chứng tích hợp.

## 1. Nguyên tắc chung

- Chạy trên CSDL thật: SQLite file tạm và PostgreSQL CSDL riêng có tên kết thúc `_test`; HTTP server test; fake transport PayPal kiểm soát được.
- Thứ tự được điều khiển bằng barrier (promise), không dùng sleep ngẫu nhiên.
- Mỗi ca kiểm tra đồng thời: `payment_requests`, `paypal_payment_bindings`, số dư ví, `wallet_entries` (đếm bút toán credit), và nhật ký lệnh gọi của fake provider.
- Không sửa sản phẩm để test dễ đạt. Lỗi tìm thấy: báo Codex kèm test tái hiện.
- Không dùng PayPal thật, không dùng production, không đưa secret vào file hay commit.

## 2. Thiết kế fake transport

- Trạng thái provider lưu bền (file hoặc CSDL riêng) để **sống sót qua restart backend**.
- Kịch bản điều khiển được cho từng lệnh:
  - **create:** OK / lỗi mạng trước khi tạo / tạo xong nhưng mất phản hồi / 5xx.
  - **capture:** OK / PENDING / DECLINED / treo chờ lệnh cho phép / thu tiền xong nhưng mất phản hồi.
  - **get:** trả trạng thái hiện tại; có thể trả PENDING/APPROVED khi POST cũ vẫn đang chạy.
  - **webhook:** ký đúng / ký sai / lặp / mất.
- Mỗi lệnh gọi được ghi nhật ký: method, path, idempotency key, thời điểm. Dùng nhật ký này để kiểm số lần POST thực tế.
- Có cơ chế **hold**: giữ một POST cho đến khi test cho phép tiếp tục (barrier).

## 3. Ma trận kiểm thử (theo GIAO-VIEC mục 3)

### T1 — Đồng thời: capture, webhook, đối soát cùng một khoản
- [ ] Chuẩn bị: một yêu cầu PayPal đã gắn order; fake provider báo đã thanh toán.
- [ ] Chạy đồng thời: capture (POST đang treo), webhook trùng hai lần, worker đối soát.
- [ ] Kiểm: đúng **một** bút toán credit; ví tăng đúng số VND; request SUCCEEDED đúng một lần; các POST sau không tạo thu tiền mới.
- [ ] SQLite và PostgreSQL.

### T2 — Từ chối dữ liệu sai, không ghi tiền
- [ ] capture ID đã dùng cho request khác → từ chối, không credit.
- [ ] order, amount, currency, merchant hoặc request ID không khớp (ở webhook, GET, hoặc response capture) → từ chối, không credit.
- [ ] Với mỗi trường hợp: ví không đổi, binding không đổi, lỗi có mã ổn định.

### T3 — Fault injection trong settlement
- [ ] Lỗi sau khi cập nhật ví, trước commit → rollback đủ: ví, `wallet_entries`, request, binding. Không còn VERIFIED mồ côi.
- [ ] Retry sau lỗi: không mất tiền, không cộng trùng.
- [ ] Dùng điểm fault injection do Codex đặt tên.

### T4 — Tách provider
- [ ] Mock checkout và mock webhook từ chối request PAYPAL_SANDBOX: không đổi trạng thái, không credit.
- [ ] Webhook PayPal từ chối request MOCK.
- [ ] Worker phân tuyến: logic hết hạn của mock không bao giờ đóng request PayPal.

### T5 — Kết quả không rõ ràng (ambiguous)
- [ ] Mất phản hồi create (order đã tạo ở PayPal): retry cùng requestId trong cửa sổ → phục hồi **cùng** order, không tạo order mới. Ngoài cửa sổ → `PAYPAL_CREATE_RECOVERY_REQUIRED`, không tự FAILED.
- [ ] Capture đã thu tiền nhưng mất phản hồi: không credit trước khi xác minh; worker GET → VERIFIED → settlement đúng một lần.
- [ ] Crash sau khi đánh dấu POST, trước commit: không POST thứ hai khi chưa xác minh; phục hồi theo `mustVerifyFirst`.
- [ ] Restart backend giữa chừng + worker phục hồi cùng order, không tạo bản ghi thứ hai.

### T6 — Đua giữa capture treo và đóng / thu tiền muộn
- [ ] POST capture đang treo + đóng hết hạn: đóng không thắng; POST thành công muộn → ghi bằng chứng, settlement đúng một lần.
- [ ] Thu tiền muộn trên request đã FAILED do lỗi khác → `RECOVERY_REQUIRED`, không credit, không mở lại.

### T7 — Quyền sở hữu và điểm vào
- [ ] Người mua và người bán không gọi được endpoint settlement của admin.
- [ ] Người khác không lấy được yêu cầu của người mua (404 hoặc 403, không lộ sự tồn tại).
- [ ] Return URL hoặc query `token` không tự cộng tiền.
- [ ] Tài khoản có role bị đổi bằng SQL (không có dấu nguồn gốc admin) không capture và không settle được.

### T8 — Bất biến và suite đầy đủ
- [ ] 9 bất biến được kiểm trước và sau mỗi nhóm.
- [ ] Suite đầy đủ trên SQLite và PostgreSQL từ DB rỗng; báo số phép kiểm, pass/fail/skip, DB test, đường dẫn report.
- [ ] Rate-limit: nếu một ca bị bỏ qua, ghi rõ lý do; không bỏ qua âm thầm.

## 4. Bất biến bổ sung đề xuất (cần Codex quyết định)

- Mỗi request PAYPAL_SANDBOX SUCCEEDED có đúng một bút toán credit và một capture ID.
- Mỗi capture ID VERIFIED gắn đúng một request.
- Không có bút toán credit PayPal cho request chưa SUCCEEDED.

Các bất biến này nằm trong `invariants.js` nên **không** tự thêm: cần Codex quyết định.

## 5. Mẫu báo cáo bàn giao M2

```text
Nhánh / hash / base:
File test:
Ca T1–T8: pass / fail / skip (kèm lý do skip)
SQLite: số phép kiểm, DB test, report
PostgreSQL: số phép kiểm, DB test, report
9 bất biến: kết quả trước/sau
Lỗi sản phẩm tìm thấy (nếu có): test tái hiện + commit liên quan
Rủi ro còn lại:
```

## 6. Cần Codex trả lời trước khi viết test

1. Endpoint create / capture / webhook / reconcile: đường dẫn, body, response, HTTP status và mã lỗi.
2. Cách đưa fake transport vào và danh sách host cho test.
3. Loại bút toán ví cho PayPal.
4. Tên điểm fault injection trong settlement.
5. Giá trị lease capture, cửa sổ create và timeout adapter đang dùng trong code.
6. Worker đối soát PayPal chạy ở đâu: trong process server hay process riêng.
