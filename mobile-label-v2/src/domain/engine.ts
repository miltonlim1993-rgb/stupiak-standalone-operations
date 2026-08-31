import { labelSourceTier } from './policy';
import {
  DraftLabel,
  DraftLabelRequest,
  ExpiryRule,
  LabelBatch,
  SourceEligibilityResult,
} from './types';

const normalizedList = (value?: string): string[] =>
  String(value || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

const asTime = (value: string): number => {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
};

const batchTier = (batch: LabelBatch): number =>
  Number(batch.sourceTier || 0) || labelSourceTier(batch.action);

export const isExpired = (batch: LabelBatch, now = new Date()): boolean =>
  Boolean(batch.expiryAt) && asTime(batch.expiryAt) <= now.getTime();

export const eligibleSources = (
  batches: LabelBatch[],
  rule: ExpiryRule,
  outletName: string,
  now = new Date(),
): LabelBatch[] => {
  const allowedActions = normalizedList(rule.allowedSourceActions);
  const allowedOutlets = normalizedList(rule.sourceAllowedOutlets);
  const requiredSourceProductId = String(rule.sourceProductId || rule.productId || '').trim();
  const requiredTier = Number(rule.requiredSourceTier || 0);

  return batches
    .filter((batch) => batch.status === 'active')
    .filter((batch) => batch.remainingQuantity > 0)
    .filter((batch) => !isExpired(batch, now))
    .filter((batch) => !allowedOutlets.length || allowedOutlets.includes(batch.outletName.toLowerCase()))
    .filter((batch) => batch.outletName === outletName)
    .filter((batch) => !requiredSourceProductId || batch.productId === requiredSourceProductId)
    .filter((batch) => !requiredTier || batchTier(batch) === requiredTier)
    .filter((batch) => requiredTier !== 2 || Boolean(String(batch.sourceBatchId || '').trim()))
    .filter(
      (batch) =>
        !allowedActions.length || allowedActions.includes(String(batch.action || '').trim().toLowerCase()),
    )
    .sort((a, b) => {
      const madeDiff = asTime(a.madeAt) - asTime(b.madeAt);
      if (madeDiff !== 0) return madeDiff;
      return a.batchId.localeCompare(b.batchId, undefined, { numeric: true });
    });
};

export const validateSource = (
  candidate: LabelBatch | undefined,
  batches: LabelBatch[],
  rule: ExpiryRule,
  outletName: string,
  now = new Date(),
): SourceEligibilityResult => {
  if (!candidate) {
    return { ok: false, reason: 'NOT_FOUND', message: 'Source batch not found.' };
  }
  if (candidate.outletName !== outletName) {
    return { ok: false, reason: 'WRONG_OUTLET', message: 'This batch belongs to another outlet.' };
  }
  const sourceProductId = String(rule.sourceProductId || rule.productId || '').trim();
  if (sourceProductId && candidate.productId !== sourceProductId) {
    return { ok: false, reason: 'WRONG_PRODUCT', message: 'Source product does not match this action.' };
  }

  const requiredTier = Number(rule.requiredSourceTier || 0);
  const actualTier = batchTier(candidate);
  if (requiredTier && actualTier !== requiredTier) {
    return {
      ok: false,
      reason: 'WRONG_TIER',
      message:
        requiredTier === 1
          ? 'Open must use a first-hand Prepare, Freeze or Received label.'
          : 'Refill and Cooked must use a second-hand Open label.',
    };
  }
  if (requiredTier === 2 && !String(candidate.sourceBatchId || '').trim()) {
    return {
      ok: false,
      reason: 'SOURCE_CHAIN_INCOMPLETE',
      message: 'This Open label has no first-hand source link.',
    };
  }

  const allowedActions = normalizedList(rule.allowedSourceActions);
  if (
    allowedActions.length &&
    !allowedActions.includes(String(candidate.action || '').trim().toLowerCase())
  ) {
    return { ok: false, reason: 'ACTION_NOT_ALLOWED', message: 'This source action is not allowed.' };
  }
  if (candidate.status !== 'active') {
    return { ok: false, reason: 'INACTIVE', message: 'Source batch is no longer active.' };
  }
  if (candidate.remainingQuantity <= 0) {
    return { ok: false, reason: 'EXHAUSTED', message: 'Source batch has no remaining quantity.' };
  }
  if (isExpired(candidate, now)) {
    return { ok: false, reason: 'EXPIRED', message: 'Source batch has expired.' };
  }

  const fifo = eligibleSources(batches, rule, outletName, now)[0];
  if (fifo && fifo.batchId !== candidate.batchId) {
    return {
      ok: false,
      reason: 'NOT_FIFO',
      fifoBatchId: fifo.batchId,
      message: `FIFO blocked: use the older batch ${fifo.batchId} first.`,
    };
  }

  return { ok: true, batch: candidate };
};

export const computeRuleExpiry = (request: DraftLabelRequest): string => {
  const { rule, madeAt, manualExpiryAt, sourceBatch } = request;
  const madeMs = asTime(madeAt);
  if (!madeMs) throw new Error('Made time is invalid.');

  if (rule.manualExpiryRequired) {
    if (!manualExpiryAt) throw new Error('Manual expiry is required.');
    const manualMs = asTime(manualExpiryAt);
    if (!manualMs || manualMs <= madeMs) {
      throw new Error('Use-by time must be later than the made time.');
    }
    return new Date(manualMs).toISOString();
  }

  const duration = Number(rule.durationMinutes);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('This expiry rule has no valid automatic duration.');
  }

  const ownExpiryMs = madeMs + duration * 60_000;
  const mode = String(rule.sourceExpiryMode || 'none').trim().toLowerCase();

  if (!sourceBatch || mode === 'none' || mode === 'trace_only') {
    return new Date(ownExpiryMs).toISOString();
  }

  const sourceExpiryMs = asTime(sourceBatch.expiryAt);
  if (!sourceExpiryMs && ['min', 'minimum', 'earliest', 'inherit', 'source'].includes(mode)) {
    throw new Error('The source batch has no valid use-by time.');
  }
  if (sourceExpiryMs && sourceExpiryMs <= madeMs) {
    throw new Error('This source batch has expired.');
  }
  if (!sourceExpiryMs) return new Date(ownExpiryMs).toISOString();
  if (['inherit', 'source', 'same_as_source'].includes(mode)) {
    return new Date(sourceExpiryMs).toISOString();
  }
  if (['min', 'minimum', 'earliest', 'cap', 'cap_at_source', 'source_cap'].includes(mode)) {
    return new Date(Math.min(ownExpiryMs, sourceExpiryMs)).toISOString();
  }
  return new Date(ownExpiryMs).toISOString();
};

