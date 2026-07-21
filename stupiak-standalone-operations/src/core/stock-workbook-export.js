const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PDF_MIME = 'application/pdf';
const WEEK_INDEXES = [1, 2, 3, 4, 5];
const COLORS = {
  dark: '404040', mid: 'BFBFBF', pale: 'E7E6E6', white: 'FFFFFF', ink: '111111'
};

export async function exportStockExcel(stockState, outletName) {
  const snapshot = buildSnapshot(stockState, outletName);
  validateSnapshot(snapshot);
  const workbook = buildWorkbook(snapshot);
  const buffer = await workbook.xlsx.writeBuffer();
  downloadFile(new File([buffer], fileBaseName(snapshot) + '.xlsx', { type: XLSX_MIME }));
}

export async function exportStockPdf(stockState, outletName) {
  const snapshot = buildSnapshot(stockState, outletName);
  validateSnapshot(snapshot);
  downloadFile(await buildPdf(snapshot));
}

function buildSnapshot(state, outletName) {
  const sections = {};
  for (const section of state.data?.sections || []) {
    const rows = (section.rows || []).map((row) => ({
      row: Number(row.row),
      item: String(row.item || ''),
      minimum: numericOrBlank(row.minimum),
      conversion: Number(row.conversion || 1),
      hasSecondaryQuantity: Boolean(row.hasSecondaryQuantity),
      primaryUnit: row.weeks?.[0]?.primaryUnit || row.unit || '',
      secondaryUnit: row.weeks?.[0]?.secondaryUnit || '',
      unit: row.weeks?.[0]?.unit || row.unit || '',
      weeks: Object.fromEntries(WEEK_INDEXES.map((week) => {
        const value = state.values?.[section.sheetName]?.[row.row]?.[week] || {};
        return [week, {
          primary: numericOrBlank(value.primary),
          secondary: numericOrBlank(value.secondary),
          quantity: numericOrBlank(value.quantity)
        }];
      })),
      monthly: { quantity: numericOrBlank(state.values?.[section.sheetName]?.[row.row]?.quantity) }
    }));
    sections[section.sheetName] = { type: section.type, rows };
  }
  return {
    outlet: String(outletName || state.data?.outlet || 'Outlet'),
    monthKey: String(state.monthKey || state.businessDate || '').slice(0, 7),
    countedBy: String(state.countedBy || 'UNKNOWN').trim() || 'UNKNOWN',
    note: String(state.sessionNote || '').trim(),
    weekDates: { ...(state.weekDates || {}) },
    stationaryDate: String(state.stationaryDate || ''),
    sections
  };
}

function validateSnapshot(snapshot) {
  if (!WEEK_INDEXES.some((week) => snapshot.weekDates[week]) && !snapshot.stationaryDate) {
    throw new Error('Enter at least one Week count date before exporting.');
  }
}

function buildWorkbook(snapshot) {
  const ExcelJS = window.ExcelJS;
  if (!ExcelJS) throw new Error('Excel generator is not loaded. Refresh the page and try again.');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Stupiak Operations';
  wb.created = new Date();
  wb.modified = new Date();
  wb.calcProperties.fullCalcOnLoad = true;
  wb.calcProperties.forceFullCalc = true;
  wb.calcProperties.calcMode = 'auto';
  addOrderPage(wb, snapshot);
  addInventorySheet(wb, snapshot);
  addUtensilSheet(wb, snapshot, 'Untensil PG1');
  addUtensilSheet(wb, snapshot, 'Utensil PG2');
  addStationarySheet(wb, snapshot);
  return wb;
}

