/**
 * ONE-TIME FeedMe Insights integration for Standalone Cash Count.
 *
 * Add this file to the EXISTING FeedMe Insights / Close Up Apps Script project.
 * After Insights resolves or creates `<Outlet Name> Sales <Year>`, call:
 *
 *   registerResolvedFeedMeReportForCash_(payload, target);
 *
 * Required Script Properties in the FeedMe Insights GAS project:
 * STANDALONE_CASH_GAS_URL    = deployed Cash GAS /exec URL
 * STANDALONE_CASH_GAS_SECRET = same secret used by Cash GAS
 * STANDALONE_OPERATIONS_URL  = https://stupiak-standalone-operations.pages.dev
 *
 * No outlet-specific properties are required. outletId / restaurantId is the
 * stable key and every future outlet/year is registered automatically.
 */

function registerResolvedFeedMeReportForCash_(payload, target) {
  payload = payload || {};
  target = target || {};
  const props = PropertiesService.getScriptProperties();
  const gasUrl = String(props.getProperty('STANDALONE_CASH_GAS_URL') || '').trim();
  const secret = String(props.getProperty('STANDALONE_CASH_GAS_SECRET') || '').trim();
  if (!gasUrl || !secret) return { ok: false, skipped: true, reason: 'Standalone Cash registry is not configured' };

  const outletId = String(
    payload.outletId || payload.restaurantId || payload.feedmeOutletId || target.outletId || ''
  ).trim();
  const outletName = String(
    payload.outletName || payload.restaurantName || target.outlet || target.outletName || ''
  ).trim();
  const year = Number(
    target.year || payload.year || String(payload.businessDate || payload.date || '').slice(0, 4)
  );
  const spreadsheetId = String(
    target.spreadsheetId || (target.spreadsheet && target.spreadsheet.getId && target.spreadsheet.getId()) || ''
  ).trim();
  const outletFolderId = String(target.outletFolderId || target.folderId || '').trim();

  if (!outletId) throw new Error('Cannot register Cash report: FeedMe outletId / restaurantId is missing');
  if (!outletName) throw new Error('Cannot register Cash report: outletName is missing');
  if (!year || !spreadsheetId) throw new Error('Cannot register Cash report: year or spreadsheetId is missing');

  const cache = CacheService.getScriptCache();
  const cacheKey = 'cash-registry:' + outletId + ':' + year + ':' + spreadsheetId;
  if (cache.get(cacheKey)) return { ok: true, cached: true };

  const body = {
    action: 'registerOutletReport',
    secret: secret,
    feedmeOutletId: outletId,
    outletCode: outletName,
    outletName: outletName,
    year: year,
    spreadsheetId: spreadsheetId,
    outletFolderId: outletFolderId,
    siteKey: outletId,
    source: 'FeedMe Insights automatic outlet/year resolver'
  };

  const response = UrlFetchApp.fetch(gasUrl, {
    method: 'post',
    contentType: 'text/plain;charset=utf-8',
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
    followRedirects: true
  });
  const text = response.getContentText();
  let result;
  try { result = JSON.parse(text); } catch (_) { throw new Error('Cash registry returned unreadable content: ' + text.slice(0, 180)); }
  if (response.getResponseCode() >= 400 || result.ok === false) {
    throw new Error(result.error || 'Cash registry request failed (' + response.getResponseCode() + ')');
  }
  cache.put(cacheKey, '1', 21600);
  return result;
}

function standaloneCashUrlForOutlet_(outletId) {
  const base = String(
    PropertiesService.getScriptProperties().getProperty('STANDALONE_OPERATIONS_URL') ||
    'https://stupiak-standalone-operations.pages.dev'
  ).replace(/\/$/, '');
  return base + '/?outlet=' + encodeURIComponent(String(outletId || '').trim()) + '#/cash';
}
