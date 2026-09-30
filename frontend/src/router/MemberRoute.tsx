import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { Spinner } from "../components/ui/Spinner";
import { useAuth } from "../context/AuthContext";

/** UX gate only; member endpoints remain protected by server-side role checks. */
export function MemberRoute({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <Spinner label="Đang kiểm tra đăng nhập…" />;
  if (!user || user.accountStatus !== "ACTIVE") return <Navigate to="/login" replace />;
  if (user.role !== "MEMBER") return <Navigate to="/me" replace />;
  return <>{children}</>;
}
