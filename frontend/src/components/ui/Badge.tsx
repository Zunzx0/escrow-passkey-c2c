import type { ReactNode } from "react";

type Tone = "slate" | "amber" | "blue" | "green" | "red" | "purple";

const toneClasses: Record<Tone, string> = {
  slate: "bg-[#f1f5f9] text-[#475569]",
  amber: "bg-[#fef3c7] text-[#b45309]",
  blue: "bg-[#e0f2fe] text-[#0369a1]",
  green: "bg-[#d1fae5] text-[#047857]",
  red: "bg-[#fee2e2] text-[#b91c1c]",
  purple: "bg-[#ede9fe] text-[#6d28d9]",
};

export function Badge({ tone = "slate", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${toneClasses[tone]}`}>{children}</span>;
}
