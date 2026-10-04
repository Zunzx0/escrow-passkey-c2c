/**
 * Hồi quy: hai yêu cầu đăng ký Passkey ĐẦU TIÊN của cùng một tài khoản chạy đồng thời
 * (nhánh claude/fix-passkey-first-registration-race).
 *
 * Tình huống: người dùng mở hai tab (hoặc bấm hai lần trên hai thiết bị) ở bước 2 của đăng ký,
 * mỗi tab xin một challenge riêng rồi gửi /register/passkey/verify gần như cùng lúc. Cả hai
 * request đều qua requireAccountStatus('PENDING_PASSKEY') vì cùng đọc trạng thái TRƯỚC khi bên
 * kia commit. Trước khi sửa: giao dịch của bên thua chạy tới INSERT ví và vấp UNIQUE(wallets.
 * user_id) -> lỗi SQL không được ánh xạ -> 500 INTERNAL_ERROR chung chung (dữ liệu không hỏng nhờ
 * rollback, nhưng phản hồi không cho client biết chuyện gì xảy ra).
 *
 * Kỳ vọng sau khi sửa (kích hoạt có điều kiện `WHERE account_status='PENDING_PASSKEY'` là câu
 * lệnh đầu tiên của giao dịch):
 *   - đúng một request 201, request còn lại 409 INVALID_ACCOUNT_STATUS — CÙNG mã lỗi mà
 *     requireAccountStatus trả khi request thứ hai đến sau khi bên thắng đã commit, nên client
 *     nhận một phản hồi duy nhất bất kể thời điểm; không bao giờ 500;
 *   - tài khoản ACTIVE với đúng 1 credential (của bên thắng), đúng 1 ví, đúng 1 bút toán
 *     DEMO_TOPUP, số dư bằng đúng mức cấp ban đầu;
 *   - challenge của bên thua không bị tiêu thụ (giao dịch đã rollback);
 *   - đăng nhập bằng Passkey của bên thắng được, của bên thua không;
 *   - 9 bất biến vẫn đúng.
 *
 * Yêu cầu: server test đang chạy (`npm run start:test`).
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const crypto = require('crypto');
const { createAuthenticator } = require('./softwareAuthenticator');
const { DEFAULT_PASSWORD } = require('./helpers/hybrid');
const { checkInvariants } = require('../src/lib/invariants');
const { db } = require('../src/db');

const BASE = process.env.BASE_URL || 'http://localhost:3100';
const RP_ID = process.env.WEBAUTHN_RP_ID || 'localhost';
const ORIGIN = process.env.WEBAUTHN_ORIGIN || BASE;
const DEMO_BALANCE = parseInt(process.env.DEMO_BUYER_INITIAL_BALANCE || '5000000', 10);
const ROUNDS = 3;

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

async function createPendingAccount(label) {
  const username = `${label}-${Date.now()}-${crypto.randomUUID().slice(0, 6)}`.toLowerCase();
  const acc = await api('/api/passkeys/register/account', {
    method: 'POST', body: { username, displayName: `Tài khoản ${label}`, password: DEFAULT_PASSWORD },
  });
  if (acc.status !== 201) throw new Error(`tạo tài khoản thất bại: ${JSON.stringify(acc.data)}`);
  return { username, token: acc.data.token, userId: acc.data.user.id };
}

async function registrationOptions(token) {
  const r = await api('/api/passkeys/register/passkey/options', { method: 'POST', token, body: {} });
  if (r.status !== 200) throw new Error(`xin options thất bại: ${JSON.stringify(r.data)}`);
  return r.data;
}

function verify(token, sessionId, response) {
  return api('/api/passkeys/register/passkey/verify', {
    method: 'POST', token, body: { registrationSessionId: sessionId, response },
  });
}

async function accountState(userId) {
  const user = await db.prepare('SELECT account_status FROM users WHERE id = ?').get(userId);
  const creds = await db.prepare('SELECT credential_id FROM passkey_credentials WHERE user_id = ?').all(userId);
  const wallets = await db.prepare("SELECT id, available_balance, locked_balance FROM wallets WHERE user_id = ? AND wallet_type = 'USER'").all(userId);
  const entries = wallets.length
    ? await db.prepare("SELECT COUNT(*) AS n FROM wallet_entries WHERE wallet_id = ? AND entry_type = 'DEMO_TOPUP'").get(wallets[0].id)
    : { n: 0 };
  return { status: user.account_status, creds: creds.map((c) => c.credential_id), wallets, demoEntries: Number(entries.n) };
}

async function loginWith(auth) {
  const opt = await api('/api/passkeys/login/options', { method: 'POST' });
  const assertion = auth.authenticate({ rpId: RP_ID, origin: ORIGIN, challenge: opt.data.options.challenge, uv: true });
  return api('/api/passkeys/login/verify', {
    method: 'POST', body: { authenticationSessionId: opt.data.authenticationSessionId, response: assertion },
  });
}

/** Kiểm phản hồi của BÊN THUA: chỉ chấp nhận đúng một mã lỗi đã định nghĩa, không bao giờ 5xx. */
function assertLoser(res, label) {
  assert(res.status < 500, `${label}: không phải lỗi 5xx chung (nhận ${res.status} ${res.data.error})`);
  assert(res.status === 409 && res.data.error === 'INVALID_ACCOUNT_STATUS',
    `${label}: nhận 409 INVALID_ACCOUNT_STATUS (thực tế ${res.status} ${res.data.error})`);
}

