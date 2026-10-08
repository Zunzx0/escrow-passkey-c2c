# Chốt kiểm chứng luồng PayPal cho báo cáo — 08/10/2026

## Bản đã kiểm tra

Mã sản phẩm e2c6cb6, nhánh codex/payment-provider-isolation. Hai tệp spec Chrome cập nhật trong lượt này, không sửa backend hay giao diện sản phẩm.

## Kết quả Codex tự chạy

Chrome thật với API fixture biệt lập: 445 PASS, 0 FAIL, 0 SKIP, 53 ca, exit 0, 54.8 giây. Log tại C:\Users\tranq\AppData\Local\Temp\enclave-chrome-auto-final4.log. Bộ gồm allowlist URL, return tự capture, GET trước/sau capture, trạng thái chưa hoàn tất, cancel, Back bằng page.goBack thật, reload không capture lại, đổi phiên cùng/khác tài khoản, refresh token và cấu hình lỗi. Các ca bấm nút xác nhận thủ công cũ được thay bằng ca tự hoàn tất; không so sánh số tổng mới với 458 cũ như tỷ lệ chất lượng.

Ảnh mới: cho-an-tam/test/browser/paypal/evidence/B2-back-cho-quyet-dinh.png. Dữ liệu trong ảnh là fixture, không phải giao dịch PayPal thật.

Lượt đầu sau cập nhật: 424 PASS/3 FAIL; lỗi dựng ca gồm gọi Back trước khi navigation fixture hoàn tất và hai ca còn bấm nút capture đã bỏ. Sau sửa chờ DOM của trang fixture và bỏ thao tác nút cũ, lượt cuối đạt nêu trên. Lượt bị ngắt trước đó để lại lock; đã xác minh owner PID 42032 chết và không còn Chrome test trước khi xoá đúng lock. Không xoá hoặc dừng Chrome người dùng.

Các kết quả UI khác tại những lượt trước: auto-complete 25/25, Back 15/15, abandon 45/45; PayPal UI 220/220. Module PayPal kiểm lại 50/50. Đây là các lượt riêng, không cộng thành tổng full suite.

Backend không đổi so với c579389 đã chạy full SQLite/PostgreSQL và bất biến tài chính. Không nhận các báo cáo full suite cũ là lượt vừa chạy lại.

## Kết quả người dùng xác nhận trực tiếp

Ngày 08/10/2026, người dùng trả lời: “Đã cộng tiền và hiện thành công” khi được hỏi về việc thanh toán Sandbox quay về Enclave, cộng đúng số tiền và hiện Nạp tiền thành công. Đây là bằng chứng do người dùng báo, Codex chưa kiểm độc lập capture ID, webhook verification hoặc số credit trong cơ sở dữ liệu của khoản này.

## Phần cần thiết bị / vận hành

Cần chốt đủ tài khoản BUYER, SELLER, ADMIN và Passkey thật để thực hiện mua/giữ tiền/giải ngân và tranh chấp/hoàn tiền. Xác nhận cookie HTTPS và bằng chứng webhook/đối soát thực tế chưa được thay thế bởi fixture. PR #21 đang draft, kiểm tra GitHub đạt; trang chính chưa đồng bộ bản Sandbox. Trước phát hành phải sao lưu và kiểm cấu hình/migration, không reset hay đổi DB production sang DB Sandbox.

Bản Sandbox đã dùng được để thực hiện nghiệm thu và lấy ảnh chức năng thực tế. Không đưa ảnh fixture vào báo cáo như giao dịch thật. Không gọi hệ thống hoàn thiện 100% khi các mục nghiệm thu còn trống.
