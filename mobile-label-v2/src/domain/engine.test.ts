import {
  consumeSourceLocally,
  createDraftLabel,
  eligibleSources,
  validateSource,
} from './engine';
import { ExpiryRule, LabelBatch, ProductMaster } from './types';

const product: ProductMaster = {
  productId: 'chicken-popcorn-l',
  enabled: true,
  productName: 'Chicken Popcorn L',
};

const openRule: ExpiryRule = {
  id: 'chicken-popcorn-l-open-chiller',
  productId: product.productId,
  productName: product.productName,
  action: 'Open',
  storageCondition: 'Chiller',
  durationMinutes: 60,
  manualExpiryRequired: false,
  requiresQuantity: false,
  showQuantityOnLabel: false,
  enabled: true,
  requiresSource: true,
  allowedSourceActions: 'Prepare',
  sourceExpiryMode: 'min',
  sourceProductId: product.productId,
  sourceProductName: product.productName,
  outputProductId: product.productId,
  outputProductName: product.productName,
  sourceConsumptionQuantity: 1,
};

const source = (overrides: Partial<LabelBatch> = {}): LabelBatch => ({
  batchId: 'SP-RRKCH-20260831-0001',
  barcodeValue: 'LBL:SP-RRKCH-20260831-0001',
  outletName: 'RR-KCH',
  productId: product.productId,
  productName: product.productName,
  action: 'Prepare',
  storageCondition: 'Chiller',
  madeAt: '2026-08-31T01:00:00.000Z',
  expiryAt: '2026-09-05T01:00:00.000Z',
  initialQuantity: 40,
  remainingQuantity: 40,
  quantityUnit: 'pack',
  status: 'active',
  createdAt: '2026-08-31T01:00:00.000Z',
  ...overrides,
});

describe('SP Label Printing V2 source engine', () => {
  it('enforces Prepare 40 -> only 40 one-unit Open consumptions', () => {
    let batch = source();
    for (let i = 0; i < 40; i += 1) {
      const draft = createDraftLabel(
        {
          outletName: 'RR-KCH',
          staffName: 'Tester',
          product,
          rule: openRule,
          quantity: 1,
          sourceBatch: batch,
          madeAt: '2026-08-31T02:00:00.000Z',
        },
        [batch],
        new Date('2026-08-31T02:00:00.000Z'),
      );
      batch = consumeSourceLocally(batch, draft.sourceConsumeQuantity);
    }

    expect(batch.remainingQuantity).toBe(0);
    expect(batch.status).toBe('consumed');

    expect(() =>
      createDraftLabel(
        {
          outletName: 'RR-KCH',
          staffName: 'Tester',
          product,
          rule: openRule,
          quantity: 1,
          sourceBatch: batch,
          madeAt: '2026-08-31T02:00:00.000Z',
        },
        [batch],
        new Date('2026-08-31T02:00:00.000Z'),
      ),
    ).toThrow(/no longer active|no remaining quantity/i);
  });

  it('forces the oldest eligible source first', () => {
    const older = source({ batchId: 'OLD', madeAt: '2026-08-30T01:00:00.000Z' });
    const newer = source({ batchId: 'NEW', madeAt: '2026-08-31T01:00:00.000Z' });

    expect(eligibleSources([newer, older], openRule, 'RR-KCH')[0].batchId).toBe('OLD');
    expect(validateSource(newer, [newer, older], openRule, 'RR-KCH').reason).toBe('NOT_FIFO');
  });

  it('does not allow a child expiry past the source expiry in min mode', () => {
    const batch = source({ expiryAt: '2026-08-31T02:30:00.000Z' });
    const draft = createDraftLabel(
      {
        outletName: 'RR-KCH',
        staffName: 'Tester',
        product,
        rule: { ...openRule, durationMinutes: 180 },
        quantity: 1,
        sourceBatch: batch,
        madeAt: '2026-08-31T02:00:00.000Z',
      },
      [batch],
      new Date('2026-08-31T02:00:00.000Z'),
    );

    expect(draft.expiryAt).toBe('2026-08-31T02:30:00.000Z');
  });

  it('blocks wrong source action', () => {
    const batch = source({ action: 'Freeze' });
    expect(validateSource(batch, [batch], openRule, 'RR-KCH').reason).toBe('ACTION_NOT_ALLOWED');
  });
});
