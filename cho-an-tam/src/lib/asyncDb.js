// Lớp truy cập cơ sở dữ liệu BẤT ĐỒNG BỘ, chạy được trên hai nền: SQLite (node:sqlite) và
// PostgreSQL (pg). Phần còn lại của dự án chỉ thấy một hình dạng API duy nhất:
//
//   await db.prepare(sql).get(...params)   -> một dòng hoặc undefined
//   await db.prepare(sql).all(...params)   -> mảng dòng
//   await db.prepare(sql).run(...params)   -> { changes }
//   await db.exec(sql)
//   await db.transaction(async (...args) => { ... })(...args)
//
// SQL viết một lần bằng dấu `?`; bản PostgreSQL tự đổi sang $1, $2, ...
//
// ---------------------------------------------------------------------------------------
// Vì sao phải có khoá toàn cục cho giao dịch ghi
//
// Bản đồng bộ cũ được bảo vệ "miễn phí": node:sqlite chạy đồng bộ, Node đơn luồng, nên khi một
// db.transaction() đang chạy thì không request nào xen vào được (xem ghi chú ở lib/hash.js). Khi
// mọi lời gọi trở thành await, bảo đảm đó MẤT: giữa hai câu lệnh của một nghiệp vụ, request khác
// hoàn toàn có thể chạy.
//
// Để mọi lập luận về bất biến cũ vẫn còn nguyên giá trị, mỗi giao dịch ghi được tuần tự hoá:
//   - PostgreSQL: pg_advisory_xact_lock(LOCK_KEY) ngay sau BEGIN — đúng cơ chế mà thiết kế gốc
//     (4_system_design.md mục 9) đã dự kiến cho bản Postgres. Khoá tự nhả khi COMMIT/ROLLBACK.
//   - SQLite: một mutex trong process. Câu lệnh nằm NGOÀI giao dịch phải chờ giao dịch đang mở
//     kết thúc, vì cả process chỉ có một kết nối — không chờ thì câu lệnh của request khác sẽ lọt
//     vào giữa giao dịch đang mở và commit/rollback cùng với nó.
//
// Câu lệnh đơn lẻ ngoài giao dịch (đọc danh sách, cập nhật có điều kiện) không cần khoá: chúng
// tự nguyên tử, và các cập nhật quan trọng vốn đã có điều kiện `WHERE ... AND version = ?`.
// ---------------------------------------------------------------------------------------
const { AsyncLocalStorage } = require('node:async_hooks');

const PG_LOCK_KEY = 72_410_001; // hằng số tuỳ ý, chỉ cần mọi tiến trình của ứng dụng dùng chung

function normalize(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

/** Đổi `?` thành $1, $2, ... — bỏ qua dấu ? nằm trong chuỗi '...' hoặc định danh "...". */
function toPgPlaceholders(sql) {
  let out = '';
  let n = 0;
  let quote = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (quote) {
      out += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === '?') {
      n += 1;
      out += `$${n}`;
      continue;
    }
    out += ch;
  }
  return out;
}

class Mutex {
  constructor() {
    this.locked = false;
    this.waiters = [];
    this.idleWaiters = [];
  }
  async acquire() {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    await new Promise((resolve) => this.waiters.push(resolve));
  }
  release() {
    const next = this.waiters.shift();
    if (next) {
      next(); // chuyển quyền thẳng cho người chờ kế tiếp, khoá vẫn giữ nguyên trạng thái "đang khoá"
      return;
    }
    this.locked = false;
    const idle = this.idleWaiters.splice(0);
    for (const r of idle) r();
  }
  waitIdle() {
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }
}

// ---------------------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------------------
class SqliteAsyncDatabase {
  /** @param raw instance đồng bộ từ lib/sqlite.js (đã mở, đã chạy migration) */
  constructor(raw, { ready = Promise.resolve() } = {}) {
    this.dialect = 'sqlite';
    this.raw = raw;
    this.ready = ready;
    this.mutex = new Mutex();
    this.als = new AsyncLocalStorage();
  }

  _store() {
    const s = this.als.getStore();
    return s && !s.done ? s : null;
  }

  // Câu lệnh ngoài giao dịch: chờ tới khi không còn giao dịch nào mở. Vòng lặp kiểm lại sau mỗi
  // lần thức dậy, và câu lệnh chạy NGAY sau lần kiểm cuối mà không có await nào xen giữa —
  // nhờ vậy không giao dịch nào kịp mở ra giữa lúc kiểm và lúc chạy.
  async _gate() {
    await this.ready;
    if (this._store()) return;
    while (this.mutex.locked) await this.mutex.waitIdle();
  }

  prepare(sql) {
    const self = this;
    return {
      async get(...args) {
        await self._gate();
        return self.raw.prepare(sql).get(...args.map(normalize));
      },
      async all(...args) {
        await self._gate();
        return self.raw.prepare(sql).all(...args.map(normalize));
      },
      async run(...args) {
        await self._gate();
        const r = self.raw.prepare(sql).run(...args.map(normalize));
        return { changes: r.changes };
      },
    };
  }

