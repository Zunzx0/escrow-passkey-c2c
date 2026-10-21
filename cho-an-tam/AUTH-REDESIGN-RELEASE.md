# Enclave — triển khai thiết kế đăng ký, đăng nhập và Passkey

Ngày: 21/10/2026. Nhánh làm việc: `codex/auth-passkey-redesign`.

Nguồn yêu cầu: bản thiết kế (3), `Enclave bản sửa đổi kế hoạch đăng ký, đăng nhập và xác thực.md` và các quyết định trực tiếp ngày 21/10/2026. Người dùng chọn **hoàn tất luồng mua hàng trước, rút tiền làm sau**, tự thao tác trình diễn trên hệ thống chính; không dựng thêm môi trường demo hoặc rút ngắn các mốc bảo mật. Mã đang ở nhánh cục bộ; chưa đưa lên enclave.id.vn. Mục 11 ghi trạng thái mới nhất; mục 10 giữ lịch sử của lượt trước.

## 1. Luồng đã triển khai

1. Khách xem chợ không cần đăng nhập.
2. Đăng ký có Email riêng, tên đăng nhập riêng, tên hiển thị và mật khẩu. Máy chủ kiểm tra lại các trường; đăng ký công khai luôn tạo BUYER.
3. Tạo `BASIC`, cấp phiên P để vào chợ ngay; **chưa có ví**. OTP 6 số ngẫu nhiên, HMAC, hạn 10 phút, tối đa 5 lần sai/mã. Trần cứng 20 lần sai/tài khoản trong cửa sổ trượt 24 giờ và khóa OTP ít nhất 1 giờ: phải hết cả hai điều kiện mới mở. Gửi lại cách nhau 60 giây; chung tối đa 5 thư xác minh/giờ/địa chỉ nhận qua mọi tài khoản, giữ nguyên dấu chấm và dấu cộng. Mở lại popup không tự xoay mã, đồng hồ lấy từ máy chủ. Không suy từ phản hồi tiếp nhận rằng thư đã vào hộp thư. BASIC không hoạt động 30 ngày, không có dữ liệu tài chính cần giữ, được dọn.
4. Xác minh email chuyển sang `VERIFIED`, vẫn chưa có ví. Khi bắt đầu nạp/mua hàng mới mở hộp thoại kích hoạt tại chỗ, có nút Để sau. Chưa xác minh thì nhập OTP; nếu đã xác minh ngay trong phiên này thì đi tiếp tạo Passkey. Phiên mật khẩu mới chưa có bằng chứng hộp thư gần đây phải xác minh lại **khi kích hoạt**, vẫn được xem chợ bình thường. Đây là lớp bảo vệ bổ sung cho lần tạo khóa đầu tiên, không khôi phục luồng ép thiết lập sau đăng ký của bản cũ.
5. Tạo Passkey có UV và resident key bắt buộc; `user.id` WebAuthn là 32 byte ngẫu nhiên riêng. Máy chủ kiểm challenge, origin, RP ID và chữ ký qua SimpleWebAuthn.
6. Tên Passkey nhập ngay trong hộp thoại, bỏ trống dùng tên tự động. Trong cùng transaction: ghi credential, kích hoạt ACTIVE, tạo ví/số dư demo nếu đủ điều kiện, lưu băm 8 mã khôi phục, nâng phiên lên K và ghi sự kiện/email chờ gửi. Người mua được tặng 5.000.000 VND demo; ví admin không được tạo.
7. Hiện 8 mã một lần; nền/Escape không làm mất màn này. Nút xác nhận đã lưu chỉ bật sau tải/sao chép và tích ô; Để sau giải thích mất khả năng xem lại, rồi phải bấm xác nhận để sau. Không đánh dấu đã lưu khi hoãn. Banner nhắc tạo lại mã còn hiện. Thao tác nạp/đặt mua ban đầu tiếp tục tại trang cũ; không lưu token/OTP/mã dự phòng vào localStorage.
8. Đăng nhập bằng mật khẩu mở phiên P; Passkey có UV mở phiên K. Có đăng nhập Passkey tự điền nếu trình duyệt hỗ trợ.
9. **Bỏ ngưỡng miễn Passkey 500.000/1.000.000 VND của bản cũ.** Mọi lần khóa tiền cần phiếu `LOCK_ESCROW`, kể cả P hoặc K và đơn nhỏ. Kiểm số dư, người bán, trạng thái và giá trước khi mở xác thực OS. Phiếu gắn với phiên, đơn, hai bên, hàng, giá và phiên bản. Kiểm lại lúc thi hành; tiêu thụ phiếu, chiếm tin đăng bằng version, ghi hai chân ledger và khóa tiền cùng transaction.
10. Nâng phiên P lên K bằng một lần xác thực Passkey, không đăng xuất. Giải ngân, phân xử và thay đổi bảo mật vẫn cần phiếu G mới, 120 giây, dùng một lần.

