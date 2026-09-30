import type { EscrowStatus, ListingStatus, TransactionStatus, WalletEntryType } from "../api/types";

type Tone = "slate" | "amber" | "blue" | "green" | "red" | "purple";

export const transactionStatusLabel: Record<TransactionStatus, string> = {
  CREATED: "Vừa tạo",
  SECURED: "Đã khóa tiền",
  SHIPPING: "Đang giao",
  WAIT_CONFIRM: "Chờ xác nhận",
  DISPUTED: "Đang tranh chấp",
  COMPLETED: "Hoàn tất",
  RELEASED: "Đã giải ngân",
  REFUNDED: "Đã hoàn tiền",
};

export const transactionStatusTone: Record<TransactionStatus, Tone> = {
  CREATED: "slate",
  SECURED: "blue",
  SHIPPING: "amber",
  WAIT_CONFIRM: "amber",
  DISPUTED: "red",
  COMPLETED: "green",
  RELEASED: "green",
  REFUNDED: "purple",
};

export const escrowStatusLabel: Record<EscrowStatus, string> = {
  NONE: "Chưa liên quan tới ký quỹ",
  LOCKED: "Tiền đang được giữ an toàn",
  FROZEN: "Tiền tạm khóa do tranh chấp",
  RELEASED: "Tiền đã chuyển cho người bán",
  REFUNDED: "Tiền đã hoàn cho người mua",
};

export const listingStatusLabel: Record<ListingStatus, string> = {
  AVAILABLE: "Đang bán",
  LOCKED: "Đã có người mua",
  SOLD: "Đã bán",
};

export const listingStatusTone: Record<ListingStatus, Tone> = {
  AVAILABLE: "green",
  LOCKED: "amber",
  SOLD: "slate",
};

export const walletEntryTypeLabel: Record<WalletEntryType, string> = {
  TOPUP: "Nạp tiền",
  LOCK: "Khóa tiền vào Escrow",
  RELEASE: "Giải ngân",
  REFUND: "Hoàn tiền",
};

export function formatVnd(amount: number): string {
  return new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 }).format(amount);
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("vi-VN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
}

export function formatRelativeTime(iso: string): string {
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "Vừa đăng";
  if (minutes < 60) return `${minutes} phút trước`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} giờ trước`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} ngày trước`;
  return new Intl.DateTimeFormat("vi-VN", { dateStyle: "medium" }).format(new Date(iso));
}
