# Phát hành ảnh sản phẩm và bằng chứng — phạm vi laptop

Hồ sơ chuẩn bị ngày 27/10/2026. Chưa phải biên bản phát hành hoặc nghiệm thu. Mã đơn hàng/tiền và media đang có thay đổi chưa commit; không dùng tên nhánh hay báo cáo của agent để suy ra website đã cập nhật.

## Phạm vi cần giữ

- Người bán chọn JPEG/PNG/WebP cho tin đăng; tối đa 6 ảnh, ảnh đầu là bìa. Tin cũ chưa có ảnh hiển thị đúng là chưa có ảnh.
- Ảnh trong tranh chấp chỉ hai bên và admin đã nhận hồ sơ được xem. Ảnh là nội dung người dùng cung cấp; thời điểm tải lên không chứng minh thời điểm chụp hay tình trạng thật của hàng.
- Quyền tiền, Passkey và chính sách hạn chế sau khôi phục không thay đổi vì thêm ảnh. Ảnh không tự quyết định nhận hàng, hoàn tiền hoặc giải ngân.
- Hoàn hàng vật lý P1, rút tiền và kiểm thử thiết bị mobile thực tế chưa được hoàn thành trong gói này. Không ghi chúng là đã có trong báo cáo.

## Điều kiện trước phát hành

1. Chốt hash nguồn sau khi backend, frontend và tester cùng dừng sửa. Đọc log kiểm thử ảnh/tiền trên đúng nguồn đó; tách SQLite, PostgreSQL, JSDOM và nghiệm thu trình duyệt thật.
2. Xem diff, xác nhận chỉ mã/kiểm thử/hướng dẫn và `.env.example`; loại trừ `.env` thật, khóa, DB, ảnh người dùng, dữ liệu test tạm và log chứa dữ liệu cá nhân.
3. Chuẩn bị và xác nhận bản sao lưu DB có thể phục hồi. Rà số đơn đang mở và các mốc thời hạn trước khi chạy v12/v13; không để việc boot server tự nâng cấp xảy ra trước bước sao lưu.
4. Chuẩn bị kho Supabase Storage **private**, giới hạn loại đầu ra `image/webp` và kích thước không lớn hơn 512 KiB. Không mở public bucket, không thêm policy cho khách xem toàn bộ bucket.
5. Cấu hình tại backend Railway: `MEDIA_STORAGE_URL`, `MEDIA_STORAGE_SERVICE_KEY`, `MEDIA_STORAGE_BUCKET=enclave-media`; khóa chỉ nằm ở máy chủ. Việc tạo quyền mới/lưu khóa phải được duyệt đúng phạm vi. Không đưa khóa vào Vercel, JS, URL, git hoặc chat.
6. Giữ các biến thời hạn mới của đơn hàng và worker. Bản hiện tại hỗ trợ `MEDIA_WORKER_SECONDS` và `MEDIA_MAX_IN_FLIGHT`; không dùng cấu hình kiểm thử trên website thật.
7. Có phê duyệt công khai/phát hành đúng gói thay đổi đang xem xét. Các lần đồng ý trước cho shipping/auth không tự bao phủ mọi gói mã bổ sung.

## Kiểm cấu hình ảnh không làm thay đổi dữ liệu

Trong thư mục `cho-an-tam`, dùng môi trường sẵn có của dịch vụ, không truyền khóa trực tiếp vào dòng lệnh:

```text
node scripts/check-media-storage.js
node scripts/check-media-storage.js --probe
```

Lệnh đầu chỉ kiểm sự hiện diện và hình dạng cấu hình. `--probe` thêm GET có xác thực để xác nhận bucket riêng tư; không tạo bucket, tải ảnh lên hoặc ghi DB. Không in khóa hoặc URL được cấp. Kết quả probe đạt không chứng minh quyền ghi/xóa object hay toàn bộ quy trình upload đã chạy thật.

Thiếu cấu hình phải báo `MEDIA_STORAGE_UNAVAILABLE`; không chuyển sang lưu filesystem tạm của Railway hoặc dùng bộ nhớ làm kho thật. Các luồng không cần ảnh vẫn phải hoạt động. Không nghiệm thu tính năng ảnh trên website khi còn lỗi này.

## Trình tự phát hành

1. Backend và migration tương thích trước; cấu hình kho riêng tư được kiểm tra. Container đang dùng Node 24 bookworm; cần xác nhận build Linux thực tế tải và nạp được Sharp, không suy từ encode thành công trên Windows.
2. Kiểm health, phiên, quyền và worker; health HTTP 200 chỉ là điều kiện vận hành ban đầu.
3. Frontend sau backend; CSP chỉ bổ sung `blob:` cho ảnh. Kết nối API tiếp tục giới hạn origin đã cấu hình, không mở wildcard để chữa lỗi ảnh.
4. Nghiệm thu trên laptop của phạm vi báo cáo. Ghi rõ hệ điều hành, trình duyệt, phiên bản triển khai và ngày thử. Ảnh kết quả phải là màn thực tế, không dùng giao diện API giả làm minh chứng nghiệp vụ thật.

## Các thao tác nghiệm thu laptop

- Tin đăng: chọn nhiều ảnh, đổi ảnh bìa, bỏ ảnh trước gửi, lưu/sửa tin và giá khi chưa có đơn; quay lại vẫn còn đúng gallery. Tin mẫu chưa có ảnh không bị gán ảnh giả.
- Upload: sai loại, quá lớn, ảnh hỏng; lỗi mạng và thử lại; đóng hoặc bấm lặp lúc đang tải/lưu; phản hồi cũ sau chuyển trang không đóng nhầm cửa sổ mới.
- Quyền xem: khách xem được ảnh tin PUBLIC; không xem được ảnh tin ẩn hoặc bằng chứng. Hai bên trong đơn xem được ảnh snapshot; admin chưa nhận hồ sơ không đọc được bằng chứng.
- Giữ nội dung: khóa tiền lưu snapshot ảnh; việc sửa hoặc mở bán lại tin sau này không thay ảnh của đơn cũ. Thêm bằng chứng không đổi số dư hay tự biến hồ sơ SYSTEM thành khiếu nại.
- Tiền và Passkey: xác nhận nhận kiện, đã kiểm, giải ngân là ba hành động riêng; hủy Passkey không chuyển tiền; retry không chuyển hai lần. Quyết định admin có nội dung cũ phải bị từ chối khi bằng chứng đổi.
- PayPal Sandbox vẫn là cổng nạp đang có; VNPAY mới là câu hỏi ước lượng, chưa là lệnh thay cổng. Không thay nhà cung cấp thanh toán trong gói media.

## Phục hồi và kết quả

Sau khi đã ghi trạng thái đơn mới hoặc tham chiếu ảnh/snapshot, không chỉ chạy lại mã cũ để rollback. Ưu tiên sửa tiến; nếu phục hồi toàn bộ thì phải ghép bản DB, kho ảnh và bản mã tương ứng, có kế hoạch cho mọi thay đổi hợp lệ sau thời điểm sao lưu. Không xóa lịch sử sổ cái để ép hệ thống chạy.

Chỉ đánh dấu hoàn tất từng phần khi có kết quả quan sát được. Bộ test dùng ảnh tổng hợp và kho ảnh giả riêng kiểm logic; nó không chứng nhận cấu hình Supabase thật, Windows Hello thật, email thật hoặc PayPal thật.
