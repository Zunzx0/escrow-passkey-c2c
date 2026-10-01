// Chạy MỘT lượt đối soát thanh toán như một process riêng, tách khỏi máy chủ web.
//
//   node scripts/reconcile.js                    đối soát mọi yêu cầu PENDING đủ tuổi
//   node scripts/reconcile.js --min-age=0        bỏ ngưỡng tuổi (dùng khi kiểm thử)
//   node scripts/reconcile.js --id=<paymentId>   chỉ đối soát đúng một yêu cầu
//
// In kết quả (JSON) ra stdout; in "query <id>" ra stderr ngay trước khi hỏi provider, để bộ
// kiểm thử biết chính xác lúc worker đang chờ provider mà chen webhook vào đúng khoảnh khắc đó.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { reconcileOnce } = require('../src/lib/reconciler');

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

const opts = {};
if (arg('min-age') !== undefined) opts.minAgeSeconds = Number(arg('min-age'));
if (arg('limit') !== undefined) opts.limit = Number(arg('limit'));
if (arg('id') !== undefined) opts.paymentRequestId = arg('id');
opts.onQuery = (id) => process.stderr.write(`query ${id}\n`);

reconcileOnce(opts)
  .then((summary) => {
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    process.exit(0);
  })
  .catch((e) => {
    console.error('[reconcile] lỗi:', e);
    process.exit(1);
  });
