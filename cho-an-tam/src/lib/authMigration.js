const fs = require('fs');
const path = require('path');

// Preserve all old users, wallets, ledger entries, credentials and foreign keys.
function migrateSqlite(raw) {
  function extendCheck(table, from, to) {
    const ddl = raw.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table)?.sql;
    if (!ddl || to.split(',').every(value=>ddl.includes(value))) return;
    if (!ddl.includes(from)) throw new Error(`AUTH_MIGRATION_UNEXPECTED_CHECK: ${table}`);
    const columns = raw.prepare(`PRAGMA table_info(${table})`).all().map(c => `"${c.name}"`).join(',');
    const objects=raw.prepare("SELECT sql FROM sqlite_master WHERE tbl_name=? AND type IN ('index','trigger') AND sql IS NOT NULL").all(table);
    raw.pragma('foreign_keys = OFF');
    raw.pragma('legacy_alter_table = ON');
    try {
      raw.transaction(() => {
        raw.exec(ddl.replace(new RegExp(`CREATE TABLE\\s+(?:IF NOT EXISTS\\s+)?["\x60]?${table}["\x60]?`, 'i'), `CREATE TABLE ${table}_auth_new`).replace(from, to));
        raw.exec(`INSERT INTO ${table}_auth_new (${columns}) SELECT ${columns} FROM ${table}`);
        raw.exec(`DROP TABLE ${table}`);
        raw.exec(`ALTER TABLE ${table}_auth_new RENAME TO ${table}`);
        for(const object of objects) raw.exec(object.sql);
        if(raw.pragma('foreign_key_check').length) throw new Error('AUTH_MIGRATION_FOREIGN_KEY_CHECK_FAILED');
      })();
    } finally { raw.pragma('legacy_alter_table = OFF');raw.pragma('foreign_keys = ON'); }
  }
  extendCheck('users', "'PENDING_BOOTSTRAP','PENDING_PASSKEY','ACTIVE'", "'PENDING_BOOTSTRAP','PENDING_EMAIL','PENDING_PASSKEY','ACTIVE','RECOVERING','SUSPENDED'");
  extendCheck('users', "'PENDING_BOOTSTRAP','PENDING_EMAIL','PENDING_PASSKEY','ACTIVE','RECOVERING','SUSPENDED'", "'PENDING_BOOTSTRAP','PENDING_EMAIL','PENDING_PASSKEY','BASIC','VERIFIED','ACTIVE','RECOVERING','SUSPENDED'");
  extendCheck('reauth_grants', "'RELEASE_ESCROW','ADJUDICATE','MANAGE_CREDENTIAL','CHANGE_PASSWORD'", "'RELEASE_ESCROW','ADJUDICATE','MANAGE_CREDENTIAL','CHANGE_PASSWORD','ADD_CREDENTIAL','REMOVE_CREDENTIAL','REGENERATE_RECOVERY','CHANGE_EMAIL','UPGRADE_SESSION'");
  extendCheck('reauth_grants', "'RELEASE_ESCROW','ADJUDICATE','MANAGE_CREDENTIAL','CHANGE_PASSWORD','ADD_CREDENTIAL','REMOVE_CREDENTIAL','REGENERATE_RECOVERY','CHANGE_EMAIL','UPGRADE_SESSION'", "'RELEASE_ESCROW','ADJUDICATE','MANAGE_CREDENTIAL','CHANGE_PASSWORD','ADD_CREDENTIAL','REMOVE_CREDENTIAL','REGENERATE_RECOVERY','CHANGE_EMAIL','UPGRADE_SESSION','LOCK_ESCROW'");
  const additions = {
    users: { email:'TEXT', email_verified_at:'TEXT', webauthn_user_id:'TEXT', recovery_acknowledged:'INTEGER NOT NULL DEFAULT 0', recovery_restricted_until:'TEXT',auth_last_active_at:'TEXT' },
    passkey_credentials: { backup_eligible:'INTEGER', backed_up:'INTEGER', user_handle:'TEXT' },
    sessions: { auth_method:"TEXT NOT NULL DEFAULT 'password'", auth_at:'TEXT', device_name:'TEXT',enrollment_verified_at:'TEXT' },
    reauth_grants: { credential_id:'TEXT', target_id:'TEXT' },
    transactions:{inspection_due_at:'TEXT'},
  };
  for (const [table, fields] of Object.entries(additions)) {
    const have = new Set(raw.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
    for (const [column, type] of Object.entries(fields)) if (!have.has(column)) raw.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
  raw.exec('CREATE INDEX IF NOT EXISTS idx_reauth_grants_lookup ON reauth_grants(user_id, transaction_id, expires_at)');
  raw.exec('DROP INDEX IF EXISTS idx_users_email');
  raw.exec(fs.readFileSync(path.join(__dirname, '..', 'schema.auth.sql'), 'utf8'));
  for (const [table,column] of [['auth_email_codes','email'],['auth_email_outbox','expires_at']]) {
    if (!raw.prepare(`PRAGMA table_info(${table})`).all().some(c=>c.name===column)) raw.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
  }
  raw.exec("UPDATE users SET account_status=CASE WHEN email_verified_at IS NULL THEN 'BASIC' ELSE 'VERIFIED' END WHERE role<>'ADMIN' AND account_status IN ('PENDING_EMAIL','PENDING_PASSKEY')");
  if (raw.pragma('foreign_key_check').length) throw new Error('AUTH_MIGRATION_FOREIGN_KEY_CHECK_FAILED');
}
module.exports = { migrateSqlite };
