# Pro: kiểm chứng độc lập bản tích hợp Enclave trước nghiệm thu Sandbox thật

Ngày 07/10/2026. Đây không phải thanh toán thật và không tuyên bố toàn hệ thống hoàn tất. Fixture/jsdom/Chrome fixture không chứng minh Sandbox, cookie backend HTTPS hay Windows Hello thật.

- Repository: https://github.com/Zunzx0/escrow-passkey-c2c.git
- Nền: `5080e3a239b9935e22a35cc2c66e6e396f8cceda` (`codex/payment-provider-isolation`, trùng đầu nhánh lúc fetch). Nhánh Pro: `claude/paypal-release-review`. PR/compare vào `codex/payment-provider-isolation`, chưa vào `migrate-postgres`.
- Cách làm: Pro (cấp 2) dựng môi trường chung và hàng đợi tài nguyên; ba agent cấp 3 (QA backend, review runner, BA/an toàn); agent BA review chéo hai báo cáo còn lại; Pro tự kiểm độc lập hai đường lỗi trọng yếu và chạy lượt Chrome của riêng mình. Không tạo cấp 4.
- Sản phẩm (`public/`, `src/`, migration, `package.json`, lockfile, `run-suite.js`) KHÔNG bị sửa. `git diff` của chúng so với nền: rỗng.

## 1. Kết luận ngắn

1. Không tìm thấy lỗi chặn phát hành ở mức code/bằng chứng tự động. Không thấy đường nào ghi tiền vào ví khi chưa có chứng cứ capture COMPLETED đã xác minh với PayPal (đọc code; chưa kiểm chứng bằng Sandbox thật).
2. Backend trên cả SQLite và PostgreSQL riêng xanh ở hash này (mục 3). Lượt Chrome fixture tự chạy của Pro xanh; lượt tự chạy của agent review từng đỏ do lỗi dọn dẹp runner (mục 4), phụ thuộc tải máy.
3. Có việc cần Codex trước hoặc song song với nghiệm thu thật: bản vá mock admission (đã biết) kèm hash mới, vá một dòng helper test `paypal-m2-fake.js:98`, nâng hạn dọn dẹp của runner Chrome, và quyết định chính sách cho yêu cầu PENDING bỏ dở (F-03) vì nó ảnh hưởng ngay việc nghiệm thu lặp.
4. Đề xuất: ĐỦ điều kiện chuyển sang nghiệm thu thật CÓ ĐIỀU KIỆN (mục 7). Phần nghiệm thu thật do Codex và người dùng thực hiện; checklist của Pro chỉ hỗ trợ.

## 2. Môi trường chung và tài nguyên

- Windows 11, Node v26.4.0, Chrome 154.0.8037.98 (cài sẵn), `playwright-core` 1.63.0 ngoài repo (`C:\Users\tranq\tools\pw-runner`), `npm ci` đúng lockfile trong worktree.
- PostgreSQL riêng của Pro: 17.11 (xác nhận bằng `psql` `show server_version`), `127.0.0.1:55432`, auth trust chỉ localhost, data `C:\Users\tranq\tools\pg-pro-release\data`. Các DB test: `enclave_pro_release_test`, `..._store_test`, `..._migration_test`, `..._evidence_test`, `..._prov_test`. PostgreSQL hệ thống ở cổng 5432 là của người dùng, không đụng.
- Hàng đợi: một khoá `C:\Users\tranq\tools\pro-release-heavy.lock`; mỗi lúc chỉ một lượt server/DB/suite/Chrome.
- Không bật PayPal, không dùng secret, không gọi mạng ngoài, không tạo tài nguyên trả phí.

## 3. Backend và tài chính (agent `pro_release_backend_qa`; chi tiết `PRO-RELEASE-BACKEND-QA.md`)

Các số tách theo loại, KHÔNG cộng lẫn:

