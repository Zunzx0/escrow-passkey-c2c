// A minimal, hand-rolled "software" WebAuthn authenticator for tests.
// Produces real ES256 (P-256) signed registration/authentication
// responses that @simplewebauthn/server's verifier accepts, so tests can
// exercise the real cryptographic path (wrong origin/RP ID rejection,
// full successful registration, signature verification during login,
// signCount handling) instead of stopping at business-logic guards.
//
// This is NOT a general WebAuthn/CBOR library — it hand-encodes exactly
// the fixed shapes needed here (attestation fmt "none", a single EC2
// COSE key, "none"-attestation authData). Byte layouts follow the
// WebAuthn/CTAP2 spec directly (authenticatorData structure, COSE_Key
// parameters, DER ECDSA signature encoding) — well-established, stable
// formats, not implementation details of any one library version.
import { webcrypto } from "node:crypto";
import { createHash } from "node:crypto";

const subtle = webcrypto.subtle;

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function uint32BE(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, false);
  return b;
}

function sha256(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(data).digest());
}

// --- Minimal CBOR encoding for exactly the shapes we need ---------------

function cborUnsignedInt(n: number): Uint8Array {
  // Major type 0 (unsigned int), values used here are all tiny (<24).
  if (n < 24) return new Uint8Array([n]);
  if (n < 256) return new Uint8Array([0x18, n]);
  throw new Error("cborUnsignedInt: value too large for this minimal encoder");
}

function cborNegativeInt(value: number): Uint8Array {
  // Major type 1: a CBOR negative integer -1-argument encodes `value`
  // (value < 0), so argument = -1 - value. We only ever need small
  // negative COSE labels (-1, -2, -3, -7) here.
  const arg = -1 - value;
  if (arg < 0 || arg >= 24) throw new Error("cborNegativeInt: value out of range for this minimal encoder");
  return new Uint8Array([0x20 | arg]);
}

function cborByteString(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 24) return concatBytes(new Uint8Array([0x40 | bytes.length]), bytes);
  if (bytes.length < 256) return concatBytes(new Uint8Array([0x58, bytes.length]), bytes);
  throw new Error("cborByteString: too large for this minimal encoder");
}

function cborTextString(s: string): Uint8Array {
  const bytes = new TextEncoder().encode(s);
  if (bytes.length < 24) return concatBytes(new Uint8Array([0x60 | bytes.length]), bytes);
  throw new Error("cborTextString: too large for this minimal encoder");
}

/** COSE_Key CBOR for an EC2/P-256/ES256 public key: {1:2, 3:-7, -1:1, -2:x, -3:y} */
export function encodeCoseEc2Key(x: Uint8Array, y: Uint8Array): Uint8Array {
  return concatBytes(
    new Uint8Array([0xa5]), // map, 5 pairs
    cborUnsignedInt(1),
    cborUnsignedInt(2), // kty: EC2
    cborUnsignedInt(3),
    cborNegativeInt(-7), // alg: ES256
    cborNegativeInt(-1),
    cborUnsignedInt(1), // crv: P-256
    cborNegativeInt(-2),
    cborByteString(x),
    cborNegativeInt(-3),
    cborByteString(y)
  );
}

/** attestationObject CBOR for fmt "none": {fmt:"none", attStmt:{}, authData:<bytes>} */
function encodeNoneAttestationObject(authData: Uint8Array): Uint8Array {
  return concatBytes(
    new Uint8Array([0xa3]), // map, 3 pairs
    cborTextString("fmt"),
    cborTextString("none"),
    cborTextString("attStmt"),
    new Uint8Array([0xa0]), // empty map
    cborTextString("authData"),
    cborByteString(authData)
  );
}

/** Converts a WebCrypto raw ECDSA signature (r||s, 64 bytes for P-256) to DER, as required by WebAuthn assertions. */
function rawSignatureToDer(raw: Uint8Array): Uint8Array {
  const r = raw.slice(0, 32);
  const s = raw.slice(32, 64);

  function encodeInteger(bytes: Uint8Array): Uint8Array {
    let b = bytes;
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    b = b.slice(i);
    if (b[0] & 0x80) b = concatBytes(new Uint8Array([0]), b);
    return concatBytes(new Uint8Array([0x02, b.length]), b);
  }

  const rEnc = encodeInteger(r);
  const sEnc = encodeInteger(s);
  const body = concatBytes(rEnc, sEnc);
  return concatBytes(new Uint8Array([0x30, body.length]), body);
}

export interface VirtualCredential {
  credentialIdB64: string;
  privateKey: CryptoKey;
  publicKeyX: Uint8Array;
  publicKeyY: Uint8Array;
}

