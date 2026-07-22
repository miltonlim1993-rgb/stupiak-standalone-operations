import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { authorizeOutletRequest, verifyOutletToken } from '../functions/_shared/outlet-auth.js';

const secret = 'test-secret-with-enough-entropy';
function token(claims) {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
}

test('accepts a valid, unexpired outlet session', async () => {
  const result = await verifyOutletToken(token({ outletRef: 'feedme-a', role: 'outlet_operator', exp: 2000 }), secret, 1000);
  assert.equal(result.ok, true);
  assert.equal(result.claims.outletRef, 'feedme-a');
});

test('rejects an expired outlet session', async () => {
  const result = await verifyOutletToken(token({ outletRef: 'feedme-a', role: 'outlet_operator', exp: 999 }), secret, 1000);
  assert.equal(result.ok, false);
});

test('rejects a modified outlet session', async () => {
  const signed = token({ outletRef: 'feedme-a', role: 'outlet_operator', exp: 2000 });
  const [payload, signature] = signed.split('.');
  const modified = Buffer.from(JSON.stringify({ outletRef: 'feedme-b', role: 'system_admin', exp: 2000 })).toString('base64url');
  const result = await verifyOutletToken(`${modified}.${signature}`, secret, 1000);
  assert.equal(result.ok, false);
  assert.notEqual(modified, payload);
});

test('denies access when the URL requests another outlet', async () => {
  const signed = token({ outletRef: 'feedme-a', role: 'outlet_operator', exp: Math.floor(Date.now() / 1000) + 3600 });
  const context = {
    env: { OUTLET_LINK_SECRET: secret },
    request: new Request('https://example.test', { headers: { Authorization: `Bearer ${signed}` } })
  };
  const result = await authorizeOutletRequest(context, { requestedOutlet: 'feedme-b', action: 'getBootstrap' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'OUTLET_ACCESS_DENIED');
});

test('prevents an outlet operator from opening dashboards', async () => {
  const signed = token({ outletRef: 'feedme-a', role: 'outlet_operator', exp: Math.floor(Date.now() / 1000) + 3600 });
  const context = {
    env: { OUTLET_LINK_SECRET: secret },
    request: new Request('https://example.test', { headers: { Authorization: `Bearer ${signed}` } })
  };
  const result = await authorizeOutletRequest(context, { requestedOutlet: 'feedme-a', action: 'getStockDashboard' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ACTION_ACCESS_DENIED');
});

test('allows an outlet operator to save a cash count', async () => {
  const signed = token({ outletRef: 'feedme-a', role: 'outlet_operator', exp: Math.floor(Date.now() / 1000) + 3600 });
  const context = {
    env: { OUTLET_LINK_SECRET: secret },
    request: new Request('https://example.test', { headers: { Authorization: `Bearer ${signed}` } })
  };
  const result = await authorizeOutletRequest(context, { requestedOutlet: 'feedme-a', action: 'saveStandaloneCashCount' });
  assert.equal(result.ok, true);
});
