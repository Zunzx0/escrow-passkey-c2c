// Các tiêu đề bảo vệ ở tầng ứng dụng web.
//
// Viết tay thay vì thêm helmet: đồ án sắp đóng băng phiên bản để thực nghiệm, và quy trình
// đã chốt là cố định danh sách phụ thuộc. Ba mươi dòng dưới đây đọc hiểu được trong một lần
// và không kéo theo cây phụ thuộc nào mới.
//
// Nhóm cơ chế này KHÔNG phải trọng tâm nghiên cứu của đồ án — trọng tâm là ràng buộc một lần
// xác thực lại với đúng chủ thể, giao dịch và quyết định. Nhưng mục 2.3.1 đã nêu rằng các
// tấn công web tổng quát vẫn được xét khi chúng chạm tới ba đối tượng trong phạm vi: phiên
// làm việc, trạng thái giao dịch và quyền giải ngân. Một lỗ XSS đúng là con đường ngắn nhất
// để lấy mã phiên, nên siết lớp này là siết trực tiếp một nhánh của mô hình đe doạ.

/**
 * Content-Security-Policy.
 *
 *   script-src 'self'         — giao diện không có <script> nội tuyến nào, toàn bộ mã nằm ở
 *                               tệp rời, nên KHÔNG cần 'unsafe-inline'. Đây là phần có giá
 *                               trị nhất của CSP: chặn đúng dạng XSS chèn thẻ script.
 *   style-src  'self'         — toàn bộ kiểu nằm trong css/style.css; giao diện không còn
 *                               thuộc tính style nội tuyến hoặc gán element.style.
 *   img-src    data:          — favicon là một SVG nội tuyến dạng data URI.
 *   connect-src 'self'        — chặn việc gửi dữ liệu ra máy chủ khác.
 *   frame-ancestors 'none'    — chống clickjacking; thay cho X-Frame-Options ở trình duyệt mới.
 *   form-action 'self'        — chặn việc chuyển hướng biểu mẫu ra ngoài.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

function securityHeaders({ enableHsts = false } = {}) {
  return (req, res, next) => {
    res.setHeader('Content-Security-Policy', CSP);

    // Chặn trình duyệt tự đoán kiểu nội dung. Không có nó, một tệp người dùng tải lên bị
    // đoán nhầm thành HTML sẽ chạy như HTML.
    res.setHeader('X-Content-Type-Options', 'nosniff');

    // frame-ancestors ở trên đã đủ với trình duyệt hiện hành; giữ thêm cái này cho bản cũ.
    res.setHeader('X-Frame-Options', 'DENY');

    // Không rò rỉ đường dẫn đầy đủ (có thể chứa mã giao dịch) sang trang ngoài.
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

    // Hệ thống không dùng camera, micro hay định vị; đóng sẵn để một đoạn mã lạ không xin được.
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');

    // Không cho lưu đệm phản hồi của API — chúng chứa dữ liệu riêng của từng tài khoản.
    if (req.path.startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-store');
    }

    // Chỉ bật HSTS khi đã thực sự chạy HTTPS. Bật nhầm trên môi trường HTTP sẽ khoá trình
    // duyệt của người dùng khỏi chính trang này trong nhiều tháng.
    if (enableHsts) {
      res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    }

    next();
  };
}

/**
 * Kiểm cấu hình bí mật lúc khởi động.
 *
 * Chạy tiếp với khoá ký mặc định nguy hiểm hơn là dừng hẳn: mọi mã phiên đều giả mạo được,
 * mà hệ thống vẫn trông như đang chạy bình thường. Vì vậy thiếu JWT_SECRET là lỗi khởi động,
 * không phải cảnh báo.
 */
const INSECURE_SECRETS = new Set([
  '',
  'CHANGE_ME_dev_only_not_secure',
  'CHANGE_ME_RUN_THE_COMMAND_ABOVE',
  'secret',
  'changeme',
]);

function assertSecretsConfigured() {
  const secret = process.env.JWT_SECRET || '';
  const paymentSecret = process.env.PAYMENT_WEBHOOK_SECRET || '';
  const problems = [];

  if (INSECURE_SECRETS.has(secret)) {
    problems.push('JWT_SECRET chưa được đặt, hoặc vẫn là giá trị mẫu trong .env.example.');
  } else if (secret.length < 32) {
    problems.push(`JWT_SECRET quá ngắn (${secret.length} ký tự), cần ít nhất 32.`);
  }

  // Thiếu khoá này thì verifyProviderSignature() luôn trả false một cách an toàn (xem
  // mockPaymentProvider.js) — webhook nạp tiền sẽ không BAO GIỜ chạy được, chứ không phải
  // mở toang. Vẫn coi là lỗi khởi động để không ai mất công tìm hiểu vì sao mọi lần nạp
  // tiền đều bị từ chối 401.
  if (INSECURE_SECRETS.has(paymentSecret)) {
    problems.push('PAYMENT_WEBHOOK_SECRET chưa được đặt, hoặc vẫn là giá trị mẫu trong .env.example.');
  } else if (paymentSecret.length < 32) {
    problems.push(`PAYMENT_WEBHOOK_SECRET quá ngắn (${paymentSecret.length} ký tự), cần ít nhất 32.`);
  }

  if (problems.length === 0) return;

  console.error('\n  Không khởi động được vì cấu hình bí mật chưa an toàn:\n');
  for (const p of problems) console.error(`   - ${p}`);
  console.error('\n  Sinh một khoá mới rồi ghi vào .env:');
  console.error('     node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"\n');
  process.exit(1);
}

/**
 * Môi trường thực nghiệm/demo không bao giờ được chạy với chèn lỗi.
 *
 * `node --env-file` KHÔNG ghi đè biến đã có sẵn trong shell, nên dù .env.experiment đặt
 * FAULT_INJECT rỗng, một lệnh `$env:FAULT_INJECT="..."` còn sót trong cửa sổ PowerShell vẫn bật
 * được chèn lỗi. Chặn ở đây là chặn tại chỗ duy nhất chắc chắn chạy.
 */
function assertEnvironmentSafe() {
  if (process.env.APP_ENV === 'experiment' && (process.env.FAULT_INJECT || process.env.FAULT_INJECT_MODE)) {
    console.error('\n  Không khởi động: APP_ENV=experiment nhưng FAULT_INJECT/FAULT_INJECT_MODE đang có giá trị.');
    console.error('  Môi trường thực nghiệm không được chạy với chèn lỗi. Xoá biến đó khỏi cửa sổ lệnh rồi chạy lại:');
    console.error('     Remove-Item Env:FAULT_INJECT, Env:FAULT_INJECT_MODE -ErrorAction SilentlyContinue\n');
    process.exit(1);
  }
}

module.exports = { securityHeaders, assertSecretsConfigured, assertEnvironmentSafe, CSP };