export async function generateVirtualCredential(): Promise<VirtualCredential> {
  const keyPair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const rawPublic = new Uint8Array(await subtle.exportKey("raw", keyPair.publicKey));
  // Uncompressed SEC1 point: 0x04 || X(32) || Y(32)
  const x = rawPublic.slice(1, 33);
  const y = rawPublic.slice(33, 65);

  const credentialId = webcrypto.getRandomValues(new Uint8Array(16));

  return {
    credentialIdB64: base64url(credentialId),
    privateKey: keyPair.privateKey,
    publicKeyX: x,
    publicKeyY: y,
  };
}

function buildClientDataJSON(type: "webauthn.create" | "webauthn.get", challenge: string, origin: string): Uint8Array {
  const json = JSON.stringify({ type, challenge, origin, crossOrigin: false });
  return new TextEncoder().encode(json);
}

export interface BuildRegistrationOptions {
  rpID: string;
  origin: string;
  challenge: string;
  credential: VirtualCredential;
  /** Deliberately produce a bad response for negative tests. */
  tamperOrigin?: string;
  tamperRpIdHash?: boolean;
  /** Defaults to true (matches every existing test's assumption). Set to
   * false to simulate an authenticator that did NOT perform user
   * verification — needed for the register/login "UV=false still
   * succeeds because policy is preferred, not required" regression tests
   * (Stage 6 review). */
  userVerified?: boolean;
}

/** Builds a RegistrationResponseJSON-shaped object with a real, verifiable "none"-attestation. */
export function buildRegistrationResponse(opts: BuildRegistrationOptions) {
  const clientDataJSON = buildClientDataJSON("webauthn.create", opts.challenge, opts.tamperOrigin ?? opts.origin);

  const rpIdHash = opts.tamperRpIdHash ? sha256(new TextEncoder().encode("evil-rp-id")) : sha256(new TextEncoder().encode(opts.rpID));
  const userVerified = opts.userVerified ?? true;
  const flags = new Uint8Array([userVerified ? 0x45 : 0x41]); // UP(0x01) | AT(0x40) always; UV(0x04) only if userVerified
  const signCount = uint32BE(0);
  const aaguid = new Uint8Array(16);
  const credentialIdBytes = Buffer.from(opts.credential.credentialIdB64, "base64url");
  const credIdLen = new Uint8Array(2);
  new DataView(credIdLen.buffer).setUint16(0, credentialIdBytes.length, false);
  const coseKey = encodeCoseEc2Key(opts.credential.publicKeyX, opts.credential.publicKeyY);

  const authData = concatBytes(rpIdHash, flags, signCount, aaguid, credIdLen, credentialIdBytes, coseKey);
  const attestationObject = encodeNoneAttestationObject(authData);

  return {
    id: opts.credential.credentialIdB64,
    rawId: opts.credential.credentialIdB64,
    response: {
      clientDataJSON: base64url(clientDataJSON),
      attestationObject: base64url(attestationObject),
      transports: ["internal"],
    },
    authenticatorAttachment: "platform",
    clientExtensionResults: {},
    type: "public-key",
  };
}

export interface BuildAuthenticationOptions {
  rpID: string;
  origin: string;
  challenge: string;
  credential: VirtualCredential;
  signCount: number;
  tamperOrigin?: string;
  /** Defaults to true (matches every existing test's assumption). Set to
   * false to simulate an authenticator that did NOT perform user
   * verification — needed to prove Stage 6's `requireUserVerification:
   * true` on REAUTH is actually enforced, not just requested. */
  userVerified?: boolean;
}

/** Builds an AuthenticationResponseJSON-shaped object with a real ECDSA assertion signature. */
export async function buildAuthenticationResponse(opts: BuildAuthenticationOptions) {
  const clientDataJSON = buildClientDataJSON("webauthn.get", opts.challenge, opts.tamperOrigin ?? opts.origin);
  const clientDataHash = sha256(clientDataJSON);

  const rpIdHash = sha256(new TextEncoder().encode(opts.rpID));
  const userVerified = opts.userVerified ?? true;
  const flags = new Uint8Array([userVerified ? 0x05 : 0x01]); // UP always; UV only if userVerified
  const signCount = uint32BE(opts.signCount);
  const authenticatorData = concatBytes(rpIdHash, flags, signCount);

  const signedData = concatBytes(authenticatorData, clientDataHash);
  const rawSignature = new Uint8Array(
    await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, opts.credential.privateKey, signedData)
  );
  const derSignature = rawSignatureToDer(rawSignature);

  return {
    id: opts.credential.credentialIdB64,
    rawId: opts.credential.credentialIdB64,
    response: {
      clientDataJSON: base64url(clientDataJSON),
      authenticatorData: base64url(authenticatorData),
      signature: base64url(derSignature),
      userHandle: undefined,
    },
    authenticatorAttachment: "platform",
    clientExtensionResults: {},
    type: "public-key",
  };
}
