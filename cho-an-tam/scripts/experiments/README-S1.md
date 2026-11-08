# Thực nghiệm S1 — đã đóng trang thu thập công khai

Trang /experiments/s1.html không còn được phục vụ. Không hướng dẫn người dùng thường sao chép phiên đăng nhập từ website. Mã trang cũ được giữ dưới test/fixtures/experiment-browser, ngoài public/ và ngoài ảnh Docker vận hành. Công cụ thu thập thay thế phải được rà soát riêng về tài khoản thử nghiệm và ranh giới truy cập.

Script Node còn được giữ làm mã thực nghiệm gửi yêu cầu; nó không tự lấy phiên trong trình duyệt và không còn có trang công khai để cấp gói mới. Ảnh và số liệu từ lần thực nghiệm đã thực hiện vẫn dùng được nếu mô tả đúng giả định bản sao phiên có kiểm soát. Không thay kết quả live bằng kiểm cách ly hoặc ghi thêm kết quả chưa quan sát.

Gỡ trang không thu hồi các gói đã xuất. Sau khi kết thúc thực nghiệm, đăng xuất tài khoản thử nghiệm qua ứng dụng để thu hồi phiên tương ứng. Không gửi token, mật khẩu hoặc PIN qua chat.

## Quy trình cũ đã ngừng — giữ để truy vết, không thực hiện trên bản công khai

Trang chuẩn bị: https://enclave.id.vn/experiments/s1.html . Chỉ dùng được sau khi gói S1 được duyệt và phát hành. Người dùng đã đăng nhập Enclave trước; trang không hỏi mật khẩu và không xin phiếu chuyển tiền.

1. Chuẩn bị một đơn của người mua thử nghiệm, đã nhận/kiểm hàng và đang chờ chuyển tiền. Chưa bấm chuyển tiền.
2. Mở trang chuẩn bị, nhập đường dẫn đơn và bấm Kiểm tra đơn. Đọc thông tin, đồng ý dùng tài khoản thử nghiệm rồi bấm Sao chép phiên thử nghiệm.
3. Trong thư mục đã giải nén, mở Chay-S1.cmd. Chương trình chỉ đọc gói được chủ tài khoản vừa sao chép, dùng Node và cmdlet Get-Clipboard của Windows. Không mở F12, không nhập token, mật khẩu hay PIN vào cửa sổ script; không thay ExecutionPolicy.
4. Script chứng minh phiên hợp lệ bằng GET users/me và quyền đọc đơn, rồi POST release với một giá trị phiếu cố ý không hợp lệ. Phải là 401/REAUTH_REQUIRED và trạng thái/ví/nhật ký giữ nguyên mới ghi đạt nhánh bị chặn. 401 UNAUTHENTICATED, 403, 404 hoặc lỗi mạng không phải bằng chứng nhánh này đạt.
5. Chụp kết quả script. Sau đó chính chủ quay lại trang đơn bình thường, bấm chuyển tiền và tự xác nhận Windows Hello. Chụp kết quả hoàn tất để làm đối chứng. Phần script S1 không tự xác nhận Windows Hello và không ghi đối chứng chính chủ là đã hoàn tất.

Trong mã API hiện tại, bỏ hẳn trường reauthGrant sẽ bị 400 VALIDATION_ERROR trước khi kiểm quyền tiền. Vì vậy script gửi giá trị giả `S1_NO_VALID_PASSKEY_GRANT` để kiểm tra hàng rào phiếu hợp lệ, không phải thử lỗi thiếu trường JSON.

Nếu cần ảnh kết quả trong PowerShell, mở PowerShell tại thư mục giải nén và gõ `node .\S1-Enclave.cjs --clipboard` sau khi sao chép gói. Gõ lệnh này thay vì sao chép nó sau gói, để không ghi đè gói trong Clipboard. Chay-S1.cmd là cách mở nhanh một cửa sổ console trên Windows; nó không bảo đảm shell đang hiển thị là PowerShell.

Mã đưa vào báo cáo là S1-Enclave.cjs: có request POST /release và giá trị phiếu cố ý không hợp lệ. Tệp s1-live-client.cjs hỗ trợ đọc gói, kiểm phiên/đơn, đối chiếu số liệu và in kết quả. Tệp JSON kết quả chỉ có dữ liệu đối chiếu đã lọc, không có mã phiên. Không dùng ảnh kết quả cách ly dưới đây như ảnh của website thật.

Thông tin lấy trước đây bằng F12 là access token trong Authorization Bearer và mã đơn. Cookie HttpOnly chỉ dùng làm mới phiên trong trình duyệt; không sao chép nó ra script. Trang S1 dùng API làm mới phiên sẵn có rồi chỉ xuất access token và mã đơn của đúng tài khoản. Không xuất reauthGrant/assertion/khóa riêng. Mốc expiresAt trong gói lấy từ exp của token để hướng dẫn thời hạn; máy chủ mới là nơi quyết định phiên hợp lệ, và đăng xuất/thu hồi có thể làm token mất hiệu lực sớm hơn.

Đây là mô phỏng người tấn công đã có phiên của tài khoản thử nghiệm. Nó không khai thác XSS, đánh cắp phiên hay chứng minh quá trình phishing thực tế. Ngay cả nếu tài khoản đăng nhập ban đầu bằng Passkey, việc có phiên vẫn khác với việc xác thực lại để chuyển tiền.

Gói phiên là dữ liệu nhạy cảm, có thể được dùng lại trong thời gian phiên còn hiệu lực. Base64 không phải mã hóa; không gửi gói vào chat, Git hoặc ảnh báo cáo. Script không đặt gói/token vào argv hay lưu trong kết quả. Nó chỉ cố thay clipboard nếu SHA256 nội dung hiện tại vẫn khớp gói vừa đọc, không bảo đảm xóa lịch sử clipboard của hệ điều hành.

Script gọi duy nhất api.enclave.id.vn, không tự gửi lại lệnh khi lỗi mạng. Nếu phản hồi bất thường, vẫn đối chiếu trạng thái/ví khi có thể và báo khác dự kiến thay vì tự tính là an toàn. Kết quả API chưa thay thế đối chiếu độc lập mọi ví, các bút toán và chuỗi nhật ký trong CSDL.
