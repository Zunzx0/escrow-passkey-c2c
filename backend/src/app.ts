import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { existsSync } from "node:fs";
import path from "node:path";
import { env } from "./config/env";
import { authRouter } from "./routes/auth.routes";
import { disputeRouter } from "./routes/dispute.routes";
import { listingRouter } from "./routes/listing.routes";
import { paymentRouter } from "./routes/payment.routes";
import { transactionRouter } from "./routes/transaction.routes";
import { walletRouter } from "./routes/wallet.routes";
import { errorHandler } from "./middleware/errorHandler";

export const app = express();

app.use(
  cors({
    origin: env.CORS_ORIGIN,
    credentials: true,
  })
);
app.use(express.json());
app.use(cookieParser());

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Routers are mounted stage by stage per ke-hoach-du-an-escrow-passkey.md
// section 28 ("Thứ tự chính thức"): auth (Stage 2), listings/transactions/
// LOCK (Stage 4), shipping/receive (Stage 5+), disputes/admin (Stage 7),
// payments (Stage 9). The wallet/ledger engine (Stage 3) has no router of
// its own — it's only ever called from inside another router's service.
app.use("/api/auth", authRouter);
app.use("/api/listings", listingRouter);
app.use("/api/transactions", transactionRouter);
app.use("/api/wallet", walletRouter);
app.use("/api/disputes", disputeRouter);
app.use("/api/payments", paymentRouter);

// The production container places the Vite build next to dist/. Serving it
// from Express gives the application one HTTPS origin, which is the simplest
// and most reliable setup for session cookies and WebAuthn RP validation.
const frontendDirectory = path.resolve(__dirname, "../public");
if (existsSync(frontendDirectory)) {
  app.use(express.static(frontendDirectory));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api/")) return next();
    res.sendFile(path.join(frontendDirectory, "index.html"));
  });
}

app.use(errorHandler);
