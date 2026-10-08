# Vòng kiểm thử đầy đủ — 2026-10-07T13-09-40-880Z

- Môi trường: test (http://localhost:3930), cơ sở dữ liệu `data\test\pro-abandon-full-sqlite.db` (tạo mới từ trống)
- Node v26.4.0, win32 x64
- Kết quả: **CÓ BỘ HỎNG** — 1000 phép kiểm đạt, 6 phép kiểm hỏng

| Bộ | Kết quả | Đạt | Hỏng | Thời gian |
|---|---|---:|---:|---:|
| count-marks-unit | PASS | 14 | 0 | 0s |
| invariants-unit | PASS | 39 | 0 | 1s |
| e2e | FAIL | 33 | 6 | 3s |
| market-e2e | PASS | 63 | 0 | 4s |
| security-e2e | PASS | 38 | 0 | 3s |
| hybrid-e2e | PASS | 53 | 0 | 4s |
| hardening-e2e | PASS | 23 | 0 | 2s |
| payment-e2e | PASS | 40 | 0 | 2s |
| reconcile-e2e | PASS | 65 | 0 | 7s |
| counter-e2e | PASS | 30 | 0 | 1s |
| cleanup-e2e | PASS | 13 | 0 | 1s |
| notification-e2e | PASS | 44 | 0 | 3s |
| checkout-e2e | PASS | 19 | 0 | 2s |
| dispute-race-e2e | PASS | 29 | 0 | 3s |
| security-report-regression-e2e | PASS | 47 | 0 | 5s |
| username-enumeration-e2e | PASS | 12 | 0 | 4s |
| listing-lifecycle-e2e | PASS | 70 | 0 | 6s |
| passkey-registration-race-e2e | PASS | 41 | 0 | 1s |
| topup-concurrency-e2e | PASS | 43 | 0 | 2s |
| manual-transaction-amount-e2e | PASS | 46 | 0 | 1s |
| topup-idempotency-e2e | PASS | 82 | 0 | 5s |
| payment-provider-isolation-e2e | PASS | 16 | 0 | 0s |
| paypal-integration-e2e | PASS | 52 | 0 | 3s |
| admin-provenance-e2e | PASS | 69 | 0 | 5s |
| rollback-e2e (FAULT_INJECT=release:after-wallet-update) | PASS | 10 | 0 | 1s |
| check-invariants | PASS | 9 | 0 | 0s |

Đầu ra nguyên văn của từng bộ nằm cùng thư mục (`<bộ>.log`), log máy chủ ở `server.log` và `server-fault.log`.
