import { ROLE_LEVEL } from '@/lib/ops-helpers'

export const DAILY_OPERATION_PATHS = Object.freeze([
  '/tasks',
  '/training',
])

export const SENSITIVE_MANAGER_PATHS = new Set(['/ops-control'])

export function normalizedRole(role) {
  return String(role || '').trim().toLowerCase().replace(/^role_/, '')
}

export function roleLevel(role) {
  return ROLE_LEVEL[normalizedRole(role)] || 0
}

export function canAccessDailyOperations(role) {
  return roleLevel(role) >= ROLE_LEVEL.staff
}

export function canAccessSensitiveManagerRoute(role, pathname) {
  if (!SENSITIVE_MANAGER_PATHS.has(String(pathname || ''))) return true
  return roleLevel(role) >= ROLE_LEVEL.manager
}
