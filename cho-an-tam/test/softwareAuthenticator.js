// Software authenticator giả lập (chỉ phục vụ TEST tự động trong sandbox).
// Mô phỏng một Passkey thật: sinh cặp khóa ES256, ký attestation/assertion 'none'.
// KHÔNG dùng trong sản phẩm — người dùng thật sẽ dùng Touch ID/Windows Hello qua trình duyệt.
const crypto = require('crypto');
const { encodeCoseEc2Key, encodeAttestationObjectNone } = require('./minicbor');

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}
function unb64url(str) {
  return Buffer.from(str, 'base64url');
}
function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest();
}

// zeroCounter: mô phỏng Passkey đồng bộ (iCloud/Google) luôn báo signCount = 0.
// forceNextCounter(n): lần ký kế tiếp mang đúng counter n — để dựng các ca counter đứng yên
// hoặc lùi mà kiểm thử tín hiệu rủi ro cần.
function createAuthenticator({ zeroCounter = false } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const credentialId = crypto.randomBytes(32);
  let counter = 0;
  let forcedNext = null;

  const jwk = publicKey.export({ format: 'jwk' });
  const x = Buffer.from(jwk.x, 'base64url');
  const y = Buffer.from(jwk.y, 'base64url');

  // COSE_Key EC2 / ES256
  const coseKeyBuf = encodeCoseEc2Key({ x, y });

  function buildAuthData({ rpId, flags, includeAttestedCredData }) {
    const rpIdHash = sha256(Buffer.from(rpId));
    const flagsByte = Buffer.from([flags]);
    const counterBuf = Buffer.alloc(4);
    if (forcedNext !== null) {
      counter = forcedNext;
      forcedNext = null;
    } else if (!zeroCounter) {
      counter += 1;
    }
    counterBuf.writeUInt32BE(counter);

    let attestedCredData = Buffer.alloc(0);
    if (includeAttestedCredData) {
      const aaguid = Buffer.alloc(16, 0);
      const credIdLen = Buffer.alloc(2);
      credIdLen.writeUInt16BE(credentialId.length);
      attestedCredData = Buffer.concat([aaguid, credIdLen, credentialId, coseKeyBuf]);
    }
    return Buffer.concat([rpIdHash, flagsByte, counterBuf, attestedCredData]);
  }

  function sign(data) {
    const signer = crypto.createSign('SHA256');
    signer.update(data);
    signer.end();
    return signer.sign(privateKey); // DER-encoded ECDSA signature, đúng format WebAuthn cần
  }

  // uv=false mô phỏng một bộ xác thực chỉ báo "có người hiện diện" mà KHÔNG thực hiện xác
  // minh người dùng cục bộ. Dùng để kiểm rằng máy chủ từ chối đúng ở những chỗ đã tuyên bố
  // mức xác minh người dùng là bắt buộc.
  function register({ rpId, origin, challenge, uv = true }) {
    const clientData = JSON.stringify({ type: 'webauthn.create', challenge, origin, crossOrigin: false });
    const clientDataJSON = Buffer.from(clientData);
    // flags: UP(0x01) | UV(0x04) | AT(0x40) = 0x45; bỏ UV thì còn 0x41
    const authData = buildAuthData({ rpId, flags: uv ? 0x45 : 0x41, includeAttestedCredData: true });
    const attestationObject = encodeAttestationObjectNone(authData);

    return {
      id: b64url(credentialId),
      rawId: b64url(credentialId),
      type: 'public-key',
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
      response: {
        clientDataJSON: b64url(clientDataJSON),
        attestationObject: b64url(attestationObject),
        transports: ['internal'],
      },
    };
  }

  function authenticate({ rpId, origin, challenge, uv = true }) {
    const clientData = JSON.stringify({ type: 'webauthn.get', challenge, origin, crossOrigin: false });
    const clientDataJSON = Buffer.from(clientData);
    const clientDataHash = sha256(clientDataJSON);
    // flags: UP | UV = 0x05 (không kèm attested credential data khi authenticate); bỏ UV còn 0x01
    const authenticatorData = buildAuthData({ rpId, flags: uv ? 0x05 : 0x01, includeAttestedCredData: false });
    const signature = sign(Buffer.concat([authenticatorData, clientDataHash]));

    return {
      id: b64url(credentialId),
      rawId: b64url(credentialId),
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authenticatorData),
        signature: b64url(signature),
        userHandle: null,
      },
    };
  }

  function forceNextCounter(value) {
    forcedNext = value;
  }

  return { credentialId: b64url(credentialId), register, authenticate, forceNextCounter };
}

module.exports = { createAuthenticator };
