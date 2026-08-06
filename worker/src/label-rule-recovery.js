function normalizedText(value) {
  return String(value || '').trim().toLowerCase()
}

export function stableRuleMatch(rules = [], body = {}) {
  const requestedKey = String(body?.rule_key || '').trim()
  if (!requestedKey) return null

  const exact = rules.find((rule) => String(rule.ruleKey || '') === requestedKey)
  if (exact) return exact

  // Legacy rule keys included a volatile row suffix. Recover only when the
  // stable rule ID, product, action and storage identify exactly one current
  // rule. Ambiguous or mismatched requests remain rejected by the normal
  // create-label validation path.
  const [keyRuleId = '', keyAction = '', keyStorage = ''] = requestedKey.split('::')
  const ruleId = String(body?.rule_id || keyRuleId || '').trim()
  const productId = String(body?.product_id || '').trim()

  let candidates = rules.filter((rule) => (
    (!ruleId || String(rule.ruleId || '') === ruleId)
    && (!productId || String(rule.productId || '') === productId)
  ))

  if (keyAction) {
    const actionMatches = candidates.filter(
      (rule) => normalizedText(rule.action) === normalizedText(keyAction),
    )
    if (actionMatches.length) candidates = actionMatches
  }

  if (keyStorage) {
    const storageMatches = candidates.filter(
      (rule) => normalizedText(rule.storageCondition) === normalizedText(keyStorage),
    )
    if (storageMatches.length) candidates = storageMatches
  }

  return candidates.length === 1 ? candidates[0] : null
}

export function recoveredCreateBody(rules = [], body = {}) {
  const matched = stableRuleMatch(rules, body)
  if (!matched) return null
  if (String(matched.ruleKey || '') === String(body?.rule_key || '')) return null

  return {
    ...body,
    rule_id: matched.ruleId,
    rule_key: matched.ruleKey,
    product_id: matched.productId || body.product_id,
  }
}
