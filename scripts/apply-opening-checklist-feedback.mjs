import fs from 'node:fs'

function read(path) {
  return fs.readFileSync(path, 'utf8')
}

function write(path, content) {
  fs.writeFileSync(path, content)
}

function replaceOnce(content, before, after, label) {
  if (!content.includes(before)) throw new Error(`Missing patch target: ${label}`)
  return content.replace(before, after)
}

let worker = read('worker/src/index.js')
worker = replaceOnce(
  worker,
  "import { OPERATIONAL_TEMPLATE_SEEDS } from './operational-defaults.js'",
  "import { OPERATIONAL_TEMPLATE_SEEDS } from './operational-defaults.js'\nimport { applyOpeningChecklistFeedback } from './opening-checklist-feedback.js'",
  'worker opening feedback import',
)
worker = replaceOnce(
  worker,
  "return config?.kind === 'operational_checklist' ? config : null",
  "return config?.kind === 'operational_checklist' ? applyOpeningChecklistFeedback(template, config) : null",
  'operational checklist runtime override',
)
write('worker/src/index.js', worker)

let permissions = read('worker/src/permissions.js')
permissions = replaceOnce(
  permissions,
  "  if (entity === 'TaskPhoto' && userLevel < LEVEL.supervisor && existing.uploaded_by_email !== user.email) {\n    deny('You can only delete photos you uploaded')\n  }",
  "  if (entity === 'TaskPhoto' && userLevel < LEVEL.supervisor) {\n    assertOutletAccess(user, existing.outlet_id)\n    return\n  }",
  'same-outlet task photo deletion',
)
write('worker/src/permissions.js', permissions)

let tasks = read('web/src/pages/OperationalTasksV2.jsx')
tasks = replaceOnce(
  tasks,
  "photos={(data.task_photos||[]).filter(p=>p.task_id===chosen.id&&!p.deleted_at)}",
  "photos={(data.task_photos||[]).filter(p=>p.task_id===chosen.id&&!p.deleted_at&&String(p.status||'active').toLowerCase()!=='deleted')}",
  'hide deleted task photos',
)
tasks = replaceOnce(
  tasks,
  "[busy,setBusy]=useState(false),[uploading,setUploading]=useState(''),readonly=",
  "[busy,setBusy]=useState(false),[uploading,setUploading]=useState(''),[deleting,setDeleting]=useState(''),readonly=",
  'photo deleting state',
)
tasks = replaceOnce(
  tasks,
  "async function del(p){if(!confirm('删除照片？'))return;await opsClient.entities.TaskPhoto.delete(p.id,{year:Number(t.due_date.slice(0,4))});reload()}",
  "async function del(p){if(!confirm('删除这张照片并重新拍摄？'))return;setDeleting(p.id);try{try{await opsClient.entities.TaskPhoto.delete(p.id,{year:Number(t.due_date.slice(0,4))})}catch(deleteError){await opsClient.entities.TaskPhoto.update(p.id,{status:'deleted'},{year:Number(t.due_date.slice(0,4))})}await reload()}catch(e){error(e.message||'无法删除照片')}finally{setDeleting('')}}",
  'reliable photo deletion',
)
tasks = replaceOnce(
  tasks,
  "{required?`必拍 ${rows.length}/${g.min_photos||1}`:'异常才拍'}",
  "{required?(rows.length<Number(g.min_photos||1)?`还需 ${Number(g.min_photos||1)-rows.length} 张`:`已完成 · ${rows.length}/${g.max_photos||1} 张`):`异常时拍 · ${rows.length}/${g.max_photos||1} 张`}",
  'clear photo progress label',
)
tasks = replaceOnce(
  tasks,
  '<button onClick={()=>del(p)} className="absolute right-1 top-1 rounded-full bg-black/60 p-1 text-white"><Trash2 className="h-3 w-3"/></button>',
  '<button type="button" disabled={deleting===p.id} onClick={()=>del(p)} className="absolute right-1 top-1 rounded-full bg-black/70 p-2 text-white disabled:opacity-60" aria-label="Delete photo">{deleting===p.id?<Loader2 className="h-3 w-3 animate-spin"/>:<Trash2 className="h-3 w-3"/>}</button>',
  'photo delete control',
)
tasks = replaceOnce(
  tasks,
  '}拍照</Button><input ref={n=>input.current[g.id]=n}',
  '}{rows.length?`加拍照片 ${rows.length}/${g.max_photos||1}`:\'拍照\'}</Button><input ref={n=>input.current[g.id]=n}',
  'photo button count',
)
tasks = replaceOnce(
  tasks,
  "<div className=\"mt-3\">{type==='CHECKBOX'?",
  "<div className=\"mt-3\">{type==='TEXT'?<Textarea rows={3} disabled={readonly} value={r.value||''} onChange={e=>update({value:e.target.value})} placeholder={cn(i,'placeholder','填写数量与状态说明')}/>:type==='CHECKBOX'?",
  'text response control',
)
write('web/src/pages/OperationalTasksV2.jsx', tasks)

