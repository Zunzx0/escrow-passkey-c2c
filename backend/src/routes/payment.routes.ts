import { Router } from "express";
import { asyncHandler } from "../middleware/asyncHandler";
import { requireAuth } from "../middleware/requireAuth";
import {
  getMyPaymentRequests,
  getPaymentRequest,
  postPaymentWebhook,
  postSimulateProviderCallback,
  postTopUp,
} from "../controllers/payment.controller";

export const paymentRouter = Router();

paymentRouter.post("/topup", requireAuth, asyncHandler(postTopUp));
// Must be registered before "/:id" so "mine" isn't swallowed as an id param.
paymentRouter.get("/mine", requireAuth, asyncHandler(getMyPaymentRequests));
paymentRouter.get("/:id", requireAuth, asyncHandler(getPaymentRequest));
paymentRouter.post("/:id/simulate", requireAuth, asyncHandler(postSimulateProviderCallback));
// Public — a real Mock Payment Provider process has no session with us,
// only the shared HMAC secret. Authenticity comes from the signature
// check inside processWebhookCallback, never from requireAuth.
paymentRouter.post("/webhook", asyncHandler(postPaymentWebhook));
