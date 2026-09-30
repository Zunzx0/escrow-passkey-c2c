import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { Spinner } from "../components/ui/Spinner";
import { useAuth } from "../context/AuthContext";

/** UX gate only; the server still checks ADMIN on every dispute endpoint. */
export function AdminRoute({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) return <Spinner label="Đang kiểm tra quyền quản trị…" />;
  if (!user || user.accountStatus !== "ACTIVE") return <Navigate to="/login" replace />;
  if (user.role !== "ADMIN") return <Navigate to="/me" replace />;

  return <>{children}</>;
}
