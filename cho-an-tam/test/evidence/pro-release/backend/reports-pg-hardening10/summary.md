# Vòng kiểm thử đầy đủ — 2026-10-07T09-09-48-439Z

- Môi trường: test (http://localhost:3910), cơ sở dữ liệu `PostgreSQL enclave_pro_release_test` (tạo mới từ trống)
- Node v26.4.0, win32 x64
- Kết quả: **TẤT CẢ PASS** — 36 phép kiểm đạt, 0 phép kiểm hỏng

| Bộ | Kết quả | Đạt | Hỏng | Thời gian |
|---|---|---:|---:|---:|
| hardening-e2e | PASS | 27 | 0 | 5s |
| check-invariants | PASS | 9 | 0 | 1s |

Đầu ra nguyên văn của từng bộ nằm cùng thư mục (`<bộ>.log`), log máy chủ ở `server.log` và `server-fault.log`.
