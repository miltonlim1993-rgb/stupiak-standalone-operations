import {
  DraftLabel,
  DraftLabelRequest,
  ExpiryRule,
  LabelBatch,
  SourceEligibilityResult,
} from './types';

const asCsvSet = (value?: string): Set<string> =>
  new Set(
    String(value || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );

const asTime = (value: string): number => {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
};

export const isExpired = (batch: LabelBatch, now = new Date()): boolean =>
  Boolean(batch.expiryAt) && asTime(batch.expiryAt) <= now.getTime();

export const eligibleSources = (
  batches: LabelBatch[],
  rule: ExpiryRule,
  outletName: string,
  now = new Date(),
): LabelBatch[] => {
  const allowedActions = asCsvSet(rule.allowedSourceActions);
  const allowedOutlets = asCsvSet(rule.sourceAllowedOutlets);
  const requiredSourceProductId = String(rule.sourceProductId || rule.productId || '').trim();

  return batches
    .filter((batch) => batch.status === 'active')
    .filter((batch) => batch.remainingQuantity > 0)
    .filter((batch) => !isExpired(batch, now))
    .filter((batch) => !allowedOutlets.size || allowedOutlets.has(batch.outletName))
    .filter((batch) => batch.outletName === outletName)
    .filter((batch) => !requiredSourceProductId || batch.productId === requiredSourceProductId)
    .filter((batch) => !allowedActions.size || allowedActions.has(batch.action))
    .sort((a, b) => {
      const madeDiff = asTime(a.madeAt) - asTime(b.madeAt);
      if (madeDiff !== 0) return madeDiff;
      return a.batchId.localeCompare(b.batchId);
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
  const allowedActions = asCsvSet(rule.allowedSourceActions);
  if (allowedActions.size && !allowedActions.has(candidate.action)) {
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
      message: `Older eligible stock exists: ${fifo.batchId}`,
    };
  }

  return { ok: true, batch: candidate };
};

export const computeRuleExpiry = (request: DraftLabelRequest): string => {
  const { rule, madeAt, manualExpiryAt, sourceBatch } = request;
  if (rule.manualExpiryRequired) {
    if (!manualExpiryAt) throw new Error('Manual expiry is required.');
    return new Date(manualExpiryAt).toISOString();
  }

  if (rule.durationMinutes === null || !Number.isFinite(Number(rule.durationMinutes))) {
    throw new Error('Expiry duration is missing.');
  }

  const madeMs = asTime(madeAt);
  if (!madeMs) throw new Error('Made time is invalid.');
  const ownExpiryMs = madeMs + Number(rule.durationMinutes) * 60_000;
  const mode = String(rule.sourceExpiryMode || 'none');

  if (!sourceBatch || mode === 'none' || mode === 'trace_only') {
    return new Date(ownExpiryMs).toISOString();
  }

  const sourceExpiryMs = asTime(sourceBatch.expiryAt);
  if (!sourceExpiryMs) return new Date(ownExpiryMs).toISOString();
  if (mode === 'inherit') return new Date(sourceExpiryMs).toISOString();
  if (mode === 'min') return new Date(Math.min(ownExpiryMs, sourceExpiryMs)).toISOString();
  return new Date(ownExpiryMs).toISOString();
};

export const sourceConsumeQuantityFor = (rule: ExpiryRule): number => {
  const configured = Number(rule.sourceConsumptionQuantity || 1);
  return Number.isFinite(configured) && configured > 0 ? configured : 1;
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

  if (request.rule.requiresSource) {
    const eligibility = validateSource(
      request.sourceBatch,
      allBatches,
      request.rule,
      request.outletName,
      now,
    );
    if (!eligibility.ok) throw new Error(eligibility.message || 'Invalid source batch.');
    const consume = sourceConsumeQuantityFor(request.rule);
    if ((request.sourceBatch?.remainingQuantity || 0) < consume) {
      throw new Error('Source batch does not have enough remaining quantity.');
    }
  }

  return {
    request,
    expiryAt: computeRuleExpiry(request),
    sourceConsumeQuantity: request.rule.requiresSource ? sourceConsumeQuantityFor(request.rule) : 0,
  };
};

export const consumeSourceLocally = (
  source: LabelBatch,
  consumeQuantity: number,
): LabelBatch => {
  const remaining = Math.max(0, source.remainingQuantity - consumeQuantity);
  return {
    ...source,
    remainingQuantity: remaining,
    status: remaining === 0 ? 'consumed' : source.status,
  };
};
