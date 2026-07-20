/**
 * Stupiak Standalone Cash Count v2.0
 *
 * Replace the older CashCountStandalonePatch file with this file.
 * Keep the original FeedMe closing GAS in the same Apps Script project.
 *
 * Add these routes inside the existing doPost lock block, before
 * "throw new Error('Unsupported action')":
 *
 *   if (payload.action === 'getStandaloneCashBootstrap') return standaloneCashBootstrap_(payload);
 *   if (payload.action === 'saveStandaloneCashCount') return handleStandaloneCashCount_(payload);
 *   if (payload.action === 'getStandaloneCashDashboard') return standaloneCashDashboard_(payload);
 *
 * The existing validateSecret_ should use:
 *   CASH_GAS_SECRET first, then CLOSEUP_SECRET as fallback.
 */

const STANDALONE_CASH_VERSION = '2.0.0';
const STANDALONE_CASH_LOG_SHEET = '_CashShiftLog';
const STANDALONE_CASH_LOG_HEADERS = [
  'Event ID','Saved At','Business Date','Outlet','Phase','Sequence',
  'Opening / Counted Total','Outgoing Total','Incoming Total','Variance',
  'From Staff','To Staff','Counted By','Cash Breakdown','Outgoing Breakdown','Incoming Breakdown','Denominations JSON',
  'Remark','Source','Source Version','Payments JSON'
];

function standaloneCashBootstrap_(payload) {
  const businessDate = standaloneCashRequiredDate_(payload.businessDate);
  const outlet = standaloneCashResolveOutlet_(payload);
  const target = resolveTarget_(Object.assign({}, payload, { businessDate: businessDate, outlet: outlet }), {});
  const relation = standaloneCashRelationContext_(target.spreadsheet);
  const row = standaloneCashFindRelationRow_(relation, businessDate, target.outlet || outlet);
  const payments = standaloneCashReadPayments_(relation, row.values);
  const events = standaloneCashReadDateEvents_(target, target.outlet || outlet, businessDate, relation, row.values);

  return json_({
    ok: true,
    service: 'Stupiak Standalone Cash Count',
    version: STANDALONE_CASH_VERSION,
    outlet: target.outlet || outlet,
    businessDate: businessDate,
    spreadsheetId: target.spreadsheetId,
    spreadsheetName: target.spreadsheetName,
    spreadsheetUrl: target.spreadsheetUrl,
    year: target.year,
    payments: payments,
    summary: standaloneCashRelationSummary_(relation, row.values),
    events: events
  });
}

