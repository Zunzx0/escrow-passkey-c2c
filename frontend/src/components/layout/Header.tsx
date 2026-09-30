import { type FormEvent, useEffect, useState } from "react";
import { Link, NavLink, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { getMyWallet } from "../../api/wallet";
import { formatVnd } from "../../lib/status";
import { CATEGORY_UNAVAILABLE_HINT, MARKET_CATEGORIES } from "../../lib/categories";
import { Button } from "../ui/Button";
import { BellIcon, SearchIcon, ShieldIcon, WalletIcon } from "../ui/icons";

const MEMBER_LINKS = [
  { to: "/me/listings", label: "Tin của tôi" },
  { to: "/me/transactions", label: "Giao dịch" },
];

const ADMIN_LINKS = [{ to: "/admin/disputes", label: "Tranh chấp" }];

export function Header() {
  const { user, loading, logout } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [balance, setBalance] = useState<number | null>(null);
  const [searchInput, setSearchInput] = useState("");

  const activeSearch = searchParams.get("search") ?? "";
  useEffect(() => {
    setSearchInput(activeSearch);
  }, [activeSearch]);

  useEffect(() => {
    if (!user || user.role !== "MEMBER") {
      setBalance(null);
      return;
    }
    let cancelled = false;
    getMyWallet()
      .then((w) => {
        if (!cancelled) setBalance(w.availableBalance);
      })
      .catch(() => {
        if (!cancelled) setBalance(null);
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  const accountLinks = user?.role === "ADMIN" ? ADMIN_LINKS : MEMBER_LINKS;

  function handleSearchSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = searchInput.trim();
    navigate(trimmed ? `/?search=${encodeURIComponent(trimmed)}` : "/");
  }

  return (
    <header className="sticky top-0 z-50 border-b border-[#e8edf3] bg-white/96 backdrop-blur-[12px]">
      <div className="mx-auto flex h-16 max-w-[1360px] items-center gap-4 px-4 sm:px-6 md:h-[72px] lg:gap-8 2xl:max-w-[1480px]">
        <Link to="/" className="flex shrink-0 items-center gap-2.5">
          <span className="brand-gradient flex h-[34px] w-[34px] items-center justify-center rounded-[10px] text-white">
            <ShieldIcon className="h-[19px] w-[19px]" />
          </span>
          <span className="text-[18px] font-bold tracking-tight text-[var(--color-text)]">Chợ An Toàn</span>
        </Link>

        {/* §8: search is the centre of gravity of the header, and public. */}
        {/* The most prominent element in the header — widened and given a
            larger submit button so it reads as the primary action. */}
        <form onSubmit={handleSearchSubmit} className="relative hidden min-w-0 flex-1 md:block lg:max-w-[760px]">
          <SearchIcon className="pointer-events-none absolute left-4 top-1/2 h-[19px] w-[19px] -translate-y-1/2 text-[var(--color-text-muted)]" />
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Tìm điện thoại, laptop, máy ảnh, đồ gia dụng..."
            aria-label="Tìm sản phẩm"
            className="h-[44px] w-full rounded-[8px] border border-[#dfe5ee] bg-[var(--color-surface-input)] pl-12 pr-[104px] text-[15px] text-[var(--color-text)] transition-all placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-brand)] focus:bg-white focus:shadow-[0_0_0_3px_rgba(14,165,233,0.12)] focus:outline-none"
          />
          <button
            type="submit"
            className="absolute right-1 top-1/2 h-[36px] -translate-y-1/2 rounded-[7px] bg-[var(--color-brand)] px-6 text-[14px] font-semibold text-white transition-colors hover:bg-[var(--color-brand-hover)]"
          >
            Tìm
          </button>
        </form>

        <div className="ml-auto flex shrink-0 items-center gap-1.5 lg:gap-3">
          {loading ? null : user ? (
            <>
              <nav className="hidden items-center gap-6 text-sm font-medium xl:flex">
                {accountLinks.map(({ to, label }) => (
                  <NavLink
                    key={to}
                    to={to}
                    className={({ isActive }) =>
                      `whitespace-nowrap transition-colors ${isActive ? "text-[var(--color-brand)]" : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"}`
                    }
                  >
                    {label}
                  </NavLink>
                ))}
              </nav>

              {user.role === "MEMBER" && (
                <Link to="/listings/new" className="hidden sm:block">
                  <Button variant="gradient" className="h-[42px] px-4">Đăng tin</Button>
                </Link>
              )}

              {user.role === "MEMBER" && (
                <Link
                  to="/me/wallet"
                  className="hidden h-10 items-center gap-2 rounded-[10px] px-3 text-sm font-semibold text-[var(--color-text)] transition-colors hover:bg-[var(--color-surface-subtle)] lg:flex"
                  title="Ví của tôi"
                >
                  <WalletIcon className="h-[18px] w-[18px] text-[var(--color-text-secondary)]" />
                  {balance === null ? "…" : formatVnd(balance)}
                </Link>
              )}

              <button
                type="button"
                disabled
                title="Thông báo chưa khả dụng trong bản demo này"
                className="hidden h-10 w-10 items-center justify-center rounded-[10px] text-[var(--color-text-light)] sm:flex"
              >
                <BellIcon className="h-[18px] w-[18px]" />
              </button>

              <Link
                to="/me"
                className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--color-surface-secondary)] text-xs font-bold text-[var(--color-text)] transition-colors hover:bg-[#e6ecf4]"
                title={user.displayName ?? user.email}
              >
                {(user.displayName ?? user.email).slice(0, 1).toUpperCase()}
              </Link>

              <Button
                variant="ghost"
                className="hidden h-10 px-2.5 text-xs lg:inline-flex"
                onClick={async () => {
                  await logout();
                  navigate("/");
                }}
              >
                Đăng xuất
              </Button>
            </>
          ) : (
            <>
              <Link to="/login?returnTo=/listings/new" className="hidden sm:block">
                <Button variant="secondary" className="h-[42px] px-4">
                  Đăng tin
                </Button>
              </Link>
              <Link
                to="/login"
                className="whitespace-nowrap px-2 text-sm font-medium text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text)]"
              >
                Đăng nhập
              </Link>
              <Link to="/register">
                <Button className="h-[42px] px-4">Đăng ký</Button>
              </Link>
            </>
          )}
        </div>
      </div>

      {/* §9: category bar — the single strongest "this is a marketplace" signal.
          Static by design: no category exists in the schema yet. */}
      <div className="border-t border-[#eef2f7] bg-white">
        <div className="no-scrollbar mx-auto flex h-11 max-w-[1360px] items-center gap-6 overflow-x-auto px-4 sm:px-6 2xl:max-w-[1480px]">
          {MARKET_CATEGORIES.map(({ label }) => (
            <span
              key={label}
              title={CATEGORY_UNAVAILABLE_HINT}
              className="cursor-default whitespace-nowrap text-[14.5px] font-medium text-[var(--color-text)] transition-colors hover:text-[var(--color-brand)]"
            >
              {label}
            </span>
          ))}
        </div>
      </div>

      {/* Mobile search lives under the bar so the top row stays uncluttered. */}
      <form onSubmit={handleSearchSubmit} className="border-t border-[#eef2f7] bg-white px-4 py-2.5 md:hidden">
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute left-3.5 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-[var(--color-text-muted)]" />
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Tìm sản phẩm..."
            aria-label="Tìm sản phẩm"
            className="h-11 w-full rounded-[10px] border border-[#e3e8ef] bg-[var(--color-surface-input)] pl-11 pr-3 text-[15px] text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-brand)] focus:bg-white focus:outline-none"
          />
        </div>
      </form>
    </header>
  );
}
