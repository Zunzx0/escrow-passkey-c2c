/**
 * Hồi quy giao diện Passkey trên mobile.
 *
 * Chứng minh bốn điều không phụ thuộc thiết bị thật: giao diện tự kiểm tra khả năng trước
 * khi tạo tài khoản, chặn trình duyệt nhúng/thiết bị thiếu authenticator, không tạo tài
 * khoản dở dang, và dịch mã lỗi WebAuthn thành hướng dẫn cụ thể.
 */
const { wallet, json, sleep, logoutUi } = require('./paypal-wallet-ui');

let checks = 0;
let fails = 0;
const ok = (condition, message) => {
  checks++;
  console.log(`  ${condition ? '✅' : '❌'} ${message}`);
  if (!condition) fails++;
};

const ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';
const ANDROID_WEBVIEW =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UQ1A; wv) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Version/4.0 Chrome/124.0.0.0 Mobile Safari/537.36';

function installMobilePasskeyEnvironment(page, { ua = ANDROID_CHROME, platform = true } = {}) {
  Object.defineProperty(page.w.navigator, 'userAgent', { value: ua, configurable: true });
  Object.defineProperty(page.w.navigator, 'credentials', {
    value: { create: async () => ({}) }, configurable: true,
  });
  page.w.PublicKeyCredential = class PublicKeyCredential {};
  page.w.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = async () => platform;
}

async function openRegistration(options) {
  const page = await wallet({ hash: '#/' });
  await logoutUi(page);
  installMobilePasskeyEnvironment(page, options);
  page.click(page.d.querySelector('[data-act="open-auth-register"]'));
  await sleep(300);
  return page;
}

function fillRegistration(page) {
  page.d.querySelector('#regUsername').value = 'mobile-test';
  page.d.querySelector('#regDisplayName').value = 'Mobile Test';
  page.d.querySelector('#regPassword').value = 'mat-khau-test';
}

async function main() {
  console.log('\nMobile Passkey readiness');

  let page = await openRegistration();
  ok(/Thiết bị sẵn sàng/.test(page.d.querySelector('#registerPasskeyReadiness').textContent),
    'Chrome mobile đủ điều kiện được xác nhận tự động');
  page.close();

  page = await openRegistration({ ua: ANDROID_WEBVIEW });
  ok(/trình duyệt nhúng/.test(page.d.querySelector('#registerPasskeyReadiness').textContent),
    'Trình duyệt nhúng được phát hiện và hướng dẫn mở Chrome/Safari');
  fillRegistration(page);
  page.click(page.d.querySelector('[data-act="do-register"]'));
  await sleep(100);
  ok(page.count('POST /api/passkeys/register/account') === 0,
    'Không tạo tài khoản dở dang khi đang ở trình duyệt nhúng');
  page.close();

  page = await openRegistration({ platform: false });
  ok(/chưa cung cấp Passkey/.test(page.d.querySelector('#registerPasskeyReadiness').textContent),
    'Điện thoại thiếu platform authenticator được giải thích ngay');
  fillRegistration(page);
  page.click(page.d.querySelector('[data-act="do-register"]'));
  await sleep(100);
  ok(page.count('POST /api/passkeys/register/account') === 0,
    'Không tạo tài khoản dở dang khi điện thoại chưa sẵn sàng');
  page.close();

  page = await openRegistration();
  page.routes['POST /api/passkeys/register/account'] = () => json(201, {
    token: 'pending-mobile-token',
    user: {
      id: 'pending-mobile-user', username: 'mobile-test', displayName: 'Mobile Test',
      role: 'BUYER', accountStatus: 'PENDING_PASSKEY',
    },
  });
  page.routes['POST /api/passkeys/register/passkey/options'] = () => json(200, {
    registrationSessionId: 'session-mobile', options: {},
  });
  fillRegistration(page);
  page.click(page.d.querySelector('[data-act="do-register"]'));
  await sleep(140);
  ok(page.count('POST /api/passkeys/register/account') === 1 &&
      /Bước cuối để kích hoạt/.test(page.d.querySelector('#modalRoot').textContent),
    'Thiết bị sẵn sàng mới được tạo tài khoản và chuyển sang bước gắn Passkey');

  page.w.SimpleWebAuthnBrowser.startRegistration = async () => {
    const error = new Error('authenticator failure');
    error.name = 'UnknownError';
    error.code = 'ERROR_AUTHENTICATOR_GENERAL_ERROR';
    throw error;
  };
  page.click(page.d.querySelector('[data-act="do-enroll-passkey"]'));
  await sleep(180);
  ok(page.toasts().some((toast) => /Google Password Manager/.test(toast.text)),
    'Lỗi authenticator được dịch thành hướng dẫn Android/iPhone cụ thể');
  ok(page.count('POST /api/passkeys/register/passkey/verify') === 0,
    'Không gửi xác minh khi thiết bị chưa tạo được Passkey');
  page.close();

  console.log(`\n${checks} kiểm tra, ${fails ? `${fails} FAIL` : 'ALL PASS'}`);
  process.exit(fails ? 1 : 0);
}

if (require.main === module) main().catch((error) => {
  console.error('[mobile-passkey-readiness-ui] lỗi:', error);
  process.exit(1);
});
