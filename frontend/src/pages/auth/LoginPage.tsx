import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { loginWithPassword } from "../../api/auth";
import { ApiError } from "../../api/client";
import { loginWithPasskey } from "../../hooks/usePasskey";
import { useAuth } from "../../context/AuthContext";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Alert } from "../../components/ui/Alert";
import { PasskeyIcon, ShieldIcon } from "../../components/ui/icons";

const inputClass =
  "mt-1.5 w-full rounded-[10px] border border-[var(--color-border)] bg-white px-3.5 py-2.5 text-sm text-[var(--color-text)] transition-colors placeholder:text-[var(--color-text-light)] focus:border-[var(--color-brand)] focus:outline-none focus:ring-2 focus:ring-[rgba(14,165,233,0.15)]";

const labelClass = "block text-sm font-medium text-[var(--color-text)]";

export default function LoginPage() {
  const navigate = useNavigate();
  const { setUser } = useAuth();
  const [searchParams] = useSearchParams();
  // Always a same-app relative path set by our own links (e.g. "Mua ngay"
  // while signed out) — never redirect to an attacker-supplied absolute URL.
  const raw = searchParams.get("returnTo");
  const returnTo = raw && raw.startsWith("/") && !raw.startsWith("//") ? raw : "/";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [passkeyLoading, setPasskeyLoading] = useState(false);

  async function handlePasswordLogin(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPasswordLoading(true);
    try {
      const user = await loginWithPassword(email, password);
      setUser(user);
      navigate(returnTo);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Đăng nhập thất bại.");
    } finally {
      setPasswordLoading(false);
    }
  }

  async function handlePasskeyLogin() {
    setError(null);
    if (!email) {
      setError("Nhập email trước khi đăng nhập bằng Passkey.");
      return;
    }
    setPasskeyLoading(true);
    try {
      const user = await loginWithPasskey(email);
      setUser(user);
      navigate(returnTo);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Đăng nhập Passkey thất bại.");
    } finally {
      setPasskeyLoading(false);
    }
  }

  return (
    <div className="mx-auto grid max-w-4xl items-center gap-10 py-8 lg:grid-cols-2">
      <div className="hidden lg:block">
        <span className="brand-gradient flex h-14 w-14 items-center justify-center rounded-[16px] text-white">
          <ShieldIcon className="h-7 w-7" />
        </span>
        <h2 className="mt-6 text-[28px] font-bold leading-[1.15] text-[var(--color-text)]">
          Mua bán dễ dàng,
          <br />
          giao dịch an tâm.
        </h2>
        <p className="mt-4 max-w-sm text-[15px] leading-6 text-[var(--color-text-secondary)]">
          Tiền của người mua được giữ lại an toàn cho đến khi nhận được hàng đúng như mô tả.
        </p>
      </div>

      <Card className="p-6 sm:p-8">
        <h1 className="text-xl font-bold text-[var(--color-text)]">Đăng nhập</h1>

        {error && (
          <div className="mt-4">
            <Alert tone="error">{error}</Alert>
          </div>
        )}

        <form className="mt-6 space-y-4" onSubmit={handlePasswordLogin}>
          <div>
            <label className={labelClass} htmlFor="email">
              Email
            </label>
            <input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className={inputClass} />
          </div>
          <div>
            <label className={labelClass} htmlFor="password">
              Mật khẩu
            </label>
            <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} className={inputClass} />
          </div>
          <Button type="submit" className="h-12 w-full" loading={passwordLoading}>
            Đăng nhập
          </Button>
        </form>

        <div className="my-5 flex items-center gap-3 text-xs uppercase tracking-wide text-[var(--color-text-muted)]">
          <div className="h-px flex-1 bg-[var(--color-border)]" />
          hoặc
          <div className="h-px flex-1 bg-[var(--color-border)]" />
        </div>

        <Button variant="secondary" className="h-12 w-full" onClick={handlePasskeyLogin} loading={passkeyLoading}>
          <PasskeyIcon className="h-[18px] w-[18px]" /> Đăng nhập bằng Passkey
        </Button>

        <p className="mt-6 text-center text-sm text-[var(--color-text-secondary)]">
          Chưa có tài khoản?{" "}
          <Link
            to={returnTo !== "/" ? `/register?returnTo=${encodeURIComponent(returnTo)}` : "/register"}
            className="font-semibold text-[var(--color-brand)] hover:text-[var(--color-brand-hover)]"
          >
            Đăng ký
          </Link>
        </p>
      </Card>
    </div>
  );
}