function handleStandaloneCashCount_(payload) {
  const eventId = standaloneCashText_(payload.eventId || payload.idempotencyKey);
  const phase = standaloneCashText_(payload.phase).toLowerCase();
  const businessDate = standaloneCashRequiredDate_(payload.businessDate);
  const outlet = standaloneCashResolveOutlet_(payload);
  const countedBy = standaloneCashText_(payload.countedBy || payload.staffName || payload.preparedBy);

  if (!eventId) throw new Error('eventId is required');
  if (['opening', 'handover', 'closing'].indexOf(phase) < 0) throw new Error('phase must be opening, handover, or closing');
  if (phase !== 'handover' && !countedBy) throw new Error('countedBy is required');

  const target = resolveTarget_(Object.assign({}, payload, { businessDate: businessDate, outlet: outlet }), {});
  const ss = target.spreadsheet;
  const relation = standaloneCashRelationContext_(ss);
  const log = standaloneCashPrepareLog_(ss);

  const existing = standaloneCashFindEvent_(log, eventId);
  if (existing > 0) {
    return json_({
      ok: true,
      duplicate: true,
      eventId: eventId,
      outlet: target.outlet || outlet,
      businessDate: businessDate,
      spreadsheetId: target.spreadsheetId,
      spreadsheetName: target.spreadsheetName,
      spreadsheetUrl: target.spreadsheetUrl
    });
  }

  const countedTotal = standaloneCashNumberOrNull_(payload.countedTotal);
  const outgoingTotal = standaloneCashNumberOrNull_(payload.outgoingTotal);
  const incomingTotal = standaloneCashNumberOrNull_(payload.incomingTotal);
  const fromStaff = standaloneCashText_(payload.fromStaff);
  const toStaff = standaloneCashText_(payload.toStaff);
  if ((phase === 'opening' || phase === 'closing') && countedTotal === null) throw new Error('countedTotal is required');
  if (phase === 'handover') {
    if (outgoingTotal === null || incomingTotal === null) throw new Error('Both handover totals are required');
    if (!fromStaff || !toStaff) throw new Error('fromStaff and toStaff are required');
  }

  const denominations = payload.denominations || {};
  const otherCash = standaloneCashNumber_(payload.otherCash);
  const outgoingDenominations = payload.outgoingDenominations || {};
  const incomingDenominations = payload.incomingDenominations || {};
  const outgoingOtherCash = standaloneCashNumber_(payload.outgoingOtherCash);
  const incomingOtherCash = standaloneCashNumber_(payload.incomingOtherCash);
  const variance = phase === 'handover' ? standaloneCashRound2_(incomingTotal - outgoingTotal) : '';
  const remark = standaloneCashText_(payload.remark || payload.notes);
  const payments = phase === 'closing'
    ? standaloneCashValidateAndNormalizePayments_(relation, payload.payments || [])
    : [];

  const sequence = standaloneCashNextSequence_(log, businessDate, target.outlet || outlet);
  const savedAt = new Date().toISOString();
  const breakdown = standaloneCashBreakdown_(denominations, otherCash);
  const outgoingBreakdown = phase === 'handover' ? standaloneCashBreakdown_(outgoingDenominations, outgoingOtherCash) : '';
  const incomingBreakdown = phase === 'handover' ? standaloneCashBreakdown_(incomingDenominations, incomingOtherCash) : '';

  log.appendRow([
    eventId, savedAt, businessDate, target.outlet || outlet, phase, sequence,
    countedTotal === null ? '' : countedTotal,
    outgoingTotal === null ? '' : outgoingTotal,
    incomingTotal === null ? '' : incomingTotal,
    variance, fromStaff, toStaff, countedBy, breakdown, outgoingBreakdown, incomingBreakdown,
    JSON.stringify({
      denominations: denominations,
      otherCash: otherCash,
      outgoingDenominations: outgoingDenominations,
      outgoingOtherCash: outgoingOtherCash,
      incomingDenominations: incomingDenominations,
      incomingOtherCash: incomingOtherCash
    }),
    remark, 'standalone-cash-count', STANDALONE_CASH_VERSION, JSON.stringify(payments)
  ]);

  standaloneCashWriteRelation_(relation, {
    businessDate: businessDate,
    outlet: target.outlet || outlet,
    phase: phase,
    countedTotal: countedTotal,
    outgoingTotal: outgoingTotal,
    incomingTotal: incomingTotal,
    fromStaff: fromStaff,
    toStaff: toStaff,
    countedBy: countedBy,
    breakdown: breakdown,
    remark: remark,
    payments: payments,
    savedAt: savedAt
  });

  SpreadsheetApp.flush();
  if (phase === 'closing' && typeof refreshIssueLog_ === 'function') {
    try {
      refreshIssueLog_(ss, Number(target.year || businessDate.slice(0, 4)), target.outlet || outlet);
      SpreadsheetApp.flush();
    } catch (_) {}
  }

  const whatsappMessage = standaloneCashWhatsAppMessage_({
    outlet: target.outlet || outlet,
    businessDate: businessDate,
    phase: phase,
    countedTotal: countedTotal,
    outgoingTotal: outgoingTotal,
    incomingTotal: incomingTotal,
    variance: variance,
    countedBy: countedBy,
    fromStaff: fromStaff,
    toStaff: toStaff,
    remark: remark,
    payments: payments,
    spreadsheetUrl: target.spreadsheetUrl
  });

  return json_({
    ok: true,
    saved: true,
    eventId: eventId,
    phase: phase,
    sequence: sequence,
    outlet: target.outlet || outlet,
    businessDate: businessDate,
    year: target.year,
    spreadsheetId: target.spreadsheetId,
    spreadsheetName: target.spreadsheetName,
    spreadsheetUrl: target.spreadsheetUrl,
    whatsappMessage: whatsappMessage,
    whatsappShareUrl: 'https://api.whatsapp.com/send?text=' + encodeURIComponent(whatsappMessage)
  });
}

