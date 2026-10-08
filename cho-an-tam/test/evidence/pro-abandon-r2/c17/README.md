# C17 — patch của Codex áp lên `8af54be` (số tự chạy của Pro)

Nguồn patch: `CODEX-F03-C17-8af54be.patch` do Codex gửi (sha256 `9CE95FBCA0355DF8F455EBF6369C14B0F5E2295EC89DBEBD7BD6E04B822A1939`, 3305 byte). Pro KHÔNG sửa nội dung patch. Chỉ chuyển kiểu xuống dòng khi áp: `cho-an-tam/src/lib/paypalAbandonment.js` dùng CRLF (giữ CRLF) còn `cho-an-tam/test/paypal-abandonment-e2e.js` dùng LF (đổi phần patch của tệp này sang LF), vì patch gốc toàn CRLF nên `git apply --check` báo lệch ở tệp test. Sau khi áp: `git status` đúng hai tệp, +29/−1, các dòng thêm/bớt giống hệt patch (so sánh bỏ qua kiểu xuống dòng).

Chạy bởi Pro (Node v26.4.0, Windows 11, PostgreSQL 17.11 riêng ở `127.0.0.1:55432`, bản ghép tuần tự):

| Lượt | Kết quả | Exit |
| --- | --- | --- |
| Test MỚI (có C17) trên `paypalAbandonment.js` CHƯA vá (HEAD `8af54be`), SQLite | 398 đạt / 1 hỏng; C17 4 đạt / 1 hỏng (assert "C17 must refuse replay when final DTO shows recovery") | 1 |
| Sau patch, `paypal-abandonment-e2e` SQLite | 399 / 399 (C17 5/5) | 0 |
| Sau patch, `paypal-abandonment-e2e` PostgreSQL | 399 / 399 (C17 5/5) | 0 |
| Sau patch, `paypal-history-isolation` SQLite / PG | 27 / 27 mỗi nền | 0 |
| Sau patch, M2 HTTP SQLite / PG | 67 / 67 | 0 |
| Sau patch, `node --test` module PayPal (6 tệp) | 53 pass, 0 fail, 0 skip | 0 |

Không chạy lại full suite trong lượt này (patch chỉ đổi `done()` trong `paypalAbandonment.js` và thêm một ca vào bộ abandonment độc lập). Số full suite của vòng R2 (`../`) là của bản `8af54be` trước patch. Số của Codex (abandonment 394/394 trên `8af54be`; 398/1 trên `8af54be` với C17; 399/399 SQLite và PostgreSQL sau patch, cluster Codex cổng 54338) nằm trong `PHAN-HOI-PRO-F03-R2-8af54be.md` của Codex và không được Pro nhận là số của mình.
