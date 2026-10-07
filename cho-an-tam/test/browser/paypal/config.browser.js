/**
 * B5 — cấu hình nạp tiền công khai trong Chrome thật (API FIXTURE, không phải backend/PayPal thật).
 * Cổng chỉ mở theo xác nhận của máy chủ; thiếu/lỗi/sai dạng thì đóng CẢ HAI, không fallback sang mock, không POST topup.
 */
const CFG_KEY = 'GET /api/payments/paypal/config';
const POSTS = ['POST /api/payments/paypal/topup', 'POST /api/payments/topup'];
const NOT_READY = 'Nạp tiền chưa sẵn sàng';

module.exports = {
  id: 'B5',
  title: 'Cấu hình nạp tiền: đóng khi lỗi/sai dạng, mở đúng provider server xác nhận',
  async run({ h, t, browser }) {
    /** Mở trang ví và chờ cho tới khi card nạp tiền vẽ xong sau khi config được xử lý. */
    async function openWallet(c, { resp, cfg, timeoutMs = 5000, expectResponded = true }) {
      const routes = resp ? { [CFG_KEY]: resp } : {};
      const s = await h.openSession(browser, { routes, cfg, timeoutMs });
      c.cleanup(() => s.close());
      await s.open();
      await s.until(() => s.fx.count(CFG_KEY) >= 1, 5000, 'GET config tới fixture');
      if (expectResponded) await s.until(() => s.fx.responded(CFG_KEY) >= 1, 5000, 'fixture trả lời GET config');
      await s.page.waitForFunction(() => /Nạp tiền vào ví/.test((document.querySelector('#view') || {}).textContent || '')
        && (document.querySelector('#topupAmount') || /Nạp tiền chưa sẵn sàng/.test(document.querySelector('#view').textContent)), null, { timeout: 8000 });
      c.precondition(s.fx.count(CFG_KEY) >= 1, 'GET /api/payments/paypal/config đã được gọi thật');
      return s;
    }
    const closedBoth = async (c, s) => {
      c.ok(!(await s.has('#topupAmount')), 'Không có ô nhập số tiền (cả hai cổng đóng)');
      c.ok(!(await s.has('[data-act="topup-create"]')) && !(await s.has('[data-act="topup-preset"]')), 'Không có nút tạo/preset nạp tiền');
      c.ok(new RegExp(NOT_READY).test(await s.viewText()), `Hiện "${NOT_READY}"`);
      c.ok(!/Cổng thanh toán mô phỏng/.test(await s.viewText()) && !(await s.has('.tag-info')), 'Không fallback: không thẻ mô phỏng, không nhãn PayPal Sandbox');
      for (const k of POSTS) c.ok(s.fx.count(k) === 0, `Không phát ${k}`);
      c.ok(s.fx.requests.filter((r) => r.key.includes('/mock-provider/')).length === 0, 'Không gọi /mock-provider/');
      c.ok(s.navs.length === 0, 'Không điều hướng sang PayPal');
      c.ok(s.leaked().length === 0, 'Không request ngoài lọt ra');
    };

    t.section('Cấu hình lỗi hoặc sai dạng: đóng cả hai cổng');
    const bad = [
      ['404', () => h.json(404, { error: 'NOT_FOUND', message: 'x' }), 'đã xác nhận 404 là có phản hồi'],
      ['500', () => h.json(500, { error: 'INTERNAL_ERROR', message: 'x' })],
      ['200 JSON rỗng {}', () => h.json(200, {})],
      ['200 mảng', () => h.json(200, [])],
      ['200 null', () => h.json(200, null)],
      ['200 chuỗi JSON', () => h.json(200, 'paypal')],
      ['200 không phải JSON (HTML)', () => ({ status: 200, type: 'text/html', text: '<html>ok</html>' })],
      ['200 JSON hỏng cú pháp', () => ({ status: 200, type: 'application/json', text: '{"paypalSandbox":{' })],
      ['thiếu mockPayments', () => h.json(200, { paypalSandbox: { enabled: true, mode: 'sandbox', rateKind: 'DEMO_FIXED' } })],
      ['thiếu paypalSandbox', () => h.json(200, { mockPayments: { enabled: true } })],
      ['paypalSandbox.enabled là chuỗi "true"', () => h.json(200, { paypalSandbox: { enabled: 'true', mode: 'sandbox' }, mockPayments: { enabled: false } })],
      ['mockPayments.enabled là số 1', () => h.json(200, { paypalSandbox: { enabled: false, mode: 'sandbox' }, mockPayments: { enabled: 1 } })],
      ['mockPayments là chuỗi', () => h.json(200, { paypalSandbox: { enabled: false, mode: 'sandbox' }, mockPayments: 'on' })],
      ['paypalSandbox là mảng', () => h.json(200, { paypalSandbox: [], mockPayments: { enabled: true } })],
    ];
    for (const [label, resp] of bad) {
      await t.case(`B5 config ${label}: đóng cả hai cổng`, async (c) => {
        const s = await openWallet(c, { resp });
        c.ok(s.fx.responded(CFG_KEY) >= 1, 'GET config đã được trả lời trước khi assert');
        c.ok(await s.has('[data-act="paypal-config-retry"]'), 'Có nút "Tải lại cấu hình" (trạng thái lỗi, không đoán)');
        await closedBoth(c, s);
      });
    }

    await t.case('B5 config treo (timeout): đóng cả hai cổng, request GET đã gửi nhưng chưa được trả lời', async (c) => {
      const s = await openWallet(c, { resp: () => h.HANG, timeoutMs: 400, expectResponded: false });
      c.ok(s.fx.responded(CFG_KEY) === 0, 'Fixture không hề trả lời GET config (treo thật)');
      c.ok(await s.has('[data-act="paypal-config-retry"]'), 'Có nút "Tải lại cấu hình"');
      await closedBoth(c, s);
    });

    await t.case('B5 config lỗi rồi bấm "Tải lại cấu hình" với config hợp lệ: mở đúng cổng, vẫn không POST khi lỗi', async (c) => {
      let ok = false;
      const s = await openWallet(c, { resp: () => (ok ? h.json(200, h.CFG(true, false)) : h.json(500, { error: 'INTERNAL_ERROR', message: 'x' })) });
      c.precondition(!(await s.has('#topupAmount')), 'Trạng thái đầu: cổng đóng sau 500');
      for (const k of POSTS) c.ok(s.fx.count(k) === 0, `Trước khi tải lại không phát ${k}`);
      ok = true;
      const before = s.fx.count(CFG_KEY);
      await s.click('[data-act="paypal-config-retry"]');
      await s.until(() => s.fx.count(CFG_KEY) > before && s.fx.responded(CFG_KEY) > before, 4000, 'GET config lần 2 được trả lời');
      await s.page.waitForSelector('#topupAmount', { timeout: 4000 });
      c.ok(/PayPal Sandbox/.test(await s.viewText()) && (await s.has('.tag-info')), 'Sau tải lại hợp lệ: mở PayPal Sandbox');
      for (const k of POSTS) c.ok(s.fx.count(k) === 0, `Mở cổng không tự phát ${k}`);
      c.ok(s.leaked().length === 0, 'Không request ngoài lọt ra');
    });

    t.section('Cấu hình hợp lệ: chỉ mở đúng provider server xác nhận');
    await t.case('B5 paypal=true, mock=false, mode=sandbox: PayPal Sandbox', async (c) => {
      const s = await openWallet(c, { cfg: h.CFG(true, false) });
      c.precondition(s.fx.responded(CFG_KEY) >= 1, 'Config hợp lệ đã được fixture trả lời');
      const text = await s.viewText();
      c.ok(await s.has('#topupAmount'), 'Có ô nhập số tiền');
      c.ok(/PayPal Sandbox/.test(text) && (await s.has('.tag-info')), 'Có nhãn PayPal Sandbox');
      c.ok(/Tạo yêu cầu nạp PayPal/.test(await s.page.$eval('[data-act="topup-create"]', (e) => e.textContent)), 'Nút ghi rõ "Tạo yêu cầu nạp PayPal"');
      c.ok(!/Cổng thanh toán mô phỏng/.test(text), 'Không thẻ cổng mô phỏng');
      for (const k of POSTS) c.ok(s.fx.count(k) === 0, `Chưa phát ${k} khi chưa bấm`);
      c.ok(s.leaked().length === 0, 'Không request ngoài lọt ra');
    });

    await t.case('B5 paypal=false, mock=true: cổng mô phỏng, không nhãn PayPal', async (c) => {
      const s = await openWallet(c, { cfg: h.CFG(false, true) });
      c.precondition(s.fx.responded(CFG_KEY) >= 1, 'Config hợp lệ đã được fixture trả lời');
      const text = await s.viewText();
      c.ok(await s.has('#topupAmount'), 'Có ô nhập số tiền');
      c.ok(/Cổng thanh toán mô phỏng/.test(text), 'Có nhãn cổng thanh toán mô phỏng');
      c.ok(!(await s.has('.tag-info')) && !/PayPal Sandbox/.test(text) && !/Tạo yêu cầu nạp PayPal/.test(text), 'Không gắn nhãn/nút PayPal Sandbox lên mock');
      c.ok(!(await s.has('[data-act="paypal-approve"]')), 'Không có nút phê duyệt PayPal');
      for (const k of POSTS) c.ok(s.fx.count(k) === 0, `Chưa phát ${k} khi chưa bấm`);
      c.ok(s.leaked().length === 0, 'Không request ngoài lọt ra');
    });

    await t.case('B5 paypal=false, mock=false: chưa sẵn sàng, không có nút tải lại (config hợp lệ)', async (c) => {
      const s = await openWallet(c, { cfg: h.CFG(false, false) });
      c.precondition(s.fx.responded(CFG_KEY) >= 1, 'Config hợp lệ đã được fixture trả lời');
      c.ok(/Hiện chưa có cổng nạp tiền nào được bật/.test(await s.viewText()), 'Thông điệp "chưa có cổng nào được bật" (config ok, không phải lỗi tải)');
      await closedBoth(c, s);
    });

    await t.case('B5 paypal=true mode=live: không mở PayPal', async (c) => {
      const s = await openWallet(c, { cfg: h.CFG(true, false, 'live') });
      c.precondition(s.fx.responded(CFG_KEY) >= 1, 'Config mode=live đã được fixture trả lời');
      await closedBoth(c, s);
    });

    await t.case('B5 paypal=true mode=live + mock=true: chỉ mô phỏng nếu server bật mock, không PayPal', async (c) => {
      const s = await openWallet(c, { cfg: h.CFG(true, true, 'live') });
      c.precondition(s.fx.responded(CFG_KEY) >= 1, 'Config đã được fixture trả lời');
      const text = await s.viewText();
      c.ok(await s.has('#topupAmount') && /Cổng thanh toán mô phỏng/.test(text), 'Mở cổng mô phỏng theo mock=true');
      c.ok(!(await s.has('.tag-info')) && !/Tạo yêu cầu nạp PayPal/.test(text), 'Không PayPal khi mode=live');
      c.ok(s.leaked().length === 0, 'Không request ngoài lọt ra');
    });

    await t.case('B5 paypal=true và mock=true cùng bật: PayPal được ưu tiên, không hiện hai cổng', async (c) => {
      const s = await openWallet(c, { cfg: h.CFG(true, true) });
      c.precondition(s.fx.responded(CFG_KEY) >= 1, 'Config hợp lệ đã được fixture trả lời');
      const text = await s.viewText();
      c.ok(/PayPal Sandbox/.test(text) && (await s.has('.tag-info')), 'Hiện PayPal Sandbox');
      c.ok(!/Cổng thanh toán mô phỏng/.test(text), 'Không đồng thời hiện cổng mô phỏng');
      c.ok(s.leaked().length === 0, 'Không request ngoài lọt ra');
    });
  },
};
