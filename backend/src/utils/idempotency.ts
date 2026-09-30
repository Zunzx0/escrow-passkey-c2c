import { createHash } from "node:crypto";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return Object.keys(obj)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = canonicalize(obj[key]);
        return acc;
      }, {});
  }
  return value;
}

/**
 * ke-hoach §11: request_fingerprint must hash at minimum actor_id,
 * transaction_id/payment_request_id, the action type, the amount, and any
 * context field that determines the outcome (e.g. dispute_id + decision
 * for admin adjudication) — omitting one of those lets a same-key retry
 * be mistaken for a different, unintended operation. Callers decide which
 * fields go in; this only guarantees the hash is stable regardless of key
 * order (including nested objects), so equivalent requests always match.
 *
 * CRITICAL (Stage 3 review, 2026-09-17): every field passed in here MUST
 * come from data the SERVER has already looked up/verified, never copied
 * straight from the client's request body. E.g. `amount` must be
 * `transaction.amount` read from the DB inside the same handler, not
 * `req.body.amount` — a client sending `{"amount": 1000000}` must not be
 * able to influence the fingerprint before the server has checked that
 * value against the real transaction. If the client-sent value were used
 * directly, a forged amount would still just produce "a" valid-looking
 * fingerprint, defeating the entire point of binding the key to a
 * specific, server-confirmed outcome.
 */
export function computeRequestFingerprint(fields: Record<string, unknown>): string {
  const canonicalJson = JSON.stringify(canonicalize(fields));
  return createHash("sha256").update(canonicalJson).digest("hex");
}
