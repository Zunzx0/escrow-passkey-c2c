# Vòng kiểm thử đầy đủ — 2026-10-07T08-54-26-512Z

- Môi trường: test (http://localhost:3910), cơ sở dữ liệu `data\test\pro-release-sqlite.db` (tạo mới từ trống)
- Node v26.4.0, win32 x64
- Kết quả: **TẤT CẢ PASS** — 1006 phép kiểm đạt, 0 phép kiểm hỏng

| Bộ | Kết quả | Đạt | Hỏng | Thời gian |
|---|---|---:|---:|---:|
| count-marks-unit | PASS | 14 | 0 | 5s |
| invariants-unit | PASS | 39 | 0 | 6s |
| e2e | PASS | 39 | 0 | 23s |
| market-e2e | PASS | 63 | 0 | 33s |
| security-e2e | PASS | 38 | 0 | 30s |
| hybrid-e2e | PASS | 53 | 0 | 22s |
| hardening-e2e | PASS | 23 | 0 | 7s |
| payment-e2e | PASS | 40 | 0 | 5s |
| reconcile-e2e | PASS | 65 | 0 | 20s |
| counter-e2e | PASS | 30 | 0 | 5s |
| cleanup-e2e | PASS | 13 | 0 | 5s |
| notification-e2e | PASS | 44 | 0 | 12s |
| checkout-e2e | PASS | 19 | 0 | 11s |
| dispute-race-e2e | PASS | 29 | 0 | 7s |
| security-report-regression-e2e | PASS | 47 | 0 | 16s |
| username-enumeration-e2e | PASS | 12 | 0 | 19s |
| listing-lifecycle-e2e | PASS | 70 | 0 | 21s |
| passkey-registration-race-e2e | PASS | 41 | 0 | 5s |
| topup-concurrency-e2e | PASS | 43 | 0 | 7s |
| manual-transaction-amount-e2e | PASS | 46 | 0 | 6s |
| topup-idempotency-e2e | PASS | 82 | 0 | 19s |
| payment-provider-isolation-e2e | PASS | 16 | 0 | 2s |
| paypal-integration-e2e | PASS | 52 | 0 | 10s |
| admin-provenance-e2e | PASS | 69 | 0 | 46s |
| rollback-e2e (FAULT_INJECT=release:after-wallet-update) | PASS | 10 | 0 | 6s |
| check-invariants | PASS | 9 | 0 | 0s |

Đầu ra nguyên văn của từng bộ nằm cùng thư mục (`<bộ>.log`), log máy chủ ở `server.log` và `server-fault.log`.
