const path = require('path');
const fs = require('fs');
const Database = require('./lib/sqlite');
const crypto = require('crypto');

// DB_PATH chọn file cơ sở dữ liệu, để tách hẳn ba môi trường: dev, test tự động và
// demo/thực nghiệm (xem .env.test, .env.experiment). Đường dẫn tương đối tính từ gốc dự án,
// không tính từ thư mục đang đứng, để chạy lệnh ở đâu cũng trỏ đúng một file.
const PROJECT_ROOT = path.join(__dirname, '..');
const DB_PATH = process.env.DB_PATH
  ? path.resolve(PROJECT_ROOT, process.env.DB_PATH)
  : path.join(PROJECT_ROOT, 'data', 'escrow.db');
const DATA_DIR = path.dirname(DB_PATH);
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Chuyển sang mô hình xác thực LAI cũng là một thay đổi không vá được tại chỗ.
//
// Mọi tài khoản từ nay bắt buộc có mật khẩu (users.password_hash NOT NULL) và một trạng
// thái vòng đời (account_status). Cơ sở dữ liệu cũ chứa các tài khoản chỉ có Passkey, tức
// là không có giá trị nào hợp lệ để điền vào password_hash — đặt một giá trị giả sẽ tạo ra
// đúng thứ mà mô hình lai muốn tránh: tài khoản có lối vào mà không ai biết trạng thái thật
// của nó. Vì vậy cơ sở dữ liệu cũ được ĐỔI TÊN giữ lại làm bản lưu rồi tạo mới từ đầu.
//
// Điều này khớp với quy trình thực nghiệm: mỗi lần đổi lược đồ thì reset và chạy lại toàn
// bộ testcase, không trộn dữ liệu của hai mô hình vào cùng một lần đo.
function archivePasswordlessDatabase() {
  if (!fs.existsSync(DB_PATH)) return;

  let looksPasswordless = false;
  const probe = new Database(DB_PATH);
  try {
    const cols = probe.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
    looksPasswordless = cols.length > 0 && !cols.includes('password_hash');
  } catch (_) {
    looksPasswordless = false;
  } finally {
    probe.close();
  }
  if (!looksPasswordless) return;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const suffix of ['', '-wal', '-shm']) {
    const src = DB_PATH + suffix;
    if (fs.existsSync(src)) fs.renameSync(src, `${DB_PATH}.chi-passkey-${stamp}${suffix}`);
  }
  console.log(`[migrate] Cơ sở dữ liệu theo mô hình chỉ dùng Passkey đã được giữ lại tại escrow.db.chi-passkey-${stamp}.`);
  console.log('[migrate] Đã tạo cơ sở dữ liệu mới theo mô hình xác thực lai.');
}

archivePasswordlessDatabase();

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
// Process khác đang giữ khoá ghi thì chờ tối đa 5 giây thay vì báo "database is locked" ngay.
db.pragma('busy_timeout = 5000');

const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schemaSql);

