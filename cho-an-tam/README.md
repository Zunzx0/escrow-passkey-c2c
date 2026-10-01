# Chợ An Tâm — Sàn mua bán C2C (Escrow + Passkeys)

Website mô phỏng một **sàn thương mại điện tử C2C**, nơi cá nhân đăng bán đồ đã qua sử dụng và cá
nhân khác đặt mua, trong đó:

- Tiền của người mua **không chuyển thẳng** cho người bán mà do **ví trung gian Escrow** giữ hộ,
  chỉ giải ngân sau khi người mua xác nhận đã nhận hàng hoặc khi có quyết định phân xử.
- Xác thực theo **mô hình lai**: đăng nhập bằng mật khẩu hoặc Passkey đều được, nhưng **mọi thao
  tác làm tiền rời ký quỹ** (giải ngân, phân xử) và **mọi thay đổi thông tin xác thực** (thêm/xoá
  passkey, đổi mật khẩu) bắt buộc **xác thực lại bằng Passkey** — xem mục 4.
- Mọi thay đổi trạng thái giao dịch được ghi vào **chuỗi băm có đánh số thứ tự**, phát hiện được
  nếu ai đó sửa, chèn hay xoá lén một bản ghi nhật ký trong database.

Chạy bằng **một server Node.js duy nhất** + **SQLite** (chỉ là 1 file, không cần cài database riêng).
Giao diện là HTML/CSS/JS thuần — **không cần build, không có thư viện JS ngoài, không CDN, không
webfont** (dùng font hệ thống), nên chạy được hoàn toàn offline.

> Tên "Chợ An Tâm" là tên tạm cho đồ án; đổi tên chỉ cần sửa `public/index.html` và vài chuỗi
> trong `public/js/app.js`.

### Giao diện tham khảo các chợ lớn theo từng phần

Không bê nguyên một chợ làm mẫu; mỗi phần học từ nơi làm tốt nhất phần đó:

| Phần | Tham khảo | Ở đâu trong ứng dụng |
|---|---|---|
| Trang chủ, danh mục, thẻ sản phẩm, tìm kiếm/lọc | Shopee, Lazada | `#/` |
| Chi tiết tin, thông tin người bán, quản lý tin | Chợ Tốt | `#/listing/:id`, `#/shop` |
| Lịch sử mua / đơn đã bán, trạng thái đơn, tranh chấp | eBay | `#/orders` |
| Chi tiết giao dịch: dòng thời gian 6 bước, tiền ký quỹ, hành động hiện tại, chuỗi nhật ký | thiết kế riêng | `#/tx/:id` |
| Ví & nạp tiền qua cổng thanh toán mô phỏng | thiết kế riêng | `#/wallet` |

Sản phẩm chưa có chức năng tải ảnh lên, nên thẻ sản phẩm hiện ô giữ chỗ theo ngành hàng (icon), như
cách các chợ hiển thị tin chưa có ảnh.

### Mỗi tin đăng là một sản phẩm đơn chiếc

Bảng `listings` không có cột số lượng, đúng với đặc điểm hàng hoá C2C: đồ đã qua sử dụng, hàng
sưu tầm, vật dụng cá nhân. Hệ quả là **bán xong thì sản phẩm rời sàn vĩnh viễn**:

```
Tin đăng mở bán ──► người mua đặt đơn (chưa giữ chỗ)
                        │
              khoá tiền vào Escrow ──► tin đăng ngừng nhận đơn mới
                        │
        giải ngân hoặc phân xử giải ngân ──► đã bán, không quay lại sàn
                        │
                 phân xử hoàn tiền ──► giao dịch coi như chưa xảy ra, tin đăng mở bán lại
```

Chỉ trạng thái `REFUNDED` mới trả sản phẩm về trạng thái bán được. Ai khoá tiền trước thì giữ
sản phẩm — đây cũng là một tình huống kiểm thử tranh đua trong `test/market-e2e.js`.

---

## 1. Cài đặt (chỉ làm 1 lần)

### Bước 1: Cài Node.js
Nếu máy chưa có: tải bản LTS tại https://nodejs.org (bấm nút "LTS" màu xanh), cài như phần mềm
bình thường. Kiểm tra bằng cách mở **PowerShell** (Windows) hoặc **Terminal** (macOS) rồi gõ:
```
node -v
```
Ra một dòng như `v20.x.x` trở lên là được.

### Bước 2: Mở Terminal/PowerShell tại thư mục `escrow-app`
- Windows: mở thư mục `escrow-app` trong File Explorer, gõ `cmd` vào thanh địa chỉ rồi Enter.
- macOS: chuột phải vào thư mục → "New Terminal at Folder".

### Bước 3: Cài thư viện
```
npm install
```

### Bước 4: Tạo file cấu hình `.env`
Copy `.env.example` thành `.env`:
- Windows (PowerShell): `copy .env.example .env`
- macOS/Linux: `cp .env.example .env`

Sau đó **sửa 1 giá trị** trong `.env`:

1. `JWT_SECRET` — sinh chuỗi ngẫu nhiên bằng:
   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

Không có biến môi trường nào cấp quyền. Đăng ký luôn tạo tài khoản Người mua; quyền bán đi
qua quy trình xin và duyệt, còn quản trị viên đầu tiên được tạo bằng `npm run seed:admin`
(xem mục 4).

---

## 2. Chạy ứng dụng

```
npm start
```

Thấy dòng `Chợ An Tâm — sàn mua bán C2C … đang chạy tại: http://localhost:3000` là thành công.
**Để cửa sổ Terminal này mở** (đóng lại là server tắt).

Mở trình duyệt (Chrome/Edge khuyến nghị) tại đúng địa chỉ:
```
http://localhost:3000
```
⚠️ **Không** dùng `127.0.0.1:3000` — Passkeys sẽ không hoạt động nếu địa chỉ không khớp
`WEBAUTHN_ORIGIN` trong `.env`.

### Ba môi trường tách biệt

| Môi trường | Lệnh | Cổng | Cơ sở dữ liệu | Dùng cho |
|---|---|---|---|---|
| dev | `npm start` | 3000 | `data/escrow.db` | phát triển, thử tay |
| test | `npm run start:test` / `npm run test:suite` | 3100 | `data/test/escrow.db` | kiểm thử tự động, stress, chèn lỗi |
| experiment | `npm run start:experiment` | 3200 | `data/experiment/escrow.db` | thu kết quả Chương 3, buổi bảo vệ |

Ba môi trường khác cổng và khác file cơ sở dữ liệu (`.env.test`, `.env.experiment` — không commit),
nên bộ test không thể vô tình ghi vào cơ sở dữ liệu thực nghiệm. Máy chủ ở môi trường experiment
**từ chối khởi động** nếu `FAULT_INJECT` đang bật, và tự kiểm mã có đúng bản đã đóng băng không
(mục 11). Mỗi môi trường có kho trạng thái Mock Provider riêng (`<tên DB>.mock-provider.db`).

