import { Modal } from "./ui/Modal";
import { Button } from "./ui/Button";
import { PasskeyIcon } from "./ui/icons";
import { formatVnd } from "../lib/status";

export type PasskeyConfirmStage = "confirm" | "passkey" | "processing";

interface PasskeyConfirmModalProps {
  open: boolean;
  title: string;
  amount: number;
  transactionLabel: string;
  consequence: string;
  stage: PasskeyConfirmStage;
  onConfirm: () => void;
  onCancel: () => void;
}

const stageMessage: Record<PasskeyConfirmStage, string> = {
  confirm: "",
  passkey: "Vui lòng hoàn tất xác thực trên thiết bị của bạn…",
  processing: "Đang thực hiện thao tác…",
};

/**
 * Before any Passkey-gated sensitive action, show exactly what is being
 * authorized — action, amount, which transaction, consequence — as its own
 * step, separate from the WebAuthn browser prompt that follows.
 */
export function PasskeyConfirmModal({ open, title, amount, transactionLabel, consequence, stage, onConfirm, onCancel }: PasskeyConfirmModalProps) {
  const busy = stage !== "confirm";

  return (
    <Modal open={open} onClose={busy ? () => {} : onCancel}>
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#e0f2fe] text-[var(--color-brand-hover)]">
          <PasskeyIcon className="h-5 w-5" />
        </span>
        <div>
          <h2 className="text-base font-semibold text-[var(--color-text)]">{title}</h2>
          <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">Thao tác quan trọng — cần xác nhận lại danh tính của bạn</p>
        </div>
      </div>

      <dl className="mt-5 space-y-2.5 rounded-[10px] border border-[var(--color-border)] bg-[var(--color-surface-subtle)] p-4 text-sm">
        <div className="flex items-center justify-between gap-4">
          <dt className="text-[var(--color-text-secondary)]">Giao dịch</dt>
          <dd className="font-tech truncate text-[var(--color-text)]">{transactionLabel}</dd>
        </div>
        <div className="flex items-center justify-between gap-4">
          <dt className="text-[var(--color-text-secondary)]">Số tiền</dt>
          <dd className="text-[15px] font-bold text-[var(--color-text)]">{formatVnd(amount)}</dd>
        </div>
      </dl>

      <p className="mt-4 text-sm leading-relaxed text-[var(--color-text-secondary)]">{consequence}</p>

      {busy ? (
        <div className="mt-6 flex items-center justify-center gap-2.5 py-2 text-sm text-[var(--color-text-secondary)]">
          <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-[var(--color-border)] border-t-[var(--color-brand)]" aria-hidden="true" />
          {stageMessage[stage]}
        </div>
      ) : (
        <div className="mt-6 flex gap-3">
          <Button variant="secondary" className="flex-1" onClick={onCancel}>
            Hủy
          </Button>
          <Button className="flex-1" onClick={onConfirm}>
            Xác nhận
          </Button>
        </div>
      )}
    </Modal>
  );
}