// Migration nhẹ cho các DB đã theo mô hình mua bán nhưng tạo trước khi bổ sung hai cột
// phục vụ chống lặp và chống can thiệp nhật ký. CREATE TABLE IF NOT EXISTS không đụng
// tới bảng đã tồn tại nên phải thêm bằng ALTER TABLE.
function migrate() {
  const entryCols = new Set(db.prepare('PRAGMA table_info(wallet_entries)').all().map((c) => c.name));
  if (entryCols.size > 0 && !entryCols.has('request_fingerprint')) {
    db.exec('ALTER TABLE wallet_entries ADD COLUMN request_fingerprint TEXT');
    console.log('[migrate] Đã thêm cột request_fingerprint vào wallet_entries.');
  }

  const logCols = new Set(db.prepare('PRAGMA table_info(audit_logs)').all().map((c) => c.name));
  if (logCols.size > 0 && !logCols.has('sequence_no')) {
    // Không thể thêm cột NOT NULL kèm UNIQUE bằng ALTER TABLE, nên bảng cũ chỉ được
    // đánh số bổ sung; ràng buộc duy nhất chỉ có ở cơ sở dữ liệu tạo mới.
    db.exec('ALTER TABLE audit_logs ADD COLUMN sequence_no INTEGER NOT NULL DEFAULT 0');
    db.exec(`
      UPDATE audit_logs SET sequence_no = (
        SELECT COUNT(*) FROM audit_logs older
        WHERE older.transaction_id = audit_logs.transaction_id AND older.id <= audit_logs.id
      )
    `);
    console.log('[migrate] Đã thêm cột sequence_no vào audit_logs và đánh số lại chuỗi nhật ký.');
  }

  // Phiếu uỷ quyền của mô hình lai mang thêm dispute_id và decision, đồng thời nới tập giá
  // trị hợp lệ của action. SQLite không sửa được ràng buộc CHECK bằng ALTER TABLE, nên bảng
  // được dựng lại. Không cần chép dữ liệu cũ sang: phiếu chỉ sống đúng REAUTH_TTL_SECONDS
  // (mặc định 120 giây) và cố ý dùng một lần, nên một phiếu tồn tại qua lần khởi động lại
  // máy chủ đằng nào cũng đã hết hạn.
  const grantCols = new Set(db.prepare('PRAGMA table_info(reauth_grants)').all().map((c) => c.name));
  if (grantCols.size > 0 && !grantCols.has('decision')) {
    db.exec('DROP TABLE reauth_grants');
    db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
    console.log('[migrate] Đã dựng lại reauth_grants với dispute_id và decision (phiếu cũ đều đã hết hạn).');
  }

  // wallet_entries.entry_type nới thêm TOPUP_CREDIT (nạp tiền qua Mock Payment Provider).
  // SQLite không sửa được CHECK bằng ALTER TABLE, nên bảng ledger — KHÔNG được phép mất dữ
  // liệu — phải dựng lại đúng khuôn mẫu migratePasskeyCredentials(): tạo bảng mới, chép
  // NGUYÊN VẸN toàn bộ dữ liệu cũ, đổi tên. Phát hiện bằng cách đọc thẳng câu SQL đã tạo
  // bảng trong sqlite_master, vì PRAGMA table_info không lộ nội dung ràng buộc CHECK.
  const walletEntriesDdl = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'wallet_entries'`)
    .get();
  if (walletEntriesDdl && !walletEntriesDdl.sql.includes('TOPUP_CREDIT')) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE wallet_entries_new (
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
        )
      `);
      db.exec(`
        INSERT INTO wallet_entries_new
          (id, wallet_id, transaction_id, request_id, entry_type, available_delta, locked_delta,
           available_after, locked_after, idempotency_key, request_fingerprint, description, created_at)
        SELECT id, wallet_id, transaction_id, request_id, entry_type, available_delta, locked_delta,
               available_after, locked_after, idempotency_key, request_fingerprint, description, created_at
        FROM wallet_entries
      `);
      db.exec('DROP TABLE wallet_entries');
      db.exec('ALTER TABLE wallet_entries_new RENAME TO wallet_entries');
      db.exec('CREATE INDEX IF NOT EXISTS idx_wallet_entries_wallet ON wallet_entries(wallet_id, created_at)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_wallet_entries_transaction ON wallet_entries(transaction_id, created_at)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_wallet_entries_request ON wallet_entries(request_id)');
    })();
    console.log('[migrate] wallet_entries: đã thêm TOPUP_CREDIT vào entry_type (dữ liệu cũ được giữ nguyên).');
  }

  // payment_requests nhận thêm vết vận hành của worker đối soát. Thêm cột rời bằng ALTER TABLE
  // là đủ (không đổi ràng buộc cũ); ràng buộc CHECK của resolved_by chỉ có ở DB tạo mới.
  const paymentCols = new Set(db.prepare('PRAGMA table_info(payment_requests)').all().map((c) => c.name));
  if (paymentCols.size > 0) {
    const add = [
      ['resolved_by', 'TEXT'],
      ['reconcile_attempts', 'INTEGER NOT NULL DEFAULT 0'],
      ['last_reconciled_at', 'TEXT'],
      ['last_reconcile_error', 'TEXT'],
    ].filter(([name]) => !paymentCols.has(name));
    for (const [name, type] of add) db.exec(`ALTER TABLE payment_requests ADD COLUMN ${name} ${type}`);
    if (add.length) console.log(`[migrate] payment_requests: đã thêm cột ${add.map(([n]) => n).join(', ')}.`);
  }

  const txnCols = new Set(db.prepare('PRAGMA table_info(transactions)').all().map((c) => c.name));
  if (txnCols.size > 0 && !txnCols.has('seller_ack_at')) {
    db.exec('ALTER TABLE transactions ADD COLUMN seller_ack_at TEXT');
    console.log('[migrate] transactions: đã thêm cột seller_ack_at.');
  }

  // listings.location (khu vực giao nhận) — thêm cho cơ sở dữ liệu tạo trước khi có cột này.
  const listingColsForLocation = new Set(db.prepare('PRAGMA table_info(listings)').all().map((c) => c.name));
  if (listingColsForLocation.size > 0 && !listingColsForLocation.has('location')) {
    db.exec('ALTER TABLE listings ADD COLUMN location TEXT');
    console.log('[migrate] listings: đã thêm cột location.');
  }

  // listings.status là hàng rào concurrency chính cho LOCK (xem schema.sql). ALTER TABLE
  // của SQLite không gắn được CHECK constraint cho cột thêm sau, nhưng ứng dụng chỉ bao giờ
  // ghi 'AVAILABLE'/'LOCKED'/'SOLD' vào cột này nên không cần dựng lại bảng.
  const listingCols = new Set(db.prepare('PRAGMA table_info(listings)').all().map((c) => c.name));
  if (listingCols.size > 0 && !listingCols.has('status')) {
    db.exec("ALTER TABLE listings ADD COLUMN status TEXT NOT NULL DEFAULT 'AVAILABLE'");
    // Suy lại status cho dữ liệu cũ từ đúng nguồn mà cơ chế trước đây dùng (transactions
    // đang giữ chỗ), để không có tin đăng nào ĐÃ có đơn giữ chỗ/đã bán mà lại mang
    // status=AVAILABLE ngay sau khi migrate.
    const { RESERVING_STATUSES } = require('./lib/catalog');
    const placeholders = RESERVING_STATUSES.map(() => '?').join(',');
    db.prepare(
      `UPDATE listings SET status = 'LOCKED' WHERE id IN (
         SELECT DISTINCT listing_id FROM transactions
         WHERE listing_id IS NOT NULL AND status IN (${placeholders})
       )`
    ).run(...RESERVING_STATUSES);
    console.log('[migrate] Đã thêm cột status vào listings (AVAILABLE mặc định, LOCKED cho tin đăng đã có đơn giữ chỗ/đã bán).');
  }
}

