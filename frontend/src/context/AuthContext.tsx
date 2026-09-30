import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { getMe, logout as apiLogout } from "../api/auth";
import { ApiError } from "../api/client";
import type { CurrentUser } from "../api/types";

interface AuthContextValue {
  user: CurrentUser | null;
  loading: boolean;
  refresh: () => Promise<void>;
  setUser: (user: CurrentUser | null) => void;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const me = await getMe();
      setUser(me);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setUser(null);
      } else {
        throw err;
      }
    }
  }, []);

  useEffect(() => {
    refresh().finally(() => setLoading(false));
  }, [refresh]);

  const logout = useCallback(async () => {
    await apiLogout();
    setUser(null);
  }, []);

  return <AuthContext.Provider value={{ user, loading, refresh, setUser, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
