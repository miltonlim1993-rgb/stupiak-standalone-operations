const ROLE_ACTIONS = {
  outlet_operator: new Set([
    'getStandaloneCashBootstrap', 'submitStandaloneCashCount',
    'getBootstrap', 'submitStockCount', 'getStockSubmissionStatus', 'getStockSyncStatus', 'markWhatsAppOpened'
  ]),
  outlet_manager: new Set([
    'getStandaloneCashBootstrap', 'submitStandaloneCashCount', 'getStandaloneCashDashboard',
    'getBootstrap', 'submitStockCount', 'getStockSubmissionStatus', 'getStockSyncStatus', 'markWhatsAppOpened', 'getStockDashboard', 'getStockSetup'
  ]),
  operations_admin: new Set(['*']),
  system_admin: new Set(['*'])
};

export async function authorizeOutletRequest(context, { requestedOutlet, action }) {
  const secret = String(context.env.OUTLET_LINK_SECRET || '');
  if (!secret) return { ok: true, compatibilityMode: true, role: 'legacy', outletRef: requestedOutlet };

  const token = bearerToken(context.request);
  if (!token) return denied(401, 'A signed outlet link is required.', 'OUTLET_SESSION_REQUIRED');
  const verified = await verifyOutletToken(token, secret);
  if (!verified.ok) return denied(401, verified.error, 'OUTLET_SESSION_INVALID');

  const claims = verified.claims;
  const allowedOutlets = Array.isArray(claims.outlets) ? claims.outlets.map(String) : [String(claims.outletRef || '')].filter(Boolean);
  if (requestedOutlet && !allowedOutlets.includes(String(requestedOutlet))) {
    return denied(403, 'This session is not assigned to the requested outlet.', 'OUTLET_ACCESS_DENIED');
  }
  const allowedActions = ROLE_ACTIONS[String(claims.role || '')];
  if (!allowedActions || (!allowedActions.has('*') && !allowedActions.has(String(action || '')))) {
    return denied(403, 'This role cannot perform the requested action.', 'ACTION_ACCESS_DENIED');
  }
  return { ok: true, role: claims.role, outletRef: requestedOutlet || allowedOutlets[0] || '', claims };
}

export async function verifyOutletToken(token, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  const [payloadPart, signaturePart, extra] = String(token || '').split('.');
  if (!payloadPart || !signaturePart || extra) return { ok: false, error: 'Malformed outlet session.' };
  const expected = await hmac(payloadPart, secret);
  if (!constantTimeEqual(signaturePart, expected)) return { ok: false, error: 'Outlet session signature is invalid.' };
  let claims;
  try { claims = JSON.parse(decodeBase64Url(payloadPart)); }
  catch { return { ok: false, error: 'Outlet session payload is unreadable.' }; }
  if (!claims || Number(claims.exp || 0) <= nowSeconds) return { ok: false, error: 'Outlet session has expired.' };
  if (claims.nbf && Number(claims.nbf) > nowSeconds + 30) return { ok: false, error: 'Outlet session is not active yet.' };
  if (!claims.role || (!claims.outletRef && !Array.isArray(claims.outlets))) return { ok: false, error: 'Outlet session claims are incomplete.' };
  return { ok: true, claims };
}

function bearerToken(request) {
  const header = String(request.headers.get('Authorization') || '');
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

function denied(status, error, code) {
  return { ok: false, status, error, code };
}

async function hmac(value, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
  return encodeBase64Url(new Uint8Array(signature));
}

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

function encodeBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function constantTimeEqual(left, right) {
  if (!left || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}