async function main() {
  // =======================================================================================
  section(`K1: Hai thiết bị, hai challenge, gửi verify ĐỒNG THỜI (${ROUNDS} tài khoản)`);
  // =======================================================================================
  for (let round = 1; round <= ROUNDS; round++) {
    const acc = await createPendingAccount(`race-k1-${round}`);
    const devA = createAuthenticator();
    const devB = createAuthenticator();
    const optA = await registrationOptions(acc.token);
    const optB = await registrationOptions(acc.token);
    const respA = devA.register({ rpId: RP_ID, origin: ORIGIN, challenge: optA.options.challenge, uv: true });
    const respB = devB.register({ rpId: RP_ID, origin: ORIGIN, challenge: optB.options.challenge, uv: true });

    const [rA, rB] = await Promise.all([
      verify(acc.token, optA.registrationSessionId, respA),
      verify(acc.token, optB.registrationSessionId, respB),
    ]);
    console.log(`  [K1#${round}] A -> ${rA.status} ${rA.data.error || 'OK'}   B -> ${rB.status} ${rB.data.error || 'OK'}`);

    const winners = [rA, rB].filter((r) => r.status === 201);
    assert(winners.length === 1, `#${round}: đúng một request kích hoạt được tài khoản (thực tế ${winners.length})`);
    const aWon = rA.status === 201;
    assertLoser(aWon ? rB : rA, `#${round} bên thua`);

    const st = await accountState(acc.userId);
    const winnerCred = (aWon ? respA : respB).id;
    const loserSession = aWon ? optB.registrationSessionId : optA.registrationSessionId;
    assert(st.status === 'ACTIVE', `#${round}: tài khoản ACTIVE (thực tế ${st.status})`);
    assert(st.creds.length === 1 && st.creds[0] === winnerCred, `#${round}: đúng 1 credential, là của bên thắng (có ${st.creds.length})`);
    assert(st.wallets.length === 1, `#${round}: đúng 1 ví (có ${st.wallets.length})`);
    assert(st.demoEntries === 1, `#${round}: đúng 1 bút toán DEMO_TOPUP (có ${st.demoEntries})`);
    assert(st.wallets.length === 1 && st.wallets[0].available_balance === DEMO_BALANCE && st.wallets[0].locked_balance === 0,
      `#${round}: số dư đúng bằng mức cấp ban đầu ${DEMO_BALANCE}, không nhân đôi`);
    const loserChallenge = await db.prepare('SELECT used_at FROM auth_challenges WHERE id = ?').get(loserSession);
    assert(loserChallenge && loserChallenge.used_at === null, `#${round}: challenge của bên thua không bị tiêu thụ (giao dịch đã rollback)`);

    const loginWinner = await loginWith(aWon ? devA : devB);
    const loginLoser = await loginWith(aWon ? devB : devA);
    assert(loginWinner.status === 200, `#${round}: đăng nhập bằng Passkey của bên thắng được (nhận ${loginWinner.status})`);
    assert(loginLoser.status >= 400 && loginLoser.status < 500, `#${round}: Passkey của bên thua không đăng nhập được (nhận ${loginLoser.status} ${loginLoser.data.error})`);
  }

  // =======================================================================================
  section('K2: Cùng MỘT phản hồi (cùng challenge) gửi hai lần đồng thời');
  // =======================================================================================
  {
    const acc = await createPendingAccount('race-k2');
    const dev = createAuthenticator();
    const opt = await registrationOptions(acc.token);
    const resp = dev.register({ rpId: RP_ID, origin: ORIGIN, challenge: opt.options.challenge, uv: true });
    const [r1, r2] = await Promise.all([
      verify(acc.token, opt.registrationSessionId, resp),
      verify(acc.token, opt.registrationSessionId, resp),
    ]);
    console.log(`  [K2] 1 -> ${r1.status} ${r1.data.error || 'OK'}   2 -> ${r2.status} ${r2.data.error || 'OK'}`);
    const winners = [r1, r2].filter((r) => r.status === 201);
    assert(winners.length === 1, `Đúng một request thành công (thực tế ${winners.length})`);
    const loser = r1.status === 201 ? r2 : r1;
    // Bên thua bị chặn ở một trong ba chỗ tuỳ thời điểm, cả ba đều là mã lỗi đã định nghĩa:
    // middleware trạng thái (bên thắng đã commit), bước kiểm used_at ngoài giao dịch, hoặc bước
    // tiêu thụ challenge nguyên tử trong giao dịch.
    const allowed = { INVALID_ACCOUNT_STATUS: 409, CHALLENGE_REPLAY: 400 };
    assert(allowed[loser.data.error] === loser.status,
      `Bên thua nhận mã lỗi đã định nghĩa {INVALID_ACCOUNT_STATUS 409, CHALLENGE_REPLAY 400} (thực tế ${loser.status} ${loser.data.error})`);
    const st = await accountState(acc.userId);
    assert(st.status === 'ACTIVE' && st.creds.length === 1 && st.wallets.length === 1 && st.demoEntries === 1,
      `Đúng 1 credential, 1 ví, 1 bút toán DEMO_TOPUP (có ${st.creds.length}/${st.wallets.length}/${st.demoEntries})`);
  }

  // =======================================================================================
  section('K3: verify sau khi tài khoản đã ACTIVE (tuần tự) vẫn cùng mã lỗi');
  // =======================================================================================
  {
    const acc = await createPendingAccount('race-k3');
    const devA = createAuthenticator();
    const devB = createAuthenticator();
    const optA = await registrationOptions(acc.token);
    const optB = await registrationOptions(acc.token);
    const rA = await verify(acc.token, optA.registrationSessionId,
      devA.register({ rpId: RP_ID, origin: ORIGIN, challenge: optA.options.challenge, uv: true }));
    assert(rA.status === 201, `Lần verify đầu kích hoạt tài khoản (nhận ${rA.status})`);
    const rB = await verify(acc.token, optB.registrationSessionId,
      devB.register({ rpId: RP_ID, origin: ORIGIN, challenge: optB.options.challenge, uv: true }));
    assertLoser(rB, 'Lần verify thứ hai (tuần tự)');
    const st = await accountState(acc.userId);
    assert(st.creds.length === 1 && st.wallets.length === 1 && st.demoEntries === 1, 'Vẫn đúng 1 credential, 1 ví, 1 bút toán DEMO_TOPUP');
  }

  const inv = await checkInvariants(db);
  assert(inv.ok, `${inv.checked} bất biến đều đúng${inv.ok ? '' : ` (vi phạm: ${JSON.stringify(inv.violations)})`}`);

  console.log(failures ? `\n${failures} FAIL` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error('[passkey-registration-race] lỗi:', e); process.exit(1); });
