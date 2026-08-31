import { sheetSnapshotMeta } from './meta';
import { rawProductHeaders, rawProductRows } from './products';
import { rawRuleRows1 } from './rules1';
import { rawRuleRows2 } from './rules2';
import { rawRuleRows3 } from './rules3';
import { rawRuleRows4 } from './rules4';
import { rawRuleRows5 } from './rules5';
export const rawRuleHeaders = ["ruleId","enabled","productId","productName","action","storageCondition","durationMinutes","manualExpiryRequired","requiresQuantity","quantityLabel","quantityUnit","showQuantityOnLabel","note","requiresSource","allowedSourceActions","sourceAllowedOutlets","sourceExpiryMode","sourceProductId","sourceProductName","outputProductId","outputProductName"] as const;
export const rawSheetCatalogSnapshot = {
  meta: sheetSnapshotMeta,
  productHeaders: rawProductHeaders,
  productRows: rawProductRows,
  ruleHeaders: rawRuleHeaders,
  ruleRows: [...rawRuleRows1,...rawRuleRows2,...rawRuleRows3,...rawRuleRows4,...rawRuleRows5],
} as const;