  async exec(sql) {
    await this._gate();
    this.raw.exec(sql);
  }

  transaction(fn) {
    const self = this;
    return async function wrapped(...args) {
      await self.ready;
      const outer = self._store();
      if (outer) {
        const name = `sp_${outer.depth}`;
        outer.depth += 1;
        self.raw._db.exec(`SAVEPOINT ${name}`);
        try {
          const result = await fn.apply(this, args);
          self.raw._db.exec(`RELEASE ${name}`);
          return result;
        } catch (err) {
          try { self.raw._db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); } catch (_) {}
          throw err;
        } finally {
          outer.depth -= 1;
        }
      }

      await self.mutex.acquire();
      const store = { depth: 0, done: false };
      try {
        self.raw._db.exec('BEGIN IMMEDIATE');
        try {
          const result = await self.als.run(store, () => fn.apply(this, args));
          self.raw._db.exec('COMMIT');
          return result;
        } catch (err) {
          try { self.raw._db.exec('ROLLBACK'); } catch (_) {}
          throw err;
        }
      } finally {
        store.done = true;
        self.mutex.release();
      }
    };
  }

  isUniqueViolation(err) {
    return !!err && (/UNIQUE constraint failed/.test(err.message || '') || err.code === 'SQLITE_CONSTRAINT_UNIQUE');
  }

  isCheckViolation(err) {
    return !!err && (err.code === 'SQLITE_CONSTRAINT_CHECK' || /CHECK constraint failed/.test(err.message || ''));
  }

  async close() {
    this.raw.close();
  }
}

// ---------------------------------------------------------------------------------------
// PostgreSQL
// ---------------------------------------------------------------------------------------
class PgAsyncDatabase {
  constructor(pool, { ready = Promise.resolve() } = {}) {
    this.dialect = 'pg';
    this.pool = pool;
    this.ready = ready;
    this.als = new AsyncLocalStorage();
    this.cache = new Map();
  }

  _text(sql) {
    let t = this.cache.get(sql);
    if (!t) {
      t = toPgPlaceholders(sql);
      this.cache.set(sql, t);
    }
    return t;
  }

  // Trong giao dịch thì dùng đúng client của giao dịch. Một lời gọi lỡ chạy SAU khi giao dịch đã
  // kết thúc (ví dụ quên await) sẽ đi qua pool chứ không dùng lại client đã trả về pool — client
  // đó lúc ấy có thể đang phục vụ một request khác.
  _executor() {
    const s = this.als.getStore();
    return s && !s.done ? s.client : this.pool;
  }

  async _query(sql, args) {
    await this.ready;
    return this._executor().query(this._text(sql), args.map(normalize));
  }

  prepare(sql) {
    const self = this;
    return {
      async get(...args) {
        const r = await self._query(sql, args);
        return r.rows[0];
      },
      async all(...args) {
        const r = await self._query(sql, args);
        return r.rows;
      },
      async run(...args) {
        const r = await self._query(sql, args);
        return { changes: r.rowCount };
      },
    };
  }

  async exec(sql) {
    await this.ready;
    await this._executor().query(sql);
  }

  transaction(fn) {
    const self = this;
    return async function wrapped(...args) {
      await self.ready;
      const outerRaw = self.als.getStore();
      const outer = outerRaw && !outerRaw.done ? outerRaw : null;
      if (outer) {
        const name = `sp_${outer.depth}`;
        outer.depth += 1;
        await outer.client.query(`SAVEPOINT ${name}`);
        try {
          const result = await fn.apply(this, args);
          await outer.client.query(`RELEASE SAVEPOINT ${name}`);
          return result;
        } catch (err) {
          await outer.client.query(`ROLLBACK TO SAVEPOINT ${name}`).catch(() => {});
          throw err;
        } finally {
          outer.depth -= 1;
        }
      }

      const client = await self.pool.connect();
      const store = { client, depth: 0, done: false };
      let broken = false;
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock($1)', [PG_LOCK_KEY]);
        try {
          const result = await self.als.run(store, () => fn.apply(this, args));
          await client.query('COMMIT');
          return result;
        } catch (err) {
          await client.query('ROLLBACK').catch(() => { broken = true; });
          throw err;
        }
      } catch (err) {
        if (!client._ending && err && /Connection terminated|ECONNRESET/.test(err.message || '')) broken = true;
        throw err;
      } finally {
        store.done = true;
        client.release(broken ? true : undefined);
      }
    };
  }

  isUniqueViolation(err) {
    return !!err && err.code === '23505';
  }

  isCheckViolation(err) {
    return !!err && err.code === '23514';
  }

  async close() {
    await this.pool.end();
  }
}

module.exports = { SqliteAsyncDatabase, PgAsyncDatabase, toPgPlaceholders, PG_LOCK_KEY };
