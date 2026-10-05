// Chạy TOÀN BỘ vòng kiểm thử (hardening) trên môi trường test, từ cơ sở dữ liệu sạch.
//
//   npm run test:suite                   xoá DB test, chạy mọi bộ, ghi báo cáo vào reports/
//   npm run test:suite -- --keep-db      giữ DB test hiện có
//   npm run test:suite -- --only=payment-e2e,reconcile-e2e
//
// Trình tự:
//   1. Chỉ chạy khi APP_ENV=test và DB_PATH nằm trong data/test/ — không bao giờ xoá hay ghi
//      nhầm vào cơ sở dữ liệu dev hay thực nghiệm.
//   2. Dựng máy chủ test riêng, chờ /health báo environment=test.
//   3. Chạy lần lượt từng bộ kiểm thử, mỗi bộ một process, lưu nguyên văn đầu ra.
//   4. Khởi động lại máy chủ với FAULT_INJECT để chạy bộ rollback, rồi tắt.
//   5. Kiểm chín bất biến trên cơ sở dữ liệu test sau cùng.
//   6. Ghi reports/<mốc thời gian>/summary.json + summary.md; mã thoát khác 0 nếu có bộ hỏng.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ENV_FILE = '.env.test';

function fail(msg) {
  console.error(`\n  [suite] ${msg}\n`);
  process.exit(2);
}

if (process.env.APP_ENV !== 'test') fail('Chỉ chạy với môi trường test: npm run test:suite (nạp .env.test).');

