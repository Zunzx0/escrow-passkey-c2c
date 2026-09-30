import type { NextFunction, Request, Response } from "express";
import type { User } from "@prisma/client";
import { getUserFromRequest } from "../services/session.service";
import { HttpError } from "../utils/httpError";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const user = await getUserFromRequest(req);
  if (!user) {
    next(new HttpError(401, "Not authenticated"));
    return;
  }
  req.user = user;
  next();
}

export async function attachUserIfPresent(req: Request, _res: Response, next: NextFunction) {
  const user = await getUserFromRequest(req);
  if (user) req.user = user;
  next();
}
