const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveInitialGrant } = require('../src/lib/initialGrant');

test('new default, explicit values and legacy deployment compatibility', () => {
  assert.equal(resolveInitialGrant({}), 10_000_000);
  assert.equal(resolveInitialGrant({ INITIAL_GRANT_VND: '12000000' }), 12_000_000);
  assert.equal(resolveInitialGrant({ DEMO_BUYER_INITIAL_BALANCE: '5000000' }), 5_000_000);
  assert.equal(resolveInitialGrant({ INITIAL_GRANT_VND: '0' }), 0);
  assert.equal(resolveInitialGrant({ DEMO_BUYER_INITIAL_BALANCE: '0' }), 0);
  assert.equal(resolveInitialGrant({ INITIAL_GRANT_VND: '5000000', DEMO_BUYER_INITIAL_BALANCE: '5000000' }), 5_000_000);
});

test('ambiguous or malformed deployment settings fail closed without echoing their value', () => {
  assert.throws(() => resolveInitialGrant({ INITIAL_GRANT_VND: '10000000', DEMO_BUYER_INITIAL_BALANCE: '5000000' }), /conflicts/);
  for (const name of ['INITIAL_GRANT_VND', 'DEMO_BUYER_INITIAL_BALANCE']) {
    for (const value of ['', ' ', '1.5', '1e7', '10000000suffix', '-1', '010', '200000001', '9007199254740992', 'sensitive-placeholder']) {
      assert.throws(() => resolveInitialGrant({ [name]: value }), error => {
        assert.ok(error.message.startsWith(name + ' must be'));
        assert.ok(!error.message.includes('sensitive-placeholder'));
        return true;
      });
    }
  }
});