## 2. Phiếu ủy quyền và bảo vệ thao tác

- `ADD_CREDENTIAL`: thêm Passkey; `REMOVE_CREDENTIAL`: xóa đúng credential ID đã xác nhận. Hai loại không thay thế nhau.
- `LOCK_ESCROW`: mỗi lần thanh toán cần xác nhận, không thay bằng nâng phiên P lên K. G sai đơn/phiên/giá, thiếu context, hết hạn hoặc đã dùng bị từ chối. Nạp tiền vào ví đã kích hoạt không xin G; mở tranh chấp không xin G.
- `CHANGE_PASSWORD`: thêm yêu cầu mật khẩu hiện tại; thay đổi, thu hồi phiên khác và tiêu thụ G cùng transaction.
- `CHANGE_EMAIL`: gắn với email mới; cần mã tại email cũ và mới. Tài khoản cũ chưa có email đã xác minh dùng Passkey hiện có và mã tại email mới.
- `REGENERATE_RECOVERY`: tạo lại bộ mã; bộ cũ hết hiệu lực ngay trong transaction.
- `RELEASE_ESCROW`, `ADJUDICATE`: giữ ràng buộc người dùng, phiên, giao dịch/hồ sơ, quyết định và context hash. Thiếu context hash bị từ chối. Kiểm lại ngữ cảnh khi thực thi, không chỉ lúc xin G.
- G phải được cấp từ credential còn tồn tại và phiên còn hiệu lực tại thời điểm dùng. Dùng đồng thời cùng G chỉ được một lần commit.
- Tạm khóa xin phiếu sau ba lần xác thực sai liên tiếp; bộ đếm theo tài khoản ở DB. Giới hạn xin phiếu mặc định 5 lần/phút/tài khoản.
- Không cho xóa Passkey cuối. Xóa Passkey thu hồi phiên khác, giữ phiên hiện tại và gửi thông báo bảo mật.
- Giữ vận chuyển mô phỏng và xác nhận nhận hàng riêng với giải ngân. Bổ sung thời hạn kiểm tra mặc định 24 giờ, `ORDER_INSPECTION_SECONDS`, lưu trong DB từ lúc vào WAIT_CONFIRM. Worker riêng tự mở **DISPUTED/FROZEN** khi quá hạn; không tự giải ngân. Hai worker không tạo hai tranh chấp và không làm đổi số dư. Đơn cũ không có hạn kiểm tra không bị áp hạn hồi tố.
- Thanh toán gửi biên nhận cho người mua; giải ngân gửi xác nhận cho cả hai qua outbox cùng transaction. Mail gửi thất bại không tạo lại giao dịch tiền.

## 3. Khôi phục

### Còn mật khẩu và mã dự phòng

Đăng nhập mật khẩu, nhập lại mật khẩu và một mã dự phòng. Mã được tiêu thụ nguyên tử, gửi thông báo bảo mật; chỉ cấp phiên `recover`, không gọi được chức năng nghiệp vụ. Sau khi tạo Passkey mới có UV, thu hồi Passkey/phiên/G và toàn bộ mã cũ, sinh 8 mã mới hiển thị một lần. Tiền và trạng thái đơn không đổi. Không áp hạn chế 72 giờ của đường email cho đường này. WITHDRAW/ADD_PAYOUT và giới hạn 24 giờ của hai chức năng đó được để đợt sau.

### Chỉ còn email

- Gửi yêu cầu luôn có phản hồi chung cho email tồn tại và không tồn tại.
- Liên kết đầu sống 30 phút, dùng một lần; người dùng phải bấm xác nhận mới bắt đầu 24 giờ chờ.
- RECOVERING khóa giải ngân/phân xử. Có email cảnh báo, nhắc ở mốc 12 giờ và 23 giờ.
- Đăng nhập bằng Passkey cũ tự hủy khôi phục. Liên kết hủy chỉ hủy đúng yêu cầu tương ứng.
- Sau thời gian chờ, worker gửi liên kết tiếp tục sống một giờ. Máy chủ vẫn kiểm thời điểm, trạng thái và thời hạn; giao diện không quyết định điều kiện này.
- Tạo Passkey mới có UV, bắt buộc mật khẩu mới, thu hồi phiên/Passkey/liên kết/G cũ; tạo bộ mã khôi phục mới.
- Hạn chế giải ngân và phân xử 72 giờ ở **cấp tài khoản**, nên thêm một Passkey khác không bỏ qua được hạn chế.
- Nếu không hoàn tất trong thời hạn, yêu cầu hết hiệu lực và Passkey cũ được giữ nguyên. Không khóa tiền vô thời hạn vì một yêu cầu khôi phục bỏ dở.
- Không có cả email lẫn mã dự phòng thì không có khôi phục tự phục vụ. Email bị chiếm lâu dài vẫn là giới hạn của mô hình; thời gian chờ chỉ làm chậm tấn công.

