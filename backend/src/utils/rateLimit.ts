// Minimal in-memory sliding-window rate limiter (kiến thức §46, BA.md §20:
// "Tuyến đăng nhập mật khẩu phải có rate limiting"). Single-process /
// in-memory only — resets on restart and doesn't share state across
// instances. That is an accepted limitation for this thesis-scale demo;
// a production deployment would back this with Redis or similar.
//
// The numeric limits themselves (e.g. PASSWORD_LOGIN_RATE_LIMIT_MAX) are
// policy/config for experimentation, not a claimed security standard
// (kiến thức §46).

interface Bucket {
  windowStart: number;
  count: number;
}

const buckets = new Map<string, Bucket>();

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

export function checkRateLimit(key: string, max: number, windowMinutes: number): RateLimitResult {
  const windowMs = windowMinutes * 60_000;
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || now - bucket.windowStart >= windowMs) {
    buckets.set(key, { windowStart: now, count: 1 });
    return { allowed: true, remaining: max - 1, retryAfterMs: 0 };
  }

  if (bucket.count >= max) {
    return { allowed: false, remaining: 0, retryAfterMs: windowMs - (now - bucket.windowStart) };
  }

  bucket.count += 1;
  return { allowed: true, remaining: max - bucket.count, retryAfterMs: 0 };
}
