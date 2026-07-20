const ALLOWED_GAS_HOSTS = new Set(['script.google.com', 'script.googleusercontent.com']);

export async function onRequestPost(context) {
  try {
    const body = await context.request.json();
    const service = body.service === 'cash' ? 'cash' : 'stock';
    const settings = body.clientSettings || {};
    const envUrl = service === 'stock' ? context.env.STOCK_GAS_URL : context.env.CASH_GAS_URL;
    const envSecret = service === 'stock' ? context.env.STOCK_GAS_SECRET : context.env.CASH_GAS_SECRET;
    const clientUrl = service === 'stock' ? settings.stockCountGasUrl : settings.cashCountGasUrl;
    const clientSecret = service === 'stock' ? settings.stockCountGasSecret : settings.cashCountGasSecret;
    const targetUrl = String(envUrl || clientUrl || '').trim();
    const secret = String(envSecret || clientSecret || '');
    if (!targetUrl) return json({ ok:false, error:`${service} GAS URL is not configured` },400);
    const parsed = new URL(targetUrl);
    if (!ALLOWED_GAS_HOSTS.has(parsed.hostname) || !parsed.pathname.endsWith('/exec')) return json({ok:false,error:'Only deployed Google Apps Script /exec URLs are allowed'},400);

    const payload = { ...(body.payload || {}), secret };
    const gasResponse = await fetch(targetUrl, { method:'POST', headers:{'Content-Type':'text/plain;charset=utf-8'}, body:JSON.stringify(payload), redirect:'follow' });
    const text = await gasResponse.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      const looksLikeHtml = /<!doctype|<html|accounts\.google\.com|authorization required|sign in/i.test(text);
      const label = service === 'stock' ? 'Stock' : 'Cash';
      const error = looksLikeHtml
        ? `${label} GAS returned a Google HTML page. Open Apps Script → Deploy → Manage deployments → Edit, choose New version, Execute as Me, Who has access: Anyone, then deploy the existing /exec URL.`
        : `${label} GAS did not return JSON. Confirm the latest code is deployed as a new Web App version and that Cloudflare uses the same /exec URL.`;
      return json({ok:false,error,status:gasResponse.status,gasUrl:targetUrl},502);
    }

    if (data.ok && data.saved && !data.duplicate) {
      const event = buildEvent(service,payload,data);
      if (context.env.STATVARA_WEBHOOK_URL) context.waitUntil(sendStatvaraEvent(context.env,event));
    }
    data.integration = {
      statvara: context.env.STATVARA_WEBHOOK_URL ? 'queued_when_saved' : 'reserved',
      storageProvider: context.env.FILE_STORAGE_PROVIDER || 'google_drive'
    };
    return json(data,gasResponse.ok?200:502);
  } catch (error) { return json({ok:false,error:String(error?.message||error)},500); }
}

function buildEvent(service,payload,result){
  const isStock=service==='stock';
  return {
    id: isStock ? result.submissionId : result.eventId,
    type: isStock ? 'stock.count.submitted' : `cash.${payload.phase}.submitted`,
    occurredAt:new Date().toISOString(),
    source:'stupiak-standalone-operations',
    version:'1.0',
    outlet:{name:result.outlet||payload.outlet||''},
    businessDate:result.businessDate||payload.businessDate,
    actor:{name:payload.countedBy||payload.toStaff||''},
    storage:{provider:'google_drive',spreadsheetId:result.spreadsheetId||'',spreadsheetUrl:result.spreadsheetUrl||''},
    payload:isStock?{monthKey:result.monthKey,weekIndex:result.weekIndex,orderCount:result.orderCount,changedCellCount:result.changedCellCount}:{phase:payload.phase,countedTotal:payload.countedTotal,outgoingTotal:payload.outgoingTotal,incomingTotal:payload.incomingTotal,variance:payload.incomingTotal!=null?Number(payload.incomingTotal)-Number(payload.outgoingTotal):null}
  };
}

async function sendStatvaraEvent(env,event){
  const body=JSON.stringify(event); const headers={'Content-Type':'application/json','X-Stupiak-Event':event.type};
  if(env.STATVARA_API_KEY) headers.Authorization=`Bearer ${env.STATVARA_API_KEY}`;
  await fetch(env.STATVARA_WEBHOOK_URL,{method:'POST',headers,body});
}
function json(value,status=200){return new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json;charset=utf-8','Cache-Control':'no-store'}});}
