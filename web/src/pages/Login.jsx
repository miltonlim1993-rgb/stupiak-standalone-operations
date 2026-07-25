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

export default function Login() {
  const buttonRef = useRef(null)
  const navigate = useNavigate()
  const location = useLocation()
  const { isAuthenticated, loginWithGoogle } = useAuth()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const clientId = import.meta.env.VITE_GOOGLE_LOGIN_CLIENT_ID

  useEffect(() => {
    let cancelled = false
    async function setup() {
      if (!clientId) {
        setError('Google Login Client ID is not configured in web/.env.local.')
        return
      }
      try {
        await loadGoogleIdentityScript()
        if (cancelled || !buttonRef.current) return
        window.google.accounts.id.initialize({
          client_id: clientId,
          callback: async ({ credential }) => {
            setLoading(true)
            setError('')
            try {
              await loginWithGoogle(credential)
              navigate(location.state?.from || '/', { replace: true })
            } catch (err) {
              setError(err.code === 'sheets_rate_limited'
                ? 'The operations sheet is temporarily busy. Please wait about one minute, then tap your Google account again.'
                : (err.message || 'Google sign-in failed'))
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
  }, [clientId, loginWithGoogle, location.state, navigate])

  if (isAuthenticated) return <Navigate to="/" replace />

  return (
    <AuthLayout
      title="Welcome to Stupiak’s Ops"
      subtitle="Sign in with your approved Google account"
      footer={<span className="inline-flex items-center gap-1"><ShieldCheck className="h-3.5 w-3.5" /> New accounts require manager approval.</span>}
    >
      {error && <div className="mb-4 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">{error}</div>}
      <div className="relative min-h-12 flex items-center justify-center">
        <div ref={buttonRef} className={loading ? 'opacity-40 pointer-events-none w-full flex justify-center' : 'w-full flex justify-center'} />
        {loading && <Loader2 className="absolute h-5 w-5 animate-spin" />}
      </div>
    </AuthLayout>
  )
}
