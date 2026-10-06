'use strict';
// Chỉ dùng trong fixture test: tắt tạm trigger bất biến của một bảng để giả lập thời gian đã trôi qua
// (ví dụ create_attempt_at đã quá 5 phút). Trigger được bật lại ngay cả khi fn ném lỗi.
// KHÔNG phải đường sản phẩm. Chỉ chạy trên CSDL test cục bộ.
async function withTriggerDisabled(db, table, fn) {
  if (db.dialect === 'pg') {
    await db.exec(`ALTER TABLE app.${table} DISABLE TRIGGER USER`);
    try { return await fn(); } finally { await db.exec(`ALTER TABLE app.${table} ENABLE TRIGGER USER`); }
  }
  const triggers = await db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?").all(table);
  for (const t of triggers) await db.exec(`DROP TRIGGER "${t.name}"`);
  try { return await fn(); } finally { for (const t of triggers) await db.exec(t.sql); }
}

module.exports = { withTriggerDisabled };
