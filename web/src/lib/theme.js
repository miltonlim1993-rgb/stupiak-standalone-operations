const THEME_KEY = 'stupiaks-ops-theme'

export function getStoredTheme() {
  const value = localStorage.getItem(THEME_KEY)
  return ['light', 'dark', 'system'].includes(value) ? value : 'system'
}

export function resolveTheme(theme = getStoredTheme()) {
  if (theme === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  return theme
}

export function applyTheme(theme = getStoredTheme()) {
  const resolved = resolveTheme(theme)
  document.documentElement.classList.toggle('dark', resolved === 'dark')
  document.documentElement.dataset.theme = theme
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
