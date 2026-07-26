const CHEFOPS_PACK_DEFAULT_URL = 'https://stupiaks-ops.sporkburger19.workers.dev/api/internal/data-pack/dirty';

const CHEFOPS_PACK_SHEET_MAP = {
  outlet: { entity: 'Outlet', module: 'core' },
  paymentmethod: { entity: 'PaymentMethod', module: 'core' },
  positionmaster: { entity: 'PositionMaster', module: 'core' },
  appsetting: { entity: 'AppSetting', module: 'core' },
  mediarule: { entity: 'MediaRule', module: 'core' },
  inventorycatalog: { entity: 'InventoryCatalog', module: 'inventory' },
  outletstocklist: { entity: 'OutletStockList', module: 'inventory' },
  tasktemplate: { entity: 'TaskTemplate', module: 'tasks' },
  tasktemplatephoto: { entity: 'TaskTemplatePhoto', module: 'tasks' },
  sop: { entity: 'SOP', module: 'training' },
  sopstep: { entity: 'SOPStep', module: 'training' },
  sopasset: { entity: 'SOPAsset', module: 'training' },
  trainingcourse: { entity: 'TrainingCourse', module: 'training' },
  traininglesson: { entity: 'TrainingLesson', module: 'training' },
  trainingquiz: { entity: 'TrainingQuiz', module: 'training' },
  trainingquestion: { entity: 'TrainingQuestion', module: 'training' },
  labelproduct: { entity: 'LabelProduct', module: 'labels' },
  labelrule: { entity: 'LabelRule', module: 'labels' },
  printerprofile: { entity: 'PrinterProfile', module: 'labels' },
};

function chefOpsPackNormalize_(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function chefOpsPackConfig_() {
  const properties = PropertiesService.getScriptProperties();
  const url = String(properties.getProperty('CHEFOPS_PACK_WEBHOOK_URL') || CHEFOPS_PACK_DEFAULT_URL).trim();
  const secret = String(properties.getProperty('CHEFOPS_PACK_WEBHOOK_SECRET') || '').trim();
  if (!secret) throw new Error('Set CHEFOPS_PACK_WEBHOOK_SECRET in Apps Script project properties first.');
  return { url, secret, properties };
}

function chefOpsPackOutletFromRow_(sheet, row) {
  if (!row || row < 2) return '';
  const lastColumn = Math.max(1, sheet.getLastColumn());
  const headers = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0];
  const outletIndex = headers.findIndex((header) => chefOpsPackNormalize_(header) === 'outletid');
  if (outletIndex < 0) return '';
  return String(sheet.getRange(row, outletIndex + 1).getDisplayValue() || '').trim();
}

function chefOpsPackNotify_(payload) {
  const config = chefOpsPackConfig_();
  const outletId = String(payload.outlet_id || '').trim();
  const moduleName = String(payload.module || '').trim();
  const debounceKey = `CHEFOPS_PACK_LAST_${moduleName}_${outletId || 'global'}`;
  const now = Date.now();
  const previous = Number(config.properties.getProperty(debounceKey) || 0);
  if (now - previous < 10000) return { ok: true, skipped: 'debounced' };
  config.properties.setProperty(debounceKey, String(now));

  const response = UrlFetchApp.fetch(config.url, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'X-ChefOps-Pack-Secret': config.secret,
    },
    payload: JSON.stringify({
      ...payload,
      outlet_id: outletId,
      changed_at: new Date().toISOString(),
      source: 'google-sheets-installable-trigger',
    }),
    muteHttpExceptions: true,
  });

  const status = response.getResponseCode();
  const body = response.getContentText();
  if (status < 200 || status >= 300) {
    throw new Error(`ChefOps pack webhook failed (${status}): ${body.slice(0, 500)}`);
  }
  return JSON.parse(body || '{}');
}

function handleChefOpsDataPackEdit(e) {
  if (!e || !e.range) return;
  const sheet = e.range.getSheet();
  const mapping = CHEFOPS_PACK_SHEET_MAP[chefOpsPackNormalize_(sheet.getName())];
  if (!mapping) return;

  chefOpsPackNotify_({
    entity: mapping.entity,
    module: mapping.module,
    outlet_id: chefOpsPackOutletFromRow_(sheet, e.range.getRow()),
    spreadsheet_id: e.source && e.source.getId ? e.source.getId() : '',
    sheet_name: sheet.getName(),
    edited_row: e.range.getRow(),
    edited_column: e.range.getColumn(),
  });
}

function setupChefOpsDataPackNotifier() {
  const spreadsheet = SpreadsheetApp.getActive();
  ScriptApp.getProjectTriggers()
    .filter((trigger) => trigger.getHandlerFunction() === 'handleChefOpsDataPackEdit')
    .forEach((trigger) => ScriptApp.deleteTrigger(trigger));

  ScriptApp.newTrigger('handleChefOpsDataPackEdit')
    .forSpreadsheet(spreadsheet)
    .onEdit()
    .create();

  return `Installed ChefOps data-pack notifier for ${spreadsheet.getName()}`;
}

function testChefOpsDataPackNotifier() {
  return chefOpsPackNotify_({
    entity: 'TaskTemplate',
    module: 'tasks',
    outlet_id: '',
    sheet_name: 'manual-test',
  });
}
