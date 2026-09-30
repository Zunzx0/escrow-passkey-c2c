import { type ButtonHTMLAttributes, forwardRef } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "gradient";

// §33: only the "Đăng tin" CTA uses the brand gradient; every other button
// stays flat so the page doesn't read as a SaaS landing page.
const variantClasses: Record<Variant, string> = {
  primary:
    "bg-[var(--color-brand)] text-white hover:bg-[var(--color-brand-hover)] disabled:bg-[#cbd5e1] disabled:text-white",
  gradient:
    "bg-[linear-gradient(90deg,#0EA5E9,#2563EB)] text-white hover:brightness-[1.06] disabled:bg-none disabled:bg-[#cbd5e1]",
  secondary:
    "border border-[var(--color-border)] bg-white text-[var(--color-text)] hover:border-[var(--color-border-hover)] hover:bg-[var(--color-surface-subtle)] disabled:text-[var(--color-text-light)]",
  ghost: "bg-transparent text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-subtle)] hover:text-[var(--color-text)]",
  danger: "bg-[var(--color-danger)] text-white hover:brightness-95 disabled:bg-[#cbd5e1]",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", loading = false, disabled, className = "", children, ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={`inline-flex items-center justify-center gap-2 rounded-[10px] px-4 text-sm font-semibold transition-all duration-150 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-brand)] ${
        className.includes("h-") ? "" : "h-11"
      } ${variantClasses[variant]} ${className}`}
      {...rest}
    >
      {loading && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" />}
      {children}
    </button>
  );
});
