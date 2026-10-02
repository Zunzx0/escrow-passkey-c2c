// Chạy MỘT lượt dọn challenge hết hạn/đã dùng quá khoảng ân hạn, như một process riêng.
//
//   node scripts/cleanup-challenges.js              dùng CHALLENGE_CLEANUP_GRACE_SECONDS
//   node scripts/cleanup-challenges.js --grace=600  ân hạn 600 giây
//
// In kết quả (JSON) ra stdout.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { cleanupChallenges } = require('../src/lib/maintenance');

const hit = process.argv.find((a) => a.startsWith('--grace='));
const opts = hit ? { graceSeconds: Number(hit.slice('--grace='.length)) } : {};

cleanupChallenges(opts)
  .then((summary) => {
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    process.exit(0);
  })
  .catch((e) => {
    console.error('[cleanup] lỗi:', e);
    process.exit(1);
  });
