/** Real Chromium + isolated API fixtures. No real PayPal/backend claims. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const h = require('./paypal/harness');
const BROWSER_CLEANUP_MS = 30000;
const SPEC_DIR = path.join(__dirname, 'paypal');
const SPECS = [
  { id: 'B1B2', file: 'payment-flow.browser.js' },
  { id: 'B3B4', file: 'session.browser.js' },
  { id: 'B5', file: 'config.browser.js' },
];

function selectSpecs(args, specs = SPECS, exists = s => fs.existsSync(path.join(SPEC_DIR, s.file))) {
  const filters = args.filter(a => a.startsWith('--only='));
  if (args.some(a => !a.startsWith('--only=')) || filters.length > 1) throw Error('Invalid runner arguments');
  const ids = filters.length ? filters[0].slice(7).split(',') : specs.map(s => s.id);
  if (!ids.length || ids.some(id => !id || !specs.some(s => s.id === id))) throw Error('Unknown or empty --only group');
  const selected = specs.filter(s => ids.includes(s.id));
  if (!selected.length || selected.some(s => !exists(s))) throw Error('Required browser spec is missing');
  return selected;
}

function createLock(lockPath, { isAlive = pid => {
  try { process.kill(pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; if (e.code === 'EPERM') return true; throw e; }
}, sleep = h.sleep } = {}) {
  const ownerFile = path.join(lockPath, 'owner-' + crypto.randomBytes(16).toString('hex') + '.json');
  let owned = false;
  return {
    async acquire({ maxMs = 15 * 60 * 1000, signal } = {}) {
      const end = Date.now() + maxMs;
      let emptySince;
      while (Date.now() < end) {
        if (signal?.aborted) throw Error('Browser lock wait cancelled');
        try {
          fs.mkdirSync(lockPath);
        } catch (e) {
          if (e.code !== 'EEXIST') throw e;
          let names;
          try { names = fs.readdirSync(lockPath); } catch (readError) { if (readError.code === 'ENOENT') continue; throw readError; }
          if (!names.length) {
            emptySince ??= Date.now();
            if (Date.now() - emptySince > 1000) throw Error('Incomplete browser lock; verify owner manually before cleanup');
          } else {
            emptySince = undefined;
            if (names.length !== 1 || !/^owner-[a-f0-9]{32}\.json$/.test(names[0])) throw Error('Unrecognized browser lock; verify owner manually before cleanup');
            let owner;
            try { owner = JSON.parse(fs.readFileSync(path.join(lockPath, names[0]), 'utf8')); }
            catch (readError) { if (readError.code === 'ENOENT') continue; throw readError; }
            if (!Number.isInteger(owner.pid) || owner.pid < 1 || !isAlive(owner.pid)) throw Error(`Stale browser lock at ${lockPath}; owner PID ${owner.pid}; verify owner and Chrome children manually before cleanup`);
          }
          await sleep(25);
          continue;
        }
        try { fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.pid }), { flag: 'wx' }); owned = true; return; }
        catch (error) {
          try { fs.unlinkSync(ownerFile); } catch (cleanupError) { if (cleanupError.code !== 'ENOENT') error.cleanupError = cleanupError; }
          try { fs.rmdirSync(lockPath); } catch (cleanupError) { error.cleanupError = cleanupError; }
          throw error;
        }
      }
      throw Error('Browser lock wait timed out');
    },
    release() {
      if (!owned) return false;
      // Immutable filename: a waiter or a previous holder never removes a new owner's file.
      try { fs.unlinkSync(ownerFile); } catch (e) { if (e.code === 'ENOENT') { owned = false; return false; } throw e; }
      owned = false;
      fs.rmdirSync(lockPath);
      return true;
    },
  };
}

class PreconditionFailed extends Error {}
function makeT(specId, totals, failedCases, skippedCases) {
  return {
    section: title => console.log(`\n[${specId}] ${title}`),
    async case(name, fn) {
      totals.cases++;
      const cleanups = [];
      let caseFail = 0, caseSkip;
      const fail = msg => { totals.fail++; caseFail++; console.log(`  ❌ ${msg}`); };
      const c = {
        ok(cond, msg) { if (cond) { totals.pass++; console.log(`  ✅ ${msg}`); } else fail(msg); return !!cond; },
        precondition(cond, msg) { if (cond) { totals.pass++; console.log(`  ✅ [điều kiện dựng] ${msg}`); } else { fail('[điều kiện dựng] ' + msg); throw new PreconditionFailed(msg); } },
        skip(reason) { caseSkip = reason; throw new PreconditionFailed('SKIP ' + reason); },
        cleanup(fnc) { cleanups.push(fnc); },
      };
      console.log(`\n▶ ${name}`);
      try { await fn(c); }
      catch (e) {
        if (caseSkip) { totals.skip++; skippedCases.push(`${name}: ${caseSkip}`); }
        else if (!(e instanceof PreconditionFailed)) fail('Ngoại lệ trong ca: ' + (e.stack || e));
      } finally {
        for (const fnc of cleanups.reverse()) {
          try { await h.withDeadline(fnc(), h.SESSION_CLEANUP_MS, 'case cleanup'); } catch (e) { fail('Dọn tài nguyên: ' + e.message); }
        }
      }
      if (caseFail) failedCases.push(name);
    },
  };
}

async function main(args = process.argv.slice(2)) {
  let specs;
  try { specs = selectSpecs(args); } catch (e) { console.error(e.message); return 2; }
  const exe = h.findChrome();
  if (!exe) { console.error('Chrome/Edge unavailable; no browser coverage'); return 2; }
  let chromium;
  try { ({ chromium } = require('playwright-core')); } catch (_) { console.error('playwright-core unavailable; no browser coverage'); return 2; }
  const lock = createLock(path.join(os.tmpdir(), 'enclave-paypal-browser.lock'));
  const abort = new AbortController();
  const totals = { pass: 0, fail: 0, skip: 0, cases: 0 };
  const failedCases = [], skippedCases = [];
  const started = Date.now();
  let browser, cleanupPromise, interrupted = false;
  const cleanup = () => cleanupPromise ||= (async () => {
    // Avoid racing context shutdown against browser shutdown.
    const errors = [];
    try { await h.withDeadline(h.closeAllSessions(), h.SESSION_CLEANUP_MS, 'session cleanup'); } catch (e) { errors.push(e); }
    try { if (browser) await h.withDeadline(browser.close(), BROWSER_CLEANUP_MS, 'browser cleanup'); } catch (e) { errors.push(e); }
    // Failed cleanup retains the owner's lock: do not let a second runner overlap a possibly live browser.
    if (!errors.length) { try { lock.release(); } catch (e) { errors.push(e); } }
    for (const e of errors) { totals.fail++; console.error('Cleanup failed:', e.message, `; lock retained at ${path.join(os.tmpdir(), 'enclave-paypal-browser.lock')}; owner PID ${process.pid}`); }
  })();
  const onSignal = () => { interrupted = true; abort.abort(); if (browser) void cleanup(); };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    await lock.acquire({ signal: abort.signal });
    if (!interrupted) {
      browser = await chromium.launch({ executablePath: exe, headless: true, handleSIGINT: false, handleSIGTERM: false,
        args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync'] });
      console.log(`Browser ${browser.version()}, playwright-core ${require('playwright-core/package.json').version}`);
      for (const s of specs) {
        if (interrupted) break;
        try { await require(path.join(SPEC_DIR, s.file)).run({ h, t: makeT(s.id, totals, failedCases, skippedCases), browser }); }
        catch (e) { totals.fail++; failedCases.push(s.id + ': ' + e.message); }
      }
    }
  } catch (e) { if (!interrupted) { totals.fail++; console.error(e.stack || e); } }
  finally {
    await cleanup();
    process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal);
  }
  console.log(`Kết quả trình duyệt (fixture, ${((Date.now()-started)/1000).toFixed(1)}s): PASS ${totals.pass} · FAIL ${totals.fail} · SKIP ${totals.skip} · CASES ${totals.cases}`);
  if (failedCases.length) console.error(failedCases.join('\n'));
  if (skippedCases.length) console.error(skippedCases.join('\n'));
  return interrupted ? 130 : totals.fail || totals.skip || !totals.cases ? 1 : 0;
}
module.exports = { createLock, selectSpecs, makeT, main };
if (require.main === module) main().then(code => process.exit(code), e => { console.error(e); process.exit(1); });
