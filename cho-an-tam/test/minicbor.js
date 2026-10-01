// CBOR encoder tối giản, chỉ đủ dùng cho software authenticator giả lập (test-only).
// Viết tay thay vì dùng thư viện vì cbor-x gắn tag 259 cho JS Map (để bảo toàn ngữ nghĩa
// Map lúc decode lại), trong khi @simplewebauthn/server dùng tiny-cbor và mong đợi CBOR
// map THUẦN (không tag) theo đúng chuẩn COSE/WebAuthn.

function encodeHead(majorType, value) {
  const mt = majorType << 5;
  if (value < 24) {
    return Buffer.from([mt | value]);
  } else if (value < 256) {
    return Buffer.from([mt | 24, value]);
  } else if (value < 65536) {
    const b = Buffer.alloc(3);
    b[0] = mt | 25;
    b.writeUInt16BE(value, 1);
    return b;
  }
  const b = Buffer.alloc(5);
  b[0] = mt | 26;
  b.writeUInt32BE(value, 1);
  return b;
}

function encodeUInt(n) {
  return encodeHead(0, n);
}

function encodeNegInt(n) {
  // n là số âm, ví dụ -7 -> lưu (-1 - n) = 6 với major type 1
  return encodeHead(1, -1 - n);
}

function encodeInt(n) {
  return n >= 0 ? encodeUInt(n) : encodeNegInt(n);
}

function encodeBytes(buf) {
  return Buffer.concat([encodeHead(2, buf.length), Buffer.from(buf)]);
}

function encodeTextString(str) {
  const buf = Buffer.from(str, 'utf8');
  return Buffer.concat([encodeHead(3, buf.length), buf]);
}

function encodeMapHeader(numPairs) {
  return encodeHead(5, numPairs);
}

// COSE key EC2/ES256: map 5 entry, key là số nguyên (1,3,-1,-2,-3)
function encodeCoseEc2Key({ x, y }) {
  const entries = [
    [1, 2], // kty: EC2
    [3, -7], // alg: ES256
    [-1, 1], // crv: P-256
  ];
  const parts = [encodeMapHeader(5)];
  for (const [k, v] of entries) {
    parts.push(encodeInt(k), encodeInt(v));
  }
  parts.push(encodeInt(-2), encodeBytes(x));
  parts.push(encodeInt(-3), encodeBytes(y));
  return Buffer.concat(parts);
}

// attestationObject: map { "fmt": "none", "attStmt": {}, "authData": <bytes> }
function encodeAttestationObjectNone(authData) {
  return Buffer.concat([
    encodeMapHeader(3),
    encodeTextString('fmt'),
    encodeTextString('none'),
    encodeTextString('attStmt'),
    encodeMapHeader(0),
    encodeTextString('authData'),
    encodeBytes(authData),
  ]);
}

module.exports = { encodeCoseEc2Key, encodeAttestationObjectNone, encodeBytes, encodeTextString, encodeMapHeader, encodeInt };
