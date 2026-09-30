export type UserRole = "MEMBER" | "ADMIN";
export type AccountStatus = "PENDING_PASSKEY" | "ACTIVE";

export interface CurrentUser {
  id: string;
  email: string;
  displayName: string | null;
  role: UserRole;
  accountStatus: AccountStatus;
}

export type ListingStatus = "AVAILABLE" | "LOCKED" | "SOLD";

export interface ListingImage {
  id: string;
  url: string;
  position: number;
}

export interface ListingSeller {
  id: string;
  displayName: string | null;
}

export interface Listing {
  id: string;
  sellerId: string;
  title: string;
  description: string | null;
  price: number;
  status: ListingStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
  images: ListingImage[];
  /** Present on the public browse + detail responses; absent from GET /listings/mine (you are the seller there). */
  seller?: ListingSeller;
}

export interface ListingPage {
  items: Listing[];
  total: number;
  page: number;
  limit: number;
}

export type ListingSort = "newest" | "price_asc" | "price_desc";

export type TransactionStatus = "CREATED" | "SECURED" | "SHIPPING" | "WAIT_CONFIRM" | "DISPUTED" | "COMPLETED" | "RELEASED" | "REFUNDED";
export type EscrowStatus = "NONE" | "LOCKED" | "FROZEN" | "RELEASED" | "REFUNDED";

export interface Transaction {
  id: string;
  buyerId: string;
  sellerId: string;
  listingId: string;
  amount: number;
  status: TransactionStatus;
  escrowStatus: EscrowStatus;
  version: number;
  deliveryDeadline: string | null;
  inspectionDeadline: string | null;
  sellerAckAt: string | null;
  shippedAt: string | null;
  receivedAt: string | null;
  completedAt: string | null;
  releasedAt: string | null;
  refundedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Wallet {
  availableBalance: number;
  lockedBalance: number;
  version: number;
}

export type WalletEntryType = "TOPUP" | "LOCK" | "RELEASE" | "REFUND";

export interface WalletEntry {
  id: string;
  entryType: WalletEntryType;
  deltaAvailable: number;
  deltaLocked: number;
  availableBalanceAfter: number;
  lockedBalanceAfter: number;
  transactionId: string | null;
  paymentRequestId: string | null;
  createdAt: string;
}

export type PaymentRequestStatus = "PENDING" | "SUCCEEDED" | "FAILED" | "TIMEOUT";

export interface PaymentRequest {
  id: string;
  userId: string;
  amount: number;
  status: PaymentRequestStatus;
  idempotencyKey: string;
  providerReference: string;
  createdAt: string;
  updatedAt: string;
}

export type WebhookOutcome =
  | "CREDITED"
  | "FAILED"
  | "TIMEOUT"
  | "ACKNOWLEDGED_PENDING"
  | "REJECTED_SIGNATURE"
  | "REJECTED_AMOUNT_MISMATCH"
  | "IGNORED_TERMINAL"
  | "REPLAYED_DUPLICATE";

export interface WebhookResult {
  outcome: WebhookOutcome;
  paymentRequestId: string;
}

export type DisputeInternalStatus = "OPEN" | "UNDER_REVIEW" | "NEED_MORE_EVIDENCE" | "RESOLVED";
export type DisputeDecision = "REFUND" | "RELEASE";

export interface Dispute {
  id: string;
  transactionId: string;
  openedById: string;
  reason: string;
  status: DisputeInternalStatus;
  decision: DisputeDecision | null;
  resolvedById: string | null;
  resolutionNote: string | null;
  createdAt: string;
  resolvedAt: string | null;
  transaction?: Transaction;
}
