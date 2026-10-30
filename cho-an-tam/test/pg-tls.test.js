'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const tls = require('node:tls');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { Client } = require('pg');
const { pgConnectionConfig } = require('../src/lib/pgTls');

const remote = 'postgresql://fixture:synthetic-password@database.example.test/postgres';
const production = { NODE_ENV: 'production' };
const parsed = (url, env) => new Client(pgConnectionConfig(url, env)).connectionParameters;

test('remote database requires certificate and hostname validation by default', () => {
  const c = parsed(remote, production);
  assert.equal(c.ssl.rejectUnauthorized, true);
  assert.equal(c.ssl.checkServerIdentity, undefined);
  assert.ok(c.ssl.ca.length > 1);
  assert.ok(c.ssl.ca.some(cert => new crypto.X509Certificate(cert).fingerprint256 === '80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA'));
});

test('SSL query parameters cannot replace the effective CA or weaken verification', () => {
  for (const mode of ['no-verify', 'prefer', 'require', 'verify-ca', 'verify-full']) {
    const c = parsed(remote + '?sslmode=' + mode + '&uselibpqcompat=true', production);
    assert.equal(c.ssl.rejectUnauthorized, true, mode);
    assert.ok(Array.isArray(c.ssl.ca), mode);
    assert.equal(c.ssl.checkServerIdentity, undefined, mode);
  }
  for (const query of ['ssl=no-verify', 'ssl=true', 'sslnegotiation=direct', 'sslcert=/not/read&sslkey=/not/read&sslrootcert=/not/read']) {
    const c = parsed(remote + '?' + query, production);
    assert.equal(c.ssl.rejectUnauthorized, true, query);
    assert.ok(Array.isArray(c.ssl.ca), query);
  }
});

test('unencrypted PostgreSQL is allowed only for explicit non-production loopback tests', () => {
  for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
    const url = `postgresql://fixture@${host}/postgres`;
    assert.equal(parsed(url, { NODE_ENV: 'test', PGSSL: 'disable' }).ssl, false);
    assert.equal(parsed(url + '?sslmode=disable', { NODE_ENV: 'test' }).ssl, false);
    assert.throws(() => parsed(url, { NODE_ENV: 'production', PGSSL: 'disable' }), { code: 'PG_TLS_CONFIG' });
  }
  for (const host of ['database.example.test', 'localhost.evil.test', '127.0.0.2']) {
    assert.throws(() => parsed(`postgresql://fixture@${host}/postgres?sslmode=disable`, { NODE_ENV: 'test' }), { code: 'PG_TLS_CONFIG' });
  }
  assert.throws(() => parsed('postgresql://fixture@127.0.0.1/postgres?host=127.0.0.1&host=database.example.test', { NODE_ENV: 'test', PGSSL: 'disable' }), { code: 'PG_TLS_CONFIG' });
});

test('malformed configuration does not echo credentials in error objects', () => {
  for (const input of ['not-a-url-synthetic-password', 'https://fixture:synthetic-password@example.test/', remote + '?sslmode=disable']) {
    assert.throws(() => pgConnectionConfig(input, production), error => error.code === 'PG_TLS_CONFIG' && !String(error).includes('synthetic-password') && !error.input && !error.cause);
  }
});

let fixtureDir, fixtureKey, fixtureCert;
before(() => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enclave-pg-tls-'));
  const executable = process.env.TEST_OPENSSL || (process.platform === 'win32' && fs.existsSync('E:/Git/usr/bin/openssl.exe') ? 'E:/Git/usr/bin/openssl.exe' : 'openssl');
  const key = path.join(fixtureDir, 'synthetic-key.pem'), cert = path.join(fixtureDir, 'synthetic-cert.pem');
  const generated = spawnSync(executable, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=wrong.example.test', '-addext', 'subjectAltName=DNS:wrong.example.test'], { windowsHide: true, encoding: 'utf8', timeout: 30000 });
  assert.equal(generated.status, 0, 'OpenSSL must generate the temporary synthetic certificate');
  fixtureKey = fs.readFileSync(key); fixtureCert = fs.readFileSync(cert);
});
after(() => {
  if (fixtureKey) fixtureKey.fill(0);
  if (fixtureDir) {
    const resolved = path.resolve(fixtureDir);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(resolved).startsWith('enclave-pg-tls-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

async function rejectedHandshake(trustSyntheticRoot) {
  const sockets = new Set(); let offeredTls = false, applicationBytes = 0;
  const context = tls.createSecureContext({ key: fixtureKey, cert: fixtureCert });
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('error', () => {});
    socket.once('data', packet => {
      assert.equal(packet.readInt32BE(4), 80877103, 'client requests PostgreSQL SSL before startup/authentication');
      offeredTls = true; socket.write('S');
      const secured = new tls.TLSSocket(socket, { isServer: true, secureContext: context });
      sockets.add(secured); secured.on('error', () => {});
      secured.on('data', data => { applicationBytes += data.length; });
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = pgConnectionConfig(`postgresql://fixture:synthetic-password@127.0.0.1:${server.address().port}/postgres`, production);
  if (trustSyntheticRoot) config.ssl.ca = [fixtureCert]; // Trust only this disposable test CA to isolate hostname checks.
  const client = new Client({ ...config, connectionTimeoutMillis: 3000 });
  try {
    await assert.rejects(client.connect(), error => trustSyntheticRoot ? error.code === 'ERR_TLS_CERT_ALTNAME_INVALID' : ['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN'].includes(error.code));
    assert.equal(offeredTls, true);
    assert.equal(applicationBytes, 0, 'no database startup or password payload reaches the untrusted server');
  } finally {
    await client.end().catch(() => {});
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
}

test('real pg TLS handshake rejects an untrusted certificate before authentication', { timeout: 10000 }, () => rejectedHandshake(false));
test('real pg TLS handshake rejects a trusted certificate with the wrong hostname', { timeout: 10000 }, () => rejectedHandshake(true));
