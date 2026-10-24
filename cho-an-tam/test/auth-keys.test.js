const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const keys=require('../src/lib/authKeys');

test('versioned auth keys retain old digests/ciphertexts and reject tampering',()=>{
  const names=['AUTH_SECRET_PEPPER_KEYS','AUTH_SECRET_PEPPER_KEY_ID','AUTH_SECRET_PEPPER','AUTH_MAIL_ENCRYPTION_KEYS','AUTH_MAIL_KEY_ID','AUTH_MAIL_ENCRYPTION_KEY','AUTH_PUBLIC_URL','APP_ENV','NODE_ENV','EMAIL_RECOVERY_WAIT_SECONDS','EMAIL_RECOVERY_RESTRICT_SECONDS','ORDER_INSPECTION_SECONDS'];
  const saved=Object.fromEntries(names.map(name=>[name,process.env[name]]));
  try {
    const first=crypto.randomBytes(32).toString('hex'),second=crypto.randomBytes(32).toString('hex');
    Object.assign(process.env,{AUTH_SECRET_PEPPER_KEYS:JSON.stringify({v1:first}),AUTH_SECRET_PEPPER_KEY_ID:'v1',AUTH_SECRET_PEPPER:first,AUTH_MAIL_ENCRYPTION_KEYS:JSON.stringify({v1:first}),AUTH_MAIL_KEY_ID:'v1',AUTH_MAIL_ENCRYPTION_KEY:first});
    const digest=keys.digest('fixture-otp'),cipher=keys.encrypt('fixture-email-token');
    assert.ok(digest.startsWith('v1:'));assert.ok(cipher.startsWith('v1:'));
    Object.assign(process.env,{AUTH_SECRET_PEPPER_KEYS:JSON.stringify({v1:first,v2:second}),AUTH_SECRET_PEPPER_KEY_ID:'v2',AUTH_MAIL_ENCRYPTION_KEYS:JSON.stringify({v1:first,v2:second}),AUTH_MAIL_KEY_ID:'v2'});
    assert.ok(keys.matches('fixture-otp',digest));assert.equal(keys.matches('wrong',digest),false);
    assert.equal(keys.decrypt(cipher),'fixture-email-token');assert.ok(keys.digest('next').startsWith('v2:'));
    assert.throws(()=>keys.decrypt(cipher.replace(/^v1:/,'v2:')));
    const legacy=crypto.createHmac('sha256',first).update('legacy').digest('hex');assert.ok(keys.matches('legacy',legacy));
    const iv=crypto.randomBytes(12),enc=crypto.createCipheriv('aes-256-gcm',crypto.createHash('sha256').update(first).digest(),iv);
    const data=Buffer.concat([enc.update('legacy-mail','utf8'),enc.final()]);
    assert.equal(keys.decrypt(Buffer.concat([iv,enc.getAuthTag(),data]).toString('base64')),'legacy-mail');
    process.env.AUTH_SECRET_PEPPER_KEYS=JSON.stringify({v2:second});assert.equal(keys.matches('fixture-otp',digest),false);
    process.env.AUTH_MAIL_ENCRYPTION_KEYS=JSON.stringify({v2:second});assert.throws(()=>keys.decrypt(cipher),/KEY_MISSING/);
    Object.assign(process.env,{APP_ENV:'production',NODE_ENV:'production',AUTH_PUBLIC_URL:'https://enclave.example/',EMAIL_RECOVERY_WAIT_SECONDS:'86400',EMAIL_RECOVERY_RESTRICT_SECONDS:'259200',ORDER_INSPECTION_SECONDS:'86400'});keys.validateProduction();
    for(const name of ['EMAIL_RECOVERY_WAIT_SECONDS','EMAIL_RECOVERY_RESTRICT_SECONDS','ORDER_INSPECTION_SECONDS']){
      const original=process.env[name];process.env[name]='30';assert.throws(()=>keys.validateProduction(),/PRODUCTION_TIMER_INVALID/);process.env[name]=original;
    }
    process.env.AUTH_PUBLIC_URL='http://enclave.example/';assert.throws(()=>keys.validateProduction(),/PUBLIC_URL_INVALID/);
  }finally{for(const name of names){if(saved[name]===undefined)delete process.env[name];else process.env[name]=saved[name];}}
});
