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
  const SIGNED_OUT='cat_signed_out';
  const HOME_PAGE_SIZE = 18;    // số tin mỗi lần "Xem thêm" ở trang chủ

  const state = {
    token: null,
    user: null,
    wallet: null,
    sellerRequest: null,        // yêu cầu cấp quyền bán hàng mới nhất của chính mình
    meta: null,                 // danh mục + tình trạng + khu vực, nạp 1 lần từ /api/listings/meta
    filters: { q: '', category: '', condition: '', location: '', sort: 'new' },
    homeLimit: HOME_PAGE_SIZE,  // số tin đang hiện ở trang chủ
    homeListings: [],           // kết quả tìm gần nhất, để "Xem thêm" không phải gọi lại API
    orderTab: null,             // 'sell' | 'buy' — chỉ người bán có hai tab
    adminTab: 'disputes',       // 'disputes' | 'seller-requests' | 'users' | 'invariants' | 'security-events'
    secEventsType: '',          // bộ lọc loại sự kiện của tab "Sự kiện bảo mật"
    orderFilter: 'active',      // 'active' | 'all' | 'done'
    busy: new Set(),            // id các nút đang chạy, để khoá double-click
    unread: 0,                  // số thông báo chưa đọc — hỏi lại định kỳ (polling), không WebSocket
    topupPoll: null,            // hẹn giờ đang chờ kết quả một yêu cầu nạp tiền
    topupPollGen: 0,            // tăng mỗi lần bắt đầu/dừng theo dõi; vòng theo dõi cũ thấy số khác thì tự thoát
    topupPollWake: null,        // hàm đánh thức lượt chờ đang treo, để huỷ theo dõi cũng kết thúc Promise đang đợi
    sessionEpoch: 0,            // tăng mỗi khi PHIÊN đổi (đăng xuất, đăng nhập mới, đổi tài khoản); không tăng khi chỉ làm mới token
    topupIntent: null,          // bản nhớ trong bộ nhớ của ý định nạp tiền chưa rõ kết quả (bản lưu nằm ở localStorage)
    topupNotice: null,          // thông báo trạng thái nạp tiền đang hiện trên trang ví
    payConfig: null,            // cấu hình công khai của cổng nạp tiền do máy chủ trả (PayPal Sandbox / mô phỏng)
    paypalCallback: null,       // {kind:'return'|'cancel', id} đọc từ URL khi PayPal đưa người dùng quay lại; dùng một lần
    shippingModalId: null,
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
    REGISTRATION_DENIED: 'Thông tin đăng ký không khả dụng',
  };

  const PAYMENT_UI = {
    PENDING:   { label: 'Đang xử lý',          tone: 'tag-warning' },
    SUCCEEDED: { label: 'Thành công',          tone: 'tag-success' },
    FAILED:    { label: 'Thất bại',            tone: 'tag-danger' },
  };
  const RESOLVED_BY_LABEL = { WEBHOOK: 'qua webhook', RECONCILER: 'qua đối soát tự động' };

  // Giai đoạn (stage) của một yêu cầu nạp PayPal Sandbox do MÁY CHỦ quyết định (HOP-DONG-API-PAYPAL-P2-M2.md §5).
  // Chỉ SUCCEEDED (được GET xác nhận) mới là nạp thành công; mọi giai đoạn khác — kể cả HTTP 200, DUPLICATE, BUSY —
  // KHÔNG phải thành công.
  const PAYPAL_PROVIDER = 'PAYPAL_SANDBOX';
  const PAYPAL_STAGE_UI = {
    CREATING:                 { label: 'Đang tạo yêu cầu',            tone: 'tag-warning', hint: 'Chưa có order PayPal' },
    AWAITING_APPROVAL:        { label: 'Chờ phê duyệt PayPal',        tone: 'tag-warning', hint: 'Chờ bạn phê duyệt ở PayPal Sandbox' },
    CAPTURING:                { label: 'Đang xác nhận thanh toán',    tone: 'tag-warning', hint: 'Đang xác nhận với PayPal' },
    RECONCILING:              { label: 'Đang đối soát',               tone: 'tag-warning', hint: 'Chưa rõ kết quả — hệ thống đang đối soát' },
    CREATE_RECOVERY_REQUIRED: { label: 'Cần đối soát',                tone: 'tag-danger',  hint: 'Chưa tạo được order; không tự tạo order mới' },
    RECOVERY_REQUIRED:        { label: 'Cần xử lý thủ công',          tone: 'tag-danger',  hint: 'Có bằng chứng thu tiền nhưng yêu cầu đã đóng' },
    NOT_CAPTURED:             { label: 'Không tiếp tục thu tiền',     tone: '',            hint: 'Ví không đổi' },
    SUCCEEDED:                { label: 'Thành công',                  tone: 'tag-success', hint: '' },
    FAILED:                   { label: 'Thất bại',                    tone: 'tag-danger',  hint: 'Yêu cầu đã đóng; ví không đổi' },
  };
  const PAYPAL_STAGES = Object.keys(PAYPAL_STAGE_UI);

  // =====================================================================
  // Tiện ích
  // =====================================================================

  function safeParse(s) { try { return JSON.parse(s); } catch (_) { return null; } }

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function accountLabel(username) {
    if (!username) return '';
    return `${String(username).includes('@') ? '' : '@'}${esc(username)}`;
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

  // Gốc địa chỉ của API, do js/config.js quyết định: '' khi giao diện và API cùng một máy chủ,
  // https://api.enclave.id.vn khi giao diện chạy trên Vercel.
  const API_BASE = window.ENCLAVE_API_BASE || '';

  // Access token sống ngắn; khi hết hạn thì xin token mới bằng cookie làm mới (HttpOnly, trang
  // không đọc được). Nhiều request cùng gặp 401 thì chỉ làm mới một lần.
  // credentials: 'include' vì cookie làm mới thuộc về origin của API, có thể khác origin của trang.
  let refreshing = null;
  let cookieMutation=Promise.resolve();
  function withAuthCookieLock(fn){
    if(navigator.locks?.request)return navigator.locks.request('enclave-auth-cookie',fn);
    const job=cookieMutation.then(fn,fn);cookieMutation=job.catch(()=>{});return job;
  }
  function refreshSession() {
    if(localStorage.getItem(SIGNED_OUT)==='1')return Promise.resolve(false);
    const epoch = state.sessionEpoch;
    const userId = state.user && state.user.id;
    if (!refreshing || refreshing.epoch !== epoch) {
      const job = { epoch, promise: null };
      job.promise = (async () => {
        try {
          const perform=async()=>{
            for(let attempt=0;attempt<3;attempt++){
              const result=await fetchJson(API_BASE + '/api/passkeys/session/refresh', {method:'POST',credentials:'include'});
              if(result.res.status!==409||result.data.error!=='SESSION_REFRESH_ROTATED'||attempt===2)return result;
              await new Promise(resolve=>setTimeout(resolve,150*2**attempt));
              if(state.sessionEpoch!==epoch||localStorage.getItem(SIGNED_OUT)==='1')return {res:{ok:false},data:{}};
            }
          };
          const {res,data} = await withAuthCookieLock(perform);
          if (state.sessionEpoch !== epoch || !res.ok) return false;
          if (state.sessionEpoch !== epoch || !data.token || !data.user || (userId && data.user.id !== userId)) return false;
          setSession(data.token, { ...(state.user || {}), ...data.user });
          if(data.scope==='recover')authUi.recoveryEmail=data.recoveryMethod==='EMAIL';
          return true;
        } catch (_) { return false; }
      })();
      refreshing = job;
      job.promise.finally(() => { if (refreshing === job) refreshing = null; });
    }
    return refreshing.promise;
  }

  // ---------------------------------------------------------------------
  // Thông báo lỗi API
  //
  // Người dùng chỉ được thấy câu tiếng Việt do giao diện hoặc máy chủ chủ động viết. Không bao
  // giờ hiện mã lỗi thô, stack trace hay nội dung phản hồi của lớp trung gian (Vercel, Railway,
  // proxy): các lớp đó có thể trả HTML hoặc JSON không theo định dạng của sàn.
  // ---------------------------------------------------------------------

  const UNKNOWN_OUTCOME_MSG =
    'Chưa nhận được phản hồi từ máy chủ nên chưa rõ thao tác đã được thực hiện hay chưa. ' +
    'Đừng thử lại ngay: hãy kiểm tra lại trạng thái (đơn hàng, ví, lịch sử nạp tiền) rồi mới quyết định.';

  const API_ERROR_MESSAGES = {
    EMAIL_NOT_CONFIGURED:()=> 'Dịch vụ email xác minh chưa được cấu hình. Vui lòng liên hệ quản trị viên để hoàn tất thiết lập.',
    INVALID_AMOUNT: () => 'Số tiền phải là số nguyên đồng, ví dụ 150000 — không có phần lẻ, chữ hay ký tự khác.',
    // Khoảng hợp lệ thay đổi theo thao tác (nạp tiền, giao dịch) và cấu hình, nên lấy từ chính câu
    // của máy chủ ("… từ X đến Y") thay vì ghi cứng một con số ở đây.
    AMOUNT_OUT_OF_RANGE: (data) => {
      const m = /từ\s+(.+?)\s+đến\s+(.+?)\s*$/.exec(String((data && data.message) || ''));
      return m ? `Số tiền ngoài phạm vi cho phép: phải từ ${m[1]} đến ${m[2]}.` : 'Số tiền ngoài phạm vi cho phép.';
    },
    LISTING_STATE_CONFLICT: () =>
      'Trạng thái sản phẩm chưa khớp với đơn hàng. Tiền chưa được chuyển; hãy báo quản trị viên kèm mã giao dịch để kiểm tra.',
    // 401 này KHÔNG phải hết phiên: phiếu uỷ quyền Passkey sai, hết hạn hoặc đã dùng. Người dùng vẫn
    // đang đăng nhập và chỉ cần xác thực lại.
    REAUTH_REQUIRED: () =>
      'Thao tác này cần xác thực lại bằng Passkey. Phiếu xác thực đã hết hạn hoặc đã được dùng; bạn vẫn đang đăng nhập — ' +
      'hãy bắt đầu lại thao tác và xác thực Passkey khi được yêu cầu.',
    // 503 của POST /payments/topup: yêu cầu ĐÃ được lưu ở máy chủ, chỉ chưa gửi được sang cổng. Gửi lại bằng cùng
    // requestId là an toàn (không tạo trùng).
    PAYPAL_DISABLED: () =>
      'Nạp tiền bằng PayPal Sandbox hiện chưa được bật hoặc chưa đủ cấu hình. Không có yêu cầu nào được tạo và giao diện không tự chuyển sang cổng khác.',
    PAYPAL_CREATE_RECOVERY_REQUIRED: () =>
      'Yêu cầu này đã không tạo được order PayPal trong 5 phút đầu và hệ thống KHÔNG tự tạo order mới. Cần hỗ trợ đối soát — ' +
      'hãy giữ mã tham chiếu của yêu cầu.',
    PAYPAL_ORDER_MISMATCH: () =>
      'Dữ liệu order PayPal không khớp với yêu cầu đã lưu. Dừng mọi thao tác tự động; cần đối soát thủ công.',
    PAYPAL_CAPTURE_CONFLICT: () =>
      'Bằng chứng thu tiền của yêu cầu này cần được đối soát thủ công. Dừng mọi thao tác tự động; ví không bị giao diện thay đổi.',
    PAYPAL_CAPTURE_CLAIM_LOST: () =>
      'Một thao tác xác nhận khác đang giữ quyền thu tiền cho yêu cầu này. Không gửi thêm lệnh nào — hãy bấm "Kiểm tra lại" để xem trạng thái.',
    PAYMENT_PROVIDER_MISMATCH: () =>
      'Yêu cầu này thuộc một cổng thanh toán khác với cổng bạn đang dùng. Hãy kiểm tra lại trong Lịch sử nạp tiền.',
    PROVIDER_UNAVAILABLE: () =>
      'Cổng thanh toán tạm thời không nhận yêu cầu. Yêu cầu nạp tiền của bạn đã được lưu, chưa bị mất — hãy bấm "Thử lại cùng yêu cầu" ' +
      'sau ít phút (hệ thống cũng sẽ tự gửi lại).',
    DISPUTE_NOT_OPEN: () =>
      'Tranh chấp này không còn ở trạng thái chờ xử lý — có thể đã được xử lý ở nơi khác. Không có khoản tiền nào được chuyển thêm; ' +
      'danh sách sẽ được tải lại.',
  };

  /** Câu của máy chủ chỉ được dùng khi đúng định dạng lỗi của sàn và trông như một câu người đọc được. */
  function safeServerMessage(data) {
    const code = data && data.error;
    const msg = data && data.message;
    if (typeof code !== 'string' || !/^[A-Z][A-Z0-9_]{2,60}$/.test(code)) return null;
    if (typeof msg !== 'string' || !msg.trim() || msg.length > 300) return null;
    if (/[<>]/.test(msg) || /\bat\s+\S+\s*\(.*:\d+/.test(msg)) return null; // HTML hoặc dấu vết stack
    return msg.trim();
  }

  function apiErrorMessage(status, data) {
    const body = data && typeof data === 'object' ? data : {};
    const known = API_ERROR_MESSAGES[body.error];
    if (known) return known(body);

    if (status >= 500) {
      const ref = typeof body.requestId === 'string' && /^[0-9a-f-]{8,40}$/i.test(body.requestId)
        ? ` Mã tham chiếu: ${body.requestId.slice(0, 8)}.` : '';
      return ([502, 503, 504].includes(status)
        ? 'Máy chủ tạm thời không phản hồi. Hãy thử lại sau ít phút.'
        : 'Hệ thống gặp lỗi khi xử lý yêu cầu. Hãy thử lại sau ít phút.')
        + ' Nếu bạn vừa gửi một thao tác liên quan đến tiền hoặc đơn hàng, hãy kiểm tra lại trạng thái trước khi làm lại.' + ref;
    }

    const own = safeServerMessage(body);
    if (own) return own;
    switch (status) {
      case 400: return 'Yêu cầu không hợp lệ. Hãy kiểm tra lại thông tin đã nhập.';
      case 401: return 'Bạn cần đăng nhập để thực hiện thao tác này.';
      case 403: return 'Bạn không có quyền thực hiện thao tác này.';
      case 404: return 'Không tìm thấy nội dung được yêu cầu.';
      case 409: return 'Trạng thái đã thay đổi so với lúc bạn xem. Hãy tải lại trang rồi thử lại.';
      case 429: return 'Bạn thao tác quá nhanh. Hãy chờ một lúc rồi thử lại.';
      default: return `Yêu cầu không thực hiện được (mã HTTP ${status}). Hãy thử lại sau.`;
    }
  }

  /**
   * Lỗi mất kết nối hoặc quá thời gian chờ. Với thao tác ghi, yêu cầu có thể đã tới máy chủ và đã
   * được xử lý: KHÔNG được nói "thất bại" và KHÔNG được tự coi là thành công — chỉ báo chưa rõ
   * và yêu cầu kiểm tra lại trạng thái. `unknownOutcome` để nơi gọi tự kiểm tra lại giúp.
   */
  function connectionError(method, timedOut) {
    const writes = method !== 'GET';
    const err = new Error(writes
      ? UNKNOWN_OUTCOME_MSG
      : (timedOut ? 'Máy chủ phản hồi quá lâu. Hãy kiểm tra kết nối rồi tải lại.' : 'Không kết nối được tới máy chủ. Hãy kiểm tra mạng rồi thử lại.'));
    err.code = timedOut ? 'TIMEOUT' : 'NETWORK_ERROR';
    err.unknownOutcome = writes;
    return err;
  }

  // Quá thời gian chờ coi như mất kết nối. Mặc định 30 giây; window.ENCLAVE_API_TIMEOUT_MS cho phép
  // bộ kiểm thử UI rút ngắn.
  function apiTimeoutMs() {
    const v = Number(window.ENCLAVE_API_TIMEOUT_MS);
    return v > 0 ? v : 30000;
  }

  /** fetch có hạn chờ; đọc cả phần thân trong cùng hạn đó để một thân bị cắt dở không thành "thành công rỗng". */
  async function fetchJson(url, options) {
    const method = (options && options.method) || 'GET';
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    let timedOut = false;
    const timer = ctl ? setTimeout(() => { timedOut = true; ctl.abort(); }, apiTimeoutMs()) : null;
    try {
      const res = await fetch(url, ctl ? { ...options, signal: ctl.signal } : options);
      const data = await res.json().catch(() => null);
      if (timedOut) throw new Error('timeout');
      if (res.ok && (!data || typeof data !== 'object' || Array.isArray(data))) {
        throw new Error('Invalid JSON response');
      }
      return { res, data: data && typeof data === 'object' ? data : {} };
    } catch (e) {
      throw connectionError(method, timedOut);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function api(path, { method = 'GET', body, allowAuthRetry = true } = {}, retried = false) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (state.token) headers['Authorization'] = 'Bearer ' + state.token;

    // Request này có thể được phát đi dưới một phiên đã kết thúc (đăng xuất, đăng nhập lại, đổi tài khoản) trong lúc chờ.
    // Khi đó bỏ cả phản hồi lẫn lỗi: không làm mới phiên, không thử lại bằng token của người dùng MỚI, không báo lỗi cho họ.
    const epoch = state.sessionEpoch;
    const oldSession = () => Object.assign(new Error('Phản hồi của phiên cũ'), { silent: true, stale: true });
    let res;
    let data;
    try {
      const send=()=>fetchJson(API_BASE + '/api' + path, { method, headers, credentials:'include',body:body!==undefined?JSON.stringify(body):undefined });
      const cookieEndpoint=/^\/passkeys\/(register\/(account|passkey\/verify)|login\/(password|verify)|email\/verify|recovery\/(code|email\/authorize|passkey\/verify))$/.test(path);
      ({res,data}=await (cookieEndpoint?withAuthCookieLock(send):send()));
    } catch (e) {
      throw state.sessionEpoch !== epoch ? oldSession() : e;
    }
    if (state.sessionEpoch !== epoch) throw oldSession();

    if (res.status === 401 && data.error === 'UNAUTHENTICATED' && state.token && allowAuthRetry) {
      const refreshed = !retried && await refreshSession();
      if (state.sessionEpoch !== epoch) throw oldSession();
      if (refreshed) return api(path, { method, body, allowAuthRetry }, true);
      clearSession();
      renderChrome();
      route();
      const expired = new Error('Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại');
      expired.code = 'UNAUTHENTICATED';
      expired.status = 401;
      throw expired;
    }
    if (!res.ok) {
      const err = new Error(apiErrorMessage(res.status, data));
      err.code = data.error;
      err.status = res.status;
      // 429: số giây phải chờ nằm ở header Retry-After (API khác origin cần expose header này).
      const retryAfter = Number(res.headers.get('Retry-After'));
      if (res.status === 429 && Number.isFinite(retryAfter) && retryAfter > 0) err.retryAfter = Math.ceil(retryAfter);
      throw err;
    }
    return data;
  }

  function toast(message, kind = 'info') {
    const glyph = kind === 'ok' ? 'circle-check' : kind === 'err' ? 'circle-alert' : 'info';
    const box = $('#toasts');
    const el = document.createElement('div');
    el.className = 'toast ' + kind;
    el.setAttribute('role', kind === 'err' ? 'alert' : 'status');
    el.innerHTML = `${ico(glyph, 18)}<span class="grow">${esc(message)}</span>` +
      `<button type="button" class="toast-x" aria-label="Đóng thông báo">${ico('x', 16)}</button>`;
    // Rời đi bằng hiệu ứng ngắn rồi mới gỡ; className giữ nguyên "toast <kind>" vì test đọc loại từ đó.
    const leave = () => {
      if (el.hasAttribute('data-leaving')) return;
      el.setAttribute('data-leaving', '');
      setTimeout(() => el.remove(), 200);
    };
    el.querySelector('.toast-x').addEventListener('click', leave);
    box.appendChild(el);
    setTimeout(leave, kind === 'err' ? 8000 : 5000);
  }

  /** Bọc một handler async: khoá nút, hiện spinner, bắt lỗi thành toast. */
  async function guard(key, btn, fn, successMsg) {
    if (state.busy.has(key)) return;
    state.busy.add(key);
    const original = btn ? btn.innerHTML : null;
    const generation=modalGeneration;
    const inModal=btn?.closest?.('.modal');
    const oldDismissible=modalDismissible;
    const controls=inModal?Array.from(inModal.querySelectorAll('button,input,select,textarea')).map(el=>({el,disabled:el.disabled})):[];
    if(inModal) {modalDismissible=false;controls.forEach(({el})=>{el.disabled=true;});}
    if (btn) { btn.disabled = true; btn.innerHTML = ico('loader-circle', 17, 'spin') + ' Đang xử lý…'; }
    try {
      const result = await fn();
      if (successMsg) toast(successMsg, 'ok');
      return result;
    } catch (e) {
      // Lỗi của một phản hồi cũ (phiên đã đổi) mang cờ silent: không được hiện thông báo cho người đang dùng phiên mới.
      if (!(e && e.silent)) {
        const body=$('#modalRoot .modal-body');
        if(body && inModal && generation===modalGeneration) {
          body.querySelector('.operation-error')?.remove();
          const message=document.createElement('div');message.className='note note-danger operation-error';message.setAttribute('role','alert');message.textContent=e.message;body.prepend(message);
        } else toast(e.message, 'err');
      }
      // Dữ liệu đang hiển thị đã cũ (tranh chấp đã được xử lý ở nơi khác): vẽ lại để nút không còn mời gọi
      // một thao tác sẽ lại bị từ chối.
      if (e && e.code === 'DISPUTE_NOT_OPEN') {
        closeModal();
        Promise.resolve(route()).catch(() => { /* lỗi tải lại đã được báo ở nơi khác */ });
      }
      throw e;
    } finally {
      state.busy.delete(key);
      if(inModal && generation===modalGeneration) {modalDismissible=oldDismissible;controls.forEach(({el,disabled})=>{if(el.isConnected)el.disabled=disabled;});}
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
        'Passkey của tài khoản này đã có trong bộ xác thực đang chọn. ' +
        'Hãy đăng nhập bằng Passkey đó, hoặc chọn thiết bị khác.',
      ConstraintError:
        'Thiết bị chưa bật khoá màn hình (vân tay, Face ID hoặc mã PIN). ' +
        'Passkey đầu tiên bắt buộc phải có bước xác minh này, hãy bật rồi thử lại.',
    },
    'add-device': {
      NotAllowedError:
        'Chưa thêm được thiết bị. Bạn đã bấm huỷ hoặc để quá lâu ở cửa sổ xác minh.',
      InvalidStateError:
        'Bộ xác thực đang chọn đã có Passkey của tài khoản này. Hãy chọn thiết bị hoặc bộ xác thực khác để thêm khóa dự phòng.',
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
      'Hãy mở lại đúng địa chỉ https://enclave.id.vn rồi thử lại.',
    NotSupportedError:
      'Trình duyệt hoặc thiết bị này không hỗ trợ Passkey. Hãy dùng Chrome, Edge hoặc Safari bản mới.',
    AbortError: 'Thao tác đã bị dừng giữa chừng. Hãy thử lại.',
  };

  const WEBAUTHN_CODE_HINTS = {
    ERROR_AUTHENTICATOR_GENERAL_ERROR:
      'Trình quản lý Passkey của điện thoại không tạo được khóa. Trên Android, hãy mở Enclave ' +
      'trực tiếp bằng Chrome và bật Google Password Manager; trên iPhone, dùng Safari và bật ' +
      'Mật khẩu & Chuỗi khóa iCloud, rồi thử lại.',
    ERROR_AUTHENTICATOR_MISSING_USER_VERIFICATION_SUPPORT:
      'Thiết bị chưa có phương thức xác minh phù hợp. Hãy bật khóa màn hình bằng vân tay, ' +
      'khuôn mặt hoặc mã PIN rồi thử lại.',
    ERROR_AUTHENTICATOR_MISSING_DISCOVERABLE_CREDENTIAL_SUPPORT:
      'Bộ quản lý mật khẩu hiện tại chưa hỗ trợ Passkey có thể đồng bộ. Hãy chọn Google Password ' +
      'Manager trên Android hoặc Mật khẩu & Chuỗi khóa iCloud trên iPhone.',
    ERROR_AUTHENTICATOR_NO_SUPPORTED_PUBKEYCREDPARAMS_ALG:
      'Trình duyệt hoặc bộ quản lý Passkey đã quá cũ. Hãy cập nhật trình duyệt và dịch vụ hệ thống rồi thử lại.',
    ERROR_INVALID_RP_ID:
      'Tên miền Passkey không khớp. Hãy mở đúng https://enclave.id.vn rồi thử lại.',
    ERROR_INVALID_DOMAIN:
      'Địa chỉ đang mở không đủ điều kiện tạo Passkey. Hãy mở đúng https://enclave.id.vn bằng HTTPS.',
  };

  function isMobileBrowser() {
    return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');
  }

  function isEmbeddedBrowser() {
    const ua = navigator.userAgent || '';
    return /;\s*wv\)|\bwv\b|FBAN|FBAV|Instagram|Zalo|MicroMessenger|Line\//i.test(ua);
  }

  /**
   * Kiểm tra nhẹ trước khi tạo tài khoản. Đây không thay thế bước WebAuthn thật, nhưng chặn
   * sớm các trường hợp chắc chắn không chạy được để người mới không bị tạo tài khoản dở dang.
   */
  async function inspectPasskeyReadiness() {
    const localDev = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
    const secure = window.isSecureContext === true || location.protocol === 'https:' || localDev;
    if (!secure) return { ok: false, code: 'INSECURE' };
    if (isEmbeddedBrowser()) return { ok: false, code: 'EMBEDDED' };
    if (!window.PublicKeyCredential || !navigator.credentials || typeof navigator.credentials.create !== 'function') {
      return { ok: false, code: 'UNSUPPORTED' };
    }

    try {
      if (window.SimpleWebAuthnBrowser && typeof window.SimpleWebAuthnBrowser.browserSupportsWebAuthn === 'function') {
        const supported = window.SimpleWebAuthnBrowser.browserSupportsWebAuthn();
        if (!supported) return { ok: false, code: 'UNSUPPORTED' };
      }
    } catch (_) {
      // Một số trình duyệt cũ không cung cấp API dò khả năng chi tiết. WebAuthn thật bên dưới
      // vẫn là nguồn quyết định, nên không chặn chỉ vì phép dò phụ thất bại.
    }

    if (isMobileBrowser() && typeof window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === 'function') {
      try {
        const available = await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
        if (!available) return { ok: false, code: 'NO_PLATFORM_AUTHENTICATOR' };
      } catch (_) { /* để WebAuthn thật quyết định */ }
    }
    return { ok: true, code: 'READY' };
  }

  function passkeyReadinessCopy(result) {
    const copies = {
      READY: {
        tone: 'note-success', icon: 'shield-check',
        text: '<b>Thiết bị sẵn sàng.</b> Bước tiếp theo sẽ mở vân tay, Face ID hoặc mã PIN của máy.',
      },
      EMBEDDED: {
        tone: 'note-warning', icon: 'smartphone',
        text: '<b>Trang đang mở trong trình duyệt nhúng.</b> Hãy chọn menu ⋮ → “Mở bằng Chrome/Safari”, rồi kiểm tra lại.',
      },
      NO_PLATFORM_AUTHENTICATOR: {
        tone: 'note-warning', icon: 'fingerprint',
        text: '<b>Điện thoại chưa cung cấp Passkey cho trình duyệt.</b> Hãy bật Google Password Manager hoặc Mật khẩu & Chuỗi khóa iCloud và khóa màn hình.',
      },
      INSECURE: {
        tone: 'note-danger', icon: 'shield',
        text: '<b>Trang chưa được mở qua kết nối an toàn.</b> Hãy dùng đúng địa chỉ https://enclave.id.vn.',
      },
      UNSUPPORTED: {
        tone: 'note-danger', icon: 'circle-alert',
        text: '<b>Trình duyệt này chưa hỗ trợ Passkey.</b> Hãy mở Enclave bằng Chrome hoặc Safari bản mới nhất.',
      },
    };
    return copies[result.code] || copies.UNSUPPORTED;
  }

  function renderPasskeyReadiness(target, result) {
    const box = typeof target === 'string' ? $(target.startsWith('#') ? target : `#${target}`) : target;
    if (!box || !result) return;
    const copy = passkeyReadinessCopy(result);
    box.className = `note passkey-readiness ${copy.tone}`;
    box.innerHTML = `${ico(copy.icon, 18)}<div class="passkey-readiness-body"><span>${copy.text}</span>` +
      `${result.ok ? '' : `<button class="btn btn-sm mt-2" data-act="copy-site-link">Sao chép liên kết để mở bằng Chrome hoặc Safari</button>`}</div>`;
  }

  async function refreshPasskeyReadiness(targetId) {
    const box = $(targetId.startsWith('#') ? targetId : `#${targetId}`);
    if (!box) return null;
    box.className = 'note passkey-readiness';
    box.innerHTML = `${ico('loader-circle', 18)}<div class="passkey-readiness-body"><span>Đang tự kiểm tra Passkey trên thiết bị này…</span></div>`;
    const result = await inspectPasskeyReadiness();
    renderPasskeyReadiness(box, result);
    return result;
  }

  /**
   * Bọc một lời gọi WebAuthn và đổi lỗi thô thành câu người dùng hiểu được.
   * @param kind login | enroll | add-device | reauth
   */
  async function webauthn(kind, fn) {
    try {
      return await fn();
    } catch (e) {
      // Nguyên văn giữ lại cho người phát triển; giao diện chỉ nhận câu đã diễn giải.
      console.error(`[webauthn:${kind}]`, e && e.name, e && e.code, e && e.message,
        e && e.cause && e.cause.name, e && e.cause && e.cause.message);
      const byKind = WEBAUTHN_HINTS[kind] || {};
      const errorName = (e && e.name) || (e && e.cause && e.cause.name);
      const message = byKind[errorName] || WEBAUTHN_CODE_HINTS[e && e.code] || WEBAUTHN_COMMON[errorName];
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
  let modalDismissible = true;
  let modalGeneration = 0;

  function openModal({ title, body, footer = '', wide = false, dismissible = true }) {
    closeModal({ instant: true });
    modalDismissible = dismissible;
    const root = $('#modalRoot');
    root.innerHTML = `
      <div class="modal-backdrop"${dismissible ? ' data-act="modal-backdrop"' : ''}>
        <div class="modal${wide ? ' wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="modalTitle" tabindex="-1">
          <div class="modal-head">
            <h2 id="modalTitle">${esc(title)}</h2>
            ${dismissible ? `<button class="icon-btn" data-act="modal-close" aria-label="Đóng">${ico('x', 18)}</button>` : ''}
          </div>
          <div class="modal-body">${body}</div>
          ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
        </div>
      </div>`;
    const firstInput = root.querySelector('input, select, textarea');
    // Chuyển OTP → Passkey có ô tên tùy chọn: tự focus ô này trên iPhone
    // sẽ mở lại bàn phím và có thể zoom viewport trước hộp thoại hệ điều hành.
    // Thiết bị cảm ứng focus hộp thoại có tên để vẫn hỗ trợ trình đọc màn hình.
    const touchDevice = isMobileBrowser() || (typeof window.matchMedia === 'function' && window.matchMedia('(any-pointer: coarse)').matches);
    const focusTarget = firstInput && !touchDevice ? firstInput : root.querySelector('[role="dialog"]');
    focusTarget?.focus({ preventScroll: true });
    return root;
  }

  function closeModal({ instant = false } = {}) {
    modalGeneration++;
    if (window.EnclaveShippingMotion) window.EnclaveShippingMotion.stop();
    state.shippingModalId = null;
    const root = $('#modalRoot');
    const old = root.firstElementChild;
    root.innerHTML = '';
    if (old && !instant) playModalExit(old);
    modalDismissible = true;
    state.paypalAbandonConfirmation = null;
  }

  // Hiệu ứng đóng chạy trên hộp thoại cũ đã rời #modalRoot, đặt trong một shadow root đóng: không
  // id, data-act hay .modal nào của nó còn bị querySelector/getElementById tìm thấy hay bấm trúng
  // trong 200ms nó mờ dần. Trình duyệt không có constructable stylesheet (jsdom) thì đóng ngay.
  let modalGhostSheet = null;
  function playModalExit(old) {
    if (modalGhostSheet === null) {
      try {
        const css = [...document.styleSheets].flatMap((s) => {
          try { return [...s.cssRules].map((r) => r.cssText); } catch (_) { return []; }
        }).join('\n');
        modalGhostSheet = new CSSStyleSheet();
        modalGhostSheet.replaceSync(css);
      } catch (_) { modalGhostSheet = false; }
    }
    if (!modalGhostSheet || typeof document.body.attachShadow !== 'function') return;
    const host = document.createElement('div');
    host.setAttribute('aria-hidden', 'true');
    host.inert = true;
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.adoptedStyleSheets = [modalGhostSheet];
    old.classList.add('modal-leaving');
    shadow.appendChild(old);
    document.body.appendChild(host);
    setTimeout(() => host.remove(), 200);
  }

  // Đường đóng do NGƯỜI DÙNG kích hoạt (nút đóng, bấm nền, phím Escape) phải cùng tuân theo cờ
  // dismissible. closeModal() trần vẫn dùng cho đường lập trình (đổi modal, hoàn tất đăng nhập).
  function dismissModal() {
    if(!modalDismissible)return;
    if(authUi.codes && authUi.activation){finishActivation().catch(e=>toast(e.message,'err'));return;}
    authUi.activation=null;authUi.codes=null;closeModal();
  }

  // =====================================================================
  // Phiên đăng nhập
  // =====================================================================

  function setSession(token, user) {
    localStorage.removeItem(SIGNED_OUT);
    // Phiên MỚI = chưa có phiên, hoặc đổi sang tài khoản khác. Làm mới token của cùng một phiên (refreshSession)
    // thì KHÔNG phải phiên mới, nếu không mọi thao tác đang chạy sẽ bị coi là "cũ" oan mỗi lần token được gia hạn.
    const fresh = !state.token || !state.user || !user || state.user.id !== user.id;
    state.token = token;
    state.user = user;
    if (fresh) {
      state.sessionEpoch++;
      resetTopupFlow(); // trạng thái nạp tiền trong bộ nhớ thuộc về phiên trước
      stopShippingWatch();
    }
    startShippingWatch(); // Tài khoản vừa kích hoạt Passkey cũng cần bắt đầu theo dõi.
  }

  function clearSession() {
    authUi.codes=null;authUi.nameCallback=null;authUi.linkToken=null;authUi.activation=null;authUi.lock=null;
    stopShippingWatch();
    state.token = null;
    state.user = null;
    state.wallet = null;
    state.sellerRequest = null;
    state.unread = 0;
    closeModal(); // Hộp thoại thiết lập không được tồn tại sau khi phiên kết thúc.
    localStorage.removeItem(STORAGE_TOKEN);
    localStorage.removeItem(STORAGE_USER);
    // Mọi phản hồi còn đang bay của phiên này trở thành "cũ" ngay (kể cả khi đăng nhập lại cùng tài khoản).
    state.sessionEpoch++;
    // Dừng theo dõi và bỏ trạng thái trong bộ nhớ. Bản lưu theo từng người dùng vẫn còn để chính người đó
    // phục hồi một lần nạp chưa rõ khi quay lại.
    resetTopupFlow();
  }

  async function refreshWallet() {
    const epoch = state.sessionEpoch;
    if (!state.token || !state.user || state.user.role === 'ADMIN') { state.wallet = null; return; }
    if(['BASIC','VERIFIED'].includes(state.user.accountStatus)){state.wallet=null;return;}
    try {
      const wallet = await api('/wallets/me');
      if (state.sessionEpoch === epoch) state.wallet = wallet;
    } catch (_) {
      if (state.sessionEpoch === epoch) state.wallet = null;
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
    const epoch = state.sessionEpoch;
    if (!state.token || !state.user || state.user.role !== 'BUYER') { state.sellerRequest = null; return; }
    try {
      const { request } = await api('/users/me/seller-request');
      if (state.sessionEpoch === epoch) state.sellerRequest = request;
    } catch (_) {
      if (state.sessionEpoch === epoch) state.sellerRequest = null;
    }
  }

  function logout() {
    localStorage.setItem(SIGNED_OUT,'1');
    // Thu hồi phiên ở máy chủ, không chỉ xoá token trong trình duyệt. Lỗi mạng thì vẫn đăng xuất
    // phía máy khách; phiên ở máy chủ sẽ tự hết hạn.
    const token = state.token;
    withAuthCookieLock(()=>fetch(API_BASE + '/api/passkeys/session/logout', {
      method: 'POST',
      credentials: 'include',
      headers: token ? { Authorization: 'Bearer ' + token } : {},
    })).catch(() => {});
    clearSession();
    toast('Đã đăng xuất', 'ok');
    location.hash = '#/';
    renderChrome();
    route();
  }

  // ---------- Modal xác thực ----------

  // Mô hình xác thực LAI.
  //
  // Đăng nhập mật khẩu mở phiên P có hạn mức; Passkey có UV mở phiên K. Giải ngân và
  // thay đổi thông tin xác thực vẫn cần phiếu G mới dù đang ở phiên K.
  //
  // Giao diện chỉ dẫn đường; MỌI phép kiểm đều nằm ở máy chủ. Ẩn một nút không phải là
  // một biện pháp an toàn.

  function openAuthModal(tab = 'login') {
    openModal({
      title: 'Enclave',
      body: `
        <div class="tabs tabs-split mb-5" id="authTabs">
          <button data-act="auth-tab" data-tab="login">Đăng nhập</button>
          <button data-act="auth-tab" data-tab="register">Đăng ký</button>
        </div>
        <div id="authPanel"></div>`,
    });
    switchAuthTab(tab);
  }

  let authTabGeneration=0;
  function switchAuthTab(tab) {
    authTabGeneration++;
    const title=$('#modalRoot .modal-head h2');if(title)title.textContent=tab==='login'?'Đăng nhập':'Tạo tài khoản Enclave';
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
            <label for="loginUsername">Tên đăng nhập hoặc email</label>
            <input id="loginUsername" type="text" autocomplete="username webauthn" maxlength="254">
            <p class="hint">Chưa xác minh email? Hãy dùng tên đăng nhập đã chọn khi đăng ký.</p>
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
            <label for="regEmail">Email</label>
            <input id="regEmail" type="email" autocomplete="email" maxlength="254" required>
            <span class="hint">Dùng để xác minh, nhận thông báo bảo mật và khôi phục tài khoản. Không hiển thị công khai.</span>
          </div>
          <div class="field">
            <label for="regUsername">Tên đăng nhập</label>
            <input id="regUsername" type="text" autocomplete="username" minlength="3" maxlength="32" required>
            <span class="hint">3–32 chữ thường, số, . _ -. Không đặt dấu ở đầu, cuối hoặc liền nhau. Không hiển thị công khai.</span>
          </div>
          <div class="field">
            <label for="regDisplayName">Tên hiển thị</label>
            <input id="regDisplayName" type="text" autocomplete="name" minlength="2" maxlength="40" required>
            <span class="hint">Hiển thị công khai. Đừng dùng email, số điện thoại hoặc tên giả mạo quản trị.</span>
          </div>
          <div class="field">
            <label for="regPassword">Mật khẩu</label>
            <input id="regPassword" type="password" autocomplete="new-password" minlength="8" maxlength="128" required>
            <button class="btn btn-ghost btn-sm" data-act="toggle-password" data-target="regPassword">Hiện mật khẩu</button>
            <span class="hint">Ít nhất 8 ký tự. Không dùng lại mật khẩu ở nơi khác; đây là hệ thống demo.</span>
          </div>

          <button class="btn btn-primary btn-block btn-lg" data-act="do-register">Tiếp tục</button>
          <p class="hint">Bạn có thể xem hàng ngay. Khi thanh toán lần đầu, chúng tôi sẽ nhờ bạn tạo Passkey (vân tay, khuôn mặt hoặc mã PIN thiết bị).</p>
          <p class="hint">Bằng việc tạo tài khoản, bạn đồng ý <button class="btn btn-ghost btn-sm" data-act="auth-terms">Điều khoản và Chính sách bảo mật</button>.</p>
        </div>`;
      bindRegistrationValidation();
    }
    if(tab==='login') {
      panel.insertAdjacentHTML('beforeend','<div class="row mt-3"><button class="btn btn-ghost btn-sm" data-act="forgot-password">Quên mật khẩu</button><button class="btn btn-ghost btn-sm" data-act="lost-passkey">Mất Passkey?</button></div>');
      startConditionalLogin();
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
    if(['BASIC','VERIFIED'].includes(user.accountStatus)&&(!user.emailVerified||user.emailProofFresh===false)){
      if(!user.email)return openLegacyEmailSetup();
      // openEmailVerification tự gọi ensure: dùng lại mã còn hiệu lực, không gửi/xoay mã mỗi lần mở.
      openEmailVerification(user);
      return;
    }
    if(user.accountStatus==='PENDING_EMAIL') return openEmailVerification(user);
    if(!user.emailVerified && user.role!=='ADMIN' && user.accountStatus==='PENDING_PASSKEY') return openLegacyEmailSetup();
    const bootstrap = user.accountStatus === 'PENDING_BOOTSTRAP';
    openModal({
      title: bootstrap ? 'Đổi mật khẩu tạm' : 'Kích hoạt ví bằng Passkey',
      dismissible: !bootstrap,
      body: `
        <div class="stack">
          <p class="muted m-0">${note || (bootstrap
            ? 'Đặt mật khẩu riêng của bạn để tiếp tục.'
            : esc(authUi.activation?.label || 'Kích hoạt ví để nạp tiền và mua hàng.'))}</p>

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
            <p class="muted">Đăng nhập và xác nhận giao dịch bằng vân tay, khuôn mặt hoặc mã PIN thiết bị. Máy chủ chỉ lưu khóa công khai, không lưu sinh trắc học hay khóa riêng của bạn.</p>
            <div id="setupPasskeyReadiness" class="note passkey-readiness">
              ${ico('loader-circle', 18)}<div class="passkey-readiness-body"><span>Đang tự kiểm tra Passkey trên thiết bị này…</span></div>
            </div>
            <button class="btn btn-primary btn-block btn-lg" data-act="do-enroll-passkey">
              ${ico('key-round', 17)} Tạo Passkey
            </button>
          `}

          ${!bootstrap?authField('activationDeviceName','Tên Passkey (có thể bỏ qua)','text',suggestedDeviceName())+'<p class="hint">Tặng 5.000.000 VND demo khi kích hoạt ví. Đây là số dư mô phỏng.</p><button class="btn btn-ghost btn-block" data-act="activation-later">Để sau</button>':'<button class="btn btn-ghost btn-block" data-act="do-logout">Đăng xuất và hoàn tất sau</button>'}
        </div>`,
    });
    if (!bootstrap) Promise.resolve(refreshPasskeyReadiness('setupPasskeyReadiness')).catch((error) => {
      console.error('[passkey-readiness:setup]', error);
      renderPasskeyReadiness('setupPasskeyReadiness', { ok: false, code: 'UNSUPPORTED' });
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
    if(result.verification)applyEmailMeta(result.verification);
    if(result.scope==='recover') {renderChrome();openRecoveryPasskey(result.recoveryMethod==='EMAIL');return false;}
    if (result.user.accountStatus && !['BASIC','VERIFIED','ACTIVE','RECOVERING'].includes(result.user.accountStatus)) {
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
    if(state.recoverAfterLogin){state.recoverAfterLogin=false;openRecoveryCode();return true;}
    // Kích hoạt/khôi phục xong thì tiếp tục việc đang làm. Mã dự phòng chỉ
    // hiển thị khi người dùng chủ động tạo trong Bảo mật, không chen vào đây.
    if(authUi.emailLink) await openEmailLinkModal();
    else if(authUi.activation&&state.user.accountStatus==='ACTIVE')await finishActivation();
    return true;
  }

  async function doRegister(btn) {
    for(const input of document.querySelectorAll('#authPanel input')) {if(!input.reportValidity()) return;}
    const email=$('#regEmail').value.trim();
    const username = $('#regUsername').value.trim();
    const displayName = $('#regDisplayName').value.trim();
    const password = $('#regPassword').value;
    if (!username || !displayName) return toast('Vui lòng nhập tên đăng nhập hoặc email và tên hiển thị', 'err');
    if (!password) return toast('Vui lòng đặt mật khẩu', 'err');

    await guard('register', btn, async () => {
      const result = await api('/passkeys/register/account', {
        method: 'POST', body: { email,username, displayName, password },
      });
      await afterSession(result,'Tài khoản đã tạo. Bạn có thể xem hàng ngay; xác minh email trước khi mở ví.');
    });
  }

  /** Bước 2 của đăng ký, dùng chung cho cả người dùng thường lẫn quản trị viên bootstrap. */
  async function doEnrollPasskey(btn) {
    if (!state.token || !state.user) {
      openAuthModal('login');
      toast('Phiên thiết lập đã hết hạn. Hãy đăng nhập lại để tiếp tục gắn Passkey.', 'info');
      return;
    }
    await guard('enroll', btn, async () => {
      const deviceName=$('#activationDeviceName')?.value.trim()||suggestedDeviceName();
      let prepared;
      try{prepared=await api('/passkeys/register/passkey/options',{method:'POST',body:{}});}
      catch(e){if(e.code==='EMAIL_VERIFICATION_REQUIRED')return reopenEmailStep();throw e;}
      const {registrationSessionId,options}=prepared;
      const attResp = await webauthn('enroll', () =>
        SimpleWebAuthnBrowser.startRegistration({ optionsJSON: options }));
      let result;
      // Bằng chứng email có thể hết hạn trong lúc người dùng ở hộp thoại hệ điều hành: quay lại bước email,
      // giữ nguyên authUi.activation và KHÔNG tự mở lại hộp thoại Passkey.
      try{result=await api('/passkeys/register/passkey/verify',{method:'POST',body:{registrationSessionId,response:attResp,deviceName}});}
      catch(e){if(e.code==='EMAIL_VERIFICATION_REQUIRED')return reopenEmailStep();throw e;}
      await afterSession(result,`Đã kích hoạt ví cho ${result.user.displayName}.`);
    });
  }

  /** Máy chủ đòi bằng chứng email mới: mở lại bước email, giữ (hoặc tạo) ý định kích hoạt để quay lại sau khi xác minh. */
  function reopenEmailStep() {
    state.user.emailProofFresh=false;
    if(!authUi.activation)authUi.activation={label:'Kích hoạt ví bằng Passkey.',resume:()=>route(),userId:state.user.id,hash:location.hash};
    openSetupModal(state.user);
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
    if (!username || !password) return toast('Nhập tên đăng nhập hoặc email và mật khẩu', 'err');

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
    return hash.split(/[?&]/)[0].split('/').filter(Boolean)[0] || '';
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

    if (role === 'BUYER') return [orders, wallet, inbox, security, audit];
    if (role === 'SELLER') {
      return [orders, { icon: 'store', title: 'Tin đăng của tôi', href: '#/shop' }, wallet, inbox, security, audit];
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
    renderSecurityBanner();
    const here = (location.hash || '#/').split('?')[0];
    const full=!!state.user&&['BASIC','VERIFIED','ACTIVE','RECOVERING'].includes(state.user.accountStatus)&&state.user.authMethod!=='recovery';
    const showSidebar = currentArea() === 'console' && full;
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

    if(!full){$('#topbarActions').innerHTML='<button class="top-link" data-act="resume-setup">Hoàn tất thiết lập</button><button class="top-link" data-act="do-logout">Đăng xuất</button>';return;}
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
  // Bản xem trước Vercel vẫn hiện icon đúng loại hàng khi API metadata bị chặn theo origin.
  const CATEGORY_ICON_FALLBACK = {
    DIEN_THOAI: 'smartphone', MAY_TINH: 'laptop', DIEN_TU: 'headphones',
    MAY_ANH: 'camera', THOI_TRANG: 'shirt', GIA_DUNG: 'sofa',
    SACH: 'book-open', THE_THAO: 'bike', SUU_TAM: 'gem',
  };
  function categoryIcon(key) { const c = categoryOf(key); return (c && c.icon) || CATEGORY_ICON_FALLBACK[key] || 'package'; }

  // Mỗi ngành hàng một tông màu riêng cho khung ảnh placeholder — thay cho ô xám đồng loạt,
  // để lưới sản phẩm trông có sức sống dù chưa có ảnh thật. Màu chỉ mang tính trang trí/phân
  // loại, không trùng với các màu mang nghĩa trạng thái (cam = hành động, xanh lục = ký quỹ).
  const CATEGORY_TINT_CLASS = {
    DIEN_THOAI: 'pimg-dien-thoai',
    MAY_TINH: 'pimg-may-tinh',
    DIEN_TU: 'pimg-dien-tu',
    MAY_ANH: 'pimg-may-anh',
    THOI_TRANG: 'pimg-thoi-trang',
    GIA_DUNG: 'pimg-gia-dung',
    SACH: 'pimg-sach',
    THE_THAO: 'pimg-the-thao',
    SUU_TAM: 'pimg-suu-tam',
  };
  function categoryTintClass(key) { return CATEGORY_TINT_CLASS[key] || 'pimg-neutral'; }
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
    const tintClass = tinted ? categoryTintClass(l && l.category) : '';
    return `<div class="pimg ${tintClass} ${sold ? 'is-sold' : ''}" ${sold ? `data-label="${esc(label)}"` : ''} aria-hidden="true">${ico(categoryIcon(l && l.category), size)}</div>`;
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
        <div class="note note-danger mt-3">
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
          <div class="row flex-nowrap gap-3">
            <span class="ico-box cat-action-icon">${ico('tag', 22)}</span>
            <div>
              <h3 class="m-0">Có đồ không dùng tới? Đăng bán ngay</h3>
              <p class="muted small m-2-0-0">Gửi yêu cầu mở cửa hàng; quản trị viên duyệt xong thì chính tài khoản
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

  // Bản xem trước chỉ xuất hiện khi chưa có tin thật. Không gắn id hoặc đường mua hàng:
  // khách không thể đặt mua một sản phẩm chưa tồn tại trong cơ sở dữ liệu.
  const CATALOG_PREVIEW = [
    { title: 'iPhone 13 128GB xanh, pin 89%', category: 'DIEN_THOAI', price: 9800000, location: 'Hà Nội' },
    { title: 'MacBook Air M1 2020 8GB/256GB', category: 'MAY_TINH', price: 13500000, location: 'TP. Hồ Chí Minh' },
    { title: 'Tai nghe Sony WH-1000XM4 chống ồn', category: 'DIEN_TU', price: 3900000, location: 'Hà Nội' },
    { title: 'Máy ảnh Fujifilm X-T30 kèm lens 15-45mm', category: 'MAY_ANH', price: 14200000, location: 'Đà Nẵng' },
    { title: 'Áo khoác da nam size L, đã mặc 3 lần', category: 'THOI_TRANG', price: 1150000, location: 'TP. Hồ Chí Minh' },
    { title: 'Nồi chiên không dầu Philips 4.1L', category: 'GIA_DUNG', price: 1250000, location: 'Hải Phòng' },
    { title: 'Trọn bộ Harry Potter 7 tập bản đặc biệt', category: 'SACH', price: 850000, location: 'Hà Nội' },
    { title: 'Xe đạp thể thao Giant ATX 27.5', category: 'THE_THAO', price: 5600000, location: 'Cần Thơ' },
  ];

  function previewProductCard(l) {
    return `
      <article class="pcard pcard-preview" aria-label="Sản phẩm minh họa: ${esc(l.title)}">
        <div class="pcard-media">
          ${productImage(l)}
          <span class="tag tag-primary pcard-badge">Minh họa</span>
        </div>
        <div class="pcard-body">
          <div class="pcard-title">${esc(l.title)}</div>
          <div class="pcard-price-row"><span class="pcard-price">${money(l.price)}</span></div>
          <div class="pcard-foot"><span class="pcard-meta">${ico('map-pin', 12)} ${esc(l.location)}</span></div>
        </div>
      </article>`;
  }

  function catalogPreview() {
    return `<div class="catalog-preview-head">
              <p><b>8 sản phẩm minh họa</b> để xem giao diện. Đây không phải tin đăng thật và không thể đặt mua.</p>
              ${state.user && state.user.role === 'SELLER'
                ? `<a class="btn btn-sm" href="#/shop">${ico('store', 16)} Quản lý tin đăng</a>`
                : ''}
            </div>
            <div class="grid">${CATALOG_PREVIEW.map(previewProductCard).join('')}</div>`;
  }

  function statusTag(t) {
    if (t.status === 'SECURED' && t.shipment && t.shipment.status === 'PICKUP_PENDING') {
      return '<span class="tag tag-info">Chờ xe lấy hàng</span>';
    }
    if (t.status === 'SHIPPING' && t.shipment && t.shipment.status === 'ARRIVED') {
      return '<span class="tag tag-success">Hàng đã đến · chờ nhận</span>';
    }
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
    { key: 'SHIPPED', label: 'Đã bàn giao cho vận chuyển', actions: ['SELLER_SHIPPED', 'SIMULATED_CARRIER_PICKED_UP'] },
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
        if (t.shipment && t.shipment.status === 'PICKUP_PENDING') return 'Đã đóng gói · xe đang đến lấy hàng, không cần thao tác thêm';
        if (!t.sellerAckAt) return isBuyer ? 'Chờ người bán xác nhận đơn' : 'Xác nhận đơn và chuẩn bị gửi hàng';
        return isBuyer ? 'Người bán đang đóng gói kiện hàng' : 'Đóng gói xong rồi bấm "Đã đóng gói" để xe đến lấy';
      case 'SHIPPING':
        if (t.shipment && t.shipment.status === 'IN_TRANSIT') return 'Enclave Delivery đang vận chuyển · tiền vẫn ở ký quỹ';
        if (!t.shipment) return isBuyer ? 'Bấm "Xác nhận đã nhận hàng" khi kiện hàng tới' : 'Chờ người mua nhận hàng';
        return isBuyer ? 'Kiện hàng đã đến · nhận và kiểm tra hàng trước khi xác nhận' : 'Chờ người mua nhận và kiểm tra hàng';
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
        state.sellerRequest = null;
        toast('Yêu cầu mở cửa hàng đã được duyệt. Bạn đã có thể đăng tin bán.', 'ok');
      } catch (_) { /* lần điều hướng sau sẽ thử lại */ }
    } else if (now.status === 'REJECTED') {
      toast('Yêu cầu mở cửa hàng bị từ chối. Xem lý do ở trang chủ.', 'err');
    }
  }

  async function route() {
    const hash = (location.hash || '#/').replace(/^#/, '');
    const [pathPart] = hash.split(/[?&]/);
    const parts = pathPart.split('/').filter(Boolean);
    window.scrollTo({ top: 0 });

    await syncPendingSellerRequest();
    await refreshUnread();

    if (!state.meta) {
      try { state.meta = await api('/listings/meta'); } catch (_) { state.meta = { categories: [], conditions: [], locations: [] }; }
    }

    const head = parts[0] || '';
    if (head !== 'wallet') stopTopupPoll(); // rời trang ví: không còn gì để theo dõi
    try {
      if (head === '') return await viewHome();
      if (head === 'listing') return await viewListing(parts[1]);
      if (head === 'orders') return await viewOrders();
      if (head === 'shop') return await viewShop();
      if (head === 'tx') return await viewTransaction(parts[1]);
      if (head === 'notifications') return await viewNotifications();
      if (head === 'wallet') return await viewWallet();
      if (head === 'security') return await viewSecurity();
      if(head==='account-action') {view().innerHTML='<div class="page"><div class="card p-5"><h2>Bảo mật tài khoản</h2><p>Làm theo hướng dẫn trong hộp thoại. Nếu đã đóng hoặc tải lại trang, hãy mở lại liên kết trong email.</p><button class="btn" data-act="open-auth">Đăng nhập</button></div></div>';return;}
      if (head === 'admin') return await viewAdmin(parts[1] || 'disputes');
      if (head === 'audit') return await viewAudit(parts[1]);
      view().innerHTML = `<div class="page">${empty('compass', 'Không có trang này', 'Đường dẫn bạn mở không tồn tại.',
        '<a class="btn btn-primary" href="#/">Về trang chủ</a>')}</div>`;
    } catch (e) {
      view().innerHTML = `<div class="page">${empty('frown', 'Không tải được nội dung', e.message,
        `<button class="btn" data-act="reload">${ico('refresh-cw', 17)} Tải lại</button>`)}</div>`;
    } finally {
      renderChrome();
      playViewEnter();
    }
  }

  // Bật hiệu ứng vào trang (#view[data-enter] trong style.css) sau khi route() vẽ xong, rồi tắt lại để
  // những lần vẽ lại tại chỗ ngoài route() (đếm ngược, thăm dò trạng thái) không nháy.
  let viewEnterTimer = 0;
  function playViewEnter() {
    const el = view();
    if (!el) return;
    el.removeAttribute('data-enter');
    void el.offsetWidth; // gỡ rồi gắn lại trong cùng khung hình: ép trình duyệt chạy lại animation
    el.setAttribute('data-enter', '');
    clearTimeout(viewEnterTimer);
    viewEnterTimer = setTimeout(() => el.removeAttribute('data-enter'), 1200);
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

  /** Trở về đúng trang chủ của chợ, kể cả khi URL đã là #/ nhưng đang lọc danh mục. */
  function resetAndGoHome() {
    state.filters = { q: '', category: '', condition: '', location: '', sort: 'new' };
    const searchInput = $('#topSearchInput');
    if (searchInput) searchInput.value = '';
    goHome();
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
        ${f.category ? `
        <nav class="breadcrumb home-breadcrumb" aria-label="Đường dẫn">
          <a href="#/" data-act="go-home">Trang chủ</a>${ico('chevron-right', 14)}
          <span aria-current="page">${esc(categoryLabel(f.category))}</span>
        </nav>` : ''}
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
              <div><b>Xác thực bằng Passkey</b><span>Vân tay, khuôn mặt hoặc mã PIN thiết bị</span></div>
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
          <div id="listingGrid" class="mt-3">${skeletonGrid(12)}</div>
          <div class="load-more mt-4" id="loadMore"></div>
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
        grid.innerHTML = filtered
          ? empty('search', 'Không có tin đăng nào khớp', 'Thử bỏ bớt bộ lọc hoặc tìm với từ khoá khác.',
            '<button class="btn" data-act="clear-filters">Xoá bộ lọc</button>')
          : catalogPreview();
        $('#loadMore').innerHTML = '';
        return;
      }
      renderListingPage();
    } catch (e) {
      if (!grid) return;
      // Origin preview của Vercel có thể không nằm trong danh sách CORS của API.
      // Vẫn cho xem giao diện mẫu nhưng báo rõ API không kết nối được.
      const previewHost = /\.vercel\.app$/.test(window.location.hostname);
      const filtered = f.q || f.category || f.condition || f.location;
      grid.innerHTML = previewHost && !filtered
        ? `<div class="note note-warning mb-3">Bản xem trước chưa kết nối được API. Các thẻ bên dưới chỉ minh họa giao diện, không thể đặt mua.</div>${catalogPreview()}`
        : empty('frown', 'Không tải được danh sách tin', e.message);
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
    view().innerHTML = `<div class="page"><div class="skeleton h-420"></div></div>`;

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
    const publicId = (seller && seller.username) || l.sellerUsername;
    return `
      <div class="seller-card">
        <span class="avatar">${esc(initials(name))}</span>
        <div class="grow">
          <b>${esc(name)}</b>
          <div class="small muted">${publicId ? accountLabel(publicId) : ''}
            ${seller ? `${publicId ? ' · ' : ''}Tham gia ${fmtDay(seller.joinedAt)}` : ''}</div>
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
        <p class="muted tiny center m-0">Cần đăng nhập để mua.</p>`;
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
      <p class="muted tiny center m-0">Chưa trừ tiền ở bước này — bạn xác nhận thanh toán vào ký quỹ ở bước sau.</p>`;
  }

  async function doOrder(listingId, btn, savedNote) {
    const note = savedNote ?? ($('#bkNote') ? $('#bkNote').value.trim() : '');
    if(!['ACTIVE','RECOVERING'].includes(state.user?.accountStatus))return beginActivation('Bạn đang đặt mua sản phẩm này. Lời nhắn và sản phẩm được giữ nguyên.',()=>doOrder(listingId,null,note));
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
            <div class="chips mb-4">${orderFilterChips()}</div>
            <div id="orderList"><div class="skeleton min-h-120"></div></div>
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
        box.innerHTML = `<div class="empty p-8">
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
            <div class="row gap-6px">${statusTag(t)}${escrowTag(t)}</div>
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
      if (t.status === 'SHIPPING' && (!t.shipment || t.shipment.status === 'ARRIVED')) {
        out.push(`<button class="btn btn-primary btn-sm" data-act="wait-confirm" data-id="${id}">${ico('package', 15)} Xác nhận đã nhận hàng</button>`);
      }
      if (t.status === 'WAIT_CONFIRM') {
        out.push(`<button class="btn btn-trust btn-sm" data-act="open-release" data-id="${id}">${ico('fingerprint', 15)} Xác nhận bằng Passkey &amp; giải ngân</button>`);
        out.push(`<button class="btn btn-danger btn-sm" data-act="open-dispute" data-id="${id}">${ico('triangle-alert', 15)} Mở tranh chấp</button>`);
      }
    } else {
      if (t.status === 'SECURED' && !t.sellerAckAt) {
        out.push(`<button class="btn btn-primary btn-sm" data-act="acknowledge" data-id="${id}">${ico('check', 15)} Xác nhận đơn hàng</button>`);
      }
      if (t.status === 'SECURED' && t.sellerAckAt && !t.shipment) {
        out.push(`<button class="btn btn-primary btn-sm" data-act="pack" data-id="${id}">${ico('package', 15)} Đã đóng gói</button>`);
      }
      if (t.status === 'WAIT_CONFIRM') {
        out.push(`<button class="btn btn-danger btn-sm" data-act="open-dispute" data-id="${id}">${ico('triangle-alert', 15)} Báo sự cố</button>`);
      }
    }
    if (t.shipment) out.push(`<button class="btn btn-sm" data-act="shipping-open" data-id="${id}">${ico('truck', 15)} Theo dõi giao hàng</button>`);
    return out.join('');
  }


  // ---------- Hành động trên đơn ----------

  // Máy chủ giữ lịch vận chuyển; trình duyệt chỉ theo dõi và minh họa kết quả.
  // Một vòng theo dõi cho mỗi phiên, không chạy chồng và bỏ mọi phản hồi của phiên cũ.
  let shippingWatch = null;
  let transactionRenderGen = 0;
  const shippingRows = new Map();
  const shippingSeen = new Set();

  function shippingKey(t) {
    return [t.id, t.version, t.status, t.sellerAckAt, t.shipment && t.shipment.status].join(':');
  }

  function rememberShipping(t) {
    if (!t || !t.id || !t.shipment) return;
    const previous = shippingRows.get(t.id);
    if (previous && (Number(previous.version) > Number(t.version)
      || Date.parse(previous.shipment.serverNow) > Date.parse(t.shipment.serverNow))) return;
    shippingRows.set(t.id, t);
  }

  function shippingNoticeKey(t) {
    return 'cat_shipping_seen:' + state.user.id + ':' + t.shipment.id + ':' + t.shipment.status;
  }

  function shippingNoticeSeen(t) {
    const key = shippingNoticeKey(t);
    try { return shippingSeen.has(key) || sessionStorage.getItem(key) === '1'; }
    catch (_) { return shippingSeen.has(key); }
  }

  function markShippingNotice(t) {
    const key = shippingNoticeKey(t);
    shippingSeen.add(key);
    try { sessionStorage.setItem(key, '1'); } catch (_) { /* bộ nhớ phiên vẫn đủ */ }
  }

  function showShipping(t) {
    const motion = window.EnclaveShippingMotion;
    if (!motion || !t.shipment || !state.user) return;
    const modal = openModal({
      title: 'Enclave Delivery',
      body: `<p class="small muted m-0-0-6">${esc(t.itemName)} · Đơn #${esc(shortId(t.id))}</p>${motion.scene(t)}`,
      footer: `<button class="btn" data-act="modal-close">Đóng</button><button class="btn btn-primary" data-act="shipping-order" data-id="${esc(t.id)}">Xem đơn hàng</button>`,
    });
    modal.querySelector('.modal-backdrop').classList.add('shipping-backdrop');
    modal.querySelector('.modal').classList.add('shipping-modal');
    state.shippingModalId = t.id;
    markShippingNotice(t);
    motion.mount(modal.querySelector('.modal-body'), t);
  }

  async function openShipping(id, btn) {
    const epoch = state.sessionEpoch;
    const hash = location.hash;
    const modalIntent = modalGeneration;
    const t = await guard('shipping-open:' + id, btn, () => api('/transactions/' + encodeURIComponent(id)));
    if (epoch !== state.sessionEpoch || hash !== location.hash || modalIntent !== modalGeneration || !t) return;
    rememberShipping(t);
    showShipping(shippingRows.get(t.id) || t);
    wakeShippingWatch();
  }

  function stopShippingWatch() {
    if (shippingWatch) {
      shippingWatch.stopped = true;
      clearTimeout(shippingWatch.timer);
    }
    shippingWatch = null;
    shippingRows.clear();
  }

  function startShippingWatch() {
    if (shippingWatch || !state.token || !state.user || state.user.role === 'ADMIN'
      || state.user.accountStatus && state.user.accountStatus !== 'ACTIVE') return;
    const watch = { epoch: state.sessionEpoch, stopped: false, busy: false, timer: null };
    shippingWatch = watch;
    watch.timer = setTimeout(() => pollShipping(watch), 100);
  }

  function wakeShippingWatch() {
    startShippingWatch();
    if (!shippingWatch || shippingWatch.busy) return;
    clearTimeout(shippingWatch.timer);
    shippingWatch.timer = setTimeout(() => pollShipping(shippingWatch), 100);
  }

  function shippingWatchAlive(watch) {
    return watch && !watch.stopped && shippingWatch === watch && watch.epoch === state.sessionEpoch && state.user;
  }

  async function pollShipping(watch) {
    if (!shippingWatchAlive(watch) || watch.busy) return;
    watch.busy = true;
    let active = false;
    try {
      if (document.visibilityState === 'hidden') return;
      const perspectives = state.user.role === 'SELLER' ? ['buyer', 'seller'] : ['buyer'];
      const lists = await Promise.all(perspectives.map((as) => api('/transactions?as=' + as)));
      if (!shippingWatchAlive(watch)) return;
      let changed = false;
      for (const list of lists) for (const t of list.transactions || []) {
        if (!t.shipment) continue;
        const before = shippingRows.get(t.id);
        rememberShipping(t);
        const current = shippingRows.get(t.id);
        if (current && (!before || shippingKey(before) !== shippingKey(current))) changed = true;
      }
      const rows = Array.from(shippingRows.values());
      active = rows.some((t) => ['PICKUP_PENDING', 'IN_TRANSIT'].includes(t.shipment.status));
      if (state.shippingModalId) {
        const t = shippingRows.get(state.shippingModalId);
        if (t && window.EnclaveShippingMotion) {
          window.EnclaveShippingMotion.update(t);
          markShippingNotice(t);
        }
      }
      const page = $('#txPage');
      const current = page && shippingRows.get(page.dataset.id);
      if (current && page.dataset.shippingKey !== shippingKey(current)) {
        await viewTransaction(current.id);
      } else if (changed && currentHead() === 'orders' && !state.busy.size) {
        const perspective = state.orderTab === 'sell' ? 'SELLER' : 'BUYER';
        await Promise.all([loadOrders('#orderList', perspective, perspective === 'SELLER' ? 'seller' : 'buyer'), loadTodo('#todoBox', { hideWhenEmpty: true })]);
      }
      if (!shippingWatchAlive(watch)) return;
      if (!$('#modalRoot').children.length && !state.busy.size && document.visibilityState !== 'hidden') {
        const candidate = rows.find((t) => ['SECURED', 'SHIPPING'].includes(t.status) && t.escrowStatus === 'LOCKED'
          && ((t.sellerId === state.user.id && t.shipment.status === 'PICKUP_PENDING')
            || (t.buyerId === state.user.id && ['IN_TRANSIT', 'ARRIVED'].includes(t.shipment.status)))
          && !shippingNoticeSeen(t));
        if (candidate) showShipping(candidate);
      }
    } catch (_) {
      // Mất mạng: giữ kết quả máy chủ đã xác nhận, không tự tuyên bố đã giao hàng.
    } finally {
      watch.busy = false;
      if (shippingWatchAlive(watch)) watch.timer = setTimeout(() => pollShipping(watch), active ? 1200 : 6000);
    }
  }

  async function secureOrder(id, btn, then) {
    if(!['ACTIVE','RECOVERING'].includes(state.user?.accountStatus))return beginActivation('Bạn đang thanh toán đơn hàng.',()=>secureOrder(id,null,then));
    const epoch=state.sessionEpoch;
    const prepared=await guard('prepare-secure:'+id,btn,()=>api(`/transactions/${id}/reauth/options`,{method:'POST',body:{action:'LOCK_ESCROW'}}));
    if(!prepared || epoch!==state.sessionEpoch)return;
    authUi.lock={id,then,prepared,createdAt:Date.now(),requestId:newRequestId(),epoch};
    openModal({title:'Xác nhận thanh toán vào ký quỹ',body:`<p>Sản phẩm: <b>${esc(prepared.context.itemName)}</b></p><div class="price-row total"><span>Thanh toán cho ${esc(prepared.context.sellerName)}</span><b>${money(prepared.context.amount)}</b></div><div class="note note-trust mt-3">Tiền sẽ được giữ trong ký quỹ cho đến khi bạn xác nhận đã nhận hàng. Xác nhận bằng Passkey để thanh toán.</div><p class="hint">Tiền chưa chuyển cho người bán. Mỗi lần thanh toán đều cần xác nhận, kể cả khi đã đăng nhập bằng Passkey.</p>`,footer:'<button class="btn" data-act="modal-close">Hủy</button><button class="btn btn-primary" data-act="secure-confirm">Xác nhận bằng Passkey</button>'});
  }
  async function confirmSecureOrder(btn){
    const pending=authUi.lock;if(!pending || pending.epoch!==state.sessionEpoch)return;
    const {id,then}=pending;
    await guard('secure:'+id,btn,async()=>{
      if(Date.now()-pending.createdAt>110000){pending.prepared=await api(`/transactions/${id}/reauth/options`,{method:'POST',body:{action:'LOCK_ESCROW'}});pending.createdAt=Date.now();}
      const {reauthSessionId,options}=pending.prepared;
      const response=await webauthn('reauth',()=>SimpleWebAuthnBrowser.startAuthentication({optionsJSON:options}));
      const {reauthGrant}=await api(`/transactions/${id}/reauth/verify`,{method:'POST',body:{reauthSessionId,response}});
      pending.createdAt=0;
      return api(`/transactions/${id}/secure`,{method:'POST',body:{requestId:pending.requestId,reauthGrant}});
    },'Đã thanh toán — tiền đang được giữ trong ký quỹ, chưa chuyển cho người bán.');
    authUi.lock=null;
    closeModal();
    await refreshWallet();
    if (then === 'tx') { location.hash = '#/tx/' + id; return; }
    route();
  }

  async function acknowledgeOrder(id, btn) {
    await guard('ack:' + id, btn, () => api(`/transactions/${id}/acknowledge`, { method: 'POST' }),
      'Đã xác nhận đơn. Đóng gói xong rồi bấm "Đã đóng gói" để xe đến lấy hàng.');
    route();
  }

  function confirmPackedOrder(id) {
    openModal({
      title: 'Kiện hàng đã sẵn sàng?',
      body: '<p>Hãy đóng gói chắc chắn và chuẩn bị kiện hàng tại điểm lấy. Sau khi xác nhận, Enclave Delivery sẽ tự mô phỏng lấy và giao hàng.</p><div class="note note-trust">' + ico('shield-check', 18) + '<span>Tiền vẫn ở ký quỹ. Giao hàng đến nơi chưa phải là xác nhận nhận hàng hay giải ngân.</span></div>',
      footer: `<button class="btn" data-act="modal-close">Chưa sẵn sàng</button><button class="btn btn-primary" data-act="pack-confirm" data-id="${esc(id)}">${ico('package', 16)} Xác nhận đã đóng gói</button>`,
    });
  }

  async function packOrder(id, btn) {
    if (state.busy.has('pack:' + id)) return;
    const epoch = state.sessionEpoch;
    const root = $('#modalRoot');
    const buttons = Array.from(root.querySelectorAll('button'));
    modalDismissible = false;
    buttons.forEach((button) => { button.disabled = true; });
    try {
      const t = await guard('pack:' + id, btn, () => api(`/transactions/${encodeURIComponent(id)}/pack`, { method: 'POST' }));
      if (!t || epoch !== state.sessionEpoch) return;
      rememberShipping(t);
      closeModal();
      await route();
      if (epoch !== state.sessionEpoch) return;
      showShipping(t);
      wakeShippingWatch();
    } finally {
      if (epoch === state.sessionEpoch && root === $('#modalRoot') && !state.shippingModalId) {
        modalDismissible = true;
        buttons.forEach((button) => { if (button.isConnected) button.disabled = false; });
      }
    }
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
        <div class="note note-warning mb-4">
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
        <div class="note note-warning mt-4">
          ${ico('triangle-alert', 18)}
          <span>Chỉ xác nhận khi bạn đã nhận và kiểm hàng. Sau bước này tiền thuộc về người bán
            và không rút lại được — nếu hàng có vấn đề, hãy mở tranh chấp thay vì xác nhận.</span>
        </div>
        <div class="note mt-3">
          ${ico('key-round', 18)}
          <span>Đây là thao tác <b>chuyển số dư mô phỏng</b>, nên hệ thống bắt buộc <b>xác thực lại bằng Passkey (vân tay, khuôn mặt hoặc mã PIN thiết bị)</b> ngay cả khi bạn đang đăng nhập. Xác thực này chỉ dùng được đúng một lần, cho đúng đơn
            này, và hết hạn sau ít phút.</span>
        </div>`,
      footer: `
        <button class="btn" data-act="modal-close">Huỷ</button>
        <button class="btn btn-trust" data-act="do-release" data-id="${esc(t.id)}">${ico('fingerprint', 17)} Xác nhận bằng Passkey &amp; giải ngân</button>`,
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
  async function getAccountGrant(action,details={}) {
    const { reauthSessionId, options } = await api('/passkeys/reauth/options', {
      method: 'POST', body: { action,...details },
    });
    const assertion = await webauthn('reauth', () =>
      SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: options }));
    const result = await api('/passkeys/reauth/verify', {
      method: 'POST', body: { reauthSessionId, response: assertion },
    });
    return action==='UPGRADE_SESSION' ? result : result.reauthGrant;
  }

  const getCredentialGrant = () => getAccountGrant('ADD_CREDENTIAL');

  // Auth v3: all credentials/tokens below stay in page memory.
  const authUi={nameCallback:null,codes:null,codesSaved:false,action:null,linkToken:null,emailChange:null,recoveryEmail:false,activation:null,lock:null,emailMeta:null,emailTick:0,emailLink:null};
  function beginActivation(label,resume){
    if(!state.user)return openAuthModal('login');
    authUi.activation={label,resume,userId:state.user.id,hash:location.hash};
    openSetupModal(state.user);
  }
  async function finishActivation(){
    const pending=authUi.activation;authUi.activation=null;authUi.codes=null;closeModal();renderChrome();
    if(pending && state.user?.id===pending.userId && location.hash===pending.hash && ['ACTIVE','RECOVERING'].includes(state.user.accountStatus))await pending.resume?.();
  }
  const authField=(id,label,type='text',value='')=>`<div class="field"><label for="${id}">${esc(label)}</label><input id="${id}" type="${type}" value="${esc(value)}" ${type==='password'?'autocomplete="new-password" maxlength="128"':''} required></div>`;
  function suggestedDeviceName(){const ua=navigator.userAgent;return `${/Android/.test(ua)?'Android':/iPhone|iPad/.test(ua)?'iPhone / iPad':/Windows/.test(ua)?'Windows':/Mac/.test(ua)?'Mac':'Thiết bị'}, ${/Edg/.test(ua)?'Edge':/Chrome/.test(ua)?'Chrome':/Safari/.test(ua)?'Safari':'trình duyệt'}`;}
  function bindRegistrationValidation(){
    const reserved=new Set(['admin','support','enclave','root','system','moderator']);
    for(const input of document.querySelectorAll('#authPanel input')){
      input.addEventListener('input',()=>input.setCustomValidity(''));
      input.addEventListener('blur',async()=>{
        if(input.id==='regUsername'){
          input.value=input.value.trim().toLowerCase();const name=input.value;
          input.setCustomValidity(/^[a-z0-9](?:[a-z0-9]|[._-](?=[a-z0-9])){1,30}[a-z0-9]$/.test(name)&&!reserved.has(name)?'':'Tên đăng nhập không hợp lệ hoặc dành riêng.');
          if(input.checkValidity())try{const result=await api('/passkeys/username-availability?username='+encodeURIComponent(name));if(input.isConnected&&input.value===name)input.setCustomValidity(result.available?'':'Tên đăng nhập đã có người dùng.');}catch{}
        }
        if(input.value)input.reportValidity();
      });
    }
  }
  async function startConditionalLogin(){
    const generation=modalGeneration,epoch=state.sessionEpoch,tabGeneration=authTabGeneration;
    try{
      if(!SimpleWebAuthnBrowser.browserSupportsWebAuthnAutofill || !await SimpleWebAuthnBrowser.browserSupportsWebAuthnAutofill())return;
      if(generation!==modalGeneration||tabGeneration!==authTabGeneration||!$('#loginUsername'))return;
      const {authenticationSessionId,options}=await api('/passkeys/login/options',{method:'POST'});
      const response=await SimpleWebAuthnBrowser.startAuthentication({optionsJSON:options,useBrowserAutofill:true});
      if(generation!==modalGeneration||tabGeneration!==authTabGeneration||epoch!==state.sessionEpoch)return;
      const result=await api('/passkeys/login/verify',{method:'POST',body:{authenticationSessionId,response}});
      if(generation===modalGeneration&&tabGeneration===authTabGeneration&&epoch===state.sessionEpoch)await afterSession(result,`Xin chào ${result.user.displayName}`);
    }catch{ /* Conditional UI is optional. Explicit login buttons remain available. */ }
  }
  // Hạn gửi lại/hết hạn mã theo đồng hồ máy chủ (bù lệch bằng serverNow), không đếm lại 60 giây mỗi lần mở.
  // Metadata chỉ nói yêu cầu đã được tiếp nhận, KHÔNG chứng minh email đã tới hộp thư.
  function applyEmailMeta(meta){
    if(!meta||!state.user)return;
    const skew=Date.parse(meta.serverNow)-Date.now(),offset=Number.isFinite(skew)?skew:0;
    const at=(iso)=>{const t=Date.parse(iso);return Number.isFinite(t)?t-offset:null;};
    let nextAt=at(meta.nextRequestAt);
    if(nextAt===null&&Number(meta.resendAfterSeconds)>=0)nextAt=Date.now()+Number(meta.resendAfterSeconds)*1000;
    authUi.emailMeta={userId:state.user.id,nextAt,expiresAt:at(meta.expiresAt),emailMask:meta.emailMask||currentEmailMeta()?.emailMask||null,failed:false};
  }
  function currentEmailMeta(){const m=authUi.emailMeta;return m&&state.user&&m.userId===state.user.id?m:null;}
  async function requestEmailCode(btn,ensure){
    const userId=state.user?.id;
    try{
      const result=await guard(ensure?'email-ensure':'email-resend',btn,()=>api('/passkeys/email/resend',{method:'POST',body:ensure?{ensure:true}:{}}));
      if(result&&state.user?.id===userId)applyEmailMeta(result.verification||result);
    }catch(e){
      // guard đã hiện lỗi trong hộp thoại; ở đây chỉ cập nhật nút: 429 thì chờ theo Retry-After, lỗi khác cho thử lại.
      if(!e?.silent&&state.user?.id===userId)authUi.emailMeta={...(currentEmailMeta()||{userId,expiresAt:null,emailMask:null}),nextAt:e.retryAfter?Date.now()+e.retryAfter*1000:null,failed:!e.retryAfter};
    }finally{emailResendCountdown();}
  }
  function openEmailVerification(user){
    const email=user.emailMask || currentEmailMeta()?.emailMask || user.email?.replace(/^(.{1,2})[^@]*@/,'$1***@') || 'email của bạn';
    openModal({title:authUi.activation?'Kích hoạt ví · xác minh email':'Nhập mã xác minh',body:`${authUi.activation?`<p>${esc(authUi.activation.label)}</p>`:''}<p>Nhập mã 6 số được gửi tới <b id="emailCodeMask">${esc(email)}</b>.</p><p class="hint" id="emailCodeStatus" role="status">Đang chuẩn bị mã xác minh…</p><div class="field"><label for="emailVerificationCode">Mã xác minh</label><input id="emailVerificationCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required></div><button class="btn btn-ghost" data-act="email-resend" id="emailResend" disabled>Gửi lại mã</button><button class="btn btn-ghost" data-act="activation-email-change">Dùng email khác</button>`,footer:'<button class="btn" data-act="activation-later">Để sau</button><button class="btn btn-primary" data-act="email-verify">Xác minh</button>'});
    // ensure: máy chủ dùng lại mã còn hiệu lực, chỉ tạo mã khi cần.
    requestEmailCode($('#emailResend'),true);
  }
  function emailResendCountdown(){
    const generation=modalGeneration,loop=++authUi.emailTick;
    const tick=()=>{
      const btn=$('#emailResend'),status=$('#emailCodeStatus');if(!btn||generation!==modalGeneration||loop!==authUi.emailTick)return;
      setTimeout(tick,1000);
      if(state.busy.has('email-ensure')||state.busy.has('email-resend')){if(status)status.textContent='Đang chuẩn bị mã xác minh…';return;} // guard đang giữ nút
      const meta=currentEmailMeta(),now=Date.now();
      if(meta?.emailMask)$('#emailCodeMask').textContent=meta.emailMask;
      const seconds=meta?.nextAt?Math.max(0,Math.ceil((meta.nextAt-now)/1000)):0;
      btn.disabled=!meta||seconds>0||state.busy.size>0;
      btn.textContent=meta?.failed?'Thử lại':seconds?`Gửi lại mã sau ${seconds} giây`:'Gửi lại mã';
      if(status)status.textContent=!meta?'Đang chuẩn bị mã xác minh…':meta.failed?'Chưa chuẩn bị được mã. Bạn có thể thử lại hoặc để sau.':meta.expiresAt&&meta.expiresAt>now?`Mã gần nhất có hiệu lực đến ${fmtDateTime(new Date(meta.expiresAt).toISOString())}. Chưa thấy email? Kiểm tra thư rác hoặc gửi lại khi được phép.`:meta.expiresAt?'Mã gần nhất đã hết hạn. Hãy gửi lại mã.':'Chưa thấy email? Kiểm tra thư rác hoặc gửi lại khi được phép.';
    };tick();
  }
  async function openEmailLinkModal(){
    const link=authUi.emailLink;if(!link)return;
    const dismiss='<button class="btn" data-act="email-link-dismiss">Bỏ qua liên kết</button>';
    if(!link.preview){
      // preview chỉ đọc, không tiêu thụ token; mở trang KHÔNG phải là xác nhận.
      openModal({title:'Xác minh email',dismissible:false,body:'<p role="status">Đang kiểm tra liên kết…</p>',footer:dismiss});
      try{const p=await api('/passkeys/email/link/preview',{method:'POST',body:{token:link.token}});if(authUi.emailLink!==link)return;link.preview={username:String(p.username||''),emailMask:String(p.emailMask||''),expiresAt:p.expiresAt||null};}
      catch(e){
        if(authUi.emailLink!==link||e.silent)return;
        if(e.status)authUi.emailLink=null; // liên kết sai/hết hạn: bỏ token; lỗi mạng thì giữ để thử lại
        openModal({title:'Không dùng được liên kết',dismissible:false,body:`<p>${esc(e.message)}</p><p>Bạn vẫn có thể xác minh bằng mã 6 số khi kích hoạt ví.</p>`,footer:e.status?'<button class="btn" data-act="email-link-dismiss">Đã hiểu</button>':dismiss+'<button class="btn btn-primary" data-act="email-link-open">Thử lại</button>'});return;
      }
    }
    const {username,emailMask,expiresAt}=link.preview,current=state.user?.username;
    const who=`<p>Tài khoản: <b>${accountLabel(username)}</b><br>Email: <b>${esc(emailMask)}</b></p>${expiresAt?`<p class="hint">Liên kết hết hạn lúc ${fmtDateTime(expiresAt)}.</p>`:''}`;
    if(!state.user||!current||!username)openModal({title:'Xác minh email',dismissible:false,body:`${who}<p>Đăng nhập đúng tài khoản này rồi bấm xác nhận. Chỉ mở liên kết thì email chưa được xác minh.</p>`,footer:dismiss+'<button class="btn btn-primary" data-act="email-link-login">Đăng nhập để tiếp tục</button>'});
    else if(current&&username&&current.toLowerCase()!==username.toLowerCase())openModal({title:'Liên kết của tài khoản khác',dismissible:false,body:`${who}<p>Bạn đang đăng nhập bằng <b>${accountLabel(current)}</b>. Email sẽ không được xác minh cho tài khoản hiện tại.</p><p>Muốn xác minh cho ${accountLabel(username)}, hãy đăng xuất rồi đăng nhập đúng tài khoản đó.</p>`,footer:dismiss+'<button class="btn btn-primary" data-act="email-link-switch">Đăng xuất để đổi tài khoản</button>'});
    else openModal({title:'Xác nhận email',dismissible:false,body:`${who}<p>Bấm xác nhận để xác minh email cho phiên đăng nhập này. Việc này không tạo ví hay Passkey.</p>`,footer:dismiss+'<button class="btn btn-primary" data-act="email-link-confirm">Xác nhận email</button>'});
  }
  async function verifyEmailUi(btn){
    const code=$('#emailVerificationCode').value.trim();if(!/^\d{6}$/.test(code))return toast('Hãy nhập đủ 6 chữ số.','err');
    await guard('verify-email',btn,async()=>{const result=await api('/passkeys/email/verify',{method:'POST',body:{code}});setSession(result.token,result.user);renderChrome();if(authUi.activation)openSetupModal(result.user);else{closeModal();await route();}});
  }
  function openLegacyEmailSetup(){
    openModal({title:'Bổ sung email xác minh',body:`<p>Tài khoản được tạo trước bản nâng cấp. Hãy xác minh email trước khi thiết lập Passkey và mở ví.</p>${authField('legacyEmail','Email','email')}`,footer:'<button class="btn" data-act="activation-later">Để sau</button><button class="btn btn-primary" data-act="legacy-email">Gửi mã xác minh</button>'});
  }
  function openDeviceNameModal(callback,{dismissible=true}={}){
    authUi.nameCallback=callback;
    openModal({title:'Đặt tên cho Passkey này',dismissible,body:`${authField('deviceNameInput','Tên Passkey','text',suggestedDeviceName())}<p class="hint">Tên giúp bạn nhận biết Passkey; không dùng để xác định danh tính thiết bị.</p>`,footer:`${dismissible?'<button class="btn" data-act="modal-close">Hủy</button>':'<button class="btn" data-act="restart-setup">Tạo lại Passkey</button>'}<button class="btn btn-primary" data-act="device-name-save">Lưu và tiếp tục</button>`});
    $('#deviceNameInput').maxLength=60;
  }
  function showRecoveryCodes(codes){
    authUi.codes=codes;authUi.codesSaved=false;
    // Không đóng bằng nền/Escape/nút X: mã chỉ hiện một lần, chỉ "Hoàn tất" hoặc "Để sau" (có cảnh báo) mới rời hộp thoại.
    openModal({title:'Lưu mã khôi phục',dismissible:false,body:`<p>Nếu mất thiết bị, các mã này giúp bạn khôi phục tài khoản. Mỗi mã chỉ dùng một lần. Chúng tôi sẽ không hiển thị lại.</p><div class="recovery-code-grid">${codes.map(code=>`<code>${esc(code)}</code>`).join('')}</div><div class="row mt-3"><button class="btn" data-act="recovery-codes-download">Tải xuống</button><button class="btn" data-act="recovery-codes-copy">Sao chép</button></div><label class="row mt-3"><input id="recoveryCodesAcknowledged" type="checkbox"> Tôi đã lưu các mã này ở nơi an toàn</label>`,footer:'<button class="btn" data-act="recovery-codes-later">Để sau</button><button class="btn btn-primary" id="recoveryCodesDone" data-act="recovery-codes-done" disabled>Hoàn tất</button>'});
    $('#recoveryCodesAcknowledged').addEventListener('change',()=>{$('#recoveryCodesDone').disabled=!authUi.codesSaved||!$('#recoveryCodesAcknowledged').checked;});
  }
  function codesSaved(){authUi.codesSaved=true;$('#recoveryCodesDone').disabled=!$('#recoveryCodesAcknowledged').checked;}
  async function upgradeAuthUi(btn,then){
    await guard('session-upgrade',btn,async()=>{
      const result=await getAccountGrant('UPGRADE_SESSION');setSession(result.token,result.user);closeModal();renderChrome();if(then)await then();else await route();
    });
  }
  function openRecoveryChoice(){
    openEmailRecoveryRequest('recovery');
  }
  function openRecoveryCode(){
    if(!state.user || !['ACTIVE','RECOVERING'].includes(state.user.accountStatus)){state.recoverAfterLogin=true;openAuthModal('login');return toast('Hãy đăng nhập bằng mật khẩu trước, rồi nhập mã khôi phục.','info');}
    openModal({title:'Khôi phục bằng mã dự phòng',body:`${authField('recoveryCurrentPassword','Mật khẩu hiện tại','password')}${authField('recoveryCode','Mã khôi phục (XXXXX-XXXXX)')}<p class="hint">Mã được dùng một lần. Sau khi tạo Passkey mới, Passkey và các phiên cũ sẽ bị thu hồi.</p>`,footer:'<button class="btn" data-act="modal-close">Hủy</button><button class="btn btn-primary" data-act="recovery-code-verify">Xác minh và tiếp tục</button>'});
  }
  function openEmailRecoveryRequest(kind='recovery'){
    authUi.action=kind;authUi.recoveryOtp=null;
    openModal({title:kind==='password'?'Quên mật khẩu':'Khôi phục Passkey qua email',body:`${authField('recoveryEmail','Email đã xác minh','email')}<p>${kind==='password'?'Bạn sẽ nhận liên kết đặt lại mật khẩu có hiệu lực 30 phút.':'Nhận mã 6 số qua email, sau đó tạo Passkey mới theo hướng dẫn. Sau khi xác nhận mã, yêu cầu chờ 24 giờ để bảo vệ tài khoản; giải ngân bị hạn chế 72 giờ sau khôi phục.'}</p>${kind==='password'?'':'<p class="hint">Nếu Passkey vẫn dùng được trên thiết bị khác, bạn có thể đăng nhập bằng nó. <button class="btn btn-ghost btn-sm" data-act="recovery-code-open">Tôi có mã dự phòng đã lưu</button></p>'}`,footer:`<button class="btn" data-act="modal-close">Hủy</button><button class="btn btn-primary" data-act="recovery-email-request">${kind==='password'?'Gửi hướng dẫn':'Gửi mã xác nhận'}</button>`});
  }
  function openRecoveryEmailCode(result,email){
    const skew=Date.parse(result.serverNow)-Date.now(),offset=Number.isFinite(skew)?skew:0;
    const next=Date.parse(result.nextRequestAt)-offset;
    authUi.recoveryOtp={requestToken:result.requestToken,email,nextAt:Number.isFinite(next)?next:Date.now()+60000};
    openModal({title:'Nhập mã khôi phục qua email',body:`<p>${esc(result.message)}</p><p>Email: <b>${esc(result.emailMask||email)}</b></p><div class="field"><label for="recoveryEmailCode">Mã xác nhận 6 số</label><input id="recoveryEmailCode" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required></div><p class="hint">Mã có hiệu lực 10 phút. Xác nhận mã sẽ bắt đầu thời gian chờ 24 giờ; tài khoản chưa bị thay đổi khi chỉ gửi mã.</p><button class="btn btn-ghost" data-act="recovery-email-resend" id="recoveryEmailResend" disabled>Gửi lại mã</button>`,footer:'<button class="btn" data-act="recovery-email-open">Đổi email</button><button class="btn btn-primary" data-act="recovery-email-code-verify">Xác nhận khôi phục</button>'});
    const generation=modalGeneration,context=authUi.recoveryOtp;
    const tick=()=>{const btn=$('#recoveryEmailResend');if(!btn||generation!==modalGeneration||authUi.recoveryOtp!==context)return;const seconds=Math.max(0,Math.ceil((context.nextAt-Date.now())/1000));btn.textContent=seconds?`Gửi lại mã sau ${seconds} giây`:'Gửi lại mã';btn.disabled=seconds>0||state.busy.size>0;setTimeout(tick,1000);};tick();
  }
  function openRecoveryPasskey(emailRecovery){
    authUi.recoveryEmail=emailRecovery;
    openModal({title:'Tạo Passkey khôi phục',dismissible:false,body:`<p>Tạo Passkey mới bằng vân tay, khuôn mặt hoặc mã PIN thiết bị. Các Passkey cũ sẽ bị thu hồi khi hoàn tất.</p>${authField('recoveryDeviceName','Tên Passkey','text',suggestedDeviceName())}${emailRecovery?authField('recoveryNewPassword','Mật khẩu mới bắt buộc','password'):''}`,footer:'<button class="btn" data-act="do-logout">Đăng xuất</button><button class="btn btn-primary" data-act="recovery-passkey-create">Tạo Passkey mới</button>'});
  }
  async function handleAccountAction(){
    const hash=location.hash || '';if(!hash.startsWith('#/account-action?'))return;
    const params=new URLSearchParams(hash.slice(hash.indexOf('?')+1));
    authUi.action=params.get('purpose');authUi.linkToken=params.get('token');
    history.replaceState(null,'',location.pathname+location.search+'#/account-action');
    const kind=authUi.action;
    if(kind==='verify-email'){
      // Token chỉ nằm trong bộ nhớ (không lưu storage/log), sống qua đăng nhập/đổi tài khoản tới khi xác nhận hoặc bỏ qua.
      const token=authUi.linkToken;authUi.linkToken=null;authUi.action=null;
      if(token){authUi.emailLink={token,preview:null};await openEmailLinkModal();}
      return;
    }
    if(kind==='password-reset'){
      openModal({title:'Đặt lại mật khẩu',body:authField('resetNewPassword','Mật khẩu mới','password'),footer:'<button class="btn" data-act="modal-close">Hủy</button><button class="btn btn-primary" data-act="reset-password-complete">Đặt lại mật khẩu</button>'});return;
    }
    const titles={'recovery-start':'Xác nhận bắt đầu khôi phục','recovery-cancel':'Hủy yêu cầu khôi phục','recovery-finish':'Tiếp tục khôi phục tài khoản'};
    if(!titles[kind]||!authUi.linkToken)return;
    openModal({title:titles[kind],body:`<p>${kind==='recovery-start'?'Sau khi xác nhận, thời gian chờ 24 giờ bắt đầu. Trong thời gian này tài khoản không thể giải ngân.':kind==='recovery-cancel'?'Xác nhận hủy yêu cầu khôi phục. Các Passkey hiện có vẫn được giữ.':'Bạn sẽ tạo Passkey mới và đặt mật khẩu mới. Sau khi hoàn tất, các phiên và Passkey cũ bị thu hồi.'}</p>`,footer:'<button class="btn" data-act="modal-close">Để sau</button><button class="btn btn-primary" data-act="recovery-link-confirm">Xác nhận</button>'});
  }
  async function loadSecurityDetails(){
    const box=$('#securityDetails');if(!box)return;
    try{
      const data=await api('/passkeys/security');if(!box.isConnected)return;
      const labels={LOGIN_PASSWORD:'Đăng nhập bằng mật khẩu',LOGIN_PASSKEY:'Đăng nhập bằng Passkey',FIRST_PASSKEY_ADDED:'Tạo Passkey đầu tiên',PASSKEY_ADDED:'Thêm Passkey',PASSKEY_REMOVED:'Xóa Passkey',EMAIL_VERIFIED:'Xác minh email',EMAIL_CHANGED:'Đổi email',PASSWORD_CHANGED:'Đổi mật khẩu',PASSWORD_RESET:'Đặt lại mật khẩu',RECOVERY_CODES_REGENERATED:'Tạo lại mã khôi phục',RECOVERY_CODE_USED:'Dùng mã khôi phục',RECOVERY_STARTED:'Bắt đầu khôi phục',RECOVERY_CANCELLED:'Hủy khôi phục',ACCOUNT_RECOVERED:'Hoàn tất khôi phục',RECOVERY_EXPIRED:'Khôi phục hết hạn',PASSKEY_COUNTER_WARNING:'Cảnh báo bộ đếm Passkey'};
      box.innerHTML=`<div class="card p-5"><h3>Email</h3><p>${data.email?esc(data.email):'Chưa có email'} · ${data.emailVerified?'Đã xác minh':'Chưa xác minh'}</p><button class="btn" data-act="change-email-open">${data.email?'Đổi email':'Thêm email đã xác minh'}</button></div><div class="card p-5"><h3>Khôi phục tài khoản</h3><p>Khi không dùng được Passkey, nhận mã xác nhận qua email đã xác minh và làm theo hướng dẫn.</p><button class="btn" data-act="lost-passkey">Không dùng được Passkey?</button><details class="mt-3"><summary>Tùy chọn nâng cao: mã dự phòng</summary><p class="hint mt-3">Không bắt buộc. Còn ${Number(data.recoveryCodesRemaining)} mã chưa dùng. Chỉ tạo nếu bạn muốn tự lưu thêm phương án dự phòng.</p><button class="btn" data-act="recovery-regenerate">Tạo bộ mã dự phòng</button></details></div><div class="card p-5"><div class="row-between"><h3>Phiên đăng nhập</h3><button class="btn" data-act="sessions-revoke-others">Đăng xuất các phiên khác</button></div>${data.sessions.map(s=>`<div class="border-row"><b>${esc(s.device_name||'Trình duyệt')}</b><p class="hint">${s.auth_method==='passkey'?'Phiên Passkey':s.auth_method==='password'?'Phiên mật khẩu':'Phiên khôi phục'} · Dùng gần nhất ${fmtDateTime(s.last_seen_at)} ${s.current?'· Phiên hiện tại':''}</p>${s.current?'':`<button class="btn btn-sm" data-act="session-revoke" data-id="${esc(s.id)}">Đăng xuất phiên này</button>`}</div>`).join('')}</div><div class="card p-5"><h3>Nhật ký bảo mật gần đây</h3>${data.events.length?data.events.map(e=>`<div class="border-row">${esc(labels[e.action]||'Sự kiện bảo mật')}<span class="hint"> · ${fmtDateTime(e.created_at)}</span></div>`).join(''):'Chưa có sự kiện.'}</div>`;
    }catch(e){box.textContent=e.message;}
  }
  function renderSecurityBanner(){
    let box=$('#securitySessionBanner');if(!box){box=document.createElement('div');box.id='securitySessionBanner';box.className='wrap';view().before(box);}
    if(!state.user){box.innerHTML='';return;}
    if(['BASIC','VERIFIED'].includes(state.user.accountStatus)){
      box.innerHTML=state.user.emailVerified?'<div class="note mt-3">Email đã xác minh. Ví sẽ được kích hoạt khi bạn bắt đầu nạp tiền hoặc mua hàng.</div>':'<div class="note mt-3">Xác minh email để mở khóa thanh toán. <button class="btn btn-sm" data-act="email-verify-open">Nhập mã xác minh</button></div>';return;
    }
    if(!['ACTIVE','RECOVERING'].includes(state.user.accountStatus)){box.innerHTML='';return;}
    const user=state.user;
    box.innerHTML=(user.authMethod==='password'?`<div class="note mt-3">Bạn đang dùng phiên mật khẩu. Mỗi lần thanh toán hoặc giải ngân đều cần xác nhận Passkey. <button class="btn btn-sm" data-act="upgrade-session">Nâng cấp bằng Passkey</button></div>`:'')+(user.accountStatus==='RECOVERING'?'<div class="note note-danger mt-3">Đang có yêu cầu khôi phục tài khoản. Giải ngân tạm khóa. Nếu không phải bạn, hãy đăng nhập bằng Passkey cũ để hủy.</div>':'')+(user.recoveryRestrictedUntil&&Date.parse(user.recoveryRestrictedUntil)>Date.now()?`<div class="note note-warning mt-3">Tài khoản vừa được khôi phục qua email. Giải ngân và phân xử tạm khóa đến ${fmtDateTime(user.recoveryRestrictedUntil)}.</div>`:'');
  }

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
    if(['BASIC','VERIFIED'].includes(state.user.accountStatus)){view().innerHTML=empty('key-round','Bảo mật và kích hoạt ví','Tạo Passkey khi bạn sẵn sàng sử dụng ví. Bạn có thể tiếp tục xem hàng.','<button class="btn btn-primary" data-act="activate-wallet">Kích hoạt ví bằng Passkey</button>');return;}

    view().innerHTML = `
      <div class="page">
        ${banner('Bảo mật tài khoản', 'Passkey, thiết bị và mật khẩu của bạn')}

        <div class="card p-5 mb-5">
          <div class="row-between mb-4">
            <h3 class="m-0">Passkey đã đăng ký</h3>
            <button class="btn btn-primary btn-sm" data-act="add-device">${ico('plus', 15)} Thêm thiết bị</button>
          </div>
          <div id="credentialList">${skeletonGrid(2)}</div>
        </div>

        <div class="card p-5">
          <div class="row-between">
            <div>
              <h3 class="m-0-0-4">Mật khẩu</h3>
              <p class="muted tiny m-0">
                Dùng để mở phiên làm việc. Đổi mật khẩu sẽ đăng xuất mọi phiên khác.
              </p>
            </div>
            <button class="btn btn-sm" data-act="open-change-password">${ico('key-round', 15)} Đổi mật khẩu</button>
          </div>
        </div>
      </div>`;

    const page=$('#credentialList')?.closest('.page');
    if(page)page.insertAdjacentHTML('beforeend','<div id="securityDetails" class="stack mt-4"></div>');
    await Promise.all([loadCredentials(),loadSecurityDetails()]);
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
            <div class="row-between border-row">
              <div>
                <b>${esc(c.deviceName)}</b>
                <div class="muted tiny">
                  ${c.backedUp==null?'Chưa có thông tin sao lưu':c.backedUp?'Đã được sao lưu':'Chưa ghi nhận bản sao lưu'} · ${c.backupEligible==null?'Chưa có thông tin khả năng sao lưu':c.backupEligible?'Hỗ trợ sao lưu':'Không hỗ trợ sao lưu'}<br>
                  Đăng ký ${esc((c.createdAt || '').slice(0, 10))}
                  ${c.lastUsedAt ? ` · dùng gần nhất ${esc(c.lastUsedAt.slice(0, 10))}` : ' · chưa dùng lần nào'}
                </div>
              </div>
              <button class="btn btn-ghost btn-sm" data-act="rename-device" data-id="${esc(c.id)}" data-name="${esc(c.deviceName)}">Đổi tên</button>
              <button class="btn btn-ghost btn-sm" data-act="del-device" data-id="${esc(c.id)}" data-name="${esc(c.deviceName)}"
                ${onlyOne ? 'disabled title="Không thể xoá Passkey cuối cùng"' : ''}>
                ${ico('x', 15)} Xoá
              </button>
            </div>`).join('')}
          ${onlyOne ? `
            <p class="muted tiny m-s3-0-0">
              Chỉ còn một Passkey nên không xoá được. Nên thêm một thiết bị dự phòng.
            </p>` : ''}
          ${onlyOne&&credentials[0]?.backedUp===false?'<div class="note note-warning">Passkey này chưa được ghi nhận sao lưu. Hãy thêm một Passkey khác để tránh bị khóa khi mất thiết bị.</div>':''}
        </div>`;
    } catch (e) {
      box.innerHTML = `<p class="muted">Không tải được danh sách: ${esc(e.message)}</p>`;
    }
  }

  async function addDevice(btn) {
    openDeviceNameModal(async(deviceName)=>{
      // Phiếu xin TRƯỚC, vì máy chủ kiểm phiếu ngay ở bước xin tuỳ chọn đăng ký — người
      // dùng biết sớm là mình chưa đủ điều kiện, thay vì làm xong mới bị từ chối.
      const reauthGrant = await getCredentialGrant();
      const { registrationSessionId, options } = await api('/passkeys/credentials/options', {
        method: 'POST', body: { deviceName: deviceName.trim() || 'Thiết bị mới', reauthGrant },
      });
      const attResp = await webauthn('add-device', () =>
        SimpleWebAuthnBrowser.startRegistration({ optionsJSON: options }));
      await api('/passkeys/credentials/verify', {
        method: 'POST', body: { registrationSessionId, response: attResp, reauthGrant },
      });
      closeModal();await Promise.all([loadCredentials(),loadSecurityDetails()]);toast('Đã thêm Passkey mới.','ok');
    });
  }

  async function deleteDevice(id, btn) {
    await guard('deldev:' + id, btn, async () => {
      const reauthGrant = await getAccountGrant('REMOVE_CREDENTIAL',{credentialId:id});
      return api(`/passkeys/credentials/${id}`, { method: 'DELETE', body: { reauthGrant } });
    }, 'Đã xoá thiết bị.');

    closeModal();await Promise.all([loadCredentials(),loadSecurityDetails()]);
  }

  // ---------- Đổi mật khẩu ----------
  //
  // Cần cả mật khẩu hiện tại và phiếu Passkey CHANGE_PASSWORD. Sau khi đổi, phiên khác bị thu hồi.

  function openChangePasswordModal() {
    openModal({
      title: 'Đổi mật khẩu',
      body: `
        <div class="stack">
          <div class="field"><label for="currentPassword">Mật khẩu hiện tại</label><input id="currentPassword" type="password" autocomplete="current-password" required></div>
          <div class="field">
            <label for="newPassword">Mật khẩu mới</label>
            <input id="newPassword" type="password" autocomplete="new-password">
            <span class="hint">Ít nhất 8 ký tự</span>
          </div>
          <p class="muted tiny m-0">
            Bạn sẽ được yêu cầu xác thực bằng Passkey. Các phiên đăng nhập khác sẽ bị đăng xuất.
          </p>
        </div>`,
      footer: `
        <button class="btn" data-act="modal-close">Huỷ</button>
        <button class="btn btn-primary" data-act="do-change-password">Đổi mật khẩu</button>`,
    });
  }

  async function doChangePassword(btn) {
    const currentPassword=$('#currentPassword').value;
    const newPassword = $('#newPassword').value;
    if (!newPassword) return toast('Nhập mật khẩu mới', 'err');

    await guard('chpw', btn, async () => {
      const reauthGrant = await getAccountGrant('CHANGE_PASSWORD');
      const result = await api('/users/me/password', { method: 'POST', body: { currentPassword,newPassword, reauthGrant } });
      // Mã phiên cũ vừa bị thu hồi cùng lúc với việc đổi mật khẩu; dùng mã mới máy chủ trả về.
      setSession(result.token, state.user);
      closeModal();
      // Đổi mật khẩu là thao tác nhạy cảm — dùng popup lớn giữa màn hình thay vì toast góc
      // màn hình, để người dùng chắc chắn nhận ra thao tác đã hoàn tất.
      openModal({
        title: 'Đổi mật khẩu thành công',
        body: `
          <div class="center">
            <div class="mb-3">
              <span class="text-success">${ico('circle-check', 48)}</span>
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
        <div class="card"><div class="table-scroll" id="shopPanel"><div class="skeleton min-h-160"></div></div></div>
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
          <div class="row flex-nowrap gap-3">
            <div class="thumb-52">${productImage(l, { size: 22 })}</div>
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
          <div class="row justify-end flex-nowrap">
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
        ? `<div class="note note-warning mt-4">${ico('circle-alert', 18)}
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
    if (!r) return; // lần bấm lặp khi yêu cầu đầu còn chạy: không báo thành công thay cho nó
    closeModal();
    toast(r && r.hidden ? 'Đã ẩn tin vì tin đã có lịch sử giao dịch.' : 'Đã gỡ tin.', 'ok');
    route();
  }


  // =====================================================================
  // Trang: Ví & nạp tiền
  // =====================================================================

  const ENTRY_LABEL = {
    DEMO_TOPUP: 'Số dư khởi tạo (demo)',
    TOPUP_CREDIT: 'Nạp tiền qua cổng mô phỏng',
    ESCROW_LOCK_DEBIT: 'Thanh toán đơn — chuyển vào ký quỹ',
    ESCROW_LOCK_CREDIT: 'Ký quỹ nhận tiền',
    ESCROW_RELEASE_DEBIT: 'Ký quỹ giải ngân',
    ESCROW_RELEASE_CREDIT: 'Nhận tiền bán hàng',
    ESCROW_REFUND_DEBIT: 'Ký quỹ hoàn tiền',
    ESCROW_REFUND_CREDIT: 'Nhận hoàn tiền',
  };

  async function viewWallet() {
    if (!state.user) return requireLogin('Đăng nhập để xem ví của bạn.');
    if (state.user.role === 'ADMIN') {
      return wrongRole('Quản trị viên không phải một bên của giao dịch nên không có ví.');
    }
    if(['BASIC','VERIFIED'].includes(state.user.accountStatus)){
      view().innerHTML=empty('wallet','Kích hoạt ví khi bạn cần','Xác minh email và tạo Passkey để mở ví. Tặng 5.000.000 VND demo khi kích hoạt.','<button class="btn btn-primary" data-act="activate-wallet">Kích hoạt ví &amp; nạp tiền</button><a class="btn" href="#/">Tiếp tục xem hàng</a>');return;
    }

    // Cổng nạp tiền nào đang bật là do MÁY CHỦ nói (GET /api/payments/paypal/config); không đoán từ hostname.
    const cfg = await loadPayConfig();
    if (currentHead() !== 'wallet' || !state.user) return; // người dùng đã đi nơi khác / đăng xuất trong lúc chờ

    view().innerHTML = `
      <div class="page">
        ${banner('Ví & nạp tiền', 'Mọi biến động số dư được ghi thành bút toán và có khoá chống ghi trùng')}
        <div class="stat-grid" id="walletStats"></div>
        ${walletTopupCard(cfg)}
        <div class="card">
          <div class="card-head"><h2>Lịch sử nạp tiền</h2></div>
          <div class="table-scroll" id="topupHistory"></div>
        </div>
        <div class="card">
          <div class="card-head"><h2>Biến động số dư</h2></div>
          <div class="table-scroll" id="walletLedger"></div>
        </div>
      </div>`;

    renderTopupIntent();

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
    // Vừa được PayPal đưa quay lại (?paypal=return|cancel): xác minh rồi tự hoàn tất khi return hợp lệ.
    if (state.paypalCallback) Promise.resolve(processPaypalCallback()).catch(() => {});
    else Promise.resolve(resumePaypalAfterBack()).catch(() => {});
  }

  // ---------- Nạp tiền qua Mock Payment Provider ----------
  //
  // Giao diện KHÔNG bao giờ tự cộng số dư. Sau khi người dùng "thanh toán" ở cổng thanh toán mô
  // phỏng, trang chỉ hỏi lại máy chủ trạng thái của yêu cầu; số dư chỉ được vẽ lại khi máy chủ đã
  // tất toán SUCCEEDED (qua webhook, hoặc qua đối soát nếu webhook thất lạc).

  const TOPUP_PRESETS = [100000, 200000, 500000, 1000000, 2000000];

  function topupCard() {
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
          <div id="topupIntent" aria-live="polite"></div>
          <div class="note">
            ${ico('info', 18)}
            <span>Đây là <b>thanh toán mô phỏng</b>: không dùng thẻ, ví điện tử hay tài khoản ngân hàng thật và không chuyển
              tiền thật. Hệ thống chưa nối PayPal hay cổng thanh toán thật nào.</span>
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

  /**
   * Nút ở dòng lịch sử. Chỉ SUBMITTED (cổng đã nhận yêu cầu) mới mở được cổng thanh toán. Dòng không có
   * trường submissionStatus (dữ liệu cũ) được coi là đã gửi, đúng như máy chủ quy ước.
   */
  function historyAction(p) {
    if (p.provider === PAYPAL_PROVIDER) return paypalHistoryAction(p);
    if (p.status !== 'PENDING') return '';
    const sub = p.submissionStatus || 'SUBMITTED';
    if (sub === 'SUBMITTING') return '<span class="muted small">Đang gửi sang cổng thanh toán…</span>';
    if (sub === 'SUBMIT_FAILED') {
      const intent = loadIntent();
      return intent && p.requestId && intent.requestId === p.requestId
        ? '<button class="btn btn-sm" data-act="topup-retry">Thử lại cùng yêu cầu</button>'
        : '<span class="muted small">Chưa gửi được sang cổng — hệ thống sẽ tự gửi lại</span>';
    }
    return `<button class="btn btn-sm" data-act="checkout-open" data-id="${esc(p.id)}" data-ref="${esc(p.providerRef)}">Mở lại cổng thanh toán</button>`;
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
          const pp = p.provider === PAYPAL_PROVIDER && PAYPAL_STAGES.includes(p.stage);
          const ui = pp ? PAYPAL_STAGE_UI[p.stage] : (PAYMENT_UI[p.status] || { label: p.status, tone: '' });
          const tag = p.provider === PAYPAL_PROVIDER ? '<div><span class="tag tag-info">PayPal Sandbox</span></div>'
            : p.provider === 'MOCK' ? '<div><span class="tag">Mô phỏng</span></div>' : '';
          const usd = pp && validQuote(p.quote, p.amount) ? `<div class="muted small">${esc(p.quote.usdValue)} USD · Sandbox</div>` : '';
          const result = p.resolvedAt
            ? `${fmtDateTime(p.resolvedAt)} · ${esc(RESOLVED_BY_LABEL[p.resolvedBy] || '')}`
            : (pp ? esc(ui.hint || '') : 'Chờ cổng thanh toán trả kết quả');
          return `
            <tr>
              <td class="nowrap">${fmtDateTime(p.createdAt)}${tag}</td>
              <td class="num">${money(p.amount)}${usd}</td>
              <td><span class="tag ${ui.tone}">${esc(ui.label)}</span></td>
              <td class="muted small">${result}</td>
              <td>${historyAction(p)}</td>
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
    const epoch = state.sessionEpoch;
    let res, data;
    try { ({ res, data } = await fetchJson(API_BASE + '/mock-provider' + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
     }));
    } catch (e) { throw state.sessionEpoch !== epoch ? staleError() : e; }
    if (state.sessionEpoch !== epoch) throw staleError();
    if (res.status === 401 && !retried) {
      const refreshed = await refreshSession();
      if (state.sessionEpoch !== epoch) throw staleError();
      if (refreshed) return providerApi(path, { method, body }, true);
    }
    if (!res.ok) {
      const err = new Error(apiErrorMessage(res.status, data));
      err.code = data.error;
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // ---------- Ý định nạp tiền và requestId ----------
  //
  // Một lần bấm "nạp" = MỘT ý định = MỘT requestId, sinh một lần rồi giữ nguyên cho mọi lần gửi lại. Nhờ vậy
  // bấm đúp, thử lại sau timeout/mất kết nối/503 hay tải lại trang đều dẫn tới cùng một yêu cầu ở máy chủ,
  // không bao giờ tạo thêm một khoản nạp thứ hai. Máy chủ bảo đảm điều đó (POST /api/payments/topup).
  //
  // Ý định chỉ sống trong lúc kết quả CHƯA RÕ (chưa nhận được một yêu cầu đã SUBMITTED hay đã kết thúc). Lưu theo
  // id người dùng; chỉ chứa mã yêu cầu và số tiền, KHÔNG chứa token hay bí mật. Khi chưa rõ, số tiền bị khoá: đổi
  // số tiền mà giữ cùng khoá sẽ bị máy chủ từ chối (409) và là một ý định khác về bản chất — người dùng phải chủ
  // động bắt đầu lần nạp mới.
  //
  // Chính sách tài khoản: khoá localStorage theo id người dùng CHỈ để giao diện không dùng chéo ý định giữa các
  // tài khoản — nó không phải cơ chế bảo mật (mã JS nào cùng origin cũng đọc được localStorage). Vì thế ý định của
  // một tài khoản KHÔNG bị tự xoá khi tài khoản khác đăng nhập: chủ của nó quay lại vẫn phục hồi được, và tài khoản
  // khác không bao giờ đọc hay dùng nó (loadIntent kiểm userId). Nội dung chỉ là mã yêu cầu ngẫu nhiên và số tiền.
  //
  // Phản hồi đến muộn: mọi thao tác nạp tiền mang một "ngữ cảnh" (phiên, người dùng, ý định) lấy lúc bắt đầu và kiểm
  // lại sau MỖI await. Phản hồi của phiên đã đăng xuất / đổi tài khoản / bị thay bằng ý định khác không được mở cổng,
  // báo thông báo, đọc ví hay sửa ý định của phiên đang dùng.

  const INTENT_PREFIX = 'cat_topup_intent:';
  const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{8,100}$/;
  const PAYMENT_STATUSES = ['PENDING', 'SUCCEEDED', 'FAILED'];
  const SUBMISSION_STATUSES = ['SUBMITTING', 'SUBMITTED', 'SUBMIT_FAILED'];
  // Theo dõi có hạn, giãn dần: tổng ~8 giây rồi dừng và đưa nút "Kiểm tra lại" cho người dùng.
  const POLL_DELAYS_MS = [1000, 1500, 2250, 3400];

  function validIntent(v, userId) {
    return !!v && typeof v === 'object' && v.userId === userId && REQUEST_ID_RE.test(String(v.requestId))
      && Number.isSafeInteger(v.amount) && v.amount > 0;
  }

  function loadIntent() {
    const user = state.user;
    if (!user || !user.id) return null;
    if (validIntent(state.topupIntent, user.id)) return state.topupIntent;
    try {
      const v = JSON.parse(localStorage.getItem(INTENT_PREFIX + user.id) || 'null');
      if (validIntent(v, user.id)) { state.topupIntent = v; return v; }
    } catch (_) { /* không đọc được: coi như không có ý định nào */ }
    return null;
  }

  function saveIntent(intent) {
    state.topupIntent = intent;
    try { localStorage.setItem(INTENT_PREFIX + intent.userId, JSON.stringify(intent)); } catch (_) { /* vẫn giữ trong bộ nhớ */ }
  }

  function clearIntent() {
    const user = state.user;
    state.topupIntent = null;
    if (!user || !user.id) return;
    try { localStorage.removeItem(INTENT_PREFIX + user.id); } catch (_) { /* không có gì để xoá */ }
  }

  /**
   * Ngữ cảnh của một thao tác nạp tiền: dấu phiên + người dùng + ý định lúc bắt đầu. `requestId` null với thao tác
   * không gắn ý định (ví dụ theo dõi sau khi thanh toán ở cổng, hoặc mở lại cổng từ lịch sử).
   */
  function topupCtx(requestId) {
    return { epoch: state.sessionEpoch, userId: state.user ? state.user.id : null, requestId: requestId || null, released: false };
  }

  /** Thao tác này còn thuộc phiên và ý định đang dùng không? So cả epoch (đăng xuất rồi đăng nhập lại cùng tài khoản), không chỉ userId. */
  function ctxAlive(ctx) {
    if (!ctx || state.sessionEpoch !== ctx.epoch || !state.token || !state.user || state.user.id !== ctx.userId) return false;
    if (ctx.requestId && !ctx.released) {
      const cur = loadIntent();
      if (!cur || cur.requestId !== ctx.requestId) return false;
    }
    return true;
  }

  /** Chính thao tác này kết thúc ý định của mình: xoá bản lưu và đánh dấu để các bước sau chỉ còn kiểm phiên. */
  function releaseIntent(ctx) {
    clearIntent();
    ctx.released = true;
  }

  const staleError = () => Object.assign(new Error('Phản hồi của phiên cũ'), { silent: true, stale: true });

  function stopTopupPoll() {
    state.topupPollGen++;
    if (state.topupPoll) { clearTimeout(state.topupPoll); state.topupPoll = null; }
    // Đánh thức lượt chờ đang treo để vòng theo dõi cũ thoát ngay (thấy số thế hệ đã đổi) thay vì treo mãi.
    const wake = state.topupPollWake;
    state.topupPollWake = null;
    if (wake) wake();
  }

  function resetTopupFlow() {
    stopTopupPoll();
    state.topupIntent = null;
    state.topupNotice = null;
    state.paypalAbandonConfirmation = null;
  }

  function startIntent(amount, provider) {
    const intent = { userId: state.user.id, requestId: 'topup-' + newRequestId(), amount, provider: provider || 'MOCK', createdAt: new Date().toISOString() };
    saveIntent(intent);
    return intent;
  }

  /** Một dòng yêu cầu nạp từ máy chủ có đủ và đúng dữ liệu để dựa vào không? Thiếu/sai thì KHÔNG coi là thành công. */
  function validPaymentRow(r, expect) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) return false;
    if (typeof r.id !== 'string' || !r.id) return false;
    if (!PAYMENT_STATUSES.includes(r.status) || !SUBMISSION_STATUSES.includes(r.submissionStatus)) return false;
    if (!Number.isSafeInteger(r.amount) || r.amount <= 0) return false;
    if (typeof r.providerRef !== 'string' || !r.providerRef) return false;
    if (expect && expect.amount !== undefined && r.amount !== expect.amount) return false;
    if (expect && expect.requestId !== undefined && r.requestId !== expect.requestId) return false;
    return true;
  }

  /**
   * Mức kiểm nhẹ hơn cho dòng đọc lại bằng GET (theo dõi, kiểm tra trạng thái): cần id, trạng thái và số tiền hợp lệ;
   * thiếu submissionStatus thì coi là SUBMITTED, đúng quy ước của máy chủ. Khi biết trước id / số tiền / requestId của
   * yêu cầu đang theo dõi thì dòng đọc về phải KHỚP — sai id, sai số tiền hay requestId khác (kể cả null) đều bị từ chối.
   * Trả về dòng đã chuẩn hoá hoặc null. Phản hồi TẠO yêu cầu (POST) bị kiểm đủ mọi trường bằng validPaymentRow.
   */
  function readPaymentState(r, expect) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
    if (typeof r.id !== 'string' || !r.id || !PAYMENT_STATUSES.includes(r.status)) return null;
    if (!Number.isSafeInteger(r.amount) || r.amount <= 0) return null;
    if (r.submissionStatus !== undefined && !SUBMISSION_STATUSES.includes(r.submissionStatus)) return null;
    if (expect && expect.id !== undefined && r.id !== expect.id) return null;
    if (expect && expect.amount !== undefined && r.amount !== expect.amount) return null;
    if (expect && expect.requestId !== undefined && r.requestId !== expect.requestId) return null;
    return { ...r, submissionStatus: r.submissionStatus || 'SUBMITTED' };
  }

  /** Từ chối dứt khoát của máy chủ (trước khi ghi gì): bỏ ý định để lần sau nhập số tiền khác được. */
  function isDefiniteRejection(e) {
    const st = e && e.status;
    if (!st || st < 400 || st >= 500) return false;
    return st !== 401 && st !== 408 && (e && e.code) !== 'IDEMPOTENCY_KEY_REUSED';
  }

  function setTopupNotice(notice) {
    state.topupNotice = notice;
    renderTopupIntent();
  }

  function renderTopupIntent() {
    const intent = loadIntent();
    // Còn ý định mà chưa có thông báo cụ thể (ví dụ vừa tải lại trang): coi là chưa rõ kết quả.
    const notice = state.topupNotice || (intent ? { kind: 'unknown' } : null);
    const input = $('#topupAmount');
    if (input) {
      input.disabled = !!intent;
      if (intent) input.value = String(intent.amount);
    }
    document.querySelectorAll('[data-act="topup-preset"]').forEach((c) => { c.disabled = !!intent; });
    const box = $('#topupIntent');
    if (!box) return;
    if (!notice) { box.innerHTML = ''; return; }

    const amountText = intent ? money(intent.amount) : '';
    const retry = '<button class="btn btn-sm btn-primary" data-act="topup-retry">Thử lại cùng yêu cầu</button>';
    const check = '<button class="btn btn-sm" data-act="topup-check">Kiểm tra trạng thái</button>';
    const fresh = '<button class="btn btn-sm btn-ghost" data-act="topup-new">Bắt đầu lần nạp mới</button>';
    const idAttr = notice.paymentId ? ` data-id="${esc(notice.paymentId)}"` : '';
    const box2 = (tone, icon, text, buttons) =>
      `<div class="note ${tone}">${ico(icon, 18)}<span>${text}${buttons ? `<span class="row mt-2px">${buttons}</span>` : ''}</span></div>`;

    switch (notice.kind) {
      case 'submitting':
        box.innerHTML = box2('', 'loader-circle',
          `<b>Đang gửi yêu cầu nạp ${amountText} sang cổng thanh toán…</b> Đây không phải lỗi: hệ thống đang theo dõi và sẽ mở cổng thanh toán khi cổng đã nhận. Số dư chưa đổi.`, '');
        break;
      case 'retryable':
        box.innerHTML = box2('note-warning', 'triangle-alert',
          `<b>Yêu cầu nạp ${amountText} đã được lưu nhưng chưa gửi được sang cổng thanh toán.</b> Số dư chưa đổi. Bấm thử lại: hệ thống dùng cùng mã yêu cầu nên không tạo khoản nạp thứ hai.`,
          retry + fresh);
        break;
      case 'notfound':
        box.innerHTML = box2('note-warning', 'triangle-alert',
          `<b>Chưa thấy yêu cầu nạp nào với mã này</b>, nên có thể nó chưa được tạo. Gửi lại cùng yêu cầu là an toàn — không tạo khoản nạp thứ hai.`,
          retry + fresh);
        break;
      case 'unconfirmed':
        box.innerHTML = box2('note-warning', 'triangle-alert',
          `<b>Chưa xác nhận được kết quả nạp ${amountText} từ máy chủ.</b> Giao diện chưa xác minh được trạng thái cuối cùng của yêu cầu này nên không báo thành công và không cập nhật số dư. Hãy kiểm tra lại.`,
          `<button class="btn btn-sm btn-primary" data-act="topup-check"${idAttr}>Kiểm tra lại</button>`);
        break;
      case 'poll-timeout':
        box.innerHTML = box2('note-warning', 'clock',
          '<b>Chưa có kết quả mới từ cổng thanh toán.</b> Hệ thống vẫn tự đối soát; số dư chỉ đổi khi máy chủ xác nhận. Bạn có thể kiểm tra lại bất cứ lúc nào.',
          `<button class="btn btn-sm" data-act="topup-check"${idAttr}>Kiểm tra lại</button>`);
        break;
      case 'paypal':
        box.innerHTML = paypalNoticeHtml(notice, intent);
        break;
      case 'paypal-stop':
        box.innerHTML = box2('note-warning', 'triangle-alert',
          `<b>Dừng mọi thao tác tự động.</b> ${esc((API_ERROR_MESSAGES[notice.code] || (() => ''))())} Không có khoản nào bị giao diện tự cộng hay tự tạo lại.`,
          check + (intent ? fresh : ''));
        break;
      default: // 'unknown'
        box.innerHTML = box2('note-warning', 'triangle-alert',
          `<b>Chưa rõ yêu cầu nạp ${amountText} đã được tạo hay chưa.</b> Số tiền được khoá để tránh nạp trùng. Hãy kiểm tra trạng thái trước; gửi lại cùng yêu cầu thì an toàn.`,
          check + retry + fresh);
    }
  }

  async function createTopup(btn) {
    // Ý định đã có thì đi tiếp đúng đường của nó (không đổi cổng giữa chừng); chưa có thì theo cấu hình máy chủ.
    const existing = loadIntent();
    if ((existing && existing.provider === PAYPAL_PROVIDER) || (!existing && state.payConfig && state.payConfig.paypal)) {
      return createPaypalTopup(btn);
    }
    // Còn ý định chưa rõ thì GỬI LẠI chính nó (cùng khoá, cùng số tiền), bỏ qua ô nhập.
    let intent = loadIntent();
    if (!intent) {
      const amount = Number($('#topupAmount') ? $('#topupAmount').value : NaN);
      if (!Number.isInteger(amount) || amount < 1000) return toast('Nhập số tiền là số nguyên, tối thiểu 1.000₫', 'err');
      intent = startIntent(amount); // lưu TRƯỚC khi gửi: tải lại giữa chừng vẫn phục hồi được
    }
    const ctx = topupCtx(intent.requestId); // lấy dấu phiên + ý định lúc bắt đầu; không có await nào trước guard
    let pr;
    try {
      pr = await guard('topup-create', btn, async () => {
        try {
          return await api('/payments/topup', { method: 'POST', body: { amount: intent.amount, requestId: intent.requestId } });
        } catch (e) {
          // Lỗi của phiên/ý định cũ: không báo cho phiên mới. Riêng "hết phiên" của CHÍNH request này vẫn phải hiện.
          if (!ctxAlive(ctx) && !(e && e.code === 'UNAUTHENTICATED')) throw staleError();
          throw e;
        }
      });
    } catch (e) {
      if ((e && e.stale) || !ctxAlive(ctx)) return; // phiên đã kết thúc: không đụng vào ý định/thông báo nào nữa
      if (isDefiniteRejection(e)) {
        releaseIntent(ctx);
        setTopupNotice(null);
      } else if (e && e.code === 'PROVIDER_UNAVAILABLE') {
        setTopupNotice({ kind: 'retryable' });
      } else {
        setTopupNotice({ kind: 'unknown' });
        // Không rõ yêu cầu đã được tạo hay chưa: nạp lại danh sách để người dùng thấy sự thật thay vì nạp trùng.
        if (e && e.unknownOutcome) await loadTopupHistory().catch(() => {});
      }
      return;
    }
    if (!pr) return; // lần bấm lặp khi yêu cầu đầu còn chạy
    if (!ctxAlive(ctx)) return; // phản hồi đến sau khi đăng xuất / đổi tài khoản / bỏ ý định
    if (!validPaymentRow(pr, { amount: intent.amount, requestId: intent.requestId })) {
      // 200 nhưng thân thiếu/sai: không phải bằng chứng thành công. Giữ ý định, bảo người dùng kiểm tra.
      setTopupNotice({ kind: 'unknown' });
      toast('Máy chủ trả về dữ liệu không đầy đủ nên chưa rõ yêu cầu nạp đã được tạo hay chưa. Hãy bấm "Kiểm tra trạng thái".', 'err');
      await loadTopupHistory().catch(() => {});
      return;
    }
    await loadTopupHistory().catch(() => {});
    if (!ctxAlive(ctx)) return;
    await settleRow(pr, { ctx, openOnSubmitted: true, fromGet: false });
  }

  /**
   * Xác nhận một kết quả KẾT THÚC bằng GET /payments/:id. Chỉ trả về dòng khi GET thành công, hợp lệ, cùng id / số tiền /
   * requestId với yêu cầu đang theo dõi và nói đúng trạng thái kết thúc đó. Lỗi, timeout, thân hỏng, không khớp, hay trạng
   * thái khác (ví dụ POST nói SUCCEEDED mà GET nói PENDING) đều trả null — KHÔNG quay lại dùng dòng POST để báo thành công.
   */
  async function confirmTerminal(row, ctx) {
    let raw;
    try { raw = await api('/payments/' + encodeURIComponent(row.id)); } catch (_) { return null; }
    if (!ctxAlive(ctx)) return null;
    const fresh = readPaymentState(raw, { id: row.id, amount: row.amount, requestId: ctx.requestId || undefined });
    return fresh && fresh.status === row.status ? fresh : null;
  }

  /**
   * Xử lý một dòng yêu cầu nạp. `fromGet`: dòng đã được đọc bằng GET (theo dõi / kiểm tra) hay là phản hồi POST tạo yêu cầu.
   *   kết thúc            -> (POST) phải được GET xác nhận trước; xác nhận được mới bỏ ý định và báo; không thì "chưa xác nhận"
   *   PENDING + SUBMITTED -> cổng đã nhận: bỏ ý định, mở cổng thanh toán (nếu được phép)
   *   PENDING + SUBMITTING-> đang gửi: giữ ý định, theo dõi có hạn, KHÔNG mở cổng, KHÔNG báo lỗi
   *   PENDING + SUBMIT_FAILED -> giữ ý định, cho thử lại cùng khoá
   * Sau mỗi await kiểm ctxAlive: phản hồi của phiên/ý định cũ không được làm gì cả.
   */
  async function settleRow(row, { ctx, openOnSubmitted, fromGet }) {
    if (!ctxAlive(ctx)) return;
    const intent = ctx.requestId && !ctx.released ? loadIntent() : null;
    if (intent && row.id && intent.paymentId !== row.id) saveIntent({ ...intent, paymentId: row.id });

    if (row.status !== 'PENDING') {
      const confirmed = fromGet ? row : await confirmTerminal(row, ctx);
      if (!ctxAlive(ctx)) return;
      if (!confirmed) {
        // Giữ ý định: kết quả chưa được máy chủ xác nhận, người dùng có thể kiểm tra lại. Không báo thành công.
        setTopupNotice({ kind: 'unconfirmed', paymentId: row.id });
        toast('Chưa xác nhận được kết quả nạp tiền từ máy chủ. Hãy bấm "Kiểm tra lại".');
        return;
      }
      if (ctx.requestId && !ctx.released) releaseIntent(ctx);
      setTopupNotice(null);
      await announceTerminal(confirmed, ctx);
      return;
    }
    if (row.submissionStatus === 'SUBMITTED') {
      if (ctx.requestId && !ctx.released) releaseIntent(ctx);
      if (!openOnSubmitted) return; // đang theo dõi sau khi thanh toán: vẫn chờ, không mở lại cổng
      setTopupNotice(null);
      await openCheckout(row.id, row.providerRef, ctx);
      return;
    }
    if (row.submissionStatus === 'SUBMITTING') {
      setTopupNotice({ kind: 'submitting', paymentId: row.id });
      const result = await pollPayment(row.id, (r) => r.status !== 'PENDING' || r.submissionStatus !== 'SUBMITTING', ctx);
      if (result.cancelled || !ctxAlive(ctx)) return;
      if (result.done) return settleRow(result.row, { ctx, openOnSubmitted, fromGet: true });
      setTopupNotice({ kind: 'poll-timeout', paymentId: row.id });
      return;
    }
    // SUBMIT_FAILED
    setTopupNotice({ kind: 'retryable', paymentId: row.id });
  }

  /** Báo kết quả KẾT THÚC đã được máy chủ xác nhận. Không tự cộng tiền ở giao diện: chỉ đọc lại ví từ máy chủ. */
  async function announceTerminal(row, ctx) {
    if (!ctxAlive(ctx)) return;
    if (row.status === 'SUCCEEDED') {
      toast(`Nạp tiền thành công${RESOLVED_BY_LABEL[row.resolvedBy] ? ' ' + RESOLVED_BY_LABEL[row.resolvedBy] : ''}: ${money(row.amount)} đã vào ví.`, 'ok');
      await refreshWallet();
    } else if (row.status === 'FAILED') {
      toast('Yêu cầu nạp này đã thất bại. Ví của bạn không thay đổi.', 'err');
    }
    if (!ctxAlive(ctx)) return;
    if (currentHead() === 'wallet') route(); else renderChrome();
  }

  /**
   * Hỏi máy chủ trạng thái một yêu cầu nạp, có hạn và giãn dần. Dừng khi: đạt điều kiện, hết lượt, người dùng rời
   * trang ví, đăng xuất / đổi tài khoản, hoặc có vòng theo dõi mới/bị dừng — nên không bao giờ thành vòng lặp vô hạn
   * hay spam API. Huỷ cũng đánh thức lượt chờ đang treo (stopTopupPoll), nên Promise luôn kết thúc.
   */
  async function pollPayment(paymentId, until, ctx) {
    const owner = ctx || topupCtx(null);
    stopTopupPoll(); // vòng cũ (nếu có) thoát; sau đó lấy số thế hệ của vòng này
    const gen = state.topupPollGen;
    const stale = () => gen !== state.topupPollGen || !ctxAlive(owner) || currentHead() !== 'wallet';
    let last = null;
    for (const delay of POLL_DELAYS_MS) {
      await new Promise((resolve) => {
        state.topupPollWake = resolve;
        state.topupPoll = setTimeout(() => { state.topupPoll = null; state.topupPollWake = null; resolve(); }, delay);
      });
      if (stale()) return { cancelled: true, row: last };
      try {
        const row = readPaymentState(await api('/payments/' + encodeURIComponent(paymentId)), { id: paymentId });
        if (stale()) return { cancelled: true, row: last };
        if (row) {
          last = row;
          if (until(row)) return { done: true, row };
        }
      } catch (_) { /* thử lại ở lượt sau */ }
    }
    return { done: false, row: last };
  }

  /** Nút "Kiểm tra trạng thái / Kiểm tra lại". */
  async function checkTopupStatus(btn) {
    const intent = loadIntent();
    const knownId = (btn && btn.dataset && btn.dataset.id) || (intent && intent.paymentId) || null;
    if (!intent && !knownId) return;
    const ctx = topupCtx(intent ? intent.requestId : null);
    const lookup = async () => {
      try {
        if (knownId) return await api('/payments/' + encodeURIComponent(knownId));
        // Chưa biết id (yêu cầu có thể chưa/đã được tạo): tìm theo mã yêu cầu trong danh sách của chính mình.
        const { paymentRequests } = await api('/payments/me');
        return (Array.isArray(paymentRequests) ? paymentRequests : []).find((r) => r && r.requestId === intent.requestId) || null;
      } catch (e) {
        if (!ctxAlive(ctx) && !(e && e.code === 'UNAUTHENTICATED')) throw staleError();
        throw e;
      }
    };
    let raw;
    try {
      raw = await guard('topup-check', btn, lookup);
    } catch (_) {
      return; // lỗi đã được báo (hoặc là của phiên cũ, im lặng); giữ nguyên thông báo hiện tại
    }
    if (raw === undefined) return; // bấm lặp
    if (!ctxAlive(ctx)) return;
    if (raw !== null && (raw.provider === PAYPAL_PROVIDER || (intent && intent.provider === PAYPAL_PROVIDER))) {
      return finishPaypalCheck(raw, { intent, knownId, ctx });
    }
    if (raw === null) {
      setTopupNotice({ kind: 'notfound' });
      return;
    }
    const row = readPaymentState(raw, {
      id: knownId || undefined,
      requestId: intent ? intent.requestId : undefined,
      amount: intent ? intent.amount : undefined,
    });
    if (!row) {
      toast('Máy chủ trả về dữ liệu không đầy đủ hoặc không khớp. Hãy thử kiểm tra lại sau ít phút.', 'err');
      return;
    }
    await loadTopupHistory().catch(() => {});
    if (!ctxAlive(ctx)) return;
    if (row.status === 'PENDING' && row.submissionStatus === 'SUBMITTED' && !intent) {
      toast('Yêu cầu nạp vẫn đang chờ cổng thanh toán xác nhận. Số dư chưa đổi.');
      return;
    }
    await settleRow(row, { ctx, openOnSubmitted: !!intent, fromGet: true });
  }

  /** Bắt đầu lần nạp mới: bỏ ý định cũ chưa rõ kết quả. Phải xác nhận vì khoản cũ có thể đã được tạo. */
  function askNewTopup() {
    openModal({
      title: 'Bắt đầu lần nạp mới?',
      body: `
        <div class="stack">
          <div class="note note-warning">${ico('triangle-alert', 18)}<span>Lần nạp trước <b>chưa rõ kết quả</b> và có thể đã được tạo.
            Nếu bạn bắt đầu lần mới, giao diện sẽ không còn theo dõi lần cũ; nếu cả hai đều được thanh toán ở cổng, ví có thể được nạp hai lần.
            Hãy bấm "Kiểm tra trạng thái" trước nếu chưa chắc.</span></div>
        </div>`,
      footer: `<button class="btn" data-act="modal-close">Giữ lần nạp cũ</button>
        <button class="btn btn-danger" data-act="topup-new-confirm">Bắt đầu lần nạp mới</button>`,
    });
  }

  function confirmNewTopup() {
    stopTopupPoll();
    clearIntent();
    state.topupNotice = null;
    closeModal();
    renderTopupIntent();
    const input = $('#topupAmount');
    if (input) { input.value = ''; input.focus(); }
    toast('Đã bỏ lần nạp cũ. Nhập số tiền để bắt đầu lần nạp mới.');
  }

  // ---------- PayPal Sandbox ----------
  //
  // Hợp đồng: HOP-DONG-API-PAYPAL-P2-M2.md. Mọi con số tiền, báo giá, giai đoạn và URL phê duyệt đều do MÁY CHỦ quyết định; giao
  // diện chỉ hiển thị và KIỂM dữ liệu, không tự tính tỷ giá hay số USD, không tự dựng URL, không tự cộng ví.
  //
  // Luồng: tạo yêu cầu (POST /payments/paypal/topup, giữ requestId như P1) -> người dùng bấm "Mở PayPal Sandbox" (mở lại URL bằng
  // GET .../checkout) -> PayPal đưa về ?paypal=return|cancel&paymentRequestId=<id> -> giao diện GET /payments/:id để xác minh chủ
  // sở hữu / id / số tiền / requestId / provider -> tự hoàn tất bằng POST .../capture sau return hợp lệ -> luôn GET lại làm chứng cứ.
  // Query của PayPal (token, PayerID) KHÔNG phải chứng cứ thành công và không dùng làm danh tính hay quyền sở hữu.

  const PAYPAL_APPROVAL_ORIGIN = 'https://www.sandbox.paypal.com';
  // Từ chối dứt khoát của máy chủ TRƯỚC khi tạo gì: bỏ ý định. Lỗi còn lại (mạng, timeout, 5xx, 429, ...) có thể đã tạo -> giữ ý định.
  const PAYPAL_DEFINITE_CODES = ['INVALID_AMOUNT', 'AMOUNT_OUT_OF_RANGE', 'VALIDATION_ERROR', 'TOPUP_LIMIT_EXCEEDED',
    'WALLET_NOT_FOUND', 'FORBIDDEN', 'PAYPAL_DISABLED'];
  const PAYPAL_STOP_CODES = ['PAYPAL_CREATE_RECOVERY_REQUIRED', 'PAYPAL_ORDER_MISMATCH', 'PAYPAL_CAPTURE_CONFLICT'];
  const PAYPAL_OUTCOME_HINT = {
    APPLIED: 'Máy chủ báo đã áp dụng — đang xác minh lại trạng thái.',
    DUPLICATE: 'Yêu cầu này đã được xử lý trước đó — đang xác minh lại trạng thái.',
    BUSY: 'Máy chủ đang xử lý một xác nhận khác cho yêu cầu này. Hãy chờ rồi kiểm tra lại.',
    NOT_READY: 'PayPal chưa ghi nhận phê duyệt. Hãy hoàn tất phê duyệt ở PayPal Sandbox rồi quay lại.',
    CLOSED: 'Yêu cầu này đã đóng.',
    NOT_CAPTURED: 'Không thu tiền cho yêu cầu này.',
    RECOVERY_REQUIRED: 'Cần xử lý thủ công; giao diện không tự cộng ví.',
    RECONCILING: 'Chưa rõ kết quả; hệ thống đang đối soát.',
    AWAITING_APPROVAL: 'Vẫn chờ phê duyệt ở PayPal Sandbox.',
  };

  /** Điều hướng sang URL đã kiểm. window.ENCLAVE_NAVIGATE chỉ để bộ kiểm thử UI chặn điều hướng thật. */
  function goTo(url) {
    if (typeof window.ENCLAVE_NAVIGATE === 'function') return window.ENCLAVE_NAVIGATE(url);
    window.location.assign(url);
  }

  /** Chỉ chấp nhận URL https, ĐÚNG origin Sandbox, không username/password. Không domain gần giống, không javascript:. */
  function validApprovalUrl(raw) {
    if (typeof raw !== 'string' || !raw || raw.length > 2000 || /[\s\\]/.test(raw)) return null;
    let u;
    try { u = new URL(raw); } catch (_) { return null; }
    if (u.protocol !== 'https:' || u.origin !== PAYPAL_APPROVAL_ORIGIN) return null;
    if (u.username || u.password || u.port) return null;
    return u.href;
  }

  /** Cấu hình công khai. Thiếu/lỗi/sai dạng thì TẮT PayPal; chỉ mở mô phỏng khi máy chủ nói mockPayments.enabled=true. */
  function readPayConfig(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const pp = raw.paypalSandbox;
    const mk = raw.mockPayments;
    if (!pp || typeof pp !== 'object' || typeof pp.enabled !== 'boolean') return null;
    if (!mk || typeof mk !== 'object' || typeof mk.enabled !== 'boolean') return null;
    return { paypal: pp.enabled === true && pp.mode === 'sandbox', mock: mk.enabled === true, state: 'ok' };
  }

  async function loadPayConfig() {
    try {
      const cfg = readPayConfig(await api('/payments/paypal/config'));
      state.payConfig = cfg || { paypal: false, mock: false, state: 'invalid' };
    } catch (e) {
      if (e && e.stale) return state.payConfig || { paypal: false, mock: false, state: 'error' };
      // Không có cấu hình xác nhận: giữ cả hai cổng tắt, kể cả HTTP 404.
      state.payConfig = { paypal: false, mock: false, state: 'error' };
    }
    return state.payConfig;
  }

  function walletTopupCard(cfg) {
    if (cfg.paypal) return paypalTopupCard();
    if (cfg.mock) return topupCard();
    const msg = cfg.state === 'ok'
      ? 'Hiện chưa có cổng nạp tiền nào được bật. Giao diện không tự chuyển sang cổng khác.'
      : 'Chưa tải được cấu hình nạp tiền từ máy chủ nên chưa mở cổng nào. Giao diện không đoán cổng nào đang bật.';
    return `
      <div class="card">
        <div class="card-head"><h2>Nạp tiền vào ví</h2></div>
        <div class="card-body stack">
          <div class="note note-warning">${ico('triangle-alert', 18)}<span><b>Nạp tiền chưa sẵn sàng.</b> ${msg}</span></div>
          <div id="topupIntent" aria-live="polite"></div>
          ${cfg.state === 'ok' ? '' : '<div><button class="btn" data-act="paypal-config-retry">Tải lại cấu hình</button></div>'}
        </div>
      </div>`;
  }

  function paypalTopupCard() {
    return `
      <div class="card">
        <div class="card-head"><h2>Nạp tiền vào ví</h2><span class="tag tag-info">${ico('shield-check', 12)} PayPal Sandbox</span></div>
        <div class="card-body stack">
          <div class="field">
            <label for="topupAmount">Số tiền ghi vào ví (VND)</label>
            <div class="chips">${TOPUP_PRESETS.map((v) =>
              `<button class="chip" data-act="topup-preset" data-v="${v}">${money(v)}</button>`).join('')}</div>
            <input id="topupAmount" type="number" min="1000" step="1000" placeholder="Hoặc nhập số tiền khác...">
          </div>
          <div id="topupIntent" aria-live="polite"></div>
          <div class="note">
            ${ico('info', 18)}
            <span>Đây là <b>PayPal Sandbox</b> (môi trường thử): dùng tài khoản Sandbox, không chuyển tiền thật. Sau khi tạo yêu cầu,
              <b>máy chủ</b> chốt số VND ghi vào ví và số USD Sandbox phải trả theo tỷ giá mô phỏng; giao diện không tự tính.</span>
          </div>
          <div class="note">
            ${ico('info', 18)}
            <span>Số dư chỉ tăng khi <b>máy chủ xác nhận</b> đã thu tiền. Quay lại từ PayPal, đóng cửa sổ hay huỷ không làm tăng số dư và
              cũng không làm yêu cầu thất bại. Ví, ký quỹ, hoàn tiền và giải ngân tranh chấp vẫn tính bằng VND trong ví nội bộ; hệ thống
              không hoàn tiền hay chi tiền qua PayPal.</span>
          </div>
          <div><button class="btn btn-primary btn-lg" data-act="topup-create">${ico('wallet', 18)} Tạo yêu cầu nạp PayPal</button></div>
        </div>
      </div>`;
  }

  /** Báo giá do máy chủ chốt. Chỉ KIỂM nhất quán (không dùng để tính số hiển thị): usdValue là chuỗi của máy chủ. */
  function validQuote(q, amount) {
    if (!q || typeof q !== 'object' || Array.isArray(q)) return false;
    if (q.currency !== 'USD' || q.amountVnd !== amount) return false;
    if (!Number.isSafeInteger(q.usdCents) || q.usdCents <= 0) return false;
    if (typeof q.usdValue !== 'string' || !/^\d{1,9}\.\d{2}$/.test(q.usdValue)) return false;
    if (q.usdValue.replace('.', '').replace(/^0+(?=\d)/, '') !== String(q.usdCents)) return false;
    if (!Number.isSafeInteger(q.rateVndPerUsd) || q.rateVndPerUsd <= 0 || q.rateKind !== 'DEMO_FIXED') return false;
    return typeof q.rateLabel === 'string' && !!q.rateLabel.trim() && q.rateLabel.length <= 200;
  }

  /**
   * Một dòng yêu cầu PayPal Sandbox đọc từ máy chủ có đủ và đúng dữ liệu để dựa vào không? Kiểm id / số tiền / requestId / provider
   * khớp yêu cầu đang theo dõi (khi biết), báo giá hợp lệ, giai đoạn thuộc bộ đã biết, và status SUCCEEDED <=> stage SUCCEEDED.
   * Trả về dòng hoặc null.
   */
  function readPaypalRow(r, expect) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
    if (typeof r.id !== 'string' || !r.id || r.provider !== PAYPAL_PROVIDER || r.sandbox !== true) return null;
    if (!PAYMENT_STATUSES.includes(r.status) || !PAYPAL_STAGES.includes(r.stage)) return null;
    if (!Number.isSafeInteger(r.amount) || r.amount <= 0 || typeof r.requestId !== 'string' || !REQUEST_ID_RE.test(r.requestId)) return null;
    if (!SUBMISSION_STATUSES.includes(r.submissionStatus) || !validQuote(r.quote, r.amount)) return null;
    if ((r.status === 'SUCCEEDED') !== (r.stage === 'SUCCEEDED')) return null;
    if (expect && expect.id !== undefined && r.id !== expect.id) return null;
    if (expect && expect.amount !== undefined && r.amount !== expect.amount) return null;
    if (expect && expect.requestId !== undefined && r.requestId !== expect.requestId) return null;
    return r;
  }

  function paypalMatchesIntent(row, intent) {
    return !!intent && intent.provider === PAYPAL_PROVIDER && row.requestId === intent.requestId && row.amount === intent.amount
      && (!intent.paymentId || intent.paymentId === row.id);
  }

  function paypalHistoryAction(p) {
    if (!PAYPAL_STAGES.includes(p.stage)) return '';
    const id = esc(p.id);
    switch (p.stage) {
      case 'AWAITING_APPROVAL': return `<button class="btn btn-sm" data-act="paypal-approve" data-id="${id}">Mở PayPal Sandbox</button>` + paypalAbandonButton(p);
      case 'CREATING': case 'CAPTURING': case 'RECONCILING':
        return `<button class="btn btn-sm" data-act="topup-check" data-id="${id}">Kiểm tra</button>`;
      case 'CREATE_RECOVERY_REQUIRED': case 'RECOVERY_REQUIRED':
        return `<span class="muted small">Cần hỗ trợ — mã tham chiếu ${esc(shortId(p.id))}</span>`;
      default: return '';
    }
  }

  /** Khung thông báo PayPal theo giai đoạn. Chỉ có nút ĐÚNG với giai đoạn đó (ví dụ chỉ AWAITING_APPROVAL mới có nút xác nhận). */
  function paypalNoticeHtml(notice, intent) {
    const r = notice.row;
    const q = r.quote;
    const id = esc(r.id);
    const ref = shortId(r.id);
    const ui = PAYPAL_STAGE_UI[r.stage];
    const quote = `
      <span class="price-row"><span>Ghi vào ví (VND)</span><span class="val">${money(r.amount)}</span></span>
      <span class="price-row"><span>PayPal Sandbox thu (USD)</span><span class="val">${esc(q.usdValue)} USD</span></span>
      <span class="muted small">${esc(q.rateLabel)} — ${Number(q.rateVndPerUsd).toLocaleString('vi-VN')} VND/USD, do máy chủ chốt; giao diện không tính lại.</span>`;
    const hint = notice.extra && notice.extra.outcome && PAYPAL_OUTCOME_HINT[notice.extra.outcome]
      ? `<br><span class="small">${esc(PAYPAL_OUTCOME_HINT[notice.extra.outcome])}</span>` : '';
    const timed = notice.timedOut ? '<br><span class="small">Chưa có kết quả mới sau thời gian theo dõi — bấm "Kiểm tra lại".</span>' : '';
    const check = `<button class="btn btn-sm" data-act="topup-check" data-id="${id}">Kiểm tra lại</button>`;
    const dismiss = '<button class="btn btn-sm btn-ghost" data-act="topup-dismiss">Đã hiểu</button>';
    const fresh = '<button class="btn btn-sm btn-ghost" data-act="topup-new">Bắt đầu lần nạp mới</button>';
    const wrap = (tone, icon, text, buttons) =>
      `<div class="note ${tone}">${ico(icon, 18)}<span>${text}${hint}${timed}${buttons ? `<span class="row mt-2px">${buttons}</span>` : ''}</span></div>`;

    switch (r.stage) {
      case 'CREATING':
        return wrap('note-warning', 'loader-circle',
          `<b>Đang tạo yêu cầu PayPal Sandbox cho khoản nạp ${money(r.amount)}…</b> Chưa có order. Có thể kiểm tra lại, hoặc thử lại cùng yêu cầu (cùng mã, không tạo trùng).`,
          check + '<button class="btn btn-sm btn-primary" data-act="topup-retry">Thử lại cùng yêu cầu</button>');
      case 'AWAITING_APPROVAL': {
        const note = notice.unverified
          ? '<b>Yêu cầu này không khớp với ý định nạp lưu trên thiết bị này</b> nên không cho xác nhận thu tiền ở đây; chỉ hiển thị trạng thái.'
          : notice.returned
            ? '<b>Đang kiểm tra kết quả thanh toán PayPal.</b> Số dư chỉ tăng khi máy chủ xác nhận đã thu tiền.'
            : notice.cancelled
              ? '<b>Bạn đã quay lại mà chưa hoàn tất phê duyệt.</b> Huỷ hay đóng cửa sổ không làm yêu cầu thất bại; yêu cầu vẫn mở và chưa thu tiền.'
              : '<b>Chờ bạn phê duyệt ở PayPal Sandbox.</b> Số dư chỉ tăng sau khi bạn phê duyệt và máy chủ xác nhận.';
        return wrap('', 'shield-check', `${note}${quote}`,
          `<button class="btn btn-sm btn-primary" data-act="paypal-approve" data-id="${id}">${notice.returned || notice.cancelled ? 'Mở lại PayPal Sandbox' : 'Mở PayPal Sandbox'}</button>`
          + check + paypalAbandonButton(r));
      }
      case 'CAPTURING':
        return wrap('note-warning', 'loader-circle',
          `<b>Đang xác nhận thanh toán với PayPal…</b> Đừng thao tác lặp; chưa phải thành công cũng chưa phải thất bại.${quote}`, check);
      case 'RECONCILING':
        return wrap('note-warning', 'clock',
          `<b>Chưa rõ kết quả thanh toán; hệ thống đang đối soát.</b> Đây không phải thất bại và cũng chưa phải thành công; số dư chưa đổi.${quote}`, check);
      case 'CREATE_RECOVERY_REQUIRED':
        return wrap('note-warning', 'triangle-alert',
          `<b>Chưa tạo được order PayPal và hệ thống KHÔNG tự tạo order mới.</b> Cần hỗ trợ đối soát — hãy gửi mã tham chiếu <b>${esc(ref)}</b>.`,
          (intent ? fresh : '') + dismiss);
      case 'RECOVERY_REQUIRED':
        return wrap('note-warning', 'triangle-alert',
          `<b>Có bằng chứng thu tiền nhưng yêu cầu đã đóng — cần xử lý thủ công.</b> Giao diện không tự cộng ví. Mã tham chiếu <b>${esc(ref)}</b>.`, dismiss);
      case 'NOT_CAPTURED':
        return wrap('', 'info', '<b>Không tiếp tục thu tiền cho yêu cầu này.</b> Ví không đổi. (Đóng hay huỷ cửa sổ PayPal không tự là trạng thái này.)', dismiss);
      default: // FAILED
        return wrap('note-warning', 'triangle-alert', `<b>${esc(ui.label)}:</b> yêu cầu nạp đã đóng; ví không đổi.`, dismiss);
    }
  }

  /** Xác nhận SUCCEEDED bằng GET /payments/:id khớp id / số tiền / requestId / provider. Lỗi hay không khớp -> null. */
  async function confirmPaypalByGet(row, ctx) {
    let raw;
    try { raw = await api('/payments/' + encodeURIComponent(row.id)); } catch (_) { return null; }
    if (!ctxAlive(ctx)) return null;
    return readPaypalRow(raw, { id: row.id, amount: row.amount, requestId: row.requestId });
  }

  /**
   * Xử lý một dòng PayPal. `fromGet`: dòng đã được đọc bằng GET (theo dõi / kiểm tra / return) hay là phản hồi POST tạo yêu cầu.
   * SUCCEEDED chỉ được báo khi GET khớp nói SUCCEEDED. Mọi giai đoạn khác hiển thị đúng như máy chủ nói; không giả thành công/thất bại.
   */
  async function settlePaypalRow(row, { ctx, fromGet, returned, cancelled, unverified, extra }) {
    if (!ctxAlive(ctx)) return;
    const intent = ctx.requestId && !ctx.released ? loadIntent() : null;
    // Chỉ GHI NHỚ id yêu cầu khi ý định chưa có id và dòng đúng là của ý định này. Không bao giờ ghi đè id đã có:
    // một lần quay lại mang id lạ không được tự biến thành "khớp ý định".
    if (intent && !intent.paymentId && row.id && row.requestId === intent.requestId && row.amount === intent.amount) {
      saveIntent({ ...intent, paymentId: row.id });
    }

    if (row.stage === 'SUCCEEDED') {
      const confirmed = fromGet ? row : await confirmPaypalByGet(row, ctx);
      if (!ctxAlive(ctx)) return;
      if (!confirmed || confirmed.stage !== 'SUCCEEDED') {
        setTopupNotice({ kind: 'unconfirmed', paymentId: row.id });
        toast('Chưa xác nhận được kết quả nạp tiền từ máy chủ. Hãy bấm "Kiểm tra lại".');
        return;
      }
      if (ctx.requestId && !ctx.released) releaseIntent(ctx);
      setTopupNotice(null);
      toast(`Nạp tiền thành công: ${money(confirmed.amount)} đã vào ví (PayPal Sandbox ${confirmed.quote.usdValue} USD).`, 'ok');
      await refreshWallet();
      if (!ctxAlive(ctx)) return;
      if (currentHead() === 'wallet') route(); else renderChrome();
      return;
    }

    setTopupNotice({ kind: 'paypal', row, returned, cancelled, unverified, extra });
    // Yêu cầu đã đóng ở máy chủ: mở khoá số tiền để người dùng nạp tiếp (thông báo vẫn còn). Giai đoạn còn mở thì giữ ý định.
    if (['FAILED', 'NOT_CAPTURED', 'RECOVERY_REQUIRED'].includes(row.stage)) {
      if (ctx.requestId && !ctx.released) { releaseIntent(ctx); renderTopupIntent(); }
      if (row.stage === 'FAILED') toast('Yêu cầu nạp PayPal đã đóng. Ví của bạn không thay đổi.', 'err');
      return;
    }
    if (['CREATING', 'CAPTURING', 'RECONCILING'].includes(row.stage)) {
      const res = await pollPayment(row.id, (r) => !['CREATING', 'CAPTURING', 'RECONCILING'].includes(r.stage), ctx);
      if (res.cancelled || !ctxAlive(ctx)) return;
      const fresh = res.row ? readPaypalRow(res.row, { id: row.id, amount: row.amount, requestId: row.requestId }) : null;
      if (res.done && fresh) return settlePaypalRow(fresh, { ctx, fromGet: true });
      setTopupNotice({ kind: 'paypal', row: fresh || row, timedOut: true });
    }
  }

  /** Tạo yêu cầu nạp PayPal Sandbox. requestId/số tiền của ý định được giữ qua retry, tải lại, 5xx, timeout. */
  async function createPaypalTopup(btn) {
    let intent = loadIntent();
    if (!intent) {
      const amount = Number($('#topupAmount') ? $('#topupAmount').value : NaN);
      if (!Number.isInteger(amount) || amount < 1000) return toast('Nhập số tiền là số nguyên, tối thiểu 1.000₫', 'err');
      intent = startIntent(amount, PAYPAL_PROVIDER); // lưu TRƯỚC khi gửi
    }
    const ctx = topupCtx(intent.requestId);
    let raw;
    try {
      raw = await guard('topup-create', btn, async () => {
        try {
          return await api('/payments/paypal/topup', { method: 'POST', body: { amount: intent.amount, requestId: intent.requestId } });
        } catch (e) {
          if (!ctxAlive(ctx) && !(e && e.code === 'UNAUTHENTICATED')) throw staleError();
          throw e;
        }
      });
    } catch (e) {
      if ((e && e.stale) || !ctxAlive(ctx)) return;
      const code = e && e.code;
      if (PAYPAL_DEFINITE_CODES.includes(code)) {
        releaseIntent(ctx);
        setTopupNotice(null);
        if (code === 'PAYPAL_DISABLED') { // cấu hình đã đổi: không tự chuyển sang cổng khác, vẽ lại theo cấu hình mới
          state.payConfig = { paypal: false, mock: false, state: 'ok' };
          if (currentHead() === 'wallet') route();
        }
      } else if (PAYPAL_STOP_CODES.includes(code)) {
        setTopupNotice({ kind: 'paypal-stop', code }); // dừng tự động; giữ ý định để kiểm tra
      } else {
        setTopupNotice({ kind: 'unknown' }); // mạng/timeout/5xx/429/...: có thể đã tạo -> giữ ý định, cùng khoá
        if (e && e.unknownOutcome) await loadTopupHistory().catch(() => {});
      }
      return;
    }
    if (raw === undefined) return; // bấm lặp
    if (!ctxAlive(ctx)) return;
    const row = readPaypalRow(raw, { amount: intent.amount, requestId: intent.requestId });
    if (!row) {
      setTopupNotice({ kind: 'unknown' });
      toast('Máy chủ trả về dữ liệu PayPal không đầy đủ hoặc không khớp nên chưa rõ yêu cầu nạp đã được tạo hay chưa. Hãy bấm "Kiểm tra trạng thái".', 'err');
      await loadTopupHistory().catch(() => {});
      return;
    }
    await loadTopupHistory().catch(() => {});
    if (!ctxAlive(ctx)) return;
    await settlePaypalRow(row, { ctx, fromGet: false });
    if (ctxAlive(ctx) && row.stage === 'AWAITING_APPROVAL') {
      await openPaypalApproval({ dataset: { id: row.id } });
    }
  }

  /** "Mở PayPal Sandbox": lấy URL mới bằng GET .../checkout, kiểm chặt rồi mới điều hướng. Không bao giờ tự dựng URL. */
  async function openPaypalApproval(btn) {
    const intent = loadIntent();
    const mine = intent && intent.provider === PAYPAL_PROVIDER ? intent : null;
    const id = (btn && btn.dataset && btn.dataset.id) || (mine && mine.paymentId) || null;
    if (!id) return;
    const ctx = topupCtx(mine ? mine.requestId : null);
    let raw;
    try {
      raw = await guard('paypal-approve', btn, async () => {
        try {
          return await api('/payments/paypal/' + encodeURIComponent(id) + '/checkout');
        } catch (e) {
          if (!ctxAlive(ctx) && !(e && e.code === 'UNAUTHENTICATED')) throw staleError();
          throw e;
        }
      });
    } catch (_) {
      return; // lỗi đã được báo (hoặc của phiên cũ, im lặng)
    }
    if (raw === undefined || !ctxAlive(ctx)) return;
    const row = readPaypalRow(raw, { id, requestId: mine ? mine.requestId : undefined, amount: mine ? mine.amount : undefined });
    if (!row) {
      toast('Máy chủ trả về dữ liệu không hợp lệ nên chưa mở PayPal. Hãy bấm "Kiểm tra lại".', 'err');
      return;
    }
    if (row.stage !== 'AWAITING_APPROVAL') {
      await settlePaypalRow(row, { ctx, fromGet: true });
      return;
    }
    const url = validApprovalUrl(row.approvalUrl);
    if (!url) {
      toast('PayPal trả về địa chỉ phê duyệt không hợp lệ nên chưa mở. Hãy thử lại sau hoặc liên hệ hỗ trợ.', 'err');
      return;
    }
    if (!ctxAlive(ctx)) return;
    try { sessionStorage.setItem('cat_paypal_departure', JSON.stringify({ userId: state.user.id, id: row.id, requestId: row.requestId, amount: row.amount })); } catch (_) {}
    goTo(url);
  }

  // Browser Back không phải return phê duyệt: chỉ đọc trạng thái và cho tiếp tục/huỷ.
  async function resumePaypalAfterBack() {
    let saved;
    try { saved = JSON.parse(sessionStorage.getItem('cat_paypal_departure') || 'null'); } catch (_) { return; }
    const intent = loadIntent();
    if (!saved || !state.user || saved.userId !== state.user.id || !intent || intent.provider !== PAYPAL_PROVIDER
      || saved.id !== intent.paymentId || saved.requestId !== intent.requestId || saved.amount !== intent.amount) return;
    const ctx = topupCtx(intent.requestId);
    try { sessionStorage.removeItem('cat_paypal_departure'); } catch (_) {}
    let raw;
    try { raw = await api('/payments/' + encodeURIComponent(saved.id)); } catch (_) {
      if (ctxAlive(ctx)) setTopupNotice({ kind: 'unconfirmed', paymentId: saved.id });
      return;
    }
    if (!ctxAlive(ctx)) return;
    const row = readPaypalRow(raw, { id: saved.id, requestId: intent.requestId, amount: intent.amount });
    if (!row) return setTopupNotice({ kind: 'unconfirmed', paymentId: saved.id });
    await settlePaypalRow(row, { ctx, fromGet: true, cancelled: true });
  }

  function paypalAbandonButton(row) {
    if (row.status !== 'PENDING' || row.stage !== 'AWAITING_APPROVAL' || !row.orderId) return '';
    return `<button class="btn btn-sm btn-ghost" data-act="paypal-abandon" data-id="${esc(row.id)}" data-request-id="${esc(row.requestId)}" data-amount="${esc(row.amount)}">Huỷ yêu cầu nạp</button>`;
  }

  async function openPaypalAbandon(btn) {
    const id = btn && btn.dataset.id;
    const expected = { id, requestId: btn && btn.dataset.requestId, amount: Number(btn && btn.dataset.amount) };
    if (!id || !expected.requestId || !Number.isSafeInteger(expected.amount)) return;
    const intent = loadIntent();
    const matched = intent && intent.provider === PAYPAL_PROVIDER && intent.paymentId === id
      && intent.requestId === expected.requestId && intent.amount === expected.amount;
    const ctx = topupCtx(matched ? intent.requestId : null);
    let raw;
    try { raw = await guard('paypal-abandon-open', btn, () => api('/payments/' + encodeURIComponent(id))); }
    catch (_) { return; }
    if (raw === undefined || !ctxAlive(ctx)) return;
    const row = readPaypalRow(raw, expected);
    if (!row) { toast('Chưa xác nhận được yêu cầu nạp. Hãy kiểm tra lại trạng thái.', 'err'); return; }
    if (row.status !== 'PENDING' || row.stage !== 'AWAITING_APPROVAL' || !row.orderId) {
      setTopupNotice({ kind: 'paypal', row });
      toast('Trạng thái đã thay đổi; chưa thể bỏ yêu cầu này.');
      return;
    }
    stopTopupPoll();
    openModal({ title: 'Bỏ yêu cầu nạp PayPal?', body: `<p>Bạn muốn bỏ yêu cầu nạp <b>${money(row.amount)}</b> này?</p>
      <p>Máy chủ chỉ đóng khi xác nhận chưa gửi lệnh thu tiền. Đây không phải hoàn tiền và không huỷ order tại PayPal.</p>
      <p>Nếu đã thu tiền hoặc chưa rõ kết quả, yêu cầu sẽ được giữ để đối soát. Đóng cửa sổ PayPal không tự bỏ yêu cầu.</p>`,
      footer: '<button class="btn" data-act="modal-close">Giữ yêu cầu</button><button class="btn btn-primary" data-act="paypal-abandon-confirm">Xác nhận bỏ yêu cầu</button>' });
    state.paypalAbandonConfirmation = { ctx, row };
  }

  async function confirmPaypalAbandon(btn) {
    const pending = state.paypalAbandonConfirmation;
    if (!pending || !ctxAlive(pending.ctx) || state.busy.has('paypal-abandon')) return;
    const { ctx, row } = pending;
    closeModal();
    let body = null;
    try {
      body = await guard('paypal-abandon', btn, () => api('/payments/paypal/' + encodeURIComponent(row.id) + '/abandon',
        { method: 'POST', body: {}, allowAuthRetry: false }));
    } catch (e) { if ((e && e.stale) || !ctxAlive(ctx)) return; }
    if (!ctxAlive(ctx)) return;
    // POST (including 409/timeout) is never proof of the final state. Do not retry it automatically.
    const fresh = await confirmPaypalByGet(row, ctx);
    if (!ctxAlive(ctx)) return;
    if (!fresh) {
      setTopupNotice({ kind: 'unconfirmed', paymentId: row.id });
      toast('Chưa xác nhận được kết quả bỏ yêu cầu. Hãy kiểm tra lại trạng thái.');
      return;
    }
    if (fresh.stage === 'SUCCEEDED') {
      await settlePaypalRow(fresh, { ctx, fromGet: true });
      return;
    }
    // Recovery evidence wins over FAILED. Keep the intent and never report an abandoned outcome for it.
    setTopupNotice({ kind: 'paypal', row: fresh });
    if (fresh.status === 'FAILED' && fresh.stage === 'FAILED') {
      if (ctx.requestId && !ctx.released) releaseIntent(ctx);
      renderTopupIntent();
      const confirmed = readPaypalRow(body, { id: row.id, requestId: row.requestId, amount: row.amount });
      const abandoned = confirmed && confirmed.status === 'FAILED' && confirmed.stage === 'FAILED'
        && ['ABANDONED', 'ALREADY_ABANDONED'].includes(body.outcome);
      toast(abandoned ? 'Đã bỏ yêu cầu nạp. Ví không đổi; lần nạp mới sẽ dùng mã mới.' : 'Yêu cầu nạp đã đóng theo trạng thái máy chủ.');
    }
    await loadTopupHistory().catch(() => {});
  }

  /** Tự hoàn tất một lần sau return đã xác minh. Không bao giờ gửi lại POST tự động; luôn GET lại làm chứng cứ. */
  async function capturePaypal(btn, expectedCtx) {
    const intent = loadIntent();
    const id = (btn && btn.dataset && btn.dataset.id) || (intent && intent.paymentId) || null;
    if (!intent || intent.provider !== PAYPAL_PROVIDER || !id) return;
    const ctx = expectedCtx || topupCtx(intent.requestId);
    if (!ctxAlive(ctx) || intent.paymentId !== id) return;
    let body;
    try {
      body = await guard('paypal-capture', btn, async () => {
        try {
          return await api('/payments/paypal/' + encodeURIComponent(id) + '/capture', { method: 'POST' });
        } catch (e) {
          if (!ctxAlive(ctx) && !(e && e.code === 'UNAUTHENTICATED')) throw staleError();
          throw e;
        }
      });
    } catch (e) {
      if ((e && e.stale) || !ctxAlive(ctx)) return;
      // Timeout / mất kết nối / 429 / 5xx / CLAIM_LOST / CONFLICT: kết quả có thể chưa rõ. KHÔNG gửi lại POST; hỏi trạng thái.
      await refreshPaypalState(id, ctx, { stop: PAYPAL_STOP_CODES.includes(e && e.code) ? e.code : null });
      return;
    }
    if (body === undefined || !ctxAlive(ctx)) return; // bấm lặp
    const outcome = body && typeof body === 'object' && typeof body.outcome === 'string' ? body.outcome : null;
    await refreshPaypalState(id, ctx, { outcome });
  }

  /** GET /payments/:id (chứng cứ) rồi hiển thị đúng giai đoạn. GET lỗi/không khớp -> "chưa xác nhận", không suy ra thành công/thất bại. */
  async function refreshPaypalState(id, ctx, { outcome, stop } = {}) {
    const intent = loadIntent();
    let raw;
    try { raw = await api('/payments/' + encodeURIComponent(id)); } catch (_) { raw = null; }
    if (!ctxAlive(ctx)) return;
    const row = raw ? readPaypalRow(raw, { id, requestId: intent ? intent.requestId : undefined, amount: intent ? intent.amount : undefined }) : null;
    if (!row) {
      if (stop) setTopupNotice({ kind: 'paypal-stop', code: stop });
      else setTopupNotice({ kind: 'unconfirmed', paymentId: id });
      return;
    }
    await loadTopupHistory().catch(() => {});
    if (!ctxAlive(ctx)) return;
    await settlePaypalRow(row, { ctx, fromGet: true, extra: outcome ? { outcome } : null });
  }

  /** "Kiểm tra trạng thái / Kiểm tra lại" cho dòng PayPal (đã lấy bằng GET /payments/:id hoặc từ danh sách). */
  async function finishPaypalCheck(raw, { intent, knownId, ctx }) {
    const row = readPaypalRow(raw, {
      id: knownId || undefined,
      requestId: intent ? intent.requestId : undefined,
      amount: intent ? intent.amount : undefined,
    });
    if (!row) {
      toast('Máy chủ trả về dữ liệu PayPal không đầy đủ hoặc không khớp. Hãy thử kiểm tra lại sau ít phút.', 'err');
      return;
    }
    await loadTopupHistory().catch(() => {});
    if (!ctxAlive(ctx)) return;
    await settlePaypalRow(row, { ctx, fromGet: true });
  }

  /** URL ?paypal=return|cancel&paymentRequestId=<id>: chỉ lấy loại và id, rồi dọn query. token/PayerID không phải chứng cứ. */
  function readPaypalCallbackFromUrl() {
    let kind;
    let id;
    try {
      const q = new URLSearchParams(window.location.search || '');
      kind = q.get('paypal');
      id = q.get('paymentRequestId');
      if (q.has('paypal') || q.has('paymentRequestId')) {
        // PayPal có thể nối &token/PayerID SAU fragment của URL cũ. Luôn quay về
        // trang ví sạch; dữ liệu query chỉ chọn yêu cầu để máy chủ kiểm tra.
        window.history.replaceState(null, '', window.location.pathname + '#/wallet');
      } else if (/^#\/wallet[?&]/.test(window.location.hash)) {
        // Khôi phục cả địa chỉ lỗi đã bị dọn query ở phiên bản cũ. Token/PayerID
        // không đủ để capture: giữ nguyên các bước xác minh ý định/phiên hiện có.
        window.history.replaceState(null, '', window.location.pathname + window.location.search + '#/wallet');
      }
    } catch (_) { return null; }
    if ((kind !== 'return' && kind !== 'cancel') || !/^[A-Za-z0-9-]{8,64}$/.test(id || '')) return null;
    return { kind, id };
  }

  /**
   * Xử lý lần quay lại từ PayPal (một lần). Return/cancel đều chỉ GET trạng thái để xác minh chủ sở hữu / id / số tiền / requestId /
   * provider; cancel không capture, không đánh FAILED, không tạo yêu cầu mới. Return tự hoàn tất (capture) chỉ
   * khi dữ liệu khớp ý định lưu trên thiết bị này.
   */
  async function processPaypalCallback() {
    const cb = state.paypalCallback;
    if (!cb || !state.user || !state.token) return;
    state.paypalCallback = null; // dùng một lần
    try { sessionStorage.removeItem('cat_paypal_departure'); } catch (_) {}
    const intent = loadIntent();
    const mine = intent && intent.provider === PAYPAL_PROVIDER ? intent : null;
    const ctx = topupCtx(mine ? mine.requestId : null);
    let raw;
    try {
      raw = await api('/payments/' + encodeURIComponent(cb.id));
    } catch (e) {
      if (e && e.stale) return;
      if (ctxAlive(ctx)) toast(e && e.message ? e.message : 'Không kiểm tra được yêu cầu nạp vừa quay lại từ PayPal.', 'err');
      return;
    }
    if (!ctxAlive(ctx)) return;
    const row = readPaypalRow(raw, { id: cb.id });
    if (!row) {
      toast('Máy chủ trả về dữ liệu không khớp với lần quay lại từ PayPal nên không xử lý. Hãy xem Lịch sử nạp tiền.', 'err');
      return;
    }
    await loadTopupHistory().catch(() => {});
    if (!ctxAlive(ctx)) return;
    const matched = paypalMatchesIntent(row, mine);
    // Query chỉ chọn yêu cầu; quyền, trạng thái phê duyệt và số tiền vẫn do server xác minh.
    // Cancel, ý định không khớp và kết quả đã kết thúc tuyệt đối không phát capture.
    if (cb.kind === 'return' && matched && row.status === 'PENDING' && row.stage === 'AWAITING_APPROVAL') {
      if (!mine.paymentId) saveIntent({ ...mine, paymentId: row.id });
      setTopupNotice({ kind: 'paypal', row: { ...row, stage: 'CAPTURING' } });
      await capturePaypal({ dataset: { id: row.id } }, ctx);
      return;
    }
    await settlePaypalRow(row, {
      ctx, fromGet: true, returned: cb.kind === 'return', cancelled: cb.kind === 'cancel', unverified: !matched,
    });
  }

  async function openCheckout(paymentRequestId, providerRef, ctx) {
    const owner = ctx || topupCtx(null); // mở từ lịch sử: chỉ ràng buộc phiên
    if (!ctxAlive(owner)) return;
    if (typeof paymentRequestId !== 'string' || !paymentRequestId || typeof providerRef !== 'string' || !providerRef) {
      return toast('Thiếu mã yêu cầu hoặc mã giao dịch tại cổng nên chưa mở cổng thanh toán.', 'err');
    }
    let page;
    try {
      page = await providerApi('/checkout/' + encodeURIComponent(providerRef));
    } catch (e) {
      if (!ctxAlive(owner)) return;
      return toast(e.code === 'NOT_FOUND' ? 'Cổng thanh toán mô phỏng đang tắt (MOCK_PROVIDER_CHECKOUT=0).' : e.message, 'err');
    }
    if (!ctxAlive(owner)) return; // đăng xuất / đổi tài khoản trong lúc chờ cổng trả lời: không mở modal cho phiên mới
    if (!page || typeof page.providerRef !== 'string' || !Number.isSafeInteger(page.amount) || typeof page.status !== 'string') {
      return toast('Cổng thanh toán trả về dữ liệu không hợp lệ nên chưa mở cổng. Hãy kiểm tra lại trạng thái.', 'err');
    }
    const settled = page.status !== 'PENDING';
    openModal({
      title: 'Cổng thanh toán (mô phỏng)',
      body: `
        <div class="note note-warning mb-4">
          ${ico('info', 18)}
          <span>Đây là trang của <b>cổng thanh toán</b>, không phải của sàn. Trong demo, bạn chọn kết quả thanh toán;
            cổng sẽ gửi webhook đã ký về máy chủ của sàn.</span>
        </div>
        <div class="price-row"><span>Phương thức</span><span>${ico('shield-check', 16)} Thanh toán mô phỏng</span></div>
        <div class="price-row"><span>Mã giao dịch tại cổng</span><span class="mono">${esc(shortId(page.providerRef))}</span></div>
        <div class="price-row total"><span>Số tiền thanh toán</span><span class="val">${money(page.amount)}</span></div>
        ${settled ? `<div class="note note-success mt-4">${ico('circle-check', 18)}<span>Cổng thanh toán
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
    const ctx = topupCtx(null);
    try {
      await guard('checkout:' + ref, el, async () => {
        try {
          return await providerApi(`/checkout/${encodeURIComponent(ref)}/pay`, { method: 'POST', body: { outcome, deliverWebhook } });
        } catch (e) {
          if (!ctxAlive(ctx) && !(e && e.code === 'UNAUTHENTICATED')) throw staleError();
          throw e;
        }
      });
    } catch (e) {
      if ((e && e.stale) || !ctxAlive(ctx)) return;
      // Mất kết nối giữa chừng: cổng có thể đã ghi nhận. Hỏi lại máy chủ — không coi là thất bại, không coi là thành công.
      if (e && e.unknownOutcome) {
        closeModal();
        await waitForTopupResult(id);
      }
      return;
    }
    if (!ctxAlive(ctx)) return;
    closeModal();
    await waitForTopupResult(id);
  }

  /** Hỏi máy chủ trạng thái yêu cầu nạp tiền sau khi thanh toán ở cổng. Có hạn, giãn dần; không tự đoán kết quả. */
  async function waitForTopupResult(paymentRequestId) {
    const ctx = topupCtx(null);
    toast('Đang xử lý — chờ cổng thanh toán xác nhận…');
    const result = await pollPayment(paymentRequestId, (r) => r.status !== 'PENDING', ctx);
    if (result.cancelled || !ctxAlive(ctx)) return; // đã rời trang ví / đăng xuất / đổi tài khoản: không báo gì thay họ
    const p = result.row;
    if (p && p.status === 'SUCCEEDED') {
      toast(`Nạp tiền thành công${RESOLVED_BY_LABEL[p.resolvedBy] ? ' ' + RESOLVED_BY_LABEL[p.resolvedBy] : ''}: ${money(p.amount)} đã vào ví.`, 'ok');
      await refreshWallet();
      if (!ctxAlive(ctx)) return;
      setTopupNotice(null);
    } else if (p && p.status === 'FAILED') {
      toast('Cổng thanh toán báo thất bại. Ví của bạn không thay đổi.', 'err');
      setTopupNotice(null);
    } else {
      toast(!p
        ? 'Chưa kiểm tra được trạng thái do lỗi kết nối. Hãy mở lại Lịch sử nạp tiền sau ít phút; số dư chỉ thay đổi khi có xác nhận.'
        : 'Chưa có xác nhận từ cổng thanh toán. Hệ thống sẽ tự đối soát; số dư chỉ thay đổi khi có kết quả.');
      state.topupNotice = { kind: 'poll-timeout', paymentId: paymentRequestId };
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
        <div class="note note-success mb-5">
          ${ico('circle-check', 18)}<span>Không có việc nào đang chờ bạn.</span>
        </div>`;
      return;
    }
    box.innerHTML = `
      <div class="card mb-5">
        <div class="card-head"><h2>Việc cần xử lý</h2><span class="badge-count">${items.length}</span></div>
        <div class="card-body stack gap-3">
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
      box.innerHTML = '<p class="muted m-0">Chưa có thông báo nào.</p>';
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

    const epoch = state.sessionEpoch;
    const hash = location.hash;
    const generation = ++transactionRenderGen;

    const [t, { logs }] = await Promise.all([
      api('/transactions/' + encodeURIComponent(id)),
      api(`/transactions/${encodeURIComponent(id)}/logs`),
    ]);
    if (epoch !== state.sessionEpoch || hash !== location.hash || generation !== transactionRenderGen) return;
    rememberShipping(t);
    const me = state.user;
    const role = t.buyerId === me.id ? 'BUYER' : t.sellerId === me.id ? 'SELLER' : me.role === 'ADMIN' ? 'ADMIN' : null;
    const isBuyer = role === 'BUYER';

    view().innerHTML = `
      <div class="page" id="txPage" data-id="${esc(t.id)}" data-shipping-key="${esc(shippingKey(t))}">
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
            <div class="mt-6px">${statusTag(t)}</div>
          </div>
        </div>

        <div class="tx-grid">
          <div class="stack">
            ${window.EnclaveShippingMotion ? window.EnclaveShippingMotion.render(t) : ''}
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
              <div class="card-body stack gap-3">
                <div class="small layout-grid gap-8px">
                  <div class="row flex-nowrap items-start">${ico('fingerprint', 16)}<span>Giải ngân và phân xử luôn đòi <b>xác thực lại bằng Passkey</b>, kể cả khi đang đăng nhập.</span></div>
                  <div class="row flex-nowrap items-start">${ico('key-round', 16)}<span>Phiếu uỷ quyền dùng một lần, ràng buộc đúng giao dịch này, đúng số tiền, đúng người nhận.</span></div>
                  <div class="row flex-nowrap items-start">${ico('link-2', 16)}<span>Mọi bước được ghi vào chuỗi băm riêng của giao dịch; sửa lén một bản ghi sẽ bị phát hiện.</span></div>
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
        ${b.text ? `<div class="small mt-2px">${esc(b.text)}</div>` : ''}
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
      ? `<div class="note note-warning mt-3">${ico('triangle-alert', 18)}
          <span>Chỉ giải ngân khi đã kiểm hàng. Sau bước này tiền thuộc về người bán và không rút lại được.</span></div>`
      : '';
    return `
      <div class="action-box ${acts ? '' : 'idle'}">
        <h3>Hành động hiện tại</h3>
        <p class="small m-0 text-2">${esc(text)}</p>
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
          <p class="small muted m-0-0-6">Mở bởi <b>${d.openedBy === 'BUYER' ? 'người mua' : 'người bán'}</b> lúc ${fmtDateTime(d.createdAt)}</p>
          <p class="m-0-0-6">“${esc(d.reason)}”</p>
          ${resolved ? `<p class="small m-0">Quyết định: <b>${d.adminDecision === 'REFUND'
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
      <div class="note mb-5">
        ${ico(result.ok ? 'shield-check' : 'frown', 18)}
        <span>${result.ok
          ? `Cả <b>${result.checked}</b> bất biến đều đúng trên dữ liệu hiện tại.`
          : `Có <b>${result.violations.length}</b> vi phạm. Đây là dấu hiệu dữ liệu hoặc logic đã sai, không phải lỗi hiển thị.`}</span>
      </div>
      <div class="stack gap-4">
        ${result.checks.map((c) => {
          const bad = broken.get(c.code);
          return `
            <div class="card"><div class="card-body">
              <div class="row-between items-start">
                <div class="grow">
                  <h3 class="m-0-0-4">${c.no}. ${esc(c.name)}</h3>
                  <p class="muted small m-0">${esc(c.statement)}</p>
                  ${bad ? `<ul class="muted small mt-8px">${bad.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>` : ''}
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

    list.innerHTML = `<div class="stack gap-5">${requests.map((r) => {
      const st = SELLER_REQUEST_UI[r.status] || { label: r.status, tone: '' };
      const open = r.status === 'PENDING';
      return `
        <div class="card"><div class="card-body">
          <div class="row-between items-start">
            <div class="grow">
              <h3>${esc(r.shopName)}</h3>
              <div class="muted small">
                Người gửi <b>${esc(r.userName || '—')}</b> (${accountLabel(r.userUsername)})
                · Gửi lúc ${fmtDateTime(r.createdAt)}
              </div>
            </div>
            <span class="tag ${st.tone}">${esc(st.label)}</span>
          </div>

          ${r.pitch
            ? `<p class="small m-s4-0 pre-wrap">“${esc(r.pitch)}”</p>`
            : `<p class="small muted m-s4-0">Người gửi không viết mô tả.</p>`}

          ${!open && r.reviewNote
            ? `<div class="note ${r.status === 'REJECTED' ? 'note-danger' : 'note-success'} mb-4">
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

  // Tranh chấp của lần tải gần nhất, để bước xem lại đọc đúng dữ liệu máy chủ đã trả thay vì
  // tin vào chữ trên nút.
  const disputeCache = new Map();

  async function loadDisputes() {
    const { disputes } = await api('/admin/disputes');
    const list = $('#adminPanel');
    if (!list) return;
    disputeCache.clear();
    disputes.forEach((d) => disputeCache.set(d.id, d));

    if (disputes.length === 0) {
      list.innerHTML = empty('shield-check', 'Không có tranh chấp nào', 'Mọi đơn hàng đang diễn ra suôn sẻ.');
      return;
    }

    list.innerHTML = `<div class="stack gap-5">${disputes.map((d) => {
      const t = d.transaction || {};
      const open = d.status === 'OPEN';
      return `
        <div class="card"><div class="card-body">
          <div class="row-between items-start">
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

          <p class="small m-0-0-4">
            <b>${d.openedBy === 'BUYER' ? 'Người mua' : 'Người bán'} ${esc(d.createdByName || '')} khiếu nại:</b>
          </p>
          <p class="small m-0-0-s4 pre-wrap">“${esc(d.reason)}”</p>

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
  /**
   * Bước xem lại TRƯỚC khi xác thực Passkey: nói rõ hành động, người nhận tiền và số tiền để
   * quản trị viên không bấm nhầm hai nút liền kề. Xác nhận ở đây chỉ mở đường tới bước
   * Passkey; phiếu uỷ quyền và quyền của máy chủ không đổi.
   */
  function openDisputeConfirm(kind, disputeId) {
    const d = disputeCache.get(disputeId);
    if (!d) return toast('Không tìm thấy tranh chấp — hãy tải lại trang.', 'err');
    const t = d.transaction || {};
    const refund = kind === 'refund';
    const recipient = refund ? 'Người mua' : 'Người bán';
    const recipientName = refund ? t.buyerName : t.sellerName;
    openModal({
      title: refund ? 'Xem lại: hoàn tiền cho người mua' : 'Xem lại: giải ngân cho người bán',
      body: `
        <div class="stack">
          <div class="note note-warning">
            ${ico('triangle-alert', 18)}
            <span>Quyết định này <b>không thể hoàn tác</b>: tiền rời ví ký quỹ và được ghi vĩnh viễn vào nhật ký của đơn.</span>
          </div>
          <div class="price-row"><span>Đơn hàng</span><span>${esc(t.itemName || 'Đơn hàng')}</span></div>
          <div class="price-row"><span>Hành động</span><span><b>${refund ? 'Hoàn toàn bộ tiền' : 'Chuyển toàn bộ tiền'}</b></span></div>
          <div class="price-row"><span>${recipient} nhận tiền</span><span><b>${esc(recipientName || '—')}</b></span></div>
          <div class="price-row total"><span>Số tiền</span><span class="val">${money(t.amount || 0)}</span></div>
          <p class="small muted m-0">Sau khi bấm xác nhận, bạn sẽ được yêu cầu xác thực lại bằng Passkey.</p>
        </div>`,
      footer: `
        <button class="btn" data-act="modal-close">Huỷ</button>
        <button class="btn btn-primary" data-act="admin-confirm" data-kind="${refund ? 'refund' : 'release'}"
          data-id="${esc(disputeId)}">${ico('shield-check', 17)} ${refund ? 'Xác nhận hoàn tiền' : 'Xác nhận giải ngân'} và dùng Passkey</button>`,
    });
  }

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
    closeModal();
    route();
  }

  // ---------- Quản trị: người dùng ----------

  async function loadAdminUsers() {
    const { users } = await api('/admin/users');
    const list = $('#adminPanel');
    if (!list) return;

    const counts = users.reduce((acc, u) => ({ ...acc, [u.role]: (acc[u.role] || 0) + 1 }), {});
    list.innerHTML = `
      <div class="stat-grid mb-6">
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
              <td class="mono">${accountLabel(u.username)}</td>
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
      <div class="row mb-5">
        <label class="muted small" for="secEventType">Lọc theo loại</label>
        <select id="secEventType" class="w-auto">
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
                  <td>${e.username ? accountLabel(e.username) : '<span class="muted">—</span>'}</td>
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
    SELLER_PACKED: 'Người bán đã đóng gói',
    SIMULATED_CARRIER_PICKED_UP: 'Enclave Delivery đã lấy hàng (mô phỏng)',
    SIMULATED_CARRIER_ARRIVED: 'Đơn hàng đã đến điểm giao (mô phỏng)',
    SIMULATED_SHIPMENT_STOPPED: 'Tạm dừng vận chuyển mô phỏng',
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
          <p class="muted tiny mt-10px">Mã giao dịch nằm ở trang chi tiết giao dịch (nút "Xem mã băm").</p>
        </div></div>

        <div id="auditResult"></div>
      </div>`;

    if (txId) await loadAudit(txId);
  }

  async function loadAudit(txId) {
    const box = $('#auditResult');
    if (!box) return;
    if (!txId) return toast('Nhập mã đơn hàng', 'err');
    box.innerHTML = '<div class="skeleton h-160"></div>';
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
    'del-device': (el) => openModal({title:'Xóa Passkey?',body:`<p>Xóa Passkey <b>${esc(el.dataset.name||'đã chọn')}</b>? Passkey này sẽ không đăng nhập được nữa và các phiên khác sẽ bị đăng xuất.</p>`,footer:`<button class="btn" data-act="modal-close">Hủy</button><button class="btn btn-danger" data-act="del-device-confirm" data-id="${esc(el.dataset.id)}">Xóa bằng Passkey</button>`}),
    'del-device-confirm':(el)=>deleteDevice(el.dataset.id,el),
    'logout': () => logout(),
    'modal-close': () => dismissModal(),
    'reload': () => route(),
    'open-sell': () => openSell(),
    'passkey-check': (el) => refreshPasskeyReadiness(el.dataset.target),
    'go-home': () => resetAndGoHome(),
    'filter-cat': (el) => { state.filters.category = el.dataset.cat || ''; goHome(); },
    'clear-filters': () => resetAndGoHome(),
    'load-more': () => { state.homeLimit += HOME_PAGE_SIZE; renderListingPage(); },
    'scroll-products': () => { const el = $('#products'); if (el) el.scrollIntoView({ behavior: 'smooth' }); },

    'do-order': (el) => doOrder(el.dataset.id, el),

    'filter-order': (el) => { state.orderFilter = el.dataset.f; route(); },
    'order-tab': (el) => { state.orderTab = el.dataset.tab; route(); },
    'acknowledge': (el) => acknowledgeOrder(el.dataset.id, el),
    'secure': (el) => secureOrder(el.dataset.id, el, el.dataset.then),
    'secure-confirm':(el)=>confirmSecureOrder(el),
    'pack': (el) => confirmPackedOrder(el.dataset.id),
    'pack-confirm': (el) => packOrder(el.dataset.id, el),
    'shipping-open': (el) => openShipping(el.dataset.id, el),
    'shipping-order': (el) => { closeModal(); location.hash = '#/tx/' + encodeURIComponent(el.dataset.id); },
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

    'admin-refund': (el) => openDisputeConfirm('refund', el.dataset.id),
    'admin-release': (el) => openDisputeConfirm('release', el.dataset.id),
    'admin-confirm': (el) => adminResolve(el.dataset.kind, el.dataset.id, el),

    'audit-load': () => loadAudit($('#auditTxId').value.trim()),
    'audit-verify': (el) => verifyAudit(el),

    'topup-preset': (el) => { const input = $('#topupAmount'); if (input && !input.disabled) input.value = el.dataset.v; },
    'topup-create': (el) => createTopup(el),
    'topup-retry': (el) => createTopup(el),
    'topup-check': (el) => checkTopupStatus(el),
    'topup-new': () => askNewTopup(),
    'topup-new-confirm': () => confirmNewTopup(),
    'topup-dismiss': () => { state.topupNotice = null; renderTopupIntent(); },
    'paypal-approve': (el) => openPaypalApproval(el),
    'paypal-capture': (el) => capturePaypal(el),
    'paypal-abandon': (el) => openPaypalAbandon(el),
    'paypal-abandon-confirm': (el) => confirmPaypalAbandon(el),
    'paypal-config-retry': () => route(),
    'checkout-open': (el) => openCheckout(el.dataset.id, el.dataset.ref),
    'checkout-pay': (el) => payCheckout(el),
    'notif-open': (el) => openNotification(el),
    'notif-read-all': (el) => readAllNotifications(el),
    'tx-verify-chain': (el) => verifyTxChain(el),
    'toggle-password':(el)=>{const input=$('#'+el.dataset.target);input.type=input.type==='password'?'text':'password';el.textContent=input.type==='password'?'Hiện mật khẩu':'Ẩn mật khẩu';},
    'auth-terms':()=>openModal({title:'Điều khoản và quyền riêng tư của bản demo',body:'<p>Enclave là hệ thống mô phỏng phục vụ đồ án. Số dư trong ví không phải tiền gửi ngân hàng và không có chức năng rút tiền thật.</p><p>Email dùng để xác minh, thông báo bảo mật và khôi phục. Khóa công khai Passkey được lưu trên máy chủ; khóa riêng và dữ liệu sinh trắc học được xử lý bởi thiết bị hoặc nhà cung cấp Passkey. Không chia sẻ mật khẩu và mã khôi phục.</p>',footer:'<button class="btn" data-act="open-auth-register">Quay lại đăng ký</button>'}),
    'copy-site-link':async()=>{try{await navigator.clipboard.writeText(location.origin+location.pathname);toast('Đã sao chép. Mở liên kết trong Chrome, Edge hoặc Safari.','ok');}catch{toast('Hãy mở https://enclave.id.vn trong Chrome, Edge hoặc Safari.','info');}},
    'email-verify':verifyEmailUi,
    'email-resend':(el)=>requestEmailCode(el,false),
    'legacy-email':async(el)=>{const email=$('#legacyEmail').value;await guard('legacy-email',el,async()=>{const result=await api('/passkeys/email/enroll/request',{method:'POST',body:{email}});state.user.email=email;state.user.emailVerified=false;state.user.accountStatus='BASIC';openEmailVerification({...state.user,...result});});},
    'device-name-save':async(el)=>{const name=$('#deviceNameInput').value.trim(),callback=authUi.nameCallback;if(!name)return toast('Hãy đặt tên Passkey.','err');await guard('device-name',el,()=>callback(name));},
    'restart-setup':()=>{authUi.nameCallback=null;openSetupModal(state.user);},
    'resume-setup':()=>state.user?.authMethod==='recovery'?openRecoveryPasskey(authUi.recoveryEmail):beginActivation('Kích hoạt ví để bắt đầu mua bán.',()=>route()),
    'activate-wallet':()=>beginActivation('Bạn đang kích hoạt ví để nạp tiền.',()=>route()),
    'activation-later':()=>{authUi.activation=null;authUi.codes=null;closeModal();},
    'activation-email-change':()=>openLegacyEmailSetup(),
    'email-verify-open':()=>{authUi.activation=null;openEmailVerification(state.user);},
    'recovery-codes-later':(el)=>{
      // Bấm lần đầu chỉ cảnh báo; không đánh dấu đã lưu. Bấm "Vẫn để sau" mới rời đi (và vẫn tiếp tục kích hoạt nếu đang dở).
      const body=$('#modalRoot .modal-body');if(!body)return finishActivation();
      body.querySelector('.recovery-defer-warning')?.remove();
      body.insertAdjacentHTML('beforeend','<div class="note note-warning mt-3 recovery-defer-warning" role="alert">Các mã này sẽ không được hiển thị lại và chưa được ghi nhận là đã lưu. Nếu để sau, bạn cần vào Bảo mật để tạo bộ mã mới (bộ mã hiện tại sẽ bị thu hồi).</div>');
      el.dataset.act='recovery-codes-later-confirm';el.textContent='Vẫn để sau';
    },
    'recovery-codes-later-confirm':()=>finishActivation(),
    'email-link-open':()=>openEmailLinkModal(),
    'email-link-dismiss':()=>{authUi.emailLink=null;closeModal();},
    'email-link-login':()=>openAuthModal('login'),
    'email-link-switch':()=>{logout();openEmailLinkModal();},
    'email-link-confirm':async(el)=>{
      const link=authUi.emailLink,userId=state.user?.id;if(!link||!userId)return;
      await guard('email-link-confirm',el,async()=>{
        const result=await api('/passkeys/email/link/confirm',{method:'POST',body:{token:link.token}});
        if(!result.verified||!result.user||result.user.id!==userId||result.user.sessionId!==state.user?.sessionId||result.user.authMethod!==state.user?.authMethod)throw new Error('Chưa xác nhận được kết quả xác minh email. Hãy kiểm tra lại trước khi tiếp tục.');
        if(authUi.emailLink===link)authUi.emailLink=null;
        // Không có token/phiên mới: chỉ gộp user vào phiên hiện tại.
        if(result.user&&state.user?.id===userId&&(!result.user.id||result.user.id===userId))state.user={...state.user,...result.user};
        renderChrome();
        if(authUi.activation?.userId===userId)openSetupModal(state.user);
        else openModal({title:'Đã xác minh email',body:`<p>${esc(result.message||'Email đã được xác minh.')}</p>`,footer:'<button class="btn" data-act="modal-close">Đã hiểu</button>'});
      });
    },
    'rename-device':(el)=>openDeviceNameModal(async(name)=>{await api('/passkeys/credentials/'+encodeURIComponent(el.dataset.id),{method:'PATCH',body:{deviceName:name}});closeModal();await loadCredentials();}),
    'upgrade-session':(el)=>upgradeAuthUi(el),
    'upgrade-and-secure':(el)=>upgradeAuthUi(el,()=>secureOrder(el.dataset.id,null,el.dataset.then)),
    'forgot-password':()=>openEmailRecoveryRequest('password'),
    'lost-passkey':openRecoveryChoice,
    'recovery-code-open':openRecoveryCode,
    'recovery-email-open':()=>openEmailRecoveryRequest('recovery'),
    'recovery-email-request':async(el)=>{
      const email=$('#recoveryEmail').value.trim(),kind=authUi.action,generation=modalGeneration;
      if(!$('#recoveryEmail').reportValidity())return;
      await guard('recovery-email',el,async()=>{
        const result=await api(kind==='password'?'/passkeys/password-reset/request':'/passkeys/recovery/email/request',{method:'POST',body:{email}});
        if(generation!==modalGeneration)return;
        if(kind!=='password'&&result.requestToken)return openRecoveryEmailCode(result,email);
        openModal({title:'Kiểm tra hộp thư',body:`<p>${esc(result.message)}</p>`,footer:'<button class="btn" data-act="modal-close">Đã hiểu</button>'});
      });
    },
    'recovery-email-resend':async(el)=>{
      const context=authUi.recoveryOtp,generation=modalGeneration;if(!context||Date.now()<context.nextAt)return;
      try{await guard('recovery-email-resend',el,async()=>{
          const result=await api('/passkeys/recovery/email/request',{method:'POST',body:{email:context.email}});
          if(generation===modalGeneration&&authUi.recoveryOtp===context)openRecoveryEmailCode(result,context.email);
        });
      }catch(e){if(!e?.silent&&authUi.recoveryOtp===context&&e.retryAfter)context.nextAt=Date.now()+e.retryAfter*1000;}
    },
    'recovery-email-code-verify':async(el)=>{
      const context=authUi.recoveryOtp,generation=modalGeneration,input=$('#recoveryEmailCode');
      if(!context||!input?.reportValidity())return;
      await guard('recovery-email-code',el,async()=>{
        const result=await api('/passkeys/recovery/email/verify',{method:'POST',body:{requestToken:context.requestToken,code:input.value}});
        if(generation!==modalGeneration||authUi.recoveryOtp!==context)return;
        authUi.recoveryOtp=null;
        if(state.user){try{const me=await api('/users/me');state.user=me.user;renderChrome();}catch{/* The server already confirmed recovery; a display refresh must not hide that result. */}}
        openModal({title:'Đã xác nhận yêu cầu khôi phục',body:`<p>${esc(result.message)}</p><p>Có thể tiếp tục từ <b>${fmtDateTime(result.availableAt)}</b>. Hãy kiểm tra email khi đến thời điểm này.</p>`,footer:'<button class="btn btn-primary" data-act="modal-close">Đã hiểu</button>'});
      });
    },
    'recovery-code-verify':async(el)=>{const password=$('#recoveryCurrentPassword').value,code=$('#recoveryCode').value;await guard('recovery-code',el,async()=>{const result=await api('/passkeys/recovery/code',{method:'POST',body:{password,code}});await afterSession(result);});},
    'recovery-passkey-create':async(el)=>{const deviceName=$('#recoveryDeviceName').value,newPassword=$('#recoveryNewPassword')?.value;await guard('recovery-create',el,async()=>{const {registrationSessionId,options}=await api('/passkeys/recovery/passkey/options',{method:'POST',body:{}});const response=await webauthn('enroll',()=>SimpleWebAuthnBrowser.startRegistration({optionsJSON:options}));const result=await api('/passkeys/recovery/passkey/verify',{method:'POST',body:{registrationSessionId,response,newPassword,deviceName}});await afterSession(result,'Đã khôi phục tài khoản.');});},
    'recovery-link-confirm':async(el)=>{const kind=authUi.action,token=authUi.linkToken;await guard('recovery-link',el,async()=>{const path=kind==='recovery-start'?'/recovery/email/start':kind==='recovery-cancel'?'/recovery/cancel':'/recovery/email/authorize';const result=await api('/passkeys'+path,{method:'POST',body:{token}});authUi.linkToken=null;if(kind==='recovery-finish'){await afterSession(result);return;}openModal({title:kind==='recovery-cancel'?'Đã hủy yêu cầu':'Đang chờ khôi phục',body:`<p>${esc(result.message)}</p>${result.availableAt?`<p>Có thể tiếp tục sau ${fmtDateTime(result.availableAt)}. Chúng tôi sẽ gửi email khi đến lúc.</p>`:''}`,footer:'<button class="btn" data-act="modal-close">Đã hiểu</button>'});});},
    'reset-password-complete':async(el)=>{const newPassword=$('#resetNewPassword').value,token=authUi.linkToken;await guard('reset-password',el,async()=>{await api('/passkeys/password-reset/complete',{method:'POST',body:{token,newPassword}});authUi.linkToken=null;clearSession();openAuthModal('login');toast('Đã đặt lại mật khẩu. Hãy đăng nhập lại.','ok');});},
    'recovery-regenerate':async(el)=>{await guard('regenerate-codes',el,async()=>{const reauthGrant=await getAccountGrant('REGENERATE_RECOVERY');const result=await api('/passkeys/recovery-codes/regenerate',{method:'POST',body:{reauthGrant}});showRecoveryCodes(result.recoveryCodes);});},
    'recovery-codes-copy':async()=>{try{await navigator.clipboard.writeText(authUi.codes.join('\n'));codesSaved();toast('Đã sao chép mã khôi phục.','ok');}catch{toast('Không thể sao chép. Hãy dùng nút Tải xuống.','err');}},
    'recovery-codes-download':()=>{const blob=new Blob(['Mã khôi phục Enclave — giữ riêng tư, mỗi mã dùng một lần.\n'+authUi.codes.join('\n')],{type:'text/plain;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='enclave-ma-khoi-phuc.txt';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);codesSaved();},
    'recovery-codes-done':async(el)=>{if(!authUi.codesSaved||!$('#recoveryCodesAcknowledged').checked)return;await guard('ack-codes',el,async()=>{await api('/passkeys/recovery-codes/acknowledge',{method:'POST',body:{}});authUi.codes=null;state.user.recoveryAcknowledged=true;await finishActivation();if(currentHead()==='security')await loadSecurityDetails();});},
    'sessions-revoke-others':async(el)=>{await guard('sessions-revoke',el,()=>api('/passkeys/sessions/revoke-others',{method:'POST',body:{}}),'Đã đăng xuất các phiên khác.');await loadSecurityDetails();},
    'session-revoke':async(el)=>{await guard('session-revoke:'+el.dataset.id,el,()=>api('/passkeys/sessions/'+encodeURIComponent(el.dataset.id),{method:'DELETE'}));await loadSecurityDetails();},
    'change-email-open':()=>openModal({title:'Đổi email đã xác minh',body:authField('newEmail','Email mới','email')+'<p>Cần xác nhận bằng Passkey và mã gửi tới email cũ (nếu đã xác minh) cùng email mới.</p>',footer:'<button class="btn" data-act="modal-close">Hủy</button><button class="btn btn-primary" data-act="change-email-request">Xác nhận bằng Passkey</button>'}),
    'change-email-request':async(el)=>{const newEmail=$('#newEmail').value;await guard('email-change',el,async()=>{const reauthGrant=await getAccountGrant('CHANGE_EMAIL',{newEmail});const result=await api('/passkeys/email/change/request',{method:'POST',body:{newEmail,reauthGrant}});authUi.emailChange=result.changeId;openModal({title:'Xác minh đổi email',body:(result.oldEmailRequired?authField('oldEmailCode','Mã gửi tới email cũ'):'')+authField('newEmailCode','Mã gửi tới email mới'),footer:'<button class="btn" data-act="modal-close">Hủy</button><button class="btn btn-primary" data-act="change-email-verify">Lưu email mới</button>'});});},
    'change-email-verify':async(el)=>{const oldCode=$('#oldEmailCode')?.value,newCode=$('#newEmailCode').value;await guard('email-change-verify',el,async()=>{await api('/passkeys/email/change/verify',{method:'POST',body:{changeId:authUi.emailChange,oldCode,newCode}});const me=await api('/users/me');state.user=me.user;closeModal();renderChrome();await loadSecurityDetails();toast('Đã đổi email và thu hồi các phiên khác.','ok');});},
  };

  function onDocumentClick(e) {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    if(el.disabled)return;
    const act = el.dataset.act;

    if (act === 'modal-backdrop') {
      if (e.target === el) dismissModal();
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
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') dismissModal(); });
    window.addEventListener('hashchange', route);
    // Liên kết email mở khi ứng dụng đang chạy: đọc và gỡ token khỏi URL ngay, như lúc khởi động.
    window.addEventListener('hashchange', () => { handleAccountAction().catch(() => {}); });
    window.addEventListener('storage',(event)=>{
      if(event.key===SIGNED_OUT&&event.newValue==='1'){clearSession();renderChrome();route();}
    });
    window.addEventListener('pageshow', (event) => {
      if (event.persisted && currentHead() === 'wallet' && !state.paypalCallback) {
        Promise.resolve(resumePaypalAfterBack()).catch(() => {});
      }
    });
    const topSearch = $('#topSearch');
    if (topSearch) topSearch.addEventListener('submit', (e) => {
      e.preventDefault();
      state.filters.q = ($('#topSearchInput').value || '').trim();
      goHome();
    });

    // Có thể vừa được PayPal đưa quay lại (?paypal=return|cancel): đọc và dọn query TRƯỚC khi làm gì khác.
    state.paypalCallback = readPaypalCallbackFromUrl();

    // Restore only from the rotating HttpOnly cookie; clear legacy access-token storage.
    localStorage.removeItem(STORAGE_TOKEN);localStorage.removeItem(STORAGE_USER);
    view().innerHTML='<div class="page"><div class="card p-5" role="status">Đang khôi phục phiên đăng nhập…</div></div>';
    await refreshSession();
    if (state.token && !state.token.startsWith('vrf_')) {
      const epoch = state.sessionEpoch;
      try {
        const me = await api('/users/me');
        if (state.sessionEpoch === epoch) {
          state.user = me.user;
          state.wallet = me.wallet;
        }
      } catch (e) {
        // Phản hồi khởi động cũ không được xoá phiên vừa đăng ký/đăng nhập.
        // Mất mạng cũng không phải bằng chứng phiên đã bị thu hồi.
        if (state.sessionEpoch === epoch && (e.status === 401 || e.status === 403)) clearSession();
      }
    }

    await refreshSellerRequest();
    renderChrome();
    await route();
    startShippingWatch();
    if(state.user?.authMethod==='recovery')openRecoveryPasskey(authUi.recoveryEmail);
    else if (state.token && state.user && state.user.accountStatus && !['BASIC','VERIFIED','ACTIVE','RECOVERING'].includes(state.user.accountStatus)) {
      openSetupModal(state.user);
    }
    await handleAccountAction();

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
      if (document.visibilityState === 'visible' && state.token) {
        refreshSession();
        wakeShippingWatch();
      }
    });
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', App.init);
