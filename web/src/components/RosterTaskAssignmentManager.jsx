import { useAuth } from '@/lib/AuthContext'
import { configureRosterTaskAssignment } from '@/lib/roster-task-assignment'

export default function RosterTaskAssignmentManager() {
  const { user, isAuthenticated } = useAuth()
  configureRosterTaskAssignment(isAuthenticated ? user : null)
  return null
}
