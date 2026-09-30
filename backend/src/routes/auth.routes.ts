import { Router } from "express";
import { asyncHandler } from "../middleware/asyncHandler";
import { requireAuth } from "../middleware/requireAuth";
import {
  getMe,
  postLoginPassword,
  postLoginPasskeyOptions,
  postLoginPasskeyVerify,
  postLogout,
  postRegister,
  postRegisterPasskeyOptions,
  postRegisterPasskeyVerify,
} from "../controllers/auth.controller";

export const authRouter = Router();

// Registration — two phases (BA.md §3.3, §19): password first, then a
// mandatory first Passkey activates the account.
authRouter.post("/register", asyncHandler(postRegister));
authRouter.post("/register/passkey/options", asyncHandler(postRegisterPasskeyOptions));
authRouter.post("/register/passkey/verify", asyncHandler(postRegisterPasskeyVerify));

// Login — hybrid: password OR Passkey, both create the same session type
// (BA.md §3.2, §20).
authRouter.post("/login/password", asyncHandler(postLoginPassword));
authRouter.post("/login/passkey/options", asyncHandler(postLoginPasskeyOptions));
authRouter.post("/login/passkey/verify", asyncHandler(postLoginPasskeyVerify));

authRouter.post("/logout", asyncHandler(postLogout));
authRouter.get("/me", requireAuth, asyncHandler(getMe));
