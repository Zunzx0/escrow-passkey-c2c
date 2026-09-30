import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getMyListings } from "../api/listings";
import type { Listing } from "../api/types";
import { ApiError } from "../api/client";
import { formatRelativeTime, formatVnd, listingStatusLabel, listingStatusTone } from "../lib/status";
import { Card } from "../components/ui/Card";
import { Spinner } from "../components/ui/Spinner";
import { Alert } from "../components/ui/Alert";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";
import { ChevronRightIcon } from "../components/ui/icons";
import { productIconForName } from "../lib/productIcon";

export default function MyListingsPage() {
  const [listings, setListings] = useState<Listing[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getMyListings()
      .then(setListings)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Không tải được danh sách."));
  }, []);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[var(--color-text)]">Tin đăng của tôi</h1>
          <p className="mt-1 text-sm text-[var(--color-text-secondary)]">Những món đồ bạn đang bán.</p>
        </div>
        <Link to="/listings/new">
          <Button variant="gradient">Đăng tin mới</Button>
        </Link>
      </div>

      <div className="mt-6">
        {error && <Alert tone="error">{error}</Alert>}
        {!error && listings === null && <Spinner />}
        {!error && listings !== null && listings.length === 0 && (
          <EmptyState
            title="Bạn chưa đăng tin nào"
            description="Đăng món đồ đầu tiên và bắt đầu bán cho cộng đồng."
            action={
              <Link to="/listings/new">
                <Button>Đăng tin đầu tiên</Button>
              </Link>
            }
          />
        )}
        {listings && listings.length > 0 && (
          <div className="space-y-3">
            {listings.map((listing) => (
              <Link key={listing.id} to={`/listings/${listing.id}`} className="block">
                <Card className="flex items-center gap-4 p-4 transition-all hover:border-[var(--color-border-hover)] hover:shadow-[var(--shadow-card-hover)]">
                  <span className="h-14 w-14 shrink-0 overflow-hidden rounded-[10px] bg-[var(--color-surface-subtle)]">
                    {listing.images[0]?.url ? (
                      <img src={listing.images[0].url} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <span className="flex h-full items-center justify-center text-[var(--color-text-light)]">
                        {productIconForName(listing.title, { className: "h-5 w-5" })}
                      </span>
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-[var(--color-text)]">{listing.title}</p>
                    <p className="mt-0.5 text-[16px] font-bold text-[var(--color-text)]">{formatVnd(listing.price)}</p>
                    <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">Đăng {formatRelativeTime(listing.createdAt)}</p>
                  </div>
                  <Badge tone={listingStatusTone[listing.status]}>{listingStatusLabel[listing.status]}</Badge>
                  <ChevronRightIcon className="h-5 w-5 shrink-0 text-[var(--color-text-light)]" />
                </Card>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
