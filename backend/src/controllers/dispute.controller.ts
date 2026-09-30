import type { Request, Response } from "express";
import { z } from "zod";
import { assertAdminRole } from "../utils/authz";
import {
  adjudicateDispute,
  getDisputeForAdmin,
  listDisputesForAdmin,
  requestAdjudicationReauth,
  verifyAdjudicationReauth,
} from "../services/dispute.service";
import { checkChallengeIssuanceRateLimit } from "../services/webauthn.service";

// --- Stage 9: Admin adjudication -------------------------------------------
// Every endpoint here is ADMIN-only (assertAdminRole) — BA.md §9.4: "Quản
// trị viên không mở tranh chấp. Quản trị viên chỉ xử lý hồ sơ tranh chấp đã
// được tạo bởi một bên của giao dịch." Opening (Stage 8, transaction.routes)
// stays MEMBER-only; everything below stays ADMIN-only. No account can do
// both for the same dispute.

export async function getDisputes(req: Request, res: Response) {
  assertAdminRole(req.user!);
  const disputes = await listDisputesForAdmin();
  res.json(disputes);
}

export async function getDispute(req: Request, res: Response) {
  assertAdminRole(req.user!);
  const dispute = await getDisputeForAdmin(req.params.id);
  res.json(dispute);
}

const decisionSchema = z.object({ decision: z.enum(["REFUND", "RELEASE"]) });

export async function postAdjudicationReauthOptions(req: Request, res: Response) {
  assertAdminRole(req.user!);
  checkChallengeIssuanceRateLimit("REAUTH", req.ip ?? "unknown", req.user!.email);
  const body = decisionSchema.parse(req.body);
  const options = await requestAdjudicationReauth(req.user!.id, req.params.id, body.decision);
  res.json(options);
}

const reauthVerifySchema = z.object({ decision: z.enum(["REFUND", "RELEASE"]), response: z.any() });

export async function postAdjudicationReauthVerify(req: Request, res: Response) {
  assertAdminRole(req.user!);
  const body = reauthVerifySchema.parse(req.body);
  const grant = await verifyAdjudicationReauth(req.user!.id, req.params.id, body.decision, body.response);
  res.json(grant);
}

const adjudicateSchema = z.object({
  decision: z.enum(["REFUND", "RELEASE"]),
  token: z.string().min(1),
  resolutionNote: z.string().trim().max(2000).optional(),
});

export async function postAdjudicateDispute(req: Request, res: Response) {
  assertAdminRole(req.user!);
  const body = adjudicateSchema.parse(req.body);
  const transaction = await adjudicateDispute(req.user!.id, req.params.id, body.decision, body.token, body.resolutionNote);
  res.json(transaction);
}
