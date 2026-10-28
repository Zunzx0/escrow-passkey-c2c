// Server-side sandbox credit, not a payment-provider result or client input.
const DEFAULT_INITIAL_GRANT_VND = 10_000_000;
const MAX_INITIAL_GRANT_VND = 200_000_000;

function parseSetting(value, name) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${name} must be a whole VND amount between 0 and ${MAX_INITIAL_GRANT_VND}`);
  }
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount > MAX_INITIAL_GRANT_VND) {
    throw new Error(`${name} must be a whole VND amount between 0 and ${MAX_INITIAL_GRANT_VND}`);
  }
  return amount;
}

function resolveInitialGrant(env = process.env) {
  const current = env.INITIAL_GRANT_VND;
  const legacy = env.DEMO_BUYER_INITIAL_BALANCE;
  const amount = current === undefined ? undefined : parseSetting(current, 'INITIAL_GRANT_VND');
  const oldAmount = legacy === undefined ? undefined : parseSetting(legacy, 'DEMO_BUYER_INITIAL_BALANCE');
  if (amount !== undefined && oldAmount !== undefined && amount !== oldAmount) {
    throw new Error('INITIAL_GRANT_VND conflicts with DEMO_BUYER_INITIAL_BALANCE; keep one setting');
  }
  return amount ?? oldAmount ?? DEFAULT_INITIAL_GRANT_VND;
}

module.exports = { resolveInitialGrant, DEFAULT_INITIAL_GRANT_VND, MAX_INITIAL_GRANT_VND };
