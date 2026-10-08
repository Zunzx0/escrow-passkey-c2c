# Browser runner safety fixes — 2026-10-07

Base: Pro browser acceptance eb148c0, merged normally into codex/payment-provider-isolation.
Scope: browser test runner and harness only; no application, backend, schema or deployment changes.

## Fixes

1. Browser lock ownership: each owner has a unique immutable owner file. A waiting runner and a former holder cannot release another holder. Stale or unrecognized locks require manual verification; they are never automatically deleted. Failed cleanup retains the owner's lock.
2. Coverage validation: unknown/empty filters and missing selected specs are rejected before launching Chrome. Incomplete runs (skip or no cases) fail. Invalid arguments exit 2.
3. Resource cleanup: partially created sessions close fixture servers and contexts; all cleanups are attempted, bounded to five seconds each, and cleanup failures count as failures. Signal handling cancels waiting and requests cleanup of owned resources.

## Verified results

- node --test test/browser/runner-safety-unit.js: 8/8 pass, 0 fail, 0 skip.
- Full Chrome fixture runner: 54 cases, PASS 458, FAIL 0, SKIP 0, exit 0; 73.2 seconds.
- Actual CLI invocation with --only=UNKNOWN: exit 2 before browser launch.
- git diff --check: pass.
- Generated evidence images unchanged. No public/, src/, package manifest or lockfile changes.

The cleanup unit intentionally injects a failure and asserts that the runner records it; its printed failure marker is expected, and the enclosing unit passes.

## Reproduction

From cho-an-tam, with playwright-core installed outside the repository:

```powershell
$env:NODE_PATH='C:\Users\tranq\tools\pw-runner\node_modules'
node --test test/browser/runner-safety-unit.js
node test/browser/paypal-wallet-browser.js
```

## Limits

This verifies Chrome with isolated local fixtures, not PayPal Sandbox, HTTPS session cookies or a real Passkey. Browser signal behavior is implemented; regression evidence covers cancellation of lock waiting and resource cleanup failures rather than an operating-system kill of Chrome. A hard process kill cannot guarantee cleanup; the next run rejects the stale lock for manual inspection.
