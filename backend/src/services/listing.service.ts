import { prisma } from "../lib/prisma";
import { HttpError } from "../utils/httpError";

export type CreateListingInput = {
  title: string;
  description?: string;
  price: number;
  imageUrls?: string[];
};

// Listing is a single, unique item (BA.md §18 "tin đăng đơn chiếc") — no
// stock/quantity field exists on purpose. `status`/`version` are written
// here at AVAILABLE/0 (the model defaults) and are otherwise ONLY ever
// touched by the LOCK conditional update in transaction.service.ts.
export async function createListing(sellerId: string, input: CreateListingInput) {
  return prisma.listing.create({
    data: {
      sellerId,
      title: input.title,
      description: input.description,
      price: input.price,
      images: input.imageUrls?.length
        ? { create: input.imageUrls.map((url, position) => ({ url, position })) }
        : undefined,
    },
    include: { images: true },
  });
}

export type ListingSort = "newest" | "price_asc" | "price_desc";

export type ListBrowseFilters = {
  search?: string;
  minPrice?: number;
  maxPrice?: number;
  sort?: ListingSort;
};

// Browse/search over the public marketplace grid. Deliberately filters only
// on fields that already exist on Listing (title/price) — no category or
// location field exists in the schema, so those stay out of scope here
// (see reference_frontend_design_system memory, "role-model correction").
export async function listAvailableListings(page: number, limit: number, filters: ListBrowseFilters = {}) {
  const skip = (page - 1) * limit;
  const where = {
    status: "AVAILABLE" as const,
    ...(filters.search ? { title: { contains: filters.search, mode: "insensitive" as const } } : {}),
    ...(filters.minPrice !== undefined || filters.maxPrice !== undefined
      ? { price: { gte: filters.minPrice, lte: filters.maxPrice } }
      : {}),
  };
  const orderBy =
    filters.sort === "price_asc"
      ? ({ price: "asc" } as const)
      : filters.sort === "price_desc"
        ? ({ price: "desc" } as const)
        : ({ createdAt: "desc" } as const);

  const [items, total] = await Promise.all([
    prisma.listing.findMany({
      where,
      include: {
        images: true,
        // Same public-only projection as getListingById: the marketplace card
        // shows who posted the listing, so id + displayName ONLY — this
        // endpoint is unauthenticated.
        seller: { select: { id: true, displayName: true } },
      },
      orderBy,
      skip,
      take: limit,
    }),
    prisma.listing.count({ where }),
  ]);
  return { items, total, page, limit };
}

// Policy decision (Stage 4 review, 2026-09-18): the detail view is public
// for a listing in ANY status (AVAILABLE/LOCKED/SOLD) — unlike the browse
// list above, which only shows AVAILABLE so buyers don't attempt to buy
// something already taken. A direct link to a LOCKED/SOLD listing (e.g.
// shared by the seller, or held by the transaction's own buyer/seller)
// must still resolve consistently rather than 404 for a listing that
// genuinely exists. This is safe to expose: the Listing row itself never
// carries buyer identity or transaction data — only title/description/
// price/images/status/seller, all of which are already visible while the
// listing was AVAILABLE. If a field containing anything more sensitive is
// ever added to Listing, this decision must be revisited.
export async function getListingById(id: string) {
  const listing = await prisma.listing.findUnique({
    where: { id },
    include: {
      images: true,
      // Public "thông tin người đăng" on the detail page — id + displayName
      // ONLY. This endpoint has no auth (anyone can view a listing), so
      // email/passwordHash/etc. must never be selected here.
      seller: { select: { id: true, displayName: true } },
    },
  });
  if (!listing) throw new HttpError(404, "Không tìm thấy tin đăng.");
  return listing;
}

export async function listMyListings(sellerId: string) {
  return prisma.listing.findMany({
    where: { sellerId },
    include: { images: true },
    orderBy: { createdAt: "desc" },
  });
}
