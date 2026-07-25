import React from 'react'
import ReactDOM from 'react-dom/client'
import App from '@/App.jsx'
import '@/index.css'
import '@/lib/install-prompt'
import { applyTheme } from '@/lib/theme'

applyTheme()

if (window.location.hash === '#/cash' || window.location.hash.startsWith('#/cash?')) {
  const suffix = window.location.hash.includes('?') ? `?${window.location.hash.split('?')[1]}` : window.location.search
  window.history.replaceState({}, '', `/close-up${suffix || ''}`)
}

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then((registration) => {
      registration.update().catch(() => undefined)
    }).catch((error) => console.warn('Service worker registration failed', error))
  })
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />)
