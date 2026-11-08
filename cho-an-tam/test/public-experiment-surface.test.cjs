'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const express = require('express');
const { blockPublicExperiments } = require('../src/lib/experimentSurface');
const appRoot = path.resolve(__dirname, '..');

test('Deployed public tree contains no session/grant collector or archived fixture', () => {
  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const name = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(name); else files.push(name);
    }
  }
  walk(path.join(appRoot, 'public'));
  for (const file of files) {
    assert.ok(!/[/\\]experiments[/\\]/i.test(file), file);
    if (!/\.(html|js|json|css)$/i.test(file)) continue;
    const content = fs.readFileSync(file, 'utf8');
    assert.ok(!/ENCLAVE-S[12]:|ENCLAVE-S[12]-1|Sao chép phiên thử nghiệm|Sao chép gói xác nhận/.test(content), file);
  }
  for (const name of ['s1.html', 's1.js', 's2.html', 's2.js', 's2.css']) {
    assert.ok(fs.existsSync(path.join(__dirname, 'fixtures/experiment-browser', name)), 'Keep research source outside deployment.');
  }
  const docker = fs.readFileSync(path.join(appRoot, '../Dockerfile'), 'utf8');
  assert.doesNotMatch(docker, /^COPY\s+(?:\.\s|cho-an-tam\/?\s|cho-an-tam\/test)/im);
  const vercel = JSON.parse(fs.readFileSync(path.join(appRoot, 'public/vercel.json'), 'utf8'));
  assert.ok(vercel.headers.some(rule => rule.source === '/experiments/:path*' && rule.headers.some(header => header.key === 'Cache-Control' && header.value.includes('no-store'))));
});

const blockedPaths = ['/experiments', '/experiments/', '/experiments/s1.html', '/experiments/s2.js',
  '/EXPERIMENTS/s1.html', '/%65xperiments/s1.html', '/experiments%2fs2.html',
  '//experiments//s1.html', '/unused/../experiments/s1.html', '/%2e/experiments/s1.html',
  '/experiments%5cs1.html', '/experiments/s1.html?cache=old', '/experiments/%invalid'];

test('Guard rejects the entire namespace before downstream handlers for every method', () => {
  for (const url of blockedPaths) for (const method of ['GET', 'HEAD', 'POST', 'OPTIONS']) {
    let status, body, called = false; const headers = {};
    const res = { setHeader(key, value) { headers[key] = value; }, status(value) { status = value; return this; }, json(value) { body = value; return this; } };
    blockPublicExperiments({ originalUrl: url, method }, res, () => { called = true; });
    assert.equal(called, false, method + ' ' + url); assert.equal(status, 404, url);
    assert.equal(body.error, 'NOT_FOUND'); assert.match(headers['Cache-Control'], /no-store/);
  }
});

test('Ordinary pages, APIs and query strings retain their normal route', () => {
  for (const url of ['/', '/index.html', '/js/app.js', '/health', '/api/users/me', '/api/transactions/example/release', '/api/passkeys/session/refresh', '/api/listings?q=/experiments/s1.html', '/experiments-other']) {
    let next = 0;
    blockPublicExperiments({ originalUrl: url }, { setHeader() { throw new Error('Normal responses must not be modified.'); } }, () => { next++; });
    assert.equal(next, 1, url);
  }
});

test('Real HTTP cannot expose an accidentally reintroduced static collector', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'enclave-public-surface-'));
  const dir = path.join(temp, 'experiments'), file = path.join(dir, 's1.html');
  fs.mkdirSync(dir); fs.writeFileSync(file, 'SYNTHETIC_COLLECTOR_MUST_NOT_BE_SERVED');
  const app = express(); let downstream = 0;
  app.use(blockPublicExperiments); app.use(express.json()); app.use(express.static(temp));
  app.get('/health', (req, res) => { downstream++; res.json({ status: 'OK' }); });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.unlinkSync(file); fs.rmdirSync(dir); fs.rmdirSync(temp);
  });
  function request(url, method = 'GET') {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: url, method,
        headers: { Origin: 'https://enclave.id.vn', 'Content-Type': 'application/json' } }, res => {
        let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
      });
      req.on('error', reject); req.end(method === 'POST' ? '{' : undefined);
    });
  }
  for (const url of blockedPaths) {
    const reply = await request(url); assert.equal(reply.status, 404, url);
    assert.equal(JSON.parse(reply.body).error, 'NOT_FOUND'); assert.doesNotMatch(reply.body, /SYNTHETIC_COLLECTOR/);
  }
  for (const method of ['POST', 'HEAD', 'OPTIONS']) assert.equal((await request('/experiments/s1.html', method)).status, 404);
  const health = await request('/health'); assert.equal(health.status, 200); assert.equal(downstream, 1);
});
