import { Router } from "express";
import { asyncHandler } from "../middleware/asyncHandler";
import { requireAuth } from "../middleware/requireAuth";
import {
  getMyTransactions,
  getTransaction,
  postBuyerReceive,
  postCreateTransaction,
  postLockTransaction,
  postOpenDispute,
  postReleaseReauthOptions,
  postReleaseReauthVerify,
  postReleaseTransaction,
  postSellerAck,
  postShipTransaction,
} from "../controllers/transaction.controller";

export const transactionRouter = Router();

transactionRouter.post("/", requireAuth, asyncHandler(postCreateTransaction));
// Must be registered before "/:id" so "mine" isn't swallowed as an id param.
transactionRouter.get("/mine", requireAuth, asyncHandler(getMyTransactions));
transactionRouter.get("/:id", requireAuth, asyncHandler(getTransaction));
transactionRouter.post("/:id/lock", requireAuth, asyncHandler(postLockTransaction));
transactionRouter.post("/:id/seller-ack", requireAuth, asyncHandler(postSellerAck));
transactionRouter.post("/:id/ship", requireAuth, asyncHandler(postShipTransaction));
transactionRouter.post("/:id/receive", requireAuth, asyncHandler(postBuyerReceive));
// Stage 6: re-auth + scoped grant (issues an authorization token that
// Stage 7's RELEASE endpoint below consumes).
transactionRouter.post("/:id/release/reauth/options", requireAuth, asyncHandler(postReleaseReauthOptions));
transactionRouter.post("/:id/release/reauth/verify", requireAuth, asyncHandler(postReleaseReauthVerify));
// Stage 7: the actual money-moving RELEASE action.
transactionRouter.post("/:id/release", requireAuth, asyncHandler(postReleaseTransaction));
// Stage 8: open dispute / FREEZE — either party of the transaction, from an
// allowed state (buyer: SECURED/SHIPPING/WAIT_CONFIRM, seller: WAIT_CONFIRM).
transactionRouter.post("/:id/dispute", requireAuth, asyncHandler(postOpenDispute));
