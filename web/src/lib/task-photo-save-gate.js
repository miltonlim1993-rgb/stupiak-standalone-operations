export function createTaskPhotoSaveGate({
  getSnapshot,
  subscribe,
  timeoutMs = 60_000,
  setTimer = (callback, delay) => setTimeout(callback, delay),
  clearTimer = (timer) => clearTimeout(timer),
} = {}) {
  if (typeof getSnapshot !== 'function') throw new TypeError('getSnapshot is required')
  if (typeof subscribe !== 'function') throw new TypeError('subscribe is required')

  let inFlight = null
  let cancelActive = null

  const commit = () => {
    if (inFlight) return inFlight

    inFlight = new Promise((resolve) => {
      let settled = false
      let retryTriggered = false
      let retryCleared = false
      let unsubscribe = () => {}
      let timer = null

      const settle = (success) => {
        if (settled) return
        settled = true
        unsubscribe()
        if (timer != null) clearTimer(timer)
        cancelActive = null
        resolve(Boolean(success))
      }

      const inspect = () => {
        if (settled) return
        const snapshot = getSnapshot() || {}
        const localCount = Math.max(0, Number(snapshot.localCount || 0))
        const retryButtons = Array.isArray(snapshot.retryButtons)
          ? snapshot.retryButtons.filter((button) => button && !button.disabled && typeof button.click === 'function')
          : []

        if (localCount === 0) {
          settle(true)
          return
        }

        if (!retryTriggered && retryButtons.length) {
          retryTriggered = true
          retryButtons.forEach((button) => button.click())
          return
        }

        if (!retryTriggered) return
        if (!retryButtons.length) {
          retryCleared = true
          return
        }
        if (retryCleared) settle(false)
      }

      unsubscribe = subscribe(inspect) || (() => {})
      timer = setTimer(() => settle(false), timeoutMs)
      cancelActive = () => settle(false)
      inspect()
    }).finally(() => {
      inFlight = null
    })

    return inFlight
  }

  return {
    commit,
    cancel() {
      cancelActive?.()
    },
    isInFlight() {
      return Boolean(inFlight)
    },
  }
}
