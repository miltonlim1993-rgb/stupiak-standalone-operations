// Compatibility entrypoint. The state-driven implementation lives in v2 so existing
// imports and deployment routing remain stable while Task saves move to field patches.
export {
  buildTaskProgressPatch,
  handleD1OperationalTaskAction,
  mergeTaskResponsePatches,
} from './realtime-task-action-d1-v2.js'