function standaloneCashDashboard_(payload) {
  const dateFrom = standaloneCashRequiredDate_(payload.dateFrom || payload.businessDate);
  const dateTo = standaloneCashRequiredDate_(payload.dateTo || payload.businessDate);
  if (dateFrom > dateTo) throw new Error('dateFrom cannot be after dateTo');
  const outlet = standaloneCashResolveOutlet_(payload);
  const events = [];
  const targets = {};
  const startYear = Number(dateFrom.slice(0, 4));
  const endYear = Number(dateTo.slice(0, 4));

  for (let year = startYear; year <= endYear; year += 1) {
    const target = resolveTarget_({ businessDate: year + '-01-01', outlet: outlet }, {});
    targets[String(year)] = target;
    const relation = standaloneCashRelationContext_(target.spreadsheet);
    const yearEvents = standaloneCashReadRangeEvents_(target, target.outlet || outlet, dateFrom, dateTo, relation);
    yearEvents.forEach(function(event) { events.push(event); });
  }

  events.sort(function(a, b) {
    return standaloneCashSortStamp_(a).localeCompare(standaloneCashSortStamp_(b)) || Number(a.sequence || 0) - Number(b.sequence || 0);
  });

  const daysMap = {};
  events.forEach(function(event) {
    const key = event.businessDate;
    if (!daysMap[key]) {
      daysMap[key] = {
        businessDate: key,
        openingTotal: null,
        closingTotal: null,
        handoverCount: 0,
        handoverVariance: 0,
        eventCount: 0,
        complete: false
      };
    }
    const day = daysMap[key];
    day.eventCount += 1;
    if (event.phase === 'opening') day.openingTotal = standaloneCashNullable_(event.countedTotal);
    if (event.phase === 'closing') day.closingTotal = standaloneCashNullable_(event.countedTotal);
    if (event.phase === 'handover') {
      day.handoverCount += 1;
      day.handoverVariance = standaloneCashRound2_(day.handoverVariance + Number(event.variance || 0));
    }
    day.complete = day.openingTotal !== null && day.closingTotal !== null;
  });

  const days = Object.keys(daysMap).sort().map(function(key) { return daysMap[key]; });
  const monthKeys = standaloneCashMonthKeys_(dateFrom, dateTo);
  const months = monthKeys.map(function(monthKey) {
    const monthEvents = events.filter(function(event) { return event.businessDate.slice(0, 7) === monthKey; });
    const monthDays = days.filter(function(day) { return day.businessDate.slice(0, 7) === monthKey; });
    const target = targets[monthKey.slice(0, 4)];
    return {
      monthKey: monthKey,
      exists: Boolean(target),
      spreadsheetId: target ? target.spreadsheetId : '',
      spreadsheetName: target ? target.spreadsheetName : '',
      spreadsheetUrl: target ? target.spreadsheetUrl : '',
      eventCount: monthEvents.length,
      dayCount: monthDays.length,
      closingCount: monthEvents.filter(function(event) { return event.phase === 'closing'; }).length,
      closingTotal: standaloneCashRound2_(monthEvents.filter(function(event) { return event.phase === 'closing'; }).reduce(function(sum, event) { return sum + Number(event.countedTotal || 0); }, 0)),
      handoverCount: monthEvents.filter(function(event) { return event.phase === 'handover'; }).length
    };
  });

  const summary = {
    dayCount: days.length,
    completeDays: days.filter(function(day) { return day.complete; }).length,
    closingCount: events.filter(function(event) { return event.phase === 'closing'; }).length,
    closingTotal: standaloneCashRound2_(events.filter(function(event) { return event.phase === 'closing'; }).reduce(function(sum, event) { return sum + Number(event.countedTotal || 0); }, 0)),
    handoverCount: events.filter(function(event) { return event.phase === 'handover'; }).length,
    handoverVariance: standaloneCashRound2_(events.filter(function(event) { return event.phase === 'handover'; }).reduce(function(sum, event) { return sum + Number(event.variance || 0); }, 0)),
    missingClosingDays: days.filter(function(day) { return day.eventCount > 0 && day.closingTotal === null; }).length
  };

  return json_({
    ok: true,
    version: STANDALONE_CASH_VERSION,
    outlet: outlet,
    dateFrom: dateFrom,
    dateTo: dateTo,
    summary: summary,
    months: months,
    days: days,
    events: events
  });
}

