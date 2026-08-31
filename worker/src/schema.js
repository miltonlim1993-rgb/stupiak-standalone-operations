export const COMMON_FIELDS = [
  'id',
  'outlet_id',
  'created_date',
  'created_by',
  'updated_date',
  'updated_by',
  'deleted_at',
  'version',
]

export const ENTITY_SCHEMAS = {
  User: {
    storage: 'master',
    sheet: 'Users',
    fields: [
      'google_sub', 'email', 'full_name', 'avatar_url', 'role', 'phone',
      'department', 'status', 'last_login_at', 'outlet_ids',
      'name_confirmed', 'name_confirmed_at', 'name_updated_at',
      'principal_type', 'capabilities_json',
    ],
    numberFields: [],
    booleanFields: ['name_confirmed'],
  },
  Outlet: {
    storage: 'master',
    sheet: 'Outlets',
    fields: ['name', 'code', 'address', 'status', 'timezone'],
  },
  InventoryItem: {
    storage: 'master',
    sheet: 'InventoryItems',
    fields: [
      'item_name', 'category', 'current_qty', 'min_threshold', 'unit',
      'cost_per_unit', 'supplier', 'last_counted_date', 'status',
    ],
    numberFields: ['current_qty', 'min_threshold', 'cost_per_unit', 'source_order'],
    booleanFields: ['enabled'],
    readLastColumn: 'AE',
  },
  InventoryCatalog: {
    storage: 'master',
    sheet: 'InventoryCatalog',
    fields: [],
    headers: [
      'item_id', 'item_name', 'default_category', 'default_count_uom',
      'default_purchase_uom', 'default_units_per_purchase_uom',
      'global_enabled', 'created_at', 'updated_at', 'notes',
    ],
    idField: 'item_id',
    numberFields: ['default_units_per_purchase_uom'],
    booleanFields: ['global_enabled'],
    readOnly: true,
  },
  OutletStockList: {
    storage: 'master',
    sheet: 'OutletStockLists',
    fields: [],
    headers: [
      'stock_list_id', 'outlet_id', 'item_id', 'item_name', 'enabled',
      'section', 'display_order', 'category', 'count_uom', 'purchase_uom',
      'units_per_purchase_uom', 'minimum_qty', 'target_qty',
      'minimum_order_qty', 'uom_setup_status', 'notes', 'legacy_inventory_id',
      'created_at', 'updated_at',
    ],
    idField: 'stock_list_id',
    numberFields: [
      'display_order', 'units_per_purchase_uom', 'minimum_qty',
      'target_qty', 'minimum_order_qty',
    ],
    booleanFields: ['enabled'],
    readOnly: true,
  },
  TaskTemplate: {
    storage: 'master',
    sheet: 'TaskTemplates',
    fields: [
      'name', 'title', 'description', 'category', 'priority', 'status',
      'assigned_to_role', 'assigned_to_user_id', 'due_time', 'marks',
      'penalty', 'recurrence_rule', 'is_active', 'outlet_ids', 'station',
      'period', 'photo_required', 'sop_id', 'display_order', 'checklist_mode',
      'estimated_minutes', 'instructions',
    ],
    numberFields: ['marks', 'penalty', 'display_order', 'estimated_minutes'],
    booleanFields: ['is_active', 'photo_required'],
  },
  TaskTemplatePhoto: {
    storage: 'master',
    sheet: 'TaskTemplatePhotos',
    fields: [
      'template_id', 'display_order', 'photo_type', 'drive_file_id',
      'file_name', 'file_url', 'caption', 'enabled',
    ],
    numberFields: ['display_order'],
    booleanFields: ['enabled'],
  },
  AppSetting: {
    storage: 'master',
    sheet: 'AppSettings',
    fields: ['key', 'value', 'category', 'description', 'is_configured'],
    booleanFields: ['is_configured'],
  },
  MediaRule: {
    storage: 'master',
    sheet: 'MediaRules',
    fields: [
      'module', 'max_files', 'allowed_media', 'capture_mode',
      'watermark_mode', 'max_file_mb', 'active', 'notes',
    ],
    numberFields: ['max_files', 'max_file_mb'],
    booleanFields: ['active'],
  },
  Notification: {
    storage: 'master',
    sheet: 'Notifications',
    fields: [
      'recipient_user_id', 'recipient_email', 'recipient_name', 'title',
      'message', 'target_page', 'entity_type', 'entity_id', 'status',
      'read_at', 'pushed_by_name', 'pushed_by_email', 'expires_at',
      'priority', 'action_label', 'metadata_json',
    ],
  },
  PaymentMethod: {
    storage: 'master',
    sheet: 'PaymentMethods',
    fields: [
      'code', 'name', 'icon', 'color', 'category', 'display_order',
      'active', 'requires_reference', 'notes',
    ],
    numberFields: ['display_order'],
    booleanFields: ['active', 'requires_reference'],
  },
  PositionMaster: {
    storage: 'master',
    sheet: 'PositionMaster',
    fields: [
      'code', 'name', 'short_name', 'icon', 'pattern', 'color',
      'display_order', 'active', 'notes',
    ],
    numberFields: ['display_order'],
    booleanFields: ['active'],
  },
  DeviceRegistration: {
    storage: 'master',
    sheet: 'DeviceRegistrations',
    fields: [
      'user_id', 'user_email', 'user_name', 'device_id', 'platform',
      'app_version', 'notification_permission', 'push_endpoint',
      'push_subscription_json', 'last_active_at', 'status',
    ],
  },
  PrinterProfile: {
    storage: 'master',
    sheet: 'PrinterProfiles',
    fields: [
      'purpose', 'profile_name', 'brand', 'model', 'connection_type',
      'command_language', 'ip_address', 'port', 'bluetooth_mode',
      'bluetooth_device_name', 'bluetooth_device_id', 'label_width_mm',
      'label_height_mm', 'dpi', 'default_copies', 'auto_print',
      'standby_enabled', 'auto_reconnect', 'queue_when_offline',
      'retry_limit', 'is_default', 'enabled', 'station_mode',
      'station_device_name', 'notes',
    ],
    numberFields: [
      'port', 'label_width_mm', 'label_height_mm', 'dpi',
      'default_copies', 'retry_limit',
    ],
    booleanFields: [
      'auto_print', 'standby_enabled', 'auto_reconnect',
      'queue_when_offline', 'is_default', 'enabled',
    ],
  },
  Task: {
    storage: 'operations',
    partitionField: 'due_date',
    sheet: 'Tasks',
    fields: [
      'title', 'description', 'category', 'priority', 'status',
      'assigned_to_role', 'assigned_to_user_id', 'assigned_to_name',
      'due_date', 'due_time', 'marks', 'penalty', 'is_followup',
      'parent_task_id', 'completed_date', 'completed_by_name', 'notes',
      'template_id', 'recurrence_rule', 'photo_required',
      'reference_photo_url', 'reference_drive_file_id', 'reference_file_name',
      'completion_photo_url', 'completion_drive_file_id', 'completion_file_name',
      'completion_notes', 'completed_by_email', 'created_by_name', 'station',
      'period', 'sop_id', 'template_version',
    ],
    numberFields: ['marks', 'penalty', 'template_version'],
    booleanFields: ['is_followup', 'photo_required'],
  },
  TaskPhoto: {
    storage: 'operations',
    partitionField: 'created_date',
    sheet: 'TaskPhotos',
    fields: [
      'task_id', 'template_id', 'photo_type', 'display_order', 'drive_file_id',
      'file_name', 'file_url', 'caption', 'uploaded_by_name',
      'uploaded_by_email', 'uploaded_at', 'status', 'mime_type', 'file_size',
      'captured_at', 'watermark_text', 'draft_id',
    ],
    numberFields: ['display_order', 'file_size'],
  },
  Attendance: {
    storage: 'operations',
    partitionField: 'date',
    sheet: 'Attendance',
    fields: ['staff_name', 'staff_role', 'date', 'clock_in', 'clock_out', 'status', 'hours_worked', 'notes'],
    numberFields: ['hours_worked'],
  },
  StockCount: {
    storage: 'operations',
    partitionField: 'count_date',
    sheet: 'StockCounts',
    fields: [
      'item_name', 'category', 'expected_qty', 'actual_qty', 'unit',
      'variance', 'count_date', 'counted_by', 'status',
      'submitted_to_whatsapp', 'submitted_to_erp', 'notes', 'counted_by_email',
      'stock_list_id', 'item_id',
    ],
    numberFields: ['expected_qty', 'actual_qty', 'variance'],
    nullableNumberFields: ['expected_qty'],
    booleanFields: ['submitted_to_whatsapp', 'submitted_to_erp'],
  },
  UrgentIssue: {
    storage: 'operations',
    partitionField: 'due_date',
    sheet: 'UrgentIssues',
    fields: [
      'title', 'description', 'priority', 'category', 'assigned_to_role',
      'assigned_to_user_id', 'assigned_to_name', 'status', 'resolved_date',
      'followup_notes', 'due_date',
    ],
  },
  Receipt: {
    storage: 'operations',
    partitionField: 'receipt_date',
    sheet: 'Receipts',
    fields: [
      'receipt_date', 'receipt_number', 'source', 'amount', 'description',
      'category', 'payment_method', 'raw_data', 'image_url', 'drive_file_id',
      'file_name', 'mime_type', 'file_size', 'notes',
    ],
    numberFields: ['amount', 'file_size'],
  },
  CloseUp: {
    storage: 'operations',
    partitionField: 'business_date',
    sheet: 'CloseUps',
    fields: [
      'business_date', 'shift_id', 'shift_name', 'opening_float',
      'expected_cash', 'actual_cash', 'cash_variance', 'expected_sales',
      'payment_total', 'total_variance', 'payments_json',
      'denominations_json', 'notes', 'status', 'submitted_by_name',
      'submitted_by_email', 'submitted_at', 'sync_status', 'sync_attempts',
      'last_sync_at', 'last_sync_error', 'external_sync_key',
      'external_response_json', 'event_key', 'handover_sequence',
      'outgoing_cash', 'incoming_cash', 'handover_variance',
      'from_staff', 'to_staff', 'outgoing_denominations_json',
      'incoming_denominations_json',
      'authority_contract', 'authority_role', 'logical_key', 'root_close_id',
      'correction_of_id', 'correction_sequence', 'correction_reason',
      'expected_basis_id', 'expected_basis_digest', 'expected_source_identity',
      'expected_channels', 'expected_channels_total', 'count_identity',
      'denominations', 'actual_channels', 'payment_variance', 'variance_reason',
      'custody', 'submitted_by_user_id', 'review', 'completed_at',
      'corrected_by_user_id', 'corrected_by_email', 'corrected_by_name', 'corrected_at',
    ],
    numberFields: [
      'opening_float', 'expected_cash', 'actual_cash', 'cash_variance',
      'expected_sales', 'payment_total', 'total_variance', 'sync_attempts',
      'handover_sequence', 'outgoing_cash', 'incoming_cash', 'handover_variance',
    ],
  },
  FoodLabel: {
    storage: 'operations',
    partitionField: 'prep_date',
    sheet: 'FoodLabels',
    fields: [
      'item_name', 'prep_date', 'expiry_date', 'serial_batch', 'barcode',
      'storage_condition', 'allergens', 'weight', 'quantity', 'notes',
      'initial_print_quantity', 'total_reprint_quantity', 'reprint_count',
      'printer_name', 'printed_at', 'printed_by_user_id', 'printed_by_name',
      'last_reprinted_at', 'last_reprinted_by_user_id', 'last_reprinted_by_name',
      'last_reprint_reason', 'last_reprint_note',
    ],
    numberFields: ['quantity', 'initial_print_quantity', 'total_reprint_quantity', 'reprint_count'],
  },
  LabelPrintLog: {
    storage: 'operations',
    partitionField: 'printed_at',
    sheet: 'LabelPrintLogs',
    fields: [
      'label_id', 'original_label_id', 'batch_code', 'barcode',
      'print_action', 'print_quantity', 'reprint_reason', 'reprint_note',
      'printer_name', 'printed_at', 'printed_by_user_id', 'printed_by_name',
      'printed_by_email', 'source_deduction_qty', 'approval_status',
    ],
    numberFields: ['print_quantity', 'source_deduction_qty'],
  },
  AuditLog: {
    storage: 'operations',
    partitionField: 'created_date',
    sheet: 'AuditLogs',
    fields: ['actor_sub', 'actor_email', 'action', 'entity', 'entity_id', 'summary', 'payload_json', 'actor_name'],
  },

  SOP: {
    storage: 'training',
    sheet: 'SOPs',
    headers: [
      'id', 'outlet_ids', 'created_date', 'created_by', 'updated_date',
      'updated_by', 'deleted_at', 'version', 'sop_code', 'title', 'category',
      'department', 'station', 'language', 'summary', 'purpose', 'scope',
      'safety_notes', 'owner_role', 'version_label', 'effective_date',
      'review_date', 'required_roles', 'active', 'source_document_url',
      'source_reference',
    ],
    fields: [],
    numberFields: ['version'],
    booleanFields: ['active'],
  },
  SOPStep: {
    storage: 'training',
    sheet: 'SOPSteps',
    headers: [
      'id', 'sop_id', 'step_order', 'section_title', 'step_title',
      'instruction', 'warning', 'quality_check', 'estimated_minutes', 'active',
    ],
    fields: [],
    numberFields: ['step_order', 'estimated_minutes'],
    booleanFields: ['active'],
  },
  SOPAsset: {
    storage: 'training',
    sheet: 'SOPAssets',
    headers: [
      'id', 'sop_id', 'lesson_id', 'asset_type', 'display_order',
      'drive_file_id', 'file_name', 'file_url', 'caption', 'thumbnail_url', 'active', 'step_id',
    ],
    fields: [],
    numberFields: ['display_order'],
    booleanFields: ['active'],
  },
  TrainingCourse: {
    storage: 'training',
    sheet: 'TrainingCourses',
    headers: [
      'id', 'title', 'description', 'category', 'required', 'required_roles',
      'target_outlet_ids', 'active', 'version', 'estimated_minutes',
      'passing_score', 'certificate_valid_days', 'cover_image_url',
      'linked_sop_ids', 'created_at', 'updated_at',
    ],
    fields: [],
    numberFields: ['version', 'estimated_minutes', 'passing_score', 'certificate_valid_days'],
    booleanFields: ['required', 'active'],
  },
  TrainingLesson: {
    storage: 'training',
    sheet: 'TrainingLessons',
    headers: [
      'id', 'course_id', 'lesson_order', 'title', 'lesson_type', 'sop_id',
      'content', 'video_url', 'asset_ids', 'estimated_minutes', 'required', 'active',
    ],
    fields: [],
    numberFields: ['lesson_order', 'estimated_minutes'],
    booleanFields: ['required', 'active'],
  },
  TrainingAssignment: {
    storage: 'training',
    sheet: 'TrainingAssignments',
    headers: [
      'id', 'course_id', 'user_email', 'user_name', 'outlet_id',
      'assigned_by_name', 'assigned_by_email', 'assigned_at', 'due_date',
      'status', 'required',
    ],
    fields: [],
    booleanFields: ['required'],
  },
  TrainingProgress: {
    storage: 'training',
    sheet: 'TrainingProgress',
    headers: [
      'id', 'assignment_id', 'course_id', 'user_email', 'user_name',
      'outlet_id', 'progress_percent', 'current_lesson_id', 'status',
      'started_at', 'completed_at', 'score', 'updated_at',
    ],
    fields: [],
    numberFields: ['progress_percent', 'score'],
  },
  TrainingAcknowledgement: {
    storage: 'training',
    sheet: 'TrainingAcknowledgements',
    headers: [
      'id', 'sop_id', 'user_email', 'user_name', 'outlet_id',
      'acknowledged_version', 'acknowledged_at', 'status',
    ],
    fields: [],
  },
  TrainingQuiz: {
    storage: 'training',
    sheet: 'TrainingQuizzes',
    headers: ['id', 'course_id', 'title', 'passing_score', 'max_attempts', 'active'],
    fields: [],
    numberFields: ['passing_score', 'max_attempts'],
    booleanFields: ['active'],
  },
  TrainingQuestion: {
    storage: 'training',
    sheet: 'TrainingQuestions',
    headers: [
      'id', 'quiz_id', 'question_order', 'question_type', 'question',
      'options_json', 'correct_answer', 'explanation', 'points', 'active',
    ],
    fields: [],
    numberFields: ['question_order', 'points'],
    booleanFields: ['active'],
  },
  TrainingAttempt: {
    storage: 'training',
    sheet: 'TrainingAttempts',
    headers: [
      'id', 'quiz_id', 'course_id', 'user_email', 'user_name', 'outlet_id',
      'score', 'passed', 'answers_json', 'started_at', 'submitted_at',
    ],
    fields: [],
    numberFields: ['score'],
    booleanFields: ['passed'],
  },
}

