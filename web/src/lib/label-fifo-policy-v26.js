export const LABEL_FIFO_POLICY_VERSION = '4.6.25-label-source-fifo-v26'

const ACTION_TIERS = new Map([
  ['prepare', 1],
  ['prepared', 1],
  ['preparation', 1],
  ['freeze', 1],
  ['frozen', 1],
  ['freezing', 1],
  ['receive', 1],
  ['received', 1],
  ['receiving', 1],
  ['open', 2],
  ['opened', 2],
  ['opening', 2],
  ['refill', 3],
  ['refilled', 3],
  ['refilling', 3],
  ['cook', 3],
  ['cooked', 3],
  ['cooking', 3],
])

function actionKey(value = '') {
  return String(value || '').trim().toLowerCase().replace(/[^a-z]+/g, '')
}

export function labelSourceTier(value = '') {
  const raw = String(value || '').trim().toLowerCase()
  const words = ` ${raw.replace(/[^a-z]+/g, ' ').trim()} `
  if (/\b(refill|refilled|refilling|cook|cooked|cooking)\b/.test(words)) return 3
  if (/\b(open|opened|opening)\b/.test(words)) return 2
  if (/\b(prepare|prepared|preparation|freeze|frozen|freezing|receive|received|receiving)\b/.test(words)) return 1
  return ACTION_TIERS.get(actionKey(value)) || 0
}

function sourceProductDefaults(rule = {}) {
  return {
    sourceProductId: rule.sourceProductId || rule.productId || '',
    sourceProductName: rule.sourceProductName || rule.productName || '',
  }
}

export function applyHierarchyToRule(rule = {}) {
  const tier = labelSourceTier(rule.action)
  if (!tier) return { ...rule, sourceTier: 0, sourceStage: 'unclassified', fifoReprintLocked: false }
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
    }
  }
  if (tier === 2) {
    return {
      ...rule,
      ...sourceProductDefaults(rule),
      requiresSource: true,
      allowedSourceActions: 'prepare,prepared,preparation,freeze,frozen,freezing,received,receive,receiving',
      sourceExpiryMode: 'min',
      sourceUsageMode: 'tracked',
      consumePerLabel: 1,
      sourceTier: 2,
      sourceStage: 'second_hand',
      requiredSourceTier: 1,
      fifoReprintLocked: true,
    }
  }
  return {
    ...rule,
    ...sourceProductDefaults(rule),
    requiresSource: true,
    allowedSourceActions: 'open,opened,opening',
    sourceExpiryMode: 'min',
    consumePerLabel: 1,
    sourceTier: 3,
    sourceStage: 'third_hand',
    requiredSourceTier: 2,
    fifoReprintLocked: false,
  }
}

export function applyHierarchyToCatalog(catalog = {}) {
  return {
    ...catalog,
    rules: Array.isArray(catalog.rules) ? catalog.rules.map(applyHierarchyToRule) : catalog.rules,
    fifoPolicy: {
      version: LABEL_FIFO_POLICY_VERSION,
      firstHand: ['Prepare', 'Freeze', 'Received'],
      secondHand: ['Open'],
      thirdHand: ['Refill', 'Cooked'],
      childExpiryMode: 'min',
      firstSecondReprintLocked: true,
    },
  }
}
