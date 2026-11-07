'use strict';
// Chỉ chạy trên API Enclave. Phiên và phiếu lấy từ thao tác Passkey trên website.
const { open, inspect, reject, release, unchanged, completed, finish, report } = require('./s2-live-client.cjs');

async function run(packet, transport) {
  const ctx = await open(packet, transport);
  const before = await inspect(ctx);
  await reject(ctx, 'Phát lại phản hồi WebAuthn', `/transactions/${ctx.a}/reauth/verify`, ctx.assertion, 400, 'CHALLENGE_REPLAY');
  await unchanged(ctx, before);
  await reject(ctx, 'Dùng phiếu A cho đơn B', `/transactions/${ctx.b}/release`, release(ctx.grant), 401, 'REAUTH_REQUIRED');
  await unchanged(ctx, before);

  const correct = release(ctx.grant);
  await ctx.post('Chuyển tiền A đúng phiếu', `/transactions/${ctx.a}/release`, correct, 200);
  const settled = await inspect(ctx);
  completed(before, settled);
  await ctx.post('Gửi lại cùng mã yêu cầu', `/transactions/${ctx.a}/release`, correct, 200);
  await unchanged(ctx, settled);
  await reject(ctx, 'Dùng phiếu cũ với mã mới', `/transactions/${ctx.a}/release`, release(ctx.grant), 409, 'INVALID_STATE');
  await unchanged(ctx, settled);
  return finish(ctx, before, settled);
}

module.exports = { run };
if (require.main === module) {
  const fs = require('node:fs');
  let packet = fs.readFileSync(0, 'utf8').trim();
  run(packet).then(result => report(result)).catch(error => {
    console.error('S2 CHƯA HOÀN TẤT: ' + (error.safeMessage || 'Kiểm tra kết nối, phiên/phiếu và trạng thái đơn.'));
    process.exitCode = 1;
  }).finally(() => { packet = null; });
}
