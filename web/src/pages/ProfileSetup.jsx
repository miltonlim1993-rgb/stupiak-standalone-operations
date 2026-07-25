import { useMemo, useState } from 'react'
import { Loader2, UserRoundCheck } from 'lucide-react'
import AuthLayout from '@/components/AuthLayout'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAuth } from '@/lib/AuthContext'

function initialName(user) {
  const name = String(user?.full_name || '').trim()
  return name.includes('@') ? '' : name
}

export default function ProfileSetup() {
  const { user, updateProfile } = useAuth()
  const [name, setName] = useState(() => initialName(user))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const normalized = useMemo(() => String(name || '').replace(/\s+/g, ' ').trim(), [name])

  const submit = async (event) => {
    event.preventDefault()
    setError('')
    if (normalized.length < 2 || normalized.includes('@')) {
      setError('Enter your actual name. Do not enter an email address.')
      return
    }
    setSaving(true)
    try {
      await updateProfile({ full_name: normalized })
    } catch (err) {
      setError(err.message || 'Your name could not be saved')
    } finally {
      setSaving(false)
    }
  }

  return (
    <AuthLayout
      title="Confirm your actual name"
      subtitle="This name will be printed on labels and saved in audit records."
      footer={<span className="inline-flex items-center gap-1"><UserRoundCheck className="h-3.5 w-3.5" /> Your email is used for sign-in only and is never printed on a label.</span>}
    >
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="actual-name">Your actual name</Label>
          <Input
            id="actual-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoComplete="name"
            autoFocus
            maxLength={80}
            placeholder="e.g. Milton Lim"
          />
          <p className="text-xs text-muted-foreground">Use the name coworkers know you by. Generic names such as Staff or Admin are not accepted.</p>
        </div>
        {error && <div className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
        <Button type="submit" className="h-11 w-full" disabled={saving}>
          {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Save and continue
        </Button>
      </form>
    </AuthLayout>
  )
}
