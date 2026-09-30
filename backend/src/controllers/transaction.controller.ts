import type { Request, Response } from "express";
import { z } from "zod";
import { assertMemberRole } from "../utils/authz";
import {
  buyerReceive,
  createTransaction,
  getTransactionForParticipant,
  listMyTransactions,
  lockTransaction,
  openDispute,
  releaseTransaction,
  requestReleaseReauth,
  sellerAcknowledge,
  shipTransaction,
  verifyReleaseReauth,
} from "../services/transaction.service";
import { checkChallengeIssuanceRateLimit } from "../services/webauthn.service";

const createTransactionSchema = z.object({ listingId: z.string().min(1) });

export async function postCreateTransaction(req: Request, res: Response) {
  assertMemberRole(req.user!);
  const body = createTransactionSchema.parse(req.body);
  const transaction = await createTransaction(req.user!.id, body.listingId);
  res.status(201).json(transaction);
}

export async function getTransaction(req: Request, res: Response) {
  const transaction = await getTransactionForParticipant(req.user!.id, req.params.id);
  res.json(transaction);
}

export async function getMyTransactions(req: Request, res: Response) {
  const transactions = await listMyTransactions(req.user!.id);
  res.json(transactions);
}

export async function postLockTransaction(req: Request, res: Response) {
  assertMemberRole(req.user!);
  const transaction = await lockTransaction(req.user!.id, req.params.id);
  res.json(transaction);
}

export async function postSellerAck(req: Request, res: Response) {
  assertMemberRole(req.user!);
  const transaction = await sellerAcknowledge(req.user!.id, req.params.id);
  res.json(transaction);
}

export async function postShipTransaction(req: Request, res: Response) {
  assertMemberRole(req.user!);
  const transaction = await shipTransaction(req.user!.id, req.params.id);
  res.json(transaction);
}

export async function postBuyerReceive(req: Request, res: Response) {
  assertMemberRole(req.user!);
  const transaction = await buyerReceive(req.user!.id, req.params.id);
  res.json(transaction);
}

// --- Stage 6: Passkey re-auth + scoped grant, worked example = RELEASE --
// The grant issued here is NOT the RELEASE action itself (Stage 16) —
// only a short-lived, single-use authorization token the client must
// present to that future endpoint.

export async function postReleaseReauthOptions(req: Request, res: Response) {
  assertMemberRole(req.user!);
  checkChallengeIssuanceRateLimit("REAUTH", req.ip ?? "unknown", req.user!.email);
  const options = await requestReleaseReauth(req.user!.id, req.params.id);
  res.json(options);
}

const releaseReauthVerifySchema = z.object({ response: z.any() });

export async function postReleaseReauthVerify(req: Request, res: Response) {
  assertMemberRole(req.user!);
  const body = releaseReauthVerifySchema.parse(req.body);
  const grant = await verifyReleaseReauth(req.user!.id, req.params.id, body.response);
  res.json(grant);
}

// --- Stage 7: Buyer RELEASE ------------------------------------------------

const releaseSchema = z.object({ token: z.string().min(1) });

export async function postReleaseTransaction(req: Request, res: Response) {
  assertMemberRole(req.user!);
  const body = releaseSchema.parse(req.body);
  const transaction = await releaseTransaction(req.user!.id, req.params.id, body.token);
  res.json(transaction);
}

// --- Stage 8: Open dispute / FREEZE ----------------------------------------

const openDisputeSchema = z.object({ reason: z.string().trim().min(1).max(2000) });

export async function postOpenDispute(req: Request, res: Response) {
  assertMemberRole(req.user!);
  const body = openDisputeSchema.parse(req.body);
  const dispute = await openDispute(req.user!.id, req.params.id, body.reason);
  res.status(201).json(dispute);
}
