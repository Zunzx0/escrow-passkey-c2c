# Frontend — Chợ An Toàn

React + Vite + Tailwind. Giao diện marketplace C2C phủ các luồng chính của backend: duyệt chợ, đăng ký/đăng nhập bằng Passkey, đăng tin, nạp tiền qua nhà cung cấp mô phỏng, mua bán có Escrow, mở tranh chấp và quản trị viên phân xử bằng Passkey.

Thông báo thời gian thực chưa được triển khai trong bản demo.

## Chạy thử

1. Backend phải đang chạy ở `http://localhost:4000` (`npm run dev` trong `backend/`).
2. `npm install` (nếu chưa cài).
3. `npm run dev` → mở `http://localhost:5173`.

Vite dev server đã cấu hình sẵn `proxy: '/api' -> http://localhost:4000` (xem `vite.config.ts`) nên frontend/backend chạy cùng-origin khi dev, tránh vấn đề cookie cross-origin.

## Dữ liệu demo

Chạy `npm run seed` trong `backend/` để có 2 tài khoản người bán demo và 25 tin đăng (điện thoại, laptop, máy ảnh, console...).

Ảnh sản phẩm là **ảnh chụp thật**, tải sẵn về `public/demo/*.jpg` nên không phụ thuộc mạng lúc chạy. Nguồn: [Unsplash](https://unsplash.com/license) (được dùng miễn phí, kể cả mục đích thương mại, không cần ghi nguồn). Mỗi ảnh đã được **mở ra xem và đối chiếu với tên sản phẩm** trước khi gán — không tin vào tên file hay alt text, vì alt text trên Unsplash do người dùng tự đặt và khá thường xuyên sai.

Nếu bạn đổi tiêu đề một tin đăng trong `prisma/seed.ts`, hãy mở lại ảnh tương ứng để kiểm tra: một tin đăng có ảnh khác hẳn tên sản phẩm là thứ làm giao diện trông giống dữ liệu rác nhất.

Seed chạy lại được nhiều lần: nó chỉ xoá những tin đăng demo **chưa có giao dịch nào**, nên món đồ bạn đã mua trong lúc thử sẽ được giữ nguyên.

## Ai xem được gì

- **Không cần đăng nhập**: trang chủ `/`, tìm kiếm, và trang chi tiết tin đăng `/listings/:id` (kèm thông tin công khai của người bán: tên hiển thị, không bao giờ có email).
- **Cần đăng nhập**: mua hàng, đăng tin, ví, giao dịch, quản lý tài khoản. Khách bấm "Mua ngay" sẽ được đưa sang `/login?returnTo=...` rồi quay lại đúng tin đăng đó sau khi đăng nhập.

## Bắt buộc test bằng trình duyệt thật

Passkey (WebAuthn) **không thể** test qua HTTP client (curl/Postman/supertest) — trình duyệt phải tự thực hiện ceremony với authenticator thật (Windows Hello, vân tay, khóa bảo mật...). Vì vậy:

- Toàn bộ phần đăng ký/đăng nhập/chuyển tiền phải test tay trên trình duyệt (Chrome/Edge trên Windows với Windows Hello là dễ nhất).
- `localhost` được trình duyệt coi là secure context đặc biệt nên không cần HTTPS khi dev.

## Luồng demo gợi ý

1. Đăng ký tài khoản A (người bán) → đăng ký Passkey.
2. Đăng tin bán ở tài khoản A.
3. Đăng xuất, đăng ký tài khoản B (người mua) → đăng ký Passkey.
4. Tài khoản B: vào **Ví của tôi** → tạo yêu cầu nạp tiền thử nghiệm. Giao diện gọi nhà cung cấp mô phỏng; số dư chỉ được cộng sau khi callback có chữ ký hợp lệ báo thành công.
5. Tài khoản B: vào tin đăng của A → "Mua ngay" → ở trang giao dịch bấm "Thanh toán".
6. Đăng xuất, đăng nhập lại A → vào giao dịch vừa tạo → "Xác nhận đã tiếp nhận đơn" → "Xác nhận đã gửi hàng".
7. Đăng nhập lại B → "Tôi đã nhận được hàng" → "Xác nhận & chuyển tiền cho người bán" (bắt buộc Passkey với user verification — thao tác nhạy cảm thật, có scoped one-time grant phía sau).
8. Có thể mở tranh chấp ở các trạng thái hợp lệ. Tài khoản quản trị xem hồ sơ tại `/admin/disputes`, chọn hoàn tiền hoặc giải ngân và xác nhận quyết định bằng Passkey.
9. Kiểm tra `npx prisma studio` → `Wallet`, `WalletEntry`, `Dispute`, `PaymentRequest` và `ReauthGrant` có bản ghi tương ứng.

## Cấu trúc

- `src/api/` — lớp gọi API kiểu (`client.ts` là fetch wrapper dùng cookie session, không phải token).
- `src/context/AuthContext.tsx` — trạng thái người dùng hiện tại.
- `src/hooks/usePasskey.ts` — đăng ký, đăng nhập và xác thực lại trước khi giải ngân hoặc phân xử — dùng `@simplewebauthn/browser`.
- `src/pages/HomePage.tsx` — trang chợ: hero ngắn, danh mục, 3 khu vực sản phẩm, tìm kiếm/lọc giá/sắp xếp (đồng bộ vào URL nên chia sẻ được link kết quả).
- `src/pages/TransactionDetailPage.tsx` — trang quan trọng nhất: hiển thị đúng hành động theo vai trò (người mua/người bán của **chính giao dịch đó**) và trạng thái hiện tại, tự ẩn hành động sai vai trò/state. Backend vẫn luôn tự kiểm tra lại, không tin frontend.
- `src/pages/AdminDisputesPage.tsx` và `AdminDisputeDetailPage.tsx` — hàng đợi tranh chấp và luồng phân xử dành riêng cho quản trị viên.
- `src/lib/productIcon.ts` — chọn biểu tượng dự phòng theo tên sản phẩm khi tin đăng chưa có ảnh.
- `src/lib/categories.ts` — danh mục **chỉ để hiển thị**: schema `Listing` chưa có trường danh mục nên các mục này cố ý không bấm được, thay vì giả vờ lọc được.
- `src/router/ProtectedRoute.tsx` — chỉ là tiện ích UX, không phải ranh giới bảo mật.
- `public/demo/` — ảnh sản phẩm mẫu dùng cho dữ liệu seed.

## Thiết kế

Giao diện theo hệ "Light Premium Technology Marketplace": nền trắng, màu thương hiệu `#0EA5E9`, ô tìm kiếm lớn ở header, thanh danh mục, lưới 5 sản phẩm mỗi hàng trên desktop. Nguyên tắc: đây là một cái chợ, phần bảo mật nằm phía sau và chỉ thể hiện bằng cảm giác tin cậy — không giải thích Escrow/Passkey trên giao diện người dùng cuối.
