import { ExpiryRule, ProductMaster } from '../domain/types';
import { demoProducts, demoRules } from './demoSeed';

export interface CatalogSnapshot {
  products: ProductMaster[];
  rules: ExpiryRule[];
  source: 'embedded-sheet-snapshot' | 'demo';
  capturedAt?: string;
}

/**
 * Temporary catalog seam for the no-GAS phase.
 * Replace the embedded arrays with the full read-only Sheet snapshot before
 * field testing; the UI and domain engine do not need to change.
 */
export const localCatalog: CatalogSnapshot = {
  products: demoProducts,
  rules: demoRules,
  source: 'demo',
};