// Hai nền lưu trữ. Với PostgreSQL, hàng rào an toàn là TÊN cơ sở dữ liệu: chỉ chấp nhận tên kết
// thúc bằng _test, nên một DATABASE_URL trỏ nhầm sang Supabase thật (tên `postgres`) bị từ chối
// trước khi bất kỳ bảng nào bị xoá.
const PG_URL = process.env.DATABASE_URL || '';
let dbPath = null;
let dbLabel;
if (PG_URL) {
  let dbName = '';
  try { dbName = decodeURIComponent(new URL(PG_URL).pathname.replace(/^\//, '')); } catch (_) {}
  if (!/_test$/.test(dbName)) fail(`DATABASE_URL trỏ tới cơ sở dữ liệu "${dbName}" — chỉ chạy trên cơ sở dữ liệu có tên kết thúc bằng _test.`);
  dbLabel = `PostgreSQL ${dbName}`;
} else {
  dbPath = path.resolve(ROOT, process.env.DB_PATH || '');
  const testDir = path.join(ROOT, 'data', 'test') + path.sep;
  if (!dbPath.startsWith(testDir)) fail(`DB_PATH=${dbPath} không nằm trong data/test/ — từ chối chạy.`);
  dbLabel = dbPath;
}

async function resetPostgres() {
  const { Client } = require('pg');
  const sslOff = process.env.PGSSL === 'disable' || /sslmode=disable/.test(PG_URL);
  const client = new Client({ connectionString: PG_URL, ssl: sslOff ? false : { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query('DROP SCHEMA IF EXISTS app CASCADE; DROP SCHEMA IF EXISTS mock_provider CASCADE;');
  } finally {
    await client.end();
  }
}

const BASE = process.env.BASE_URL || `http://localhost:${process.env.PORT}`;
const args = process.argv.slice(2);
const keepDb = args.includes('--keep-db');
const onlyArg = args.find((a) => a.startsWith('--only='));
const only = onlyArg ? onlyArg.slice('--only='.length).split(',') : null;

// Bài kiểm thử đầy đủ dựng một máy chủ test có cả giao diện tĩnh và cổng thanh toán
// mô phỏng. Railway API có thể dùng SERVE_FRONTEND=0, nhưng sao chép giá trị đó
// sang .env.test sẽ làm hardening-e2e báo thiếu robots.txt/security.txt. Dừng sớm
// với lời giải thích rõ ràng, trước khi xoá DB test và chạy các bộ mất nhiều phút.
if (!only) {
  const disabled = [
    ['SERVE_FRONTEND', 'robots.txt/security.txt và các bài kiểm thử giao diện'],
    ['MOCK_PROVIDER_CHECKOUT', 'các bài kiểm thử thanh toán mô phỏng'],
  ].filter(([name]) => process.env[name] === '0');
  if (disabled.length) {
    fail(`Bộ test đầy đủ cần bật ${disabled.map(([name, purpose]) => `${name}=1 (${purpose})`).join(', ')} trong .env.test. SERVE_FRONTEND=0 chỉ dành cho Railway API; giao diện production do Vercel phục vụ.`);
  }
}

// Thứ tự: bộ không cần máy chủ trước, rồi lõi -> lớp mua bán -> an toàn -> các nhánh mới.
const SUITES = [
  'invariants-unit', 'e2e', 'market-e2e', 'security-e2e', 'hybrid-e2e', 'hardening-e2e',
  'payment-e2e', 'reconcile-e2e', 'counter-e2e', 'cleanup-e2e', 'notification-e2e', 'checkout-e2e',
  'dispute-race-e2e', 'security-report-regression-e2e',
  'username-enumeration-e2e',
  'listing-lifecycle-e2e',
  'passkey-registration-race-e2e',
  'topup-concurrency-e2e',
  'topup-idempotency-e2e',
  'admin-provenance-e2e',
].filter((s) => !only || only.includes(s));
const RUN_ROLLBACK = !only || only.includes('rollback-e2e');

const startedAtIso = new Date().toISOString();
const stamp = startedAtIso.replace(/[:.]/g, '-');
const reportDir = path.join(ROOT, 'reports', `suite-${stamp}`);
fs.mkdirSync(reportDir, { recursive: true });

async function health() {
  try {
    const res = await fetch(`${BASE}/health`);
    return await res.json();
  } catch (_) {
    return null;
  }
}

async function startServer(extraEnv, logName) {
  if (await health()) fail(`Đã có máy chủ đang chạy ở ${BASE}. Tắt nó trước khi chạy bộ kiểm thử.`);
  const log = fs.openSync(path.join(reportDir, logName), 'w');
  const child = spawn(process.execPath, [`--env-file=${ENV_FILE}`, 'src/server.js'], {
    cwd: ROOT, env: { ...process.env, ...extraEnv }, stdio: ['ignore', log, log],
  });
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const h = await health();
    if (h) {
      if (h.environment !== 'test') { child.kill(); fail(`Máy chủ báo environment=${h.environment}, không phải test.`); }
      return child;
    }
    if (child.exitCode !== null) fail(`Máy chủ test không khởi động được — xem ${logName}.`);
  }
  child.kill();
  fail('Máy chủ test không phản hồi /health sau 30 giây.');
}

function stopServer(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.kill();
  });
}

function runNode(script, extraEnv = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [`--env-file=${ENV_FILE}`, script], {
      cwd: ROOT, env: { ...process.env, ...extraEnv },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out, ms: Date.now() - started }));
  });
}

function countMarks(out) {
  return {
    pass: (out.match(/✅/g) || []).length,
    fail: (out.match(/❌/g) || []).length,
  };
}

