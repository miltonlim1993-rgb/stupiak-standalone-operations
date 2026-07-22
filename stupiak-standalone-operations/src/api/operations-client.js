async function parseResponse(response) {
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`Server returned an unreadable response (${response.status})`); }
  if (!response.ok || data.ok === false) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 25000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`Request took longer than ${Math.round(timeoutMs / 1000)} seconds. Tap Retry.`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function directGas(service, payload, settings, options = {}) {
  const url = service === 'stock' ? settings.stockCountGasUrl : settings.cashCountGasUrl;
  const secret = service === 'stock' ? settings.stockCountGasSecret : settings.cashCountGasSecret;
  if (!url) throw new Error(`${service === 'stock' ? 'Stock' : 'Cash'} GAS URL has not been configured`);
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ ...payload, secret }),
    redirect: 'follow'
  }, options.timeoutMs || 25000);
  return parseResponse(response);
}

export async function callOperations(service, payload, settings, options = {}) {
  try {
    const response = await fetchWithTimeout('/api/operations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...outletAuthorizationHeader() },
      body: JSON.stringify({ service, payload, clientSettings: settings })
    }, options.timeoutMs || 25000);
    if (response.status !== 404 && response.headers.get('content-type')?.includes('application/json')) {
      return await parseResponse(response);
    }
  } catch (error) {
    if (!location.hostname.includes('localhost') && !location.hostname.includes('127.0.0.1')) throw error;
  }
  return directGas(service, payload, settings, options);
}

function outletAuthorizationHeader() {
  const params = new URLSearchParams(location.search);
  const supplied = params.get('access_token') || '';
  if (supplied) {
    try { sessionStorage.setItem('stupiak.operations.outletSession.v1', supplied); } catch {}
    params.delete('access_token');
    const query = params.toString();
    history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
  }
  let token = supplied;
  if (!token) {
    try { token = sessionStorage.getItem('stupiak.operations.outletSession.v1') || ''; } catch {}
  }
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function getSystemStatus() {
  try {
    const response = await fetchWithTimeout('/api/system', {}, 8000);
    if (!response.ok) return null;
    return await response.json();
  } catch { return null; }
}
