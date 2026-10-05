/**
 * Khởi tạo tài khoản quản trị viên đầu tiên (ngoại lệ bootstrap, mục 2.2.5).
 *
 * Vì sao phải có ngoại lệ: quy tắc chung đòi một credential ĐANG CÓ để thêm credential mới
 * và để đổi mật khẩu. Tài khoản quản trị viên đầu tiên được tạo bằng thủ tục vận hành chạy
 * trực tiếp trên máy chủ, và tại thời điểm đó chưa có credential nào — nếu để nguyên, quy
 * tắc sẽ tự chặn chính bước thiết lập quản trị viên.
 *
 * Thủ tục vì vậy gồm ba chặng, và tài khoản chỉ dùng được sau khi cả ba hoàn tất:
 *
 *   1. Ở ĐÂY      tạo tài khoản role=ADMIN, account_status=PENDING_BOOTSTRAP, kèm một mật
 *                 khẩu tạm sinh ngẫu nhiên. Chưa có ví, chưa có credential.
 *   2. Trên trình duyệt  đăng nhập bằng mật khẩu tạm -> phiên có phạm vi hạn chế, chỉ đi được
 *                 đúng một bước: POST /api/passkeys/bootstrap/password để đổi mật khẩu tạm.
 *                 Tài khoản chuyển sang PENDING_PASSKEY.
 *   3. Trên trình duyệt  đăng ký Passkey đầu tiên với mức xác minh người dùng BẮT BUỘC.
 *                 Tài khoản chuyển sang ACTIVE và từ đó mới gọi được chức năng quản trị.
 *
 * Hai thao tác ở chặng 2 và 3 không đi qua cơ chế xác thực lại, vì lúc đó chưa tồn tại
 * credential nào để xác thực lại. Ngay sau khi chặng 3 kết thúc, mọi thay đổi credential và
 * mọi lần đổi mật khẩu của tài khoản này đều theo đúng quy tắc chung như mọi tài khoản khác.
 *
 * Ngoại lệ chỉ tồn tại đúng một lần cho mỗi tài khoản quản trị viên, và bản thân thủ tục
 * không được phơi ra dưới dạng một điểm cuối HTTP: chỉ script `npm run seed:admin` và bộ
 * kiểm thử gọi tới hàm này.
 */

const { db, uuid, nowIso } = require('./../db');
const { hashPassword, generateTemporaryPassword, assertPasswordPolicy } = require('./password');
const { recordBootstrapProvenance } = require('./adminProvenance');
const { normalizeUsername, isValidUsername, USERNAME_HINT } = require('./username');

class BootstrapError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Tạo một tài khoản quản trị viên ở trạng thái chờ thiết lập.
 *
 * @returns {Promise<{ user: object, temporaryPassword: string, created: boolean }>}
 */
async function createBootstrapAdmin({ username: usernameRaw, displayName, temporaryPassword, source = 'BOOTSTRAP_CLI' } = {}) {
  const username = normalizeUsername(usernameRaw);
  if (!username) throw new BootstrapError('MISSING_USERNAME', 'Thiếu tên đăng nhập.');
  if (!isValidUsername(username)) {
    throw new BootstrapError(
      'INVALID_USERNAME',
      USERNAME_HINT
    );
  }

  const existing = await db.prepare('SELECT id, username, role, account_status FROM users WHERE username = ?').get(username);
  if (existing) {
    throw new BootstrapError(
      'USERNAME_TAKEN',
      `Tên đăng nhập "${username}" đã tồn tại (vai trò ${existing.role}, trạng thái ${existing.account_status}). ` +
        'Hãy chọn tên khác, hoặc xoá cơ sở dữ liệu thực nghiệm rồi khởi tạo lại.'
    );
  }

  const tempPassword = temporaryPassword || generateTemporaryPassword();
  assertPasswordPolicy(tempPassword);

  const id = uuid();
  const now = nowIso();
  const name = String(displayName || username).trim().slice(0, 80) || username;

  // Quản trị viên không phải một bên của giao dịch nên KHÔNG có ví. Ví chỉ được mở ở bước
  // hoàn tất đăng ký Passkey, và bước đó bỏ qua việc mở ví với tài khoản role=ADMIN.
  //
  // Dấu nguồn gốc (lib/adminProvenance.js) được ghi trong CÙNG giao dịch với tài khoản: đây là một
  // trong hai nơi duy nhất sinh ra nó. Thiếu dấu này thì role='ADMIN' không mở được quyền gì.
  await db.transaction(async () => {
    await db.prepare(
      `INSERT INTO users (id, username, display_name, role, password_hash, account_status, token_version, created_at, updated_at)
       VALUES (?, ?, ?, 'ADMIN', ?, 'PENDING_BOOTSTRAP', 0, ?, ?)`
    ).run(id, username, name, hashPassword(tempPassword), now, now);
    await recordBootstrapProvenance(db, { userId: id, username, source, now });
  })();

  const user = await db
    .prepare('SELECT id, username, display_name, role, account_status FROM users WHERE id = ?')
    .get(id);

  return { user, temporaryPassword: tempPassword, created: true };
}

module.exports = { createBootstrapAdmin, BootstrapError };