| Lượt | Kết quả | Ghi chú |
| --- | --- | --- |
| `run-suite.js` SQLite (hash 5080e3a, DB mới) | exit 0, 26 mục, runner báo 1006 PASS / 0 FAIL | Runner cộng cứng 9 PASS cho `check-invariants`; số assertion thật 997 |
| `run-suite.js` PostgreSQL (`enclave_pro_release_test`) | exit 0, 26 mục, runner báo 997 PASS / 0 FAIL | Số assertion thật 988. Chênh 9 so với SQLite truy đến assertion: `manual-transaction-amount` ít 3 (SQLite lưu kiểu integer), `topup-idempotency` ít 6 (khối nâng cấp CSDL cũ, log PG ghi "bỏ qua") |
| `test:count-marks` | 14 PASS | agent tính lại từ log từng bộ bằng `countMarks`, khớp summary runner ở 4 lượt |
| 9 bất biến tài chính | đúng trên cả hai nền (bước cuối runner và chạy lại độc lập sau các bộ PayPal) | định nghĩa không đổi |
| hardening riêng, `RATE_LIMIT_AUTH_PER_MINUTE=10` | 27/27 PASS cả hai nền | full suite chạy với giá trị 1000 nên bỏ 4 ca rate limit; số riêng, không cộng vào tổng |
| PayPal (SQLite): store-concurrency, binding-migration, evidence-upgrade, m2-settlement, m2-api, module tests | exit 0 | store-concurrency 106 phép kiểm là 4 chế độ nằm ở hai log |
| PayPal (PostgreSQL): store-concurrency, binding-migration (9), evidence-upgrade (12 = 6 SQLite + 6 PG), m2-settlement, m2-api | exit 0 | trên DB `*_store_test`, `*_migration_test`, `*_evidence_test` |
| `paypal-m2-recovery-e2e` | KHÔNG ổn định trong thư mục `Downloads` (xem F2) | không thuộc `test:suite`, thuộc `test:paypal-m2` |

Lượt thử đầu bị đỏ do `.env.test` thiếu `BASE_URL` (log lượt đó được giữ, lỗi cấu hình, không phải sản phẩm). Đã sửa cấu hình và chạy lại, không bỏ lượt đỏ.

### F2 — `paypal-m2-recovery-e2e` đỏ ngắt quãng (Pro kiểm độc lập)

Log thí nghiệm: `cho-an-tam/test/evidence/pro-release/backend/f2-pro-independent/` (README có bảng). Cùng mã, mỗi lượt DB mới:

| Vị trí chạy | Helper | Kết quả |
| --- | --- | --- |
| worktree trong `Downloads` | gốc | 5 lượt, 5 đỏ |
| `Downloads` (ASCII) | gốc | 4 lượt, 4 đỏ |
| `AppData\Local\Temp` (ASCII 6 lượt; đường dẫn có "đồ án" 4 lượt) | gốc | 10/10 xanh (47/47) |
| `Downloads` (ASCII) | vá một dòng | 5/5 xanh |
| `AppData\Local\Temp` | vá một dòng | 6/6 xanh |

Bản vá một dòng: `test/helpers/paypal-m2-fake.js:98`, đổi `fs.rmdirSync(lockPath)` thành `retrySharing(()=>fs.rmdirSync(lockPath))`, đồng bộ với dòng 107/108/118 trong cùng hàm (dòng 98 là chỗ duy nhất của nhánh dọn khoá rỗng không chịu `EPERM/EACCES/EBUSY` tạm thời). Kết luận ở mức bằng chứng: nguyên nhân gần là lỗi chia sẻ tệp tạm thời ở dòng 98, lộ ra khi thư mục ở vị trí bị quét hoặc lập chỉ mục (Defender thời gian thực đang bật; chưa chứng minh Defender là tác nhân). Không có chứng cứ lỗi logic phục hồi của sản phẩm, nhưng các lượt đỏ dừng sớm ở R3/R4 nên không phủ phần assertion phía sau. n nhỏ, một máy, chưa chạy trên Linux. Helper trong worktree KHÔNG bị Pro sửa; đề xuất Codex áp dụng.

