import { LabelBatch } from '../domain/types';
import { TsplBuilder } from '../workflow/printWorkflow';

type TextRole = 'title' | 'body' | 'meta';
type TextAlign = 'left' | 'center' | 'right';

type FontSpec = {
  role: TextRole;
  font: string;
  xMul: number;
  yMul: number;
  charWidthDots: number;
  lineHeightDots: number;
};

export interface V2LabelSettings {
  labelWidthMm: number;
  labelHeightMm: number;
  gapMm: number;
  offsetX: number;
  offsetY: number;
  titleFontSize: number;
  titleAlign: TextAlign;
  bodyFontSize: number;
  metaFontSize: number;
  showBarcode: boolean;
  barcodeHeight: number;
  lineSpacing: number;
  leftMargin: number;
  topMargin: number;
  rightMargin: number;
  bottomMargin: number;
}

/**
 * Matches the stable standalone production label layout defaults. Barcode is
 * intentionally enabled in V2 because source scanning is a core requirement;
 * the production app itself is not changed.
 */
export const DEFAULT_V2_LABEL_SETTINGS: V2LabelSettings = {
  labelWidthMm: 40,
  labelHeightMm: 30,
  gapMm: 2,
  offsetX: 0,
  offsetY: 0,
  titleFontSize: 1,
  titleAlign: 'left',
  bodyFontSize: 0,
  metaFontSize: 0,
  showBarcode: true,
  barcodeHeight: 64,
  lineSpacing: 3,
  leftMargin: 12,
  topMargin: 10,
  rightMargin: 12,
  bottomMargin: 8,
};

const DOTS_PER_MM = 8;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const mmToDots = (mm: number) => Math.max(0, Math.round(mm * DOTS_PER_MM));

