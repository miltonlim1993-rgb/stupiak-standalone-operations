const CLIENT_ID_KEY = 'chefops.realtime.client-id'

export function getRealtimeClientId() {
  try {
    let value = String(localStorage.getItem(CLIENT_ID_KEY) || '').trim()
    if (!value) {
      value = crypto.randomUUID()
      localStorage.setItem(CLIENT_ID_KEY, value)
    }
    return value
  } catch {
    return crypto.randomUUID()
  }
}
