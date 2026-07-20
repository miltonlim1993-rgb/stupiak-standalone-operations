async function parseResponse(response) {
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`Server returned an unreadable response (${response.status})`); }
  if (!response.ok || data.ok === false) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

async function directGas(service, payload, settings) {
  const url = service === 'stock' ? settings.stockCountGasUrl : settings.cashCountGasUrl;
  const secret = service === 'stock' ? settings.stockCountGasSecret : settings.cashCountGasSecret;
  if (!url) throw new Error(`${service === 'stock' ? 'Stock' : 'Cash'} GAS URL has not been configured`);
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ ...payload, secret }),
    redirect: 'follow'
  });
  return parseResponse(response);
}

export async function callOperations(service, payload, settings) {
  try {
    const response = await fetch('/api/operations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service, payload, clientSettings: settings })
    });
    if (response.status !== 404 && response.headers.get('content-type')?.includes('application/json')) {
      return await parseResponse(response);
    }
  } catch (error) {
    if (!location.hostname.includes('localhost') && !location.hostname.includes('127.0.0.1')) throw error;
  }
  return directGas(service, payload, settings);
}

export async function getSystemStatus() {
  try {
    const response = await fetch('/api/system');
    if (!response.ok) return null;
    return await response.json();
  } catch { return null; }
}
