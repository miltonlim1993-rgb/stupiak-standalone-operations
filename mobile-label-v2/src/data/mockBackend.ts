import { consumeSourceLocally } from '../domain/engine';
import { labelSourceStage, labelSourceTier } from '../domain/policy';
import { restoreSourceQuantity, ReservedBatch } from '../domain/rollback';
import { DraftLabel, ExpiryRule, LabelBatch, ProductMaster } from '../domain/types';
import { LabelBackend } from './backend';

const nowIso = () => new Date().toISOString();
const barcodeFor = (batchId: string) => `LBL:${batchId}`;

export class MockLabelBackend implements LabelBackend {
  private products: ProductMaster[];
  private rules: ExpiryRule[];
  private batches: ReservedBatch[];
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
    const printQuantity = Math.max(1, Number(request.printQuantity || 1));
    const tier = Number(request.rule.sourceTier || 0) || labelSourceTier(request.rule.action);
    const tracked = tier === 1 || tier === 2 || request.rule.sourceUsageMode === 'tracked';
    const sourceCapacity = tracked ? printQuantity : 0;

    const batch: ReservedBatch = {
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
      initialQuantity: sourceCapacity,
      remainingQuantity: sourceCapacity,
      quantityUnit: request.rule.sourceUnit || 'label',
      contentQuantity: request.rule.requiresQuantity ? request.quantity : undefined,
      contentQuantityUnit: request.rule.requiresQuantity ? request.rule.quantityUnit || '' : undefined,
      printQuantity,
      sourceTier: tier,
      sourceStage: labelSourceStage(tier),
      sourceBatchId: request.sourceBatch?.batchId,
      sourceAction: request.sourceBatch?.action,
      sourceExpiryAt: request.sourceBatch?.expiryAt,
      sourceConsumedQuantity: draft.sourceConsumeQuantity,
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
        this.batches[sourceIndex] = restoreSourceQuantity(
          this.batches[sourceIndex],
          pending,
        );
      }
    }

    this.batches[index] = { ...pending, status: 'cancelled' };
  }
}
