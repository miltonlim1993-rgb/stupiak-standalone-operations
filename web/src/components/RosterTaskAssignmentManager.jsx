import { useEffect } from 'react'
import { useAuth } from '@/lib/AuthContext'
import { configureRosterTaskAssignment, warmRosterTaskAssignmentCache } from '@/lib/roster-task-assignment'

export default function RosterTaskAssignmentManager() {
  const { user, isAuthenticated } = useAuth()
  configureRosterTaskAssignment(isAuthenticated ? user : null)

  useEffect(() => {
    if (!isAuthenticated || !user) return
    // Warm today's assigned Task snapshot after login without delaying any page.
    warmRosterTaskAssignmentCache(user)
  }, [isAuthenticated, user?.email, user?.full_name, user?.outlet_id, user?.outlet_ids, user?.role])

  return null
}
