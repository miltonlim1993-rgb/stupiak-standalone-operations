import { MockLabelBackend } from '../data/mockBackend';
import { demoBatches, demoProducts, demoRules } from '../data/demoSeed';
import { MockPrinter } from '../printing/mockPrinter';
import { executePrintWorkflow } from './printWorkflow';

const tspl = { build: () => 'SIZE 40 mm,30 mm\r\nCLS\r\nPRINT 1,1\r\n' };

describe('V2 two-phase print workflow', () => {
  it('consumes one source unit only after a valid source reservation and commits print', async () => {
    const backend = new MockLabelBackend({
      products: demoProducts,
      rules: demoRules,
      batches: demoBatches,
    });
    const source = (await backend.listBatches('RR-KCH'))[0];
    const result = await executePrintWorkflow({
      request: {
        outletName: 'RR-KCH',
        staffName: 'Tester',
        product: demoProducts[0],
        rule: demoRules.find((item) => item.action === 'Open')!,
        quantity: 1,
        sourceBatch: source,
        madeAt: '2026-08-31T02:00:00.000Z',
      },
      allBatches: [source],
      backend,
      printer: new MockPrinter(),
      tspl,
      printerTarget: { host: 'mock' },
      now: new Date('2026-08-31T02:00:00.000Z'),
    });

    expect(result.printed).toBe(true);
    expect(result.batch.status).toBe('active');
    const after = await backend.lookupBatch('LBL:DEMO-PREPARE-40', 'RR-KCH');
    expect(after?.remainingQuantity).toBe(39);
  });
});