## 4. Runner Chrome (agent `pro_release_runner_review`; chi tiết `PRO-RELEASE-RUNNER-REVIEW.md`)

| Mục | Kết quả |
| --- | --- |
| Diff 5080e3a: khoá có chủ duy nhất, waiter, chủ cũ không xoá khoá người khác, khoá stale không tự xoá, có đường dọn khi tín hiệu/lỗi setup | đọc code: đạt; nhận xét nhỏ không chặn |
| `node --test test/browser/runner-safety-unit.js` | exit 0, 8 test, 8 pass, 0 fail/skip (dòng "❌ ... controlled cleanup failure" là marker cố ý trong stdout con) |
| CLI nhóm không hợp lệ / thiếu file nhóm | exit 2, không tạo khoá (luận cứ chính là thứ tự code: `selectSpecs` ném trước `findChrome` và trước khi tạo khoá; đếm tiến trình Chrome chỉ là bằng chứng mềm) |
| Lượt Chrome đầy đủ tự chạy của agent | PASS 458 · FAIL 1 · SKIP 0 · 54 ca, exit 1, 186,4 s. FAIL duy nhất là "Cleanup failed: browser cleanup timed out", 0 assertion hành vi đỏ |
| Lượt Chrome đầy đủ tự chạy của Pro (hàng đợi, khoá riêng nhả) | PASS 458 · FAIL 0 · SKIP 0 · 54 ca, exit 0, 142,0 s; không còn khoá sau chạy (log: `lead-chrome-full-run.log`) |
| Lịch sử Codex (lời kể từ tài liệu giao việc, chưa kiểm): 8/8 unit, 458/458, 54 ca, 0 skip, 73 s | ghi riêng, không trộn với số tự chạy |

### R-1 (chặn vận hành cho runner, không chặn sản phẩm): khoá bị giữ khi dọn dẹp lỗi

Đã xác nhận bằng đọc code `paypal-wallet-browser.js` (dòng 122: `withDeadline(browser.close(), 5000, 'browser cleanup')`; lỗi cleanup làm `errors` khác rỗng nên `lock.release()` không được gọi) và bằng thực tế: khoá `%TEMP%\enclave-paypal-browser.lock` còn lại sau lượt của agent (chủ pid 19068 đã chết); Pro đã xác minh chủ đã chết, đã gỡ. Ba mẫu đo `browser.close()` của agent: 17,2 s; 5,3 s; 2,9 s (2/3 vượt 5 s) trong lúc CPU máy 100%, RAM trống ~1–1,8 GB. Hai lượt của Pro và Codex ở cùng mã xanh. Nên "phụ thuộc tải máy" là suy luận hợp lý, chưa chứng minh. Đề xuất cho Codex: nâng hạn đóng trình duyệt (30–60 s) và/hoặc kiểm Chrome con đã thoát trước khi giữ khoá, thông báo rõ đường dẫn khoá và pid. Lượt xanh có giá trị khi chạy trên máy ít tải.

Chưa kiểm chứng: SIGINT/SIGTERM/kill thật (không ai chạy; trên Windows kill từ tiến trình khác là cưỡng bức, không kích hoạt handler). M1/M7 của báo cáo cũ: cả hai bị bắt, không có khoảng trống ảnh hưởng nghiệm thu.

## 5. Review an toàn và finding (agent `pro_release_acceptance_ba`; chi tiết `PRO-RELEASE-SAFETY-REVIEW.md`)

Phương pháp: đọc code, chưa chạy (BA) kèm Pro tự xác nhận F-03 và F-05 bằng đọc độc lập các điểm code.

