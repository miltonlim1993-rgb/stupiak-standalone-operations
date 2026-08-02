import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { opsClient } from '@/api/opsClient'
import { clearNativeSessionToken, saveNativeSessionToken } from '@/lib/native-session'
import { parseOutletIds } from '@/lib/outlets'

const AuthContext = createContext(null)
const CACHED_USER_KEY = 'chefops.auth.cached-user'
const AUTH_CHECK_TIMEOUT_MS = 12_000

function primaryOutlet(user) {
  return String(user?.outlet_id || parseOutletIds(user)[0] || '').trim()
}

function rememberOutlet(user) {
  const nextOutlet = primaryOutlet(user)
  if (nextOutlet) {
    localStorage.setItem('chefops.data-pack.outlet', nextOutlet)
    return nextOutlet
  }
  return String(localStorage.getItem('chefops.data-pack.outlet') || '').trim()
}

function readCachedUser() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CACHED_USER_KEY) || 'null')
    return parsed && parsed.status === 'active' && parsed.google_sub ? parsed : null
  } catch {
    return null
  }
}

function persistUser(user) {
  try {
    if (user) localStorage.setItem(CACHED_USER_KEY, JSON.stringify(user))
    else localStorage.removeItem(CACHED_USER_KEY)
  } catch {}
}

function withTimeout(promise, timeoutMs, message) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = window.setTimeout(() => {
      const error = new Error(message)
      error.code = 'auth_check_timeout'
      error.status = 503
      reject(error)
    }, timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => window.clearTimeout(timer))
}

export function AuthProvider({ children }) {
  const initialUser = useMemo(() => readCachedUser(), [])
  const [user, setUser] = useState(initialUser)
  const [isLoadingAuth, setIsLoadingAuth] = useState(!initialUser)
  const [authError, setAuthError] = useState(null)
  const [authChecked, setAuthChecked] = useState(Boolean(initialUser))

  const applyUser = useCallback((nextUser) => {
    setUser(nextUser)
    persistUser(nextUser)
    if (nextUser) rememberOutlet(nextUser)
  }, [])

  const checkUserAuth = useCallback(async () => {
    const fallbackUser = readCachedUser()
    if (!fallbackUser) setIsLoadingAuth(true)
    setAuthError(null)
    try {
      const currentUser = await withTimeout(
        opsClient.auth.me(),
        AUTH_CHECK_TIMEOUT_MS,
        'Session verification timed out',
      )
      applyUser(currentUser)
      return currentUser
    } catch (error) {
      const status = Number(error?.status || 0)
      if (status === 401 || status === 403) {
        applyUser(null)
        if (status === 401) clearNativeSessionToken()
        return null
      }

      if (fallbackUser) {
        applyUser(fallbackUser)
        setAuthError({
          type: error.code || 'auth_temporarily_unavailable',
          message: error.message || 'Session verification is temporarily unavailable',
        })
        return fallbackUser
      }

      setAuthError({ type: error.code || 'auth_error', message: error.message })
      return null
    } finally {
      setIsLoadingAuth(false)
      setAuthChecked(true)
    }
  }, [applyUser])

  useEffect(() => {
    checkUserAuth()
  }, [checkUserAuth])

  const loginWithGoogle = useCallback(async (credential) => {
    setAuthError(null)
    const result = await opsClient.auth.loginWithGoogle(credential)
    if (result?.session_token) saveNativeSessionToken(result.session_token)
    applyUser(result.user)
    setAuthChecked(true)
    setIsLoadingAuth(false)
    return result.user
  }, [applyUser])

  const updateProfile = useCallback(async (profile) => {
    const updated = await opsClient.auth.updateMe(profile)
    applyUser(updated)
    return updated
  }, [applyUser])

  const logout = useCallback(async () => {
    try {
      await opsClient.auth.logout()
    } finally {
      clearNativeSessionToken()
      persistUser(null)
      try {
        navigator.serviceWorker?.controller?.postMessage({ type: 'CLEAR_DATA_CACHE' })
        if ('caches' in window) {
          const keys = await caches.keys()
          await Promise.all(keys.filter((key) => key.includes('-data') || key.includes('issue-images')).map((key) => caches.delete(key)))
        }
        Object.keys(localStorage).filter((key) => key.startsWith('chefops.v4.issues.') || key.startsWith('chefops.notifications.seen.')).forEach((key) => localStorage.removeItem(key))
      } catch {}
      setUser(null)
      setAuthChecked(true)
      setIsLoadingAuth(false)
      window.location.assign('/login')
    }
  }, [])

  const navigateToLogin = useCallback(() => {
    if (window.location.pathname !== '/login') window.location.assign('/login')
  }, [])

  const value = useMemo(() => ({
    user,
    setUser: applyUser,
    isAuthenticated: Boolean(user),
    isLoadingAuth,
    isLoadingPublicSettings: false,
    authError,
    authChecked,
    loginWithGoogle,
    logout,
    navigateToLogin,
    checkUserAuth,
    checkAppState: checkUserAuth,
    updateProfile,
  }), [user, applyUser, isLoadingAuth, authError, authChecked, loginWithGoogle, logout, navigateToLogin, checkUserAuth, updateProfile])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth must be used within AuthProvider')
  return context
}
