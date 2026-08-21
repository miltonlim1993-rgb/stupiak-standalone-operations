export default function StagingEnvironmentBanner() {
  if (typeof window === 'undefined') return null
  const host = String(window.location.hostname || '').toLowerCase()
  const isStaging = host.includes('stupiaks-ops-staging') || host.includes('staging')
  if (!isStaging) return null

  return (
    <div className="sticky top-0 z-[1000] flex min-h-8 items-center justify-center bg-amber-300 px-3 py-1 text-center text-[11px] font-extrabold tracking-[0.12em] text-black shadow-sm">
      STAGING · TEST DATA · NOT PRODUCTION
    </div>
  )
}