function addInventorySheet(wb, snapshot) {
  const sheet = wb.addWorksheet('Inventory ', pageSetup());
  const widths = [69.29,4.43,6.29,6.29,6,7.86,6.29,6.29,6.29,6.29,7.86,6.29,6.29,6.29,6.29,8,6.29,6.29,6.29,6.29,7.86,7.86,7.86,7.86,7.86,7.86,4.43,10,10,9,9,9,9,9];
  widths.forEach((width, i) => { sheet.getColumn(i + 1).width = width; });
  [6,11,16,21,26,30,31,32,33,34].forEach((col) => { sheet.getColumn(col).hidden = true; });
  sheet.mergeCells('A1:Z1');
  sheet.getCell('A1').value = `Inventory listing ${snapshot.monthKey.slice(0, 4)}`;
  titleStyle(sheet.getCell('A1'));
  sheet.getRow(1).height = 26;
  sheet.mergeCells('A2:A3');
  sheet.getCell('A2').value = 'ITEM';
  darkHeader(sheet.getCell('A2'));
  const starts = [2,7,12,17,22];
  starts.forEach((start, idx) => {
    sheet.mergeCells(2, start, 2, start + 4);
    sheet.getCell(2, start).value = weekHeader(snapshot, idx + 1);
    darkHeader(sheet.getCell(2, start));
    sheet.mergeCells(3, start, 3, start + 3);
    sheet.getCell(3, start).value = 'Quantity and Unit';
    grayHeader(sheet.getCell(3, start));
    sheet.getCell(3, start + 4).value = 'Status';
    grayHeader(sheet.getCell(3, start + 4));
  });
  sheet.getCell('AA2').value = 'MIN';
  sheet.mergeCells('AA2:AA3');
  darkHeader(sheet.getCell('AA2'));

  const section = snapshot.sections.Inventory;
  for (const item of section?.rows || []) {
    const rowNo = item.row;
    const row = sheet.getRow(rowNo);
    row.height = 22;
    row.getCell(1).value = item.item;
    bodyStyle(row.getCell(1), rowNo);
    for (const week of WEEK_INDEXES) {
      const start = starts[week - 1];
      const value = item.weeks[week];
      const active = Boolean(snapshot.weekDates[week]);
      if (item.hasSecondaryQuantity) {
        row.getCell(start).value = active ? blankToNull(value.primary) : null;
        row.getCell(start + 1).value = item.primaryUnit;
        row.getCell(start + 2).value = active ? blankToNull(value.secondary) : null;
        row.getCell(start + 3).value = item.secondaryUnit;
      } else {
        sheet.mergeCells(rowNo, start, rowNo, start + 1);
        sheet.mergeCells(rowNo, start + 2, rowNo, start + 3);
        row.getCell(start).value = active ? blankToNull(value.primary) : null;
        row.getCell(start + 2).value = item.primaryUnit;
      }
      const status = active ? inventoryStatus(item, value) : '';
      row.getCell(start + 4).value = status;
      for (let col = start; col <= start + 4; col += 1) bodyStyle(row.getCell(col), rowNo, 'center');
      row.getCell(29 + week).value = status ? item.item : '';
    }
    row.getCell(27).value = blankToNull(item.minimum);
    bodyStyle(row.getCell(27), rowNo, 'center');
  }
  sheet.pageSetup.printArea = `A1:AA${Math.max(...(section?.rows || []).map((r) => r.row), 3)}`;
  sheet.views = [{ state: 'frozen', xSplit: 1, ySplit: 3 }];
}

