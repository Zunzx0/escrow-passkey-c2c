import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { getListing } from "../api/listings";
import { createTransaction } from "../api/transactions";
import type { Listing, ListingSeller } from "../api/types";
import { ApiError } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { formatRelativeTime, formatVnd, listingStatusLabel, listingStatusTone } from "../lib/status";
import { Card } from "../components/ui/Card";
import { Spinner } from "../components/ui/Spinner";
import { Alert } from "../components/ui/Alert";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { CheckIcon, ShieldIcon } from "../components/ui/icons";
import { productIconForName } from "../lib/productIcon";

function SellerBlock({ seller }: { seller: ListingSeller }) {
  const label = seller.displayName ?? "Người bán";
  return (
    <div className="flex items-center gap-3 rounded-[12px] border border-[var(--color-border)] bg-white p-3.5">
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[var(--color-surface-secondary)] text-sm font-bold text-[var(--color-text)]">
        {label.slice(0, 1).toUpperCase()}
      </span>
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-[var(--color-text)]">{label}</p>
        <p className="text-xs text-[var(--color-text-muted)]">Người đăng tin</p>
      </div>
    </div>
  );
}

const PROTECTION_POINTS = [
  "Tiền của bạn được giữ lại an toàn ngay khi thanh toán, người bán chưa nhận được.",
  "Người bán chỉ nhận được tiền sau khi bạn xác nhận đã nhận hàng.",
  "Mọi bước của giao dịch đều được ghi nhận và bạn theo dõi được.",
];

export default function ListingDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [buying, setBuying] = useState(false);
  const [activeImage, setActiveImage] = useState(0);

  useEffect(() => {
    if (!id) return;
    getListing(id)
      .then((l) => {
        setListing(l);
        setActiveImage(0);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Không tải được tin đăng."));
  }, [id]);

  async function handleBuy() {
    if (!id) return;
    // Browsing is public; creating a transaction needs an account. Send an
    // anonymous visitor to log in rather than firing a doomed 401 request.
    if (!user) {
      navigate(`/login?returnTo=/listings/${id}`);
      return;
    }
    setError(null);
    setBuying(true);
    try {
      const transaction = await createTransaction(id);
      navigate(`/transactions/${transaction.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Không thể tạo giao dịch.");
      setBuying(false);
    }
  }

  if (error && !listing) return <div className="mt-8"><Alert tone="error">{error}</Alert></div>;
  if (!listing) return <Spinner />;

  const isOwnListing = user?.id === listing.sellerId;
  const isAvailable = listing.status === "AVAILABLE";
  const images = listing.images;
  const cover = images[activeImage]?.url ?? images[0]?.url;

  return (
    <div className="mx-auto mt-8 max-w-[1100px]">
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div>
          <div className="overflow-hidden rounded-[12px] border border-[var(--color-border)] bg-[var(--color-surface-subtle)]">
            <div className="aspect-square w-full">
              {cover ? (
                <img src={cover} alt={listing.title} className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full items-center justify-center text-[var(--color-text-light)]">
                  {productIconForName(listing.title, { className: "h-16 w-16" })}
                </div>
              )}
            </div>
          </div>

          {images.length > 1 && (
            <div className="mt-3 flex flex-wrap gap-2.5">
              {images.map((img, i) => (
                <button
                  key={img.id}
                  type="button"
                  onClick={() => setActiveImage(i)}
                  className={`h-16 w-16 overflow-hidden rounded-[10px] border-2 transition-colors ${
                    i === activeImage ? "border-[var(--color-brand)]" : "border-[var(--color-border)] hover:border-[var(--color-border-hover)]"
                  }`}
                >
                  <img src={img.url} alt="" className="h-full w-full object-cover" />
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="lg:sticky lg:top-40 lg:self-start">
          <Badge tone={listingStatusTone[listing.status]}>{listingStatusLabel[listing.status]}</Badge>

          <h1 className="mt-3 text-[24px] font-bold leading-tight text-[var(--color-text)] md:text-[28px]">{listing.title}</h1>
          <p className="mt-1.5 text-xs text-[var(--color-text-muted)]">Đăng {formatRelativeTime(listing.createdAt)}</p>

          <p className="mt-4 text-[32px] font-bold leading-none text-[var(--color-text)]">{formatVnd(listing.price)}</p>

          <div className="mt-5 space-y-3">
            {error && <Alert tone="error">{error}</Alert>}

            {user?.role === "ADMIN" ? (
              <Alert tone="info">Tài khoản quản trị chỉ xử lý hồ sơ tranh chấp, không tham gia mua bán.</Alert>
            ) : isOwnListing ? (
              <Alert tone="info">Đây là tin đăng của bạn.</Alert>
            ) : !isAvailable ? (
              <Alert tone="info">Tin đăng này hiện không còn khả dụng để mua.</Alert>
            ) : (
              <>
                <Button className="h-12 w-full text-[15px]" onClick={handleBuy} loading={buying}>
                  Mua ngay
                </Button>
                <p className="text-center text-xs leading-5 text-[var(--color-text-muted)]">
                  {user
                    ? "Tiền sẽ được giữ an toàn cho đến khi bạn xác nhận đã nhận hàng."
                    : "Bạn cần đăng nhập để mua — tiền sau đó được giữ an toàn đến khi bạn xác nhận đã nhận hàng."}
                </p>
              </>
            )}
          </div>

          {listing.seller && (
            <div className="mt-6">
              <p className="mb-2.5 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Người bán</p>
              <SellerBlock seller={listing.seller} />
            </div>
          )}
        </div>
      </div>

      <div className="mt-12 grid gap-8 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div>
          <h2 className="text-lg font-bold text-[var(--color-text)]">Mô tả sản phẩm</h2>
          {listing.description ? (
            <p className="mt-3 whitespace-pre-wrap text-[15px] leading-7 text-[var(--color-text-secondary)]">{listing.description}</p>
          ) : (
            <p className="mt-3 text-sm text-[var(--color-text-muted)]">Người bán chưa thêm mô tả cho món đồ này.</p>
          )}
        </div>

        <Card className="h-fit p-5">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-[#d1fae5] text-[var(--color-success)]">
              <ShieldIcon className="h-[18px] w-[18px]" />
            </span>
            <p className="text-sm font-semibold text-[var(--color-text)]">Giao dịch này được bảo vệ</p>
          </div>
          <ul className="mt-4 space-y-3">
            {PROTECTION_POINTS.map((point) => (
              <li key={point} className="flex gap-2.5 text-[13px] leading-5 text-[var(--color-text-secondary)]">
                <CheckIcon className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-success)]" strokeWidth={2.5} />
                {point}
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
