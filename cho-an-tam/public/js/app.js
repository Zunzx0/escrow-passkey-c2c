/* Chợ An Tâm — sàn mua bán C2C có ký quỹ (Escrow) và Passkey.
   Frontend SPA thuần JS, không build, không CDN. Router bằng location.hash; mọi thao tác gọi
   REST API ở /api/*.

   GIAO DIỆN tham khảo các chợ lớn theo TỪNG PHẦN, không bê nguyên một chợ:
     · Trang chủ, danh mục, thẻ sản phẩm: Shopee / Lazada.
     · Chi tiết tin, thông tin người bán, quản lý tin: Chợ Tốt.
     · Lịch sử mua / đơn đã bán, trạng thái đơn, tranh chấp: eBay.
     · Chi tiết giao dịch (ký quỹ, Passkey, chuỗi nhật ký): thiết kế riêng của hệ thống.
   Quy tắc nội dung: tiếng Việt, sentence case, không emoji, nút là "động từ + tân ngữ". */

const App = (() => {
  'use strict';

  const ico = (name, size, cls) => Icons.icon(name, size, cls);

  // =====================================================================
  // State
  // =====================================================================

  const STORAGE_TOKEN = 'cat_token';
  const STORAGE_USER = 'cat_user';
  const HOME_PAGE_SIZE = 18;    // số tin mỗi lần "Xem thêm" ở trang chủ

  const state = {
    token: localStorage.getItem(STORAGE_TOKEN) || null,
    user: safeParse(localStorage.getItem(STORAGE_USER)),
    wallet: null,
    sellerRequest: null,        // yêu cầu cấp quyền bán hàng mới nhất của chính mình
    meta: null,                 // danh mục + tình trạng + khu vực, nạp 1 lần từ /api/listings/meta
    filters: { q: '', category: '', condition: '', location: '', sort: 'new' },
    homeLimit: HOME_PAGE_SIZE,  // số tin đang hiện ở trang chủ
    homeListings: [],           // kết quả tìm gần nhất, để "Xem thêm" không phải gọi lại API
    orderTab: null,             // 'sell' | 'buy' — chỉ người bán có hai tab
    topupMethod: 'CARD',        // phương thức nạp tiền (mô phỏng) đang chọn
    adminTab: 'disputes',       // 'disputes' | 'seller-requests' | 'users' | 'invariants' | 'security-events'
    secEventsType: '',          // bộ lọc loại sự kiện của tab "Sự kiện bảo mật"
    orderFilter: 'active',      // 'active' | 'all' | 'done'
    busy: new Set(),            // id các nút đang chạy, để khoá double-click
    unread: 0,                  // số thông báo chưa đọc — hỏi lại định kỳ (polling), không WebSocket
    topupPoll: null,            // hẹn giờ đang chờ kết quả một yêu cầu nạp tiền
  };

  const ROLE_LABEL = { BUYER: 'Người mua', SELLER: 'Người bán', ADMIN: 'Quản trị viên' };

  // Ánh xạ trạng thái của lõi Escrow sang ngôn ngữ nghiệp vụ mua bán.
  // `tone` là class Tag của DS — Tag luôn viền, không bao giờ tô đặc.
  const STATUS_UI = {
    CREATED:      { label: 'Chờ thanh toán',               tone: 'tag-warning' },
    SECURED:      { label: 'Đã thanh toán',                tone: 'tag-info' },
    SHIPPING:     { label: 'Đang giao',                    tone: 'tag-info' },
    WAIT_CONFIRM: { label: 'Đã nhận hàng · chờ xác nhận',  tone: 'tag-warning' },
    COMPLETED:    { label: 'Hoàn tất',                     tone: 'tag-success' },
    RELEASED:     { label: 'Hoàn tất theo phân xử',        tone: 'tag-success' },
    REFUNDED:     { label: 'Đã hoàn tiền',                 tone: 'tag-success' },
    DISPUTED:     { label: 'Đang tranh chấp',              tone: 'tag-danger' },
  };

  const ESCROW_UI = {
    NONE:     'Chưa thanh toán',
    LOCKED:   'Ký quỹ đang giữ',
    FROZEN:   'Đóng băng do tranh chấp',
    RELEASED: 'Đã giải ngân cho người bán',
    REFUNDED: 'Đã hoàn cho người mua',
  };

  const SELLER_REQUEST_UI = {
    PENDING:  { label: 'Đang chờ duyệt', tone: 'tag-warning' },
    APPROVED: { label: 'Đã được duyệt',  tone: 'tag-success' },
    REJECTED: { label: 'Bị từ chối',     tone: 'tag-danger' },
  };

  // Nhãn tiếng Việt cho từng loại sự kiện an toàn — khớp EVENTS trong lib/securityEvents.js.
  // Nhóm trên là các lần bị TỪ CHỐI, nhóm dưới là thao tác nhạy cảm THÀNH CÔNG.
  const SECURITY_EVENT_LABEL = {
    LOGIN_PASSWORD_FAILED: 'Đăng nhập bằng mật khẩu sai',
    LOGIN_PASSKEY_FAILED: 'Đăng nhập bằng Passkey thất bại',
    REAUTH_REQUIRED: 'Thiếu xác thực lại bắt buộc',
    REAUTH_FAILED: 'Xác thực lại thất bại',
    CHALLENGE_REPLAY: 'Challenge bị dùng lại',
    CHALLENGE_EXPIRED: 'Challenge đã hết hạn',
    ORIGIN_OR_SIGNATURE_REJECTED: 'Sai origin hoặc chữ ký',
    CONTEXT_MISMATCH: 'Ngữ cảnh uỷ quyền không khớp',
    INVALID_STATE: 'Sai trạng thái giao dịch',
    FORBIDDEN: 'Không đủ quyền',
    ACCOUNT_SETUP_INCOMPLETE: 'Tài khoản chưa hoàn tất đăng ký',
    IDEMPOTENCY_CONFLICT: 'Xung đột mã yêu cầu',
    RATE_LIMITED: 'Bị giới hạn tần suất',
    ACCOUNT_ACTIVATED: 'Tài khoản được kích hoạt',
    PASSWORD_CHANGED: 'Đổi mật khẩu',
    CREDENTIAL_ADDED: 'Thêm Passkey',
    CREDENTIAL_REMOVED: 'Xoá Passkey',
    ADMIN_BOOTSTRAP_PASSWORD_CHANGED: 'Đổi mật khẩu khởi tạo quản trị',
    ADMIN_ADJUDICATION: 'Quản trị viên phân xử tranh chấp',
    WEBHOOK_INVALID_SIGNATURE: 'Webhook nạp tiền sai chữ ký',
    WEBHOOK_CONFLICT: 'Webhook trái với kết quả đã tất toán',
    RECONCILE_CONFLICT: 'Đối soát: provider báo kết quả khác',
    COUNTER_ANOMALY: 'signCount của Passkey bất thường',
    TOPUP_SUCCEEDED: 'Nạp tiền thành công',
    TOPUP_FAILED: 'Nạp tiền thất bại',
  };

  const PAYMENT_UI = {
    PENDING:   { label: 'Đang xử lý',          tone: 'tag-warning' },
    SUCCEEDED: { label: 'Thành công',          tone: 'tag-success' },
    FAILED:    { label: 'Thất bại',            tone: 'tag-danger' },
  };
  const RESOLVED_BY_LABEL = { WEBHOOK: 'qua webhook', RECONCILER: 'qua đối soát tự động' };

  // =====================================================================
  // Tiện ích
  // =====================================================================

  function safeParse(s) { try { return JSON.parse(s); } catch (_) { return null; } }

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function money(n) { return Number(n || 0).toLocaleString('vi-VN') + '₫'; }

  function fmtDay(ymd) {
    if (!ymd) return '—';
    const [y, m, d] = String(ymd).slice(0, 10).split('-');
    return `${d}/${m}/${y}`;
  }

  function fmtDateTime(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function todayYmd() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function newRequestId() {
    return (crypto.randomUUID && crypto.randomUUID()) || 'req-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  }

  function initials(name) {
    return String(name || '?').trim().split(/\s+/).slice(-2).map((w) => w[0]).join('').toUpperCase();
  }

  function $(sel, root) { return (root || document).querySelector(sel); }

  // Access token sống ngắn; khi hết hạn thì xin token mới bằng cookie làm mới (HttpOnly, trang
  // không đọc được). Nhiều request cùng gặp 401 thì chỉ làm mới một lần.
  let refreshing = null;
  function refreshSession() {
    if (!refreshing) {
      refreshing = (async () => {
        try {
          const res = await fetch('/api/passkeys/session/refresh', { method: 'POST', credentials: 'same-origin' });
          if (!res.ok) return false;
          const data = await res.json();
          if (!data.token) return false;
          setSession(data.token, { ...(state.user || {}), ...data.user });
          return true;
        } catch (_) {
          return false;
        }
      })();
      refreshing.finally(() => { refreshing = null; });
    }
    return refreshing;
  }

  async function api(path, { method = 'GET', body } = {}, retried = false) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (state.token) headers['Authorization'] = 'Bearer ' + state.token;

    const res = await fetch('/api' + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));

    if (res.status === 401 && data.error === 'UNAUTHENTICATED' && state.token) {
      if (!retried && await refreshSession()) return api(path, { method, body }, true);
      clearSession();
      renderChrome();
      route();
      throw new Error('Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại');
    }
    if (!res.ok) {
      const err = new Error(data.message || data.error || `Lỗi HTTP ${res.status}`);
      err.code = data.error;
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function toast(message, kind = 'info') {
    const glyph = kind === 'ok' ? 'circle-check' : kind === 'err' ? 'circle-alert' : 'info';
    const box = $('#toasts');
    const el = document.createElement('div');
    el.className = 'toast ' + kind;
    el.innerHTML = `${ico(glyph, 18)}<span class="grow">${esc(message)}</span>`;
    box.appendChild(el);
    setTimeout(() => el.remove(), kind === 'err' ? 8000 : 5000);
  }

  /** Bọc một handler async: khoá nút, hiện spinner, bắt lỗi thành toast. */
  async function guard(key, btn, fn, successMsg) {
    if (state.busy.has(key)) return;
    state.busy.add(key);
    const original = btn ? btn.innerHTML : null;
    if (btn) { btn.disabled = true; btn.innerHTML = ico('loader-circle', 17, 'spin') + ' Đang xử lý…'; }
    try {
      const result = await fn();
      if (successMsg) toast(successMsg, 'ok');
      return result;
    } catch (e) {
      toast(e.message, 'err');
      throw e;
    } finally {
      state.busy.delete(key);
      if (btn && btn.isConnected) { btn.disabled = false; btn.innerHTML = original; }
    }
  }

  // =====================================================================
  // Dịch lỗi WebAuthn sang ngôn ngữ người dùng
  // =====================================================================
  //
  // Trình duyệt cố tình trả về thông báo mơ hồ, và đó là CHỦ Ý của đặc tả: nếu phân biệt
  // được "không có passkey nào" với "người dùng bấm huỷ" thì một trang bất kỳ có thể dò xem
  // máy này đang giữ passkey của những dịch vụ nào. Cái giá phải trả là người dùng nhận một
  // câu vô nghĩa như "The operation either timed out or was not allowed".
  //
  // Vì vậy việc diễn giải phải do ứng dụng làm, dựa trên NGỮ CẢNH — cùng một mã lỗi
  // NotAllowedError mang ý nghĩa khác nhau ở lúc đăng nhập, lúc gắn passkey và lúc xác thực
  // lại để chuyển tiền. Nguyên văn lỗi kỹ thuật được ghi ra console cho người phát triển,
  // không đưa lên giao diện.

  const WEBAUTHN_HINTS = {
    login: {
      NotAllowedError:
        'Không đăng nhập được bằng Passkey. Thiết bị này chưa có Passkey nào cho Enclave, ' +
        'hoặc bạn đã bấm huỷ, hoặc để quá lâu. Hãy đăng nhập bằng mật khẩu ở phía dưới.',
    },
    enroll: {
      NotAllowedError:
        'Chưa gắn được Passkey. Bạn đã bấm huỷ ở cửa sổ xác minh, hoặc để quá lâu. ' +
        'Bấm lại và hoàn tất bước vân tay, Face ID hoặc mã PIN của thiết bị.',
      InvalidStateError:
        'Thiết bị này đã có sẵn một Passkey của tài khoản khác trên Enclave. ' +
        'Hãy chọn "Dùng thiết bị khác" trong cửa sổ của trình duyệt, hoặc tạo Passkey mới cho tài khoản này.',
      ConstraintError:
        'Thiết bị chưa bật khoá màn hình (vân tay, Face ID hoặc mã PIN). ' +
        'Passkey đầu tiên bắt buộc phải có bước xác minh này, hãy bật rồi thử lại.',
    },
    'add-device': {
      NotAllowedError:
        'Chưa thêm được thiết bị. Bạn đã bấm huỷ hoặc để quá lâu ở cửa sổ xác minh.',
      InvalidStateError:
        'Thiết bị này đã được đăng ký cho tài khoản của bạn rồi. Hãy dùng một thiết bị khác.',
    },
    reauth: {
      NotAllowedError:
        'Chưa xác thực lại được. Bạn đã bấm huỷ, để quá lâu, hoặc đã chọn một Passkey không ' +
        'thuộc tài khoản đang đăng nhập. Thao tác này bắt buộc phải xác thực lại, không bỏ qua được.',
      ConstraintError:
        'Thiết bị không thực hiện được bước xác minh người dùng (vân tay, Face ID hoặc mã PIN). ' +
        'Thao tác chạm tới tiền bắt buộc phải có bước này.',
    },
  };

  const WEBAUTHN_COMMON = {
    SecurityError:
      'Địa chỉ trang không khớp với cấu hình Passkey của hệ thống. ' +
      'Hãy mở đúng địa chỉ http://localhost:3000 (không dùng 127.0.0.1 hay địa chỉ IP).',
    NotSupportedError:
      'Trình duyệt hoặc thiết bị này không hỗ trợ Passkey. Hãy dùng Chrome, Edge hoặc Safari bản mới.',
    AbortError: 'Thao tác đã bị dừng giữa chừng. Hãy thử lại.',
  };

  /**
   * Bọc một lời gọi WebAuthn và đổi lỗi thô thành câu người dùng hiểu được.
   * @param kind login | enroll | add-device | reauth
   */
  async function webauthn(kind, fn) {
    try {
      return await fn();
    } catch (e) {
      // Nguyên văn giữ lại cho người phát triển; giao diện chỉ nhận câu đã diễn giải.
      console.error(`[webauthn:${kind}]`, e && e.name, e && e.message);
      const byKind = WEBAUTHN_HINTS[kind] || {};
      const message = byKind[e && e.name] || WEBAUTHN_COMMON[e && e.name];
      if (message) throw new Error(message);
      throw new Error(
        'Thiết bị xác thực không hoàn tất được thao tác. Hãy thử lại; nếu vẫn lỗi, ' +
        'kiểm tra xem trình duyệt đã bật Passkey và thiết bị đã bật khoá màn hình chưa.'
      );
    }
  }

  // =====================================================================
  // Modal
  // =====================================================================

  // dismissible=false dùng cho màn hình hoàn tất thiết lập tài khoản: bỏ nút đóng và bỏ
  // việc bấm ra ngoài để tắt, vì phiên lúc đó chưa gọi được chức năng nào — đóng modal chỉ
  // dẫn người dùng tới một màn hình trống rồi lỗi 403.
  function openModal({ title, body, footer = '', wide = false, dismissible = true }) {
    closeModal();
    const root = $('#modalRoot');
    root.innerHTML = `
      <div class="modal-backdrop"${dismissible ? ' data-act="modal-backdrop"' : ''}>
        <div class="modal${wide ? ' wide' : ''}" role="dialog" aria-modal="true">
          <div class="modal-head">
            <h2>${esc(title)}</h2>
            ${dismissible ? `<button class="icon-btn" data-act="modal-close" aria-label="Đóng">${ico('x', 18)}</button>` : ''}
          </div>
          <div class="modal-body">${body}</div>
          ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
        </div>
      </div>`;
    const firstInput = root.querySelector('input, select, textarea');
    if (firstInput) firstInput.focus();
    return root;
  }

  function closeModal() { $('#modalRoot').innerHTML = ''; }

  // =====================================================================
  // Phiên đăng nhập
  // =====================================================================

  function setSession(token, user) {
    state.token = token;
    state.user = user;
    localStorage.setItem(STORAGE_TOKEN, token);
    localStorage.setItem(STORAGE_USER, JSON.stringify(user));
  }

  function clearSession() {
    state.token = null;
    state.user = null;
    state.wallet = null;
    state.sellerRequest = null;
    state.unread = 0;
    localStorage.removeItem(STORAGE_TOKEN);
    localStorage.removeItem(STORAGE_USER);
  }

  async function refreshWallet() {
    if (!state.token || !state.user || state.user.role === 'ADMIN') { state.wallet = null; return; }
    try {
      state.wallet = await api('/wallets/me');
    } catch (_) {
      state.wallet = null;
    }
  }

  /** Số thông báo chưa đọc. Lỗi mạng thì giữ số cũ — huy hiệu không phải thứ đáng làm hỏng trang. */
  async function refreshUnread() {
    if (!state.token || !state.user || state.user.accountStatus && state.user.accountStatus !== 'ACTIVE') {
      state.unread = 0;
      return;
    }
    try {
      const { unreadCount } = await api('/notifications?limit=1');
      state.unread = unreadCount;
    } catch (_) { /* giữ nguyên */ }
  }

  /** Chỉ Người mua mới có khái niệm "yêu cầu mở cửa hàng". */
  async function refreshSellerRequest() {
    if (!state.token || !state.user || state.user.role !== 'BUYER') { state.sellerRequest = null; return; }
    try {
      const { request } = await api('/users/me/seller-request');
      state.sellerRequest = request;
    } catch (_) {
      state.sellerRequest = null;
    }
  }

  function logout() {
    // Thu hồi phiên ở máy chủ, không chỉ xoá token trong trình duyệt. Lỗi mạng thì vẫn đăng xuất
    // phía máy khách; phiên ở máy chủ sẽ tự hết hạn.
    const token = state.token;
    fetch('/api/passkeys/session/logout', {
      method: 'POST',
      credentials: 'same-origin',
      headers: token ? { Authorization: 'Bearer ' + token } : {},
    }).catch(() => {});
    clearSession();
    toast('Đã đăng xuất', 'ok');
    location.hash = '#/';
    renderChrome();
    route();
  }

  // ---------- Modal xác thực ----------

  // Mô hình xác thực LAI.
  //
  // Đăng nhập có hai lối, mật khẩu hoặc Passkey, và cả hai cấp CÙNG một loại phiên. Ranh
  // giới không nằm ở chỗ đăng nhập bằng gì, mà nằm ở chiều tiền đi ra: mọi thao tác làm
  // tiền rời khỏi ký quỹ và mọi thay đổi thông tin xác thực đều phải xác thực lại bằng
  // Passkey, kể cả khi phiên hiện tại được tạo bằng chính Passkey.
  //
  // Giao diện chỉ dẫn đường; MỌI phép kiểm đều nằm ở máy chủ. Ẩn một nút không phải là
  // một biện pháp an toàn.

  function openAuthModal(tab = 'login') {
    openModal({
      title: 'Enclave',
      body: `
        <div class="tabs tabs-split" id="authTabs" style="margin-bottom:var(--s-5)">
          <button data-act="auth-tab" data-tab="login">Đăng nhập</button>
          <button data-act="auth-tab" data-tab="register">Đăng ký</button>
        </div>
        <div id="authPanel"></div>`,
    });
    switchAuthTab(tab);
  }

  function switchAuthTab(tab) {
    document.querySelectorAll('#authTabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    const panel = $('#authPanel');
    if (!panel) return;

    if (tab === 'login') {
      // Lối Passkey không cần nhập tên đăng nhập: bộ xác thực tự liệt kê passkey của trang
      // này, nên máy chủ không phải tiết lộ tài khoản nào tồn tại trước khi người dùng
      // chứng minh được quyền sở hữu. Người mua, người bán và quản trị viên dùng chung
      // đúng hai nút này.
      panel.innerHTML = `
        <div class="stack">
          <button class="btn btn-primary btn-block btn-lg" data-act="do-login-passkey">
            ${ico('key-round', 17)} Đăng nhập bằng Passkey
          </button>

          <div class="hr-text"><span>hoặc</span></div>

          <div class="field">
            <label for="loginUsername">Tên đăng nhập</label>
            <input id="loginUsername" type="text" autocomplete="username">
          </div>
          <div class="field">
            <label for="loginPassword">Mật khẩu</label>
            <input id="loginPassword" type="password" autocomplete="current-password">
          </div>
          <button class="btn btn-block btn-lg" data-act="do-login-password">Đăng nhập</button>
        </div>`;
    } else {
      // Đăng ký ở đây LUÔN tạo tài khoản Người mua và không nhận bất kỳ tham số nào ảnh
      // hưởng tới quyền. Muốn làm người bán thì đăng ký bình thường rồi vào mục "Mở cửa hàng"
      // ở trang chủ gửi yêu cầu cho quản trị viên.
      panel.innerHTML = `
        <div class="stack">
          <div class="field">
            <label for="regUsername">Tên đăng nhập</label>
            <input id="regUsername" type="text" autocomplete="username">
            <span class="hint">3–32 ký tự, chữ thường, số và . _ -</span>
          </div>
          <div class="field">
            <label for="regDisplayName">Tên hiển thị</label>
            <input id="regDisplayName" type="text" autocomplete="name">
          </div>
          <div class="field">
            <label for="regPassword">Mật khẩu</label>
            <input id="regPassword" type="password" autocomplete="new-password">
            <span class="hint">Ít nhất 8 ký tự</span>
          </div>

          <button class="btn btn-primary btn-block btn-lg" data-act="do-register">Tạo tài khoản</button>
        </div>`;
    }
  }

  /**
   * Màn hình hoàn tất thiết lập tài khoản.
   *
   * Hiện ra khi phiên đang ở phạm vi hạn chế: tài khoản đã có mật khẩu nhưng chưa có
   * Passkey (PENDING_PASSKEY), hoặc là quản trị viên vừa khởi tạo còn dùng mật khẩu tạm
   * (PENDING_BOOTSTRAP). Ở hai trạng thái này máy chủ từ chối mọi chức năng nghiệp vụ, nên
   * giao diện cũng không dẫn đi đâu khác.
   */
  function openSetupModal(user, note) {
    const bootstrap = user.accountStatus === 'PENDING_BOOTSTRAP';
    openModal({
      title: bootstrap ? 'Đổi mật khẩu tạm' : 'Gắn Passkey',
      dismissible: false,
      body: `
        <div class="stack">
          <p class="muted" style="margin:0">${note || (bootstrap
            ? 'Đặt mật khẩu riêng của bạn để tiếp tục.'
            : 'Bước cuối để kích hoạt tài khoản.')}</p>

          ${bootstrap ? `
            <div class="field">
              <label for="bootCurrent">Mật khẩu tạm</label>
              <input id="bootCurrent" type="password" autocomplete="current-password">
            </div>
            <div class="field">
              <label for="bootNew">Mật khẩu mới</label>
              <input id="bootNew" type="password" autocomplete="new-password">
              <span class="hint">Ít nhất 8 ký tự</span>
            </div>
            <button class="btn btn-primary btn-block btn-lg" data-act="do-bootstrap-password">Tiếp tục</button>
          ` : `
            <button class="btn btn-primary btn-block btn-lg" data-act="do-enroll-passkey">
              ${ico('key-round', 17)} Gắn Passkey
            </button>
          `}

          <button class="btn btn-ghost btn-block" data-act="do-logout">Để lúc khác</button>
        </div>`,
    });
  }

  /**
   * Xử lý chung sau khi máy chủ cấp một phiên.
   *
   * Nếu tài khoản chưa hoàn tất thiết lập thì dừng lại ở màn hình hoàn tất, không vào ứng
   * dụng — đúng với việc máy chủ sẽ từ chối mọi tuyến nghiệp vụ của phiên đó.
   */
  async function afterSession(result, greeting) {
    setSession(result.token, result.user);
    if (result.user.accountStatus && result.user.accountStatus !== 'ACTIVE') {
      renderChrome();
      openSetupModal(result.user);
      return false;
    }
    await refreshWallet();
    await refreshSellerRequest();
    closeModal();
    if (greeting) toast(greeting, 'ok');
    renderChrome();
    route();
    return true;
  }

  async function doRegister(btn) {
    const username = $('#regUsername').value.trim();
    const displayName = $('#regDisplayName').value.trim();
    const password = $('#regPassword').value;
    if (!username || !displayName) return toast('Vui lòng nhập tên đăng nhập và tên hiển thị', 'err');
    if (!password) return toast('Vui lòng đặt mật khẩu', 'err');

    await guard('register', btn, async () => {
      const result = await api('/passkeys/register/account', {
        method: 'POST', body: { username, displayName, password },
      });
      setSession(result.token, result.user);
      renderChrome();
      openSetupModal(result.user, 'Bước cuối để kích hoạt tài khoản và mở ví.');
    });
  }

  /** Bước 2 của đăng ký, dùng chung cho cả người dùng thường lẫn quản trị viên bootstrap. */
  async function doEnrollPasskey(btn) {
    await guard('enroll', btn, async () => {
      const { registrationSessionId, options } = await api('/passkeys/register/passkey/options', {
        method: 'POST', body: {},
      });
      const attResp = await webauthn('enroll', () =>
        SimpleWebAuthnBrowser.startRegistration({ optionsJSON: options }));
      const result = await api('/passkeys/register/passkey/verify', {
        method: 'POST', body: { registrationSessionId, response: attResp },
      });
      await afterSession(result,
        `Chào mừng ${result.user.displayName}. Bạn đang là ${ROLE_LABEL[result.user.role]}.`);
      location.hash = consoleHome(result.user.role);
      route();
    });
  }

  /** Ngoại lệ khởi tạo: đổi mật khẩu tạm của quản trị viên, khi chưa có credential nào. */
  async function doBootstrapPassword(btn) {
    const currentPassword = $('#bootCurrent').value;
    const newPassword = $('#bootNew').value;
    if (!currentPassword || !newPassword) return toast('Nhập cả mật khẩu tạm và mật khẩu mới', 'err');

    await guard('bootpw', btn, async () => {
      const result = await api('/passkeys/bootstrap/password', {
        method: 'POST', body: { currentPassword, newPassword },
      });
      setSession(result.token, result.user);
      openSetupModal(result.user, 'Bước cuối để kích hoạt quyền quản trị.');
    });
  }

  async function doLoginPasskey(btn) {
    await guard('login', btn, async () => {
      const { authenticationSessionId, options } = await api('/passkeys/login/options', { method: 'POST' });
      const assertion = await webauthn('login', () =>
        SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: options }));
      const result = await api('/passkeys/login/verify', {
        method: 'POST', body: { authenticationSessionId, response: assertion },
      });
      await afterSession(result, `Xin chào ${result.user.displayName}`);
    });
  }

  async function doLoginPassword(btn) {
    const username = ($('#loginUsername').value || '').trim();
    const password = $('#loginPassword').value;
    if (!username || !password) return toast('Nhập tên đăng nhập và mật khẩu', 'err');

    await guard('loginpw', btn, async () => {
      const result = await api('/passkeys/login/password', { method: 'POST', body: { username, password } });
      await afterSession(result, `Xin chào ${result.user.displayName}`);
    });
  }

  // =====================================================================
  // Khung trang — header chợ, menu "Tài khoản của tôi"
  // =====================================================================

  /** Khu "store" (trang chủ, tin đăng) chạy toàn chiều rộng; khu tài khoản có menu bên trái. */
  const STORE_HEADS = new Set(['', 'listing']);

  function currentHead() {
    const hash = (location.hash || '#/').replace(/^#/, '');
    return hash.split('?')[0].split('/').filter(Boolean)[0] || '';
  }

  function currentArea() { return STORE_HEADS.has(currentHead()) ? 'store' : 'console'; }

  function consoleHome(role) {
    const r = role || (state.user && state.user.role);
    if (r === 'ADMIN') return '#/admin/disputes';
    if (r === 'BUYER' || r === 'SELLER') return '#/orders';
    return '#/';
  }

  /** Menu "Tài khoản của tôi" — danh sách phẳng icon + nhãn, như Shopee/eBay. */
  function sidebarItems() {
    const role = state.user && state.user.role;
    const orders = { icon: 'receipt', title: 'Giao dịch của tôi', href: '#/orders' };
    const inbox = {
      icon: 'bell', title: 'Thông báo & việc cần làm',
      desc: state.unread ? `${state.unread} thông báo chưa đọc` : '', href: '#/notifications',
    };
    const wallet = { icon: 'wallet', title: 'Ví & nạp tiền', href: '#/wallet' };
    const security = { icon: 'shield-check', title: 'Bảo mật tài khoản', desc: 'Passkey và mật khẩu', href: '#/security' };
    const audit = { icon: 'link-2', title: 'Kiểm chứng nhật ký', href: '#/audit' };

    if (role === 'BUYER') return [orders, inbox, wallet, security, audit];
    if (role === 'SELLER') {
      return [orders, { icon: 'store', title: 'Tin đăng của tôi', href: '#/shop' }, inbox, wallet, security, audit];
    }
    if (role === 'ADMIN') return [
      { icon: 'gavel', title: 'Tranh chấp', href: '#/admin/disputes' },
      inbox,
      { icon: 'store', title: 'Yêu cầu mở cửa hàng', href: '#/admin/seller-requests' },
      { icon: 'users', title: 'Người dùng', href: '#/admin/users' },
      { icon: 'badge-check', title: 'Bất biến hệ thống', desc: 'Chín tính chất phải luôn đúng', href: '#/admin/invariants' },
      { icon: 'triangle-alert', title: 'Sự kiện bảo mật', href: '#/admin/security-events' },
      security,
      audit,
    ];
    return [];
  }

  function isNavActive(href, here) {
    if (href === '#/admin/disputes') return here === '#/admin' || here.startsWith('#/admin/disputes');
    return here === href || here.startsWith(href + '/');
  }

  function renderChrome() {
    const here = (location.hash || '#/').split('?')[0];
    const showSidebar = currentArea() === 'console' && !!state.user;
    $('#app').setAttribute('data-sidebar', showSidebar ? 'on' : 'off');

    const search = $('#topSearchInput');
    if (search && document.activeElement !== search) search.value = state.filters.q || '';

    $('#sidebar').innerHTML = showSidebar
      ? `<div class="sidebar-label">Tài khoản của tôi</div>` +
        sidebarItems().map((it) => `
          <a class="nav-item ${isNavActive(it.href, here) ? 'active' : ''}" href="${it.href}">
            ${ico(it.icon, 18)}
            <span class="nav-item-text">
              <span class="nav-item-title">${esc(it.title)}</span>
              ${it.desc ? `<span class="nav-item-desc">${esc(it.desc)}</span>` : ''}
            </span>
          </a>`).join('')
      : '';

    // Header: Logo | Tìm kiếm | Đăng bán | Giao dịch | Tài khoản
    if (!state.user) {
      $('#topbarActions').innerHTML = `
        <button class="top-link" data-act="open-sell">${ico('tag', 17)} <span class="lbl">Đăng bán</span></button>
        <button class="top-link" data-act="open-auth">${ico('key-round', 17)} <span class="lbl">Đăng nhập</span></button>
        <button class="top-link solid" data-act="open-auth-register">Đăng ký</button>`;
      return;
    }

    const role = state.user.role;
    const unread = state.unread > 99 ? '99+' : state.unread;
    const balance = state.wallet
      ? `<a class="balance-chip" href="#/wallet" title="Số dư khả dụng — bấm để xem ví và nạp tiền">
           <b>${money(state.wallet.availableBalance)}</b><span>Số dư ví</span>
         </a>`
      : '';

    $('#topbarActions').innerHTML = `
      ${role !== 'ADMIN' ? `<button class="top-link solid" data-act="open-sell">${ico('tag', 17)} <span class="lbl">Đăng bán</span></button>` : ''}
      <a class="top-link" href="${role === 'ADMIN' ? '#/admin/disputes' : '#/orders'}">
        ${ico(role === 'ADMIN' ? 'gavel' : 'receipt', 17)} <span class="lbl">${role === 'ADMIN' ? 'Quản trị' : 'Giao dịch'}</span>
      </a>
      <a class="icon-btn on-chrome notify-btn" href="#/notifications"
         aria-label="Thông báo${state.unread ? ` — ${state.unread} chưa đọc` : ''}" title="Thông báo & việc cần làm">
        ${ico('bell', 19)}
        ${state.unread ? `<span class="badge-count">${unread}</span>` : ''}
      </a>
      ${balance}
      <a class="user-chip" href="${consoleHome()}" title="Tài khoản của tôi">
        <span class="avatar" aria-hidden="true">${esc(initials(state.user.displayName))}</span>
        <span class="user-chip-text">
          <span class="user-chip-name">${esc(state.user.displayName)}</span>
          <span class="role-pill">${esc(ROLE_LABEL[role])}</span>
        </span>
      </a>
      <button class="icon-btn on-chrome" data-act="logout" aria-label="Đăng xuất" title="Đăng xuất">${ico('log-out', 19)}</button>`;
  }

  /**
   * Nút "Đăng bán" ở header dẫn tới đúng bước tiếp theo của từng người: khách thì đăng ký,
   * người mua thì xin quyền bán (lối DUY NHẤT để thành người bán), người bán thì đăng tin.
   */
  function openSell() {
    if (!state.user) return openAuthModal('register');
    if (state.user.role === 'SELLER') return openNewListing();
    const req = state.sellerRequest;
    if (req && req.status === 'PENDING') {
      return toast(`Yêu cầu mở cửa hàng "${req.shopName}" đang chờ quản trị viên duyệt.`);
    }
    return openSellerRequestModal();
  }


  // =====================================================================
  // Thành phần dùng lại
  // =====================================================================

  function categoryOf(key) {
    return (state.meta && (state.meta.categories || []).find((c) => c.key === key)) || null;
  }
  function categoryLabel(key) { const c = categoryOf(key); return c ? c.label : (key || '—'); }
  function categoryIcon(key) { const c = categoryOf(key); return (c && c.icon) || 'package'; }

  // Mỗi ngành hàng một tông màu riêng cho khung ảnh placeholder — thay cho ô xám đồng loạt,
  // để lưới sản phẩm trông có sức sống dù chưa có ảnh thật. Màu chỉ mang tính trang trí/phân
  // loại, không trùng với các màu mang nghĩa trạng thái (cam = hành động, xanh lục = ký quỹ).
  const CATEGORY_TINT = {
    DIEN_THOAI: { bg: '#EAF1FE', ink: '#2F6FE4' },
    MAY_TINH:   { bg: '#EFECFB', ink: '#6A4FD1' },
    DIEN_TU:    { bg: '#E3F6F8', ink: '#0E8FA6' },
    MAY_ANH:    { bg: '#EEF1F5', ink: '#4A5568' },
    THOI_TRANG: { bg: '#FBE8EF', ink: '#D23A72' },
    GIA_DUNG:   { bg: '#FBF0E1', ink: '#B06A12' },
    SACH:       { bg: '#E3F5EC', ink: '#118059' },
    THE_THAO:   { bg: '#FCE9E9', ink: '#D1393B' },
    SUU_TAM:    { bg: '#F3E8FC', ink: '#8938CC' },
  };
  function categoryTint(key) { return CATEGORY_TINT[key] || { bg: '#F2F2F2', ink: '#8A8A8A' }; }
  function conditionLabel(key) {
    const c = state.meta && (state.meta.conditions || []).find((x) => x.key === key);
    return c ? c.label : (key || '—');
  }
  // Tông màu theo tình trạng sản phẩm, dùng cho nhãn nổi trên ảnh — "Mới" nổi bật nhất
  // (xanh lá), "Đã dùng nhiều" trầm nhất (vàng cam), tái dùng đúng bộ màu .tag đã có sẵn.
  const CONDITION_TONE = { NEW: 'tag-success', LIKE_NEW: 'tag-info', GOOD: 'tag-navy', FAIR: 'tag-warning' };
  function conditionTone(key) { return CONDITION_TONE[key] || ''; }

  /** "vừa đăng", "3 giờ trước", "2 ngày trước" — kiểu hiển thị thời gian của các chợ C2C. */
  function relTime(iso) {
    if (!iso) return '';
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'vừa xong';
    if (s < 3600) return `${Math.floor(s / 60)} phút trước`;
    if (s < 86400) return `${Math.floor(s / 3600)} giờ trước`;
    if (s < 86400 * 30) return `${Math.floor(s / 86400)} ngày trước`;
    return fmtDay(iso);
  }

  function shortId(id) { return String(id || '').slice(0, 8).toUpperCase(); }

  /**
   * Ảnh sản phẩm. Hệ thống chưa có chức năng tải ảnh lên (README — hạn chế đã biết), nên hiện ô
   * giữ chỗ trung tính theo ngành hàng, như cách các chợ hiển thị tin chưa có ảnh.
   */
  function productImage(l, { sold = false, size = 56, tinted = true } = {}) {
    const label = sold ? listingStatus(l).label : '';
    const tint = tinted ? categoryTint(l && l.category) : null;
    const style = tint ? ` style="background:${tint.bg}; color:${tint.ink}"` : '';
    return `<div class="pimg ${sold ? 'is-sold' : ''}"${style} ${sold ? `data-label="${esc(label)}"` : ''} aria-hidden="true">${ico(categoryIcon(l && l.category), size)}</div>`;
  }

  /** Trạng thái của một tin đăng theo góc nhìn người mua. */
  function listingStatus(l) {
    if (l.visibility === 'HIDDEN') return { label: 'Đang ẩn', tone: '' };
    if (l.isSold) {
      return ['COMPLETED', 'RELEASED'].includes(l.soldStatus)
        ? { label: 'Đã bán', tone: 'tag-danger' }
        : { label: 'Đã có người mua', tone: 'tag-warning' };
    }
    return { label: 'Đang bán', tone: 'tag-success' };
  }

  function banner(title, subtitle, actions = '') {
    return `
      <div class="banner">
        <div class="banner-text">
          <h1>${esc(title)}</h1>
          ${subtitle ? `<p>${esc(subtitle)}</p>` : ''}
        </div>
        ${actions ? `<div class="banner-actions">${actions}</div>` : ''}
      </div>`;
  }

  /**
   * Lời mời bán hàng ở trang chủ — lối vào DUY NHẤT để trở thành người bán: gửi yêu cầu,
   * quản trị viên duyệt, chính tài khoản đang dùng được nâng lên (giữ nguyên ví, passkey,
   * lịch sử mua).
   */
  function shopCta() {
    const role = state.user && state.user.role;
    if (role === 'SELLER' || role === 'ADMIN') return '';

    const req = state.sellerRequest;
    let action;
    let extra = '';
    if (!state.user) {
      action = `<button class="btn btn-primary" data-act="open-auth-register">${ico('store', 17)} Đăng ký để bán hàng</button>`;
    } else if (req && req.status === 'PENDING') {
      action = `<span class="tag tag-warning">${ico('history', 14)} Yêu cầu đang chờ duyệt</span>`;
    } else if (req && req.status === 'REJECTED') {
      action = `<button class="btn btn-primary" data-act="open-seller-request">${ico('refresh-cw', 17)} Gửi lại yêu cầu</button>`;
      extra = `
        <div class="note note-danger" style="margin-top:var(--s-3)">
          ${ico('circle-alert', 18)}
          <span>Yêu cầu trước bị từ chối${req.reviewedAt ? ' lúc ' + fmtDateTime(req.reviewedAt) : ''}.
            Lý do: <b>${esc(req.reviewNote || 'không ghi')}</b></span>
        </div>`;
    } else {
      action = `<button class="btn btn-primary" data-act="open-seller-request">${ico('store', 17)} Mở cửa hàng</button>`;
    }

    return `
      <div class="card"><div class="card-body">
        <div class="row-between">
          <div class="row" style="flex-wrap:nowrap;gap:var(--s-3)">
            <span class="ico-box" style="background:var(--primary-soft);color:var(--primary)">${ico('tag', 22)}</span>
            <div>
              <h3 style="margin:0">Có đồ không dùng tới? Đăng bán ngay</h3>
              <p class="muted small" style="margin:2px 0 0">Gửi yêu cầu mở cửa hàng; quản trị viên duyệt xong thì chính tài khoản
                này được nâng lên người bán — giữ nguyên ví, passkey và lịch sử mua.</p>
            </div>
          </div>
          <div>${action}</div>
        </div>
        ${extra}
      </div></div>`;
  }

  function openSellerRequestModal() {
    const req = state.sellerRequest;
    openModal({
      title: 'Đăng ký bán hàng',
      body: `
        <div class="stack">
          <div class="note">
            ${ico('shield-check', 18)}
            <span>Tài khoản <b>${esc(state.user.displayName)}</b> sẽ được nâng lên <b>Người bán</b> sau khi quản trị
              viên duyệt. Bạn không phải tạo tài khoản mới và không mất số dư đang có.</span>
          </div>
          <div class="field">
            <label for="srShopName">Tên cửa hàng *</label>
            <input id="srShopName" type="text" maxlength="60" placeholder="Nhập tên cửa hàng..."
                   value="${esc(req && req.status === 'REJECTED' ? req.shopName : '')}">
            <span class="hint">2–60 ký tự. Người mua sẽ thấy tên này.</span>
          </div>
          <div class="field">
            <label for="srPitch">Bạn định bán những gì</label>
            <textarea id="srPitch" maxlength="1000" placeholder="Loại hàng, tình trạng, số lượng dự kiến...">${esc(req && req.status === 'REJECTED' ? (req.pitch || '') : '')}</textarea>
          </div>
        </div>`,
      footer: `
        <button class="btn" data-act="modal-close">Huỷ</button>
        <button class="btn btn-primary" data-act="do-seller-request">Gửi yêu cầu</button>`,
    });
  }

  async function submitSellerRequest(btn) {
    const shopName = $('#srShopName').value.trim();
    const pitch = $('#srPitch').value.trim();
    if (shopName.length < 2) return toast('Tên cửa hàng phải từ 2 ký tự trở lên', 'err');

    await guard('seller-request', btn, () => api('/users/me/seller-request', {
      method: 'POST', body: { shopName, pitch },
    }), 'Đã gửi yêu cầu. Kết quả sẽ hiện ở trang chủ và trong thông báo.');

    closeModal();
    await refreshSellerRequest();
    route();
  }

  /** Card sản phẩm — bố cục quen thuộc của các chợ: ảnh vuông, tên 2 dòng, giá, khu vực, thời gian. */
  function productCard(l) {
    return `
      <a class="pcard" href="#/listing/${esc(l.id)}">
        <div class="pcard-media">
          ${productImage(l, { sold: l.isSold })}
          ${!l.isSold ? `<span class="tag ${conditionTone(l.condition)} pcard-cond">${esc(conditionLabel(l.condition))}</span>` : ''}
        </div>
        <div class="pcard-body">
          <div class="pcard-title">${esc(l.title)}</div>
          <div class="pcard-price-row">
            <span class="pcard-price">${money(l.price)}</span>
            ${!l.isSold ? `<span class="escrow-mini" title="Tiền giữ trong ký quỹ tới khi bạn xác nhận">${ico('shield-check', 13)} Ký quỹ</span>` : ''}
          </div>
          <div class="pcard-foot">
            <span class="pcard-meta">${ico('map-pin', 12)} ${esc(l.location || 'Toàn quốc')}</span>
            <span>${esc(relTime(l.createdAt))}</span>
          </div>
        </div>
      </a>`;
  }

  function statusTag(t) {
    const ui = STATUS_UI[t.status] || { label: t.status, tone: '' };
    return `<span class="tag ${ui.tone}">${esc(ui.label)}</span>`;
  }

  function escrowTag(t) {
    // Chưa thanh toán thì nhãn trạng thái đơn ("Chờ thanh toán") đã nói đủ — không lặp lại.
    if (t.escrowStatus === 'NONE') return '';
    const tone = { LOCKED: 'tag-navy', FROZEN: 'tag-danger' }[t.escrowStatus] || '';
    return `<span class="tag ${tone}">${ico('shield-check', 12)} ${esc(ESCROW_UI[t.escrowStatus] || t.escrowStatus)}</span>`;
  }

  // Sáu bước của một giao dịch ký quỹ — cùng một mô hình cho thanh tiến trình rút gọn ở danh
  // sách đơn và cho dòng thời gian đầy đủ ở trang chi tiết.
  //   "Người bán xác nhận" là MỐC sự kiện (seller_ack_at), không phải trạng thái máy.
  const TX_STEPS = [
    { key: 'CREATED', label: 'Đã tạo đơn', actions: ['ORDER_CREATED', 'TRANSACTION_CREATED'] },
    { key: 'LOCKED', label: 'Đã khoá tiền vào ký quỹ', actions: ['ESCROW_LOCKED'] },
    { key: 'ACK', label: 'Người bán xác nhận đơn', actions: ['SELLER_ACKNOWLEDGED'] },
    { key: 'SHIPPED', label: 'Người bán đã giao hàng', actions: ['SELLER_SHIPPED'] },
    { key: 'RECEIVED', label: 'Người mua đã nhận hàng', actions: ['BUYER_RECEIVED_PACKAGE'] },
    { key: 'DONE', label: 'Hoàn tất', actions: ['ESCROW_RELEASED', 'ADMIN_RELEASE', 'ADMIN_REFUND'] },
  ];

  /** Số bước đã hoàn thành theo trạng thái hiện tại. */
  function stepsDone(t) {
    switch (t.status) {
      case 'CREATED': return 1;
      case 'SECURED': return t.sellerAckAt ? 3 : 2;
      case 'SHIPPING': return 4;
      case 'WAIT_CONFIRM': case 'DISPUTED': return 5;
      case 'COMPLETED': case 'RELEASED': case 'REFUNDED': return 6;
      default: return 1;
    }
  }

  function progressBar(t) {
    const done = stepsDone(t);
    return `<div class="progress" title="${esc(TX_STEPS[Math.min(done, TX_STEPS.length) - 1].label)}">${TX_STEPS.map((s, i) => {
      let cls = i < done ? 'done' : '';
      if (i === done && done < TX_STEPS.length) cls = t.status === 'DISPUTED' ? 'failed' : 'current';
      return `<span class="${cls}"></span>`;
    }).join('')}</div>`;
  }

  /** "Bước tiếp theo" — một câu, theo đúng vai trò người xem. */
  function nextStepText(t, isBuyer) {
    switch (t.status) {
      case 'CREATED': return isBuyer ? 'Thanh toán để tiền được giữ trong ký quỹ' : 'Chờ người mua thanh toán';
      case 'SECURED':
        if (!t.sellerAckAt) return isBuyer ? 'Chờ người bán xác nhận đơn' : 'Xác nhận đơn và chuẩn bị gửi hàng';
        return isBuyer ? 'Chờ người bán gửi hàng' : 'Gửi hàng rồi bấm "Xác nhận đã giao hàng"';
      case 'SHIPPING': return isBuyer ? 'Bấm "Xác nhận đã nhận hàng" khi kiện hàng tới' : 'Chờ người mua nhận hàng';
      case 'WAIT_CONFIRM': return isBuyer ? 'Kiểm hàng rồi giải ngân, hoặc mở tranh chấp' : 'Chờ người mua xác nhận giải ngân';
      case 'DISPUTED': return 'Tiền đang bị đóng băng, chờ quản trị viên phân xử';
      case 'COMPLETED': return 'Người mua đã giải ngân — giao dịch kết thúc';
      case 'RELEASED': return 'Đã giải ngân cho người bán theo phân xử';
      case 'REFUNDED': return 'Đã hoàn tiền cho người mua theo phân xử';
      default: return '';
    }
  }

  function moneyStrip(t) {
    return `
      <div class="money-strip">
        <div><span>Giá trị giao dịch</span><b>${money(t.amount)}</b></div>
        <div><span>Trạng thái tiền</span><b>${esc(ESCROW_UI[t.escrowStatus] || t.escrowStatus)}</b></div>
        <div><span>Người bán nhận</span><b>${money(t.amount)}</b></div>
      </div>`;
  }

  function empty(icon, title, text, cta = '') {
    return `
      <div class="card"><div class="empty">
        <span class="ico-box">${ico(icon || 'inbox', 28)}</span>
        <h3>${esc(title)}</h3>
        <p>${esc(text)}</p>
        ${cta ? `<div class="row">${cta}</div>` : ''}
      </div></div>`;
  }

  function skeletonGrid(n = 8) {
    return `<div class="grid">${Array.from({ length: n }, () => '<div class="skeleton"></div>').join('')}</div>`;
  }


  // =====================================================================
  // Router
  // =====================================================================

  const view = () => $('#view');

  /**
   * Người dùng đang chờ duyệt quyền bán thì vai trò có thể đổi bất cứ lúc nào do quản trị viên
   * bấm duyệt ở phía bên kia. Mỗi lần điều hướng, hỏi lại máy chủ một lần để giao diện bắt kịp.
   */
  async function syncPendingSellerRequest() {
    if (!state.user || state.user.role !== 'BUYER') return;
    if (!state.sellerRequest || state.sellerRequest.status !== 'PENDING') return;

    await refreshSellerRequest();
    const now = state.sellerRequest;
    if (!now || now.status === 'PENDING') return;

    if (now.status === 'APPROVED') {
      try {
        const me = await api('/users/me');
        state.user = me.user;
        state.wallet = me.wallet;
        localStorage.setItem(STORAGE_USER, JSON.stringify(me.user));
        state.sellerRequest = null;
        toast('Yêu cầu mở cửa hàng đã được duyệt. Bạn đã có thể đăng tin bán.', 'ok');
      } catch (_) { /* lần điều hướng sau sẽ thử lại */ }
    } else if (now.status === 'REJECTED') {
      toast('Yêu cầu mở cửa hàng bị từ chối. Xem lý do ở trang chủ.', 'err');
    }
  }

  async function route() {
    const hash = (location.hash || '#/').replace(/^#/, '');
    const [pathPart] = hash.split('?');
    const parts = pathPart.split('/').filter(Boolean);
    window.scrollTo({ top: 0 });

    await syncPendingSellerRequest();
    await refreshUnread();

    if (!state.meta) {
      try { state.meta = await api('/listings/meta'); } catch (_) { state.meta = { categories: [], conditions: [], locations: [] }; }
    }

    const head = parts[0] || '';
    try {
      if (head === '') return await viewHome();
      if (head === 'listing') return await viewListing(parts[1]);
      if (head === 'orders') return await viewOrders();
      if (head === 'shop') return await viewShop();
      if (head === 'tx') return await viewTransaction(parts[1]);
      if (head === 'notifications') return await viewNotifications();
      if (head === 'wallet') return await viewWallet();
      if (head === 'security') return await viewSecurity();
      if (head === 'admin') return await viewAdmin(parts[1] || 'disputes');
      if (head === 'audit') return await viewAudit(parts[1]);
      view().innerHTML = `<div class="page">${empty('compass', 'Không có trang này', 'Đường dẫn bạn mở không tồn tại.',
        '<a class="btn btn-primary" href="#/">Về trang chủ</a>')}</div>`;
    } catch (e) {
      view().innerHTML = `<div class="page">${empty('frown', 'Không tải được nội dung', e.message,
        `<button class="btn" data-act="reload">${ico('refresh-cw', 17)} Tải lại</button>`)}</div>`;
    } finally {
      renderChrome();
    }
  }

  function requireLogin(message) {
    view().innerHTML = `<div class="page">${empty('lock', 'Cần đăng nhập', message,
      `<button class="btn btn-primary" data-act="open-auth">${ico('key-round', 17)} Đăng nhập</button>`)}</div>`;
  }

  function wrongRole(message, cta = '') {
    view().innerHTML = `<div class="page">${empty('ban', 'Trang không dành cho vai trò này', message, cta)}</div>`;
  }

  /** Về trang chủ với bộ lọc mới; nếu đang ở trang chủ thì vẽ lại tại chỗ. */
  function goHome() {
    state.homeLimit = HOME_PAGE_SIZE;
    if (currentHead() === '') route();
    else location.hash = '#/';
  }


  // =====================================================================
  // Trang: Trang chủ — học Shopee/Lazada: banner nhỏ, danh mục, sản phẩm mới
  // =====================================================================

  async function viewHome() {
    const f = state.filters;
    const cats = state.meta.categories || [];
    const conds = state.meta.conditions || [];
    const locs = state.meta.locations || [];
    const filtering = !!(f.q || f.category || f.condition || f.location);
    const listTitle = f.q ? `Kết quả cho "${f.q}"` : f.category ? categoryLabel(f.category) : 'Sản phẩm mới đăng';

    view().innerHTML = `
      <div class="page-flush">
        ${filtering ? '' : `
        <div class="home-top">
          <div class="promo-banner">
            <h1>Mua đồ cũ, không lo mất tiền</h1>
            <p>Tiền chỉ chuyển cho người bán sau khi bạn xác nhận đã nhận đúng hàng — không chuyển khoản thẳng cho người lạ.</p>
            <button class="btn" data-act="scroll-products">Xem sản phẩm mới</button>
          </div>
          <div class="promo-side">
            <div class="promo-mini">
              <span class="ico-box">${ico('shield-check', 22)}</span>
              <div><b>Không mất tiền oan</b><span>Chỉ thanh toán khi nhận đúng hàng</span></div>
            </div>
            <div class="promo-mini">
              <span class="ico-box">${ico('fingerprint', 22)}</span>
              <div><b>Xác thực vân tay, khuôn mặt</b><span>An toàn hơn mã OTP qua tin nhắn</span></div>
            </div>
          </div>
        </div>`}

        <section>
          <div class="section-title">
            <h2>Danh mục</h2>
            ${f.category ? `<a class="small" href="#/" data-act="filter-cat" data-cat="">Xem tất cả danh mục</a>` : ''}
          </div>
          <div class="cat-grid">
            ${cats.map((c) => `
              <a class="cat ${f.category === c.key ? 'active' : ''}" href="#/" data-act="filter-cat" data-cat="${esc(c.key)}">
                <span class="ico-box">${ico(c.icon, 24)}</span>
                <span>${esc(c.label)}</span>
              </a>`).join('')}
          </div>
        </section>

        <section id="products">
          <div class="section-title">
            <h2>${esc(listTitle)}</h2>
            <span class="muted small" id="resultCount"></span>
          </div>
          <div class="listing-toolbar">
            <div class="row">
              ${ico('sliders', 16)}
              <select id="fCondition" aria-label="Tình trạng">
                <option value="">Mọi tình trạng</option>
                ${conds.map((c) => `<option value="${esc(c.key)}" ${f.condition === c.key ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}
              </select>
              <select id="fLocation" aria-label="Khu vực">
                <option value="">Toàn quốc</option>
                ${locs.map((l) => `<option value="${esc(l)}" ${f.location === l ? 'selected' : ''}>${esc(l)}</option>`).join('')}
              </select>
              ${filtering ? `<button class="btn btn-sm btn-ghost" data-act="clear-filters">${ico('x', 15)} Xoá bộ lọc</button>` : ''}
            </div>
            <div class="row">
              <label class="muted small" for="fSort">Sắp xếp</label>
              <select id="fSort">
                <option value="new" ${f.sort === 'new' ? 'selected' : ''}>Tin mới nhất</option>
                <option value="price_asc" ${f.sort === 'price_asc' ? 'selected' : ''}>Giá thấp đến cao</option>
                <option value="price_desc" ${f.sort === 'price_desc' ? 'selected' : ''}>Giá cao đến thấp</option>
              </select>
            </div>
          </div>
          <div id="listingGrid" style="margin-top:var(--s-3)">${skeletonGrid(12)}</div>
          <div class="load-more" id="loadMore" style="margin-top:var(--s-4)"></div>
        </section>

        <div class="trust-strip">
          <div class="trust-item">${ico('shield-check', 20)}<div><b>Không mất tiền oan</b><span>Người bán chỉ nhận tiền khi bạn xác nhận</span></div></div>
          <div class="trust-item">${ico('fingerprint', 20)}<div><b>Vân tay hoặc khuôn mặt</b><span>Xác thực lại mỗi khi chuyển tiền</span></div></div>
          <div class="trust-item">${ico('scale', 20)}<div><b>Có người phân xử</b><span>Mở tranh chấp là tiền được đóng băng</span></div></div>
          <div class="trust-item">${ico('link-2', 20)}<div><b>Nhật ký chống sửa</b><span>Mọi bước đều được lưu vết, không sửa được</span></div></div>
        </div>

        ${shopCta()}
      </div>`;

    const bind = (id, key) => {
      const el = $(id);
      if (el) el.addEventListener('change', () => { state.filters[key] = el.value; goHome(); });
    };
    bind('#fCondition', 'condition');
    bind('#fLocation', 'location');
    bind('#fSort', 'sort');

    await loadListings();
  }

  async function loadListings() {
    const f = state.filters;
    const params = new URLSearchParams();
    for (const k of ['q', 'category', 'condition', 'location', 'sort']) if (f[k]) params.set(k, f[k]);

    const grid = $('#listingGrid');
    const count = $('#resultCount');
    try {
      const { listings } = await api('/listings?' + params.toString());
      state.homeListings = listings;
      if (count) count.textContent = `${listings.length} tin đăng`;
      if (!grid) return;

      if (listings.length === 0) {
        const filtered = f.q || f.category || f.condition || f.location;
        grid.innerHTML = empty(
          'search',
          filtered ? 'Không có tin đăng nào khớp' : 'Chợ đang trống',
          filtered ? 'Thử bỏ bớt bộ lọc hoặc tìm với từ khoá khác.' : 'Chưa ai đăng tin bán. Mở cửa hàng để đăng tin đầu tiên.',
          filtered ? '<button class="btn" data-act="clear-filters">Xoá bộ lọc</button>' : ''
        );
        $('#loadMore').innerHTML = '';
        return;
      }
      renderListingPage();
    } catch (e) {
      if (grid) grid.innerHTML = empty('frown', 'Không tải được danh sách tin', e.message);
    }
  }

  /** "Xem thêm" hiện thêm một trang trên danh sách đã tải — không gọi lại máy chủ. */
  function renderListingPage() {
    const all = state.homeListings || [];
    const shown = all.slice(0, state.homeLimit);
    $('#listingGrid').innerHTML = `<div class="grid">${shown.map(productCard).join('')}</div>`;
    const rest = all.length - shown.length;
    $('#loadMore').innerHTML = rest > 0
      ? `<button class="btn" data-act="load-more">Xem thêm ${Math.min(rest, HOME_PAGE_SIZE)} tin ${ico('chevron-down', 16)}</button>`
      : '';
  }

  // =====================================================================
  // Trang: Chi tiết tin đăng — học Chợ Tốt: ảnh | tên, giá, người bán, trạng thái tin, mua ngay
  // =====================================================================

  async function viewListing(id) {
    if (!id) { location.hash = '#/'; return; }
    view().innerHTML = `<div class="page"><div class="skeleton" style="height:420px"></div></div>`;

    const l = await api('/listings/' + encodeURIComponent(id));
    let seller = null;
    try { seller = await api('/users/' + encodeURIComponent(l.sellerId)); } catch (_) { /* hồ sơ người bán không bắt buộc */ }
    const isOwner = !!(state.user && state.user.id === l.sellerId);
    const st = listingStatus(l);

    view().innerHTML = `
      <div class="page">
        <div class="breadcrumb">
          <a href="#/" data-act="filter-cat" data-cat="">Trang chủ</a>${ico('chevron-right', 14)}
          <a href="#/" data-act="filter-cat" data-cat="${esc(l.category)}">${esc(categoryLabel(l.category))}</a>${ico('chevron-right', 14)}
          <span>${esc(l.title)}</span>
        </div>

        <div class="pd">
          <div class="pd-gallery">${productImage(l, { sold: l.isSold, size: 110 })}</div>
          <div>
            <h1 class="pd-title">${esc(l.title)}</h1>
            <div class="pd-meta">
              <span>${ico('map-pin', 14)} ${esc(l.location || 'Toàn quốc')}</span>
              <span>${ico('clock', 14)} Đăng ${esc(relTime(l.createdAt))}</span>
              <span>${ico('tag', 14)} ${esc(categoryLabel(l.category))}</span>
            </div>
            <div class="pd-price">${money(l.price)}</div>
            <div class="pd-status">
              <span class="muted small">Trạng thái tin</span>
              <span class="tag ${st.tone}">${esc(st.label)}</span>
              <span class="tag">${esc(conditionLabel(l.condition))}</span>
            </div>
            <div class="pd-buy">${buyPanel(l, isOwner)}</div>
            ${isOwner ? '' : `
            <div class="pd-flow">
              <div class="pd-flow-title">${ico('shield-check', 15)} Quy trình mua an toàn</div>
              <ol>
                <li><b>Bạn thanh toán</b> — chúng tôi giữ tiền lại, người bán chưa nhận được.</li>
                <li><b>Người bán xác nhận và giao hàng.</b></li>
                <li><b>Bạn kiểm hàng</b> rồi xác nhận để chuyển tiền, hoặc báo sự cố nếu có vấn đề.</li>
              </ol>
            </div>`}
          </div>
        </div>

        <div class="pd-cols">
          <div class="stack">
            <div class="card">
              <div class="card-head"><h2>Mô tả sản phẩm</h2></div>
              <div class="card-body"><p class="desc">${esc(l.description || 'Người bán chưa viết mô tả.')}</p></div>
            </div>
            <div class="card">
              <div class="card-head"><h2>Thông tin sản phẩm</h2></div>
              <div class="card-body">
                <dl class="spec-list">
                  <div class="spec"><dt>Danh mục</dt><dd>${esc(categoryLabel(l.category))}</dd></div>
                  <div class="spec"><dt>Tình trạng</dt><dd>${esc(conditionLabel(l.condition))}</dd></div>
                  <div class="spec"><dt>Khu vực</dt><dd>${esc(l.location || 'Toàn quốc')}</dd></div>
                  <div class="spec"><dt>Ngày đăng</dt><dd>${fmtDateTime(l.createdAt)}</dd></div>
                  <div class="spec"><dt>Mã tin</dt><dd class="mono">${esc(shortId(l.id))}</dd></div>
                </dl>
              </div>
            </div>
          </div>
          <div class="stack">
            <div class="card">
              <div class="card-head"><h2>Thông tin người bán</h2></div>
              <div class="card-body">${sellerCard(l, seller)}</div>
            </div>
            <div class="note note-trust">
              ${ico('shield-check', 18)}
              <span>Bạn <b>không chuyển khoản thẳng</b> cho người bán. Tiền chỉ chuyển cho người bán khi bạn xác nhận
                đã nhận hàng — bước đó luôn cần xác thực lại bằng vân tay hoặc khuôn mặt.</span>
            </div>
          </div>
        </div>
      </div>`;
  }

  function sellerCard(l, seller) {
    const name = (seller && seller.displayName) || l.sellerName;
    return `
      <div class="seller-card">
        <span class="avatar">${esc(initials(name))}</span>
        <div class="grow">
          <b>${esc(name)}</b>
          <div class="small muted">@${esc((seller && seller.username) || l.sellerUsername)}
            ${seller ? ` · Tham gia ${fmtDay(seller.joinedAt)}` : ''}</div>
          <div class="small" style="color:var(--trust);margin-top:2px">${ico('badge-check', 14)} Tài khoản đã xác minh danh tính</div>
        </div>
      </div>
      ${seller ? `
      <div class="seller-stats">
        <div><b>${esc(seller.listingCount)}</b><span>Tin đang đăng</span></div>
        <div><b>${esc(seller.completedSales)}</b><span>Đã bán thành công</span></div>
      </div>` : ''}`;
  }

  function buyPanel(l, isOwner) {
    // "Còn hay đã bán" là sự thật của sản phẩm, đúng với mọi người xem — xét TRƯỚC chuyện đã
    // đăng nhập chưa, để khách không phải đăng nhập rồi mới biết là không mua được.
    if (isOwner) {
      return `<div class="note">${ico('info', 18)}<span>Đây là tin đăng của bạn.</span></div>
        <a class="btn" href="#/shop">${ico('store', 16)} Quản lý tin đăng</a>`;
    }
    if (l.isSold) {
      return `<button class="btn btn-lg btn-block" disabled>Sản phẩm đã có người mua</button>
        <a class="btn btn-block" href="#/" data-act="filter-cat" data-cat="${esc(l.category)}">Xem tin tương tự</a>`;
    }
    if (!state.user) {
      return `<button class="btn btn-primary btn-lg btn-block" data-act="open-auth">${ico('shopping-bag', 18)} Mua ngay</button>
        <p class="muted tiny center" style="margin:0">Cần đăng nhập để mua.</p>`;
    }
    if (state.user.role !== 'BUYER') {
      return `<div class="note note-warning">${ico('circle-alert', 18)}
        <span>Chỉ tài khoản <b>người mua</b> mới đặt mua được.</span></div>`;
    }

    const enough = !state.wallet || state.wallet.availableBalance >= l.price;
    return `
      <div>
        <div class="price-row"><span>Giá sản phẩm</span><span class="val">${money(l.price)}</span></div>
        <div class="price-row total"><span>Số tiền giữ trong ký quỹ</span><span class="val">${money(l.price)}</span></div>
      </div>
      <div class="field">
        <label for="bkNote">Lời nhắn cho người bán</label>
        <input id="bkNote" type="text" maxlength="200" placeholder="Ví dụ: giao giờ hành chính...">
      </div>
      ${!enough ? `<div class="note note-danger">${ico('circle-alert', 18)}
        <span>Số dư khả dụng (${money(state.wallet.availableBalance)}) chưa đủ. <a href="#/wallet"><b>Nạp tiền vào ví</b></a></span></div>` : ''}
      <button class="btn btn-primary btn-lg btn-block" data-act="do-order" data-id="${esc(l.id)}">${ico('shopping-bag', 18)} Mua ngay</button>
      <p class="muted tiny center" style="margin:0">Chưa trừ tiền ở bước này — bạn xác nhận thanh toán vào ký quỹ ở bước sau.</p>`;
  }

  async function doOrder(listingId, btn) {
    const note = $('#bkNote') ? $('#bkNote').value.trim() : '';
    const txn = await guard('order', btn, () => api('/transactions/orders', { method: 'POST', body: { listingId, note } }));
    if (!txn) return;

    openModal({
      title: 'Đã tạo đơn hàng',
      body: `
        <p>Đơn <b>${esc(txn.itemName)}</b> đã được tạo nhưng <b>chưa trừ tiền</b>.</p>
        ${moneyStrip(txn)}
        <div class="note note-trust">
          ${ico('shield-check', 18)}
          <span>Bước tiếp theo: thanh toán ${money(txn.amount)} để tiền được giữ lại an toàn. Người bán chỉ bắt đầu
            xử lý khi tiền đã được giữ lại.</span>
        </div>`,
      footer: `
        <button class="btn" data-act="modal-close">Để sau</button>
        <button class="btn btn-primary" data-act="secure" data-id="${esc(txn.id)}" data-then="tx">${ico('lock', 17)} Thanh toán an toàn</button>`,
    });
  }


  // =====================================================================
  // Trang: Giao dịch của tôi — học eBay (lịch sử mua / đơn đã bán)
  // =====================================================================

  async function viewOrders() {
    if (!state.user) return requireLogin('Đăng nhập để xem các giao dịch của bạn.');
    if (state.user.role === 'ADMIN') {
      return wrongRole('Quản trị viên không phải một bên của giao dịch.',
        '<a class="btn btn-primary" href="#/admin/disputes">Tới trang quản trị</a>');
    }
    const isSeller = state.user.role === 'SELLER';
    if (!isSeller || !state.orderTab) state.orderTab = isSeller ? 'sell' : 'buy';

    view().innerHTML = `
      <div class="page">
        ${banner('Giao dịch của tôi', 'Mỗi đơn cho biết tiền đang ở đâu và bước tiếp theo là gì',
          isSeller ? `<a class="btn" href="#/shop">${ico('store', 16)} Tin đăng của tôi</a>` : `<a class="btn" href="#/">${ico('shopping-bag', 16)} Tiếp tục mua sắm</a>`)}
        <div id="todoBox"></div>
        <div class="card">
          ${isSeller ? `
          <div class="tabs">
            <button class="${state.orderTab === 'sell' ? 'active' : ''}" data-act="order-tab" data-tab="sell">Đơn bán</button>
            <button class="${state.orderTab === 'buy' ? 'active' : ''}" data-act="order-tab" data-tab="buy">Đơn mua</button>
          </div>` : ''}
          <div class="card-body">
            <div class="chips" style="margin-bottom:var(--s-4)">${orderFilterChips()}</div>
            <div id="orderList"><div class="skeleton" style="min-height:120px"></div></div>
          </div>
        </div>
      </div>`;

    const perspective = state.orderTab === 'sell' ? 'SELLER' : 'BUYER';
    await Promise.all([
      loadTodo('#todoBox', { hideWhenEmpty: true }),
      loadOrders('#orderList', perspective, perspective === 'SELLER' ? 'seller' : 'buyer'),
    ]);
  }

  function orderFilterChips() {
    const opts = [['active', 'Đang xử lý'], ['done', 'Đã kết thúc'], ['all', 'Tất cả']];
    return opts.map(([k, label]) =>
      `<button class="chip ${state.orderFilter === k ? 'active' : ''}" data-act="filter-order" data-f="${k}">${esc(label)}</button>`
    ).join('');
  }

  const DONE_STATUSES = ['COMPLETED', 'RELEASED', 'REFUNDED'];

  async function loadOrders(selector, perspective, as) {
    const box = $(selector);
    if (!box) return;
    try {
      const { transactions } = await api('/transactions' + (as ? '?as=' + as : ''));
      let list = transactions;
      if (state.orderFilter === 'active') list = list.filter((t) => !DONE_STATUSES.includes(t.status));
      if (state.orderFilter === 'done') list = list.filter((t) => DONE_STATUSES.includes(t.status));

      if (list.length === 0) {
        box.innerHTML = `<div class="empty" style="padding:var(--s-8)">
          <span class="ico-box">${ico('receipt', 28)}</span>
          <h3>Chưa có đơn nào ở mục này</h3>
          <p>${perspective === 'BUYER' ? 'Khi bạn mua một sản phẩm, đơn sẽ xuất hiện ở đây.' : 'Khi có người mua tin đăng của bạn, đơn sẽ xuất hiện ở đây.'}</p>
          ${perspective === 'BUYER' ? '<div class="row"><a class="btn btn-primary" href="#/">Khám phá sản phẩm</a></div>' : ''}
        </div>`;
        return;
      }
      box.innerHTML = `<div class="order-list">${list.map((t) => orderRow(t, perspective)).join('')}</div>`;
    } catch (e) {
      box.innerHTML = `<div class="note note-danger">${ico('circle-alert', 18)}<span>${esc(e.message)}</span></div>`;
    }
  }

  function orderRow(t, perspective) {
    const isBuyer = perspective === 'BUYER';
    const other = isBuyer ? t.sellerName : t.buyerName;
    return `
      <div class="order">
        <div class="order-head">
          <span>${isBuyer ? 'Người bán' : 'Người mua'}: <b>${esc(other || '—')}</b></span>
          <span>Mã GD <span class="mono">#${esc(shortId(t.id))}</span> · ${fmtDateTime(t.createdAt)}</span>
        </div>
        <div class="order-main">
          <div class="order-tile">${productImage({ category: t.listingCategory }, { size: 30 })}</div>
          <div>
            <a class="order-title" href="#/tx/${esc(t.id)}">${esc(t.itemName)}</a>
            <div class="row" style="gap:6px">${statusTag(t)}${escrowTag(t)}</div>
            ${progressBar(t)}
          </div>
          <div class="order-amount">
            <b>${money(t.amount)}</b>
            <span class="muted">${t.escrowStatus === 'LOCKED' || t.escrowStatus === 'FROZEN' ? 'đang giữ trong ký quỹ' : ''}</span>
          </div>
        </div>
        <div class="order-foot">
          <span class="small muted">${ico('info', 14)} ${esc(nextStepText(t, isBuyer))}</span>
          <div class="row">
            ${orderActions(t, isBuyer)}
            <a class="btn btn-sm" href="#/tx/${esc(t.id)}">Xem chi tiết</a>
          </div>
        </div>
      </div>`;
  }

  /**
   * Hành động được phép trên một đơn, theo đúng quy tắc của máy chủ (vai trò + trạng thái).
   * Giao diện chỉ dẫn đường — máy chủ vẫn tự kiểm lại mọi điều kiện; ẩn nút không phải là một
   * biện pháp an toàn. Chuyển SHIPPING -> WAIT_CONFIRM là việc của NGƯỜI MUA (chỉ người mua
   * quan sát được kiện hàng đã tới tay), người bán chỉ báo đã gửi hàng.
   */
  function orderActions(t, isBuyer) {
    const id = esc(t.id);
    const out = [];
    if (isBuyer) {
      if (t.status === 'CREATED') {
        out.push(`<button class="btn btn-primary btn-sm" data-act="secure" data-id="${id}">${ico('lock', 15)} Thanh toán an toàn</button>`);
      }
      if (t.status === 'SHIPPING') {
        out.push(`<button class="btn btn-primary btn-sm" data-act="wait-confirm" data-id="${id}">${ico('package', 15)} Xác nhận đã nhận hàng</button>`);
      }
      if (t.status === 'WAIT_CONFIRM') {
        out.push(`<button class="btn btn-trust btn-sm" data-act="open-release" data-id="${id}">${ico('fingerprint', 15)} Xác thực vân tay &amp; giải ngân</button>`);
        out.push(`<button class="btn btn-danger btn-sm" data-act="open-dispute" data-id="${id}">${ico('triangle-alert', 15)} Mở tranh chấp</button>`);
      }
    } else {
      if (t.status === 'SECURED' && !t.sellerAckAt) {
        out.push(`<button class="btn btn-primary btn-sm" data-act="acknowledge" data-id="${id}">${ico('check', 15)} Xác nhận đơn hàng</button>`);
      }
      if (t.status === 'SECURED' && t.sellerAckAt) {
        out.push(`<button class="btn btn-primary btn-sm" data-act="ship" data-id="${id}">${ico('truck', 15)} Xác nhận đã giao hàng</button>`);
      }
      if (t.status === 'WAIT_CONFIRM') {
        out.push(`<button class="btn btn-danger btn-sm" data-act="open-dispute" data-id="${id}">${ico('triangle-alert', 15)} Báo sự cố</button>`);
      }
    }
    return out.join('');
  }


  // ---------- Hành động trên đơn ----------

  async function secureOrder(id, btn, then) {
    await guard('secure:' + id, btn, () => api(`/transactions/${id}/secure`, {
      method: 'POST', body: { requestId: newRequestId() },
    }), 'Đã thanh toán — tiền đang được giữ trong ký quỹ, chưa chuyển cho người bán.');
    closeModal();
    await refreshWallet();
    if (then === 'tx') { location.hash = '#/tx/' + id; return; }
    route();
  }

  async function acknowledgeOrder(id, btn) {
    await guard('ack:' + id, btn, () => api(`/transactions/${id}/acknowledge`, { method: 'POST' }),
      'Đã xác nhận đơn. Hãy gửi hàng rồi bấm "Xác nhận đã giao hàng".');
    route();
  }

  async function shipOrder(id, btn) {
    await guard('ship:' + id, btn, () => api(`/transactions/${id}/ship`, { method: 'POST' }),
      'Đã ghi nhận giao hàng. Tiền vẫn ở ký quỹ cho tới khi người mua xác nhận.');
    route();
  }

  async function waitConfirmOrder(id, btn) {
    await guard('wc:' + id, btn, () => api(`/transactions/${id}/wait-confirm`, { method: 'POST' }),
      'Đã ghi nhận bạn nhận được hàng. Kiểm hàng rồi giải ngân, hoặc mở tranh chấp nếu có vấn đề.');
    route();
  }

  function openDisputeModal(id) {
    openModal({
      title: 'Mở tranh chấp',
      body: `
        <div class="note note-warning" style="margin-bottom:var(--s-4)">
          ${ico('triangle-alert', 18)}
          <span>Khi mở tranh chấp, toàn bộ tiền trong ký quỹ bị <b>đóng băng</b> — không bên nào rút được — cho tới khi
            quản trị viên xem xét và quyết định hoàn tiền cho người mua hay giải ngân cho người bán.</span>
        </div>
        <div class="field">
          <label for="dsReason">Mô tả sự cố</label>
          <textarea id="dsReason" placeholder="Hàng không đúng mô tả, thiếu phụ kiện, chưa nhận được hàng..."></textarea>
        </div>`,
      footer: `
        <button class="btn" data-act="modal-close">Huỷ</button>
        <button class="btn btn-danger" data-act="do-dispute" data-id="${esc(id)}">Mở tranh chấp</button>`,
    });
  }

  async function doDispute(id, btn) {
    const reason = $('#dsReason') ? $('#dsReason').value.trim() : '';
    if (!reason) return toast('Vui lòng mô tả sự cố', 'err');
    await guard('dispute:' + id, btn, () => api(`/transactions/${id}/dispute`, { method: 'POST', body: { reason } }),
      'Đã mở tranh chấp. Tiền trong ký quỹ đã bị đóng băng.');
    closeModal();
    route();
  }


  // ---------- Xác thực lại + giải ngân ----------

  async function openReleaseModal(id) {
    let t;
    try { t = await api('/transactions/' + id); } catch (e) { return toast(e.message, 'err'); }

    openModal({
      title: 'Xác nhận đã nhận hàng và giải ngân',
      body: `
        <p>Sản phẩm: <b>${esc(t.itemName)}</b></p>
        ${moneyStrip(t)}
        <div>
          <div class="price-row total"><span>Chuyển cho ${esc(t.sellerName || 'người bán')}</span><span class="val">${money(t.amount)}</span></div>
        </div>
        <div class="note note-warning" style="margin-top:var(--s-4)">
          ${ico('triangle-alert', 18)}
          <span>Chỉ xác nhận khi bạn đã nhận và kiểm hàng. Sau bước này tiền thuộc về người bán
            và không rút lại được — nếu hàng có vấn đề, hãy mở tranh chấp thay vì xác nhận.</span>
        </div>
        <div class="note" style="margin-top:var(--s-3)">
          ${ico('key-round', 18)}
          <span>Đây là thao tác <b>chuyển tiền thật</b>, nên hệ thống bắt buộc <b>xác thực lại bằng vân tay hoặc
            khuôn mặt</b> ngay cả khi bạn đang đăng nhập. Xác thực này chỉ dùng được đúng một lần, cho đúng đơn
            này, và hết hạn sau ít phút.</span>
        </div>`,
      footer: `
        <button class="btn" data-act="modal-close">Huỷ</button>
        <button class="btn btn-trust" data-act="do-release" data-id="${esc(t.id)}">${ico('fingerprint', 17)} Xác thực vân tay &amp; giải ngân</button>`,
    });
  }

  async function doRelease(id, btn) {
    await guard('release:' + id, btn, async () => {
      const { reauthSessionId, options } = await api(`/transactions/${id}/reauth/options`, { method: 'POST' });
      const assertion = await webauthn('reauth', () =>
        SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: options }));
      const { reauthGrant } = await api(`/transactions/${id}/reauth/verify`, {
        method: 'POST', body: { reauthSessionId, response: assertion },
      });
      return api(`/transactions/${id}/release`, {
        method: 'POST', body: { requestId: newRequestId(), reauthGrant },
      });
    }, 'Đã giải ngân. Toàn bộ số tiền đã chuyển cho người bán.');

    closeModal();
    await refreshWallet();
    route();
  }

  /**
   * Xác thực lại để lấy phiếu uỷ quyền cho một thao tác trên tài khoản.
   *
   * Đang đăng nhập là chưa đủ: mô hình đe doạ của hệ thống thừa nhận mã phiên có thể bị
   * đánh cắp. Kẻ chiếm được phiên chỉ cần thêm một passkey của mình, hoặc đặt lại mật khẩu,
   * là giữ được quyền truy cập lâu dài. Vì vậy thêm credential, xoá credential và đổi mật
   * khẩu đều đi qua bước này.
   *
   * Phiếu ràng buộc với đúng MỘT hành động: phiếu xin cho việc quản lý thiết bị không đổi
   * được mật khẩu, và ngược lại.
   */
  async function getAccountGrant(action = 'MANAGE_CREDENTIAL') {
    const { reauthSessionId, options } = await api('/passkeys/reauth/options', {
      method: 'POST', body: { action },
    });
    const assertion = await webauthn('reauth', () =>
      SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: options }));
    const { reauthGrant } = await api('/passkeys/reauth/verify', {
      method: 'POST', body: { reauthSessionId, response: assertion },
    });
    return reauthGrant;
  }

  const getCredentialGrant = () => getAccountGrant('MANAGE_CREDENTIAL');

  // =====================================================================
  // Trang: Bảo mật tài khoản
  // =====================================================================
  //
  // Ba việc người dùng phải tự làm được: xem mình đang có những Passkey nào, thêm một
  // Passkey dự phòng, và đổi mật khẩu. Cả ba đều đi qua bước xác thực lại.
  //
  // Cho phép nhiều Passkey là để giảm nguy cơ mất khả năng thực hiện các thao tác bắt buộc
  // Passkey khi một thiết bị hỏng hoặc mất. Mật khẩu KHÔNG phải kênh khôi phục: mất hết
  // Passkey thì vẫn đăng nhập được để xem, nhưng không tự giải ngân hay tự gắn lại thiết bị.

  async function viewSecurity() {
    if (!state.user) return requireLogin('Đăng nhập để quản lý Passkey và mật khẩu.');

    view().innerHTML = `
      <div class="page">
        ${banner('Bảo mật tài khoản', 'Passkey, thiết bị và mật khẩu của bạn')}

        <div class="card" style="padding:var(--s-5); margin-bottom:var(--s-5)">
          <div class="row-between" style="margin-bottom:var(--s-4)">
            <h3 style="margin:0">Passkey đã đăng ký</h3>
            <button class="btn btn-primary btn-sm" data-act="add-device">${ico('plus', 15)} Thêm thiết bị</button>
          </div>
          <div id="credentialList">${skeletonGrid(2)}</div>
        </div>

        <div class="card" style="padding:var(--s-5)">
          <div class="row-between">
            <div>
              <h3 style="margin:0 0 4px">Mật khẩu</h3>
              <p class="muted tiny" style="margin:0">
                Dùng để mở phiên làm việc. Đổi mật khẩu sẽ đăng xuất mọi phiên khác.
              </p>
            </div>
            <button class="btn btn-sm" data-act="open-change-password">${ico('key-round', 15)} Đổi mật khẩu</button>
          </div>
        </div>
      </div>`;

    await loadCredentials();
  }

  async function loadCredentials() {
    const box = $('#credentialList');
    if (!box) return;
    try {
      const { credentials } = await api('/passkeys/credentials');
      const onlyOne = credentials.length <= 1;
      box.innerHTML = `
        <div class="stack">
          ${credentials.map((c) => `
            <div class="row-between" style="padding:10px 0; border-bottom:1px solid var(--border)">
              <div>
                <b>${esc(c.deviceName)}</b>
                <div class="muted tiny">
                  Đăng ký ${esc((c.createdAt || '').slice(0, 10))}
                  ${c.lastUsedAt ? ` · dùng gần nhất ${esc(c.lastUsedAt.slice(0, 10))}` : ' · chưa dùng lần nào'}
                </div>
              </div>
              <button class="btn btn-ghost btn-sm" data-act="del-device" data-id="${esc(c.id)}"
                ${onlyOne ? 'disabled title="Không thể xoá Passkey cuối cùng"' : ''}>
                ${ico('x', 15)} Xoá
              </button>
            </div>`).join('')}
          ${onlyOne ? `
            <p class="muted tiny" style="margin:var(--s-3) 0 0">
              Chỉ còn một Passkey nên không xoá được. Nên thêm một thiết bị dự phòng.
            </p>` : ''}
        </div>`;
    } catch (e) {
      box.innerHTML = `<p class="muted">Không tải được danh sách: ${esc(e.message)}</p>`;
    }
  }

  async function addDevice(btn) {
    const deviceName = prompt('Đặt tên cho thiết bị này (ví dụ: Điện thoại cá nhân)');
    if (deviceName === null) return;

    await guard('adddev', btn, async () => {
      // Phiếu xin TRƯỚC, vì máy chủ kiểm phiếu ngay ở bước xin tuỳ chọn đăng ký — người
      // dùng biết sớm là mình chưa đủ điều kiện, thay vì làm xong mới bị từ chối.
      const reauthGrant = await getCredentialGrant();
      const { registrationSessionId, options } = await api('/passkeys/credentials/options', {
        method: 'POST', body: { deviceName: deviceName.trim() || 'Thiết bị mới', reauthGrant },
      });
      const attResp = await webauthn('add-device', () =>
        SimpleWebAuthnBrowser.startRegistration({ optionsJSON: options }));
      return api('/passkeys/credentials/verify', {
        method: 'POST', body: { registrationSessionId, response: attResp, reauthGrant },
      });
    }, 'Đã thêm thiết bị mới.');

    await loadCredentials();
  }

  async function deleteDevice(id, btn) {
    await guard('deldev:' + id, btn, async () => {
      const reauthGrant = await getCredentialGrant();
      return api(`/passkeys/credentials/${id}`, { method: 'DELETE', body: { reauthGrant } });
    }, 'Đã xoá thiết bị.');

    await loadCredentials();
  }

  // ---------- Đổi mật khẩu ----------
  //
  // Không hỏi mật khẩu cũ mà hỏi Passkey. Mật khẩu cũ là thứ kẻ chiếm được phiên có thể đã
  // biết; credential thì không. Sau khi đổi, mọi phiên đang mở khác đều bị thu hồi.

  function openChangePasswordModal() {
    openModal({
      title: 'Đổi mật khẩu',
      body: `
        <div class="stack">
          <div class="field">
            <label for="newPassword">Mật khẩu mới</label>
            <input id="newPassword" type="password" autocomplete="new-password">
            <span class="hint">Ít nhất 8 ký tự</span>
          </div>
          <p class="muted tiny" style="margin:0">
            Bạn sẽ được yêu cầu xác thực bằng Passkey. Các phiên đăng nhập khác sẽ bị đăng xuất.
          </p>
        </div>`,
      footer: `
        <button class="btn" data-act="modal-close">Huỷ</button>
        <button class="btn btn-primary" data-act="do-change-password">Đổi mật khẩu</button>`,
    });
  }

  async function doChangePassword(btn) {
    const newPassword = $('#newPassword').value;
    if (!newPassword) return toast('Nhập mật khẩu mới', 'err');

    await guard('chpw', btn, async () => {
      const reauthGrant = await getAccountGrant('CHANGE_PASSWORD');
      const result = await api('/users/me/password', { method: 'POST', body: { newPassword, reauthGrant } });
      // Mã phiên cũ vừa bị thu hồi cùng lúc với việc đổi mật khẩu; dùng mã mới máy chủ trả về.
      setSession(result.token, state.user);
      closeModal();
      // Đổi mật khẩu là thao tác nhạy cảm — dùng popup lớn giữa màn hình thay vì toast góc
      // màn hình, để người dùng chắc chắn nhận ra thao tác đã hoàn tất.
      openModal({
        title: 'Đổi mật khẩu thành công',
        body: `
          <div class="center">
            <div style="margin-bottom: var(--s-3)">
              <span style="color: var(--success)">${ico('circle-check', 48)}</span>
            </div>
            <p>Mật khẩu của bạn đã được cập nhật.<br>Các phiên đăng nhập khác đã bị đăng xuất.</p>
          </div>`,
        footer: `<button class="btn btn-primary" data-act="modal-close">Đã hiểu</button>`,
      });
    });
  }

  // =====================================================================
  // Trang: Tin đăng của tôi (người bán) — học Chợ Tốt "Quản lý tin"
  // =====================================================================

  async function viewShop() {
    if (!state.user) return requireLogin('Đăng nhập bằng tài khoản người bán để quản lý tin đăng.');
    if (state.user.role !== 'SELLER') {
      return wrongRole('Tài khoản của bạn là ' + ROLE_LABEL[state.user.role] + '. Mở cửa hàng để đăng tin bán.',
        state.user.role === 'BUYER' ? `<button class="btn btn-primary" data-act="open-sell">${ico('store', 16)} Mở cửa hàng</button>` : '');
    }

    view().innerHTML = `
      <div class="page">
        ${banner('Tin đăng của tôi', 'Mỗi tin là một sản phẩm đơn chiếc — khi có người thanh toán, tin ngừng nhận đơn mới',
          `<button class="btn btn-primary" data-act="new-listing">${ico('plus', 17)} Đăng tin mới</button>`)}
        <div id="todoBox"></div>
        <div class="card"><div class="table-scroll" id="shopPanel"><div class="skeleton" style="min-height:160px"></div></div></div>
      </div>`;

    loadTodo('#todoBox', { hideWhenEmpty: true });
    await loadMyListings();
  }

  async function loadMyListings() {
    const box = $('#shopPanel');
    if (!box) return;
    try {
      const { listings } = await api('/listings?mine=true');
      if (listings.length === 0) {
        box.innerHTML = `<div class="empty">
          <span class="ico-box">${ico('store', 28)}</span>
          <h3>Bạn chưa có tin đăng nào</h3>
          <p>Đăng tin đầu tiên, hoặc nhập nhanh 8 tin mẫu để xem chợ hiển thị thế nào.</p>
          <div class="row">
            <button class="btn btn-primary" data-act="new-listing">${ico('plus', 17)} Đăng tin mới</button>
            <button class="btn" data-act="seed-demo">${ico('sparkles', 17)} Nhập 8 tin mẫu</button>
          </div>
        </div>`;
        return;
      }
      box.innerHTML = `
        <table class="data">
          <thead><tr><th>Tin đăng</th><th class="num">Giá</th><th>Trạng thái</th><th>Ngày đăng</th><th></th></tr></thead>
          <tbody>${listings.map(manageRow).join('')}</tbody>
        </table>`;
    } catch (e) {
      box.innerHTML = empty('frown', 'Không tải được tin đăng', e.message);
    }
  }

  function manageRow(l) {
    const st = listingStatus(l);
    return `
      <tr>
        <td>
          <div class="row" style="flex-wrap:nowrap;gap:var(--s-3)">
            <div style="width:52px;flex:0 0 auto">${productImage(l, { size: 22 })}</div>
            <div>
              <a href="#/listing/${esc(l.id)}"><b>${esc(l.title)}</b></a>
              <div class="small muted">${esc(categoryLabel(l.category))} · ${esc(l.location || 'Toàn quốc')}</div>
            </div>
          </div>
        </td>
        <td class="num nowrap">${money(l.price)}</td>
        <td><span class="tag ${st.tone}">${esc(st.label)}</span></td>
        <td class="nowrap small">${fmtDateTime(l.createdAt)}</td>
        <td>
          <div class="row" style="justify-content:flex-end;flex-wrap:nowrap">
            <a class="btn btn-sm btn-ghost" href="#/listing/${esc(l.id)}">Xem</a>
            <button class="btn btn-sm" data-act="edit-listing" data-id="${esc(l.id)}">Sửa</button>
            <button class="btn btn-sm btn-ghost" data-act="delete-listing" data-id="${esc(l.id)}">Gỡ</button>
          </div>
        </td>
      </tr>`;
  }

  async function seedDemo(btn) {
    await guard('seed', btn, () => api('/listings/demo-seed', { method: 'POST' }), 'Đã nhập 8 tin đăng mẫu.');
    route();
  }

  // ---------- Form đăng / sửa tin ----------

  function listingForm(l) {
    const cats = state.meta.categories || [];
    const conds = state.meta.conditions || [];
    const locs = state.meta.locations || [];
    const v = l || {};
    return `
      <div class="form-grid">
        <div class="field span-2">
          <label for="lsTitle">Tiêu đề tin *</label>
          <input id="lsTitle" type="text" maxlength="120" value="${esc(v.title || '')}" placeholder="Ví dụ: iPhone 13 128GB xanh, pin 89%">
        </div>
        <div class="field">
          <label for="lsCategory">Danh mục *</label>
          <select id="lsCategory">
            ${cats.map((c) => `<option value="${esc(c.key)}" ${v.category === c.key ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label for="lsCondition">Tình trạng</label>
          <select id="lsCondition">
            ${conds.map((c) => `<option value="${esc(c.key)}" ${(v.condition || 'GOOD') === c.key ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label for="lsPrice">Giá bán (₫) *</label>
          <input id="lsPrice" type="number" min="1000" step="1000" value="${esc(v.price || '')}" placeholder="Nhập giá bán...">
          <span class="hint">Người mua trả đúng số tiền này vào ký quỹ; bạn nhận đủ khi người mua xác nhận.</span>
        </div>
        <div class="field">
          <label for="lsLocation">Khu vực</label>
          <select id="lsLocation">
            ${locs.map((x) => `<option value="${esc(x)}" ${v.location === x ? 'selected' : ''}>${esc(x)}</option>`).join('')}
          </select>
        </div>
        <div class="field span-2">
          <label for="lsDesc">Mô tả chi tiết</label>
          <textarea id="lsDesc" maxlength="2000" placeholder="Tình trạng thực tế, phụ kiện kèm theo, lý do bán, cách giao nhận...">${esc(v.description || '')}</textarea>
        </div>
        <div class="field">
          <label for="lsVisibility">Hiển thị</label>
          <select id="lsVisibility">
            <option value="PUBLIC" ${(v.visibility || 'PUBLIC') === 'PUBLIC' ? 'selected' : ''}>Công khai</option>
            <option value="HIDDEN" ${v.visibility === 'HIDDEN' ? 'selected' : ''}>Tạm ẩn</option>
          </select>
        </div>
      </div>`;
  }

  function readListingForm() {
    return {
      title: $('#lsTitle').value.trim(),
      description: $('#lsDesc').value.trim(),
      category: $('#lsCategory').value,
      condition: $('#lsCondition').value,
      price: parseInt($('#lsPrice').value, 10),
      location: $('#lsLocation').value,
      visibility: $('#lsVisibility').value,
    };
  }

  function openNewListing() {
    openModal({
      title: 'Đăng tin bán',
      wide: true,
      body: listingForm(null),
      footer: `<button class="btn" data-act="modal-close">Huỷ</button>
               <button class="btn btn-primary" data-act="save-listing">Đăng tin</button>`,
    });
  }

  async function openEditListing(id) {
    const l = await api('/listings/' + encodeURIComponent(id));
    openModal({
      title: 'Sửa tin đăng',
      wide: true,
      body: listingForm(l) + (l.isSold
        ? `<div class="note note-warning" style="margin-top:var(--s-4)">${ico('circle-alert', 18)}
             <span>Tin này đã có người thanh toán nên không đổi được giá bán.</span></div>`
        : ''),
      footer: `<button class="btn" data-act="modal-close">Huỷ</button>
               <button class="btn btn-primary" data-act="save-listing" data-id="${esc(l.id)}" data-busy="${l.isSold ? '1' : ''}">Lưu thay đổi</button>`,
    });
  }

  async function saveListing(btn) {
    const id = btn.dataset.id;
    const payload = readListingForm();
    if (!payload.title) return toast('Nhập tiêu đề tin', 'err');
    if (!payload.price || payload.price < 1000) return toast('Giá bán tối thiểu 1.000₫', 'err');

    // Tin đã có người thanh toán: máy chủ chặn đổi giá, nên không gửi trường này lên.
    if (id && btn.dataset.busy) delete payload.price;

    await guard('save-listing', btn,
      () => id
        ? api('/listings/' + encodeURIComponent(id), { method: 'PATCH', body: payload })
        : api('/listings', { method: 'POST', body: payload }),
      id ? 'Đã lưu thay đổi.' : 'Đã đăng tin.');

    closeModal();
    if (!id && currentHead() !== 'shop') { location.hash = '#/shop'; return; }
    route();
  }

  function confirmDeleteListing(id) {
    openModal({
      title: 'Gỡ tin đăng',
      body: `<p>Tin sẽ không còn hiển thị trên chợ. Nếu tin từng phát sinh giao dịch, hệ thống chỉ <b>ẩn</b> tin đi
             để lịch sử giao dịch không bị mất tham chiếu.</p>`,
      footer: `<button class="btn" data-act="modal-close">Huỷ</button>
               <button class="btn btn-danger" data-act="do-delete-listing" data-id="${esc(id)}">Gỡ tin</button>`,
    });
  }

  async function doDeleteListing(id, btn) {
    const r = await guard('del:' + id, btn, () => api('/listings/' + encodeURIComponent(id), { method: 'DELETE' }));
    closeModal();
    toast(r && r.hidden ? 'Đã ẩn tin vì tin đã có lịch sử giao dịch.' : 'Đã gỡ tin.', 'ok');
    route();
  }


  // =====================================================================
  // Trang: Ví & nạp tiền
  // =====================================================================

  const ENTRY_LABEL = {
    DEMO_TOPUP: 'Số dư khởi tạo (demo)',
    TOPUP_CREDIT: 'Nạp tiền qua cổng thanh toán',
    ESCROW_LOCK_DEBIT: 'Thanh toán đơn — chuyển vào ký quỹ',
    ESCROW_LOCK_CREDIT: 'Ký quỹ nhận tiền',
    ESCROW_RELEASE_DEBIT: 'Ký quỹ giải ngân',
    ESCROW_RELEASE_CREDIT: 'Nhận tiền bán hàng',
    ESCROW_REFUND_DEBIT: 'Ký quỹ hoàn tiền',
    ESCROW_REFUND_CREDIT: 'Nhận hoàn tiền',
  };

  const PAY_METHODS = [
    { key: 'CARD', icon: 'credit-card', label: 'Thẻ ATM nội địa', note: 'Mô phỏng' },
    { key: 'EWALLET', icon: 'smartphone', label: 'Ví điện tử', note: 'Mô phỏng' },
    { key: 'BANK', icon: 'landmark', label: 'Chuyển khoản ngân hàng', note: 'Mô phỏng' },
  ];

  async function viewWallet() {
    if (!state.user) return requireLogin('Đăng nhập để xem ví của bạn.');
    if (state.user.role === 'ADMIN') {
      return wrongRole('Quản trị viên không phải một bên của giao dịch nên không có ví.');
    }

    view().innerHTML = `
      <div class="page">
        ${banner('Ví & nạp tiền', 'Mọi biến động số dư được ghi thành bút toán và có khoá chống ghi trùng')}
        <div class="stat-grid" id="walletStats"></div>
        ${topupCard()}
        <div class="card">
          <div class="card-head"><h2>Lịch sử nạp tiền</h2></div>
          <div class="table-scroll" id="topupHistory"></div>
        </div>
        <div class="card">
          <div class="card-head"><h2>Biến động số dư</h2></div>
          <div class="table-scroll" id="walletLedger"></div>
        </div>
      </div>`;

    const [wallet, buying, selling] = await Promise.all([
      api('/wallets/me'),
      api('/transactions?as=buyer').catch(() => ({ transactions: [] })),
      state.user.role === 'SELLER' ? api('/transactions?as=seller').catch(() => ({ transactions: [] })) : { transactions: [] },
    ]);
    state.wallet = wallet;
    const holding = (list) => list.filter((t) => ['LOCKED', 'FROZEN'].includes(t.escrowStatus)).reduce((s, t) => s + t.amount, 0);

    $('#walletStats').innerHTML = `
      <div class="card stat">
        <span class="ico-box">${ico('wallet', 22)}</span>
        <span><span class="k">Số dư khả dụng</span><span class="v">${money(wallet.availableBalance)}</span></span>
      </div>
      <div class="card stat trust">
        <span class="ico-box">${ico('shield-check', 22)}</span>
        <span><span class="k">Tiền bạn đã trả, đang giữ trong ký quỹ</span><span class="v">${money(holding(buying.transactions))}</span></span>
      </div>
      ${state.user.role === 'SELLER' ? `
      <div class="card stat trust">
        <span class="ico-box">${ico('clock', 22)}</span>
        <span><span class="k">Tiền bán hàng chờ người mua xác nhận</span><span class="v">${money(holding(selling.transactions))}</span></span>
      </div>` : ''}`;

    await loadTopupHistory();

    const { entries } = await api('/wallets/me/entries');
    $('#walletLedger').innerHTML = entries.length === 0
      ? '<div class="empty"><p class="muted">Ví chưa có biến động nào.</p></div>'
      : `
        <table class="data">
          <thead><tr><th>Thời điểm</th><th>Nội dung</th><th class="num">Thay đổi</th><th class="num">Số dư sau</th></tr></thead>
          <tbody>${entries.map((e) => `
            <tr>
              <td class="nowrap">${fmtDateTime(e.createdAt)}</td>
              <td>
                <div>${esc(ENTRY_LABEL[e.entryType] || e.entryType)}</div>
                ${e.transactionId ? `<a class="tiny muted" href="#/tx/${esc(e.transactionId)}">Giao dịch #${esc(shortId(e.transactionId))}</a>` : ''}
              </td>
              <td class="num ${e.availableDelta > 0 ? 'delta-pos' : e.availableDelta < 0 ? 'delta-neg' : ''}">
                ${e.availableDelta ? (e.availableDelta > 0 ? '+' : '') + money(e.availableDelta) : '—'}</td>
              <td class="num">${money(e.availableAfter)}</td>
            </tr>`).join('')}
          </tbody>
        </table>`;
    renderChrome();
  }

  // ---------- Nạp tiền qua Mock Payment Provider ----------
  //
  // Giao diện KHÔNG bao giờ tự cộng số dư. Sau khi người dùng "thanh toán" ở cổng thanh toán mô
  // phỏng, trang chỉ hỏi lại máy chủ trạng thái của yêu cầu; số dư chỉ được vẽ lại khi máy chủ đã
  // tất toán SUCCEEDED (qua webhook, hoặc qua đối soát nếu webhook thất lạc).

  const TOPUP_PRESETS = [100000, 200000, 500000, 1000000, 2000000];

  function topupCard() {
    const method = state.topupMethod || 'CARD';
    return `
      <div class="card">
        <div class="card-head"><h2>Nạp tiền vào ví</h2><span class="tag tag-navy">${ico('shield-check', 12)} Cổng thanh toán mô phỏng</span></div>
        <div class="card-body stack">
          <div class="field">
            <label for="topupAmount">Số tiền</label>
            <div class="chips">${TOPUP_PRESETS.map((v) =>
              `<button class="chip" data-act="topup-preset" data-v="${v}">${money(v)}</button>`).join('')}</div>
            <input id="topupAmount" type="number" min="1000" step="1000" placeholder="Hoặc nhập số tiền khác...">
          </div>
          <div class="field">
            <label>Phương thức thanh toán</label>
            <div class="radio-cards">
              ${PAY_METHODS.map((m) => `
                <label class="radio-card">
                  <input type="radio" name="payMethod" value="${m.key}" ${method === m.key ? 'checked' : ''}>
                  ${ico(m.icon, 20)}
                  <span>${esc(m.label)}<small>${esc(m.note)}</small></span>
                </label>`).join('')}
            </div>
            <span class="hint">Cả ba phương thức đều đi qua cùng một cổng thanh toán mô phỏng — đồ án không nối cổng thật.</span>
          </div>
          <div class="note">
            ${ico('info', 18)}
            <span>Số dư chỉ tăng khi <b>cổng thanh toán xác nhận thành công</b> (webhook đã ký, hoặc đối soát tự động nếu
              webhook thất lạc). Trang này không tự cộng tiền trước khi máy chủ xác nhận.</span>
          </div>
          <div><button class="btn btn-primary btn-lg" data-act="topup-create">${ico('wallet', 18)} Tiếp tục thanh toán</button></div>
        </div>
      </div>`;
  }

  async function loadTopupHistory() {
    const box = $('#topupHistory');
    if (!box) return;
    const { paymentRequests } = await api('/payments/me');
    if (paymentRequests.length === 0) {
      box.innerHTML = '<div class="empty"><p class="muted">Chưa có lần nạp tiền nào.</p></div>';
      return;
    }
    box.innerHTML = `
      <table class="data">
        <thead><tr><th>Thời điểm</th><th class="num">Số tiền</th><th>Trạng thái</th><th>Kết quả</th><th></th></tr></thead>
        <tbody>${paymentRequests.map((p) => {
          const ui = PAYMENT_UI[p.status] || { label: p.status, tone: '' };
          return `
            <tr>
              <td class="nowrap">${fmtDateTime(p.createdAt)}</td>
              <td class="num">${money(p.amount)}</td>
              <td><span class="tag ${ui.tone}">${esc(ui.label)}</span></td>
              <td class="muted small">${p.resolvedAt
                ? `${fmtDateTime(p.resolvedAt)} · ${esc(RESOLVED_BY_LABEL[p.resolvedBy] || '')}`
                : 'Chờ cổng thanh toán trả kết quả'}</td>
              <td>${p.status === 'PENDING'
                ? `<button class="btn btn-sm" data-act="checkout-open" data-id="${esc(p.id)}" data-ref="${esc(p.providerRef)}">Mở lại cổng thanh toán</button>`
                : ''}</td>
            </tr>`;
        }).join('')}
        </tbody>
      </table>`;
  }

  /** Gọi "trang" của Mock Provider — nằm ngoài /api vì đó là hệ thống của provider, không phải của sàn. */
  async function providerApi(path, { method = 'GET', body } = {}, retried = false) {
    // Cổng giả lập chỉ cho đúng người tạo yêu cầu nạp tiền thao tác, nên phải kèm phiên.
    const headers = body !== undefined ? { 'Content-Type': 'application/json' } : {};
    if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
    const res = await fetch('/mock-provider' + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && !retried && await refreshSession()) return providerApi(path, { method, body }, true);
    if (!res.ok) {
      const err = new Error(data.message || data.error || `Lỗi HTTP ${res.status}`);
      err.code = data.error;
      throw err;
    }
    return data;
  }

  async function createTopup(btn) {
    const amount = Number($('#topupAmount') ? $('#topupAmount').value : NaN);
    if (!Number.isInteger(amount) || amount < 1000) return toast('Nhập số tiền là số nguyên, tối thiểu 1.000₫', 'err');
    const picked = document.querySelector('input[name="payMethod"]:checked');
    state.topupMethod = picked ? picked.value : 'CARD';
    const pr = await guard('topup-create', btn, () => api('/payments/topup', { method: 'POST', body: { amount } }));
    await loadTopupHistory();
    await openCheckout(pr.id, pr.providerRef);
  }

  async function openCheckout(paymentRequestId, providerRef) {
    let page;
    try {
      page = await providerApi('/checkout/' + encodeURIComponent(providerRef));
    } catch (e) {
      return toast(e.code === 'NOT_FOUND' ? 'Cổng thanh toán mô phỏng đang tắt (MOCK_PROVIDER_CHECKOUT=0).' : e.message, 'err');
    }
    const settled = page.status !== 'PENDING';
    const m = PAY_METHODS.find((x) => x.key === (state.topupMethod || 'CARD')) || PAY_METHODS[0];
    openModal({
      title: 'Cổng thanh toán (mô phỏng)',
      body: `
        <div class="note note-warning" style="margin-bottom:var(--s-4)">
          ${ico('info', 18)}
          <span>Đây là trang của <b>cổng thanh toán</b>, không phải của sàn. Trong demo, bạn chọn kết quả thanh toán;
            cổng sẽ gửi webhook đã ký về máy chủ của sàn.</span>
        </div>
        <div class="price-row"><span>Phương thức</span><span>${ico(m.icon, 16)} ${esc(m.label)}</span></div>
        <div class="price-row"><span>Mã giao dịch tại cổng</span><span class="mono">${esc(shortId(page.providerRef))}</span></div>
        <div class="price-row total"><span>Số tiền thanh toán</span><span class="val">${money(page.amount)}</span></div>
        ${settled ? `<div class="note note-success" style="margin-top:var(--s-4)">${ico('circle-check', 18)}<span>Cổng thanh toán
          đã có kết quả <b>${esc(page.status)}</b>. Nếu ví chưa đổi, hệ thống sẽ tự đối soát.</span></div>` : ''}`,
      footer: settled
        ? '<button class="btn" data-act="modal-close">Đóng</button>'
        : `
          <button class="btn" data-act="modal-close">Để sau</button>
          <button class="btn btn-danger" data-act="checkout-pay" data-id="${esc(paymentRequestId)}" data-ref="${esc(providerRef)}"
            data-outcome="FAILED" data-deliver="1">Thanh toán thất bại</button>
          <button class="btn" data-act="checkout-pay" data-id="${esc(paymentRequestId)}" data-ref="${esc(providerRef)}"
            data-outcome="SUCCEEDED" data-deliver="0" title="Cổng ghi nhận thành công nhưng webhook không tới được máy chủ">
            Thành công, webhook thất lạc</button>
          <button class="btn btn-primary" data-act="checkout-pay" data-id="${esc(paymentRequestId)}" data-ref="${esc(providerRef)}"
            data-outcome="SUCCEEDED" data-deliver="1">${ico('circle-check', 17)} Thanh toán thành công</button>`,
    });
  }

  async function payCheckout(el) {
    const { id, ref, outcome } = el.dataset;
    const deliverWebhook = el.dataset.deliver === '1';
    await guard('checkout:' + ref, el, () => providerApi(`/checkout/${encodeURIComponent(ref)}/pay`, {
      method: 'POST', body: { outcome, deliverWebhook },
    }));
    closeModal();
    await waitForTopupResult(id);
  }

  /** Hỏi máy chủ trạng thái yêu cầu nạp tiền trong vài giây. Không tự đoán kết quả. */
  async function waitForTopupResult(paymentRequestId) {
    toast('Đang xử lý — chờ cổng thanh toán xác nhận…');
    let p = null;
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      try { p = await api('/payments/' + encodeURIComponent(paymentRequestId)); } catch (_) { continue; }
      if (p.status !== 'PENDING') break;
    }
    if (p && p.status === 'SUCCEEDED') {
      toast(`Nạp tiền thành công ${RESOLVED_BY_LABEL[p.resolvedBy] || ''}: ${money(p.amount)} đã vào ví.`, 'ok');
      await refreshWallet();
    } else if (p && p.status === 'FAILED') {
      toast('Cổng thanh toán báo thất bại. Ví của bạn không thay đổi.', 'err');
    } else {
      toast('Chưa có xác nhận từ cổng thanh toán. Hệ thống sẽ tự đối soát; số dư chỉ thay đổi khi có kết quả.');
    }
    if (currentHead() === 'wallet') route(); else renderChrome();
  }


  // =====================================================================
  // Trang: Thông báo & việc cần làm
  // =====================================================================

  const TODO_ICON = {
    PAY_ORDER: 'lock', ACK_ORDER: 'badge-check', SHIP_ORDER: 'truck', CONFIRM_RECEIPT: 'package', RELEASE_OR_DISPUTE: 'circle-check',
    TOPUP_PENDING: 'wallet', ADJUDICATE_DISPUTE: 'gavel', REVIEW_SELLER_REQUESTS: 'store',
  };

  function todoLink(item) {
    if (item.kind === 'ADJUDICATE_DISPUTE') return '#/admin/disputes';
    if (item.kind === 'REVIEW_SELLER_REQUESTS') return '#/admin/seller-requests';
    if (item.kind === 'TOPUP_PENDING') return '#/wallet';
    return item.transactionId ? `#/tx/${encodeURIComponent(item.transactionId)}` : '#/';
  }

  /** Việc cần xử lý — máy chủ tính từ trạng thái thật, không từ bảng thông báo. */
  async function loadTodo(selector, { hideWhenEmpty = false } = {}) {
    const box = $(selector);
    if (!box) return;
    let items;
    try { ({ items } = await api('/notifications/todo')); } catch (_) { box.innerHTML = ''; return; }
    if (items.length === 0) {
      box.innerHTML = hideWhenEmpty ? '' : `
        <div class="note note-success" style="margin-bottom:var(--s-5)">
          ${ico('circle-check', 18)}<span>Không có việc nào đang chờ bạn.</span>
        </div>`;
      return;
    }
    box.innerHTML = `
      <div class="card" style="margin-bottom:var(--s-5)">
        <div class="card-head"><h2>Việc cần xử lý</h2><span class="badge-count">${items.length}</span></div>
        <div class="card-body stack" style="gap:var(--s-3)">
          ${items.map((i) => `
            <a class="todo-item" href="${todoLink(i)}">
              ${ico(TODO_ICON[i.kind] || 'clipboard-list', 18)}
              <span class="grow"><b>${esc(i.title)}</b><span class="muted small">${esc(i.detail)}</span></span>
              ${ico('chevron-right', 16)}
            </a>`).join('')}
        </div>
      </div>`;
  }

  async function viewNotifications() {
    if (!state.user) return requireLogin('Đăng nhập để xem thông báo của bạn.');
    view().innerHTML = `
      <div class="page">
        ${banner('Thông báo & việc cần làm',
          'Việc cần làm được tính từ trạng thái thật của đơn hàng; thông báo là lịch sử các sự kiện đã xảy ra',
          `<button class="btn" data-act="notif-read-all">${ico('check', 17)} Đánh dấu đã đọc hết</button>`)}
        <div id="todoBox">${skeletonGrid(1)}</div>
        <div class="card">
          <div class="card-head"><h2>Thông báo</h2></div>
          <div class="card-body" id="notifList"></div>
        </div>
      </div>`;
    await loadTodo('#todoBox');
    await loadNotifList();
  }

  async function loadNotifList() {
    const box = $('#notifList');
    if (!box) return;
    const { notifications, unreadCount } = await api('/notifications?limit=50');
    state.unread = unreadCount;
    if (notifications.length === 0) {
      box.innerHTML = '<p class="muted" style="margin:0">Chưa có thông báo nào.</p>';
      return;
    }
    box.innerHTML = notifications.map((n) => `
      <a class="notif-item ${n.read ? '' : 'unread'}" href="#" data-act="notif-open" data-id="${esc(n.id)}"
         data-tx="${esc(n.transactionId || '')}" data-pay="${esc(n.paymentRequestId || '')}">
        <span class="grow">
          <b>${esc(n.title)}</b>
          ${n.body ? `<span class="small">${esc(n.body)}</span>` : ''}
          <span class="muted tiny">${fmtDateTime(n.createdAt)}</span>
        </span>
        ${n.read ? '' : '<span class="tag tag-info">Mới</span>'}
      </a>`).join('');
  }

  async function openNotification(el) {
    try { await api(`/notifications/${encodeURIComponent(el.dataset.id)}/read`, { method: 'POST' }); } catch (_) { /* vẫn điều hướng */ }
    if (el.dataset.tx) location.hash = '#/tx/' + el.dataset.tx;
    else if (el.dataset.pay) location.hash = '#/wallet';
    else route();
  }

  async function readAllNotifications(btn) {
    await guard('notif-read-all', btn, () => api('/notifications/read-all', { method: 'POST' }));
    route();
  }

  // =====================================================================
  // Trang: Chi tiết giao dịch — "control center" của một giao dịch ký quỹ
  // =====================================================================
  //
  // Phần này KHÔNG chép từ chợ nào: đây là dấu ấn riêng của hệ thống. Gom về một chỗ: trạng thái
  // theo dòng thời gian (mốc giờ đọc từ chuỗi nhật ký thật), tiền đang ở đâu, và ĐÚNG MỘT nhóm hành
  // động hiện tại cho đúng vai trò người xem. Hành động lấy từ cùng orderActions() với trang danh
  // sách, nên hai nơi không thể lệch nhau; máy chủ vẫn tự kiểm lại mọi điều kiện.

  const ESCROW_BOX = {
    NONE:     { cls: 'done',   label: 'Chưa thanh toán',             text: 'Tiền vẫn ở ví người mua, chưa vào ký quỹ.', here: 0 },
    LOCKED:   { cls: '',       label: 'Đang được giữ an toàn',       text: 'Người bán chưa nhận được tiền; người mua chỉ lấy lại được qua phân xử.', here: 1 },
    FROZEN:   { cls: 'frozen', label: 'Đang bị đóng băng',           text: 'Không bên nào rút được cho tới khi quản trị viên phân xử.', here: 1 },
    RELEASED: { cls: 'done',   label: 'Đã giải ngân cho người bán',  text: 'Giao dịch đã tất toán.', here: 2 },
    REFUNDED: { cls: 'done',   label: 'Đã hoàn cho người mua',       text: 'Giao dịch đã tất toán.', here: 0 },
  };

  async function viewTransaction(id) {
    if (!state.user) return requireLogin('Đăng nhập để xem chi tiết giao dịch.');
    if (!id) { location.hash = consoleHome(); return; }

    const [t, { logs }] = await Promise.all([
      api('/transactions/' + encodeURIComponent(id)),
      api(`/transactions/${encodeURIComponent(id)}/logs`),
    ]);
    const me = state.user;
    const role = t.buyerId === me.id ? 'BUYER' : t.sellerId === me.id ? 'SELLER' : me.role === 'ADMIN' ? 'ADMIN' : null;
    const isBuyer = role === 'BUYER';

    view().innerHTML = `
      <div class="page">
        <div class="breadcrumb">
          <a href="${consoleHome()}">${role === 'ADMIN' ? 'Quản trị' : 'Giao dịch của tôi'}</a>${ico('chevron-right', 14)}
          <span>Giao dịch #${esc(shortId(t.id))}</span>
        </div>

        <div class="tx-head">
          <div>
            <div class="tx-id">Giao dịch #${esc(shortId(t.id))} · tạo lúc ${fmtDateTime(t.createdAt)}</div>
            <div class="tx-title">${t.listingId ? `<a href="#/listing/${esc(t.listingId)}">${esc(t.itemName)}</a>` : esc(t.itemName)}</div>
            <div class="tx-parties">
              <span>Người mua: <b>${esc(t.buyerName || '—')}</b></span>
              <span>Người bán: <b>${esc(t.sellerName || '—')}</b></span>
              ${role ? `<span>Bạn là: <b>${esc(ROLE_LABEL[role])}</b></span>` : ''}
            </div>
          </div>
          <div class="tx-value">
            <span>Giá trị giao dịch</span>
            <b>${money(t.amount)}</b>
            <div style="margin-top:6px">${statusTag(t)}</div>
          </div>
        </div>

        <div class="tx-grid">
          <div class="stack">
            <div class="card">
              <div class="card-head"><h2>Trạng thái giao dịch</h2><span class="tag tag-navy">${ico('link-2', 12)} ${logs.length} bản ghi trong chuỗi băm</span></div>
              <div class="card-body"><ol class="steps">${txSteps(t, logs)}</ol></div>
            </div>
            ${t.dispute ? disputeCard(t.dispute) : ''}
            <div class="card">
              <div class="card-head"><h3>Nhật ký chi tiết</h3></div>
              <div class="card-body">
                ${logs.map((l) => `
                  <div class="log-row">
                    <div class="row-between"><b>${esc(ACTION_LABEL[l.action] || l.action)}</b><span class="muted small">${fmtDateTime(l.createdAt)}</span></div>
                    <div class="muted small">${esc(l.oldStatus || 'khởi tạo')} → ${esc(l.newStatus || '—')}</div>
                  </div>`).join('')}
              </div>
            </div>
          </div>

          <div class="stack">
            ${escrowBox(t)}
            ${actionBox(t, role, isBuyer)}
            <div class="card">
              <div class="card-head"><h3>Bảo mật của giao dịch</h3></div>
              <div class="card-body stack" style="gap:var(--s-3)">
                <div class="small" style="display:grid;gap:8px">
                  <div class="row" style="flex-wrap:nowrap;align-items:flex-start">${ico('fingerprint', 16)}<span>Giải ngân và phân xử luôn đòi <b>xác thực lại bằng Passkey</b>, kể cả khi đang đăng nhập.</span></div>
                  <div class="row" style="flex-wrap:nowrap;align-items:flex-start">${ico('key-round', 16)}<span>Phiếu uỷ quyền dùng một lần, ràng buộc đúng giao dịch này, đúng số tiền, đúng người nhận.</span></div>
                  <div class="row" style="flex-wrap:nowrap;align-items:flex-start">${ico('link-2', 16)}<span>Mọi bước được ghi vào chuỗi băm riêng của giao dịch; sửa lén một bản ghi sẽ bị phát hiện.</span></div>
                </div>
                <div class="row">
                  <button class="btn btn-sm" data-act="tx-verify-chain" data-id="${esc(t.id)}">${ico('shield-check', 15)} Kiểm chứng chuỗi nhật ký</button>
                  <a class="btn btn-sm btn-ghost" href="#/audit/${esc(t.id)}">Xem mã băm</a>
                </div>
                <div id="txChainResult"></div>
              </div>
            </div>
          </div>
        </div>
      </div>`;
  }

  /** Dòng thời gian: 6 bước chuẩn, chèn bước tranh chấp nếu có; mốc giờ lấy từ chuỗi nhật ký. */
  function txSteps(t, logs) {
    const timeOf = (actions) => {
      const l = logs.find((x) => actions.includes(x.action));
      return l ? l.createdAt : null;
    };
    const steps = TX_STEPS.map((s) => ({ ...s }));
    const last = steps[steps.length - 1];
    if (t.status === 'COMPLETED') last.label = 'Người mua giải ngân — hoàn tất';
    if (t.status === 'RELEASED') last.label = 'Giải ngân cho người bán theo phân xử';
    if (t.status === 'REFUNDED') last.label = 'Hoàn tiền cho người mua theo phân xử';

    let done = stepsDone(t);
    if (t.dispute) {
      steps.splice(steps.length - 1, 0, { key: 'DISPUTE', label: 'Mở tranh chấp — tiền bị đóng băng', actions: ['DISPUTE_OPENED'], dispute: true });
      if (t.status !== 'DISPUTED') done += 1;
    }

    return steps.map((s, i) => {
      let cls = i < done ? 'done' : 'pending';
      if (i === done && done < steps.length) cls = 'current';
      if (s.dispute && t.status === 'DISPUTED') cls = 'failed';
      const time = timeOf(s.actions);
      const note = s.key === 'ACK' && cls === 'done' && !t.sellerAckAt ? 'Người bán gửi hàng mà không bấm xác nhận đơn riêng' : '';
      return `
        <li class="step ${cls}">
          <span class="step-dot">${cls === 'done' ? ico('check', 14) : cls === 'failed' ? ico('triangle-alert', 13) : ''}</span>
          <div>
            <div class="step-title">${esc(s.label)}</div>
            ${time ? `<div class="step-time">${fmtDateTime(time)}</div>` : ''}
            ${note ? `<div class="step-note">${esc(note)}</div>` : ''}
          </div>
        </li>`;
    }).join('');
  }

  function escrowBox(t) {
    const b = ESCROW_BOX[t.escrowStatus] || ESCROW_BOX.NONE;
    const flow = ['Ví người mua', 'Ký quỹ', 'Ví người bán'];
    return `
      <div class="escrow-box ${b.cls}">
        <div class="label">${ico('shield-check', 15)} Tiền ký quỹ</div>
        <div class="amount">${money(t.amount)}</div>
        <div><b>${esc(b.label)}</b></div>
        ${b.text ? `<div class="small" style="margin-top:2px">${esc(b.text)}</div>` : ''}
        <div class="escrow-flow">
          ${flow.map((f, i) => `<span class="${i === b.here ? 'here' : ''}">${esc(f)}</span>${i < flow.length - 1 ? ico('arrow-right', 14) : ''}`).join('')}
        </div>
      </div>`;
  }

  function actionBox(t, role, isBuyer) {
    const acts = role === 'ADMIN'
      ? (t.status === 'DISPUTED' ? `<a class="btn btn-primary" href="#/admin/disputes">${ico('gavel', 16)} Phân xử tranh chấp</a>` : '')
      : role ? orderActions(t, isBuyer) : '';
    const text = role === 'ADMIN'
      ? (t.status === 'DISPUTED' ? 'Hồ sơ tranh chấp đang chờ bạn phân xử.' : 'Không có việc gì cho quản trị viên ở giao dịch này.')
      : nextStepText(t, isBuyer);
    const warn = isBuyer && t.status === 'WAIT_CONFIRM'
      ? `<div class="note note-warning" style="margin-top:var(--s-3)">${ico('triangle-alert', 18)}
          <span>Chỉ giải ngân khi đã kiểm hàng. Sau bước này tiền thuộc về người bán và không rút lại được.</span></div>`
      : '';
    return `
      <div class="action-box ${acts ? '' : 'idle'}">
        <h3>Hành động hiện tại</h3>
        <p class="small" style="margin:0;color:var(--text-2)">${esc(text)}</p>
        ${warn}
        ${acts ? `<div class="row">${acts}</div>` : ''}
      </div>`;
  }

  function disputeCard(d) {
    const resolved = d.status !== 'OPEN';
    return `
      <div class="card">
        <div class="card-head">
          <h2>Tranh chấp</h2>
          <span class="tag ${resolved ? 'tag-success' : 'tag-danger'}">${resolved ? 'Đã phân xử' : 'Đang chờ phân xử'}</span>
        </div>
        <div class="card-body">
          <p class="small muted" style="margin:0 0 6px">Mở bởi <b>${d.openedBy === 'BUYER' ? 'người mua' : 'người bán'}</b> lúc ${fmtDateTime(d.createdAt)}</p>
          <p style="margin:0 0 6px">“${esc(d.reason)}”</p>
          ${resolved ? `<p class="small" style="margin:0">Quyết định: <b>${d.adminDecision === 'REFUND'
            ? 'Hoàn tiền cho người mua' : 'Giải ngân cho người bán'}</b> lúc ${fmtDateTime(d.resolvedAt)}</p>` : ''}
        </div>
      </div>`;
  }

  async function verifyTxChain(el) {
    const r = await guard('txchain:' + el.dataset.id, el,
      () => api(`/transactions/${encodeURIComponent(el.dataset.id)}/logs/verify`));
    const box = $('#txChainResult');
    if (!box || !r) return;
    box.innerHTML = r.valid
      ? `<div class="note note-success">${ico('shield-check', 18)}<span>Chuỗi nhật ký hợp lệ — đã kiểm ${esc(r.checkedCount)} bản ghi.</span></div>`
      : `<div class="note note-danger">${ico('triangle-alert', 18)}<span>Chuỗi nhật ký không hợp lệ tại bản ghi #${esc(r.invalidLogId)}.</span></div>`;
  }


  // =====================================================================
  // Trang: Quản trị — mỗi tab là một destination riêng trên sidebar
  // =====================================================================

  const ADMIN_PAGES = {
    disputes: { title: 'Tranh chấp', subtitle: 'Tiền của các đơn dưới đây đang bị đóng băng trong ví ký quỹ. Quyết định của bạn được ghi vĩnh viễn vào chuỗi nhật ký của đơn' },
    'seller-requests': { title: 'Yêu cầu mở cửa hàng', subtitle: 'Duyệt là nâng chính tài khoản đó từ Người mua lên Người bán — ví, passkey và lịch sử đơn của họ giữ nguyên' },
    users:    { title: 'Người dùng', subtitle: 'Toàn bộ tài khoản đang có trên hệ thống, theo vai trò' },
    invariants: { title: 'Bất biến hệ thống', subtitle: 'Chín tính chất phải luôn đúng, kiểm trực tiếp trên dữ liệu chứ không dựa vào cảm nhận' },
    'security-events': { title: 'Sự kiện bảo mật', subtitle: 'Nhật ký các lần bị từ chối hoặc thực hiện thao tác nhạy cảm — khác nhật ký giao dịch, phần lớn không gắn với đơn hàng nào' },
  };

  async function viewAdmin(tab) {
    if (!state.user) return requireLogin('Đăng nhập bằng tài khoản quản trị.');
    if (state.user.role !== 'ADMIN') {
      return wrongRole('Tài khoản của bạn không có quyền quản trị.');
    }

    state.adminTab = ADMIN_PAGES[tab] ? tab : 'disputes';
    const page = ADMIN_PAGES[state.adminTab];
    const actions = '';

    view().innerHTML = `
      <div class="page">
        ${banner(page.title, page.subtitle, actions)}
        ${state.adminTab === 'disputes' ? '<div id="todoBox"></div>' : ''}
        <div id="adminPanel">${skeletonGrid(2)}</div>
      </div>`;

    if (state.adminTab === 'disputes') loadTodo('#todoBox', { hideWhenEmpty: true });
    if (state.adminTab === 'seller-requests') return loadSellerRequests();
    if (state.adminTab === 'users') return loadAdminUsers();
    if (state.adminTab === 'invariants') return loadInvariants();
    if (state.adminTab === 'security-events') return loadSecurityEvents();
    return loadDisputes();
  }

  // Chín bất biến, đọc thẳng từ máy chủ — kể cả số thứ tự, tên và phát biểu. Cùng một hàm mà
  // bộ kiểm thử tự động gọi sau mỗi testcase, nên màn hình này và kết quả test không thể nói
  // hai điều khác nhau, và không có danh sách chép tay nào ở giao diện để lệch đi.
  async function loadInvariants() {
    const box = $('#adminPanel');
    if (!box) return;
    const result = await api('/admin/invariants');
    const broken = new Map();
    for (const v of result.violations) {
      if (!broken.has(v.invariant)) broken.set(v.invariant, []);
      broken.get(v.invariant).push(v.detail);
    }

    box.innerHTML = `
      <div class="note" style="margin-bottom:var(--s-5)">
        ${ico(result.ok ? 'shield-check' : 'frown', 18)}
        <span>${result.ok
          ? `Cả <b>${result.checked}</b> bất biến đều đúng trên dữ liệu hiện tại.`
          : `Có <b>${result.violations.length}</b> vi phạm. Đây là dấu hiệu dữ liệu hoặc logic đã sai, không phải lỗi hiển thị.`}</span>
      </div>
      <div class="stack" style="gap:var(--s-4)">
        ${result.checks.map((c) => {
          const bad = broken.get(c.code);
          return `
            <div class="card"><div class="card-body">
              <div class="row-between" style="align-items:flex-start">
                <div class="grow">
                  <h3 style="margin:0 0 4px">${c.no}. ${esc(c.name)}</h3>
                  <p class="muted small" style="margin:0">${esc(c.statement)}</p>
                  ${bad ? `<ul class="muted small" style="margin:8px 0 0">${bad.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>` : ''}
                </div>
                <span class="tag ${bad ? 'tag-danger' : 'tag-success'}">${bad ? 'VI PHẠM' : 'ĐÚNG'}</span>
              </div>
            </div></div>`;
        }).join('')}
      </div>`;
  }

  async function loadSellerRequests() {
    const { requests } = await api('/admin/seller-requests');
    const list = $('#adminPanel');
    if (!list) return;

    if (requests.length === 0) {
      list.innerHTML = empty('inbox', 'Chưa có yêu cầu nào',
        'Khi một Người mua gửi yêu cầu mở cửa hàng từ trang chủ, yêu cầu sẽ xuất hiện ở đây.');
      return;
    }

    list.innerHTML = `<div class="stack" style="gap:var(--s-5)">${requests.map((r) => {
      const st = SELLER_REQUEST_UI[r.status] || { label: r.status, tone: '' };
      const open = r.status === 'PENDING';
      return `
        <div class="card"><div class="card-body">
          <div class="row-between" style="align-items:flex-start">
            <div class="grow">
              <h3>${esc(r.shopName)}</h3>
              <div class="muted small">
                Người gửi <b>${esc(r.userName || '—')}</b> (@${esc(r.userUsername || '')})
                · Gửi lúc ${fmtDateTime(r.createdAt)}
              </div>
            </div>
            <span class="tag ${st.tone}">${esc(st.label)}</span>
          </div>

          ${r.pitch
            ? `<p class="small" style="margin:var(--s-4) 0;white-space:pre-wrap">“${esc(r.pitch)}”</p>`
            : `<p class="small muted" style="margin:var(--s-4) 0">Người gửi không viết mô tả.</p>`}

          ${!open && r.reviewNote
            ? `<div class="note ${r.status === 'REJECTED' ? 'note-danger' : 'note-success'}" style="margin-bottom:var(--s-4)">
                 ${ico(r.status === 'REJECTED' ? 'circle-alert' : 'circle-check', 18)}
                 <span>${esc(r.reviewNote)}</span>
               </div>`
            : ''}

          <div class="row">
            ${open ? `
              <button class="btn btn-primary btn-sm" data-act="approve-seller-request" data-id="${esc(r.id)}">
                ${ico('circle-check', 15)} Duyệt &amp; nâng lên Người bán
              </button>
              <button class="btn btn-danger btn-sm" data-act="open-reject-seller-request" data-id="${esc(r.id)}">
                ${ico('x', 15)} Từ chối
              </button>
            ` : `<span class="muted small">
                   ${r.status === 'APPROVED' ? 'Đã duyệt' : 'Đã từ chối'}
                   ${r.reviewedByName ? 'bởi ' + esc(r.reviewedByName) : ''}
                   ${r.reviewedAt ? 'lúc ' + fmtDateTime(r.reviewedAt) : ''}
                 </span>`}
          </div>
        </div></div>`;
    }).join('')}</div>`;
  }

  async function approveSellerRequest(id, btn) {
    await guard('sr-approve:' + id, btn, () => api(`/admin/seller-requests/${id}/approve`, {
      method: 'POST', body: { note: 'Đã duyệt' },
    }), 'Đã duyệt. Tài khoản này giờ là Người bán và mở cửa hàng được ngay.');
    route();
  }

  function openRejectSellerRequest(id) {
    openModal({
      title: 'Từ chối yêu cầu mở cửa hàng',
      body: `
        <div class="field">
          <label for="srReject">Lý do từ chối *</label>
          <textarea id="srReject" maxlength="500" placeholder="Nêu lý do..."></textarea>
          <span class="hint">Người gửi đọc được lý do này ở trang chủ và có thể gửi lại yêu cầu.</span>
        </div>`,
      footer: `
        <button class="btn" data-act="modal-close">Huỷ</button>
        <button class="btn btn-danger" data-act="do-reject-seller-request" data-id="${esc(id)}">Từ chối</button>`,
    });
  }

  async function rejectSellerRequest(id, btn) {
    const note = $('#srReject') ? $('#srReject').value.trim() : '';
    if (!note) return toast('Vui lòng nêu lý do từ chối', 'err');
    await guard('sr-reject:' + id, btn, () => api(`/admin/seller-requests/${id}/reject`, {
      method: 'POST', body: { note },
    }), 'Đã từ chối yêu cầu.');
    closeModal();
    route();
  }

  async function loadDisputes() {
    const { disputes } = await api('/admin/disputes');
    const list = $('#adminPanel');
    if (!list) return;

    if (disputes.length === 0) {
      list.innerHTML = empty('shield-check', 'Không có tranh chấp nào', 'Mọi đơn hàng đang diễn ra suôn sẻ.');
      return;
    }

    list.innerHTML = `<div class="stack" style="gap:var(--s-5)">${disputes.map((d) => {
      const t = d.transaction || {};
      const open = d.status === 'OPEN';
      return `
        <div class="card"><div class="card-body">
          <div class="row-between" style="align-items:flex-start">
            <div class="grow">
              <h3>${esc(t.itemName || 'Đơn hàng')}</h3>
              <div class="muted small">
                Người mua <b>${esc(t.buyerName || '—')}</b> · Người bán <b>${esc(t.sellerName || '—')}</b>
                · Mở lúc ${fmtDateTime(d.createdAt)}
              </div>
            </div>
            <span class="tag ${open ? 'tag-danger' : 'tag-success'}">${open ? 'Chờ xử lý' : d.status === 'RESOLVED_REFUND' ? 'Đã hoàn tiền' : 'Đã chuyển cho chủ'}</span>
          </div>

          <div class="money-strip">
            <div><span>Số tiền</span><b>${money(t.amount || 0)}</b></div>
    
            <div><span>Ký quỹ đóng băng</span><b>${money(t.amount || 0)}</b></div>
    
          </div>

          <p class="small" style="margin:0 0 4px">
            <b>${d.openedBy === 'BUYER' ? 'Người mua' : 'Người bán'} ${esc(d.createdByName || '')} khiếu nại:</b>
          </p>
          <p class="small" style="margin:0 0 var(--s-4);white-space:pre-wrap">“${esc(d.reason)}”</p>

          <div class="row">
            ${open ? `
              <button class="btn btn-sm" data-act="admin-refund" data-id="${esc(d.id)}">${ico('rotate-ccw', 15)} Hoàn ${money(t.amount || 0)} cho người mua</button>
              <button class="btn btn-primary btn-sm" data-act="admin-release" data-id="${esc(d.id)}">${ico('banknote', 15)} Chuyển ${money(t.amount || 0)} cho người bán</button>
            ` : `<span class="muted small">Đã xử lý lúc ${fmtDateTime(d.resolvedAt)}</span>`}
            <a class="btn btn-ghost btn-sm" href="#/audit/${esc(d.transactionId)}">${ico('link-2', 15)} Nhật ký</a>
          </div>
        </div></div>`;
    }).join('')}</div>`;
  }

  /**
   * Phân xử tranh chấp.
   *
   * Quyết định này làm tiền rời khỏi ký quỹ, nên nó cũng phải kèm phiếu uỷ quyền sinh từ
   * một lần xác thực lại bằng Passkey của CHÍNH quản trị viên — đúng nguyên tắc áp cho
   * người mua, không có ngoại lệ cho quyền quản trị.
   *
   * Quyết định được gửi lên NGAY TỪ bước xin challenge và được máy chủ lưu vào ngữ cảnh uỷ
   * quyền. Phiếu cấp ra ràng buộc đúng quyết định đó, nên một phiếu xin cho "hoàn tiền"
   * không dùng được cho "giải ngân". Nếu thiếu ràng buộc này thì lần xác thực lại chỉ chứng
   * minh quản trị viên có mặt, chứ không chứng minh đã chấp thuận điều gì.
   */
  async function adminResolve(kind, disputeId, btn) {
    const decision = kind === 'refund' ? 'REFUND' : 'RELEASE';
    await guard('adm:' + disputeId, btn, async () => {
      const { reauthSessionId, options } = await api(`/admin/disputes/${disputeId}/reauth/options`, {
        method: 'POST', body: { decision },
      });
      const assertion = await webauthn('reauth', () =>
        SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: options }));
      const { reauthGrant } = await api(`/admin/disputes/${disputeId}/reauth/verify`, {
        method: 'POST', body: { reauthSessionId, response: assertion },
      });
      return api(`/admin/disputes/${disputeId}/${kind}`, {
        method: 'POST', body: { requestId: newRequestId(), reauthGrant },
      });
    }, kind === 'refund' ? 'Đã hoàn toàn bộ tiền cho người mua.' : 'Đã chuyển toàn bộ tiền cho người bán.');
    route();
  }

  // ---------- Quản trị: người dùng ----------

  async function loadAdminUsers() {
    const { users } = await api('/admin/users');
    const list = $('#adminPanel');
    if (!list) return;

    const counts = users.reduce((acc, u) => ({ ...acc, [u.role]: (acc[u.role] || 0) + 1 }), {});
    list.innerHTML = `
      <div class="stat-grid" style="margin-bottom:var(--s-6)">
        <div class="card stat">
          <span class="ico-box">${ico('shopping-bag', 22)}</span>
          <span><span class="k">Người mua</span><span class="v">${counts.BUYER || 0}</span></span>
        </div>
        <div class="card stat">
          <span class="ico-box">${ico('store', 22)}</span>
          <span><span class="k">Người bán</span><span class="v">${counts.SELLER || 0}</span></span>
        </div>
        <div class="card stat">
          <span class="ico-box">${ico('shield-check', 22)}</span>
          <span><span class="k">Quản trị viên</span><span class="v">${counts.ADMIN || 0}</span></span>
        </div>
      </div>
      <div class="card"><div class="table-scroll">
        <table class="data">
          <thead><tr><th>Tên hiển thị</th><th>Tên đăng nhập</th><th>Vai trò</th><th class="num">Sản phẩm</th><th>Tham gia</th></tr></thead>
          <tbody>${users.map((u) => `
            <tr>
              <td>${esc(u.displayName)}</td>
              <td class="mono">@${esc(u.username)}</td>
              <td><span class="tag ${u.role === 'ADMIN' ? 'tag-danger' : u.role === 'SELLER' ? 'tag-navy' : ''}">${esc(ROLE_LABEL[u.role])}</span></td>
              <td class="num">${u.role === 'SELLER' ? u.listingCount : '—'}</td>
              <td class="nowrap">${fmtDateTime(u.createdAt)}</td>
            </tr>`).join('')}</tbody>
        </table>
      </div></div>`;
  }

  // ---------- Quản trị: sự kiện bảo mật ----------
  //
  // Khác nhật ký giao dịch (chỉ ghi các lần CHUYỂN TRẠNG THÁI THÀNH CÔNG của một đơn), bảng
  // này trả lời câu hỏi "ai đã THỬ làm gì mà bị từ chối" — phần lớn không gắn với đơn hàng
  // nào (đăng nhập sai, phiếu uỷ quyền hết hạn, chữ ký sai origin...). Xem lib/securityEvents.js.

  function formatDetail(detail) {
    const entries = Object.entries(detail || {});
    if (entries.length === 0) return '—';
    return esc(entries.map(([k, v]) => `${k}: ${v}`).join(' · '));
  }

  async function loadSecurityEvents() {
    const box = $('#adminPanel');
    if (!box) return;

    const params = new URLSearchParams({ limit: '150' });
    if (state.secEventsType) params.set('type', state.secEventsType);
    const { events } = await api('/admin/security-events?' + params.toString());

    const typeOptions = Object.keys(SECURITY_EVENT_LABEL).map((k) =>
      `<option value="${k}" ${state.secEventsType === k ? 'selected' : ''}>${esc(SECURITY_EVENT_LABEL[k])}</option>`
    ).join('');

    box.innerHTML = `
      <div class="row" style="margin-bottom:var(--s-5);align-items:center">
        <label class="muted small" for="secEventType">Lọc theo loại</label>
        <select id="secEventType" style="width:auto">
          <option value="">Tất cả loại sự kiện</option>
          ${typeOptions}
        </select>
        <span class="muted small">${events.length} bản ghi gần nhất</span>
      </div>
      ${events.length === 0
        ? empty('shield-check', 'Chưa có sự kiện nào',
            'Chưa ghi nhận lần đăng nhập sai, phiếu hết hạn hay thao tác nào bị từ chối phù hợp bộ lọc này.')
        : `<div class="card"><div class="table-scroll">
            <table class="data">
              <thead><tr>
                <th>Thời gian</th><th>Sự kiện</th><th>Kết quả</th><th>Người dùng</th>
                <th>IP</th><th>Yêu cầu</th><th class="num">Mã</th><th>Chi tiết</th>
              </tr></thead>
              <tbody>${events.map((e) => `
                <tr>
                  <td class="nowrap">${fmtDateTime(e.createdAt)}</td>
                  <td>
                    ${esc(SECURITY_EVENT_LABEL[e.eventType] || e.eventType)}<br>
                    <span class="tag tag-mono">${esc(e.eventType)}</span>
                  </td>
                  <td><span class="tag ${e.outcome === 'ALLOWED' ? 'tag-success' : 'tag-danger'}">${e.outcome === 'ALLOWED' ? 'Cho phép' : 'Từ chối'}</span></td>
                  <td>${e.username ? '@' + esc(e.username) : '<span class="muted">—</span>'}</td>
                  <td class="mono small">${esc(e.ip || '—')}</td>
                  <td class="mono small">${esc(e.method || '')} ${esc(e.route || '')}</td>
                  <td class="num">${e.statusCode == null ? '—' : e.statusCode}</td>
                  <td class="small muted">${formatDetail(e.detail)}</td>
                </tr>`).join('')}
              </tbody>
            </table>
          </div></div>`}`;

    const sel = $('#secEventType');
    if (sel) sel.addEventListener('change', () => {
      state.secEventsType = sel.value;
      loadSecurityEvents();
    });
  }

  // =====================================================================
  // Trang: Nhật ký & Hash Chain
  // =====================================================================

  const ACTION_LABEL = {
    TRANSACTION_CREATED: 'Tạo giao dịch',
    ORDER_CREATED: 'Tạo đơn hàng',
    ESCROW_LOCKED: 'Khoá tiền vào ký quỹ',
    SELLER_ACKNOWLEDGED: 'Người bán xác nhận đơn',
    SELLER_SHIPPED: 'Người bán gửi hàng',
    BUYER_RECEIVED_PACKAGE: 'Người mua đã nhận hàng',
    ESCROW_RELEASED: 'Tất toán & giải ngân',
    DISPUTE_OPENED: 'Mở tranh chấp',
    ADMIN_REFUND: 'Quản trị viên hoàn tiền',
    ADMIN_RELEASE: 'Quản trị viên giải ngân',
  };

  async function viewAudit(txId) {
    if (!state.user) return requireLogin('Đăng nhập để tra cứu nhật ký đơn của bạn.');

    view().innerHTML = `
      <div class="page">
        ${banner('Nhật ký & Hash Chain',
          'Mỗi đơn hàng có một chuỗi băm riêng: log sau chứa hash của log trước. Sửa lén một dòng trong database sẽ làm gãy chuỗi và bị phát hiện ngay')}

        <div class="card"><div class="card-body">
          <div class="row">
            <div class="input-wrap grow">
              ${ico('search', 16)}
              <input id="auditTxId" type="text" placeholder="Dán mã giao dịch..." value="${esc(txId || '')}">
            </div>
            <button class="btn" data-act="audit-load">Xem nhật ký</button>
            <button class="btn btn-primary" data-act="audit-verify">${ico('shield-check', 17)} Kiểm chứng chuỗi</button>
          </div>
          <p class="muted tiny" style="margin:10px 0 0">Mã giao dịch nằm ở trang chi tiết giao dịch (nút "Xem mã băm").</p>
        </div></div>

        <div id="auditResult"></div>
      </div>`;

    if (txId) await loadAudit(txId);
  }

  async function loadAudit(txId) {
    const box = $('#auditResult');
    if (!box) return;
    if (!txId) return toast('Nhập mã đơn hàng', 'err');
    box.innerHTML = '<div class="skeleton" style="height:160px"></div>';
    try {
      const { logs } = await api(`/transactions/${encodeURIComponent(txId)}/logs`);
      if (logs.length === 0) {
        box.innerHTML = empty('file-text', 'Đơn này chưa có log', 'Có thể mã đơn chưa đúng.');
        return;
      }
      box.innerHTML = `
        <div class="card">
          <div class="card-head">
            <h3>${logs.length} bản ghi</h3>
            <span class="tag tag-navy">Chuỗi băm riêng cho đơn này</span>
          </div>
          <div class="card-body">
            ${logs.map((l, i) => `
              <div class="log-row">
                <div class="row-between">
                  <b>#${l.id} · ${esc(ACTION_LABEL[l.action] || l.action)}</b>
                  <span class="muted tiny">${fmtDateTime(l.createdAt)}</span>
                </div>
                <div class="muted tiny">${esc(l.oldStatus || 'khởi tạo')} → ${esc(l.newStatus || '—')}</div>
                <div class="hashes">
                  ${i === 0 ? '<span class="chain-link">GENESIS</span> ' : ''}prev: ${esc(l.previousHash)}<br>
                  curr: <span class="chain-link">${esc(l.currentHash)}</span>
                </div>
              </div>`).join('')}
          </div>
        </div>`;
    } catch (e) {
      box.innerHTML = empty('ban', 'Không xem được nhật ký', e.message);
    }
  }

  async function verifyAudit(btn) {
    const txId = $('#auditTxId').value.trim();
    if (!txId) return toast('Nhập mã đơn hàng', 'err');
    const result = await guard('verify', btn, () => api(`/transactions/${encodeURIComponent(txId)}/logs/verify`));
    if (!result) return;

    if (result.valid) {
      toast(`Hash Chain hợp lệ — đã kiểm tra ${result.checkedCount} bản ghi, không có dấu hiệu bị sửa.`, 'ok');
    } else {
      toast(`Hash Chain không hợp lệ — phát hiện sai lệch tại bản ghi #${result.invalidLogId}.`, 'err');
    }
    await loadAudit(txId);
  }

  // =====================================================================
  // Điều phối sự kiện (event delegation)
  // =====================================================================

  const HANDLERS = {
    'open-auth': () => openAuthModal('login'),
    'open-auth-register': () => openAuthModal('register'),
    'auth-tab': (el) => switchAuthTab(el.dataset.tab),


    'open-seller-request': () => openSellerRequestModal(),
    'do-seller-request': (el) => submitSellerRequest(el),
    'approve-seller-request': (el) => approveSellerRequest(el.dataset.id, el),
    'open-reject-seller-request': (el) => openRejectSellerRequest(el.dataset.id),
    'do-reject-seller-request': (el) => rejectSellerRequest(el.dataset.id, el),

    'do-login-passkey': (el) => doLoginPasskey(el),
    'do-login-password': (el) => doLoginPassword(el),
    'do-register': (el) => doRegister(el),
    'do-enroll-passkey': (el) => doEnrollPasskey(el),
    'do-bootstrap-password': (el) => doBootstrapPassword(el),
    'do-logout': () => logout(),
    'open-change-password': () => openChangePasswordModal(),
    'do-change-password': (el) => doChangePassword(el),
    'add-device': (el) => addDevice(el),
    'del-device': (el) => deleteDevice(el.dataset.id, el),
    'logout': () => logout(),
    'modal-close': () => closeModal(),
    'reload': () => route(),
    'open-sell': () => openSell(),
    'filter-cat': (el) => { state.filters.category = el.dataset.cat || ''; goHome(); },
    'clear-filters': () => { state.filters = { q: '', category: '', condition: '', location: '', sort: 'new' }; goHome(); },
    'load-more': () => { state.homeLimit += HOME_PAGE_SIZE; renderListingPage(); },
    'scroll-products': () => { const el = $('#products'); if (el) el.scrollIntoView({ behavior: 'smooth' }); },

    'do-order': (el) => doOrder(el.dataset.id, el),

    'filter-order': (el) => { state.orderFilter = el.dataset.f; route(); },
    'order-tab': (el) => { state.orderTab = el.dataset.tab; route(); },
    'acknowledge': (el) => acknowledgeOrder(el.dataset.id, el),
    'secure': (el) => secureOrder(el.dataset.id, el, el.dataset.then),
    'ship': (el) => shipOrder(el.dataset.id, el),
    'wait-confirm': (el) => waitConfirmOrder(el.dataset.id, el),
    'open-release': (el) => openReleaseModal(el.dataset.id),
    'do-release': (el) => doRelease(el.dataset.id, el),
    'open-dispute': (el) => openDisputeModal(el.dataset.id),
    'do-dispute': (el) => doDispute(el.dataset.id, el),

    'new-listing': () => openNewListing(),
    'edit-listing': (el) => openEditListing(el.dataset.id),
    'save-listing': (el) => saveListing(el),
    'delete-listing': (el) => confirmDeleteListing(el.dataset.id),
    'do-delete-listing': (el) => doDeleteListing(el.dataset.id, el),
    'seed-demo': (el) => seedDemo(el),

    'admin-refund': (el) => adminResolve('refund', el.dataset.id, el),
    'admin-release': (el) => adminResolve('release', el.dataset.id, el),

    'audit-load': () => loadAudit($('#auditTxId').value.trim()),
    'audit-verify': (el) => verifyAudit(el),

    'topup-preset': (el) => { const input = $('#topupAmount'); if (input) input.value = el.dataset.v; },
    'topup-create': (el) => createTopup(el),
    'checkout-open': (el) => openCheckout(el.dataset.id, el.dataset.ref),
    'checkout-pay': (el) => payCheckout(el),
    'notif-open': (el) => openNotification(el),
    'notif-read-all': (el) => readAllNotifications(el),
    'tx-verify-chain': (el) => verifyTxChain(el),
  };

  function onDocumentClick(e) {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;

    if (act === 'modal-backdrop') {
      if (e.target === el) closeModal();
      return;
    }
    const handler = HANDLERS[act];
    if (!handler) return;
    e.preventDefault();
    Promise.resolve(handler(el)).catch(() => { /* lỗi đã được guard() báo qua toast */ });
  }

  // =====================================================================
  // Khởi động
  // =====================================================================

  async function init() {
    document.addEventListener('click', onDocumentClick);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
    window.addEventListener('hashchange', route);
    const topSearch = $('#topSearch');
    if (topSearch) topSearch.addEventListener('submit', (e) => {
      e.preventDefault();
      state.filters.q = ($('#topSearchInput').value || '').trim();
      goHome();
    });

    // Khôi phục phiên: xác nhận lại token với server thay vì tin localStorage.
    if (state.token) {
      try {
        const me = await api('/users/me');
        state.user = me.user;
        state.wallet = me.wallet;
        localStorage.setItem(STORAGE_USER, JSON.stringify(me.user));
      } catch (_) {
        clearSession();
      }
    }

    await refreshSellerRequest();
    renderChrome();
    await route();

    // Polling thông báo: đủ cho phạm vi đồ án, không cần WebSocket. Chỉ vẽ lại khung khi số
    // chưa đọc thật sự đổi.
    setInterval(async () => {
      if (!state.token) return;
      const before = state.unread;
      await refreshUnread();
      if (state.unread !== before) renderChrome();
    }, 20000);

    // Làm mới access token trước khi nó hết hạn (15 phút), và ngay khi quay lại tab sau một lúc
    // để máy ngủ, để người dùng không bị đăng xuất giữa chừng.
    setInterval(() => { if (state.token) refreshSession(); }, 10 * 60 * 1000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && state.token) refreshSession();
    });
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', App.init);