### Quên mật khẩu

Liên kết email 30 phút, một lần; đặt lại mật khẩu thu hồi tất cả phiên. Nó không tự thêm Passkey và không cấp G. Đổi email/hoàn tất khôi phục vô hiệu các liên kết bảo mật cũ còn chờ.

## 4. Phiên và giao diện

- Access token chỉ ở bộ nhớ trang; xóa `cat_token`, `cat_user` cũ khỏi localStorage. Tải lại trang khôi phục qua cookie refresh HttpOnly.
- Cookie giữ `/api/passkeys/session`, HttpOnly, SameSite=Strict. Production luôn có Secure kể cả TLS kết thúc ở proxy. Frontend enclave.id.vn và API api.enclave.id.vn cùng site; không chuyển cookie sang None.
- Refresh xoay vòng và lưu lịch sử băm. Trùng tức thời trong 10 giây chỉ trả 409, không cấp token và không đặt/xóa cookie, tránh hai tab thu hồi nhầm phiên. Frontend thử tối đa 3 lần bằng cookie hiện tại, kiểm phiên trước mỗi lần. Phát lại token cũ sau cửa sổ này thu hồi phiên. Logout qua cookie cũ vẫn thu hồi ngay. Đây là đánh đổi có chủ đích: phát lại trong 10 giây chưa gây thu hồi, nhưng tuyệt đối không nhận được token mới.
- P: nhàn rỗi 2 giờ, tuyệt đối 24 giờ. K: nhàn rỗi 12 giờ, tuyệt đối 7 ngày. Nhãn phiên đọc từ DB, không nhận quyền do giao diện gửi.
- Có dấu đăng xuất không chứa bí mật trong localStorage để khi logout gặp lỗi mạng, tải lại trang không tự đăng nhập lại từ cookie chưa kịp thu hồi. Dấu này bị xóa khi người dùng đăng nhập thành công.
- Trang Bảo mật có email, Passkey/đổi tên, số mã dự phòng còn lại, danh sách phiên/đăng xuất phiên khác và 30 sự kiện bảo mật gần nhất.
- Kiểm tra trình duyệt nhúng/khả năng Passkey là cảnh báo mềm. Vẫn cho thử khóa ngoài hoặc điện thoại khác. Không hạ yêu cầu UV ở máy chủ.
- Popup khóa các nút trong khi đang gửi thao tác, chặn đóng bằng nền/Escape và chặn nhấn lặp. Có xác nhận trước khi xóa Passkey.
- Chữ giao diện nêu cả vân tay, khuôn mặt và mã PIN thiết bị; giải ngân là chuyển **số dư mô phỏng**.

## 5. Email Resend cần cấu hình trước khi công khai bản mới

Người dùng đã chọn chuẩn bị Resend và hiện chưa có dịch vụ gửi thư. Không tự tạo tài khoản nhà cung cấp, không đưa mã OTP lên giao diện hoặc endpoint công khai.

Thiết lập trong secret store của máy chủ, không commit `.env`:

```dotenv
RESEND_API_KEY=<khóa gửi thư của Resend>
AUTH_EMAIL_FROM=Enclave <security@ten-mien-da-xac-minh>
AUTH_PUBLIC_URL=https://enclave.id.vn/
AUTH_MAIL_ENCRYPTION_KEY=<khóa ngẫu nhiên riêng, giữ ổn định>
AUTH_SECRET_PEPPER=<khóa ngẫu nhiên riêng, giữ ổn định>
```

Phải xác minh domain gửi trong Resend bằng các bản ghi DNS của nhà cung cấp. Không yêu cầu người đăng ký Enclave có tài khoản Resend. Thử gửi tới hộp thư thật do chủ hệ thống kiểm soát trước khi mở đăng ký công khai. Không cần cung cấp các khóa trong hội thoại.