| Mức | Finding |
| --- | --- |
| CHẶN phát hành (code) | Không có |
| Đã biết (Codex đang vá, chưa trong hash) | F-01: `payments.js:78` chỉ kiểm `PAYPAL_SANDBOX_ENABLED`, không kiểm `MOCK_PROVIDER_CHECKOUT`: tạo được top-up mock khi mock tắt |
| Cần xử lý sau | F-02 mock webhook/đối soát mock vẫn chạy khi cờ PayPal bật (cần HMAC, chỉ tác động hàng MOCK có sẵn); **F-03**; F-04; **F-05**; F-06 |
| Thông tin | F-07 … F-13 (webhook trả 200 cả khi chưa tất toán; token trong URL return trước khi dọn; phụ thuộc `TRUST_PROXY`; `PAYPAL_FRONTEND_ORIGIN` mặc định; lease; xác minh webhook chưa kiểm với event ký thật; callback sau đăng xuất) |

Pro đã tự xác nhận (đọc độc lập, chưa chạy):
- **F-03** (ảnh hưởng nghiệm thu lặp): `closeUncaptured` chỉ định nghĩa và export ở `paypalPaymentStore.js:538,569`, không có lời gọi nào trong `src/`; `topupPolicy.js:34,41` đếm PENDING trong cửa sổ gần nhất và chặn khi đủ 5; không có API huỷ. Một tài khoản Sandbox thử lại nhiều lần trong ngày tự khoá chính mình. Checklist đã giới hạn 4 yêu cầu/tài khoản/ngày.
- **F-05**: `PayPalSandboxError` chỉ có `statusCode`, không có `status` (`paypalSandboxProvider.js:13`); `server.js:148` dùng `err.status || 500`; `payments.js:142` gọi `Promise.all(rows.map(serializePaymentRequest))` không `catch` theo dòng; `paypalRuntime.js:67–71` gọi `adapter.getOrder` khi dòng có gợi ý payer-action. Một dòng PayPal có `getOrder` lỗi làm 500 cả danh sách `/api/payments/me`. Fail-safe (không báo thành công giả) nhưng mất lịch sử.

"Đã đọc, không thấy": ghi ví không có chứng cứ (mọi đường đi qua `settle`, chỉ nhận capture COMPLETED đã `verifyOrder`); mock chạm hàng PayPal và ngược lại (ngoài F-01/F-02); idempotency và race capture–webhook–reconcile; lộ secret/token qua log/response/UI; host Live hay host tuỳ ý. Phạm vi đọc từng mục nằm trong tệp review. Chưa đọc `schema*.sql`/trigger, CSP, `walletOps.js`.

## 6. Checklist nghiệm thu Sandbox thật

`CHECKLIST-NGHIEM-THU-PAYPAL-SANDBOX-PRO.md`: 16 mục PP-00 … PP-15, tất cả mặc định CHƯA CHẠY, mỗi mục có dữ liệu đầu vào, bước, quan sát, tiêu chí đạt, điều kiện dừng, bằng chứng cần lưu (che mã), test tự động hiện có và phần tự động KHÔNG đủ. PP-11 (cookie/HTTPS) và PP-12 (Passkey/Windows Hello thật) là phần người dùng phải thao tác; fixture và software authenticator không tính là bằng chứng. PP-13 (tranh chấp) mô tả hoàn tiền/giải ngân trong ví hệ thống, không phải PayPal refund/payout. PP-14 kiểm F-04 (phê duyệt rồi đóng tab). PP-15 dùng SQL chỉ-đọc để kiểm 3 bất biến PayPal vì `check-invariants` chỉ chạy 9.

## 7. Điều kiện chuyển sang nghiệm thu thật

Đề xuất: đủ để bắt đầu nghiệm thu Sandbox thật khi hoàn tất các điều kiện sau (việc của Codex, Pro không nhận):
1. Đưa bản vá mock admission vào hash nghiệm thu mới; Pro (hoặc Codex) chạy lại kiểm tra bị ảnh hưởng (`payment-provider-isolation`, `paypal-integration`) và lượt kết hợp cần thiết, không đổi nền giữa lượt.
2. Cấu hình nghiệm thu: Sandbox bật, Live không dùng, mock tắt, DB không có hàng MOCK PENDING (PP-00, PP-01), mỗi tài khoản không quá 4 yêu cầu mới/ngày cho tới khi quyết định F-03.
3. Việc nên làm (không chặn nghiệm thu): vá helper `paypal-m2-fake.js:98`; nâng hạn dọn dẹp runner và đường dẫn khoá thân thiện; ghi `BASE_URL` vào README/`.env.example`; F-03, F-04, F-05, F-06 theo thứ tự ưu tiên của Codex.
4. Chưa có bằng chứng (chỉ có từ nghiệm thu thật): Sandbox (redirect/return thật, order Personal→Business), webhook ký thật (F-12), cookie Secure/HttpOnly/SameSite và refresh qua HTTPS thật, Windows Hello/passkey thật, F-04.

