# PRO-RELEASE-RUNNER-REVIEW

Người rà soát: agent cấp 3 pro_release_runner_review. Ngày 2026-10-07. Worktree claude/paypal-release-review, HEAD 5080e3a239b9935e22a35cc2c66e6e396f8cceda. Không sửa runner/harness/spec/public/src, không commit.

## Phạm vi
Diff 5080e3a so với 4ac0938/eb148c0 (paypal-wallet-browser.js, paypal/harness.js, runner-safety-unit.js, BROWSER-RUNNER-SAFETY-FIX-REPORT.md), unit, CLI, một lượt Chrome đầy đủ, dọn tài nguyên, giới hạn M1/M7. Ca lỗi dựng trên BẢN SAO (scratchpad runner-review\copy), không đụng worktree chung.

## 1. Đọc diff: ba bản vá
- Khoá có chủ duy nhất: đúng. Mỗi runner có file owner-<32 hex>.json riêng (flag wx, tên bất biến). release() chỉ unlink file của chính mình rồi rmdir; chưa sở hữu thì trả false (unit 1, 3 chứng minh). Waiter không bao giờ ghi vào thư mục khoá vì mkdir EEXIST. Chủ cũ không xoá được khoá chủ mới vì tên file khác.
- Waiter chờ: poll 25 ms tới 15 phút, huỷ được bằng AbortSignal.
- Khoá stale: KHÔNG tự xoá. Chủ không còn sống, thư mục rỗng >1 s, hoặc nội dung lạ đều ném lỗi "verify manually". An toàn, nhưng kéo theo hệ quả vận hành (xem finding F1).
- Ngắt/lỗi: SIGINT/SIGTERM đặt interrupted, abort chờ khoá, cleanup() memo hoá đóng session fixture + browser, rồi mới nhả khoá; cleanup lỗi thì GIỮ khoá và tính FAIL (cố ý). Lỗi setup trong openSession đóng context + fixture. Case cleanup có hạn 5 s. Exit 130 khi bị ngắt.
- Nhận xét nhỏ (sau, không chặn): (a) kiểm phủ chỉ yêu cầu tổng totals.cases > 0, không yêu cầu mỗi spec chạy >= 1 ca nên một spec rỗng vẫn có thể pass khi chạy đủ nhóm; (b) trong cleanup, closeAllSessions và browser.close chạy song song nên ctx.close có thể báo lỗi giả khi ngắt giữa chừng (chưa tái hiện); (c) tín hiệu thứ hai không ép thoát, chỉ dựa vào hạn 5 s.

## 2. Unit
Lệnh: `node --test test/browser/runner-safety-unit.js` (cwd cho-an-tam). Exit 0. tests 8, pass 8, fail 0, cancelled 0, skipped 0.
Marker thất bại cố ý: dòng `❌ Dọn tài nguyên: controlled cleanup failure` nằm trong stdout con của test "cleanup failure counts FAIL…" (test này chủ động tiêm lỗi); test ấy ✔. Thất bại thật của node:test = 0.

## 3. CLI (bản sao, TEMP không đổi, không Chrome)
| Lệnh | Thông báo | Exit |
| --- | --- | --- |
| `--only=XYZ` | Unknown or empty --only group | 2 |
| `--only=` | Unknown or empty --only group | 2 |
| `--only=B5,` | Unknown or empty --only group | 2 |
| `--bogus` | Invalid runner arguments | 2 |
| không tham số, bản sao thiếu session.browser.js | Required browser spec is missing | 2 |
| `--only=B3B4`, cùng bản sao | Required browser spec is missing | 2 |
Luận cứ không mở Chrome: thứ tự code. Trong main(), selectSpecs() ném (và main trả 2) trước findChrome(), trước require playwright, trước createLock/acquire, nên không có đường tới chromium.launch. Bằng chứng mềm (không dùng làm luận cứ): sau các lệnh không có khoá %TEMP% mới; đếm chrome.exe trước/sau cùng 11 nhưng đó là đếm tổng gồm Chrome của người dùng, không định danh được process con.

## 4. Lượt Chrome đầy đủ (tự chạy, hash 5080e3a)
Lệnh: `node test/browser/paypal-wallet-browser.js` (cwd cho-an-tam, NODE_PATH ngoài repo, có khoá hàng đợi, Chrome 154.0.8037.98, playwright-core 1.63.0).
Kết quả (log gốc full.log, nguyên văn):
```
Cleanup failed: browser cleanup timed out
Kết quả trình duyệt (fixture, 186.4s): PASS 458 · FAIL 1 · SKIP 0 · CASES 54
```
(Dòng "Cleanup failed" nằm trong stderr; PowerShell bọc thêm tiền tố "node : " và dòng NativeCommandError, không thuộc runner.) Exit 1. Số dòng ❌ trong các ca: 0.
FAIL 1 là lỗi cleanup do runner cộng vào totals.fail (paypal-wallet-browser.js:127, `for (const e of errors) { totals.fail++; console.error('Cleanup failed:', e.message); }`), KHÔNG phải assertion hành vi. 458 chỉ là số PASS assertion; không có tuyên bố "458/458 qua" vì lượt chạy có 1 FAIL và exit 1.
Lặp lại trên bản sao (TEMP cách ly, full2.log): `Kết quả trình duyệt (fixture, 197.4s): PASS 458 · FAIL 1 · SKIP 0 · CASES 54`, cùng dòng "Cleanup failed: browser cleanup timed out", exit 1. Tái hiện 2/2.

