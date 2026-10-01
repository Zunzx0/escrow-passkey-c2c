/**
 * E2E cho tác vụ dọn challenge WebAuthn.
 *
 * Dựng sẵn sáu loại bản ghi trong auth_challenges rồi chạy script dọn (như một process riêng,
 * đúng cách vận hành sẽ chạy), sau đó kiểm từng loại:
 *
 *   A  hết hạn từ lâu, chưa dùng              -> bị dọn
 *   B  vừa hết hạn, còn trong khoảng ân hạn   -> giữ lại
 *   C  còn hiệu lực, chưa dùng                -> giữ lại
 *   D  đã dùng từ lâu                         -> bị dọn
 *   E  vừa dùng, còn trong khoảng ân hạn      -> giữ lại
 *   F  vừa phát hành qua API thật             -> giữ lại, và vẫn hoàn tất đăng nhập được
 *   G  đã dùng từ lâu, expires_at còn ở tương lai -> bị dọn (quy tắc "đã dùng và cũ")
 *
 * Kèm hai phép kiểm "dọn không tham gia quyết định an toàn":
 *   - reauth_grants và security_events không bị đụng tới;
 *   - challenge đã dùng rồi bị dọn thì phát lại vẫn bị từ chối.
 *
 * Yêu cầu: server đang chạy (npm start).
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const crypto = require('crypto');
const path = require('path');
const { spawnSync } = require('child_process');
const fetch = globalThis.fetch || require('node-fetch');
const { flows } = require('./helpers/accounts');
const { db } = require('../src/db');

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const RP_ID = process.env.WEBAUTHN_RP_ID || 'localhost';
const ORIGIN = process.env.WEBAUTHN_ORIGIN || BASE;
const GRACE = 3600;

let failures = 0;
function assert(cond, label) {
  console.log(`  ${cond ? '✅' : '❌'} ${label}`);
  if (!cond) failures++;
}
function section(title) { console.log(`\n${title}`); }

async function api(p, opts = {}, retried = false) {
  const { method = 'GET', body, token } = opts;
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(BASE + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let data = {};
  try { data = await res.json(); } catch (_) {}
  if (res.status === 429 && !retried) {
    console.log('  ⏳ Chạm rate limit — chờ 60 giây rồi thử lại…');
    await new Promise((r) => setTimeout(r, 61000));
    return api(p, opts, true);
  }
  return { status: res.status, data };
}

const iso = (msFromNow) => new Date(Date.now() + msFromNow).toISOString();
const MIN = 60 * 1000;

function insertChallenge({ expiresAt, usedAt = null }) {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO auth_challenges (id, user_id, transaction_id, challenge, purpose, context_data, expires_at, used_at)
     VALUES (?, NULL, NULL, ?, 'AUTHENTICATION', '{}', ?, ?)`
  ).run(id, crypto.randomBytes(32).toString('base64url'), expiresAt, usedAt);
  return id;
}
const exists = (id) => !!db.prepare('SELECT 1 FROM auth_challenges WHERE id = ?').get(id);
const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

async function main() {
  console.log(`\n=== E2E DỌN CHALLENGE: ${BASE} ===`);
  const rand = Date.now();
  const user = await flows.registerUser({ username: `cln_${rand}`, displayName: 'Cleanup User' });

  // Challenge D thật: đăng nhập thành công một lần, rồi đẩy used_at về quá khứ để nó thành
  // "đã dùng từ lâu" — dùng để kiểm rằng phát lại sau khi bị dọn vẫn bị từ chối.
  const replayOpt = await api('/api/passkeys/login/options', { method: 'POST' });
  const replayAssertion = user.auth.authenticate({ rpId: RP_ID, origin: ORIGIN, challenge: replayOpt.data.options.challenge });
  const replayBody = { authenticationSessionId: replayOpt.data.authenticationSessionId, response: replayAssertion };
  const firstUse = await api('/api/passkeys/login/verify', { method: 'POST', body: replayBody });
  if (firstUse.status !== 200) throw new Error(`Không chuẩn bị được challenge đã dùng: ${JSON.stringify(firstUse.data)}`);
  db.prepare('UPDATE auth_challenges SET used_at = ?, expires_at = ? WHERE id = ?')
    .run(iso(-120 * MIN), iso(-115 * MIN), replayOpt.data.authenticationSessionId);

  const A = insertChallenge({ expiresAt: iso(-120 * MIN) });
  const B = insertChallenge({ expiresAt: iso(-1 * MIN) });
  const C = insertChallenge({ expiresAt: iso(5 * MIN) });
  const D = replayOpt.data.authenticationSessionId;
  const E = insertChallenge({ expiresAt: iso(4 * MIN), usedAt: iso(-1 * MIN) });
  // G: đã dùng từ lâu nhưng expires_at vẫn ở tương lai (cấu hình TTL dài hơn ân hạn) — chỉ quy
  // tắc "đã dùng và cũ" bắt được, quy tắc "hết hạn" thì không.
  const G = insertChallenge({ expiresAt: iso(10 * MIN), usedAt: iso(-120 * MIN) });

  // F: phát hành qua API thật ngay trước khi dọn, hoàn tất đăng nhập SAU khi dọn.
  const fOpt = await api('/api/passkeys/login/options', { method: 'POST' });
  const F = fOpt.data.authenticationSessionId;

  const grantsBefore = count('reauth_grants');
  const eventsBefore = count('security_events');

  section('D01: Chạy script dọn như một process riêng');
  const run = spawnSync(process.execPath, ['scripts/cleanup-challenges.js', `--grace=${GRACE}`], {
    cwd: path.join(__dirname, '..'), env: process.env, encoding: 'utf8',
  });
  let summary = null;
  try { summary = JSON.parse(run.stdout.trim().split('\n').pop()); } catch (_) {}
  assert(run.status === 0 && summary, `Script kết thúc bình thường (mã ${run.status})`);
  assert(summary && summary.deletedExpired >= 1 && summary.deletedUsed >= 1, `Cả hai quy tắc dọn đều chạy (${JSON.stringify(summary)})`);

  section('D02: Đúng loại bị dọn, đúng loại được giữ');
  assert(!exists(A), 'A — hết hạn từ lâu: ĐÃ DỌN');
  assert(exists(B), 'B — vừa hết hạn, còn trong ân hạn: GIỮ');
  assert(exists(C), 'C — còn hiệu lực, chưa dùng: GIỮ');
  assert(!exists(D), 'D — đã dùng từ lâu: ĐÃ DỌN');
  assert(exists(E), 'E — vừa dùng, còn trong ân hạn: GIỮ');
  assert(exists(F), 'F — vừa phát hành: GIỮ');
  assert(!exists(G), 'G — đã dùng từ lâu dù chưa tới expires_at: ĐÃ DỌN (quy tắc "đã dùng và cũ")');

  section('D03: Challenge vừa phát hành vẫn hoàn tất được sau khi dọn');
  {
    const assertion = user.auth.authenticate({ rpId: RP_ID, origin: ORIGIN, challenge: fOpt.data.options.challenge });
    const r = await api('/api/passkeys/login/verify', {
      method: 'POST', body: { authenticationSessionId: F, response: assertion },
    });
    assert(r.status === 200 && !!r.data.token, `Đăng nhập bằng challenge F thành công (nhận ${r.status})`);
  }

  section('D04: Dọn không tham gia quyết định an toàn');
  {
    const replay = await api('/api/passkeys/login/verify', { method: 'POST', body: replayBody });
    assert(replay.status >= 400 && !replay.data.token,
      `Phát lại challenge đã dùng (đã bị dọn) vẫn bị từ chối (nhận ${replay.status} ${replay.data.error})`);
    assert(count('reauth_grants') === grantsBefore, 'reauth_grants KHÔNG bị đụng tới (căn cứ của bất biến phiếu dùng một lần)');
    assert(count('security_events') >= eventsBefore, 'security_events KHÔNG bị xoá');
  }

  console.log(failures === 0 ? '\n=== KẾT QUẢ: TẤT CẢ PASS ✅ ===\n' : `\n=== KẾT QUẢ: ${failures} KIỂM THỬ THẤT BẠI ❌ ===\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('LỖI KHÔNG MONG ĐỢI:', e);
  process.exit(1);
});