Email dùng outbox AES-256-GCM cùng transaction với thay đổi bảo mật; HTTPS, hạn chờ, lease, idempotency và backoff khi lỗi/429. Không ghi OTP/token/API key vào log. Xóa ciphertext sau gửi hoặc hết hạn, tối đa 24 giờ; thư OTP/link ngừng gửi khi hết hiệu lực. HMAC/ciphertext ghi key ID; keyring đọc khóa cũ, không được bỏ pepper cũ khi còn recovery code hợp lệ dùng nó. `.env.example` có quy tắc xoay khóa. Production từ chối khóa thiếu/ngắn, URL không HTTPS và mốc khôi phục/kiểm hàng thấp hơn cấu hình chuẩn. Chưa cấu hình email thì đăng ký/khôi phục trả lỗi rõ ràng.

Liên kết xác minh dự phòng được mở trên thiết bị khác: preview chỉ đọc; phải đăng nhập mật khẩu đúng tài khoản, thấy username/email che bớt và bấm Xác nhận POST. Chỉ phiên vừa xác nhận có bằng chứng email mới; không tự đăng nhập, mở ví, nâng K hoặc cấp G. Token bị dọn khỏi URL và chỉ giữ trong bộ nhớ trang. Liên kết dùng một lần, gắn email và mã hiện tại.

Tài liệu tích hợp: https://resend.com/docs/api-reference/emails/send-email

## 6. Nâng cấp và tương thích

- PostgreSQL: migration 8 thêm trạng thái/cột; 9 thêm các bảng auth; **10** thêm BASIC/VERIFIED, LOCK_ESCROW, thời điểm hoạt động, hạn kiểm tra hàng và index email duy nhất cho địa chỉ đã xác minh.
- Migration **11** thêm bảng OTP/quota bền, email gắn với mã và hạn outbox, `user_handle` theo từng credential. Khóa cũ chưa biết handle không bị giả định dùng handle mới của tài khoản; khóa mới có handle được kiểm đúng bản ghi. SQLite cũng thêm cột vào bảng auth đã tồn tại, không chỉ CREATE IF NOT EXISTS.
- SQLite: dựng lại ràng buộc CHECK có bảo toàn dữ liệu, index, trigger và kiểm khóa ngoại. Có kiểm thử bằng DB cũ đã có trigger quản trị, ví và ledger.
- Không reset DB, không cộng lại số dư của tài khoản ACTIVE, không tự đánh dấu email cũ là đã xác minh.
- ACTIVE cũ tiếp tục dùng được; vào Bảo mật để thêm email đã xác minh và tạo mã dự phòng bằng Passkey đang có.
- PENDING_EMAIL/PENDING_PASSKEY cũ của người dùng thường chuyển sang BASIC/VERIFIED tương ứng, được vào chợ, vẫn phải xác minh và tạo Passkey trước khi có ví. Trạng thái bootstrap admin được giữ riêng. Tài khoản có ví hoặc lịch sử giao dịch được bảo vệ khỏi dọn nhầm.
- Giữ luồng bootstrap quản trị có provenance: mật khẩu tạm → đổi mật khẩu → Passkey; không tạo ví admin. Đây là ngoại lệ vận hành cho quản trị cũ, không phải đường đăng ký công khai không email.
- Cờ sao lưu của credential cũ là chưa biết, không tự suy đoán là chỉ nằm trên thiết bị. Credential mới lưu BE/BS; đăng nhập hợp lệ cập nhật thông tin sao lưu.
- `EXPERIMENT_FREEZE.json` và báo cáo cũ không được ghi đè. Chúng là bằng chứng của phiên bản trước, không phải kết quả đo của lần sửa này.

## 7. Kiểm thử và giới hạn công bố

Các lệnh độc lập dùng dữ liệu thử:

```text
npm ci --ignore-scripts --no-audit --no-fund
npm run test:auth
npm run test:auth:postgres
node test/ui/session-refresh-ui.js
node test/ui/paypal-return-routing-ui.js
node test/ui/shipping-ui.js
node test/ui/home-navigation-ui.js
node test/invariants-unit.js
```

`test:auth:postgres` cần PostgreSQL 17 cục bộ; nó tạo cụm tạm chỉ nghe 127.0.0.1, dựng phiên bản 7 có dữ liệu cũ, kiểm nâng cấp và tự dừng. Không kết nối Supabase hay service PostgreSQL đang dùng. Suite HTTP dùng chữ ký của software authenticator qua bộ xác minh WebAuthn thật. UI dùng jsdom và mock fetch, không phải bằng chứng vân tay/Face ID thực tế.

Kết quả kiểm thử ngày 21/10/2026:

