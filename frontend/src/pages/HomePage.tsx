import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { listAvailableListings } from "../api/listings";
import type { Listing, ListingSort } from "../api/types";
import { ApiError } from "../api/client";
import { Alert } from "../components/ui/Alert";
import { Button } from "../components/ui/Button";
import { ListingCardSkeleton } from "../components/ui/Skeleton";
import { ListingCard } from "../components/listing/ListingCard";
import { CATEGORY_UNAVAILABLE_HINT, MARKET_CATEGORIES } from "../lib/categories";
import { ChevronRightIcon, FilterIcon, PackageIcon, ShieldIcon } from "../components/ui/icons";

const LATEST_COUNT = 10;
const SUGGESTED_COUNT = 12;
const POOL_SIZE = 40;
const EXPLORE_PAGE_SIZE = 20;

const SORT_OPTIONS: { value: ListingSort; label: string }[] = [
  { value: "newest", label: "Mới nhất" },
  { value: "price_asc", label: "Giá thấp trước" },
  { value: "price_desc", label: "Giá cao trước" },
];

const GRID = "grid grid-cols-2 gap-[18px] md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5";

// Real product photos, layered slightly so the hero speaks "hàng hoá" instead
// of "sơ đồ hệ thống".
const HERO_COLLAGE = [
  { src: "/demo/phone-iphone.jpg", alt: "Điện thoại", offset: "translate-y-3" },
  { src: "/demo/laptop-macbook.jpg", alt: "Laptop", offset: "-translate-y-2" },
  { src: "/demo/headphones-sony.jpg", alt: "Tai nghe", offset: "translate-y-1" },
  { src: "/demo/camera-canon.jpg", alt: "Máy ảnh", offset: "-translate-y-4" },
];

