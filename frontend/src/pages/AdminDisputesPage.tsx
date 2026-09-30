import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getDisputes } from "../api/disputes";
import type { Dispute } from "../api/types";
import { ApiError } from "../api/client";
import { formatDateTime, formatVnd } from "../lib/status";
import { Alert } from "../components/ui/Alert";
import { Badge } from "../components/ui/Badge";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { Spinner } from "../components/ui/Spinner";
import { ChevronRightIcon, ShieldIcon } from "../components/ui/icons";

const statusLabel = {
  OPEN: "Mới mở",
  UNDER_REVIEW: "Đang xem xét",
  NEED_MORE_EVIDENCE: "Cần thêm bằng chứng",
  RESOLVED: "Đã giải quyết",
} as const;

export default function AdminDisputesPage() {
  const [items, setItems] = useState<Dispute[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getDisputes()
      .then(setItems)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Không tải được hồ sơ tranh chấp."));
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-[var(--color-text)]">Hồ sơ tranh chấp</h1>
        <p className="mt-1 text-sm text-[var(--color-text-secondary)]">Xem xét và phân xử các giao dịch đang bị đóng băng.</p>
      </div>

      {error && <Alert tone="error">{error}</Alert>}
      {!error && items === null && <Spinner />}
      {items?.length === 0 && <EmptyState title="Không có hồ sơ tranh chấp" description="Các hồ sơ mới sẽ xuất hiện tại đây." />}

      {items && items.length > 0 && (
        <div className="space-y-3">
          {items.map((dispute) => (
            <Link key={dispute.id} to={`/admin/disputes/${dispute.id}`} className="block">
              <Card className="flex items-center gap-4 p-4 transition-all hover:border-[var(--color-border-hover)] hover:shadow-[var(--shadow-card-hover)]">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] bg-[#fee2e2] text-[var(--color-danger)]">
                  <ShieldIcon className="h-5 w-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-tech text-xs text-[var(--color-text-muted)]">#{dispute.transactionId}</p>
                    <Badge tone={dispute.status === "RESOLVED" ? "green" : "red"}>{statusLabel[dispute.status]}</Badge>
                  </div>
                  <p className="mt-1.5 line-clamp-1 text-sm text-[var(--color-text-secondary)]">{dispute.reason}</p>
                  <p className="mt-1 text-xs text-[var(--color-text-muted)]">Mở lúc {formatDateTime(dispute.createdAt)}</p>
                </div>
                {dispute.transaction && <span className="shrink-0 font-bold text-[var(--color-text)]">{formatVnd(dispute.transaction.amount)}</span>}
                <ChevronRightIcon className="h-5 w-5 shrink-0 text-[var(--color-text-light)]" />
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
