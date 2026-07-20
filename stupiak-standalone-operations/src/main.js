import { APP_VERSION } from './config.js';
import { callOperations, getSystemStatus } from './api/operations-client.js';
import { loadSettings, saveSettings } from './core/storage.js';
import { todayIso } from './core/dates.js';
import { homePage } from './pages/home.js';
import { cashPage, createCashState, buildCashPayload, cashTotal } from './pages/cash.js';
import { settingsPage } from './pages/settings.js';
import { stockPage, createStockState, initializeStockValues, buildStockPayload, validateStock } from './pages/stock.js';
import { icon } from './ui/icons.js';
import { showToast } from './ui/toast.js';

const app = document.querySelector('#app');
const state = {
  route: location.hash.replace('#/','') || 'home',
  settings: loadSettings(), outlet: '', systemStatus: null,
  stock: createStockState(), cash: createCashState(), deferredPrompt: null
};

function shell(content) {
  const nav = [['home','home','Home'],['cash','cash','Cash Count'],['stock','stock','Stock Count'],['settings','settings','Dev Settings']];
  return `<div class="app-shell">
    <aside class="sidebar">
      <div class="brand"><div class="brand-mark">S</div><div><strong>Stupiak</strong><span>Operations</span></div></div>
      <nav>${nav.map(([route,ico,label])=>`<button class="${state.route===route?'active':''}" data-route="${route}">${icon(ico)}<span>${label}</span></button>`).join('')}</nav>
      <div class="sidebar-foot"><button id="install-app" class="install-button" ${state.deferredPrompt?'':'hidden'}>Install App</button><span>v${APP_VERSION}</span></div>
    </aside>
    <main class="main"><header class="topbar"><button class="mobile-brand" data-route="home"><span>S</span> Stupiak Ops</button><div class="topbar-status"><span class="status-dot ${state.outlet?'online':''}"></span>${state.outlet||'Standalone mode'}</div></header>${content}</main>
    <nav class="bottom-nav">${nav.slice(0,3).concat([nav[3]]).map(([route,ico,label])=>`<button class="${state.route===route?'active':''}" data-route="${route}">${icon(ico)}<span>${label.replace(' Count','')}</span></button>`).join('')}</nav>
  </div>`;
}

function render() {
  const context = { settings: state.settings, outlet: state.outlet, systemStatus: state.systemStatus };
  const page = state.route === 'cash' ? cashPage(context,state.cash) : state.route === 'stock' ? stockPage(context,state.stock) : state.route === 'settings' ? settingsPage(context) : homePage(context);
  app.innerHTML = shell(page);
  bindCommon();
  if (state.route === 'stock') bindStock();
  if (state.route === 'cash') bindCash();
  if (state.route === 'settings') bindSettings();
}

function navigate(route) {
  state.route = route;
  location.hash = `#/${route}`;
  render();
  if (route === 'stock' && !state.stock.data && !state.stock.loading) loadStock();
}

function bindCommon() {
  document.querySelectorAll('[data-route]').forEach((el)=>el.addEventListener('click',()=>navigate(el.dataset.route)));
  document.querySelector('#install-app')?.addEventListener('click',async()=>{if(!state.deferredPrompt)return;state.deferredPrompt.prompt();await state.deferredPrompt.userChoice;state.deferredPrompt=null;render();});
}

async function loadStock() {
  state.stock.loading = true; state.stock.error = ''; state.stock.submitResult = null; render();
  try {
    const data = await callOperations('stock',{action:'getBootstrap',businessDate:state.stock.businessDate},state.settings);
    state.stock.data = data; state.outlet = data.outlet || state.outlet; initializeStockValues(state.stock,data);
  } catch (error) { state.stock.error = error.message; }
  finally { state.stock.loading = false; render(); }
}

function bindStock() {
  document.querySelector('#stock-date')?.addEventListener('change',(event)=>{state.stock.businessDate=event.target.value||todayIso();state.stock.data=null;loadStock();});
  document.querySelector('#retry-stock')?.addEventListener('click',loadStock);
  document.querySelectorAll('[data-stock-tab]').forEach((el)=>el.addEventListener('click',()=>{state.stock.activeTab=el.dataset.stockTab;state.stock.submitResult=null;render();}));
  document.querySelectorAll('[data-mobile-week]').forEach((el)=>el.addEventListener('click',()=>{state.stock.mobileWeek=Number(el.dataset.mobileWeek);render();}));
  document.querySelector('#stock-search')?.addEventListener('input',(e)=>{state.stock.search=e.target.value;renderPreservingFocus('stock-search',state.stock.search.length);});
  document.querySelectorAll('[data-stock-sheet]').forEach((el)=>el.addEventListener('input',(event)=>{const {stockSheet,stockRow,stockField}=event.target.dataset;state.stock.values[stockSheet][Number(stockRow)][stockField]=event.target.value;updateLiveStockStatus(event.target); }));
  document.querySelector('#stock-counted-by')?.addEventListener('input',(e)=>state.stock.countedBy=e.target.value);
  document.querySelector('#stock-session-note')?.addEventListener('input',(e)=>state.stock.sessionNote=e.target.value);
  document.querySelector('#submit-stock')?.addEventListener('click',submitStock);
  document.querySelector('#stock-whatsapp')?.addEventListener('click',openStockWhatsApp);
}

