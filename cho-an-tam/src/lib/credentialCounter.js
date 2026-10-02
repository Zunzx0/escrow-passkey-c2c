// signCount (counter) của Passkey là TÍN HIỆU RỦI RO, không phải điều kiện cứng.
//
// Về lý thuyết, counter tăng dần sau mỗi lần ký; một chữ ký mang counter không lớn hơn lần
// trước có thể là dấu hiệu khoá riêng đã bị sao chép sang thiết bị khác. Nhưng thực tế nhiều
// Passkey đồng bộ (iCloud Keychain, Google Password Manager) luôn báo 0, và một số bộ xác thực
// dùng chung khoá giữa nhiều thiết bị nên counter không đơn điệu. Từ chối cứng sẽ khoá oan
// người dùng hợp lệ mà không chứng minh được gì. Thiết kế đã chốt: ghi nhận, không kết luận.
//
// Vì vậy các route gọi verifyAuthenticationResponse với counter = 0 để thư viện
// @simplewebauthn/server KHÔNG tự từ chối (nó ném lỗi khi counter không tăng — xem
// verifyAuthenticationResponse.js), rồi dùng module này để tự so sánh và ghi sự kiện.
//
// Quy tắc: chỉ khi CẢ counter cũ lẫn counter mới đều khác 0 mà counter mới <= counter cũ thì
// ghi COUNTER_ANOMALY. Không từ chối xác thực, không khoá credential, không gọi đó là "clone".
//
// Giá trị lưu lại là counter LỚN NHẤT từng thấy (high-water mark), không phải counter mới: nếu
// ghi đè bằng giá trị nhỏ hơn thì một chữ ký lặp lại dải counter cũ lần sau sẽ trông như bình
// thường và tín hiệu bị xoá mất.
const { logSecurityEvent, EVENTS } = require('./securityEvents');

function assessCounter(credential, newCounter) {
  const oldCounter = Number(credential.counter) || 0;
  const next = Number(newCounter) || 0;
  const anomaly = oldCounter !== 0 && next !== 0 && next <= oldCounter;
  return { anomaly, oldCounter, newCounter: next, stored: Math.max(oldCounter, next) };
}

/** Ghi sự kiện nếu có bất thường. Gọi SAU khi giao dịch cơ sở dữ liệu của lần xác thực đã commit. */
async function reportCounterAnomaly(req, credential, check) {
  if (!check.anomaly) return;
  await logSecurityEvent(req, {
    type: EVENTS.COUNTER_ANOMALY,
    // Lần xác thực vẫn được CHẤP NHẬN — sự kiện chỉ đánh dấu để người vận hành xem xét.
    outcome: 'ALLOWED',
    actorId: credential.user_id,
    detail: {
      credentialId: credential.credential_id,
      oldCounter: check.oldCounter,
      newCounter: check.newCounter,
    },
  });
}

module.exports = { assessCounter, reportCounterAnomaly };
