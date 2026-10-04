// Nguồn gốc của quyền quản trị — bằng chứng bền vững, ĐỘC LẬP với cột users.role.
//
// Vì sao cần: role chỉ là một cột văn bản. Một lỗi ở bất kỳ đâu (câu UPDATE sai điều kiện, một
// script vận hành, một thao tác tay trên CSDL) đổi được nó thành 'ADMIN'. PR #13 thêm dấu hiệu
// "tài khoản có ví USER thì không phải admin", nhưng dấu hiệu đó không bao được tài khoản CHƯA có
// ví: tài khoản mua đang PENDING_PASSKEY bị sửa role='ADMIN' rồi hoàn tất Passkey thì bước kích
// hoạt bỏ qua việc mở ví (vì role=ADMIN), và thành một "quản trị viên" không ví.
//
// Mô hình: một tài khoản chỉ được coi là ADMIN khi role='ADMIN' VÀ có một dòng admin_provenance.
// Dòng đó chỉ sinh ra ở đúng hai chỗ:
//   - createBootstrapAdmin() (CLI `npm run seed:admin` / biến môi trường ADMIN_BOOTSTRAP_*), trong
//     CÙNG giao dịch với lệnh tạo tài khoản;
//   - lần migration tạo bảng (LEGACY_BACKFILL), chạy ĐÚNG MỘT LẦN cho cơ sở dữ liệu có từ trước.
//
// Ràng buộc ở CSDL (trigger, cả SQLite lẫn PostgreSQL) chặn ba đường giả mạo phổ biến:
//   - UPDATE users đổi role sang 'ADMIN'                          -> ADMIN_PROMOTION_FORBIDDEN
//   - INSERT users role='ADMIN' mà không ở PENDING_BOOTSTRAP       -> ADMIN_PROMOTION_FORBIDDEN
//   - INSERT admin_provenance cho tài khoản không phải admin bootstrap vừa tạo (role ADMIN,
//     PENDING_BOOTSTRAP, chưa có ví), hoặc với nguồn LEGACY_BACKFILL -> ADMIN_PROVENANCE_FORBIDDEN
//   - UPDATE admin_provenance                                      -> ADMIN_PROVENANCE_IMMUTABLE
// Trigger là lớp thứ nhất; lớp kiểm lúc chạy (lib/auth.js, routes/admin.js) vẫn tự đứng vững nếu
// trigger bị gỡ. Giới hạn phải nói rõ: người có toàn quyền ghi CSDL vẫn tự chèn được một tài khoản
// PENDING_BOOTSTRAP kèm dòng nguồn gốc — lớp này chặn LỖI LOGIC và thao tác sửa role, không thay
// thế việc bảo vệ quyền truy cập trực tiếp vào CSDL.

const SOURCES = ['BOOTSTRAP_CLI', 'BOOTSTRAP_ENV', 'LEGACY_BACKFILL'];

// Giá trị role NỘI BỘ gán cho req.user khi users.role='ADMIN' nhưng không có nguồn gốc hợp lệ.
// Không trùng vai trò nào, nên mọi phép kiểm `role === 'ADMIN'` / requireRole('ADMIN') hiện có và
// về sau đều tự từ chối (fail-closed). Không bao giờ ghi vào CSDL hay trả ra API.
const UNVERIFIED_ADMIN_ROLE = 'ADMIN_UNVERIFIED';

const quoted = (list) => list.map((s) => `'${s}'`).join(',');

// Backfill: ADMIN có từ trước khi có bảng và KHÔNG có ví USER. Kiểm toán cho thấy không API nào
// từng tạo được ADMIN ngoài bootstrap, nên ADMIN không ví ở thời điểm migration được coi là hợp lệ;
// ADMIN có ví USER là dấu hiệu bị nâng quyền (PR #13) nên bị loại.
function backfillSql(schema, nowExpr) {
  return `
    INSERT INTO ${schema}admin_provenance (user_id, source, username_at_grant, granted_at)
    SELECT u.id, 'LEGACY_BACKFILL', u.username, ${nowExpr}
    FROM ${schema}users u
    WHERE u.role = 'ADMIN'
      AND NOT EXISTS (SELECT 1 FROM ${schema}wallets w WHERE w.user_id = u.id AND w.wallet_type = 'USER')`;
}

