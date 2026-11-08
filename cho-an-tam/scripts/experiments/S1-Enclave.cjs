'use strict';
const { randomUUID } = require('node:crypto');
const { open, inspect, verdict, cli } = require('./s1-live-client.cjs');

async function run(packet, transport) {
  // Kiểm tra phiên hợp lệ và lưu trạng thái trước khi gửi yêu cầu.
  const ctx = await open(packet, transport);

  // Mô phỏng người đã có phiên nhưng không có phiếu xác nhận Passkey.
  const reply = await ctx.request(`/transactions/${ctx.id}/release`, {
    requestId: randomUUID(),
    reauthGrant: 'S1_NO_VALID_PASSKEY_GRANT',
  });

  // Chỉ ghi đạt khi HTTP 401/REAUTH_REQUIRED và dữ liệu giữ nguyên.
  const after = await inspect(ctx);
  return verdict(ctx, reply, ctx.before, after);
}

module.exports = { run };
if (require.main === module) cli(run, { clipboard: process.argv.includes('--clipboard') });
