export const LABEL_SETTINGS_STAFF_VERSION = '4.6.15-label-settings-staff-v17'

let installed = false
let scheduled = false

function applyLatestWorkspaceLayout() {
  scheduled = false
  const workspace = document.querySelector('[data-printer-workspace]')
  if (!workspace) return

  // The responsive workspace stylesheet was originally anchored to max-w-6xl.
  // The page later moved to max-w-7xl without updating those selectors, causing
  // Web browsers to fall back to the first-generation stacked form. Keep both
  // classes so the intended responsive layout applies on Web and APK equally.
  workspace.classList.add('max-w-6xl')
  workspace.dataset.printerWorkspace = LABEL_SETTINGS_STAFF_VERSION

  const heading = workspace.querySelector('h1')
  const header = heading?.closest('header')
  if (header && !header.querySelector('[data-label-settings-staff-badge]')) {
    const badge = document.createElement('span')
    badge.dataset.labelSettingsStaffBadge = 'true'
    badge.className = 'inline-flex items-center rounded-full bg-emerald-100 px-2.5 py-1 text-[10px] font-bold text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200'
    badge.textContent = 'All staff access · Stable TSPL v16'
    heading.parentElement?.appendChild(badge)
  }
}

function schedule() {
  if (scheduled) return
  scheduled = true
  window.requestAnimationFrame(applyLatestWorkspaceLayout)
}

export function installLabelSettingsStaffV17() {
  if (installed || typeof window === 'undefined') return
  installed = true

  const start = () => {
    schedule()
    const observer = new MutationObserver(schedule)
    observer.observe(document.body, { childList: true, subtree: true })
    window.addEventListener('popstate', schedule)
    window.addEventListener('pageshow', schedule)
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true })
  else start()
}
