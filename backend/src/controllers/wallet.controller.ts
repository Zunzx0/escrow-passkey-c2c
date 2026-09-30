import type { Request, Response } from "express";
import { getMyWallet, getMyWalletEntries } from "../services/wallet.read.service";

export async function getMyWalletHandler(req: Request, res: Response) {
  const wallet = await getMyWallet(req.user!.id);
  res.json(wallet);
}

export async function getMyWalletEntriesHandler(req: Request, res: Response) {
  const entries = await getMyWalletEntries(req.user!.id);
  res.json(entries);
}
