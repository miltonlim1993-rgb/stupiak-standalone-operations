export const LABEL_FIFO_POLICY_VERSION = '4.6.25-label-source-fifo-v26'

const ACTION_ALIASES = new Map([
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

export const FIRST_HAND_SOURCE_ACTIONS = 'prepare,prepared,freeze,frozen,received,receive'
export const SECOND_HAND_SOURCE_ACTIONS = 'open,opened'

export function normalizeLabelAction(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z]+/g, '')
}

export function labelSourceTier(value = '') {
  return ACTION_ALIASES.get(normalizeLabelAction(value)) || 0
}

export function labelSourceStage(value = '') {
  const tier = typeof value === 'number' ? value : labelSourceTier(value)
  if (tier === 1) return 'first_hand'
  if (tier === 2) return 'second_hand'
  if (tier === 3) return 'third_hand'
  return 'unclassified'
}

export function fifoReprintLocked(value = '') {
  const tier = typeof value === 'number' ? value : labelSourceTier(value)
  return tier === 1 || tier === 2
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
      requiresSource: true,
      allowedSourceActions: FIRST_HAND_SOURCE_ACTIONS,
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
    requiresSource: true,
    allowedSourceActions: SECOND_HAND_SOURCE_ACTIONS,
    sourceExpiryMode: 'min',
    consumePerLabel: 1,
    sourceTier: 3,
    sourceStage: 'third_hand',
    requiredSourceTier: 2,
    fifoReprintLocked: false,
  }
}

export function applyHierarchyToCatalog(catalog = {}) {
  const rules = Array.isArray(catalog.rules) ? catalog.rules.map(applyHierarchyToRule) : catalog.rules
  return {
    ...catalog,
    rules,
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

export function labelTierFromRecord(record = {}) {
  let meta = {}
  try {
    meta = JSON.parse(record.notes || '{}') || {}
  } catch {
    meta = {}
  }
  const stored = Number(meta.source_tier || meta.label_source_tier || 0)
  return stored >= 1 && stored <= 3 ? stored : labelSourceTier(meta.action)
}

export function fifoOrderTimestamp(record = {}) {
  let meta = {}
  try {
    meta = JSON.parse(record.notes || '{}') || {}
  } catch {
    meta = {}
  }
  const values = [meta.prepared_at, record.printed_at, record.created_date, record.prep_date]
  for (const value of values) {
    const parsed = Date.parse(String(value || ''))
    if (Number.isFinite(parsed)) return parsed
  }
  return Number.MAX_SAFE_INTEGER
}
