const crypto = require('node:crypto');

const TYPES = {
  pepper: ['AUTH_SECRET_PEPPER_KEYS', 'AUTH_SECRET_PEPPER_KEY_ID', 'AUTH_SECRET_PEPPER'],
  mail: ['AUTH_MAIL_ENCRYPTION_KEYS', 'AUTH_MAIL_KEY_ID', 'AUTH_MAIL_ENCRYPTION_KEY'],
};
function keyset(type) {
  const [mapName, idName, singleName] = TYPES[type];
  const current = process.env[idName] || 'v1';
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(current)) throw new Error('AUTH_KEY_ID_INVALID');
  let keys;
  try { keys = process.env[mapName] ? JSON.parse(process.env[mapName]) : null; }
  catch { throw new Error('AUTH_KEYRING_INVALID'); }
  if (keys && (typeof keys !== 'object' || Array.isArray(keys))) throw new Error('AUTH_KEYRING_INVALID');
  const legacy = process.env[singleName] || process.env.JWT_SECRET || (type==='mail'?'local-only-mail-key':'local-only-auth-pepper');
  if (!keys) keys = { [current]: legacy };
  if (typeof keys[current] !== 'string' || !keys[current]) throw new Error('AUTH_CURRENT_KEY_MISSING');
  for (const [id, key] of Object.entries(keys)) {
    if (!/^[a-zA-Z0-9_-]{1,32}$/.test(id) || typeof key !== 'string' || !key) throw new Error('AUTH_KEYRING_INVALID');
  }
  return { current, keys, legacy };
}
function digest(value) {
  const { current, keys } = keyset('pepper');
  return `${current}:${crypto.createHmac('sha256', keys[current]).update(String(value)).digest('hex')}`;
}
function matches(value, stored) {
  if (typeof stored !== 'string') return false;
  const { keys, legacy } = keyset('pepper');
  const parts = stored.split(':');
  const key = parts.length === 1 ? legacy : parts.length === 2 ? keys[parts[0]] : null;
  const hex = parts.at(-1);
  if (!key || !/^[a-f0-9]{64}$/.test(hex)) return false;
  const actual = crypto.createHmac('sha256', key).update(String(value)).digest();
  return crypto.timingSafeEqual(actual, Buffer.from(hex, 'hex'));
}
function encrypt(body) {
  const { current, keys } = keyset('mail');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', crypto.createHash('sha256').update(keys[current]).digest(), iv);
  cipher.setAAD(Buffer.from(`enclave-auth-mail:${current}`));
  const data = Buffer.concat([cipher.update(body, 'utf8'), cipher.final()]);
  return `${current}:${Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64')}`;
}
function decrypt(body) {
  const { keys, legacy } = keyset('mail');
  const parts = String(body).split(':');
  const key = parts.length === 1 ? legacy : parts.length === 2 ? keys[parts[0]] : null;
  if (!key) throw new Error('AUTH_DECRYPT_KEY_MISSING');
  const data = Buffer.from(parts.at(-1), 'base64');
  if (data.length < 28) throw new Error('AUTH_CIPHERTEXT_INVALID');
  const cipher = crypto.createDecipheriv('aes-256-gcm', crypto.createHash('sha256').update(key).digest(), data.subarray(0, 12));
  if (parts.length === 2) cipher.setAAD(Buffer.from(`enclave-auth-mail:${parts[0]}`));
  cipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8');
}
function validateProduction() {
  if (process.env.APP_ENV !== 'production' && process.env.NODE_ENV !== 'production') return;
  for (const type of Object.keys(TYPES)) {
    const [mapName, , singleName] = TYPES[type];
    if (!process.env[mapName] && !process.env[singleName]) throw new Error('AUTH_PRODUCTION_KEY_REQUIRED');
    const { keys } = keyset(type);
    if (Object.values(keys).some(key => Buffer.byteLength(key) < 32)) throw new Error('AUTH_PRODUCTION_KEY_TOO_SHORT');
  }
  const url = new URL(process.env.AUTH_PUBLIC_URL || '');
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('AUTH_PUBLIC_URL_INVALID');
  // A leftover local-test override must never shorten public account-recovery protection.
  for (const [name,minimum] of Object.entries({EMAIL_RECOVERY_WAIT_SECONDS:86400,EMAIL_RECOVERY_RESTRICT_SECONDS:259200,ORDER_INSPECTION_SECONDS:86400})) {
    if (process.env[name] === undefined || process.env[name] === '') continue;
    const value=Number(process.env[name]);
    if (!Number.isSafeInteger(value) || value < minimum) throw new Error('AUTH_PRODUCTION_TIMER_INVALID: '+name);
  }
}
module.exports = { digest, matches, encrypt, decrypt, validateProduction };
