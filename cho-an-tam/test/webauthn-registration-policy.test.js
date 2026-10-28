// Pure real WebAuthn verification of synthetic attestation data; no DB/network.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { generateRegistrationOptions, verifyRegistrationResponse } = require('../src/lib/webauthnRegistration');
const { encodeCoseEc2Key, encodeAttestationObjectNone, encodeMapHeader, encodeInt, encodeBytes } = require('./minicbor');
const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'jwk' });
const ed = crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' });
const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' });
const from = value => Buffer.from(value, 'base64url');
function cose(entries) {
  return Buffer.concat([encodeMapHeader(entries.length), ...entries.flatMap(([key, value]) => [encodeInt(key), typeof value === 'number' ? encodeInt(value) : encodeBytes(value)])]);
}
function key(alg) {
  if (alg === -8) return cose([[1, 1], [3, -8], [-1, 6], [-2, from(ed.x)]]);
  if (alg === -7) return encodeCoseEc2Key({ x: from(ec.x), y: from(ec.y) });
  return cose([[1, 3], [3, alg], [-1, from(rsa.n)], [-2, from(rsa.e)]]);
}
function response(alg, { origin = 'https://enclave.example', rpId = 'enclave.example', challenge = 'synthetic-policy-challenge', uv = true } = {}) {
  const id = crypto.randomBytes(32), length = Buffer.alloc(2); length.writeUInt16BE(id.length);
  const data = Buffer.concat([crypto.createHash('sha256').update(rpId).digest(), Buffer.from([uv ? 0x45 : 0x41]), Buffer.alloc(4), Buffer.alloc(16), length, id, key(alg)]);
  return { id: id.toString('base64url'), rawId: id.toString('base64url'), type: 'public-key', clientExtensionResults: {}, response: {
    clientDataJSON: Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin, crossOrigin: false })).toString('base64url'),
    attestationObject: encodeAttestationObjectNone(data).toString('base64url'), transports: ['internal'],
  } };
}
const expected = { expectedChallenge: 'synthetic-policy-challenge', expectedOrigin: 'https://enclave.example', expectedRPID: 'enclave.example', requireUserVerification: true };

test('registration advertises exactly EdDSA, ES256 and RS256 even if a caller supplies other IDs', async () => {
  const options = await generateRegistrationOptions({ rpName: 'Enclave policy fixture', rpID: 'enclave.example', userName: 'policy-fixture', supportedAlgorithmIDs: [-65535], authenticatorSelection: { residentKey: 'required', userVerification: 'required' } });
  assert.deepEqual(options.pubKeyCredParams.map(p => p.alg), [-8, -7, -257]);
  assert.equal(options.authenticatorSelection.userVerification, 'required');
});
for (const [alg, name] of [[-8, 'EdDSA'], [-7, 'ES256'], [-257, 'RS256']]) {
  test(name + ' registration remains valid under the explicit policy', async () => {
    assert.equal((await verifyRegistrationResponse({ ...expected, response: response(alg) })).verified, true);
  });
}
for (const [alg, name] of [[-65535, 'RS1'], [-37, 'PS256']]) {
  test(name + ' is rejected because it was not offered, including attempted policy overrides', async () => {
    await assert.rejects(verifyRegistrationResponse({ ...expected, response: response(alg), supportedAlgorithmIDs: [alg] }), /Unexpected public key alg/);
  });
}
test('explicit algorithm policy preserves origin, RP, challenge and UV verification', async () => {
  for (const changes of [{ origin: 'https://attacker.example' }, { rpId: 'attacker.example' }, { challenge: 'wrong-challenge' }, { uv: false }]) {
    await assert.rejects(verifyRegistrationResponse({ ...expected, response: response(-7, changes) }));
  }
});