function standaloneCashRelationContext_(ss) {
  let sheet = ss.getSheetByName('_RelationDaily');
  if (!sheet && typeof ensureV7RelationSheet_ === 'function') sheet = ensureV7RelationSheet_(ss);
  if (!sheet) throw new Error('Missing _RelationDaily in the FeedMe report');
  if (sheet.getLastColumn() < 1) throw new Error('_RelationDaily has no headers');
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0].map(standaloneCashText_);
  const col = {};
  headers.forEach(function(header, index) { if (header) col[header] = index; });
  if (col['Business Date'] === undefined) throw new Error('Missing _RelationDaily column: Business Date');
  if (col['Outlet'] === undefined) throw new Error('Missing _RelationDaily column: Outlet');
  return { sheet: sheet, headers: headers, col: col };
}

function standaloneCashFindRelationRow_(relation, businessDate, outlet) {
  if (relation.sheet.getLastRow() < 2) return { rowNumber: 0, values: new Array(relation.headers.length).fill('') };
  const values = relation.sheet.getRange(2, 1, relation.sheet.getLastRow() - 1, relation.headers.length).getValues();
  for (let index = 0; index < values.length; index += 1) {
    const rowDate = standaloneCashDate_(values[index][relation.col['Business Date']]);
    const rowOutlet = standaloneCashText_(values[index][relation.col['Outlet']]);
    if (rowDate === businessDate && (!outlet || !rowOutlet || rowOutlet === outlet)) {
      return { rowNumber: index + 2, values: values[index] };
    }
  }
  return { rowNumber: 0, values: new Array(relation.headers.length).fill('') };
}

function standaloneCashPaymentDefinitions_(relation) {
  const excluded = {
    'GF': true,
    'Foodpanda': true,
    'Shopee Food': true,
    'Grab Dine Out': true,
    'Daily Nett': true
  };
  const definitions = [];
  relation.headers.forEach(function(header, index) {
    const match = header.match(/^(.*) Actual$/);
    if (!match) return;
    const name = standaloneCashText_(match[1]);
    if (!name || excluded[name]) return;
    const systemHeader = name + ' System';
    if (relation.col[systemHeader] === undefined) return;
    definitions.push({
      id: standaloneCashSlug_(name),
      name: name === 'Other' ? 'Other Payment' : name,
      sourceName: name,
      systemHeader: systemHeader,
      actualHeader: header,
      remarkHeader: relation.col[name + ' Remark'] === undefined ? '' : name + ' Remark',
      sort: index
    });
  });
  return definitions.sort(function(a, b) { return a.sort - b.sort; });
}

function standaloneCashReadPayments_(relation, rowValues) {
  return standaloneCashPaymentDefinitions_(relation).map(function(definition) {
    const system = standaloneCashCellNumber_(rowValues, relation.col[definition.systemHeader]);
    const actual = standaloneCashCellNumber_(rowValues, relation.col[definition.actualHeader]);
    const remark = definition.remarkHeader ? standaloneCashText_(rowValues[relation.col[definition.remarkHeader]]) : '';
    return {
      id: definition.id,
      name: definition.name,
      system: system,
      actual: actual,
      variance: actual === '' ? '' : standaloneCashRound2_(Number(actual || 0) - Number(system || 0)),
      remark: remark
    };
  });
}

