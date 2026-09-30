import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { registerWithPassword } from "../../api/auth";
import { ApiError } from "../../api/client";
import { registerPasskey } from "../../hooks/usePasskey";
import { useAuth } from "../../context/AuthContext";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Alert } from "../../components/ui/Alert";
import { CheckIcon, PasskeyIcon } from "../../components/ui/icons";

type Step = "account" | "passkey";

const inputClass =
  "mt-1.5 w-full rounded-[10px] border border-[var(--color-border)] bg-white px-3.5 py-2.5 text-sm text-[var(--color-text)] transition-colors placeholder:text-[var(--color-text-light)] focus:border-[var(--color-brand)] focus:outline-none focus:ring-2 focus:ring-[rgba(14,165,233,0.15)]";

const labelClass = "block text-sm font-medium text-[var(--color-text)]";

function StepIndicator({ step }: { step: Step }) {
  const items: { key: Step; label: string }[] = [
    { key: "account", label: "Tạo tài khoản" },
    { key: "passkey", label: "Đăng ký Passkey" },
  ];
  return (
    <div className="mb-6 flex items-center gap-2">
      {items.map((item, i) => {
        const isDone = step === "passkey" && item.key === "account";
        const isCurrent = step === item.key;
        return (
          <div key={item.key} className="flex flex-1 items-center gap-2">
            <div
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                isDone
                  ? "bg-[var(--color-brand)] text-white"
                  : isCurrent
                    ? "border-2 border-[var(--color-brand)] text-[var(--color-brand)]"
                    : "border-2 border-[var(--color-border)] text-[var(--color-text-light)]"
              }`}
            >
              {isDone ? <CheckIcon className="h-3 w-3" strokeWidth={2.5} /> : i + 1}
            </div>
            <span className={`text-xs font-medium ${isCurrent || isDone ? "text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}`}>
              {item.label}
            </span>
            {i < items.length - 1 && <div className="h-px flex-1 bg-[var(--color-border)]" />}
          </div>
        );
      })}
    </div>
  );
}

export default function RegisterPage() {
  const navigate = useNavigate();
  const { setUser } = useAuth();
  const [searchParams] = useSearchParams();
  const raw = searchParams.get("returnTo");
  const returnTo = raw && raw.startsWith("/") && !raw.startsWith("//") ? raw : "/";

  const [step, setStep] = useState<Step>("account");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleCreateAccount(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await registerWithPassword(email, password, displayName || undefined);
      setStep("passkey");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Không thể tạo tài khoản.");
    } finally {
      setLoading(false);
    }
  }

  async function handleRegisterPasskey() {
    setError(null);
    setLoading(true);
    try {
      const user = await registerPasskey(email);
      setUser(user);
      navigate(returnTo);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Đăng ký Passkey thất bại.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-md py-8">
      <Card className="p-6 sm:p-8">
        <h1 className="text-xl font-bold text-[var(--color-text)]">Tạo tài khoản</h1>
        <p className="mt-1.5 text-sm leading-6 text-[var(--color-text-secondary)]">
          Một tài khoản dùng chung để vừa mua vừa bán — vai trò người mua/người bán được xác định theo từng giao dịch.
        </p>

        <div className="mt-6">
          <StepIndicator step={step} />
        </div>

        {error && (
          <div className="mb-4">
            <Alert tone="error">{error}</Alert>
          </div>
        )}

        {step === "account" && (
          <form className="space-y-4" onSubmit={handleCreateAccount}>
            <div>
              <label className={labelClass} htmlFor="email">
                Email
              </label>
              <input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className={inputClass} />
            </div>
            <div>
              <label className={labelClass} htmlFor="displayName">
                Tên hiển thị (tuỳ chọn)
              </label>
              <input id="displayName" type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} className={inputClass} />
            </div>
            <div>
              <label className={labelClass} htmlFor="password">
                Mật khẩu
              </label>
              <input
                id="password"
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={inputClass}
              />
              <p className="mt-1.5 text-xs leading-5 text-[var(--color-text-muted)]">
                Tối thiểu 8 ký tự. Các thao tác nhạy cảm như giải ngân hoặc phân xử cần xác nhận lại bằng Passkey.
              </p>
            </div>
            <Button type="submit" className="h-12 w-full" loading={loading}>
              Tiếp tục
            </Button>
          </form>
        )}

        {step === "passkey" && (
          <div className="space-y-4">
            <Alert tone="info">
              Tài khoản đã được tạo. Bước cuối: đăng ký Passkey (vân tay/khuôn mặt/khóa bảo mật) để kích hoạt tài khoản. Sau đó hệ thống sẽ
              yêu cầu Passkey khi đăng nhập và khi xác nhận các thao tác nhạy cảm.
            </Alert>
            <Button className="h-12 w-full" onClick={handleRegisterPasskey} loading={loading}>
              <PasskeyIcon className="h-[18px] w-[18px]" /> Đăng ký Passkey ngay
            </Button>
          </div>
        )}

        <p className="mt-6 text-center text-sm text-[var(--color-text-secondary)]">
          Đã có tài khoản?{" "}
          <Link
            to={returnTo !== "/" ? `/login?returnTo=${encodeURIComponent(returnTo)}` : "/login"}
            className="font-semibold text-[var(--color-brand)] hover:text-[var(--color-brand-hover)]"
          >
            Đăng nhập
          </Link>
        </p>
      </Card>
    </div>
  );
}
