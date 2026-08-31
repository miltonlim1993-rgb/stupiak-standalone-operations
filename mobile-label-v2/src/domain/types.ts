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
  initialQuantity: number;
  remainingQuantity: number;
  quantityUnit: string;
  sourceBatchId?: string;
  sourceAction?: LabelAction;
  sourceExpiryAt?: string;
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
  quantity: number;
  sourceBatch?: LabelBatch;
  madeAt: string;
  manualExpiryAt?: string;
}

export interface DraftLabel {
  request: DraftLabelRequest;
  expiryAt: string;
  sourceConsumeQuantity: number;
}
