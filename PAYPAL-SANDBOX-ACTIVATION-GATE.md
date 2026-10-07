# Sandbox activation gate — Enclave

Updated 2026-10-07. The integration branch remains codex/payment-provider-isolation. Do not enable Sandbox against the production database as a substitute for an isolated acceptance environment.

## Ready in code

- Separate PayPal provider, durable order/capture bindings, capture coordination, settlement, verified webhook and GET-only reconciliation.
- Wallet UI requires server configuration and confirmed server status; return/cancel URLs are not payment evidence.
- Mock creation admission now follows the mock checkout feature flag. Existing mock webhook/reconciliation remain available to resolve historical pending requests; disabling new creation must not discard those requests.

## Required before real acceptance

1. Obtain an HTTPS backend/frontend test destination and an isolated test database. Verify existing account quotas/credits before creating hosted resources. Do not upgrade, subscribe, or enter payment details.
2. Deploy the reviewed integration hash to that test destination. Frontend API target, CORS allowlist, Passkey origin/RP and PayPal callback frontend origin must refer to the same intended test deployment.
3. Register a Sandbox webhook for that backend's existing PayPal webhook route; copy the resulting webhook ID into the backend configuration. Confirm the route path in src/routes/paypal.js and server mounting before submitting.
4. Configure only backend secrets: PAYPAL_SANDBOX_CLIENT_ID and PAYPAL_SANDBOX_CLIENT_SECRET. Never write them into public/, reports or chat. Credential transfer into a named hosting account requires destination-specific authorization.
5. Set PAYPAL_SANDBOX_MERCHANT_ID to the Sandbox Business merchant, PAYPAL_SANDBOX_WEBHOOK_ID to the test webhook, PAYPAL_FRONTEND_ORIGIN to the HTTPS test frontend origin, PAYPAL_SANDBOX_ENABLED=1 and MOCK_PROVIDER_CHECKOUT=0. The runtime must report Sandbox enabled; malformed/incomplete configuration must stay disabled.
6. PAYPAL_DEMO_VND_PER_USD is an explicit demo rate, not a market conversion service. Keep the label visible. Default timeout is 10 seconds; default capture lease is 120 seconds. Runtime rejects lease shorter than four provider timeouts plus 10 seconds.
7. Perform approval with the Personal Sandbox account and capture/confirm via the application. Record wallet delta, one matching ledger credit, payment status and redacted provider evidence. Repeat cancel and retry cases from the acceptance checklist.
8. Verify real HTTPS refresh cookies and a real device Passkey with the user. A browser fixture or synthetic authenticator is insufficient evidence.
9. Only after all required cases pass: review PR into migrate-postgres, deploy and smoke-test the intended Enclave domains. Preserve rollback options and record the deployed hash.

## Current blocker

The PayPal dashboard tab stopped responding to the browser tool during this session; two recovery attempts timed out. No credentials were transferred and no Sandbox configuration was enabled. The user has been asked to reopen the Sandbox Applications page. The real test destination and credentials still require verification before activation.