for (const schema of Object.values(ENTITY_SCHEMAS)) {
  schema.storage ||= 'operations'
  schema.headers ||= [...COMMON_FIELDS, ...(schema.fields || [])]
  schema.numberFields ||= []
  schema.booleanFields ||= []
  schema.nullableNumberFields ||= []
  schema.idField ||= schema.headers.includes('id') ? 'id' : schema.headers[0]
}

export const MASTER_ENTITIES = Object.entries(ENTITY_SCHEMAS)
  .filter(([, schema]) => schema.storage === 'master')
  .map(([entity]) => entity)

export const OPERATIONS_ENTITIES = Object.entries(ENTITY_SCHEMAS)
  .filter(([, schema]) => schema.storage === 'operations')
  .map(([entity]) => entity)

export const TRAINING_ENTITIES = Object.entries(ENTITY_SCHEMAS)
  .filter(([, schema]) => schema.storage === 'training')
  .map(([entity]) => entity)

export const MASTER_SHEET_DEFINITIONS = MASTER_ENTITIES.map((entity) => {
  const schema = ENTITY_SCHEMAS[entity]
  return { entity, title: schema.sheet, headers: schema.headers }
})

export const OPERATIONS_SHEET_DEFINITIONS = OPERATIONS_ENTITIES.map((entity) => {
  const schema = ENTITY_SCHEMAS[entity]
  return { entity, title: schema.sheet, headers: schema.headers }
})

export const TRAINING_SHEET_DEFINITIONS = TRAINING_ENTITIES.map((entity) => {
  const schema = ENTITY_SCHEMAS[entity]
  return { entity, title: schema.sheet, headers: schema.headers }
})

export const SHEET_DEFINITIONS = [
  ...MASTER_SHEET_DEFINITIONS,
  ...OPERATIONS_SHEET_DEFINITIONS,
  ...TRAINING_SHEET_DEFINITIONS,
]

export function getSchema(entity) {
  const schema = ENTITY_SCHEMAS[entity]
  if (!schema) {
    const error = new Error(`Unknown entity: ${entity}`)
    error.status = 404
    error.code = 'unknown_entity'
    throw error
  }
  return schema
}
