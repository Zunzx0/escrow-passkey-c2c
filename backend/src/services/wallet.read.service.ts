import { prisma } from "../lib/prisma";
import { HttpError } from "../utils/httpError";

// Read-only accessor, deliberately separate from wallet.service.ts (which
// owns every WRITE to a wallet's balance). Added for the FE (frontend
// review, 2026-09-18): a buyer needs to see their own balance before
// attempting to LOCK a transaction. This never mutates anything.
export async function getMyWallet(userId: string) {
  const wallet = await prisma.wallet.findUnique({ where: { userId } });
  if (!wallet) throw new HttpError(404, "Không tìm thấy ví.");
  return {
    availableBalance: wallet.availableBalance,
    lockedBalance: wallet.lockedBalance,
    version: wallet.version,
  };
}

// The caller's own balance-change history (ke-hoach FE design review §10.3
// "Lịch sử biến động") — every WalletEntry row for their own wallet, most
// recent first. Read-only, scoped to `wallet.userId === userId`; never
// exposes another user's or the Escrow wallet's entries.
export async function getMyWalletEntries(userId: string) {
  const wallet = await prisma.wallet.findUnique({ where: { userId } });
  if (!wallet) throw new HttpError(404, "Không tìm thấy ví.");
  const entries = await prisma.walletEntry.findMany({
    where: { walletId: wallet.id },
    orderBy: { createdAt: "desc" },
  });
  return entries.map((e) => ({
    id: e.id,
    entryType: e.entryType,
    deltaAvailable: e.deltaAvailable,
    deltaLocked: e.deltaLocked,
    availableBalanceAfter: e.availableBalanceAfter,
    lockedBalanceAfter: e.lockedBalanceAfter,
    transactionId: e.transactionId,
    paymentRequestId: e.paymentRequestId,
    createdAt: e.createdAt,
  }));
}
