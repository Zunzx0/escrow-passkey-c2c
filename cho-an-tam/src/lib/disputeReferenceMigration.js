'use strict';
const { CATEGORIES, initialCategory } = require('./disputeReference');

function migrateSqlite(raw) {
  raw.transaction(() => {
    const columns = new Set(raw.prepare('PRAGMA table_info(disputes)').all().map(c => c.name));
    if (!columns.has('case_number')) raw.exec('ALTER TABLE disputes ADD COLUMN case_number INTEGER CHECK(case_number > 0)');
    if (!columns.has('case_prefix')) raw.exec("ALTER TABLE disputes ADD COLUMN case_prefix TEXT CHECK(case_prefix IN ('A','B','C','D','E','F','G','L'))");
    raw.exec('CREATE TABLE IF NOT EXISTS dispute_case_counter(id INTEGER PRIMARY KEY CHECK(id=1),last_number INTEGER NOT NULL CHECK(last_number >= 0))');
    if (raw.prepare('SELECT 1 FROM disputes WHERE (case_number IS NULL) <> (case_prefix IS NULL) LIMIT 1').get()) throw new Error('DISPUTE_REFERENCE_INCOMPLETE');
    const high = Number(raw.prepare('SELECT COALESCE(MAX(case_number),0) n FROM disputes').get().n);
    raw.prepare('INSERT INTO dispute_case_counter(id,last_number) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET last_number=MAX(dispute_case_counter.last_number,excluded.last_number)').run(high);
    for (const d of raw.prepare('SELECT id,type FROM disputes WHERE case_number IS NULL ORDER BY created_at,id').all()) {
      const number = raw.prepare('UPDATE dispute_case_counter SET last_number=last_number+1 WHERE id=1 RETURNING last_number').get().last_number;
      raw.prepare('UPDATE disputes SET case_number=?,case_prefix=? WHERE id=? AND case_number IS NULL').run(number, initialCategory(d).code, d.id);
    }
    raw.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS ux_dispute_case_number ON disputes(case_number);
      CREATE TRIGGER IF NOT EXISTS dispute_reference_immutable BEFORE UPDATE OF case_number,case_prefix ON disputes
      WHEN OLD.case_number IS NOT NULL AND (NEW.case_number IS NOT OLD.case_number OR NEW.case_prefix IS NOT OLD.case_prefix)
      BEGIN SELECT RAISE(ABORT,'DISPUTE_REFERENCE_IMMUTABLE'); END;
      CREATE TRIGGER IF NOT EXISTS dispute_reference_pair BEFORE INSERT ON disputes
      WHEN (NEW.case_number IS NULL) <> (NEW.case_prefix IS NULL)
      BEGIN SELECT RAISE(ABORT,'DISPUTE_REFERENCE_INCOMPLETE'); END;
      CREATE TRIGGER IF NOT EXISTS dispute_reference_allocate AFTER INSERT ON disputes
      WHEN NEW.case_number IS NULL AND NEW.case_prefix IS NULL
      BEGIN
        SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM dispute_case_counter WHERE id=1) THEN RAISE(ABORT,'DISPUTE_COUNTER_UNAVAILABLE') END;
        UPDATE dispute_case_counter SET last_number=last_number+1 WHERE id=1;
        UPDATE disputes SET case_number=(SELECT last_number FROM dispute_case_counter WHERE id=1),
          case_prefix=CASE NEW.type ${Object.entries(CATEGORIES).map(([type,c])=>`WHEN '${type}' THEN '${c.code}'`).join(' ')} ELSE 'L' END
        WHERE id=NEW.id;
      END;
    `);
  })();
}

module.exports = { migrateSqlite };
