import { apiGet, apiPost } from "./client";
import type { Listing, ListingPage, ListingSort } from "./types";

export interface BrowseListingsParams {
  page?: number;
  limit?: number;
  search?: string;
  minPrice?: number;
  maxPrice?: number;
  sort?: ListingSort;
}

export function listAvailableListings(params: BrowseListingsParams = {}) {
  const { page = 1, limit = 20, search, minPrice, maxPrice, sort } = params;
  const query = new URLSearchParams({ page: String(page), limit: String(limit) });
  if (search) query.set("search", search);
  if (minPrice !== undefined) query.set("minPrice", String(minPrice));
  if (maxPrice !== undefined) query.set("maxPrice", String(maxPrice));
  if (sort) query.set("sort", sort);
  return apiGet<ListingPage>(`/listings?${query.toString()}`);
}

export function getListing(id: string) {
  return apiGet<Listing>(`/listings/${id}`);
}

export function getMyListings() {
  return apiGet<Listing[]>("/listings/mine");
}

export function createListing(input: { title: string; description?: string; price: number; imageUrls?: string[] }) {
  return apiPost<Listing>("/listings", input);
}
