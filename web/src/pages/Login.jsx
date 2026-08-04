import { useEffect, useMemo, useRef, useState } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import {
  CheckCircle2,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  LogIn,
  ShieldCheck,
  UserPlus,
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
    local_login_invalid: 'Login ID, PIN or password is incorrect.',
    local_auth_locked: 'Too many attempts. Wait 15 minutes and try again.',
    user_pending: 'Your account is still waiting for Owner approval.',
    user_inactive: 'This account is not active. Contact the Owner.',
    local_activation_invalid: 'Activation code is invalid or expired.',
    local_auth_migration_required: 'Local login is not active on the server yet.',
    local_auth_not_configured: 'Local login is not configured on the server yet.',
    local_pin_too_common: 'Choose a less predictable six-digit PIN.',
    local_pin_sequential: 'Sequential PINs are not allowed.',
    local_pin_matches_login: 'PIN cannot match the end of your phone number.',
    local_password_length: 'Management passwords must contain at least 12 characters.',
    local_password_complexity: 'Management passwords need letters, numbers and a symbol.',
    google_login_disabled: 'Google sign-in has been retired. Use your local OPS account.',
    sheets_rate_limited: 'The operations sheet is busy. Please try again shortly.',
  }
  return messages[error?.code] || error?.message || 'Unable to continue'
}

function Field({ label, children, hint }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium text-foreground">{label}</span>
      {children}
      {hint ? <span className="block text-xs leading-5 text-muted-foreground">{hint}</span> : null}
    </label>
  )
}

