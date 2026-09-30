import type { Request, Response } from "express";
import { z } from "zod";
import { assertMemberRole, POSTGRES_INT4_MAX } from "../utils/authz";
import {
  createTopUpRequest,
  getPaymentRequestForOwner,
  listMyPaymentRequests,
  processWebhookCallback,
  simulateMockProviderCallback,
} from "../services/payment.service";

const topUpSchema = z.object({
  amount: z.number().int().positive().max(POSTGRES_INT4_MAX),
  idempotencyKey: z.string().min(1).max(200),
});

export async function postTopUp(req: Request, res: Response) {
  assertMemberRole(req.user!);
  const body = topUpSchema.parse(req.body);
  const request = await createTopUpRequest(req.user!.id, body.amount, body.idempotencyKey);
  res.status(201).json(request);
}

export async function getMyPaymentRequests(req: Request, res: Response) {
  assertMemberRole(req.user!);
  const requests = await listMyPaymentRequests(req.user!.id);
  res.json(requests);
}

export async function getPaymentRequest(req: Request, res: Response) {
  assertMemberRole(req.user!);
  const request = await getPaymentRequestForOwner(req.user!.id, req.params.id);
  res.json(request);
}

// --- Dev/test tool: stands in for the outside Mock Provider deciding an
// outcome and calling our webhook. See payment.service.ts's
// simulateMockProviderCallback doc comment for why this shares the exact
// same processing function as the real webhook below.
const simulateSchema = z.object({
  status: z.enum(["PENDING", "SUCCEEDED", "FAILED", "TIMEOUT"]),
  eventId: z.string().min(1).max(200).optional(),
});

export async function postSimulateProviderCallback(req: Request, res: Response) {
  assertMemberRole(req.user!);
  // Ownership check happens here, at the route layer — a real provider
  // callback has no "owner" concept, but this endpoint only exists BECAUSE
  // there is no real external provider, so it's scoped to the request's
  // own owner to stop one member from completing/failing another
  // member's top-up.
  await getPaymentRequestForOwner(req.user!.id, req.params.id);
  const body = simulateSchema.parse(req.body);
  const result = await simulateMockProviderCallback(req.params.id, body.status, body.eventId);
  res.json(result);
}

// --- The real webhook receiver — what an actual Mock Provider process (or
// a test proving forged-signature rejection) calls. Deliberately NOT
// behind requireAuth: a real payment provider has no session with our
// server, only the shared HMAC secret (ke-hoach §8, kiến thức §33).
const webhookPayloadSchema = z.object({
  providerReference: z.string().min(1),
  eventId: z.string().min(1),
  status: z.enum(["PENDING", "SUCCEEDED", "FAILED", "TIMEOUT"]),
  // Same Int4 ceiling as every other money-input boundary in this codebase
  // (ke-hoach §19 "Amount lớn") — a callback (real or forged) claiming an
  // out-of-range amount must be rejected with a clean 400, never reach
  // Prisma/Postgres and fail with a raw DB error.
  amount: z.number().int().positive().max(POSTGRES_INT4_MAX),
  timestamp: z.string().min(1),
});

const webhookBodySchema = z.object({
  payload: webhookPayloadSchema,
  signature: z.string().min(1),
});

const OUTCOME_STATUS: Record<string, number> = {
  REJECTED_SIGNATURE: 401,
  REJECTED_AMOUNT_MISMATCH: 409,
};

export async function postPaymentWebhook(req: Request, res: Response) {
  const body = webhookBodySchema.parse(req.body);
  const result = await processWebhookCallback(body.payload, body.signature);
  res.status(OUTCOME_STATUS[result.outcome] ?? 200).json(result);
}
