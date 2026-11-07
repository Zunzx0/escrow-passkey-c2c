'use strict';
(() => {
  const WEB = 'https://enclave.id.vn', API = 'https://api.enclave.id.vn';
  const $ = id => document.getElementById(id);
  let token = null, selected = null, packet = null, expires = 0, timer = null, busy = false, epoch = 0;
  const say = (text, error = false) => { $('status').textContent = text; $('status').className = error ? 'error' : ''; };
  const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
  function orderId(value) {
    const url = new URL(value);
    const id = url.hash.replace(/^#\/tx\//, '');
    if (url.origin !== WEB || url.pathname !== '/' || url.search || !uuid.test(id)) throw new Error('Dán đúng đường dẫn đơn trên enclave.id.vn.');
    return id;
  }
  function clear() {
    packet = null; expires = 0;
    clearInterval(timer); timer = null;
    $('ready').hidden = true;
  }
  function controls() {
    for (const id of ['check', 'order-a', 'order-b', 'consent']) $(id).disabled = busy;
    $('prepare').disabled = busy || !selected || !$('consent').checked || Boolean(packet);
    $('copy').disabled = busy || !packet || Date.now() >= expires;
  }
  async function request(route, body) {
    const response = await fetch(API + '/api' + route, {
      method: body === undefined ? 'GET' : 'POST', credentials: 'include', cache: 'no-store',
      headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
    let data;
    try { data = await response.json(); }
    catch { throw new Error('Máy chủ trả dữ liệu chưa đọc được. Hãy kiểm tra lại kết nối.'); }
    if (!response.ok) {
      if (response.status === 401 && ['SESSION_EXPIRED', 'UNAUTHENTICATED'].includes(data.error)) throw new Error('Phiên đã kết thúc. Quay lại Enclave đăng nhập rồi mở trang này.');
      if (data.error === 'SESSION_REFRESH_ROTATED') throw new Error('Phiên vừa được làm mới ở tab khác. Bấm kiểm tra lại.');
      throw new Error('Máy chủ chưa chấp nhận bước này. Kiểm tra lại trạng thái đơn hoặc thử lại sau.');
    }
    return data;
  }
  function ready(order, userId) {
    return order.buyerId === userId && order.status === 'WAIT_CONFIRM' && order.escrowStatus === 'LOCKED' &&
      order.inspectedAt && !order.integrityHold && order.canBuyerRelease === true;
  }
  async function guard(fn) {
    if (busy) return;
    busy = true; controls();
    try { await fn(); }
    catch (error) { say(error.name === 'NotAllowedError' || error.code === 'ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY' ? 'Xác nhận Passkey chưa hoàn tất. Chưa chuẩn bị được phiếu.' : error.message, true); }
    finally { busy = false; controls(); }
  }
  $('orders').addEventListener('submit', event => {
    event.preventDefault();
    guard(async () => {
      clear(); token = null; selected = null; $('details').hidden = true; $('consent').checked = false;
      const aId = orderId($('order-a').value.trim()), bId = orderId($('order-b').value.trim());
      if (aId === bId) throw new Error('Chọn hai đơn A và B khác nhau.');
      if (localStorage.getItem('cat_signed_out') === '1') throw new Error('Bạn đã đăng xuất. Quay lại Enclave đăng nhập trước.');
      say('Đang kiểm tra phiên và hai đơn...');
      const refresh = () => request('/passkeys/session/refresh', {});
      const session = navigator.locks?.request ? await navigator.locks.request('enclave-auth-cookie', refresh) : await refresh();
      if (typeof session.token !== 'string' || !session.user?.id) throw new Error('Chưa xác nhận được phiên đăng nhập.');
      token = session.token;
      const [me, a, b] = await Promise.all([request('/users/me'), request('/transactions/' + aId), request('/transactions/' + bId)]);
      if (me.user?.id !== session.user.id || !ready(a, me.user.id) || !ready(b, me.user.id)) throw new Error('Cả hai đơn phải thuộc người mua đang đăng nhập, đã kiểm hàng và đang chờ chuyển tiền.');
      selected = { a, b, userId: me.user.id };
      $('account').textContent = 'Người mua: ' + (me.user.displayName || me.user.username);
      for (const [key, order] of [['a', a], ['b', b]]) $('summary-' + key).textContent =
        (order.itemName || order.listingTitle) + ' · ' + Number(order.amount).toLocaleString('vi-VN') + 'đ · Người bán: ' + order.sellerName;
      $('details').hidden = false;
      say('Hai đơn đủ điều kiện. Đọc thông tin và xác nhận Passkey cho đơn A.');
    });
  });
  $('consent').addEventListener('change', controls);
  for (const id of ['order-a', 'order-b']) $(id).addEventListener('input', () => {
    clear(); token = null; selected = null; $('details').hidden = true; controls();
  });
  $('prepare').addEventListener('click', () => guard(async () => {
    if (!selected || !$('consent').checked) return;
    const generation = epoch;
    if (typeof window.SimpleWebAuthnBrowser?.startAuthentication !== 'function') throw new Error('Chưa tải được chức năng Passkey. Hãy tải lại trang.');
    const options = await request('/transactions/' + selected.a.id + '/reauth/options', { action: 'RELEASE_ESCROW' });
    const context = options.context;
    if (options.options?.userVerification !== 'required' || context?.transactionId !== selected.a.id ||
        context.action !== 'RELEASE_ESCROW' || context.buyerId !== selected.userId ||
        context.sellerId !== selected.a.sellerId || Number(context.amount) !== Number(selected.a.amount)) throw new Error('Nội dung xác nhận đã thay đổi. Kiểm tra lại hai đơn.');
    const response = await SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: options.options });
    if (generation !== epoch) return;
    const body = { reauthSessionId: options.reauthSessionId, response };
    const verified = await request('/transactions/' + selected.a.id + '/reauth/verify', body);
    if (generation !== epoch) return;
    if (typeof verified.reauthGrant !== 'string' || JSON.stringify(verified.signedContext) !== JSON.stringify(context)) throw new Error('Máy chủ chưa xác nhận đúng nội dung. Hãy kiểm tra lại.');
    expires = Date.parse(verified.expiresAt);
    if (!Number.isFinite(expires) || expires <= Date.now()) throw new Error('Phiếu đã hết hạn. Hãy xác nhận lại.');
    const payload = { version: 'ENCLAVE-S2-1', apiOrigin: API, webOrigin: WEB, accessToken: token,
      orderA: selected.a.id, orderB: selected.b.id, releaseGrant: verified.reauthGrant,
      expiresAt: verified.expiresAt, assertionReplay: body };
    packet = 'ENCLAVE-S2:' + btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(payload))));
    $('ready').hidden = false;
    const tick = () => {
      const seconds = Math.max(0, Math.floor((expires - Date.now()) / 1000));
      $('expiry').textContent = 'Thời gian còn lại: ' + seconds + ' giây';
      if (!seconds) { clear(); say('Phiếu đã hết hạn. Xác nhận Passkey lại để chuẩn bị phiếu mới.'); }
      controls();
    };
    timer = setInterval(tick, 1000); tick();
    say('Passkey đã xác nhận. Sao chép gói sang script; tiền vẫn đang được Enclave giữ.');
  }));
  $('copy').addEventListener('click', () => guard(async () => {
    if (!packet || Date.now() >= expires) throw new Error('Phiếu đã hết hạn. Hãy xác nhận lại.');
    await navigator.clipboard.writeText(packet);
    say('Đã sao chép. Dán vào cửa sổ script bằng Ctrl+V rồi Enter; không dán gói vào chat.');
  }));
  window.addEventListener('pagehide', () => {
    epoch++; clear(); token = null; selected = null;
    window.SimpleWebAuthnBrowser?.WebAuthnAbortService?.cancelCeremony();
  });
  if (location.origin !== WEB || !window.isSecureContext) {
    busy = true; say('Mở trang này trên https://enclave.id.vn để dùng Passkey của Enclave.', true);
  }
  controls();
})();
