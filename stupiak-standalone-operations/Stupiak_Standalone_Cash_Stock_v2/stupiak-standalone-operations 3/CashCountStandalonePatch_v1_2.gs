/**
 * Standalone Cash Count patch for the existing Cash GAS.
 *
 * Add this file to the SAME Apps Script project used by the existing cash workbook.
 * Then add this route inside the existing doPost lock block:
 *
 *   if (payload.action === 'saveStandaloneCashCount') {
 *     return handleStandaloneCashCount_(payload);
 *   }
 *   if (payload.action === 'getStandaloneCashDashboard') {
 *     return standaloneCashDashboard_(payload);
 *   }
 *
 * This does not remove or change the old FeedMe actions.
 */

const STANDALONE_CASH_VERSION = '1.2.0';
const STANDALONE_CASH_LOG_SHEET = '_CashShiftLog';
const STANDALONE_CASH_LOG_HEADERS = [
  'Event ID','Saved At','Business Date','Outlet','Phase','Sequence',
  'Opening / Counted Total','Outgoing Total','Incoming Total','Variance',
  'From Staff','To Staff','Counted By','Cash Breakdown','Outgoing Breakdown','Incoming Breakdown','Denominations JSON',
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
  const outgoingDenominations = payload.outgoingDenominations || {};
  const incomingDenominations = payload.incomingDenominations || denominations;
  const outgoingOtherCash = payload.outgoingOtherCash || 0;
  const incomingOtherCash = payload.incomingOtherCash !== undefined ? payload.incomingOtherCash : otherCash;
  const breakdown = standaloneCashBreakdown_(denominations, otherCash);
  const outgoingBreakdown = phase === 'handover' ? standaloneCashBreakdown_(outgoingDenominations, outgoingOtherCash) : '';
  const incomingBreakdown = phase === 'handover' ? standaloneCashBreakdown_(incomingDenominations, incomingOtherCash) : '';
  const variance = phase === 'handover' ? standaloneCashRound2_(incomingTotal - outgoingTotal) : '';

  log.appendRow([
    eventId, new Date().toISOString(), businessDate, outlet, phase, sequence,
    countedTotal === null ? '' : countedTotal,
    outgoingTotal === null ? '' : outgoingTotal,
    incomingTotal === null ? '' : incomingTotal,
    variance, fromStaff, toStaff, countedBy, breakdown, outgoingBreakdown, incomingBreakdown,
    JSON.stringify({ denominations: denominations, otherCash: otherCash || 0, outgoingDenominations: outgoingDenominations, outgoingOtherCash: outgoingOtherCash, incomingDenominations: incomingDenominations, incomingOtherCash: incomingOtherCash }),
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
    year: target.year,
    whatsappMessage: standaloneCashWhatsAppMessage_({ businessDate: businessDate, outlet: outlet, phase: phase, countedTotal: countedTotal, outgoingTotal: outgoingTotal, incomingTotal: incomingTotal, variance: variance, countedBy: countedBy, fromStaff: fromStaff, toStaff: toStaff, remark: standaloneCashText_(payload.remark || payload.notes), spreadsheetUrl: target.spreadsheetUrl }),
    whatsappShareUrl: 'https://api.whatsapp.com/send?text=' + encodeURIComponent(standaloneCashWhatsAppMessage_({ businessDate: businessDate, outlet: outlet, phase: phase, countedTotal: countedTotal, outgoingTotal: outgoingTotal, incomingTotal: incomingTotal, variance: variance, countedBy: countedBy, fromStaff: fromStaff, toStaff: toStaff, remark: standaloneCashText_(payload.remark || payload.notes), spreadsheetUrl: target.spreadsheetUrl }))
  });
}


