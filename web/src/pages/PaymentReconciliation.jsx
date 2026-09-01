import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle, CheckCircle2, FileCheck2, History, Loader2, RefreshCcwDot,
  RotateCcw, ShieldCheck,
} from 'lucide-react'
import { opsClient } from '@/api/opsClient'
import { useAuth } from '@/lib/AuthContext'
import { parseOutletIds } from '@/lib/outlets'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import PageNotifications from '@/components/PageNotifications'

function todayText() {
  const date = new Date()
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function mutationId(action) {
  const id = typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `payment-reconciliation:${action}:${id}`
}

function formatMoney(value) {
  const amount = Number(value || 0)
  return new Intl.NumberFormat('en-MY', { style: 'currency', currency: 'MYR' }).format(Number.isFinite(amount) ? amount : 0)
}

function versionOf(record) {
  return Number(record?.__realtime?.version || 0)
}

function statusLabel(status) {
  return ({
    blind_entry: 'Blind entry',
    differences_revealed: 'Differences revealed',
    remarks_complete: 'Remarks complete',
    submitted: 'Submitted / reconciled',
  })[status] || status || 'Not started'
}

export default function PaymentReconciliation() {
  const { user } = useAuth()
  const outletId = user?.outlet_id || parseOutletIds(user)[0] || ''
  const [date, setDate] = useState(todayText())
  const [context, setContext] = useState(null)
  const [reason, setReason] = useState('')
  const [evidenceIds, setEvidenceIds] = useState('')
  const [classification, setClassification] = useState('')
  const [replacementReason, setReplacementReason] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const expected = context?.expected_basis || null
  const actual = context?.actual_fact || null
  const current = context?.current_reconciliation || null
  const comparison = current?.comparison || null
  const canReplace = ['supervisor', 'manager', 'owner'].includes(String(user?.role || '').toLowerCase())

  useEffect(() => { load() }, [date, outletId])

  useEffect(() => {
    if (!comparison) return
    setClassification(comparison.all_matched ? 'matched' : 'explained_discrepancy')
  }, [comparison?.all_matched, current?.id])

  const readyToStart = Boolean(expected?.id && actual?.id && !current)
  const facts = useMemo(() => ({
    expected: expected ? `${expected.id} · v${versionOf(expected)} · ${String(expected.source_digest || '').slice(0, 12)}…` : 'Unavailable',
    actual: actual ? `${actual.id} · v${versionOf(actual)} · ${String(actual.count_identity || '').slice(0, 12)}…` : 'Unavailable',
  }), [expected, actual])

  async function load() {
    if (!outletId) { setLoading(false); return }
    setLoading(true)
    setError('')
    try {
      setContext(await opsClient.paymentReconciliation.context({
        outletId,
        businessDate: date,
        shiftId: 'night',
      }))
    } catch (err) {
      setError(err.message || 'Unable to load Payment Reconciliation')
    } finally {
      setLoading(false)
    }
  }

  async function run(action, payload, successMessage) {
    setSaving(true)
    setError('')
    setMessage('')
    try {
      await opsClient.paymentReconciliation[action]({
        mutation_id: mutationId(action),
        requested_at: new Date().toISOString(),
        ...payload,
      })
      setMessage(successMessage)
      setReason('')
      setEvidenceIds('')
      setReplacementReason('')
      await load()
    } catch (err) {
      setError(err.message || `Unable to ${action} reconciliation`)
    } finally {
      setSaving(false)
    }
  }

  function start() {
    if (!expected?.id || !actual?.id) return
    return run('start', {
      outlet_id: outletId,
      business_date: date,
      shift_id: 'night',
      expected_basis_id: expected.id,
      expected_basis_digest: expected.source_digest,
      actual_close_id: actual.id,
      actual_version: versionOf(actual),
      actual_count_identity: actual.count_identity,
    }, 'Blind actual evidence was bound to the exact expected and actual facts.')
  }

  function reveal() {
    return run('reveal', {
      reconciliation_id: current.id,
      expected_version: versionOf(current),
    }, 'Server-calculated differences were revealed.')
  }

  function remark() {
    return run('remark', {
      reconciliation_id: current.id,
      expected_version: versionOf(current),
      classification,
      reason: reason.trim(),
      evidence_ids: evidenceIds.split(',').map((item) => item.trim()).filter(Boolean),
    }, classification === 'unresolved_exception'
      ? 'The unresolved exception remains open and cannot be submitted.'
      : 'Variance remarks and evidence were recorded.')
  }

  function submit() {
    return run('submit', {
      reconciliation_id: current.id,
      expected_version: versionOf(current),
    }, 'Payment Reconciliation completed in D1. No payment, allocation, journal, AP, or Cash Close fact was changed.')
  }

  function replace() {
    if (!expected?.id || !actual?.id || !current?.id) return
    return run('replace', {
      original_reconciliation_id: current.id,
      outlet_id: outletId,
      business_date: date,
      shift_id: 'night',
      expected_basis_id: expected.id,
      expected_basis_digest: expected.source_digest,
      actual_close_id: actual.id,
      actual_version: versionOf(actual),
      actual_count_identity: actual.count_identity,
      replacement_reason: replacementReason.trim(),
    }, 'A linked replacement was created. The original reconciliation remains immutable.')
  }

  return <div className="chefops-page mx-auto w-full max-w-6xl space-y-4 p-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-xl font-bold">Payment Reconciliation</h1>
        <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">Compare exact FeedMe expected facts with accepted D1 operational evidence. Reconciliation is evidence only—it cannot create a Payment, settle AP, post a journal, or alter Cash Close.</p>
      </div>
      <span className={`rounded-full px-3 py-1 text-xs font-semibold ${context?.completion?.complete ? 'bg-emerald-100 text-emerald-700' : current ? 'bg-amber-100 text-amber-800' : 'bg-muted text-muted-foreground'}`}>{statusLabel(current?.status)}</span>
    </div>
    <PageNotifications page="/payment-reconciliation" limit={2} />

    <section className="grid gap-3 rounded-2xl border border-border bg-card p-4 sm:grid-cols-3">
      <div><Label>Business date</Label><Input className="mt-2" type="date" value={date} onChange={(event) => setDate(event.target.value)} /></div>
      <div><Label>Outlet</Label><div className="mt-2 flex h-10 items-center rounded-md bg-muted px-3 text-sm font-medium">{outletId || 'No outlet'}</div></div>
      <div><Label>Scope</Label><div className="mt-2 flex h-10 items-center rounded-md bg-muted px-3 text-sm font-medium">Night / closing · outlet/day</div></div>
    </section>

    {context?.source_drift ? <section className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900"><div className="flex gap-3"><AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" /><div><p className="font-semibold">Source drift detected</p><p className="mt-1 text-xs">{context.stale_reasons.join(', ')}. Historical evidence was not rewritten; create a linked replacement against the current facts.</p></div></div></section> : null}

    <div className="grid gap-4 lg:grid-cols-[1.2fr_.8fr]">
      <div className="space-y-4">
        <section className="rounded-2xl border border-border bg-card p-4">
          <div className="flex items-center gap-2"><ShieldCheck className="h-5 w-5 text-sky-600" /><h2 className="font-semibold">Exact fact identities</h2></div>
          <div className="mt-4 space-y-3 text-xs">
            <Fact label="Expected source" role="FeedMe · external input" identity={facts.expected} />
            <Fact label="Actual fact" role="Completed D1 Close Up · operational truth" identity={facts.actual} />
          </div>
          {!expected ? <p className="mt-3 rounded-lg bg-red-50 p-3 text-xs text-red-700">No signed FeedMe expected basis is available.</p> : null}
          {!actual ? <p className="mt-3 rounded-lg bg-red-50 p-3 text-xs text-red-700">No completed authoritative Close Up is available. Close Up completion does not automatically complete reconciliation.</p> : null}
        </section>

        {comparison ? <section className="rounded-2xl border border-border bg-card p-4">
          <div className="flex items-center justify-between gap-3"><div className="flex items-center gap-2"><RefreshCcwDot className="h-5 w-5 text-violet-600" /><h2 className="font-semibold">Server differences</h2></div><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${comparison.all_matched ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>{comparison.all_matched ? 'Matched' : 'Discrepancy'}</span></div>
          <div className="mt-4 overflow-hidden rounded-xl border border-border">
            <div className="grid grid-cols-5 gap-2 bg-muted px-3 py-2 text-[11px] font-semibold"><span>Channel</span><span>Expected</span><span>Actual</span><span>Variance</span><span>Class</span></div>
            {comparison.channels.map((item) => <div key={item.channel} className="grid grid-cols-5 gap-2 border-t border-border px-3 py-2 text-xs"><span className="font-medium">{item.channel}</span><span>{formatMoney(item.expected)}</span><span>{formatMoney(item.actual)}</span><span className={item.variance === '0.00' ? 'text-emerald-700' : 'text-red-700'}>{formatMoney(item.variance)}</span><span className="break-words text-[11px] text-muted-foreground">{item.difference_class}</span></div>)}
            <div className="grid grid-cols-5 gap-2 border-t border-border bg-muted/50 px-3 py-2 text-xs font-bold"><span>Total</span><span>{formatMoney(comparison.expected_total)}</span><span>{formatMoney(comparison.actual_total)}</span><span>{formatMoney(comparison.variance)}</span><span>{comparison.all_matched ? 'matched' : 'review'}</span></div>
          </div>
        </section> : null}

        {context?.history?.length ? <section className="rounded-2xl border border-border bg-card p-4">
          <div className="flex items-center gap-2"><History className="h-5 w-5 text-slate-600" /><h2 className="font-semibold">Immutable history</h2></div>
          <div className="mt-3 space-y-2">{context.history.map((record) => <div key={record.id} className="rounded-xl bg-muted/50 p-3 text-xs"><div className="flex items-center justify-between gap-2"><span className="font-semibold">#{Number(record.replacement_sequence || 0)} · {statusLabel(record.status)}</span><span>{record.comparison ? formatMoney(record.comparison.variance) : 'Blind'}</span></div><p className="mt-1 break-all text-muted-foreground">{record.id}</p>{record.replacement_of_id ? <p className="mt-1 text-muted-foreground">Replaces: {record.replacement_of_id}</p> : null}</div>)}</div>
        </section> : null}
      </div>

      <aside className="space-y-4">
        <section className="rounded-2xl border border-border bg-card p-4">
          <div className="flex items-center gap-2"><FileCheck2 className="h-5 w-5 text-emerald-600" /><h2 className="font-semibold">Lifecycle command</h2></div>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">Every action is reauthorized by the server, outlet scoped, version checked, and idempotent. Offline device state is never authoritative.</p>

          {readyToStart ? <Button className="mt-4 w-full" onClick={start} disabled={saving}>Enter blind actual evidence</Button> : null}
          {current?.status === 'blind_entry' ? <Button className="mt-4 w-full" onClick={reveal} disabled={saving}>Reveal server differences</Button> : null}
          {current?.status === 'differences_revealed' ? <div className="mt-4 space-y-3">
            <div><Label>Decision class</Label><select className="mt-2 h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={classification} onChange={(event) => setClassification(event.target.value)}>{comparison?.all_matched ? <option value="matched">Matched</option> : <><option value="explained_discrepancy">Explained discrepancy</option><option value="unresolved_exception">Unresolved exception</option></>}</select></div>
            <div><Label>Reason / explanation</Label><Textarea className="mt-2 min-h-24" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Required; non-zero discrepancies remain visible" /></div>
            <div><Label>Evidence IDs</Label><Input className="mt-2" value={evidenceIds} onChange={(event) => setEvidenceIds(event.target.value)} placeholder="Comma-separated stable evidence IDs" /></div>
            <Button className="w-full" onClick={remark} disabled={saving || !reason.trim()}>Record variance remarks</Button>
          </div> : null}
          {current?.status === 'remarks_complete' ? <Button className="mt-4 w-full" onClick={submit} disabled={saving || current?.variance_remark?.classification === 'unresolved_exception'}>Submit reconciliation</Button> : null}
          {current?.status === 'submitted' ? <div className="mt-4 rounded-xl bg-emerald-50 p-3 text-xs text-emerald-800"><div className="flex items-center gap-2 font-semibold"><CheckCircle2 className="h-4 w-4" /> Authoritative reconciliation complete</div><p className="mt-2 leading-5">Payment created: no<br />Allocation changed: no<br />Journal created: no<br />Cash Close changed: no</p></div> : null}

          {canReplace && current ? <div className="mt-4 border-t border-border pt-4"><Label>Linked replacement reason</Label><Textarea className="mt-2 min-h-20" value={replacementReason} onChange={(event) => setReplacementReason(event.target.value)} placeholder="Required; the original remains immutable" /><Button variant="outline" className="mt-2 w-full" onClick={replace} disabled={saving || !replacementReason.trim() || !expected || !actual}><RotateCcw className="mr-2 h-4 w-4" /> Create linked replacement</Button></div> : null}

          {saving ? <p className="mt-3 flex items-center justify-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Server acceptance in progress</p> : null}
          {error ? <p className="mt-3 rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}
          {message ? <p className="mt-3 rounded-xl bg-emerald-50 p-3 text-sm text-emerald-700">{message}</p> : null}
          {loading ? <p className="mt-3 text-center text-xs text-muted-foreground">Loading authoritative context…</p> : null}
        </section>
      </aside>
    </div>
  </div>
}

function Fact({ label, role, identity }) {
  return <div className="rounded-xl bg-muted/50 p-3"><div className="flex items-center justify-between gap-3"><span className="font-semibold">{label}</span><span className="text-muted-foreground">{role}</span></div><p className="mt-2 break-all font-mono text-[11px] text-muted-foreground">{identity}</p></div>
}
