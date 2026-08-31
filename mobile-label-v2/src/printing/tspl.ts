import { LabelBatch } from '../domain/types';
import { TsplBuilder } from '../workflow/printWorkflow';

export interface V2LabelSettings {
  widthMm: number;
  heightMm: number;
  gapMm: number;
  density: number;
  speed: number;
  left: number;
  top: number;
  lineGap: number;
  titleScale: number;
  bodyScale: number;
  metaScale: number;
  barcodeHeight: number;
}

export const DEFAULT_V2_LABEL_SETTINGS: V2LabelSettings = {
  widthMm: 40,
  heightMm: 30,
  gapMm: 2,
  density: 8,
  speed: 4,
  left: 18,
  top: 12,
  lineGap: 4,
  titleScale: 1,
  bodyScale: 1,
  metaScale: 1,
  barcodeHeight: 52,
};

const FONT = '3';

const clean = (value: unknown) =>
  String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/["\\]/g, ' ')
    .replace(/[^\x20-\x7E]/g, '?')
    .replace(/\s+/g, ' ')
    .trim();

const formatDateTime = (iso: string) => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return clean(iso) || '-';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

const rowHeight = (scale: number, gap: number) => 24 * Math.max(1, scale) + gap;

export class StableV2TsplBuilder implements TsplBuilder {
  constructor(private readonly settings: V2LabelSettings = DEFAULT_V2_LABEL_SETTINGS) {}

  build(batch: LabelBatch, copies: number): string {
    const s = this.settings;
    let y = s.top;
    const lines: string[] = [
      `SIZE ${s.widthMm} mm,${s.heightMm} mm`,
      `GAP ${s.gapMm} mm,0 mm`,
      `DENSITY ${s.density}`,
      `SPEED ${s.speed}`,
      'DIRECTION 1',
      'REFERENCE 0,0',
      'CLS',
    ];

    const addText = (text: string, scale: number) => {
      const value = clean(text);
      if (!value) return;
      lines.push(`TEXT ${s.left},${y},"${FONT}",0,${Math.max(1, scale)},${Math.max(1, scale)},"${value}"`);
      y += rowHeight(scale, s.lineGap);
    };

    addText(batch.productName, s.titleScale);
    addText(`${batch.action} / ${batch.storageCondition}`, s.bodyScale);
    if (batch.initialQuantity > 1 || batch.quantityUnit) {
      addText(`Qty: ${batch.initialQuantity} ${batch.quantityUnit || ''}`.trim(), s.metaScale);
    }
    addText(`Made: ${formatDateTime(batch.madeAt)}`, s.metaScale);
    addText(`Use By: ${formatDateTime(batch.expiryAt)}`, s.metaScale);
    addText(`Batch: ${batch.batchId}`, s.metaScale);

    const barcode = clean(batch.barcodeValue || `LBL:${batch.batchId}`);
    if (barcode) {
      lines.push(`BARCODE ${s.left},${y},"128",${s.barcodeHeight},0,0,2,2,"${barcode}"`);
      y += s.barcodeHeight + s.lineGap;
    }

    lines.push(`PRINT ${Math.max(1, copies)},1`);
    return `${lines.join('\r\n')}\r\n`;
  }
}