---

## 3. Kịch bản demo (khoảng 5 phút)

Cần **2 cửa sổ trình duyệt tách biệt** (một cửa sổ thường + một cửa sổ ẩn danh, hoặc 2 profile
Chrome khác nhau) để hai vai không lẫn phiên đăng nhập.

### A. Mở cửa hàng (cửa sổ 1 — Người bán)
1. Bấm **Đăng ký** ở góc phải header. Nhập tên đăng nhập `shop01`, tên hiển thị và mật khẩu, rồi
   **Gắn Passkey** (trình duyệt hỏi Windows Hello/Touch ID). Tài khoản tạo ra là **Người mua** —
   đây là vai trò duy nhất mà đăng ký cấp.
2. Bấm **Đăng bán** trên header → gửi yêu cầu mở cửa hàng.
3. Cần một quản trị viên duyệt. Nếu chưa có ai, xem mục 4 để tạo quản trị viên đầu tiên bằng
   `npm run seed:admin`, rồi vào **Quản trị → Yêu cầu mở cửa hàng** và duyệt.
4. Quay lại cửa sổ 1, tải lại trang. Vào **Tin đăng của tôi** → bấm **Nhập 8 tin mẫu** (iPhone,
   MacBook, tai nghe, máy ảnh…) hoặc **Đăng tin mới** để tự nhập.

### B. Mua sản phẩm (cửa sổ 2 — Người mua)
5. Đăng ký tài khoản `mua01` → được cấp vai trò Người mua kèm 5.000.000₫ số dư demo. Tin mẫu có
   giá thật (vài triệu đồng), nên có thể cần **nạp thêm tiền** ở bước G trước.
6. Ở trang chủ, chọn danh mục hoặc tìm kiếm, bấm vào một tin → **Mua ngay** → **Thanh toán vào ký
   quỹ**. Trang chuyển tới **chi tiết giao dịch**: tiền ký quỹ "Đang được giữ an toàn", dòng thời
   gian ở bước "Người bán xác nhận đơn".

### C. Xác nhận đơn & giao hàng (cửa sổ 1 — Người bán)
7. Vào **Giao dịch → Đơn bán**. Bấm **Xác nhận đơn hàng**, rồi sau khi gửi hàng bấm **Xác nhận đã
   giao hàng**. Người bán không tự đánh dấu "người mua đã nhận" được (máy chủ trả 403).

### D. Nhận hàng & giải ngân (cửa sổ 2 — Người mua)
8. Mở giao dịch → **Xác nhận đã nhận hàng**, kiểm hàng, rồi **Xác thực Passkey & giải ngân**.
   👉 **Đây là điểm nhấn của đồ án**: dù đang đăng nhập, hệ thống vẫn bắt **xác thực Passkey một
   lần nữa** trước khi tiền rời khỏi Escrow (cơ chế *re-authentication*).
9. Toàn bộ số tiền chuyển cho người bán; dòng thời gian chuyển sang "Hoàn tất". Kiểm chứng ở trang
   **Ví & nạp tiền** của cả hai bên.

### E. Tranh chấp (tuỳ chọn)
10. Ở bước 8, thay vì giải ngân, bấm **Mở tranh chấp** (người bán có nút **Báo sự cố** tương tự) —
    tiền lập tức bị **đóng băng**, không bên nào rút được.
11. Đăng nhập bằng tài khoản quản trị (xem mục 4) → **Tranh chấp** để hoàn tiền cho người mua hoặc
    chuyển toàn bộ cho người bán (cũng phải xác thực lại bằng Passkey).

### F. Hash Chain (tuỳ chọn)
12. Ở trang chi tiết giao dịch, khối **Bảo mật của giao dịch** có nút **Kiểm chứng chuỗi nhật ký**
    (kết quả "Chuỗi nhật ký hợp lệ") và **Xem mã băm** để xem từng bản ghi prev/curr.

### G. Nạp tiền qua cổng thanh toán mô phỏng (tuỳ chọn)
13. Vào **Ví & nạp tiền**, chọn số tiền và phương thức (thẻ / ví điện tử / chuyển khoản — cả ba đều
    **mô phỏng**, đi qua cùng một cổng), bấm **Tiếp tục thanh toán**. Hộp thoại mở ra là **trang của
    cổng thanh toán** (không phải của sàn). Chọn:
    - **Thanh toán thành công** — cổng gửi webhook đã ký về máy chủ, số dư tăng sau vài giây;
    - **Thanh toán thất bại** — ví không đổi;
    - **Thành công, webhook thất lạc** — ví CHƯA đổi, yêu cầu vẫn "Đang xử lý"; worker đối soát chạy
      mỗi 60 giây sẽ phát hiện và cộng tiền (cột "Kết quả" ghi *qua đối soát tự động*).
    Giao diện không bao giờ tự cộng số dư trước khi máy chủ xác nhận `SUCCEEDED`.

### H. Thông báo & việc cần làm
14. Biểu tượng chuông trên header hiện số thông báo chưa đọc (tự cập nhật mỗi 20 giây). Trang
    **Thông báo & việc cần làm** liệt kê việc đang chờ bạn — tính thẳng từ trạng thái giao dịch,
    nên kể cả khi một thông báo bị mất, việc cần làm vẫn hiện đúng.

---

## 4. Luồng đăng ký & phân quyền

### Mô hình xác thực LAI

Hệ thống **không** dùng Passkey làm phương thức đăng nhập duy nhất. Thiết kế phân biệt hai
mức quyền khác nhau:

| Mức | Nội dung | Chấp nhận |
|---|---|---|
| 1 | Mở một phiên làm việc, dùng các chức năng thông thường | mật khẩu **hoặc** Passkey |
| 2 | Phê duyệt thao tác **làm tiền rời khỏi ký quỹ**, hoặc thay đổi thông tin xác thực | **chỉ** Passkey, qua bước xác thực lại |

Mức 1 **không** đồng nghĩa với "không chạm tới tiền": một phiên hợp lệ vẫn tạo được đơn và
vẫn **khoá được tiền vào ký quỹ**. Ranh giới nằm ở **chiều tiền đi ra**. Cụ thể, một mã phiên
bị đánh cắp vẫn làm được mọi thao tác trong phạm vi phiên, nhưng **không** đưa được tiền ra
khỏi ký quỹ, **không** thêm được credential và **không** đổi được mật khẩu.

Để mức 2 luôn khả dụng, **đăng ký Passkey là bước bắt buộc** để hoàn tất tài khoản — không
tồn tại tài khoản đang hoạt động nào chỉ có mật khẩu. Đây là điểm phân biệt với cách bổ sung
Passkey như một tuỳ chọn đặt cạnh mật khẩu; ở cách đó, lối mật khẩu vẫn phê duyệt được giao
dịch nên mức bảo đảm chung hạ xuống bằng mức của lối yếu nhất.

