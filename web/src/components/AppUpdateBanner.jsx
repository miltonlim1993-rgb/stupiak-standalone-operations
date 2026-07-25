import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'

export default function AppUpdateBanner() {
  const [registration, setRegistration] = useState(null)
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return undefined
    let active = true
    const inspect = async () => {
      const current = await navigator.serviceWorker.getRegistration()
      if (!current || !active) return
      if (current.waiting) setRegistration(current)
      const onUpdate = () => {
        const worker = current.installing
        if (!worker) return
        worker.addEventListener('statechange', () => { if (worker.state === 'installed' && navigator.serviceWorker.controller) setRegistration(current) })
      }
      current.addEventListener('updatefound', onUpdate)
    }
    inspect()
    return () => { active = false }
  }, [])
  if (!registration) return null
  return <div className="fixed inset-x-3 top-16 z-[90] mx-auto flex max-w-md items-center gap-3 rounded-2xl border border-amber-300 bg-amber-50 p-3 shadow-xl"><RefreshCw className="h-4 w-4 text-amber-700" /><div className="min-w-0 flex-1"><p className="text-sm font-semibold text-amber-900">New app version ready</p><p className="text-xs text-amber-800/75">Reload once to use the latest screens and cached data.</p></div><button type="button" className="rounded-xl bg-amber-900 px-3 py-2 text-xs font-semibold text-white" onClick={() => { registration.waiting?.postMessage({ type: 'SKIP_WAITING' }); window.location.reload() }}>Update</button></div>
}
