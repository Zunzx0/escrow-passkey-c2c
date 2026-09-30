import { Link } from "react-router-dom";
import { ShieldIcon } from "../ui/icons";

/** Columns of real routes are links; anything without a page is a plain label, never a dead link. */
const LINK_COLUMNS: { title: string; items: { label: string; to: string }[] }[] = [
  {
    title: "Mua hàng",
    items: [
      { label: "Khám phá", to: "/" },
      { label: "Tin mới đăng", to: "/" },
    ],
  },
  {
    title: "Bán hàng",
    items: [
      { label: "Đăng tin", to: "/listings/new" },
      { label: "Tin của tôi", to: "/me/listings" },
    ],
  },
];

const LABEL_COLUMNS: { title: string; items: string[] }[] = [
  { title: "Hỗ trợ", items: ["Trung tâm trợ giúp", "Hướng dẫn mua", "Hướng dẫn bán", "Tranh chấp"] },
  { title: "Pháp lý", items: ["Điều khoản", "Quyền riêng tư", "Bảo mật"] },
];

export function Footer() {
  return (
    <footer className="mt-auto border-t border-[var(--color-border)] bg-[var(--color-surface-subtle)]">
      <div className="mx-auto max-w-[1360px] px-4 pb-10 pt-14 sm:px-6 2xl:max-w-[1480px]">
        {/* Logo block on the left, link columns clustered tightly on the
            right — previously all 5 blocks split an equal 1fr each across
            the full ~1360-1480px container, so short column content ended
            up with huge leftover whitespace. Capping each link column's
            width keeps them close together regardless of container width. */}
        <div className="flex flex-col gap-10 md:flex-row md:items-start md:justify-between">
          <div className="max-w-[280px] shrink-0">
            <div className="flex items-center gap-2.5">
              <span className="brand-gradient flex h-9 w-9 items-center justify-center rounded-[9px] text-white">
                <ShieldIcon className="h-[19px] w-[19px]" />
              </span>
              <span className="text-[17px] font-bold text-[var(--color-text)]">Chợ An Toàn</span>
            </div>
            <p className="mt-4 text-[14px] leading-7 text-[var(--color-text-secondary)]">
              Chợ mua bán giữa các cá nhân, với dòng tiền được bảo vệ trong suốt giao dịch.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-x-10 gap-y-10 sm:grid-cols-4 sm:gap-x-12 md:grid-cols-[repeat(4,minmax(0,140px))]">
            {LINK_COLUMNS.map((col) => (
              <div key={col.title}>
                <p className="text-[15px] font-semibold text-[var(--color-text)]">{col.title}</p>
                <ul className="mt-4 space-y-3">
                  {col.items.map((item) => (
                    <li key={item.label}>
                      <Link to={item.to} className="text-[14px] leading-6 text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-brand)]">
                        {item.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}

            {LABEL_COLUMNS.map((col) => (
              <div key={col.title}>
                <p className="text-[15px] font-semibold text-[var(--color-text)]">{col.title}</p>
                <ul className="mt-4 space-y-3">
                  {col.items.map((item) => (
                    <li key={item} className="text-[14px] leading-6 text-[var(--color-text-muted)]">
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-10 border-t border-[var(--color-border)] pt-6">
          <p className="text-[13px] text-[var(--color-text-secondary)]">© {new Date().getFullYear()} Chợ An Toàn</p>
        </div>
      </div>
    </footer>
  );
}
