import { useEffect } from 'react'

import TasksV3 from '@/pages/TasksV3'

export default function TasksV3Page() {
  useEffect(() => {
    const openAdjacentCameraInput = (event) => {
      const button = event.target instanceof Element ? event.target.closest('button') : null
      if (!button || button.disabled) return
      const input = button.nextElementSibling
      if (!(input instanceof HTMLInputElement) || input.type !== 'file' || !input.classList.contains('hidden')) return

      event.preventDefault()
      event.stopPropagation()
      input.click()
    }

    document.addEventListener('click', openAdjacentCameraInput, true)
    return () => document.removeEventListener('click', openAdjacentCameraInput, true)
  }, [])

  return <TasksV3 />
}