### Đăng ký gồm hai bước

```
  Bước 1                          Bước 2
  tên đăng nhập + mật khẩu  ───►  đăng ký Passkey (bắt buộc, UV = required)
  account_status =                account_status = ACTIVE
    PENDING_PASSKEY               ví được mở, dùng được chức năng giao dịch
  chưa có ví
  mọi tuyến nghiệp vụ trả 403
```

Credential đầu tiên chỉ được ghi nhận sau khi bộ xác thực **đã thực hiện xác minh người dùng
cục bộ** và đặt cờ tương ứng trong phản hồi. Việc ghi credential, mở ví và kích hoạt tài khoản
nằm trong **cùng một giao dịch cơ sở dữ liệu**, nên không có khoảnh khắc nào tài khoản đã hoạt
động mà chưa có Passkey — đó chính là bất biến số 8.

**Đăng ký thường luôn tạo tài khoản Người mua.** Không có chỗ chọn vai trò, vì vai trò không
phải thứ người dùng tự khai.

Muốn thành **Người bán** thì vào mục **Mở cửa hàng** ở trang chủ và gửi yêu cầu:

```
Người mua          gửi yêu cầu        Quản trị viên          tài khoản CŨ
đăng ký bình  ───►  ở trang chủ  ───►  duyệt ở Bảng    ───►  được nâng lên
thường (BUYER)      (PENDING)          quản trị              Người bán
```

Duyệt xong thì **chính tài khoản đang dùng** đổi vai trò — không tạo tài khoản thứ hai. Ví,
passkey và toàn bộ đơn người đó từng đi mua giữ nguyên; các đơn cũ nằm ở tab **Đơn tôi đi
mua** trong Cửa hàng. Bị từ chối thì lý do hiện ngay ở trang chủ và gửi lại được.

Vì `src/lib/auth.js` đọc lại `role` từ database ở mỗi request thay vì tin trường `role` trong
JWT, quyền mới có hiệu lực **ngay lập tức** — người vừa được duyệt không phải đăng nhập lại
hay chờ token 15 phút hết hạn.

### Chỉ có một đường cấp quyền bán

| Cách đăng ký | Vai trò nhận được |
|---|---|
| Đăng ký thường (đường duy nhất) | 🙋 **Người mua** |
| Người mua gửi yêu cầu ở dải "Mở cửa hàng" → admin duyệt | 🏠 **Người bán** |
| `npm run seed:admin` chạy trên máy chủ | 🛡️ **Quản trị viên** |

Luồng đăng ký **không nhận bất kỳ tham số nào ảnh hưởng tới quyền**. Gửi kèm `role` hay bất cứ
trường nào khác đều bị bỏ qua, vì máy chủ không đọc tới. Nhờ vậy không tồn tại lỗi nâng quyền
tại điểm đăng ký, thay vì phải chặn nó bằng các phép kiểm bổ sung.

### Tạo quản trị viên đầu tiên (ngoại lệ bootstrap)

Quy tắc chung đòi một credential **đang có** để thêm credential mới và để đổi mật khẩu. Tài
khoản quản trị viên đầu tiên được tạo bằng thủ tục vận hành trên máy chủ, và lúc đó chưa có
credential nào — nếu để nguyên, quy tắc sẽ tự chặn chính bước thiết lập quản trị viên.

Thủ tục vì vậy gồm **ba chặng**, và tài khoản chỉ dùng được sau khi cả ba hoàn tất:

```
1. trên máy chủ     npm run seed:admin -- --username=admin01
                    -> tài khoản ADMIN, account_status = PENDING_BOOTSTRAP, kèm MẬT KHẨU TẠM

2. trên trình duyệt đăng nhập bằng mật khẩu tạm -> phiên có phạm vi hạn chế
                    đổi mật khẩu tạm            -> PENDING_PASSKEY

3. trên trình duyệt đăng ký Passkey đầu tiên    -> ACTIVE, mới gọi được chức năng quản trị
```

Trước khi xong cả ba chặng, mọi tuyến quản trị đều trả **403**. Không nhảy cóc được: xin đăng
ký Passkey khi chưa đổi mật khẩu tạm trả **409**. Hai thao tác ở chặng 2 và 3 không đi qua cơ
chế xác thực lại vì lúc đó chưa có credential nào để xác thực lại; ngay sau chặng 3, mọi thay
đổi credential và mọi lần đổi mật khẩu đều theo đúng quy tắc chung như mọi tài khoản khác.

Quản trị viên **không có ví**, vì không phải một bên của giao dịch.

> 🔒 Không có **điểm cuối HTTP** nào cấp được quyền quản trị. Muốn thêm admin thì phải có
> quyền chạy lệnh trên máy chủ — cùng mức quyền với người có thể sửa thẳng cơ sở dữ liệu.

### Đăng nhập — hai lối, một loại phiên

| Lối | Cần nhập | Mức xác minh người dùng |
|---|---|---|
| Passkey | không cần gì (discoverable credential) | `preferred` |
| Mật khẩu | tên đăng nhập + mật khẩu | không áp dụng |

Lối Passkey không cần ô username: trình duyệt tự liệt kê các passkey của trang này, nên máy
chủ không phải tiết lộ tài khoản nào tồn tại trước khi người dùng chứng minh được quyền sở hữu.
Cũng **không có chỗ chọn vai trò** — vai trò đọc từ chính tài khoản, giao diện tự đổi theo.

Lối mật khẩu có bốn biện pháp chống dò cùng lúc: hàm dẫn xuất khoá chậm **scrypt** có muối
riêng cho từng tài khoản, giới hạn tần suất, **thông báo lỗi đồng nhất** cho cả trường hợp sai
tên đăng nhập lẫn sai mật khẩu (kèm một lần dẫn xuất giả để thời gian phản hồi không tố cáo
tài khoản nào có thật), và quan trọng nhất: đoán trúng cũng chỉ được một **phiên**.

Hai lối cấp **cùng một loại phiên**. Phiên tạo bằng Passkey cũng không được coi là đủ để giải
ngân — quyền đó chỉ đến từ phiếu uỷ quyền của một lần xác thực lại.

### Bốn thao tác nhạy cảm đòi xác thực lại

| Thao tác | Hành động của phiếu | Phiếu ràng buộc thêm |
|---|---|---|
| Người mua xác nhận hàng đúng mô tả và giải ngân | `RELEASE_ESCROW` | đúng một giao dịch + ngữ cảnh |
| Quản trị viên phân xử tranh chấp | `ADJUDICATE` | giao dịch + hồ sơ tranh chấp + **quyết định** |
| Thêm hoặc xoá Passkey | `MANAGE_CREDENTIAL` | — |
| Đổi mật khẩu | `CHANGE_PASSWORD` | — |

