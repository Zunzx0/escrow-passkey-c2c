const {db,uuid,nowIso}=require('../db');
const sec=require('./accountSecurity');

async function processAuthMaintenance() {
  await db.transaction(async()=>{
    const now=nowIso(),cutoff=new Date(Date.now()-30*86400000).toISOString();
    await db.prepare("DELETE FROM users WHERE account_status='BASIC' AND COALESCE(auth_last_active_at,created_at)<? AND NOT EXISTS (SELECT 1 FROM wallets WHERE wallets.user_id=users.id) AND NOT EXISTS (SELECT 1 FROM transactions WHERE buyer_id=users.id OR seller_id=users.id)").run(cutoff);
    await db.prepare('DELETE FROM auth_limits WHERE reset_at<?').run(Date.now()-3600000);
    await db.prepare('DELETE FROM auth_login_throttles WHERE last_failure_at<? AND locked_until<=?').run(Date.now()-86400000,Date.now());
    await db.prepare('DELETE FROM auth_registration_flows WHERE expires_at<=?').run(now);
    await db.prepare('DELETE FROM auth_otp_failures WHERE failed_at<=?').run(Date.now()-86400000);
    await db.prepare('DELETE FROM auth_email_sends WHERE sent_at<=?').run(Date.now()-3600000);
    await db.prepare("UPDATE auth_email_outbox SET body_cipher='',claim_until=NULL,last_error='EMAIL_EXPIRED' WHERE sent_at IS NULL AND body_cipher<>'' AND (expires_at<=? OR created_at<=?)").run(now,new Date(Date.now()-86400000).toISOString());
    const recoveries=await db.prepare("SELECT r.*,u.email,u.email_verified_at FROM account_recoveries r JOIN users u ON u.id=r.user_id WHERE r.status IN ('WAITING','READY')").all();
    for(const r of recoveries) {
      const user={id:r.user_id,email:r.email},created=Date.parse(r.created_at),available=Date.parse(r.available_at);
      if(Date.parse(r.expires_at)<=Date.now()) {
        await db.prepare("UPDATE account_recoveries SET status='CANCELLED' WHERE id=?").run(r.id);
        await db.prepare("UPDATE users SET account_status='ACTIVE' WHERE id=? AND account_status='RECOVERING'").run(r.user_id);
        await sec.securityNotice(r.user_id,'RECOVERY_EXPIRED','Yêu cầu khôi phục đã hết hạn; Passkey hiện có vẫn được giữ nguyên');
      } else if(r.status==='WAITING' && available<=Date.now()) {
        const token=await sec.makeLink(r.user_id,'RECOVERY_FINISH',Math.max(1,Math.floor((Date.parse(r.expires_at)-Date.now())/1000)),{recoveryId:r.id});
        await sec.queueMail(user,'Đã đến thời điểm khôi phục Enclave',`Mở liên kết trước ${r.expires_at} để tạo Passkey mới và đặt mật khẩu mới: ${sec.linkUrl('recovery-finish',token)}. Sau khôi phục, giải ngân và phân xử bị hạn chế trong 72 giờ.`,user.email,{expiresAt:r.expires_at});
        await db.prepare("UPDATE account_recoveries SET status='READY' WHERE id=? AND status='WAITING'").run(r.id);
      } else if(r.status==='WAITING') {
        for(const [field,fraction] of [['reminded_12',12/24],['reminded_23',23/24]]) {
          if(!r[field] && Date.now()>=created+(available-created)*fraction) {
            const cancel=await sec.makeLink(r.user_id,'RECOVERY_CANCEL',Math.max(1,Math.floor((Date.parse(r.expires_at)-Date.now())/1000)),{recoveryId:r.id});
            await sec.queueMail(user,'Nhắc lại: yêu cầu khôi phục Enclave đang chờ',`Yêu cầu khôi phục sẽ được mở lúc ${r.available_at}. Nếu không phải bạn, hủy tại ${sec.linkUrl('recovery-cancel',cancel)} hoặc đăng nhập bằng Passkey cũ.`);
            await db.prepare(`UPDATE account_recoveries SET ${field}=1 WHERE id=?`).run(r.id);
          }
        }
      }
    }
  })();
}
async function deliverEmails({fetchImpl=fetch}={}) {
  if(process.env.AUTH_EMAIL_TRANSPORT==='test' && process.env.APP_ENV==='test') return {test:true};
  if(!sec.mailConfigured()) return {configured:false};
  const rows=await db.prepare("SELECT id FROM auth_email_outbox WHERE sent_at IS NULL AND body_cipher<>'' AND next_attempt_at<=? AND (expires_at IS NULL OR expires_at>?) AND created_at>? AND (claim_until IS NULL OR claim_until<?) ORDER BY created_at LIMIT 10").all(nowIso(),nowIso(),new Date(Date.now()-86400000).toISOString(),nowIso());
  let sent=0;
  for(const item of rows) {
    const claim=sec.after(60);
    const acquired=await db.prepare("UPDATE auth_email_outbox SET claim_until=?,attempts=attempts+1 WHERE id=? AND sent_at IS NULL AND body_cipher<>'' AND (expires_at IS NULL OR expires_at>?) AND (claim_until IS NULL OR claim_until<?)").run(claim,item.id,nowIso(),nowIso());
    if(acquired.changes!==1) continue;
    const row=await db.prepare('SELECT * FROM auth_email_outbox WHERE id=?').get(item.id);
    try {
      const response=await fetchImpl('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${process.env.RESEND_API_KEY}`,'Content-Type':'application/json','Idempotency-Key':`enclave-auth-${row.id}`},body:JSON.stringify({from:process.env.AUTH_EMAIL_FROM,to:[row.recipient],subject:row.subject,text:sec.decryptMail(row.body_cipher)}),signal:AbortSignal.timeout(15000)});
      if(!response.ok) {
        const e=new Error(`RESEND_HTTP_${response.status}`);e.retryAfter=Number(response.headers.get('retry-after')||0);throw e;
      }
      await db.prepare("UPDATE auth_email_outbox SET sent_at=?,body_cipher='',claim_until=NULL,last_error=NULL WHERE id=? AND claim_until=?").run(nowIso(),row.id,claim);sent++;
    } catch(e) {
      const seconds=Math.max(Number(e.retryAfter||0),Math.min(3600,15*2**Math.min(row.attempts-1,8))+Math.floor(Math.random()*10));
      await db.prepare('UPDATE auth_email_outbox SET claim_until=NULL,next_attempt_at=?,last_error=? WHERE id=? AND claim_until=?').run(sec.after(seconds),/^RESEND_HTTP_\d+$/.test(e.message)?e.message:'EMAIL_DELIVERY_ERROR',row.id,claim);
    }
  }
  return {sent};
}
function startAuthJobs({intervalMs=10000}={}) {
  let busy=false;
  async function tick(){if(busy)return;busy=true;try{await processAuthMaintenance();await deliverEmails();}catch(e){console.error('[auth-jobs] maintenance failed');}finally{busy=false;}}
  const timer=setInterval(tick,intervalMs);timer.unref();tick();return timer;
}
module.exports={processAuthMaintenance,deliverEmails,startAuthJobs};