| Nhóm | Kết quả |
| --- | --- |
| Migration SQLite từ DB cũ có ví, ledger, khóa, trigger admin | PASS; chạy lại không mất dữ liệu, kiểm khóa ngoại sạch |
| API + chữ ký WebAuthn thật trên SQLite tạm | **95 + 43 PASS**; gồm OTP, phiên, tài khoản, tiền, recovery và giả X-Forwarded-For ở chế độ server trực tiếp |
| PostgreSQL tạm, nâng từ migration 7 lên 11, API/WebAuthn | **97 + 42 PASS**; thêm 2 kiểm giữ số dư/email cũ; ca X-Forwarded-For cuối chỉ chạy SQLite |
| PostgreSQL đã có bảng auth-v10 thiếu cột mới | PASS thêm cột, giữ OTP/outbox, chạy migration 11 hai lần |
| Auth UI qua DOM | **28 PASS** |
| Email/link/recovery UI qua DOM | **20 PASS** |
| Cảnh báo/luồng kích hoạt trên mô phỏng mobile | **8 PASS** |
| PayPal quay về ví và thứ tự menu | **18 PASS** |
| Refresh phiên, hai tab và phản hồi đến muộn | **17 PASS** |
| Giao diện vận chuyển | **23 PASS** |
| Breadcrumb và logo về trang chủ | **4 PASS** |
| Backend vận chuyển, HTTP thật và worker tách tiến trình | **82 PASS** |
| Ví PayPal DOM | **220 PASS** |
| PayPal tất toán / HTTP / abandon, provider giả | **85 / 67 / 399 PASS** |
| HMAC/AES version, legacy, xoay khóa; outbox lỗi/429/lease/expiry; cookie Secure | PASS qua kiểm thử độc lập, không gọi Resend thật |
| Kiểm chín bất biến bằng các dữ liệu cố tình sai rồi hoàn tác | PASS |
| Cú pháp JS thay đổi, kiểm khoảng trắng, dependency production | **46 tệp PASS**; production dependency giữ nguyên, jsdom là devDependency |

Các kiểm thử UI là jsdom/mock; kiểm WebAuthn API dùng chữ ký từ bộ xác thực phần mềm. **Chưa gửi thư thật, chưa đo vân tay/Face ID trên điện thoại thật, chưa triển khai production**. Chưa chạy lại toàn bộ bộ 489 kiểm tra của báo cáo đóng băng: không lấy kết quả cũ làm bằng chứng của bản auth mới. PostgreSQL hiện có cảnh báo tương thích tương lai về truy vấn song song của `pg@9`; dependency production đang dùng vẫn giữ phiên bản khóa cũ.

## 8. Các điểm điều chỉnh so với bản đề xuất

1. Một thiết bị có thể giữ Passkey cho nhiều tài khoản; chỉ chặn credential trùng, không chặn toàn bộ thiết bị.
2. `backedUp` mô tả trạng thái sao lưu, không chứng minh định danh thiết bị. Không gắn nhãn tuyệt đối “chỉ trên thiết bị” cho bản ghi cũ/không rõ.
3. Không nói “không có gì để đánh cắp trên máy chủ”: máy chủ vẫn có dữ liệu tài khoản và khóa công khai cần bảo vệ. Chỉ khóa riêng/sinh trắc không được Enclave lưu.
4. Không tự lặp hộp thoại OS khi người dùng hủy hoặc báo chắc chắn họ bấm hủy: WebAuthn có thể gộp hủy, hết giờ và không cho phép thành cùng lỗi. Cho thử lại có chủ đích, giữ UV bắt buộc.
5. `WITHDRAW`/`ADD_PAYOUT` và việc chờ tài khoản nhận 24 giờ **được người dùng chọn để đợt sau**. Chưa có endpoint hay UI rút tiền; không trình bày như chức năng đã hoàn thành.
6. CAPTCHA và email “đăng nhập từ thiết bị mới” là mục tùy chọn trong thiết kế, chưa bật. Không có nhận diện danh tính thật hay chống tạo nhiều tài khoản tuyệt đối: địa chỉ email/alias không tương đương một người duy nhất.
7. Token ở bộ nhớ giảm lưu tồn qua XSS, không loại bỏ XSS đang chạy. Phiên K không thay phiếu G. Tài khoản khôi phục qua email vẫn có giới hạn an toàn đã mô tả.
8. Có khe hở nếu chỉ kiểm cờ email đã xác minh khi tạo khóa đầu: người có mật khẩu có thể đăng nhập sau đó và gắn khóa trước chủ tài khoản. Bản triển khai yêu cầu bằng chứng email trong phiên kích hoạt còn hạn 30 phút. VERIFIED vẫn được xem chợ; chỉ bước kích hoạt mới cần chứng minh lại khi thiếu bằng chứng. Email đã xác minh không được thay bằng endpoint bổ sung email của BASIC.
9. Để vừa cho vào chợ ngay vừa không lộ email đã có tài khoản, yêu cầu đăng ký trùng email tạo BASIC độc lập với tên đăng nhập mới; không tạo phiên của chủ email và không gửi OTP kích hoạt cho bản đăng ký trùng. Chỉ email đã xác minh chịu index duy nhất. OTP gắn ID người dùng, nên không lấy mã của tài khoản cũ để kích hoạt bản trùng. Chủ tài khoản cũ nhận thông báo. BASIC có thể đổi sang email khác mà mình sở hữu; email đã xác minh phải đổi theo luồng bảo mật.

