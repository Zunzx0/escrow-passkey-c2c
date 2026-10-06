'use strict';
// Harness M2: môi trường test cục bộ, tài khoản/phiên thật trong CSDL, router thật, bất biến, đếm kết quả.
//
// Không đọc .env.test và không dùng credential của phiên khác. Chỉ chạy:
//   - SQLite: DB_PATH nằm trong data/test/ (mặc định data/test/paypal-m2-<tên>.db, bị xoá khi bắt đầu);
//   - PostgreSQL: DATABASE_URL trỏ tới localhost và CSDL có tên kết thúc _test (schema bị dựng lại).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..', '..');
const TEST_DIR = path.join(ROOT, 'data', 'test');

function localPgUrl(url) {
  const u = new URL(url);
  const name = decodeURIComponent(u.pathname.replace(/^\//, ''));
  if (!['127.0.0.1', 'localhost'].includes(u.hostname) || !/_test$/.test(name)) {
    throw new Error('M2 chỉ chạy trên PostgreSQL localhost có tên CSDL kết thúc _test');
  }
  return { url, name };
}

// Chuẩn bị môi trường TRƯỚC khi nạp src/db. Với PostgreSQL, dựng lại schema bằng tiến trình con đồng bộ.
function init(name, { reset = true } = {}) {
  process.env.APP_ENV = 'test';
  // Chính sách nạp của sản phẩm (5 yêu cầu PENDING, 100.000.000đ/ngày) sẽ chặn một tài khoản tạo nhiều yêu cầu
  // trong bộ kiểm thử. Nâng giới hạn CHỈ cho tiến trình test; giá trị mặc định của sản phẩm không đổi.
  process.env.TOPUP_MAX_PENDING = process.env.TOPUP_MAX_PENDING || '1000';
  process.env.TOPUP_MAX_PER_DAY = process.env.TOPUP_MAX_PER_DAY || '1000000000';
  if (process.env.DATABASE_URL) {
    const { url, name: dbName } = localPgUrl(process.env.DATABASE_URL);
    if (reset) {
      const script = `
        const { Client } = require('pg');
        (async () => {
          const admin = new Client({ connectionString: ${JSON.stringify(url.replace(/\/[^/?]+(\?|$)/, '/postgres$1'))} });
          await admin.connect();
          if (!(await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [${JSON.stringify(dbName)}])).rowCount) {
            await admin.query('CREATE DATABASE "' + ${JSON.stringify(dbName)} + '"');
          }
          await admin.end();
          const c = new Client({ connectionString: ${JSON.stringify(url)} });
          await c.connect();
          await c.query('DROP SCHEMA IF EXISTS app CASCADE; DROP SCHEMA IF EXISTS mock_provider CASCADE;');
          await c.end();
        })().catch((e) => { console.error(e.message); process.exit(1); });`;
      const r = spawnSync(process.execPath, ['-e', script], { cwd: ROOT, encoding: 'utf8', env: process.env });
      if (r.status !== 0) throw new Error(`Không dựng lại được CSDL thử nghiệm: ${r.stderr || r.stdout}`);
    }
  } else {
    if (!process.env.DB_PATH) process.env.DB_PATH = path.join('data', 'test', `paypal-m2-${name}.db`);
    const file = path.resolve(ROOT, process.env.DB_PATH);
    if (!file.startsWith(TEST_DIR + path.sep)) throw new Error(`DB_PATH=${file} không nằm trong data/test/`);
    if (reset) {
      for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(file + suffix); } catch (_) { /* chưa có */ } }
    }
  }
  fs.mkdirSync(TEST_DIR, { recursive: true });
  return { statePath: path.join(TEST_DIR, `paypal-m2-${name}-state.json`) };
}

function resetFake(statePath) { try { fs.unlinkSync(statePath); } catch (_) { /* chưa có */ } }

function config(overrides = {}) {
  return { enabled: true, mode: 'sandbox', clientId: 'm2-client-id', clientSecret: 'm2-client-secret',
    merchantId: 'M2MERCHANT01', webhookId: 'M2WEBHOOK01', frontendOrigin: 'https://enclave.id.vn',
    rateVndPerUsd: 25000, timeoutMs: 500, leaseMs: 12000, ...overrides };
}

