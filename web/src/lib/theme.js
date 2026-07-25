const THEME_KEY = 'stupiaks-ops-theme'
const DEFAULT_THEME = 'light'

export function getStoredTheme() {
  const value = localStorage.getItem(THEME_KEY)
  return ['light', 'dark', 'system'].includes(value) ? value : DEFAULT_THEME
}

export function resolveTheme(theme = getStoredTheme()) {
  if (theme === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  return theme
}

export function applyTheme(theme = getStoredTheme()) {
  const selected = ['light', 'dark', 'system'].includes(theme) ? theme : DEFAULT_THEME
  const resolved = resolveTheme(selected)
  const root = document.documentElement

  root.classList.toggle('dark', resolved === 'dark')
  root.dataset.theme = selected
  root.style.colorScheme = resolved

  if (!localStorage.getItem(THEME_KEY)) {
    localStorage.setItem(THEME_KEY, DEFAULT_THEME)
  }

  const themeMeta = document.querySelector('meta[name="theme-color"]')
  if (themeMeta) themeMeta.setAttribute('content', resolved === 'dark' ? '#090909' : '#F6B900')

  return resolved
}

export function saveTheme(theme) {
  localStorage.setItem(THEME_KEY, theme)
  applyTheme(theme)
}

export function watchSystemTheme(callback) {
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  const listener = () => {
    if (getStoredTheme() === 'system') {
      applyTheme('system')
      callback?.()
    }
  }
  media.addEventListener?.('change', listener)
  return () => media.removeEventListener?.('change', listener)
}