## 9. Các điểm cần phân biệt trong bản MD sửa đổi

| Mục trong bản mới | Kết luận đối chiếu |
| --- | --- |
| BASIC → VERIFIED → ACTIVE | Đã đổi cả API, phiên, schema và giao diện. Không còn ép Passkey khi vừa đăng ký. |
| Bỏ hạn mức miễn xác thực cho phiên P | Đã bỏ cơ chế 500.000/1.000.000; tiền rời ví luôn cần G. Bản MD (2)/(3) đã sửa câu nhắc ngưỡng P còn sót. |
| Nạp tiền | Ví phải được kích hoạt lần đầu; sau đó nạp qua PayPal Sandbox không xin G. Quyết toán vẫn từ bằng chứng nhà cung cấp, không từ URL quay lại. |
| Thanh toán/giải ngân | Hộp thoại xác nhận riêng, khóa điều khiển khi bận; G đúng đơn/phiên/ngữ cảnh, một lần, 120 giây. Số tiền từ DB. |
| Quá hạn kiểm tra hàng | Đã thêm worker chuyển sang tranh chấp, không tự trả cho người bán. Mặc định 24 giờ là lựa chọn triển khai, bản MD chưa chốt con số. |
| Rút tiền, tài khoản nhận, chờ 24 giờ | Để sau theo trả lời trực tiếp của người dùng. |
| Giỏ nhiều người bán chỉ chạm một lần | Hệ thống hiện mua từng tin đăng; chưa có giỏ nhiều người bán. Không tự tuyên bố đã có phiếu gộp nhiều đơn. |
| Chat, yêu thích trong mô tả BASIC | Đây là khả năng của mô hình đề xuất; bản sửa auth không tạo hai phân hệ này. BASIC dùng các tính năng hiện có theo quyền tài khoản; tài khoản bán chưa có ví chỉ lưu tin ẩn/nháp. |
| Hủy đơn/hết hạn rồi hoàn tiền | Không coi bảng nguyên tắc ở 11.1 là bằng chứng đã có chức năng hủy/tự hoàn. Luồng hoàn qua phân xử hiện có được giữ; chính sách hủy, hạn chờ người bán và hoàn tự động cần thiết kế riêng trước khi thêm. |
| `SHA-256(nonce || context_hash)` | Vẫn là đề xuất. Bản này dùng challenge WebAuthn chuẩn và lưu/kiểm context ở máy chủ. Không tuyên bố có màn ký số tiền tin cậy của OS. |
| Mã OTP trong log demo | Không áp dụng: mã/token chỉ qua email/outbox mã hóa. Chế độ test dùng transport giả và dữ liệu tạm. |

