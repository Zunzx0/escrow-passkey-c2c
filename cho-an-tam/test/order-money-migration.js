'use strict';
// Legacy SQLite schema -> order v12, repeated upgrade and reopen. No app DB import.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),base=path.join(root,'data','test');
fs.mkdirSync(base,{recursive:true});const dir=fs.mkdtempSync(path.join(base,'order-migration-')),file=path.join(dir,'legacy.db');
const Database=require('../src/lib/sqlite'),migration=require('../src/lib/orderMigration');
let db=new Database(file),checks=0;
const eq=(a,b,label)=>{assert.deepEqual(a,b,label);checks++;};
try{
  db.exec(fs.readFileSync(path.join(root,'src','schema.sql'),'utf8'));
  db.exec("INSERT INTO users(id,username,display_name,role,password_hash,account_status) VALUES('buyer','legacy_buyer','Legacy buyer','BUYER','fixture','ACTIVE'),('seller','legacy_seller','Legacy seller','SELLER','fixture','ACTIVE')");
  db.exec("INSERT INTO wallets(id,user_id,wallet_type,available_balance,version) VALUES('wallet','buyer','USER',123456,9)");
  db.exec("INSERT INTO wallet_entries(id,wallet_id,request_id,entry_type,available_delta,available_after,locked_after,idempotency_key) VALUES('entry','wallet','legacy','DEMO_TOPUP',123456,123456,0,'old-ledger-key')");
  db.exec("INSERT INTO listings(id,seller_id,title,price,category,condition,visibility,status,version) VALUES('listing','seller','Đồ cũ cần kiểm tra',60000,'SACH','GOOD','PUBLIC','LOCKED',4)");
  db.exec("INSERT INTO transactions(id,buyer_id,seller_id,item_name,amount,status,escrow_status,listing_id,version) VALUES('order','buyer','seller','Đồ cũ cần kiểm tra',60000,'REFUNDED','REFUNDED','listing',8)");
  db.exec("INSERT INTO disputes(id,transaction_id,created_by,reason,status) VALUES('dispute','order','buyer','Mô tả cũ phải được giữ nguyên','RESOLVED_REFUND')");
  db.exec('CREATE INDEX idx_fixture_preserve ON transactions(item_name)');
  const before={wallet:db.prepare('SELECT * FROM wallets').get(),entry:db.prepare('SELECT * FROM wallet_entries').get(),listing:db.prepare('SELECT * FROM listings').get(),order:db.prepare('SELECT * FROM transactions').get(),dispute:db.prepare('SELECT * FROM disputes').get()};
  for(let i=0;i<3;i++)migration.migrateSqlite(db);
  eq({...db.prepare('SELECT * FROM wallets').get()},{...before.wallet},'balance/version preserved');
  eq({...db.prepare('SELECT * FROM wallet_entries').get()},{...before.entry},'all ledger fields and original idempotency key preserved');
  eq(db.prepare('SELECT status FROM listings').get().status,'LOCKED','unknown legacy custody not reopened');
  for(const [table,name,old] of [['transactions','order',before.order],['disputes','dispute',before.dispute]]){const row=db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(name);for(const key of Object.keys(old))eq(row[key],old[key],table+' old column '+key);}
  const order=db.prepare('SELECT * FROM transactions').get();
  eq(order.inspected_at,null,'no fabricated inspection');eq(order.received_confirmed_by,null,'no fabricated receipt');
  eq(db.prepare('SELECT COUNT(*) n FROM order_shipping_snapshot').get().n,0,'no fabricated address');
  eq(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_fixture_preserve'").get().name,'idx_fixture_preserve','custom index survived table rebuild');
  eq(db.pragma('foreign_key_check').length,0,'foreign keys intact');
  db.close();db=new Database(file);migration.migrateSqlite(db);
  eq(db.prepare("SELECT idempotency_key FROM wallet_entries WHERE id='entry'").get().idempotency_key,'old-ledger-key','reopen preserves ledger');
  eq(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name LIKE '%__order_v12'").get().n,0,'no temporary migration tables left');
  console.log(`SQLITE ORDER MIGRATION: ${checks} assertions PASS; populated legacy schema preserved, repeated 4 times including reopen`);
}finally{if(db.open)db.close();assert.ok(path.resolve(file).startsWith(base+path.sep));for(const suffix of ['','-wal','-shm'])try{fs.unlinkSync(file+suffix);}catch(e){if(e.code!=='ENOENT')throw e;}fs.rmdirSync(dir);}
