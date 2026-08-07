const CAPTURE_EVENT = 'chefops:task-photo-captured'
const CONSUMER_READY_EVENT = 'chefops:task-photo-capture-consumer-ready'

export function publishTaskPhotoCapture(detail = {}) {
  const event = new CustomEvent(CAPTURE_EVENT, {
    detail,
    cancelable: true,
  })
  const unhandled = window.dispatchEvent(event)
  return !unhandled
}

export function subscribeTaskPhotoCapture(listener) {
  const handler = (event) => listener(event)
  window.addEventListener(CAPTURE_EVENT, handler)
  return () => window.removeEventListener(CAPTURE_EVENT, handler)
}

export function announceTaskPhotoCaptureConsumer(taskId = '') {
  window.dispatchEvent(new CustomEvent(CONSUMER_READY_EVENT, {
    detail: { taskId: String(taskId || '') },
  }))
}

export function subscribeTaskPhotoCaptureConsumer(listener) {
  const handler = (event) => listener(event.detail || {})
  window.addEventListener(CONSUMER_READY_EVENT, handler)
  return () => window.removeEventListener(CONSUMER_READY_EVENT, handler)
}
