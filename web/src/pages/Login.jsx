import { useEffect, useRef, useState } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { Loader2, ShieldCheck } from 'lucide-react'
import AuthLayout from '@/components/AuthLayout'
import { useAuth } from '@/lib/AuthContext'

const SCRIPT_ID = 'google-identity-services'

function loadGoogleIdentityScript() {
  if (window.google?.accounts?.id) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const existing = document.getElementById(SCRIPT_ID)
    if (existing) {
      existing.addEventListener('load', resolve, { once: true })
      existing.addEventListener('error', reject, { once: true })
      return
    }
    const script = document.createElement('script')
    script.id = SCRIPT_ID
    script.src = 'https://accounts.google.com/gsi/client'
    script.async = true
    script.defer = true
    script.onload = resolve
    script.onerror = () => reject(new Error('Unable to load Google sign-in'))
    document.head.appendChild(script)
  })
}

function isNativeAndroid() {
  const capacitor = window.Capacitor
  return Boolean(capacitor?.isNativePlatform?.() && capacitor?.getPlatform?.() === 'android')
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function loginErrorMessage(error) {
  if (error?.code === 'sheets_rate_limited') {
    return 'The operations sheet is still busy after automatic retries. Please try again shortly.'
  }
  return error?.message || 'Google sign-in failed'
}

async function loginWithAutomaticRetry(loginWithGoogle, credential) {
  let lastError = null
  const delays = [0, 1200, 2500]
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    if (delays[attempt]) await sleep(delays[attempt])
    try {
      return await loginWithGoogle(credential)
    } catch (error) {
      lastError = error
      if (error?.code !== 'sheets_rate_limited') throw error
    }
  }
  throw lastError
}

export default function Login() {
  const buttonRef = useRef(null)
  const navigate = useNavigate()
  const location = useLocation()
  const { isAuthenticated, loginWithGoogle } = useAuth()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const clientId = import.meta.env.VITE_GOOGLE_LOGIN_CLIENT_ID
  const nativeAndroid = isNativeAndroid()

  useEffect(() => {
    let cancelled = false
    async function setup() {
      if (!clientId) {
        setError('Google Login Client ID is not configured.')
        return
      }
      if (nativeAndroid) return
      try {
        await loadGoogleIdentityScript()
        if (cancelled || !buttonRef.current) return
        window.google.accounts.id.initialize({
          client_id: clientId,
          callback: async ({ credential }) => {
            setLoading(true)
            setError('')
            try {
              await loginWithAutomaticRetry(loginWithGoogle, credential)
              navigate(location.state?.from || '/', { replace: true })
            } catch (err) {
              setError(loginErrorMessage(err))
            } finally {
              setLoading(false)
            }
          },
        })
        buttonRef.current.replaceChildren()
        window.google.accounts.id.renderButton(buttonRef.current, {
          type: 'standard',
          theme: 'outline',
          size: 'large',
          shape: 'rectangular',
          text: 'continue_with',
          width: Math.min(360, buttonRef.current.clientWidth || 360),
        })
      } catch (err) {
        setError(err.message || 'Unable to initialise Google sign-in')
      }
    }
    setup()
    return () => { cancelled = true }
  }, [clientId, loginWithGoogle, location.state, navigate, nativeAndroid])

  const nativeSignIn = async () => {
    setLoading(true)
    setError('')
    try {
      const plugin = window.Capacitor?.Plugins?.NativeGoogleAuth
      if (!plugin?.signIn) throw new Error('Native Google Sign-In is unavailable. Install the latest Android release.')
      const result = await plugin.signIn({ serverClientId: clientId })
      if (!result?.idToken) throw new Error('Google did not return an ID token')
      await loginWithAutomaticRetry(loginWithGoogle, result.idToken)
      navigate(location.state?.from || '/', { replace: true })
    } catch (err) {
      setError(loginErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  if (isAuthenticated) return <Navigate to="/" replace />

  return (
    <AuthLayout
      title="Welcome to Stupiak’s Ops"
      subtitle="Sign in with your approved Google account"
      footer={<span className="inline-flex items-center gap-1"><ShieldCheck className="h-3.5 w-3.5" /> New accounts require manager approval.</span>}
    >
      {error && <div className="mb-4 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">{error}</div>}
      <div className="relative min-h-12 flex items-center justify-center">
        {nativeAndroid ? (
          <button
            type="button"
            disabled={loading || !clientId}
            onClick={nativeSignIn}
            className="flex h-11 w-full max-w-[360px] items-center justify-center gap-3 rounded-md border border-[#747775] bg-white px-4 text-sm font-medium text-[#1f1f1f] shadow-sm transition hover:bg-[#f8fafd] disabled:pointer-events-none disabled:opacity-50"
          >
            <span className="flex h-5 w-5 items-center justify-center rounded-full text-base font-bold text-[#4285F4]">G</span>
            Continue with Google
          </button>
        ) : (
          <div ref={buttonRef} className={loading ? 'opacity-40 pointer-events-none w-full flex justify-center' : 'w-full flex justify-center'} />
        )}
        {loading && <Loader2 className="absolute right-3 h-5 w-5 animate-spin" />}
      </div>
    </AuthLayout>
  )
}