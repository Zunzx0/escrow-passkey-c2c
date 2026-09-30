import type { ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { Header } from "./Header";
import { Sidebar } from "./Sidebar";
import { Footer } from "./Footer";
import { useAuth } from "../../context/AuthContext";

export function Layout({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { pathname } = useLocation();

  // §45: no sidebar on the marketplace, and the grid must use the full width
  // (§4) instead of the narrow dashboard container.
  const isMarketplace = pathname === "/" || pathname.startsWith("/listings/");

  if (isMarketplace) {
    return (
      <div className="flex min-h-screen flex-col">
        <Header />
        <main className="mx-auto w-full max-w-[1360px] flex-1 px-4 pb-16 sm:px-6 2xl:max-w-[1480px]">{children}</main>
        <Footer />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col">
      <Header />
      <div className="mx-auto flex w-full max-w-[1200px] flex-1 gap-8 px-4 py-8 sm:px-6">
        {user && <Sidebar />}
        <main className="min-w-0 flex-1">{children}</main>
      </div>
      <Footer />
    </div>
  );
}
