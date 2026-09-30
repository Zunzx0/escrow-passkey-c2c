import { apiGet } from "./client";
import type { Wallet, WalletEntry } from "./types";

export function getMyWallet() {
  return apiGet<Wallet>("/wallet/me");
}

export function getMyWalletEntries() {
  return apiGet<WalletEntry[]>("/wallet/me/entries");
}
