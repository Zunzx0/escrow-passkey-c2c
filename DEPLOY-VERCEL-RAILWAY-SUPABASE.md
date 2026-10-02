# Triển khai Enclave lên Vercel + Railway + Supabase

Tài liệu thao tác đi kèm `MIGRATION-VERCEL-RAILWAY-SUPABASE.md`. Phần mã đã xong trên nhánh
`migrate-postgres`; các bước dưới đây là phần phải làm bằng tài khoản của bạn.

| Thành phần | Địa chỉ | Chạy gì |
|---|---|---|
| Giao diện | `https://enclave.id.vn` | Vercel, thư mục `cho-an-tam/public` |
| API | `https://api.enclave.id.vn` | Railway, `Dockerfile` ở gốc repo |
| Dữ liệu | (không công khai) | Supabase PostgreSQL, schema `app` + `mock_provider` |

Render **giữ nguyên** làm phương án dự phòng cho tới khi bước 6 kiểm tra xong. Nhánh `main` chưa đổi,
nên Render không bị ảnh hưởng.

---

## 0. Đã làm sẵn trong mã

- Lớp truy cập dữ liệu chạy được trên cả SQLite và PostgreSQL (`DATABASE_URL` có thì dùng PostgreSQL).
- Mỗi giao dịch ghi trên PostgreSQL giữ `pg_advisory_xact_lock` — tuần tự hoá giống `BEGIN IMMEDIATE`
  của SQLite, nên mọi lập luận về 9 bất biến vẫn đúng.
- Lược đồ PostgreSQL tự tạo khi máy chủ khởi động lần đầu (bảng `app.schema_migrations` ghi phiên bản).
- Challenge WebAuthn được tiêu thụ nguyên tử (`... AND used_at IS NULL`) ở cả 6 chỗ — chặn phát lại song song.
- CORS so khớp chính xác origin; giao diện gọi API qua `public/js/config.js`.
- Bộ kiểm thử đầy đủ: **489/489 đạt trên SQLite và 489/489 đạt trên PostgreSQL**, 9 bất biến đúng.

---

## 1. Supabase — tạo cơ sở dữ liệu

1. https://supabase.com → **New project**. Tên: `enclave`. Region: **Southeast Asia (Singapore)**.
2. Đặt **Database password** mạnh, lưu vào trình quản lý mật khẩu. Không gửi qua chat/email.
3. Vào **Project Settings → Database → Connection string → URI**, chọn **Session pooler** (cổng `5432`,
   chạy được qua IPv4). Chuỗi có dạng:
   `postgresql://postgres.<mã-dự-án>:<MẬT-KHẨU>@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres`
4. Không cần tạo bảng bằng tay — máy chủ API tự tạo ở lần khởi động đầu.
5. Không dùng `anon key` / `service_role key` ở đâu cả. Bảng nằm ở schema `app`, Data API của Supabase
   không phơi schema này.

## 2. Railway — chạy API

1. https://railway.com → **New Project → Deploy from GitHub repo** → `Zunzx0/escrow-passkey-c2c`.
2. **Settings → Source → Branch**: chọn `migrate-postgres`. Railway đọc `railway.json` ở gốc repo
   (build bằng `Dockerfile`, health check `/health`).
3. **Variables** — thêm đúng các biến sau:

   | Biến | Giá trị |
   |---|---|
   | `APP_ENV` | `production` |
   | `DATABASE_URL` | chuỗi Session pooler ở bước 1.3 |
   | `JWT_SECRET` | chuỗi ngẫu nhiên MỚI ≥ 32 ký tự (lệnh sinh ở dưới) |
   | `PAYMENT_WEBHOOK_SECRET` | chuỗi ngẫu nhiên MỚI khác, ≥ 32 ký tự |
   | `WEBAUTHN_RP_ID` | `enclave.id.vn` |
   | `WEBAUTHN_ORIGIN` | `https://enclave.id.vn` |
   | `CORS_ORIGIN` | `https://enclave.id.vn` |
   | `SERVE_FRONTEND` | `0` |
   | `TRUST_PROXY` | `1` |
   | `ENABLE_HSTS` | `1` |
   | `MOCK_PROVIDER_CHECKOUT` | `1` |
   | `PAYMENT_WEBHOOK_URL` | `https://api.enclave.id.vn/api/payments/webhook` |
   | `ADMIN_BOOTSTRAP_USERNAME` | tên quản trị viên, ví dụ `admin` |
   | `ADMIN_BOOTSTRAP_PASSWORD` | mật khẩu tạm ≥ 12 ký tự |

   Sinh chuỗi ngẫu nhiên: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

   `WEBAUTHN_ORIGIN` là địa chỉ **giao diện** (Vercel), không phải `api.enclave.id.vn` — nghi thức
   Passkey chạy trong trang giao diện.
