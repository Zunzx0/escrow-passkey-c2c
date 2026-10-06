'use strict';
// Tiến trình con cho M2: chạy đường capture THẬT trong một process riêng rồi có thể bị crash/giết giữa chừng.
// Tham số qua biến môi trường PPM2_* (CSDL và trạng thái fake dùng chung với tiến trình cha).
const H = require('./paypal-m2-harness');
H.init('child', { reset: false });
const { createDurableFake } = require('./paypal-m2-fake');

async function run() {
  const { createSandboxProvider } = require('../../src/lib/paypalSandboxProvider');
  const { createPayPalRuntime } = require('../../src/lib/paypalRuntime');
  const cfg = H.config({
    timeoutMs: Number(process.env.PPM2_TIMEOUT_MS || 500),
    leaseMs: Number(process.env.PPM2_LEASE_MS || 12000),
  });
  const fake = createDurableFake({ statePath: process.env.PPM2_STATE });
  if (process.env.PPM2_PLAN) fake.plan('capture', { kind: process.env.PPM2_PLAN });
  const runtime = createPayPalRuntime({ config: cfg, provider: createSandboxProvider(cfg, { fetchImpl: fake.fetchImpl }) });
  try {
    const r = await runtime.capture(process.env.PPM2_REQUEST, process.env.PPM2_USER);
    console.log('CHILD_RESULT ' + JSON.stringify({ outcome: r.outcome }));
  } catch (e) {
    console.log('CHILD_ERROR ' + (e.code || e.message));
  }
  process.exit(0);
}

run();
