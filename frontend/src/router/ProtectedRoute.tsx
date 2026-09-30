import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { Spinner } from "../components/ui/Spinner";

/**
 * Frontend-side gate only — a UX convenience, never a security boundary.
 * The backend independently re-checks auth/role/ownership on every
 * request regardless of what this component decides to render (ke-hoach
 * §17: "Frontend ẩn action sai role/state nhưng backend vẫn phải kiểm
 * tra").
 */
export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) return <Spinner label="Đang kiểm tra đăng nhập…" />;
  if (!user) return <Navigate to="/login" replace />;
  if (user.accountStatus !== "ACTIVE") return <Navigate to="/login" replace />;

  return <>{children}</>;
}
