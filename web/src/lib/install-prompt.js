let deferredPrompt = null

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault()
    deferredPrompt = event
    window.dispatchEvent(new CustomEvent('chefops:install-ready'))
  })
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null
    window.dispatchEvent(new CustomEvent('chefops:installed'))
  })
}

export function canPromptInstall() {
  return Boolean(deferredPrompt)
}

export async function promptInstall() {
  if (!deferredPrompt) return { outcome: 'unavailable' }
  const prompt = deferredPrompt
  deferredPrompt = null
  await prompt.prompt()
  return prompt.userChoice
}
