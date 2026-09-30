import { Link } from "react-router-dom";
import type { Listing } from "../../api/types";
import { formatRelativeTime, formatVnd } from "../../lib/status";
import { CheckIcon } from "../ui/icons";
import { productIconForName } from "../../lib/productIcon";

/**
 * Marketplace product card. Hierarchy after review: image → price → title →
 * seller/meta. The price is the second-most important thing on a marketplace
 * card, so seller and timestamp are deliberately kept quieter.
 */
export function ListingCard({ listing }: { listing: Listing }) {
  const cover = listing.images[0]?.url;
  const sellerName = listing.seller?.displayName ?? "Người bán";

  return (
    <Link
      to={`/listings/${listing.id}`}
      className="group flex flex-col overflow-hidden rounded-[10px] border border-[#e7ebf0] bg-white shadow-[0_2px_8px_rgba(15,23,42,0.04)] transition-all duration-[180ms] hover:-translate-y-0.5 hover:border-[var(--color-border-hover)] hover:shadow-[0_12px_28px_rgba(15,23,42,0.09)]"
    >
      <div className="aspect-square w-full overflow-hidden bg-[var(--color-surface-subtle)]">
        {cover ? (
          <img
            src={cover}
            alt={listing.title}
            loading="lazy"
            className="h-full w-full object-cover transition-transform duration-[180ms] group-hover:scale-[1.02]"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-[var(--color-text-light)]">
            {productIconForName(listing.title, { className: "h-10 w-10" })}
          </div>
        )}
      </div>

      <div className="flex flex-1 flex-col p-3.5">
        <h3 className="line-clamp-2 min-h-[42px] text-[15px] font-semibold leading-[1.4] text-[var(--color-text)]">{listing.title}</h3>

        {/* 8px from title */}
        <p className="mt-2 text-[20px] font-bold leading-none tracking-tight text-[var(--color-text)]">{formatVnd(listing.price)}</p>

        {/* 12px from price */}
        <div className="mt-3 flex items-center gap-2">
          <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full bg-[var(--color-surface-secondary)] text-[10px] font-bold text-[var(--color-text-muted)]">
            {sellerName.slice(0, 1).toUpperCase()}
          </span>
          <span className="truncate text-[13px] text-[var(--color-text-muted)]">{sellerName}</span>
        </div>

        <div className="mt-auto flex items-center justify-between gap-2 pt-2.5">
          <span className="text-[12.5px] text-[var(--color-text-muted)]">{formatRelativeTime(listing.createdAt)}</span>
          <span className="flex shrink-0 items-center gap-1 text-[12.5px] font-medium text-[var(--color-success)]">
            <CheckIcon className="h-3.5 w-3.5" strokeWidth={2.5} />
            Được bảo vệ
          </span>
        </div>
      </div>
    </Link>
  );
}
