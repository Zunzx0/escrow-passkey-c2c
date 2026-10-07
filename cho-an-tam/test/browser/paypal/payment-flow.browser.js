/**
 * B1-B2: luồng thanh toán PayPal Sandbox trong Chrome THẬT với API FIXTURE (không phải Sandbox/backend/cookie thật).
 *   B1  nút "Mở PayPal Sandbox" -> GET checkout -> điều hướng thật tới đúng approval URL; URL giả không rời trang.
 *   B2  return/cancel: dọn query, không xử lý lại khi reload, cancel không capture, capture chỉ sau bấm xác nhận.
 * Không dùng ENCLAVE_NAVIGATE; không sleep để đoán thời điểm.
 */
module.exports = {
  id: 'B1B2',
  title: 'Luồng thanh toán PayPal: mở Sandbox, URL giả, return/cancel, capture (Chrome thật, fixture)',
  async run({ h, t, browser }) {
    const ID = h.ID;
    const GET_ROW = `GET /api/payments/${ID}`;
    const GET_CHECKOUT = `GET /api/payments/paypal/${ID}/checkout`;
    const POST_CAPTURE = `POST /api/payments/paypal/${ID}/capture`;
    const intentStore = () => ({ [h.INTENT_PREFIX + h.BUYER.id]: h.intentJson() });
    const returnSearch = `?paypal=return&paymentRequestId=${ID}&token=TOKEN-RET-123&PayerID=PAYER-RET-456`;
    const cancelSearch = `?paypal=cancel&paymentRequestId=${ID}&token=TOKEN-CAN-123`;
    const okToasts = (s) => s.toasts().then((a) => a.filter((x) => x.kind === 'ok'));
    const urlParts = (s) => new URL(s.page.url());
    const noExternalNav = (s) => s.external.filter((e) => e.navigation).length === 0;

    /** Dựng phiên: ý định đã lưu + fixture PayPal có trạng thái; srv điều khiển trạng thái và URL phê duyệt. */
    async function make(c, { search = '', storage = intentStore(), srvInit, routesOver, cfg } = {}) {
      const srv = h.paypalServer(srvInit);
      const s = await h.openSession(browser, { routes: { ...srv.routes(), ...(routesOver ? routesOver(srv) : {}) }, search, storage, cfg });
      c.cleanup(() => s.close());
      return { s, srv };
    }
    /** Từ ý định đã lưu: bấm "Kiểm tra trạng thái" thật để lộ nút mở PayPal. */
    async function revealApprove(s) {
      await s.open();
      await s.page.waitForSelector('#topupIntent [data-act="topup-check"]', { timeout: 5000 });
      await s.click('#topupIntent [data-act="topup-check"]');
      await s.page.waitForSelector('#topupIntent [data-act="paypal-approve"]', { timeout: 5000 });
    }

    // ------------------------------------------------------------------ B1
    t.section('B1: mở PayPal Sandbox thật trong Chrome');
    await t.case('B1.1 Bấm "Mở PayPal Sandbox": GET checkout rồi điều hướng thật tới đúng approval URL của fixture', async (c) => {
      const { s } = await make(c);
      await revealApprove(s);
      const hook = await s.page.evaluate(() => typeof window.ENCLAVE_NAVIGATE);
      const before = s.page.url();
      c.precondition(hook === 'undefined', 'Không có hook ENCLAVE_NAVIGATE: điều hướng là của trình duyệt thật');
      c.precondition(s.fx.count(GET_CHECKOUT) === 0 && s.navs.length === 0, 'Chưa gọi checkout, chưa điều hướng trước khi bấm');
      await s.click('#topupIntent [data-act="paypal-approve"]');
      await s.until(() => s.fx.responded(GET_CHECKOUT) === 1, 4000, 'GET checkout được trả lời');
      await s.until(() => s.navs.length >= 1, 4000, 'điều hướng chính sang PayPal');
      await s.page.waitForURL((u) => u.host === h.PAYPAL_HOST, { timeout: 4000 });
      c.ok(s.fx.count(GET_CHECKOUT) === 1, 'Đúng một GET .../checkout');
      c.ok(s.navs.length === 1 && s.navs[0] === h.SANDBOX, `Điều hướng thật đúng URL fixture trả (${s.navs[0]})`);
      c.ok(before !== s.page.url() && urlParts(s).host === h.PAYPAL_HOST, 'Tab thực sự rời trang ví sang host Sandbox');
      c.ok(s.external.every((e) => e.navigation && e.action === 'stub' && new URL(e.url).host === h.PAYPAL_HOST), 'Mọi request ngoài chỉ là điều hướng chính tới host Sandbox (bị thay bằng trang giả)');
      c.ok(s.fx.count('POST /api/payments/paypal/' + ID + '/capture') === 0, 'Mở PayPal không tự capture');
      c.ok(s.leaked().length === 0, 'Không request ngoài lọt ra');
    });

    const badUrls = [
      ['http không TLS', 'http://www.sandbox.paypal.com/checkoutnow?token=ORDER1'],
      ['hậu tố (…paypal.com.evil.example)', 'https://www.sandbox.paypal.com.evil.example/checkoutnow?token=ORDER1'],
      ['tiền tố (evil-www.sandbox…)', 'https://evil-www.sandbox.paypal.com/checkoutnow'],
      ['thiếu www', 'https://sandbox.paypal.com/checkoutnow?token=ORDER1'],
      ['subdomain khác', 'https://api.sandbox.paypal.com/checkoutnow'],
      ['PayPal LIVE', 'https://www.paypal.com/checkoutnow?token=ORDER1'],
      ['userinfo user:pass', 'https://user:pass@www.sandbox.paypal.com/checkoutnow'],
      ['userinfo giả host (…paypal.com@evil.example)', 'https://www.sandbox.paypal.com@evil.example/checkoutnow'],
      ['cổng lạ :8443', 'https://www.sandbox.paypal.com:8443/checkoutnow'],
      ['javascript:', 'javascript:alert(1)'],
      ['data:', 'data:text/html,<script>1</script>'],
      ['chứa khoảng trắng', 'https://www.sandbox.paypal.com/a b'],
      ['dấu gạch chéo ngược', 'https://www.sandbox.paypal.com\\@evil.example/'],
      ['chuỗi rỗng', ''],
      ['null', null],
      ['số', 12345],
    ];
    for (const [label, url] of badUrls) {
      await t.case(`B1.2 URL phê duyệt giả (${label}): không rời trang, giao diện báo lỗi`, async (c) => {
        const { s, srv } = await make(c);
        srv.approvalUrl = url;
        await revealApprove(s);
        const before = s.page.url();
        await s.click('#topupIntent [data-act="paypal-approve"]');
        await s.until(() => s.fx.responded(GET_CHECKOUT) === 1, 4000, 'GET checkout được trả lời');
        c.precondition(s.fx.count(GET_CHECKOUT) === 1, 'Request checkout thật đã phát và được fixture trả lời (URL giả đã tới trang)');
        await s.until(async () => (await s.toasts()).some((x) => x.kind === 'err' && /địa chỉ phê duyệt không hợp lệ/.test(x.text)), 4000, 'toast lỗi địa chỉ phê duyệt không hợp lệ');
        c.ok(s.navs.length === 0, 'Không có điều hướng chính sang PayPal (s.navs rỗng)');
        c.ok(s.page.url() === before, 'URL trang không đổi');
        c.ok(s.external.length === 0 && noExternalNav(s), 'Không có request/điều hướng ngoài nào (s.external rỗng)');
        c.ok(await s.has('#topupIntent [data-act="paypal-approve"]'), 'Giao diện vẫn ở trang ví, nút mở lại còn đó');
        c.ok(s.leaked().length === 0, 'Không request ngoài lọt ra');
      });
    }

    // ------------------------------------------------------------------ B2
    t.section('B2: return / cancel / capture');
    await t.case('B2.1 Return: dọn token/PayerID khỏi thanh địa chỉ, chỉ GET xác minh, KHÔNG tự capture; reload không xử lý lại', async (c) => {
      const { s } = await make(c, { search: returnSearch });
      await s.open();
      await s.page.waitForSelector('#topupIntent [data-act="paypal-capture"]', { timeout: 5000 });
      c.precondition(s.fx.responded(GET_ROW) >= 1, 'GET /payments/:id (xác minh) đã được fixture trả lời');
      c.precondition(await s.has('#topupIntent [data-act="paypal-capture"]'), 'Trang ở trạng thái return khớp ý định: có nút xác nhận');
      const u = urlParts(s);
      c.ok(u.search === '' && u.hash === '#/wallet' && !/TOKEN-RET|PAYER-RET|paypal=/.test(s.page.url()), `Query dọn sạch, giữ #/wallet (${u.pathname + u.search + u.hash})`);
      c.ok(!/TOKEN-RET|PAYER-RET/.test(await s.page.evaluate(() => location.href)), 'token/PayerID không còn trong location.href');
      c.ok(s.fx.count(POST_CAPTURE) === 0, 'Return KHÔNG tự capture');
      c.ok((await okToasts(s)).length === 0 && !/Nạp tiền thành công/.test(await s.viewText()), 'Return KHÔNG tự báo thành công');
      c.ok(s.fx.count('POST /api/payments/paypal/topup') === 0, 'Return không tạo yêu cầu mới');
      await s.shot('B2-return-cho-xac-nhan');
      const getsBefore = s.fx.count(GET_ROW);
      const meBefore = s.fx.responded('GET /api/users/me');
      await s.page.reload({ waitUntil: 'domcontentloaded' });
      await s.until(() => s.fx.responded('GET /api/users/me') > meBefore, 4000, 'tải lại hoàn tất khôi phục phiên');
      await s.page.waitForSelector('#topupAmount', { timeout: 5000 });
      c.ok(s.fx.count(GET_ROW) === getsBefore, 'Sau reload KHÔNG xử lý lại return (không có GET /payments/:id mới)');
      c.ok(!(await s.has('#topupIntent [data-act="paypal-capture"]')) && s.fx.count(POST_CAPTURE) === 0, 'Sau reload không còn nút capture, không POST capture');
      c.ok(urlParts(s).search === '', 'Sau reload thanh địa chỉ vẫn sạch query');
      c.ok(s.leaked().length === 0 && s.external.length === 0, 'Không request ngoài lọt ra');
    });

    await t.case('B2.2 Query return KHÔNG phải chứng cứ: không có ý định trên thiết bị thì không cho capture', async (c) => {
      const { s } = await make(c, { search: returnSearch, storage: {} });
      await s.open();
      await s.until(() => s.fx.responded(GET_ROW) >= 1, 4000, 'GET xác minh trả lời');
      await s.until(async () => /không khớp với ý định/.test(await s.viewText()), 4000, 'giao diện báo không khớp ý định');
      c.precondition(await s.has('#topupIntent'), 'Trang ví đã dựng và có vùng thông báo');
      c.ok(!(await s.has('#topupIntent [data-act="paypal-capture"]')), 'Không có nút capture dù URL mang token/PayerID');
      c.ok(s.fx.count(POST_CAPTURE) === 0 && (await okToasts(s)).length === 0, 'Không POST capture, không toast thành công');
      c.ok(urlParts(s).search === '', 'Query vẫn được dọn');
      c.ok(s.leaked().length === 0 && s.navs.length === 0, 'Không request ngoài lọt ra, không điều hướng');
    });

    await t.case('B2.3 Cancel: chỉ GET trạng thái, không capture, không toast thành công, giữ ý định và mở lại được PayPal', async (c) => {
      const { s } = await make(c, { search: cancelSearch });
      await s.open();
      await s.page.waitForSelector('#topupIntent [data-act="paypal-approve"]', { timeout: 5000 });
      c.precondition(s.fx.responded(GET_ROW) >= 1, 'GET /payments/:id (xác minh) đã được trả lời');
      c.precondition(/chưa hoàn tất phê duyệt/.test(await s.viewText()), 'Trang đang ở trạng thái cancel');
      const u = urlParts(s);
      c.ok(u.search === '' && u.hash === '#/wallet' && !/TOKEN-CAN/.test(s.page.url()), 'Query cancel (kèm token) được dọn khỏi thanh địa chỉ');
      c.ok(s.fx.count(POST_CAPTURE) === 0 && !(await s.has('#topupIntent [data-act="paypal-capture"]')), 'Cancel: không POST capture, không có nút capture');
      c.ok((await okToasts(s)).length === 0, 'Cancel: không có toast thành công');
      const v = await s.viewText();
      c.ok(/không làm yêu cầu thất bại/.test(v) && !/Thất bại|đã đóng/.test(await s.page.$eval('#topupIntent', (e) => e.textContent)), 'Cancel không bị diễn giải là FAILED/đóng');
      const it = await s.intent();
      c.ok(!!it && it.paymentId === ID && it.requestId === h.KEY && it.amount === h.AMOUNT, 'Ý định vẫn còn trong localStorage (order giữ để mở lại)');
      c.ok(s.fx.count('POST /api/payments/paypal/topup') === 0, 'Không tạo yêu cầu mới');
      await s.shot('B2-cancel-giu-y-dinh');
      // Mở lại PayPal từ trạng thái cancel
      const reopenLabel = await s.page.$eval('#topupIntent [data-act="paypal-approve"]', (e) => e.textContent.trim());
      c.ok(reopenLabel === 'Mở lại PayPal Sandbox', `Nút mở lại có nhãn "${reopenLabel}"`);
      await s.click('#topupIntent [data-act="paypal-approve"]');
      await s.until(() => s.fx.responded(GET_CHECKOUT) === 1 && s.navs.length === 1, 4000, 'mở lại PayPal');
      c.ok(s.navs[0] === h.SANDBOX, 'Mở lại điều hướng đúng approval URL');
      c.ok(s.fx.count(POST_CAPTURE) === 0 && s.leaked().length === 0, 'Vẫn không capture, không request ngoài lọt ra');
    });

    await t.case('B2.4 Cancel rồi reload: không xử lý lại, ý định còn nguyên', async (c) => {
      const { s } = await make(c, { search: cancelSearch });
      await s.open();
      await s.page.waitForSelector('#topupIntent [data-act="paypal-approve"]', { timeout: 5000 });
      c.precondition(s.fx.responded(GET_ROW) >= 1 && urlParts(s).search === '', 'Cancel đã xử lý và query đã dọn');
      const getsBefore = s.fx.count(GET_ROW);
      const meBefore = s.fx.responded('GET /api/users/me');
      await s.page.reload({ waitUntil: 'domcontentloaded' });
      await s.until(() => s.fx.responded('GET /api/users/me') > meBefore, 4000, 'tải lại hoàn tất khôi phục phiên');
      await s.page.waitForSelector('#topupAmount', { timeout: 5000 });
      c.ok(s.fx.count(GET_ROW) === getsBefore, 'Reload không xử lý lại cancel');
      c.ok(!!(await s.intent()) && s.fx.count(POST_CAPTURE) === 0 && (await okToasts(s)).length === 0, 'Ý định còn, không capture, không toast thành công');
      c.ok(s.leaked().length === 0, 'Không request ngoài lọt ra');
    });

    await t.case('B2.5 Bấm xác nhận kể cả bấm đúp: đúng MỘT POST capture', async (c) => {
      const gate = h.deferred();
      const { s, srv } = await make(c, {
        search: returnSearch,
        routesOver: (sv) => ({ [POST_CAPTURE]: () => gate.promise.then(() => h.json(200, { ...sv.row, outcome: 'APPLIED' })) }),
      });
      await s.open();
      await s.page.waitForSelector('#topupIntent [data-act="paypal-capture"]', { timeout: 5000 });
      c.precondition(s.fx.count(POST_CAPTURE) === 0, 'Trước khi bấm chưa có POST capture');
      srv.row = { ...srv.row, stage: 'CAPTURING' };
      // Hai click đồng bộ trên cùng nút thật (giả lập bấm đúp)
      await s.page.$eval('#topupIntent [data-act="paypal-capture"]', (b) => { b.click(); b.click(); });
      await s.until(() => s.fx.count(POST_CAPTURE) >= 1, 4000, 'POST capture tới fixture');
      c.precondition(s.fx.responded(POST_CAPTURE) === 0, 'POST capture đang treo (chưa trả lời) khi quan sát lần bấm lặp');
      // Kiểm riêng guard busy: gỡ disabled của nút (nếu còn) rồi click lại thật lúc POST đang treo.
      const probe = await s.page.$eval('#topupIntent', (e) => {
        const b = e.querySelector('[data-act="paypal-capture"]');
        if (!b) return { found: false };
        const wasDisabled = b.disabled;
        b.disabled = false;
        b.removeAttribute('disabled');
        b.click();
        return { found: true, wasDisabled };
      });
      c.ok(probe.found && probe.wasDisabled, `Nút capture còn trong DOM lúc treo và đang disabled (found=${probe.found}, disabled=${probe.wasDisabled}); đã gỡ disabled rồi click lại nên guard busy được kiểm riêng`);
      c.ok(s.fx.count(POST_CAPTURE) === 1, 'Gỡ disabled + click lại lúc POST treo: vẫn đúng 1 POST capture (guard busy)');
      const getsBefore = s.fx.count(GET_ROW);
      gate.release();
      await s.until(() => s.fx.responded(POST_CAPTURE) >= 1, 4000, 'POST capture được trả lời');
      await s.until(() => s.fx.responded(GET_ROW) > getsBefore, 4000, 'GET trạng thái sau capture');
      await s.until(async () => /Đang xác nhận thanh toán/.test(await s.viewText()), 4000, 'hiển thị CAPTURING');
      c.ok(s.fx.count(POST_CAPTURE) === 1, 'Đúng MỘT POST capture ở fixture sau bấm đúp + bấm lặp lúc đang treo');
      c.ok(!(await s.has('#topupIntent [data-act="paypal-capture"]')), 'Không còn nút capture sau khi xác nhận');
      c.ok((await okToasts(s)).length === 0, 'CAPTURING chưa báo thành công');
      c.ok(s.leaked().length === 0, 'Không request ngoài lọt ra');
    });

    for (const [label, stage, re] of [
      ['RECONCILING', 'RECONCILING', /Chưa rõ kết quả thanh toán/],
      ['PENDING / AWAITING_APPROVAL', 'AWAITING_APPROVAL', /Vẫn chờ phê duyệt|Bạn đã quay lại|Chờ bạn phê duyệt/],
    ]) {
      await t.case(`B2.6 POST capture 200 nhưng GET nói ${label}: KHÔNG báo thành công`, async (c) => {
        const { s, srv } = await make(c, { search: returnSearch });
        await s.open();
        await s.page.waitForSelector('#topupIntent [data-act="paypal-capture"]', { timeout: 5000 });
        srv.row = { ...srv.row, status: 'PENDING', stage };
        const getsBefore = s.fx.count(GET_ROW);
        await s.click('#topupIntent [data-act="paypal-capture"]');
        await s.until(() => s.fx.responded(POST_CAPTURE) === 1, 4000, 'POST capture 200');
        await s.until(() => s.fx.responded(GET_ROW) > getsBefore, 4000, 'GET trạng thái sau capture');
        c.precondition(s.fx.count(POST_CAPTURE) === 1 && s.fx.count(GET_ROW) > getsBefore, 'POST capture đã phát/được trả lời và GET sau capture đã trả về PENDING');
        await s.until(async () => re.test(await s.viewText()), 4000, 'giao diện phản ánh trạng thái chưa xong');
        c.ok((await okToasts(s)).length === 0 && !/Nạp tiền thành công/.test(await s.viewText()), 'Không toast/chữ "Nạp tiền thành công"');
        c.ok(!!(await s.intent()), 'Ý định được giữ (chưa có chứng cứ thu tiền)');
        c.ok(s.fx.count(POST_CAPTURE) === 1, 'Không gửi lại POST capture');
        c.ok(s.leaked().length === 0, 'Không request ngoài lọt ra');
      });
    }

    await t.case('B2.7 POST capture 200 và GET SUCCEEDED khớp ý định: đúng một thông báo thành công, dọn ý định, đọc lại ví', async (c) => {
      const { s, srv } = await make(c, { search: returnSearch });
      await s.open();
      await s.page.waitForSelector('#topupIntent [data-act="paypal-capture"]', { timeout: 5000 });
      c.precondition((await okToasts(s)).length === 0 && !!(await s.intent()), 'Trước capture: chưa có toast thành công, ý định còn');
      srv.row = { ...srv.row, status: 'SUCCEEDED', stage: 'SUCCEEDED', resolvedAt: new Date().toISOString(), resolvedBy: 'WEBHOOK' };
      const getsBefore = s.fx.count(GET_ROW);
      const walletBefore = s.fx.count('GET /api/wallets/me');
      await s.click('#topupIntent [data-act="paypal-capture"]');
      await s.until(() => s.fx.responded(POST_CAPTURE) === 1, 4000, 'POST capture 200');
      await s.until(() => s.fx.responded(GET_ROW) > getsBefore, 4000, 'GET trạng thái sau capture');
      await s.until(async () => (await okToasts(s)).some((x) => /Nạp tiền thành công/.test(x.text)), 4000, 'toast thành công');
      c.ok((await okToasts(s)).filter((x) => /Nạp tiền thành công/.test(x.text)).length === 1, 'Đúng MỘT toast "Nạp tiền thành công"');
      await s.until(async () => (await s.intent()) === null, 4000, 'ý định được dọn');
      c.ok(s.fx.count(POST_CAPTURE) === 1, 'Đúng MỘT POST capture');
      c.ok(s.fx.count('GET /api/wallets/me') > walletBefore, 'Ví được đọc lại từ máy chủ');
      c.ok(s.leaked().length === 0, 'Không request ngoài lọt ra');
    });
  },
};
