export type LabelAction =
  | 'Prepare'
  | 'Freeze'
  | 'Received'
  | 'Open'
  | 'Refill'
  | 'Cooked'
  | 'Defrost'
  | 'Marinated'
  | string;

export type BatchStatus =
  | 'active'
  | 'consumed'
  | 'expired'
  | 'pending_print'
  | 'cancelled';

export type SourceStage = 'unclassified' | 'first_hand' | 'second_hand' | 'third_hand';

export interface ProductMaster {
  productId: string;
  enabled: boolean;
  productName: string;
  displayName?: string;
  category?: string;
  sku?: string;
  productBarcode?: string;
  alternateBarcodes?: string[];
  defaultLabelTitle?: string;
  note?: string;
}

export interface ExpiryRule {
  id: string;
  productId: string;
  productName: string;
  action: LabelAction;
  storageCondition: string;
  durationMinutes: number | null;
  manualExpiryRequired: boolean;
  requiresQuantity: boolean;
  quantityLabel?: string;
  quantityUnit?: string;
  showQuantityOnLabel: boolean;
  enabled: boolean;
  note?: string;
  requiresSource: boolean;
  allowedSourceActions?: string;
  sourceAllowedOutlets?: string;
  sourceExpiryMode?: 'none' | 'trace_only' | 'min' | 'inherit' | string;
  sourceProductId?: string;
  sourceProductName?: string;
  outputProductId?: string;
  outputProductName?: string;
  /** Web v26 name: each printed child label consumes this many source slots. */
  consumePerLabel?: number;
  sourceUsageMode?: 'tracked' | 'terminal' | 'manual' | string;
  sourceCapacity?: number;
  sourceUnit?: string;
  sourceTier?: number;
  sourceStage?: SourceStage;
  requiredSourceTier?: number;
  fifoReprintLocked?: boolean;
  /** Backward-compatible alias used by the first V2 draft. */
  sourceConsumptionQuantity?: number;
}

export interface LabelBatch {
  batchId: string;
  barcodeValue: string;
  outletName: string;
  productId: string;
  productName: string;
  action: LabelAction;
  storageCondition: string;
  madeAt: string;
  expiryAt: string;
  /** Source capacity. For tier 1/2 this is the number of labels initially printed. */
  initialQuantity: number;
  /** Remaining source capacity. */
  remainingQuantity: number;
  /** Source-capacity unit, normally "label" for parity with web v26. */
  quantityUnit: string;
  /** Optional business/content quantity printed on the label, separate from source capacity. */
  contentQuantity?: number;
  contentQuantityUnit?: string;
  /** Number of identical physical labels created by this batch record. */
  printQuantity?: number;
  sourceTier?: number;
  sourceStage?: SourceStage;
  sourceBatchId?: string;
  sourceAction?: LabelAction;
  sourceExpiryAt?: string;
  sourceConsumedQuantity?: number;
  status: BatchStatus;
  staffName?: string;
  createdAt: string;
  printedAt?: string;
}

export interface SourceEligibilityResult {
  ok: boolean;
  batch?: LabelBatch;
  reason?:
    | 'NOT_FOUND'
    | 'WRONG_OUTLET'
    | 'WRONG_PRODUCT'
    | 'ACTION_NOT_ALLOWED'
    | 'WRONG_TIER'
    | 'SOURCE_CHAIN_INCOMPLETE'
    | 'EXPIRED'
    | 'EXHAUSTED'
    | 'NOT_FIFO'
    | 'INACTIVE';
  message?: string;
  fifoBatchId?: string;
}

export interface DraftLabelRequest {
  outletName: string;
  staffName: string;
  product: ProductMaster;
  rule: ExpiryRule;
  /** Business quantity/weight requested by ExpiryRules, not number of printed labels. */
  quantity: number;
  /** Number of physical labels to create. Web v26 calls this print_quantity. */
  printQuantity?: number;
  sourceBatch?: LabelBatch;
  madeAt: string;
  manualExpiryAt?: string;
}

export interface DraftLabel {
  request: DraftLabelRequest;
  expiryAt: string;
  sourceConsumeQuantity: number;
}