Cột **quyết định** của phiếu phân xử là thứ chặn kịch bản: quản trị viên xác thực trong lúc màn
hình hiển thị "hoàn tiền cho người mua", còn yêu cầu gửi lên lại mang "giải ngân cho người bán".
Thiếu nó thì lần xác thực lại chỉ chứng minh quản trị viên *có mặt*, không chứng minh đã *chấp
thuận* điều gì. Một phiếu cấp cho `REFUND` dùng cho `/release` sẽ bị từ chối **401**.

Đổi mật khẩu hỏi **Passkey chứ không hỏi mật khẩu cũ**: mật khẩu cũ là thứ kẻ chiếm được phiên
có thể đã biết, credential thì không. Sau khi đổi, `token_version` tăng lên nên **mọi phiên
đang mở khác — kể cả phiên kẻ tấn công đang cầm — mất hiệu lực ngay**.

> **Vì sao không cấp quyền ngay lúc đăng ký?** Một cơ chế cấp quyền đặt ở form đăng ký là một
> bề mặt tấn công nằm ngay trước cửa, ai cũng chạm tới được. Tách hẳn ra thì mỗi quyền chỉ còn
> đúng một lối vào: quyền bán qua bước duyệt của con người, quyền quản trị qua quyền truy cập
> máy chủ. Việc kiểm soát và việc kiểm thử vì vậy cũng quy về một chỗ.

---

## 5. Dòng tiền — quy ước quan trọng

Một giao dịch giữ trong Escrow **đúng một khoản**, bằng giá bán của tin đăng:

```
transactions.amount = listings.price
```

Không có số tiền, không có kỳ mua, nên mỗi nghiệp vụ chỉ có **một dòng tiền**:

| Nghiệp vụ | Ví người mua | Ví Escrow | Ví người bán |
|---|---|---|---|
| Khoá tiền | khả dụng −amount | bị khoá +amount | không đổi |
| Giải ngân (`COMPLETED`) | không đổi | bị khoá −amount | khả dụng +amount |
| Phân xử giải ngân (`RELEASED`) | không đổi | bị khoá −amount | khả dụng +amount |
| Phân xử hoàn tiền (`REFUNDED`) | khả dụng +amount | bị khoá −amount | không đổi |
| Đóng băng (`DISPUTED`) | không đổi | không đổi | không đổi |

Ở mỗi dòng, **tổng biến động bằng không** — tiền không tự sinh và không tự mất, chỉ chuyển vị
trí, và mọi lần chuyển đều để lại bút toán ở cả hai đầu.

> **Ghi chú:** `COMPLETED` và `RELEASED` cùng đưa tiền tới người bán nhưng được tách làm hai
> trạng thái, vì trạng thái tự nó lưu lại **căn cứ** giải ngân: theo ý chí của người mua, hay
> theo quyết định phân xử. Khi đối soát về sau chỉ cần nhìn trạng thái là biết.

---

## 6. Trạng thái giao dịch

Mọi lệnh chạm tới tiền đều kiểm **cặp** `status` + `escrow_status`, không chỉ kiểm một giá trị:

| Trạng thái DB | Escrow | Hiển thị trên UI | Ý nghĩa |
|---|---|---|---|
| `CREATED` | `NONE` | Chờ thanh toán | người mua đã đặt hàng, chưa nộp tiền |
| `SECURED` | `LOCKED` | Đã giữ tiền · chờ giao | tiền đã nằm trong Escrow |
| `SHIPPING` | `LOCKED` | Đang giao hàng | người bán đã gửi hàng |
| `WAIT_CONFIRM` | `LOCKED` | Đã giao · chờ xác nhận | chờ người mua kiểm hàng |
| `COMPLETED` | `RELEASED` | Hoàn tất | người mua xác nhận, tiền sang người bán |
| `DISPUTED` | `FROZEN` | Đang tranh chấp | tiền bị đóng băng |
| `RELEASED` | `RELEASED` | Admin đã giải ngân | phân xử cho người bán |
| `REFUNDED` | `REFUNDED` | Đã hoàn tiền người mua | phân xử cho người mua |

Nhánh huỷ đơn trước khi giao (`SECURED` → `REFUNDED`) nằm **ngoài phạm vi** bản hiện thực này:
nó đòi một chính sách xác định ai được huỷ và trong thời hạn nào, mà chính sách đó thuộc nghiệp
vụ chứ không thuộc cơ chế ký quỹ đang nghiên cứu.

---

## 7. Cấu trúc project