Tài liệu Resend đã đối chiếu: [gửi email](https://resend.com/docs/api-reference/emails/send-email), [idempotency key](https://resend.com/docs/dashboard/emails/idempotency-keys). Khóa chống gửi lặp phía Resend có cửa sổ 24 giờ; không diễn giải thành bảo đảm gửi đúng một lần vô hạn.

## 10. Đối chiếu bản thiết kế (3): nhiều tài khoản và vòng đời khôi phục

- Đã kiểm tra `excludeCredentials`: trước thay đổi này, luồng thêm khóa đã lọc bằng `WHERE user_id = ?`. Không có truy vấn lấy toàn bộ Passkey trên một thiết bị. Lần tạo khóa đầu dùng danh sách rỗng mặc định của thư viện.
- Gom thông tin tài khoản dùng khi đăng ký Passkey vào `registrationIdentity()` trong `src/lib/accountSecurity.js`. Lần tạo đầu và thêm khóa đều lấy danh sách khóa của đúng tài khoản. Không loại trừ khóa của người khác đang dùng chung thiết bị.
- `user.name` vẫn là username duy nhất. `user.id` vẫn là 32 byte ngẫu nhiên, khác giữa các tài khoản và ổn định khi cùng tài khoản thêm khóa. Máy chủ không dùng tên hiển thị để cấp quyền.
- Tên công khai của hai tài khoản được phép trùng. Nhãn gửi riêng cho trình quản lý Passkey được đổi thành `@username · Tên hiển thị`, ví dụ `@dung01 · Trần Quang Dũng` và `@dung02 · Trần Quang Dũng`. Dùng nhãn thống nhất ở tạo đầu, thêm khóa và khôi phục; không đổi tên công khai trên chợ.
- Khôi phục là luồng thay khóa, nên chủ động dùng danh sách loại trừ rỗng như hành vi trước đó. Chỉ sau khi xác minh khóa mới thành công, máy chủ mới thay các khóa cũ trong transaction. Vẫn kiểm credential ID trùng toàn hệ thống để không gán cùng một credential cho hai tài khoản. Điều này khác với việc cấm hai tài khoản tạo hai khóa riêng trên một máy.
- Không tự sửa nhãn các Passkey cũ đã được Windows Hello/Google Password Manager/iCloud Keychain lưu. Thay đổi nhãn áp dụng cho các lần tạo mới sau khi triển khai. Giao diện và mức cắt ngắn nhãn do trình quản lý Passkey quyết định.
- Đã sửa câu báo lỗi `InvalidStateError` ở giao diện: trước đó nói thiết bị có Passkey của "tài khoản khác", dù danh sách loại trừ đã lọc đúng chủ tài khoản. Nay nêu rõ Passkey của chính tài khoản này đã có trên bộ xác thực được chọn. Không suy ra toàn bộ thiết bị bị cấm tạo khóa cho tài khoản khác.
- Đã đối chiếu và kiểm thử: hết 24 giờ chỉ đổi yêu cầu khôi phục sang READY, tài khoản vẫn RECOVERING. Hủy hoặc quá hạn hoàn tất trả ACTIVE với mật khẩu/khóa cũ. Hoàn tất hợp lệ mới thay khóa/mật khẩu và áp hạn chế 72 giờ.
- Tiếp tục giữ bằng chứng email trong đúng phiên kích hoạt, còn hạn 30 phút. Quá hạn không cấp tùy chọn tạo khóa đầu. Admin hoàn tiền vẫn cần G `ADJUDICATE`; người mua chỉ nhận hoàn tiền không cần tự xác nhận Passkey.

Lượt bổ sung không thay schema, thời gian chờ hoặc cấu hình email. Đã bổ sung các kiểm tra API về hai tài khoản trùng tên, phạm vi excludeCredentials, user handle, metadata khôi phục, bằng chứng email quá hạn và hết cửa sổ hoàn tất. Kết quả lượt chốt được ghi dưới đây; bảng mục 7 ghi kết quả của lượt triển khai trước. Chưa chạy lại PostgreSQL hay thử trình chọn Passkey trên thiết bị thật cho riêng phần nhãn này.

Chuẩn đối chiếu: [W3C — phạm vi excludeCredentials](https://www.w3.org/TR/webauthn-3/#dom-publickeycredentialcreationoptions-excludecredentials) và [thông tin tài khoản WebAuthn](https://www.w3.org/TR/webauthn-3/#dictdef-publickeycredentialuserentity). `user.id` là căn cứ định danh/xác thực; `user.name` và `displayName` là thông tin hiển thị.

Kết quả lượt bản (3): **95 kiểm tra API/WebAuthn trên SQLite tạm PASS**, gồm 15 kiểm tra bổ sung so với lượt 80 trước. Cú pháp các tệp thay đổi và `git diff --check` PASS. Không sửa thời gian chờ, schema hoặc dữ liệu thật; chưa triển khai website.

Hai lần chạy lại bộ kiểm thử UI không hoàn tất trong lượt này và đã được dừng; lượt sau ghi nhận 6 kiểm tra đầu đạt trước khi dừng, không ghi nhận PASS cho toàn bộ lượt UI bản (3). Các số 28/8 tại mục 7 là kết quả lịch sử của lượt trước. Việc nạp riêng dependency UI cũng chưa hoàn tất trước khi dừng; chưa xác định nguyên nhân, không suy ra là lỗi giao diện hoặc kết luận mọi điện thoại đều chạy được.

## 11. Lượt hoàn thiện sau bản sửa đổi, 21/10/2026

Mục này thay các ghi chú đang chờ kiểm thử ở mục 10. Các kết quả tại bảng mục 7 đã cập nhật theo lượt thực sự chạy. Tất cả kiểm thử dùng dữ liệu cô lập; PostgreSQL được tự khởi tạo/dừng riêng trên loopback, không chạm Supabase. SQLite migration đã diễn tập tạo backup nhất quán trước nâng cấp, phục hồi sang tệp khác rồi nâng cấp lại; số dư, ledger, khóa, mã băm và ciphertext được giữ.

Claude CLI đã thực sự tham gia: triển khai frontend trong bản sao được người dùng đồng ý, Codex kiểm diff rồi tích hợp; tiếp đó rà soát độc lập 93 tệp và kiểm lại bản sửa ở snapshot 96 tệp. Claude chỉ đọc mã ở hai lượt review; các kết quả chạy test do Codex thực hiện. Phát hiện refresh hai tab được tái hiện bằng HTTP trước khi sửa, sau sửa đạt trên cả SQLite và PostgreSQL. Lượt kiểm lại không xác nhận thêm P1/P2 trong phạm vi được đọc; đây không phải chứng nhận hệ thống không có lỗi. Nhận xét ban đầu rằng access token nằm trong localStorage là sai và Claude đã rút lại sau khi đối chiếu `setSession`.

Bộ PayPal DOM ban đầu có 2/220 ca chưa đạt vì chờ cố định quá ngắn. Dấu thời gian giả lập: poll CAPTURING 1179 ms; kiểm tra cũ 2643 ms; poll SUCCEEDED 2690 ms; hoàn tất 2723 ms. Chỉ sửa bài test để chờ điều kiện có giới hạn 5 giây, không sửa thanh toán để làm test đạt. Chạy lại đạt 220/220.

Production dependency không đổi phiên bản. Kiểm thử tại Node 26.4.0, jsdom 30.1.2 là devDependency đã khóa. Chỉ công bố các bộ đã chạy trong bảng; không cộng số kiểm tra lặp thành số tình huống độc lập và không lấy báo cáo đóng băng 489 ca làm bằng chứng cho phiên bản này.

### Điều kiện trước khi đưa bản auth lên hệ thống chính

1. Xác minh domain gửi tại Resend; cấu hình API key trong Railway secret store, SPF/DKIM và chính sách DMARC theo DNS thật. Không gửi khóa vào chat hoặc commit. Trạng thái cuối người dùng cung cấp là đang chuẩn bị Resend, chưa có bằng chứng gửi thật.
2. Đặt riêng các khóa HMAC/mail tối thiểu 32 byte; AUTH_PUBLIC_URL cố định HTTPS; giữ khóa cũ khi xoay. Giữ thời gian chính thức, không bật transport test hoặc fault injection trên web công khai.
3. Xác minh topology proxy thực tế trước bật TRUST_PROXY=1. Bộ kiểm đã chứng minh server trực tiếp bỏ X-Forwarded-For giả; chưa chứng minh cấu hình proxy của nhà cung cấp. Cookie production luôn Secure; vẫn cần thử Set-Cookie/refresh/logout trên hai domain thật. Dùng Session pooler khi cấu hình DB dựa trên search_path theo phiên; chưa nghiệm thu Transaction pooler.
4. Chụp backup DB đang dùng bằng công cụ của nhà cung cấp, xác nhận khả năng phục hồi trước migration; không xóa/reset DB. Migration được tiến lên; không tự phục hồi backup cũ sau khi có nghiệp vụ tiền mới phát sinh.
5. Công khai/push mã auth và gộp nhánh sau khi có ủy quyền đúng phạm vi. Đồng ý công khai bản vận chuyển d5d6d27 trước đây không được trình bày thành một lần duyệt mới cho mọi mã auth.
6. Nghiệm thu thật: hộp thư do chủ hệ thống kiểm soát, Windows Hello, Android Chrome và iOS Safari nếu có thiết bị; hủy/hết hạn Passkey, quay lại từ email trên thiết bị khác, tải lại/đổi tài khoản/hai tab. Không yêu cầu người dùng tự xem cấu hình điện thoại để hệ thống giả thành công.

Hiện trạng: mã và các kiểm tra tự động nêu trên hoàn tất tại checkout làm việc; **chưa triển khai bản auth mới, chưa gửi email thật, chưa có bằng chứng sinh trắc học thiết bị thật**. Tài liệu này không tuyên bố toàn bộ Enclave hoàn hảo hoặc bảo đảm không bao giờ xảy ra lỗi.
