import type { ReactNode } from "react";

export function Modal({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="animate-fade-in absolute inset-0 bg-[#0f172a]/40 backdrop-blur-[2px]" onClick={onClose} aria-hidden="true" />
      <div className="animate-fade-in relative w-full max-w-md rounded-[16px] border border-[var(--color-border)] bg-white p-6 shadow-[0_24px_60px_rgba(15,23,42,0.18)]">
        {children}
      </div>
    </div>
  );
}
