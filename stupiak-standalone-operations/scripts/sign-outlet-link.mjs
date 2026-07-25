import { createHmac } from 'node:crypto';

const [outletRef, role = 'outlet_operator', hoursText = '168'] = process.argv.slice(2);
const secret = process.env.OUTLET_LINK_SECRET;
if (!outletRef || !secret) {
  console.error('Usage: OUTLET_LINK_SECRET=... node scripts/sign-outlet-link.mjs <externalOutletId> [role] [hours]');
  process.exit(1);
}
const now = Math.floor(Date.now() / 1000);
const claims = { outletRef, role, iat: now, exp: now + Math.max(1, Number(hoursText || 168)) * 3600 };
const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
const signature = createHmac('sha256', secret).update(payload).digest('base64url');
const token = `${payload}.${signature}`;
console.log(`https://stupiakops.pages.dev/?outlet=${encodeURIComponent(outletRef)}&access_token=${encodeURIComponent(token)}#/home`);
