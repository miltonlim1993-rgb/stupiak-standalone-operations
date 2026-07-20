const WEEKLY_SECTIONS = ['Inventory', 'Untensil PG1', 'Utensil PG2'];
const SECTION_ORDER = ['Inventory', 'Untensil PG1', 'Utensil PG2', 'Stationary'];
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PDF_MIME = 'application/pdf';

const COLORS = {
  navy: '23395B',
  blue: '548ED4',
  lightBlue: 'D9EAF7',
  paleBlue: 'EDF4FA',
  white: 'FFFFFF',
  ink: '172033',
  muted: '667085',
  line: 'AAB7C8',
  green: 'E2F0D9',
  greenText: '207245',
  red: 'FCE4D6',
  redText: 'B42318',
  amber: 'FFF2CC',
  amberText: '8A6116'
};

export async function prepareStockPackage(stockState, outletName) {
  const snapshot = buildStockSnapshot(stockState, outletName);
  validateSnapshot(snapshot);
  const [pdfFile, excelFile] = await Promise.all([
    createTemplatePdfFile(snapshot),
    createTemplateExcelFile(snapshot)
  ]);
  return {
    snapshot,
    pdfFile,
    excelFile,
    files: [pdfFile, excelFile],
    message: buildWhatsappMessage(snapshot),
    preparedAt: Date.now()
  };
}

export async function shareStockPackage(preparedPackage) {
  if (!preparedPackage?.files?.length) throw new Error('Prepare the PDF and Excel first.');
  const files = preparedPackage.files;
  const message = preparedPackage.message || '';
  const snapshot = preparedPackage.snapshot || {};
  const mobileLike = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const canShareFiles = mobileLike
    && Boolean(navigator.share)
    && (!navigator.canShare || navigator.canShare({ files }));

  if (canShareFiles) {
    await navigator.share({
      title: `Stock Count · ${snapshot.outlet || 'Outlet'}`,
      text: message,
      files
    });
    return { shared: true, files, message };
  }

  files.forEach(downloadFile);
  try { await navigator.clipboard.writeText(message); } catch (_) {}
  const whatsappWindow = window.open(`https://wa.me/?text=${encodeURIComponent(message)}`, '_blank', 'noopener');
  return { shared: false, downloaded: true, whatsappOpened: Boolean(whatsappWindow), files, message };
}

