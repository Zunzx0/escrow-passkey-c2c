import { Router } from "express";
import { asyncHandler } from "../middleware/asyncHandler";
import { requireAuth } from "../middleware/requireAuth";
import {
  getDispute,
  getDisputes,
  postAdjudicateDispute,
  postAdjudicationReauthOptions,
  postAdjudicationReauthVerify,
} from "../controllers/dispute.controller";

export const disputeRouter = Router();

// Opening a dispute lives on transactionRouter (POST /api/transactions/:id/dispute,
// Stage 8) — everything here is the admin-only adjudication side (Stage 9).
disputeRouter.get("/", requireAuth, asyncHandler(getDisputes));
disputeRouter.get("/:id", requireAuth, asyncHandler(getDispute));
disputeRouter.post("/:id/adjudicate/reauth/options", requireAuth, asyncHandler(postAdjudicationReauthOptions));
disputeRouter.post("/:id/adjudicate/reauth/verify", requireAuth, asyncHandler(postAdjudicationReauthVerify));
disputeRouter.post("/:id/adjudicate", requireAuth, asyncHandler(postAdjudicateDispute));
