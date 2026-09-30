import type { ReactNode } from "react";

export function EmptyState({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-[12px] border border-[var(--color-border)] bg-[var(--color-surface-subtle)] py-16 text-center">
      <p className="text-base font-semibold text-[var(--color-text)]">{title}</p>
      {description && <p className="max-w-sm text-sm leading-relaxed text-[var(--color-text-secondary)]">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
