import { env } from "./env";

export const webauthnConfig = {
  rpID: env.RP_ID,
  rpName: env.RP_NAME,
  origin: env.ORIGIN,
};
