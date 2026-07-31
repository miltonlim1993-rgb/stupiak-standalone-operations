const LEVEL = { staff: 1, leader: 2, supervisor: 3, manager: 4, owner: 5 }

const TRAINING_LIBRARY = new Set([
  'SOP', 'SOPStep', 'SOPAsset', 'TrainingCourse', 'TrainingLesson',
  'TrainingQuiz', 'TrainingQuestion',
])
const TRAINING_USER_RECORDS = new Set([
  'TrainingAssignment', 'TrainingProgress', 'TrainingAcknowledgement', 'TrainingAttempt',
])

export function level(role) {
  return LEVEL[role] || 0
}

export function assignedOutletIds(user) {
  const values = [user?.outlet_id]
  const raw = String(user?.outlet_ids || '').trim()
  if (raw) {
    if (raw.startsWith('[')) {
      try {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) values.push(...parsed)
      } catch {
        values.push(...raw.split(','))
      }
    } else {
      values.push(...raw.split(','))
    }
  }
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))]
}

export function canAccessOutlet(user, outletId) {
  if (level(user?.role) >= LEVEL.manager) return true
  const requested = String(outletId || '').trim()
  return Boolean(requested && assignedOutletIds(user).includes(requested))
}

export function assertOutletAccess(user, outletId) {
  if (canAccessOutlet(user, outletId)) return
  const error = new Error('This outlet is not assigned to your account')
  error.status = 403
  error.code = 'wrong_outlet'
  throw error
}

export function assertAssignedOutletAccess(user, outletId) {
  const requested = String(outletId || '').trim()
  const allowed = assignedOutletIds(user)
  if (requested && allowed.includes(requested)) return
  const error = new Error('This outlet is not assigned to your account')
  error.status = 403
  error.code = 'wrong_outlet'
  throw error
}

export function assertReadPermission(user, entity) {
  if (entity === 'Notification') deny('Use the notification API')
  if (entity === 'LabelPrintLog') deny('Use the label printing API')
  if (entity === 'User' && level(user.role) < LEVEL.manager) deny('Only managers can view users')
  if (entity === 'AuditLog' && level(user.role) < LEVEL.manager) deny('Only managers can view audit logs')
  if (entity === 'AppSetting' && level(user.role) < LEVEL.manager) deny('Only managers can view app settings')
}

export function assertCreatePermission(user, entity) {
  if (entity === 'Notification') deny('Use the notification API')
  if (entity === 'LabelPrintLog') deny('Use the label printing API')
  if (['InventoryCatalog', 'OutletStockList'].includes(entity)) deny(`${entity} is managed in ChefOps Master`)
  const minimum = {
    User: LEVEL.manager,
    Outlet: LEVEL.manager,
    Task: LEVEL.leader,
    TaskTemplate: LEVEL.manager,
    TaskTemplatePhoto: LEVEL.manager,
    TaskPhoto: LEVEL.staff,
    InventoryItem: LEVEL.supervisor,
    AppSetting: LEVEL.manager,
    MediaRule: LEVEL.manager,
    PositionMaster: LEVEL.manager,
    PrinterProfile: LEVEL.manager,
    SOP: LEVEL.manager,
    SOPStep: LEVEL.manager,
    SOPAsset: LEVEL.manager,
    TrainingCourse: LEVEL.manager,
    TrainingLesson: LEVEL.manager,
    TrainingAssignment: LEVEL.supervisor,
    TrainingProgress: LEVEL.staff,
    TrainingAcknowledgement: LEVEL.staff,
    TrainingQuiz: LEVEL.manager,
    TrainingQuestion: LEVEL.manager,
    TrainingAttempt: LEVEL.staff,
    AuditLog: 99,
  }[entity] || LEVEL.staff
  if (level(user.role) < minimum) deny(`Your role cannot create ${entity} records`)
}

