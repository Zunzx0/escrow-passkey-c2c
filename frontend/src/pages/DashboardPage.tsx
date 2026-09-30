import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { getMyWallet } from "../api/wallet";
import { getMyTransactions } from "../api/transactions";
import { getMyListings } from "../api/listings";
import { getDisputes } from "../api/disputes";
import type { Dispute, Listing, Transaction, Wallet } from "../api/types";
import { formatVnd, transactionStatusLabel, transactionStatusTone } from "../lib/status";
import { Card } from "../components/ui/Card";
import { Badge } from "../components/ui/Badge";
import { Spinner } from "../components/ui/Spinner";
import { PackageIcon, ShieldIcon, WalletIcon } from "../components/ui/icons";

const OPEN_TRANSACTION_STATUSES = new Set(["CREATED", "SECURED", "SHIPPING", "WAIT_CONFIRM", "DISPUTED"]);

function StatCard({ icon: Icon, label, value }: { icon: typeof WalletIcon; label: string; value: string }) {
  return (
    <Card className="p-4"><div className="flex items-center gap-3"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-[#e0f2fe] text-[var(--color-brand-hover)]"><Icon className="h-[18px] w-[18px]" /></span><div className="min-w-0"><p className="text-xs text-[var(--color-text-muted)]">{label}</p><p className="truncate text-lg font-bold text-[var(--color-text)]">{value}</p></div></div></Card>
  );
}

function AdminDashboard({ userName }: { userName: string }) {
  const [disputes, setDisputes] = useState<Dispute[] | null>(null);
  useEffect(() => { getDisputes().then(setDisputes).catch(() => setDisputes([])); }, []);
  const unresolved = disputes?.filter((d) => d.status !== "RESOLVED") ?? [];

  return (
    <div className="space-y-8">
      <div><h1 className="text-2xl font-bold text-[var(--color-text)]">Xin chào, {userName}</h1><p className="mt-1 text-sm text-[var(--color-text-secondary)]">Tổng quan khu vực quản trị tranh chấp.</p></div>
      <div className="grid gap-4 sm:grid-cols-2">
        <StatCard icon={ShieldIcon} label="Hồ sơ chờ phân xử" value={disputes ? String(unresolved.length) : "…"} />
        <StatCard icon={PackageIcon} label="Tổng hồ sơ" value={disputes ? String(disputes.length) : "…"} />
      </div>
      <Card className="p-5">
        <div className="flex items-center justify-between"><h2 className="text-sm font-semibold text-[var(--color-text)]">Tranh chấp cần xử lý</h2><Link to="/admin/disputes" className="text-xs font-medium text-[var(--color-brand)]">Xem tất cả</Link></div>
        <div className="mt-4 space-y-1">{!disputes && <Spinner />}{disputes && unresolved.length === 0 && <p className="text-sm text-[var(--color-text-muted)]">Không có hồ sơ nào đang chờ.</p>}{unresolved.slice(0, 5).map((d) => <Link key={d.id} to={`/admin/disputes/${d.id}`} className="flex items-center justify-between gap-3 rounded-[10px] px-2 py-2.5 text-sm transition-colors hover:bg-[var(--color-surface-subtle)]"><span className="truncate text-[var(--color-text-secondary)]">{d.reason}</span><Badge tone="red">Chờ phân xử</Badge></Link>)}</div>
      </Card>
    </div>
  );
}

export default function DashboardPage() {
  const { user } = useAuth();
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [transactions, setTransactions] = useState<Transaction[] | null>(null);
  const [listings, setListings] = useState<Listing[] | null>(null);

  useEffect(() => {
    if (user?.role !== "MEMBER") return;
    getMyWallet().then(setWallet).catch(() => setWallet(null));
    getMyTransactions().then(setTransactions).catch(() => setTransactions([]));
    getMyListings().then(setListings).catch(() => setListings([]));
  }, [user?.role]);

  if (!user) return <Spinner />;
  if (user.role === "ADMIN") return <AdminDashboard userName={user.displayName ?? user.email} />;

  const openTransactions = transactions?.filter((t) => OPEN_TRANSACTION_STATUSES.has(t.status)) ?? [];
  return (
    <div className="space-y-8">
      <div><h1 className="text-2xl font-bold text-[var(--color-text)]">Xin chào, {user.displayName ?? user.email}</h1><p className="mt-1 text-sm text-[var(--color-text-secondary)]">Tổng quan tài khoản của bạn trên Chợ An Toàn.</p></div>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3"><StatCard icon={WalletIcon} label="Số dư khả dụng" value={wallet ? formatVnd(wallet.availableBalance) : "…"} /><StatCard icon={ShieldIcon} label="Giao dịch đang xử lý" value={transactions ? String(openTransactions.length) : "…"} /><StatCard icon={PackageIcon} label="Tin đang đăng" value={listings ? String(listings.length) : "…"} /></div>
      <div className="grid gap-6 md:grid-cols-2">
        <Card className="p-5"><div className="flex items-center justify-between"><h2 className="text-sm font-semibold text-[var(--color-text)]">Giao dịch gần đây</h2><Link to="/me/transactions" className="text-xs font-medium text-[var(--color-brand)]">Xem tất cả</Link></div><div className="mt-4 space-y-1">{!transactions && <Spinner />}{transactions?.length === 0 && <p className="text-sm text-[var(--color-text-muted)]">Chưa có giao dịch nào.</p>}{transactions?.slice(0, 5).map((t) => <Link key={t.id} to={`/transactions/${t.id}`} className="flex items-center justify-between gap-3 rounded-[10px] px-2 py-2.5 text-sm transition-colors hover:bg-[var(--color-surface-subtle)]"><span className="font-semibold text-[var(--color-text)]">{formatVnd(t.amount)}</span><Badge tone={transactionStatusTone[t.status]}>{transactionStatusLabel[t.status]}</Badge></Link>)}</div></Card>
        <Card className="p-5"><div className="flex items-center justify-between"><h2 className="text-sm font-semibold text-[var(--color-text)]">Tin đăng gần đây</h2><Link to="/me/listings" className="text-xs font-medium text-[var(--color-brand)]">Xem tất cả</Link></div><div className="mt-4 space-y-1">{!listings && <Spinner />}{listings?.length === 0 && <p className="text-sm text-[var(--color-text-muted)]">Bạn chưa đăng tin nào.</p>}{listings?.slice(0, 5).map((l) => <Link key={l.id} to={`/listings/${l.id}`} className="flex items-center justify-between gap-3 rounded-[10px] px-2 py-2.5 text-sm transition-colors hover:bg-[var(--color-surface-subtle)]"><span className="truncate text-[var(--color-text-secondary)]">{l.title}</span><span className="shrink-0 font-semibold text-[var(--color-text)]">{formatVnd(l.price)}</span></Link>)}</div></Card>
      </div>
    </div>
  );
}
