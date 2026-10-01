// Đóng băng / kiểm lại phiên bản thực nghiệm.
//
//   npm run freeze:experiment                        đóng băng (nhãn mặc định thesis-experiment-v1.0)
//   npm run freeze:experiment -- --label=v1.1        đóng băng với nhãn khác
//   npm run freeze:verify                            mã hiện tại có đúng bản đã đóng băng không
//
// Chỉ đóng băng khi vòng kiểm thử đầy đủ gần nhất (npm run test:suite) đã xanh VÀ không file mã
// nguồn nào bị sửa sau thời điểm vòng đó bắt đầu — tức là kết quả kiểm thử đang ứng đúng với mã
// sẽ được đóng băng. Manifest KHÔNG chứa bí mật: giá trị các khoá bí mật trong .env.experiment
// được thay bằng dấu vân tay rút gọn để vẫn nhận ra khoá có bị đổi giữa chừng hay không.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  ROOT, MANIFEST, fileHashes, codeHash, latestModifiedAt, verifyFreeze,
} = require('../src/lib/freeze');

const args = process.argv.slice(2);

if (args.includes('--verify')) {
  const r = verifyFreeze();
  if (!r.frozen) { console.log(`\n  ${r.reason}.\n`); process.exit(2); }
  console.log(`\n  Bản đóng băng: ${r.label} (lúc ${r.frozenAt})`);
  if (r.ok) {
    console.log('  KHỚP — mã hiện tại đúng là bản đã đóng băng.\n');
    process.exit(0);
  }
  console.log('  LỆCH — mã đã thay đổi sau khi đóng băng:');
  for (const f of r.changed) console.log(`    sửa   ${f}`);
  for (const f of r.added) console.log(`    thêm  ${f}`);
  for (const f of r.removed) console.log(`    xoá   ${f}`);
  console.log('  Kết quả thu trên mã này KHÔNG còn là kết quả của bản đã đóng băng.\n');
  process.exit(1);
}

function refuse(msg) {
  console.error(`\n  Không đóng băng: ${msg}\n`);
  process.exit(1);
}

// --- Báo cáo kiểm thử gần nhất ------------------------------------------------------------
const reportsDir = path.join(ROOT, 'reports');
const suites = fs.existsSync(reportsDir)
  ? fs.readdirSync(reportsDir).filter((d) => d.startsWith('suite-')
    && fs.existsSync(path.join(reportsDir, d, 'summary.json'))).sort()
  : [];
if (suites.length === 0) refuse('chưa có báo cáo vòng kiểm thử đầy đủ nào — chạy `npm run test:suite` trước.');
const latestDir = suites[suites.length - 1];
const report = JSON.parse(fs.readFileSync(path.join(reportsDir, latestDir, 'summary.json'), 'utf8'));
if (!report.ok) refuse(`vòng kiểm thử gần nhất (${latestDir}) CÓ BỘ HỎNG.`);
if (!report.freshDatabase) refuse(`vòng kiểm thử gần nhất (${latestDir}) không chạy từ cơ sở dữ liệu trống.`);

const startedAtMs = Date.parse(report.startedAtIso || '');
if (!Number.isFinite(startedAtMs)) refuse(`báo cáo ${latestDir} thiếu mốc thời gian bắt đầu.`);
const latest = latestModifiedAt();
if (latest.at > startedAtMs) {
  refuse(`${latest.file} được sửa lúc ${new Date(latest.at).toISOString()}, SAU khi vòng kiểm thử gần nhất bắt đầu `
    + `(${report.startedAtIso}). Chạy lại \`npm run test:suite\` trên mã hiện tại rồi mới đóng băng.`);
}

// --- Phiên bản phụ thuộc thực tế ------------------------------------------------------------
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
const dependencies = {};
for (const name of Object.keys(pkg.dependencies || {})) {
  const entry = lock.packages && lock.packages[`node_modules/${name}`];
  dependencies[name] = entry ? entry.version : '(không có trong package-lock)';
}

// --- Cấu hình môi trường thực nghiệm (không lộ bí mật) ---------------------------------------
const experimentConfig = {};
const envFile = path.join(ROOT, '.env.experiment');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, key, value] = m;
    experimentConfig[key] = /SECRET|TOKEN|PASSWORD|KEY/.test(key)
      ? `<ẩn · sha256:${crypto.createHash('sha256').update(value).digest('hex').slice(0, 12)}>`
      : value;
  }
}

const labelArg = args.find((a) => a.startsWith('--label='));
const hashes = fileHashes();
const manifest = {
  label: labelArg ? labelArg.slice('--label='.length) : 'thesis-experiment-v1.0',
  frozenAt: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform} ${process.arch}`,
  app: { name: pkg.name, version: pkg.version },
  database: 'SQLite (node:sqlite, WAL) — xem ke-hoach-du-an mục 4',
  dependencies,
  experimentConfig,
  testReport: {
    directory: `reports/${latestDir}`,
    startedAt: report.startedAtIso,
    assertionsPassed: report.totalAssertionsPassed,
    assertionsFailed: report.totalAssertionsFailed,
    suites: report.suites.map((s) => `${s.suite}: ${s.ok ? 'PASS' : 'FAIL'} (${s.pass}/${s.pass + s.fail})`),
  },
  codeHash: codeHash(hashes),
  files: hashes,
};
fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));

console.log(`\n  Đã đóng băng ${manifest.label}`);
console.log(`  codeHash: ${manifest.codeHash}`);
console.log(`  ${Object.keys(hashes).length} file được băm · báo cáo kiểm thử: reports/${latestDir}`);
console.log(`  Manifest: ${path.relative(ROOT, MANIFEST)}`);
console.log('  Từ giờ kiểm lại bằng: npm run freeze:verify\n');