4. Deploy. Trong **Deploy Logs** phải thấy:
   ```
   [migrate] PostgreSQL: đã áp migration 1 (initial-schema).
   WEBAUTHN_RP_ID=enclave.id.vn  WEBAUTHN_ORIGIN=https://enclave.id.vn
   Cơ sở dữ liệu: PostgreSQL aws-0-...pooler.supabase.com:5432/postgres
   CORS: https://enclave.id.vn · Giao diện tĩnh: tắt
   [admin-bootstrap] Đã tạo quản trị viên "admin" ở trạng thái chờ thiết lập.
   ```
5. **Settings → Networking → Custom Domain** → nhập `api.enclave.id.vn`. Railway hiện một bản ghi
   **CNAME** — chép đúng giá trị đó (bước 4).

## 3. Vercel — chạy giao diện

1. https://vercel.com → **Add New → Project** → import cùng repo.
2. **Root Directory**: `cho-an-tam/public`. **Framework Preset**: `Other`. Không có Build Command,
   Output Directory để trống (mặc định).
3. **Git → Production Branch**: `migrate-postgres` (đổi về `main` sau khi gộp nhánh).
4. Không thêm Environment Variable nào — giao diện không giữ bí mật.
5. Deploy. Mở địa chỉ `*.vercel.app` để xem giao diện hiện đúng. (Passkey KHÔNG chạy ở địa chỉ
   này vì không thuộc `enclave.id.vn` — bình thường.)
6. **Settings → Domains** → thêm `enclave.id.vn` và `www.enclave.id.vn`; đặt `www` chuyển hướng về
   `enclave.id.vn`. Vercel hiện bản ghi DNS cần đặt — chép đúng giá trị đó (bước 4).

## 4. DNS (ở nơi bạn mua tên miền)

Ghi lại cấu hình DNS hiện tại (đang trỏ Render) trước khi sửa, để quay lại được.

| Host | Kiểu | Giá trị |
|---|---|---|
| `api` | CNAME | giá trị Railway đưa ở bước 2.5 |
| `@` | A (hoặc ALIAS) | giá trị Vercel đưa ở bước 3.6 |
| `www` | CNAME | giá trị Vercel đưa ở bước 3.6 |

Thứ tự: thêm `api` trước, chờ Railway báo chứng chỉ TLS xong, rồi mới đổi `@` sang Vercel.

## 5. Tạo quản trị viên và dữ liệu demo

1. Mở `https://enclave.id.vn` (cửa sổ ẩn danh) → đăng nhập bằng `ADMIN_BOOTSTRAP_USERNAME` và mật khẩu tạm.
2. Đổi mật khẩu tạm → đăng ký Passkey (Windows Hello / vân tay). Tài khoản chuyển ACTIVE.
3. Xoá hai biến `ADMIN_BOOTSTRAP_*` khỏi Railway (không bắt buộc — máy chủ tự bỏ qua khi đã có quản trị viên).
4. **Khác với Render:** dữ liệu giờ nằm ở Supabase nên **không mất khi Railway khởi động lại**. Passkey
   chỉ cần đăng ký một lần.

## 6. Kiểm tra sau khi chuyển

- [ ] `https://api.enclave.id.vn/health` trả `{"status":"OK"}`
- [ ] `https://enclave.id.vn` tải giao diện; DevTools → Network: mọi request đi tới `api.enclave.id.vn`
- [ ] Đăng ký tài khoản mới → đăng ký Passkey → đăng nhập bằng Passkey
- [ ] Nạp tiền mô phỏng → số dư tăng đúng một lần
- [ ] Đặt mua → khoá ký quỹ → giao hàng → xác nhận → giải ngân (có hỏi Passkey)
- [ ] Mở tranh chấp → quản trị viên phân xử (có hỏi Passkey)
- [ ] **Redeploy Railway** → đăng nhập lại bằng Passkey cũ → số dư, đơn hàng còn nguyên
- [ ] Màn hình quản trị → Bất biến: 9/9 đạt

Khi tất cả đạt: gộp `migrate-postgres` vào `main`, đổi nhánh của Railway và Vercel về `main`, tắt
service Render sau vài ngày.

## 7. Quay lại nếu có sự cố

- Giao diện lỗi: trỏ `@` về lại giá trị DNS cũ của Render (đã ghi ở bước 4).
- API lỗi: Railway → Deployments → **Rollback** về bản trước.
- Dữ liệu: đừng trông vào sao lưu tự động của gói Free — kiểm tra mục Database → Backups của dự án
  để biết gói của bạn có gì. Trước buổi báo cáo, tự xuất một bản bằng `pg_dump` với chuỗi kết nối ở
  bước 1.3. Không sửa số dư bằng SQL tay.

## Lưu ý chi phí và thời hạn

- Supabase gói Free **tạm dừng dự án sau 7 ngày không có truy cập**. Trước buổi báo cáo, mở Dashboard
  xác nhận dự án Active.
- Railway Trial có hạn mức tín dụng; worker đối soát chạy mỗi 60 giây nên service không "ngủ". Theo dõi
  Usage; nếu cần, đặt `RECONCILE_INTERVAL_SECONDS=300` để giảm tải.
