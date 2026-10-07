# Thí nghiệm F2 do Pro tự chạy (`paypal-m2-recovery-e2e`, mỗi lượt DB mới)

Lệnh: `node --env-file=.env.test test/paypal-m2-recovery-e2e.js` với `DB_PATH=data/test/<tên>.db`, Node v26.4.0, Windows 11, hash 5080e3a. Mỗi nhóm là một bản sao cùng mã; nhóm "patched" chỉ khác một dòng `test/helpers/paypal-m2-fake.js:98`: `fs.rmdirSync(lockPath)` đổi thành `retrySharing(()=>fs.rmdirSync(lockPath))`. Helper trong worktree chính KHÔNG bị sửa.

| Tiền tố log | Vị trí chạy | Mã helper | Kết quả |
|---|---|---|---|
| `worktree-downloads-original__` | worktree (`Downloads\đồ án\claude-wt\...`) | gốc | 5 lượt, 5 đỏ (EPERM rmdir; child thoát sớm; "B acquired only after A released") |
| `downloads-ascii-original__` | `Downloads\zz-f2-probe` (ASCII) | gốc | 4 lượt, 4 đỏ |
| `scratch-ascii-original__` | `AppData\Local\Temp` (ASCII) | gốc | 6 lượt, 6 xanh (47/47) |
| `scratch-nonascii-original__` | `AppData\Local\Temp` (đường dẫn có "đồ án") | gốc | 4 lượt, 4 xanh (47/47) |
| `scratch-ascii-patched__` | `AppData\Local\Temp` (ASCII) | patched | 6 lượt, 6 xanh (47/47) |
| `downloads-ascii-patched__` | `Downloads\zz-f2-probe2` (ASCII) | patched | 5 lượt, 5 xanh (47/47) |

Mỗi lượt có `*-runN.log` (stdout) và `*-runN.log.err` (stderr) thật. Số ✅ trong log là số kiểm đạt của lượt đó; lượt đỏ dừng sớm nên số ✅ nhỏ hơn 47.

Giới hạn: n nhỏ, một máy, chưa chạy trên Linux. Tác nhân quét tệp (Microsoft Defender thời gian thực đang bật) chưa được chứng minh. Kết luận dùng được: cùng mã đỏ ở vị trí trong `Downloads`, xanh ở `AppData\Local\Temp`, và bản vá một dòng làm xanh cả hai vị trí. Đây là bằng chứng harness test không chịu được lỗi chia sẻ tệp tạm thời trên Windows, chưa phải bằng chứng về logic phục hồi của sản phẩm (các lượt đỏ dừng sớm ở R3/R4 nên không phủ phần assertion phía sau).
