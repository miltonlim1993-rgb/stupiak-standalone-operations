const WEEKLY_SECTIONS = ['Inventory', 'Untensil PG1', 'Utensil PG2'];
const REQUIRED_SETUP_SHEETS = ['Inventory', 'Untensil PG1', 'Utensil PG2', 'Stationary'];
let schemaReady = false;

export async function handleStockD1({ context, payload, targetUrl, secret }) {
  const db = context.env.STOCK_DB;
  if (!db) return null;
  await ensureSchema(db);

  const action = String(payload.action || '');
  const outlet = stockOutlet(payload, context.env);
  const monthKey = normalizeMonth(payload.monthKey || payload.businessDate);

  if (action === 'importStockSetup') {
    const setup = normalizeSetup(payload.setup, outlet);
    await writeSetup(db, outlet, setup);
    const bootstrap = await buildBootstrapFromSetup(db, outlet, monthKey, setup, payload.businessDate);
    await writeSnapshot(db, outlet, monthKey, bootstrap, 'stock-setup-import');
    return handled({
      ok: true,
      saved: true,
      outlet,
      monthKey,
      setupUpdatedAt: setup.updatedAt,
      sheetCount: setup.sheets.length,
      itemCount: setup.sheets.reduce((sum, sheet) => sum + (sheet.rows?.length || 0), 0),
      dataSource: 'cloudflare-d1-stock-setup'
    }, 200, 0);
  }

  if (action === 'getStockSetup') {
    const setup = await readSetup(db, outlet);
    return handled({ ok: true, outlet, setup, dataSource: 'cloudflare-d1-stock-setup' }, 200, 0);
  }

  if (action === 'getBootstrap') {
    const setup = await readSetup(db, outlet);
    if (setup) {
      const bootstrap = await buildBootstrapFromSetup(db, outlet, monthKey, setup, payload.businessDate);
      await writeSnapshot(db, outlet, monthKey, bootstrap, 'stock-setup');
      return handled({ ...bootstrap, dataSource: 'cloudflare-d1-stock-setup', d1UpdatedAt: Date.now() }, 200, 10);
    }

    if (!payload.refresh) {
      const snapshot = await readSnapshot(db, outlet, monthKey);
      if (snapshot) {
        return handled({
          ...snapshot.data,
          ok: snapshot.data?.ok !== false,
          outlet: snapshot.data?.outlet || outlet,
          monthKey,
          dataSource: 'cloudflare-d1',
          d1UpdatedAt: snapshot.updatedAt
        }, 200, 15);
      }
    }

    const gasData = await callGas(targetUrl, secret, { ...payload, outlet });
    if (gasData?.ok !== false) await writeSnapshot(db, outlet, monthKey, gasData, 'google-sheet');
    return handled({ ...gasData, dataSource: 'google-sheet', monthKey }, 200, 0);
  }

  if (action === 'submitStockCount') {
    const result = await saveSubmissionToD1(db, outlet, monthKey, payload);
    return handled(result, 200, 0);
  }

  if (action === 'getStockSubmissionStatus') {
    const submissionId = String(payload.submissionId || '');
    const row = submissionId
      ? await db.prepare('SELECT submission_id, gas_sync_status, saved_at, month_key, section_name, counted_by FROM stock_submissions WHERE submission_id = ?').bind(submissionId).first()
      : null;
    if (!row) return handled({ ok: true, saved: false, submissionId }, 200, 0);
    return handled({
      ok: true,
      saved: true,
      submissionId: row.submission_id,
      monthKey: row.month_key,
      sectionName: row.section_name,
      countedBy: row.counted_by || '',
      gasSyncStatus: row.gas_sync_status,
      savedAt: row.saved_at,
      dataSource: 'cloudflare-d1'
    }, 200, 0);
  }

  if (action === 'getStockSyncStatus') {
    return handled({ ok: true, pending: [], mode: 'd1-only' }, 200, 0);
  }

  return null;
}

function handled(data, status = 200, ttl = 0) {
  return { handled: true, data, status, ttl };
}

