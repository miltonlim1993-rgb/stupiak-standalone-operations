/**
 * Stupiak Standalone Stock Count GAS v2.2.0
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

const STOCK_V2_VERSION = '2.2.0';
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
  history: '_StockHistory',
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

const STOCK_HISTORY_HEADERS = [
  'Submission ID', 'Saved At', 'Business Date', 'Month Key', 'Week Index', 'Outlet',
  'Counted By', 'Session Note', 'Category', 'Sheet Name', 'Row', 'Item',
  'Primary Qty', 'Primary Unit', 'Secondary Qty', 'Secondary Unit', 'Units Per Primary',
  'Calculated Base Qty', 'Minimum', 'Status', 'Source', 'Source Version'
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
    if (action === 'getStockDashboard') return stockGetDashboard_(payload);
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
  const support = stockPrepareSupportSheets_(spreadsheet, target);
  const submissionSheet = support.submissions;

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

  const savedAt = new Date().toISOString();
  const historyRows = stockBuildHistoryRows_(spreadsheet, target, submissionId, savedAt, businessDate, weekIndex, countedBy, sessionNote, sections);
  if (historyRows.length) {
    support.history.getRange(support.history.getLastRow() + 1, 1, historyRows.length, STOCK_HISTORY_HEADERS.length).setValues(historyRows);
  }

  submissionSheet.appendRow([
    submissionId,
    savedAt,
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

function stockGetDashboard_(payload) {
  const dateFrom = stockRequiredDate_(payload.dateFrom || payload.businessDate || stockToday_());
  const dateTo = stockRequiredDate_(payload.dateTo || payload.businessDate || stockToday_());
  if (dateFrom > dateTo) throw new Error('dateFrom cannot be after dateTo');

  const monthKeys = stockMonthKeysBetween_(dateFrom, dateTo);
  if (monthKeys.length > 36) throw new Error('Dashboard range cannot exceed 36 months');

  const template = stockTemplateSpreadsheet_();
  const outlet = stockOutletName_(template);
  const months = [];
  let sessions = [];
  let items = [];

  monthKeys.forEach(function(monthKey) {
    const target = stockResolveMonthlySpreadsheet_(monthKey + '-01', false);
    if (!target) {
      months.push({ monthKey: monthKey, exists: false, sessionCount: 0, itemRecordCount: 0, attentionCount: 0 });
      return;
    }

    const support = stockPrepareSupportSheets_(target.spreadsheet, target);
    let monthSessions = stockReadSubmissionObjects_(support.submissions, dateFrom, dateTo).map(function(row) {
      row.spreadsheetId = target.spreadsheetId;
      row.spreadsheetName = target.spreadsheetName;
      row.spreadsheetUrl = target.spreadsheetUrl;
      return row;
    });
    let monthItems = stockReadHistoryObjects_(support.history, target, dateFrom, dateTo);
    const legacyItems = stockReadLegacyHistory_(target, dateFrom, dateTo, monthSessions, monthItems);
    monthItems = monthItems.concat(legacyItems);
    monthSessions = stockMergeLegacySessions_(monthSessions, monthItems, target);

    const attentionCount = monthItems.filter(function(row) { return stockIsAttention_(row.status); }).length;
    months.push({
      monthKey: monthKey,
      exists: true,
      spreadsheetId: target.spreadsheetId,
      spreadsheetName: target.spreadsheetName,
      spreadsheetUrl: target.spreadsheetUrl,
      sessionCount: monthSessions.length,
      itemRecordCount: monthItems.length,
      attentionCount: attentionCount,
      lastSubmittedAt: stockLatestText_(monthSessions.map(function(row) { return row.savedAt || row.businessDate; }))
    });
    sessions = sessions.concat(monthSessions);
    items = items.concat(monthItems);
  });

  sessions.sort(function(a, b) {
    return stockSortStamp_(b).localeCompare(stockSortStamp_(a));
  });
  items.sort(function(a, b) {
    return stockSortStamp_(b).localeCompare(stockSortStamp_(a)) ||
      stockText_(a.category).localeCompare(stockText_(b.category)) ||
      stockText_(a.item).localeCompare(stockText_(b.item));
  });

  const latestItems = stockBuildLatestItems_(items);
  const categories = stockUnique_(items.map(function(row) { return row.category; }).filter(Boolean));
  const submittedDays = stockUnique_(sessions.map(function(row) { return row.businessDate; }).filter(Boolean)).length;
  const attentionItemCount = latestItems.filter(function(row) { return stockIsAttention_(row.status); }).length;

  return stockJson_({
    ok: true,
    version: STOCK_V2_VERSION,
    schema: STOCK_V2_SCHEMA,
    dashboardSchema: 'STOCK_DASHBOARD_V1',
    outlet: outlet,
    dateFrom: dateFrom,
    dateTo: dateTo,
    summary: {
      monthsInRange: monthKeys.length,
      monthlyFiles: months.filter(function(month) { return month.exists; }).length,
      sessionCount: sessions.length,
      submittedDays: submittedDays,
      itemRecordCount: items.length,
      uniqueItems: latestItems.length,
      attentionItemCount: attentionItemCount
    },
    months: months,
    sessions: sessions,
    categories: categories,
    latestItems: latestItems,
    items: items.slice(0, 8000)
  });
}

function stockBuildHistoryRows_(spreadsheet, target, submissionId, savedAt, businessDate, weekIndex, countedBy, sessionNote, sections) {
  const result = [];
  const inventoryRows = stockIndexSubmittedRows_(sections.Inventory || sections.inventory || []);
  const inventory = stockGetSheet_(spreadsheet, 'Inventory');
  const inventoryWeek = STOCK_WEEK_COLUMNS.inventory[weekIndex - 1];
  for (let row = STOCK_LAYOUT.Inventory.rowStart; row <= STOCK_LAYOUT.Inventory.rowEnd; row += 1) {
    const input = inventoryRows[row];
    if (!input) continue;
    const item = stockText_(inventory.getRange('A' + row).getDisplayValue());
    if (!item) continue;
    const primary = stockNumberOrZero_(input.primary !== undefined ? input.primary : input.quantity);
    const hasSecondary = INVENTORY_SECONDARY_ROWS.indexOf(row) >= 0;
    const secondary = hasSecondary ? stockNumberOrZero_(input.secondary) : 0;
    const conversion = INVENTORY_CONVERSION_BY_ROW[row] || 1;
    const minimum = stockNumberOrZero_(inventory.getRange(STOCK_LAYOUT.Inventory.minCol + row).getValue());
    const primaryUnit = hasSecondary
      ? stockText_(inventory.getRange(stockPreviousColumn_(inventoryWeek.secondaryCol) + row).getDisplayValue())
      : stockText_(inventory.getRange(inventoryWeek.secondaryCol + row).getDisplayValue());
    const secondaryUnit = hasSecondary
      ? stockText_(inventory.getRange(stockNextColumn_(inventoryWeek.secondaryCol) + row).getDisplayValue())
      : '';
    const baseQty = stockRound4_(primary * conversion + secondary);
    result.push(stockHistoryRowValues_({
      submissionId: submissionId, savedAt: savedAt, businessDate: businessDate, monthKey: target.monthKey,
      weekIndex: weekIndex, outlet: target.outlet, countedBy: countedBy, sessionNote: sessionNote,
      category: 'Inventory', sheetName: 'Inventory', row: row, item: item,
      primaryQty: primary, primaryUnit: primaryUnit, secondaryQty: hasSecondary ? secondary : '', secondaryUnit: secondaryUnit,
      unitsPerPrimary: conversion, baseQty: baseQty, minimum: minimum,
      status: baseQty <= minimum ? 'Order' : 'OK', source: 'submission'
    }));
  }

  ['Untensil PG1', 'Utensil PG2'].forEach(function(sheetName) {
    const submitted = stockIndexSubmittedRows_(sections[sheetName] || (sheetName === 'Untensil PG1' ? sections.utensilPg1 : sections.utensilPg2) || []);
    const config = STOCK_LAYOUT[sheetName];
    const sheet = stockGetSheet_(spreadsheet, sheetName);
    const week = STOCK_WEEK_COLUMNS.utensil[weekIndex - 1];
    for (let row = config.rowStart; row <= config.rowEnd; row += 1) {
      const input = submitted[row];
      if (!input) continue;
      const item = stockText_(sheet.getRange('A' + row).getDisplayValue());
      if (!item) continue;
      const quantity = stockNumberOrZero_(input.quantity !== undefined ? input.quantity : input.primary);
      const minimum = stockNumberOrZero_(sheet.getRange(config.minCol + row).getValue());
      const status = stockUtensilStatus_(sheetName, row, quantity, minimum) || 'OK';
      result.push(stockHistoryRowValues_({
        submissionId: submissionId, savedAt: savedAt, businessDate: businessDate, monthKey: target.monthKey,
        weekIndex: weekIndex, outlet: target.outlet, countedBy: countedBy, sessionNote: sessionNote,
        category: sheetName, sheetName: sheetName, row: row, item: item,
        primaryQty: quantity, primaryUnit: stockText_(sheet.getRange(week.unitCol + row).getDisplayValue()),
        secondaryQty: '', secondaryUnit: '', unitsPerPrimary: 1, baseQty: quantity, minimum: minimum,
        status: status, source: 'submission'
      }));
    }
  });

  const stationaryRows = stockIndexSubmittedRows_(sections.Stationary || sections.stationary || []);
  const stationary = stockGetSheet_(spreadsheet, 'Stationary');
  for (let row = STOCK_LAYOUT.Stationary.rowStart; row <= STOCK_LAYOUT.Stationary.rowEnd; row += 1) {
    const input = stationaryRows[row];
    if (!input) continue;
    const item = stockText_(stationary.getRange('A' + row).getDisplayValue());
    if (!item) continue;
    const quantity = stockNumberOrZero_(input.quantity !== undefined ? input.quantity : input.primary);
    const minimum = stockNumberOrZero_(stationary.getRange('E' + row).getValue());
    result.push(stockHistoryRowValues_({
      submissionId: submissionId, savedAt: savedAt, businessDate: businessDate, monthKey: target.monthKey,
      weekIndex: '', outlet: target.outlet, countedBy: countedBy, sessionNote: sessionNote,
      category: 'Stationary', sheetName: 'Stationary', row: row, item: item,
      primaryQty: quantity, primaryUnit: stockText_(stationary.getRange('C' + row).getDisplayValue()),
      secondaryQty: '', secondaryUnit: '', unitsPerPrimary: 1, baseQty: quantity, minimum: minimum,
      status: quantity <= minimum ? 'Order' : 'OK', source: 'submission'
    }));
  }
  return result;
}

function stockHistoryRowValues_(row) {
  return [
    row.submissionId, row.savedAt, row.businessDate, row.monthKey, row.weekIndex, row.outlet,
    row.countedBy, row.sessionNote, row.category, row.sheetName, row.row, row.item,
    row.primaryQty, row.primaryUnit, row.secondaryQty, row.secondaryUnit, row.unitsPerPrimary,
    row.baseQty, row.minimum, row.status, row.source || 'submission', STOCK_V2_VERSION
  ];
}

function stockReadSubmissionObjects_(sheet, dateFrom, dateTo) {
  if (!sheet || sheet.getLastRow() < 2) return [];
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, STOCK_SUBMISSION_HEADERS.length).getValues();
  return values.map(function(row) {
    const obj = {};
    STOCK_SUBMISSION_HEADERS.forEach(function(header, index) { obj[header] = row[index]; });
    return {
      submissionId: stockText_(obj['Submission ID']),
      savedAt: stockIsoDateTime_(obj['Saved At']),
      businessDate: stockCellDateText_(obj['Business Date']),
      monthKey: stockText_(obj['Month Key']),
      weekIndex: Number(obj['Week Index'] || 0) || '',
      outlet: stockText_(obj['Outlet']),
      countedBy: stockText_(obj['Counted By']),
      sessionNote: stockText_(obj['Session Note']),
      changedCellCount: Number(obj['Changed Cell Count'] || 0),
      itemCount: 0,
      orderCount: Number(obj['Order Count'] || 0),
      whatsappOpenedAt: stockIsoDateTime_(obj['WhatsApp Opened At']),
      source: stockText_(obj['Source']) || 'submission'
    };
  }).filter(function(row) {
    return row.businessDate && row.businessDate >= dateFrom && row.businessDate <= dateTo;
  });
}

function stockReadHistoryObjects_(sheet, target, dateFrom, dateTo) {
  if (!sheet || sheet.getLastRow() < 2) return [];
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, STOCK_HISTORY_HEADERS.length).getValues();
  return values.map(function(row) {
    const obj = {};
    STOCK_HISTORY_HEADERS.forEach(function(header, index) { obj[header] = row[index]; });
    return {
      submissionId: stockText_(obj['Submission ID']), savedAt: stockIsoDateTime_(obj['Saved At']),
      businessDate: stockCellDateText_(obj['Business Date']), monthKey: stockText_(obj['Month Key']) || target.monthKey,
      weekIndex: Number(obj['Week Index'] || 0) || '', outlet: stockText_(obj['Outlet']) || target.outlet,
      countedBy: stockText_(obj['Counted By']), sessionNote: stockText_(obj['Session Note']),
      category: stockText_(obj['Category']), sheetName: stockText_(obj['Sheet Name']), row: Number(obj['Row'] || 0),
      item: stockText_(obj['Item']), primaryQty: stockBlankOrNumber_(obj['Primary Qty']), primaryUnit: stockText_(obj['Primary Unit']),
      secondaryQty: stockBlankOrNumber_(obj['Secondary Qty']), secondaryUnit: stockText_(obj['Secondary Unit']),
      unitsPerPrimary: stockNumberOrZero_(obj['Units Per Primary']) || 1,
      baseQty: stockNumberOrZero_(obj['Calculated Base Qty']), minimum: stockNumberOrZero_(obj['Minimum']),
      status: stockText_(obj['Status']) || 'OK', source: stockText_(obj['Source']) || 'submission',
      spreadsheetId: target.spreadsheetId, spreadsheetName: target.spreadsheetName, spreadsheetUrl: target.spreadsheetUrl
    };
  }).filter(function(row) {
    return row.businessDate && row.businessDate >= dateFrom && row.businessDate <= dateTo;
  }).map(stockAddQuantityText_);
}

function stockReadLegacyHistory_(target, dateFrom, dateTo, sessions, existingHistory) {
  const result = [];
  const existingKeys = {};
  existingHistory.forEach(function(row) { existingKeys[stockHistoryKey_(row)] = true; });
  const countedByByDate = {};
  sessions.forEach(function(row) { countedByByDate[row.businessDate] = row.countedBy; });

  const inventory = stockGetSheet_(target.spreadsheet, 'Inventory');
  const inventoryValues = inventory.getRange('A1:AA43').getValues();
  const inventoryDisplay = inventory.getRange('A1:AA43').getDisplayValues();
  STOCK_WEEK_COLUMNS.inventory.forEach(function(week) {
    const date = stockCellDateText_(inventoryValues[1][stockColumnNumber_(week.primaryCol) - 1]);
    const dateFromCell = stockCellDateText_(inventory.getRange(week.dateCell).getValue());
    const businessDate = dateFromCell || date;
    if (!businessDate || businessDate < dateFrom || businessDate > dateTo) return;
    for (let row = STOCK_LAYOUT.Inventory.rowStart; row <= STOCK_LAYOUT.Inventory.rowEnd; row += 1) {
      const item = stockText_(inventoryDisplay[row - 1][0]);
      if (!item) continue;
      const primary = inventoryValues[row - 1][stockColumnNumber_(week.primaryCol) - 1];
      if (primary === '' || primary === null) continue;
      const hasSecondary = INVENTORY_SECONDARY_ROWS.indexOf(row) >= 0;
      const secondary = hasSecondary ? stockNumberOrZero_(inventoryValues[row - 1][stockColumnNumber_(week.secondaryCol) - 1]) : 0;
      const conversion = INVENTORY_CONVERSION_BY_ROW[row] || 1;
      const minimum = stockNumberOrZero_(inventoryValues[row - 1][26]);
      const baseQty = stockRound4_(stockNumberOrZero_(primary) * conversion + secondary);
      const history = stockAddQuantityText_({
        submissionId: 'legacy-' + target.monthKey + '-w' + week.index, savedAt: businessDate + 'T00:00:00',
        businessDate: businessDate, monthKey: target.monthKey, weekIndex: week.index, outlet: target.outlet,
        countedBy: countedByByDate[businessDate] || 'Legacy sheet', sessionNote: '', category: 'Inventory', sheetName: 'Inventory', row: row,
        item: item, primaryQty: stockNumberOrZero_(primary),
        primaryUnit: hasSecondary ? stockText_(inventoryDisplay[row - 1][stockColumnNumber_(week.secondaryCol) - 2]) : stockText_(inventoryDisplay[row - 1][stockColumnNumber_(week.secondaryCol) - 1]),
        secondaryQty: hasSecondary ? secondary : '', secondaryUnit: hasSecondary ? stockText_(inventoryDisplay[row - 1][stockColumnNumber_(week.secondaryCol)]) : '',
        unitsPerPrimary: conversion, baseQty: baseQty, minimum: minimum,
        status: baseQty <= minimum ? 'Order' : 'OK', source: 'legacy-sheet', spreadsheetId: target.spreadsheetId,
        spreadsheetName: target.spreadsheetName, spreadsheetUrl: target.spreadsheetUrl
      });
      if (!existingKeys[stockHistoryKey_(history)]) result.push(history);
    }
  });

  ['Untensil PG1', 'Utensil PG2'].forEach(function(sheetName) {
    const sheet = stockGetSheet_(target.spreadsheet, sheetName);
    const config = STOCK_LAYOUT[sheetName];
    const values = sheet.getRange('A1:Q' + config.rowEnd).getValues();
    const display = sheet.getRange('A1:Q' + config.rowEnd).getDisplayValues();
    STOCK_WEEK_COLUMNS.utensil.forEach(function(week) {
      const businessDate = stockCellDateText_(sheet.getRange(week.dateCell).getValue());
      if (!businessDate || businessDate < dateFrom || businessDate > dateTo) return;
      for (let row = config.rowStart; row <= config.rowEnd; row += 1) {
        const item = stockText_(display[row - 1][0]);
        if (!item) continue;
        const quantity = values[row - 1][stockColumnNumber_(week.quantityCol) - 1];
        if (quantity === '' || quantity === null) continue;
        const minimum = stockNumberOrZero_(values[row - 1][stockColumnNumber_(config.minCol) - 1]);
        const status = stockUtensilStatus_(sheetName, row, stockNumberOrZero_(quantity), minimum) || 'OK';
        const history = stockAddQuantityText_({
          submissionId: 'legacy-' + target.monthKey + '-w' + week.index, savedAt: businessDate + 'T00:00:00',
          businessDate: businessDate, monthKey: target.monthKey, weekIndex: week.index, outlet: target.outlet,
          countedBy: countedByByDate[businessDate] || 'Legacy sheet', sessionNote: '', category: sheetName, sheetName: sheetName, row: row,
          item: item, primaryQty: stockNumberOrZero_(quantity), primaryUnit: stockText_(display[row - 1][stockColumnNumber_(week.unitCol) - 1]),
          secondaryQty: '', secondaryUnit: '', unitsPerPrimary: 1, baseQty: stockNumberOrZero_(quantity), minimum: minimum,
          status: status, source: 'legacy-sheet', spreadsheetId: target.spreadsheetId, spreadsheetName: target.spreadsheetName,
          spreadsheetUrl: target.spreadsheetUrl
        });
        if (!existingKeys[stockHistoryKey_(history)]) result.push(history);
      }
    });
  });

  const hasStationaryHistory = existingHistory.some(function(row) { return row.category === 'Stationary'; });
  if (!hasStationaryHistory) {
    const stationary = stockGetSheet_(target.spreadsheet, 'Stationary');
    const values = stationary.getRange('A1:E22').getValues();
    const display = stationary.getRange('A1:E22').getDisplayValues();
    const latestSessionDate = stockLatestText_(sessions.map(function(row) { return row.businessDate; })) || stockMonthEnd_(target.monthKey);
    if (latestSessionDate >= dateFrom && latestSessionDate <= dateTo) {
      for (let row = STOCK_LAYOUT.Stationary.rowStart; row <= STOCK_LAYOUT.Stationary.rowEnd; row += 1) {
        const item = stockText_(display[row - 1][0]);
        const quantity = values[row - 1][1];
        if (!item || quantity === '' || quantity === null) continue;
        const minimum = stockNumberOrZero_(values[row - 1][4]);
        result.push(stockAddQuantityText_({
          submissionId: 'legacy-' + target.monthKey + '-stationary', savedAt: latestSessionDate + 'T00:00:00',
          businessDate: latestSessionDate, monthKey: target.monthKey, weekIndex: '', outlet: target.outlet,
          countedBy: countedByByDate[latestSessionDate] || 'Legacy sheet', sessionNote: '', category: 'Stationary', sheetName: 'Stationary', row: row,
          item: item, primaryQty: stockNumberOrZero_(quantity), primaryUnit: stockText_(display[row - 1][2]), secondaryQty: '', secondaryUnit: '',
          unitsPerPrimary: 1, baseQty: stockNumberOrZero_(quantity), minimum: minimum,
          status: stockNumberOrZero_(quantity) <= minimum ? 'Order' : 'OK', source: 'legacy-sheet', spreadsheetId: target.spreadsheetId,
          spreadsheetName: target.spreadsheetName, spreadsheetUrl: target.spreadsheetUrl
        }));
      }
    }
  }
  return result;
}

function stockMergeLegacySessions_(sessions, items, target) {
  const existingDates = {};
  sessions.forEach(function(row) { existingDates[row.businessDate] = true; });
  const grouped = {};
  items.forEach(function(row) {
    if (row.source !== 'legacy-sheet' || existingDates[row.businessDate]) return;
    const key = row.businessDate + '|' + (row.weekIndex || 'monthly');
    if (!grouped[key]) grouped[key] = { businessDate: row.businessDate, weekIndex: row.weekIndex, itemCount: 0, orderCount: 0 };
    grouped[key].itemCount += 1;
    if (stockIsAttention_(row.status)) grouped[key].orderCount += 1;
  });
  Object.keys(grouped).forEach(function(key) {
    const row = grouped[key];
    sessions.push({
      submissionId: 'legacy-session-' + key, savedAt: row.businessDate + 'T00:00:00', businessDate: row.businessDate,
      monthKey: target.monthKey, weekIndex: row.weekIndex, outlet: target.outlet, countedBy: 'Legacy sheet', sessionNote: '',
      changedCellCount: row.itemCount, itemCount: row.itemCount, orderCount: row.orderCount, source: 'legacy-sheet',
      spreadsheetId: target.spreadsheetId, spreadsheetName: target.spreadsheetName, spreadsheetUrl: target.spreadsheetUrl
    });
  });

  const itemCountBySubmission = {};
  items.forEach(function(row) { itemCountBySubmission[row.submissionId] = (itemCountBySubmission[row.submissionId] || 0) + 1; });
  sessions.forEach(function(row) { row.itemCount = itemCountBySubmission[row.submissionId] || row.itemCount || 0; });
  return sessions;
}

function stockBuildLatestItems_(items) {
  const grouped = {};
  items.forEach(function(row) {
    const key = row.category + '|' + row.item;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(row);
  });
  return Object.keys(grouped).map(function(key) {
    const rows = grouped[key].sort(function(a, b) { return stockSortStamp_(b).localeCompare(stockSortStamp_(a)); });
    const latest = Object.assign({}, rows[0]);
    const previous = rows.length > 1 ? rows[1] : null;
    latest.previousBaseQty = previous ? previous.baseQty : null;
    latest.delta = previous ? stockRound4_(Number(latest.baseQty || 0) - Number(previous.baseQty || 0)) : null;
    return latest;
  }).sort(function(a, b) {
    const attentionDelta = Number(stockIsAttention_(b.status)) - Number(stockIsAttention_(a.status));
    return attentionDelta || a.category.localeCompare(b.category) || a.item.localeCompare(b.item);
  });
}

function stockAddQuantityText_(row) {
  const primary = stockTrimNumber_(row.primaryQty);
  let text = primary + (row.primaryUnit ? ' ' + row.primaryUnit : '');
  if (row.secondaryQty !== '' && row.secondaryQty !== null && row.secondaryQty !== undefined) {
    text += ' + ' + stockTrimNumber_(row.secondaryQty) + (row.secondaryUnit ? ' ' + row.secondaryUnit : '');
  }
  row.quantityText = text;
  return row;
}

function stockHistoryKey_(row) {
  return [row.businessDate, row.sheetName, row.row].join('|');
}

function stockMonthKeysBetween_(dateFrom, dateTo) {
  const result = [];
  let year = Number(dateFrom.slice(0, 4));
  let month = Number(dateFrom.slice(5, 7));
  const endYear = Number(dateTo.slice(0, 4));
  const endMonth = Number(dateTo.slice(5, 7));
  while (year < endYear || (year === endYear && month <= endMonth)) {
    result.push(String(year) + '-' + String(month).padStart(2, '0'));
    month += 1;
    if (month > 12) { month = 1; year += 1; }
  }
  return result;
}

function stockMonthEnd_(monthKey) {
  const year = Number(monthKey.slice(0, 4));
  const month = Number(monthKey.slice(5, 7));
  const last = new Date(year, month, 0).getDate();
  return monthKey + '-' + String(last).padStart(2, '0');
}

function stockColumnNumber_(column) {
  let number = 0;
  stockText_(column).toUpperCase().split('').forEach(function(char) {
    number = number * 26 + char.charCodeAt(0) - 64;
  });
  return number;
}

function stockIsoDateTime_(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  return stockText_(value);
}

function stockSortStamp_(row) {
  return stockText_(row.savedAt) || stockText_(row.businessDate);
}

function stockLatestText_(values) {
  return values.filter(Boolean).sort().pop() || '';
}

function stockUnique_(values) {
  const seen = {};
  return values.filter(function(value) {
    const key = stockText_(value);
    if (!key || seen[key]) return false;
    seen[key] = true;
    return true;
  }).sort();
}

function stockIsAttention_(status) {
  const text = stockText_(status).toLowerCase();
  return Boolean(text && text !== 'ok');
}

function stockRound4_(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 10000) / 10000;
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

  let history = spreadsheet.getSheetByName(STOCK_SUPPORT_SHEETS.history);
  if (!history) history = spreadsheet.insertSheet(STOCK_SUPPORT_SHEETS.history);
  history.getRange(1, 1, 1, STOCK_HISTORY_HEADERS.length).setValues([STOCK_HISTORY_HEADERS]);
  history.setFrozenRows(1);
  history.getRange(1, 1, 1, STOCK_HISTORY_HEADERS.length)
    .setFontWeight('bold')
    .setBackground('#0F766E')
    .setFontColor('#FFFFFF');
  history.hideSheet();

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
  return { submissions: submissions, history: history, meta: meta };
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
