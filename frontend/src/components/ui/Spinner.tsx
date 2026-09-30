export function Spinner({ label = "Đang tải…" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2.5 py-12 text-sm text-[var(--color-text-secondary)]">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-[var(--color-border)] border-t-[var(--color-brand)]" aria-hidden="true" />
      {label}
    </div>
  );
}