function stockOutlet(payload, env) {
  return String(payload.outlet || payload.outletId || env.STOCK_DEFAULT_OUTLET || env.OUTLET_NAME || 'RR-KCH').trim() || 'RR-KCH';
}

function normalizeMonth(value) {
  const text = String(value || '');
  const match = /^(\d{4})-(\d{2})/.exec(text);
  if (match) return `${match[1]}-${match[2]}`;
  return new Date().toISOString().slice(0, 7);
}

async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS stock_setups (
      outlet_id TEXT PRIMARY KEY,
      setup_json TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'excel',
      updated_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS stock_snapshots (
      outlet_id TEXT NOT NULL,
      month_key TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'd1',
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (outlet_id, month_key)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS stock_submissions (
      submission_id TEXT PRIMARY KEY,
      outlet_id TEXT NOT NULL,
      month_key TEXT NOT NULL,
      section_name TEXT NOT NULL,
      counted_by TEXT,
      session_note TEXT,
      saved_at INTEGER NOT NULL,
      gas_sync_status TEXT NOT NULL DEFAULT 'd1-only'
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS stock_values (
      outlet_id TEXT NOT NULL,
      month_key TEXT NOT NULL,
      sheet_name TEXT NOT NULL,
      week_index INTEGER NOT NULL DEFAULT 0,
      source_row INTEGER NOT NULL,
      business_date TEXT,
      primary_qty REAL,
      secondary_qty REAL,
      quantity REAL,
      counted_by TEXT,
      submission_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (outlet_id, month_key, sheet_name, week_index, source_row)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS stock_sync_queue (
      submission_id TEXT PRIMARY KEY,
      outlet_id TEXT NOT NULL,
      month_key TEXT NOT NULL,
      section_name TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'disabled',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      updated_at INTEGER NOT NULL
    )`),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_stock_values_lookup ON stock_values(outlet_id, month_key, sheet_name, week_index)')
  ]);
  schemaReady = true;
}

async function readSetup(db, outlet) {
  const row = await db.prepare('SELECT setup_json, updated_at FROM stock_setups WHERE outlet_id = ?').bind(outlet).first();
  if (!row?.setup_json) return null;
  try {
    const setup = JSON.parse(row.setup_json);
    setup.updatedAt = setup.updatedAt || row.updated_at;
    return setup;
  } catch {
    return null;
  }
}

async function writeSetup(db, outlet, setup) {
  const now = Date.now();
  setup.outlet = outlet;
  setup.updatedAt = now;
  await db.prepare(`
    INSERT INTO stock_setups (outlet_id, setup_json, source, updated_at)
    VALUES (?, ?, 'excel', ?)
    ON CONFLICT(outlet_id) DO UPDATE SET
      setup_json = excluded.setup_json,
      source = excluded.source,
      updated_at = excluded.updated_at
  `).bind(outlet, JSON.stringify(setup), now).run();
}

function normalizeSetup(setup, outlet) {
  if (!setup || !Array.isArray(setup.sheets)) throw new Error('Stock setup Excel could not be parsed.');
  const allowed = new Set(REQUIRED_SETUP_SHEETS);
  const sheets = setup.sheets
    .filter((sheet) => allowed.has(String(sheet.sheetName || '')))
    .map((sheet) => ({
      sheetName: String(sheet.sheetName),
      type: sheet.type || (sheet.sheetName === 'Stationary' ? 'monthly-stationary' : sheet.sheetName === 'Inventory' ? 'weekly-inventory' : 'weekly-utensil'),
      rows: (sheet.rows || [])
        .filter((row) => String(row.item || '').trim())
        .map((row, index) => ({
          row: Number(row.row || index + 4),
          item: String(row.item || '').trim(),
          minimum: numberOrZero(row.minimum),
          unit: String(row.unit || row.primaryUnit || '').trim(),
          primaryUnit: String(row.primaryUnit || row.unit || '').trim(),
          secondaryUnit: String(row.secondaryUnit || '').trim(),
          conversion: numberOrOne(row.conversion),
          hasSecondaryQuantity: Boolean(row.hasSecondaryQuantity || row.secondaryUnit),
          active: row.active !== false
        }))
    }))
    .filter((sheet) => sheet.rows.length);

  const found = new Set(sheets.map((sheet) => sheet.sheetName));
  const missing = REQUIRED_SETUP_SHEETS.filter((name) => !found.has(name));
  if (missing.length) {
    throw new Error(`Stock setup incomplete. Missing tabs: ${missing.join(', ')}. Upload the original RR-KCH Inventory Listing workbook.`);
  }
  return {
    version: 1,
    outlet: String(setup.outlet || outlet),
    workbookName: String(setup.workbookName || 'Stock Setup'),
    importedAt: setup.importedAt || new Date().toISOString(),
    sheets,
    orderPage: Array.isArray(setup.orderPage?.values) ? setup.orderPage : { values: [] }
  };
}

async function readSnapshot(db, outlet, monthKey) {
  const row = await db.prepare('SELECT snapshot_json, updated_at FROM stock_snapshots WHERE outlet_id = ? AND month_key = ?')
    .bind(outlet, monthKey)
    .first();
  if (!row?.snapshot_json) return null;
  try {
    return { data: JSON.parse(row.snapshot_json), updatedAt: row.updated_at };
  } catch {
    return null;
  }
}

async function writeSnapshot(db, outlet, monthKey, data, source = 'd1') {
  const now = Date.now();
  await db.prepare(`
    INSERT INTO stock_snapshots (outlet_id, month_key, snapshot_json, source, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(outlet_id, month_key) DO UPDATE SET
      snapshot_json = excluded.snapshot_json,
      source = excluded.source,
      updated_at = excluded.updated_at
  `).bind(outlet, monthKey, JSON.stringify(data), source, now).run();
}

async function buildBootstrapFromSetup(db, outlet, monthKey, setup, businessDate = '') {
  const sections = setup.sheets.map((sheet) => ({
    sheetName: sheet.sheetName,
    type: sheet.type,
    rows: sheet.rows.filter((row) => row.active !== false).map((row) => buildSectionRow(sheet, row))
  }));

  const values = await db.prepare(`
    SELECT sheet_name, week_index, source_row, business_date, primary_qty, secondary_qty, quantity, counted_by
    FROM stock_values
    WHERE outlet_id = ? AND month_key = ?
  `).bind(outlet, monthKey).all();
  overlaySavedValues(sections, values.results || []);

  const latest = await db.prepare(`
    SELECT counted_by
    FROM stock_submissions
    WHERE outlet_id = ? AND month_key = ? AND counted_by IS NOT NULL AND counted_by != ''
    ORDER BY saved_at DESC
    LIMIT 1
  `).bind(outlet, monthKey).first();

  return {
    ok: true,
    outlet,
    monthKey,
    businessDate: businessDate || `${monthKey}-01`,
    countedBy: latest?.counted_by || '',
    spreadsheetName: `${outlet} Stock Count ${monthKey}`,
    spreadsheetUrl: '',
    setupUpdatedAt: setup.updatedAt || Date.now(),
    sections,
    orderPage: setup.orderPage || { values: [] },
    selectedWeek: weekIndexForDate(businessDate || `${monthKey}-01`),
    mode: 'd1-only-stock-setup'
  };
}

function buildSectionRow(sheet, row) {
  if (sheet.type === 'monthly-stationary') {
    return {
      row: row.row,
      item: row.item,
      unit: row.unit || row.primaryUnit || '',
      minimum: row.minimum,
      quantityValue: '',
      status: 'Order',
      date: '',
      countedBy: ''
    };
  }

  const weeks = [1, 2, 3, 4, 5].map((index) => {
    if (sheet.type === 'weekly-inventory') {
      return {
        index,
        primaryValue: '',
        secondaryValue: row.hasSecondaryQuantity ? '' : undefined,
        primaryUnit: row.primaryUnit || row.unit || '',
        secondaryUnit: row.hasSecondaryQuantity ? row.secondaryUnit || '' : undefined,
        status: 'Order',
        date: '',
        countedBy: ''
      };
    }
    return {
      index,
      quantityValue: '',
      unit: row.unit || row.primaryUnit || '',
      status: 'Order',
      date: '',
      countedBy: ''
    };
  });

  return {
    row: row.row,
    item: row.item,
    minimum: row.minimum,
    conversion: row.conversion || 1,
    hasSecondaryQuantity: Boolean(row.hasSecondaryQuantity),
    weeks
  };
}

function overlaySavedValues(sections, rows) {
  const sectionMap = new Map(sections.map((section) => [section.sheetName, section]));
  for (const saved of rows) {
    const section = sectionMap.get(String(saved.sheet_name));
    if (!section) continue;
    const row = (section.rows || []).find((entry) => Number(entry.row) === Number(saved.source_row));
    if (!row) continue;
    if (section.type === 'monthly-stationary' || Number(saved.week_index) === 0) {
      row.quantityValue = emptyOrNumber(saved.quantity);
      row.date = saved.business_date || '';
      row.countedBy = saved.counted_by || '';
      row.status = stockStatus(row.quantityValue, row.minimum);
      continue;
    }
    const week = (row.weeks || []).find((entry) => Number(entry.index) === Number(saved.week_index));
    if (!week) continue;
    if (section.type === 'weekly-inventory') {
      week.primaryValue = emptyOrNumber(saved.primary_qty);
      if (row.hasSecondaryQuantity) week.secondaryValue = emptyOrNumber(saved.secondary_qty);
      const total = Number(week.primaryValue || 0) * Number(row.conversion || 1) + Number(week.secondaryValue || 0);
      week.status = total <= Number(row.minimum || 0) ? 'Order' : '';
    } else {
      week.quantityValue = emptyOrNumber(saved.quantity);
      week.status = stockStatus(week.quantityValue, row.minimum);
    }
    week.date = saved.business_date || '';
    week.countedBy = saved.counted_by || '';
  }
}

async function saveSubmissionToD1(db, outlet, monthKey, payload) {
  const submissionId = String(payload.submissionId || crypto.randomUUID());
  const existing = await db.prepare('SELECT submission_id, gas_sync_status, saved_at FROM stock_submissions WHERE submission_id = ?')
    .bind(submissionId)
    .first();
  if (existing) {
    return {
      ok: true,
      saved: true,
      duplicate: true,
      submissionId,
      monthKey,
      gasSyncStatus: existing.gas_sync_status,
      savedAt: existing.saved_at,
      dataSource: 'cloudflare-d1'
    };
  }

  const now = Date.now();
  const columns = normalizeColumns(payload);
  const sectionName = String(payload.sectionName || columns[0]?.sheetName || 'Stock');
  const statements = [];

  statements.push(db.prepare(`
    INSERT INTO stock_submissions
      (submission_id, outlet_id, month_key, section_name, counted_by, session_note, saved_at, gas_sync_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'd1-only')
  `).bind(
    submissionId,
    outlet,
    monthKey,
    sectionName,
    String(payload.countedBy || ''),
    String(payload.sessionNote || ''),
    now
  ));

  for (const column of columns) {
    for (const row of column.rows) {
      statements.push(db.prepare(`
        INSERT INTO stock_values
          (outlet_id, month_key, sheet_name, week_index, source_row, business_date,
           primary_qty, secondary_qty, quantity, counted_by, submission_id, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(outlet_id, month_key, sheet_name, week_index, source_row) DO UPDATE SET
          business_date = excluded.business_date,
          primary_qty = excluded.primary_qty,
          secondary_qty = excluded.secondary_qty,
          quantity = excluded.quantity,
          counted_by = excluded.counted_by,
          submission_id = excluded.submission_id,
          updated_at = excluded.updated_at
      `).bind(
        outlet,
        monthKey,
        column.sheetName,
        column.weekIndex,
        Number(row.row || 0),
        column.businessDate,
        numberOrNull(row.primary),
        numberOrNull(row.secondary),
        numberOrNull(row.quantity),
        String(payload.countedBy || ''),
        submissionId,
        now
      ));
    }
  }

  await runBatches(db, statements, 45);
  await refreshSnapshotFromSetup(db, outlet, monthKey, payload.businessDate);

  const savedWeeks = columns
    .filter((column) => column.weekIndex > 0)
    .map((column) => ({ weekIndex: column.weekIndex, businessDate: column.businessDate, sheetName: column.sheetName }));

  return {
    ok: true,
    saved: true,
    submissionId,
    outlet,
    monthKey,
    sectionName,
    countedBy: String(payload.countedBy || ''),
    weekIndex: savedWeeks[0]?.weekIndex || '',
    savedWeeks,
    gasSyncStatus: 'd1-only',
    orderCount: 0,
    spreadsheetName: `${outlet} Stock Count ${monthKey}`,
    spreadsheetUrl: '',
    dataSource: 'cloudflare-d1',
    savedAt: now
  };
}

async function refreshSnapshotFromSetup(db, outlet, monthKey, businessDate = '') {
  const setup = await readSetup(db, outlet);
  if (!setup) return;
  const data = await buildBootstrapFromSetup(db, outlet, monthKey, setup, businessDate);
  await writeSnapshot(db, outlet, monthKey, data, 'd1-write-through');
}

function normalizeColumns(payload) {
  if (Array.isArray(payload.weekColumns) && payload.weekColumns.length) {
    return payload.weekColumns.map((column) => {
      const sheetName = String(column.sheetName || payload.sectionName || Object.keys(column.sections || {})[0] || 'Inventory');
      return {
        sheetName,
        weekIndex: Number(column.weekIndex || 0),
        businessDate: String(column.businessDate || payload.businessDate || ''),
        rows: Array.isArray(column.sections?.[sheetName]) ? column.sections[sheetName] : []
      };
    });
  }

  return Object.entries(payload.sections || {}).map(([sheetName, rows]) => ({
    sheetName,
    weekIndex: sheetName === 'Stationary' ? 0 : Number(payload.selectedWeek || 0),
    businessDate: String(payload.businessDate || ''),
    rows: Array.isArray(rows) ? rows : []
  }));
}

async function callGas(targetUrl, secret, payload) {
  if (!targetUrl || !secret) throw new Error('Stock GAS mirror is not configured. Import a Stock Setup Excel file to D1, or configure Stock GAS.');
  const response = await fetch(targetUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ ...payload, secret }),
    redirect: 'follow'
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error(`Stock GAS returned an unreadable response (${response.status}).`); }
  if (!response.ok || data?.ok === false) throw new Error(data?.error || `Stock GAS request failed (${response.status}).`);
  return data;
}

async function runBatches(db, statements, size) {
  for (let index = 0; index < statements.length; index += size) {
    await db.batch(statements.slice(index, index + size));
  }
}

function numberOrNull(value) {
  if (value === '' || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function emptyOrNumber(value) {
  if (value === '' || value === null || value === undefined) return '';
  const number = Number(value);
  return Number.isFinite(number) ? number : '';
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function numberOrOne(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 1;
}

function stockStatus(value, minimum) {
  return Number(value || 0) <= Number(minimum || 0) ? 'Order' : '';
}

function weekIndexForDate(value) {
  const text = String(value || '');
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (!match) return 1;
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00`);
  const monthStart = new Date(date.getFullYear(), date.getMonth(), 1);
  const offset = (monthStart.getDay() + 6) % 7;
  const gridStart = new Date(monthStart.getFullYear(), monthStart.getMonth(), monthStart.getDate() - offset);
  return Math.max(1, Math.min(5, Math.floor((date.getTime() - gridStart.getTime()) / (7 * 24 * 60 * 60 * 1000)) + 1));
}
