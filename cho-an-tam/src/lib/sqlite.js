// Lớp SQLite của dự án, xây trên node:sqlite — SQLite tích hợp sẵn trong Node.
//
// Trước đây dự án dùng package `better-sqlite3`. Đó là native addon: mỗi lần cài phải
// biên dịch bằng node-gyp (cần Visual C++ Build Tools + Python) hoặc tải prebuilt từ
// GitHub. Trên máy thiếu toolset, hoặc mạng chặn GitHub, hoặc Node mới hơn bản prebuilt
// có sẵn, việc cài sẽ thất bại và cả ứng dụng không chạy được. Đó là lý do dự án từng
// "chạy ở máy này, chết ở máy kia".
//
// node:sqlite là module lõi của Node nên không phải cài gì, không phải biên dịch gì —
// đổi lại nó yêu cầu Node đủ mới (xem kiểm tra phiên bản bên dưới).
//
// API ở đây cố ý giữ nguyên hình dạng của better-sqlite3 để phần còn lại của dự án
// không phải sửa, và cũng chỉ hiện thực đúng những gì dự án dùng:
//   new Database(path), db.pragma(), db.exec(), db.prepare().run/get/all/iterate,
//   db.transaction(fn), db.close()

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (err) {
  throw new Error(
    `Node.js ${process.version} không có module 'node:sqlite' nên ứng dụng không khởi động được.\n` +
      `Dự án cần Node.js 23.4.0 trở lên (khuyến nghị bản LTS mới nhất).\n` +
      `Tải tại https://nodejs.org rồi chạy lại 'npm start'.\n` +
      `Nếu đang dùng Node 22.5–23.3, có thể tạm chạy: node --experimental-sqlite src/server.js`
  );
}

function normalize(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

function normalizeArgs(args) {
  if (args.length === 1 && args[0] !== null && typeof args[0] === 'object' && !Buffer.isBuffer(args[0])) {
    const out = {};
    for (const [k, v] of Object.entries(args[0])) out[k] = normalize(v);
    return [out];
  }
  return args.map(normalize);
}

class Statement {
  constructor(stmt) {
    this._stmt = stmt;
  }
  run(...args) {
    const r = this._stmt.run(...normalizeArgs(args));
    return {
      changes: Number(r.changes),
      lastInsertRowid: typeof r.lastInsertRowid === 'bigint' ? Number(r.lastInsertRowid) : r.lastInsertRowid,
    };
  }
  get(...args) {
    return this._stmt.get(...normalizeArgs(args));
  }
  all(...args) {
    return this._stmt.all(...normalizeArgs(args));
  }
  iterate(...args) {
    return this._stmt.iterate(...normalizeArgs(args));
  }
}

class Database {
  constructor(location) {
    this._db = new DatabaseSync(location);
    this._depth = 0; // hỗ trợ transaction lồng nhau bằng SAVEPOINT
    this.open = true;
  }

  pragma(source) {
    // better-sqlite3 nhận "journal_mode = WAL"; node:sqlite chỉ cần exec/prepare PRAGMA
    try {
      return this._db.prepare(`PRAGMA ${source}`).all();
    } catch (_) {
      this._db.exec(`PRAGMA ${source}`);
      return [];
    }
  }

  exec(sql) {
    this._db.exec(sql);
    return this;
  }

  prepare(sql) {
    return new Statement(this._db.prepare(sql));
  }

  // BEGIN IMMEDIATE chứ không phải BEGIN (deferred): giao dịch giành khoá ghi ngay từ đầu.
  // Khi chỉ có một process thì hai cách như nhau. Khi có process thứ hai cùng ghi (worker đối
  // soát chạy riêng, hoặc bộ test mở thẳng cơ sở dữ liệu), giao dịch deferred đọc trước rồi
  // mới ghi có thể nhận SQLITE_BUSY_SNAPSHOT ngay lập tức — lỗi mà busy_timeout không cứu
  // được. Giành khoá ghi từ đầu thì process đến sau chỉ việc chờ theo busy_timeout.
  transaction(fn) {
    const self = this;
    return function wrapped(...args) {
      const nested = self._depth > 0;
      const name = `sp_${self._depth}`;
      self._db.exec(nested ? `SAVEPOINT ${name}` : 'BEGIN IMMEDIATE');
      self._depth += 1;
      try {
        const result = fn.apply(this, args);
        self._depth -= 1;
        self._db.exec(nested ? `RELEASE ${name}` : 'COMMIT');
        return result;
      } catch (err) {
        self._depth -= 1;
        try {
          self._db.exec(nested ? `ROLLBACK TO ${name}; RELEASE ${name}` : 'ROLLBACK');
        } catch (_) {}
        throw err;
      }
    };
  }

  close() {
    this._db.close();
    this.open = false;
  }
}

module.exports = Database;
module.exports.default = Database;