export function assertUpdatePermission(user, entity, existing, patch) {
  if (entity === 'Notification') deny('Use the notification API')
  if (entity === 'LabelPrintLog') deny('Use the label printing API')
  if (['InventoryCatalog', 'OutletStockList'].includes(entity)) deny(`${entity} is managed in ChefOps Master`)
  const userLevel = level(user.role)
  if (entity === 'User') {
    if (userLevel < LEVEL.manager) deny('Only managers can update users')
    if (patch.role === 'owner' && user.role !== 'owner') deny('Only an owner can grant the owner role')
    if (existing.role === 'owner' && user.role !== 'owner') deny('Only an owner can update another owner')
    return
  }
  if ([
    'Outlet', 'TaskTemplate', 'TaskTemplatePhoto', 'AppSetting', 'MediaRule', 'PositionMaster', 'PrinterProfile',
    'SOP', 'SOPStep', 'SOPAsset', 'TrainingCourse', 'TrainingLesson',
    'TrainingQuiz', 'TrainingQuestion',
  ].includes(entity) && userLevel < LEVEL.manager) deny('Manager access required')
  if (entity === 'TrainingAssignment' && userLevel < LEVEL.supervisor) {
    if (String(existing.user_email || '').toLowerCase() !== String(user.email || '').toLowerCase()) deny('You can only update your own training assignment')
    const allowed = new Set(['status'])
    if (Object.keys(patch).some((key) => !allowed.has(key))) deny('You may only update assignment status')
  }
  if (entity === 'InventoryItem' && userLevel < LEVEL.supervisor) deny('Supervisor access required')
  if (entity === 'Task' && userLevel < LEVEL.supervisor) {
    const allowed = new Set([
      'status', 'completed_date', 'completed_by_name', 'completed_by_email', 'notes',
      'completion_photo_url', 'completion_drive_file_id', 'completion_file_name',
      'completion_notes', 'updated_date', 'updated_by', 'version',
    ])
    if (Object.keys(patch).some((key) => !allowed.has(key))) deny('You may only update task progress')
  }
  if (entity === 'TaskPhoto' && userLevel < LEVEL.supervisor) {
    if (existing.uploaded_by_email && existing.uploaded_by_email !== user.email) deny('You can only update photos you uploaded')
    const allowed = new Set(['caption', 'status'])
    if (Object.keys(patch).some((key) => !allowed.has(key))) deny('You may only update the photo caption or status')
  }
  if (TRAINING_USER_RECORDS.has(entity) && userLevel < LEVEL.supervisor) {
    if (existing.user_email && String(existing.user_email).toLowerCase() !== String(user.email).toLowerCase()) {
      deny('You can only update your own training records')
    }
    if (entity === 'TrainingProgress') {
      const allowed = new Set(['progress_percent', 'current_lesson_id', 'status', 'completed_at', 'score'])
      if (Object.keys(patch).some((key) => !allowed.has(key))) deny('You may only update your own learning progress')
    }
  }
  if (userLevel < LEVEL.supervisor && ['Attendance', 'StockCount', 'UrgentIssue', 'Receipt', 'FoodLabel'].includes(entity)) {
    if (existing.created_by && existing.created_by !== user.email) deny('You can only update records that you created')
  }
}

export function assertDeletePermission(user, entity, existing) {
  if (entity === 'Notification') deny('Use the notification API')
  if (entity === 'LabelPrintLog') deny('Use the label printing API')
  if (['InventoryCatalog', 'OutletStockList'].includes(entity)) deny(`${entity} is managed in ChefOps Master`)
  const userLevel = level(user.role)
  if (entity === 'User' && existing.role === 'owner' && user.role !== 'owner') deny('Only an owner can delete another owner')
  if (entity === 'User' && existing.id === user.id) deny('You cannot delete your own active account')
  if ([
    'User', 'Outlet', 'Task', 'TaskTemplate', 'TaskTemplatePhoto', 'InventoryItem',
    'AppSetting', 'MediaRule', 'SOP', 'SOPStep', 'SOPAsset', 'TrainingCourse',
    'TrainingLesson', 'TrainingAssignment', 'TrainingQuiz', 'TrainingQuestion',
  ].includes(entity) && userLevel < LEVEL.supervisor) deny('Supervisor access required')
  if (entity === 'PrinterProfile' && userLevel < LEVEL.manager) deny('Manager access required')
  if (entity === 'TaskPhoto' && userLevel < LEVEL.supervisor) {
    assertOutletAccess(user, existing.outlet_id)
    return
  }
  if (TRAINING_USER_RECORDS.has(entity) && userLevel < LEVEL.supervisor && existing.user_email !== user.email) {
    deny('You can only delete your own training records')
  }
  if (userLevel < LEVEL.supervisor && existing.created_by && existing.created_by !== user.email) {
    deny('You can only delete records that you created')
  }
}

function applyOutletScope(user, filter) {
  const allowed = assignedOutletIds(user)
  if (!allowed.length) {
    filter.outlet_id = '__NO_ASSIGNED_OUTLET__'
    return filter
  }

  const requestedOutlet = filter.outlet_id
  if (requestedOutlet && typeof requestedOutlet === 'object' && Array.isArray(requestedOutlet.$in)) {
    const permitted = requestedOutlet.$in.map(String).filter((id) => allowed.includes(id))
    filter.outlet_id = permitted.length === 1 ? permitted[0] : { $in: permitted.length ? permitted : ['__NO_ASSIGNED_OUTLET__'] }
    return filter
  }
  if (requestedOutlet != null && requestedOutlet !== '') {
    filter.outlet_id = allowed.includes(String(requestedOutlet)) ? String(requestedOutlet) : '__NO_ASSIGNED_OUTLET__'
    return filter
  }
  filter.outlet_id = allowed.length === 1 ? allowed[0] : { $in: allowed }
  return filter
}

export function scopeFilter(user, entity, requested = {}) {
  const filter = { ...(requested || {}) }
  if (entity === 'User') return filter
  if (TRAINING_LIBRARY.has(entity) || ['TaskTemplate', 'TaskTemplatePhoto', 'PositionMaster', 'PaymentMethod', 'AppSetting', 'MediaRule'].includes(entity)) return filter

  if (TRAINING_USER_RECORDS.has(entity)) {
    if (level(user.role) < LEVEL.supervisor) filter.user_email = user.email
    return applyOutletScope(user, filter)
  }

  const assignmentScoped = ['OutletStockList', 'StockCount', 'Task', 'TaskPhoto'].includes(entity)
  if (!assignmentScoped && level(user.role) >= LEVEL.manager) return filter
  return applyOutletScope(user, filter)
}

function deny(message) {
  const error = new Error(message)
  error.status = 403
  error.code = 'forbidden'
  throw error
}
