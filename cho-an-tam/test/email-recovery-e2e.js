// Real HTTP + serialized DB transactions, local encrypted mail only. No production data.
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'enclave-recovery-otp-'));
const pgUrl=process.env.AUTH_TEST_PG_URL||'';
if(pgUrl){const u=new URL(pgUrl);assert.equal(u.hostname,'127.0.0.1');assert.equal(u.pathname,'/enclave_auth_test');}
const secret=pgUrl&&process.env.AUTH_TEST_KEY||crypto.randomBytes(32).toString('hex');
Object.assign(process.env,{APP_ENV:'test',NODE_ENV:'test',DATABASE_URL:pgUrl,PGSSL:'disable',DB_PATH:path.join(tmp,'test.db'),DOTENV_CONFIG_PATH:path.join(tmp,'absent.env'),JWT_SECRET:secret,PAYMENT_WEBHOOK_SECRET:secret,AUTH_SECRET_PEPPER:secret,AUTH_SECRET_PEPPER_KEYS:JSON.stringify({fixture:secret}),AUTH_SECRET_PEPPER_KEY_ID:'fixture',AUTH_MAIL_ENCRYPTION_KEY:secret,AUTH_MAIL_ENCRYPTION_KEYS:JSON.stringify({fixture:secret}),AUTH_MAIL_KEY_ID:'fixture',AUTH_EMAIL_TRANSPORT:'test',AUTH_PUBLIC_URL:'https://enclave.example/',AUTH_BACKGROUND_JOBS:'0',RECONCILE_INTERVAL_SECONDS:'0',CHALLENGE_CLEANUP_INTERVAL_SECONDS:'0',SHIPPING_WORKER_INTERVAL_MS:'0',RATE_LIMIT_AUTH_PER_MINUTE:'1000',TRUST_PROXY:'1'});
let server,db,sec,base,checks=0;
const ip='198.51.100.230';
const check=(value,message)=>{assert.ok(value,message);checks++;console.log('PASS '+message);};
const must=(r,status=200)=>{assert.equal(r.status,status,JSON.stringify(r.data));return r.data;};
async function api(route,body){const r=await fetch(base+'/api/passkeys'+route,{method:'POST',headers:{'Content-Type':'application/json',Origin:base,'X-Forwarded-For':ip,Connection:'close'},body:JSON.stringify(body)});return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie'),retry:r.headers.get('retry-after')};}
async function user(suffix){
 const id=crypto.randomUUID(),name='recoverotp_'+suffix,email=name+'@example.test',now=new Date().toISOString();
 await db.prepare("INSERT INTO users(id,username,display_name,role,password_hash,account_status,email,email_verified_at,created_at,updated_at) VALUES(?,?,?,'BUYER',?,'ACTIVE',?,?,?,?)").run(id,name,'Người dùng thử','fixture-only-hash',email,now,now,now);
 await db.prepare("INSERT INTO wallets(id,user_id,wallet_type,available_balance) VALUES(?,?,'USER',5000000)").run(crypto.randomUUID(),id);
 await db.prepare('INSERT INTO passkey_credentials(id,user_id,credential_id,public_key,created_at) VALUES(?,?,?,?,?)').run(crypto.randomUUID(),id,'fixture-key-'+id,Buffer.from([1,2,3]),now);
 return {id,email};
}
async function latest(u){const rows=await db.prepare('SELECT * FROM auth_email_outbox WHERE user_id=? ORDER BY created_at DESC').all(u.id);const row=rows.find(r=>r.subject==='Xác nhận yêu cầu khôi phục Enclave');assert.ok(row);const text=sec.decryptMail(row.body_cipher);return {code:text.match(/\b\d{6}\b/)[0],link:new URLSearchParams(new URL(text.match(/https?:\/\/\S+/)[0]).hash.split('?')[1]).get('token'),row};}
async function request(u){return must(await api('/recovery/email/request',{email:u.email}));}
async function advanceRequestWindow(u){
 for(const key of [`recovery-email:${u.email}`,`recovery-email-cooldown:${u.email}`,`recovery-ip:${ip}`,`recovery-otp-ip:${ip}`])await db.prepare('DELETE FROM auth_limits WHERE bucket_key=?').run(sec.hash(key));
 // Controlled fixture clock window: do not clear OTP failures/locks or per-challenge attempts.
 await db.prepare('DELETE FROM auth_email_sends WHERE recipient_hash=?').run(sec.hash(u.email));
}
async function main(){
 const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));base='http://localhost:'+port;
 Object.assign(process.env,{PORT:String(port),WEBAUTHN_RP_ID:'localhost',WEBAUTHN_ORIGIN:base});
 const {app}=require('../src/server');({db}=require('../src/db'));sec=require('../src/lib/accountSecurity');await db.ready;
 server=app.listen(port);await new Promise(r=>server.once('listening',r));
 const a=await user('one');
 const first=await request(a),mail=await latest(a);
 const absent=must(await api('/recovery/email/request',{email:'absent-recovery@example.test'}));
 check(JSON.stringify(Object.keys(first).sort())===JSON.stringify(Object.keys(absent).sort())&&first.message===absent.message&&first.requestToken.length===absent.requestToken.length,'known and unknown emails receive the same public response shape');
 check(!('code' in first)&&!('user' in first)&&!mail.row.body_cipher.includes('Mã xác nhận'),'OTP is only in encrypted mail, never the API response');
 check((await db.prepare('SELECT account_status FROM users WHERE id=?').get(a.id)).account_status==='ACTIVE'&&!(await db.prepare('SELECT 1 FROM account_recoveries WHERE user_id=?').get(a.id)),'requesting mail does not start recovery');
 const cooldown=await api('/recovery/email/request',{email:a.email});check(cooldown.status===429&&Number(cooldown.retry)>0,'recovery resend enforces a server cooldown');
 check((await api('/recovery/email/verify',{requestToken:absent.requestToken,code:mail.code})).status===400,'an unknown-email flow cannot use another account OTP');
 const wrong=mail.code==='000000'?'111111':'000000';
 const failures=await Promise.all(Array.from({length:10},()=>api('/recovery/email/verify',{requestToken:first.requestToken,code:wrong})));
 check(failures.every(r=>r.status===400)&&(await db.prepare('SELECT COUNT(*) AS n FROM auth_otp_failures WHERE user_id=?').get(a.id)).n===5,'concurrent wrong guesses count at most five for one recovery OTP');
 check((await api('/recovery/email/verify',{requestToken:first.requestToken,code:mail.code})).status===400,'correct code is denied after five wrong guesses');
 await advanceRequestWindow(a);const second=await request(a),secondMail=await latest(a);
 check((await api('/recovery/email/verify',{requestToken:first.requestToken,code:mail.code})).status===400,'resending invalidates the previous recovery OTP');
 check((await api('/recovery/email/start',{token:mail.link})).status===400,'resending also invalidates the previous alternative link');
 const sessionsBefore=(await db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).n;
 const raced=await Promise.all([1,2].map(()=>api('/recovery/email/verify',{requestToken:second.requestToken,code:secondMail.code})));
 check(raced.filter(r=>r.status===200).length===1&&raced.filter(r=>r.status===400).length===1,'one email OTP starts recovery exactly once under concurrent submission');
 const started=raced.find(r=>r.status===200);
 check(!started.cookie&&!started.data.token&&(await db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).n===sessionsBefore,'email OTP never creates a login, recovery session or refresh cookie');
 const recovery=await db.prepare('SELECT * FROM account_recoveries WHERE user_id=?').get(a.id);
 check(recovery.status==='WAITING'&&Date.parse(recovery.available_at)>Date.now()+23*3600000,'verified OTP preserves the 24-hour waiting period');
 check((await db.prepare('SELECT COUNT(*) AS n FROM passkey_credentials WHERE user_id=?').get(a.id)).n===1,'starting recovery preserves the existing Passkey');
 await assert.rejects(()=>sec.assertMoneyAllowed(a.id,'RELEASE_ESCROW'),e=>e.code==='RECOVERY_MONEY_RESTRICTED');check(true,'starting recovery blocks money release');
 check((await api('/recovery/email/start',{token:secondMail.link})).status===400,'OTP consumption invalidates its alternative link');
 const cancelRow=(await db.prepare('SELECT * FROM auth_email_outbox WHERE user_id=? ORDER BY created_at DESC').all(a.id)).find(r=>r.subject.startsWith('Cảnh báo:'));
 const cancelText=sec.decryptMail(cancelRow.body_cipher),cancelToken=new URLSearchParams(new URL(cancelText.match(/https?:\/\/\S+/)[0]).hash.split('?')[1]).get('token');
 must(await api('/recovery/cancel',{token:cancelToken}));
 check((await db.prepare('SELECT account_status FROM users WHERE id=?').get(a.id)).account_status==='ACTIVE','existing cancellation link still restores the old account');
 check((await api('/recovery/email/verify',{requestToken:second.requestToken,code:secondMail.code})).status===400,'cancelled request cannot be restarted with consumed OTP');
 const b=await user('expiry');await advanceRequestWindow(b);const expiring=await request(b),expiryMail=await latest(b);
 await db.prepare('UPDATE auth_links SET expires_at=? WHERE token_hash=?').run(new Date(Date.now()-1000).toISOString(),sec.hash(expiring.requestToken));
 check((await api('/recovery/email/verify',{requestToken:expiring.requestToken,code:expiryMail.code})).status===400,'expired email OTP cannot start recovery');
 const c=await user('cap');
 for(let batch=0;batch<4;batch++){
  await advanceRequestWindow(c);const r=await request(c),m=await latest(c),bad=m.code==='000000'?'111111':'000000';
  for(let i=0;i<5;i++)await api('/recovery/email/verify',{requestToken:r.requestToken,code:bad});
 }
 check((await db.prepare('SELECT COUNT(*) AS n FROM auth_otp_failures WHERE user_id=?').get(c.id)).n===20,'recovery resend does not reset the rolling 24-hour failure total');
 await advanceRequestWindow(c);const capped=await request(c),capMail=await latest(c);
 const locked=await api('/recovery/email/verify',{requestToken:capped.requestToken,code:capMail.code});
 check(locked.status===429&&locked.data.error==='RECOVERY_EMAIL_CODE_LOCKED'&&Number(locked.retry)>0,'rolling OTP lock rejects even a valid new code');
 must(await api('/recovery/email/start',{token:capMail.link}));
 check((await db.prepare('SELECT account_status FROM users WHERE id=?').get(c.id)).account_status==='RECOVERING','high-entropy confirmation link remains available when short OTP is locked');
 check((await db.prepare('SELECT COUNT(*) AS n FROM auth_recovery_codes WHERE user_id=?').get(c.id)).n===0,'email recovery requires no stored backup codes');
 const d=await user('emailchange');await advanceRequestWindow(d);const changed=await request(d),changedMail=await latest(d);
 await db.prepare('UPDATE users SET email=? WHERE id=?').run('changed-recovery@example.test',d.id);
 check((await api('/recovery/email/verify',{requestToken:changed.requestToken,code:changedMail.code})).status===400,'OTP issued to an old email cannot recover after the account email changes');
 check((await api('/recovery/email/start',{token:changedMail.link})).status===409,'alternative link is also bound to the verified recipient email');
 console.log('EMAIL RECOVERY: '+checks+' checks passed');
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(server)await new Promise(r=>server.close(r));if(db)await db.close();});
