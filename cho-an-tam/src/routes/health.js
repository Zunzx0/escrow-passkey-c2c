const express = require('express');
const { isEnabled } = require('../lib/faultInjection');
const { backgroundJobConfig } = require('../lib/backgroundJobs');

const router = express.Router();

router.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    time: new Date().toISOString(),
    // dev | test | experiment — bộ chạy kiểm thử dựa vào đây để không bao giờ chạy nhầm lên
    // máy chủ thực nghiệm.
    environment: process.env.APP_ENV || 'dev',
    // Công bố cấu hình chèn lỗi để runbook thực nghiệm kiểm được rằng nó ĐANG TẮT trước khi
    // thu kết quả chính thức, và để bài kiểm thử rollback biết máy chủ có đang ở cấu hình
    // dành cho nó hay không. Chỉ là một cờ bật/tắt, không lộ thêm gì.
    faultInject: isEnabled() ? process.env.FAULT_INJECT : null,
    // Cấu hình tác vụ nền — để bộ kiểm thử đối soát biết worker trong máy chủ có thể chen
    // vào hay không, và runbook ghi lại được cấu hình của lần đo.
    backgroundJobs: backgroundJobConfig(),
  });
});

module.exports = router;
