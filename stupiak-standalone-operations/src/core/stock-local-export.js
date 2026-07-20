const WEEKLY_SECTIONS = ['Inventory', 'Untensil PG1', 'Utensil PG2'];
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PDF_MIME = 'application/pdf';

export async function prepareAndShareStockPackage(stockState, outletName) {
  const snapshot = buildStockSnapshot(stockState, outletName);
  validateSnapshot(snapshot);

  const [pdfFile, excelFile] = await Promise.all([
    createPdfFile(snapshot),
    createExcelFile(snapshot)
  ]);

  const message = buildWhatsappMessage(snapshot);
  const files = [pdfFile, excelFile];

  if (navigator.share && (!navigator.canShare || navigator.canShare({ files }))) {
    await navigator.share({
      title: `Stock Count · ${snapshot.outlet}`,
      text: message,
      files
    });
    return { shared: true, files, message };
  }

  files.forEach(downloadFile);
  try { await navigator.clipboard.writeText(message); } catch (_) {}
  window.open(`https://wa.me/?text=${encodeURIComponent(message)}`, '_blank', 'noopener');
  return { shared: false, files, message };
}

function buildStockSnapshot(state, outletName) {
  const savedPayload = state.lastSubmittedPayload;
  const selectedWeeks = selectWeekIndexes(state, savedPayload);
  const countedBy = String(savedPayload?.countedBy || state.countedBy || '').trim();
  const note = String(savedPayload?.sessionNote || state.sessionNote || '').trim();
  const rows = [];

  if (savedPayload?.weekColumns?.length) {
    for (const column of savedPayload.weekColumns) {
      appendPayloadSections(rows, state, column.sections || {}, Number(column.weekIndex), column.businessDate);
    }
  } else if (savedPayload?.sections && savedPayload.selectedWeek) {
    appendPayloadSections(rows, state, savedPayload.sections, Number(savedPayload.selectedWeek), savedPayload.businessDate);
  } else if (state.activeTab === 'Stationary') {
    appendStateSection(rows, state, 'Stationary', null, state.stationaryDate);
  } else {
    for (const weekIndex of selectedWeeks) {
      for (const sectionName of WEEKLY_SECTIONS) {
        appendStateSection(rows, state, sectionName, weekIndex, state.weekDates?.[weekIndex] || '');
      }
    }
  }

  const countDates = [...new Set(rows.map((row) => row.countDate).filter(Boolean))];
  const weekIndexes = [...new Set(rows.map((row) => row.weekIndex).filter((value) => value !== null))];
  const needAttention = rows.filter((row) => row.status);
  const preparedAt = new Date();

  return {
    outlet: String(outletName || state.data?.outlet || 'Outlet'),
    countedBy,
    note,
    rows,
    needAttention,
    countDates,
    weekIndexes,
    preparedAt,
    preparedDateLabel: formatDateTime(preparedAt)
  };
}

function selectWeekIndexes(state, payload) {
  if (payload?.weekColumns?.length) return payload.weekColumns.map((entry) => Number(entry.weekIndex));
  if (payload?.selectedWeek) return [Number(payload.selectedWeek)];
  const dirty = Object.keys(state.dirtyWeeks || {}).filter((key) => state.dirtyWeeks[key]).map(Number);
  if (dirty.length) return dirty.sort((a, b) => a - b);
  const focus = Number(state.lastEditedWeek || state.mobileWeek || 1);
  if (state.weekDates?.[focus]) return [focus];
  const dated = [1, 2, 3, 4, 5].filter((week) => state.weekDates?.[week]);
  return dated.length ? [dated[dated.length - 1]] : [focus];
}

function appendPayloadSections(target, state, sections, weekIndex, countDate) {
  for (const [sectionName, submittedRows] of Object.entries(sections || {})) {
    const descriptor = state.data?.sections?.find((entry) => entry.sheetName === sectionName);
    for (const submitted of submittedRows || []) {
      const row = descriptor?.rows?.find((entry) => Number(entry.row) === Number(submitted.row));
      if (!row) continue;
      target.push(makeRow(sectionName, row, submitted, weekIndex, countDate));
    }
  }
}

function appendStateSection(target, state, sectionName, weekIndex, countDate) {
  const descriptor = state.data?.sections?.find((entry) => entry.sheetName === sectionName);
  if (!descriptor) return;
  for (const row of descriptor.rows || []) {
    const value = weekIndex === null
      ? state.values?.[sectionName]?.[row.row] || {}
      : state.values?.[sectionName]?.[row.row]?.[weekIndex] || {};
    target.push(makeRow(sectionName, row, value, weekIndex, countDate));
  }
}