export const consumePerLabelFor = (rule: ExpiryRule): number => {
  const configured = Number(rule.consumePerLabel ?? rule.sourceConsumptionQuantity ?? 1);
  return Number.isFinite(configured) && configured >= 0 ? configured : 1;
};

export const sourceConsumeQuantityFor = (
  rule: ExpiryRule,
  printQuantity = 1,
): number => {
  if (!rule.requiresSource) return 0;
  return Math.max(0, printQuantity * consumePerLabelFor(rule));
};

export const createDraftLabel = (
  request: DraftLabelRequest,
  allBatches: LabelBatch[],
  now = new Date(),
): DraftLabel => {
  if (!request.rule.enabled) throw new Error('This label rule is disabled.');
  if (request.rule.requiresQuantity && !(request.quantity > 0)) {
    throw new Error('Quantity must be greater than zero.');
  }

  const printQuantity = Number(request.printQuantity || 1);
  if (!Number.isInteger(printQuantity) || printQuantity < 1 || printQuantity > 100) {
    throw new Error('Print quantity must be a whole number from 1 to 100.');
  }
  const sourceConsumeQuantity = sourceConsumeQuantityFor(request.rule, printQuantity);

  if (request.rule.requiresSource) {
    const eligibility = validateSource(
      request.sourceBatch,
      allBatches,
      request.rule,
      request.outletName,
      now,
    );
    if (!eligibility.ok) throw new Error(eligibility.message || 'Invalid source batch.');
    if ((request.sourceBatch?.remainingQuantity || 0) < sourceConsumeQuantity) {
      throw new Error(
        `This source batch has only ${request.sourceBatch?.remainingQuantity || 0} remaining. Choose another batch.`,
      );
    }
  }

  return {
    request: { ...request, printQuantity },
    expiryAt: computeRuleExpiry(request),
    sourceConsumeQuantity,
  };
};

export const consumeSourceLocally = (
  source: LabelBatch,
  consumeQuantity: number,
): LabelBatch => {
  const remaining = Math.max(
    0,
    Math.round((source.remainingQuantity - consumeQuantity + Number.EPSILON) * 1000) / 1000,
  );
  return {
    ...source,
    remainingQuantity: remaining,
    status: remaining === 0 ? 'consumed' : source.status,
  };
};
