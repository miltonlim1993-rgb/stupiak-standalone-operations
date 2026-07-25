import { useEffect, useMemo, useState } from 'react'
import {
  ArrowRightLeft, Banknote, Bike, CheckCircle2, CircleDollarSign, CreditCard,
  Loader2, Plus, QrCode, RefreshCw, Save, Smartphone, UserRound, WalletCards,
} from 'lucide-react'
import { opsClient } from '@/api/opsClient'
import { useAuth } from '@/lib/AuthContext'
import { parseOutletIds } from '@/lib/outlets'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import PageNotifications from '@/components/PageNotifications'
import { cachedBootstrap } from '@/components/AppFoundation'

const ICONS = {
  banknote: Banknote,
  'credit-card': CreditCard,
  'qr-code': QrCode,
  'wallet-cards': WalletCards,
  smartphone: Smartphone,
  bike: Bike,
  'circle-dollar-sign': CircleDollarSign,
}

const FALLBACK_METHODS = [
  { id: 'cash', code: 'cash', name: 'Cash', icon: 'banknote', color: 'emerald', category: 'cash', display_order: 10 },
  { id: 'duitnow', code: 'duitnow', name: 'DuitNow', icon: 'qr-code', color: 'violet', category: 'cashless', display_order: 20 },
  { id: 'sarawak_pay', code: 'sarawak_pay', name: 'Sarawak Pay', icon: 'wallet-cards', color: 'sky', category: 'cashless', display_order: 30 },
  { id: 'pay_and_go', code: 'pay_and_go', name: 'Pay & Go', icon: 'credit-card', color: 'blue', category: 'cashless', display_order: 40 },
  { id: 'grab_dine_out', code: 'grab_dine_out', name: 'Grab Dine Out', icon: 'smartphone', color: 'emerald', category: 'cashless', display_order: 50 },
  { id: 'grabfood', code: 'grabfood', name: 'GrabFood', icon: 'bike', color: 'green', category: 'delivery', display_order: 60 },
  { id: 'shopeefood', code: 'shopeefood', name: 'ShopeeFood', icon: 'bike', color: 'orange', category: 'delivery', display_order: 70 },
  { id: 'foodpanda', code: 'foodpanda', name: 'Foodpanda', icon: 'bike', color: 'pink', category: 'delivery', display_order: 80 },
]

const DENOMINATIONS = [100, 50, 20, 10, 5, 1, 0.5, 0.2, 0.1, 0.05]
const PHASES = {
  morning: { name: 'Morning / Opening', shortName: 'Opening' },
  handover: { name: 'Cash Handover', shortName: 'Handover' },
  night: { name: 'Night / Closing', shortName: 'Closing' },
}

