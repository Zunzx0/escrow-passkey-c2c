import {
  applyLedgerOperation,
  isWalletEntryUniqueViolation,
  resolveWalletEntryIdempotencyRace,
  type LedgerOperationParams,
  type LedgerOperationResult,
} from "../../src/services/wallet.service";
import { testPrisma } from "./db";

/**
 * TEST-ONLY convenience wrapper — opens its own transaction around a
 * single applyLedgerOperation call, and resolves the same-key concurrent
 * race the way a real caller's OWN catch block would (see
 * resolveWalletEntryIdempotencyRace's doc comment for the exact
 * sequence).
 *
 * Production business services (Stage 4 LOCK, Stage 16 RELEASE, Stage 19
 * REFUND, Stage 21 TOPUP) must NEVER use a wrapper shaped like this: they
 * call `applyLedgerOperation(tx, ...)` INSIDE their own larger
 * `prisma.$transaction`, alongside transaction-state/grant/audit writes,
 * so there is exactly one atomic boundary per business operation
 * (ke-hoach §10). This helper exists only because Stage 3 tests the
 * ledger engine in isolation, before any such real caller exists.
 */
export async function applyLedgerOperationStandalone(params: LedgerOperationParams): Promise<LedgerOperationResult> {
  try {
    return await testPrisma.$transaction((tx) => applyLedgerOperation(tx, params));
  } catch (err) {
    if (!isWalletEntryUniqueViolation(err)) {
      throw err;
    }
    return resolveWalletEntryIdempotencyRace(testPrisma, params.idempotencyKey, params.requestFingerprint);
  }
}
