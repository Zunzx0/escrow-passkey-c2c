/**
 * Kiểm thử lớp bảo vệ ứng dụng web (nhóm P1 của checklist).
 *
 * Ba nhóm:
 *   1. Tiêu đề bảo vệ có được gửi đúng không, và CSP có thực sự cấm script nội tuyến không.
 *   2. Giới hạn tần suất có chặn được việc dò mật khẩu không, và có khoá theo MẪU tuyến
 *      thay vì theo đường dẫn cụ thể không.
 *   3. Nhật ký sự kiện an toàn có ghi lại các lần bị từ chối không, và có RÒ RỈ bí mật không.
 *
 * Chạy sau khi đã chạy các bộ khác, vì nó cố tình làm chạm trần giới hạn tần suất.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { api, flows } = require('./helpers/accounts');

const BASE = process.env.BASE_URL || 'http://localhost:3000';

let pass = 0;
let fail = 0;

function assert(cond, label) {
  if (cond) { pass += 1; console.log(`  ✅ ${label}`); }
  else { fail += 1; console.log(`  ❌ ${label}`); }
}
function section(t) { console.log(`\n${t}`); }

async function main() {
  console.log(`\n=== KIỂM THỬ LỚP BẢO VỆ ỨNG DỤNG WEB: ${BASE} ===`);
  const rand = crypto.randomBytes(4).toString('hex');

  // ------------------------------------------------------------------ P1-1
  section('P1-1: Tiêu đề bảo vệ');

  const page = await fetch(BASE + '/');
  const csp = page.headers.get('content-security-policy') || '';
  assert(page.headers.get('x-content-type-options') === 'nosniff', 'X-Content-Type-Options: nosniff');
  assert(page.headers.get('x-frame-options') === 'DENY', 'X-Frame-Options: DENY');
  assert(/frame-ancestors 'none'/.test(csp), "CSP có frame-ancestors 'none' (chống clickjacking)");
  assert(/script-src 'self'/.test(csp) && !/script-src[^;]*unsafe-inline/.test(csp),
    "CSP cấm script nội tuyến (script-src 'self', không có unsafe-inline)");
  assert(/style-src 'self'/.test(csp) && !/style-src[^;]*unsafe-inline/.test(csp),
    "CSP cấm style nội tuyến (style-src 'self', không có unsafe-inline)");
  assert(/object-src 'none'/.test(csp), "CSP có object-src 'none'");
  assert(!!page.headers.get('referrer-policy'), 'Có Referrer-Policy');
  assert(page.headers.get('x-powered-by') === null, 'Không lộ X-Powered-By');

  const vercelConfig = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'vercel.json'), 'utf8'));
  const vercelHeaders = vercelConfig.headers.find((entry) => entry.source === '/(.*)').headers;
  const vercelCsp = vercelHeaders.find((header) => header.key === 'Content-Security-Policy').value;
  assert(/style-src 'self'/.test(vercelCsp) && !/style-src[^;]*unsafe-inline/.test(vercelCsp),
    'CSP của Vercel cũng cấm style nội tuyến');

  const apiRes = await fetch(BASE + '/health');
  assert((apiRes.headers.get('cache-control') || '').includes('no-store') === false,
    '/health không thuộc /api nên không bị ép no-store');

  const apiPrivate = await fetch(BASE + '/api/listings');
  assert((apiPrivate.headers.get('cache-control') || '').includes('no-store'),
    'Phản hồi API mang Cache-Control: no-store');

  const robots = await fetch(BASE + '/robots.txt');
  const robotsBody = await robots.text();
  assert(robots.status === 200 && /User-agent:\s*\*/i.test(robotsBody),
    'robots.txt tồn tại và có chỉ dẫn cho crawler');

  const securityTxt = await fetch(BASE + '/.well-known/security.txt');
  const securityTxtBody = await securityTxt.text();
  assert(securityTxt.status === 200 && /^Contact:/m.test(securityTxtBody),
    'security.txt tồn tại và có kênh báo cáo lỗ hổng');
  assert(/^Canonical:\s*https:\/\/enclave\.id\.vn\/\.well-known\/security\.txt$/m.test(securityTxtBody),
    'security.txt khai báo đúng địa chỉ chuẩn trên enclave.id.vn');
  const expires = securityTxtBody.match(/^Expires:\s*(.+)$/m);
  assert(!!expires && Number.isFinite(Date.parse(expires[1])) && Date.parse(expires[1]) > Date.now(),
    'security.txt có thời hạn còn hiệu lực');

  // ------------------------------------------------------------------ P1-2
  section('P1-2: Giới hạn tần suất trên điểm đăng nhập');

  // Đọc trần hiện tại từ cấu hình để bài kiểm thử không phụ thuộc vào một con số cứng.
  const limit = parseInt(process.env.RATE_LIMIT_AUTH_PER_MINUTE || '10', 10);
  if (limit > 40) {
    console.log(`  (bỏ qua: RATE_LIMIT_AUTH_PER_MINUTE=${limit} quá cao để kiểm nhanh)`);
  } else {
    // Dùng fetch trần chứ KHÔNG dùng helper api(): helper tự chờ hết cửa sổ rồi thử lại khi
    // gặp 429, nên nó sẽ che mất đúng cái mà bài này cần quan sát.
    async function rawLogin() {
      const res = await fetch(BASE + '/api/passkeys/login/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: `khongtontai_${rand}`, password: 'SaiMatKhau-123' }),
      });
      return res;
    }

    let sawLimit = false;
    let sawUnauthorized = false;
    let retryAfter = null;
    for (let i = 0; i < limit + 5; i += 1) {
      const r = await rawLogin();
      if (r.status === 401) sawUnauthorized = true;
      if (r.status === 429) { sawLimit = true; retryAfter = r.headers.get('retry-after'); break; }
    }
    assert(sawUnauthorized, 'Vài lần thử đầu trả 401 (chưa chạm trần)');
    assert(sawLimit, `Thử quá ${limit} lần trong một phút thì bị chặn 429`);
    assert(retryAfter !== null && Number(retryAfter) > 0, `Phản hồi 429 kèm Retry-After (${retryAfter}s)`);

    // Xô đếm khoá theo (IP, phương thức, MẪU tuyến). Một tuyến KHÁC vẫn phải đi được, chứng
    // minh giới hạn không phải là chặn toàn cục theo IP.
    const other = await fetch(BASE + '/api/listings');
    assert(other.status === 200, 'Tuyến khác vẫn hoạt động bình thường khi một tuyến bị chặn');
  }

  // ------------------------------------------------------------------ P1-3
  section('P1-3: Nhật ký sự kiện an toàn');

  const admin = await flows.createAdmin({ username: `hdadm_${rand}`, displayName: 'Quan Tri Hardening' });

  // Tạo một lần bị từ chối có thật: gọi giải ngân bằng phiếu bịa.
  const seller = await flows.createSeller(admin, { username: `hdsel_${rand}`, displayName: 'Nguoi Ban' });
  const buyer = await flows.registerUser({ username: `hdbuy_${rand}`, displayName: 'Nguoi Mua' });
  const listing = await api('/api/listings', {
    method: 'POST', token: seller.token,
    body: { title: `Sản phẩm hardening ${rand}`, category: 'DIEN_TU', condition: 'GOOD', price: 500000, location: 'Hà Nội' },
  });
  const order = await api('/api/transactions/orders', {
    method: 'POST', token: buyer.token, body: { listingId: listing.data.id },
  });
  const denied = await api(`/api/transactions/${order.data.id}/release`, {
    method: 'POST', token: buyer.token,
    body: { requestId: crypto.randomUUID(), reauthGrant: 'phieu-bia-dat' },
  });
  assert(denied.status >= 400, `Giải ngân bằng phiếu bịa bị từ chối (nhận ${denied.status})`);

  const events = await api('/api/admin/security-events?limit=200', { token: admin.token });
  assert(events.status === 200 && Array.isArray(events.data.events), 'Đọc được nhật ký sự kiện an toàn');

  const types = new Set(events.data.events.map((e) => e.eventType));
  assert(types.has('INVALID_STATE') || types.has('REAUTH_REQUIRED'),
    `Lần bị từ chối vừa rồi đã được ghi lại (các loại thấy được: ${[...types].slice(0, 6).join(', ')})`);
  assert(types.has('ACCOUNT_ACTIVATED'), 'Việc kích hoạt tài khoản được ghi là sự kiện ALLOWED');
  assert(types.has('ADMIN_BOOTSTRAP_PASSWORD_CHANGED'), 'Việc đổi mật khẩu tạm của quản trị viên được ghi lại');

  const allowed = events.data.events.filter((e) => e.outcome === 'ALLOWED');
  const deniedEvents = events.data.events.filter((e) => e.outcome === 'DENIED');
  assert(allowed.length > 0 && deniedEvents.length > 0,
    `Ghi cả hai chiều: ${allowed.length} ALLOWED, ${deniedEvents.length} DENIED`);

  // Yêu cầu quan trọng nhất của mục này: nhật ký KHÔNG được chứa bí mật.
  const dump = JSON.stringify(events.data.events);
  const leaks = ['phieu-bia-dat', 'SaiMatKhau-123', buyer.password, admin.password, admin.temporaryPassword]
    .filter((secret) => secret && dump.includes(secret));
  assert(leaks.length === 0,
    leaks.length === 0
      ? 'Không có mật khẩu, phiếu uỷ quyền hay mã phiên nào lọt vào nhật ký'
      : `RÒ RỈ: nhật ký chứa ${leaks.length} giá trị bí mật`);

  assert(!/"(token|password|reauthGrant|challenge)"/.test(dump),
    'Không có trường token/password/reauthGrant/challenge trong nhật ký');

  console.log(`\n=== KẾT QUẢ: ${fail === 0 ? 'TẤT CẢ PASS ✅' : `${fail} TEST FAIL ❌`} (${pass} pass) ===\n`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error('LỖI KHÔNG MONG ĐỢI:', e);
  process.exit(1);
});
