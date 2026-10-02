require('dotenv').config();
const crypto = require('crypto');
const path = require('path');
const express = require('express');

const { securityHeaders, assertSecretsConfigured, assertEnvironmentSafe } = require('./lib/security');
const { RP_ID, ORIGIN } = require('./lib/webauthnConfig');

// Kiểm cấu hình bí mật TRƯỚC khi nạp bất kỳ thứ gì dùng tới nó. Chạy tiếp với khoá ký mặc
// định nguy hiểm hơn là dừng hẳn, vì khi đó mọi mã phiên đều giả mạo được mà hệ thống vẫn
// trông như đang chạy bình thường.
assertSecretsConfigured();
assertEnvironmentSafe();

const healthRouter = require('./routes/health');
const passkeysRouter = require('./routes/passkeys');
const usersRouter = require('./routes/users');
const walletsRouter = require('./routes/wallets');
const { router: listingsRouter } = require('./routes/listings');
const transactionsRouter = require('./routes/transactions');
const paymentsRouter = require('./routes/payments');
const notificationsRouter = require('./routes/notifications');
const mockProviderRouter = require('./routes/mockProvider');
const adminRouter = require('./routes/admin');
const { logFromError } = require('./lib/securityEvents');
const { AppError } = require('./lib/errors');
const { InjectedFault } = require('./lib/faultInjection');

const app = express();

// Địa chỉ IP dùng làm khoá của bộ giới hạn tần suất. Chỉ tin X-Forwarded-For khi thực sự
// chạy sau một proxy tin cậy — bật sẵn thì bất kỳ ai cũng tự khai IP và vượt qua giới hạn.
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);

app.disable('x-powered-by');
app.use(securityHeaders({ enableHsts: process.env.ENABLE_HSTS === '1' }));
app.use(express.json({ limit: '1mb' }));

app.use('/', healthRouter);
// Đăng ký + đăng nhập dùng CHUNG một luồng cho cả ba vai trò. Đăng ký gồm hai bước và luôn
// tạo ra Người mua. Không có endpoint nào cấp quyền: năng lực bán đi qua quy trình xin và
// duyệt, quyền quản trị chỉ khởi tạo bằng `npm run seed:admin` chạy trên máy chủ.
app.use('/api/passkeys', passkeysRouter);
app.use('/api/users', usersRouter);
app.use('/api/wallets', walletsRouter);
app.use('/api/listings', listingsRouter);
app.use('/api/transactions', transactionsRouter);
app.use('/api/payments', paymentsRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/admin', adminRouter);
// Phía PROVIDER mô phỏng, cố ý nằm ngoài /api — xem routes/mockProvider.js.
app.use('/mock-provider', mockProviderRouter);

// Tuyến API không tồn tại: trả JSON thống nhất thay cho trang "Cannot POST ..." mặc định của
// Express, vốn để lộ framework đang dùng.
app.use(['/api', '/mock-provider'], (req, res) => {
  res.status(404).json({ error: 'NOT_FOUND', message: 'Không tìm thấy tài nguyên' });
});

// Frontend tĩnh (HTML/CSS/JS thuần, không cần build)
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use((req, res) => {
  res.status(404).json({ error: 'NOT_FOUND', message: 'Không tìm thấy tài nguyên' });
});

// ---------------------------------------------------------------------------
// Middleware lỗi tập trung.
//
// Đây cũng là nơi DUY NHẤT ghi nhận các lần bị từ chối vào nhật ký sự kiện an toàn. Đặt tập
// trung thay vì rải lời gọi ở từng route là có chủ ý: thêm một nhánh từ chối mới ở bất kỳ
// đâu thì nó tự động được ghi lại, không phụ thuộc vào việc người viết có nhớ hay không.
// ---------------------------------------------------------------------------
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  if (err && (err.code === 'SQLITE_CONSTRAINT_CHECK' || /CHECK constraint failed/.test(err.message || ''))) {
    console.error('[constraint]', err.message);
    return res.status(400).json({ error: 'CONSTRAINT_VIOLATION', message: 'Vi phạm ràng buộc dữ liệu (ví dụ số dư không đủ)' });
  }

  // Lỗi của bộ đọc JSON: chỉ báo "body không hợp lệ", không trả nguyên văn thông báo của parser.
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'INVALID_JSON', message: 'Nội dung gửi lên không phải JSON hợp lệ' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'PAYLOAD_TOO_LARGE', message: 'Nội dung gửi lên quá lớn' });
  }

  const status = err.status || 500;
  // Với lỗi 5xx, chỉ lỗi do chính ứng dụng định nghĩa mới được đưa mã ra ngoài. Lỗi bất ngờ
  // (lỗi lập trình, lỗi SQL...) có thể chứa chi tiết nội bộ nên chỉ ghi ở log máy chủ.
  const intentional = err instanceof AppError || err instanceof InjectedFault;

  logFromError(req, err, status);

  if (status >= 500) {
    const requestId = crypto.randomUUID();
    console.error(`[error ${requestId}] ${req.method} ${req.originalUrl}`, err);
    return res.status(status).json({
      error: intentional ? err.code : 'INTERNAL_ERROR',
      message: intentional && err instanceof AppError ? err.message : 'Lỗi hệ thống, vui lòng thử lại sau',
      requestId,
    });
  }
  // Lỗi 4xx luôn do mã ứng dụng chủ động ném kèm status (lỗi parser đã xử lý ở trên).
  res.status(status).json({ error: err.code || 'BAD_REQUEST', message: err.message || 'Yêu cầu không hợp lệ' });
});

