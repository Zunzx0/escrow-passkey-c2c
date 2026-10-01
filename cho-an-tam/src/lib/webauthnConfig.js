// Giữ cấu hình WebAuthn đồng nhất giữa máy phát triển và máy chủ công khai.
// Render cung cấp hostname thật tại thời điểm chạy; dùng trực tiếp giá trị này
// giúp Passkey vẫn đúng khi URL được gắn thêm hậu tố duy nhất.
const renderHostname = String(process.env.RENDER_EXTERNAL_HOSTNAME || '').trim();
const port = process.env.PORT || '3000';

const RP_ID = process.env.WEBAUTHN_RP_ID || renderHostname || 'localhost';
const ORIGIN = process.env.WEBAUTHN_ORIGIN
  || (renderHostname ? `https://${renderHostname}` : `http://localhost:${port}`);

module.exports = { RP_ID, ORIGIN };
