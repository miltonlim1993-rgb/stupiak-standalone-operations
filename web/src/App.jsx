import { Toaster } from '@/components/ui/toaster'
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClientInstance } from '@/lib/query-client'
import { BrowserRouter as Router, Route, Routes, Navigate } from 'react-router-dom'
import PageNotFound from '@/lib/PageNotFound'
import { AuthProvider, useAuth } from '@/lib/AuthContext'
import ScrollToTop from '@/components/ScrollToTop'
import Login from '@/pages/Login'
import ProtectedRoute from '@/components/ProtectedRoute'
import Layout from '@/components/Layout'
import Dashboard from '@/pages/Dashboard'
import Tasks from '@/pages/Tasks'
import StockCount from '@/pages/StockCount'
import UrgentIssues from '@/pages/UrgentIssues'
import More from '@/pages/More'
import Inventory from '@/pages/Inventory'
import Attendance from '@/pages/Attendance'
import Receipts from '@/pages/Receipts'
import FoodLabels from '@/pages/FoodLabels'
import LabelSettings from '@/pages/LabelSettings'
import Reports from '@/pages/Reports'
import Settings from '@/pages/Settings'
import OpsControl from '@/pages/OpsControl'
import Training from '@/pages/Training'
import ProfileSetup from '@/pages/ProfileSetup'
import CloseUp from '@/pages/CloseUp'
import InstallApp from '@/pages/InstallApp'
import Notifications from '@/pages/Notifications'

function AppRoutes() {
  const { isLoadingAuth, isAuthenticated, user } = useAuth()
  if (isLoadingAuth) {
    return <div className="fixed inset-0 flex items-center justify-center"><div className="w-8 h-8 border-4 border-slate-200 border-t-slate-800 rounded-full animate-spin" /></div>
  }
  if (isAuthenticated && user?.requires_name_setup) return <ProfileSetup />
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Navigate to="/login" replace />} />
      <Route path="/forgot-password" element={<Navigate to="/login" replace />} />
      <Route path="/reset-password" element={<Navigate to="/login" replace />} />
      <Route element={<ProtectedRoute />}>
        <Route element={<Layout />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/tasks" element={<Tasks />} />
          <Route path="/stock" element={<StockCount />} />
          <Route path="/urgent" element={<UrgentIssues />} />
          <Route path="/close-up" element={<CloseUp />} />
          <Route path="/notifications" element={<Notifications />} />
          <Route path="/install" element={<InstallApp />} />
          <Route path="/more" element={<More />} />
          <Route path="/inventory" element={<Inventory />} />
          <Route path="/attendance" element={<Attendance />} />
          <Route path="/receipts" element={<Receipts />} />
          <Route path="/labels" element={<FoodLabels />} />
          <Route path="/labels/settings" element={<LabelSettings />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/ops-control" element={<OpsControl />} />
          <Route path="/training" element={<Training />} />
          <Route path="/sop/:sopId" element={<Training />} />
        </Route>
      </Route>
      <Route path="*" element={<PageNotFound />} />
    </Routes>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <QueryClientProvider client={queryClientInstance}>
        <Router>
          <ScrollToTop />
          <AppRoutes />
        </Router>
        <Toaster />
      </QueryClientProvider>
    </AuthProvider>
  )
}