function standaloneCashDashboard_(payload) {
  const dateFrom = standaloneCashRequiredDate_(payload.dateFrom || payload.businessDate);
  const dateTo = standaloneCashRequiredDate_(payload.dateTo || payload.businessDate);
  const outlet = standaloneCashText_(payload.outlet);
  if (!outlet) throw new Error('outlet is required');
  if (dateFrom > dateTo) throw new Error('dateFrom cannot be after dateTo');

  const startYear = Number(dateFrom.slice(0, 4));
  const endYear = Number(dateTo.slice(0, 4));
  if (endYear - startYear > 5) throw new Error('Cash dashboard range cannot exceed 6 years');

  let events = [];
  const files = [];
  const seenSpreadsheetIds = {};
  for (let year = startYear; year <= endYear; year += 1) {
    let target;
    try {
      target = resolveTarget_({ businessDate: year + '-01-01', year: year, outlet: outlet }, {});
    } catch (error) {
      continue;
    }
    if (!target || !target.spreadsheet || seenSpreadsheetIds[target.spreadsheetId]) continue;
    seenSpreadsheetIds[target.spreadsheetId] = true;
    files.push({
      year: year,
      spreadsheetId: target.spreadsheetId,
      spreadsheetName: target.spreadsheetName,
      spreadsheetUrl: target.spreadsheetUrl
    });
    const logEvents = standaloneCashReadLogEvents_(target, outlet, dateFrom, dateTo);
    const legacyEvents = standaloneCashReadLegacyEvents_(target, outlet, dateFrom, dateTo, logEvents);
    events = events.concat(logEvents, legacyEvents);
  }

  events.sort(function(a, b) {
    return standaloneCashSortStamp_(b).localeCompare(standaloneCashSortStamp_(a));
  });

  const daysByDate = {};
  events.forEach(function(event) {
    const date = event.businessDate;
    if (!daysByDate[date]) {
      daysByDate[date] = {
        businessDate: date, openingTotal: '', closingTotal: '', handoverCount: 0,
        handoverVariance: 0, eventCount: 0, complete: false, spreadsheetUrl: event.spreadsheetUrl
      };
    }
    const day = daysByDate[date];
    day.eventCount += 1;
    if (event.phase === 'opening') day.openingTotal = event.countedTotal;
    if (event.phase === 'closing') day.closingTotal = event.countedTotal;
    if (event.phase === 'handover') {
      day.handoverCount += 1;
      day.handoverVariance = standaloneCashRound2_(day.handoverVariance + Number(event.variance || 0));
    }
    day.complete = day.openingTotal !== '' && day.closingTotal !== '';
  });
  const days = Object.keys(daysByDate).map(function(key) { return daysByDate[key]; }).sort(function(a, b) { return b.businessDate.localeCompare(a.businessDate); });

  const monthKeys = standaloneCashMonthKeys_(dateFrom, dateTo);
  const months = monthKeys.map(function(monthKey) {
    const monthEvents = events.filter(function(event) { return event.businessDate.slice(0, 7) === monthKey; });
    const monthDays = days.filter(function(day) { return day.businessDate.slice(0, 7) === monthKey; });
    const file = files.filter(function(entry) { return String(entry.year) === monthKey.slice(0, 4); })[0] || null;
    return {
      monthKey: monthKey,
      exists: Boolean(file),
      spreadsheetId: file ? file.spreadsheetId : '',
      spreadsheetName: file ? file.spreadsheetName : '',
      spreadsheetUrl: file ? file.spreadsheetUrl : '',
      eventCount: monthEvents.length,
      dayCount: monthDays.length,
      openingCount: monthEvents.filter(function(event) { return event.phase === 'opening'; }).length,
      closingCount: monthEvents.filter(function(event) { return event.phase === 'closing'; }).length,
      handoverCount: monthEvents.filter(function(event) { return event.phase === 'handover'; }).length,
      closingTotal: standaloneCashRound2_(monthEvents.filter(function(event) { return event.phase === 'closing'; }).reduce(function(sum, event) { return sum + Number(event.countedTotal || 0); }, 0)),
      handoverVariance: standaloneCashRound2_(monthEvents.filter(function(event) { return event.phase === 'handover'; }).reduce(function(sum, event) { return sum + Number(event.variance || 0); }, 0))
    };
  });

  const openingEvents = events.filter(function(event) { return event.phase === 'opening'; });
  const closingEvents = events.filter(function(event) { return event.phase === 'closing'; });
  const handoverEvents = events.filter(function(event) { return event.phase === 'handover'; });

  return json_({
    ok: true,
    version: STANDALONE_CASH_VERSION,
    dashboardSchema: 'CASH_DASHBOARD_V1',
    outlet: outlet,
    dateFrom: dateFrom,
    dateTo: dateTo,
    summary: {
      eventCount: events.length,
      dayCount: days.length,
      completeDays: days.filter(function(day) { return day.complete; }).length,
      missingOpeningDays: days.filter(function(day) { return day.openingTotal === ''; }).length,
      missingClosingDays: days.filter(function(day) { return day.closingTotal === ''; }).length,
      openingCount: openingEvents.length,
      closingCount: closingEvents.length,
      handoverCount: handoverEvents.length,
      openingTotal: standaloneCashRound2_(openingEvents.reduce(function(sum, event) { return sum + Number(event.countedTotal || 0); }, 0)),
      closingTotal: standaloneCashRound2_(closingEvents.reduce(function(sum, event) { return sum + Number(event.countedTotal || 0); }, 0)),
      handoverVariance: standaloneCashRound2_(handoverEvents.reduce(function(sum, event) { return sum + Number(event.variance || 0); }, 0))
    },
    months: months,
    days: days,
    events: events.slice(0, 5000),
    files: files
  });
}

