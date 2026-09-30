import { Router } from "express";
import { asyncHandler } from "../middleware/asyncHandler";
import { requireAuth } from "../middleware/requireAuth";
import { getMyWalletEntriesHandler, getMyWalletHandler } from "../controllers/wallet.controller";

export const walletRouter = Router();

walletRouter.get("/me", requireAuth, asyncHandler(getMyWalletHandler));
walletRouter.get("/me/entries", requireAuth, asyncHandler(getMyWalletEntriesHandler));
