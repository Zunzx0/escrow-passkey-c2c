# Báo cáo B3–B4 (phiên đăng nhập, trình duyệt thật, API FIXTURE)

Tệp: `cho-an-tam/test/browser/paypal/session.browser.js` (id `B3B4`). Không sửa harness, runner, public/, src/.

## Lệnh tái lập
```
$env:NODE_PATH='C:\Users\tranq\tools\pw-runner\node_modules'; Set-Location '...\paypal-browser-acceptance\cho-an-tam'; node test/browser/paypal-wallet-browser.js --only=B3B4
```

## Kết quả thật (Chrome 154.0.8037.98, playwright-core 1.63.0)
Lần chạy lại sau khi vá F2/F3: `Kết quả trình duyệt (fixture, 18.1s): PASS 61 · FAIL 0 · SKIP 0`, exit code 0 sau khi siết B4.2 (lần đầu: PASS 57; sau F2/F3: PASS 60). Request ngoài lọt ra: 0 (mỗi ca assert `s.leaked().length === 0`).

## Ca và assert
- B3.1 (cùng tài khoản) và B3.2 (h.OTHER): capture trả `h.deferred().promise`. Điều kiện dựng: POST capture tới fixture đúng 1 lần (fx.count và máy chủ), deferred chưa giải quyết, fixture chưa trả lời. Sau `s.logout()` + `s.login()`: 1 logout, 1 login, nút logout hiện, response cũ vẫn chưa giao; rồi release, chờ `fx.responded(CAPTURE)===1` (giao thật). Assert: không toast "Nạp tiền thành công", không chữ "đã vào ví", số GET `/api/payments/<ID>` không tăng (1/1/1), vẫn 1 POST capture, ý định phiên mới (cùng tài khoản) còn; với tài khoản khác: tài khoản mới không có ý định, ý định tài khoản cũ còn; vẫn đăng nhập. Release deferred trong cleanup kể cả khi lỗi.
- B4.1: GET trạng thái khi return bị 401 với token cũ -> đúng 1 refresh -> GET retry bằng token mới -> bấm xác nhận -> đúng 1 POST capture bằng token mới; hiện thành công sau GET SUCCEEDED.
- B4.2: capture 401 (token cũ) -> 1 refresh -> retry capture bằng token mới; tổng 2 request (1 bị từ chối + 1 retry), máy chủ chỉ thực thi 1; thành công hiện đúng 1 toast.
- B4.3 / B4.4: capture 401, refresh trả 401 / 500: capture không bị lặp (1 request, máy chủ thực thi 0), refresh không lặp, không thành công giả, toast "Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại", nút đăng nhập hiện, giao diện về khách.
- B4.5: GET lúc return 401 + refresh 401: không có nút capture, không capture, không thành công giả.

## Lỗi sản phẩm nghi ngờ
Không phát hiện. Không sửa app.js.

## Sửa theo QA
- F2 (B4.1): bỏ `.catch` nuốt timeout; sau capture phải có GET trạng thái MỚI (so số GET trước/sau) bằng token mới nằm sau POST capture trong thứ tự request, và đúng 1 toast "Nạp tiền thành công". Mutation "POST 200 coi là thành công, không GET" (QA M4) trước đó bắt B2.5/B2.6/B2.7/B4.2 nhưng bỏ sót B4.1; nay B4.1 cũng đỏ trước mutation đó.
- B4.2 (vòng 2): ghi số GET trước khi bấm; sau retry capture bắt buộc có GET STATUS mới nằm SAU POST capture thành công (theo thứ tự fx.requests), bằng token mới, rồi mới tính thành công. Lần chạy lại: xem dòng kết quả ở trên.
- F3 (B4.3/B4.4): tách assert nút `open-auth` hiện khỏi assert thông điệp. Theo app.js `api()`: khi refresh thất bại thì clearSession, renderChrome, route và ném lỗi "Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại" (hiện thành toast); test assert đúng chuỗi này.

## Mutation và độ mạnh của B3
- Mutation epoch do Pro chạy trên bản sao app.js: bỏ cả hai lớp sessionEpoch (api() và ctxAlive) -> B3B4: 54 đạt / 3 FAIL, đều ở B3.1 (cùng tài khoản): (1) phản hồi cũ KHÔNG hiện toast thành công, (2) không GET /api/payments/<ID> thay cho phiên mới (trước=1, sau đăng nhập=1, cuối=2), (3) ý định phiên mới không bị xoá. B3.2 (tài khoản khác) vẫn xanh vì lớp kiểm userId còn.
- B3 là QUAN SÁT CÓ HẠN: sau khi phản hồi cũ được giao, test chờ settle 5 lần x 40 ms (~200 ms) rồi assert phủ định, nên không phải bằng chứng tuyệt đối rằng sẽ không bao giờ có tác dụng muộn. Bằng chứng chính là precondition (phản hồi đã giao thật) cộng mutation bắt được lỗi.

## Giới hạn
- Chưa làm: refresh trả user khác userId, refresh song song, nhánh checkout lỗi.
- Là fixture: không chứng minh Sandbox, cookie Secure/HttpOnly/SameSite qua backend HTTPS thật, hay Windows Hello/passkey thật (refresh chỉ là route fixture).
- Không tiến trình nào của tôi còn lại (runner đóng browser, nhả khoá, exit 0).
