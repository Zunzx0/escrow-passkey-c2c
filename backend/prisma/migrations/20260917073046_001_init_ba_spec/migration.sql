-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('BUYER', 'ADMIN');

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('PENDING_PASSKEY', 'ACTIVE');

-- CreateEnum
CREATE TYPE "ChallengePurpose" AS ENUM ('REGISTER', 'LOGIN', 'REAUTH');

-- CreateEnum
CREATE TYPE "GrantAction" AS ENUM ('RELEASE', 'ADJUDICATE', 'ADD_PASSKEY', 'REMOVE_PASSKEY', 'CHANGE_PASSWORD');

-- CreateEnum
CREATE TYPE "GrantDecision" AS ENUM ('REFUND', 'RELEASE');

-- CreateEnum
CREATE TYPE "ListingStatus" AS ENUM ('AVAILABLE', 'LOCKED', 'SOLD');

-- CreateEnum
CREATE TYPE "WalletEntryType" AS ENUM ('TOPUP', 'LOCK', 'RELEASE', 'REFUND');

-- CreateEnum
CREATE TYPE "TransactionStatus" AS ENUM ('CREATED', 'SECURED', 'SHIPPING', 'WAIT_CONFIRM', 'DISPUTED', 'COMPLETED', 'RELEASED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "EscrowStatus" AS ENUM ('NONE', 'LOCKED', 'FROZEN', 'RELEASED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "DisputeInternalStatus" AS ENUM ('OPEN', 'UNDER_REVIEW', 'NEED_MORE_EVIDENCE', 'RESOLVED');

-- CreateEnum
CREATE TYPE "DisputeDecision" AS ENUM ('REFUND', 'RELEASE');

-- CreateEnum
CREATE TYPE "PaymentRequestStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'TIMEOUT');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "displayName" TEXT,
    "role" "UserRole" NOT NULL DEFAULT 'BUYER',
    "accountStatus" "AccountStatus" NOT NULL DEFAULT 'PENDING_PASSKEY',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PasskeyCredential" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "publicKey" BYTEA NOT NULL,
    "counter" BIGINT NOT NULL DEFAULT 0,
    "transports" TEXT[],
    "deviceType" TEXT,
    "backedUp" BOOLEAN NOT NULL DEFAULT false,
    "aaguid" TEXT,
    "nickname" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "PasskeyCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "sessionToken" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "userAgent" TEXT,
    "ipAddress" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthChallenge" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "purpose" "ChallengePurpose" NOT NULL,
    "challenge" TEXT NOT NULL,
    "context" JSONB,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReauthGrant" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "action" "GrantAction" NOT NULL,
    "transactionId" TEXT,
    "disputeId" TEXT,
    "decision" "GrantDecision",
    "context" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReauthGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Listing" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "price" INTEGER NOT NULL,
    "status" "ListingStatus" NOT NULL DEFAULT 'AVAILABLE',
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Listing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ListingImage" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ListingImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Wallet" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "isEscrow" BOOLEAN NOT NULL DEFAULT false,
    "availableBalance" INTEGER NOT NULL DEFAULT 0,
    "lockedBalance" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Wallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletEntry" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "transactionId" TEXT,
    "paymentRequestId" TEXT,
    "deltaAvailable" INTEGER NOT NULL,
    "deltaLocked" INTEGER NOT NULL,
    "availableBalanceAfter" INTEGER NOT NULL,
    "lockedBalanceAfter" INTEGER NOT NULL,
    "entryType" "WalletEntryType" NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestFingerprint" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalletEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Transaction" (
    "id" TEXT NOT NULL,
    "buyerId" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "status" "TransactionStatus" NOT NULL DEFAULT 'CREATED',
    "escrowStatus" "EscrowStatus" NOT NULL DEFAULT 'NONE',
    "version" INTEGER NOT NULL DEFAULT 0,
    "deliveryDeadline" TIMESTAMP(3),
    "inspectionDeadline" TIMESTAMP(3),
    "sellerAckAt" TIMESTAMP(3),
    "shippedAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "refundedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Dispute" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "openedById" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "DisputeInternalStatus" NOT NULL DEFAULT 'OPEN',
    "decision" "DisputeDecision",
    "resolvedById" TEXT,
    "resolutionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "Dispute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT,
    "paymentRequestId" TEXT,
    "seqNo" INTEGER NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "prevHash" TEXT NOT NULL,
    "currentHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "status" "PaymentRequestStatus" NOT NULL DEFAULT 'PENDING',
    "idempotencyKey" TEXT NOT NULL,
    "providerReference" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentCallback" (
    "id" TEXT NOT NULL,
    "paymentRequestId" TEXT NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "reportedStatus" "PaymentRequestStatus" NOT NULL,
    "signatureValid" BOOLEAN NOT NULL,
    "rawPayload" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "PaymentCallback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "PasskeyCredential_credentialId_key" ON "PasskeyCredential"("credentialId");

-- CreateIndex
CREATE INDEX "PasskeyCredential_userId_idx" ON "PasskeyCredential"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_sessionToken_key" ON "Session"("sessionToken");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "AuthChallenge_challenge_key" ON "AuthChallenge"("challenge");

-- CreateIndex
CREATE INDEX "AuthChallenge_userId_idx" ON "AuthChallenge"("userId");

-- CreateIndex
CREATE INDEX "AuthChallenge_expiresAt_idx" ON "AuthChallenge"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReauthGrant_tokenHash_key" ON "ReauthGrant"("tokenHash");

-- CreateIndex
CREATE INDEX "ReauthGrant_userId_idx" ON "ReauthGrant"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Wallet_userId_key" ON "Wallet"("userId");

-- CreateIndex
CREATE INDEX "WalletEntry_walletId_idx" ON "WalletEntry"("walletId");

-- CreateIndex
CREATE INDEX "WalletEntry_transactionId_idx" ON "WalletEntry"("transactionId");

-- CreateIndex
CREATE INDEX "WalletEntry_paymentRequestId_idx" ON "WalletEntry"("paymentRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "WalletEntry_idempotencyKey_walletId_key" ON "WalletEntry"("idempotencyKey", "walletId");

-- CreateIndex
CREATE INDEX "Transaction_buyerId_idx" ON "Transaction"("buyerId");

-- CreateIndex
CREATE INDEX "Transaction_sellerId_idx" ON "Transaction"("sellerId");

-- CreateIndex
CREATE INDEX "Transaction_listingId_idx" ON "Transaction"("listingId");

-- CreateIndex
CREATE INDEX "Transaction_status_idx" ON "Transaction"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Dispute_transactionId_key" ON "Dispute"("transactionId");

-- CreateIndex
CREATE INDEX "AuditLog_transactionId_idx" ON "AuditLog"("transactionId");

-- CreateIndex
CREATE INDEX "AuditLog_paymentRequestId_idx" ON "AuditLog"("paymentRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "AuditLog_transactionId_seqNo_key" ON "AuditLog"("transactionId", "seqNo");

-- CreateIndex
CREATE UNIQUE INDEX "AuditLog_paymentRequestId_seqNo_key" ON "AuditLog"("paymentRequestId", "seqNo");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentRequest_idempotencyKey_key" ON "PaymentRequest"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentRequest_providerReference_key" ON "PaymentRequest"("providerReference");

-- CreateIndex
CREATE INDEX "PaymentCallback_paymentRequestId_idx" ON "PaymentCallback"("paymentRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentCallback_paymentRequestId_providerEventId_key" ON "PaymentCallback"("paymentRequestId", "providerEventId");

-- AddForeignKey
ALTER TABLE "PasskeyCredential" ADD CONSTRAINT "PasskeyCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthChallenge" ADD CONSTRAINT "AuthChallenge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReauthGrant" ADD CONSTRAINT "ReauthGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReauthGrant" ADD CONSTRAINT "ReauthGrant_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReauthGrant" ADD CONSTRAINT "ReauthGrant_disputeId_fkey" FOREIGN KEY ("disputeId") REFERENCES "Dispute"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Listing" ADD CONSTRAINT "Listing_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingImage" ADD CONSTRAINT "ListingImage_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletEntry" ADD CONSTRAINT "WalletEntry_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletEntry" ADD CONSTRAINT "WalletEntry_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletEntry" ADD CONSTRAINT "WalletEntry_paymentRequestId_fkey" FOREIGN KEY ("paymentRequestId") REFERENCES "PaymentRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dispute" ADD CONSTRAINT "Dispute_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dispute" ADD CONSTRAINT "Dispute_openedById_fkey" FOREIGN KEY ("openedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dispute" ADD CONSTRAINT "Dispute_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_paymentRequestId_fkey" FOREIGN KEY ("paymentRequestId") REFERENCES "PaymentRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentRequest" ADD CONSTRAINT "PaymentRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentCallback" ADD CONSTRAINT "PaymentCallback_paymentRequestId_fkey" FOREIGN KEY ("paymentRequestId") REFERENCES "PaymentRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