## 8. Chưa chạy / giới hạn

- Chưa chạy trên Linux hoặc máy khác (F2, runner). Không đo PayPal Sandbox thật, cookie HTTPS, Windows Hello.
- Các số assertion thuộc loại khác nhau (suite SQLite, suite PG, hardening, module test, Chrome fixture) KHÔNG cộng thành một con số tiến độ.
- Hai báo cáo cũ ("22/24 bộ", "74 PASS") và các lỗi nhỏ trong báo cáo con đã được BA nêu và tác giả sửa ở các báo cáo con tương ứng.

## 9. Tài nguyên đã dọn

Khoá hàng đợi và khoá Chrome không còn; không còn server ở cổng test; không còn process Chrome/node của runner. Thư mục thăm dò F2 trong `Downloads` đã xoá (gỡ junction trước, `node_modules` thật còn nguyên). Cluster PostgreSQL riêng ở `127.0.0.1:55432` được tắt khi bàn giao; data giữ ở đường dẫn trên, khởi động lại bằng `pg_ctl -D <data> -o "-p 55432 -c listen_addresses=127.0.0.1" start`. `.env.test`, `reports/`, `data/test/*` còn trong worktree nhưng đã gitignore, không commit.

## 10. Tệp bàn giao

`PRO-PAYPAL-RELEASE-REVIEW.md` (tệp này), `PRO-RELEASE-BACKEND-QA.md`, `PRO-RELEASE-RUNNER-REVIEW.md`, `PRO-RELEASE-SAFETY-REVIEW.md`, `CHECKLIST-NGHIEM-THU-PAYPAL-SANDBOX-PRO.md`, và log đã lọc bí mật trong `cho-an-tam/test/evidence/pro-release/backend/` (kèm `lead-chrome-full-run.log` và thư mục `f2-pro-independent/`). Quét bí mật (postgres URL có mật khẩu, JWT, Bearer, client_secret, JWT_SECRET, PAYMENT_WEBHOOK_SECRET, PGPASSWORD) trên thư mục evidence: 0 khớp; chỉ có đường dẫn cục bộ chứa tên người dùng Windows.

## 11. Đính chính danh sách tệp (cập nhật sau phản hồi của Codex)

Commit `7a8d5a4` (bàn giao đầu tiên) chứa 79 tệp: 5 báo cáo `.md` ở gốc và 74 tệp trong `cho-an-tam/test/evidence/pro-release/` (6 `.md`, 55 `.err`, 9 `.txt`, 4 `.json`). Nó KHÔNG chứa 123 tệp `.log` (stdout của các lượt chạy) vì `cho-an-tam/.gitignore` có quy tắc `*.log`; mô tả "log đã lọc bí mật" ở mục 10 và các báo cáo con vì vậy đã sai về danh sách tệp thực tế trong commit đó. Các tệp này được bổ sung bằng một commit riêng kế tiếp trên nhánh này, dùng `git add -f` (không sửa `.gitignore`), sau khi quét lại bí mật (postgres URL có mật khẩu, JWT, Bearer, client_secret, JWT_SECRET, PAYMENT_WEBHOOK_SECRET, PGPASSWORD, khoá riêng): 0 khớp trên 123 tệp, 449 KB. Không chạy lại bất kỳ lượt kiểm chứng nào để bổ sung; nội dung log giữ nguyên như lúc chạy. Việc gộp nhánh báo cáo này vẫn là quyết định riêng, chưa thực hiện.
