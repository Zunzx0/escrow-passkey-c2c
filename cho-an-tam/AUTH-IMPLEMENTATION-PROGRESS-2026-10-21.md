# Auth implementation work in progress — 21/10/2026

**Trạng thái mới nhất:** các đoạn “Remaining work” bên dưới là ghi chép ở giữa lượt, không phải danh sách còn tồn tại hiện nay. Xem mục cập nhật cuối tệp và `AUTH-REDESIGN-RELEASE.md` mục 11. Chưa triển khai auth lên web; còn email thật/cấu hình hosting và nghiệm thu thiết bị thật.

User has now authorized implementing the plan to completion in the main system; no separate demo environment or shortened time controls. Authoritative checkout: this directory, branch codex/auth-passkey-redesign. Existing uncommitted redesign changes are preserved. No deploy/push/commit yet.

Confirmed requirements: 20 wrong OTP checks in a rolling 24h window + minimum 1h lock; <=5 wrong checks/code; cap only OTP; recipient-shared <=5 verification emails/hour; email verification link on another device requires ordinary matching password login + explicit POST, same P session, only its own 30-minute proof; no automatic wallet/K/G. Rotate all recovery codes on both recovery paths. Withdraw/payout deferred; email-only recovery stays 24h/1h/72h. User manually demonstrates website with normal timers. Inspection deadline is a maximum, never a mandatory wait; release still needs existing confirmation/G.

Implemented this work session:

- Added src/lib/authKeys.js: versioned HMAC digests and AES-GCM envelope, old-key/legacy reading, production config validation.
- Added src/lib/emailVerification.js: verified-email ownership only, per-recipient rolling quota, atomic per-code attempt cap and durable rolling account cap, throttled notice, explicit read-only link preview + matching-session confirmation, server deadlines/ensure semantics, purpose/email/code binding. New link default 10min is technical choice, not a user-selected value.
- Migration 11 plus repeat-safe SQLite additions: credential.user_handle, email-code.email, outbox.expires_at, failures/locks/shared email-sends tables.
- Account routes wired to verification module, registration/resend return metadata, link endpoints preserve same P; all recovery completion now generates a fresh full set; recovery HMAC lookup supports old key versions.
- Registration challenges store server-issued userHandle and issuing session; first/add/recovery credential stores handle. Login compares known per-credential handle, leaves genuinely legacy unknown handles untouched. Challenge use also rechecks expiry.
- Logout checks current and historical refresh hash inside transaction.
- authOrigin middleware rejects untrusted Origin on auth mutations including same-site subdomains, missing Origin with Cookie; CORS exposes Retry-After.
- Outbox has expiry and purge; mail worker ignores expired/purged bodies.
- Claude CLI performed an actual implementation task in the authorized sanitized enclave-team-work snapshot, using explicitly Read skill files security-review/product-lens/verification-before-completion, and edited ONLY public/js/app.js. Verified snapshot manifest showed exactly that one source file changed and live original matched baseline hash before integration. Integrated file then fixed missing-username confirmation guard and malformed confirmation-response validation locally.
- Frontend server-timed ensure OTP, link preview/login/mismatch/explicit-confirm in-memory flow, expired-proof options/verify recovery, recovery-code modal explicit defer warning. No automatic link confirmation.

Fresh evidence so far (not entire system acceptance):

- node --test test/auth-keys.test.js PASS.
- node test/auth-migration.js PASS preservation/repeat safety.
- node --test test/auth-mail.test.js PASS fake Resend.
- node test/auth-redesign-e2e.js PASS 95 assertions on isolated SQLite (after backend changes).
- node test/auth-verification-e2e.js PASS 30 new assertions on isolated SQLite.
- node test/ui/auth-redesign-ui.js PASS 28 assertions after updating fake email/resend contract.
- Syntax and git diff --check pass at last run (only existing line-ending warnings).

New verification suite's initial two failures were test issues: it required all 50 burst rejections be 400 instead of accepting legitimate 429; it then mixed that burst with the separate rolling-cap scenario, triggering the preexisting 30/10min request gate. Fixed by separating burst and cap accounts, retaining DB attempt/failure assertions. No security limits removed.