const clean = (value: unknown) =>
  String(value ?? '')
    .replace(/[^\x20-\x7E]/g, ' ')
    .replace(/"/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

const fontFor = (scaleValue: number, role: TextRole): FontSpec => {
  const scale = clamp(Math.round(scaleValue), 0, 3);
  if (role === 'title') {
    if (scale === 0) return { role, font: '2', xMul: 1, yMul: 1, charWidthDots: 10, lineHeightDots: 20 };
    if (scale === 1) return { role, font: '3', xMul: 1, yMul: 1, charWidthDots: 12, lineHeightDots: 24 };
    if (scale === 2) return { role, font: '4', xMul: 1, yMul: 1, charWidthDots: 14, lineHeightDots: 28 };
    return { role, font: '4', xMul: 2, yMul: 2, charWidthDots: 28, lineHeightDots: 56 };
  }
  if (scale === 0) return { role, font: '1', xMul: 1, yMul: 1, charWidthDots: 8, lineHeightDots: 16 };
  if (scale === 1) return { role, font: '2', xMul: 1, yMul: 1, charWidthDots: 10, lineHeightDots: 20 };
  if (scale === 2) return { role, font: '3', xMul: 1, yMul: 1, charWidthDots: 12, lineHeightDots: 24 };
  return { role, font: '3', xMul: 2, yMul: 2, charWidthDots: 24, lineHeightDots: 48 };
};

const widthDots = (text: string, font: FontSpec) => clean(text).length * font.charWidthDots;

const truncate = (text: string, font: FontSpec, usableWidth: number) => {
  const normalized = clean(text);
  if (!normalized) return '';
  if (widthDots(normalized, font) <= usableWidth) return normalized;
  const maxChars = Math.max(0, Math.floor(usableWidth / Math.max(1, font.charWidthDots)));
  if (maxChars <= 0) return '';
  if (normalized.length <= maxChars) return normalized;
  if (maxChars <= 3) return normalized.slice(0, maxChars);
  return `${normalized.slice(0, maxChars - 3).trimEnd()}...`;
};

const fitPrefixed = (prefix: string, value: unknown, font: FontSpec, usableWidth: number) => {
  const cleanPrefix = clean(prefix);
  const cleanValue = clean(value);
  if (!cleanValue) return cleanPrefix;
  const full = `${cleanPrefix} ${cleanValue}`;
  if (widthDots(full, font) <= usableWidth) return full;
  const prefixWidth = widthDots(`${cleanPrefix} `, font);
  const fittedValue = truncate(cleanValue, font, Math.max(0, usableWidth - prefixWidth));
  return fittedValue ? `${cleanPrefix} ${fittedValue}` : truncate(cleanPrefix, font, usableWidth);
};

const formatTsplDateTime = (iso: string) => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return clean(iso) || '-';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

const resolveX = (
  text: string,
  font: FontSpec,
  align: TextAlign,
  baseLeft: number,
  usableWidth: number,
  labelWidth: number,
  rightMargin: number,
) => {
  if (align === 'left') return baseLeft;
  const lineWidth = widthDots(text, font);
  const maxStart = Math.max(baseLeft, labelWidth - rightMargin - lineWidth);
  if (align === 'center') {
    return clamp(baseLeft + Math.round((usableWidth - lineWidth) / 2), baseLeft, maxStart);
  }
  return clamp(baseLeft + Math.max(0, usableWidth - lineWidth), baseLeft, maxStart);
};

export class StableV2TsplBuilder implements TsplBuilder {
  constructor(private readonly settings: V2LabelSettings = DEFAULT_V2_LABEL_SETTINGS) {}

  build(batch: LabelBatch, copies: number): string {
    const s = this.settings;
    const labelWidthDots = mmToDots(s.labelWidthMm);
    const labelHeightDots = mmToDots(s.labelHeightMm);
    const usableWidth = Math.max(0, labelWidthDots - s.leftMargin - s.rightMargin);
    const maxX = Math.max(0, labelWidthDots - s.rightMargin);
    const maxY = Math.max(0, labelHeightDots - s.bottomMargin);
    const baseLeft = clamp(s.leftMargin + s.offsetX, 0, maxX);
    let cursorY = clamp(s.topMargin + s.offsetY, 0, maxY);

    const titleFont = fontFor(s.titleFontSize, 'title');
    const bodyFont = fontFor(s.bodyFontSize, 'body');
    const metaFont = fontFor(s.metaFontSize, 'meta');
    const product = truncate(batch.productName, titleFont, usableWidth);
    const staff = fitPrefixed('Staff:', batch.staffName || '', bodyFont, usableWidth);
    const action = fitPrefixed('Action:', batch.action, bodyFont, usableWidth);
    const storage = fitPrefixed('Storage:', batch.storageCondition, bodyFont, usableWidth);
    const contentQty = batch.contentQuantity === undefined ? '' : clean(batch.contentQuantity);
    const contentUnit = clean(batch.contentQuantityUnit || '');
    const quantityValue = [contentQty, contentUnit].filter(Boolean).join(' ');
    const printedText = formatTsplDateTime(batch.madeAt);
    const expiryText = formatTsplDateTime(batch.expiryAt);

    const contentLines: Array<{ text: string; font: FontSpec; align: TextAlign }> = [
      { text: product, font: titleFont, align: s.titleAlign },
      { text: staff, font: bodyFont, align: 'left' },
      { text: action, font: bodyFont, align: 'left' },
      { text: storage, font: bodyFont, align: 'left' },
    ];

    if (quantityValue) {
      contentLines.push({
        text: fitPrefixed('Qty:', quantityValue, bodyFont, usableWidth),
        font: bodyFont,
        align: 'left',
      });
      contentLines.push({
        text: truncate(`P:${printedText} EXP:${expiryText}`, metaFont, usableWidth),
        font: metaFont,
        align: 'left',
      });
    } else {
      contentLines.push({ text: fitPrefixed('P:', printedText, metaFont, usableWidth), font: metaFont, align: 'left' });
      contentLines.push({ text: fitPrefixed('EXP:', expiryText, metaFont, usableWidth), font: metaFont, align: 'left' });
    }

    const commands: string[] = [];
    for (const line of contentLines) {
      if (!line.text) continue;
      const x = resolveX(line.text, line.font, line.align, baseLeft, usableWidth, labelWidthDots, s.rightMargin);
      commands.push(
        `TEXT ${x},${cursorY},"${line.font.font}",0,${line.font.xMul},${line.font.yMul},"${line.text}"`,
      );
      cursorY += line.font.lineHeightDots + s.lineSpacing;
    }

    const barcode = clean(batch.barcodeValue || `LBL:${batch.batchId}`);
    if (s.showBarcode && barcode) {
      const barcodeHeight = clamp(s.barcodeHeight, 20, 200);
      commands.push(`BARCODE ${baseLeft},${cursorY},"128",${barcodeHeight},0,0,2,2,"${barcode}"`);
      cursorY += barcodeHeight + s.lineSpacing;
      commands.push(
        `TEXT ${baseLeft},${cursorY},"${metaFont.font}",0,${metaFont.xMul},${metaFont.yMul},"${truncate(barcode, metaFont, usableWidth)}"`,
      );
    }

    const lines = [
      `SIZE ${s.labelWidthMm} mm,${s.labelHeightMm} mm`,
      `GAP ${s.gapMm} mm,0 mm`,
      'DENSITY 8',
      'SPEED 4',
      'DIRECTION 1',
      'REFERENCE 0,0',
      'CLS',
      ...commands,
      `PRINT ${Math.max(1, copies)},1`,
    ];

    return `${lines.join('\r\n')}\r\n`;
  }
}
