import type { Transaction } from "../../api/types";
import { formatDateTime } from "../../lib/status";
import { CheckIcon } from "../ui/icons";

const STEP_ORDER = ["CREATED", "SECURED", "SHIPPING", "WAIT_CONFIRM", "COMPLETED"] as const;

interface Step {
  status: (typeof STEP_ORDER)[number];
  label: string;
  hint: string;
  timestamp: (t: Transaction) => string | null;
}

const STEPS: Step[] = [
  { status: "CREATED", label: "Tạo giao dịch", hint: "Người mua đã chọn mua món đồ này.", timestamp: (t) => t.createdAt },
  {
    status: "SECURED",
    label: "Đã thanh toán, tiền được giữ an toàn",
    hint: "Người bán chưa nhận được tiền.",
    timestamp: (t) => (t.status === "CREATED" ? null : t.updatedAt),
  },
  { status: "SHIPPING", label: "Người bán đã gửi hàng", hint: "Đang trên đường tới người mua.", timestamp: (t) => t.shippedAt },
  { status: "WAIT_CONFIRM", label: "Người mua đã nhận hàng", hint: "Chờ người mua xác nhận để hoàn tất.", timestamp: (t) => t.receivedAt },
  { status: "COMPLETED", label: "Hoàn tất", hint: "Tiền đã được chuyển cho người bán.", timestamp: (t) => t.completedAt },
];

export function StatusTimeline({ transaction }: { transaction: Transaction }) {
  // Terminal and disputed states sit outside the happy-path enum. Infer the
  // furthest completed business step from durable timestamps so the timeline
  // does not jump back to an empty state when Escrow is frozen or settled.
  const effectiveStatus = STEP_ORDER.includes(transaction.status as (typeof STEP_ORDER)[number])
    ? (transaction.status as (typeof STEP_ORDER)[number])
    : transaction.completedAt
      ? "COMPLETED"
      : transaction.receivedAt
        ? "WAIT_CONFIRM"
        : transaction.shippedAt
          ? "SHIPPING"
          : transaction.escrowStatus !== "NONE"
            ? "SECURED"
            : "CREATED";
  const currentIndex = STEP_ORDER.indexOf(effectiveStatus);

  return (
    <ol>
      {STEPS.map((step, i) => {
        const isLastStep = i === STEPS.length - 1;
        const isDone = i < currentIndex || (isLastStep && i === currentIndex);
        const isCurrent = i === currentIndex && !isDone;
        const ts = step.timestamp(transaction);

        return (
          <li key={step.status} className="relative flex gap-4 pb-7 last:pb-0">
            {!isLastStep && (
              <span
                className={`absolute left-[13px] top-7 h-[calc(100%-1.25rem)] w-px ${isDone ? "bg-[var(--color-brand)]" : "bg-[var(--color-border)]"}`}
                aria-hidden="true"
              />
            )}
            <span
              className={`z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${
                isDone
                  ? "bg-[var(--color-brand)] text-white"
                  : isCurrent
                    ? "border-2 border-[var(--color-brand)] bg-white text-[var(--color-brand)]"
                    : "border-2 border-[var(--color-border)] bg-white text-[var(--color-text-light)]"
              }`}
            >
              {isDone ? <CheckIcon className="h-3.5 w-3.5" strokeWidth={2.5} /> : i + 1}
            </span>

            <div className="min-w-0 pt-0.5">
              <p className={`text-sm font-semibold ${isDone || isCurrent ? "text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}`}>
                {step.label}
              </p>
              <p className="mt-0.5 text-xs leading-5 text-[var(--color-text-secondary)]">{step.hint}</p>
              {ts && <p className="font-tech mt-1 text-[11px] text-[var(--color-text-muted)]">{formatDateTime(ts)}</p>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
