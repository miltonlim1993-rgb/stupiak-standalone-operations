import { useEffect } from 'react'

import { opsClient } from '@/api/opsClient'
import { normalizeTaskWorkflowShiftView } from '@/lib/task-shift-view-v3'
import TasksV3 from '@/pages/TasksV3'

if (!opsClient.tasks.__taskShiftViewV3Installed) {
  const originalBootstrap = opsClient.tasks.workflowBootstrap.bind(opsClient.tasks)
  opsClient.tasks.workflowBootstrap = async (options) => normalizeTaskWorkflowShiftView(await originalBootstrap(options))
  Object.defineProperty(opsClient.tasks, '__taskShiftViewV3Installed', { value: true })
}

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