function updateLiveStockStatus(input) {
  const cell=input.closest('.week-cell')||input.closest('tr'); if(!cell)return;
  const sheet=input.dataset.stockSheet,rowNo=Number(input.dataset.stockRow),section=state.stock.data.sections.find((s)=>s.sheetName===sheet),row=section.rows.find((r)=>r.row===rowNo),value=state.stock.values[sheet][rowNo]; let status='';
  if(section.type==='weekly-inventory') status=Number(value.primary||0)*row.conversion+Number(value.secondary||0)<=row.minimum?'Order':'';
  else if(sheet==='Utensil PG2'&&rowNo===9) status=Number(value.quantity||0)<=0?'No More Use':'';
  else if(sheet==='Utensil PG2'&&rowNo===36) status=Number(value.quantity||0)<=4?'Spare Item':'';
  else status=Number(value.quantity||0)<=row.minimum?'Order':'';
  const badge=cell.querySelector('.row-status'); if(badge){badge.textContent=status||'OK';badge.className=`row-status ${status?'attention':'ok'}`;}
}

async function submitStock() {
  const error=validateStock(state.stock); if(error){showToast(error,'error');return;}
  state.stock.submitting=true;state.stock.submitResult=null;render();
  try { const result=await callOperations('stock',buildStockPayload(state.stock),state.settings);state.stock.submitResult=result;showToast('Stock count saved'); }
  catch(error){showToast(error.message,'error');}
  finally{state.stock.submitting=false;render();}
}

function openStockWhatsApp() {
  const result=state.stock.submitResult;if(!result?.whatsappShareUrl)return;
  window.open(result.whatsappShareUrl,'_blank','noopener,noreferrer');
  callOperations('stock',{action:'markWhatsAppOpened',submissionId:result.submissionId,businessDate:state.stock.businessDate},state.settings).catch(()=>{});
}

function bindCash() {
  document.querySelector('#cash-date')?.addEventListener('change',(e)=>{state.cash.businessDate=e.target.value;state.cash.result=null;});
  document.querySelectorAll('[data-cash-phase]').forEach((el)=>el.addEventListener('click',()=>{state.cash.phase=el.dataset.cashPhase;state.cash.result=null;render();}));
  document.querySelectorAll('[data-cash-scope]').forEach((el)=>el.addEventListener('input',(e)=>{state.cash[e.target.dataset.cashScope][e.target.dataset.denomination]=e.target.value;renderCashTotalsOnly();}));
  document.querySelectorAll('[data-cash-other]').forEach((el)=>el.addEventListener('input',(e)=>{state.cash[`${e.target.dataset.cashOther}Other`]=e.target.value;renderCashTotalsOnly();}));
  document.querySelector('#cash-counted-by')?.addEventListener('input',(e)=>state.cash.countedBy=e.target.value);
  document.querySelector('#cash-from-staff')?.addEventListener('input',(e)=>state.cash.fromStaff=e.target.value);
  document.querySelector('#cash-to-staff')?.addEventListener('input',(e)=>state.cash.toStaff=e.target.value);
  document.querySelector('#cash-remark')?.addEventListener('input',(e)=>state.cash.remark=e.target.value);
  document.querySelector('#submit-cash')?.addEventListener('click',submitCash);
}

function renderCashTotalsOnly(){const active=document.activeElement;const info=active&&{scope:active.dataset.cashScope,denom:active.dataset.denomination,other:active.dataset.cashOther,pos:active.selectionStart};render();let next;if(info?.scope)next=document.querySelector(`[data-cash-scope="${info.scope}"][data-denomination="${info.denom}"]`);else if(info?.other)next=document.querySelector(`[data-cash-other="${info.other}"]`);next?.focus();try{next?.setSelectionRange(info.pos,info.pos);}catch{}}

