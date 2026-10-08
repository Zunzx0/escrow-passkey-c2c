# PayPal Sandbox: tự hoàn tất khoản nạp sau phê duyệt

Thay thế yêu cầu giao diện cũ phải bấm xác nhận capture trên Enclave. Người dùng bấm nạp, giao diện tạo yêu cầu rồi lấy và kiểm URL checkout từ server để mở PayPal Sandbox. Sau return hợp lệ, GET xác minh khoản nạp khớp phiên và ý định lưu, rồi tự gọi capture một lần. Cancel không capture. Server vẫn kiểm owner, order, phê duyệt, merchant, tiền và capture ID; settlement chống cộng trùng không thay đổi.

Chỉ GET hợp lệ nói SUCCEEDED mới thông báo thành công và đọc lại ví. Timeout, lỗi hay kết quả chưa rõ không tự gửi lại capture. Request khác, phiên cũ, hoặc thiếu ý định không tự capture. Query token/PayerID không phải bằng chứng thanh toán.

Kiểm thử UI mới: `node test/ui/paypal-auto-complete-ui.js`; hồi quy PayPal: `node test/ui/paypal-wallet-ui.js`. Đều dùng jsdom và fetch giả, không chứng minh giao dịch Sandbox thật. Các báo cáo Chrome trước thay đổi này là bằng chứng lịch sử, không chứng minh luồng return tự capture mới.

Tài liệu PayPal: https://developer.paypal.com/api/rest/integration/orders-api — phê duyệt trên PayPal và capture phía máy chủ với intent CAPTURE.
