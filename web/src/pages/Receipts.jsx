import { useEffect, useMemo, useRef, useState } from 'react'
import { Camera, CheckCircle2, FileText, Images, Loader2, Receipt, ScanLine, Trash2, UploadCloud } from 'lucide-react'
import { opsClient } from '@/api/opsClient'
import { useAuth } from '@/lib/AuthContext'
import { recognizeReceipt } from '@/lib/receipt-ocr'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import MobileSheet from '@/components/MobileSheet'
import MediaLightbox from '@/components/MediaLightbox'
import PageNotifications from '@/components/PageNotifications'

function todayText() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
function money(value) { return new Intl.NumberFormat('en-MY', { style: 'currency', currency: 'MYR' }).format(Number(value || 0)) }

export default function Receipts() {
  const { user } = useAuth()
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState(false)

  const load = async () => {
    setLoading(true)
    try { setRows(await opsClient.entities.Receipt.filter({}, '-receipt_date,-created_date', 200, { year: new Date().getFullYear() })) } catch (error) { console.error(error) } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4 pb-24 lg:p-6">
      <div className="flex items-start justify-between gap-3"><div><h1 className="text-xl font-bold">Receipts</h1><p className="mt-0.5 text-xs text-muted-foreground">Scan a receipt, review OCR fields, then save the original image and structured record.</p></div><Button size="sm" className="h-9 rounded-xl" onClick={() => setOpen(true)}><ScanLine className="mr-1.5 h-4 w-4" /> Scan</Button></div>
      <PageNotifications page="/receipts" limit={2} />
      <div className="rounded-2xl border border-blue-200 bg-blue-50 p-3 text-xs leading-5 text-blue-800"><strong>Receipt OCR is active.</strong> The first scan downloads the OCR engine to this device. Later scans can reuse the cached engine. Every result requires staff review before saving.</div>
      {loading ? <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin" /></div> : rows.length ? <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{rows.map((row) => <ReceiptCard key={row.id} row={row} />)}</div> : <div className="rounded-2xl border border-dashed p-12 text-center"><Receipt className="mx-auto h-10 w-10 text-muted-foreground" /><p className="mt-3 text-sm font-medium">No scanned receipts yet</p><p className="mt-1 text-xs text-muted-foreground">Use the camera or choose an image/PDF.</p></div>}
      <MobileSheet open={open} onClose={() => setOpen(false)} title="Scan receipt" description="Image or PDF · browser OCR now, Statvara RapidOCR adapter later" compact={false}><ReceiptScanner user={user} onDone={() => { setOpen(false); load() }} /></MobileSheet>
    </div>
  )
}

function ReceiptCard({ row }) {
  const [viewerOpen, setViewerOpen] = useState(false)
  let raw = {}; let notes = {}
  try { raw = JSON.parse(row.raw_data || '{}') } catch {}
  try { notes = JSON.parse(row.notes || '{}') } catch {}
  const isPdf = String(row.mime_type || '').toLowerCase() === 'application/pdf' || /\.pdf$/i.test(String(row.file_name || ''))
  const title = `${row.source || 'Receipt'} · ${row.receipt_number || row.receipt_date || 'Image'}`

  return <>
    <article className="overflow-hidden rounded-2xl border border-border bg-card">
      <div className="flex items-start gap-3 p-4">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/15 text-primary"><Receipt className="h-5 w-5" /></span>
        <div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{row.source || 'Unknown supplier'}</p><p className="mt-0.5 text-xs text-muted-foreground">{row.receipt_date || 'No date'} · {row.receipt_number || 'No number'}</p></div>
        <p className="text-sm font-bold">{money(row.amount)}</p>
      </div>
      {row.image_url ? (
        isPdf
          ? <a href={row.image_url} target="_blank" rel="noreferrer" className="flex h-32 w-full items-center justify-center gap-2 border-t border-border bg-muted text-sm font-medium"><FileText className="h-6 w-6" /> Open receipt PDF</a>
          : <button type="button" onClick={() => setViewerOpen(true)} className="block w-full border-t border-border bg-muted"><img src={row.image_url} alt="Receipt" className="h-32 w-full object-cover" /></button>
      ) : null}
      <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-3 text-[11px]"><span className="capitalize text-muted-foreground">{row.payment_method || 'Payment unconfirmed'}</span><span className="inline-flex items-center gap-1 text-emerald-600"><CheckCircle2 className="h-3 w-3" /> Reviewed{raw.confidence ? ` · ${Math.round(raw.confidence)}% OCR` : ''}</span></div>
      {notes.ocr_warnings?.length ? <div className="border-t border-amber-200 bg-amber-50 px-4 py-2 text-[11px] text-amber-800">{notes.ocr_warnings.length} OCR warning(s) were reviewed.</div> : null}
    </article>
    <MediaLightbox open={viewerOpen} onOpenChange={setViewerOpen} src={row.image_url || ''} title={title} type="image" />
  </>
}

function ReceiptScanner({ user, onDone }) {
  const [file, setFile] = useState(null)
  const [preview, setPreview] = useState('')
  const [progress, setProgress] = useState(null)
  const [ocr, setOcr] = useState(null)
  const [draft, setDraft] = useState({ receipt_date: todayText(), receipt_number: '', source: '', amount: '', description: '', category: 'expense', payment_method: '', notesText: '' })
  const [scanning, setScanning] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const cameraRef = useRef(null); const fileRef = useRef(null)

  useEffect(() => { if (!file) { setPreview(''); return }; const url = URL.createObjectURL(file); setPreview(url); return () => URL.revokeObjectURL(url) }, [file])
  const select = (selected) => { if (!selected) return; if (selected.size > 25 * 1024 * 1024) { setError('Receipt file is larger than 25 MB.'); return }; setFile(selected); setOcr(null); setError('') }

  async function scan() {
    if (!file) return
    setScanning(true); setError(''); setProgress({ progress: 0, message: 'Starting OCR' })
    try {
      const result = await recognizeReceipt(file, setProgress)
      setOcr(result)
      setDraft((current) => ({ ...current, ...result.parsed, description: result.parsed.source ? `Receipt from ${result.parsed.source}` : 'Receipt expense' }))
    } catch (err) { setError(`${err.message || 'OCR failed'} The first scan requires internet to download the OCR engine.`) } finally { setScanning(false) }
  }

  async function save(event) {
    event.preventDefault()
    if (!ocr || !file) { setError('Scan and review the receipt first.'); return }
    setSaving(true); setError('')
    try {
      const uploaded = await opsClient.integrations.Core.UploadFile({ file, folderType: 'Receipts', outletName: user?.outlet_id || 'General' })
      const year = Number((draft.receipt_date || todayText()).slice(0, 4))
      await opsClient.entities.Receipt.create({
        outlet_id: user?.outlet_id || '', receipt_date: draft.receipt_date || todayText(), receipt_number: draft.receipt_number, source: draft.source,
        amount: Number(draft.amount || 0), description: draft.description, category: draft.category, payment_method: draft.payment_method,
        raw_data: JSON.stringify({ engine: ocr.engine, confidence: ocr.confidence, pages_processed: ocr.pagesProcessed, normalized_text: ocr.parsed.normalized_text, currency: ocr.parsed.currency }),
        image_url: uploaded.file_url, drive_file_id: uploaded.drive_file_id, file_name: uploaded.file_name, mime_type: uploaded.mime_type, file_size: uploaded.file_size,
        notes: JSON.stringify({ ocr_warnings: ocr.parsed.warnings, operator_reviewed_by: user?.full_name || user?.email, operator_reviewed_at: new Date().toISOString(), note: draft.notesText }),
      }, { year })
      onDone()
    } catch (err) { setError(err.message || 'Unable to save receipt') } finally { setSaving(false) }
  }

  return <form onSubmit={save} className="space-y-3">
    <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { select(e.target.files?.[0]); e.target.value = '' }} /><input ref={fileRef} type="file" accept="image/*,application/pdf" hidden onChange={(e) => { select(e.target.files?.[0]); e.target.value = '' }} />
    {!file ? <div className="grid grid-cols-2 gap-2"><button type="button" onClick={() => cameraRef.current?.click()} className="flex h-24 flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-primary/50 bg-primary/5 text-sm font-medium text-primary"><Camera className="h-6 w-6" /> Take photo</button><button type="button" onClick={() => fileRef.current?.click()} className="flex h-24 flex-col items-center justify-center gap-2 rounded-2xl border border-dashed text-sm font-medium"><Images className="h-6 w-6" /> Image / PDF</button></div> : <section className="overflow-hidden rounded-2xl border border-border"><div className="relative bg-muted">{file.type === 'application/pdf' ? <div className="flex h-32 flex-col items-center justify-center"><FileText className="h-8 w-8" /><p className="mt-2 text-xs">{file.name}</p></div> : <img src={preview} alt="Receipt preview" className="h-48 w-full object-contain" />}<button type="button" onClick={() => { setFile(null); setOcr(null) }} className="absolute right-2 top-2 flex h-9 w-9 items-center justify-center rounded-full bg-black/70 text-white"><Trash2 className="h-4 w-4" /></button></div><div className="p-3"><Button type="button" className="w-full" onClick={scan} disabled={scanning}>{scanning ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ScanLine className="mr-2 h-4 w-4" />}{scanning ? progress?.message || 'Scanning…' : ocr ? 'Scan again' : 'Run receipt OCR'}</Button>{progress ? <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full bg-primary" style={{ width: `${Math.round((progress.progress || 0) * 100)}%` }} /></div> : null}</div></section>}
    {ocr ? <><section className="rounded-2xl border border-border bg-card p-3"><div className="flex items-center justify-between"><p className="text-sm font-semibold">Review detected fields</p><span className={`rounded-full px-2 py-1 text-[10px] font-semibold ${ocr.confidence >= 80 ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>{Math.round(ocr.confidence)}% OCR</span></div>{ocr.parsed.warnings.length ? <div className="mt-3 rounded-xl bg-amber-50 p-3 text-xs text-amber-800">{ocr.parsed.warnings.map((warning) => <p key={warning}>• {warning}</p>)}</div> : null}<div className="mt-3 grid gap-3 sm:grid-cols-2"><Field label="Supplier" value={draft.source} onChange={(v) => setDraft({ ...draft, source: v })} /><Field label="Receipt date" type="date" value={draft.receipt_date} onChange={(v) => setDraft({ ...draft, receipt_date: v })} /><Field label="Receipt number" value={draft.receipt_number} onChange={(v) => setDraft({ ...draft, receipt_number: v })} /><Field label="Total amount (RM)" type="number" value={draft.amount} onChange={(v) => setDraft({ ...draft, amount: v })} /><div><Label>Payment method</Label><select className="mt-2 h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={draft.payment_method} onChange={(e) => setDraft({ ...draft, payment_method: e.target.value })}><option value="">Confirm method</option><option value="cash">Cash</option><option value="card">Card</option><option value="duitnow">DuitNow</option><option value="touch_n_go">Touch ’n Go</option><option value="grabpay">GrabPay</option><option value="bank_transfer">Bank transfer</option><option value="other">Other</option></select></div><Field label="Category" value={draft.category} onChange={(v) => setDraft({ ...draft, category: v })} /></div><div className="mt-3"><Label>Description</Label><Input className="mt-2" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></div><div className="mt-3"><Label>Review note</Label><Textarea className="mt-2" value={draft.notesText} onChange={(e) => setDraft({ ...draft, notesText: e.target.value })} /></div></section><Button type="submit" className="h-11 w-full" disabled={saving}>{saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <UploadCloud className="mr-2 h-4 w-4" />}{saving ? 'Uploading and saving…' : 'Save reviewed receipt'}</Button></> : null}
    {error ? <p className="rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}
  </form>
}
function Field({ label, value, onChange, type = 'text' }) { return <div><Label>{label}</Label><Input className="mt-2" type={type} value={value} onChange={(e) => onChange(e.target.value)} /></div> }