function todayText() {
  const date = new Date()
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function newHandoverKey() {
  const id = typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `handover-${id}`
}

function money(value) {
  const parsed = Number(value || 0)
  return Number.isFinite(parsed) ? parsed : 0
}

function formatMoney(value) {
  return new Intl.NumberFormat('en-MY', { style: 'currency', currency: 'MYR' }).format(money(value))
}

function parseJson(value, fallback = {}) {
  try {
    const parsed = JSON.parse(value || '')
    return parsed && typeof parsed === 'object' ? parsed : fallback
  } catch {
    return fallback
  }
}

function colorClass(color) {
  return ({
    emerald: 'bg-emerald-100 text-emerald-700', blue: 'bg-blue-100 text-blue-700',
    violet: 'bg-violet-100 text-violet-700', sky: 'bg-sky-100 text-sky-700',
    green: 'bg-green-100 text-green-700', pink: 'bg-pink-100 text-pink-700',
    orange: 'bg-orange-100 text-orange-700', slate: 'bg-slate-100 text-slate-700',
  })[color] || 'bg-muted text-muted-foreground'
}

function sumDenominations(values) {
  return DENOMINATIONS.reduce((sum, denomination) => sum + denomination * money(values[String(denomination)]), 0)
}

export default function CloseUp() {
  const { user } = useAuth()
  const outletId = user?.outlet_id || parseOutletIds(user)[0] || ''
  const defaultStaff = user?.full_name || user?.email || ''

  const [date, setDate] = useState(todayText())
  const [phase, setPhase] = useState('night')
  const [activeRecordId, setActiveRecordId] = useState('')
  const [handoverEventKey, setHandoverEventKey] = useState(newHandoverKey)
  const [methods, setMethods] = useState(() => cachedBootstrap()?.payment_methods || FALLBACK_METHODS)
  const [payments, setPayments] = useState({})
  const [denominations, setDenominations] = useState({})
  const [outgoingDenominations, setOutgoingDenominations] = useState({})
  const [incomingDenominations, setIncomingDenominations] = useState({})
  const [countedBy, setCountedBy] = useState(defaultStaff)
  const [fromStaff, setFromStaff] = useState(defaultStaff)
  const [toStaff, setToStaff] = useState('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [existing, setExisting] = useState(null)
  const [recent, setRecent] = useState([])

  useEffect(() => {
    if (!countedBy && defaultStaff) setCountedBy(defaultStaff)
    if (!fromStaff && defaultStaff) setFromStaff(defaultStaff)
  }, [defaultStaff, countedBy, fromStaff])

  useEffect(() => {
    const bootstrapListener = (event) => {
      if (event.detail?.payment_methods?.length) setMethods(event.detail.payment_methods)
    }
    const packListener = () => {
      const packed = window.__chefopsDataPack?.modules?.core?.payment_methods
      if (packed?.length) setMethods(packed)
    }
    window.addEventListener('chefops:bootstrap', bootstrapListener)
    window.addEventListener('chefops:data-pack-updated', packListener)
    return () => {
      window.removeEventListener('chefops:bootstrap', bootstrapListener)
      window.removeEventListener('chefops:data-pack-updated', packListener)
    }
  }, [])

  useEffect(() => { loadCloseUp() }, [date, phase, outletId, activeRecordId])

  const electronicMethods = useMemo(() => methods
    .filter((method) => method.active !== false && String(method.code || '').toLowerCase() !== 'cash')
    .sort((a, b) => Number(a.display_order || 0) - Number(b.display_order || 0)), [methods])
  const cashlessMethods = electronicMethods.filter((method) => String(method.category || '').toLowerCase() !== 'delivery')
  const deliveryMethods = electronicMethods.filter((method) => String(method.category || '').toLowerCase() === 'delivery')

  const actualCash = useMemo(() => sumDenominations(denominations), [denominations])
  const outgoingCash = useMemo(() => sumDenominations(outgoingDenominations), [outgoingDenominations])
  const incomingCash = useMemo(() => sumDenominations(incomingDenominations), [incomingDenominations])
  const handoverVariance = incomingCash - outgoingCash
  const ePaymentTotal = useMemo(() => electronicMethods.reduce((sum, method) => sum + money(payments[method.code]), 0), [electronicMethods, payments])
  const recordedTotal = phase === 'handover'
    ? incomingCash
    : actualCash + (phase === 'night' ? ePaymentTotal : 0)

  function resetDraft(nextPhase = phase) {
    setExisting(null)
    setPayments({})
    setDenominations({})
    setOutgoingDenominations({})
    setIncomingDenominations({})
    setCountedBy(defaultStaff)
    setFromStaff(defaultStaff)
    setToStaff('')
    setNotes('')
    setMessage('')
    setError('')
    if (nextPhase === 'handover') setHandoverEventKey(newHandoverKey())
  }

  function hydrate(row) {
    setExisting(row)
    setCountedBy(row.submitted_by_name || row.created_by || defaultStaff)
    setFromStaff(row.from_staff || defaultStaff)
    setToStaff(row.to_staff || '')
    setNotes(row.notes || '')
    const paymentPayload = parseJson(row.payments_json, {})
    setPayments(paymentPayload.amounts || paymentPayload || {})
    setDenominations(parseJson(row.denominations_json, {}))
    setOutgoingDenominations(parseJson(row.outgoing_denominations_json, {}))
    setIncomingDenominations(parseJson(row.incoming_denominations_json, {}))
    if (row.event_key) setHandoverEventKey(row.event_key)
  }

  async function loadCloseUp(preferredRecordId = activeRecordId) {
    if (!outletId) { setLoading(false); return }
    setLoading(true)
    setError('')
    try {
      const year = Number(date.slice(0, 4))
      const rows = await opsClient.entities.CloseUp.filter(
        { outlet_id: outletId, business_date: date },
        '-submitted_at,-created_date',
        100,
        { year },
      )
      const datedRows = rows || []
      setRecent(datedRows)

      let row = null
      if (preferredRecordId) row = datedRows.find((item) => item.id === preferredRecordId) || null
      else if (phase !== 'handover') row = datedRows.find((item) => item.shift_id === phase) || null

      if (row) hydrate(row)
      else resetDraft(phase)
    } catch (err) {
      setError(err.message || 'Unable to load Close Up')
    } finally {
      setLoading(false)
    }
  }

  function choosePhase(nextPhase) {
    setPhase(nextPhase)
    setActiveRecordId('')
    resetDraft(nextPhase)
  }

  function chooseRecord(row) {
    setPhase(row.shift_id)
    setActiveRecordId(row.id)
  }

  function addAnotherHandover() {
    setPhase('handover')
    setActiveRecordId('')
    resetDraft('handover')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  async function save(event) {
    event.preventDefault()
    if (!outletId) { setError('No outlet is assigned to this account.'); return }
    if (phase === 'handover') {
      if (!fromStaff.trim() || !toStaff.trim()) {
        setError('From staff and to staff are required for every handover.')
        return
      }
    } else if (!countedBy.trim()) {
      setError('Staff name is required before submitting.')
      return
    }

    setSaving(true)
    setError('')
    setMessage('')
    try {
      const year = Number(date.slice(0, 4))
      const isHandover = phase === 'handover'
      const eventKey = existing?.event_key || (isHandover
        ? handoverEventKey
        : `${outletId}|${date}|${phase}`)
      const payload = {
        record_id: existing?.id || '',
        event_key: eventKey,
        outlet_id: outletId,
        business_date: date,
        shift_id: phase,
        shift_name: PHASES[phase].name,
        opening_float: 0,
        expected_cash: 0,
        actual_cash: isHandover ? incomingCash : actualCash,
        outgoing_cash: isHandover ? outgoingCash : 0,
        incoming_cash: isHandover ? incomingCash : 0,
        handover_variance: isHandover ? handoverVariance : 0,
        from_staff: isHandover ? fromStaff.trim() : '',
        to_staff: isHandover ? toStaff.trim() : '',
        cash_variance: 0,
        expected_sales: 0,
        payment_total: recordedTotal,
        total_variance: 0,
        payments_json: JSON.stringify({
          amounts: phase === 'night' ? payments : {},
          methods: phase === 'night'
            ? electronicMethods.map((method) => ({ code: method.code, name: method.name, category: method.category }))
            : [],
        }),
        denominations_json: JSON.stringify(isHandover ? {} : denominations),
        outgoing_denominations_json: JSON.stringify(isHandover ? outgoingDenominations : {}),
        incoming_denominations_json: JSON.stringify(isHandover ? incomingDenominations : {}),
        notes: notes.trim(),
        status: 'submitted',
        submitted_by_name: isHandover ? (defaultStaff || fromStaff.trim()) : countedBy.trim(),
        submitted_by_email: user?.email || '',
      }
      const saved = await opsClient.closeUp.upsert(payload, { year })
      setExisting(saved)
      setActiveRecordId(saved.id)
      setMessage(saved.sync_status === 'synced'
        ? `${PHASES[phase].shortName} saved and synced to the yearly Sales report.`
        : saved.sync_status === 'not_configured'
          ? `${PHASES[phase].shortName} saved. Sales report sync is not configured yet.`
          : `${PHASES[phase].shortName} saved. Sales report sync is pending retry.`)
      await loadCloseUp(saved.id)
    } catch (err) {
      setError(err.message || 'Unable to save Close Up')
    } finally {
      setSaving(false)
    }
  }

  async function retrySalesSync() {
    if (!existing?.id) return
    setSaving(true)
    setError('')
    setMessage('')
    try {
      const updated = await opsClient.closeUp.retrySync(existing.id, { year: Number(date.slice(0, 4)) })
      setExisting(updated)
      setMessage(updated.sync_status === 'synced'
        ? 'Sales report sync completed.'
        : 'Sync is still pending. This record remains safely saved in ChefOps.')
    } catch (err) {
      setError(err.message || 'Unable to retry Sales report sync')
    } finally {
      setSaving(false)
    }
  }

  const submitLabel = saving
    ? 'Saving…'
    : existing
      ? phase === 'handover' ? 'Update handover' : 'Update actuals'
      : phase === 'handover' ? 'Save handover' : 'Submit actuals'

  return <div className="chefops-page closeup-page mx-auto space-y-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-xl font-bold">Close Up</h1>
        <p className="mt-0.5 text-xs text-muted-foreground">Opening, unlimited handovers and closing actuals. Every event is retained in the yearly report log.</p>
      </div>
      <span className={`rounded-full px-3 py-1 text-xs font-semibold ${existing ? 'bg-emerald-100 text-emerald-700' : 'bg-muted text-muted-foreground'}`}>{existing ? 'Submitted' : 'New entry'}</span>
    </div>
    <PageNotifications page="/close-up" limit={2} />

    <form onSubmit={save} className="closeup-layout">
      <div className="closeup-main space-y-4">
        <section className="closeup-meta-grid rounded-2xl border border-border bg-card p-4">
          <div>
            <Label>Business date</Label>
            <Input className="mt-2" type="date" value={date} onChange={(event) => { setDate(event.target.value); setActiveRecordId('') }} />
          </div>
          <div>
            <Label>Phase</Label>
            <select className="mt-2 h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={phase} onChange={(event) => choosePhase(event.target.value)}>
              <option value="morning">Morning / Opening</option>
              <option value="handover">Cash Handover</option>
              <option value="night">Night / Closing</option>
            </select>
          </div>
          <div>
            <Label>Outlet</Label>
            <div className="mt-2 flex h-10 items-center rounded-md bg-muted px-3 text-sm font-medium">{outletId || 'No outlet'}</div>
          </div>
        </section>

        {phase === 'handover' ? <>
          <section className="rounded-2xl border border-amber-200 bg-amber-50/50 p-4">
            <div className="flex items-start gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-100 text-amber-700"><ArrowRightLeft className="h-4 w-4" /></span>
              <div>
                <h2 className="text-sm font-semibold">New cash handover</h2>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">There is no daily limit. Save every transfer separately; the full sequence remains in <strong>_CashShiftLog</strong>.</p>
              </div>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div><Label>From staff</Label><Input className="mt-2" value={fromStaff} onChange={(event) => setFromStaff(event.target.value)} placeholder="Person handing over" /></div>
              <div><Label>To staff</Label><Input className="mt-2" value={toStaff} onChange={(event) => setToStaff(event.target.value)} placeholder="Person receiving" /></div>
            </div>
          </section>

          <div className="closeup-handover-grid">
            <DenominationSection
              title="Cash handed over"
              description="Count the notes and coins leaving the first staff member."
              total={outgoingCash}
              values={outgoingDenominations}
              onChange={setOutgoingDenominations}
              tone="amber"
            />
            <DenominationSection
              title="Cash received"
              description="The receiving staff member counts again independently."
              total={incomingCash}
              values={incomingDenominations}
              onChange={setIncomingDenominations}
              tone="emerald"
            />
          </div>

          <section className={`rounded-2xl border p-4 ${Math.abs(handoverVariance) < 0.005 ? 'border-emerald-200 bg-emerald-50/50' : 'border-red-200 bg-red-50/50'}`}>
            <div className="flex items-center justify-between gap-3">
              <div><h2 className="text-sm font-semibold">Handover variance</h2><p className="mt-1 text-xs text-muted-foreground">Cash received minus cash handed over.</p></div>
              <p className={`text-xl font-bold ${Math.abs(handoverVariance) < 0.005 ? 'text-emerald-700' : 'text-red-700'}`}>{formatMoney(handoverVariance)}</p>
            </div>
          </section>
        </> : <DenominationSection
          title="Cash on hand"
          description="Enter the number of notes and coins. Actual cash is calculated automatically."
          total={actualCash}
          values={denominations}
          onChange={setDenominations}
          tone="emerald"
        />}

        {phase === 'night' ? <>
          <PaymentGroup title="Cashless payments" methods={cashlessMethods} payments={payments} setPayments={setPayments} />
          <PaymentGroup title="Delivery platforms" methods={deliveryMethods} payments={payments} setPayments={setPayments} />
        </> : null}
      </div>

      <aside className="closeup-summary-panel space-y-4">
        <section className="rounded-2xl border border-border bg-card p-4">
          <h2 className="text-sm font-semibold">Actual summary</h2>
          <div className="mt-4 space-y-2">
            {phase === 'handover' ? <>
              <Summary label="Handed over" value={outgoingCash} />
              <Summary label="Received" value={incomingCash} />
              <Summary label="Variance" value={handoverVariance} strong alert={Math.abs(handoverVariance) >= 0.005} />
            </> : <>
              <Summary label="Cash on hand" value={actualCash} />
              <Summary label="E-payments" value={phase === 'night' ? ePaymentTotal : 0} />
              <Summary label="Recorded actual total" value={recordedTotal} strong />
            </>}
          </div>

          {phase !== 'handover' ? <div className="mt-4">
            <Label>Counted by</Label>
            <div className="relative mt-2"><UserRound className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><Input className="pl-9" value={countedBy} onChange={(event) => setCountedBy(event.target.value)} placeholder="Staff name" /></div>
          </div> : null}

          <div className="closeup-note-before-save mt-4 rounded-xl border border-border bg-muted/25 p-3">
            <Label>{phase === 'handover' ? 'Handover note' : 'Close Up note'}</Label>
            <Textarea className="mt-2 min-h-20 bg-background" value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Optional operational note" />
          </div>

          {error ? <p className="mt-3 rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}
          {message ? <p className="mt-3 rounded-xl bg-emerald-50 p-3 text-sm text-emerald-700">{message}</p> : null}
          {existing ? <div className={`mt-3 rounded-xl p-3 text-xs ${existing.sync_status === 'synced' ? 'bg-emerald-50 text-emerald-700' : existing.sync_status === 'not_configured' ? 'bg-amber-50 text-amber-700' : 'bg-orange-50 text-orange-700'}`}>
            <div className="flex items-center justify-between gap-2"><span className="font-semibold">Sales report: {existing.sync_status || 'pending'}</span>{existing.sync_status !== 'synced' ? <button type="button" onClick={retrySalesSync} className="inline-flex items-center gap-1 font-semibold"><RefreshCw className="h-3.5 w-3.5" /> Retry</button> : null}</div>
            {existing.last_sync_error ? <p className="mt-1 break-words leading-5">{existing.last_sync_error}</p> : null}
          </div> : null}
          {loading ? <p className="mt-3 text-center text-[11px] text-muted-foreground">Checking previous entries in the background. You can still submit.</p> : null}

          <Button type="submit" className="closeup-desktop-submit mt-4 h-11 w-full" disabled={saving || !outletId}>{saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}{submitLabel}</Button>
          {phase === 'handover' && existing ? <Button type="button" variant="outline" className="mt-2 h-11 w-full" onClick={addAnotherHandover}><Plus className="mr-2 h-4 w-4" /> Add another handover</Button> : null}
        </section>

        {recent.length ? <section className="rounded-2xl border border-border bg-card p-4">
          <div className="flex items-center justify-between gap-2"><h2 className="text-sm font-semibold">This date</h2><span className="text-[11px] text-muted-foreground">{recent.length} event{recent.length === 1 ? '' : 's'}</span></div>
          <div className="mt-3 space-y-2">{recent.map((row) => {
            const rowPhase = row.shift_id || 'night'
            const isHandover = rowPhase === 'handover'
            const amount = isHandover ? money(row.incoming_cash || row.actual_cash) : money(row.payment_total)
            const label = isHandover
              ? `Handover${row.handover_sequence ? ` #${row.handover_sequence}` : ''}`
              : row.shift_name || PHASES[rowPhase]?.name || rowPhase
            return <button type="button" key={row.id} onClick={() => chooseRecord(row)} className={`flex w-full items-center justify-between rounded-xl border p-3 text-left ${activeRecordId === row.id || existing?.id === row.id ? 'border-primary bg-primary/5' : 'border-transparent bg-muted/50'}`}>
              <div className="min-w-0"><p className="truncate text-sm font-medium">{label}</p><p className="truncate text-xs text-muted-foreground">{isHandover ? `${row.from_staff || '—'} → ${row.to_staff || '—'}` : row.submitted_by_name || row.created_by}</p></div>
              <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-emerald-600"><CheckCircle2 className="h-4 w-4" /> {formatMoney(amount)}</span>
            </button>
          })}</div>
          <Button type="button" variant="outline" className="mt-3 w-full" onClick={addAnotherHandover}><Plus className="mr-2 h-4 w-4" /> New handover</Button>
        </section> : null}
      </aside>

      <div className="chefops-mobile-action">
        <Button type="submit" className="h-12 w-full shadow-lg" disabled={saving || !outletId}>{saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}{submitLabel}</Button>
      </div>
    </form>
  </div>
}

function DenominationSection({ title, description, total, values, onChange, tone = 'emerald' }) {
  const toneClass = tone === 'amber' ? 'text-amber-700' : 'text-emerald-700'
  return <section className="rounded-2xl border border-border bg-card p-4">
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-2"><Banknote className={`h-4 w-4 ${toneClass}`} /><h2 className="text-sm font-semibold">{title}</h2></div>
      <p className={`text-lg font-bold ${toneClass}`}>{formatMoney(total)}</p>
    </div>
    <p className="mt-1 text-xs text-muted-foreground">{description}</p>
    <div className="closeup-denomination-grid mt-4">
      {DENOMINATIONS.map((denomination) => <div key={denomination} className="min-w-0 rounded-xl border border-border p-2.5">
        <Label className="text-[11px] font-semibold">RM {denomination}</Label>
        <Input className="mt-1.5 h-9 min-w-0" type="number" min="0" inputMode="numeric" value={values[String(denomination)] || ''} onChange={(event) => onChange({ ...values, [String(denomination)]: event.target.value })} placeholder="0" />
        <p className="mt-1 truncate text-[10px] text-muted-foreground">{formatMoney(denomination * money(values[String(denomination)]))}</p>
      </div>)}
    </div>
  </section>
}

function PaymentGroup({ title, methods, payments, setPayments }) {
  if (!methods.length) return null
  return <section className="rounded-2xl border border-border bg-card p-4">
    <div className="flex items-center justify-between"><h2 className="text-sm font-semibold">{title}</h2><span className="text-sm font-bold">{formatMoney(methods.reduce((sum, method) => sum + money(payments[method.code]), 0))}</span></div>
    <div className="closeup-payment-grid mt-4">{methods.map((method) => {
      const Icon = ICONS[method.icon] || CircleDollarSign
      return <div key={method.code} className="min-w-0 rounded-xl border border-border p-3">
        <div className="flex items-center gap-2"><span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${colorClass(method.color)}`}><Icon className="h-4 w-4" /></span><p className="min-w-0 flex-1 truncate text-sm font-medium">{method.name}</p></div>
        <div className="relative mt-2"><span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">RM</span><Input className="pl-9" type="number" min="0" step="0.01" inputMode="decimal" value={payments[method.code] ?? ''} onChange={(event) => setPayments({ ...payments, [method.code]: event.target.value })} placeholder="0.00" /></div>
      </div>
    })}</div>
  </section>
}

function Summary({ label, value, strong = false, alert = false }) {
  const className = alert
    ? 'bg-red-50 text-red-700'
    : strong
      ? 'bg-primary/10 text-primary'
      : 'bg-muted/60'
  return <div className={`flex items-center justify-between rounded-xl px-3 py-2.5 ${className}`}><span className="text-xs">{label}</span><span className={`${strong ? 'text-base' : 'text-sm'} font-bold`}>{formatMoney(value)}</span></div>
}