function standaloneCashReadLogEvents_(target, outlet, dateFrom, dateTo) {
  const sheet = target.spreadsheet.getSheetByName(STANDALONE_CASH_LOG_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return [];
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0].map(standaloneCashText_);
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues();
  return values.map(function(row) {
    const obj = {};
    headers.forEach(function(header, index) { obj[header] = row[index]; });
    return {
      eventId: standaloneCashText_(obj['Event ID']),
      savedAt: standaloneCashIsoDateTime_(obj['Saved At']),
      businessDate: standaloneCashDate_(obj['Business Date']),
      outlet: standaloneCashText_(obj['Outlet']),
      phase: standaloneCashText_(obj['Phase']).toLowerCase(),
      sequence: Number(obj['Sequence'] || 0),
      countedTotal: standaloneCashBlankNumber_(obj['Opening / Counted Total']),
      outgoingTotal: standaloneCashBlankNumber_(obj['Outgoing Total']),
      incomingTotal: standaloneCashBlankNumber_(obj['Incoming Total']),
      variance: standaloneCashBlankNumber_(obj['Variance']),
      fromStaff: standaloneCashText_(obj['From Staff']),
      toStaff: standaloneCashText_(obj['To Staff']),
      countedBy: standaloneCashText_(obj['Counted By']),
      cashBreakdown: standaloneCashText_(obj['Cash Breakdown']),
      outgoingBreakdown: standaloneCashText_(obj['Outgoing Breakdown']),
      incomingBreakdown: standaloneCashText_(obj['Incoming Breakdown']),
      remark: standaloneCashText_(obj['Remark']),
      source: standaloneCashText_(obj['Source']) || 'cash-shift-log',
      spreadsheetId: target.spreadsheetId,
      spreadsheetName: target.spreadsheetName,
      spreadsheetUrl: target.spreadsheetUrl
    };
  }).filter(function(event) {
    return event.businessDate && event.businessDate >= dateFrom && event.businessDate <= dateTo &&
      (!outlet || event.outlet === outlet) && ['opening', 'handover', 'closing'].indexOf(event.phase) >= 0;
  });
}

