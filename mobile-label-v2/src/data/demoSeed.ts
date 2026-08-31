import { LabelBatch } from '../domain/types';
import { localCatalog } from './catalogSource';

const SEED_PRODUCT_ID = 'slice-cheese-rv';
const seedProduct = localCatalog.products.find((item) => item.productId === SEED_PRODUCT_ID);
const seedRules = localCatalog.rules.filter((item) => item.productId === SEED_PRODUCT_ID);

/**
 * Backward-compatible names used by the current V2 screen/tests. They now
 * contain the complete embedded Sheet snapshot, with Slice Cheese promoted to
 * the top only so the local closed-loop demo opens on a real 3-stage product.
 */
export const demoProducts = [
  ...(seedProduct ? [seedProduct] : []),
  ...localCatalog.products.filter((item) => item.productId !== SEED_PRODUCT_ID),
];

export const demoRules = [
  ...seedRules,
  ...localCatalog.rules.filter((item) => item.productId !== SEED_PRODUCT_ID),
];

export const demoBatches: LabelBatch[] = [
  {
    batchId: 'DEMO-RECEIVED-40',
    barcodeValue: 'LBL:DEMO-RECEIVED-40',
    outletName: 'RR-KCH',
    productId: SEED_PRODUCT_ID,
    productName: seedProduct?.displayName || seedProduct?.productName || 'Slice Cheese (RV)',
    action: 'Received',
    storageCondition: 'Chiller',
    madeAt: '2026-08-31T01:00:00.000Z',
    expiryAt: '2026-09-30T01:00:00.000Z',
    initialQuantity: 40,
    remainingQuantity: 40,
    quantityUnit: 'label',
    contentQuantity: 40,
    contentQuantityUnit: 'block/ 28pcs',
    printQuantity: 40,
    sourceTier: 1,
    sourceStage: 'first_hand',
    status: 'active',
    staffName: 'V2 Demo',
    createdAt: '2026-08-31T01:00:00.000Z',
    printedAt: '2026-08-31T01:00:05.000Z',
  },
];
