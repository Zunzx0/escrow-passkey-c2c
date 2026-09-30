import "dotenv/config";
import { z } from "zod";

// Render exposes the final public hostname at runtime. Deriving WebAuthn
// settings from it keeps RP ID, origin, CORS and the browser URL aligned even
// when the service name receives a suffix because the preferred name is busy.
const hostedHostname = process.env.RENDER_EXTERNAL_HOSTNAME?.trim();
const hostedOrigin = hostedHostname ? `https://${hostedHostname}` : undefined;

const booleanFromEnvironment = z.preprocess((value) => {
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}, z.boolean());

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().default(4000),

  // WebAuthn / Passkey
  RP_ID: z.string().min(1).default(hostedHostname ?? "localhost"),
  RP_NAME: z.string().min(1),
  ORIGIN: z.string().min(1).default(hostedOrigin ?? "http://localhost:5173"),

  CORS_ORIGIN: z.string().min(1).default(hostedOrigin ?? "http://localhost:5173"),

  // Session (created identically whether login was by password or Passkey)
  SESSION_COOKIE_NAME: z.string().default("session_token"),
  SESSION_TTL_DAYS: z.coerce.number().default(7),
  SESSION_COOKIE_SECURE: booleanFromEnvironment.default(Boolean(hostedHostname)),

  // WebAuthn challenges — random, single-use, expiring (BA.md §6)
  AUTH_CHALLENGE_TTL_MINUTES: z.coerce.number().default(5),
  // Rate limiting for challenge issuance, per user+IP (BA.md §6, kiến thức §8)
  CHALLENGE_RATE_LIMIT_MAX: z.coerce.number().default(10),
  CHALLENGE_RATE_LIMIT_WINDOW_MINUTES: z.coerce.number().default(10),

  // reauth_grant TTL — short-lived, single-use (BA.md §5, §21)
  REAUTH_GRANT_TTL_MINUTES: z.coerce.number().default(5),

  // Password login rate limiting (kiến thức §46)
  PASSWORD_LOGIN_RATE_LIMIT_MAX: z.coerce.number().default(5),
  PASSWORD_LOGIN_RATE_LIMIT_WINDOW_MINUTES: z.coerce.number().default(1),

  // Business-tracking deadlines only — NOT tied to any auto-release logic
  // (BA.md §10, §18: no auto-release/state-change when they pass).
  DELIVERY_DEADLINE_DAYS: z.coerce.number().default(7),
  INSPECTION_DEADLINE_DAYS: z.coerce.number().default(3),

  // Mock Payment Provider — HMAC secret shared with the (mock) provider to
  // sign/verify webhook callbacks (BA.md §11, kiến thức §33).
  MOCK_PAYMENT_HMAC_SECRET: z.string().min(16),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables:", parsed.error.flatten().fieldErrors);
  throw new Error("Invalid environment variables");
}

export const env = parsed.data;
