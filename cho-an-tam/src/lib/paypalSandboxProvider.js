'use strict';

// Server-only PayPal Orders v2 adapter. No database access and no wallet credit here.
const crypto = require('crypto');
const SANDBOX_BASE = 'https://api-m.sandbox.paypal.com';
const MAX_BODY_BYTES = 1024 * 1024;

class PayPalSandboxError extends Error {
  constructor(code, message, statusCode = 502) {
    super(message);
    this.name = 'PayPalSandboxError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function fail(code, message, statusCode) { throw new PayPalSandboxError(code, message, statusCode); }
function identifier(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,127}$/.test(value);
}

function parseUsdCents(value) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,13})\.[0-9]{2}$/.test(value)) {
    fail('PAYPAL_INVALID_AMOUNT', 'PayPal amount must be a canonical USD decimal string', 400);
  }
  const [whole, fraction] = value.split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction);
  if (cents <= 0n || cents > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail('PAYPAL_INVALID_AMOUNT', 'PayPal amount is outside the supported range', 400);
  }
  return Number(cents);
}

// Demonstration quote only: integer VND per USD, rounded upward to one USD cent.
// Persist the returned quote BEFORE creating the remote order; never reconstruct from current FX.
function createQuote(amountVnd, rateVndPerUsd) {
  if (!Number.isSafeInteger(amountVnd) || amountVnd <= 0 ||
      !Number.isSafeInteger(rateVndPerUsd) || rateVndPerUsd <= 0) {
    fail('PAYPAL_INVALID_AMOUNT', 'Positive integer VND amount and demonstration rate are required', 400);
  }
  const cents = (BigInt(amountVnd) * 100n + BigInt(rateVndPerUsd) - 1n) / BigInt(rateVndPerUsd);
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) fail('PAYPAL_INVALID_AMOUNT', 'Quote exceeds supported range', 400);
  const usdCents = Number(cents);
  const usdValue = `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
  return Object.freeze({ version: 1, amountVnd, currency: 'USD', usdCents, usdValue, rateVndPerUsd });
}

function validateQuote(quote) {
  if (!quote || typeof quote !== 'object') fail('PAYPAL_INVALID_QUOTE', 'A stored server quote is required', 400);
  const expected = createQuote(quote.amountVnd, quote.rateVndPerUsd);
  for (const key of Object.keys(expected)) {
    if (expected[key] !== quote[key]) fail('PAYPAL_INVALID_QUOTE', 'Stored quote is inconsistent', 400);
  }
  return expected;
}

function verifyOrder(order, { orderId, paymentRequestId, quote, merchantId }) {
  const expected = validateQuote(quote);
  if (!identifier(orderId) || !identifier(paymentRequestId) || !identifier(merchantId)) {
    fail('PAYPAL_ORDER_MISMATCH', 'Trusted order binding is required', 409);
  }
  const unit = order && Array.isArray(order.purchase_units) && order.purchase_units.length === 1
    ? order.purchase_units[0] : null;
  if (!order || order.id !== orderId || order.intent !== 'CAPTURE' || !unit ||
      unit.reference_id !== paymentRequestId || unit.custom_id !== paymentRequestId ||
      !unit.payee || unit.payee.merchant_id !== merchantId || !unit.amount ||
      unit.amount.currency_code !== 'USD' || parseUsdCents(unit.amount.value) !== expected.usdCents) {
    fail('PAYPAL_ORDER_MISMATCH', 'Order identity, payee, currency or amount does not match the stored request', 409);
  }
  const validStatuses = new Set(['CREATED', 'SAVED', 'APPROVED', 'PAYER_ACTION_REQUIRED', 'COMPLETED', 'VOIDED']);
  if (!validStatuses.has(order.status)) fail('PAYPAL_RESPONSE_INVALID', 'Unknown PayPal order status');
  const captures = unit.payments && unit.payments.captures || [];
  if (!Array.isArray(captures) || captures.length > 1) {
    fail('PAYPAL_ORDER_MISMATCH', 'Exactly one full capture is supported', 409);
  }
  if (captures.length === 0) {
    if (order.status === 'COMPLETED') fail('PAYPAL_RESPONSE_INVALID', 'Completed order has no capture');
    return { orderId, paymentRequestId, status: 'PENDING', amount: expected.amountVnd, captureId: null,
      orderStatus: order.status, payerActionRequired: ['CREATED', 'SAVED', 'PAYER_ACTION_REQUIRED'].includes(order.status) };
  }
  const capture = captures[0];
  if (!capture || !identifier(capture.id) || capture.final_capture !== true || !capture.amount ||
      capture.amount.currency_code !== 'USD' || parseUsdCents(capture.amount.value) !== expected.usdCents) {
    fail('PAYPAL_ORDER_MISMATCH', 'Capture must match the full stored USD amount', 409);
  }
  if (capture.status === 'COMPLETED' && order.status === 'COMPLETED') {
    return { orderId, paymentRequestId, status: 'SUCCEEDED', amount: expected.amountVnd, captureId: capture.id };
  }
  // Reversed/refunded/denied/pending captures NEVER become new wallet credits.
  return { orderId, paymentRequestId, status: 'PENDING', amount: expected.amountVnd, captureId: capture.id, orderStatus: order.status, payerActionRequired: false };
}

function createSandboxProvider(config = {}, { fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const cfg = { enabled: false, timeoutMs: 10000, rateVndPerUsd: 25000,
    frontendOrigin: 'https://enclave.id.vn', ...config };
  let token = null;
  let tokenPromise = null;
  let tokenExpires = 0;

  function ready() {
    if (cfg.enabled !== true) fail('PAYPAL_DISABLED', 'PayPal Sandbox is disabled', 503);
    if ((cfg.baseUrl && cfg.baseUrl !== SANDBOX_BASE) || (cfg.mode && cfg.mode !== 'sandbox') ||
        !cfg.clientId || typeof cfg.clientId !== 'string' ||
        !cfg.clientSecret || typeof cfg.clientSecret !== 'string' ||
        !identifier(cfg.merchantId) || !identifier(cfg.webhookId) ||
        !Number.isSafeInteger(cfg.rateVndPerUsd) || cfg.rateVndPerUsd <= 0 ||
        !Number.isInteger(cfg.timeoutMs) || cfg.timeoutMs < 100 || cfg.timeoutMs > 30000 ||
        typeof fetchImpl !== 'function') {
      fail('PAYPAL_CONFIG_INVALID', 'Complete server-side Sandbox configuration is required', 503);
    }
  }

  async function transport(path, options) {
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([
        (async () => {
          const response = await fetchImpl(`${SANDBOX_BASE}${path}`, {
            ...options, signal: controller.signal, redirect: 'error',
          });
          const raw = await response.text();
          if (Buffer.byteLength(raw) > MAX_BODY_BYTES) fail('PAYPAL_RESPONSE_INVALID', 'PayPal response is too large');
          let body;
          try { body = JSON.parse(raw); } catch (_) { fail('PAYPAL_RESPONSE_INVALID', 'PayPal returned invalid JSON'); }
          if (!response.ok) {
            // Keep only whitelisted upstream issue needed for an already-captured retry.
            const issue = Array.isArray(body.details) && body.details.some(d => d && ['ORDER_ALREADY_CAPTURED','PAYER_ACTION_REQUIRED'].includes(d.issue))
              ? body.details.find(d => d && ['ORDER_ALREADY_CAPTURED','PAYER_ACTION_REQUIRED'].includes(d.issue)).issue : null;
            const error = new PayPalSandboxError(response.status === 401 ? 'PAYPAL_AUTH_FAILED' : 'PAYPAL_API_ERROR',
              'PayPal Sandbox request was rejected');
            error.upstreamStatus = response.status;
            error.issue = issue;
            throw error;
          }
          return body;
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new PayPalSandboxError('PAYPAL_TIMEOUT', 'PayPal Sandbox request timed out', 503));
          }, cfg.timeoutMs);
        }),
      ]);
    } catch (error) {
      if (error instanceof PayPalSandboxError) throw error;
      fail('PAYPAL_UNAVAILABLE', 'PayPal Sandbox is temporarily unavailable', 503);
    } finally { clearTimeout(timer); }
  }

  async function accessToken() {
    ready();
    if (token && now() < tokenExpires) return token;
    if (!tokenPromise) {
      tokenPromise = (async () => {
        const auth = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
        const body = await transport('/v1/oauth2/token', {
          method: 'POST', headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'grant_type=client_credentials',
        });
        if (!body || typeof body.access_token !== 'string' || !body.access_token ||
            body.token_type !== 'Bearer' || !Number.isFinite(body.expires_in) || body.expires_in <= 0) {
          fail('PAYPAL_RESPONSE_INVALID', 'Invalid Sandbox OAuth response');
        }
        token = body.access_token;
        tokenExpires = now() + Math.max(0, body.expires_in - 60) * 1000;
        return token;
      })();
    }
    try { return await tokenPromise; } finally { tokenPromise = null; }
  }

  async function api(path, method = 'GET', body, requestKey) {
    const bearer = await accessToken();
    const headers = { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', Prefer: 'return=representation' };
    if (requestKey) headers['PayPal-Request-Id'] = requestKey;
    try {
      return await transport(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch (error) {
      if (error.code === 'PAYPAL_AUTH_FAILED') { token = null; tokenExpires = 0; }
      throw error;
    }
  }

  function requestKey(phase, paymentRequestId) {
    if (!identifier(paymentRequestId)) fail('PAYPAL_ORDER_MISMATCH', 'Invalid internal payment request ID', 400);
    return crypto.createHash('sha256').update(`enclave-paypal-sandbox:${phase}:${paymentRequestId}`).digest('hex').slice(0, 32);
  }

  function returnAddress(value) {
    try {
      const url = new URL(value);
      const origin = new URL(cfg.frontendOrigin);
      if (url.origin !== origin.origin || url.username || url.password || origin.protocol !== 'https:') throw new Error();
      return url.href;
    } catch (_) { fail('PAYPAL_CONFIG_INVALID', 'Return URL must use the configured HTTPS frontend origin', 400); }
  }

  function binding(input) {
    ready();
    if (!identifier(input.orderId) || !identifier(input.paymentRequestId)) {
      fail('PAYPAL_ORDER_MISMATCH', 'Stored order ID and request ID are required', 400);
    }
    return { ...input, quote: validateQuote(input.quote), merchantId: cfg.merchantId };
  }

  function approvalAddress(order) {
    const link = Array.isArray(order.links) && order.links.find(l => l.rel === 'payer-action' || l.rel === 'approve');
    if (!link) return null;
    try {
      const url = new URL(link.href);
      if (url.origin !== 'https://www.sandbox.paypal.com' || url.username || url.password) throw new Error();
      return url.href;
    } catch (_) { fail('PAYPAL_RESPONSE_INVALID', 'PayPal returned an unsafe approval URL'); }
  }

  return Object.freeze({
    createQuote: amountVnd => { ready(); return createQuote(amountVnd, cfg.rateVndPerUsd); },
    async createOrder({ paymentRequestId, quote, returnUrl, cancelUrl }) {
      ready();
      const key = requestKey('create', paymentRequestId);
      const expected = validateQuote(quote);
      const created = await api('/v2/checkout/orders', 'POST', {
        intent: 'CAPTURE', purchase_units: [{ reference_id: paymentRequestId, custom_id: paymentRequestId,
          payee: { merchant_id: cfg.merchantId }, amount: { currency_code: 'USD', value: expected.usdValue },
          description: 'Enclave Sandbox wallet demonstration — no real money' }],
        payment_source: { paypal: { experience_context: { user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING',
          return_url: returnAddress(returnUrl), cancel_url: returnAddress(cancelUrl) } } },
      }, key);
      if (!created || !identifier(created.id)) fail('PAYPAL_RESPONSE_INVALID', 'PayPal create response has no order ID');
      // A POST representation can be sparse. GET is the canonical full resource
      // used to check metadata, payee and amount before returning any order.
      const order = await api(`/v2/checkout/orders/${encodeURIComponent(created.id)}`);
      const result = verifyOrder(order, { orderId: created.id, paymentRequestId, quote: expected, merchantId: cfg.merchantId });
      const approvalUrl = approvalAddress(order) || approvalAddress(created);
      if (!approvalUrl && ['CREATED', 'PAYER_ACTION_REQUIRED'].includes(order.status)) {
        fail('PAYPAL_RESPONSE_INVALID', 'PayPal order is missing its approval URL');
      }
      return { ...result, approvalUrl };
    },
    async captureOrder(input) {
      const expected = binding(input);
      const path = `/v2/checkout/orders/${encodeURIComponent(expected.orderId)}`;
      // Validate identity/amount BEFORE requesting a capture, then independently
      // validate current authoritative state afterward. Never charge a tampered
      // or wrong-payee order and only discover its mismatch after capture.
      const preflight = await api(path);
      const before = verifyOrder(preflight, expected);
      if (before.status === 'SUCCEEDED') return before;
      // Buyer action is a UI hint, never evidence that a previous POST cannot settle.
      if (before.payerActionRequired || before.captureId || before.orderStatus !== 'APPROVED') {
        return { ...before, approvalUrl: before.payerActionRequired ? approvalAddress(preflight) : null };
      }
      try {
        if (input.beforeCapture !== undefined) {
          if (typeof input.beforeCapture !== 'function') fail('VALIDATION_ERROR', 'beforeCapture must be a function', 400);
          await input.beforeCapture();
        }
        const captured = await api(`${path}/capture`, 'POST', {},
          requestKey('capture', expected.paymentRequestId));
        if (!captured || captured.id !== expected.orderId) {
          fail('PAYPAL_ORDER_MISMATCH', 'Capture response order ID does not match', 409);
        }
      } catch (error) {
        if (error.upstreamStatus === 422 && error.issue === 'PAYER_ACTION_REQUIRED') {
          // POST has been sent. Query authoritative state; retain uncertainty and its marker.
          const currentOrder = await api(path);
          const current = verifyOrder(currentOrder, expected);
          return { ...current, captureUncertain: true,
            approvalUrl: current.payerActionRequired ? approvalAddress(currentOrder) : null };
        }
        if (error.upstreamStatus !== 422 || error.issue !== 'ORDER_ALREADY_CAPTURED') throw error;
      }
      return verifyOrder(await api(path), expected);
    },
    async getOrder(input) {
      const expected = binding(input);
      const order = await api(`/v2/checkout/orders/${encodeURIComponent(expected.orderId)}`);
      return { ...verifyOrder(order, expected), approvalUrl: approvalAddress(order) };
    },
    async verifyWebhook({ headers, event }) {
      ready();
      if (!headers || !event || typeof event !== 'object' || Array.isArray(event) || !identifier(event.id)) return false;
      const keys = ['paypal-auth-algo', 'paypal-cert-url', 'paypal-transmission-id', 'paypal-transmission-sig', 'paypal-transmission-time'];
      if (keys.some(key => typeof headers[key] !== 'string' || !headers[key] || headers[key].length > 4096)) return false;
      if (headers['paypal-auth-algo'] !== 'SHA256withRSA') return false;
      try {
        const cert = new URL(headers['paypal-cert-url']);
        if (!['https://api.sandbox.paypal.com', SANDBOX_BASE].includes(cert.origin) ||
            !cert.pathname.startsWith('/v1/notifications/certs/') || cert.username || cert.password) return false;
      } catch (_) { return false; }
      if (Buffer.byteLength(JSON.stringify(event)) > MAX_BODY_BYTES) return false;
      const result = await api('/v1/notifications/verify-webhook-signature', 'POST', {
        auth_algo: headers['paypal-auth-algo'], cert_url: headers['paypal-cert-url'],
        transmission_id: headers['paypal-transmission-id'], transmission_sig: headers['paypal-transmission-sig'],
        transmission_time: headers['paypal-transmission-time'], webhook_id: cfg.webhookId, webhook_event: event,
      });
      return !!result && result.verification_status === 'SUCCESS';
    },
  });
}

module.exports = { SANDBOX_BASE, PayPalSandboxError, createSandboxProvider, createQuote, validateQuote, verifyOrder, parseUsdCents };