function addUtensilSheet(wb, snapshot, name) {
  const sheet = wb.addWorksheet(name === 'Untensil PG1' ? 'Untensil PG1' : 'Utensil PG2', pageSetup());
  const pg1 = name === 'Untensil PG1';
  const widths = pg1
    ? [66,6.86,7.29,8,7.57,7.29,8,8,7.29,8,10.29,7.29,7.71,9,7.29,9,4,9,9,9,9,9,9]
    : [65.57,7.86,10,10.43,7.43,9.86,8.71,6,10,12.43,9,10,14.71,9,10,11.43,5.43,9,9,9,9,9,9,9];
  widths.forEach((width, i) => { sheet.getColumn(i + 1).width = width; });
  if (pg1) [4,7,10,13,16,19,20,21,22,23].forEach((c) => { sheet.getColumn(c).hidden = true; });
  else [20,21,22,23,24].forEach((c) => { sheet.getColumn(c).hidden = true; });
  sheet.mergeCells('A1:M1');
  sheet.getCell('A1').value = `Untensil Inventory listing ${snapshot.monthKey.slice(0,4)} (WEEKLY STOCK)`;
  titleStyle(sheet.getCell('A1'));
  sheet.mergeCells('A2:A3'); sheet.getCell('A2').value = 'ITEM'; darkHeader(sheet.getCell('A2'));
  const starts = [2,5,8,11,14];
  starts.forEach((start, idx) => {
    sheet.mergeCells(2, start, 2, start + 2);
    sheet.getCell(2, start).value = weekHeader(snapshot, idx + 1);
    darkHeader(sheet.getCell(2, start));
    sheet.mergeCells(3, start, 3, start + 1);
    sheet.getCell(3, start).value = 'Quantity ＆ Unit';
    grayHeader(sheet.getCell(3, start));
    sheet.getCell(3, start + 2).value = 'Status';
    grayHeader(sheet.getCell(3, start + 2));
  });
  sheet.mergeCells('Q2:Q3'); sheet.getCell('Q2').value = 'Minimun Order\nQuantity'; darkHeader(sheet.getCell('Q2'));
  const section = snapshot.sections[name];
  for (const item of section?.rows || []) {
    const row = sheet.getRow(item.row);
    row.height = 22;
    row.getCell(1).value = item.item;
    bodyStyle(row.getCell(1), item.row);
    for (const week of WEEK_INDEXES) {
      const start = starts[week - 1];
      const active = Boolean(snapshot.weekDates[week]);
      const value = item.weeks[week];
      row.getCell(start).value = active ? blankToNull(value.quantity) : null;
      row.getCell(start + 1).value = item.unit;
      row.getCell(start + 2).value = active ? utensilStatus(name, item, value.quantity) : '';
      for (let col = start; col <= start + 2; col += 1) bodyStyle(row.getCell(col), item.row, 'center');
      row.getCell((pg1 ? 18 : 19) + week).value = row.getCell(start + 2).value ? item.item : '';
    }
    row.getCell(17).value = blankToNull(item.minimum);
    bodyStyle(row.getCell(17), item.row, 'center');
  }
  sheet.pageSetup.printArea = `A1:Q${Math.max(...(section?.rows || []).map((r) => r.row),3)}`;
  sheet.views = [{ state: 'frozen', xSplit: 1, ySplit: 3 }];
}

function addStationarySheet(wb, snapshot) {
  const sheet = wb.addWorksheet('Stationary ', pageSetup());
  [59,12.14,12.14,12.14,5,34.57].forEach((width, i) => { sheet.getColumn(i + 1).width = width; });
  sheet.getColumn(6).hidden = true;
  sheet.mergeCells('A1:D1'); sheet.getCell('A1').value = `Stationary Intensity listing ${snapshot.monthKey.slice(0,4)} (MONTHLY STOCK)`; titleStyle(sheet.getCell('A1'));
  sheet.mergeCells('A2:A3'); sheet.getCell('A2').value = 'ITEM'; darkHeader(sheet.getCell('A2'));
  sheet.mergeCells('B2:D2'); sheet.getCell('B2').value = snapshot.stationaryDate ? `COUNT DATE · ${formatDate(snapshot.stationaryDate)}` : 'MONTHLY STOCK'; darkHeader(sheet.getCell('B2'));
  sheet.mergeCells('B3:C3'); sheet.getCell('B3').value = 'Quantity ＆ Unit'; grayHeader(sheet.getCell('B3'));
  sheet.getCell('D3').value = 'Status'; grayHeader(sheet.getCell('D3'));
  sheet.getCell('E3').value = 'Min Order'; darkHeader(sheet.getCell('E3'));
  const section = snapshot.sections.Stationary;
  for (const item of section?.rows || []) {
    const row = sheet.getRow(item.row);
    row.height = 22;
    row.getCell(1).value = item.item;
    row.getCell(2).value = snapshot.stationaryDate ? blankToNull(item.monthly.quantity) : null;
    row.getCell(3).value = item.unit;
    row.getCell(4).value = snapshot.stationaryDate && Number(item.monthly.quantity || 0) <= Number(item.minimum || 0) ? 'Order' : '';
    row.getCell(5).value = blankToNull(item.minimum);
    row.getCell(6).value = row.getCell(4).value ? item.item : '';
    for (let col = 1; col <= 6; col += 1) bodyStyle(row.getCell(col), item.row, col === 1 ? 'left' : 'center');
  }
  sheet.pageSetup.printArea = `A1:E${Math.max(...(section?.rows || []).map((r) => r.row),3)}`;
  sheet.views = [{ state: 'frozen', xSplit: 1, ySplit: 3 }];
}