UI runtime diagnostic: require(jsdom) outside sandbox completed in ~1s and complete UI suite in ~6.5s. Restricted run was much slower; do not treat prior interrupted UI runs as product bugs or passes.

Remaining work:

1. Focused new DOM regressions for server cooldown, link no-auto-POST/mismatched-login/same-P, error/retry and explicit recovery-code defer.
2. Review shared OTP cap and recipient budget on email-change verification too; avoid generating first-activation links for ACTIVE email-change failures.
3. Verify older/current keys and expired mail cleanup more thoroughly; config/.env.example docs for key IDs/key rings, production preflight, proxy trust, no real secret reads.
4. Run newest SQLite suites after remaining backend changes; run migration + auth/new verification suites on isolated PostgreSQL using updated harness/snapshot (existing auth-postgres currently only includes original auth suite).
5. Relevant UI/navigation/PayPal/shipping/money invariants regression tests.
6. Independent Claude security review of final allowlisted snapshot and fixes for substantiated findings.
7. Resend real setup/domain and physical phone/Windows acceptance remain external prerequisites. Last user-provided state was Resend not yet configured. Do not claim real email or actual biometrics tested.
8. Before publishing/deploying auth changes, prepare a concrete reviewed result and respect existing authorization: prior explicit public shipping approval was scoped to shipping, not blanket proof of auth publication approval. Do all authorized local work first; no premature permission request.

Claude implementation output: ../sport-store-SIEM-Backup/backend/enclave-team-work/team/claude-auth-frontend-implementation-2026-10-21.jsonl (actual absolute path under Downloads/đồ án). CLI job 89223 completed exit 0. No Claude job running currently. Test jobs 38915 were stopped/closed; no running test currently known.

## Cập nhật chốt lượt làm việc

- Hoàn tất giao diện metadata thời gian máy chủ, OTP/link đúng tài khoản/phiên, giữ token liên kết trong bộ nhớ, xác nhận POST chủ động, xử lý hủy và hiển thị mã dự phòng một lần. Không mở tab localhost hay tạo hệ thống demo để người dùng trình diễn.
- Đổi email dùng chung trần sai OTP theo tài khoản và quota người nhận. Thông báo khóa OTP của tài khoản ACTIVE không vô tình tạo liên kết kích hoạt ví.
- Outbox ngừng gửi mã/liên kết hết hạn; xóa ciphertext sau gửi hoặc hết hạn/tối đa 24h. Bài kiểm giả Resend chứng minh retry, lease nhiều worker, đọc mail khóa cũ sau rotation, purge và idempotency. Keyring và cách giữ khóa cũ được ghi trong .env.example.
- Production từ chối khóa thiếu/ngắn, public URL không HTTPS và thời gian khôi phục/kiểm hàng rút ngắn. Cookie production luôn Secure ngay cả khi TLS kết thúc ở proxy. Không đọc hoặc sửa .env thật.
- Đã thử migration từ bảng auth cũ thiếu cột trên cả SQLite và PostgreSQL, chạy lại không mất OTP/outbox; diễn tập backup/restore SQLite rồi nâng cấp lại. Dữ liệu ví/ledger/khóa và trigger admin giữ nguyên.
- Claude final review có một phát hiện đúng: hai tab refresh cùng cookie có thể thu hồi phiên hợp lệ. Đã tái hiện thất bại trước sửa. Lịch sử token dưới 10 giây chỉ trả 409 không cookie/token; frontend thử tối đa 3 lần bằng cookie hiện tại, kiểm epoch. Token cũ ngoài cửa sổ vẫn thu hồi phiên; logout token cũ thu hồi ngay. 10 giây là khoảng xử lý xung đột, không phải hiệu lực thêm để lấy token mới.
- Claude đã kiểm lại sửa refresh: không xác nhận P1/P2 mới trong phạm vi đọc. Đã rút lại nhận xét sai về token trong localStorage sau khi đọc setSession; token chỉ trong state bộ nhớ. Không xem đánh giá mã là chứng nhận không có lỗi.
- Bộ giới hạn tốc độ đã bền ở DB nhưng helper reset test còn xóa Map không dùng. Đã bỏ trạng thái chết, helper reset async chỉ chạy APP_ENV=test, sửa ba caller test để await. Không có endpoint reset trên sản phẩm.
- PayPal UI ban đầu 2/220 chưa đạt: dấu thời gian chứng minh assertion sớm hơn poll tiếp theo. Chỉ đổi test chờ điều kiện có hạn 5s, không đổi logic tiền. Chạy lại 220/220 đạt.

