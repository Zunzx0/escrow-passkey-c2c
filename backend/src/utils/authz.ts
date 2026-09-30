import { HttpError } from "./httpError";

// PostgreSQL's `integer` column type (used for every money field in the
// schema — see schema.prisma) is 4 bytes, max 2^31-1. Any amount-like
// input must be validated against this ceiling BEFORE it reaches Prisma,
// or a legitimately-shaped but oversized request would fail with a raw
// DB error instead of a clean 400 (ke-hoach §19 "Amount lớn boundary").
export const POSTGRES_INT4_MAX = 2_147_483_647;

// Role is never trusted from the client/session alone without a check —
// ke-hoach §4: "Không tin frontend về role". ADMIN never buys/sells/holds
// a wallet (BA.md §2.3). BA.md §2.1/§2.2 define "buyer"/"seller" as
// PER-TRANSACTION roles (transaction.buyer_id/seller_id, listing.seller_id)
// — NOT an account-level identity: the same MEMBER account creates
// listings (seller for those) and creates transactions on others'
// listings (buyer for those). This only gates "is this a regular
// (non-admin) account" — actual buyer/seller authorization always comes
// from checking the specific Transaction/Listing row, never from role.
export function assertMemberRole(user: { role: string }): void {
  if (user.role !== "MEMBER") {
    throw new HttpError(403, "Tài khoản quản trị viên không thể thực hiện thao tác này.");
  }
}

// Stage 9: the mirror image of assertMemberRole — admin adjudication
// (BA.md §9.4) is the one flow only an ADMIN account may perform.
export function assertAdminRole(user: { role: string }): void {
  if (user.role !== "ADMIN") {
    throw new HttpError(403, "Chỉ quản trị viên mới có quyền thực hiện thao tác này.");
  }
}