function addOrderPage(wb, snapshot) {
  const sheet = wb.addWorksheet('Order Page', pageSetup());
  [65,16,16,16,16].forEach((width, i) => { sheet.getColumn(i + 1).width = width; });
  let rowNo = 1;
  for (const week of WEEK_INDEXES) {
    const inv = orderItems(snapshot.sections.Inventory?.rows || [], week, 'Inventory');
    const u1 = orderItems(snapshot.sections['Untensil PG1']?.rows || [], week, 'Untensil PG1');
    const u2 = orderItems(snapshot.sections['Utensil PG2']?.rows || [], week, 'Utensil PG2');
    sheet.mergeCells(rowNo,1,rowNo,5); sheet.getCell(rowNo,1).value = weekHeader(snapshot, week); darkHeader(sheet.getCell(rowNo,1)); rowNo += 1;
    rowNo = addOrderBlock(sheet, rowNo, 'Inventory Order List', inv);
    rowNo = addOrderBlock(sheet, rowNo, 'Utensil Order List', [...u1, ...u2]);
    rowNo += 1;
  }
  rowNo = addOrderBlock(sheet, rowNo, 'Stationary Stock (MONTHLY)', orderItems(snapshot.sections.Stationary?.rows || [], null, 'Stationary'));
  sheet.pageSetup.printArea = `A1:E${rowNo}`;
}

function addOrderBlock(sheet, rowNo, title, items) {
  sheet.mergeCells(rowNo,1,rowNo,5); sheet.getCell(rowNo,1).value = title; grayHeader(sheet.getCell(rowNo,1)); rowNo += 1;
  const text = items.length ? items.join(', ') : 'No order required';
  sheet.mergeCells(rowNo,1,rowNo,5); sheet.getCell(rowNo,1).value = text; bodyStyle(sheet.getCell(rowNo,1), rowNo); sheet.getCell(rowNo,1).alignment = { wrapText: true, vertical: 'top', horizontal: 'left' }; sheet.getRow(rowNo).height = Math.max(28, Math.ceil(text.length / 95) * 18);
  return rowNo + 1;
}

function orderItems(rows, week, sectionName) {
  return rows.filter((item) => {
    if (sectionName === 'Stationary') return item.monthly.quantity !== '' && Number(item.monthly.quantity || 0) <= Number(item.minimum || 0);
    if (!week) return false;
    const value = item.weeks[week];
    return sectionName === 'Inventory' ? inventoryStatus(item, value) === 'Order' : utensilStatus(sectionName, item, value.quantity) !== '';
  }).map((item) => item.item);
}

function pageSetup() {
  return { pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.25, right: 0.25, top: 0.35, bottom: 0.35, header: 0.1, footer: 0.1 } } };
}
function titleStyle(cell) { cell.font = { bold: true, size: 18, color: { argb: COLORS.ink } }; cell.alignment = { horizontal: 'center', vertical: 'middle' }; }
function darkHeader(cell) { cell.fill = solid(COLORS.dark); cell.font = { bold: true, color: { argb: COLORS.white }, size: 11 }; cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }; cell.border = whiteBorder(); }
function grayHeader(cell) { cell.fill = solid(COLORS.mid); cell.font = { bold: true, color: { argb: COLORS.ink }, size: 10 }; cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }; cell.border = whiteBorder(); }
function bodyStyle(cell, rowNo, align = 'left') { cell.fill = solid(rowNo % 2 === 0 ? COLORS.mid : COLORS.pale); cell.font = { color: { argb: COLORS.ink }, size: 10 }; cell.alignment = { horizontal: align, vertical: 'middle', wrapText: true }; cell.border = whiteBorder(); }
function solid(argb) { return { type: 'pattern', pattern: 'solid', fgColor: { argb } }; }
function whiteBorder() { return { top:{style:'thin',color:{argb:COLORS.white}},left:{style:'thin',color:{argb:COLORS.white}},bottom:{style:'thin',color:{argb:COLORS.white}},right:{style:'thin',color:{argb:COLORS.white}} }; }

async function buildPdf(snapshot) {
  const PDFLib = window.PDFLib;
  if (!PDFLib) throw new Error('PDF generator is not loaded. Refresh the page and try again.');
  const { PDFDocument, StandardFonts } = PDFLib;
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  addPdfSection(doc, font, bold, snapshot, 'Inventory');
  addPdfSection(doc, font, bold, snapshot, 'Untensil PG1');
  addPdfSection(doc, font, bold, snapshot, 'Utensil PG2');
  addPdfStationary(doc, font, bold, snapshot);
  return new File([await doc.save()], fileBaseName(snapshot) + '.pdf', { type: PDF_MIME });
}

