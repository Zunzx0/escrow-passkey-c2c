import { useCallback, useEffect, useState, type FormEvent } from "react";
import { createTopUp, getMyPaymentRequests, simulateProviderCallback } from "../api/payments";
import { getMyWallet, getMyWalletEntries } from "../api/wallet";
import type { PaymentRequest, Wallet, WalletEntry } from "../api/types";
import { ApiError } from "../api/client";
import { formatDateTime, formatVnd, walletEntryTypeLabel } from "../lib/status";
import { Card } from "../components/ui/Card";
import { Spinner } from "../components/ui/Spinner";
import { Alert } from "../components/ui/Alert";
import { Button } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";
import { WalletIcon } from "../components/ui/icons";

function deltaText(entry: WalletEntry): { text: string; positive: boolean } {
  const total = entry.deltaAvailable + entry.deltaLocked;
  return { text: `${total >= 0 ? "+" : ""}${formatVnd(total)}`, positive: total >= 0 };
}

const paymentStatusLabel = { PENDING: "Đang xử lý", SUCCEEDED: "Thành công", FAILED: "Thất bại", TIMEOUT: "Hết thời gian" } as const;

export default function WalletPage() {
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [entries, setEntries] = useState<WalletEntry[] | null>(null);
  const [payments, setPayments] = useState<PaymentRequest[] | null>(null);
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    try {
      const [w, e, p] = await Promise.all([getMyWallet(), getMyWalletEntries(), getMyPaymentRequests()]);
      setWallet(w);
      setEntries(e);
      setPayments(p);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Không tải được thông tin ví.");
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleTopUp(e: FormEvent) {
    e.preventDefault();
    const parsed = Number(amount);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      setError("Số tiền nạp phải là số nguyên dương.");
      return;
    }
    setError(null);
    setSuccess(null);
    setLoading(true);
    try {
      const request = await createTopUp(parsed, crypto.randomUUID());
      const result = await simulateProviderCallback(request.id, "SUCCEEDED");
      if (result.outcome !== "CREDITED" && result.outcome !== "IGNORED_TERMINAL") {
        throw new Error(`Nhà cung cấp mô phỏng trả về kết quả ${result.outcome}.`);
      }
      setAmount("");
      setSuccess(`Đã nạp thành công ${formatVnd(parsed)} qua nhà cung cấp thanh toán mô phỏng.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không thể nạp tiền.");
    } finally {
      setLoading(false);
    }
  }

  if (error && !wallet) return <Alert tone="error">{error}</Alert>;
  if (!wallet) return <Spinner />;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-[var(--color-text)]">Ví của tôi</h1>
      <div className="grid gap-4 sm:grid-cols-3">
        <Card className="p-5"><p className="text-xs text-[var(--color-text-muted)]">Số dư khả dụng</p><p className="mt-1.5 text-2xl font-bold text-[var(--color-text)]">{formatVnd(wallet.availableBalance)}</p></Card>
        <Card className="p-5"><p className="text-xs text-[var(--color-text-muted)]">Đang được giữ an toàn</p><p className="mt-1.5 text-2xl font-bold text-[#0369a1]">{formatVnd(wallet.lockedBalance)}</p></Card>
        <Card className="p-5"><p className="text-xs text-[var(--color-text-muted)]">Tổng cộng</p><p className="mt-1.5 text-2xl font-bold text-[var(--color-text-secondary)]">{formatVnd(wallet.availableBalance + wallet.lockedBalance)}</p></Card>
      </div>

      {error && <Alert tone="error">{error}</Alert>}
      {success && <Alert tone="success">{success}</Alert>}

      <Card className="p-5">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-[#e0f2fe] text-[var(--color-brand-hover)]"><WalletIcon className="h-5 w-5" /></span>
          <div><h2 className="text-sm font-semibold text-[var(--color-text)]">Nạp tiền thử nghiệm</h2><p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">Bản demo tạo yêu cầu PENDING qua nhà cung cấp thanh toán mô phỏng; ví chỉ được cộng sau khi callback có chữ ký hợp lệ báo thành công.</p></div>
        </div>
        <form className="mt-4 flex flex-col gap-3 sm:flex-row" onSubmit={handleTopUp}>
          <div className="flex-1">
            <label htmlFor="topupAmount" className="sr-only">Số tiền muốn nạp</label>
            <input id="topupAmount" type="number" min="1000" step="1000" required value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Ví dụ: 1.000.000" className="h-11 w-full rounded-[10px] border border-[var(--color-border)] bg-white px-3.5 text-sm text-[var(--color-text)] focus:border-[var(--color-brand)] focus:outline-none" />
          </div>
          <Button type="submit" loading={loading}><WalletIcon className="h-[18px] w-[18px]" /> Nạp tiền</Button>
        </form>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="p-5">
          <h2 className="text-sm font-semibold text-[var(--color-text)]">Lịch sử biến động</h2>
          <div className="mt-4">
            {entries === null && <Spinner />}
            {entries?.length === 0 && <EmptyState title="Chưa có biến động nào" />}
            {entries && entries.length > 0 && <div className="divide-y divide-[var(--color-border)]">{entries.map((entry) => { const { text, positive } = deltaText(entry); return <div key={entry.id} className="flex items-center justify-between gap-4 py-3.5 text-sm"><div className="min-w-0"><p className="font-medium text-[var(--color-text)]">{walletEntryTypeLabel[entry.entryType]}</p><p className="font-tech mt-0.5 text-xs text-[var(--color-text-muted)]">{formatDateTime(entry.createdAt)}</p></div><span className={`shrink-0 font-bold ${positive ? "text-[var(--color-success)]" : "text-[var(--color-danger)]"}`}>{text}</span></div>; })}</div>}
          </div>
        </Card>

        <Card className="p-5">
          <h2 className="text-sm font-semibold text-[var(--color-text)]">Yêu cầu nạp tiền</h2>
          <div className="mt-4">
            {payments === null && <Spinner />}
            {payments?.length === 0 && <EmptyState title="Chưa có yêu cầu nạp tiền" />}
            {payments && payments.length > 0 && <div className="divide-y divide-[var(--color-border)]">{payments.map((payment) => <div key={payment.id} className="flex items-center justify-between gap-4 py-3.5 text-sm"><div className="min-w-0"><p className="font-medium text-[var(--color-text)]">{formatVnd(payment.amount)}</p><p className="font-tech mt-0.5 truncate text-xs text-[var(--color-text-muted)]">{formatDateTime(payment.createdAt)}</p></div><span className={`shrink-0 text-xs font-semibold ${payment.status === "SUCCEEDED" ? "text-[var(--color-success)]" : payment.status === "PENDING" ? "text-[#b45309]" : "text-[var(--color-danger)]"}`}>{paymentStatusLabel[payment.status]}</span></div>)}</div>}
          </div>
        </Card>
      </div>
    </div>
  );
}
