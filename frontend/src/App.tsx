import { Route, Routes } from "react-router-dom";
import { Layout } from "./components/layout/Layout";
import { ProtectedRoute } from "./router/ProtectedRoute";
import { AdminRoute } from "./router/AdminRoute";
import { MemberRoute } from "./router/MemberRoute";
import LoginPage from "./pages/auth/LoginPage";
import RegisterPage from "./pages/auth/RegisterPage";
import HomePage from "./pages/HomePage";
import DashboardPage from "./pages/DashboardPage";
import WalletPage from "./pages/WalletPage";
import ListingDetailPage from "./pages/ListingDetailPage";
import NewListingPage from "./pages/NewListingPage";
import MyListingsPage from "./pages/MyListingsPage";
import MyTransactionsPage from "./pages/MyTransactionsPage";
import TransactionDetailPage from "./pages/TransactionDetailPage";
import AdminDisputesPage from "./pages/AdminDisputesPage";
import AdminDisputeDetailPage from "./pages/AdminDisputeDetailPage";

export default function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />

        {/* Marketplace homepage — public, per BA.md/backend design: GET /api/listings
            has no auth. Any MEMBER browses here; buyer/seller-ness only exists
            per-transaction, never as a reason to gate the shop front itself. */}
        <Route path="/" element={<HomePage />} />
        <Route
          path="/me"
          element={
            <ProtectedRoute>
              <DashboardPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/me/wallet"
          element={
            <MemberRoute>
              <WalletPage />
            </MemberRoute>
          }
        />
        <Route
          path="/listings/new"
          element={
            <MemberRoute>
              <NewListingPage />
            </MemberRoute>
          }
        />
        {/* Listing detail is also public — GET /api/listings/:id has no auth
            (tested: seller info is deliberately id+displayName only, safe to
            expose). Buying requires login, handled inline on the page itself. */}
        <Route path="/listings/:id" element={<ListingDetailPage />} />
        <Route
          path="/me/listings"
          element={
            <MemberRoute>
              <MyListingsPage />
            </MemberRoute>
          }
        />
        <Route
          path="/me/transactions"
          element={
            <MemberRoute>
              <MyTransactionsPage />
            </MemberRoute>
          }
        />
        <Route
          path="/transactions/:id"
          element={
            <MemberRoute>
              <TransactionDetailPage />
            </MemberRoute>
          }
        />
        <Route
          path="/admin/disputes"
          element={
            <AdminRoute>
              <AdminDisputesPage />
            </AdminRoute>
          }
        />
        <Route
          path="/admin/disputes/:id"
          element={
            <AdminRoute>
              <AdminDisputeDetailPage />
            </AdminRoute>
          }
        />
      </Routes>
    </Layout>
  );
}
