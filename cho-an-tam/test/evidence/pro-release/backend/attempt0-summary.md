# Vòng kiểm thử đầy đủ — 2026-10-07T08-50-01-136Z

- Môi trường: test (http://localhost:3910), cơ sở dữ liệu `data\test\pro-release-sqlite.db` (tạo mới từ trống)
- Node v26.4.0, win32 x64
- Kết quả: **CÓ BỘ HỎNG** — 74 phép kiểm đạt, 0 phép kiểm hỏng

| Bộ | Kết quả | Đạt | Hỏng | Thời gian |
|---|---|---:|---:|---:|
| count-marks-unit | PASS | 14 | 0 | 0s |
| invariants-unit | PASS | 39 | 0 | 1s |
| e2e | FAIL | 0 | 0 | 1s |
| market-e2e | FAIL | 0 | 0 | 1s |
| security-e2e | FAIL | 0 | 0 | 1s |
| hybrid-e2e | FAIL | 0 | 0 | 2s |
| hardening-e2e | FAIL | 0 | 0 | 1s |
| payment-e2e | FAIL | 0 | 0 | 1s |
| reconcile-e2e | FAIL | 0 | 0 | 1s |
| counter-e2e | FAIL | 0 | 0 | 1s |
| cleanup-e2e | FAIL | 0 | 0 | 1s |
| notification-e2e | FAIL | 0 | 0 | 1s |
| checkout-e2e | FAIL | 0 | 0 | 1s |
| dispute-race-e2e | FAIL | 0 | 0 | 1s |
| security-report-regression-e2e | FAIL | 0 | 0 | 1s |
| username-enumeration-e2e | PASS | 12 | 0 | 9s |
| listing-lifecycle-e2e | FAIL | 0 | 0 | 1s |
| passkey-registration-race-e2e | FAIL | 0 | 0 | 1s |
| topup-concurrency-e2e | FAIL | 0 | 0 | 1s |
| manual-transaction-amount-e2e | FAIL | 0 | 0 | 1s |
| topup-idempotency-e2e | FAIL | 0 | 0 | 1s |
| payment-provider-isolation-e2e | FAIL | 0 | 0 | 1s |
| paypal-integration-e2e | FAIL | 0 | 0 | 1s |
| admin-provenance-e2e | FAIL | 0 | 0 | 1s |
| rollback-e2e (FAULT_INJECT=release:after-wallet-update) | FAIL | 0 | 0 | 1s |
| check-invariants | PASS | 9 | 0 | 0s |

Đầu ra nguyên văn của từng bộ nằm cùng thư mục (`<bộ>.log`), log máy chủ ở `server.log` và `server-fault.log`.
