import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '@/lib/AuthContext'
import { canAccessSensitiveManagerRoute } from '@/lib/role-access'

const SENSITIVE_MANAGER_PATHS = new Set(['/ops-control'])

function Loading() {
  return (
    <div className="fixed inset-0 flex items-center justify-center bg-background">
      <div className="w-8 h-8 border-4 border-slate-200 border-t-slate-800 rounded-full animate-spin" />
    </div>
  )
}

export default function ProtectedRoute() {
  const { isAuthenticated, isLoadingAuth, authChecked, user } = useAuth()
  const location = useLocation()
  if (isLoadingAuth || !authChecked) return <Loading />
  if (!isAuthenticated) return <Navigate to="/login" replace state={{ from: location.pathname }} />

  if (
    SENSITIVE_MANAGER_PATHS.has(location.pathname)
    && !canAccessSensitiveManagerRoute(user?.role, location.pathname)
  ) {
    return <Navigate to="/tasks" replace state={{ accessDenied: 'manager_required', from: location.pathname }} />
  }

  return <Outlet />
}
