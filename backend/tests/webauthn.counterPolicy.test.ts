import { describe, expect, it } from "vitest";
import { decideCounterUpdate } from "../src/services/webauthn.service";

// Pure decision-table tests for the signCount risk policy (Stage 2
// review, 2026-09-17) — deliberately isolated from HTTP/DB/crypto so
// every subtle combination can be checked precisely and fast.
describe("decideCounterUpdate", () => {
  it("stored=0, new=0: counter-less authenticator, no event, persists 0", () => {
    const result = decideCounterUpdate(0n, 0n);
    expect(result).toEqual({ counterToPersist: 0n, securityEvent: null });
  });

  it("stored=0, new>0: first real reading establishes the baseline, no event", () => {
    const result = decideCounterUpdate(0n, 5n);
    expect(result).toEqual({ counterToPersist: 5n, securityEvent: null });
  });

  it("stored>0, new>stored: normal increment, no event", () => {
    const result = decideCounterUpdate(10n, 11n);
    expect(result).toEqual({ counterToPersist: 11n, securityEvent: null });
  });

  it("stored>0, 0<new<=stored: anomaly logged, but the HIGH-WATER MARK is kept (not overwritten with the lower value)", () => {
    const result = decideCounterUpdate(10n, 7n);
    expect(result.counterToPersist).toBe(10n);
    expect(result.securityEvent).toEqual({ eventType: "WEBAUTHN_SIGNCOUNT_ANOMALY", severity: "WARNING" });
  });

  it("stored>0, new==stored (no increment at all): still an anomaly, still keeps the mark", () => {
    const result = decideCounterUpdate(10n, 10n);
    expect(result.counterToPersist).toBe(10n);
    expect(result.securityEvent).toEqual({ eventType: "WEBAUTHN_SIGNCOUNT_ANOMALY", severity: "WARNING" });
  });

  it("stored>0, new=0: a distinct signal (previously-counting credential now claims no support) — NOT treated as an ordinary regression, and the mark is still kept so future detection isn't disabled", () => {
    const result = decideCounterUpdate(10n, 0n);
    expect(result.counterToPersist).toBe(10n);
    expect(result.securityEvent).toEqual({ eventType: "WEBAUTHN_COUNTER_RESET_TO_ZERO", severity: "WARNING" });
  });

  it("never auto-fails: every case returns a counterToPersist, never throws", () => {
    for (const [stored, incoming] of [
      [0n, 0n],
      [0n, 999n],
      [999n, 1000n],
      [999n, 1n],
      [999n, 999n],
      [999n, 0n],
    ] as [bigint, bigint][]) {
      expect(() => decideCounterUpdate(stored, incoming)).not.toThrow();
    }
  });
});