async function main() {
  console.log(`\n=== VÒNG KIỂM THỬ ĐẦY ĐỦ — môi trường test (${BASE}) ===`);
  console.log(`  Cơ sở dữ liệu: ${dbLabel}`);
  console.log(`  Báo cáo:       ${reportDir}\n`);

  if (!keepDb) {
    if (PG_URL) {
      await resetPostgres();
    } else {
      const base = dbPath.replace(/\.db$/i, '');
      for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`,
        `${base}.mock-provider.db`, `${base}.mock-provider.db-wal`, `${base}.mock-provider.db-shm`]) {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      }
    }
    console.log('  Đã xoá cơ sở dữ liệu test — mọi bộ chạy từ trạng thái trống.\n');
  }

  const results = [];
  let server = await startServer({}, 'server.log');
  try {
    for (const suite of SUITES) {
      process.stdout.write(`  ▶ ${suite.padEnd(20)} `);
      const r = await runNode(`test/${suite}.js`);
      fs.writeFileSync(path.join(reportDir, `${suite}.log`), r.out);
      const marks = countMarks(r.out);
      const ok = r.code === 0 && marks.fail === 0;
      results.push({ suite, ok, exitCode: r.code, ...marks, seconds: Math.round(r.ms / 1000) });
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(marks.pass).padStart(3)} ✓  ${String(marks.fail).padStart(2)} ✗  ${Math.round(r.ms / 1000)}s`);
    }
  } finally {
    await stopServer(server);
  }

  if (RUN_ROLLBACK) {
    const faultPoint = 'release:after-wallet-update';
    server = await startServer({ FAULT_INJECT: faultPoint }, 'server-fault.log');
    try {
      process.stdout.write(`  ▶ ${'rollback-e2e'.padEnd(20)} `);
      const r = await runNode('test/rollback-e2e.js');
      fs.writeFileSync(path.join(reportDir, 'rollback-e2e.log'), r.out);
      const marks = countMarks(r.out);
      const ok = r.code === 0 && marks.fail === 0 && marks.pass > 0;
      results.push({ suite: 'rollback-e2e', ok, exitCode: r.code, ...marks, seconds: Math.round(r.ms / 1000), faultInject: faultPoint });
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(marks.pass).padStart(3)} ✓  ${String(marks.fail).padStart(2)} ✗  ${Math.round(r.ms / 1000)}s  (FAULT_INJECT=${faultPoint})`);
    } finally {
      await stopServer(server);
    }
  }

  process.stdout.write(`  ▶ ${'check-invariants'.padEnd(20)} `);
  const inv = await runNode('scripts/check-invariants.js');
  fs.writeFileSync(path.join(reportDir, 'check-invariants.log'), inv.out);
  results.push({ suite: 'check-invariants', ok: inv.code === 0, exitCode: inv.code, pass: inv.code === 0 ? 9 : 0, fail: inv.code === 0 ? 0 : 1, seconds: Math.round(inv.ms / 1000) });
  console.log(inv.code === 0 ? 'PASS  chín bất biến đúng trên DB test sau toàn bộ vòng chạy' : 'FAIL  có bất biến bị vi phạm');

  const totalPass = results.reduce((s, r) => s + r.pass, 0);
  const totalFail = results.reduce((s, r) => s + r.fail, 0);
  const allOk = results.every((r) => r.ok);
  const summary = {
    startedAt: stamp,
    // Mốc bắt đầu chính xác: freeze-experiment dùng nó để xác nhận không file mã nào bị sửa
    // sau khi vòng kiểm thử này bắt đầu.
    startedAtIso,
    environment: 'test',
    baseUrl: BASE,
    database: dbPath ? path.relative(ROOT, dbPath) : dbLabel,
    freshDatabase: !keepDb,
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    ok: allOk,
    totalAssertionsPassed: totalPass,
    totalAssertionsFailed: totalFail,
    suites: results,
  };
  fs.writeFileSync(path.join(reportDir, 'summary.json'), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(reportDir, 'summary.md'), [
    `# Vòng kiểm thử đầy đủ — ${stamp}`,
    '',
    `- Môi trường: test (${BASE}), cơ sở dữ liệu \`${summary.database}\`${keepDb ? '' : ' (tạo mới từ trống)'}`,
    `- Node ${process.version}, ${summary.platform}`,
    `- Kết quả: **${allOk ? 'TẤT CẢ PASS' : 'CÓ BỘ HỎNG'}** — ${totalPass} phép kiểm đạt, ${totalFail} phép kiểm hỏng`,
    '',
    '| Bộ | Kết quả | Đạt | Hỏng | Thời gian |',
    '|---|---|---:|---:|---:|',
    ...results.map((r) => `| ${r.suite}${r.faultInject ? ` (FAULT_INJECT=${r.faultInject})` : ''} | ${r.ok ? 'PASS' : 'FAIL'} | ${r.pass} | ${r.fail} | ${r.seconds}s |`),
    '',
    'Đầu ra nguyên văn của từng bộ nằm cùng thư mục (`<bộ>.log`), log máy chủ ở `server.log` và `server-fault.log`.',
    '',
  ].join('\n'));

  console.log(`\n=== ${allOk ? 'TẤT CẢ PASS ✅' : 'CÓ BỘ HỎNG ❌'} — ${totalPass} phép kiểm đạt, ${totalFail} hỏng ===`);
  console.log(`  Báo cáo: ${path.relative(ROOT, reportDir)}\\summary.md\n`);
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => {
  console.error('[suite] lỗi:', e);
  process.exit(1);
});
