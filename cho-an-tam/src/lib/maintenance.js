// Tác vụ vệ sinh dữ liệu định kỳ.
//
// cleanupChallenges() CHỈ là dọn rác, KHÔNG tham gia quyết định an toàn nào. Mọi lần kiểm
// challenge ở các route vẫn dựa trên expires_at, used_at, purpose và context_data của bản ghi —
// dọn hay không dọn thì kết quả kiểm vẫn như nhau:
//   - challenge đã hết hạn: dù còn nằm trong bảng thì vẫn bị từ chối vì expires_at;
//   - challenge đã dùng rồi bị dọn: lần phát lại tìm không thấy bản ghi nên vẫn bị từ chối
//     (CHALLENGE_NOT_FOUND thay vì CHALLENGE_REPLAY) — không mở ra đường phát lại nào.
//
// Khoảng ân hạn (grace) giữ lại các bản ghi vừa hết hạn/vừa dùng một thời gian, để lần gọi phát
// lại trong khoảng đó còn nhận đúng mã lỗi CHALLENGE_REPLAY/CHALLENGE_EXPIRED và để người vận
// hành còn đối chiếu được. Challenge còn hiệu lực và chưa dùng thì không bao giờ bị đụng tới.
//
// KHÔNG dọn reauth_grants: phiếu đã tiêu thụ là căn cứ của bất biến "phiếu dùng một lần và
// đúng phạm vi" — xoá đi là xoá bằng chứng mà bộ kiểm bất biến cần.
const { db } = require('../db');

const DEFAULT_GRACE_SECONDS = parseInt(process.env.CHALLENGE_CLEANUP_GRACE_SECONDS || '3600', 10);

function cleanupChallenges({ graceSeconds = DEFAULT_GRACE_SECONDS, now = Date.now() } = {}) {
  const threshold = new Date(now - graceSeconds * 1000).toISOString();
  let deletedExpired = 0;
  let deletedUsed = 0;
  db.transaction(() => {
    deletedExpired = db.prepare('DELETE FROM auth_challenges WHERE expires_at < ?').run(threshold).changes;
    deletedUsed = db
      .prepare('DELETE FROM auth_challenges WHERE used_at IS NOT NULL AND used_at < ?')
      .run(threshold).changes;
  })();
  return { deletedExpired, deletedUsed, threshold };
}

module.exports = { cleanupChallenges, DEFAULT_GRACE_SECONDS };
