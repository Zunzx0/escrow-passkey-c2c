'use strict';

const { PayPalSandboxError, validateQuote } = require('./paypalSandboxProvider');

// Additive integration boundary. Store and settlement are deliberately injected:
// the application must persist immutable quote/order ownership and select the
// provider before this module can be exposed by an authenticated route.
function createSandboxPaymentService({ provider, store, settle, returnUrl, cancelUrl,
  captureCoordinator = null, now = Date.now, createRetryWindowMs = 5 * 60 * 1000 }) {
  if (!provider || !store || typeof settle !== 'function' ||
      !['loadByRequestId', 'loadByOrderId', 'bindOrder', 'claimCreateAttempt'].every(k => typeof store[k] === 'function') ||
      typeof now !== 'function' || !Number.isInteger(createRetryWindowMs) || createRetryWindowMs <= 0 ||
      createRetryWindowMs > 5 * 60 * 1000) {
    throw new TypeError('PayPal provider, persistent binding store and atomic settlement are required');
  }

  function reject(code, message, statusCode) { throw new PayPalSandboxError(code, message, statusCode); }

  function trusted(row) {
    if (!row) reject('PAYMENT_REQUEST_NOT_FOUND', 'Payment request was not found', 404);
    if (row.provider !== 'PAYPAL_SANDBOX' || typeof row.paymentRequestId !== 'string' || !row.paymentRequestId ||
        typeof row.userId !== 'string' || !row.userId || typeof row.providerRef !== 'string' || !row.providerRef ||
        !Number.isSafeInteger(row.amountVnd) || row.amountVnd <= 0 ||
        !['PENDING', 'SUCCEEDED', 'FAILED'].includes(row.status)) {
      reject('PAYPAL_ORDER_MISMATCH', 'Persistent PayPal payment binding is invalid', 409);
    }
    const quote = validateQuote(row.quote);
    if (quote.amountVnd !== row.amountVnd) reject('PAYPAL_ORDER_MISMATCH', 'Quote does not match the payment request', 409);
    return { ...row, quote };
  }

  async function load(paymentRequestId, userId, authenticate) {
    if (typeof paymentRequestId !== 'string' || !paymentRequestId) {
      reject('VALIDATION_ERROR', 'Payment request ID is required', 400);
    }
    const row = trusted(await store.loadByRequestId(paymentRequestId));
    if (row.paymentRequestId !== paymentRequestId) reject('PAYPAL_ORDER_MISMATCH', 'Stored request ID does not match', 409);
    if (authenticate && (typeof userId !== 'string' || row.userId !== userId)) {
      reject('FORBIDDEN', 'Payment request belongs to another account', 403);
    }
    return row;
  }

  function input(row) {
    if (typeof row.orderId !== 'string' || !row.orderId) reject('PAYPAL_ORDER_NOT_READY', 'PayPal order is not yet bound', 409);
    return { orderId: row.orderId, paymentRequestId: row.paymentRequestId, quote: row.quote };
  }

  function openForCheckout(row) {
    if (row.status === 'FAILED') reject('PAYPAL_PAYMENT_CLOSED', 'Payment request is already closed', 409);
    if (row.status === 'SUCCEEDED' && !row.orderId) {
      reject('PAYPAL_ORDER_MISMATCH', 'Settled request is missing its bound PayPal order', 409);
    }
  }

  async function apply(row, result, source) {
    // Defensive binding check even when the injected adapter has already verified PayPal.
    if (!result || result.orderId !== row.orderId || result.paymentRequestId !== row.paymentRequestId ||
        result.amount !== row.amountVnd || !['PENDING', 'SUCCEEDED'].includes(result.status)) {
      reject('PAYPAL_ORDER_MISMATCH', 'Verified provider result does not match the stored request', 409);
    }
    if (result.status === 'PENDING') return { status: 'PENDING', outcome: 'STILL_PENDING' };
    if (typeof result.captureId !== 'string' || !result.captureId) {
      reject('PAYPAL_ORDER_MISMATCH', 'Completed capture ID is required', 409);
    }
    // Existing settlement must independently require row.provider=PAYPAL_SANDBOX,
    // claim PENDING atomically and credit/ledger in the SAME database transaction.
    return settle({ paymentRequestId: row.paymentRequestId, providerRef: row.providerRef,
      status: 'SUCCEEDED', amount: row.amountVnd, source, orderId: row.orderId, captureId: result.captureId });
  }

  return Object.freeze({
    async createOrder({ paymentRequestId, userId }) {
      let row = await load(paymentRequestId, userId, true);
      openForCheckout(row);
      if (!row.orderId) {
        const clock = now();
        const previous = row;
        // Atomic persistent first-attempt timestamp survives restarts and must
        // never be refreshed on retries. This bounded window is deliberately
        // far shorter than the provider's default idempotency retention.
        row = trusted(await store.claimCreateAttempt(row.paymentRequestId, new Date(clock).toISOString()));
        openForCheckout(row);
        if (row.paymentRequestId !== previous.paymentRequestId || row.userId !== userId ||
            row.providerRef !== previous.providerRef || JSON.stringify(row.quote) !== JSON.stringify(previous.quote)) {
          reject('PAYPAL_ORDER_MISMATCH', 'Create claim changed the trusted binding', 409);
        }
        if (!row.orderId) {
          const first = typeof row.createAttemptAt === 'string' ? Date.parse(row.createAttemptAt) : NaN;
          if (!Number.isFinite(first) || first > clock || clock - first >= createRetryWindowMs) {
            reject('PAYPAL_CREATE_RECOVERY_REQUIRED', 'Ambiguous PayPal order creation requires operator recovery', 409);
          }
        }
      }
      // Once bound, NEVER issue another remote create, even after PayPal's finite
      // idempotency retention expires. Recover the same order with a GET instead.
      const result = row.orderId
        ? await provider.getOrder(input(row))
        : await provider.createOrder({ paymentRequestId: row.paymentRequestId, quote: row.quote, returnUrl: typeof returnUrl==='function'?returnUrl(row.paymentRequestId):returnUrl, cancelUrl: typeof cancelUrl==='function'?cancelUrl(row.paymentRequestId):cancelUrl });
      if (!result || result.paymentRequestId !== row.paymentRequestId || result.amount !== row.amountVnd ||
          typeof result.orderId !== 'string' || !result.orderId || (row.orderId && row.orderId !== result.orderId)) {
        reject('PAYPAL_ORDER_MISMATCH', 'Created order does not match the stored payment request', 409);
      }
      // This must be durable and conditional; network retries use the same PayPal key.
      // bindOrder must treat the SAME order as an idempotent replay, reject a different order.
      if (await store.bindOrder(row.paymentRequestId, result.orderId) !== true) {
        reject('PAYPAL_ORDER_MISMATCH', 'Could not persist a unique PayPal order binding', 409);
      }
      // Creation, approval, or a return URL never credits the wallet.
      return { paymentRequestId: row.paymentRequestId, orderId: result.orderId,
        approvalUrl: result.approvalUrl, quote: row.quote, sandbox: true };
    },
    async capture({ paymentRequestId, userId }) {
      if (captureCoordinator) return captureCoordinator.capture({paymentRequestId,userId});
      const row = await load(paymentRequestId, userId, true);
      openForCheckout(row);
      const result = row.status === 'SUCCEEDED'
        ? await provider.getOrder(input(row))
        : await provider.captureOrder(input(row));
      return apply(row, result, 'RECONCILER');
    },
    async reconcile({ paymentRequestId }) {
      const row = await load(paymentRequestId, null, false);
      return apply(row, await provider.getOrder(input(row)), 'RECONCILER');
    },
    async webhook({ headers, event }) {
      if (await provider.verifyWebhook({ headers, event }) !== true) {
        reject('INVALID_SIGNATURE', 'PayPal webhook signature was not verified', 401);
      }
      if (event.event_type !== 'PAYMENT.CAPTURE.COMPLETED') return { ignored: true };
      const resource = event.resource;
      const orderId = resource && resource.supplementary_data && resource.supplementary_data.related_ids &&
        resource.supplementary_data.related_ids.order_id;
      if (typeof orderId !== 'string' || !orderId || typeof resource.id !== 'string') {
        reject('PAYPAL_ORDER_MISMATCH', 'Capture webhook is missing its order binding', 400);
      }
      const row = trusted(await store.loadByOrderId(orderId));
      if (row.orderId !== orderId) reject('PAYPAL_ORDER_MISMATCH', 'Webhook order does not match the stored binding', 409);
      // Signature alone is insufficient: ask PayPal for current authoritative order.
      const result = await provider.getOrder(input(row));
      if (result.captureId !== resource.id) reject('PAYPAL_ORDER_MISMATCH', 'Webhook capture ID does not match PayPal', 409);
      return apply(row, result, 'WEBHOOK');
    },
  });
}

module.exports = { createSandboxPaymentService };