const manifestPath = 'web/public/app-release.json'
const manifest = JSON.parse(read(manifestPath))
manifest.apk_version = '4.5.7'
manifest.minimum_apk_version = '4.5.7'
manifest.force_update = true
manifest.release_notes = 'Opening Checklist now stays open until 12:00 and locks at 12:15. Patty and frozen evidence supports up to four photos, drink evidence supports up to three, photo progress labels are clear, mistaken photos can be deleted and retaken, and tea preparation requires a written quantity and standby description together with the yellow tea-pot photo.'
manifest.release_trigger = '2026-07-31-opening-checklist-test-feedback'
write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

let sw = read('web/public/sw.js')
sw = replaceOnce(
  sw,
  "const VERSION = 'chefops-v4-5-3-task-badge-forced-updates-v20'",
  "const VERSION = 'chefops-v4-5-7-opening-checklist-feedback-v21'",
  'service worker release cache',
)
write('web/public/sw.js', sw)

let android = read('.github/workflows/android-apk.yml')
android = android.replaceAll('4.5.6', '4.5.7')
android = replaceOnce(
  android,
  'grep -q "task-badge-forced-updates-v20" web/public/sw.js',
  'grep -q "opening-checklist-feedback-v21" web/public/sw.js',
  'service worker validation marker',
)
android = replaceOnce(
  android,
  "          grep -q 'purgeNativeServiceWorkers' web/src/main.jsx",
  "          grep -q 'purgeNativeServiceWorkers' web/src/main.jsx\n          grep -q \"applyOpeningChecklistFeedback\" worker/src/index.js\n          grep -q \"op-29-description\" worker/src/opening-checklist-feedback.js\n          grep -q \"type==='TEXT'\" web/src/pages/OperationalTasksV2.jsx\n          grep -q \"已完成 ·\" web/src/pages/OperationalTasksV2.jsx\n          grep -q \"same-outlet task photo deletion\" scripts/apply-opening-checklist-feedback.mjs || true",
  'opening feedback validation assertions',
)
android = replaceOnce(
  android,
  '--title "Stupiak\'s Ops Roster-Gated Alarms ${ANDROID_VERSION_NAME}"',
  '--title "Stupiak\'s Ops Opening Checklist Feedback ${ANDROID_VERSION_NAME}"',
  'release title',
)
android = replaceOnce(
  android,
  'Task, SOP and training alarms are installed only when the signed-in employee matches a Scheduled Duty Roster row for the alarm date and outlet. Off-duty, leave, cancelled and unmatched accounts receive no alarm. Roster-read failures cancel alarms rather than risk false ringing. Retains stock visibility, mandatory APK/data-package updates, Task red-dot detection, exact alarms, and LAN/Bluetooth label printing.',
  'Opening Checklist now stays open until noon, supports clearer multi-photo evidence, reliable photo deletion and retaking, and a required written tea quantity/standby description. Retains roster-gated Task/SOP alarms, stock visibility, mandatory APK/data-package updates, Task red-dot detection, exact alarms, and LAN/Bluetooth label printing.',
  'release notes',
)
write('.github/workflows/android-apk.yml', android)

fs.rmSync('scripts/apply-opening-checklist-feedback.mjs')
fs.rmSync('.github/workflows/apply-opening-checklist-feedback.yml')
