/**
 * Stupiak Standalone Stock Count GAS v2.0.0
 *
 * PURPOSE
 * - Uses the original Excel/Google Sheet layout as the visible UI/data layout.
 * - One template represents one outlet; the frontend never asks staff to choose an outlet.
 * - Creates one new spreadsheet per calendar month inside the configured Drive folder.
 * - Keeps visible sheet order/layout exactly as the template:
 *   Order Page, Inventory, Untensil PG1, Utensil PG2, Stationary.
 * - Submit first; only after a successful submit does the frontend show WhatsApp Send.
 *
 * SCRIPT PROPERTIES
 * Required:
 *   STOCK_MONTHLY_FOLDER_ID      Drive folder that stores this outlet's monthly files
 *   STOCKCOUNT_SECRET           Shared secret used by the frontend (recommended)
 *
 * Optional:
 *   STOCK_TEMPLATE_SPREADSHEET_ID
 *     If blank, the spreadsheet bound to this Apps Script is used as the template.
 *   STOCK_OUTLET_NAME
 *     If blank, outlet is derived from the template spreadsheet file name.
 *   STOCK_FILE_PREFIX           Default: Stock Count
 *   WHATSAPP_PHONE              Optional phone in international digits; leave blank to choose a chat/group manually.
 */

const STOCK_V2_VERSION = '2.0.0';
const STOCK_V2_SCHEMA = 'ORIGINAL_SHEET_LAYOUT_V2';

const STOCK_VISIBLE_SHEETS = [
  'Order Page',
  'Inventory',
  'Untensil PG1',
  'Utensil PG2',
  'Stationary'
];

const STOCK_SUPPORT_SHEETS = {
  submissions: '_Submissions',
  meta: '_Meta'
};

const STOCK_WEEK_COLUMNS = {
  inventory: [
    { index: 1, dateCell: 'B2', primaryCol: 'B', secondaryCol: 'D', statusCol: 'F' },
    { index: 2, dateCell: 'G2', primaryCol: 'G', secondaryCol: 'I', statusCol: 'K' },
    { index: 3, dateCell: 'L2', primaryCol: 'L', secondaryCol: 'N', statusCol: 'P' },
    { index: 4, dateCell: 'Q2', primaryCol: 'Q', secondaryCol: 'S', statusCol: 'U' },
    { index: 5, dateCell: 'V2', primaryCol: 'V', secondaryCol: 'X', statusCol: 'Z' }
  ],
  utensil: [
    { index: 1, dateCell: 'B2', quantityCol: 'B', unitCol: 'C', statusCol: 'D' },
    { index: 2, dateCell: 'E2', quantityCol: 'E', unitCol: 'F', statusCol: 'G' },
    { index: 3, dateCell: 'H2', quantityCol: 'H', unitCol: 'I', statusCol: 'J' },
    { index: 4, dateCell: 'K2', quantityCol: 'K', unitCol: 'L', statusCol: 'M' },
    { index: 5, dateCell: 'N2', quantityCol: 'N', unitCol: 'O', statusCol: 'P' }
  ]
};

const INVENTORY_SECONDARY_ROWS = [11, 13, 14, 15, 25, 26];
const INVENTORY_CONVERSION_BY_ROW = {
  11: 6,
  13: 24,
  14: 24,
  15: 24,
  25: 48,
  26: 4
};

const STOCK_LAYOUT = {
  Inventory: {
    id: 'inventory',
    sheetName: 'Inventory',
    type: 'weekly-inventory',
    rowStart: 4,
    rowEnd: 43,
    minCol: 'AA'
  },
  'Untensil PG1': {
    id: 'utensil-pg1',
    sheetName: 'Untensil PG1',
    type: 'weekly-utensil',
    rowStart: 4,
    rowEnd: 35,
    minCol: 'Q'
  },
  'Utensil PG2': {
    id: 'utensil-pg2',
    sheetName: 'Utensil PG2',
    type: 'weekly-utensil',
    rowStart: 4,
    rowEnd: 38,
    minCol: 'Q'
  },
  Stationary: {
    id: 'stationary',
    sheetName: 'Stationary',
    type: 'monthly-stationary',
    rowStart: 4,
    rowEnd: 22,
    minCol: 'E'
  }
};

const STOCK_SUBMISSION_HEADERS = [
  'Submission ID', 'Saved At', 'Business Date', 'Month Key', 'Week Index',
  'Outlet', 'Counted By', 'Session Note', 'Changed Cell Count', 'Order Count',
  'WhatsApp Opened At', 'Source', 'Source Version'
];

