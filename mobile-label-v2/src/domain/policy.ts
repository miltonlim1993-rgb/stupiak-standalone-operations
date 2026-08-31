import { ExpiryRule, LabelAction, SourceStage } from './types';

export const WEB_FIFO_POLICY_VERSION = '4.6.25-label-source-fifo-v26';

const normalizedWords = (value: LabelAction) =>
  ` ${String(value || '').toLowerCase().replace(/[^a-z]+/g, ' ').trim()} `;

export function labelSourceTier(action: LabelAction): number {
  const words = normalizedWords(action);
  if (/\b(refill|refilled|refilling|cook|cooked|cooking)\b/.test(words)) return 3;
  if (/\b(open|opened|opening)\b/.test(words)) return 2;
  if (/\b(prepare|prepared|preparation|freeze|frozen|freezing|receive|received|receiving)\b/.test(words)) return 1;
  return 0;
}

export function labelSourceStage(tier: number): SourceStage {
  if (tier === 1) return 'first_hand';
  if (tier === 2) return 'second_hand';
  if (tier === 3) return 'third_hand';
  return 'unclassified';
}

/**
 * Mirrors the already-proven web v26 hierarchy. Sheet values still provide the
 * product/output fields; the hierarchy makes the source-chain rules explicit.
 */
export function applyWebV26Hierarchy(rule: ExpiryRule): ExpiryRule {
  const tier = labelSourceTier(rule.action);
  if (!tier) {
    return {
      ...rule,
      sourceTier: 0,
      sourceStage: 'unclassified',
      requiredSourceTier: 0,
      fifoReprintLocked: false,
    };
  }

  if (tier === 1) {
    return {
      ...rule,
      requiresSource: false,
      allowedSourceActions: '',
      sourceExpiryMode: 'none',
      sourceUsageMode: 'tracked',
      consumePerLabel: 1,
      sourceTier: 1,
      sourceStage: 'first_hand',
      requiredSourceTier: 0,
      fifoReprintLocked: true,
    };
  }

  const sourceProductId = rule.sourceProductId || rule.productId;
  const sourceProductName = rule.sourceProductName || rule.productName;

  if (tier === 2) {
    return {
      ...rule,
      sourceProductId,
      sourceProductName,
      requiresSource: true,
      allowedSourceActions:
        'prepare,prepared,preparation,freeze,frozen,freezing,received,receive,receiving',
      sourceExpiryMode: 'min',
      sourceUsageMode: 'tracked',
      consumePerLabel: 1,
      sourceTier: 2,
      sourceStage: 'second_hand',
      requiredSourceTier: 1,
      fifoReprintLocked: true,
    };
  }

  return {
    ...rule,
    sourceProductId,
    sourceProductName,
    requiresSource: true,
    allowedSourceActions: 'open,opened,opening',
    sourceExpiryMode: 'min',
    sourceUsageMode: 'terminal',
    consumePerLabel: 1,
    sourceTier: 3,
    sourceStage: 'third_hand',
    requiredSourceTier: 2,
    fifoReprintLocked: false,
  };
}

export const normalizeCatalogRules = (rules: ExpiryRule[]) =>
  rules.map(applyWebV26Hierarchy);
