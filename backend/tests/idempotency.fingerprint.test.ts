import { describe, expect, it } from "vitest";
import { computeRequestFingerprint } from "../src/utils/idempotency";

// Pure, DB-free tests for the request_fingerprint helper (ke-hoach §11).
describe("computeRequestFingerprint", () => {
  it("is stable regardless of top-level key order", () => {
    const a = computeRequestFingerprint({ actorId: "u1", amount: 1000, action: "LOCK" });
    const b = computeRequestFingerprint({ amount: 1000, action: "LOCK", actorId: "u1" });
    expect(a).toBe(b);
  });

  it("is stable regardless of nested object key order", () => {
    const a = computeRequestFingerprint({ actorId: "admin1", context: { disputeId: "d1", decision: "REFUND" } });
    const b = computeRequestFingerprint({ actorId: "admin1", context: { decision: "REFUND", disputeId: "d1" } });
    expect(a).toBe(b);
  });

  it("changes when the amount changes", () => {
    const base = computeRequestFingerprint({ actorId: "u1", transactionId: "t1", action: "LOCK", amount: 1000 });
    const changed = computeRequestFingerprint({ actorId: "u1", transactionId: "t1", action: "LOCK", amount: 2000 });
    expect(changed).not.toBe(base);
  });

  it("changes when the actor changes", () => {
    const base = computeRequestFingerprint({ actorId: "u1", transactionId: "t1", action: "LOCK", amount: 1000 });
    const changed = computeRequestFingerprint({ actorId: "u2", transactionId: "t1", action: "LOCK", amount: 1000 });
    expect(changed).not.toBe(base);
  });

  it("changes when the action changes", () => {
    const lock = computeRequestFingerprint({ actorId: "u1", transactionId: "t1", action: "LOCK", amount: 1000 });
    const release = computeRequestFingerprint({ actorId: "u1", transactionId: "t1", action: "RELEASE", amount: 1000 });
    expect(lock).not.toBe(release);
  });

  it("changes when the transaction changes", () => {
    const t1 = computeRequestFingerprint({ actorId: "u1", transactionId: "t1", action: "LOCK", amount: 1000 });
    const t2 = computeRequestFingerprint({ actorId: "u1", transactionId: "t2", action: "LOCK", amount: 1000 });
    expect(t1).not.toBe(t2);
  });

  it("changes when the dispute changes but the decision stays the same", () => {
    const d1 = computeRequestFingerprint({ actorId: "admin1", disputeId: "d1", decision: "REFUND" });
    const d2 = computeRequestFingerprint({ actorId: "admin1", disputeId: "d2", decision: "REFUND" });
    expect(d1).not.toBe(d2);
  });

  it("changes when a decision-context field changes (admin adjudication: same dispute, different decision)", () => {
    const release = computeRequestFingerprint({ actorId: "admin1", disputeId: "d1", decision: "RELEASE" });
    const refund = computeRequestFingerprint({ actorId: "admin1", disputeId: "d1", decision: "REFUND" });
    expect(release).not.toBe(refund);
  });

  it("produces a 64-char lowercase hex sha256 digest", () => {
    const hash = computeRequestFingerprint({ a: 1 });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
