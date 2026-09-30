import type { ReactNode } from "react";

type Tone = "error" | "info" | "success";

const toneClasses: Record<Tone, string> = {
  error: "border-[#fecaca] bg-[#fef2f2] text-[#b91c1c]",
  info: "border-[#bae6fd] bg-[#f0f9ff] text-[#075985]",
  success: "border-[#a7f3d0] bg-[#ecfdf5] text-[#047857]",
};

export function Alert({ tone = "info", children }: { tone?: Tone; children: ReactNode }) {
  return <div className={`rounded-[10px] border px-4 py-3 text-sm leading-relaxed ${toneClasses[tone]}`}>{children}</div>;
}
