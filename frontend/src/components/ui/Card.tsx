import type { HTMLAttributes } from "react";

export function Card({ className = "", ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`rounded-[12px] border border-[var(--color-border)] bg-[var(--color-surface-card)] shadow-[var(--shadow-card)] ${className}`}
      {...rest}
    />
  );
}
