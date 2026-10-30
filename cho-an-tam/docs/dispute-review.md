# Căn cứ phân xử trước khi trả tiền

Hồ sơ đang tranh chấp tiếp tục giữ tiền cho đến khi có lệnh trả tiền hợp lệ. Passkey xác nhận quản trị viên và ngữ cảnh quyết định; nó không xác định lời trình bày hay ảnh là sự thật, cũng không tự bảo đảm quyết định công bằng.

Quản trị viên độc lập phải nhận xử lý hồ sơ, tải thông tin mới nhất, xác nhận đã đọc và ghi thông tin đã đối chiếu cùng lý do chọn hướng xử lý. Lý do từ 30 đến 2.000 ký tự chỉ là kiểm tra dữ liệu đầu vào, không phải thuật toán chấm chất lượng chứng cứ. Chưa đủ căn cứ thì dùng yêu cầu bổ sung; hệ thống lưu nội dung cho hai bên xem và tiếp tục giữ tiền. Mốc nhắc xử lý không tự trả tiền.

Thiếu mốc người mua tự xác nhận nhận hàng không có nghĩa hệ thống biết người mua thực sự chưa nhận kiện. Điều này cũng không thể là điều kiện bắt buộc của mọi quyết định, vì hồ sơ chưa nhận hàng vẫn cần được xem xét. Khi thiếu mốc này, quyết định trả tiền cần thêm xác nhận đã hiểu thông tin còn thiếu và đã ghi căn cứ đối chiếu. Không thay mốc nhận hàng bằng một xác nhận giả.

Lưu căn cứ chưa cấp phiếu và chưa chuyển tiền. Màn hình sau hiển thị căn cứ đã lưu, đúng số tiền, người nhận và hướng hoàn/chuyển tiền. Quản trị viên phải bấm xác nhận riêng và dùng Passkey có xác minh người dùng. Máy chủ tự dựng ngữ cảnh phiên bản 3, gồm quản trị viên, phiên đăng nhập, đơn, hồ sơ, phiên bản, số tiền, hai bên, quyết định, ID và digest của bản đánh giá. Không nhận số tiền hoặc người nhận tùy ý từ trình duyệt.

Máy chủ kiểm bản đánh giá trước khi cấp challenge, trước và trong transaction cấp phiếu sau xác minh WebAuthn, rồi kiểm lại trong transaction tất toán. Nội dung bổ sung, ảnh hoặc đánh giá mới thay đổi phiên bản và làm bản đánh giá/phiếu cũ không dùng được. Yêu cầu bổ sung cũng làm các quyền quyết định cũ hết hiệu lực. Lệnh tất toán giữ hàng rào CAS, phiếu một lần và khóa chống ghi bút toán lặp. Phát lại đúng yêu cầu đã hoàn tất chỉ đọc kết quả cũ.

Migration PostgreSQL 15 và SQLite chỉ thêm bảng bản đánh giá. Bản ghi có trigger chặn UPDATE/DELETE qua đường ghi thông thường. Không điền ngược lý do cho quyết định lịch sử. Đây không phải bảo vệ chống quản trị viên cơ sở dữ liệu có quyền thay lược đồ hoặc sửa toàn bộ hệ thống. Lý do ở hồ sơ riêng của hai bên và admin phụ trách; nhật ký giao dịch chỉ lưu ID/digest và quyết định, không chép nội dung tự do hoặc địa chỉ vào payload.

Trước phát hành cần sao lưu và kiểm khôi phục/migration. Sau phát hành kiểm phiên bản giao diện/backend và luồng trên website thật với người dùng tự xác nhận Windows Hello; các kiểm tự động dưới đây không thay bước đó. Bản giao diện cũ thiếu reviewId sẽ không xin challenge phân xử được; tải lại trang để dùng bước ghi căn cứ mới. Không hạ hàng rào máy chủ để tương thích giao diện cũ.

Các bộ kiểm liên quan:

- `test/order-money-spec-e2e.js` và `test/order-money-postgres.js`: API thật và DB tạm; DR1–DR8 kiểm gọi trực tiếp, dữ liệu thiếu, yêu cầu bổ sung, chữ ký WebAuthn phần mềm, phiên bản cũ, đổi quyết định, đồng thời và migration lặp. Cả hai hướng hoàn/chuyển tiền giữ bất biến sổ tiền.
- `test/media-upload-e2e.js` và `test/media-upload-postgres.js`: ảnh tổng hợp, Sharp và kho riêng trong bộ nhớ; ảnh mới vô hiệu hóa đánh giá/phiếu cũ. Không phải nghiệm thu ảnh người dùng hoặc Supabase thật.
- `test/auth-redesign-e2e.js`: hồi quy xác thực và quyết định có Passkey phần mềm, outbox email cục bộ.
- `test/ui/dispute-review-ui.js` và các bộ UI liên quan: SPA thật trong JSDOM với API/thiết bị giả, kiểm xác nhận riêng, lỗi cạnh trường, khóa nút khi lưu, hủy xác thực, phiên cũ và yêu cầu bổ sung không trả tiền.

Thiết kế tham khảo nguyên tắc xác thực giao dịch phía máy chủ và chống đổi ngữ cảnh của [OWASP Transaction Authorization Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Transaction_Authorization_Cheat_Sheet.html), cùng mô hình xác thực khóa công khai của [W3C WebAuthn](https://www.w3.org/TR/webauthn-3/). Đây là đối chiếu thiết kế, không phải chứng nhận tuân thủ hay kiểm định độc lập.