```
escrow-app/
├── src/
│   ├── server.js             # Khởi động, mount routes
│   ├── db.js                 # Kết nối SQLite, migration, seed Admin + ví SYSTEM_ESCROW
│   ├── schema.sql            # Schema (users, wallets, listings, transactions, …)
│   ├── lib/
│   │   ├── auth.js           # JWT, requireAuth / optionalAuth / requireRole
│   │   ├── hash.js           # Hash Chain: append + verify
│   │   ├── walletOps.js      # Optimistic locking, bút toán ví, idempotency
│   │   ├── catalog.js        # Danh mục sản phẩm, trạng thái giữ chỗ tin đăng
│   │   ├── reauth.js         # Phiếu uỷ quyền: cấp, tra, tiêu thụ
│   │   ├── rateLimit.js      # Giới hạn tần suất cho endpoint Passkeys
│   │   ├── invariants.js     # 9 bất biến — nguồn duy nhất (số thứ tự, tên, phát biểu, truy vấn)
│   │   ├── mockPaymentProvider.js  # PHÍA PROVIDER mô phỏng: kho trạng thái riêng, ký/xác minh HMAC, truy vấn trạng thái
│   │   ├── paymentService.js # applyProviderResult — đường DUY NHẤT tất toán nạp tiền (webhook + worker dùng chung)
│   │   ├── reconciler.js     # Worker đối soát: hỏi provider về yêu cầu còn PENDING
│   │   ├── credentialCounter.js  # signCount là tín hiệu rủi ro, không phải điều kiện cứng
│   │   ├── maintenance.js    # Dọn challenge hết hạn/đã dùng (không tham gia quyết định an toàn)
│   │   ├── backgroundJobs.js # Chạy worker đối soát + dọn challenge định kỳ trong máy chủ
│   │   ├── notifications.js  # Thông báo (phản ánh trạng thái) + "Việc cần xử lý" (tính từ trạng thái)
│   │   ├── freeze.js         # Băm mã nguồn để đóng băng / kiểm lại phiên bản thực nghiệm
│   │   └── errors.js
│   └── routes/
│       ├── passkeys.js       # Đăng ký / đăng nhập WebAuthn — chung cho mọi vai trò
│       ├── users.js          # Hồ sơ cá nhân + hồ sơ công khai + xin quyền bán hàng
│       ├── listings.js       # CRUD tin đăng bán (lớp marketplace)
│       ├── transactions.js   # Giao dịch: đặt → khoá tiền → giao → giải ngân → tranh chấp
│       ├── wallets.js        # Số dư + sổ cái
│       ├── payments.js       # Nạp tiền: tạo yêu cầu PENDING, webhook đã ký
│       ├── notifications.js  # Thông báo, đánh dấu đã đọc, việc cần xử lý
│       ├── mockProvider.js   # "Trang thanh toán" của provider mô phỏng (/mock-provider/*, ngoài /api)
│       └── admin.js          # Tranh chấp, duyệt quyền bán hàng, người dùng
├── public/                   # Giao diện SPA (HTML/CSS/JS thuần)
│   ├── index.html            # Khung: header chợ (logo, tìm kiếm, Đăng bán, Giao dịch, tài khoản), footer
│   ├── css/
│   │   └── style.css         # Toàn bộ giao diện: token màu/khoảng cách + component, tự chứa
│   └── js/
│       ├── icons.js          # Icon Lucide nội tuyến (không CDN)
│       ├── simplewebauthn-browser.js
│       └── app.js            # Router + gọi API + render
├── scripts/
│   ├── run-suite.js          # Vòng kiểm thử đầy đủ trên môi trường test (npm run test:suite)
│   ├── reconcile.js          # Chạy một lượt đối soát như process riêng
│   ├── cleanup-challenges.js # Chạy một lượt dọn challenge
│   ├── check-invariants.js   # Kiểm 9 bất biến
│   ├── freeze-experiment.js  # Đóng băng / kiểm lại phiên bản thực nghiệm
│   └── seed-admin.js · seed-experiment.js · reset-db.js
├── test/
│   ├── e2e.js                # Test lõi escrow
│   ├── market-e2e.js         # Test lớp mua bán: đăng bán, đặt mua, giao, giải ngân, tranh chấp, LOCK đồng thời
│   ├── security-e2e.js       # Test 12 nhóm mối đe doạ ở mục 2.3 của báo cáo
│   ├── payment-e2e.js        # Mock Provider: 8 kịch bản webhook
│   ├── reconcile-e2e.js      # Worker đối soát: đua với webhook, 2 worker song song, provider lỗi, process chết
│   ├── counter-e2e.js        # signCount: 0→0, 0→N, N→N+1, N→N, N→N-1, N→0, lối xác thực lại
│   ├── cleanup-e2e.js        # Dọn challenge đúng loại, không đụng quyết định an toàn
│   ├── notification-e2e.js   # Thông báo, việc cần xử lý, phân quyền đọc, bảng thông báo hỏng
│   ├── checkout-e2e.js       # Các lối mà giao diện dùng: cổng thanh toán, chi tiết đơn
│   ├── invariants-unit.js    # Chứng minh từng phép kiểm bất biến bắt đúng vi phạm (không cần máy chủ)
│   ├── seed-demo.js          # Dựng sẵn một người bán + 8 tin đăng để xem giao diện
│   └── softwareAuthenticator.js  # Passkey giả lập cho test tự động (điều khiển được signCount)
├── reports/                  # Báo cáo các vòng test:suite (không commit)
├── EXPERIMENT_FREEZE.json    # Manifest đóng băng phiên bản thực nghiệm
└── data/                     # escrow.db (dev) · test/ · experiment/ — tự tạo khi chạy lần đầu
```

---

## 8. Chạy test tự động

**Cách chính — một lệnh cho toàn bộ vòng kiểm thử (hardening):**

```
npm run test:suite
```

Lệnh này tự dựng máy chủ ở môi trường **test** (cổng 3100, `data/test/escrow.db` tạo mới từ trống),
chạy lần lượt mọi bộ dưới đây, khởi động lại máy chủ với `FAULT_INJECT` để chạy bộ rollback, kiểm
9 bất biến trên cơ sở dữ liệu sau cùng, rồi ghi `reports/suite-<mốc thời gian>/summary.md` cùng đầu
ra nguyên văn của từng bộ — dùng trực tiếp làm minh chứng cho Chương 3. Nó từ chối chạy nếu không ở
môi trường test hoặc nếu `DB_PATH` không nằm trong `data/test/`.

Chạy lẻ từng bộ trên máy chủ dev (Node ≥ 18 đã có `fetch` sẵn). Mở **một cửa sổ Terminal MỚI**
trong khi server vẫn đang chạy:

```
npm run test:core      # Lõi escrow: idempotency, optimistic locking, re-auth, hash chain
npm run test:market    # Lớp mua bán: đăng bán, đặt mua, chống mua trùng, tranh chấp
npm run test:security  # 12 nhóm mối đe doạ: phát lại, sửa số tiền, dùng lại phiếu, sửa nhật ký
npm run test:hybrid    # Mô hình lai + các "đường vòng"
npm run test:hardening # Lớp bảo vệ web: security headers, rate limit, nhật ký sự kiện
npm run test:payment   # Mock Payment Provider: 8 kịch bản webhook (thành công, thất bại, giả, lặp, trái thứ tự…)
npm run test:reconcile # Worker đối soát: đua với webhook, hai worker song song, provider lỗi, process chết giữa chừng
npm run test:counter   # signCount của Passkey là tín hiệu rủi ro, không phải điều kiện cứng
npm run test:cleanup   # Dọn challenge hết hạn/đã dùng mà không đụng tới quyết định an toàn
npm run test:invariants # KHÔNG cần máy chủ: chứng minh từng phép kiểm trong 9 bất biến bắt đúng vi phạm của nó
npm run test:all       # Chạy lần lượt các bộ không cần cấu hình đặc biệt
```

Hai bộ chạy riêng vì cần cấu hình đặc biệt:

```
# Rollback — máy chủ phải bật chèn lỗi có chủ đích
$env:FAULT_INJECT="release:after-wallet-update"; npm start
node test/rollback-e2e.js          # rồi TẮT biến này đi

# Hardening — cần trần giới hạn tần suất đủ thấp để chạm được trong vài giây
$env:RATE_LIMIT_AUTH_PER_MINUTE="25"; npm start
npm run test:hardening
```

`test:rollback` cố tình làm hỏng lệnh giải ngân **sau khi số dư đã đổi nhưng trước khi bút
toán được ghi**, rồi kiểm rằng sáu thứ đều quay về trạng thái cũ: số dư, cặp trạng thái, số
phiên bản, số bút toán, số bản ghi nhật ký, và — đáng giá nhất — **phiếu uỷ quyền vẫn chưa
bị tiêu thụ**. Nếu việc tiêu thụ phiếu nằm ngoài giao dịch cơ sở dữ liệu thì sau một lần
hỏng như vậy người dùng mất phiếu mà tiền vẫn chưa chuyển.

`test:hybrid` trả lời đúng những câu một người phản biện sẽ hỏi:

