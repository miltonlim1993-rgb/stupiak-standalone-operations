import { localCatalog, rawCatalogRules, rawCatalogSnapshot } from './catalogSource';

describe('embedded read-only Sheet catalog', () => {
  it('contains the captured ProductMaster and enabled ExpiryRules counts', () => {
    expect(rawCatalogSnapshot.meta.enabledProductCount).toBe(70);
    expect(rawCatalogSnapshot.meta.enabledRuleCount).toBe(116);
    expect(localCatalog.products).toHaveLength(70);
    expect(rawCatalogRules).toHaveLength(116);
    expect(localCatalog.rules).toHaveLength(116);
  });

  it('preserves raw Sheet values but applies web v26 hierarchy at runtime', () => {
    const raw = rawCatalogRules.find((rule) => rule.id === 'evaporated-milk-carnation-open-chiller');
    const runtime = localCatalog.rules.find((rule) => rule.id === 'evaporated-milk-carnation-open-chiller');
    expect(raw?.requiresSource).toBe(false);
    expect(runtime?.requiresSource).toBe(true);
    expect(runtime?.sourceTier).toBe(2);
    expect(runtime?.requiredSourceTier).toBe(1);
    expect(runtime?.allowedSourceActions).toMatch(/prepare/i);
  });

  it('keeps unclassified Sheet-specific source rules instead of overwriting them', () => {
    const rule = localCatalog.rules.find((item) => item.id === 'chicken-popcorn-l-defrost-chiller');
    expect(rule?.sourceTier).toBe(0);
    expect(rule?.requiresSource).toBe(true);
    expect(rule?.allowedSourceActions).toBe('Freeze');
    expect(rule?.sourceExpiryMode).toBe('min');
  });

  it('keeps the disabled Peanut Sauce rule out of runtime catalog', () => {
    expect(localCatalog.rules.some((rule) => rule.id === 'peanut-sauce-open-dry-storage')).toBe(false);
  });
});
