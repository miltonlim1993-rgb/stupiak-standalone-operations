import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { opsClient } from '@/api/opsClient'
import { clearNativeSessionToken, saveNativeSessionToken } from '@/lib/native-session'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [isLoadingAuth, setIsLoadingAuth] = useState(true)
  const [authError, setAuthError] = useState(null)
  const [authChecked, setAuthChecked] = useState(false)

  const checkUserAuth = useCallback(async () => {
    setIsLoadingAuth(true)
    setAuthError(null)
    try {
      const currentUser = await opsClient.auth.me()
      setUser(currentUser)
      localStorage.setItem('chefops.data-pack.outlet', String(currentUser?.outlet_id || ''))
      return currentUser
    } catch (error) {
      setUser(null)
      if (error.status === 401) clearNativeSessionToken()
      if (error.status !== 401) {
        setAuthError({ type: error.code || 'auth_error', message: error.message })
      }
      return null
    } finally {
      setIsLoadingAuth(false)
      setAuthChecked(true)
    }
  }, [])

  useEffect(() => {
    checkUserAuth()
  }, [checkUserAuth])

  const loginWithGoogle = useCallback(async (credential) => {
    setAuthError(null)
    const result = await opsClient.auth.loginWithGoogle(credential)
    if (result?.session_token) saveNativeSessionToken(result.session_token)
    setUser(result.user)
    localStorage.setItem('chefops.data-pack.outlet', String(result.user?.outlet_id || ''))
    setAuthChecked(true)
    return result.user
  }, [])

  const updateProfile = useCallback(async (profile) => {
    const updated = await opsClient.auth.updateMe(profile)
    setUser(updated)
    localStorage.setItem('chefops.data-pack.outlet', String(updated?.outlet_id || ''))
    return updated
  }, [])

  const logout = useCallback(async () => {
    try {
      await opsClient.auth.logout()
    } finally {
      clearNativeSessionToken()
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
      window.location.assign('/login')
    }
  }, [])

  const navigateToLogin = useCallback(() => {
    if (window.location.pathname !== '/login') window.location.assign('/login')
  }, [])

  const value = useMemo(() => ({
    user,
    setUser,
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
  }), [user, isLoadingAuth, authError, authChecked, loginWithGoogle, logout, navigateToLogin, checkUserAuth, updateProfile])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth must be used within AuthProvider')
  return context
}