function doGet() {
  try {
    const template = stockTemplateSpreadsheet_();
    return stockJson_({
      ok: true,
      service: 'Stupiak Standalone Stock Count',
      version: STOCK_V2_VERSION,
      schema: STOCK_V2_SCHEMA,
      outlet: stockOutletName_(template),
      templateSpreadsheetId: template.getId(),
      templateSpreadsheetName: template.getName(),
      time: new Date().toISOString()
    });
  } catch (error) {
    return stockJson_({ ok: false, error: stockErrorText_(error) });
  }
}

function doPost(e) {
  let payload = {};
  const lock = LockService.getScriptLock();
  try {
    payload = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    stockValidateSecret_(payload.secret || '');
    lock.waitLock(30000);

    const action = stockText_(payload.action);
    if (action === 'getBootstrap') return stockGetBootstrap_(payload);
    if (action === 'submitStockCount') return stockSubmit_(payload);
    if (action === 'markWhatsAppOpened') return stockMarkWhatsAppOpened_(payload);
    if (action === 'getMonthStatus') return stockGetMonthStatus_(payload);
    throw new Error('Unsupported action: ' + action);
  } catch (error) {
    return stockJson_({ ok: false, error: stockErrorText_(error) });
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

/**
 * Returns all five week columns in the same sequence as the spreadsheet.
 * Frontend rule:
 * - render visible tabs in STOCK_VISIBLE_SHEETS order;
 * - render the item rows without regrouping/reordering;
 * - show all five week blocks horizontally;
 * - only selectedWeek is editable; previous/future weeks are read-only.
 */
function stockGetBootstrap_(payload) {
  const businessDate = stockRequiredDate_(payload.businessDate || stockToday_());
  const target = stockResolveMonthlySpreadsheet_(businessDate, true);
  const weekIndex = stockWeekIndex_(businessDate);
  const spreadsheet = target.spreadsheet;

  stockEnsureVisibleLayout_(spreadsheet);
  stockPrepareSupportSheets_(spreadsheet, target);

  const sections = [
    stockReadInventoryLayout_(spreadsheet, weekIndex),
    stockReadUtensilLayout_(spreadsheet, 'Untensil PG1', weekIndex),
    stockReadUtensilLayout_(spreadsheet, 'Utensil PG2', weekIndex),
    stockReadStationaryLayout_(spreadsheet)
  ];

  return stockJson_({
    ok: true,
    version: STOCK_V2_VERSION,
    schema: STOCK_V2_SCHEMA,
    outlet: target.outlet,
    businessDate: businessDate,
    monthKey: target.monthKey,
    selectedWeek: weekIndex,
    visibleSheetOrder: stockVisibleSheetOrder_(spreadsheet),
    spreadsheetId: target.spreadsheetId,
    spreadsheetName: target.spreadsheetName,
    spreadsheetUrl: target.spreadsheetUrl,
    sections: sections,
    orderPage: stockReadOrderPage_(spreadsheet),
    latestSubmission: stockLatestSubmission_(spreadsheet, businessDate)
  });
}

function stockSubmit_(payload) {
  const submissionId = stockText_(payload.submissionId || payload.idempotencyKey);
  const businessDate = stockRequiredDate_(payload.businessDate);
  const countedBy = stockText_(payload.countedBy || payload.staffName);
  const sessionNote = stockText_(payload.sessionNote || payload.notes);
  const sections = payload.sections || {};

  if (!submissionId) throw new Error('submissionId is required');
  if (!countedBy) throw new Error('countedBy is required');

  const target = stockResolveMonthlySpreadsheet_(businessDate, true);
  const spreadsheet = target.spreadsheet;
  const weekIndex = stockWeekIndex_(businessDate);

  stockEnsureVisibleLayout_(spreadsheet);
  const submissionSheet = stockPrepareSupportSheets_(spreadsheet, target).submissions;

  const existingRow = stockFindSubmissionRow_(submissionSheet, submissionId);
  if (existingRow > 0) {
    const existing = stockSubmissionObject_(submissionSheet, existingRow);
    return stockJson_({
      ok: true,
      duplicate: true,
      submissionId: submissionId,
      outlet: target.outlet,
      businessDate: businessDate,
      monthKey: target.monthKey,
      weekIndex: weekIndex,
      spreadsheetId: target.spreadsheetId,
      spreadsheetName: target.spreadsheetName,
      spreadsheetUrl: target.spreadsheetUrl,
      whatsappMessage: stockBuildWhatsAppMessage_(target, businessDate, weekIndex, countedBy, [], sessionNote),
      whatsappShareUrl: stockWhatsAppUrl_(stockBuildWhatsAppMessage_(target, businessDate, weekIndex, countedBy, [], sessionNote)),
      existingSubmission: existing
    });
  }

  const changes = [];
  const orderItems = [];

  stockWriteInventory_(spreadsheet, weekIndex, businessDate, sections.Inventory || sections.inventory || [], changes, orderItems);
  stockWriteUtensil_(spreadsheet, 'Untensil PG1', weekIndex, businessDate, sections['Untensil PG1'] || sections.utensilPg1 || [], changes, orderItems);
  stockWriteUtensil_(spreadsheet, 'Utensil PG2', weekIndex, businessDate, sections['Utensil PG2'] || sections.utensilPg2 || [], changes, orderItems);
  stockWriteStationary_(spreadsheet, sections.Stationary || sections.stationary || [], changes, orderItems);

  if (!changes.length) throw new Error('No stock values were submitted');

  SpreadsheetApp.flush();

  submissionSheet.appendRow([
    submissionId,
    new Date().toISOString(),
    businessDate,
    target.monthKey,
    weekIndex,
    target.outlet,
    countedBy,
    sessionNote,
    changes.length,
    orderItems.length,
    '',
    'standalone-stock-count-original-layout',
    STOCK_V2_VERSION
  ]);

  const message = stockBuildWhatsAppMessage_(
    target,
    businessDate,
    weekIndex,
    countedBy,
    orderItems,
    sessionNote
  );

  return stockJson_({
    ok: true,
    saved: true,
    submissionId: submissionId,
    outlet: target.outlet,
    businessDate: businessDate,
    monthKey: target.monthKey,
    weekIndex: weekIndex,
    changedCellCount: changes.length,
    orderCount: orderItems.length,
    orderItems: orderItems,
    spreadsheetId: target.spreadsheetId,
    spreadsheetName: target.spreadsheetName,
    spreadsheetUrl: target.spreadsheetUrl,
    whatsappMessage: message,
    whatsappShareUrl: stockWhatsAppUrl_(message),
    whatsappButtonEnabled: true
  });
}

function stockMarkWhatsAppOpened_(payload) {
  const submissionId = stockText_(payload.submissionId);
  const businessDate = stockRequiredDate_(payload.businessDate);
  if (!submissionId) throw new Error('submissionId is required');

  const target = stockResolveMonthlySpreadsheet_(businessDate, false);
  if (!target) throw new Error('Monthly stock file does not exist');
  const sheet = stockPrepareSupportSheets_(target.spreadsheet, target).submissions;
  const row = stockFindSubmissionRow_(sheet, submissionId);
  if (row < 1) throw new Error('Submission not found');

  sheet.getRange(row, 11).setValue(new Date().toISOString());
  return stockJson_({ ok: true, submissionId: submissionId, whatsappOpened: true });
}

function stockGetMonthStatus_(payload) {
  const businessDate = stockRequiredDate_(payload.businessDate || stockToday_());
  const target = stockResolveMonthlySpreadsheet_(businessDate, false);
  if (!target) {
    const template = stockTemplateSpreadsheet_();
    return stockJson_({
      ok: true,
      exists: false,
      outlet: stockOutletName_(template),
      businessDate: businessDate,
      monthKey: businessDate.slice(0, 7)
    });
  }

  return stockJson_({
    ok: true,
    exists: true,
    outlet: target.outlet,
    businessDate: businessDate,
    monthKey: target.monthKey,
    spreadsheetId: target.spreadsheetId,
    spreadsheetName: target.spreadsheetName,
    spreadsheetUrl: target.spreadsheetUrl
  });
}

function stockWriteInventory_(spreadsheet, weekIndex, businessDate, submittedRows, changes, orderItems) {
  if (!Array.isArray(submittedRows) || !submittedRows.length) return;
  const config = STOCK_LAYOUT.Inventory;
  const week = STOCK_WEEK_COLUMNS.inventory[weekIndex - 1];
  const sheet = stockGetSheet_(spreadsheet, config.sheetName);
  sheet.getRange(week.dateCell).setValue(stockDateObject_(businessDate)).setNumberFormat('dd/MM/yyyy');

  const submittedByRow = stockIndexSubmittedRows_(submittedRows);
  for (let row = config.rowStart; row <= config.rowEnd; row += 1) {
    const input = submittedByRow[row];
    if (!input) continue;

    const item = stockText_(sheet.getRange(row, 1).getDisplayValue());
    if (!item) continue;

    const primary = stockNonNegativeNumber_(input.primary !== undefined ? input.primary : input.quantity, item);
    const primaryCell = week.primaryCol + row;
    sheet.getRange(primaryCell).setValue(primary);
    changes.push({ sheet: config.sheetName, cell: primaryCell, value: primary });

    let secondary = 0;
    if (INVENTORY_SECONDARY_ROWS.indexOf(row) >= 0) {
      secondary = stockNonNegativeNumber_(input.secondary, item);
      const secondaryCell = week.secondaryCol + row;
      sheet.getRange(secondaryCell).setValue(secondary);
      changes.push({ sheet: config.sheetName, cell: secondaryCell, value: secondary });
    }

    const minimum = stockNumberOrZero_(sheet.getRange(config.minCol + row).getValue());
    const conversion = INVENTORY_CONVERSION_BY_ROW[row] || 1;
    const calculated = primary * conversion + secondary;
    if (calculated <= minimum) {
      orderItems.push({
        sheet: config.sheetName,
        item: item,
        status: 'Order',
        quantityText: stockInventoryQuantityText_(sheet, week, row, primary, secondary),
        minimum: minimum
      });
    }
  }
}

function stockWriteUtensil_(spreadsheet, sheetName, weekIndex, businessDate, submittedRows, changes, orderItems) {
  if (!Array.isArray(submittedRows) || !submittedRows.length) return;
  const config = STOCK_LAYOUT[sheetName];
  const week = STOCK_WEEK_COLUMNS.utensil[weekIndex - 1];
  const sheet = stockGetSheet_(spreadsheet, sheetName);
  sheet.getRange(week.dateCell).setValue(stockDateObject_(businessDate)).setNumberFormat('dd/MM/yyyy');

  const submittedByRow = stockIndexSubmittedRows_(submittedRows);
  for (let row = config.rowStart; row <= config.rowEnd; row += 1) {
    const input = submittedByRow[row];
    if (!input) continue;

    const item = stockText_(sheet.getRange(row, 1).getDisplayValue());
    if (!item) continue;
    const quantity = stockNonNegativeNumber_(input.quantity !== undefined ? input.quantity : input.primary, item);
    const quantityCell = week.quantityCol + row;
    sheet.getRange(quantityCell).setValue(quantity);
    changes.push({ sheet: sheetName, cell: quantityCell, value: quantity });

    const minimum = stockNumberOrZero_(sheet.getRange(config.minCol + row).getValue());
    const status = stockUtensilStatus_(sheetName, row, quantity, minimum);
    if (status) {
      const unit = stockText_(sheet.getRange(week.unitCol + row).getDisplayValue());
      orderItems.push({
        sheet: sheetName,
        item: item,
        status: status,
        quantityText: stockTrimNumber_(quantity) + (unit ? ' ' + unit : ''),
        minimum: minimum
      });
    }
  }
}

function stockWriteStationary_(spreadsheet, submittedRows, changes, orderItems) {
  if (!Array.isArray(submittedRows) || !submittedRows.length) return;
  const config = STOCK_LAYOUT.Stationary;
  const sheet = stockGetSheet_(spreadsheet, config.sheetName);
  const submittedByRow = stockIndexSubmittedRows_(submittedRows);

  for (let row = config.rowStart; row <= config.rowEnd; row += 1) {
    const input = submittedByRow[row];
    if (!input) continue;

    const item = stockText_(sheet.getRange(row, 1).getDisplayValue());
    if (!item) continue;
    const quantity = stockNonNegativeNumber_(input.quantity !== undefined ? input.quantity : input.primary, item);
    const cell = 'B' + row;
    sheet.getRange(cell).setValue(quantity);
    changes.push({ sheet: config.sheetName, cell: cell, value: quantity });

    const minimum = stockNumberOrZero_(sheet.getRange(config.minCol + row).getValue());
    if (quantity <= minimum) {
      const unit = stockText_(sheet.getRange('C' + row).getDisplayValue());
      orderItems.push({
        sheet: config.sheetName,
        item: item,
        status: 'Order',
        quantityText: stockTrimNumber_(quantity) + (unit ? ' ' + unit : ''),
        minimum: minimum
      });
    }
  }
}

function stockReadInventoryLayout_(spreadsheet, selectedWeek) {
  const config = STOCK_LAYOUT.Inventory;
  const sheet = stockGetSheet_(spreadsheet, config.sheetName);
  const rows = [];

  for (let row = config.rowStart; row <= config.rowEnd; row += 1) {
    const item = stockText_(sheet.getRange('A' + row).getDisplayValue());
    if (!item) continue;
    const minimum = stockNumberOrZero_(sheet.getRange(config.minCol + row).getValue());
    const weeks = STOCK_WEEK_COLUMNS.inventory.map(function(week) {
      const primaryValue = sheet.getRange(week.primaryCol + row).getValue();
      const isSecondary = INVENTORY_SECONDARY_ROWS.indexOf(row) >= 0;
      const primaryUnit = isSecondary
        ? stockText_(sheet.getRange(stockPreviousColumn_(week.secondaryCol) + row).getDisplayValue())
        : stockText_(sheet.getRange(week.secondaryCol + row).getDisplayValue());
      const secondaryUnit = isSecondary
        ? stockText_(sheet.getRange(stockNextColumn_(week.secondaryCol) + row).getDisplayValue())
        : '';
      return {
        index: week.index,
        dateCell: week.dateCell,
        date: stockCellDateText_(sheet.getRange(week.dateCell).getValue()),
        editable: week.index === selectedWeek,
        primaryCell: week.primaryCol + row,
        primaryValue: stockBlankOrNumber_(primaryValue),
        primaryUnit: primaryUnit,
        secondaryCell: isSecondary ? week.secondaryCol + row : '',
        secondaryValue: isSecondary ? stockBlankOrNumber_(sheet.getRange(week.secondaryCol + row).getValue()) : '',
        secondaryUnit: secondaryUnit,
        statusCell: week.statusCol + row,
        status: stockText_(sheet.getRange(week.statusCol + row).getDisplayValue())
      };
    });
    rows.push({
      row: row,
      item: item,
      minimum: minimum,
      conversion: INVENTORY_CONVERSION_BY_ROW[row] || 1,
      hasSecondaryQuantity: INVENTORY_SECONDARY_ROWS.indexOf(row) >= 0,
      weeks: weeks
    });
  }

  return {
    id: config.id,
    sheetName: config.sheetName,
    title: stockText_(sheet.getRange('A1').getDisplayValue()),
    type: config.type,
    selectedWeek: selectedWeek,
    rowStart: config.rowStart,
    rowEnd: config.rowEnd,
    rows: rows
  };
}

function stockReadUtensilLayout_(spreadsheet, sheetName, selectedWeek) {
  const config = STOCK_LAYOUT[sheetName];
  const sheet = stockGetSheet_(spreadsheet, sheetName);
  const rows = [];

  for (let row = config.rowStart; row <= config.rowEnd; row += 1) {
    const item = stockText_(sheet.getRange('A' + row).getDisplayValue());
    if (!item) continue;
    const minimum = stockNumberOrZero_(sheet.getRange(config.minCol + row).getValue());
    const weeks = STOCK_WEEK_COLUMNS.utensil.map(function(week) {
      return {
        index: week.index,
        dateCell: week.dateCell,
        date: stockCellDateText_(sheet.getRange(week.dateCell).getValue()),
        editable: week.index === selectedWeek,
        quantityCell: week.quantityCol + row,
        quantityValue: stockBlankOrNumber_(sheet.getRange(week.quantityCol + row).getValue()),
        unit: stockText_(sheet.getRange(week.unitCol + row).getDisplayValue()),
        statusCell: week.statusCol + row,
        status: stockText_(sheet.getRange(week.statusCol + row).getDisplayValue())
      };
    });
    rows.push({ row: row, item: item, minimum: minimum, weeks: weeks });
  }

  return {
    id: config.id,
    sheetName: config.sheetName,
    title: stockText_(sheet.getRange('A1').getDisplayValue()),
    type: config.type,
    selectedWeek: selectedWeek,
    rowStart: config.rowStart,
    rowEnd: config.rowEnd,
    rows: rows
  };
}

function stockReadStationaryLayout_(spreadsheet) {
  const config = STOCK_LAYOUT.Stationary;
  const sheet = stockGetSheet_(spreadsheet, config.sheetName);
  const rows = [];
  for (let row = config.rowStart; row <= config.rowEnd; row += 1) {
    const item = stockText_(sheet.getRange('A' + row).getDisplayValue());
    if (!item) continue;
    rows.push({
      row: row,
      item: item,
      quantityCell: 'B' + row,
      quantityValue: stockBlankOrNumber_(sheet.getRange('B' + row).getValue()),
      unit: stockText_(sheet.getRange('C' + row).getDisplayValue()),
      statusCell: 'D' + row,
      status: stockText_(sheet.getRange('D' + row).getDisplayValue()),
      minimum: stockNumberOrZero_(sheet.getRange('E' + row).getValue())
    });
  }
  return {
    id: config.id,
    sheetName: config.sheetName,
    title: stockText_(sheet.getRange('A1').getDisplayValue()),
    type: config.type,
    rows: rows
  };
}

function stockReadOrderPage_(spreadsheet) {
  const sheet = stockGetSheet_(spreadsheet, 'Order Page');
  const values = sheet.getRange('A1:E43').getDisplayValues();
  return {
    sheetName: 'Order Page',
    readOnly: true,
    range: 'A1:E43',
    values: values
  };
}

function stockResolveMonthlySpreadsheet_(businessDate, createIfMissing) {
  const template = stockTemplateSpreadsheet_();
  const outlet = stockOutletName_(template);
  const monthKey = businessDate.slice(0, 7);
  const fileName = stockMonthlyFileName_(outlet, monthKey);
  const folder = stockMonthlyFolder_();
  const files = folder.getFilesByName(fileName);

  if (files.hasNext()) {
    const file = files.next();
    const spreadsheet = SpreadsheetApp.openById(file.getId());
    return stockTargetObject_(spreadsheet, outlet, monthKey);
  }

  if (!createIfMissing) return null;

  const templateFile = DriveApp.getFileById(template.getId());
  const copiedFile = templateFile.makeCopy(fileName, folder);
  const spreadsheet = SpreadsheetApp.openById(copiedFile.getId());
  stockPrepareNewMonthlyCopy_(spreadsheet, outlet, monthKey, businessDate);
  SpreadsheetApp.flush();
  return stockTargetObject_(spreadsheet, outlet, monthKey);
}

function stockPrepareNewMonthlyCopy_(spreadsheet, outlet, monthKey, businessDate) {
  stockEnsureVisibleLayout_(spreadsheet);

  const inventory = stockGetSheet_(spreadsheet, 'Inventory');
  STOCK_WEEK_COLUMNS.inventory.forEach(function(week) {
    inventory.getRange(week.dateCell).clearContent();
    inventory.getRange(week.primaryCol + '4:' + week.primaryCol + '43').clearContent();
    INVENTORY_SECONDARY_ROWS.forEach(function(row) {
      inventory.getRange(week.secondaryCol + row).clearContent();
    });
  });

  ['Untensil PG1', 'Utensil PG2'].forEach(function(sheetName) {
    const config = STOCK_LAYOUT[sheetName];
    const sheet = stockGetSheet_(spreadsheet, sheetName);
    STOCK_WEEK_COLUMNS.utensil.forEach(function(week) {
      sheet.getRange(week.dateCell).clearContent();
      sheet.getRange(week.quantityCol + config.rowStart + ':' + week.quantityCol + config.rowEnd).clearContent();
    });
  });

  stockGetSheet_(spreadsheet, 'Stationary').getRange('B4:B22').clearContent();
  stockUpdateYearTitles_(spreadsheet, Number(monthKey.slice(0, 4)));

  const target = stockTargetObject_(spreadsheet, outlet, monthKey);
  const support = stockPrepareSupportSheets_(spreadsheet, target);
  support.meta.getRange('A1:B8').setValues([
    ['Key', 'Value'],
    ['Schema', STOCK_V2_SCHEMA],
    ['Version', STOCK_V2_VERSION],
    ['Outlet', outlet],
    ['Month Key', monthKey],
    ['Created At', new Date().toISOString()],
    ['Template Spreadsheet ID', stockTemplateSpreadsheet_().getId()],
    ['First Requested Date', businessDate]
  ]);
  support.meta.hideSheet();
}

function stockPrepareSupportSheets_(spreadsheet, target) {
  let submissions = spreadsheet.getSheetByName(STOCK_SUPPORT_SHEETS.submissions);
  if (!submissions) submissions = spreadsheet.insertSheet(STOCK_SUPPORT_SHEETS.submissions);
  if (submissions.getLastRow() === 0) {
    submissions.getRange(1, 1, 1, STOCK_SUBMISSION_HEADERS.length).setValues([STOCK_SUBMISSION_HEADERS]);
  } else {
    submissions.getRange(1, 1, 1, STOCK_SUBMISSION_HEADERS.length).setValues([STOCK_SUBMISSION_HEADERS]);
  }
  submissions.setFrozenRows(1);
  submissions.getRange(1, 1, 1, STOCK_SUBMISSION_HEADERS.length)
    .setFontWeight('bold')
    .setBackground('#111827')
    .setFontColor('#FFFFFF');
  submissions.hideSheet();

  let meta = spreadsheet.getSheetByName(STOCK_SUPPORT_SHEETS.meta);
  if (!meta) meta = spreadsheet.insertSheet(STOCK_SUPPORT_SHEETS.meta);
  if (meta.getLastRow() === 0 && target) {
    meta.getRange('A1:B6').setValues([
      ['Key', 'Value'],
      ['Schema', STOCK_V2_SCHEMA],
      ['Version', STOCK_V2_VERSION],
      ['Outlet', target.outlet],
      ['Month Key', target.monthKey],
      ['Spreadsheet ID', target.spreadsheetId]
    ]);
  }
  meta.hideSheet();
  return { submissions: submissions, meta: meta };
}


function stockVisibleSheetOrder_(spreadsheet) {
  return STOCK_VISIBLE_SHEETS.map(function(name) {
    return stockGetSheet_(spreadsheet, name).getName();
  });
}

function stockGetSheet_(spreadsheet, logicalName) {
  const sheet = stockGetSheetOrNull_(spreadsheet, logicalName);
  if (!sheet) throw new Error('Missing sheet: ' + logicalName);
  return sheet;
}

function stockGetSheetOrNull_(spreadsheet, logicalName) {
  const direct = spreadsheet.getSheetByName(logicalName);
  if (direct) return direct;
  const wanted = stockText_(logicalName);
  const sheets = spreadsheet.getSheets();
  for (let i = 0; i < sheets.length; i += 1) {
    if (stockText_(sheets[i].getName()) === wanted) return sheets[i];
  }
  return null;
}

function stockEnsureVisibleLayout_(spreadsheet) {
  STOCK_VISIBLE_SHEETS.forEach(function(name) {
    if (!stockGetSheetOrNull_(spreadsheet, name)) {
      throw new Error('Template/monthly file is missing visible sheet: ' + name);
    }
  });
}

function stockUpdateYearTitles_(spreadsheet, year) {
  ['Inventory', 'Untensil PG1', 'Utensil PG2', 'Stationary'].forEach(function(sheetName) {
    const sheet = stockGetSheet_(spreadsheet, sheetName);
    const cell = sheet.getRange('A1');
    const current = stockText_(cell.getDisplayValue());
    if (current) cell.setValue(current.replace(/20\d{2}/, String(year)));
  });
}

function stockBuildWhatsAppMessage_(target, businessDate, weekIndex, countedBy, orderItems, sessionNote) {
  const lines = [
    '📦 *STOCK COUNT SUBMITTED*',
    '',
    '*Outlet:* ' + target.outlet,
    '*Date:* ' + businessDate,
    '*Period:* Week ' + weekIndex,
    '*Counted by:* ' + countedBy,
    '*Monthly file:* ' + target.spreadsheetName,
    ''
  ];

  if (orderItems.length) {
    lines.push('*Items requiring attention (' + orderItems.length + '):*');
    let lastSheet = '';
    orderItems.forEach(function(item) {
      if (item.sheet !== lastSheet) {
        lines.push('');
        lines.push('*' + item.sheet + '*');
        lastSheet = item.sheet;
      }
      lines.push('• ' + item.item + ' — ' + item.status + ' (' + item.quantityText + ')');
    });
  } else {
    lines.push('*Items requiring attention:* None');
  }

  if (sessionNote) {
    lines.push('');
    lines.push('*Note:* ' + sessionNote);
  }

  lines.push('');
  lines.push('*Sheet:* ' + target.spreadsheetUrl);
  return lines.join('\n');
}

function stockWhatsAppUrl_(message) {
  const phone = stockText_(PropertiesService.getScriptProperties().getProperty('WHATSAPP_PHONE')).replace(/\D/g, '');
  const base = phone ? 'https://wa.me/' + phone : 'https://api.whatsapp.com/send';
  return base + (phone ? '?text=' : '?text=') + encodeURIComponent(message);
}

function stockLatestSubmission_(spreadsheet, businessDate) {
  const sheet = spreadsheet.getSheetByName(STOCK_SUPPORT_SHEETS.submissions);
  if (!sheet || sheet.getLastRow() < 2) return null;
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, STOCK_SUBMISSION_HEADERS.length).getDisplayValues();
  for (let i = values.length - 1; i >= 0; i -= 1) {
    if (stockText_(values[i][2]) === businessDate) {
      const obj = {};
      STOCK_SUBMISSION_HEADERS.forEach(function(header, index) { obj[header] = values[i][index]; });
      return obj;
    }
  }
  return null;
}

function stockFindSubmissionRow_(sheet, submissionId) {
  if (!sheet || sheet.getLastRow() < 2) return -1;
  const ids = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getDisplayValues();
  for (let i = 0; i < ids.length; i += 1) {
    if (stockText_(ids[i][0]) === submissionId) return i + 2;
  }
  return -1;
}

function stockSubmissionObject_(sheet, row) {
  const values = sheet.getRange(row, 1, 1, STOCK_SUBMISSION_HEADERS.length).getDisplayValues()[0];
  const obj = {};
  STOCK_SUBMISSION_HEADERS.forEach(function(header, index) { obj[header] = values[index]; });
  return obj;
}

function stockIndexSubmittedRows_(rows) {
  const indexed = {};
  rows.forEach(function(input) {
    const row = Number(input && input.row);
    if (Number.isInteger(row)) indexed[row] = input;
  });
  return indexed;
}

function stockUtensilStatus_(sheetName, row, quantity, minimum) {
  if (sheetName === 'Utensil PG2' && row === 9) return quantity <= 0 ? 'No More Use' : '';
  if (sheetName === 'Utensil PG2' && row === 36) return quantity <= 4 ? 'Spare Item' : '';
  return quantity <= minimum ? 'Order' : '';
}

function stockInventoryQuantityText_(sheet, week, row, primary, secondary) {
  if (INVENTORY_SECONDARY_ROWS.indexOf(row) >= 0) {
    const primaryUnit = stockText_(sheet.getRange(stockPreviousColumn_(week.secondaryCol) + row).getDisplayValue());
    const secondaryUnit = stockText_(sheet.getRange(stockNextColumn_(week.secondaryCol) + row).getDisplayValue());
    return stockTrimNumber_(primary) + (primaryUnit ? ' ' + primaryUnit : '') +
      ' + ' + stockTrimNumber_(secondary) + (secondaryUnit ? ' ' + secondaryUnit : '');
  }
  const unit = stockText_(sheet.getRange(week.secondaryCol + row).getDisplayValue());
  return stockTrimNumber_(primary) + (unit ? ' ' + unit : '');
}

function stockTargetObject_(spreadsheet, outlet, monthKey) {
  return {
    spreadsheet: spreadsheet,
    spreadsheetId: spreadsheet.getId(),
    spreadsheetName: spreadsheet.getName(),
    spreadsheetUrl: spreadsheet.getUrl(),
    outlet: outlet,
    monthKey: monthKey
  };
}

function stockTemplateSpreadsheet_() {
  const id = stockText_(PropertiesService.getScriptProperties().getProperty('STOCK_TEMPLATE_SPREADSHEET_ID'));
  if (id) return SpreadsheetApp.openById(id);
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (!active) throw new Error('Set STOCK_TEMPLATE_SPREADSHEET_ID or bind this script to the original-layout template');
  return active;
}

function stockMonthlyFolder_() {
  const id = stockText_(PropertiesService.getScriptProperties().getProperty('STOCK_MONTHLY_FOLDER_ID'));
  if (!id) throw new Error('Missing Script Property: STOCK_MONTHLY_FOLDER_ID');
  return DriveApp.getFolderById(id);
}

function stockOutletName_(template) {
  const configured = stockText_(PropertiesService.getScriptProperties().getProperty('STOCK_OUTLET_NAME'));
  if (configured) return configured;
  let name = stockText_(template.getName());
  name = name
    .replace(/\s*[-–—]?\s*stock\s*count\s*template\s*$/i, '')
    .replace(/\s*[-–—]?\s*inventory\s*template\s*$/i, '')
    .trim();
  if (!name) throw new Error('Unable to derive outlet name from template spreadsheet name');
  return name;
}

function stockMonthlyFileName_(outlet, monthKey) {
  const prefix = stockText_(PropertiesService.getScriptProperties().getProperty('STOCK_FILE_PREFIX')) || 'Stock Count';
  return prefix + ' - ' + outlet + ' - ' + monthKey;
}

function stockWeekIndex_(businessDate) {
  const day = Number(businessDate.slice(8, 10));
  return Math.min(5, Math.max(1, Math.ceil(day / 7)));
}

function stockPreviousColumn_(column) {
  return String.fromCharCode(column.charCodeAt(0) - 1);
}

function stockNextColumn_(column) {
  return String.fromCharCode(column.charCodeAt(0) + 1);
}

function stockBlankOrNumber_(value) {
  if (value === '' || value === null || value === undefined) return '';
  const n = Number(value);
  return Number.isFinite(n) ? n : value;
}

function stockNumberOrZero_(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function stockNonNegativeNumber_(value, item) {
  if (value === '' || value === null || value === undefined) {
    throw new Error('Missing quantity for: ' + item);
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error('Invalid quantity for: ' + item);
  return Math.round((n + Number.EPSILON) * 10000) / 10000;
}

function stockTrimNumber_(value) {
  const n = Number(value || 0);
  return String(Math.round((n + Number.EPSILON) * 10000) / 10000);
}

function stockRequiredDate_(value) {
  const text = stockText_(value);
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error('businessDate must be YYYY-MM-DD');
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (date.getFullYear() !== Number(match[1]) || date.getMonth() !== Number(match[2]) - 1 || date.getDate() !== Number(match[3])) {
    throw new Error('Invalid businessDate');
  }
  return text;
}

function stockDateObject_(businessDate) {
  return new Date(
    Number(businessDate.slice(0, 4)),
    Number(businessDate.slice(5, 7)) - 1,
    Number(businessDate.slice(8, 10))
  );
}

function stockCellDateText_(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  const text = stockText_(value);
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return iso[1] + '-' + iso[2] + '-' + iso[3];
  return text;
}

function stockToday_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function stockValidateSecret_(provided) {
  const required = stockText_(PropertiesService.getScriptProperties().getProperty('STOCKCOUNT_SECRET'));
  if (required && provided !== required) throw new Error('Invalid secret');
}

function stockText_(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function stockErrorText_(error) {
  return String(error && error.message ? error.message : error);
}

function stockJson_(value) {
  return ContentService.createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}
