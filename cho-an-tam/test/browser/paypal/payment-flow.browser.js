/**
 * B1-B2: luồng thanh toán PayPal Sandbox trong Chrome THẬT với API FIXTURE (không phải Sandbox/backend/cookie thật).
 *   B1  nút "Mở PayPal Sandbox" -> GET checkout -> điều hướng thật tới đúng approval URL; URL giả không rời trang.
 *   B2  return/cancel: dọn query, không xử lý lại khi reload, cancel không capture, tự capture sau return đã xác minh.
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


    t.section('B2: tự hoàn tất, cancel, Back và bằng chứng GET');
    for (const stage of ['SUCCEEDED','AWAITING_APPROVAL','RECONCILING']) {
      await t.case('Return tự capture, kết quả '+stage, async c=>{
        const {s}=await make(c,{search:returnSearch,routesOver:sv=>({[POST_CAPTURE]:()=>{sv.row={...sv.row,stage,status:stage==='SUCCEEDED'?'SUCCEEDED':'PENDING'};return h.json(200,{outcome:'APPLIED'});}})});
        await s.open();
        await s.until(()=>s.fx.responded(POST_CAPTURE)===1&&s.fx.responded(GET_ROW)>=2,4000,'capture + GET kết quả');
        c.precondition(s.fx.count(POST_CAPTURE)===1,'Một capture đã được thực hiện');
        const firstCapture=s.fx.requests.findIndex(r=>r.key===POST_CAPTURE);
        c.ok(s.fx.requests.slice(0,firstCapture).some(r=>r.key===GET_ROW),'GET trước capture');
        c.ok(s.fx.requests.slice(firstCapture+1).some(r=>r.key===GET_ROW),'GET sau capture');
        c.ok(!(await s.has('[data-act="paypal-capture"]')),'Không cần nút xác nhận thứ hai');
        c.ok(urlParts(s).search==='','Dọn callback query');
        if(stage==='SUCCEEDED'){
          await s.until(async()=>(await okToasts(s)).some(x=>/Nạp tiền thành công/.test(x.text)),4000,'toast thành công');
          c.ok((await okToasts(s)).filter(x=>/Nạp tiền thành công/.test(x.text)).length===1,'Một thông báo thành công');
          c.ok(await s.intent()===null,'Dọn ý định');
          c.ok(s.fx.count('GET /api/wallets/me')>=2,'Đọc lại ví máy chủ');
        }else{
          await s.until(async()=>stage==='RECONCILING'?/đối soát/.test(await s.viewText()):/Chờ bạn phê duyệt/.test(await s.viewText()),4000,'trạng thái chưa hoàn tất');
          c.ok((await okToasts(s)).length===0&&!!(await s.intent()),'Không tin POST 200 để báo thành công');
        }
        const caps=s.fx.count(POST_CAPTURE);
        await s.page.reload({waitUntil:'domcontentloaded'});
        await s.page.waitForSelector('#topupAmount',{timeout:5000});
        c.ok(s.fx.count(POST_CAPTURE)===caps,'Reload không capture lại');
        c.ok(s.leaked().length===0,'Không request ngoài lọt ra');
      });
    }
    for(const kind of ['cancel','return']){
      await t.case(kind==='cancel'?'Cancel không thu tiền':'Return thiếu ý định không thu tiền',async c=>{
        const {s}=await make(c,{search:kind==='cancel'?cancelSearch:returnSearch,...(kind==='return'?{storage:{}}:{})});
        await s.open();await s.until(()=>s.fx.responded(GET_ROW)>=1,4000,'GET xác minh');
        await s.until(async()=>/chưa hoàn tất phê duyệt|không khớp với ý định/.test(await s.viewText()),4000,'thông báo');
        c.ok(s.fx.count(POST_CAPTURE)===0,'Không capture');
        c.ok((await okToasts(s)).length===0,'Không báo thành công');
        c.ok(s.leaked().length===0,'Không request ngoài lọt ra');
      });
    }
    await t.case('Capture treo: vẽ lại trang không gửi lặp',async c=>{
      const gate=h.deferred();const {s}=await make(c,{search:returnSearch,routesOver:sv=>({[POST_CAPTURE]:()=>gate.promise.then(()=>h.json(200,{outcome:'BUSY'}))})});
      c.cleanup(()=>gate.release());await s.open();await s.until(()=>s.fx.count(POST_CAPTURE)===1,4000,'POST capture');
      c.precondition(s.fx.responded(POST_CAPTURE)===0,'Phản hồi còn treo');
      await s.page.evaluate(()=>window.dispatchEvent(new Event('hashchange')));
      await s.until(()=>s.fx.responded('GET /api/wallets/me/entries')>=2,4000,'vẽ lại trang');
      c.ok(s.fx.count(POST_CAPTURE)===1,'Không gửi capture thứ hai');
      c.ok(!(await s.has('[data-act="paypal-capture"]')),'Không có nút capture lặp');
      c.ok(s.leaked().length===0,'Không request ngoài lọt ra');
    });
    await t.case('Back từ PayPal: chờ quyết định và cho huỷ',async c=>{
      const {s}=await make(c);await revealApprove(s);await s.click('#topupIntent [data-act="paypal-approve"]');
      await s.until(()=>s.navs.length===1,4000,'đã mở PayPal fixture');
      await s.page.waitForURL(h.SANDBOX,{waitUntil:'domcontentloaded',timeout:5000});
      await s.page.waitForSelector('p',{timeout:5000});
      await s.page.goBack({waitUntil:'domcontentloaded'});
      await s.page.waitForSelector('#topupIntent [data-act="paypal-abandon"]',{timeout:5000});
      c.ok(/chưa hoàn tất phê duyệt/.test(await s.viewText()),'Hiện trạng thái chờ');
      c.ok(await s.has('[data-act="paypal-approve"]'),'Có nút tiếp tục');
      c.ok(s.fx.count(POST_CAPTURE)===0,'Back không thu tiền');
      c.ok(!!(await s.intent()),'Giữ ý định nạp');
      c.ok(s.leaked().length===0,'Không request ngoài lọt ra');
      await s.shot('B2-back-cho-quyet-dinh');
    });
  },
};
