import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { adjudicateDispute, getDispute } from "../api/disputes";
import type { Dispute, DisputeDecision } from "../api/types";
import { ApiError } from "../api/client";
import { performAdjudicationReauth } from "../hooks/usePasskey";
import { formatDateTime, formatVnd, transactionStatusLabel } from "../lib/status";
import { Alert } from "../components/ui/Alert";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { PasskeyConfirmModal, type PasskeyConfirmStage } from "../components/PasskeyConfirmModal";
import { Spinner } from "../components/ui/Spinner";

const inputClass =
  "mt-1.5 w-full rounded-[10px] border border-[var(--color-border)] bg-white px-3.5 py-2.5 text-sm text-[var(--color-text)] focus:border-[var(--color-brand)] focus:outline-none";

export default function AdminDisputeDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [dispute, setDispute] = useState<Dispute | null>(null);
  const [decision, setDecision] = useState<DisputeDecision>("REFUND");
  const [resolutionNote, setResolutionNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [stage, setStage] = useState<PasskeyConfirmStage>("confirm");

  useEffect(() => {
    if (!id) return;
    getDispute(id)
      .then(setDispute)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Không tải được hồ sơ tranh chấp."));
  }, [id]);

  async function handleAdjudicate() {
    if (!id) return;
    setError(null);
    try {
      setStage("passkey");
      const token = await performAdjudicationReauth(id, decision);
      setStage("processing");
      await adjudicateDispute(id, decision, token, resolutionNote.trim() || undefined);
      setDispute(await getDispute(id));
      setModalOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không thể hoàn tất phân xử.");
      setModalOpen(false);
    } finally {
      setStage("confirm");
    }
  }

  if (error && !dispute) return <Alert tone="error">{error}</Alert>;
  if (!dispute || !dispute.transaction) return <Spinner />;

  const transaction = dispute.transaction;
  const resolved = dispute.status === "RESOLVED";

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Link to="/admin/disputes" className="inline-flex items-center text-sm font-medium text-[var(--color-brand)] hover:text-[var(--color-brand-hover)]">
        Quay lại danh sách
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[var(--color-text)]">Chi tiết tranh chấp</h1>
          <p className="font-tech mt-1 text-xs text-[var(--color-text-muted)]">#{dispute.id}</p>
        </div>
        <Badge tone={resolved ? "green" : "red"}>{resolved ? "Đã giải quyết" : "Chờ phân xử"}</Badge>
      </div>

      {error && <Alert tone="error">{error}</Alert>}

      <Card className="p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <p className="text-xs text-[var(--color-text-muted)]">Giá trị giao dịch</p>
            <p className="mt-1 text-xl font-bold text-[var(--color-text)]">{formatVnd(transaction.amount)}</p>
          </div>
          <div>
            <p className="text-xs text-[var(--color-text-muted)]">Trạng thái giao dịch</p>
            <p className="mt-1 text-sm font-semibold text-[var(--color-text)]">{transactionStatusLabel[transaction.status]}</p>
          </div>
        </div>
        <p className="font-tech mt-4 text-xs text-[var(--color-text-muted)]">Giao dịch #{transaction.id}</p>
      </Card>

      <Card className="p-5">
        <h2 className="text-sm font-semibold text-[var(--color-text)]">Lý do mở tranh chấp</h2>
        <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-[var(--color-text-secondary)]">{dispute.reason}</p>
        <p className="mt-3 text-xs text-[var(--color-text-muted)]">Mở lúc {formatDateTime(dispute.createdAt)}</p>
      </Card>

      {resolved ? (
        <Alert tone="info">
          Quyết định: <strong>{dispute.decision === "REFUND" ? "Hoàn tiền cho người mua" : "Chuyển tiền cho người bán"}</strong>
          {dispute.resolutionNote ? ` — ${dispute.resolutionNote}` : ""}
        </Alert>
      ) : (
        <Card className="p-5">
          <h2 className="text-sm font-semibold text-[var(--color-text)]">Quyết định phân xử</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => setDecision("REFUND")}
              className={`rounded-[10px] border p-4 text-left transition-colors ${decision === "REFUND" ? "border-[var(--color-brand)] bg-[#f0f9ff]" : "border-[var(--color-border)]"}`}
            >
              <span className="text-sm font-semibold text-[var(--color-text)]">Hoàn tiền người mua</span>
              <span className="mt-1 block text-xs leading-5 text-[var(--color-text-muted)]">Tiền trong Escrow quay lại ví người mua.</span>
            </button>
            <button
              type="button"
              onClick={() => setDecision("RELEASE")}
              className={`rounded-[10px] border p-4 text-left transition-colors ${decision === "RELEASE" ? "border-[var(--color-brand)] bg-[#f0f9ff]" : "border-[var(--color-border)]"}`}
            >
              <span className="text-sm font-semibold text-[var(--color-text)]">Chuyển tiền người bán</span>
              <span className="mt-1 block text-xs leading-5 text-[var(--color-text-muted)]">Giải ngân tiền trong Escrow cho người bán.</span>
            </button>
          </div>
          <label className="mt-4 block text-sm font-medium text-[var(--color-text)]" htmlFor="resolutionNote">
            Ghi chú phân xử (tuỳ chọn)
          </label>
          <textarea id="resolutionNote" rows={4} maxLength={2000} value={resolutionNote} onChange={(e) => setResolutionNote(e.target.value)} className={inputClass} />
          <Button className="mt-4 w-full" onClick={() => setModalOpen(true)}>
            Tiếp tục xác nhận bằng Passkey
          </Button>
        </Card>
      )}

      <PasskeyConfirmModal
        open={modalOpen}
        title={decision === "REFUND" ? "Xác nhận hoàn tiền cho người mua" : "Xác nhận chuyển tiền cho người bán"}
        amount={transaction.amount}
        transactionLabel={`#${transaction.id.slice(0, 10)}…`}
        consequence="Quyết định sẽ tất toán Escrow ngay lập tức và không thể hoàn tác."
        stage={stage}
        onConfirm={handleAdjudicate}
        onCancel={() => setModalOpen(false)}
      />
    </div>
  );
}
