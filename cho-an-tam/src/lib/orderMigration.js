// SQLite preserves every existing column and row. Only CHECK sets are widened.
// No legacy address, receipt or inspection is fabricated.
const fs = require('fs');
const path = require('path');
function widenTable(db,name,transform) {
  const row=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name);
  const sql=transform(row.sql);
  if(sql===row.sql)return;
  const indexes=db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name=? AND type IN ('index','trigger') AND sql IS NOT NULL").all(name);
  const columns=db.prepare(`PRAGMA table_info(${name})`).all().map(c=>`"${c.name}"`).join(',');
  db.exec(sql.replace(new RegExp(`CREATE TABLE(?: IF NOT EXISTS)? ["\x60]?${name}["\x60]?(?=\\s|\\()`,'i'),`CREATE TABLE ${name}__order_v12`));
  db.exec(`INSERT INTO ${name}__order_v12 (${columns}) SELECT ${columns} FROM ${name}`);
  db.exec(`DROP TABLE ${name}`);
  db.exec(`ALTER TABLE ${name}__order_v12 RENAME TO ${name}`);
  for(const index of indexes)db.exec(index.sql);
}

function migrateSqlite(db) {
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(()=>{
      widenTable(db,'listings',s=>s.includes("'PENDING_SELLER_REVIEW'")?s:s.replace("'AVAILABLE','LOCKED','SOLD'","'AVAILABLE','LOCKED','SOLD','PENDING_SELLER_REVIEW'"));
      widenTable(db,'transactions',s=>s.includes("'CANCELLED'")?s:s.replace("'REFUNDED','RELEASED'","'REFUNDED','RELEASED','CANCELLED'"));
      widenTable(db,'disputes',s=>{
        const nullable=s.replace('created_by TEXT NOT NULL','created_by TEXT');
        return nullable.includes("'RESOLVED_BY_BUYER_RELEASE'")?nullable:nullable.replace("'OPEN','RESOLVED_REFUND','RESOLVED_RELEASE'","'OPEN','RESOLVED_REFUND','RESOLVED_RELEASE','RESOLVED_BY_BUYER_RELEASE'");
      });
      const add=(table,cols)=>{
        const existing=new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c=>c.name));
        for(const [name,type] of Object.entries(cols))if(!existing.has(name))db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
      };
      add('transactions',{
        secured_at:'TEXT',
        draft_expires_at:'TEXT',
        order_request_id:'TEXT',
        order_request_hash:'TEXT',
        cancelled_at:'TEXT',
        cancel_reason:'TEXT',
        inspected_at:'TEXT',
        inspected_by:'TEXT REFERENCES users(id)',
        received_confirmed_at:'TEXT',
        received_confirmed_by:"TEXT CHECK(received_confirmed_by IN ('BUYER','SYSTEM'))"
      });
      add('disputes',{
        type:"TEXT NOT NULL DEFAULT 'DEFECT'",
        opened_by:"TEXT NOT NULL DEFAULT 'BUYER'",
        revision:'INTEGER NOT NULL DEFAULT 0',
        buyer_never_confirmed_receipt:'INTEGER NOT NULL DEFAULT 0',
        evidence_due_at:'TEXT',
        admin_due_at:'TEXT'
      });
      db.exec(fs.readFileSync(path.join(__dirname,'..','schema.order.sql'),'utf8'));
      db.exec("UPDATE transactions SET secured_at=(SELECT MIN(a.created_at) FROM audit_logs a WHERE a.transaction_id=transactions.id AND a.action='ESCROW_LOCKED') WHERE secured_at IS NULL AND EXISTS(SELECT 1 FROM audit_logs a WHERE a.transaction_id=transactions.id AND a.action='ESCROW_LOCKED')");
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
  if(db.pragma('foreign_key_check').length)throw new Error('ORDER_MIGRATION_FOREIGN_KEY_CHECK_FAILED');
}
module.exports={
  migrateSqlite
};
