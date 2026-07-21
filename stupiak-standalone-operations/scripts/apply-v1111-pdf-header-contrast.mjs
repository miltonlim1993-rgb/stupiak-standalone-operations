import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function replaceRequired(source, search, replacement, label) {
  if (!source.includes(search)) throw new Error(`v1.11.1 PDF contrast patch failed: ${label}`);
  return source.replace(search, replacement);
}

export async function applyV1111PdfHeaderContrast(dist) {
  const file = resolve(dist, 'src/core/stock-local-export.js');
  let source = await readFile(file, 'utf8');

  source = replaceRequired(
    source,
    `function drawFitted(page,text,x,y,maxWidth,size,font,align='left'){let s=pdfText(text),z=size;while(z>5&&font.widthOfTextAtSize(s,z)>maxWidth)z-=.25;if(font.widthOfTextAtSize(s,z)>maxWidth){while(s.length>2&&font.widthOfTextAtSize(s+'...',z)>maxWidth)s=s.slice(0,-1);s+='...';}const w=font.widthOfTextAtSize(s,z),dx=align==='center'?Math.max(0,(maxWidth-w)/2):0;page.drawText(s,{x:x+dx,y,size:z,font,color:window.PDFLib.rgb(.05,.05,.05)});}`,
    `function drawFitted(page,text,x,y,maxWidth,size,font,align='left',color=window.PDFLib.rgb(.05,.05,.05)){let s=pdfText(text),z=size;while(z>5&&font.widthOfTextAtSize(s,z)>maxWidth)z-=.25;if(font.widthOfTextAtSize(s,z)>maxWidth){while(s.length>2&&font.widthOfTextAtSize(s+'...',z)>maxWidth)s=s.slice(0,-1);s+='...';}const w=font.widthOfTextAtSize(s,z),dx=align==='center'?Math.max(0,(maxWidth-w)/2):0;page.drawText(s,{x:x+dx,y,size:z,font,color});}`,
    'drawFitted color parameter'
  );

  source = replaceRequired(
    source,
    `function drawMultiline(page,text,x,y,maxWidth,size,font,align){String(text||'').split('\\n').forEach((line,i)=>drawFitted(page,line,x,y-i*(size+2),maxWidth,size,font,align));}`,
    `function drawMultiline(page,text,x,y,maxWidth,size,font,align,color=window.PDFLib.rgb(.05,.05,.05)){String(text||'').split('\\n').forEach((line,i)=>drawFitted(page,line,x,y-i*(size+2),maxWidth,size,font,align,color));}`,
    'drawMultiline color parameter'
  );

  source = replaceRequired(
    source,
    `function drawPdfHeader(page, bold, snapshot, y, margin, itemWidth, weekWidth, minWidth) {
  const dark = window.PDFLib.rgb(.25,.25,.25);
  drawRect(page, margin, y-50, itemWidth, 50, dark); drawFitted(page, 'ITEM', margin+4, y-28, itemWidth-8, 10, bold, 'center');
  for (const week of WEEK_INDEXES) {
    const x = margin+itemWidth+(week-1)*weekWidth; drawRect(page,x,y-50,weekWidth,50,dark);
    drawMultiline(page, \`WEEK \${week}\\n\${weekPeriod(snapshot.monthKey,week)}\\n\${snapshot.weekDates[week] ? 'Counted '+formatDate(snapshot.weekDates[week]) : ''}\`, x+2, y-14, weekWidth-4, 8, bold, 'center');
  }
  const xMin=margin+itemWidth+weekWidth*5; drawRect(page,xMin,y-50,minWidth,50,dark); drawFitted(page,'MIN',xMin+2,y-28,minWidth-4,9,bold,'center');
}`,
    `function drawPdfHeader(page, bold, snapshot, y, margin, itemWidth, weekWidth, minWidth) {
  const dark = window.PDFLib.rgb(.25,.25,.25);
  const white = window.PDFLib.rgb(1,1,1);
  drawRect(page, margin, y-50, itemWidth, 50, dark); drawFitted(page, 'ITEM', margin+4, y-28, itemWidth-8, 10, bold, 'center', white);
  for (const week of WEEK_INDEXES) {
    const x = margin+itemWidth+(week-1)*weekWidth; drawRect(page,x,y-50,weekWidth,50,dark);
    drawMultiline(page, \`WEEK \${week}\\n\${weekPeriod(snapshot.monthKey,week)}\\n\${snapshot.weekDates[week] ? 'Counted '+formatDate(snapshot.weekDates[week]) : ''}\`, x+2, y-14, weekWidth-4, 8, bold, 'center', white);
  }
  const xMin=margin+itemWidth+weekWidth*5; drawRect(page,xMin,y-50,minWidth,50,dark); drawFitted(page,'MIN',xMin+2,y-28,minWidth-4,9,bold,'center',white);
}`,
    'weekly PDF header white text'
  );

  source = replaceRequired(
    source,
    `['ITEM','QUANTITY','UNIT','STATUS','MIN'].forEach((h,i)=>{const x=margin+widths.slice(0,i).reduce((a,b)=>a+b,0);drawRect(page,x,y-32,widths[i],32,window.PDFLib.rgb(.25,.25,.25));drawFitted(page,h,x+3,y-20,widths[i]-6,9,bold,'center');}); y-=32;`,
    `['ITEM','QUANTITY','UNIT','STATUS','MIN'].forEach((h,i)=>{const x=margin+widths.slice(0,i).reduce((a,b)=>a+b,0);drawRect(page,x,y-32,widths[i],32,window.PDFLib.rgb(.25,.25,.25));drawFitted(page,h,x+3,y-20,widths[i]-6,9,bold,'center',window.PDFLib.rgb(1,1,1));}); y-=32;`,
    'stationary PDF header white text'
  );

  await writeFile(file, source);
}
