import { NavLink } from "react-router-dom";
import { ChevronRightIcon, PackageIcon, ShieldIcon, WalletIcon } from "../ui/icons";
import type { ComponentType, SVGProps } from "react";
import { useAuth } from "../../context/AuthContext";

const memberLinks: { to: string; label: string; icon: ComponentType<SVGProps<SVGSVGElement>>; end?: boolean }[] = [
  { to: "/me", label: "Tổng quan", icon: ChevronRightIcon, end: true },
  { to: "/me/transactions", label: "Giao dịch của tôi", icon: ShieldIcon },
  { to: "/me/listings", label: "Tin đăng của tôi", icon: PackageIcon },
  { to: "/me/wallet", label: "Ví", icon: WalletIcon },
];

const adminLinks = [
  { to: "/me", label: "Tổng quan", icon: ChevronRightIcon, end: true },
  { to: "/admin/disputes", label: "Hồ sơ tranh chấp", icon: ShieldIcon },
];

/** Account-area sidebar only — never rendered on the marketplace pages. */
export function Sidebar() {
  const { user } = useAuth();
  const links = user?.role === "ADMIN" ? adminLinks : memberLinks;
  return (
    <aside className="hidden w-56 shrink-0 md:block">
      <nav className="sticky top-32 space-y-1">
        {links.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              `flex items-center gap-2.5 rounded-[10px] px-3 py-2.5 text-sm font-medium transition-colors ${
                isActive
                  ? "bg-[#e0f2fe] text-[var(--color-brand-hover)]"
                  : "text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-subtle)] hover:text-[var(--color-text)]"
              }`
            }
          >
            <Icon className="h-4 w-4" />
            {label}
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}
