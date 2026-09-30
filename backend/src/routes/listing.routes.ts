import { Router } from "express";
import { asyncHandler } from "../middleware/asyncHandler";
import { requireAuth } from "../middleware/requireAuth";
import { getListing, getListings, getMyListings, postCreateListing } from "../controllers/listing.controller";

export const listingRouter = Router();

listingRouter.get("/", asyncHandler(getListings));
// Must be registered before "/:id" so "mine" isn't swallowed as an id param.
listingRouter.get("/mine", requireAuth, asyncHandler(getMyListings));
listingRouter.get("/:id", asyncHandler(getListing));
listingRouter.post("/", requireAuth, asyncHandler(postCreateListing));
