# F-05 — PayPal history outage isolation

Base: 5612117. Date: 2026-10-07.

## Problem and resulting behavior

A PENDING PayPal request with UNKNOWN capture state and PAYPAL_PAYER_ACTION_REQUIRED prompted a provider GET during history serialization. One timeout or mismatch rejected the entire /api/payments/me list.

The history route now passes the server-only allowProviderLookup=false option. It returns stored state, keeps UNKNOWN as RECONCILING and returns no approval URL. It never turns a stored error hint into approval or success. The serializer defaults to fresh lookup on detail/checkout/capture as before, and the production export forwards options. No catch-all suppresses database/binding errors; these still fail normally.

Response field shape, ownership, authentication, list order and 200-row limit are unchanged. The history's RECONCILING value is deliberately conservative; the user can check the detail or checkout endpoint for current verified status.

## Evidence

- Before product change: new real HTTP/router/runtime regression 15 pass, 6 fail (including /me 500 when provider offline/mismatched).
- After change: history regression SQLite 27/27, PostgreSQL 27/27, zero fail.
- M2 HTTP regression: SQLite 67/67, PostgreSQL 67/67, zero known issues reproduced.
- Existing five PayPal module files: Node test runner 50/50, zero fail/skip.
- Financial and separate PayPal invariant checks passed in the HTTP/history runs.
- Independent code review approved the option flow, no client control, no approval minted from lastError and unchanged fresh detail/checkout/capture behavior.
- PostgreSQL used only Codex's local disposable cluster at 54338/enclave_codex_admission_test; cluster stopped after testing.

## Scope and limits

No schema, frontend, credentials or deployment changes. No full-suite rerun on this product hash yet; targeted suites above are the evidence for this patch. No real PayPal Sandbox, cookie or device Passkey evidence.

The new history test substitutes the exported serialization wrapper to bind its isolated runtime. It therefore does not independently catch a future broken production wrapper; the wrapper's option forwarding is also checked by code review. Synthetic mismatch errors demonstrate rejection, not the actual adapter's exact HTTP status. Existing M2/module tests cover checkout/capture regression; the new 27 checks do not alone prove them.

npm run test:paypal-history runs on disposable local storage only. Do not add this reset-based standalone test to a suite sharing the same database without isolating that storage first.
