-- Schema SQLite cho Escrow + Passkeys trên nền thương mại điện tử C2C (mua bán).
--
-- Mô hình nghiệp vụ: cá nhân đăng bán sản phẩm, cá nhân khác đặt mua, tiền của người
-- mua được khoá tại ví ký quỹ và chỉ rời khỏi đó khi người mua xác nhận đã nhận hàng
-- (kèm xác thực lại bằng passkey) hoặc khi quản trị viên phân xử tranh chấp.
--
-- Mỗi giao dịch chỉ có MỘT dòng tiền: người mua -> ký quỹ -> người bán (hoặc quay lại
-- người mua khi hoàn tiền).

PRAGMA foreign_keys = ON;

-- Mô hình xác thực LAI: đăng nhập bằng mật khẩu HOẶC Passkey, nhưng mọi thao tác làm tiền
-- rời khỏi ký quỹ và mọi thay đổi thông tin xác thực đều đòi xác thực lại bằng Passkey.
--
-- password_hash  giá trị dẫn xuất bằng scrypt kèm muối riêng (xem src/lib/password.js).
--                Mật khẩu gốc không được lưu ở bất kỳ đâu và không được ghi vào nhật ký.
--
-- account_status vòng đời tài khoản. Ràng buộc "tài khoản ACTIVE luôn có ít nhất một
--                Passkey" (bất biến số 8) được giữ bằng chính cột này: tài khoản chỉ
--                chuyển sang ACTIVE trong cùng giao dịch cơ sở dữ liệu ghi credential đầu
--                tiên, và không cho xoá credential cuối cùng.
--                  PENDING_BOOTSTRAP  quản trị viên vừa được khởi tạo, còn dùng mật khẩu
--                                     tạm, chỉ được phép đổi mật khẩu tạm đó
--                  PENDING_PASSKEY    đã có mật khẩu, chưa đăng ký Passkey; chưa có ví và
--                                     không gọi được bất kỳ chức năng nghiệp vụ nào
--                  ACTIVE             dùng được đầy đủ
--
-- token_version  tăng lên mỗi lần đổi mật khẩu. JWT mang theo giá trị này, nên đổi mật
--                khẩu làm mọi phiên đang mở khác mất hiệu lực ngay lập tức.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('BUYER','SELLER','ADMIN')),
  password_hash TEXT NOT NULL,
  account_status TEXT NOT NULL DEFAULT 'PENDING_PASSKEY'
    CHECK (account_status IN ('PENDING_BOOTSTRAP','PENDING_PASSKEY','ACTIVE')),
  token_version INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- MỘT tài khoản có NHIỀU passkey (điện thoại, laptop, khoá cứng dự phòng).
-- Bản đầu ràng buộc UNIQUE trên user_id => mỗi người chỉ 1 passkey => mất thiết bị là
-- mất tài khoản kèm toàn bộ số dư, không có đường vào lại. Đó là lỗi chặn với hệ thống
-- có dính tới tiền, nên UNIQUE đã được gỡ (xem migratePasskeyCredentials() trong db.js
-- để biết cách nâng cấp DB cũ).
CREATE TABLE IF NOT EXISTS passkey_credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,
  public_key BLOB NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT,
  device_name TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_used_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_passkey_credentials_user ON passkey_credentials(user_id);

-- Yêu cầu mở quyền bán hàng.
--
-- Đây là đường DUY NHẤT để một Người mua trở thành Người bán: gửi yêu cầu, quản trị viên
-- duyệt, tài khoản được NÂNG CẤP tại chỗ (BUYER -> SELLER) chứ không tạo tài khoản mới.
-- Nhờ vậy ví, passkey và toàn bộ lịch sử giao dịch đã mua được giữ nguyên.
--
-- Hệ thống không có cơ chế cấp quyền nào khác đi qua đường mạng. Luồng đăng ký luôn tạo ra
-- BUYER, còn quyền ADMIN chỉ được cấp bằng script vận hành `npm run seed:admin` chạy trực
-- tiếp trên máy chủ.
CREATE TABLE IF NOT EXISTS seller_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shop_name TEXT NOT NULL,
  pitch TEXT,                           -- người gửi mô tả định bán những gì
  status TEXT NOT NULL CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  review_note TEXT,                     -- lý do từ chối, hoặc ghi chú khi duyệt
  reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Mỗi người chỉ được có ĐÚNG MỘT yêu cầu đang chờ. Partial unique index đẩy ràng buộc
