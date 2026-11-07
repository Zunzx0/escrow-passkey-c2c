# Thực nghiệm 2 trên website Enclave, không dùng DevTools

Trang chuẩn bị dự kiến: `https://enclave.id.vn/experiments/s2.html`. Chỉ có sau khi bản giao diện này được duyệt và phát hành. Chế độ này sử dụng phiên thật và Passkey thật của người mua. Script gọi duy nhất `https://api.enclave.id.vn`, trên cùng hai đơn được chọn trên website.

## Thao tác

1. Đăng nhập người mua trên Enclave. Chuẩn bị hai đơn A và B đã nhận/kiểm hàng, đang chờ chuyển tiền. Chưa bấm chuyển tiền trong trang đơn.
2. Mở trang chuẩn bị ở trên bằng chính trình duyệt đã đăng nhập. Dán đường dẫn A và B, bấm **Kiểm tra hai đơn**.
3. Đọc tên hàng, người bán và số tiền. Đánh dấu đồng ý dùng số dư mô phỏng. Bấm **Xác nhận Passkey cho đơn A**, tự hoàn tất Windows Hello. Trang chỉ xin phiếu xác nhận, chưa gọi giải ngân.
4. Bấm **Sao chép gói xác nhận**. Gói có hiệu lực ngắn theo thời hạn máy chủ cấp, hiện đếm ngược trên trang.
5. Mở PowerShell ở thư mục có ba tệp `Chay-S2-Enclave.ps1`, `S2-Enclave.cjs`, `s2-live-client.cjs`; máy cần Node.js 24. Chạy:

   ```powershell
   .\Chay-S2-Enclave.ps1
   ```

6. Khi có lời nhắc, dán bằng Ctrl+V rồi Enter. Nội dung được ẩn; không gửi gói vào chat. Script thử phát lại phản hồi WebAuthn, đưa phiếu A sang B, sau đó dùng đúng phiếu cho A và thử gửi lặp.
7. Chụp phần kết quả PowerShell. Trở lại Enclave: A đã hoàn tất; B còn đang giữ tiền. Kết quả JSON dưới `results/` không chứa token, phiếu hoặc phản hồi chữ ký.

Nếu thiết bị chặn thực thi tệp PowerShell, không tự hạ chính sách máy. Cần kiểm tra nguyên nhân hoặc chạy launcher theo cách được người quản trị máy cho phép.

## Ý nghĩa kết quả

`GET /users/me` và quyền đọc cả A/B xác nhận phiên người mua hợp lệ. Phát lại phản hồi WebAuthn đã xác minh phải trả `400 CHALLENGE_REPLAY`. Phiếu A đưa vào B phải trả `401 REAUTH_REQUIRED`, không làm thay đổi trạng thái hai đơn hay ví người mua. Các lỗi `UNAUTHENTICATED`, lỗi mạng hoặc `404` đều làm lượt thử dừng, không được coi là bằng chứng chống phát lại.

Sau đối chứng chuyển tiền A thành công, gửi lại **cùng requestId** có thể trả `200` theo cơ chế chống ghi lặp; số liệu phải giữ nguyên. Dùng phiếu cũ với requestId mới trên đơn hoàn tất trả `409 INVALID_STATE` ở bản backend đã đối chiếu. Mã lỗi này phản ánh trạng thái đơn, không tự chứng minh mọi bước kiểm phiếu đã được thực thi. Script quan sát đúng một sự kiện giải ngân trong nhật ký A; muốn kết luận đúng một cặp bút toán và tổng tiền toàn hệ thống cần đọc/đối chiếu CSDL riêng.

Luồng này chứng minh ràng buộc phiếu vào đơn, chống phát lại phản hồi WebAuthn và chống thực hiện lại lệnh chuyển tiền. Nó chưa bao gồm tráo quyết định phân xử của admin, thay đổi nội dung sau ký hoặc thí nghiệm phishing trên domain giả. Các nhánh đó phải được ghi nhận riêng nếu thực hiện tiếp.

## Cấu trúc mã và cách bảo vệ dữ liệu

`S2-Enclave.cjs` là đoạn gửi yêu cầu cần trình bày. `s2-live-client.cjs` xử lý xác thực phiên, timeout, lỗi và đối chiếu trạng thái. Launcher PowerShell chỉ nhận gói xác nhận bằng lời nhắc che nội dung và chuyển cho Node qua stdin. Không đặt bí mật vào tham số tiến trình hoặc biến cấu hình công khai.

Gói sao chép chứa access token, phiếu và phản hồi WebAuthn đã ký; đây là dữ liệu nhạy cảm, không phải khóa riêng của Passkey. Base64 chỉ là cách đóng gói, không phải mã hóa. Quyền chuyển tiền vẫn do backend kiểm tra bằng phiên, chủ đơn, ngữ cảnh và phiếu một lần. Không đưa gói vào ảnh, báo cáo, lịch sử lệnh hoặc Git. Launcher cố gắng thay nội dung clipboard nếu nó vẫn đúng gói vừa dán; clipboard history của hệ điều hành nằm ngoài khả năng bảo đảm của script.

Trang giữ dữ liệu trong bộ nhớ, xóa khi rời trang hoặc hết hạn phiếu, không dùng localStorage/sessionStorage để lưu token/phiếu. Trang sử dụng cookie HttpOnly để làm mới đúng phiên đang đăng nhập qua API hiện có, đòi UV từ API và chỉ xuất gói sau khi WebAuthn được backend xác minh. Trang không sửa backend, DB, thời hạn phiếu, kiểm tra RP ID/origin hay logic Escrow.

## Trạng thái kiểm chứng

Các bộ kiểm script/UI sử dụng dữ liệu tổng hợp. Kiểm giao thức dùng HTTP thật và CSDL SQLite mới, với bộ xác thực phần mềm và DOM giả lập; chúng chứng minh giao thức chuẩn bị tương thích API nhưng chưa thay thế lần Windows Hello thật trên website sau phát hành. Chỉ công nhận thực nghiệm live sau khi người dùng xác nhận Windows Hello và có phản hồi/đối chiếu của chính lượt trên Enclave.
