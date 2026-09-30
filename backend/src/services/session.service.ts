import crypto from "node:crypto";
import type { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { env } from "../config/env";

const DAY_MS = 24 * 60 * 60 * 1000;

export async function createSession(userId: string, req: Request, res: Response) {
  const sessionToken = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + env.SESSION_TTL_DAYS * DAY_MS);

  await prisma.session.create({
    data: {
      sessionToken,
      userId,
      userAgent: req.get("user-agent") ?? undefined,
      ipAddress: req.ip,
      expiresAt,
    },
  });

  res.cookie(env.SESSION_COOKIE_NAME, sessionToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.SESSION_COOKIE_SECURE,
    expires: expiresAt,
    path: "/",
  });
}

export async function destroySession(req: Request, res: Response) {
  const sessionToken = req.cookies?.[env.SESSION_COOKIE_NAME];
  if (sessionToken) {
    await prisma.session.deleteMany({ where: { sessionToken } });
  }
  res.clearCookie(env.SESSION_COOKIE_NAME, { path: "/" });
}

export async function getUserFromRequest(req: Request) {
  const sessionToken = req.cookies?.[env.SESSION_COOKIE_NAME];
  if (!sessionToken) return null;

  const session = await prisma.session.findUnique({
    where: { sessionToken },
    include: { user: true },
  });

  if (!session || session.expiresAt < new Date()) {
    if (session) {
      await prisma.session.delete({ where: { id: session.id } }).catch(() => undefined);
    }
    return null;
  }

  return session.user;
}
