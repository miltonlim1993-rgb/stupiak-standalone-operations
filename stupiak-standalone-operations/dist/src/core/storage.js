import { DEFAULT_STOCK_GAS_URL, DRAFT_KEY, SETTINGS_KEY } from '../config.js';

const safeParse = (value, fallback) => {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
};

export function loadSettings() {
  const stored = safeParse(localStorage.getItem(SETTINGS_KEY), {});
  return {
    stockCountGasUrl: stored.stockCountGasUrl || DEFAULT_STOCK_GAS_URL,
    stockCountGasSecret: stored.stockCountGasSecret || '',
    cashCountGasUrl: stored.cashCountGasUrl || '',
    cashCountGasSecret: stored.cashCountGasSecret || ''
  };
}

export function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

export function loadDrafts() {
  return safeParse(localStorage.getItem(DRAFT_KEY), {});
}

export function saveDrafts(drafts) {
  localStorage.setItem(DRAFT_KEY, JSON.stringify(drafts));
}
