/* Enclave Delivery: server-owned milestones, client-only illustration.
 * Never advances transactions, releases escrow, or calls a shipping API.
 */
(function (root) {
  'use strict';

  const ART = `
<svg class="sm-symbols" aria-hidden="true"><defs>
    <g id="sm-side-truck">
      <ellipse cx="106" cy="99" rx="112" ry="6" fill="var(--sm-shade)"/>
      <g class="sm-suspension">
        <rect x="0" y="1" width="159" height="87" rx="10" fill="var(--sm-yellow)"/>
        <path d="M160 21h23c18 0 30 13 30 32v35h-53Z" fill="var(--sm-orange)"/>
        <path d="M169 29h12c12 0 18 7 18 20v8h-30Z" fill="#262d29"/>
        <path d="m177 29 19 9v6l-19-9Z" fill="#fff" opacity=".2"/>
        <rect x="163" y="64" width="9" height="3" rx="1" fill="var(--sm-yellow)"/>
        <rect x="209" y="68" width="5" height="12" rx="1" fill="#ffe9b3"/>
        <path d="M160 24v62M3 78h152" stroke="#d5a251" stroke-width="2"/>
        <rect x="29" y="28" width="101" height="33" rx="13" fill="#202521"/>
        <text x="79" y="51" fill="var(--sm-yellow)" font-size="24" font-family="Arial,sans-serif" font-weight="700" letter-spacing="-1.6" text-anchor="middle">enclave</text>
        <path d="M42 53q29 12 66 0" stroke="var(--sm-yellow)" fill="none" stroke-width="1.6"/>
        <path d="M1 12v66" stroke="#edaf56" stroke-width="4"/>
      </g>
      <g transform="translate(32 88)"><g class="sm-wheel-spin"><circle r="13" fill="#242b25"/><circle r="5" fill="#faf7ea"/><path d="M0-11v3M11 0H8M0 11V8M-11 0h3" stroke="#72816a" stroke-width="2"/></g></g>
      <g transform="translate(184 88)"><g class="sm-wheel-spin"><circle r="13" fill="#242b25"/><circle r="5" fill="#faf7ea"/><path d="M0-11v3M11 0H8M0 11V8M-11 0h3" stroke="#72816a" stroke-width="2"/></g></g>
      <g class="sm-speed-lines" fill="none" stroke="#d6ad67" stroke-width="3" stroke-linecap="round"><path d="M-42 42h27M-55 56h35M-31 70h15"/></g>
    </g>
    <g id="sm-side-truck-left">
      <g transform="translate(214 0) scale(-1 1)"><use href="#sm-side-truck"/></g>
      <rect x="84" y="28" width="101" height="33" rx="13" fill="#202521"/>
      <text x="135" y="51" fill="var(--sm-yellow)" font-size="24" font-family="Arial,sans-serif" font-weight="700" letter-spacing="-1.6" text-anchor="middle">enclave</text>
      <path d="M98 53q29 12 66 0" stroke="var(--sm-yellow)" fill="none" stroke-width="1.6"/>
    </g>
    <g id="sm-top-truck">
      <rect x="-2" y="-3" width="164" height="94" rx="12" fill="var(--sm-shade)"/>
      <rect width="159" height="87" rx="10" fill="var(--sm-yellow)"/>
      <path d="M160 9h36q17 0 17 17v39q0 15-17 15h-36Z" fill="var(--sm-orange)"/>
      <path d="M168 18h7q23 0 23 26t-23 26h-7Z" fill="#262d29"/>
      <path d="m170 24 26 13v6l-26-13Zm0 15 27 13-2 5-25-12Z" fill="#eff3e9" opacity=".65"/>
      <rect x="210" y="23" width="3" height="13" fill="#ffe9b3"/><rect x="210" y="58" width="3" height="13" fill="#ffe9b3"/>
    </g>
    <g id="sm-box"><rect width="30" height="30" rx="4" fill="#e6b56a"/><path d="M0 15h30M15 0v9" stroke="#fff0c8" stroke-width="3"/><path d="M5 24h7" stroke="#ad7c37" stroke-width="2"/></g>
  </defs></svg>
          <div class="sm-scene" id="sm-pickup-scene">
            <svg viewBox="0 0 700 270" role="img" aria-label="Xe đến điểm lấy, mở cửa sau; kiện hàng nhảy thấp rồi trượt qua cửa vào thùng xe">
              <circle cx="556" cy="48" r="22" fill="#ffe3a3"/>
              <g fill="var(--sm-city)"><rect x="211" y="110" width="48" height="92" rx="4"/><rect x="265" y="76" width="58" height="126" rx="4"/><rect x="515" y="97" width="52" height="105" rx="4"/><rect x="576" y="127" width="41" height="75" rx="4"/></g>
              <path d="M0 205h700" stroke="var(--sm-line)" stroke-width="2"/>
              <rect x="45" y="109" width="118" height="96" rx="4" fill="#d6c4a3"/><path d="m31 111 72-39 74 39Z" fill="#dcb47a"/>
              <rect x="71" y="140" width="64" height="65" rx="3" fill="#f4ead4"/><path d="M76 151h53M76 163h53M76 175h53" stroke="#d3c3a3" stroke-width="3"/>
              <text x="104" y="132" fill="#655439" text-anchor="middle" font-family="Arial,sans-serif" font-size="11">NGƯỜI BÁN</text>
              <g fill="var(--sm-grass)"><circle cx="661" cy="177" r="20"/><circle cx="625" cy="189" r="12"/></g>
              <rect x="0" y="212" width="700" height="33" rx="17" fill="var(--sm-road)"/><path class="sm-road-mark" d="M-80 228h860"/>
              <g id="sm-pickup-parcel" transform="translate(139 175)"><use href="#sm-box"/></g>
              <g id="sm-pickup-truck" transform="translate(-230 118)"><use href="#sm-side-truck"/><g id="sm-pickup-door" opacity="0"><rect x="-5" y="28" width="12" height="46" rx="2" fill="#7d603c"/><path id="sm-pickup-gate" d="M0 20V78" fill="none" stroke="#b88944" stroke-width="5" stroke-linecap="round"/></g></g>
              <g class="sm-handoff-flash" transform="translate(522 143)"><circle r="23" fill="var(--sm-green)"/><text text-anchor="middle" y="8" fill="var(--sm-paper)" font-size="25">✓</text></g>
            </svg>
            <div class="sm-activity-text" id="sm-pickup-label">Xe đến điểm lấy hàng</div>
          </div>

          <div class="sm-scene" id="sm-route-scene" hidden>
            <svg viewBox="0 0 700 270" role="img" aria-label="Góc nhìn từ trên: xe chở kiện hàng đi từ cửa hàng đến điểm giao">
              <g fill="var(--sm-city)"><rect x="38" y="25" width="80" height="51" rx="9"/><rect x="133" y="22" width="52" height="53" rx="7"/><rect x="444" y="20" width="65" height="44" rx="8"/><rect x="541" y="193" width="102" height="47" rx="9"/><rect x="301" y="188" width="54" height="40" rx="7"/></g>
              <g fill="var(--sm-grass)"><circle cx="215" cy="41" r="16"/><circle cx="437" cy="218" r="19"/><circle cx="652" cy="41" r="13"/><circle cx="42" cy="212" r="13"/></g>
              <path id="sm-route-path" d="M73 153H169C244 153 214 96 298 96H355C440 96 402 159 490 159H556Q609 159 609 104" fill="none" stroke="var(--sm-road)" stroke-width="57" stroke-linecap="round"/>
              <path class="sm-road-mark" d="M73 153H169C244 153 214 96 298 96H355C440 96 402 159 490 159H556Q609 159 609 104" fill="none"/>
              <path id="sm-route-travel" class="sm-route-travel" d="M73 153H169C244 153 214 96 298 96H355C440 96 402 159 490 159H556Q609 159 609 104"/>
              <circle cx="73" cy="153" r="8" fill="#b58c49"/><circle cx="609" cy="104" r="8" fill="var(--sm-green)"/>
              <text x="73" y="111" text-anchor="middle" class="sm-route-label">Điểm lấy hàng</text><text x="609" y="77" text-anchor="middle" class="sm-route-label">Điểm giao</text>
              <g id="sm-route-truck"><g transform="scale(.33) translate(-105 -44)"><use href="#sm-top-truck"/></g></g>
            </svg>
          </div>

          <div class="sm-scene" id="sm-arrival-scene" hidden>
            <svg viewBox="0 0 700 245" role="img" aria-label="Xe đỗ với cửa sau hướng về nhà người mua; kiện hàng trượt ra qua cửa rồi nhảy thấp đến trước cửa nhà">
              <path d="M0 158h700" stroke="var(--sm-line)" stroke-width="2"/>
              <g fill="var(--sm-city)"><rect x="20" y="71" width="70" height="87" rx="5"/><rect x="103" y="44" width="54" height="114" rx="5"/></g>
              <rect x="505" y="74" width="105" height="84" rx="3" fill="#e1c7a2"/><path d="m492 77 66-49 65 49Z" fill="#cca679"/><rect x="545" y="111" width="30" height="47" rx="3" fill="#9cb098"/><rect x="516" y="88" width="19" height="20" rx="3" fill="#fbf4db"/><rect x="582" y="88" width="17" height="20" rx="3" fill="#fbf4db"/>
              <rect x="0" y="165" width="700" height="28" rx="14" fill="var(--sm-road)"/><path class="sm-road-mark" d="M-80 179h860"/>
              <g id="sm-delivery-parcel" transform="translate(355 105)" opacity="0"><use href="#sm-box"/></g>
              <g id="sm-arrival-truck" transform="translate(190 69)"><use href="#sm-side-truck-left"/><g id="sm-delivery-door" opacity="0"><rect x="210" y="28" width="12" height="46" rx="2" fill="#7d603c"/><path id="sm-delivery-gate" d="M214 20V78" fill="none" stroke="#b88944" stroke-width="5" stroke-linecap="round"/></g></g>
            </svg>
          </div>
`;
  const END = 19200;
  const COPY = {
    approach: ['Xe đang đến lấy hàng', 'Xe đến điểm lấy của người bán. Không cần thao tác thêm.', 'Lấy hàng'],
    loading: ['Đang lấy kiện hàng', 'Mở cửa sau, đưa kiện hàng vào thùng rồi đóng cửa.', 'Lấy hàng'],
    pickup_wait: ['Đang xác nhận lấy hàng', 'Máy chủ đang cập nhật kết quả lấy hàng. Bạn không cần bấm lại.', 'Đang cập nhật'],
    depart: ['Đã lấy hàng, xe xuất phát', 'Kiện hàng đã ở trong xe. Người bán không cần xác nhận thêm.', 'Đã lấy'],
    handoff: ['Đã bàn giao cho Enclave Delivery', 'Hệ thống tự cập nhật hành trình cho hai bên.', 'Đã lấy'],
    transit: ['Kiện hàng đang đến điểm giao', 'Xe vận chuyển mô phỏng đang di chuyển tới địa chỉ nhận hàng.', 'Đang giao'],
    arrival_wait: ['Xe đang đến điểm giao', 'Đang chờ máy chủ xác nhận giao đến. Chưa cần xác nhận nhận hàng.', 'Đang giao'],
    arrival: ['Xe đang dừng tại điểm giao', 'Chuẩn bị đưa kiện hàng ra qua cửa sau xe.', 'Giao hàng'],
    unloading: ['Đang giao kiện hàng', 'Kiện hàng ra qua cửa sau và được đặt trước cửa nhà.', 'Giao hàng'],
    delivered: ['Đơn hàng đã đến', 'Hãy nhận và kiểm tra sản phẩm trước khi xác nhận hoàn tất.', 'Đã đến'],
    received: ['Người mua đã nhận hàng', 'Kiểm tra sản phẩm và theo dõi bước hoàn tất hoặc hồ sơ tranh chấp của đơn.', 'Đã nhận'],
    received_system: ['Hệ thống đã mở thời hạn kiểm hàng', 'Chưa có xác nhận nhận kiện của người mua. Nếu chưa nhận được hàng, hãy báo vấn đề trên đơn.', 'Chờ kiểm hàng'],
    completed: ['Giao dịch đã hoàn tất', 'Hàng đã giao và giao dịch đã kết thúc. Xem kết quả trong nhật ký.', 'Hoàn tất'],
    refunded: ['Giao dịch đã hoàn tiền', 'Hành trình giao tự động đã dừng. Theo dõi kết quả hoàn tiền trong ví.', 'Hoàn tiền'],
    resolved: ['Giao dịch đã được phân xử', 'Hành trình giao tự động đã dừng. Xem quyết định trong hồ sơ tranh chấp.', 'Đã phân xử'],
    stopped: ['Hành trình đã tạm dừng', 'Theo dõi trạng thái giao dịch và hồ sơ tranh chấp; hệ thống không tiếp tục giao tự động.', 'Tạm dừng'],
    preparing: ['Chờ người bán đóng gói', 'Sau khi xác nhận đơn và đóng gói, xe sẽ tự đến lấy hàng.', 'Chuẩn bị'],
    legacy: ['Theo dõi giao nhận', 'Đơn này dùng luồng giao nhận trước đây. Xem các mốc ở trạng thái giao dịch.', 'Thông tin']
  };
  let serial = 0;
  let active = null;
  const clamp = (n) => Math.max(0, Math.min(1, n));
  const smooth = (n) => { n = clamp(n); return n * n * (3 - 2 * n); };
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const time = (v) => { const n = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(n) ? n : null; };
  const perf = () => root.performance ? root.performance.now() : Date.now();

  /* A finished local animation is never evidence that pickup/arrival succeeded.
   * Cap each stage until the corresponding server milestone is present.
   */
  function snapshot(t, now) {
    t = t || {};
    const s = t.shipment;
    if (!s) return { phase: t.status === 'SECURED' ? 'preparing' : 'legacy', elapsed: 0, step: -1, running: false };
    const packed = time(s.packedAt), picked = time(s.pickedUpAt), arrived = time(s.arrivedAt);
    const stopped = s.status === 'STOPPED' || t.escrowStatus === 'FROZEN' || ['DISPUTED', 'REFUNDED', 'RELEASED', 'COMPLETED'].includes(t.status);
    const clock = time(now) == null ? (time(s.serverNow) == null ? Date.now() : time(s.serverNow)) : time(now);
    const at = stopped && time(s.stoppedAt) != null ? time(s.stoppedAt) : clock;
    let e = 0, phase = 'preparing';
    if (arrived != null && at >= arrived) {
      e = 15400 + Math.max(0, at - arrived);
      phase = e >= END ? 'delivered' : e < 17300 ? 'arrival' : 'unloading';
    } else if (picked != null && at >= picked) {
      const due = time(s.arrivalDueAt);
      const duration = due != null && due > picked ? due - picked : 14500;
      // Vehicle may approach the destination, but cannot unload without arrivedAt.
      e = Math.min(15399, 4700 + Math.max(0, at - picked) / duration * 10700);
      phase = e < 6100 ? 'depart' : e < 7300 ? 'handoff' : e >= 15398 ? 'arrival_wait' : 'transit';
    } else if (packed != null) {
      const due = time(s.pickupDueAt);
      const duration = due != null && due > packed ? due - packed : 4700;
      e = Math.min(4699, Math.max(0, at - packed) / duration * 4700);
      phase = e < 2400 ? 'approach' : e >= 4698 ? 'pickup_wait' : 'loading';
    }
    e = Math.min(END, e);
    let displayPhase = stopped ? 'stopped' : phase;
    if (t.status === 'WAIT_CONFIRM') { displayPhase = t.receivedConfirmedBy === 'SYSTEM' ? 'received_system' : 'received'; if (arrived != null) e = END; }
    if (t.status === 'COMPLETED') { displayPhase = 'completed'; if (arrived != null) e = END; }
    if (t.status === 'REFUNDED') displayPhase = 'refunded';
    if (t.status === 'RELEASED') displayPhase = 'resolved';
    return { phase: displayPhase, posePhase: phase, elapsed: e, step: arrived != null ? 2 : picked != null ? 1 : packed != null ? 0 : -1, running: !stopped && t.status !== 'WAIT_CONFIRM' && !['pickup_wait', 'arrival_wait'].includes(phase) && packed != null && e < END };
  }

  function moneyCopy(t) {
    if (t.escrowStatus === 'LOCKED' || t.escrowStatus === 'FROZEN') return 'Tiền vẫn được giữ trong ký quỹ. Giao đến không tự giải ngân cho người bán.';
    if (t.status === 'COMPLETED' || t.status === 'RELEASED') return 'Giao dịch đã kết thúc. Xem kết quả giải ngân trong nhật ký.';
    if (t.status === 'REFUNDED') return 'Giao dịch đã hoàn tiền. Xem bút toán trong ví.';
    return 'Minh họa giao nhận không làm thay đổi tiền hoặc trạng thái giao dịch.';
  }

  function render(t) {
    if (!t || t.status === 'CREATED') return '';
    const state = snapshot(t), copy = COPY[state.phase];
    return '<section class="shipping-tracking card" aria-label="Hành trình kiện hàng"><div class="shipping-tracking-head"><div><span class="shipping-eyebrow">ENCLAVE DELIVERY</span><h3>Hành trình kiện hàng</h3></div><span class="shipping-demo-badge">Mô phỏng vận chuyển</span></div><p class="shipping-tracking-title">' + esc(copy[0]) + '</p><p class="shipping-tracking-copy">' + esc(copy[1]) + '</p>' +
      (t.shipment ? '<button type="button" class="btn btn-ghost" data-act="shipping-open" data-id="' + esc(t.id) + '">Xem hành trình giao hàng</button>' : '') +
      '<p class="shipping-tracking-note">Đến điểm giao chưa đồng nghĩa người mua đã xác nhận nhận hàng.</p></section>';
  }

  function scene(t) {
    const prefix = 'sm' + (++serial) + '-';
    // Unique symbol IDs keep multiple rendered modal fragments independent.
    const art = ART.replace(/id="sm-([^"]+)"/g, 'id="' + prefix + '$1" data-shipping-part="$1"').replace(/href="#sm-([^"]+)"/g, 'href="#' + prefix + '$1"');
    const state = snapshot(t), copy = COPY[state.phase];
    return '<div class="shipping-motion-scene" data-phase="' + state.phase + '" data-paused="false">' +
      '<div class="sm-heading"><span class="shipping-eyebrow">VẬN CHUYỂN MÔ PHỎNG</span><span class="sm-step-pill" data-shipping-part="phase-pill">' + esc(copy[2]) + '</span></div>' +
      '<h3 class="sm-title" data-shipping-part="title">' + esc(copy[0]) + '</h3>' + art +
      '<div class="sm-status" aria-live="polite"><span class="sm-pulse" aria-hidden="true"></span><div><strong data-shipping-part="status-title">' + esc(copy[0]) + '</strong><p data-shipping-part="status-copy">' + esc(copy[1]) + '</p></div></div>' +
      '<div class="sm-mini-route" data-shipping-part="mini-route"><span>Điểm lấy</span><div class="sm-progress"><span data-shipping-part="progress-fill"></span></div><span>Điểm giao</span></div>' +
      '<p class="sm-footer" data-shipping-part="money-copy">' + esc(moneyCopy(t)) + '</p>' +
      '<div class="sm-controls"><span>Đóng cửa sổ vẫn tiếp tục vận chuyển.</span><button type="button" class="btn btn-ghost btn-sm" data-shipping-pause aria-pressed="false">Tạm dừng chuyển động</button></div></div>';
  }

  function pose(el, x, y) { if (el) el.setAttribute('transform', 'translate(' + x.toFixed(2) + ' ' + y.toFixed(2) + ')'); }

  function draw(view) {
    if (!view || !view.node.isConnected) { stop(); return; }
    const t = view.transaction;
    let now = view.serverAt + Math.max(0, perf() - view.syncedAt);
    const stopImmediately = t.shipment && (t.shipment.status === 'STOPPED' || t.escrowStatus === 'FROZEN' || ['DISPUTED', 'REFUNDED', 'RELEASED'].includes(t.status));
    if (stopImmediately) { if (view.frozenTime == null) view.frozenTime = now; now = view.frozenTime; }
    else view.frozenTime = null;
    const state = snapshot(t, now);
    const e = view.paused && view.pausedElapsed != null ? view.pausedElapsed : state.elapsed, p = view.parts;
    view.lastElapsed = e;
    const currentPhase = state.phase;
    const phase = state.posePhase || currentPhase;
    view.node.dataset.phase = currentPhase;
    view.node.dataset.paused = String(view.paused || view.reduced || !state.running);
    if (view.phase !== currentPhase) {
      view.phase = currentPhase;
      const c = COPY[currentPhase] || COPY.legacy;
      p.title.textContent = c[0]; p['status-title'].textContent = c[0]; p['status-copy'].textContent = c[1]; p['phase-pill'].textContent = c[2];
    }
    p['money-copy'].textContent = moneyCopy(t);
    const pickup = e < 7300;
    p['pickup-scene'].hidden = !pickup;
    p['route-scene'].hidden = pickup || e >= 15400;
    p['arrival-scene'].hidden = e < 15400;
    p['mini-route'].hidden = pickup || e >= 15400;
    if (p['pickup-label']) p['pickup-label'].textContent = currentPhase === 'stopped' ? 'Hành trình tạm dừng' : phase === 'pickup_wait' ? 'Chờ xác nhận lấy hàng từ máy chủ' : phase === 'loading' ? 'Lấy hàng qua cửa sau' : phase === 'approach' ? 'Xe đến điểm lấy hàng' : 'Đã lấy kiện hàng';

    let truckX = 265;
    if (e < 2400) truckX = -240 + 505 * smooth(e / 2400);
    if (e >= 4700) truckX = 265 + 520 * smooth((e - 4700) / 1400);
    pose(p['pickup-truck'], view.reduced ? (e < 6100 ? 265 : 785) : truckX, 118);
    const loading = clamp((e - 2400) / 2300);
    const pickupJump = view.reduced ? (loading < .5 ? 0 : 1) : loading;
    const pickupHop = Math.min(1, pickupJump / .62), pickupSlide = smooth((pickupJump - .62) / .26);
    pose(p['pickup-parcel'], pickupJump < .62 ? 139 + 96 * smooth(pickupHop) : 235 + 50 * pickupSlide, pickupJump < .62 ? 175 - 22 * smooth(pickupHop) - 8 * Math.sin(Math.PI * pickupHop) : 153);
    p['pickup-parcel'].setAttribute('opacity', e < 4700 ? '1' : '0');
    p['pickup-door'].setAttribute('opacity', ['loading', 'pickup_wait'].includes(phase) ? '1' : '0');
    p['pickup-gate'].setAttribute('transform', 'rotate(' + (-84 * smooth(loading / .16) * (1 - smooth((loading - .88) / .12))) + ' 0 78)');

    const progress = clamp((e - 7300) / 8100);
    const path = p['route-path'], length = view.pathLength;
    if (length) {
      const position = (view.reduced ? .5 : progress) * length;
      const point = path.getPointAtLength(position);
      const before = path.getPointAtLength(Math.max(0, position - 2)), after = path.getPointAtLength(Math.min(length, position + 2));
      const angle = Math.atan2(after.y - before.y, after.x - before.x) * 180 / Math.PI;
      p['route-truck'].setAttribute('transform', 'translate(' + point.x + ' ' + point.y + ') rotate(' + angle + ')');
      p['route-travel'].setAttribute('stroke-dasharray', String(length));
      p['route-travel'].setAttribute('stroke-dashoffset', String(length * (1 - progress)));
    }
    p['progress-fill'].style.width = (progress * 100).toFixed(2) + '%';
    const arrival = view.reduced ? 1 : smooth((e - 15400) / 1900);
    pose(p['arrival-truck'], 730 - 540 * arrival, 69);
    const unloading = clamp((e - 17300) / 1900);
    const deliveryJump = view.reduced ? (unloading < .5 ? 0 : 1) : unloading;
    const exitSlide = smooth((deliveryJump - .18) / .34), deliveryHop = clamp((deliveryJump - .52) / .38);
    pose(p['delivery-parcel'], deliveryJump < .52 ? 355 + 61 * exitSlide : 416 + 130 * smooth(deliveryHop), deliveryJump < .52 ? 105 : 105 + 24 * smooth(deliveryHop) - 10 * Math.sin(Math.PI * deliveryHop));
    p['delivery-parcel'].setAttribute('opacity', e >= 17300 ? '1' : '0');
    p['delivery-door'].setAttribute('opacity', phase === 'unloading' ? '1' : '0');
    p['delivery-gate'].setAttribute('transform', 'rotate(' + (84 * smooth(unloading / .18) * (1 - smooth((unloading - .9) / .1))) + ' 214 78)');
    view.running = state.running;
  }

  function frame() {
    if (!active) return;
    active.frame = null;
    draw(active);
    if (active && active.running && !active.paused && !active.reduced) active.frame = root.requestAnimationFrame(frame);
  }

  function sync(t) {
    if (!active || !t || String(t.id) !== String(active.transaction.id)) return;
    active.transaction = t;
    const supplied = t.shipment && time(t.shipment.serverNow);
    // Updates resynchronise against server time, never browser wall-clock drift.
    if (supplied != null) { active.serverAt = supplied; active.syncedAt = perf(); }
    draw(active);
    if (active && active.running && !active.frame && !active.paused && !active.reduced) active.frame = root.requestAnimationFrame(frame);
  }

  function mount(container, t) {
    stop();
    const node = container && (container.matches && container.matches('.shipping-motion-scene') ? container : container.querySelector('.shipping-motion-scene'));
    if (!node) return;
    const parts = {};
    node.querySelectorAll('[data-shipping-part]').forEach((el) => { parts[el.dataset.shippingPart] = el; });
    const media = root.matchMedia ? root.matchMedia('(prefers-reduced-motion: reduce)') : null;
    const supplied = t.shipment && time(t.shipment.serverNow);
    active = { node, transaction: t, parts, serverAt: supplied == null ? Date.now() : supplied, syncedAt: perf(), reduced: Boolean(media && media.matches), paused: false, phase: '', frame: null, running: false, pathLength: 0, media };
    try { active.pathLength = parts['route-path'].getTotalLength(); } catch (_) { /* SVG geometry unavailable in older embedded renderers. */ }
    active.onPause = () => {
      if (!active) return;
      active.paused = !active.paused;
      active.pausedElapsed = active.paused ? active.lastElapsed : null;
      node.dataset.paused = String(active.paused || active.reduced);
      const button = node.querySelector('[data-shipping-pause]');
      button.textContent = active.paused ? 'Tiếp tục chuyển động' : 'Tạm dừng chuyển động';
      button.setAttribute('aria-pressed', String(active.paused));
      if (active.paused && active.frame) { root.cancelAnimationFrame(active.frame); active.frame = null; }
      if (!active.paused) { draw(active); if (active.running && !active.reduced && !active.frame) active.frame = root.requestAnimationFrame(frame); }
    };
    active.onMotionChange = (event) => { if (active) { active.reduced = event.matches; sync(active.transaction); } };
    node.querySelector('[data-shipping-pause]').addEventListener('click', active.onPause);
    if (media && media.addEventListener) media.addEventListener('change', active.onMotionChange);
    draw(active);
    if (active && active.running && !active.reduced) active.frame = root.requestAnimationFrame(frame);
  }

  function stop() {
    if (!active) return;
    if (active.frame) root.cancelAnimationFrame(active.frame);
    const button = active.node.querySelector('[data-shipping-pause]');
    if (button) button.removeEventListener('click', active.onPause);
    if (active.media && active.media.removeEventListener) active.media.removeEventListener('change', active.onMotionChange);
    active = null;
  }

  const api = Object.freeze({ render, scene, mount, update: sync, stop, snapshot });
  root.EnclaveShippingMotion = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