// Nâng cấp passkey_credentials: bỏ UNIQUE trên user_id (cho phép nhiều thiết bị/tài khoản)
// và thêm cột device_name.
//
// SQLite không có ALTER TABLE DROP CONSTRAINT, nên cách duy nhất là dựng bảng mới rồi
// chép dữ liệu sang. Phải tắt foreign_keys trong lúc làm, vì DROP TABLE bảng cũ sẽ kích
// hoạt ON DELETE CASCADE và cuốn theo dữ liệu ở nơi khác. Pragma foreign_keys không có
// tác dụng bên trong transaction nên đoạn này cố tình chạy ngoài transaction.
function migratePasskeyCredentials() {
  const cols = db.prepare('PRAGMA table_info(passkey_credentials)').all();
  if (cols.length === 0) return; // bảng chưa tồn tại, schema.sql vừa tạo bản mới rồi

  const hasDeviceName = cols.some((c) => c.name === 'device_name');
  const userIdIsUnique = db
    .prepare('PRAGMA index_list(passkey_credentials)')
    .all()
    .filter((idx) => idx.unique)
    .some((idx) => {
      const parts = db.prepare(`PRAGMA index_info("${idx.name}")`).all();
      return parts.length === 1 && parts[0].name === 'user_id';
    });

  if (hasDeviceName && !userIdIsUnique) return; // đã ở dạng mới

  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE passkey_credentials_new (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          credential_id TEXT NOT NULL UNIQUE,
          public_key BLOB NOT NULL,
          counter INTEGER NOT NULL DEFAULT 0,
          transports TEXT,
          device_name TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          last_used_at TEXT
        )
      `);
      db.exec(`
        INSERT INTO passkey_credentials_new
          (id, user_id, credential_id, public_key, counter, transports, device_name, created_at, last_used_at)
        SELECT id, user_id, credential_id, public_key, counter, transports,
               ${hasDeviceName ? 'device_name' : `'Thiết bị đầu tiên'`}, created_at, last_used_at
        FROM passkey_credentials
      `);
      db.exec('DROP TABLE passkey_credentials');
      db.exec('ALTER TABLE passkey_credentials_new RENAME TO passkey_credentials');
      db.exec('CREATE INDEX IF NOT EXISTS idx_passkey_credentials_user ON passkey_credentials(user_id)');
    })();
    console.log('[migrate] passkey_credentials: đã bỏ UNIQUE(user_id) — một tài khoản dùng được nhiều thiết bị.');
  } finally {
    db.pragma('foreign_keys = ON');
  }

  const broken = db.pragma('foreign_key_check');
  if (broken.length > 0) {
    throw new Error(`[migrate] Khoá ngoại hỏng sau khi dựng lại passkey_credentials: ${JSON.stringify(broken)}`);
  }
}

migrate();
migratePasskeyCredentials();

function uuid() {
  return crypto.randomUUID();
}

function nowIso() {
  return new Date().toISOString();
}

// Seed: chỉ ví SYSTEM_ESCROW duy nhất.
//
// KHÔNG seed sẵn tài khoản Admin. Quản trị viên đầu tiên được tạo bằng thủ tục vận hành
// `npm run seed:admin -- --username=<tên>` chạy trực tiếp trên máy chủ (xem scripts/seed-admin.js).
// Người đó đăng ký qua đúng form chung như mọi người và nhận tài khoản người mua, sau đó script
// nâng quyền tại chỗ. Không có điểm cuối HTTP nào cấp được quyền quản trị.
function seed() {
  const existingEscrow = db.prepare("SELECT id FROM wallets WHERE wallet_type = 'SYSTEM_ESCROW'").get();
  if (!existingEscrow) {
    db.prepare(
      `INSERT INTO wallets (id, user_id, wallet_type, available_balance, locked_balance)
       VALUES (?, NULL, 'SYSTEM_ESCROW', 0, 0)`
    ).run(uuid());
    console.log('[seed] Đã tạo ví hệ thống SYSTEM_ESCROW.');
  }
}

seed();

module.exports = { db, uuid, nowIso, DB_PATH };