### Bằng chứng chạy thực tế

| Nhóm | Kết quả |
| --- | --- |
| Auth API/WebAuthn SQLite | 95 PASS |
| OTP/link/refresh/legacy key/recovery bổ sung SQLite | 43 PASS |
| Auth PostgreSQL riêng, migration 7→11 | 97 + 42 PASS; probe X-Forwarded-For cuối chỉ SQLite |
| Bảng auth-v10 cũ PostgreSQL | Giữ OTP/outbox, thêm cột, chạy hai lần PASS |
| Migration SQLite + backup/restore | PASS |
| Key/cipher/mail/production cookie unit | PASS |
| Auth UI / email-link UI | 28 / 20 PASS |
| Mobile / session / PayPal return / shipping / navigation DOM | 8 / 17 / 18 / 23 / 4 PASS |
| Ví PayPal DOM | 220 PASS |
| PayPal settlement / HTTP / abandon, provider giả | 85 / 67 / 399 PASS |
| Backend vận chuyển | 82 PASS |
| Chín bất biến tiền/tài khoản bằng fixture sai và rollback | PASS |
| Cú pháp JS mới/đổi + whitespace + dependency production | 46 tệp PASS; phiên bản production không đổi |

Không lấy các lần chạy lặp làm số test độc lập. Full auth npm script đã qua lại sau sửa refresh; sau đó bổ sung probe IP và backup/cookie unit đã chạy riêng. Bản PostgreSQL snapshot cuối gồm sửa refresh; cookie Secure production được kiểm riêng bằng unit sau snapshot này. Thư thật, cookie hai domain thật và vân tay/Face ID vật lý chưa nghiệm thu. Không chạy lại toàn bộ bộ báo cáo cũ 489 ca; không dùng kết quả cũ để tuyên bố bản mới đạt mọi thứ.

### Việc còn phụ thuộc bên ngoài

1. Resend: cần trạng thái xác minh miền gửi và key trong Railway secret store; đã hỏi người dùng, không hỏi gửi key qua chat. Trạng thái đã biết trước đó là chưa cấu hình. Chưa gửi thư thật hoặc chứng minh thư tới inbox.
2. Kiểm topology proxy và Session pooler thực tế; backup dữ liệu nhà cung cấp trước migration. Mọi DB đã thử trong lượt này là dữ liệu riêng.
3. Quyền công khai/push/gộp bản auth phải theo đúng phạm vi. Đồng ý công khai shipping d5d6d27 không tự biến thành một lần duyệt mới cho toàn bộ auth. Hoàn tất kết quả reviewable cục bộ trước khi xin bước phát hành.
4. Nghiệm thu mobile/Windows thực tế sau email và phát hành. Có thể thao tác tài khoản thử riêng trên chính website; không cần xây thêm môi trường trình diễn.

Lưu vết Claude tại `C:/Users/tranq/Downloads/đồ án/sport-store-SIEM-Backup/backend/enclave-team-work/team/`: `claude-auth-final-review-2026-10-21.jsonl`, `claude-auth-fix-followup-2026-10-21.jsonl`. Lượt review đầu chỉ đọc snapshot 93 tệp; lượt focused dùng snapshot 96 tệp. CLI thành công/is_error=false, giá tương ứng khoảng $2.618 và $0.153. Hai lượt này không tự chạy test.