function makeRow(sectionName, descriptor, value, weekIndex, countDate) {
  const primary = numberOrBlank(value.primary);
  const secondary = numberOrBlank(value.secondary);
  const quantity = numberOrBlank(value.quantity);
  const status = calculateStatus(sectionName, descriptor, { primary, secondary, quantity });
  return {
    weekIndex,
    countDate: String(countDate || ''),
    section: sectionName,
    item: String(descriptor.item || ''),
    primary,
    primaryUnit: descriptor.weeks?.[0]?.primaryUnit || descriptor.unit || '',
    secondary,
    secondaryUnit: descriptor.weeks?.[0]?.secondaryUnit || '',
    quantity,
    unit: descriptor.weeks?.[0]?.unit || descriptor.unit || '',
    minimum: numberOrBlank(descriptor.minimum),
    status
  };
}

function calculateStatus(sectionName, row, value) {
  if (sectionName === 'Inventory') {
    const total = Number(value.primary || 0) * Number(row.conversion || 1) + Number(value.secondary || 0);
    return total <= Number(row.minimum || 0) ? 'Order' : '';
  }
  const quantity = Number(value.quantity || 0);
  if (sectionName === 'Utensil PG2' && Number(row.row) === 9) return quantity <= 0 ? 'No More Use' : '';
  if (sectionName === 'Utensil PG2' && Number(row.row) === 36) return quantity <= 4 ? 'Spare Item' : '';
  return quantity <= Number(row.minimum || 0) ? 'Order' : '';
}

function validateSnapshot(snapshot) {
  if (!snapshot.countedBy) throw new Error('Enter the staff name before preparing WhatsApp files.');
  if (!snapshot.rows.length) throw new Error('There is no Stock Count data to prepare.');
  if (snapshot.rows.some((row) => !row.countDate)) throw new Error('Enter the count date for the selected Week column.');
  if (snapshot.rows.some((row) => row.primary === '' && row.quantity === '')) throw new Error('Complete the selected Stock Count column before preparing files.');
}

async function createExcelFile(snapshot) {
  const ExcelJS = window.ExcelJS;
  if (!ExcelJS) throw new Error('Excel generator is not loaded. Refresh the page and try again.');

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Stupiak Operations';
  workbook.created = snapshot.preparedAt;

  const summary = workbook.addWorksheet('Summary');
  summary.columns = [{ width: 24 }, { width: 48 }];
  const summaryRows = [
    ['Stock Count', snapshot.outlet],
    ['Count date', snapshot.countDates.join(', ')],
    ['Week', snapshot.weekIndexes.length ? snapshot.weekIndexes.map((week) => `Week ${week}`).join(', ') : 'Monthly'],
    ['Counted by', snapshot.countedBy],
    ['Session note', snapshot.note || '—'],
    ['Items counted', snapshot.rows.length],
    ['Need attention', snapshot.needAttention.length],
    ['Prepared at', snapshot.preparedDateLabel]
  ];
  summary.addRows(summaryRows);
  summary.getColumn(1).font = { bold: true };
  summary.getRow(1).font = { bold: true, size: 16 };

  const counts = workbook.addWorksheet('Stock Count');
  counts.columns = [
    { header: 'Week', key: 'week', width: 10 },
    { header: 'Count Date', key: 'countDate', width: 14 },
    { header: 'Section', key: 'section', width: 18 },
    { header: 'Item', key: 'item', width: 44 },
    { header: 'Primary Qty', key: 'primary', width: 12 },
    { header: 'Primary Unit', key: 'primaryUnit', width: 14 },
    { header: 'Secondary Qty', key: 'secondary', width: 14 },
    { header: 'Secondary Unit', key: 'secondaryUnit', width: 14 },
    { header: 'Quantity', key: 'quantity', width: 12 },
    { header: 'Unit', key: 'unit', width: 12 },
    { header: 'Minimum', key: 'minimum', width: 12 },
    { header: 'Status', key: 'status', width: 16 }
  ];
  addExcelRows(counts, snapshot.rows);

  const attention = workbook.addWorksheet('Need Attention');
  attention.columns = counts.columns.map((column) => ({ ...column }));
  addExcelRows(attention, snapshot.needAttention);

  for (const sheet of [counts, attention]) {
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).alignment = { vertical: 'middle' };
    sheet.autoFilter = { from: 'A1', to: 'L1' };
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return new File([buffer], fileBaseName(snapshot) + '.xlsx', { type: XLSX_MIME });
}