// Tài khoản thật: dòng users + ví USER + phiên + access token đúng cách server cấp.
async function createAccount(db, { role = 'BUYER', balance = 0, label = 'm2' } = {}) {
  const { createSession } = require('../../src/lib/session');
  const { signAccessToken } = require('../../src/lib/auth');
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const username = `${label}-${crypto.randomBytes(4).toString('hex')}`;
  if (role === 'ADMIN') {
    // Quản trị viên chỉ đi qua bootstrap; ở đây mô phỏng vết sửa role SAU khi tài khoản đã ACTIVE.
    await db.prepare(`INSERT INTO users (id,username,display_name,role,password_hash,account_status,token_version,is_active,created_at,updated_at)
      VALUES (?,?,?,?,?,'PENDING_BOOTSTRAP',0,1,?,?)`).run(id, username, label, 'ADMIN', 'x', now, now);
    await db.prepare("UPDATE users SET account_status='ACTIVE' WHERE id=?").run(id);
    await db.prepare(`INSERT INTO passkey_credentials (id,user_id,credential_id,public_key,counter,transports,device_name,created_at)
      VALUES (?,?,?,?,0,'[]','fixture-m2',?)`).run(crypto.randomUUID(), id, 'cred-' + crypto.randomBytes(12).toString('hex'),
      Buffer.from('fixture-public-key'), now);
  } else {
    await db.prepare(`INSERT INTO users (id,username,display_name,role,password_hash,account_status,token_version,is_active,created_at,updated_at)
      VALUES (?,?,?,?,?,'ACTIVE',0,1,?,?)`).run(id, username, label, role, 'x', now, now);
    await db.prepare(`INSERT INTO wallets (id,user_id,wallet_type,available_balance,locked_balance,version,created_at,updated_at)
      VALUES (?,?, 'USER', ?, 0, 0, ?, ?)`).run(crypto.randomUUID(), id, balance, now, now);
    // Tài khoản ACTIVE phải có ít nhất một Passkey (bất biến 8). Đây là dòng giả lập, không phải xác thực thật.
    await db.prepare(`INSERT INTO passkey_credentials (id,user_id,credential_id,public_key,counter,transports,device_name,created_at)
      VALUES (?,?,?,?,0,'[]','fixture-m2',?)`).run(crypto.randomUUID(), id, 'cred-' + crypto.randomBytes(12).toString('hex'),
      Buffer.from('fixture-public-key'), now);
  }
  const { sessionId } = await createSession(id);
  const token = signAccessToken({ id, username, role: 'BUYER', account_status: 'ACTIVE', token_version: 0 }, 'full', sessionId);
  return { id, username, role, token };
}

const wallet = (db, userId) => db.prepare("SELECT * FROM wallets WHERE user_id=? AND wallet_type='USER'").get(userId);
const credits = (db, requestId) => db.prepare("SELECT * FROM wallet_entries WHERE request_id=? AND entry_type='TOPUP_CREDIT'").all(requestId);

// Router thật được gắn vào Express trong tiến trình test (không cần máy chủ đầy đủ).
async function startRouter(router) {
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/payments/paypal', router);
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.code || 'INTERNAL_ERROR', message: err.message }));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  // base gồm tiền tố /api/payments/paypal như trên máy chủ thật: route con viết dạng '/config', '/topup', ...
  return {
    base: `http://127.0.0.1:${server.address().port}/api/payments/paypal`,
    close: () => new Promise((r) => { server.closeAllConnections && server.closeAllConnections(); server.close(r); }),
  };
}

async function http(base, route, { method = 'GET', token, body } = {}) {
  const r = await fetch(base + route, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await r.json(); } catch (_) { /* không phải JSON */ }
  return { status: r.status, body: json, headers: r.headers };
}

// Bất biến: chín bất biến cũ (không đổi) + ba bất biến PayPal tách riêng. Trả về mảng vi phạm.
async function invariantSummary(db) {
  const { checkInvariants } = require('../../src/lib/invariants');
  const { checkPayPalInvariants } = require('../../src/lib/paypalInvariants');
  const core = await checkInvariants(db);
  const paypal = await checkPayPalInvariants(db);
  return {
    coreOk: core.ok && core.checked === 9,
    coreChecked: core.checked,
    coreViolations: core.violations,
    paypal: paypal.map((p) => ({ code: p.code, count: p.violations.length, sample: p.violations.slice(0, 2) })),
    paypalOk: paypal.every((p) => p.violations.length === 0),
  };
}

function tally(title) {
  let pass = 0; let fail = 0; let known = 0;
  const record = (cond, label, detail = '') => {
    if (cond) { pass++; console.log(`  ✅ ${label}`); } else { fail++; console.log(`  ❌ ${label}${detail ? ' — ' + detail : ''}`); }
  };
  return {
    title,
    ok(cond, label, detail) { record(Boolean(cond), label, detail); },
    // Lỗi ĐÃ BIẾT, được tái hiện có chủ đích: không làm hỏng bộ kiểm thử nhưng được đếm và in riêng.
    known(cond, label, detail = '') {
      if (cond) { pass++; console.log(`  ✅ ${label}`); }
      else { known++; console.log(`  ⚠ LỖI ĐÃ BIẾT (tái hiện): ${label}${detail ? ' — ' + detail : ''}`); }
    },
    eq(actual, expected, label) {
      const same = JSON.stringify(actual) === JSON.stringify(expected);
      record(same, label, same ? '' : `nhận ${JSON.stringify(actual)}, kỳ vọng ${JSON.stringify(expected)}`);
    },
    async rejects(fn, expectCode, label) {
      try { await fn(); record(false, label, 'không bị từ chối'); }
      catch (e) {
        const got = e.code || e.name;
        record(expectCode === undefined || got === expectCode, label, `mã ${got}`);
        return e;
      }
      return null;
    },
    section(name) { console.log(`\n${name}`); },
    summary() {
      console.log(`\n[${title}] ${pass} đạt, ${fail} hỏng, ${known} lỗi đã biết (tái hiện)`);
      return { pass, fail, known };
    },
  };
}

module.exports = {
  ROOT, init, resetFake, config, createAccount, wallet, credits, startRouter, http, invariantSummary, tally,
  assert, localPgUrl,
};