- tài khoản chưa gắn Passkey thì làm được gì (đáp: không gì, ngoài việc hoàn tất đăng ký)
- đăng ký Passkey mà bộ xác thực **không** đặt cờ xác minh người dùng → bị từ chối, tài khoản
  **không** được kích hoạt
- sai tên đăng nhập và sai mật khẩu có trả về **cùng một thông báo** không
- phiên tạo từ mật khẩu **vẫn khoá được tiền** vào ký quỹ, nhưng gọi thẳng `/release` không
  kèm phiếu thì **401**
- phiếu `MANAGE_CREDENTIAL` có đổi được mật khẩu không, phiếu `CHANGE_PASSWORD` có thêm được
  thiết bị không (đáp: không, cả hai chiều)
- đổi mật khẩu xong thì phiên cũ có bị thu hồi không
- luồng bootstrap quản trị viên có nhảy cóc được không

Sau mỗi nhóm, bộ test gọi `GET /api/admin/invariants` để kiểm **chín bất biến** bằng dữ liệu
thật, thay vì kết luận bằng cảm nhận.

ℹ️ Endpoint xác thực bị giới hạn `RATE_LIMIT_AUTH_PER_MINUTE=10` request/phút. Bộ test tạo nhiều
tài khoản nên **sẽ chạm trần** — khi đó test tự in `⏳ Chạm rate limit… chờ 60 giây` rồi chạy tiếp.
Đó là hành vi đúng, không phải treo. Đặt tạm giá trị cao hơn khi chạy cả bốn bộ nếu muốn nhanh.

Mỗi bộ test tự dựng lấy tài khoản của mình và đi qua **đúng các điểm cuối thật**, kể cả luồng
bootstrap quản trị viên — không tạo tài khoản quản trị bằng cách ghi thẳng vào cơ sở dữ liệu,
vì làm vậy thì chính luồng bootstrap không bao giờ được kiểm.

### Bộ dữ liệu thực nghiệm và kiểm bất biến

```
npm run reset-db           # chuyển data/ thành data-backup-<mốc thời gian>
npm start                  # tạo lại cơ sở dữ liệu trống
npm run seed:experiment    # tạo admin01, seller01, buyer01, buyer02 + yêu cầu quyền bán
npm run check:invariants   # kiểm chín bất biến, thoát khác 0 nếu có vi phạm
```

`seed:experiment` **chạy được nhiều lần** và mỗi lần chỉ làm phần còn thiếu. Lý do: khoá riêng
của Passkey do bộ xác thực trên thiết bị sinh ra, nên máy chủ không tạo nổi credential. Script
in ra đúng những bước còn phải làm trên trình duyệt; làm xong thì chạy lại để nó tạo nốt các
tin đăng cố định.

`buyer02` dành riêng cho các kịch bản tranh đua (hai người mua cùng khoá tiền một tin đăng).

Quản trị viên còn xem được chín bất biến ngay trên giao diện tại **Bảng quản trị → Bất biến hệ
thống**. Màn hình đó, `npm run check:invariants` và bộ test tự động dùng **chung một hàm** ở
`src/lib/invariants.js` — kể cả số thứ tự, tên và phát biểu của từng bất biến — nên ba nơi không
thể nói ba điều khác nhau.

| # | Bất biến | Ghi chú |
|---|---|---|
| 1 | Số dư không âm | có CHECK ở lược đồ; phép kiểm là đối chứng độc lập |
| 2 | Tổng biến động của **nghiệp vụ chuyển tiền nội bộ** bằng 0 | dòng tiền **đi vào** từ bên ngoài (`DEMO_TOPUP`, `TOPUP_CREDIT`) chỉ có một chân nên nằm ngoài phạm vi — KHÔNG phát biểu là "mọi wallet_entries cộng lại bằng 0" |
| 3 | Giao dịch chỉ tất toán một lần | |
| 4 | Phiếu uỷ quyền dùng một lần và đúng phạm vi | |
| 5 | Phiếu phân xử đúng hồ sơ tranh chấp và đúng quyết định | kiểm cả hai chiều: phiếu đã dùng ↔ hồ sơ đã giải quyết theo đúng quyết định |
| 6 | Tin đăng đơn chiếc chỉ một lần khoá tiền thành công | kèm kiểm `listings.status` không còn `AVAILABLE` khi đã có giao dịch khoá tiền |
| 7 | Cân đối số tiền đang giữ trong ký quỹ | |
| 8 | Tài khoản ACTIVE luôn có Passkey | |
| 9 | Một giao dịch tối đa một hồ sơ tranh chấp | có UNIQUE ở lược đồ; phép kiểm là đối chứng độc lập |

`npm run test:invariants` chứng minh **từng** phép kiểm bắt được đúng vi phạm của nó (và chỉ của
nó) trên một cơ sở dữ liệu tạm, kể cả khi ràng buộc lược đồ đã bị vô hiệu hoá.

---

## 8b. Lớp bảo vệ ứng dụng web

Nhóm này không phải trọng tâm nghiên cứu — trọng tâm là ràng buộc một lần xác thực lại với
đúng chủ thể, giao dịch và quyết định. Nhưng mục 2.3.1 đã nêu rằng tấn công web tổng quát
vẫn được xét khi chúng chạm tới ba đối tượng trong phạm vi: **phiên làm việc, trạng thái giao
dịch và quyền giải ngân**. Một lỗ XSS là con đường ngắn nhất để lấy mã phiên, nên siết lớp
này là siết trực tiếp một nhánh của mô hình đe doạ.

| Cơ chế | Nơi cài đặt | Ghi chú |
|---|---|---|
| CSP, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy | `src/lib/security.js` | `script-src 'self'` **không** có `unsafe-inline` — giao diện không có `<script>` nội tuyến nào |
| `Cache-Control: no-store` cho mọi phản hồi `/api/*` | `src/lib/security.js` | phản hồi API chứa dữ liệu riêng của từng tài khoản |
| Giới hạn tần suất theo **mẫu tuyến** | `src/lib/rateLimit.js` | khoá theo `(IP, phương thức, mẫu tuyến)`; đổi mã giao dịch không lách được |
| Fail-fast khi `JWT_SECRET` yếu | `src/lib/security.js` | máy chủ từ chối khởi động thay vì chạy với khoá ký mặc định |
| Nhật ký sự kiện an toàn | `src/lib/securityEvents.js` | bảng `security_events`, xem tại `GET /api/admin/security-events` |
| Chèn lỗi chủ động để kiểm rollback | `src/lib/faultInjection.js` | mặc định TẮT; `GET /health` công bố trạng thái |