function addExcelRows(sheet, rows) {
  rows.forEach((row) => sheet.addRow({
    week: row.weekIndex ? `Week ${row.weekIndex}` : 'Monthly',
    countDate: row.countDate,
    section: row.section,
    item: row.item,
    primary: row.primary,
    primaryUnit: row.primaryUnit,
    secondary: row.secondary,
    secondaryUnit: row.secondaryUnit,
    quantity: row.quantity,
    unit: row.unit,
    minimum: row.minimum,
    status: row.status || 'OK'
  }));
}

async function createPdfFile(snapshot) {
  const PDFLib = window.PDFLib;
  if (!PDFLib) throw new Error('PDF generator is not loaded. Refresh the page and try again.');
  const { PDFDocument, StandardFonts, rgb } = PDFLib;
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const pageSize = [595.28, 841.89];
  const margin = 36;
  let page = pdf.addPage(pageSize);
  let y = page.getHeight() - margin;

  const addPage = () => {
    page = pdf.addPage(pageSize);
    y = page.getHeight() - margin;
  };
  const draw = (text, options = {}) => {
    const size = options.size || 9;
    const font = options.bold ? bold : regular;
    const safe = pdfSafe(text);
    if (y < margin + size + 8) addPage();
    page.drawText(safe, { x: options.x || margin, y, size, font, color: options.color || rgb(0.08, 0.08, 0.08), maxWidth: options.maxWidth || page.getWidth() - margin * 2 });
    y -= options.leading || size + 5;
  };

  draw('STOCK COUNT', { size: 19, bold: true, leading: 26 });
  draw(snapshot.outlet, { size: 13, bold: true, leading: 20 });
  draw(`Count date: ${snapshot.countDates.join(', ')}`);
  draw(`Week: ${snapshot.weekIndexes.length ? snapshot.weekIndexes.map((week) => `Week ${week}`).join(', ') : 'Monthly'}`);
  draw(`Counted by: ${snapshot.countedBy}`);
  if (snapshot.note) draw(`Note: ${snapshot.note}`);
  draw(`Items counted: ${snapshot.rows.length}   Need attention: ${snapshot.needAttention.length}`, { bold: true, leading: 20 });

  let currentSection = '';
  for (const row of snapshot.rows) {
    if (row.section !== currentSection) {
      currentSection = row.section;
      y -= 4;
      draw(currentSection.toUpperCase(), { size: 11, bold: true, leading: 17, color: rgb(0.15, 0.15, 0.15) });
    }
    const qty = row.primary !== ''
      ? `${row.primary} ${row.primaryUnit}${row.secondary !== '' ? ` + ${row.secondary} ${row.secondaryUnit}` : ''}`
      : `${row.quantity} ${row.unit}`;
    const status = row.status ? `  [${row.status}]` : '';
    const lines = wrapText(`${row.item} — ${qty}${status}`, 92);
    for (const line of lines) draw(line, { size: 8.5, leading: 12 });
  }

  const bytes = await pdf.save();
  return new File([bytes], fileBaseName(snapshot) + '.pdf', { type: PDF_MIME });
}

function buildWhatsappMessage(snapshot) {
  return [
    '📦 STOCK COUNT COMPLETED',
    '',
    `Outlet: ${snapshot.outlet}`,
    `Count date: ${snapshot.countDates.join(', ')}`,
    `Period: ${snapshot.weekIndexes.length ? snapshot.weekIndexes.map((week) => `Week ${week}`).join(', ') : 'Monthly'}`,
    `Counted by: ${snapshot.countedBy}`,
    `Items counted: ${snapshot.rows.length}`,
    `Need attention: ${snapshot.needAttention.length}`,
    snapshot.note ? `Note: ${snapshot.note}` : '',
    '',
    'PDF and Excel are attached.'
  ].filter(Boolean).join('\n');
}

function fileBaseName(snapshot) {
  const date = snapshot.countDates[0] || new Date().toISOString().slice(0, 10);
  const week = snapshot.weekIndexes.length ? `-W${snapshot.weekIndexes.join('-W')}` : '-Monthly';
  return `Stock-Count-${safeFileName(snapshot.outlet)}-${date}${week}`;
}

function safeFileName(value) {
  return String(value || 'Outlet').replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '');
}

function numberOrBlank(value) {
  return value === '' || value === null || value === undefined ? '' : Number(value);
}

function formatDateTime(date) {
  return new Intl.DateTimeFormat('en-MY', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kuala_Lumpur' }).format(date);
}

function pdfSafe(value) {
  return String(value ?? '').normalize('NFKD').replace(/[^\x20-\x7E]/g, '?');
}

function wrapText(text, maxChars) {
  const words = String(text || '').split(/\s+/);
  const lines = [];
  let current = '';
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else current = next;
  }
  if (current) lines.push(current);
  return lines;
}

function downloadFile(file) {
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