function addPdfSection(doc, font, bold, snapshot, name) {
  const rows = snapshot.sections[name]?.rows || [];
  const pageSize = [841.89, 595.28], margin = 22, itemWidth = 270, minWidth = 42;
  const weekWidth = (pageSize[0] - margin * 2 - itemWidth - minWidth) / 5, rowHeight = 18, headerHeight = 54;
  let page, y;
  const newPage = () => {
    page = doc.addPage(pageSize); y = pageSize[1] - margin;
    page.drawText(pdfText(name === 'Inventory' ? `Inventory listing ${snapshot.monthKey.slice(0,4)}` : `Untensil Inventory listing ${snapshot.monthKey.slice(0,4)} (WEEKLY STOCK)`), { x: margin, y: y - 16, size: 15, font: bold, color: window.PDFLib.rgb(.07,.07,.07) });
    y -= 28; drawPdfHeader(page, bold, snapshot, y, margin, itemWidth, weekWidth, minWidth); y -= headerHeight;
  };
  newPage();
  rows.forEach((item, index) => {
    if (y - rowHeight < margin) newPage();
    const fill = index % 2 === 0 ? window.PDFLib.rgb(.75,.75,.75) : window.PDFLib.rgb(.90,.90,.90);
    drawRect(page, margin, y-rowHeight, itemWidth, rowHeight, fill); drawFitted(page, item.item, margin+4, y-12, itemWidth-8, 7.4, font);
    for (const week of WEEK_INDEXES) {
      const x = margin + itemWidth + (week-1)*weekWidth; drawRect(page, x, y-rowHeight, weekWidth, rowHeight, fill);
      const active = Boolean(snapshot.weekDates[week]), value = item.weeks[week]; let text = '';
      if (active) text = name === 'Inventory' ? (item.hasSecondaryQuantity ? `${display(value.primary)} ${item.primaryUnit} + ${display(value.secondary)} ${item.secondaryUnit}` : `${display(value.primary)} ${item.primaryUnit}`) : `${display(value.quantity)} ${item.unit}`;
      drawFitted(page, text, x+3, y-12, weekWidth-6, 7, font, 'center');
    }
    const xMin = margin+itemWidth+weekWidth*5; drawRect(page, xMin, y-rowHeight, minWidth, rowHeight, fill); drawFitted(page, display(item.minimum), xMin+2, y-12, minWidth-4, 7.2, bold, 'center'); y -= rowHeight;
  });
}

function drawPdfHeader(page, bold, snapshot, y, margin, itemWidth, weekWidth, minWidth) {
  const dark = window.PDFLib.rgb(.25,.25,.25);
  drawRect(page, margin, y-50, itemWidth, 50, dark); drawFitted(page, 'ITEM', margin+4, y-28, itemWidth-8, 10, bold, 'center');
  for (const week of WEEK_INDEXES) {
    const x = margin+itemWidth+(week-1)*weekWidth; drawRect(page,x,y-50,weekWidth,50,dark);
    drawMultiline(page, `WEEK ${week}\n${weekPeriod(snapshot.monthKey,week)}\n${snapshot.weekDates[week] ? 'Counted '+formatDate(snapshot.weekDates[week]) : ''}`, x+2, y-14, weekWidth-4, 8, bold, 'center');
  }
  const xMin=margin+itemWidth+weekWidth*5; drawRect(page,xMin,y-50,minWidth,50,dark); drawFitted(page,'MIN',xMin+2,y-28,minWidth-4,9,bold,'center');
}

function addPdfStationary(doc, font, bold, snapshot) {
  const rows = snapshot.sections.Stationary?.rows || [], pageSize=[841.89,595.28], margin=26, rowHeight=20;
  let page=doc.addPage(pageSize), y=pageSize[1]-margin;
  page.drawText(`Stationary Intensity listing ${snapshot.monthKey.slice(0,4)} (MONTHLY STOCK)`,{x:margin,y:y-16,size:15,font:bold,color:window.PDFLib.rgb(.07,.07,.07)}); y-=30;
  const widths=[460,90,80,80,70];
  ['ITEM','QUANTITY','UNIT','STATUS','MIN'].forEach((h,i)=>{const x=margin+widths.slice(0,i).reduce((a,b)=>a+b,0);drawRect(page,x,y-32,widths[i],32,window.PDFLib.rgb(.25,.25,.25));drawFitted(page,h,x+3,y-20,widths[i]-6,9,bold,'center');}); y-=32;
  rows.forEach((item,index)=>{if(y-rowHeight<margin){page=doc.addPage(pageSize);y=pageSize[1]-margin;}const fill=index%2===0?window.PDFLib.rgb(.75,.75,.75):window.PDFLib.rgb(.90,.90,.90);const vals=[item.item,snapshot.stationaryDate?display(item.monthly.quantity):'',item.unit,snapshot.stationaryDate&&Number(item.monthly.quantity||0)<=Number(item.minimum||0)?'Order':'',display(item.minimum)];vals.forEach((v,i)=>{const x=margin+widths.slice(0,i).reduce((a,b)=>a+b,0);drawRect(page,x,y-rowHeight,widths[i],rowHeight,fill);drawFitted(page,v,x+3,y-13,widths[i]-6,7.5,i===0?font:(i===3?bold:font),i===0?'left':'center');});y-=rowHeight;});
}

