/**
 * Runner kiểm thử trình duyệt thật cho luồng nạp PayPal Sandbox (fixture, KHÔNG phải Sandbox/backend thật).
 *
 *   cd cho-an-tam
 *   # playwright-core nằm NGOÀI repo (không sửa package.json); dùng Chrome đã cài, không tải trình duyệt.
 *   $env:NODE_PATH = 'C:\Users\tranq\tools\pw-runner\node_modules'
 *   node test/browser/paypal-wallet-browser.js [--only=B1B2,B3B4,B5]
 *
 * Mỗi lần chỉ MỘT runner được giữ trình duyệt (khoá tệp trong thư mục tạm); runner khác chờ tới lượt.
 * Thoát 0 khi không có FAIL (SKIP không làm hỏng nhưng được in rõ); 1 khi có FAIL; 2 khi thiếu công cụ.
 * Số ca ở đây KHÔNG cộng vào 212 UI / 47 recovery / backend suite.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

let chromium;
try {
  ({ chromium } = require('playwright-core'));
} catch (_) {
  console.error('Thiếu playwright-core (đặt NODE_PATH tới node_modules ngoài repo). Các ca CHƯA CHẠY.');
  process.exit(2);
}
const h = require('./paypal/harness');

const SPEC_DIR = path.join(__dirname, 'paypal');
const SPECS = [
  { id: 'B1B2', file: 'payment-flow.browser.js' },
  { id: 'B3B4', file: 'session.browser.js' },
  { id: 'B5', file: 'config.browser.js' },
];
const LOCK = path.join(os.tmpdir(), 'enclave-paypal-browser.lock');

const only = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const t0 = Date.now();
const totals = { pass: 0, fail: 0, skip: 0 };
const failedCases = [];
const skippedCases = [];

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
async function acquireLock(maxMs = 15 * 60 * 1000) {
  const end = Date.now() + maxMs;
  while (Date.now() < end) {
    try {
      fs.mkdirSync(LOCK);
      fs.writeFileSync(path.join(LOCK, 'pid'), String(process.pid));
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let owner = 0;
      try { owner = Number(fs.readFileSync(path.join(LOCK, 'pid'), 'utf8')); } catch (_) { /* chủ đang tạo */ }
      if (owner && !alive(owner)) { try { fs.rmSync(LOCK, { recursive: true, force: true }); } catch (_) { /* tranh chấp */ } continue; }
      await h.sleep(500);
    }
  }
  throw new Error('Không lấy được khoá trình duyệt trong 15 phút');
}
const releaseLock = () => { try { fs.rmSync(LOCK, { recursive: true, force: true }); } catch (_) { /* đã dọn */ } };

class PreconditionFailed extends Error {}

/** t.case(name, fn): chạy fn(c) với c.ok / c.precondition / c.skip / c.cleanup; dọn trong finally. */
function makeT(specId) {
  return {
    section: (title) => console.log(`\n[${specId}] ${title}`),
    async case(name, fn) {
      const cleanups = [];
      let caseFail = 0;
      let caseSkip = null;
      const c = {
        ok(cond, msg) {
          if (cond) { totals.pass++; console.log(`  ✅ ${msg}`); } else { totals.fail++; caseFail++; console.log(`  ❌ ${msg}`); }
          return !!cond;
        },
        precondition(cond, msg) {
          if (cond) { totals.pass++; console.log(`  ✅ [điều kiện dựng] ${msg}`); return; }
          totals.fail++; caseFail++;
          console.log(`  ❌ [điều kiện dựng] ${msg} — dừng ca, KHÔNG chạy assert hành vi`);
          throw new PreconditionFailed(msg);
        },
        skip(reason) { caseSkip = reason; throw new PreconditionFailed('SKIP ' + reason); },
        cleanup(fnc) { cleanups.push(fnc); },
      };
      console.log(`\n▶ ${name}`);
      try {
        await fn(c);
      } catch (e) {
        if (caseSkip) {
          totals.skip++; skippedCases.push(`${name}: ${caseSkip}`);
          console.log(`  ⏭  SKIP: ${caseSkip}`);
        } else if (!(e instanceof PreconditionFailed)) {
          totals.fail++; caseFail++;
          console.log(`  ❌ Ngoại lệ trong ca: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`);
        }
      } finally {
        for (const fnc of cleanups.reverse()) { try { await fnc(); } catch (e) { console.log(`  ⚠ dọn lỗi: ${e && e.message}`); } }
      }
      if (caseFail) failedCases.push(name);
    },
  };
}

async function main() {
  const exe = h.findChrome();
  if (!exe) { console.error('Không tìm thấy Chrome/Edge (đặt CHROME_PATH). Các ca CHƯA CHẠY.'); return 2; }
  const specs = SPECS.filter((s) => !only.length || only.includes(s.id));
  const present = specs.filter((s) => fs.existsSync(path.join(SPEC_DIR, s.file)));
  for (const s of specs) if (!present.includes(s)) { console.log(`⏭  ${s.id}: thiếu ${s.file} — CHƯA CHẠY`); totals.skip++; skippedCases.push(`${s.id}: thiếu ${s.file}`); }

  await acquireLock();
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: exe,
      headless: true,
      args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync'],
    });
    console.log(`Trình duyệt: ${exe} (${browser.version()}), playwright-core ${require('playwright-core/package.json').version}`);
    for (const s of present) {
      const spec = require(path.join(SPEC_DIR, s.file));
      console.log(`\n==== ${s.id} — ${spec.title || s.file} ====`);
      try {
        await spec.run({ h, t: makeT(s.id), browser });
      } catch (e) {
        totals.fail++;
        failedCases.push(`${s.id}: lỗi ngoài ca`);
        console.log(`  ❌ Spec ${s.id} lỗi ngoài ca: ${e && e.stack}`);
      }
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    releaseLock();
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nKết quả trình duyệt (fixture, ${secs}s): PASS ${totals.pass} · FAIL ${totals.fail} · SKIP ${totals.skip}`);
  if (skippedCases.length) console.log('SKIP:\n  - ' + skippedCases.join('\n  - '));
  if (failedCases.length) console.log('FAIL:\n  - ' + failedCases.join('\n  - '));
  return totals.fail ? 1 : 0;
}

process.on('SIGINT', () => { releaseLock(); process.exit(130); });
main().then((code) => process.exit(code), (e) => { console.error(e); releaseLock(); process.exit(1); });
