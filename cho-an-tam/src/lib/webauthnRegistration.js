const webauthn = require('@simplewebauthn/server');

// Keep offered and accepted NEW credential algorithms identical. Match the
// library's advertised defaults: EdDSA, ES256 and RS256. In particular, do not
// inherit its broader verification default (which also accepts legacy RS1).
// Existing credential authentication remains unchanged.
const ALGORITHM_IDS = Object.freeze([-8, -7, -257]);

function generateRegistrationOptions(options) {
  return webauthn.generateRegistrationOptions({ ...options, supportedAlgorithmIDs: [...ALGORITHM_IDS] });
}

function verifyRegistrationResponse(options) {
  return webauthn.verifyRegistrationResponse({ ...options, supportedAlgorithmIDs: [...ALGORITHM_IDS] });
}

module.exports = { generateRegistrationOptions, verifyRegistrationResponse };