function standaloneCashValidateAndNormalizePayments_(relation, inputRows) {
  const byId = {};
  const byName = {};
  (inputRows || []).forEach(function(row) {
    if (!row) return;
    byId[standaloneCashText_(row.id)] = row;
    byName[standaloneCashText_(row.name).toLowerCase()] = row;
  });
  return standaloneCashPaymentDefinitions_(relation).map(function(definition) {
    const source = byId[definition.id] || byName[definition.name.toLowerCase()] || byName[definition.sourceName.toLowerCase()];
    if (!source || source.actual === '' || source.actual === null || source.actual === undefined) {
      throw new Error('Actual amount is required for ' + definition.name + '. Use 0 when there was no payment.');
    }
    const actual = standaloneCashNumber_(source.actual);
    const remark = standaloneCashText_(source.remark);
    return {
      id: definition.id,
      name: definition.name,
      sourceName: definition.sourceName,
      actual: actual,
      remark: remark,
      actualHeader: definition.actualHeader,
      remarkHeader: definition.remarkHeader
    };
  });
}

function standaloneCashRelationSummary_(relation, row) {
  return {
    expectedClosing: standaloneCashColumnValue_(relation, row, 'Expected Closing'),
    openingCount: standaloneCashColumnValue_(relation, row, 'Opening Count'),
    morningCount: standaloneCashColumnValue_(relation, row, 'Morning Count'),
    morningStaff: standaloneCashColumnText_(relation, row, 'Morning Staff'),
    handoverOut: standaloneCashColumnValue_(relation, row, 'Handover Out'),
    handoverIn: standaloneCashColumnValue_(relation, row, 'Handover In'),
    fromStaff: standaloneCashColumnText_(relation, row, 'From Staff'),
    toStaff: standaloneCashColumnText_(relation, row, 'To Staff'),
    nightClosingActual: standaloneCashColumnValue_(relation, row, 'Night Closing Actual'),
    preparedBy: standaloneCashColumnText_(relation, row, 'Prepared By'),
    dailyRemark: standaloneCashColumnText_(relation, row, 'Daily Remark'),
    closeUpNote: standaloneCashColumnText_(relation, row, 'Close Up Note'),
    cashBreakdown: standaloneCashColumnText_(relation, row, 'Cash Breakdown'),
    submittedAt: standaloneCashColumnText_(relation, row, 'Submitted At')
  };
}

function standaloneCashWriteRelation_(relation, event) {
  const found = standaloneCashFindRelationRow_(relation, event.businessDate, event.outlet);
  let rowNumber = found.rowNumber;
  if (!rowNumber) {
    rowNumber = Math.max(2, relation.sheet.getLastRow() + 1);
    relation.sheet.getRange(rowNumber, relation.col['Business Date'] + 1).setValue(event.businessDate);
    relation.sheet.getRange(rowNumber, relation.col['Outlet'] + 1).setValue(event.outlet);
  }

  function set(header, value) {
    if (relation.col[header] === undefined) return;
    relation.sheet.getRange(rowNumber, relation.col[header] + 1).setValue(value === null || value === undefined ? '' : value);
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
    if (relation.col['Close Up Note'] !== undefined) set('Close Up Note', event.remark);
    else set('Daily Remark', event.remark);
    (event.payments || []).forEach(function(payment) {
      set(payment.actualHeader, payment.actual);
      if (payment.remarkHeader) set(payment.remarkHeader, payment.remark);
    });
  }
  set('Submitted At', event.savedAt);
  set('Source Saved At', event.savedAt);
}