const SQLITE_TABLE = `
  CREATE TABLE admin_provenance (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    source TEXT NOT NULL CHECK (source IN (${quoted(SOURCES)})),
    username_at_grant TEXT NOT NULL,
    granted_at TEXT NOT NULL
  )`;

// CREATE TRIGGER IF NOT EXISTS: db.js chạy lại ở mỗi lần khởi động, nên trigger bị gỡ sẽ tự có lại.
const SQLITE_TRIGGERS = [
  `CREATE TRIGGER IF NOT EXISTS trg_users_no_admin_promotion
   BEFORE UPDATE OF role ON users
   FOR EACH ROW WHEN NEW.role = 'ADMIN' AND OLD.role <> 'ADMIN'
   BEGIN SELECT RAISE(ABORT, 'ADMIN_PROMOTION_FORBIDDEN'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_users_admin_insert_guard
   BEFORE INSERT ON users
   FOR EACH ROW WHEN NEW.role = 'ADMIN' AND NEW.account_status <> 'PENDING_BOOTSTRAP'
   BEGIN SELECT RAISE(ABORT, 'ADMIN_PROMOTION_FORBIDDEN'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_admin_provenance_insert_guard
   BEFORE INSERT ON admin_provenance
   FOR EACH ROW WHEN NEW.source = 'LEGACY_BACKFILL' OR NOT EXISTS (
     SELECT 1 FROM users u
     WHERE u.id = NEW.user_id AND u.role = 'ADMIN' AND u.account_status = 'PENDING_BOOTSTRAP'
       AND NOT EXISTS (SELECT 1 FROM wallets w WHERE w.user_id = u.id))
   BEGIN SELECT RAISE(ABORT, 'ADMIN_PROVENANCE_FORBIDDEN'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_admin_provenance_immutable
   BEFORE UPDATE ON admin_provenance
   BEGIN SELECT RAISE(ABORT, 'ADMIN_PROVENANCE_IMMUTABLE'); END`,
];

/**
 * SQLite: tạo bảng + backfill ĐÚNG MỘT LẦN (khi bảng chưa tồn tại), rồi bảo đảm các trigger.
 * Gọi với handle đồng bộ (lib/sqlite.js) trong lúc db.js khởi tạo.
 */
function migrateSqlite(raw) {
  const exists = raw.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'admin_provenance'").get();
  if (!exists) {
    raw.transaction(() => {
      raw.exec(SQLITE_TABLE);
      // Backfill chạy TRƯỚC khi có trigger chặn LEGACY_BACKFILL.
      const n = raw.prepare(backfillSql('', `strftime('%Y-%m-%dT%H:%M:%fZ','now')`)).run().changes;
      for (const t of SQLITE_TRIGGERS) raw.exec(t);
      console.log(`[migrate] admin_provenance: đã tạo bảng nguồn gốc quyền quản trị, backfill ${n} tài khoản ADMIN có sẵn.`);
    })();
  }
  for (const t of SQLITE_TRIGGERS) raw.exec(t);
}

/** Tài khoản có đủ cả role='ADMIN' lẫn dấu nguồn gốc? (dùng API bất đồng bộ của lib/asyncDb.js) */
async function isProvenAdmin(db, userId) {
  const row = await db
    .prepare(`SELECT 1 AS ok FROM users u JOIN admin_provenance p ON p.user_id = u.id WHERE u.id = ? AND u.role = 'ADMIN'`)
    .get(userId);
  return !!row;
}

/** Ghi dấu nguồn gốc cho admin bootstrap vừa tạo. PHẢI chạy trong cùng giao dịch với INSERT users. */
async function recordBootstrapProvenance(db, { userId, username, source, now }) {
  if (source !== 'BOOTSTRAP_CLI' && source !== 'BOOTSTRAP_ENV') throw new Error(`Nguồn bootstrap không hợp lệ: ${source}`);
  await db
    .prepare('INSERT INTO admin_provenance (user_id, source, username_at_grant, granted_at) VALUES (?, ?, ?, ?)')
    .run(userId, source, username, now);
}

module.exports = {
  SOURCES,
  UNVERIFIED_ADMIN_ROLE,
  backfillSql,
  migrateSqlite,
  isProvenAdmin,
  recordBootstrapProvenance,
};