function SecretInput({ value, onChange, placeholder = 'PIN or password', autoComplete = 'current-password' }) {
  const [visible, setVisible] = useState(false)
  return (
    <div className="relative">
      <input
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
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

  return (
    <div className="space-y-2 rounded-2xl border border-dashed border-border bg-muted/30 p-3.5">
      <p className="text-xs leading-5 text-muted-foreground">
        Temporary migration fallback for accounts that have not activated a local OPS login yet.
      </p>
      {nativeAndroid ? (
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
      )}
    </div>
  )
}

export default function Login() {
  const navigate = useNavigate()
  const location = useLocation()
  const {
    isAuthenticated,
    loginLocal,
    loginWithGoogle,
    registerLocal,
    activateLocal,
    getAuthConfig,
  } = useAuth()
  const [mode, setMode] = useState('login')
  const [config, setConfig] = useState(null)
  const [configLoading, setConfigLoading] = useState(true)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [showGoogle, setShowGoogle] = useState(false)
  const [login, setLogin] = useState({ loginId: '', secret: '' })
  const [registration, setRegistration] = useState({ fullName: '', phone: '', email: '', department: '' })
  const [activation, setActivation] = useState({ loginId: '', activationCode: '', secret: '' })
  const clientId = import.meta.env.VITE_GOOGLE_LOGIN_CLIENT_ID

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

  const destination = location.state?.from || '/'
  const localReady = Boolean(config?.local_enabled)
  const googleReady = Boolean(config?.google_enabled && clientId)

  const modeMeta = useMemo(() => ({
    login: {
      title: 'Welcome to Stupiak’s Ops',
      subtitle: 'Sign in with your Owner-approved local account',
      icon: LogIn,
    },
    register: {
      title: 'Request OPS access',
      subtitle: 'The Owner must approve every new account',
      icon: UserPlus,
    },
    activate: {
      title: 'Activate local login',
      subtitle: 'Use the one-time code issued by the Owner',
      icon: KeyRound,
    },
  }), [])
  const CurrentIcon = modeMeta[mode].icon

  const resetMessages = () => {
    setError('')
    setNotice('')
  }

  const submitLogin = async (event) => {
    event.preventDefault()
    setLoading(true)
    resetMessages()
    try {
      await loginLocal(login)
      navigate(destination, { replace: true })
    } catch (loginError) {
      setError(loginErrorMessage(loginError))
    } finally {
      setLoading(false)
    }
  }

  const submitRegistration = async (event) => {
    event.preventDefault()
    setLoading(true)
    resetMessages()
    try {
      const result = await registerLocal(registration)
      setNotice(result?.message || 'Request received. Wait for Owner approval.')
      setActivation((current) => ({ ...current, loginId: registration.phone }))
    } catch (registrationError) {
      setError(loginErrorMessage(registrationError))
    } finally {
      setLoading(false)
    }
  }

  const submitActivation = async (event) => {
    event.preventDefault()
    setLoading(true)
    resetMessages()
    try {
      const result = await activateLocal(activation)
      setLogin({ loginId: activation.loginId, secret: '' })
      setNotice(result?.message || 'Local login activated. Sign in now.')
      setMode('login')
    } catch (activationError) {
      setError(loginErrorMessage(activationError))
    } finally {
      setLoading(false)
    }
  }

  const googleSuccess = async (credential) => {
    await loginWithGoogle(credential)
    navigate(destination, { replace: true })
  }

  if (isAuthenticated) return <Navigate to="/" replace />

  return (
    <AuthLayout
      title={modeMeta[mode].title}
      subtitle={modeMeta[mode].subtitle}
      footer={(
        <span className="inline-flex items-center gap-1">
          <ShieldCheck className="h-3.5 w-3.5" />
          Access, role and outlet are controlled by the Owner.
        </span>
      )}
    >
      <div className="mb-4 flex items-center gap-3 rounded-2xl bg-muted/50 p-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <CurrentIcon className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold">No personal Google account required</p>
          <p className="text-xs leading-5 text-muted-foreground">Approved staff use a six-digit PIN. Management uses a strong password.</p>
        </div>
      </div>

      <div className="mb-4 grid grid-cols-3 rounded-xl bg-muted p-1">
        {[
          ['login', 'Sign in'],
          ['register', 'Request'],
          ['activate', 'Activate'],
        ].map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => { setMode(value); resetMessages() }}
            className={`h-9 rounded-lg text-xs font-semibold transition ${mode === value ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
          >
            {label}
          </button>
        ))}
      </div>

      {configLoading ? (
        <div className="flex min-h-36 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : (
        <>
          {error ? <div className="mb-4 rounded-xl bg-destructive/10 p-3 text-sm text-destructive">{error}</div> : null}
          {notice ? (
            <div className="mb-4 flex items-start gap-2 rounded-xl bg-emerald-50 p-3 text-sm text-emerald-800">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{notice}</span>
            </div>
          ) : null}

          {mode === 'login' ? (
            <form onSubmit={submitLogin} className="space-y-4">
              <Field label="Phone number or login ID">
                <input
                  value={login.loginId}
                  onChange={(event) => setLogin({ ...login, loginId: event.target.value })}
                  placeholder="e.g. 0123456789 or staff ID"
                  autoComplete="username"
                  inputMode="text"
                  className="h-11 w-full rounded-xl border border-input bg-background px-3 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
                  required
                />
              </Field>
              <Field label="PIN or password" hint="Staff: 6-digit PIN. Manager / Owner: strong password.">
                <SecretInput value={login.secret} onChange={(secret) => setLogin({ ...login, secret })} />
              </Field>
              <button
                type="submit"
                disabled={loading || !localReady}
                className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground transition hover:opacity-90 disabled:pointer-events-none disabled:opacity-50"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
                Sign in
              </button>
              {!localReady ? (
                <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
                  Local login is prepared but not activated on production yet. Existing approved accounts may use the temporary Google fallback below.
                </p>
              ) : null}
            </form>
          ) : null}

          {mode === 'register' ? (
            <form onSubmit={submitRegistration} className="space-y-3.5">
              <Field label="Actual name">
                <input
                  value={registration.fullName}
                  onChange={(event) => setRegistration({ ...registration, fullName: event.target.value })}
                  placeholder="Name used at work"
                  autoComplete="name"
                  className="h-11 w-full rounded-xl border border-input bg-background px-3 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
                  required
                />
              </Field>
              <Field label="Mobile phone">
                <input
                  value={registration.phone}
                  onChange={(event) => setRegistration({ ...registration, phone: event.target.value })}
                  placeholder="0123456789"
                  autoComplete="tel"
                  inputMode="tel"
                  className="h-11 w-full rounded-xl border border-input bg-background px-3 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
                  required
                />
              </Field>
              <Field label="Email (optional)">
                <input
                  type="email"
                  value={registration.email}
                  onChange={(event) => setRegistration({ ...registration, email: event.target.value })}
                  placeholder="Used only for staff records"
                  autoComplete="email"
                  className="h-11 w-full rounded-xl border border-input bg-background px-3 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
                />
              </Field>
              <Field label="Department / position (optional)">
                <input
                  value={registration.department}
                  onChange={(event) => setRegistration({ ...registration, department: event.target.value })}
                  placeholder="e.g. Kitchen, Cashier"
                  className="h-11 w-full rounded-xl border border-input bg-background px-3 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
                />
              </Field>
              <button
                type="submit"
                disabled={loading || !config?.registration_enabled}
                className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground transition hover:opacity-90 disabled:pointer-events-none disabled:opacity-50"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
                Send approval request
              </button>
            </form>
          ) : null}

          {mode === 'activate' ? (
            <form onSubmit={submitActivation} className="space-y-4">
              <Field label="Phone number or login ID">
                <input
                  value={activation.loginId}
                  onChange={(event) => setActivation({ ...activation, loginId: event.target.value })}
                  placeholder="The login ID approved by the Owner"
                  autoComplete="username"
                  className="h-11 w-full rounded-xl border border-input bg-background px-3 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
                  required
                />
              </Field>
              <Field label="One-time activation code" hint="Codes expire after 48 hours and can only be used once.">
                <input
                  value={activation.activationCode}
                  onChange={(event) => setActivation({ ...activation, activationCode: event.target.value.toUpperCase().replace(/\s+/g, '') })}
                  placeholder="8-character code"
                  autoComplete="one-time-code"
                  className="h-11 w-full rounded-xl border border-input bg-background px-3 font-mono text-sm uppercase tracking-[0.18em] outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
                  required
                />
              </Field>
              <Field label="Create PIN or password" hint="Staff use a non-obvious 6-digit PIN. Manager / Owner passwords require 12+ characters, letters, numbers and a symbol.">
                <SecretInput
                  value={activation.secret}
                  onChange={(secret) => setActivation({ ...activation, secret })}
                  placeholder="Create your credential"
                  autoComplete="new-password"
                />
              </Field>
              <button
                type="submit"
                disabled={loading || !localReady}
                className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground transition hover:opacity-90 disabled:pointer-events-none disabled:opacity-50"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
                Activate local login
              </button>
            </form>
          ) : null}

          {googleReady ? (
            <div className="mt-5 border-t border-border pt-4">
              {!showGoogle ? (
                <button
                  type="button"
                  onClick={() => setShowGoogle(true)}
                  className="w-full text-center text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                >
                  Use temporary Google migration fallback
                </button>
              ) : (
                <GoogleFallback
                  clientId={clientId}
                  loading={loading}
                  onLoading={setLoading}
                  onError={setError}
                  onSuccess={googleSuccess}
                />
              )}
            </div>
          ) : null}
        </>
      )}
    </AuthLayout>
  )
}