**Nhật ký sự kiện an toàn tách riêng khỏi `audit_logs`** vì hai bảng trả lời hai câu hỏi khác
nhau. `audit_logs` ghi các lần chuyển trạng thái *thành công* của một giao dịch, có chuỗi băm
móc xích, dùng làm căn cứ khi tranh chấp. `security_events` ghi *ai đã thử làm gì mà bị từ
chối* — và phần lớn sự kiện loại này không gắn với giao dịch nào, nên nhét chung vào chuỗi
băm của một giao dịch là sai chỗ.

Việc ghi nhận các lần bị từ chối nằm ở **một middleware lỗi tập trung** trong `server.js`,
không rải ở từng route. Nhờ vậy thêm một nhánh từ chối mới ở bất kỳ đâu thì nó tự động được
ghi lại, không phụ thuộc vào việc người viết có nhớ hay không.

Cột `detail` chỉ cho qua một **danh sách trường đã chọn**. Lọc theo danh sách cho phép chứ
không theo danh sách cấm, vì cách sau luôn sót khi có người thêm trường mới. `test:hardening`
kiểm trực tiếp rằng không có mật khẩu, phiếu uỷ quyền hay mã phiên nào lọt vào nhật ký.

### Về phiên: JWT ở header, không dùng cookie

Hệ thống mang mã phiên trong `Authorization: Bearer`, không dùng cookie. Hệ quả cần nêu đúng:

- **CSRF không áp dụng** — không có ambient credential, trình duyệt không tự đính mã phiên
  vào request do trang khác khởi tạo. Vì vậy không có CSRF token, và điều đó là đúng chứ
  không phải thiếu sót.
- **Đổi lại, `localStorage` phơi ra trước XSS**, còn cookie `HttpOnly` thì không. Đây là đánh
  đổi có thật; CSP với `script-src 'self'` là biện pháp đối trọng chính.
- **Thu hồi phiên vẫn làm được**: `users.token_version` tăng khi đổi mật khẩu, và mọi mã
  phiên cấp trước đó lập tức mất hiệu lực.

---

## 9. Các cơ chế an toàn được cài đặt

| Cơ chế | Nơi cài đặt |
|---|---|
| Không có mật khẩu — chỉ Passkey (WebAuthn, ES256) | `routes/passkeys.js` |
| Challenge dùng một lần, có hạn, chống replay | `auth_challenges.used_at` + `expires_at` |
| Re-authentication trước khi chuyển tiền | `routes/transactions.js` → `/reauth/*` + `/release` |
| Grant re-auth: CSPRNG 32 byte, server chỉ lưu SHA-256, so sánh hằng thời gian | `crypto.timingSafeEqual` |
| Phiếu uỷ quyền dùng đúng 1 lần, đúng 1 giao dịch, đúng 1 người, đúng 1 hành động | `lib/reauth.js` + `reauth_grants` |
| Thêm hoặc xoá passkey cũng đòi xác thực lại, mã phiên bị đánh cắp không đủ | `routes/passkeys.js` → `/reauth/*` |
| Idempotency: gửi lại cùng `requestId` không trừ tiền hai lần | `wallet_entries.idempotency_key` UNIQUE |
| Cùng `requestId` nhưng khác nội dung thì báo xung đột, không trả nhầm kết quả cũ | `wallet_entries.request_fingerprint` |
| Optimistic locking chống race condition | `UPDATE … WHERE id = ? AND version = ?` |
| Cập nhật nhiều ví luôn theo thứ tự `wallet.id` tăng dần (chống deadlock) | `lib/walletOps.js` |
| Số dư không bao giờ âm | `CHECK (available_balance >= 0)` ở tầng database |
| Server tự lấy giá từ listing, không tin số tiền client gửi lên | `routes/transactions.js` → `/orders` |
| Chống mua trùng — ai thanh toán trước giữ sản phẩm | `findReservingOrder()` trong `/secure` |
| Không đổi được giá khi sản phẩm đã có đơn mua | `routes/listings.js` → `PATCH` |
| Luồng đăng ký không nhận tham số quyền — mọi tài khoản mới đều là BUYER | `routes/passkeys.js` |
| Quyền của người gọi đọc lại từ cơ sở dữ liệu ở mỗi yêu cầu, không tin JWT cũ | `lib/auth.js` |
| Quyền bán chỉ đến từ bước duyệt của quản trị viên | `routes/admin.js` → `reviewSellerRequest()` |
| Quyền quản trị không có điểm cuối HTTP, chỉ cấp bằng script trên máy chủ | `lib/adminBootstrap.js` |
| Kiểm mã ở bước `options` (trước khi hỏi vân tay), không lộ oracle đoán mã | `/register/options` |
| Rate limit endpoint xác thực | `lib/rateLimit.js` |
| Chuỗi băm riêng cho từng giao dịch, có số thứ tự, verify được | `lib/hash.js` + `audit_logs.sequence_no` |
| Chỉ người trong cuộc xem được nhật ký giao dịch | `assertOwnership()` |
| Tin đăng đơn chiếc: chiếm độc quyền lúc LOCK bằng cập nhật có điều kiện `status` + `version` | `lockListingForOrder()` |
| Webhook nạp tiền: HMAC-SHA256 so sánh hằng thời gian, sai chữ ký bị từ chối trước mọi xử lý | `lib/mockPaymentProvider.js` |
| Nạp tiền tất toán đúng một lần dù webhook lặp, trái thứ tự, hay đua với worker đối soát | `lib/paymentService.js` — `WHERE status='PENDING' AND version=?` |
| Không coi "provider chưa trả lời" hay "không hỏi được provider" là thất bại | `lib/reconciler.js` |
| signCount không tăng → ghi `COUNTER_ANOMALY`, KHÔNG từ chối, KHÔNG khoá credential | `lib/credentialCounter.js` |
| Dọn challenge cũ không ảnh hưởng quyết định an toàn; không dọn phiếu uỷ quyền (căn cứ bất biến 4) | `lib/maintenance.js` |
| Thông báo chỉ phản ánh trạng thái, ghi sau commit, ghi hỏng không làm hỏng nghiệp vụ | `lib/notifications.js` |
| Môi trường thực nghiệm từ chối khởi động khi chèn lỗi đang bật | `assertEnvironmentSafe()` |

---

## 10. Khác biệt so với bộ tài liệu kỹ thuật gốc (NestJS/Prisma/PostgreSQL)

Bản này viết bằng Express + SQLite để dễ triển khai, nhưng giữ đúng các nguyên lý an toàn cốt lõi:

- Optimistic locking bằng `version` (`UPDATE … WHERE id=? AND version=?` thay cho Prisma `updateMany`).
- Idempotency key UNIQUE trên `wallet_entries`.
- Cập nhật nhiều ví luôn theo thứ tự `wallet.id` tăng dần.
- Hash Chain riêng theo từng `transaction_id`.
- Re-auth grant: token CSPRNG 32 byte, server chỉ lưu SHA-256 hash, so sánh hằng thời gian.