async function submitCash() {
  if(!state.settings.cashCountGasUrl){showToast('Configure the Cash GAS URL first.','error');return;}
  if(!state.outlet){showToast('Open Stock Count once so the outlet can be identified.','error');return;}
  if(state.cash.phase==='handover'){
    if(!state.cash.fromStaff.trim()||!state.cash.toStaff.trim()){showToast('Enter both staff names.','error');return;}
    const variance=cashTotal(state.cash.incoming,state.cash.incomingOther)-cashTotal(state.cash.outgoing,state.cash.outgoingOther);
    if(Math.abs(variance)>0.009&&!state.cash.remark.trim()){showToast('A remark is required when handover variance is not zero.','error');return;}
  } else if(!state.cash.countedBy.trim()){showToast('Enter the staff name.','error');return;}
  state.cash.submitting=true;state.cash.result=null;render();
  try { const payload=buildCashPayload(state.cash,state.outlet);const result=await callOperations('cash',payload,state.settings);result.phase=state.cash.phase;result.displayTotal=state.cash.phase==='handover'?payload.incomingTotal:payload.countedTotal;if(!result.whatsappShareUrl)result.whatsappShareUrl=buildCashWhatsapp(result,payload);state.cash.result=result;showToast('Cash count saved'); }
  catch(error){showToast(error.message,'error');}
  finally{state.cash.submitting=false;render();}
}

function buildCashWhatsapp(result,payload){const total=payload.phase==='handover'?`Outgoing RM ${payload.outgoingTotal.toFixed(2)} / Incoming RM ${payload.incomingTotal.toFixed(2)}`:`RM ${payload.countedTotal.toFixed(2)}`;const message=[`💵 *CASH COUNT SUBMITTED*`,'',`*Outlet:* ${payload.outlet}`,`*Date:* ${payload.businessDate}`,`*Phase:* ${payload.phase}`,`*Amount:* ${total}`,payload.remark?`*Note:* ${payload.remark}`:'',result.spreadsheetUrl?`*Sheet:* ${result.spreadsheetUrl}`:''].filter(Boolean).join('\n');return `https://api.whatsapp.com/send?text=${encodeURIComponent(message)}`;}

function bindSettings() {
  document.querySelector('#settings-form')?.addEventListener('submit',(event)=>{
    event.preventDefault();
    const form=new FormData(event.target);
    state.settings={
      stockCountGasUrl:form.has('stockCountGasUrl')?String(form.get('stockCountGasUrl')||'').trim():state.settings.stockCountGasUrl,
      stockCountGasSecret:form.has('stockCountGasSecret')?String(form.get('stockCountGasSecret')||''):state.settings.stockCountGasSecret,
      cashCountGasUrl:form.has('cashCountGasUrl')?String(form.get('cashCountGasUrl')||'').trim():state.settings.cashCountGasUrl,
      cashCountGasSecret:form.has('cashCountGasSecret')?String(form.get('cashCountGasSecret')||''):state.settings.cashCountGasSecret
    };
    saveSettings(state.settings);showToast('Settings saved');render();
  });
  document.querySelector('#test-stock')?.addEventListener('click',async()=>{
    const form=document.querySelector('#settings-form');
    const data=new FormData(form);
    const temp={
      ...state.settings,
      stockCountGasUrl:data.has('stockCountGasUrl')?String(data.get('stockCountGasUrl')||'').trim():state.settings.stockCountGasUrl,
      stockCountGasSecret:data.has('stockCountGasSecret')?String(data.get('stockCountGasSecret')||''):state.settings.stockCountGasSecret
    };
    const result=document.querySelector('#stock-test-result');result.textContent='Testing…';result.className='connection-result loading';
    try{const response=await callOperations('stock',{action:'getBootstrap',businessDate:todayIso()},temp);result.textContent=`Connected · ${response.outlet} · Week ${response.selectedWeek}`;result.className='connection-result success';state.outlet=response.outlet;}
    catch(error){result.textContent=error.message;result.className='connection-result error';}
  });
}

function renderPreservingFocus(id,pos){render();const input=document.getElementById(id);input?.focus();input?.setSelectionRange(pos,pos);}
window.addEventListener('hashchange',()=>{state.route=location.hash.replace('#/','')||'home';render();if(state.route==='stock'&&!state.stock.data&&!state.stock.loading)loadStock();});
window.addEventListener('beforeinstallprompt',(event)=>{event.preventDefault();state.deferredPrompt=event;render();});
if('serviceWorker'in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('/sw.js').catch(()=>{}));
getSystemStatus().then((status)=>{state.systemStatus=status;render();});
render();
if(state.route==='stock')loadStock();
