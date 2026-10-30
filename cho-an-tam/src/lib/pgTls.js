'use strict';

const fs = require('node:fs');
const path = require('node:path');
const tls = require('node:tls');

const ca = [...tls.rootCertificates, fs.readFileSync(path.join(__dirname, '../certs/supabase-prod-ca-2021.crt'), 'utf8')];
const loopback = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function configError() {
  const error = new Error('Cấu hình kết nối PostgreSQL không an toàn hoặc không hợp lệ.');
  error.code = 'PG_TLS_CONFIG';
  return error;
}

function pgConnectionConfig(connectionString, env = process.env) {
  let url;
  try { url = new URL(connectionString); } catch { throw configError(); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw configError();
  const host = (url.searchParams.getAll('host').at(-1) || url.hostname).toLowerCase();
  const disable = env.PGSSL === 'disable' || url.searchParams.get('sslmode') === 'disable' || ['0', 'false'].includes(url.searchParams.get('ssl'));
  if (disable && (env.NODE_ENV === 'production' || !loopback.has(host))) throw configError();

  // pg parses SSL query parameters after config.ssl and replaces it. Remove all such
  // overrides, including direct negotiation and libpq compatibility, so the CA and
  // hostname checks below remain effective. Never read a key/cert path from the URL.
  for (const name of [...url.searchParams.keys()]) {
    if (/^ssl/i.test(name) || name.toLowerCase() === 'uselibpqcompat') url.searchParams.delete(name);
  }
  return {
    connectionString: url.toString(),
    ssl: disable ? false : { rejectUnauthorized: true, ca },
  };
}

module.exports = { pgConnectionConfig };