function standaloneCashReadDateEvents_(target, outlet, businessDate, relation, row) {
  const events = standaloneCashReadLogEvents_(target, outlet, businessDate, businessDate);
  return standaloneCashMergeLegacyEvents_(target, outlet, businessDate, businessDate, relation, events, row);
}

function standaloneCashReadRangeEvents_(target, outlet, dateFrom, dateTo, relation) {
  const events = standaloneCashReadLogEvents_(target, outlet, dateFrom, dateTo);
  return standaloneCashMergeLegacyEvents_(target, outlet, dateFrom, dateTo, relation, events, null);
}

function standaloneCashReadLogEvents_(target, outlet, dateFrom, dateTo) {
  const sheet = target.spreadsheet.getSheetByName(STANDALONE_CASH_LOG_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return [];
  const values = sheet.getDataRange().getValues();
  const headers = values.shift().map(standaloneCashText_);
  const col = {};
  headers.forEach(function(header, index) { col[header] = index; });
  return values.map(function(row) {
    const denominationsJson = standaloneCashJson_(row[col['Denominations JSON']]);
    const paymentJson = standaloneCashJson_(row[col['Payments JSON']]);
    return {
      eventId: standaloneCashColumnRawText_(row, col, 'Event ID'),
      savedAt: standaloneCashIsoDateTime_(row[col['Saved At']]),
      businessDate: standaloneCashDate_(row[col['Business Date']]),
      outlet: standaloneCashColumnRawText_(row, col, 'Outlet'),
      phase: standaloneCashColumnRawText_(row, col, 'Phase').toLowerCase(),
      sequence: Number(row[col['Sequence']] || 0),
      countedTotal: standaloneCashCellNumber_(row, col['Opening / Counted Total']),
      outgoingTotal: standaloneCashCellNumber_(row, col['Outgoing Total']),
      incomingTotal: standaloneCashCellNumber_(row, col['Incoming Total']),
      variance: standaloneCashCellNumber_(row, col['Variance']),
      fromStaff: standaloneCashColumnRawText_(row, col, 'From Staff'),
      toStaff: standaloneCashColumnRawText_(row, col, 'To Staff'),
      countedBy: standaloneCashColumnRawText_(row, col, 'Counted By'),
      remark: standaloneCashColumnRawText_(row, col, 'Remark'),
      denominations: denominationsJson.denominations || {},
      otherCash: denominationsJson.otherCash || 0,
      outgoingDenominations: denominationsJson.outgoingDenominations || {},
      outgoingOtherCash: denominationsJson.outgoingOtherCash || 0,
      incomingDenominations: denominationsJson.incomingDenominations || {},
      incomingOtherCash: denominationsJson.incomingOtherCash || 0,
      payments: Array.isArray(paymentJson) ? paymentJson : [],
      source: standaloneCashColumnRawText_(row, col, 'Source') || 'cash-shift-log',
      spreadsheetId: target.spreadsheetId,
      spreadsheetName: target.spreadsheetName,
      spreadsheetUrl: target.spreadsheetUrl
    };
  }).filter(function(event) {
    return event.businessDate >= dateFrom && event.businessDate <= dateTo &&
      (!outlet || !event.outlet || event.outlet === outlet) &&
      ['opening', 'handover', 'closing'].indexOf(event.phase) >= 0;
  });
}

function standaloneCashMergeLegacyEvents_(target, outlet, dateFrom, dateTo, relation, events, singleRow) {
  const result = events.slice();
  const existing = {};
  result.forEach(function(event) { existing[event.businessDate + '|' + event.phase] = true; });
  let rows = [];
  if (singleRow) rows = [{ values: singleRow, businessDate: dateFrom }];
  else if (relation.sheet.getLastRow() >= 2) {
    const values = relation.sheet.getRange(2, 1, relation.sheet.getLastRow() - 1, relation.headers.length).getValues();
    rows = values.map(function(row) {
      return { values: row, businessDate: standaloneCashDate_(row[relation.col['Business Date']]) };
    });
  }

  rows.forEach(function(entry) {
    const businessDate = entry.businessDate;
    const row = entry.values;
    if (!businessDate || businessDate < dateFrom || businessDate > dateTo) return;
    const rowOutlet = standaloneCashColumnText_(relation, row, 'Outlet') || outlet;
    if (outlet && rowOutlet && rowOutlet !== outlet) return;
    const savedAt = standaloneCashColumnText_(relation, row, 'Submitted At') || businessDate + 'T00:00:00';
    const base = {
      savedAt: standaloneCashIsoDateTime_(savedAt),
      businessDate: businessDate,
      outlet: rowOutlet,
      sequence: 1,
      spreadsheetId: target.spreadsheetId,
      spreadsheetName: target.spreadsheetName,
      spreadsheetUrl: target.spreadsheetUrl,
      source: 'relation-daily-readback'
    };
    const opening = standaloneCashColumnValue_(relation, row, 'Opening Count');
    if (opening !== '' && !existing[businessDate + '|opening']) {
      result.push(Object.assign({}, base, {
        eventId: 'legacy-' + businessDate + '-opening',
        phase: 'opening',
        countedTotal: opening,
        outgoingTotal: '',
        incomingTotal: '',
        variance: '',
        fromStaff: '',
        toStaff: '',
        countedBy: standaloneCashColumnText_(relation, row, 'Morning Staff'),
        remark: '',
        denominations: {},
        otherCash: 0,
        payments: []
      }));
    }
    const handoverOut = standaloneCashColumnValue_(relation, row, 'Handover Out');
    const handoverIn = standaloneCashColumnValue_(relation, row, 'Handover In');
    if ((handoverOut !== '' || handoverIn !== '') && !existing[businessDate + '|handover']) {
      result.push(Object.assign({}, base, {
        eventId: 'legacy-' + businessDate + '-handover',
        phase: 'handover',
        countedTotal: '',
        outgoingTotal: handoverOut === '' ? 0 : handoverOut,
        incomingTotal: handoverIn === '' ? 0 : handoverIn,
        variance: standaloneCashRound2_(Number(handoverIn || 0) - Number(handoverOut || 0)),
        fromStaff: standaloneCashColumnText_(relation, row, 'From Staff'),
        toStaff: standaloneCashColumnText_(relation, row, 'To Staff'),
        countedBy: '',
        remark: '',
        denominations: {},
        otherCash: 0,
        payments: []
      }));
    }
    const closing = standaloneCashColumnValue_(relation, row, 'Night Closing Actual');
    if (closing !== '' && !existing[businessDate + '|closing']) {
      result.push(Object.assign({}, base, {
        eventId: 'legacy-' + businessDate + '-closing',
        phase: 'closing',
        countedTotal: closing,
        outgoingTotal: '',
        incomingTotal: '',
        variance: '',
        fromStaff: '',
        toStaff: '',
        countedBy: standaloneCashColumnText_(relation, row, 'Prepared By'),
        remark: standaloneCashColumnText_(relation, row, relation.col['Close Up Note'] === undefined ? 'Daily Remark' : 'Close Up Note'),
        denominations: {},
        otherCash: 0,
        payments: standaloneCashReadPayments_(relation, row)
      }));
    }
  });

  return result.sort(function(a, b) {
    return standaloneCashSortStamp_(a).localeCompare(standaloneCashSortStamp_(b)) || Number(a.sequence || 0) - Number(b.sequence || 0);
  });
}

function standaloneCashPrepareLog_(ss) {
  const sheet = ss.getSheetByName(STANDALONE_CASH_LOG_SHEET) || ss.insertSheet(STANDALONE_CASH_LOG_SHEET);
  if (sheet.getMaxColumns() < STANDALONE_CASH_LOG_HEADERS.length) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), STANDALONE_CASH_LOG_HEADERS.length - sheet.getMaxColumns());
  }
  sheet.getRange(1, 1, 1, STANDALONE_CASH_LOG_HEADERS.length).setValues([STANDALONE_CASH_LOG_HEADERS]);
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, STANDALONE_CASH_LOG_HEADERS.length)
    .setFontWeight('bold').setBackground('#0F766E').setFontColor('#FFFFFF');
  try { sheet.hideSheet(); } catch (_) {}
  return sheet;
}

