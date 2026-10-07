# Codex follow-up to Pro release review — 2026-10-07

Reviewed Pro branch claude/paypal-release-review at 7a8d5a4 against base 5080e3a. Its recommendation is conditional acceptance, not completed Sandbox evidence.

## Harness fixes verified

- Browser/context close deadlines increased from 5 to 30 seconds; case/session deadlines are bounded at 35 seconds. Session cleanup completes before root browser cleanup. Cleanup errors still fail the run and retain the owner's lock. Stale-lock diagnostics identify the path and owner PID; no automatic deletion of another holder's lock was introduced.
- Durable fake's empty-lock removal now uses the existing retrySharing function, matching the other cleanup branches.
- Before fixes, new regression checks produced 4 failures: slow context cleanup and EPERM/EACCES/EBUSY empty-lock removal. After fixes, all 12 units pass.
- Chrome fixture runner on the patched code: PASS 458, FAIL 0, SKIP 0, 54 cases, exit 0, 50.3 seconds.
- M2 recovery on SQLite, directly in Downloads with a separate test DB: 47/47, no known issues reproduced, exit 0. This confirms this run, not a guarantee against every Windows sharing condition.
- No product/backend/DB migration changes in this harness fix.

## Decisions on release findings

- F-01 already fixed in f330dc4. Codex's full SQLite combined run after that patch passed with final invariants; the exact payment-provider-isolation and paypal-integration suites both ran. Full PostgreSQL after this product patch remains to be verified independently; the new admission test passed on both dialects.
- F-02: keep reconciliation/webhooks for historical MOCK requests. Disabling new creation must not abandon already submitted payments. Use an isolated Sandbox acceptance DB without historical MOCK PENDING rows.
- F-03: genuine missing abandonment/cancellation workflow. A cancel redirect, age or timeout must never mark an ambiguous captured request FAILED. An explicit owner cancellation needs fresh verified provider evidence, no previous capture POST/claim, transactional conditional close and an audit actor. The four-requests-per-day workaround is not a completed product fix.
- F-05: independent code review confirms /me can fail in entirety due to one UNKNOWN payer-action row's network GET. Fix priority before robust acceptance: history should serialize DB state without provider lookup (UNKNOWN remains RECONCILING and approval URL null); detail/checkout/capture keep fresh verification. Add a red/green HTTP regression before product change. This is NOT fixed by the harness commit.
- F-06: operational PayPal invariant checks should remain separately labelled from the nine thesis invariants. A separate read-only check command is preferable to changing the meaning of the existing nine.

## Counting clarification

1006/997 are runner totals including a final group of nine invariant checks. Pro counted 997/988 individual assertion lines in the suite logs. Keep the group and individual counts separate; do not present these as 1006 independent business scenarios. This is a reporting distinction, not evidence of a money calculation failure.

## Outstanding evidence

Real Sandbox approval/capture/webhook, HTTPS cookies, real device Passkey, F-04 approved-order recovery, full PostgreSQL on the final product hash. Fixture evidence does not replace these. No production deployment or paid-resource creation was performed by this follow-up.
