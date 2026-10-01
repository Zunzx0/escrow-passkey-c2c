/**
 * E2E cho tín hiệu rủi ro signCount (counter) của Passkey.
 *
 * Thiết kế đã chốt: counter là TÍN HIỆU, không phải điều kiện cứng. Khi cả counter cũ và mới
 * đều khác 0 mà counter mới <= counter cũ thì ghi COUNTER_ANOMALY; xác thực VẪN thành công nếu
 * mọi điều kiện WebAuthn khác hợp lệ; không khoá credential; không kết luận "clone".
 *
 *   C01  0 -> 0        Passkey đồng bộ luôn báo 0          không bất thường
 *   C02  0 -> N        bộ xác thực bắt đầu đếm            không bất thường
 *   C03  N -> N+1      bình thường                         không bất thường
 *   C04  N -> N        đứng yên                            BẤT THƯỜNG, vẫn đăng nhập được
 *   C05  N -> N-1      lùi                                 BẤT THƯỜNG, vẫn đăng nhập được
 *   C06  N+1 sau bất thường                                 bình thường trở lại
 *   C07  N -> 0        về 0 (một bên bằng 0)               không bất thường theo quy tắc
 *   C08  bất thường ở lối XÁC THỰC LẠI (không phải đăng nhập) vẫn cấp phiếu và vẫn ghi nhận
 *
 * Mỗi ca kiểm: kết quả xác thực (HTTP), counter lưu trong cơ sở dữ liệu (high-water mark), và
 * số sự kiện COUNTER_ANOMALY của đúng credential đó.
 *
 * Yêu cầu: server đang chạy (npm start).
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fetch = globalThis.fetch || require('node-fetch');
const { flows } = require('./helpers/accounts');
const { createAuthenticator } = require('./softwareAuthenticator');
const { db } = require('../src/db');

const BASE = process.env.BASE_URL || 'http://localhost:3000';

let failures = 0;
function assert(cond, label) {
  console.log(`  ${cond ? '✅' : '❌'} ${label}`);
  if (!cond) failures++;
}
function section(title) { console.log(`\n${title}`); }

function credentialOf(userId) {
  return db.prepare('SELECT * FROM passkey_credentials WHERE user_id = ?').get(userId);
}
function anomalyEvents(credentialId) {
  return db
    .prepare(`SELECT * FROM security_events WHERE event_type = 'COUNTER_ANOMALY' AND detail LIKE ? ORDER BY id ASC`)
    .all(`%${credentialId}%`)
    .map((e) => ({ ...e, detail: JSON.parse(e.detail) }));
}

async function main() {
  console.log(`\n=== E2E TÍN HIỆU RỦI RO signCount: ${BASE} ===`);
  const rand = Date.now();

  // Người dùng A: Passkey đồng bộ, luôn báo 0.
  const authA = createAuthenticator({ zeroCounter: true });
  const userA = await flows.registerUser({ username: `cnt_a_${rand}`, displayName: 'Counter A', authenticator: authA });
  const credA = credentialOf(userA.user.id);

  // Người dùng B: bắt đầu ở 0 rồi đếm thật — dùng cho mọi ca còn lại.
  const authB = createAuthenticator({ zeroCounter: true });
  const userB = await flows.registerUser({ username: `cnt_b_${rand}`, displayName: 'Counter B', authenticator: authB });
  const credB = credentialOf(userB.user.id);

  async function loginB(nextCounter, label) {
    if (nextCounter !== null) authB.forceNextCounter(nextCounter);
    const before = anomalyEvents(credB.credential_id).length;
    const r = await flows.loginPasskey(authB);
    const after = anomalyEvents(credB.credential_id);
    return { r, newAnomalies: after.length - before, last: after[after.length - 1], stored: credentialOf(userB.user.id).counter, label };
  }

  // ---------------------------------------------------------------------- C01
  section('C01: 0 -> 0 — Passkey đồng bộ luôn báo 0');
  {
    assert(credA.counter === 0, 'Đăng ký xong, counter lưu = 0');
    const r = await flows.loginPasskey(authA);
    assert(r.status === 200 && !!r.data.token, `Đăng nhập thành công (nhận ${r.status})`);
    assert(credentialOf(userA.user.id).counter === 0, 'Counter vẫn lưu = 0');
    assert(anomalyEvents(credA.credential_id).length === 0, 'KHÔNG ghi COUNTER_ANOMALY');
  }

  // ---------------------------------------------------------------------- C02
  section('C02: 0 -> N — bộ xác thực bắt đầu đếm');
  {
    const x = await loginB(5);
    assert(x.r.status === 200, `Đăng nhập thành công (nhận ${x.r.status})`);
    assert(x.stored === 5, `Counter lưu = 5 (thực tế ${x.stored})`);
    assert(x.newAnomalies === 0, 'KHÔNG ghi COUNTER_ANOMALY');
  }

  // ---------------------------------------------------------------------- C03
  section('C03: N -> N+1 — bình thường');
  {
    const x = await loginB(6);
    assert(x.r.status === 200, `Đăng nhập thành công (nhận ${x.r.status})`);
    assert(x.stored === 6, `Counter lưu = 6 (thực tế ${x.stored})`);
    assert(x.newAnomalies === 0, 'KHÔNG ghi COUNTER_ANOMALY');
  }

  // ---------------------------------------------------------------------- C04
  section('C04: N -> N — counter đứng yên');
  {
    const x = await loginB(6);
    assert(x.r.status === 200 && !!x.r.data.token, `Đăng nhập VẪN thành công — không từ chối cứng (nhận ${x.r.status})`);
    assert(x.newAnomalies === 1, 'Ghi đúng 1 sự kiện COUNTER_ANOMALY');
    assert(x.last && x.last.detail.oldCounter === 6 && x.last.detail.newCounter === 6, 'Sự kiện ghi đúng counter cũ = 6, mới = 6');
    assert(x.last && x.last.actor_id === userB.user.id, 'Sự kiện ghi đúng người dùng');
    assert(x.last && x.last.outcome === 'ALLOWED', 'Sự kiện đánh dấu ALLOWED — lần xác thực được chấp nhận');
    assert(x.stored === 6, `Counter lưu giữ nguyên mức cao nhất = 6 (thực tế ${x.stored})`);
    assert(credentialOf(userB.user.id).id === credB.id, 'Credential KHÔNG bị xoá hay khoá');
  }

  // ---------------------------------------------------------------------- C05
  section('C05: N -> N-1 — counter lùi');
  {
    const x = await loginB(5);
    assert(x.r.status === 200 && !!x.r.data.token, `Đăng nhập VẪN thành công (nhận ${x.r.status})`);
    assert(x.newAnomalies === 1, 'Ghi đúng 1 sự kiện COUNTER_ANOMALY');
    assert(x.last && x.last.detail.oldCounter === 6 && x.last.detail.newCounter === 5, 'Sự kiện ghi đúng counter cũ = 6, mới = 5');
    assert(x.stored === 6, `Counter lưu KHÔNG bị kéo lùi, vẫn = 6 (thực tế ${x.stored})`);
  }

  // ---------------------------------------------------------------------- C06
  section('C06: N+1 sau bất thường — bình thường trở lại');
  {
    const x = await loginB(7);
    assert(x.r.status === 200, `Đăng nhập thành công (nhận ${x.r.status})`);
    assert(x.stored === 7, `Counter lưu = 7 (thực tế ${x.stored})`);
    assert(x.newAnomalies === 0, 'KHÔNG ghi thêm COUNTER_ANOMALY');
  }

  // ---------------------------------------------------------------------- C07
  section('C07: N -> 0 — một bên bằng 0 thì không coi là bất thường (theo quy tắc đã chốt)');
  {
    const x = await loginB(0);
    assert(x.r.status === 200, `Đăng nhập thành công (nhận ${x.r.status})`);
    assert(x.newAnomalies === 0, 'KHÔNG ghi COUNTER_ANOMALY');
    assert(x.stored === 7, `Counter lưu giữ mức cao nhất = 7 (thực tế ${x.stored})`);
  }

  // ---------------------------------------------------------------------- C08
  section('C08: Bất thường ở lối xác thực lại — vẫn cấp phiếu, vẫn ghi nhận');
  {
    authB.forceNextCounter(7); // N -> N
    const before = anomalyEvents(credB.credential_id).length;
    const grant = await flows.accountGrant(userB.token, authB, 'MANAGE_CREDENTIAL');
    const events = anomalyEvents(credB.credential_id);
    assert(grant.status === 200 && !!grant.data.reauthGrant, `Xác thực lại VẪN cấp phiếu uỷ quyền (nhận ${grant.status})`);
    assert(events.length - before === 1, 'Ghi đúng 1 sự kiện COUNTER_ANOMALY ở lối xác thực lại');
    const last = events[events.length - 1];
    assert(last && last.actor_id === userB.user.id && last.route && last.route.includes('reauth'), 'Sự kiện ghi đúng người dùng và đúng tuyến xác thực lại');
  }

  console.log(failures === 0 ? '\n=== KẾT QUẢ: TẤT CẢ PASS ✅ ===\n' : `\n=== KẾT QUẢ: ${failures} KIỂM THỬ THẤT BẠI ❌ ===\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('LỖI KHÔNG MONG ĐỢI:', e);
  process.exit(1);
});
