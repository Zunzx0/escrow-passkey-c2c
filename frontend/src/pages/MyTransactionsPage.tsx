import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { getMyTransactions } from "../api/transactions";
import type { Transaction } from "../api/types";
import { ApiError } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { formatDateTime, formatVnd, transactionStatusLabel, transactionStatusTone } from "../lib/status";
import { Card } from "../components/ui/Card";
import { Spinner } from "../components/ui/Spinner";
import { Alert } from "../components/ui/Alert";
import { Badge } from "../components/ui/Badge";
import { EmptyState } from "../components/ui/EmptyState";
import { ChevronRightIcon } from "../components/ui/icons";

type Filter = "all" | "buyer" | "seller" | "open" | "done";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "Tất cả" },
  { key: "buyer", label: "Tôi là người mua" },
  { key: "seller", label: "Tôi là người bán" },
  { key: "open", label: "Đang xử lý" },
  { key: "done", label: "Hoàn tất" },
];

const OPEN_STATUSES = new Set(["CREATED", "SECURED", "SHIPPING", "WAIT_CONFIRM"]);
const DONE_STATUSES = new Set(["COMPLETED", "RELEASED", "REFUNDED"]);

export default function MyTransactionsPage() {
  const { user } = useAuth();
  const [transactions, setTransactions] = useState<Transaction[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");

  useEffect(() => {
    getMyTransactions()
      .then(setTransactions)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Không tải được danh sách giao dịch."));
  }, []);

  const filtered = useMemo(() => {
    if (!transactions) return null;
    return transactions.filter((t) => {
      if (filter === "buyer") return t.buyerId === user?.id;
      if (filter === "seller") return t.sellerId === user?.id;
      if (filter === "open") return OPEN_STATUSES.has(t.status);
      if (filter === "done") return DONE_STATUSES.has(t.status);
      return true;
    });
  }, [transactions, filter, user?.id]);

  return (
    <div>
      <h1 className="text-2xl font-bold text-[var(--color-text)]">Giao dịch của tôi</h1>
      <p className="mt-1 text-sm text-[var(--color-text-secondary)]">Gồm cả những giao dịch bạn là người mua và người bán.</p>

      <div className="mt-5 flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`rounded-full px-3.5 py-2 text-xs font-medium transition-colors ${
              filter === f.key
                ? "bg-[#e0f2fe] text-[var(--color-brand-hover)]"
                : "bg-[var(--color-surface-subtle)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-secondary)] hover:text-[var(--color-text)]"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="mt-5">
        {error && <Alert tone="error">{error}</Alert>}
        {!error && transactions === null && <Spinner />}
        {!error && filtered !== null && filtered.length === 0 && (
          <EmptyState title="Không có giao dịch nào" description="Mua hoặc bán một món đồ để bắt đầu." />
        )}
        {filtered && filtered.length > 0 && (
          <div className="space-y-3">
            {filtered.map((t) => (
              <Link key={t.id} to={`/transactions/${t.id}`} className="block">
                <Card className="flex items-center gap-4 p-4 transition-all hover:border-[var(--color-border-hover)] hover:shadow-[var(--shadow-card-hover)]">
                  <div className="min-w-0 flex-1">
                    <span className="inline-flex rounded-full bg-[var(--color-surface-secondary)] px-2 py-0.5 text-[11px] font-medium text-[var(--color-text-secondary)]">
                      {t.buyerId === user?.id ? "Bạn là người mua" : "Bạn là người bán"}
                    </span>
                    <p className="mt-1.5 text-[17px] font-bold text-[var(--color-text)]">{formatVnd(t.amount)}</p>
                    <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">{formatDateTime(t.createdAt)}</p>
                  </div>
                  <Badge tone={transactionStatusTone[t.status]}>{transactionStatusLabel[t.status]}</Badge>
                  <ChevronRightIcon className="h-5 w-5 shrink-0 text-[var(--color-text-light)]" />
                </Card>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
