'use strict';
(() => {
  const WEB='https://enclave.id.vn',API='https://api.enclave.id.vn',$=id=>document.getElementById(id);
  let token=null,packet=null,expires=0,busy=false,timer=null,generation=0;
  const say=(message,error=false)=>{$('status').textContent=message;$('status').className=error?'error':'';};
  function controls(){for(const id of ['check','order-a','consent'])$(id).disabled=busy;$('copy').disabled=busy||!packet||!$('consent').checked||Date.now()>=expires;}
  function clear(){token=null;packet=null;expires=0;clearInterval(timer);timer=null;$('details').hidden=true;}
  async function request(route,body){
    const r=await fetch(API+'/api'+route,{method:body===undefined?'GET':'POST',credentials:'include',cache:'no-store',
      headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},
      body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
    let data;try{data=await r.json();}catch{throw new Error('Chưa đọc được phản hồi máy chủ. Hãy kiểm tra kết nối.');}
    if(!r.ok){
      if(r.status===401&&['SESSION_EXPIRED','UNAUTHENTICATED'].includes(data.error))throw new Error('Phiên đã kết thúc. Quay lại Enclave đăng nhập rồi kiểm tra đơn.');
      if(data.error==='SESSION_REFRESH_ROTATED')throw new Error('Phiên vừa được làm mới ở tab khác. Bấm kiểm tra lại.');
      throw new Error('Máy chủ chưa chấp nhận bước này. Kiểm tra lại tài khoản và trạng thái đơn.');
    }
    return data;
  }
  function sessionExpiry(value){
    const pieces=value.split('.');if(pieces.length!==3)throw new Error('Phiên máy chủ trả về không hợp lệ.');
    const bytes=Uint8Array.from(atob(pieces[1].replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
    const end=Number(JSON.parse(new TextDecoder().decode(bytes)).exp)*1000;
    if(!Number.isFinite(end)||end<=Date.now())throw new Error('Mã phiên đã hết hạn. Hãy kiểm tra lại.');
    return end;
  }
  async function guard(fn){if(busy)return;busy=true;controls();try{await fn();}catch(error){say(error.message,true);}finally{busy=false;controls();}}
  $('orders').addEventListener('submit',event=>{
    event.preventDefault();guard(async()=>{
      clear();$('consent').checked=false;const epoch=generation;
      const link=new URL($('order-a').value.trim()),id=link.hash.replace(/^#\/tx\//,'');
      if(link.origin!==WEB||link.pathname!=='/'||link.search||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id))throw new Error('Dán đúng đường dẫn đơn trên enclave.id.vn.');
      if(localStorage.getItem('cat_signed_out')==='1')throw new Error('Bạn đã đăng xuất. Quay lại Enclave đăng nhập trước.');
      say('Đang kiểm tra phiên và đơn...');
      const refresh=()=>request('/passkeys/session/refresh',{});
      const session=navigator.locks?.request?await navigator.locks.request('enclave-auth-cookie',refresh):await refresh();
      if(epoch!==generation)return;
      if(typeof session.token!=='string'||!session.user?.id)throw new Error('Chưa xác nhận được phiên đăng nhập.');
      token=session.token;
      const [me,order]=await Promise.all([request('/users/me'),request('/transactions/'+id)]);
      if(epoch!==generation)return;
      if(me.user?.id!==session.user.id||order.id!==id||order.buyerId!==me.user.id||order.status!=='WAIT_CONFIRM'||order.escrowStatus!=='LOCKED'||!order.inspectedAt||order.integrityHold||order.canBuyerRelease!==true)throw new Error('Đơn phải thuộc người mua đang đăng nhập, đã kiểm hàng và đang chờ chuyển tiền.');
      expires=sessionExpiry(token);
      const data={version:'ENCLAVE-S1-1',apiOrigin:API,webOrigin:WEB,transactionId:id,accessToken:token,expiresAt:new Date(expires).toISOString()};
      packet='ENCLAVE-S1:'+btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(data))));
      $('account').textContent='Người mua: '+(me.user.displayName||me.user.username);
      $('summary-a').textContent=(order.itemName||order.listingTitle)+' · '+Number(order.amount).toLocaleString('vi-VN')+'đ · Người bán: '+order.sellerName;
      $('back').href='/#/tx/'+id;$('details').hidden=false;
      const tick=()=>{const seconds=Math.max(0,Math.floor((expires-Date.now())/1000));$('expiry').textContent='Mã phiên còn khoảng '+seconds+' giây; đăng xuất có thể làm gói mất hiệu lực sớm hơn.';if(!seconds){clear();say('Mã phiên đã hết hạn. Bấm Kiểm tra đơn để chuẩn bị lại.');}controls();};
      timer=setInterval(tick,1000);tick();say('Đơn đủ điều kiện. Sao chép phiên thử nghiệm rồi mở Chay-S1.cmd; chưa xác nhận chuyển tiền trên trang đơn.');
    });
  });
  $('consent').addEventListener('change',controls);
  $('order-a').addEventListener('input',()=>{clear();controls();});
  $('copy').addEventListener('click',()=>guard(async()=>{
    if(!packet||!$('consent').checked||Date.now()>=expires)throw new Error('Hãy kiểm tra đơn và xác nhận dùng tài khoản thử nghiệm trước.');
    await navigator.clipboard.writeText(packet);say('Đã sao chép. Mở Chay-S1.cmd trên máy của bạn; không gửi gói vào chat.');
  }));
  window.addEventListener('pagehide',()=>{generation++;clear();});
  if(location.origin!==WEB||!window.isSecureContext){busy=true;say('Mở trang này trên https://enclave.id.vn.',true);}
  controls();
})();
