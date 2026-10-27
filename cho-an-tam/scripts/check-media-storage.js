'use strict';

// Read-only release check. Deliberately does not load dotenv, create a bucket,
// upload an object, print a credential, or fall back to local storage.
const allowed = new Set(['--probe', '--help']);
if (process.argv.slice(2).some(arg => !allowed.has(arg))) {
  console.error('Usage: node scripts/check-media-storage.js [--probe]');
  process.exitCode = 2;
} else if (process.argv.includes('--help')) {
  console.log('Check MEDIA_STORAGE_URL, MEDIA_STORAGE_SERVICE_KEY and optional MEDIA_STORAGE_BUCKET from the existing process environment.');
  console.log('--probe also performs a read-only authenticated bucket-privacy check; no files are written. Secrets are never printed.');
} else {
  const configured = {
    url: Boolean(process.env.MEDIA_STORAGE_URL),
    serviceKey: Boolean(process.env.MEDIA_STORAGE_SERVICE_KEY),
    bucket: process.env.MEDIA_STORAGE_BUCKET ? 'explicit' : 'default-enclave-media',
  };
  let validUrl = false;
  try {
    const url = new URL(process.env.MEDIA_STORAGE_URL || '');
    validUrl = url.protocol === 'https:' && url.hostname.endsWith('.supabase.co') &&
      !url.username && !url.password && !url.search && !url.hash && ['', '/'].includes(url.pathname);
  } catch { /* report validity only, never echo the provided URL */ }
  const validBucket = /^[a-z0-9][a-z0-9-]{0,62}$/.test(process.env.MEDIA_STORAGE_BUCKET || 'enclave-media');
  const ready = configured.url && configured.serviceKey && validUrl && validBucket;
  if (!ready) {
    console.log(JSON.stringify({ configuration: 'not-ready', configured, validUrl, validBucket, privateBucket: 'not-checked' }));
    process.exitCode = 2;
  } else if (!process.argv.includes('--probe')) {
    console.log(JSON.stringify({ configuration: 'present', configured, validUrl, validBucket, privateBucket: 'not-checked', writeAccess: 'not-tested' }));
  } else {
    require('../src/lib/mediaStorage').getMediaStorage().then(() => {
      console.log(JSON.stringify({ configuration: 'present', privateBucket: true, writeAccess: 'not-tested', operation: 'read-only' }));
    }).catch(() => {
      console.log(JSON.stringify({ configuration: 'present', privateBucket: 'not-confirmed', operation: 'read-only', error: 'MEDIA_STORAGE_UNAVAILABLE' }));
      process.exitCode = 1;
    });
  }
}
