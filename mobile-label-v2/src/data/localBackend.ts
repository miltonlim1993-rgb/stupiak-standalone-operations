import AsyncStorage from '@react-native-async-storage/async-storage';

import { consumeSourceLocally } from '../domain/engine';
import { labelSourceStage, labelSourceTier } from '../domain/policy';
import { restoreSourceQuantity, ReservedBatch } from '../domain/rollback';
import { DraftLabel, LabelBatch } from '../domain/types';
import { LabelBackend } from './backend';
import { localCatalog } from './catalogSource';
import { demoBatches } from './demoSeed';

const STORAGE_KEY = 'sp-label-v2.local-ledger.v1';
const nowIso = () => new Date().toISOString();
const barcodeFor = (batchId: string) => `LBL:${batchId}`;

type StoredLedger = {
  schema: 'sp-label-v2.local-ledger.v1';
  counter: number;
  batches: ReservedBatch[];
  updatedAt: string;
};

const initialLedger = (): StoredLedger => ({
  schema: 'sp-label-v2.local-ledger.v1',
  counter: 1,
  batches: demoBatches.map((batch) => ({ ...batch })),
  updatedAt: nowIso(),
});

export class LocalLabelBackend implements LabelBackend {
  private mutationQueue: Promise<unknown> = Promise.resolve();

  async loadCatalog() {
    return { products: [...localCatalog.products], rules: [...localCatalog.rules] };
  }

  private async readLedger(): Promise<StoredLedger> {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) {
      const seed = initialLedger();
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(seed));
      return seed;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<StoredLedger>;
      if (!Array.isArray(parsed.batches)) throw new Error('Invalid batches');
      return {
        schema: 'sp-label-v2.local-ledger.v1',
        counter: Math.max(1, Number(parsed.counter || 1)),
        batches: parsed.batches.map((batch) => ({ ...batch } as ReservedBatch)),
        updatedAt: String(parsed.updatedAt || nowIso()),
      };
    } catch {
      const seed = initialLedger();
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(seed));
      return seed;
    }
  }

  private async writeLedger(ledger: StoredLedger): Promise<void> {
    await AsyncStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...ledger, updatedAt: nowIso() }),
    );
  }

  private mutate<T>(operation: (ledger: StoredLedger) => Promise<T> | T): Promise<T> {
    const run = this.mutationQueue.then(async () => {
      const ledger = await this.readLedger();
      const result = await operation(ledger);
      await this.writeLedger(ledger);
      return result;
    });
    this.mutationQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  async listBatches(outletName: string) {
    const ledger = await this.readLedger();
    return ledger.batches
      .filter((item) => item.outletName === outletName)
      .map((item) => ({ ...item }));
  }

  async lookupBatch(code: string, outletName: string) {
    const ledger = await this.readLedger();
    const raw = String(code || '').trim();
    const normalized = raw.replace(/^LBL:/i, '');
    const item = ledger.batches.find(
      (batch) =>
        batch.outletName === outletName &&
        (batch.batchId === normalized ||
          batch.barcodeValue === raw ||
          batch.barcodeValue === `LBL:${normalized}`),
    );
    return item ? { ...item } : null;
  }

  async reserveDraft(draft: DraftLabel): Promise<LabelBatch> {
    return this.mutate((ledger) => {
      const { request } = draft;
      const sourceId = request.sourceBatch?.batchId;
      if (sourceId) {
        const sourceIndex = ledger.batches.findIndex((item) => item.batchId === sourceId);
        if (sourceIndex < 0) throw new Error('Source disappeared before reserve.');
        const latestSource = ledger.batches[sourceIndex];
        if (latestSource.status !== 'active') throw new Error('Source batch is no longer active.');
        if (latestSource.remainingQuantity < draft.sourceConsumeQuantity) {
          throw new Error('Source quantity changed. Refresh and try again.');
        }
        ledger.batches[sourceIndex] = consumeSourceLocally(
          latestSource,
          draft.sourceConsumeQuantity,
        ) as ReservedBatch;
      }

      const dateKey = new Date(request.madeAt).toISOString().slice(0, 10).replace(/-/g, '');
      const outletCode = request.outletName.toUpperCase().replace(/[^A-Z0-9]/g, '') || 'OUTLET';
      const running = String(ledger.counter++).padStart(4, '0');
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

      ledger.batches.push(batch);
      return { ...batch };
    });
  }

  async commitPrinted(batchId: string, printedAt: string, _printerHost?: string) {
    return this.mutate((ledger) => {
      const index = ledger.batches.findIndex((item) => item.batchId === batchId);
      if (index < 0) throw new Error('Pending batch not found.');
      if (ledger.batches[index].status !== 'pending_print') {
        throw new Error('Batch is not pending print.');
      }
      ledger.batches[index] = {
        ...ledger.batches[index],
        status: 'active',
        printedAt,
      };
      return { ...ledger.batches[index] };
    });
  }

  async cancelPending(batchId: string, _reason?: string): Promise<void> {
    await this.mutate((ledger) => {
      const index = ledger.batches.findIndex((item) => item.batchId === batchId);
      if (index < 0) return;
      const pending = ledger.batches[index];
      if (pending.status !== 'pending_print') return;

      if (pending.sourceBatchId) {
        const sourceIndex = ledger.batches.findIndex(
          (item) => item.batchId === pending.sourceBatchId,
        );
        if (sourceIndex >= 0) {
          ledger.batches[sourceIndex] = restoreSourceQuantity(
            ledger.batches[sourceIndex],
            pending,
          ) as ReservedBatch;
        }
      }
      ledger.batches[index] = { ...pending, status: 'cancelled' };
    });
  }

  async resetLocalLedger(): Promise<void> {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(initialLedger()));
  }
}