Chẩn đoán (suy luận, chưa chứng minh): hạn 5000 ms cho browser.close() có vẻ quá chặt trong điều kiện máy lúc đó. Probe (scratchpad probe.js; mỗi vòng: chromium.launch, h.openSession, s.close(), rồi đo `Date.now()` quanh `await browser.close()`, 3 vòng) in nguyên văn:
```
browser.close ms (idle, after 1 session) 17176
browser.close ms (idle, after 1 session) 5288
browser.close ms (idle, after 1 session) 2865
```
Chỉ 3 mẫu, 2/3 > 5000 ms. Máy khi đó CPU 100% và ~1 GB RAM trống (đo bằng Win32_Processor/Win32_OperatingSystem) nên "do tải" là suy đoán hợp lý từ 3 mẫu, chưa được chứng minh (chưa có mẫu trên máy rảnh, chưa đo lặp). Sau lượt chạy không thấy process Chrome của runner (lọc theo command line).

## 5. Dọn tài nguyên sau lượt chạy
- Server fixture: không còn (process thoát, cổng đóng cùng process node).
- Browser của runner: không còn (không thấy chrome.exe có remote-debugging-pipe/host-resolver-rules/profile playwright của tôi).
- Khoá hàng đợi của tôi: đã nhả (finally); hiện do agent khác giữ.
- **%TEMP%\enclave-paypal-browser.lock: CÒN LẠI** (do chính thiết kế "cleanup lỗi thì giữ khoá"), owner pid 19068 đã chết = khoá stale của lượt chạy tôi. Mọi lượt runner kế tiếp trên máy này sẽ bị từ chối "Stale browser lock" cho tới khi người có thẩm quyền xoá tay. Theo yêu cầu tôi KHÔNG xoá. => FINDING CHẶN vận hành (F1), cần Pro quyết định (xoá khoá khi xác nhận pid 19068 không sống và không có Chrome runner; hoặc bảo tôi xoá).
- Bản sao: khoá riêng trong scratchpad\runner-review\tmp2 cũng còn (chỉ nằm scratchpad, vô hại).
- git status (worktree): chỉ `?? test/evidence/` (thư mục của agent backend, không phải của runner này). Không có ảnh PNG nào bị đổi.

## 6. M1/M7 và tín hiệu
- M1 và M7 đều được bắt (đỏ), khác biệt chỉ ở cách đỏ (ngoại lệ/điều kiện dựng thay vì assert đích). Không có chứng cứ khoảng trống làm sai kết luận nghiệm thu: không đề xuất sửa test, không lặp mutation.
- SIGINT/SIGTERM/kill thật: **CHƯA KIỂM CHỨNG**. Tôi không chạy thực. Lưu ý Windows: `process.kill(pid,'SIGTERM'/'SIGINT')` từ process khác là kill cưỡng bức, không kích hoạt handler; chỉ Ctrl+C trong console mới kiểm được. Unit chỉ chứng minh huỷ chờ khoá và lỗi cleanup, không suy ra đường tín hiệu thật.

## Bảng tự chạy vs lịch sử Codex
| Mục | Tự chạy (tôi) | Lịch sử Codex (đối chiếu) |
| --- | --- | --- |
| Unit | 8/8 pass, 0 fail, 0 skip, exit 0 | 8/8 pass |
| `--only=UNKNOWN` | exit 2, không Chrome | exit 2 |
| Full Chrome | 54 ca, PASS 458 (assertion), FAIL 1 (lỗi cleanup, không phải assertion), SKIP 0, exit 1, 186 s (và 197 s ở bản sao) | Lời kể từ tài liệu khác, CHƯA kiểm: 54 ca, 458 assertion, FAIL 0, SKIP 0, exit 0, 73.2 s |
| Khoá sau chạy | stale enclave lock còn lại | không ghi nhận |

Chênh 73 s so với 186 s chưa được giải thích bằng chứng cứ; "máy tải" chỉ là giả thuyết.

## Findings
- F1 (CHẶN vận hành/xác nhận): hạn 5000 ms cho browser.close() (paypal-wallet-browser.js, cleanup(): `h.withDeadline(browser.close(), 5000, 'browser cleanup')`) có vẻ quá chặt (suy luận từ 3 mẫu probe, 2/3 > 5 s). Hệ quả đã quan sát: exit 1 do cleanup timeout, và khoá enclave bị giữ dù không thấy Chrome runner sống. Tái hiện: chạy full runner trong điều kiện máy như lúc đó (2/2 lần); probe.js đo browser.close 2.9-17.2 s. Đề xuất cho Codex: nâng hạn browser (ví dụ 30-60 s) và/hoặc sau timeout kiểm Chrome đã thoát hẳn rồi mới quyết giữ/nhả khoá; thêm thông điệp chỉ rõ đường dẫn khoá và pid; cân nhắc phân biệt FAIL cleanup với FAIL hành vi trong tóm tắt. Cần Pro chạy lại lượt xanh sau khi sửa trên máy ít tải.
- F2 (sau): kiểm phủ theo từng spec (xem 1a). F3 (sau): song song hoá cleanup (1b), tín hiệu thứ hai (1c).

## Giới hạn
Chỉ Chrome với fixture cục bộ. Không chứng minh PayPal Sandbox thật, cookie HTTPS, hay Windows Hello/Passkey thật. PASS 458 là số assertion qua trong fixture, kèm 1 FAIL cleanup; không phải kết quả xanh. Không so được thời gian với số của Codex (chưa kiểm).
