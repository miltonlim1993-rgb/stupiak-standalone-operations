import { normalizeCatalogRules } from '../domain/policy';
import { ExpiryRule, ProductMaster } from '../domain/types';
import { rawSheetCatalogSnapshot } from './snapshot';

type RawCell = string | number | boolean | null | undefined;
type RawRow = readonly RawCell[];

const rowObject = (headers: readonly string[], row: RawRow): Record<string, RawCell> =>
  Object.fromEntries(headers.map((header, index) => [header, row[index] ?? '']));

const asBoolean = (value: RawCell): boolean =>
  value === true || String(value ?? '').trim().toLowerCase() === 'true';

const asNumber = (value: RawCell): number => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};

const asString = (value: RawCell): string => String(value ?? '');

const products: ProductMaster[] = rawSheetCatalogSnapshot.productRows
  .map((row) => rowObject(rawSheetCatalogSnapshot.productHeaders, row))
  .filter((row) => asString(row.productId) && asBoolean(row.enabled))
  .map((row) => ({
    productId: asString(row.productId),
    enabled: true,
    productName: asString(row.productName),
    displayName: asString(row.displayName),
    category: asString(row.category),
    sku: asString(row.sku),
    productBarcode: asString(row.productBarcode),
    alternateBarcodes: asString(row.alternateBarcodes)
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    defaultLabelTitle: asString(row.defaultLabelTitle),
    note: asString(row.note),
  }));

export const rawCatalogRules: ExpiryRule[] = rawSheetCatalogSnapshot.ruleRows
  .map((row) => rowObject(rawSheetCatalogSnapshot.ruleHeaders, row))
  .filter((row) => asString(row.ruleId) && asBoolean(row.enabled))
  .map((row) => ({
    id: asString(row.ruleId),
    enabled: true,
    productId: asString(row.productId),
    productName: asString(row.productName),
    action: asString(row.action),
    storageCondition: asString(row.storageCondition),
    durationMinutes: asNumber(row.durationMinutes),
    manualExpiryRequired: asBoolean(row.manualExpiryRequired),
    requiresQuantity: asBoolean(row.requiresQuantity),
    quantityLabel: asString(row.quantityLabel),
    quantityUnit: asString(row.quantityUnit),
    showQuantityOnLabel: asBoolean(row.showQuantityOnLabel),
    note: asString(row.note),
    requiresSource: asBoolean(row.requiresSource),
    allowedSourceActions: asString(row.allowedSourceActions),
    sourceAllowedOutlets: asString(row.sourceAllowedOutlets),
    sourceExpiryMode: asString(row.sourceExpiryMode),
    sourceProductId: asString(row.sourceProductId),
    sourceProductName: asString(row.sourceProductName),
    outputProductId: asString(row.outputProductId),
    outputProductName: asString(row.outputProductName),
    sourceConsumptionQuantity: asBoolean(row.requiresSource) ? 1 : 0,
  }));

const runtimeRules = normalizeCatalogRules(rawCatalogRules);

export interface CatalogSnapshot {
  products: ProductMaster[];
  rules: ExpiryRule[];
  source: 'embedded-sheet-snapshot';
  capturedAt: string;
  spreadsheetId: string;
  rawSha256: string;
  runtimePolicyVersion: string;
}

/**
 * No-GAS field-test catalog.
 * Raw ProductMaster/ExpiryRules values are embedded read-only, then the same
 * web v26 action hierarchy is applied at runtime so APK behavior stays aligned
 * with /labels without modifying the Google Sheet.
 */
export const localCatalog: CatalogSnapshot = {
  products,
  rules: runtimeRules,
  source: 'embedded-sheet-snapshot',
  capturedAt: rawSheetCatalogSnapshot.meta.capturedAt,
  spreadsheetId: rawSheetCatalogSnapshot.meta.sourceSpreadsheetId,
  rawSha256: rawSheetCatalogSnapshot.meta.rawSha256,
  runtimePolicyVersion: rawSheetCatalogSnapshot.meta.runtimePolicyVersion,
};

/** Kept available for audit/diff only; the UI uses localCatalog.rules. */
export const rawCatalogSnapshot = rawSheetCatalogSnapshot;
