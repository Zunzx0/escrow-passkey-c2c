// "Trang thanh toán" của Mock Payment Provider — PHÍA PROVIDER, không phải API của sàn.
//
// Ngoài đời, bấm "Nạp tiền" sẽ chuyển người dùng sang trang của cổng thanh toán; người dùng
// thanh toán ở đó, rồi cổng thanh toán gửi webhook về máy chủ của merchant. Vì provider ở đây
// là mô phỏng, trang đó được dựng tại /mock-provider/* để buổi demo đi được trọn luồng bằng
// giao diện. Người dùng "thanh toán" bằng cách chọn kết quả, và có thể chọn để webhook thất
// lạc — khi đó chỉ worker đối soát mới phát hiện được kết quả.
//
// Điểm quan trọng: route này KHÔNG chạm vào ví hay payment_requests. Nó chỉ đổi trạng thái ở
// kho của provider rồi gửi webhook đã ký qua HTTP về /api/payments/webhook — backend xử lý y
// như với một provider thật. Trong môi trường thật route này không tồn tại; đặt
// MOCK_PROVIDER_CHECKOUT=0 để tắt hẳn.
//
// Ngoài đời, người trả tiền phải đăng nhập vào chính cổng thanh toán (ngân hàng, ví điện tử).
// Cổng giả lập không có tài khoản riêng nên dùng phiên của sàn làm vật thay thế: chỉ đúng người
// đã tạo yêu cầu nạp tiền mới mở được trang và chốt được kết quả. Biết providerRef thôi là không
// đủ — trước bản vá, ai lộ providerRef (qua log, referrer, ảnh chụp) cũng bị người khác chốt hộ.
const express = require('express');
const provider = require('../lib/mockPaymentProvider');
const { db } = require('../db');
const { requireAuth } = require('../lib/auth');
const { logSecurityEvent, EVENTS } = require('../lib/securityEvents');

const router = express.Router();

router.use((req, res, next) => {
  if (!provider.isCheckoutEnabled()) return res.status(404).json({ error: 'NOT_FOUND' });
  next();
});

function publicView(row) {
  return { providerRef: row.provider_ref, amount: row.amount, status: row.status };
}

const UNKNOWN = { error: 'UNKNOWN_PAYMENT', message: 'Cổng thanh toán không có giao dịch này' };

/**
 * Tìm khoản thanh toán của CHÍNH người gọi. Không phải của họ thì trả như không tồn tại, để
 * trang này không thành công cụ dò xem providerRef nào có thật.
 */
async function findOwnPayment(req, res) {
  const row = await provider.findPayment(req.params.providerRef);
  if (!row) {
    res.status(404).json(UNKNOWN);
    return null;
  }
  const owner = await db.prepare("SELECT user_id FROM payment_requests WHERE id = ? AND provider = 'MOCK'").get(row.merchant_ref);
  if (!owner || owner.user_id !== req.user.id) {
    await logSecurityEvent(req, {
      type: EVENTS.MOCK_CHECKOUT_DENIED, outcome: 'DENIED', statusCode: 404,
      detail: { reason: 'NOT_PAYMENT_OWNER' },
    });
    res.status(404).json(UNKNOWN);
    return null;
  }
  return row;
}

router.get('/checkout/:providerRef', requireAuth, async (req, res) => {
  const row = await findOwnPayment(req, res);
  if (row) res.json(publicView(row));
});

router.post('/checkout/:providerRef/pay', requireAuth, async (req, res, next) => {
  try {
    const { outcome, deliverWebhook = true } = req.body || {};
    if (outcome !== 'SUCCEEDED' && outcome !== 'FAILED') {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'outcome phải là SUCCEEDED hoặc FAILED' });
    }
    const row = await findOwnPayment(req, res);
    if (!row) return;
    // Một khoản đã chốt kết quả ở provider thì không "thanh toán lại" được.
    if (row.status !== 'PENDING') {
      return res.status(409).json({ error: 'ALREADY_SETTLED', message: `Giao dịch đã có kết quả ${row.status} ở cổng thanh toán` });
    }

    let callback;
    try {
      callback = await provider.settlePayment(row.provider_ref, outcome, { onlyFromPending: true });
    } catch (e) {
      if (e.code !== 'ALREADY_SETTLED') throw e;
      return res.status(409).json({ error: 'ALREADY_SETTLED', message: e.message });
    }
    const webhook = deliverWebhook ? await provider.deliverWebhook(callback) : { delivered: false, skipped: true };
    res.json({ providerStatus: outcome, webhook: { delivered: webhook.delivered, skipped: !!webhook.skipped, status: webhook.status || null } });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