-- này xuống tận DB, nên hai request gửi cùng lúc chỉ có một cái vào được.
CREATE UNIQUE INDEX IF NOT EXISTS idx_seller_requests_one_pending
  ON seller_requests(user_id) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS idx_seller_requests_status ON seller_requests(status, created_at);

CREATE TABLE IF NOT EXISTS wallets (
  id TEXT PRIMARY KEY,
  user_id TEXT UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  wallet_type TEXT NOT NULL CHECK (wallet_type IN ('USER','SYSTEM_ESCROW')),
  available_balance INTEGER NOT NULL DEFAULT 0 CHECK (available_balance >= 0),
  locked_balance INTEGER NOT NULL DEFAULT 0 CHECK (locked_balance >= 0),
  version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (
    (wallet_type = 'USER' AND user_id IS NOT NULL)
    OR (wallet_type = 'SYSTEM_ESCROW' AND user_id IS NULL)
  )
);

-- Chỉ cho phép một ví SYSTEM_ESCROW duy nhất
CREATE UNIQUE INDEX IF NOT EXISTS ux_single_system_escrow_wallet
  ON wallets(wallet_type) WHERE wallet_type = 'SYSTEM_ESCROW';

-- Yêu cầu nạp tiền qua Mock Payment Provider — lớp "thế giới bên ngoài" được PHÉP mô phỏng
-- (mục 1 kế hoạch), tách khỏi Wallet/Escrow core để sau này thay bằng provider thật mà
-- không phải viết lại core.
--
-- Vòng đời chỉ có ba trạng thái, đi đúng một lần: PENDING (vừa tạo, chờ callback từ
-- provider) -> SUCCEEDED (webhook hợp lệ báo thành công; ví ĐÃ được cộng trong CÙNG giao
-- dịch cơ sở dữ liệu với việc chuyển trạng thái này) hoặc FAILED (provider báo thất bại,
-- ví không đổi). Không có trạng thái thứ tư: hết hạn/không thấy callback KHÔNG đồng nghĩa
-- FAILED — yêu cầu cứ giữ nguyên PENDING (xem routes/payments.js), việc dọn/đối soát các
-- yêu cầu PENDING quá lâu thuộc về Background Worker làm ở bước kế tiếp, không phải việc
-- tự ý đổi trạng thái ở đây. Ngoại lệ DUY NHẤT: yêu cầu mà provider chưa từng nhận được
-- (submission_status khác SUBMITTED) sau TOPUP_SUBMIT_MAX_ATTEMPTS lần gửi — provider không có
-- bản ghi nào để thanh toán, nên worker đối soát đưa nó sang FAILED (lib/paymentService.js).
--
-- submission_status là trạng thái của bước GỬI yêu cầu sang provider, độc lập với status:
--   SUBMITTING     đã ghi yêu cầu, đang gửi (hoặc process chết giữa chừng)
--   SUBMITTED      provider đã ghi nhận
--   SUBMIT_FAILED  gửi hỏng; client gửi lại cùng requestId hoặc worker đối soát sẽ gửi lại
-- submit_claim / submit_claimed_at là QUYỀN GỬI (lease): chỉ tiến trình giữ claim còn hạn mới được
-- gửi yêu cầu lên provider. Hết hạn (tiến trình chết giữa chừng) thì tiến trình khác giành lại.
-- client_request_id là khoá chống lặp do client gửi (requestId), duy nhất theo từng người dùng —
-- chỉ mục duy nhất được tạo trong db.js (migrate) vì cột có thể được thêm sau bằng ALTER TABLE.
--
-- provider_ref là mã do PHÍA PROVIDER cấp (ở đây do chính ta sinh ra vì đang mô phỏng), dùng
-- để webhook callback tự nhận diện đúng yêu cầu — độc lập với id nội bộ của ta, giống cách
-- các cổng thanh toán thật vẫn làm.
--
-- status + version là hàng rào chống hai nguồn kết quả (webhook trùng, webhook và worker đối
-- soát, hai worker) cùng tất toán một yêu cầu: cập nhật có điều kiện `WHERE status='PENDING'
-- AND version=?`, cùng khuôn mẫu với listings và wallets/transactions. Mọi nguồn đều đi qua
-- đúng một hàm lib/paymentService.js#applyProviderResult.
--
-- reconcile_attempts / last_reconciled_at / last_reconcile_error chỉ là vết vận hành của
-- worker đối soát (đã hỏi provider bao nhiêu lần, lần cuối lỗi gì). Chúng KHÔNG tăng version
-- và không tham gia quyết định tất toán.
CREATE TABLE IF NOT EXISTS payment_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL CHECK (amount > 0),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SUCCEEDED','FAILED')),
  provider_ref TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL DEFAULT 'MOCK' CHECK (provider IN ('MOCK','PAYPAL_SANDBOX')),
  version INTEGER NOT NULL DEFAULT 0,
  resolved_at TEXT,
  resolved_by TEXT CHECK (resolved_by IS NULL OR resolved_by IN ('WEBHOOK','RECONCILER')),
  reconcile_attempts INTEGER NOT NULL DEFAULT 0,
  last_reconciled_at TEXT,
  last_reconcile_error TEXT,
  client_request_id TEXT,
  submission_status TEXT NOT NULL DEFAULT 'SUBMITTED'
    CHECK (submission_status IN ('SUBMITTING','SUBMITTED','SUBMIT_FAILED')),
  submit_attempts INTEGER NOT NULL DEFAULT 0,
  last_submit_error TEXT,
  submit_claim TEXT,
  submit_claimed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_payment_requests_user ON payment_requests(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_payment_requests_pending ON payment_requests(status, created_at);

-- Tin đăng bán (lớp marketplace nằm TRÊN lõi escrow).
-- Một listing = một sản phẩm đơn chiếc mà người bán rao bán, đúng đặc điểm hàng hoá C2C
-- đã nêu ở chương 1: đồ đã qua sử dụng, hàng sưu tầm, vật dụng cá nhân.
--
-- status/version thực thi bất biến "một tin đăng đơn chiếc chỉ một giao dịch khoá tiền
-- thành công". Quyền sở hữu độc quyền tại thời điểm LOCK do CHÍNH cập nhật có điều kiện
-- `WHERE status='AVAILABLE' AND version=oldVersion` trên bảng này quyết định (xem
-- routes/transactions.js), không được suy ra ngầm từ việc dò transactions.listing_id —
-- cách dò đó có thể tiếp tục tồn tại như kiểm tra nghiệp vụ bổ sung nhưng không còn là
-- hàng rào concurrency chính. Rời khỏi LOCKED chỉ khi tất toán, trong CÙNG giao dịch cơ sở dữ
-- liệu chuyển tiền (lib/listingLifecycle.js): giải ngân -> SOLD, hoàn tiền -> AVAILABLE (mở
-- bán lại).
CREATE TABLE IF NOT EXISTS listings (
  id TEXT PRIMARY KEY,
  seller_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL,
  location TEXT,                   -- khu vực của người bán (giao nhận), xem LOCATIONS ở lib/catalog.js
  condition TEXT NOT NULL DEFAULT 'GOOD' CHECK (condition IN ('NEW','LIKE_NEW','GOOD','FAIR')),
  image TEXT,                      -- dành cho ảnh sản phẩm; chưa có chức năng tải ảnh lên
  price INTEGER NOT NULL CHECK (price > 0),
  visibility TEXT NOT NULL DEFAULT 'PUBLIC' CHECK (visibility IN ('PUBLIC','HIDDEN')),
  status TEXT NOT NULL DEFAULT 'AVAILABLE' CHECK (status IN ('AVAILABLE','LOCKED','SOLD')),
  version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_listings_seller ON listings(seller_id);
CREATE INDEX IF NOT EXISTS idx_listings_category ON listings(category, visibility);

-- transactions = ĐƠN MUA BÁN. amount là toàn bộ số tiền người mua trả, cũng chính là
-- số tiền được khoá tại ký quỹ và sau đó chuyển nguyên vẹn cho một trong hai bên.
CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  buyer_id TEXT NOT NULL REFERENCES users(id),
  seller_id TEXT NOT NULL REFERENCES users(id),
  item_name TEXT NOT NULL,
  item_description TEXT,
  amount INTEGER NOT NULL CHECK (amount > 0),
  status TEXT NOT NULL DEFAULT 'CREATED' CHECK (status IN
    ('CREATED','SECURED','SHIPPING','WAIT_CONFIRM','COMPLETED','DISPUTED','REFUNDED','RELEASED')),
  escrow_status TEXT NOT NULL DEFAULT 'NONE' CHECK (escrow_status IN
    ('NONE','LOCKED','FROZEN','RELEASED','REFUNDED')),
  listing_id TEXT REFERENCES listings(id),
  buyer_note TEXT,
  -- Người bán xác nhận đã nhận đơn và sẽ gửi hàng. Là MỐC SỰ KIỆN, không phải trạng thái:
  -- đơn vẫn ở SECURED/LOCKED, không có tiền nào di chuyển (kế hoạch mục 3).
  seller_ack_at TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (buyer_id <> seller_id)
);

CREATE INDEX IF NOT EXISTS idx_transaction_buyer ON transactions(buyer_id);
CREATE INDEX IF NOT EXISTS idx_transaction_seller ON transactions(seller_id);
CREATE INDEX IF NOT EXISTS idx_transaction_status ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_transaction_listing ON transactions(listing_id, status);

-- context_data giữ ngữ cảnh mà kết quả nghiệp vụ phụ thuộc vào nhưng KHÔNG được phép
-- nhận lại từ phía người dùng: tên đăng nhập đã kiểm trùng và vai trò mặc định lúc đăng
-- ký, hoặc nội dung giao dịch lúc xác thực lại.
CREATE TABLE IF NOT EXISTS auth_challenges (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  transaction_id TEXT REFERENCES transactions(id) ON DELETE CASCADE,
  challenge TEXT NOT NULL UNIQUE,
  purpose TEXT NOT NULL CHECK (purpose IN ('REGISTRATION','AUTHENTICATION','REAUTH','ADMIN_BOOTSTRAP')),
  context_data TEXT NOT NULL DEFAULT '{}',
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_auth_challenges_lookup ON auth_challenges(purpose, expires_at, used_at);

-- idempotency_key mang ràng buộc UNIQUE nên hai lần ghi cùng khoá không thể cùng tồn tại.
-- request_fingerprint là băm của các tham số quyết định nghiệp vụ (chủ thể, hành động,
-- giao dịch, số tiền). Cùng khoá + cùng vân tay = một lần gửi lại, trả kết quả cũ.
-- Cùng khoá + KHÁC vân tay = hai yêu cầu khác nhau dùng chung khoá, phải báo xung đột.
CREATE TABLE IF NOT EXISTS wallet_entries (
  id TEXT PRIMARY KEY,
  wallet_id TEXT NOT NULL REFERENCES wallets(id),
  transaction_id TEXT REFERENCES transactions(id),
  request_id TEXT NOT NULL,
  entry_type TEXT NOT NULL CHECK (entry_type IN
    ('DEMO_TOPUP','TOPUP_CREDIT','ESCROW_LOCK_DEBIT','ESCROW_LOCK_CREDIT','ESCROW_RELEASE_DEBIT',
     'ESCROW_RELEASE_CREDIT','ESCROW_REFUND_DEBIT','ESCROW_REFUND_CREDIT')),
  available_delta INTEGER NOT NULL DEFAULT 0,
  locked_delta INTEGER NOT NULL DEFAULT 0,
  available_after INTEGER NOT NULL CHECK (available_after >= 0),
  locked_after INTEGER NOT NULL CHECK (locked_after >= 0),
  idempotency_key TEXT NOT NULL UNIQUE,
  request_fingerprint TEXT,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (available_delta <> 0 OR locked_delta <> 0)
);

CREATE INDEX IF NOT EXISTS idx_wallet_entries_wallet ON wallet_entries(wallet_id, created_at);
CREATE INDEX IF NOT EXISTS idx_wallet_entries_transaction ON wallet_entries(transaction_id, created_at);
CREATE INDEX IF NOT EXISTS idx_wallet_entries_request ON wallet_entries(request_id);

-- context_hash = SHA-256 của "ngữ cảnh uỷ quyền" (mã giao dịch, hai bên, số tiền, hành
-- động) mà người dùng đã ký bằng passkey. Lúc giải ngân, server dựng lại ngữ cảnh từ dữ
-- liệu HIỆN TẠI rồi so với giá trị này; nếu số tiền hay người nhận bị đổi sau khi ký thì
-- hai giá trị lệch nhau và lệnh bị chặn.
--
-- action phân biệt bốn loại uỷ quyền, đúng bốn thao tác nhạy cảm của hệ thống:
--   RELEASE_ESCROW     người mua xác nhận hàng đúng mô tả và giải ngân
--   ADJUDICATE         quản trị viên phân xử tranh chấp (hoàn tiền hoặc giải ngân)
--   MANAGE_CREDENTIAL  thêm hoặc xoá một Passkey
--   CHANGE_PASSWORD    đổi mật khẩu
--
-- Ba thao tác sau cũng đòi xác thực lại vì mô hình đe doạ thừa nhận mã phiên có thể bị
-- đánh cắp: nếu chỉ cần đang đăng nhập là thêm được passkey hoặc đặt lại mật khẩu thì kẻ
-- chiếm phiên sẽ tự biến nó thành quyền truy cập lâu dài.
--
-- decision là cột quyết định tính đúng đắn của luồng phân xử. Nếu phiếu chỉ ràng buộc tới
-- hồ sơ tranh chấp mà bỏ trống quyết định, quản trị viên có thể xác thực trong lúc màn hình
-- hiển thị "hoàn tiền cho người mua" còn yêu cầu gửi lên lại mang "giải ngân cho người bán",
-- và máy chủ vẫn chấp nhận vì phiếu hợp lệ. Khi đó lần xác thực lại chỉ chứng minh quản trị
-- viên CÓ MẶT, không chứng minh quản trị viên đã CHẤP THUẬN điều gì.
-- Phiên đăng nhập phía máy chủ. JWT mang `sid` trỏ vào đây, nên đăng xuất, đổi mật khẩu
-- hay quá hạn nhàn rỗi thu hồi được phiên ngay lập tức thay vì chờ JWT tự hết hạn.
-- refresh_hash là SHA-256 của mã làm mới nằm trong cookie HttpOnly; mã gốc không lưu.
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS reauth_grants (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT,
  transaction_id TEXT REFERENCES transactions(id) ON DELETE CASCADE,
  dispute_id TEXT REFERENCES disputes(id) ON DELETE CASCADE,
  action TEXT NOT NULL DEFAULT 'RELEASE_ESCROW'
    CHECK (action IN ('RELEASE_ESCROW','ADJUDICATE','MANAGE_CREDENTIAL','CHANGE_PASSWORD')),
  decision TEXT CHECK (decision IS NULL OR decision IN ('REFUND','RELEASE')),
  token_hash TEXT NOT NULL UNIQUE,
  context_hash TEXT,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (action <> 'RELEASE_ESCROW' OR (transaction_id IS NOT NULL AND decision IS NULL)),
  CHECK (action <> 'ADJUDICATE'
         OR (transaction_id IS NOT NULL AND dispute_id IS NOT NULL AND decision IS NOT NULL)),
  CHECK (action NOT IN ('MANAGE_CREDENTIAL','CHANGE_PASSWORD')
         OR (transaction_id IS NULL AND dispute_id IS NULL AND decision IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_reauth_grants_lookup ON reauth_grants(user_id, transaction_id, expires_at);

CREATE TABLE IF NOT EXISTS disputes (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL UNIQUE REFERENCES transactions(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED_REFUND','RESOLVED_RELEASE')),
  admin_id TEXT REFERENCES users(id),
  admin_decision TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_disputes_status ON disputes(status);

-- sequence_no đánh số bản ghi trong phạm vi từng giao dịch, bắt đầu từ 1.
-- Nhờ nó, việc CHÈN hoặc XOÁ một bản ghi ở giữa chuỗi bị phát hiện ngay cả khi kẻ can
-- thiệp đã tính lại liên kết băm cho phần còn lại. UNIQUE(transaction_id, sequence_no)
-- đẩy ràng buộc "không có hai bản ghi cùng số thứ tự" xuống tận cơ sở dữ liệu.
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  sequence_no INTEGER NOT NULL,
  actor_id TEXT REFERENCES users(id),
  action TEXT NOT NULL,
  old_status TEXT,
  new_status TEXT,
  event_data TEXT NOT NULL DEFAULT '{}',
  previous_hash TEXT NOT NULL,
  current_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (transaction_id, sequence_no)
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_transaction ON audit_logs(transaction_id, sequence_no);

-- Thông báo cho người dùng.
--
-- Thông báo CHỈ PHẢN ÁNH trạng thái, không bao giờ làm thay đổi trạng thái: được ghi SAU KHI
-- giao dịch cơ sở dữ liệu của nghiệp vụ đã commit, và ghi hỏng thì nghiệp vụ vẫn thành công
-- (xem lib/notifications.js). Danh sách "Việc cần xử lý" cũng không đọc từ bảng này mà tính
-- thẳng từ trạng thái giao dịch — mất một thông báo không làm mất một việc cần làm.
--
-- dedupe_key UNIQUE: cùng một sự kiện cho cùng một người chỉ sinh đúng một thông báo, kể cả
-- khi đoạn mã phát thông báo vô tình chạy hai lần.
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  transaction_id TEXT REFERENCES transactions(id) ON DELETE CASCADE,
  payment_request_id TEXT REFERENCES payment_requests(id) ON DELETE CASCADE,
  dedupe_key TEXT NOT NULL UNIQUE,
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at DESC);

-- Nhật ký sự kiện an toàn, TÁCH RIÊNG khỏi audit_logs.
--
-- Hai bảng trả lời hai câu hỏi khác nhau và phải tách ra:
--   audit_logs      "giao dịch này đã đi qua những trạng thái nào, do ai" — chuỗi băm móc
--                   xích theo từng giao dịch, dùng làm căn cứ khi tranh chấp.
--   security_events "ai đã thử làm gì mà bị từ chối" — phần lớn sự kiện ở đây KHÔNG gắn với
--                   giao dịch nào (đăng nhập sai, phiếu hết hạn, sai origin), nên nhét chung
--                   vào chuỗi băm của một giao dịch là sai chỗ và làm hỏng ý nghĩa của chuỗi.
--
-- Cột detail chỉ chứa dữ liệu ĐÃ ĐƯỢC CHỌN LỌC ở tầng ứng dụng. Không bao giờ ghi mật khẩu,
-- mã phiên, phiếu uỷ quyền hay giá trị challenge vào đây: kho nhật ký thường có chính sách
-- sao lưu rộng và quyền đọc lỏng hơn dữ liệu nghiệp vụ, ghi thiếu cân nhắc là tự tạo thêm
-- một kênh rò rỉ.
CREATE TABLE IF NOT EXISTS security_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('DENIED','ALLOWED')),
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  username TEXT,                        -- với đăng nhập thất bại thì chưa xác định được actor_id
  ip TEXT,
  method TEXT,
  route TEXT,
  status_code INTEGER,
  detail TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_security_events_time ON security_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_events_type ON security_events(event_type, created_at DESC);
