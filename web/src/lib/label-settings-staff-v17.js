export const LABEL_SETTINGS_STAFF_VERSION = '4.6.16-label-settings-staff-v18'

let installed = false
let scheduled = false

function markCurrentWorkspace() {
  const workspace = document.querySelector('[data-printer-workspace]')
  if (!workspace) return
  workspace.dataset.staffPrinterAccess = 'true'

  const heading = workspace.querySelector('h1')
  const header = heading?.closest('header')
  if (!header || /all staff/i.test(header.textContent || '') || header.querySelector('[data-label-settings-staff-badge]')) return

  const badge = document.createElement('span')
  badge.dataset.labelSettingsStaffBadge = 'true'
  badge.className = 'inline-flex items-center rounded-full bg-emerald-100 px-2.5 py-1 text-[10px] font-bold text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200'
  badge.textContent = 'All staff access · Web Direct LAN · Stable TSPL v18'
  heading.parentElement?.appendChild(badge)
}

function exposeFoodLabelShortcut() {
  if (window.location.pathname !== '/labels') return
  const toolbar = document.querySelector('.chefops-labels-toolbar')
  if (!toolbar || toolbar.querySelector('[data-staff-label-settings-link]')) return
  const actionRow = toolbar.querySelector(':scope > div:first-child > div:last-child')
  if (!actionRow) return

  const link = document.createElement('a')
  link.href = '/labels/settings'
  link.dataset.staffLabelSettingsLink = 'true'
  link.className = 'inline-flex h-9 items-center justify-center rounded-md border border-input bg-background px-3 text-xs font-semibold shadow-sm hover:bg-accent hover:text-accent-foreground'
  link.setAttribute('aria-label', 'Open Label Printer Settings')
  link.textContent = 'Printer Settings'
  actionRow.insertBefore(link, actionRow.firstChild)
}

function apply() {
  scheduled = false
  markCurrentWorkspace()
  exposeFoodLabelShortcut()
}

function schedule() {
  if (scheduled) return
  scheduled = true
  window.requestAnimationFrame(apply)
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