**Điểm khác biệt quan trọng cần nêu trong báo cáo:** driver `node:sqlite` chạy đồng bộ và Node.js
đơn luồng, nên TRONG CÙNG MỘT PROCESS, một `db.transaction(fn)()` không thể bị request khác xen vào
giữa chừng. Nhưng hệ thống không chỉ có một process: worker đối soát chạy được như process riêng
(`scripts/reconcile.js`), và bộ kiểm thử mở thẳng cơ sở dữ liệu. Giữa các process, tính đúng đắn
KHÔNG dựa vào tính đơn luồng mà dựa vào:

- giao dịch `BEGIN IMMEDIATE` + `busy_timeout` — process đến sau chờ khoá ghi thay vì lỗi;
- cập nhật có điều kiện theo `status`/`version` — người đến sau nhận "đã tất toán", không ghi đè;
- khoá chống lặp UNIQUE ở `wallet_entries`.

`test:reconcile` chứng minh điều này bằng cuộc đua thật giữa các process (hai worker song song,
worker đua với webhook, process worker chết ngang giữa giao dịch). Giới hạn phải nêu ở Chương 3:
SQLite tuần tự hoá mọi thao tác ghi bằng một khoá cho toàn cơ sở dữ liệu, nên số liệu đồng thời
phản ánh hành vi dưới cơ chế khoá này, không suy rộng thành kết quả trên PostgreSQL.

### Mở rộng nghiệp vụ so với bản escrow gốc

1. **Lớp marketplace `listings`** — mỗi tin đăng là một sản phẩm đơn chiếc, có danh mục, tình
   trạng và giá bán.
2. **`transactions` trở thành đơn mua bán** — thêm `listing_id` và `buyer_note`. Máy trạng thái
   giữ nguyên, chỉ đổi ý nghĩa nghiệp vụ của từng trạng thái.
3. **Một dòng tiền duy nhất** — xem mục 5.
4. **Người bán cũng được mở tranh chấp** (bản gốc chỉ cho Buyer), dùng khi người mua đòi hoàn
   tiền không có căn cứ hoặc phủ nhận đã nhận hàng.
5. **Người trong cuộc tự kiểm chứng Hash Chain** — thêm `GET /api/transactions/:id/logs` và
   `/logs/verify` giới hạn theo `assertOwnership`, không cần quyền Admin như trước.
6. **Một form đăng ký duy nhất, không cấp quyền** — bỏ hẳn `routes/adminBootstrap.js`, tài khoản
   admin seed sẵn và cơ chế mã mời. Cả ba vai trò dùng chung một form, và form đó không nhận
   tham số nào ảnh hưởng tới quyền: mọi tài khoản mới đều là BUYER, vai trò ghi vào
   `auth_challenges.context_data` ở phía máy chủ. Yêu cầu AUTH-02 (không ai tự đăng ký thành
   ADMIN) vì vậy được thoả mãn bằng cách loại bỏ hẳn bề mặt tấn công, thay vì canh giữ nó.

### Hạn chế đã biết

- Một tài khoản chỉ đóng **một vai** (Người mua **hoặc** Người bán). Sàn thật thường cho một
  người làm cả hai vai; ở đây quyền bán được cấp bằng cách nâng vai trò tại chỗ, giữ nguyên ví,
  passkey và lịch sử giao dịch.
- **Chưa có huỷ đơn**: nhánh `SECURED` → `REFUNDED` nằm ngoài phạm vi (xem mục 6). Đơn `CREATED`
  chưa thanh toán nằm lại danh sách nhưng không giữ chỗ nên không chặn người khác mua.
- **Chuỗi băm phát hiện được sửa, chèn và xoá giữa chuỗi**, nhưng người kiểm soát trực tiếp cơ
  sở dữ liệu vẫn có thể tính lại toàn chuỗi hoặc xoá các bản ghi ở cuối chuỗi. Muốn chặn thì
  phải neo số thứ tự và giá trị băm cuối chuỗi ra ngoài miền quản trị của hệ thống.
- **Không có giao diện hiển thị tin cậy**: WebAuthn thông thường không chứng minh được người
  dùng đã nhìn thấy đúng số tiền trên màn hình.
- Ảnh sản phẩm là **emoji hoặc URL ngoài** — chưa có upload file.
- Số dư ví là **tiền mô phỏng**: nạp tiền đi qua Mock Payment Provider (webhook đã ký + đối soát),
  chưa nối cổng thanh toán thật. Thay provider thật chỉ cần thay `lib/mockPaymentProvider.js`.
- **Quản trị viên đầu tiên phải tạo bằng dòng lệnh trên máy chủ.** Đây là chủ ý: không có điểm
  cuối HTTP nào cấp được quyền quản trị. Đổi lại, người triển khai phải có quyền chạy lệnh trên
  máy chủ, và phải đăng ký tài khoản qua giao diện trước rồi mới nâng quyền được.
- **Chưa có luồng đổi/thu hồi Passkey**: mỗi tài khoản gắn đúng một passkey
  (`passkey_credentials.user_id` là UNIQUE). Mất thiết bị là mất tài khoản — sàn thật cần cho
  đăng ký nhiều thiết bị và có phương án khôi phục.

---

## 11. Đóng băng phiên bản thực nghiệm (runbook)

Quy trình đã chốt: **không vừa chạy thí nghiệm vừa sửa logic.** Thư mục dự án không dùng git, nên
"tag" được thay bằng manifest băm SHA-256 từng file mã nguồn, bộ test, giao diện và phụ thuộc.

```
npm run test:suite           # 1. vòng kiểm thử đầy đủ trên DB test trống — phải TẤT CẢ PASS
npm run freeze:experiment    # 2. đóng băng -> EXPERIMENT_FREEZE.json
npm run freeze:verify        # kiểm lại bất cứ lúc nào: mã hiện tại có đúng bản đã đóng băng?
npm run start:experiment     # 3. máy chủ thực nghiệm (cổng 3200), tự kiểm freeze khi khởi động
```

`freeze:experiment` **từ chối** nếu vòng kiểm thử gần nhất có bộ hỏng, không chạy từ DB trống,
hoặc có file mã nguồn bị sửa SAU lúc vòng đó bắt đầu — tức là kết quả kiểm thử phải ứng đúng với
mã được đóng băng. Manifest không chứa bí mật (khoá bí mật chỉ ghi dấu vân tay rút gọn).

Nếu buộc phải sửa mã sau khi đóng băng: sửa → `npm run test:suite` → đóng băng lại với nhãn mới
(`npm run freeze:experiment -- --label=thesis-experiment-v1.1`) → **xoá kết quả đã thu và chạy lại
mọi testcase thực nghiệm bị ảnh hưởng**.

Không chạy `test:suite`, stress hay chèn lỗi trên môi trường experiment — các lệnh đó chỉ chạy trên
môi trường test (cổng và cơ sở dữ liệu khác hẳn).