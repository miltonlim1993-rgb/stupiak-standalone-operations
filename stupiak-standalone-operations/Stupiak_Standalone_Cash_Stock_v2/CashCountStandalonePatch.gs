/**
 * Standalone Cash Count patch for the existing Cash GAS.
 *
 * Add this file to the SAME Apps Script project used by the existing cash workbook.
 * Then add this route inside the existing doPost lock block:
 *
 *   if (payload.action === 'saveStandaloneCashCount') {
 *     return handleStandaloneCashCount_(payload);
 *   }
 *
 * This does not remove or change the old FeedMe actions.
 */

const STANDALONE_CASH_VERSION = '1.0.0';
const STANDALONE_CASH_LOG_SHEET = '_CashShiftLog';
const STANDALONE_CASH_LOG_HEADERS = [
  'Event ID','Saved At','Business Date','Outlet','Phase','Sequence',
  'Opening / Counted Total','Outgoing Total','Incoming Total','Variance',
  'From Staff','To Staff','Counted By','Cash Breakdown','Denominations JSON',
  'Remark','Source','Source Version'
];

function handleStandaloneCashCount_(payload) {
  const eventId = standaloneCashText_(payload.eventId || payload.idempotencyKey);
  const phase = standaloneCashText_(payload.phase).toLowerCase();
  const businessDate = standaloneCashDate_(payload.businessDate);
  const outlet = standaloneCashText_(payload.outlet);
  const countedBy = standaloneCashText_(payload.countedBy || payload.staffName || payload.preparedBy);

  if (!eventId) throw new Error('eventId is required');
  if (!businessDate) throw new Error('businessDate must be YYYY-MM-DD');
  if (!outlet) throw new Error('outlet is required');
  if (!countedBy && phase !== 'handover') throw new Error('countedBy is required');
  if (['opening','handover','closing'].indexOf(phase) < 0) {
    throw new Error('phase must be opening, handover, or closing');
  }

  const target = resolveTarget_(payload, {});
  const ss = target.spreadsheet;
  const log = standaloneCashPrepareLog_(ss);

  const existing = standaloneCashFind_(log, eventId);
  if (existing > 0) {
    return json_({
      ok: true,
      duplicate: true,
      eventId: eventId,
      spreadsheetId: target.spreadsheetId,
      spreadsheetName: target.spreadsheetName,
      spreadsheetUrl: target.spreadsheetUrl
    });
  }

  const countedTotal = standaloneCashNumber_(payload.countedTotal);
  const outgoingTotal = standaloneCashNumber_(payload.outgoingTotal);
  const incomingTotal = standaloneCashNumber_(payload.incomingTotal);
  const fromStaff = standaloneCashText_(payload.fromStaff);
  const toStaff = standaloneCashText_(payload.toStaff);

  if ((phase === 'opening' || phase === 'closing') && countedTotal === null) {
    throw new Error('countedTotal is required');
  }
  if (phase === 'handover') {
    if (outgoingTotal === null || incomingTotal === null) throw new Error('Both handover totals are required');
    if (!fromStaff || !toStaff) throw new Error('fromStaff and toStaff are required');
  }

  const sequence = standaloneCashNextSequence_(log, businessDate, outlet);
  const denominations = payload.denominations || (payload.cashCount && payload.cashCount.denominations) || {};
  const otherCash = payload.otherCash !== undefined
    ? payload.otherCash
    : (payload.cashCount && payload.cashCount.otherCash);
  const breakdown = standaloneCashBreakdown_(denominations, otherCash);
  const variance = phase === 'handover' ? standaloneCashRound2_(incomingTotal - outgoingTotal) : '';

  log.appendRow([
    eventId, new Date().toISOString(), businessDate, outlet, phase, sequence,
    countedTotal === null ? '' : countedTotal,
    outgoingTotal === null ? '' : outgoingTotal,
    incomingTotal === null ? '' : incomingTotal,
    variance, fromStaff, toStaff, countedBy, breakdown,
    JSON.stringify({ denominations: denominations, otherCash: otherCash || 0 }),
    standaloneCashText_(payload.remark || payload.notes),
    'standalone-cash-count', STANDALONE_CASH_VERSION
  ]);

  standaloneCashUpdateDailySummary_(ss, {
    businessDate: businessDate,
    outlet: outlet,
    phase: phase,
    countedTotal: countedTotal,
    outgoingTotal: outgoingTotal,
    incomingTotal: incomingTotal,
    fromStaff: fromStaff,
    toStaff: toStaff,
    countedBy: countedBy,
    breakdown: breakdown,
    remark: standaloneCashText_(payload.remark || payload.notes)
  });

  SpreadsheetApp.flush();
  return json_({
    ok: true,
    saved: true,
    eventId: eventId,
    phase: phase,
    sequence: sequence,
    spreadsheetId: target.spreadsheetId,
    spreadsheetName: target.spreadsheetName,
    spreadsheetUrl: target.spreadsheetUrl,
    outlet: target.outlet,
    year: target.year
  });
}