function drawRect(page,x,y,w,h,color){page.drawRectangle({x,y,width:w,height:h,color,borderColor:window.PDFLib.rgb(1,1,1),borderWidth:.5});}
function drawFitted(page,text,x,y,maxWidth,size,font,align='left'){let s=pdfText(text),z=size;while(z>5&&font.widthOfTextAtSize(s,z)>maxWidth)z-=.25;if(font.widthOfTextAtSize(s,z)>maxWidth){while(s.length>2&&font.widthOfTextAtSize(s+'...',z)>maxWidth)s=s.slice(0,-1);s+='...';}const w=font.widthOfTextAtSize(s,z),dx=align==='center'?Math.max(0,(maxWidth-w)/2):0;page.drawText(s,{x:x+dx,y,size:z,font,color:window.PDFLib.rgb(.05,.05,.05)});}
function drawMultiline(page,text,x,y,maxWidth,size,font,align){String(text||'').split('\n').forEach((line,i)=>drawFitted(page,line,x,y-i*(size+2),maxWidth,size,font,align));}
function inventoryStatus(item,value){return Number(value.primary||0)*Number(item.conversion||1)+Number(value.secondary||0)<=Number(item.minimum||0)?'Order':'';}
function utensilStatus(name,item,quantity){const q=Number(quantity||0);if(name==='Utensil PG2'&&item.row===9)return q<=0?'No More Use':'';if(name==='Utensil PG2'&&item.row===36)return q<=4?'Spare Item':'';return q<=Number(item.minimum||0)?'Order':'';}
function weekHeader(snapshot,week){const date=snapshot.weekDates[week];return `WEEK ${week}\n${weekPeriod(snapshot.monthKey,week)}${date?`\nCounted ${formatDate(date)}`:''}`;}
function weekPeriod(monthKey,week){const start=new Date(`${monthKey}-01T12:00:00`),offset=(start.getDay()+6)%7;start.setDate(start.getDate()-offset+(week-1)*7);const end=new Date(start);end.setDate(end.getDate()+6);return `${shortDate(start)}–${shortDate(end)}`;}
function shortDate(date){return new Intl.DateTimeFormat('en-MY',{day:'numeric',month:'short',timeZone:'Asia/Kuala_Lumpur'}).format(date);}
function formatDate(value){const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value||''));if(!m)return String(value||'');return new Intl.DateTimeFormat('en-MY',{day:'numeric',month:'short',year:'numeric',timeZone:'Asia/Kuala_Lumpur'}).format(new Date(Number(m[1]),Number(m[2])-1,Number(m[3]),12));}
function fileBaseName(snapshot){return `RR-KCH Inventory Listing - ${safe(snapshot.outlet)} - ${snapshot.monthKey}`;}
function safe(value){return String(value||'Outlet').replace(/[^a-z0-9._-]+/gi,'-').replace(/^-+|-+$/g,'');}
function display(value){return value===''||value===null||value===undefined?'':String(value);}
function numericOrBlank(value){return value===''||value===null||value===undefined?'':Number(value);}
function blankToNull(value){return value===''||value===null||value===undefined?null:Number(value);}
function pdfText(value){return String(value??'').replace(/[–—]/g,'-').replace(/[“”]/g,'"').replace(/[‘’]/g,"'").normalize('NFKD').replace(/[^\x20-\x7E]/g,'?');}
function downloadFile(file){const url=URL.createObjectURL(file),link=document.createElement('a');link.href=url;link.download=file.name;document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);}
