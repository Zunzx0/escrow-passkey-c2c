// Địa chỉ backend API mà giao diện gọi tới.
//
// Tệp này công khai và KHÔNG được chứa bí mật nào — mọi khoá (JWT, webhook, cơ sở dữ liệu) chỉ
// nằm ở máy chủ API.
//
//   enclave.id.vn (Vercel)       -> https://api.enclave.id.vn (Railway)
//   *.vercel.app (bản preview)   -> https://api.enclave.id.vn — chỉ để xem giao diện: Passkey không
//                                   chạy ở đây vì origin không thuộc RP ID enclave.id.vn
//   còn lại (localhost, Render)  -> '' : gọi chính origin đang phục vụ trang, như trước khi tách
window.ENCLAVE_API_BASE = (function () {
  var host = window.location.hostname;
  if (host === 'enclave.id.vn' || host === 'www.enclave.id.vn' || /\.vercel\.app$/.test(host)) {
    return 'https://api.enclave.id.vn';
  }
  return '';
})();
