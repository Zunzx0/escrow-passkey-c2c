import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  buyerReceive,
  getTransaction,
  lockTransaction,
  openDispute,
  releaseTransaction,
  sellerAcknowledge,
  shipTransaction,
} from "../api/transactions";
import { getListing } from "../api/listings";
import { getMyWallet } from "../api/wallet";
import type { Listing, Transaction } from "../api/types";
import { ApiError } from "../api/client";
import { performReleaseReauth } from "../hooks/usePasskey";
import { useAuth } from "../context/AuthContext";
import { formatVnd, transactionStatusLabel, transactionStatusTone } from "../lib/status";
import { Card } from "../components/ui/Card";
import { Spinner } from "../components/ui/Spinner";
import { Alert } from "../components/ui/Alert";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { EscrowBanner } from "../components/transaction/EscrowBanner";
import { StatusTimeline } from "../components/transaction/StatusTimeline";
import { PasskeyConfirmModal, type PasskeyConfirmStage } from "../components/PasskeyConfirmModal";
import { ChevronRightIcon, PackageIcon } from "../components/ui/icons";
import { productIconForName } from "../lib/productIcon";

type ActionKey = "lock" | "ack" | "ship" | "receive" | null;

export default function TransactionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();

  const [transaction, setTransaction] = useState<Transaction | null>(null);
  const [listing, setListing] = useState<Listing | null>(null);
  const [availableBalance, setAvailableBalance] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<ActionKey>(null);

  const [releaseModalOpen, setReleaseModalOpen] = useState(false);
  const [releaseStage, setReleaseStage] = useState<PasskeyConfirmStage>("confirm");
  const [disputeReason, setDisputeReason] = useState("");
  const [openingDispute, setOpeningDispute] = useState(false);
  const [showDisputeForm, setShowDisputeForm] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [t, w] = await Promise.all([getTransaction(id), getMyWallet().catch(() => null)]);
      setTransaction(t);
      if (w) setAvailableBalance(w.availableBalance);
      // Always show WHAT is being transacted. Non-blocking: the page must
      // still work if the listing can't be loaded.
      getListing(t.listingId)
        .then(setListing)
        .catch(() => setListing(null));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Không tải được giao dịch.");
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  if (error) return <Alert tone="error">{error}</Alert>;
  if (!transaction || !user) return <Spinner />;

  const isBuyer = user.id === transaction.buyerId;
  const isSeller = user.id === transaction.sellerId;

  async function runAction(key: ActionKey, fn: () => Promise<Transaction>) {
    setActionError(null);
    setPendingAction(key);
    try {
      const updated = await fn();
      setTransaction(updated);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Thao tác thất bại.");
    } finally {
      setPendingAction(null);
    }
  }

  async function handleConfirmRelease() {
    if (!id) return;
    setActionError(null);
    try {
      setReleaseStage("passkey");
      const token = await performReleaseReauth(id);
      setReleaseStage("processing");
      const updated = await releaseTransaction(id, token);
      setTransaction(updated);
      setReleaseModalOpen(false);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Không thể giải ngân.");
      setReleaseModalOpen(false);
    } finally {
      setReleaseStage("confirm");
    }
  }

  const insufficientBalance = isBuyer && transaction.status === "CREATED" && availableBalance !== null && availableBalance < transaction.amount;

  const hasAction =
    (isBuyer && transaction.status === "CREATED") ||
    (isSeller && transaction.status === "SECURED") ||
    (isBuyer && transaction.status === "SHIPPING") ||
    (isBuyer && transaction.status === "WAIT_CONFIRM");

  const canOpenDispute =
    (isBuyer && ["SECURED", "SHIPPING", "WAIT_CONFIRM"].includes(transaction.status)) ||
    (isSeller && transaction.status === "WAIT_CONFIRM");

  async function handleOpenDispute() {
    if (!transaction) return;
    if (!disputeReason.trim()) {
      setActionError("Vui lòng mô tả lý do mở tranh chấp.");
      return;
    }
    setActionError(null);
    setOpeningDispute(true);
    try {
      await openDispute(transaction.id, disputeReason.trim());
      setDisputeReason("");
      setShowDisputeForm(false);
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Không thể mở tranh chấp.");
    } finally {
      setOpeningDispute(false);
    }
  }

  const roleLabel = isBuyer && isSeller ? "Người mua và người bán" : isBuyer ? "Người mua" : isSeller ? "Người bán" : "Người ngoài cuộc";

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-[var(--color-text)]">Chi tiết giao dịch</h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <span className="font-tech text-xs text-[var(--color-text-muted)]">#{transaction.id}</span>
            <span className="rounded-full bg-[var(--color-surface-secondary)] px-2 py-0.5 text-[11px] font-medium text-[var(--color-text-secondary)]">
              Vai trò của bạn: {roleLabel}
            </span>
          </div>
        </div>
        <Badge tone={transactionStatusTone[transaction.status]}>{transactionStatusLabel[transaction.status]}</Badge>
      </div>

      {listing && (
        <Link to={`/listings/${listing.id}`} className="block">
          <Card className="flex items-center gap-4 p-4 transition-colors hover:border-[var(--color-border-hover)]">
            <span className="h-16 w-16 shrink-0 overflow-hidden rounded-[10px] bg-[var(--color-surface-subtle)]">
              {listing.images[0]?.url ? (
                <img src={listing.images[0].url} alt="" className="h-full w-full object-cover" />
              ) : (
                <span className="flex h-full items-center justify-center text-[var(--color-text-light)]">
                  {listing ? productIconForName(listing.title, { className: "h-6 w-6" }) : <PackageIcon className="h-6 w-6" />}
                </span>
              )}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-[var(--color-text)]">{listing.title}</p>
              <p className="mt-1 text-[17px] font-bold text-[var(--color-text)]">{formatVnd(transaction.amount)}</p>
            </div>
            <ChevronRightIcon className="h-5 w-5 shrink-0 text-[var(--color-text-light)]" />
          </Card>
        </Link>
      )}

      <EscrowBanner escrowStatus={transaction.escrowStatus} amount={transaction.amount} />

      {transaction.status === "DISPUTED" && (
        <Alert tone="error">Giao dịch đang được đóng băng để quản trị viên xem xét. Tiền trong Escrow sẽ không được giải ngân cho đến khi có quyết định phân xử.</Alert>
      )}

      {actionError && <Alert tone="error">{actionError}</Alert>}

      <Card className="p-6">
        <h2 className="text-sm font-semibold text-[var(--color-text)]">Tiến trình giao dịch</h2>
        <div className="mt-5">
          <StatusTimeline transaction={transaction} />
        </div>
      </Card>

      {(canOpenDispute || showDisputeForm) && (
        <Card className="p-6">
          <h2 className="text-sm font-semibold text-[var(--color-text)]">Có vấn đề với giao dịch?</h2>
          <p className="mt-2 text-sm leading-6 text-[var(--color-text-secondary)]">Mở tranh chấp sẽ đóng băng tiền trong Escrow để quản trị viên xem xét.</p>
          {!showDisputeForm ? (
            <Button variant="danger" className="mt-4" onClick={() => setShowDisputeForm(true)}>Mở tranh chấp</Button>
          ) : (
            <div className="mt-4 space-y-3">
              <label htmlFor="disputeReason" className="block text-sm font-medium text-[var(--color-text)]">Lý do tranh chấp</label>
              <textarea
                id="disputeReason"
                rows={4}
                maxLength={2000}
                required
                value={disputeReason}
                onChange={(e) => setDisputeReason(e.target.value)}
                placeholder="Mô tả rõ vấn đề với hàng hóa hoặc quá trình giao dịch…"
                className="w-full rounded-[10px] border border-[var(--color-border)] bg-white px-3.5 py-2.5 text-sm text-[var(--color-text)] focus:border-[var(--color-brand)] focus:outline-none"
              />
              <div className="flex gap-3">
                <Button variant="secondary" onClick={() => { setShowDisputeForm(false); setDisputeReason(""); }}>Hủy</Button>
                <Button variant="danger" loading={openingDispute} onClick={handleOpenDispute}>Xác nhận mở tranh chấp</Button>
              </div>
            </div>
          )}
        </Card>
      )}

      <Card className="p-6">
        <h2 className="text-sm font-semibold text-[var(--color-text)]">Việc cần làm</h2>

        <div className="mt-4 space-y-3">
          {isBuyer && transaction.status === "CREATED" && (
            <>
              {insufficientBalance && (
                <Alert tone="error">
                  Số dư khả dụng ({formatVnd(availableBalance ?? 0)}) không đủ để thanh toán {formatVnd(transaction.amount)}. Hãy nạp thêm tiền
                  trong mục Ví của tôi rồi quay lại giao dịch này.
                </Alert>
              )}
              <Button
                className="h-12 w-full"
                loading={pendingAction === "lock"}
                onClick={() => runAction("lock", () => lockTransaction(transaction.id))}
              >
                Thanh toán {formatVnd(transaction.amount)}
              </Button>
              <p className="text-center text-xs leading-5 text-[var(--color-text-muted)]">
                Tiền được giữ lại an toàn, người bán chưa nhận được cho đến khi bạn xác nhận đã nhận hàng.
              </p>
            </>
          )}

          {isSeller && transaction.status === "SECURED" && (
            <div className="space-y-3">
              <p className="text-sm leading-6 text-[var(--color-text-secondary)]">
                Người mua đã thanh toán và tiền đang được giữ an toàn. Bạn có thể gửi hàng.
              </p>
              {!transaction.sellerAckAt && (
                <Button
                  variant="secondary"
                  className="w-full"
                  loading={pendingAction === "ack"}
                  onClick={() => runAction("ack", () => sellerAcknowledge(transaction.id))}
                >
                  Xác nhận đã tiếp nhận đơn
                </Button>
              )}
              <Button
                className="h-12 w-full"
                loading={pendingAction === "ship"}
                onClick={() => runAction("ship", () => shipTransaction(transaction.id))}
              >
                Xác nhận đã gửi hàng
              </Button>
            </div>
          )}

          {isBuyer && transaction.status === "SHIPPING" && (
            <>
              <p className="text-sm leading-6 text-[var(--color-text-secondary)]">
                Người bán đã gửi hàng. Khi nhận được, hãy kiểm tra kỹ rồi xác nhận.
              </p>
              <Button
                className="h-12 w-full"
                loading={pendingAction === "receive"}
                onClick={() => runAction("receive", () => buyerReceive(transaction.id))}
              >
                Tôi đã nhận được hàng
              </Button>
            </>
          )}

          {isBuyer && transaction.status === "WAIT_CONFIRM" && (
            <>
              <p className="text-sm leading-6 text-[var(--color-text-secondary)]">
                Bước cuối: xác nhận để chuyển tiền cho người bán. Hãy chắc chắn món đồ đúng như mô tả trước khi xác nhận.
              </p>
              <Button className="h-12 w-full" onClick={() => setReleaseModalOpen(true)}>
                Xác nhận & chuyển tiền cho người bán
              </Button>
              <p className="text-center text-xs leading-5 text-[var(--color-text-muted)]">
                Bước này cần xác nhận lại danh tính và không thể hoàn tác.
              </p>
            </>
          )}

          {!isBuyer && !isSeller && (
            <p className="text-sm text-[var(--color-text-muted)]">Bạn không tham gia giao dịch này nên không có thao tác nào.</p>
          )}

          {(isBuyer || isSeller) && !hasAction && (
            <p className="text-sm text-[var(--color-text-muted)]">
              Hiện chưa có việc gì cần bạn làm — hãy chờ bước tiếp theo trong tiến trình ở trên.
            </p>
          )}
        </div>
      </Card>

      <PasskeyConfirmModal
        open={releaseModalOpen}
        title="Xác nhận chuyển tiền cho người bán"
        amount={transaction.amount}
        transactionLabel={`#${transaction.id.slice(0, 10)}…`}
        consequence="Sau khi xác nhận, tiền sẽ được chuyển sang ví người bán ngay lập tức và không thể hoàn tác."
        stage={releaseStage}
        onConfirm={handleConfirmRelease}
        onCancel={() => setReleaseModalOpen(false)}
      />
    </div>
  );
}
