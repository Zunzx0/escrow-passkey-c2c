'use strict';

// REST boundary tests, no real network/DB/dotenv. Every fetch is replaced before
// the adapter is called; credentials below are disposable synthetic fixtures.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const media = require('../src/lib/mediaStorage');

test('private media REST adapter boundaries (fake fetch; no Supabase access)', async t => {
  const names = ['APP_ENV', 'MEDIA_STORAGE_URL', 'MEDIA_STORAGE_SERVICE_KEY', 'MEDIA_STORAGE_BUCKET'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const oldFetch = global.fetch;
  const oldNow = Date.now;
  const calls = [];
  const bytes = Buffer.from('canonical-synthetic-webp-fixture');
  let fixtureResponse;
  let counter = 0;
  const key = 'fixture-service-key-not-a-real-credential';
  global.fetch = async (url, options) => {
    calls.push({url: String(url), options});
    return fixtureResponse(String(url), options);
  };
  process.env.APP_ENV = 'test';
  media.setMediaStorageForTests(null);
  function configure() {
    process.env.MEDIA_STORAGE_URL = 'https://fixture-project.supabase.co';
    process.env.MEDIA_STORAGE_SERVICE_KEY = key;
    process.env.MEDIA_STORAGE_BUCKET = 'fixture-private-' + (++counter);
    calls.length = 0;
    fixtureResponse = async url => url.includes('/bucket/')
      ? new Response(JSON.stringify({public: false}), {headers: {'Content-Type': 'application/json'}})
      : new Response(bytes, {headers: {'Content-Type': 'image/webp'}});
  }
  const unavailable = error => error.status === 503 && error.code === 'MEDIA_STORAGE_UNAVAILABLE' &&
    !error.message.includes(key);
  try {
    await t.test('missing/invalid config never sends a request', async () => {
      configure();
      delete process.env.MEDIA_STORAGE_SERVICE_KEY;
      await assert.rejects(media.getMediaStorage(), unavailable);
      assert.equal(calls.length, 0);
      process.env.MEDIA_STORAGE_SERVICE_KEY = key;
      for (const url of ['http://fixture.supabase.co', 'https://other.example',
        'https://fixture.supabase.co.evil.example', 'https://user:password@fixture.supabase.co',
        'https://fixture.supabase.co/path', 'https://fixture.supabase.co/?key=fixture']) {
        process.env.MEDIA_STORAGE_URL = url;
        await assert.rejects(media.getMediaStorage(), unavailable);
        assert.equal(calls.length, 0);
      }
      configure();
      process.env.MEDIA_STORAGE_BUCKET = '../public';
      await assert.rejects(media.getMediaStorage(), unavailable);
      assert.equal(calls.length, 0);
    });

    await t.test('public or malformed bucket response is rejected and never positively cached', async () => {
      configure();
      fixtureResponse = async () => new Response(JSON.stringify({public: true}));
      await assert.rejects(media.getMediaStorage(), unavailable);
      await assert.rejects(media.getMediaStorage(), unavailable);
      assert.equal(calls.length, 2);
      fixtureResponse = async () => new Response('not-json');
      await assert.rejects(media.getMediaStorage(), unavailable);
      assert.equal(calls.length, 3);
    });

    await t.test('private bucket read/upload/download/delete use fixed paths and reject redirects', async () => {
      configure();
      const bucket = process.env.MEDIA_STORAGE_BUCKET;
      const objectKey = 'listing/12345678-1234-1234-1234-123456789abc.webp';
      const store = await media.getMediaStorage();
      assert.deepEqual(await store.get(objectKey), bytes);
      await store.put(objectKey, bytes);
      await store.remove(objectKey);
      assert.deepEqual(calls.map(call => new URL(call.url).pathname), [
        '/storage/v1/bucket/' + bucket,
        '/storage/v1/object/authenticated/' + bucket + '/' + objectKey,
        '/storage/v1/object/' + bucket + '/' + objectKey,
        '/storage/v1/object/' + bucket,
      ]);
      for (const call of calls) {
        assert.equal(new URL(call.url).origin, 'https://fixture-project.supabase.co');
        assert.equal(call.options.redirect, 'error');
        assert.equal(call.options.headers.apikey, key);
        assert.equal(call.options.headers.Authorization, 'Bearer ' + key);
        assert.ok(call.options.signal instanceof AbortSignal);
      }
      assert.equal(calls[2].options.headers['x-upsert'], 'false');
      assert.equal(calls[2].options.headers['Content-Type'], 'image/webp');
      assert.deepEqual(JSON.parse(calls[3].options.body), {prefixes: [objectKey]});
      fixtureResponse = async () => new Response('', {status: 307, headers: {Location: 'https://other.example/'}});
      await assert.rejects(store.get(objectKey), unavailable);
      assert.equal(calls.length, 5, 'no second request to redirect destination');
    });

    await t.test('invalid object keys are never sent to storage', async () => {
      configure();
      const store = await media.getMediaStorage();
      for (const objectKey of ['../other.webp', 'listing/../../other.webp',
        'listing/12345678-1234-1234-1234-123456789abc.svg',
        'evidence/12345678-1234-1234-1234-123456789abc.webp?token=fixture']) {
        await assert.rejects(store.get(objectKey), unavailable);
        await assert.rejects(store.put(objectKey, bytes), unavailable);
        await assert.rejects(store.remove(objectKey), unavailable);
      }
      assert.equal(calls.length, 1, 'only the initial bucket probe was allowed');
    });

    await t.test('download has both declared-size and streaming-size bounds', async () => {
      configure();
      const store = await media.getMediaStorage();
      const objectKey = 'evidence/12345678-1234-1234-1234-123456789abc.webp';
      fixtureResponse = async () => new Response('small', {headers: {'Content-Length': String(512 * 1024 + 1)}});
      await assert.rejects(store.get(objectKey), unavailable);
      fixtureResponse = async () => new Response(Buffer.alloc(512 * 1024 + 1), {headers: {'Content-Length': '1'}});
      await assert.rejects(store.get(objectKey), unavailable);
    });

    await t.test('transport failures and provider error payloads are sanitized', async () => {
      configure();
      const store = await media.getMediaStorage();
      const objectKey = 'listing/12345678-1234-1234-1234-123456789abc.webp';
      fixtureResponse = async () => { throw new Error('transport echoed credential ' + key); };
      await assert.rejects(store.put(objectKey, bytes), unavailable);
      fixtureResponse = async () => new Response('provider body echoed ' + key, {status: 500});
      await assert.rejects(store.get(objectKey), unavailable);
      await assert.rejects(store.put(objectKey, bytes), unavailable);
      await assert.rejects(store.remove(objectKey), unavailable);
    });

    await t.test('positive privacy cache expires, and a later public response is denied', async () => {
      configure();
      let clock = oldNow();
      Date.now = () => clock;
      await media.getMediaStorage();
      await media.getMediaStorage();
      assert.equal(calls.length, 1);
      clock += 61000;
      fixtureResponse = async () => new Response(JSON.stringify({public: true}));
      await assert.rejects(media.getMediaStorage(), unavailable);
      assert.equal(calls.length, 2);
    });
  } finally {
    global.fetch = oldFetch;
    Date.now = oldNow;
    media.setMediaStorageForTests(null);
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
});
