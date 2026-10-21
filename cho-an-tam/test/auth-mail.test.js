const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const fixtureKey=crypto.randomBytes(32).toString('hex');
Object.assign(process.env,{APP_ENV:'test',NODE_ENV:'test',DATABASE_URL:'',DB_PATH:path.join(fs.mkdtempSync(path.join(os.tmpdir(),'enclave-mail-test-')),'mail.db'),JWT_SECRET:fixtureKey,AUTH_SECRET_PEPPER:fixtureKey,AUTH_SECRET_PEPPER_KEYS:JSON.stringify({v1:fixtureKey}),AUTH_SECRET_PEPPER_KEY_ID:'v1',AUTH_MAIL_ENCRYPTION_KEY:fixtureKey,AUTH_MAIL_ENCRYPTION_KEYS:JSON.stringify({v1:fixtureKey}),AUTH_MAIL_KEY_ID:'v1',AUTH_EMAIL_TRANSPORT:'resend',RESEND_API_KEY:'test-placeholder-no-external-call',AUTH_EMAIL_FROM:'Enclave <security@example.test>',AUTH_PUBLIC_URL:'https://enclave.example/'});
const {db,nowIso}=require('../src/db'),sec=require('../src/lib/accountSecurity');
test('Resend encrypted outbox retries safely with stable idempotency key, no real network',async()=>{
 try{
  await db.prepare("INSERT INTO users(id,username,display_name,role,password_hash,account_status,email) VALUES('mail-user','mail_user','Người thử','BUYER','fixture-only','PENDING_EMAIL','mail@example.test')").run();
  await sec.queueMail({id:'mail-user',email:'mail@example.test'},'Mã xác minh thử','Mã xác minh: 123456. Hiệu lực 10 phút.');
  const first=await db.prepare('SELECT * FROM auth_email_outbox').get();assert.ok(!first.body_cipher.includes('123456'));
  const calls=[];
  const fakeFetch=async(url,options)=>{calls.push({url,options});return {ok:calls.length>1,status:calls.length>1?200:429,headers:new Headers({'retry-after':'60'})};};
  const {deliverEmails}=require('../src/lib/authJobs');
  await deliverEmails({fetchImpl:fakeFetch});
  const waiting=await db.prepare('SELECT * FROM auth_email_outbox').get();assert.equal(waiting.sent_at,null);assert.ok(Date.parse(waiting.next_attempt_at)>Date.now());assert.equal(waiting.last_error,'RESEND_HTTP_429');
  await db.prepare('UPDATE auth_email_outbox SET next_attempt_at=?').run(nowIso());
  await deliverEmails({fetchImpl:fakeFetch});
  const sent=await db.prepare('SELECT * FROM auth_email_outbox').get();assert.ok(sent.sent_at);assert.equal(sent.body_cipher,'');assert.equal(calls.length,2);
  assert.equal(calls[0].url,'https://api.resend.com/emails');assert.equal(calls[0].options.headers['Idempotency-Key'],calls[1].options.headers['Idempotency-Key']);
  assert.equal(JSON.parse(calls[0].options.body).text,'Mã xác minh: 123456. Hiệu lực 10 phút.');
  const user={id:'mail-user',email:'mail@example.test'};
  await sec.queueMail(user,'Expired','Expired secret',user.email,{expiresAt:new Date(Date.now()-1000).toISOString()});
  await sec.queueMail(user,'Too old','Old secret');
  await db.prepare("UPDATE auth_email_outbox SET created_at=? WHERE subject='Too old'").run(new Date(Date.now()-25*3600000).toISOString());
  await sec.queueMail(user,'Key rotation','Queued before rotation');
  process.env.AUTH_MAIL_ENCRYPTION_KEYS=JSON.stringify({v1:fixtureKey,v2:crypto.randomBytes(32).toString('hex')});process.env.AUTH_MAIL_KEY_ID='v2';
  const rotationCalls=[];
  const fakeSuccess=async(url,options)=>{rotationCalls.push(JSON.parse(options.body));return {ok:true,status:200,headers:new Headers()};};
  await Promise.all([deliverEmails({fetchImpl:fakeSuccess}),deliverEmails({fetchImpl:fakeSuccess})]);
  assert.equal(rotationCalls.length,1,'parallel workers claim a live row once and skip expired/old messages');
  assert.equal(rotationCalls[0].text,'Queued before rotation','old-key outbox decrypts after key rotation');
  await require('../src/lib/authJobs').processAuthMaintenance();
  for(const subject of ['Expired','Too old']){
    const purged=await db.prepare('SELECT * FROM auth_email_outbox WHERE subject=?').get(subject);
    assert.equal(purged.body_cipher,'');assert.equal(purged.sent_at,null);assert.equal(purged.last_error,'EMAIL_EXPIRED');
  }
  console.log('MAIL: retry, shared lease, key rotation, expired/old secret purge PASS');
 }finally{await db.close();}
});
test('public refresh cookies stay Secure behind TLS termination even without req.secure',()=>{
 const saved=process.env.NODE_ENV;
 try{
  process.env.NODE_ENV='production';
  const cookies=[],res={append:(name,value)=>cookies.push(value)},session=require('../src/lib/session');
  session.setRefreshCookie({secure:false},res,'fixture-only-token');session.clearRefreshCookie({secure:false},res);
  for(const cookie of cookies){assert.match(cookie,/; Secure(?:;|$)/);assert.match(cookie,/HttpOnly; SameSite=Strict/);assert.match(cookie,/Path=\/api\/passkeys\/session/);}
 }finally{if(saved===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=saved;}
});
