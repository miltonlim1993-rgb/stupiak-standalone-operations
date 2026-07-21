const WEEKLY_SECTIONS = ['Inventory', 'Untensil PG1', 'Utensil PG2'];
let schemaReady = false;

export async function handleStockD1({ context, payload, targetUrl, secret }) {
  const db = context.env.STOCK_DB;
  if (!db) return null;
  await ensureSchema(db);

  const action = String(payload.action || '');
  const outlet = stockOutlet(payload, context.env);
  const monthKey = normalizeMonth(payload.monthKey || payload.businessDate);

  if (action === 'getBootstrap') {
    context.waitUntil(retryPendingGasSyncs(db, targetUrl, secret, 2));
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
    context.waitUntil(syncSubmissionToGas(db, targetUrl, secret, { ...payload, outlet }));
    return handled(result, 200, 0);
  }

  if (action === 'getStockSubmissionStatus') {
    const submissionId = String(payload.submissionId || '');
    const row = submissionId
      ? await db.prepare('SELECT submission_id, gas_sync_status, saved_at, month_key, section_name FROM stock_submissions WHERE submission_id = ?').bind(submissionId).first()
      : null;
    if (!row) return handled({ ok: true, saved: false, submissionId }, 200, 0);
    return handled({
      ok: true,
      saved: true,
      submissionId: row.submission_id,
      monthKey: row.month_key,
      sectionName: row.section_name,
      gasSyncStatus: row.gas_sync_status,
      savedAt: row.saved_at,
      dataSource: 'cloudflare-d1'
    }, 200, 0);
  }

  if (action === 'getStockSyncStatus') {
    const rows = await db.prepare(`
      SELECT submission_id, outlet_id, month_key, section_name, status, attempts, last_error, updated_at
      FROM stock_sync_queue
      WHERE status <> 'synced'
      ORDER BY updated_at ASC
      LIMIT 50
    `).all();
    return handled({ ok: true, pending: rows.results || [] }, 200, 0);
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
      gas_sync_status TEXT NOT NULL DEFAULT 'pending'
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
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      updated_at INTEGER NOT NULL
    )`),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_stock_values_lookup ON stock_values(outlet_id, month_key, sheet_name, week_index)'),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_stock_sync_pending ON stock_sync_queue(status, updated_at)')
  ]);
  schemaReady = true;
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
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
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

  statements.push(db.prepare(`
    INSERT INTO stock_sync_queue
      (submission_id, outlet_id, month_key, section_name, payload_json, status, attempts, updated_at)
    VALUES (?, ?, ?, ?, ?, 'pending', 0, ?)
    ON CONFLICT(submission_id) DO UPDATE SET
      payload_json = excluded.payload_json,
      status = 'pending',
      updated_at = excluded.updated_at
  `).bind(submissionId, outlet, monthKey, sectionName, JSON.stringify({ ...payload, outlet }), now));

  await runBatches(db, statements, 45);
  await updateSnapshotFromSubmission(db, outlet, monthKey, columns);

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
    weekIndex: savedWeeks[0]?.weekIndex || '',
    savedWeeks,
    gasSyncStatus: 'pending',
    dataSource: 'cloudflare-d1',
    savedAt: now
  };
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

async function updateSnapshotFromSubmission(db, outlet, monthKey, columns) {
  const snapshot = await readSnapshot(db, outlet, monthKey);
  if (!snapshot?.data) return;
  const data = snapshot.data;
  const sectionMap = new Map((data.sections || []).map((section) => [String(section.sheetName), section]));

  for (const column of columns) {
    const section = sectionMap.get(column.sheetName);
    if (!section) continue;
    const rowMap = new Map((section.rows || []).map((row) => [Number(row.row), row]));
    for (const input of column.rows) {
      const row = rowMap.get(Number(input.row));
      if (!row) continue;
      if (column.sheetName === 'Stationary' || column.weekIndex === 0) {
        row.quantityValue = emptyOrNumber(input.quantity);
        row.date = column.businessDate;
        continue;
      }
      const week = (row.weeks || []).find((entry) => Number(entry.index) === Number(column.weekIndex));
      if (!week) continue;
      if (input.primary !== undefined) week.primaryValue = emptyOrNumber(input.primary);
      if (input.secondary !== undefined) week.secondaryValue = emptyOrNumber(input.secondary);
      if (input.quantity !== undefined) week.quantityValue = emptyOrNumber(input.quantity);
      week.date = column.businessDate;
    }
  }

  data.monthKey = monthKey;
  data.d1UpdatedAt = Date.now();
  await writeSnapshot(db, outlet, monthKey, data, 'd1-write-through');
}

async function syncSubmissionToGas(db, targetUrl, secret, payload) {
  const submissionId = String(payload.submissionId || '');
  if (!submissionId) return;
  if (!targetUrl || !secret) {
    await markSyncError(db, submissionId, 'Stock GAS mirror is not configured.');
    return;
  }

  try {
    const data = await callGas(targetUrl, secret, payload);
    if (!data?.ok || !data?.saved) throw new Error(data?.error || 'Google Sheet did not confirm save.');
    await db.batch([
      db.prepare("UPDATE stock_sync_queue SET status = 'synced', attempts = attempts + 1, last_error = NULL, updated_at = ? WHERE submission_id = ?")
        .bind(Date.now(), submissionId),
      db.prepare("UPDATE stock_submissions SET gas_sync_status = 'synced' WHERE submission_id = ?")
        .bind(submissionId)
    ]);
  } catch (error) {
    await markSyncError(db, submissionId, String(error?.message || error));
  }
}

async function retryPendingGasSyncs(db, targetUrl, secret, limit = 2) {
  if (!targetUrl || !secret) return;
  const pending = await db.prepare(`
    SELECT payload_json
    FROM stock_sync_queue
    WHERE status IN ('pending', 'failed') AND attempts < 10
    ORDER BY updated_at ASC
    LIMIT ?
  `).bind(limit).all();

  for (const row of pending.results || []) {
    try {
      await syncSubmissionToGas(db, targetUrl, secret, JSON.parse(row.payload_json));
    } catch {}
  }
}

async function markSyncError(db, submissionId, message) {
  await db.batch([
    db.prepare("UPDATE stock_sync_queue SET status = 'failed', attempts = attempts + 1, last_error = ?, updated_at = ? WHERE submission_id = ?")
      .bind(message.slice(0, 1000), Date.now(), submissionId),
    db.prepare("UPDATE stock_submissions SET gas_sync_status = 'failed' WHERE submission_id = ?")
      .bind(submissionId)
  ]);
}

async function callGas(targetUrl, secret, payload) {
  if (!targetUrl || !secret) throw new Error('Stock GAS mirror is not configured.');
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
