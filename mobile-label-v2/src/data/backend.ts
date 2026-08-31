import { DraftLabel, ExpiryRule, LabelBatch, ProductMaster } from '../domain/types';

export interface LabelBackend {
  loadCatalog(): Promise<{ products: ProductMaster[]; rules: ExpiryRule[] }>;
  listBatches(outletName: string): Promise<LabelBatch[]>;
  lookupBatch(code: string, outletName: string): Promise<LabelBatch | null>;
  reserveDraft(draft: DraftLabel): Promise<LabelBatch>;
  commitPrinted(batchId: string, printedAt: string, printerHost?: string): Promise<LabelBatch>;
  cancelPending(batchId: string, reason?: string): Promise<void>;
}

/**
 * During the APK/domain phase GAS is deliberately not touched.
 * The app talks only to this interface. A GAS adapter can be added later
 * without changing the workflow, scanner, FIFO engine or print transport.
 */
export const BACKEND_CONTRACT_VERSION = 'label-backend-v2-alpha1';
