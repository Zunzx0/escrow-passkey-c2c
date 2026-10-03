// Giới hạn tần suất trong bộ nhớ (đủ dùng cho một nguyên mẫu nghiên cứu chạy một tiến trình;
// hệ thống nhiều tiến trình sẽ cần một kho dùng chung như Redis).
//
// Đây là một trong bốn biện pháp chống dò mật khẩu ở mục 2.3.2, và cũng bảo vệ các điểm cuối
// SINH CHALLENGE — nơi mỗi yêu cầu đều tạo một bản ghi trong cơ sở dữ liệu, nên gửi ồ ạt là
// một cách làm phình dữ liệu rẻ tiền.
//
// Khoá của một xô đếm là (IP, phương thức, MẪU tuyến). Dùng mẫu tuyến `/:id/reauth/options`
// chứ không dùng đường dẫn cụ thể `/abc-123/reauth/options` là có chủ ý: nếu khoá theo đường
// dẫn cụ thể thì mỗi giao dịch có một xô riêng, và kẻ tấn công chỉ cần đổi mã giao dịch là
// giới hạn mất tác dụng hoàn toàn.

const buckets = new Map();

// Dọn định kỳ để bản đồ không phình vô hạn theo số IP đã từng gọi.
const SWEEP_EVERY_MS = 5 * 60 * 1000;
let lastSweep = Date.now();

function sweep(now) {
  if (now - lastSweep < SWEEP_EVERY_MS) return;
  lastSweep = now;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt < now) buckets.delete(key);
  }
}

/**
 * @param perMinute  số yêu cầu tối đa trong một phút cho mỗi (IP, tuyến)
 * @param name       tên nhóm, để hai tuyến khác nhau có thể dùng chung một xô nếu muốn
 */
function rateLimit({ perMinute = 10, name = null, identity = null } = {}) {
  return (req, res, next) => {
    const now = Date.now();
    sweep(now);

    // req.route chỉ có sau khi Express khớp tuyến, tức là luôn có ở middleware cấp tuyến.
    const pattern = name || `${req.baseUrl || ''}${(req.route && req.route.path) || req.path}`;
    // `identity` cho phép một tuyến nhạy cảm có thêm xô theo giá trị đã chuẩn hoá, ví dụ
    // (IP, username) ở đăng ký. IP vẫn luôn nằm trong khoá để một người ở IP khác không thể
    // cố ý làm đầy xô của nạn nhân và khoá tên đăng nhập họ đang muốn đăng ký.
    const identityPart = typeof identity === 'function' ? String(identity(req) || '') : '';
    const key = `${req.ip}|${req.method}|${pattern}|${identityPart}`;

    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt < now) {
      bucket = { count: 0, resetAt: now + 60_000 };
      buckets.set(key, bucket);
    }
    bucket.count += 1;

    if (bucket.count > perMinute) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      // Ném lỗi thay vì tự trả phản hồi, để middleware lỗi tập trung ghi lại sự kiện an toàn.
      const err = new Error(`Quá nhiều yêu cầu, thử lại sau ${retryAfter} giây.`);
      err.status = 429;
      err.code = 'RATE_LIMITED';
      err.securityDetail = { limitPerMinute: perMinute, attempts: bucket.count };
      return next(err);
    }

    next();
  };
}

/**
 * Bộ đếm "lần dò" theo IP trong một cửa sổ dài (mặc định một giờ). Khác rateLimit ở chỗ chỉ
 * những phản hồi mang tín hiệu dò tìm mới bị đếm (ví dụ "tên đăng nhập đã tồn tại"), nên người
 * dùng bình thường gần như không chạm tới, còn kẻ dò danh sách tài khoản thì bị chặn sau vài lần.
 */
function probeCounter({ limit, windowMs = 60 * 60 * 1000, name }) {
  const hits = new Map();
  let lastProbeSweep = Date.now();
  function entry(req, now) {
    if (now - lastProbeSweep > SWEEP_EVERY_MS) {
      lastProbeSweep = now;
      for (const [k, e] of hits) if (e.resetAt < now) hits.delete(k);
    }
    const key = `${req.ip}|${name}`;
    let e = hits.get(key);
    if (!e || e.resetAt < now) {
      e = { count: 0, values: new Set(), resetAt: now + windowMs };
      hits.set(key, e);
    }
    return e;
  }
  return {
    /** Số giây còn bị chặn, hoặc 0. */
    blockedFor(req, now = Date.now()) {
      const e = entry(req, now);
      return e.count >= limit ? Math.max(1, Math.ceil((e.resetAt - now) / 1000)) : 0;
    },
    // Nếu có `value`, chỉ đếm mỗi giá trị chuẩn hoá một lần. Cơ chế này phát hiện một IP
    // lần lượt thử nhiều username nhưng không phạt người dùng vì gõ lại cùng một tên.
    hit(req, value = null, now = Date.now()) {
      const e = entry(req, now);
      if (value === null || value === undefined) {
        e.count += 1;
      } else {
        const normalized = String(value);
        if (!e.values.has(normalized)) {
          e.values.add(normalized);
          e.count += 1;
        }
      }
      return e.count;
    },
    reset() {
      hits.clear();
    },
  };
}

/** Xoá toàn bộ xô đếm. Chỉ dùng cho kiểm thử. */
function resetRateLimits() {
  buckets.clear();
}

module.exports = { rateLimit, probeCounter, resetRateLimits };
