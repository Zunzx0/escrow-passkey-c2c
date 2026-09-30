import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { HttpError } from "../utils/httpError";

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }

  // Was previously falling through to a raw 500 for any invalid request
  // body — violates ke-hoach §16's "chuẩn 400/401/403/404/409/429/5xx"
  // (Stage 4 review: caught while adding more zod-validated endpoints).
  if (err instanceof ZodError) {
    res.status(400).json({
      error: "Invalid request",
      details: err.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
    return;
  }

  console.error(err);
  res.status(500).json({ error: "Internal server error" });
}
