const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { SqliteAsyncDatabase, PgAsyncDatabase, PG_LOCK_KEY } = require('./lib/asyncDb');
const { normalizeSettledListingsSql } = require('./lib/listingNormalize');

function logListingNormalization(sold, reopened) {
  if (sold || reopened) {
    console.log(`[migrate] listings: chuẩn hoá ${sold} tin đăng đã bán -> SOLD, ${reopened} tin đăng đã hoàn tiền -> AVAILABLE.`);
  }
}

// Chọn nền lưu trữ:
//
//   DATABASE_URL có giá trị -> PostgreSQL (Supabase khi triển khai, PostgreSQL cục bộ khi kiểm thử)
//   không có                -> SQLite tại DB_PATH (máy dev, và bản Render cũ cho tới khi chuyển xong)
//
// Cả hai đều đi qua cùng một API bất đồng bộ (lib/asyncDb.js), nên route và nghiệp vụ không biết
// mình đang chạy trên nền nào. SQLite KHÔNG bị xoá: kế hoạch chuyển đổi yêu cầu giữ nó cho tới khi
// toàn bộ bộ kiểm thử đạt trên PostgreSQL.
const PROJECT_ROOT = path.join(__dirname, '..');
const DATABASE_URL = process.env.DATABASE_URL || '';
const DIALECT = DATABASE_URL ? 'pg' : 'sqlite';

// DB_PATH chọn file cơ sở dữ liệu SQLite, để tách hẳn ba môi trường: dev, test tự động và
// demo/thực nghiệm (xem .env.test, .env.experiment). Đường dẫn tương đối tính từ gốc dự án,
// không tính từ thư mục đang đứng, để chạy lệnh ở đâu cũng trỏ đúng một file.
const DB_PATH = DIALECT === 'sqlite'
  ? (process.env.DB_PATH
    ? path.resolve(PROJECT_ROOT, process.env.DB_PATH)
    : path.join(PROJECT_ROOT, 'data', 'escrow.db'))
  : null;

function uuid() {
  return crypto.randomUUID();
}

function nowIso() {
  return new Date().toISOString();
}

/** Mô tả nơi lưu dữ liệu để in ra log — KHÔNG bao giờ in mật khẩu trong chuỗi kết nối. */
function describeDatabase() {
  if (DIALECT === 'sqlite') return `SQLite ${DB_PATH}`;
  try {
    const u = new URL(DATABASE_URL);
    return `PostgreSQL ${u.hostname}${u.port ? `:${u.port}` : ''}${u.pathname}`;
  } catch (_) {
    return 'PostgreSQL';
  }
}

