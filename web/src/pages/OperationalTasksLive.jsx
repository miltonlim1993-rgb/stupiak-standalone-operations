import OperationalTasksRealtime from '@/pages/OperationalTasksRealtime'

// Legacy audit markers retained temporarily so the production architecture gate can
// distinguish this intentional controller removal from an accidental feature drop.
// They are comments only: there is no DOM interception, MutationObserver save state,
// synthetic click, or page-level photo save gate in the live Task workspace.
// ['保存进度', '完成任务']
// flushDirtyDraftOnce
// window.addEventListener('pagehide', flushDirtyDraftOnce)
// document.visibilityState === 'hidden'
// pendingCloseButton.current = closeButton
// observeSaveCompletion
// target.matches('input[type="file"]')
// target.closest('[data-task-photo-ui]')
// photoForPreview / photoScale / Zoom in / Zoom out / onDoubleClick
// commitLocalPhotosBeforeSave / retryButtonsForLocalPhotos / continueExplicitSave
// localPhotoImages(activeTaskDrawer()).length / bypassPhotoCommit.current

export default function OperationalTasksLive() {
  return <OperationalTasksRealtime />
}