export async function prepareAndShareStockPackage(stockState, outletName) {
  const preparedPackage = await prepareStockPackage(stockState, outletName);
  return shareStockPackage(preparedPackage);
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

async function createTemplateExcelFile(snapshot) {
  const ExcelJS = window.ExcelJS;
  if (!ExcelJS) throw new Error('Excel generator is not loaded. Refresh the page and try again.');

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Stupiak Operations';
  workbook.created = snapshot.preparedAt;
  workbook.modified = snapshot.preparedAt;

  const sheet = workbook.addWorksheet('STOCK COUNT', {
    properties: { defaultRowHeight: 20 },
    pageSetup: {
      paperSize: 9,
      orientation: 'landscape',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      margins: { left: 0.25, right: 0.25, top: 0.35, bottom: 0.35, header: 0.15, footer: 0.15 }
    }
  });
  sheet.columns = [
    { key: 'item', width: 43 },
    { key: 'mainQty', width: 13 },
    { key: 'mainUnit', width: 14 },
    { key: 'secondary', width: 18 },
    { key: 'minimum', width: 12 },
    { key: 'status', width: 15 }
  ];
  sheet.views = [{ state: 'frozen', ySplit: 6 }];
  sheet.pageSetup.printTitlesRow = '1:6';

  sheet.mergeCells('A1:F1');
  sheet.getCell('A1').value = 'STOCK COUNT';
  styleTitle(sheet.getCell('A1'));
  sheet.getRow(1).height = 34;

  addMetadataRow(sheet, 2, 'OUTLET', snapshot.outlet, 'COUNT DATE', snapshot.countDates.map(formatDateForMessage).join(', '));
  addMetadataRow(sheet, 3, 'PERIOD', periodLabel(snapshot), 'COUNTED BY', snapshot.countedBy);
  sheet.getCell('A4').value = 'SESSION NOTE';
  styleMetaLabel(sheet.getCell('A4'));
  sheet.mergeCells('B4:F4');
  sheet.getCell('B4').value = snapshot.note || '—';
  styleMetaValue(sheet.getCell('B4'));
  sheet.getRow(4).height = 24;
  sheet.getRow(5).height = 8;

  let cursor = 6;
  for (const section of groupRowsBySection(snapshot.rows)) {
    cursor = addExcelSection(sheet, cursor, section.name, section.rows);
    cursor += 1;
  }

  const lastRow = Math.max(cursor - 1, 6);
  sheet.autoFilter = undefined;
  sheet.pageSetup.printArea = `A1:F${lastRow}`;
  sheet.headerFooter.oddFooter = '&LStupiak Operations&CStock Count&RPage &P of &N';
  sheet.headerFooter.evenFooter = sheet.headerFooter.oddFooter;

  const buffer = await workbook.xlsx.writeBuffer();
  return new File([buffer], fileBaseName(snapshot) + '.xlsx', { type: XLSX_MIME });
}

function addMetadataRow(sheet, rowNumber, leftLabel, leftValue, rightLabel, rightValue) {
  sheet.getCell(`A${rowNumber}`).value = leftLabel;
  styleMetaLabel(sheet.getCell(`A${rowNumber}`));
  sheet.mergeCells(`B${rowNumber}:C${rowNumber}`);
  sheet.getCell(`B${rowNumber}`).value = leftValue;
  styleMetaValue(sheet.getCell(`B${rowNumber}`));
  sheet.getCell(`D${rowNumber}`).value = rightLabel;
  styleMetaLabel(sheet.getCell(`D${rowNumber}`));
  sheet.mergeCells(`E${rowNumber}:F${rowNumber}`);
  sheet.getCell(`E${rowNumber}`).value = rightValue;
  styleMetaValue(sheet.getCell(`E${rowNumber}`));
  sheet.getRow(rowNumber).height = 24;
}

function addExcelSection(sheet, startRow, sectionName, rows) {
  sheet.mergeCells(`A${startRow}:F${startRow}`);
  const sectionCell = sheet.getCell(`A${startRow}`);
  sectionCell.value = displaySectionName(sectionName).toUpperCase();
  sectionCell.fill = solidFill(COLORS.navy);
  sectionCell.font = { bold: true, color: { argb: COLORS.white }, size: 12 };
  sectionCell.alignment = { vertical: 'middle', horizontal: 'left' };
  sectionCell.border = thinBorder(COLORS.navy);
  sheet.getRow(startRow).height = 24;

  const headerRow = startRow + 1;
  const headers = ['ITEM', 'MAIN QTY', 'MAIN UNIT', 'SECONDARY UNIT', 'MINIMUM', 'STATUS'];
  headers.forEach((header, index) => {
    const cell = sheet.getCell(headerRow, index + 1);
    cell.value = header;
    cell.fill = solidFill(COLORS.blue);
    cell.font = { bold: true, color: { argb: COLORS.white }, size: 10 };
    cell.alignment = { vertical: 'middle', horizontal: index === 0 ? 'left' : 'center', wrapText: true };
    cell.border = thinBorder(COLORS.white);
  });
  sheet.getRow(headerRow).height = 28;

  let rowNumber = headerRow + 1;
  rows.forEach((row, index) => {
    const values = displayRowValues(row);
    const excelRow = sheet.getRow(rowNumber);
    excelRow.values = values;
    excelRow.height = Math.max(22, Math.ceil(String(row.item).length / 38) * 15);
    const fill = index % 2 === 0 ? COLORS.lightBlue : COLORS.paleBlue;
    for (let column = 1; column <= 6; column += 1) {
      const cell = excelRow.getCell(column);
      cell.fill = solidFill(fill);
      cell.font = { color: { argb: COLORS.ink }, size: 10, bold: column === 1 };
      cell.alignment = {
        vertical: 'middle',
        horizontal: column === 1 ? 'left' : 'center',
        wrapText: true
      };
      cell.border = thinBorder(COLORS.line);
    }
    styleStatusCell(excelRow.getCell(6), row.status);
    rowNumber += 1;
  });
  return rowNumber;
}

function styleTitle(cell) {
  cell.fill = solidFill(COLORS.navy);
  cell.font = { bold: true, color: { argb: COLORS.white }, size: 20 };
  cell.alignment = { vertical: 'middle', horizontal: 'center' };
  cell.border = thinBorder(COLORS.navy);
}

function styleMetaLabel(cell) {
  cell.fill = solidFill(COLORS.blue);
  cell.font = { bold: true, color: { argb: COLORS.white }, size: 10 };
  cell.alignment = { vertical: 'middle', horizontal: 'left' };
  cell.border = thinBorder(COLORS.white);
}

function styleMetaValue(cell) {
  cell.fill = solidFill(COLORS.lightBlue);
  cell.font = { bold: true, color: { argb: COLORS.ink }, size: 10 };
  cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
  cell.border = thinBorder(COLORS.line);
}

function styleStatusCell(cell, status) {
  const attention = Boolean(status);
  cell.value = attention ? status : 'OK';
  cell.fill = solidFill(attention ? COLORS.red : COLORS.green);
  cell.font = {
    bold: true,
    color: { argb: attention ? COLORS.redText : COLORS.greenText },
    size: 10
  };
  cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
}

function solidFill(argb) {
  return { type: 'pattern', pattern: 'solid', fgColor: { argb } };
}

function thinBorder(argb) {
  const side = { style: 'thin', color: { argb } };
  return { top: side, left: side, bottom: side, right: side };
}

async function createTemplatePdfFile(snapshot) {
  const PDFLib = window.PDFLib;
  if (!PDFLib) throw new Error('PDF generator is not loaded. Refresh the page and try again.');
  const { PDFDocument, StandardFonts, rgb } = PDFLib;
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const pageSize = [841.89, 595.28];
  const margin = 24;
  const tableWidth = pageSize[0] - margin * 2;
  const columnWidths = [315, 76, 82, 112, 82, tableWidth - 667];
  const groups = groupRowsBySection(snapshot.rows);
  let page;
  let y;
  let pageNumber = 0;

  const addPage = () => {
    page = pdf.addPage(pageSize);
    pageNumber += 1;
    y = page.getHeight() - margin;
    drawPdfHeader(page, snapshot, regular, bold, rgb, margin, tableWidth, y);
    y -= 102;
  };

  const ensureSpace = (requiredHeight) => {
    if (!page || y - requiredHeight < margin + 22) addPage();
  };

  addPage();
  for (const group of groups) {
    ensureSpace(48);
    y = drawPdfSectionHeader(page, y, group.name, bold, rgb, margin, tableWidth, columnWidths);
    group.rows.forEach((row, index) => {
      const values = displayRowValues(row).map((value) => pdfSafe(value));
      const itemLines = wrapTextByWidth(values[0], bold, 8.2, columnWidths[0] - 12);
      const secondaryLines = wrapTextByWidth(values[3], regular, 8.2, columnWidths[3] - 12);
      const lineCount = Math.max(1, itemLines.length, secondaryLines.length);
      const rowHeight = Math.max(22, lineCount * 10 + 8);
      if (y - rowHeight < margin + 22) {
        addPage();
        y = drawPdfSectionHeader(page, y, `${group.name} · CONTINUED`, bold, rgb, margin, tableWidth, columnWidths);
      }
      y = drawPdfDataRow(page, y, rowHeight, values, row.status, index, regular, bold, rgb, margin, columnWidths);
    });
    y -= 8;
  }

  const pages = pdf.getPages();
  pages.forEach((pdfPage, index) => {
    const footer = `Stupiak Operations  ·  Stock Count  ·  Page ${index + 1} of ${pages.length}`;
    pdfPage.drawText(footer, {
      x: margin,
      y: 12,
      size: 7.5,
      font: regular,
      color: hexRgb(rgb, COLORS.muted)
    });
  });

  const bytes = await pdf.save();
  return new File([bytes], fileBaseName(snapshot) + '.pdf', { type: PDF_MIME });
}

function drawPdfHeader(page, snapshot, regular, bold, rgb, margin, width, topY) {
  const navy = hexRgb(rgb, COLORS.navy);
  const blue = hexRgb(rgb, COLORS.blue);
  const lightBlue = hexRgb(rgb, COLORS.lightBlue);
  const white = hexRgb(rgb, COLORS.white);
  const ink = hexRgb(rgb, COLORS.ink);
  page.drawRectangle({ x: margin, y: topY - 34, width, height: 34, color: navy });
  page.drawText('STOCK COUNT', { x: margin + 12, y: topY - 23, size: 19, font: bold, color: white });

  const metadataY = topY - 58;
  const half = width / 2;
  drawPdfMetaPair(page, margin, metadataY, half, 'OUTLET', snapshot.outlet, blue, lightBlue, white, ink, regular, bold);
  drawPdfMetaPair(page, margin + half, metadataY, half, 'COUNT DATE', snapshot.countDates.map(formatDateForMessage).join(', '), blue, lightBlue, white, ink, regular, bold);
  drawPdfMetaPair(page, margin, metadataY - 22, half, 'PERIOD', periodLabel(snapshot), blue, lightBlue, white, ink, regular, bold);
  drawPdfMetaPair(page, margin + half, metadataY - 22, half, 'COUNTED BY', snapshot.countedBy, blue, lightBlue, white, ink, regular, bold);
  page.drawRectangle({ x: margin, y: metadataY - 44, width: 90, height: 20, color: blue });
  page.drawText('SESSION NOTE', { x: margin + 6, y: metadataY - 37, size: 7.5, font: bold, color: white });
  page.drawRectangle({ x: margin + 90, y: metadataY - 44, width: width - 90, height: 20, color: lightBlue });
  page.drawText(pdfSafe(snapshot.note || '—'), { x: margin + 97, y: metadataY - 37, size: 8, font: regular, color: ink, maxWidth: width - 104 });
}

function drawPdfMetaPair(page, x, y, width, label, value, labelColor, valueColor, white, ink, regular, bold) {
  const labelWidth = 76;
  page.drawRectangle({ x, y, width: labelWidth, height: 20, color: labelColor });
  page.drawText(label, { x: x + 6, y: y + 7, size: 7.5, font: bold, color: white });
  page.drawRectangle({ x: x + labelWidth, y, width: width - labelWidth, height: 20, color: valueColor });
  page.drawText(pdfSafe(value), { x: x + labelWidth + 6, y: y + 6.5, size: 8.5, font: bold, color: ink, maxWidth: width - labelWidth - 12 });
}

function drawPdfSectionHeader(page, y, sectionName, bold, rgb, margin, width, columnWidths) {
  const navy = hexRgb(rgb, COLORS.navy);
  const blue = hexRgb(rgb, COLORS.blue);
  const white = hexRgb(rgb, COLORS.white);
  page.drawRectangle({ x: margin, y: y - 22, width, height: 22, color: navy });
  page.drawText(pdfSafe(displaySectionName(sectionName).toUpperCase()), { x: margin + 8, y: y - 15, size: 10.5, font: bold, color: white });
  y -= 22;
  const labels = ['ITEM', 'MAIN QTY', 'MAIN UNIT', 'SECONDARY UNIT', 'MINIMUM', 'STATUS'];
  let x = margin;
  labels.forEach((label, index) => {
    page.drawRectangle({ x, y: y - 23, width: columnWidths[index], height: 23, color: blue, borderColor: white, borderWidth: 0.5 });
    page.drawText(label, { x: x + 5, y: y - 15, size: 7.4, font: bold, color: white, maxWidth: columnWidths[index] - 10 });
    x += columnWidths[index];
  });
  return y - 23;
}

function drawPdfDataRow(page, y, height, values, status, rowIndex, regular, bold, rgb, margin, columnWidths) {
  const fill = hexRgb(rgb, rowIndex % 2 === 0 ? COLORS.lightBlue : COLORS.paleBlue);
  const border = hexRgb(rgb, COLORS.line);
  const ink = hexRgb(rgb, COLORS.ink);
  let x = margin;
  values.forEach((value, index) => {
    let cellFill = fill;
    let textColor = ink;
    let font = index === 0 ? bold : regular;
    if (index === 5) {
      cellFill = hexRgb(rgb, status ? COLORS.red : COLORS.green);
      textColor = hexRgb(rgb, status ? COLORS.redText : COLORS.greenText);
      font = bold;
    }
    page.drawRectangle({ x, y: y - height, width: columnWidths[index], height, color: cellFill, borderColor: border, borderWidth: 0.45 });
    const lines = wrapTextByWidth(value, font, 8.2, columnWidths[index] - 10);
    const startY = y - 12;
    lines.slice(0, Math.max(1, Math.floor((height - 6) / 10))).forEach((line, lineIndex) => {
      page.drawText(line, {
        x: x + 5,
        y: startY - lineIndex * 10,
        size: 8.2,
        font,
        color: textColor,
        maxWidth: columnWidths[index] - 10
      });
    });
    x += columnWidths[index];
  });
  return y - height;
}

function displayRowValues(row) {
  const mainQty = row.primary !== '' ? row.primary : row.quantity;
  const mainUnit = row.primary !== '' ? row.primaryUnit : row.unit;
  const secondary = row.secondary !== '' ? `${row.secondary} ${row.secondaryUnit}`.trim() : '';
  return [
    row.item,
    displayNumber(mainQty),
    mainUnit || '',
    secondary,
    displayNumber(row.minimum),
    row.status || 'OK'
  ];
}

function groupRowsBySection(rows) {
  const map = new Map();
  rows.forEach((row) => {
    if (!map.has(row.section)) map.set(row.section, []);
    map.get(row.section).push(row);
  });
  return [...map.entries()]
    .sort(([a], [b]) => sectionRank(a) - sectionRank(b))
    .map(([name, groupedRows]) => ({ name, rows: groupedRows }));
}

function sectionRank(name) {
  const index = SECTION_ORDER.indexOf(name);
  return index === -1 ? 99 : index;
}

function displaySectionName(name) {
  if (name === 'Untensil PG1') return 'Utensil PG1';
  return name;
}

function periodLabel(snapshot) {
  return snapshot.weekIndexes.length
    ? snapshot.weekIndexes.map((week) => `Week ${week}`).join(', ')
    : 'Monthly';
}

function buildWhatsappMessage(snapshot) {
  return [
    'STOCK COUNT',
    `Outlet: ${snapshot.outlet}`,
    `Counted: ${snapshot.countDates.map(formatDateForMessage).join(', ')}`
  ].join('\n');
}

function formatDateForMessage(value) {
  const text = String(value || '');
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return text;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return new Intl.DateTimeFormat('en-MY', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kuala_Lumpur' }).format(date);
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

function displayNumber(value) {
  if (value === '' || value === null || value === undefined) return '';
  const number = Number(value);
  return Number.isFinite(number) ? String(number) : String(value);
}

function formatDateTime(date) {
  return new Intl.DateTimeFormat('en-MY', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kuala_Lumpur' }).format(date);
}

function pdfSafe(value) {
  return String(value ?? '')
    .replace(/[–—]/g, '-')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '?');
}

function wrapTextByWidth(text, font, fontSize, maxWidth) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  const lines = [];
  let current = '';
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(next, fontSize) > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function hexRgb(rgb, hex) {
  const normalized = String(hex).replace('#', '');
  const value = Number.parseInt(normalized, 16);
  return rgb(((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255);
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
