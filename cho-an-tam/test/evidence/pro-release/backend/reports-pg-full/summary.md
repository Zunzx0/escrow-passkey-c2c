# Vòng kiểm thử đầy đủ — 2026-10-07T09-04-08-558Z

- Môi trường: test (http://localhost:3910), cơ sở dữ liệu `PostgreSQL enclave_pro_release_test` (tạo mới từ trống)
- Node v26.4.0, win32 x64
- Kết quả: **TẤT CẢ PASS** — 997 phép kiểm đạt, 0 phép kiểm hỏng

| Bộ | Kết quả | Đạt | Hỏng | Thời gian |
|---|---|---:|---:|---:|
| count-marks-unit | PASS | 14 | 0 | 1s |
| invariants-unit | PASS | 39 | 0 | 2s |
| e2e | PASS | 39 | 0 | 18s |
| market-e2e | PASS | 63 | 0 | 14s |
| security-e2e | PASS | 38 | 0 | 10s |
| hybrid-e2e | PASS | 53 | 0 | 13s |
| hardening-e2e | PASS | 23 | 0 | 5s |
| payment-e2e | PASS | 40 | 0 | 6s |
| reconcile-e2e | PASS | 65 | 0 | 59s |
| counter-e2e | PASS | 30 | 0 | 3s |
| cleanup-e2e | PASS | 13 | 0 | 4s |
| notification-e2e | PASS | 44 | 0 | 8s |
| checkout-e2e | PASS | 19 | 0 | 10s |
| dispute-race-e2e | PASS | 29 | 0 | 6s |
| security-report-regression-e2e | PASS | 47 | 0 | 13s |
| username-enumeration-e2e | PASS | 12 | 0 | 8s |
| listing-lifecycle-e2e | PASS | 70 | 0 | 19s |
| passkey-registration-race-e2e | PASS | 41 | 0 | 4s |
| topup-concurrency-e2e | PASS | 43 | 0 | 6s |
| manual-transaction-amount-e2e | PASS | 43 | 0 | 5s |
| topup-idempotency-e2e | PASS | 76 | 0 | 16s |
| payment-provider-isolation-e2e | PASS | 16 | 0 | 2s |
| paypal-integration-e2e | PASS | 52 | 0 | 10s |
| admin-provenance-e2e | PASS | 69 | 0 | 22s |
| rollback-e2e (FAULT_INJECT=release:after-wallet-update) | PASS | 10 | 0 | 4s |
| check-invariants | PASS | 9 | 0 | 1s |

Đầu ra nguyên văn của từng bộ nằm cùng thư mục (`<bộ>.log`), log máy chủ ở `server.log` và `server-fault.log`.