const { startBackgroundJobs } = require('./lib/backgroundJobs');

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  const jobs = startBackgroundJobs();
  console.log(`\nChợ An Tâm — sàn mua bán C2C (Escrow + Passkeys) đang chạy tại: http://localhost:${PORT}`);
  console.log(`   WEBAUTHN_RP_ID=${RP_ID}  WEBAUTHN_ORIGIN=${ORIGIN}`);
  console.log('   Mở trình duyệt tại đúng địa chỉ trên (không dùng 127.0.0.1) để Passkeys hoạt động.');
  console.log(`   Môi trường: ${process.env.APP_ENV || 'dev'} · Cơ sở dữ liệu: ${require('./db').DB_PATH}`);
  console.log(`   Đối soát thanh toán: ${jobs.reconcileIntervalSeconds > 0
    ? `mỗi ${jobs.reconcileIntervalSeconds}s, bỏ qua yêu cầu mới hơn ${jobs.reconcileMinAgeSeconds}s`
    : 'TẮT'}`);
  console.log(`   Dọn challenge: ${jobs.challengeCleanupIntervalSeconds > 0
    ? `mỗi ${jobs.challengeCleanupIntervalSeconds}s, ân hạn ${jobs.challengeCleanupGraceSeconds}s`
    : 'TẮT'}`);
  if (process.env.APP_ENV === 'experiment') {
    // Môi trường thực nghiệm phải chạy đúng bản đã đóng băng; lệch thì cảnh báo lớn để kết quả
    // thu được không bị nhầm là kết quả của bản đã kiểm thử.
    const freeze = require('./lib/freeze').verifyFreeze();
    if (!freeze.frozen) {
      console.log('\n   ⚠  CHƯA ĐÓNG BĂNG phiên bản thực nghiệm (npm run freeze:experiment).');
    } else if (!freeze.ok) {
      console.log(`\n   ⚠  MÃ ĐÃ LỆCH khỏi bản đóng băng ${freeze.label}: ${freeze.changed.length} file sửa, `
        + `${freeze.added.length} thêm, ${freeze.removed.length} xoá. Chạy npm run freeze:verify để xem chi tiết.`);
    } else {
      console.log(`   Phiên bản thực nghiệm: ${freeze.label} (đóng băng lúc ${freeze.frozenAt}) — khớp.`);
    }
  }
  if (process.env.FAULT_INJECT) {
    console.log(`\n   ⚠  CHÈN LỖI CHỦ ĐỘNG ĐANG BẬT: FAULT_INJECT=${process.env.FAULT_INJECT}`);
    console.log('      Chỉ dùng cho kiểm thử rollback. KHÔNG bật khi thu kết quả chính thức.\n');
  } else {
    console.log('');
  }
});