// =========================================================================================
// SQLite
// =========================================================================================
function openSqlite() {
  const Database = require('./lib/sqlite');
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
        // Khoá chống lặp và trạng thái bước gửi sang provider (xem schema.sql). Yêu cầu cũ mặc định
        // SUBMITTED; nếu thật ra provider không có bản ghi, worker đối soát tự phát hiện và gửi lại.
        ['client_request_id', 'TEXT'],
        ['submission_status', "TEXT NOT NULL DEFAULT 'SUBMITTED' CHECK (submission_status IN ('SUBMITTING','SUBMITTED','SUBMIT_FAILED'))"],
        ['submit_attempts', 'INTEGER NOT NULL DEFAULT 0'],
        ['last_submit_error', 'TEXT'],
      ].filter(([name]) => !paymentCols.has(name));
      for (const [name, type] of add) db.exec(`ALTER TABLE payment_requests ADD COLUMN ${name} ${type}`);
      if (add.length) console.log(`[migrate] payment_requests: đã thêm cột ${add.map(([n]) => n).join(', ')}.`);
      db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS ux_payment_requests_client_request
         ON payment_requests(user_id, client_request_id) WHERE client_request_id IS NOT NULL`
      );
    }

    // Phiếu uỷ quyền gắn với phiên đã xác thực lại; cột cho phép NULL nên thêm bằng ALTER TABLE.
    const grantColsNow = new Set(db.prepare('PRAGMA table_info(reauth_grants)').all().map((c) => c.name));
    if (grantColsNow.size > 0 && !grantColsNow.has('session_id')) {
      db.exec('ALTER TABLE reauth_grants ADD COLUMN session_id TEXT');
      console.log('[migrate] reauth_grants: đã thêm cột session_id.');
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

    normalizeSettledListings();
  }

  // Tin đăng còn kẹt LOCKED dù giao dịch đã tất toán (dữ liệu tạo trước lib/listingLifecycle.js).
  // Chạy ở mọi lần khởi động; xem lib/listingNormalize.js.
  function normalizeSettledListings() {
    const sql = normalizeSettledListingsSql('', `strftime('%Y-%m-%dT%H:%M:%fZ','now')`);
    db.transaction(() => {
      const sold = db.prepare(sql.sold).run();
      const reopened = db.prepare(sql.reopened).run();
      logListingNormalization(sold.changes, reopened.changes);
    })();
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
  // Nguồn gốc quyền quản trị: bảng + backfill một lần, trigger ở mọi lần khởi động.
  // Đặt ở đây chứ không ở schema.sql để backfill chỉ chạy đúng lúc bảng được tạo lần đầu.
  require('./lib/adminProvenance').migrateSqlite(db);

  // Seed: chỉ ví SYSTEM_ESCROW duy nhất (lý do không seed Admin: xem ghi chú cuối tệp).
  const existingEscrow = db.prepare("SELECT id FROM wallets WHERE wallet_type = 'SYSTEM_ESCROW'").get();
  if (!existingEscrow) {
    db.prepare(
      `INSERT INTO wallets (id, user_id, wallet_type, available_balance, locked_balance)
       VALUES (?, NULL, 'SYSTEM_ESCROW', 0, 0)`
    ).run(uuid());
    console.log('[seed] Đã tạo ví hệ thống SYSTEM_ESCROW.');
  }

  return new SqliteAsyncDatabase(db);
}

// =========================================================================================
// PostgreSQL
// =========================================================================================

// Migration có phiên bản. Mỗi phần tử chạy đúng một lần, trong một giao dịch, và được ghi vào
// app.schema_migrations. Thêm thay đổi lược đồ về sau = thêm một phần tử mới vào CUỐI mảng,
// không bao giờ sửa phần tử đã chạy trên cơ sở dữ liệu thật.
const PG_MIGRATIONS = [
  { version: 1, name: 'initial-schema', file: 'schema.pg.sql' },
  // Số 2: admin-provenance (xem lib/adminProvenance.js). Số 3: yêu cầu nạp tiền chống lặp.
  // Runner áp đúng số chưa có, theo thứ tự mảng; không đánh số lại migration đã áp.
  { version: 2, name: 'admin-provenance', file: 'schema.pg.002-admin-provenance.sql' },
  { version: 3, name: 'topup-request-idempotency', file: 'schema.pg.003-topup-idempotency.sql' },
];

function installPgTypeParsers(pg) {
  // BIGINT (20) và NUMERIC (1700 — kết quả của SUM) mặc định được trả về dạng chuỗi để không mất
  // chính xác. Tiền trong hệ thống là số nguyên đồng và đã bị chặn trên ở tầng nhập liệu, nên đổi
  // về Number là đúng — nhưng TỪ CHỐI hẳn giá trị vượt ngưỡng an toàn thay vì làm tròn im lặng.
  const toSafeNumber = (v) => {
    if (v === null) return null;
    const n = Number(v);
    if (!Number.isFinite(n) || (Number.isInteger(n) && !Number.isSafeInteger(n))) {
      throw new Error(`Giá trị số ${v} vượt ngưỡng số nguyên an toàn của JavaScript`);
    }
    return n;
  };
  pg.types.setTypeParser(20, toSafeNumber);
  pg.types.setTypeParser(1700, toSafeNumber);
}

function openPg() {
  const pg = require('pg');
  installPgTypeParsers(pg);

  // Supabase (và hầu hết PostgreSQL được quản lý) bắt buộc TLS. Chứng chỉ của Supabase pooler
  // không nằm trong kho CA mặc định của Node, nên chỉ mã hoá chứ không kiểm chuỗi chứng chỉ —
  // đúng cấu hình mà tài liệu kế hoạch nêu. PGSSL=disable dùng cho PostgreSQL cục bộ.
  const sslOff = process.env.PGSSL === 'disable' || /sslmode=disable/.test(DATABASE_URL);
  const pool = new pg.Pool({
    connectionString: DATABASE_URL,
    ssl: sslOff ? false : { rejectUnauthorized: false },
    max: parseInt(process.env.PG_POOL_MAX || '10', 10),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    // Script và bộ kiểm thử tự thoát khi hết việc, không bị pool giữ process sống mãi.
    allowExitOnIdle: true,
  });

  // Mọi bảng nằm ở schema `app` (xem schema.pg.sql). Đặt search_path cho từng kết nối mới, nên SQL
  // trong mã vẫn viết `FROM users` như bản SQLite. Lệnh SET được xếp hàng TRƯỚC mọi truy vấn khác
  // trên kết nối đó, vì client của pg chạy truy vấn đúng thứ tự gửi.
  pool.on('connect', (client) => {
    client.query('SET search_path TO app, public').catch(() => {});
  });
  pool.on('error', (err) => {
    // Kết nối nhàn rỗi bị máy chủ đóng (Supabase khởi động lại, mạng chập chờn). Pool tự bỏ kết
    // nối hỏng; chỉ ghi lại để không làm sập process.
    console.error('[db] kết nối PostgreSQL nhàn rỗi bị đóng:', err.message);
  });

  const ready = (async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Hai tiến trình khởi động cùng lúc (hai bản Railway, hoặc máy chủ + script) không được
      // cùng chạy migration: cùng khoá với khoá của giao dịch nghiệp vụ.
      await client.query('SELECT pg_advisory_xact_lock($1)', [PG_LOCK_KEY]);
      await client.query('CREATE SCHEMA IF NOT EXISTS app');
      await client.query(
        `CREATE TABLE IF NOT EXISTS app.schema_migrations (
           version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`
      );
      const done = new Set((await client.query('SELECT version FROM app.schema_migrations')).rows.map((r) => r.version));
      for (const m of PG_MIGRATIONS) {
        if (done.has(m.version)) continue;
        await client.query(fs.readFileSync(path.join(__dirname, m.file), 'utf8'));
        await client.query('INSERT INTO app.schema_migrations (version, name, applied_at) VALUES ($1, $2, $3)', [
          m.version, m.name, nowIso(),
        ]);
        console.log(`[migrate] PostgreSQL: đã áp migration ${m.version} (${m.name}).`);
      }
      const seeded = await client.query(
        `INSERT INTO app.wallets (id, user_id, wallet_type, available_balance, locked_balance)
         VALUES ($1, NULL, 'SYSTEM_ESCROW', 0, 0)
         ON CONFLICT DO NOTHING`,
        [uuid()]
      );
      if (seeded.rowCount === 1) console.log('[seed] Đã tạo ví hệ thống SYSTEM_ESCROW.');
      // Không phải migration có phiên bản: chạy ở MỌI lần khởi động, giống bản SQLite (xem
      // lib/listingNormalize.js — hai câu lệnh có điều kiện, chạy lại không đổi gì).
      const sql = normalizeSettledListingsSql('app.', 'app.now_iso()');
      const sold = await client.query(sql.sold);
      const reopened = await client.query(sql.reopened);
      logListingNormalization(sold.rowCount, reopened.rowCount);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  })();
  // Chặn cảnh báo unhandled rejection: lỗi khởi tạo vẫn được ném lại cho mọi câu lệnh chờ `ready`.
  ready.catch(() => {});

  return new PgAsyncDatabase(pool, { ready });
}

// KHÔNG seed sẵn tài khoản Admin. Quản trị viên đầu tiên được tạo bằng thủ tục vận hành
// `npm run seed:admin -- --username=<tên>` chạy trực tiếp trên máy chủ (xem scripts/seed-admin.js),
// hoặc bằng biến môi trường ADMIN_BOOTSTRAP_* lúc khởi động (xem server.js). Không có điểm cuối
// HTTP nào cấp được quyền quản trị.
const db = DIALECT === 'pg' ? openPg() : openSqlite();

module.exports = { db, uuid, nowIso, DB_PATH, DIALECT, describeDatabase };
