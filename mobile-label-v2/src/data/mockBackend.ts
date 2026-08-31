import { consumeSourceLocally } from '../domain/engine';
import { DraftLabel, ExpiryRule, LabelBatch, ProductMaster } from '../domain/types';
import { LabelBackend } from './backend';

const nowIso = () => new Date().toISOString();

const barcodeFor = (batchId: string) => `LBL:${batchId}`;

export class MockLabelBackend implements LabelBackend {
  private products: ProductMaster[];
  private rules: ExpiryRule[];
  private batches: LabelBatch[];
  private counter = 1;

  constructor(seed?: {
    products?: ProductMaster[];
    rules?: ExpiryRule[];
    batches?: LabelBatch[];
  }) {
    this.products = seed?.products ? [...seed.products] : [];
    this.rules = seed?.rules ? [...seed.rules] : [];
    this.batches = seed?.batches ? seed.batches.map((item) => ({ ...item })) : [];
  }

  async loadCatalog() {
    return { products: [...this.products], rules: [...this.rules] };
  }

  async listBatches(outletName: string) {
    return this.batches
      .filter((item) => item.outletName === outletName)
      .map((item) => ({ ...item }));
  }

  async lookupBatch(code: string, outletName: string) {
    const normalized = String(code || '').trim().replace(/^LBL:/i, '');
    const item = this.batches.find(
      (batch) =>
        batch.outletName === outletName &&
        (batch.batchId === normalized ||
          batch.barcodeValue === code ||
          batch.barcodeValue === `LBL:${normalized}`),
    );
    return item ? { ...item } : null;
  }

  async reserveDraft(draft: DraftLabel): Promise<LabelBatch> {
    const { request } = draft;
    const sourceId = request.sourceBatch?.batchId;
    if (sourceId) {
      const sourceIndex = this.batches.findIndex((item) => item.batchId === sourceId);
      if (sourceIndex < 0) throw new Error('Source disappeared before reserve.');
      const latestSource = this.batches[sourceIndex];
      if (latestSource.remainingQuantity < draft.sourceConsumeQuantity) {
        throw new Error('Source quantity changed. Refresh and try again.');
      }
      this.batches[sourceIndex] = consumeSourceLocally(
        latestSource,
        draft.sourceConsumeQuantity,
      );
    }

    const dateKey = new Date(request.madeAt).toISOString().slice(0, 10).replace(/-/g, '');
    const outletCode = request.outletName.toUpperCase().replace(/[^A-Z0-9]/g, '') || 'OUTLET';
    const running = String(this.counter++).padStart(4, '0');
    const batchId = `V2-${outletCode}-${dateKey}-${running}`;
    const quantity = request.rule.requiresQuantity ? request.quantity : 1;

    const batch: LabelBatch = {
      batchId,
      barcodeValue: barcodeFor(batchId),
      outletName: request.outletName,
      productId: request.rule.outputProductId || request.product.productId,
      productName:
        request.rule.outputProductName ||
        request.product.displayName ||
        request.product.productName,
      action: request.rule.action,
      storageCondition: request.rule.storageCondition,
      madeAt: request.madeAt,
      expiryAt: draft.expiryAt,
      initialQuantity: quantity,
      remainingQuantity: quantity,
      quantityUnit: request.rule.quantityUnit || 'unit',
      sourceBatchId: request.sourceBatch?.batchId,
      sourceAction: request.sourceBatch?.action,
      sourceExpiryAt: request.sourceBatch?.expiryAt,
      status: 'pending_print',
      staffName: request.staffName,
      createdAt: nowIso(),
    };

    this.batches.push(batch);
    return { ...batch };
  }

  async commitPrinted(batchId: string, printedAt: string, _printerHost?: string) {
    const index = this.batches.findIndex((item) => item.batchId === batchId);
    if (index < 0) throw new Error('Pending batch not found.');
    this.batches[index] = {
      ...this.batches[index],
      status: 'active',
      printedAt,
    };
    return { ...this.batches[index] };
  }

  async cancelPending(batchId: string, _reason?: string): Promise<void> {
    const index = this.batches.findIndex((item) => item.batchId === batchId);
    if (index < 0) return;
    const pending = this.batches[index];
    if (pending.status !== 'pending_print') return;

    if (pending.sourceBatchId) {
      const sourceIndex = this.batches.findIndex(
        (item) => item.batchId === pending.sourceBatchId,
      );
      if (sourceIndex >= 0) {
        const source = this.batches[sourceIndex];
        const restored = Math.min(
          source.initialQuantity,
          source.remainingQuantity + 1,
        );
        this.batches[sourceIndex] = {
          ...source,
          remainingQuantity: restored,
          status: restored > 0 ? 'active' : source.status,
        };
      }
    }

    this.batches[index] = { ...pending, status: 'cancelled' };
  }
}
