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
const express = require('express');
const provider = require('../lib/mockPaymentProvider');

const router = express.Router();

router.use((req, res, next) => {
  if (!provider.isCheckoutEnabled()) return res.status(404).json({ error: 'NOT_FOUND' });
  next();
});

function publicView(row) {
  return { providerRef: row.provider_ref, amount: row.amount, status: row.status };
}

router.get('/checkout/:providerRef', (req, res) => {
  const row = provider.findPayment(req.params.providerRef);
  if (!row) return res.status(404).json({ error: 'UNKNOWN_PAYMENT', message: 'Cổng thanh toán không có giao dịch này' });
  res.json(publicView(row));
});

router.post('/checkout/:providerRef/pay', async (req, res, next) => {
  try {
    const { outcome, deliverWebhook = true } = req.body || {};
    if (outcome !== 'SUCCEEDED' && outcome !== 'FAILED') {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'outcome phải là SUCCEEDED hoặc FAILED' });
    }
    const row = provider.findPayment(req.params.providerRef);
    if (!row) return res.status(404).json({ error: 'UNKNOWN_PAYMENT', message: 'Cổng thanh toán không có giao dịch này' });
    // Một khoản đã chốt kết quả ở provider thì không "thanh toán lại" được.
    if (row.status !== 'PENDING') {
      return res.status(409).json({ error: 'ALREADY_SETTLED', message: `Giao dịch đã có kết quả ${row.status} ở cổng thanh toán` });
    }

    const callback = provider.settlePayment(row.provider_ref, outcome);
    const webhook = deliverWebhook ? await provider.deliverWebhook(callback) : { delivered: false, skipped: true };
    res.json({ providerStatus: outcome, webhook: { delivered: webhook.delivered, skipped: !!webhook.skipped, status: webhook.status || null } });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
