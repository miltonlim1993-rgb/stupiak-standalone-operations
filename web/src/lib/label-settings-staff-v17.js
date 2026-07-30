export const LABEL_SETTINGS_STAFF_VERSION = '4.6.23-single-settings-icon-v25'

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
  badge.textContent = 'All staff access · Windows Queue + Direct IP'
  heading.parentElement?.appendChild(badge)
}

function exposeSingleFoodLabelShortcut() {
  if (window.location.pathname !== '/labels') return
  const toolbar = document.querySelector('.chefops-labels-toolbar')
  if (!toolbar) return
  const actionRow = toolbar.querySelector(':scope > div:first-child > div:last-child')
  if (!actionRow) return

  // Managers already receive the React icon button. Only add one icon for staff when it is absent.
  if (actionRow.querySelector('a[href="/labels/settings"]')) return

  const link = document.createElement('a')
  link.href = '/labels/settings'
  link.dataset.staffLabelSettingsLink = 'true'
  link.className = 'inline-flex h-9 w-9 items-center justify-center rounded-md border border-input bg-background p-0 shadow-sm hover:bg-accent hover:text-accent-foreground'
  link.setAttribute('aria-label', 'Label settings')
  link.setAttribute('title', 'Label settings')
  link.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 21v-7"/><path d="M4 10V3"/><path d="M12 21v-9"/><path d="M12 8V3"/><path d="M20 21v-5"/><path d="M20 12V3"/><path d="M1 14h6"/><path d="M9 8h6"/><path d="M17 16h6"/></svg>'
  actionRow.insertBefore(link, actionRow.firstChild)
}

function apply() {
  scheduled = false
  markCurrentWorkspace()
  exposeSingleFoodLabelShortcut()
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
