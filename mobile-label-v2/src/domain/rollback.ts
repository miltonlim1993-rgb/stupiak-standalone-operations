import { LabelBatch } from './types';

export type ReservedBatch = LabelBatch & {
  sourceConsumedQuantity?: number;
};

export const restoreSourceQuantity = (
  source: LabelBatch,
  pending: ReservedBatch,
): LabelBatch => {
  const restoreBy = Math.max(0, Number(pending.sourceConsumedQuantity || 0));
  const remainingQuantity = Math.min(
    source.initialQuantity,
    source.remainingQuantity + restoreBy,
  );
  return {
    ...source,
    remainingQuantity,
    status: remainingQuantity > 0 ? 'active' : source.status,
  };
};
