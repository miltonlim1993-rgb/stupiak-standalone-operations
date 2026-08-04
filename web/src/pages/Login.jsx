import { useEffect, useRef, useState } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import {
  ArrowLeft,
  CheckCircle2,
  Eye,
  EyeOff,
  Loader2,
  LockKeyhole,
  LogIn,
  Mail,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react'
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

function loginErrorMessage(error) {
  const messages = {
    local_email_invalid: 'Enter a valid email address.',
    local_login_invalid: 'Email, PIN or password is incorrect.',
    local_auth_locked: 'Too many attempts. Wait 15 minutes and try again.',
    local_pin_invalid: 'PIN must contain exactly 6 digits.',
    local_pin_too_common: 'Choose a PIN other than repeated digits, 123456 or 654321.',
    local_password_length: 'Password must contain at least 8 characters.',
    local_credential_exists: 'Your PIN or password is already configured. Return to sign in.',
    user_pending: 'Your account is still waiting for Owner approval.',
    user_inactive: 'This account is not active. Contact the Owner.',
    local_credential_missing: 'This account does not have a local PIN or password yet.',
    pending_approval_session_missing: 'This waiting session has expired. Enter your email again.',
    pending_approval_session_invalid: 'This waiting session has expired. Enter your email again.',
    local_auth_migration_required: 'Local login is not active on the server yet.',
    local_auth_not_configured: 'Local login is not configured on the server yet.',
    google_login_disabled: 'Google sign-in has been retired. Use your OPS email.',
    sheets_rate_limited: 'The operations sheet is busy. Please try again shortly.',
  }
  return messages[error?.code] || error?.message || 'Unable to continue'
}

function SecretInput({ value, onChange, kind = 'password', autoComplete = 'current-password', placeholder = '' }) {
  const [visible, setVisible] = useState(false)
  const pin = kind === 'pin'
  return (
    <div className="relative">
      <input
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={(event) => onChange(pin ? event.target.value.replace(/\D/g, '').slice(0, 6) : event.target.value)}
        placeholder={placeholder || (pin ? '6-digit PIN' : 'Password')}
        autoComplete={autoComplete}
        inputMode={pin ? 'numeric' : 'text'}
        className="h-11 w-full rounded-xl border border-input bg-background px-3 pr-11 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
        required
      />
      <button
        type="button"
        aria-label={visible ? 'Hide credential' : 'Show credential'}
        onClick={() => setVisible((current) => !current)}
        className="absolute right-1.5 top-1.5 flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted"
      >
        {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  )
}

function GoogleFallback({ clientId, loading, onLoading, onError, onSuccess }) {
  const buttonRef = useRef(null)
  const nativeAndroid = isNativeAndroid()

  useEffect(() => {
    if (!clientId || nativeAndroid) return undefined
    let cancelled = false
    loadGoogleIdentityScript()
      .then(() => {
        if (cancelled || !buttonRef.current) return
        window.google.accounts.id.initialize({
          client_id: clientId,
          callback: async ({ credential }) => {
            onLoading(true)
            onError('')
            try {
              await onSuccess(credential)
            } catch (error) {
              onError(loginErrorMessage(error))
            } finally {
              onLoading(false)
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
      })
      .catch((error) => onError(error.message || 'Unable to initialise Google sign-in'))
    return () => { cancelled = true }
  }, [clientId, nativeAndroid, onError, onLoading, onSuccess])

  const nativeSignIn = async () => {
    onLoading(true)
    onError('')
    try {
      const plugin = window.Capacitor?.Plugins?.NativeGoogleAuth
      if (!plugin?.signIn) throw new Error('Native Google Sign-In is unavailable. Install the latest Android release.')
      const result = await plugin.signIn({ serverClientId: clientId })
      if (!result?.idToken) throw new Error('Google did not return an ID token')
      await onSuccess(result.idToken)
    } catch (error) {
      onError(loginErrorMessage(error))
    } finally {
      onLoading(false)
    }
  }

  return nativeAndroid ? (
    <button
      type="button"
      disabled={loading || !clientId}
      onClick={nativeSignIn}
      className="flex h-11 w-full items-center justify-center gap-3 rounded-xl border border-[#747775] bg-white px-4 text-sm font-medium text-[#1f1f1f] shadow-sm transition hover:bg-[#f8fafd] disabled:pointer-events-none disabled:opacity-50"
    >
      <span className="flex h-5 w-5 items-center justify-center rounded-full text-base font-bold text-[#4285F4]">G</span>
      Continue with Google
    </button>
  ) : (
    <div ref={buttonRef} className={loading ? 'pointer-events-none flex w-full justify-center opacity-40' : 'flex w-full justify-center'} />
  )
}

export default function Login() {
  const navigate = useNavigate()
  const location = useLocation()
  const {
    isAuthenticated,
    startEmailAccess,
    checkPendingEmailAccess,
    setupPendingEmailAccess,
    loginEmailAccess,
    clearPendingEmailAccess,
    loginWithGoogle,
    getAuthConfig,
  } = useAuth()
  const [stage, setStage] = useState('email')
  const [email, setEmail] = useState('')
  const [secret, setSecret] = useState('')
  const [confirmSecret, setConfirmSecret] = useState('')
  const [credentialKind, setCredentialKind] = useState('password')
  const [config, setConfig] = useState(null)
  const [configLoading, setConfigLoading] = useState(true)
  const [loading, setLoading] = useState(false)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [showGoogle, setShowGoogle] = useState(false)
  const clientId = import.meta.env.VITE_GOOGLE_LOGIN_CLIENT_ID
  const destination = location.state?.from || '/'

  useEffect(() => {
    let active = true
    getAuthConfig()
      .then((result) => {
        if (!active) return
        setConfig(result)
        setShowGoogle(Boolean(result?.google_enabled && !result?.local_enabled))
      })
      .catch(() => {
        if (!active) return
        setConfig({ local_enabled: false, registration_enabled: false, google_enabled: true })
        setShowGoogle(true)
      })
      .finally(() => { if (active) setConfigLoading(false) })
    return () => { active = false }
  }, [getAuthConfig])

  const checkApproval = async ({ quiet = false } = {}) => {
    if (!quiet) setChecking(true)
    try {
      const result = await checkPendingEmailAccess()
      if (result?.status === 'active') {
        navigate(destination, { replace: true })
        return
      }
      if (result?.status === 'credential_setup_required') {
        setCredentialKind(result.credential_kind || 'password')
        setSecret('')
        setConfirmSecret('')
        setNotice(result.message || 'Approved. Create your PIN or password to enter OPS.')
        setStage('setup')
        return
      }
      if (result?.status === 'rejected' || result?.status === 'suspended') {
        setStage('email')
        setError(result.message || 'This request was not approved.')
        clearPendingEmailAccess()
      }
    } catch (approvalError) {
      if (!quiet || Number(approvalError?.status || 0) === 401) {
        setError(loginErrorMessage(approvalError))
      }
      if (Number(approvalError?.status || 0) === 401) {
        setStage('email')
        clearPendingEmailAccess()
      }
    } finally {
      if (!quiet) setChecking(false)
    }
  }

  useEffect(() => {
    if (stage !== 'pending') return undefined
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') checkApproval({ quiet: true })
    }, 3000)
    return () => window.clearInterval(timer)
  }, [stage])

  const submitEmail = async (event) => {
    event.preventDefault()
    setLoading(true)
    setError('')
    setNotice('')
    try {
      const result = await startEmailAccess({ email })
      if (result?.status === 'pending') {
        setStage('pending')
        setNotice(result.message || 'Waiting for Owner approval.')
      } else if (result?.status === 'credential_required') {
        setCredentialKind(result.credential_kind || 'password')
        setSecret('')
        setStage('credential')
        setNotice(result.message || 'Enter your PIN or password.')
      } else if (result?.status === 'credential_setup_required') {
        setError(result.message)
        setShowGoogle(Boolean(config?.google_enabled))
      } else {
        setError(result?.message || 'This account is not available.')
      }
    } catch (startError) {
      setError(loginErrorMessage(startError))
    } finally {
      setLoading(false)
    }
  }

  const submitCredential = async (event) => {
    event.preventDefault()
    setLoading(true)
    setError('')
    try {
      await loginEmailAccess({ email, secret })
      navigate(destination, { replace: true })
    } catch (loginError) {
      setError(loginErrorMessage(loginError))
    } finally {
      setLoading(false)
    }
  }

  const submitSetup = async (event) => {
    event.preventDefault()
    setError('')
    if (secret !== confirmSecret) {
      setError(credentialKind === 'pin' ? 'PIN entries do not match.' : 'Password entries do not match.')
      return
    }
    setLoading(true)
    try {
      await setupPendingEmailAccess({ secret })
      navigate(destination, { replace: true })
    } catch (setupError) {
      setError(loginErrorMessage(setupError))
    } finally {
      setLoading(false)
    }
  }

  const resetEmail = () => {
    clearPendingEmailAccess()
    setStage('email')
    setSecret('')
    setConfirmSecret('')
    setError('')
    setNotice('')
  }

  const googleSuccess = async (credential) => {
    await loginWithGoogle(credential)
    navigate(destination, { replace: true })
  }

  if (isAuthenticated) return <Navigate to="/" replace />

  const title = stage === 'pending'
    ? 'Waiting for Owner approval'
    : stage === 'setup'
      ? (credentialKind === 'pin' ? 'Create your PIN' : 'Create your password')
      : stage === 'credential'
        ? 'Welcome back'
        : 'Enter Stupiak’s Ops'
  const subtitle = stage === 'pending'
    ? 'After approval, set your login here and enter OPS'
    : stage === 'setup'
      ? 'One quick setup. You will enter OPS immediately after saving.'
      : 'Use your work email. New accounts are sent to the Owner automatically.'

  return (
    <AuthLayout
      title={title}
      subtitle={subtitle}
      footer={(
        <span className="inline-flex items-center gap-1">
          <ShieldCheck className="h-3.5 w-3.5" />
          Role and outlet access are controlled by the Owner.
        </span>
      )}
    >
      {configLoading ? (
        <div className="flex min-h-44 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : (
        <>
          {error ? <div className="mb-4 rounded-xl bg-destructive/10 p-3 text-sm text-destructive">{error}</div> : null}
          {notice && !['pending'].includes(stage) ? (
            <div className="mb-4 flex items-start gap-2 rounded-xl bg-emerald-50 p-3 text-sm text-emerald-800">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{notice}</span>
            </div>
          ) : null}

          {stage === 'email' ? (
            <form onSubmit={submitEmail} className="space-y-4">
              <div className="rounded-2xl bg-muted/50 p-3.5">
                <div className="flex gap-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><Mail className="h-5 w-5" /></span>
                  <div>
                    <p className="text-sm font-semibold">One simple login</p>
                    <p className="mt-0.5 text-xs leading-5 text-muted-foreground">New email: Owner approval, then create your login on the same page. Returning user: enter your PIN or password.</p>
                  </div>
                </div>
              </div>
              <label className="block space-y-1.5">
                <span className="text-sm font-medium text-foreground">Email</span>
                <input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="name@example.com"
                  autoComplete="email"
                  className="h-11 w-full rounded-xl border border-input bg-background px-3 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
                  required
                />
              </label>
              <button
                type="submit"
                disabled={loading || !config?.local_enabled}
                className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground transition hover:opacity-90 disabled:pointer-events-none disabled:opacity-50"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
                Continue
              </button>
            </form>
          ) : null}

          {stage === 'credential' ? (
            <form onSubmit={submitCredential} className="space-y-4">
              <button type="button" onClick={resetEmail} className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">
                <ArrowLeft className="h-3.5 w-3.5" /> Change email
              </button>
              <div className="rounded-xl border border-border bg-muted/30 px-3 py-2.5">
                <p className="text-xs text-muted-foreground">Signing in as</p>
                <p className="truncate text-sm font-semibold">{email}</p>
              </div>
              <label className="block space-y-1.5">
                <span className="text-sm font-medium text-foreground">{credentialKind === 'pin' ? 'PIN' : 'Password'}</span>
                <SecretInput value={secret} onChange={setSecret} kind={credentialKind} />
                <span className="block text-xs leading-5 text-muted-foreground">{credentialKind === 'pin' ? 'Enter your 6-digit PIN.' : 'Enter your password.'}</span>
              </label>
              <button
                type="submit"
                disabled={loading || !secret}
                className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground transition hover:opacity-90 disabled:pointer-events-none disabled:opacity-50"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <LockKeyhole className="h-4 w-4" />}
                Sign in
              </button>
            </form>
          ) : null}

          {stage === 'setup' ? (
            <form onSubmit={submitSetup} className="space-y-4">
              <div className="rounded-xl border border-border bg-muted/30 px-3 py-2.5">
                <p className="text-xs text-muted-foreground">Approved account</p>
                <p className="truncate text-sm font-semibold">{email}</p>
              </div>
              <label className="block space-y-1.5">
                <span className="text-sm font-medium text-foreground">{credentialKind === 'pin' ? 'Create a 6-digit PIN' : 'Create a password'}</span>
                <SecretInput value={secret} onChange={setSecret} kind={credentialKind} autoComplete="new-password" placeholder={credentialKind === 'pin' ? '6 digits' : 'At least 8 characters'} />
              </label>
              <label className="block space-y-1.5">
                <span className="text-sm font-medium text-foreground">Confirm</span>
                <SecretInput value={confirmSecret} onChange={setConfirmSecret} kind={credentialKind} autoComplete="new-password" placeholder={credentialKind === 'pin' ? 'Enter the PIN again' : 'Enter the password again'} />
              </label>
              <div className="rounded-xl bg-muted/50 px-3 py-2 text-xs leading-5 text-muted-foreground">
                {credentialKind === 'pin'
                  ? 'Use any 6 digits except obvious choices such as 000000, repeated digits, 123456 or 654321.'
                  : 'Use at least 8 characters. No symbol, uppercase or number combination is required.'}
              </div>
              <button
                type="submit"
                disabled={loading || !secret || !confirmSecret}
                className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground transition hover:opacity-90 disabled:pointer-events-none disabled:opacity-50"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <LockKeyhole className="h-4 w-4" />}
                Save and enter OPS
              </button>
            </form>
          ) : null}

          {stage === 'pending' ? (
            <div className="space-y-4 text-center">
              <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-amber-50 text-amber-600">
                <Loader2 className="h-8 w-8 animate-spin" />
              </div>
              <div>
                <p className="text-sm font-semibold">Request sent to Ops Control</p>
                <p className="mt-1 break-all text-xs text-muted-foreground">{email}</p>
                <p className="mt-3 text-sm leading-6 text-muted-foreground">The Owner assigns your outlet and role. After approval, this page will ask you to create your PIN or password, then enter OPS immediately.</p>
              </div>
              <button
                type="button"
                disabled={checking}
                onClick={() => checkApproval()}
                className="flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-border bg-background px-4 text-sm font-semibold hover:bg-muted disabled:opacity-50"
              >
                {checking ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                Check approval now
              </button>
              <button type="button" onClick={resetEmail} className="text-xs font-medium text-muted-foreground hover:text-foreground">Use another email</button>
            </div>
          ) : null}

          {config?.google_enabled && ['email', 'credential'].includes(stage) ? (
            <div className="mt-5 border-t border-border pt-4">
              {!showGoogle ? (
                <button type="button" onClick={() => setShowGoogle(true)} className="w-full text-center text-xs text-muted-foreground hover:text-foreground">
                  Use temporary Google migration fallback
                </button>
              ) : (
                <div className="space-y-3">
                  <p className="text-center text-xs leading-5 text-muted-foreground">Temporary fallback for existing accounts that have not configured a local PIN or password.</p>
                  <GoogleFallback clientId={clientId} loading={loading} onLoading={setLoading} onError={setError} onSuccess={googleSuccess} />
                </div>
              )}
            </div>
          ) : null}
        </>
      )}
    </AuthLayout>
  )
}
