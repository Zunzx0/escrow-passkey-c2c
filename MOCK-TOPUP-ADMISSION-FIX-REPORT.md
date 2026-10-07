# Mock top-up admission fix — 2026-10-07

Base: codex/payment-provider-isolation at 5080e3a.

## Behavior

Previously, PAYPAL_SANDBOX_ENABLED=0 and MOCK_PROVIDER_CHECKOUT=0 hid/disabled checkout, but an authenticated direct POST /api/payments/topup could still create a mock payment. The creation route now uses the existing isCheckoutEnabled predicate before parsing, inserting, replaying or submitting. Disabled requests return 503 MOCK_PAYMENTS_DISABLED with a neutral message; enabling mock again preserves the existing retry contract.

Historical webhook and reconciliation are unchanged: disabling new mock creation must not abandon already submitted payments.

## Validation

- New isolated admission test: SQLite 39/39, PostgreSQL 39/39, zero failures; financial and PayPal invariant checks held.
- Full SQLite suite on an isolated source snapshot containing this patch: 1006 pass, 0 fail, all nine final financial invariants hold, exit 0. Report: suite-2026-10-07T08-56-00-961Z.
- PostgreSQL admission test used a fresh cluster on localhost:54338 and enclave_codex_admission_test. Applied migrations v1–v6. Cluster stopped after testing.
- Full PostgreSQL suite was not rerun in this task; independent release review remains assigned to Pro.
- The full SQLite suite used a high auth rate limit; four rate-limit assertions were not exercised in that full run. A separate hardening run with limit 10 is recorded below after completion; do not sum its assertions into the full-run total.
- git diff --check and Node syntax check passed.

## Test environment issues retained for transparency

An initial full-suite launch picked up an existing local test configuration after a path error. The Codex-owned runner was stopped, without stopping the other runner. Its results are not counted. A second run in a separate Temp snapshot failed six e2e assertions because BASE_URL used 127.0.0.1 while the WebAuthn origin used localhost; server logs showed the origin rejection. The test configuration was corrected and the final full suite rerun from a clean disposable DB passed as above. Product authentication was not relaxed.

## Reproduction and scope

npm run test:mock-admission runs the standalone test, which resets only its disposable local test storage. With PostgreSQL, DATABASE_URL must point to localhost and a separately owned database ending _test. Do not run against production or another agent's database.

The standalone reset test is intentionally not registered in the shared run-suite list: that would reset another suite's database. The npm script makes the separate check reproducible.

No public/, PayPal adapter, schema, hosting or credentials were changed. Real Sandbox acceptance remains unverified; see PAYPAL-SANDBOX-ACTIVATION-GATE.md.

## Separate hardening result

RATE_LIMIT_AUTH_PER_MINUTE=10: hardening 27/27, 0 failures, followed by 9/9 invariant checks; exit 0. Report suite-2026-10-07T09-03-18-926Z. These are a separate run, not added to 1006.