function standaloneCashFindEvent_(sheet, eventId) {
  if (sheet.getLastRow() < 2) return -1;
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getDisplayValues();
  for (let index = 0; index < values.length; index += 1) {
    if (standaloneCashText_(values[index][0]) === eventId) return index + 2;
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

function standaloneCashResolveOutlet_(payload) {
  const props = PropertiesService.getScriptProperties();
  const outlet = standaloneCashText_(payload.outlet || props.getProperty('CASH_OUTLET_NAME') || props.getProperty('STOCK_OUTLET_NAME'));
  if (!outlet) throw new Error('outlet is required. Send outlet or set CASH_OUTLET_NAME in Script Properties.');
  return outlet;
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
  if (event.phase === 'closing') {
    (event.payments || []).forEach(function(payment) {
      lines.push('*' + payment.name + ':* RM ' + standaloneCashRound2_(payment.actual).toFixed(2));
    });
  }
  if (event.remark) lines.push('*Note:* ' + event.remark);
  if (event.spreadsheetUrl) lines.push('', '*FeedMe Report:* ' + event.spreadsheetUrl);
  return lines.join('\n');
}

function standaloneCashBreakdown_(denominations, otherCash) {
  const order = ['100', '50', '20', '10', '5', '1', '0.5', '0.2', '0.1', '0.05'];
  const parts = [];
  order.forEach(function(value) {
    const count = Number(denominations[value] || 0);
    if (count > 0) parts.push('RM' + value + ' x ' + count);
  });
  const other = Number(otherCash || 0);
  if (other > 0) parts.push('Other RM ' + standaloneCashRound2_(other).toFixed(2));
  return parts.join(' | ');
}

function standaloneCashColumnValue_(relation, row, header) {
  if (relation.col[header] === undefined) return '';
  return standaloneCashCellNumber_(row, relation.col[header]);
}

function standaloneCashColumnText_(relation, row, header) {
  if (relation.col[header] === undefined) return '';
  return standaloneCashText_(row[relation.col[header]]);
}

function standaloneCashColumnRawText_(row, col, header) {
  return col[header] === undefined ? '' : standaloneCashText_(row[col[header]]);
}

function standaloneCashCellNumber_(row, index) {
  if (index === undefined || !row || row[index] === '' || row[index] === null || row[index] === undefined) return '';
  const number = Number(row[index]);
  return Number.isFinite(number) ? standaloneCashRound2_(number) : '';
}

function standaloneCashJson_(value) {
  if (!value) return {};
  try { return JSON.parse(String(value)); } catch (_) { return {}; }
}

function standaloneCashNullable_(value) {
  if (value === '' || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function standaloneCashNumberOrNull_(value) {
  if (value === '' || value === null || value === undefined) return null;
  return standaloneCashNumber_(value);
}

function standaloneCashNumber_(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number < 0) throw new Error('Invalid cash amount');
  return standaloneCashRound2_(number);
}

function standaloneCashRequiredDate_(value) {
  const text = standaloneCashText_(value);
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error('date must be YYYY-MM-DD');
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (date.getFullYear() !== Number(match[1]) || date.getMonth() !== Number(match[2]) - 1 || date.getDate() !== Number(match[3])) throw new Error('Invalid date');
  return text;
}

function standaloneCashDate_(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  const match = standaloneCashText_(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? match[1] + '-' + match[2] + '-' + match[3] : '';
}

function standaloneCashIsoDateTime_(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  return standaloneCashText_(value);
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

function standaloneCashSortStamp_(event) {
  return standaloneCashText_(event.savedAt) || standaloneCashText_(event.businessDate);
}

function standaloneCashSlug_(value) {
  return standaloneCashText_(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'payment';
}

function standaloneCashRound2_(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function standaloneCashText_(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}
