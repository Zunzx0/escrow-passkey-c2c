import type { ComponentType, SVGProps } from "react";
import type { EscrowStatus } from "../../api/types";
import { escrowStatusLabel, formatVnd } from "../../lib/status";
import { AlertIcon, CheckCircleIcon, LockIcon } from "../ui/icons";

const icon: Record<EscrowStatus, ComponentType<SVGProps<SVGSVGElement>>> = {
  NONE: LockIcon,
  LOCKED: LockIcon,
  FROZEN: AlertIcon,
  RELEASED: CheckCircleIcon,
  REFUNDED: CheckCircleIcon,
};

const barClasses: Record<EscrowStatus, string> = {
  NONE: "border-[var(--color-border)] bg-[var(--color-surface-subtle)] text-[var(--color-text-secondary)]",
  LOCKED: "border-[#bae6fd] bg-[#f0f9ff] text-[#075985]",
  FROZEN: "border-[#fecaca] bg-[#fef2f2] text-[#b91c1c]",
  RELEASED: "border-[#a7f3d0] bg-[#ecfdf5] text-[#047857]",
  REFUNDED: "border-[#ddd6fe] bg-[#f5f3ff] text-[#6d28d9]",
};

const iconBg: Record<EscrowStatus, string> = {
  NONE: "bg-white",
  LOCKED: "bg-[#e0f2fe]",
  FROZEN: "bg-[#fee2e2]",
  RELEASED: "bg-[#d1fae5]",
  REFUNDED: "bg-[#ede9fe]",
};

/** Always visible on a transaction so both sides can see where the money sits. */
export function EscrowBanner({ escrowStatus, amount }: { escrowStatus: EscrowStatus; amount: number }) {
  const Icon = icon[escrowStatus];
  return (
    <div className={`flex items-center gap-3.5 rounded-[12px] border px-4 py-3.5 ${barClasses[escrowStatus]}`}>
      <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${iconBg[escrowStatus]}`}>
        <Icon className="h-5 w-5" />
      </span>
      <div>
        <p className="text-sm font-semibold">{escrowStatusLabel[escrowStatus]}</p>
        <p className="mt-0.5 text-xs opacity-80">Số tiền giao dịch: {formatVnd(amount)}</p>
      </div>
    </div>
  );
}
