/**
 * B3B4 — phiên đăng nhập trong luồng nạp PayPal Sandbox, Chrome thật + API FIXTURE.
 * B3: phản hồi capture muộn của phiên cũ sau đăng xuất/đăng nhập lại (cùng tài khoản hoặc tài khoản khác).
 * B4: access token bị từ chối -> refresh -> retry đúng phiên; refresh thất bại -> không capture, không báo thành công giả.
 * Giới hạn: fixture, không phải Sandbox/backend thật; cookie không chứng minh Secure/HttpOnly/SameSite thật.
 */
module.exports = {
  id: 'B3B4',
  title: 'Phiên: phản hồi muộn sau đăng xuất/đăng nhập lại; refresh token khi return',
  async run({ h, t, browser }) {
    const CAPTURE = `POST /api/payments/paypal/${h.ID}/capture`;
    const STATUS = `GET /api/payments/${h.ID}`;
    const LOGOUT = 'POST /api/passkeys/session/logout';
    const LOGIN = 'POST /api/passkeys/login/password';
    const REFRESH = 'POST /api/passkeys/session/refresh';
    const SEARCH = '?paypal=return&paymentRequestId=' + h.ID;
    const SUCCESS_RE = /Nạp tiền thành công/;
    const bearer = (e) => (e && e.headers && e.headers.authorization) || '';
    const reqs = (s, key) => s.fx.requests.filter((r) => r.key === key);
    /** Quan sát phủ định có hạn: nhường vài macrotask cho app xử lý phản hồi đã được giao (không dùng để đoán request treo). */
    const settle = async (s) => {
      for (let i = 0; i < 5; i++) await s.page.evaluate(() => new Promise((r) => setTimeout(r, 40)));
    };
    const successToasts = async (s) => (await s.toasts()).filter((x) => SUCCESS_RE.test(x.text));

    // ---------------------------------------------------------------- B3
    const b3 = async (c, who, label) => {
      const srv = h.paypalServer();
      const gate = h.deferred();
      srv.captureResult = () => gate.promise.then(() => h.json(200, { ...srv.row, outcome: 'APPLIED' }));
      const s = await h.openSession(browser, {
        routes: srv.routes(),
        search: SEARCH,
        storage: { [h.INTENT_PREFIX + h.BUYER.id]: h.intentJson() },
      });
      c.cleanup(() => s.close());
      c.cleanup(() => gate.release()); // chạy trước s.close (cleanup đảo ngược): không để response treo
      await s.open();
      await s.page.waitForSelector('[data-act="paypal-capture"]', { timeout: 5000 });
      await s.click('[data-act="paypal-capture"]');
      await s.until(() => s.fx.count(CAPTURE) >= 1, 4000, 'POST capture tới fixture');
      c.precondition(s.fx.count(CAPTURE) === 1 && srv.captures === 1, `POST capture đã tới fixture đúng 1 lần (fx=${s.fx.count(CAPTURE)}, server=${srv.captures})`);
      c.precondition(!gate.settled && s.fx.responded(CAPTURE) === 0, 'Phản hồi capture còn treo (deferred chưa giải quyết, fixture chưa trả lời) trước khi đăng xuất');
      const getsBefore = s.fx.count(STATUS);
      srv.row = h.ppRow({ requestId: h.KEY, status: 'SUCCEEDED', stage: 'SUCCEEDED', resolvedAt: new Date().toISOString() });

      await s.logout();
      await s.login(who);
      c.precondition(s.fx.count(LOGOUT) === 1 && s.fx.count(LOGIN) === 1 && await s.has('[data-act="logout"]'),
        'Phiên mới hiệu lực (1 logout, 1 login, nút đăng xuất xuất hiện) TRƯỚC khi giải phóng phản hồi cũ');
      c.precondition(!gate.settled && s.fx.responded(CAPTURE) === 0 && s.fx.count(CAPTURE) === 1, 'Phản hồi capture cũ vẫn chưa được giao và không có capture thứ hai');
      const getsAfterLogin = s.fx.count(STATUS);

      gate.release();
      await s.until(() => s.fx.responded(CAPTURE) === 1, 4000, 'fixture giao phản hồi capture cũ');
      c.precondition(gate.settled && s.fx.responded(CAPTURE) === 1, 'Phản hồi capture cũ đã thực sự được giao (assert bên dưới không đạt giả)');
      await settle(s);

      c.ok((await successToasts(s)).length === 0, `${label}: phản hồi cũ KHÔNG hiện toast "Nạp tiền thành công"`);
      c.ok(!/đã vào ví/.test(await s.viewText()), `${label}: màn hình không hiện kết quả nạp thành công của phiên cũ`);
      c.ok(s.fx.count(STATUS) === getsAfterLogin && getsAfterLogin === getsBefore,
        `${label}: không GET /api/payments/<ID> thay cho phiên mới (trước=${getsBefore}, sau đăng nhập=${getsAfterLogin}, cuối=${s.fx.count(STATUS)})`);
      c.ok(s.fx.count(CAPTURE) === 1, `${label}: vẫn đúng 1 POST capture`);
      if (who.id === h.BUYER.id) {
        const it = await s.intent(h.BUYER);
        c.ok(!!it && it.requestId === h.KEY, `${label}: ý định lưu của phiên mới (cùng tài khoản) không bị xoá`);
      } else {
        const itNew = await s.intent(who);
        const itOld = await s.intent(h.BUYER);
        c.ok(itNew === null && !!itOld && itOld.requestId === h.KEY, `${label}: tài khoản mới không có ý định; ý định tài khoản cũ được giữ`);
      }
      c.ok(await s.has('[data-act="logout"]'), `${label}: phiên mới vẫn đăng nhập`);
      c.ok(s.leaked().length === 0, 'Không request ngoài lọt ra');
    };

    t.section('B3 — phản hồi capture muộn của phiên cũ');
    await t.case('B3.1 capture treo, logout rồi login lại CÙNG tài khoản', (c) => b3(c, h.BUYER, 'Cùng tài khoản'));
    await t.case('B3.2 capture treo, logout rồi login tài khoản KHÁC', (c) => b3(c, h.OTHER, 'Tài khoản khác'));

    // ---------------------------------------------------------------- B4
    /** Fixture 401 cho token cũ; refresh trả token mới. refresh: 'ok' | {status}. */
    const b4 = async (c, { reject, refresh }) => {
      const srv = h.paypalServer();
      const OLD = 'Bearer tok-' + h.BUYER.id;
      const NEW = 'Bearer tok-refreshed';
      const unauth = () => h.json(401, { error: 'UNAUTHENTICATED', message: 'Phiên hết hạn' });
      const base = srv.routes();
      const routes = {
        [STATUS]: (rq) => {
          if (reject === 'status' && rq.headers.authorization === OLD) return unauth();
          return base[STATUS](rq);
        },
        [CAPTURE]: (rq) => {
          if (reject === 'capture' && rq.headers.authorization === OLD) return unauth();
          srv.captures++;
          srv.row = h.ppRow({ requestId: h.KEY, status: 'SUCCEEDED', stage: 'SUCCEEDED', resolvedAt: new Date().toISOString() });
          return h.json(200, { ...srv.row, outcome: 'APPLIED' });
        },
        [REFRESH]: () => (refresh === 'ok'
          ? h.json(200, { token: 'tok-refreshed', user: h.BUYER })
          : h.json(refresh.status, { error: refresh.status === 401 ? 'UNAUTHENTICATED' : 'SERVER_ERROR', message: 'Không làm mới được' })),
      };
      const s = await h.openSession(browser, { routes, search: SEARCH, storage: { [h.INTENT_PREFIX + h.BUYER.id]: h.intentJson() } });
      c.cleanup(() => s.close());
      await s.open();
      return { s, srv, OLD, NEW };
    };

    t.section('B4 — access token bị từ chối trong luồng return');
    await t.case('B4.1 GET trạng thái khi return bị 401 -> refresh -> retry GET đúng phiên, capture sau đó đúng 1 lần', async (c) => {
      const { s, srv, OLD, NEW } = await b4(c, { reject: 'status', refresh: 'ok' });
      await s.page.waitForSelector('[data-act="paypal-capture"]', { timeout: 5000 });
      const gets = reqs(s, STATUS);
      c.precondition(gets.length >= 2 && bearer(gets[0]) === OLD && s.fx.count(REFRESH) === 1, `GET đầu bị từ chối bằng token cũ, đúng 1 refresh (GET=${gets.length}, refresh=${s.fx.count(REFRESH)})`);
      c.ok(gets.slice(1).every((g) => bearer(g) === NEW) && gets.filter((g) => bearer(g) === OLD).length === 1, 'GET retry dùng token mới; token cũ chỉ bị dùng 1 lần');
      c.ok(s.fx.count(CAPTURE) === 0, 'Chưa capture khi người dùng chưa bấm xác nhận');
      await s.click('[data-act="paypal-capture"]');
      const getsBeforeCapture = s.fx.count(STATUS);
      await s.until(() => s.fx.responded(CAPTURE) === 1, 4000, 'capture trả lời');
      await s.until(() => s.fx.count(STATUS) > getsBeforeCapture, 4000, 'GET trạng thái sau capture');
      await s.page.waitForFunction(() => /Nạp tiền thành công/.test(document.querySelector('#toasts') ? document.querySelector('#toasts').textContent : ''), null, { timeout: 5000 });
      await settle(s);
      c.ok(s.fx.count(CAPTURE) === 1 && srv.captures === 1 && bearer(reqs(s, CAPTURE)[0]) === NEW, 'Đúng 1 POST capture, bằng token mới');
      c.ok(s.fx.count(REFRESH) === 1, 'Chỉ 1 lần refresh');
      const idxCap = s.fx.requests.indexOf(reqs(s, CAPTURE)[0]);
      const getAfter = s.fx.requests.filter((r, i) => i > idxCap && r.key === STATUS);
      c.ok(getAfter.length >= 1 && getAfter.every((g) => bearer(g) === NEW), `Có GET trạng thái SAU capture bằng token mới (số=${getAfter.length}), không tin POST 200 thay GET`);
      c.ok((await successToasts(s)).length === 1, 'Thành công hiện đúng 1 toast sau GET SUCCEEDED');
      c.ok(await s.has('[data-act="logout"]'), 'Vẫn đăng nhập');
      c.ok(s.leaked().length === 0, 'Không request ngoài lọt ra');
    });

    await t.case('B4.2 capture bị 401 -> refresh -> retry capture đúng 1 lần hợp lệ, kết quả đúng sau GET SUCCEEDED', async (c) => {
      const { s, srv, OLD, NEW } = await b4(c, { reject: 'capture', refresh: 'ok' });
      await s.page.waitForSelector('[data-act="paypal-capture"]', { timeout: 5000 });
      c.precondition(s.fx.count(CAPTURE) === 0 && s.fx.count(REFRESH) === 0, 'Dựng đúng: chưa capture, chưa refresh trước khi bấm');
      const getsBeforeClick = s.fx.count(STATUS);
      await s.click('[data-act="paypal-capture"]');
      await s.until(() => s.fx.responded(CAPTURE) >= 2, 4000, 'capture bị từ chối rồi retry');
      await s.until(() => s.fx.count(STATUS) > getsBeforeClick, 4000, 'GET trạng thái MỚI sau capture');
      await s.page.waitForFunction(() => /Nạp tiền thành công/.test(document.querySelector('#toasts') ? document.querySelector('#toasts').textContent : ''), null, { timeout: 5000 });
      await settle(s);
      const caps = reqs(s, CAPTURE);
      c.ok(caps.length === 2 && bearer(caps[0]) === OLD && bearer(caps[1]) === NEW, `Capture: lần 1 bị từ chối (token cũ), lần 2 retry bằng token mới, không hơn (số=${caps.length})`);
      c.ok(srv.captures === 1, 'Máy chủ chỉ thực thi 1 capture (lần bị 401 không được tính)');
      c.ok(s.fx.count(REFRESH) === 1, 'Đúng 1 refresh');
      const idxOk = s.fx.requests.indexOf(caps[1]);
      const getAfter = s.fx.requests.filter((r, i) => i > idxOk && r.key === STATUS);
      c.ok(getAfter.length >= 1 && getAfter.length === s.fx.count(STATUS) - getsBeforeClick && getAfter.every((g) => bearer(g) === NEW),
        `Có GET trạng thái MỚI nằm SAU POST capture thành công, bằng token mới (số=${getAfter.length}; GET trước khi bấm=${getsBeforeClick})`);
      c.ok((await successToasts(s)).length === 1, 'Thành công hiện đúng 1 toast, sau GET SUCCEEDED');
      c.ok(await s.has('[data-act="logout"]'), 'Vẫn đăng nhập');
      c.ok(s.leaked().length === 0, 'Không request ngoài lọt ra');
    });

    for (const status of [401, 500]) {
      await t.case(`B4.${status === 401 ? 3 : 4} capture bị 401, refresh trả ${status} -> không retry, không thành công giả, yêu cầu đăng nhập lại`, async (c) => {
        const { s, srv } = await b4(c, { reject: 'capture', refresh: { status } });
        await s.page.waitForSelector('[data-act="paypal-capture"]', { timeout: 5000 });
        await s.click('[data-act="paypal-capture"]');
        await s.until(() => s.fx.count(REFRESH) >= 1 && s.fx.responded(REFRESH) >= 1, 4000, 'refresh trả lỗi');
        c.precondition(s.fx.count(CAPTURE) === 1 && s.fx.responded(CAPTURE) === 1, 'Dựng đúng: capture đầu bị 401 đúng 1 lần');
        await s.page.waitForSelector('[data-act="open-auth"]', { timeout: 5000 });
        await settle(s);
        c.ok(s.fx.count(CAPTURE) === 1 && srv.captures === 0, `Không retry capture, máy chủ không thực thi capture nào (capture=${s.fx.count(CAPTURE)})`);
        c.ok(s.fx.count(REFRESH) === 1, 'Không lặp refresh');
        c.ok((await successToasts(s)).length === 0 && !/đã vào ví/.test(await s.viewText()), 'Không báo thành công giả');
        const toasts = (await s.toasts()).map((x) => x.text).join(' | ');
        c.ok(await s.has('[data-act="open-auth"]'), 'Nút đăng nhập (open-auth) hiện');
        c.ok(/Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại/.test(toasts), `Toast yêu cầu đăng nhập lại có thật (app.js api(): UNAUTHENTICATED sau refresh thất bại). Toast hiện: ${toasts || 'không'}`);
        c.ok(!(await s.has('[data-act="logout"]')), 'Giao diện về trạng thái khách');
        c.ok(s.leaked().length === 0, 'Không request ngoài lọt ra');
      });
    }

    await t.case('B4.5 GET khi return bị 401, refresh 401 -> không có nút capture, không capture', async (c) => {
      const { s, srv } = await b4(c, { reject: 'status', refresh: { status: 401 } });
      await s.page.waitForSelector('[data-act="open-auth"]', { timeout: 5000 });
      c.precondition(s.fx.count(REFRESH) === 1 && s.fx.count(STATUS) >= 1, 'Dựng đúng: GET bị 401, refresh được gọi đúng 1 lần');
      await settle(s);
      c.ok(!(await s.has('[data-act="paypal-capture"]')) && s.fx.count(CAPTURE) === 0 && srv.captures === 0, 'Không có nút xác nhận và không có capture nào');
      c.ok((await successToasts(s)).length === 0, 'Không báo thành công giả');
      c.ok(s.leaked().length === 0, 'Không request ngoài lọt ra');
    });
  },
};
