/**
 * Hồi quy cho lớp giảm dò username ở bước tạo tài khoản.
 *
 * Dùng một server con và DB SQLite riêng để các xô giới hạn tần suất có trạng thái xác định,
 * không phụ thuộc các bộ kiểm thử chạy trước. Server chính của test:suite vẫn chạy trên cổng
 * 3100; bộ này dùng cổng 3181 và không chạm vào DB chung.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 3181;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_RELATIVE = path.join('data', 'test', `username-enumeration-${process.pid}.db`);
const DB_ABSOLUTE = path.join(ROOT, DB_RELATIVE);

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed += 1;
    console.log(`  ✅ ${label}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${label}`);
  }
}

async function postRegistration(username) {
  const response = await fetch(`${BASE}/api/passkeys/register/account`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username,
      displayName: 'Người kiểm thử',
      password: 'MatKhau-AnToan-123!',
    }),
  });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data, retryAfter: response.headers.get('retry-after') };
}

async function waitForHealth(child) {
  for (let i = 0; i < 60; i += 1) {
    if (child.exitCode !== null) throw new Error('Server kiểm thử dừng trước khi sẵn sàng');
    try {
      const response = await fetch(`${BASE}/health`);
      if (response.ok) return;
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Server kiểm thử không sẵn sàng sau 15 giây');
}

function stopChild(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill();
  });
}

function removeTestDb() {
  const base = DB_ABSOLUTE.replace(/\.db$/i, '');
  for (const file of [DB_ABSOLUTE, `${DB_ABSOLUTE}-wal`, `${DB_ABSOLUTE}-shm`,
    `${base}.mock-provider.db`, `${base}.mock-provider.db-wal`, `${base}.mock-provider.db-shm`]) {
    try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

async function main() {
  removeTestDb();
  fs.mkdirSync(path.dirname(DB_ABSOLUTE), { recursive: true });

  const env = {
    ...process.env,
    APP_ENV: 'test',
    PORT: String(PORT),
    BASE_URL: BASE,
    DB_PATH: DB_RELATIVE,
    WEBAUTHN_RP_ID: 'localhost',
    WEBAUTHN_ORIGIN: BASE,
    JWT_SECRET: crypto.randomBytes(32).toString('hex'),
    PAYMENT_WEBHOOK_SECRET: crypto.randomBytes(32).toString('hex'),
    RATE_LIMIT_AUTH_PER_MINUTE: '50',
    RATE_LIMIT_REGISTRATION_USERNAME_PER_MINUTE: '3',
    USERNAME_PROBE_LIMIT_PER_HOUR: '3',
    RECONCILE_INTERVAL_SECONDS: '0',
    CHALLENGE_CLEANUP_INTERVAL_SECONDS: '0',
    MOCK_PROVIDER_CHECKOUT: '0',
    SERVE_FRONTEND: '0',
  };
  delete env.DATABASE_URL;
  delete env.ADMIN_BOOTSTRAP_USERNAME;
  delete env.ADMIN_BOOTSTRAP_PASSWORD;
  delete env.FAULT_INJECT;
  delete env.FAULT_INJECT_MODE;

  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOutput = '';
  child.stdout.on('data', (chunk) => { serverOutput += chunk; });
  child.stderr.on('data', (chunk) => { serverOutput += chunk; });

  try {
    await waitForHealth(child);
    const suffix = crypto.randomBytes(4).toString('hex');
    const known = `known_${suffix}`;
    const knownTwo = `known2_${suffix}`;
    const knownThree = `known3_${suffix}`;

    const created = await postRegistration(known);
    assert(created.status === 201 && !!created.data.token,
      `Tên mới tạo được tài khoản chờ Passkey (nhận ${created.status})`);
    const createdTwo = await postRegistration(knownTwo);
    const createdThree = await postRegistration(knownThree);
    assert(createdTwo.status === 201 && createdThree.status === 201,
      'Nhiều tên mới hợp lệ từ cùng IP không bị tính là hành vi dò tài khoản');

    const duplicate = await postRegistration(known);
    const duplicateDump = JSON.stringify(duplicate.data).toLowerCase();
    assert(duplicate.status === 409 && duplicate.data.error === 'REGISTRATION_UNAVAILABLE',
      `Tên không khả dụng nhận mã chung REGISTRATION_UNAVAILABLE (nhận ${duplicate.status} ${duplicate.data.error})`);
    assert(!duplicate.data.token && !duplicate.data.user,
      'Phản hồi từ chối không cấp token hoặc dữ liệu tài khoản');
    assert(!duplicateDump.includes('đã tồn tại') && !duplicateDump.includes('username_taken'),
      'Phản hồi không nói tên đăng nhập đã tồn tại');

    const sameThird = await postRegistration(known);
    const sameFourth = await postRegistration(known);
    assert(sameThird.status === 409 && sameFourth.status === 429 && Number(sameFourth.retryAfter) > 0,
      'Thử lặp cùng một username bị giới hạn theo cặp IP–username và có Retry-After');

    const raceName = `race_${suffix}`;
    const race = await Promise.all([postRegistration(raceName), postRegistration(raceName)]);
    const raceStatuses = race.map((result) => result.status).sort((a, b) => a - b);
    const raceRejected = race.find((result) => result.status === 409);
    assert(raceStatuses.join(',') === '201,409',
      `Hai yêu cầu cùng tên chỉ tạo một tài khoản (nhận ${raceStatuses.join(',')})`);
    assert(raceRejected && raceRejected.data.error === 'REGISTRATION_UNAVAILABLE',
      'Yêu cầu thua cuộc đua cũng nhận mã lỗi chung');

    const thirdKnown = await postRegistration(knownTwo);
    const fourthKnown = await postRegistration(knownThree);
    assert(thirdKnown.status === 409 && thirdKnown.data.error === 'REGISTRATION_UNAVAILABLE',
      `Username đã có thứ ba vẫn nhận phản hồi chung trong hạn mức (nhận ${thirdKnown.status})`);
    assert(fourthKnown.status === 429 && fourthKnown.data.error === 'USERNAME_PROBE_LIMITED',
      `Lần dò trúng username đã có tiếp theo bị chặn (nhận ${fourthKnown.status} ${fourthKnown.data.error})`);
    assert(Number(fourthKnown.retryAfter) > 0, 'Phản hồi chặn dò username có Retry-After');
  } finally {
    await stopChild(child);
    removeTestDb();
  }

  if (failed > 0) {
    if (serverOutput) console.error('\n--- server con ---\n' + serverOutput);
    console.error(`\nKẾT QUẢ: ${failed} thất bại, ${passed} đạt`);
    process.exit(1);
  }
  console.log(`\nKẾT QUẢ: ${passed}/${passed} phép kiểm đạt`);
}

main().catch((error) => {
  console.error('LỖI KHÔNG MONG ĐỢI:', error);
  process.exit(1);
});