function standaloneCashReadLegacyEvents_(target, outlet, dateFrom, dateTo, logEvents) {
  const sheet = target.spreadsheet.getSheetByName('_RelationDaily');
  if (!sheet || sheet.getLastRow() < 2) return [];
  const values = sheet.getDataRange().getValues();
  const headers = values.shift().map(standaloneCashText_);
  const col = {};
  headers.forEach(function(header, index) { col[header] = index; });
  if (col['Business Date'] === undefined) return [];

  const existing = {};
  logEvents.forEach(function(event) { existing[event.businessDate + '|' + event.phase] = true; });
  const result = [];
  values.forEach(function(row) {
    const businessDate = standaloneCashDate_(row[col['Business Date']]);
    const rowOutlet = col['Outlet'] === undefined ? outlet : standaloneCashText_(row[col['Outlet']]);
    if (!businessDate || businessDate < dateFrom || businessDate > dateTo || (outlet && rowOutlet && rowOutlet !== outlet)) return;
    const base = {
      savedAt: col['Submitted At'] === undefined ? businessDate + 'T00:00:00' : standaloneCashIsoDateTime_(row[col['Submitted At']]) || businessDate + 'T00:00:00',
      businessDate: businessDate, outlet: rowOutlet || outlet, sequence: 1,
      spreadsheetId: target.spreadsheetId, spreadsheetName: target.spreadsheetName, spreadsheetUrl: target.spreadsheetUrl,
      source: 'relation-daily-backfill'
    };
    const opening = standaloneCashColumnNumber_(row, col, 'Opening Count');
    if (opening !== null && !existing[businessDate + '|opening']) {
      result.push(Object.assign({}, base, { eventId: 'legacy-' + businessDate + '-opening', phase: 'opening', countedTotal: opening, outgoingTotal: '', incomingTotal: '', variance: '', fromStaff: '', toStaff: '', countedBy: standaloneCashColumnText_(row, col, 'Morning Staff'), remark: '', cashBreakdown: '' }));
    }
    const handoverOut = standaloneCashColumnNumber_(row, col, 'Handover Out');
    const handoverIn = standaloneCashColumnNumber_(row, col, 'Handover In');
    if ((handoverOut !== null || handoverIn !== null) && !existing[businessDate + '|handover']) {
      result.push(Object.assign({}, base, { eventId: 'legacy-' + businessDate + '-handover', phase: 'handover', countedTotal: '', outgoingTotal: handoverOut === null ? 0 : handoverOut, incomingTotal: handoverIn === null ? 0 : handoverIn, variance: standaloneCashRound2_((handoverIn || 0) - (handoverOut || 0)), fromStaff: standaloneCashColumnText_(row, col, 'From Staff'), toStaff: standaloneCashColumnText_(row, col, 'To Staff'), countedBy: '', remark: '', cashBreakdown: '' }));
    }
    const closing = standaloneCashColumnNumber_(row, col, 'Night Closing Actual');
    if (closing !== null && !existing[businessDate + '|closing']) {
      result.push(Object.assign({}, base, { eventId: 'legacy-' + businessDate + '-closing', phase: 'closing', countedTotal: closing, outgoingTotal: '', incomingTotal: '', variance: '', fromStaff: '', toStaff: '', countedBy: standaloneCashColumnText_(row, col, 'Prepared By'), remark: standaloneCashColumnText_(row, col, col['Close Up Note'] === undefined ? 'Daily Remark' : 'Close Up Note'), cashBreakdown: standaloneCashColumnText_(row, col, 'Cash Breakdown') }));
    }
  });
  return result;
}

function standaloneCashRequiredDate_(value) {
  const text = standaloneCashText_(value);
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error('date must be YYYY-MM-DD');
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (date.getFullYear() !== Number(match[1]) || date.getMonth() !== Number(match[2]) - 1 || date.getDate() !== Number(match[3])) throw new Error('Invalid date');
  return text;
}

function standaloneCashMonthKeys_(dateFrom, dateTo) {
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

function standaloneCashColumnText_(row, col, header) {
  return col[header] === undefined ? '' : standaloneCashText_(row[col[header]]);
}

function standaloneCashColumnNumber_(row, col, header) {
  if (col[header] === undefined || row[col[header]] === '' || row[col[header]] === null || row[col[header]] === undefined) return null;
  const n = Number(row[col[header]]);
  return Number.isFinite(n) ? standaloneCashRound2_(n) : null;
}

function standaloneCashBlankNumber_(value) {
  if (value === '' || value === null || value === undefined) return '';
  const n = Number(value);
  return Number.isFinite(n) ? standaloneCashRound2_(n) : '';
}

function standaloneCashIsoDateTime_(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  return standaloneCashText_(value);
}

function standaloneCashSortStamp_(event) {
  return standaloneCashText_(event.savedAt) || standaloneCashText_(event.businessDate);
}

function standaloneCashWhatsAppMessage_(event) {
  const lines = ['💵 *CASH COUNT SUBMITTED*', '', '*Outlet:* ' + event.outlet, '*Date:* ' + event.businessDate, '*Phase:* ' + event.phase];
  if (event.phase === 'handover') {
    lines.push('*From / To:* ' + event.fromStaff + ' → ' + event.toStaff);
    lines.push('*Outgoing:* RM ' + standaloneCashRound2_(event.outgoingTotal).toFixed(2));
    lines.push('*Incoming:* RM ' + standaloneCashRound2_(event.incomingTotal).toFixed(2));
    lines.push('*Variance:* RM ' + standaloneCashRound2_(event.variance).toFixed(2));
  } else {
    lines.push('*Counted by:* ' + event.countedBy);
    lines.push('*Total:* RM ' + standaloneCashRound2_(event.countedTotal).toFixed(2));
  }
  if (event.remark) lines.push('*Note:* ' + event.remark);
  if (event.spreadsheetUrl) lines.push('', '*Sheet:* ' + event.spreadsheetUrl);
  return lines.join('\n');
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
