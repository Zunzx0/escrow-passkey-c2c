// Các tác vụ nền chạy định kỳ bên trong process máy chủ.
//
// Với một prototype, setInterval trong chính process máy chủ là đủ — không cần hàng đợi hay
// cron riêng. Mỗi tác vụ đều có bản chạy một lần bằng script (scripts/*.js) để vận hành chạy
// tay và để bộ kiểm thử chạy như một process tách rời.
//
// Đặt khoảng chạy = 0 để tắt một tác vụ.
const { startReconciler } = require('./reconciler');
const { cleanupChallenges } = require('./maintenance');

function intEnv(name, fallback) {
  const v = parseInt(process.env[name] || '', 10);
  return Number.isFinite(v) ? v : fallback;
}

function backgroundJobConfig() {
  return {
    reconcileIntervalSeconds: intEnv('RECONCILE_INTERVAL_SECONDS', 60),
    reconcileMinAgeSeconds: intEnv('RECONCILE_MIN_AGE_SECONDS', 30),
    challengeCleanupIntervalSeconds: intEnv('CHALLENGE_CLEANUP_INTERVAL_SECONDS', 600),
    challengeCleanupGraceSeconds: intEnv('CHALLENGE_CLEANUP_GRACE_SECONDS', 3600),
  };
}

function startChallengeCleanup({ intervalSeconds, graceSeconds }) {
  const timer = setInterval(() => {
    try {
      const r = cleanupChallenges({ graceSeconds });
      if (r.deletedExpired || r.deletedUsed) {
        console.log(`[cleanup] đã dọn ${r.deletedExpired} challenge hết hạn, ${r.deletedUsed} challenge đã dùng`);
      }
    } catch (e) {
      console.error('[cleanup] lượt dọn hỏng:', e.message);
    }
  }, intervalSeconds * 1000);
  timer.unref();
  return timer;
}

function startBackgroundJobs() {
  const cfg = backgroundJobConfig();
  if (cfg.reconcileIntervalSeconds > 0) {
    startReconciler({ intervalSeconds: cfg.reconcileIntervalSeconds, minAgeSeconds: cfg.reconcileMinAgeSeconds });
  }
  if (cfg.challengeCleanupIntervalSeconds > 0) {
    startChallengeCleanup({
      intervalSeconds: cfg.challengeCleanupIntervalSeconds,
      graceSeconds: cfg.challengeCleanupGraceSeconds,
    });
  }
  return cfg;
}

module.exports = { startBackgroundJobs, backgroundJobConfig };