function standaloneCashUpdateDailySummary_(ss, event) {
  const sheet = ss.getSheetByName('_RelationDaily');
  if (!sheet) throw new Error('Missing _RelationDaily in the existing cash workbook');
  const data = sheet.getDataRange().getValues();
  if (!data.length) throw new Error('Missing _RelationDaily headers');

  const headers = data[0].map(standaloneCashText_);
  const col = {};
  headers.forEach(function(header, index) { col[header] = index + 1; });

  ['Business Date','Outlet','Submitted At'].forEach(function(header) {
    if (!col[header]) throw new Error('Missing _RelationDaily column: ' + header);
  });

  let row = -1;
  for (let i = 1; i < data.length; i += 1) {
    const date = standaloneCashDate_(data[i][col['Business Date'] - 1]);
    const outlet = standaloneCashText_(data[i][col['Outlet'] - 1]);
    if (date === event.businessDate && outlet === event.outlet) {
      row = i + 1;
      break;
    }
  }

  if (row < 0) {
    row = Math.max(2, sheet.getLastRow() + 1);
    sheet.getRange(row, col['Business Date']).setValue(event.businessDate);
    sheet.getRange(row, col['Outlet']).setValue(event.outlet);
  }

  function set(header, value) {
    if (col[header]) sheet.getRange(row, col[header]).setValue(value === null ? '' : value);
  }

  if (event.phase === 'opening') {
    set('Opening Count', event.countedTotal);
    set('Morning Staff', event.countedBy);
  } else if (event.phase === 'handover') {
    set('Handover Out', event.outgoingTotal);
    set('Handover In', event.incomingTotal);
    set('From Staff', event.fromStaff);
    set('To Staff', event.toStaff);
  } else if (event.phase === 'closing') {
    set('Night Closing Actual', event.countedTotal);
    set('Prepared By', event.countedBy);
    set('Cash Breakdown', event.breakdown);
    if (event.remark) {
      if (col['Close Up Note']) set('Close Up Note', event.remark);
      else if (col['Daily Remark']) set('Daily Remark', event.remark);
    }
  }

  set('Submitted At', new Date().toISOString());
}

function standaloneCashPrepareLog_(ss) {
  const sheet = ss.getSheetByName(STANDALONE_CASH_LOG_SHEET) || ss.insertSheet(STANDALONE_CASH_LOG_SHEET);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, STANDALONE_CASH_LOG_HEADERS.length).setValues([STANDALONE_CASH_LOG_HEADERS]);
  }
  const current = sheet.getRange(1, 1, 1, STANDALONE_CASH_LOG_HEADERS.length).getDisplayValues()[0];
  if (current.join('|') !== STANDALONE_CASH_LOG_HEADERS.join('|')) {
    sheet.getRange(1, 1, 1, STANDALONE_CASH_LOG_HEADERS.length).setValues([STANDALONE_CASH_LOG_HEADERS]);
  }
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, STANDALONE_CASH_LOG_HEADERS.length)
    .setFontWeight('bold').setBackground('#0F766E').setFontColor('#FFFFFF');
  return sheet;
}

function standaloneCashFind_(sheet, eventId) {
  if (sheet.getLastRow() < 2) return -1;
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getDisplayValues();
  for (let i = 0; i < values.length; i += 1) {
    if (standaloneCashText_(values[i][0]) === eventId) return i + 2;
  }
  return -1;
}

function standaloneCashNextSequence_(sheet, businessDate, outlet) {
  if (sheet.getLastRow() < 2) return 1;
  const values = sheet.getRange(2, 3, sheet.getLastRow() - 1, 4).getDisplayValues();
  let max = 0;
  values.forEach(function(row) {
    if (standaloneCashDate_(row[0]) === businessDate && standaloneCashText_(row[1]) === outlet) {
      max = Math.max(max, Number(row[3] || 0));
    }
  });
  return max + 1;
}

function standaloneCashBreakdown_(denominations, otherCash) {
  const order = ['100','50','20','10','5','1','0.5','0.2','0.1','0.05'];
  const parts = [];
  order.forEach(function(value) {
    const count = Number(denominations[value] || 0);
    if (count > 0) parts.push('RM' + value + ' x ' + count);
  });
  const other = Number(otherCash || 0);
  if (other > 0) parts.push('Other RM ' + standaloneCashRound2_(other).toFixed(2));
  return parts.join(' | ');
}

function standaloneCashDate_(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  const match = standaloneCashText_(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? match[1] + '-' + match[2] + '-' + match[3] : '';
}

function standaloneCashNumber_(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error('Invalid cash amount');
  return standaloneCashRound2_(n);
}

function standaloneCashRound2_(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function standaloneCashText_(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}
