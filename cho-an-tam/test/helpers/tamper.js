/**
 * Mô phỏng thao tác ghi thẳng vào CSDL test để dựng kịch bản leo thang đặc quyền.
 *
 * Từ khi có lib/adminProvenance.js, CSDL tự chặn `UPDATE users SET role = 'ADMIN'` bằng trigger.
 * Các bài kiểm thử muốn chứng minh lớp kiểm tra LÚC CHẠY vẫn tự đứng vững — tức kịch bản xấu nhất,
 * khi trigger đã bị gỡ hay bị vượt qua — dùng hàm dưới đây: tạm tắt trigger của bảng users, đổi
 * role, rồi bật lại ngay. CHỈ dùng trên cơ sở dữ liệu test.
 */
const { db, DIALECT } = require('../../src/db');

async function forceRole(userId, role) {
  if (DIALECT === 'pg') {
    await db.exec('ALTER TABLE app.users DISABLE TRIGGER USER');
    try {
      await db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, userId);
    } finally {
      await db.exec('ALTER TABLE app.users ENABLE TRIGGER USER');
    }
    return;
  }
  const triggers = await db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'users'").all();
  for (const t of triggers) await db.exec(`DROP TRIGGER "${t.name}"`);
  try {
    await db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, userId);
  } finally {
    for (const t of triggers) await db.exec(t.sql);
  }
}

module.exports = { forceRole };