function shuffle<T>(input: T[]): T[] {
  const arr = [...input];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function SectionHeading({ title, seeAllHref }: { title: string; seeAllHref?: string }) {
  return (
    <div className="mb-[18px] flex items-end justify-between gap-4">
      <h2 className="text-[22px] font-bold leading-tight text-[var(--color-text)] md:text-[26px]">{title}</h2>
      {seeAllHref && (
        <a
          href={seeAllHref}
          className="flex shrink-0 items-center gap-0.5 text-[14px] font-medium text-[var(--color-brand)] transition-colors hover:text-[var(--color-brand-hover)]"
        >
          Xem tất cả
          <ChevronRightIcon className="h-4 w-4" />
        </a>
      )}
    </div>
  );
}

function SkeletonGrid({ count }: { count: number }) {
  return (
    <div className={GRID}>
      {Array.from({ length: count }).map((_, i) => (
        <ListingCardSkeleton key={i} />
      ))}
    </div>
  );
}

/** Horizontal row, so this section doesn't look like a copy-paste of the grids. */
function SuggestedCarousel({ items }: { items: Listing[] }) {
  const scroller = useRef<HTMLDivElement>(null);

  function scrollBy(direction: 1 | -1) {
    scroller.current?.scrollBy({ left: direction * 700, behavior: "smooth" });
  }

  return (
    <div className="relative">
      <div ref={scroller} className="no-scrollbar -mx-4 flex gap-[18px] overflow-x-auto scroll-smooth px-4 sm:mx-0 sm:px-0">
        {items.map((listing) => (
          <div key={listing.id} className="w-[210px] shrink-0 sm:w-[230px]">
            <ListingCard listing={listing} />
          </div>
        ))}
      </div>

      <div className="mt-4 hidden justify-end gap-2 sm:flex">
        <button
          type="button"
          onClick={() => scrollBy(-1)}
          aria-label="Xem các sản phẩm trước"
          className="flex h-9 w-9 items-center justify-center rounded-full border border-[var(--color-border)] bg-white text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-border-hover)] hover:text-[var(--color-text)]"
        >
          <ChevronRightIcon className="h-4 w-4 rotate-180" />
        </button>
        <button
          type="button"
          onClick={() => scrollBy(1)}
          aria-label="Xem các sản phẩm tiếp theo"
          className="flex h-9 w-9 items-center justify-center rounded-full border border-[var(--color-border)] bg-white text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-border-hover)] hover:text-[var(--color-text)]"
        >
          <ChevronRightIcon className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

export default function HomePage() {
  const [searchParams, setSearchParams] = useSearchParams();

  const search = searchParams.get("search") ?? "";
  const minPrice = searchParams.get("minPrice") ?? "";
  const maxPrice = searchParams.get("maxPrice") ?? "";
  const sort = (searchParams.get("sort") as ListingSort | null) ?? "newest";
  const hasFilters = Boolean(search || minPrice || maxPrice || sort !== "newest");

  const [filtersOpen, setFiltersOpen] = useState(false);
  const [minPriceInput, setMinPriceInput] = useState(minPrice);
  const [maxPriceInput, setMaxPriceInput] = useState(maxPrice);

  const [pool, setPool] = useState<Listing[] | null>(null);
  const [explore, setExplore] = useState<Listing[] | null>(null);
  const [exploreTotal, setExploreTotal] = useState(0);
  const [explorePage, setExplorePage] = useState(1);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setMinPriceInput(minPrice);
    setMaxPriceInput(maxPrice);
  }, [minPrice, maxPrice]);

  useEffect(() => {
    if (hasFilters) return;
    let cancelled = false;
    listAvailableListings({ page: 1, limit: POOL_SIZE, sort: "newest" })
      .then((res) => {
        if (!cancelled) setPool(res.items);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : "Không tải được danh sách sản phẩm.");
      });
    return () => {
      cancelled = true;
    };
  }, [hasFilters]);

  useEffect(() => {
    let cancelled = false;
    setExplore(null);
    setExplorePage(1);
    setError(null);
    listAvailableListings({
      page: 1,
      limit: EXPLORE_PAGE_SIZE,
      search: search || undefined,
      minPrice: minPrice ? Number(minPrice) : undefined,
      maxPrice: maxPrice ? Number(maxPrice) : undefined,
      sort,
    })
      .then((res) => {
        if (cancelled) return;
        setExplore(res.items);
        setExploreTotal(res.total);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : "Không tải được danh sách sản phẩm.");
      });
    return () => {
      cancelled = true;
    };
  }, [search, minPrice, maxPrice, sort]);

  async function loadMore() {
    const nextPage = explorePage + 1;
    setLoadingMore(true);
    try {
      const res = await listAvailableListings({
        page: nextPage,
        limit: EXPLORE_PAGE_SIZE,
        search: search || undefined,
        minPrice: minPrice ? Number(minPrice) : undefined,
        maxPrice: maxPrice ? Number(maxPrice) : undefined,
        sort,
      });
      setExplore((prev) => [...(prev ?? []), ...res.items]);
      setExploreTotal(res.total);
      setExplorePage(nextPage);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Không tải thêm được sản phẩm.");
    } finally {
      setLoadingMore(false);
    }
  }

  function updateParam(key: string, value: string | undefined) {
    const params = new URLSearchParams(searchParams);
    if (value) params.set(key, value);
    else params.delete(key);
    setSearchParams(params);
  }

  function applyPriceFilter(e: FormEvent) {
    e.preventDefault();
    const params = new URLSearchParams(searchParams);
    if (minPriceInput) params.set("minPrice", minPriceInput);
    else params.delete("minPrice");
    if (maxPriceInput) params.set("maxPrice", maxPriceInput);
    else params.delete("maxPrice");
    setSearchParams(params);
    setFiltersOpen(false);
  }

  const latest = useMemo(() => (pool ?? []).slice(0, LATEST_COUNT), [pool]);
  const suggested = useMemo(() => (pool ? shuffle(pool.slice(LATEST_COUNT)).slice(0, SUGGESTED_COUNT) : []), [pool]);
  const alreadyShown = useMemo(() => new Set([...latest, ...suggested].map((l) => l.id)), [latest, suggested]);
  const exploreItems = useMemo(() => (explore ?? []).filter((l) => !alreadyShown.has(l.id)), [explore, alreadyShown]);
  const canLoadMore = (explore?.length ?? 0) < exploreTotal;
  const isEmptyMarketplace = !hasFilters && pool !== null && pool.length === 0;

  return (
    <div>
      {/* HERO */}
      <section className="relative mt-6 overflow-hidden rounded-[16px] bg-[linear-gradient(120deg,#EFFAFF_0%,#F5F7FF_50%,#F8F5FF_100%)]">
        <div className="pointer-events-none absolute -left-20 -top-24 h-64 w-64 rounded-full bg-[rgba(14,165,233,0.14)] blur-3xl" />
        <div className="pointer-events-none absolute -bottom-28 right-10 h-64 w-64 rounded-full bg-[rgba(124,58,237,0.12)] blur-3xl" />

        <div className="relative flex items-center gap-10 px-6 py-10 sm:px-10 lg:py-11">
          <div className="min-w-0 flex-1">
            <h1 className="text-[28px] font-bold leading-[1.1] tracking-tight text-[var(--color-text)] sm:text-[36px] lg:text-[44px]">
              Tìm món bạn cần. Bán món bạn không dùng.
            </h1>
            <p className="mt-3.5 max-w-[560px] text-[15px] leading-[1.55] text-[var(--color-text-secondary)] sm:text-[17px]">
              Khám phá hàng hóa từ cộng đồng và giao dịch với cơ chế bảo vệ dòng tiền.
            </p>
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <a href="#moi-dang">
                <Button className="h-11 px-6 text-[15px]">Khám phá ngay</Button>
              </a>
              <Link to="/listings/new">
                <Button variant="secondary" className="h-11 px-6 text-[15px]">
                  Đăng tin
                </Button>
              </Link>
            </div>
            <p className="mt-5 flex items-center gap-1.5 text-[13.5px] font-medium text-[var(--color-success)]">
              <ShieldIcon className="h-4 w-4" /> Thanh toán được bảo vệ trong suốt giao dịch
            </p>
          </div>

          <div className="hidden w-[330px] shrink-0 grid-cols-2 gap-3 lg:grid">
            {HERO_COLLAGE.map((item) => (
              <div
                key={item.src}
                className={`aspect-square overflow-hidden rounded-[12px] border border-white bg-white shadow-[0_10px_28px_rgba(15,23,42,0.10)] ${item.offset}`}
              >
                <img src={item.src} alt={item.alt} className="h-full w-full object-cover" />
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CATEGORY SHORTCUTS */}
      <section className="mt-14">
        <SectionHeading title="Khám phá theo danh mục" />
        <div className="no-scrollbar -mx-4 flex gap-3 overflow-x-auto px-4 sm:mx-0 sm:grid sm:grid-cols-4 sm:overflow-visible sm:px-0 lg:grid-cols-8">
          {MARKET_CATEGORIES.map(({ label, icon: Icon }) => (
            <div
              key={label}
              title={CATEGORY_UNAVAILABLE_HINT}
              className="flex h-[86px] w-[104px] shrink-0 cursor-default flex-col items-center justify-center gap-2 rounded-[10px] border border-[var(--color-border)] bg-white transition-all duration-[180ms] hover:-translate-y-0.5 hover:border-[var(--color-border-accent)] hover:shadow-[var(--shadow-card-hover)] sm:w-auto"
            >
              <Icon className="h-[26px] w-[26px] text-[var(--color-brand)]" />
              <span className="text-[13.5px] font-medium text-[var(--color-text-secondary)]">{label}</span>
            </div>
          ))}
        </div>
      </section>

      {error && (
        <div className="mt-8">
          <Alert tone="error">{error}</Alert>
        </div>
      )}

      {hasFilters ? (
        <section id="moi-dang" className="mt-14 scroll-mt-32">
          <div className="mb-[18px] flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-[22px] font-bold text-[var(--color-text)] md:text-[26px]">
                {search ? `Kết quả cho "${search}"` : "Kết quả lọc"}
              </h2>
              {explore !== null && <p className="mt-1 text-[14px] text-[var(--color-text-secondary)]">{exploreTotal} sản phẩm</p>}
            </div>
            <div className="flex items-center gap-2.5">
              <select
                value={sort}
                onChange={(e) => updateParam("sort", e.target.value === "newest" ? undefined : e.target.value)}
                className="h-10 rounded-[8px] border border-[var(--color-border)] bg-white px-3 text-[14px] text-[var(--color-text)] focus:border-[var(--color-brand)] focus:outline-none"
              >
                {SORT_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <Button variant="secondary" className="h-10" onClick={() => setFiltersOpen((v) => !v)}>
                <FilterIcon className="h-4 w-4" /> Bộ lọc
              </Button>
              <button
                type="button"
                onClick={() => setSearchParams({})}
                className="text-[13.5px] font-medium text-[var(--color-text-secondary)] underline-offset-2 hover:text-[var(--color-brand)] hover:underline"
              >
                Xóa lọc
              </button>
            </div>
          </div>

          {filtersOpen && (
            <form
              onSubmit={applyPriceFilter}
              className="mb-6 flex flex-wrap items-end gap-3 rounded-[10px] border border-[var(--color-border)] bg-[var(--color-surface-subtle)] p-4"
            >
              <label className="text-[13.5px] font-medium text-[var(--color-text-secondary)]">
                Giá từ
                <input
                  type="number"
                  min={0}
                  value={minPriceInput}
                  onChange={(e) => setMinPriceInput(e.target.value)}
                  className="mt-1.5 block h-10 w-36 rounded-[8px] border border-[var(--color-border)] bg-white px-3 text-[14px] text-[var(--color-text)] focus:border-[var(--color-brand)] focus:outline-none"
                />
              </label>
              <label className="text-[13.5px] font-medium text-[var(--color-text-secondary)]">
                Giá đến
                <input
                  type="number"
                  min={0}
                  value={maxPriceInput}
                  onChange={(e) => setMaxPriceInput(e.target.value)}
                  className="mt-1.5 block h-10 w-36 rounded-[8px] border border-[var(--color-border)] bg-white px-3 text-[14px] text-[var(--color-text)] focus:border-[var(--color-brand)] focus:outline-none"
                />
              </label>
              <Button type="submit" className="h-10">
                Áp dụng
              </Button>
            </form>
          )}

          {explore === null ? (
            <SkeletonGrid count={10} />
          ) : explore.length === 0 ? (
            <div className="flex flex-col items-center py-20 text-center">
              <PackageIcon className="h-10 w-10 text-[var(--color-text-light)]" />
              <p className="mt-4 text-lg font-semibold text-[var(--color-text)]">Không tìm thấy sản phẩm phù hợp</p>
              <p className="mt-2 max-w-md text-[14px] text-[var(--color-text-secondary)]">Thử từ khóa khác hoặc mở rộng khoảng giá.</p>
              <Button variant="secondary" className="mt-6" onClick={() => setSearchParams({})}>
                Xóa bộ lọc
              </Button>
            </div>
          ) : (
            <>
              <div className={GRID}>
                {explore.map((listing) => (
                  <ListingCard key={listing.id} listing={listing} />
                ))}
              </div>
              {canLoadMore && (
                <div className="mt-8 flex justify-center">
                  <Button variant="secondary" className="h-11 px-8" onClick={loadMore} loading={loadingMore}>
                    Xem thêm
                  </Button>
                </div>
              )}
            </>
          )}
        </section>
      ) : isEmptyMarketplace ? (
        <section className="flex flex-col items-center py-24 text-center">
          <PackageIcon className="h-12 w-12 text-[var(--color-text-light)]" />
          <h2 className="mt-5 text-[24px] font-bold text-[var(--color-text)]">Chợ đang chờ những món đồ đầu tiên</h2>
          <p className="mt-3 max-w-md text-[15px] leading-6 text-[var(--color-text-secondary)]">
            Hãy đăng món đồ bạn không còn sử dụng và bắt đầu giao dịch.
          </p>
          <Link to="/listings/new" className="mt-7">
            <Button className="h-11 px-6 text-[15px]">Đăng tin đầu tiên</Button>
          </Link>
        </section>
      ) : (
        <>
          {/* Grid, 5 × 2 */}
          <section id="moi-dang" className="mt-14 scroll-mt-32">
            <SectionHeading title="Mới đăng gần đây" seeAllHref={exploreItems.length > 0 ? "#kham-pha" : undefined} />
            {pool === null ? (
              <SkeletonGrid count={LATEST_COUNT} />
            ) : (
              <div className={GRID}>
                {latest.map((listing) => (
                  <ListingCard key={listing.id} listing={listing} />
                ))}
              </div>
            )}
          </section>

          {/* Horizontal row — deliberately a different rhythm from the grids. */}
          {suggested.length >= 4 && (
            <section className="mt-14">
              <SectionHeading title="Có thể bạn quan tâm" />
              <SuggestedCarousel items={suggested} />
            </section>
          )}

          {/* Thin trust strip, not a section. */}
          <section className="mt-14 flex items-center gap-4 rounded-[14px] border border-[#d1fae5] bg-[#f0fdf9] px-5 py-4 sm:px-7">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-[#d1fae5] text-[var(--color-success)]">
              <ShieldIcon className="h-[22px] w-[22px]" />
            </span>
            <div>
              <p className="text-[15px] font-semibold text-[var(--color-text)]">Tiền của bạn được bảo vệ trong suốt giao dịch</p>
              <p className="mt-0.5 text-[13.5px] leading-6 text-[var(--color-text-secondary)]">
                Chỉ được chuyển cho người bán khi giao dịch đáp ứng đúng điều kiện.
              </p>
            </div>
          </section>

          {exploreItems.length > 0 && (
            <section id="kham-pha" className="mt-14 scroll-mt-32">
              <SectionHeading title="Khám phá thêm" />
              <div className={GRID}>
                {exploreItems.map((listing) => (
                  <ListingCard key={listing.id} listing={listing} />
                ))}
              </div>
              {canLoadMore && (
                <div className="mt-8 flex justify-center">
                  <Button variant="secondary" className="h-11 px-8" onClick={loadMore} loading={loadingMore}>
                    Xem thêm
                  </Button>
                </div>
              )}
            </section>
          )}
        </>
      )}

      {/* SELLER CTA */}
      <section className="mt-14 flex flex-wrap items-center justify-between gap-4 rounded-[14px] bg-[linear-gradient(120deg,rgba(14,165,233,0.08),rgba(124,58,237,0.06))] px-6 py-6 sm:px-8">
        <div className="flex items-center gap-4">
          <span className="hidden h-12 w-12 shrink-0 items-center justify-center rounded-[12px] bg-white/70 text-[var(--color-brand)] sm:flex">
            <PackageIcon className="h-6 w-6" />
          </span>
          <div>
            <p className="text-[18px] font-bold text-[var(--color-text)]">Có món đồ không còn dùng?</p>
            <p className="mt-1 text-[14px] text-[var(--color-text-secondary)]">Đăng bán trong vài phút và tiếp cận cộng đồng người mua.</p>
          </div>
        </div>
        <Link to="/listings/new">
          <Button variant="gradient" className="h-11 px-6 text-[15px]">
            Đăng tin ngay
          </Button>
        </Link>
      </section>
    </div>
  );
}
