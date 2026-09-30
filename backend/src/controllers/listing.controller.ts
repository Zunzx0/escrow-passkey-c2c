import type { Request, Response } from "express";
import { z } from "zod";
import { assertMemberRole, POSTGRES_INT4_MAX } from "../utils/authz";
import { HttpError } from "../utils/httpError";
import { createListing, getListingById, listAvailableListings, listMyListings } from "../services/listing.service";

const createListingSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  price: z.number().int().positive().max(POSTGRES_INT4_MAX),
  imageUrls: z.array(z.string().url()).max(8).optional(),
});

export async function postCreateListing(req: Request, res: Response) {
  assertMemberRole(req.user!);
  const body = createListingSchema.parse(req.body);
  const listing = await createListing(req.user!.id, body);
  res.status(201).json(listing);
}

const browseQuerySchema = z.object({
  search: z.string().trim().min(1).max(200).optional(),
  minPrice: z.coerce.number().int().nonnegative().max(POSTGRES_INT4_MAX).optional(),
  maxPrice: z.coerce.number().int().nonnegative().max(POSTGRES_INT4_MAX).optional(),
  sort: z.enum(["newest", "price_asc", "price_desc"]).optional(),
});

export async function getListings(req: Request, res: Response) {
  const page = Math.max(1, Number.parseInt(String(req.query.page ?? "1"), 10) || 1);
  const limit = Math.min(50, Math.max(1, Number.parseInt(String(req.query.limit ?? "20"), 10) || 20));
  const { search, minPrice, maxPrice, sort } = browseQuerySchema.parse({
    search: req.query.search,
    minPrice: req.query.minPrice,
    maxPrice: req.query.maxPrice,
    sort: req.query.sort,
  });
  if (minPrice !== undefined && maxPrice !== undefined && minPrice > maxPrice) {
    throw new HttpError(400, "Giá tối thiểu không được lớn hơn giá tối đa.");
  }
  const result = await listAvailableListings(page, limit, { search, minPrice, maxPrice, sort });
  res.json(result);
}

export async function getListing(req: Request, res: Response) {
  const listing = await getListingById(req.params.id);
  res.json(listing);
}

export async function getMyListings(req: Request, res: Response) {
  const listings = await listMyListings(req.user!.id);
  res.json(listings);
}
