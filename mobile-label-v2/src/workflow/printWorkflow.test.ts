import { MockLabelBackend } from '../data/mockBackend';
import { demoBatches, demoProducts, demoRules } from '../data/demoSeed';
import { MockPrinter } from '../printing/mockPrinter';
import { executePrintWorkflow } from './printWorkflow';

const tspl = { build: () => 'SIZE 40 mm,30 mm\r\nCLS\r\nPRINT 1,1\r\n' };

describe('V2 two-phase print workflow', () => {
  it('consumes one source slot only after a valid reservation and commits print', async () => {
    const backend = new MockLabelBackend({ products: demoProducts, rules: demoRules, batches: demoBatches });
    const source = (await backend.listBatches('RR-KCH'))[0];
    const openRule = demoRules.find((item) => item.productId === 'slice-cheese-rv' && item.action === 'Open')!;
    const result = await executePrintWorkflow({
      request: {
        outletName: 'RR-KCH', staffName: 'Tester', product: demoProducts[0], rule: openRule,
        quantity: 1, printQuantity: 1, sourceBatch: source, madeAt: '2026-08-31T02:00:00.000Z',
      },
      copies: 1,
      allBatches: [source], backend, printer: new MockPrinter(), tspl,
      printerTarget: { host: 'mock' }, now: new Date('2026-08-31T02:00:00.000Z'),
    });

    expect(result.printed).toBe(true);
    expect(result.batch.status).toBe('active');
    const after = await backend.lookupBatch('LBL:DEMO-RECEIVED-40', 'RR-KCH');
    expect(after?.remainingQuantity).toBe(39);
  });

  it('deducts five source slots when five child labels are printed', async () => {
    const backend = new MockLabelBackend({ products: demoProducts, rules: demoRules, batches: demoBatches });
    const source = (await backend.listBatches('RR-KCH'))[0];
    const openRule = demoRules.find((item) => item.productId === 'slice-cheese-rv' && item.action === 'Open')!;
    const result = await executePrintWorkflow({
      request: {
        outletName: 'RR-KCH', staffName: 'Tester', product: demoProducts[0], rule: openRule,
        quantity: 1, printQuantity: 5, sourceBatch: source, madeAt: '2026-08-31T02:00:00.000Z',
      },
      copies: 5,
      allBatches: [source], backend, printer: new MockPrinter(), tspl,
      printerTarget: { host: 'mock' }, now: new Date('2026-08-31T02:00:00.000Z'),
    });

    expect(result.printed).toBe(true);
    const after = await backend.lookupBatch('LBL:DEMO-RECEIVED-40', 'RR-KCH');
    expect(after?.remainingQuantity).toBe(35);
    expect(result.batch.printQuantity).toBe(5);
  });
});
