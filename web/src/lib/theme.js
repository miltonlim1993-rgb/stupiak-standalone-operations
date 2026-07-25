const THEME_KEY = 'stupiaks-ops-theme'
const DEFAULT_THEME = 'light'

export function getStoredTheme() {
  return DEFAULT_THEME
}

export function resolveTheme() {
  return DEFAULT_THEME
}

export function applyTheme() {
  const root = document.documentElement

  localStorage.setItem(THEME_KEY, DEFAULT_THEME)
  root.classList.remove('dark')
  root.dataset.theme = DEFAULT_THEME
  root.style.colorScheme = 'light'

  const themeMeta = document.querySelector('meta[name="theme-color"]')
  if (themeMeta) themeMeta.setAttribute('content', '#F6B900')

  const colorSchemeMeta = document.querySelector('meta[name="color-scheme"]')
  if (colorSchemeMeta) colorSchemeMeta.setAttribute('content', 'light')

  return DEFAULT_THEME
}

export function saveTheme() {
  applyTheme()
}

export function watchSystemTheme() {
  return () => undefined
}
