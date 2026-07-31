import { lazy, Suspense } from 'react'
import { Toaster } from '@/components/ui/toaster'
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClientInstance } from '@/lib/query-client'
import { BrowserRouter as Router, Route, Routes, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from '@/lib/AuthContext'
import ScrollToTop from '@/components/ScrollToTop'
import MobileNavigation from '@/components/MobileNavigation'
import ProtectedRoute from '@/components/ProtectedRoute'
import Layout from '@/components/Layout'
import RosterTaskAssignmentManager from '@/components/RosterTaskAssignmentManager'
import RosterGatedTaskAlarmManager from '@/components/RosterGatedTaskAlarmManager'
import TaskBadgeManager from '@/components/TaskBadgeManager'

const PageNotFound = lazy(() => import('@/lib/PageNotFound'))
const Login = lazy(() => import('@/pages/Login'))
const Dashboard = lazy(() => import('@/pages/Dashboard'))
const Tasks = lazy(() => import('@/pages/OperationalTasksV2'))
const StockCount = lazy(() => import('@/pages/StockCount'))
const UrgentIssues = lazy(() => import('@/pages/UrgentIssues'))
const More = lazy(() => import('@/pages/More'))
const Inventory = lazy(() => import('@/pages/Inventory'))
const Attendance = lazy(() => import('@/pages/Attendance'))
const Receipts = lazy(() => import('@/pages/Receipts'))
const FoodLabels = lazy(() => import('@/pages/FoodLabels'))
const LabelSettings = lazy(() => import('@/pages/LabelPrinterSettings'))
const Reports = lazy(() => import('@/pages/Reports'))
const Settings = lazy(() => import('@/pages/Settings'))
const OpsControl = lazy(() => import('@/pages/OpsControl'))
const Training = lazy(() => import('@/pages/Training'))
const GuidedSop = lazy(() => import('@/pages/GuidedSopLearning'))
const ProfileSetup = lazy(() => import('@/pages/ProfileSetup'))
const CloseUp = lazy(() => import('@/pages/CloseUp'))
const InstallApp = lazy(() => import('@/pages/InstallApp'))
const DataPackage = lazy(() => import('@/pages/DataPackage'))
const Notifications = lazy(() => import('@/pages/Notifications'))

function RouteFallback() {
  return <div className="flex min-h-[40dvh] items-center justify-center"><div className="h-8 w-8 animate-spin rounded-full border-4 border-slate-200 border-t-slate-800" /></div>
}

function AppRoutes() {
  const { isLoadingAuth, isAuthenticated, user } = useAuth()
  if (isLoadingAuth) {
    return <div className="fixed inset-0 flex items-center justify-center"><div className="h-8 w-8 animate-spin rounded-full border-4 border-slate-200 border-t-slate-800" /></div>
  }

  return (
    <Suspense fallback={<RouteFallback />}>
      {isAuthenticated && user?.requires_name_setup ? <ProfileSetup /> : (
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
              <Route path="/data-package" element={<DataPackage />} />
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
              <Route path="/sop/:sopId" element={<GuidedSop />} />
            </Route>
          </Route>
          <Route path="*" element={<PageNotFound />} />
        </Routes>
      )}
    </Suspense>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <RosterTaskAssignmentManager />
      <QueryClientProvider client={queryClientInstance}>
        <Router>
          <MobileNavigation />
          <ScrollToTop />
          <AppRoutes />
          <RosterGatedTaskAlarmManager />
          <TaskBadgeManager />
        </Router>
        <Toaster />
      </QueryClientProvider>
    </AuthProvider>
  )
}
