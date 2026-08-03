import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import {
  ATTENDANCE_ROSTER_POLICY,
  commitAttendanceRoster,
  normalizeRosterRows,
  rosterEntityId,
} from '../../worker/src/realtime-attendance-roster.js'

const outletId = 'RR-KCH'
const dates = [
  '2026-08-02',
  '2026-08-03',
  '2026-08-04',
  '2026-08-05',
  '2026-08-06',
  '2026-08-07',
  '2026-08-08',
]
const people = [
  'ZIYU', 'CHONG YU HUA', 'DARREN', 'WAYLEN', 'LYDIA',
  'JOHN', 'GEORGE', 'ETHANA', 'VIVIAN', 'CHINLING', 'ZOE',
]
const countsByDate = [6, 6, 6, 6, 6, 7, 7]
const rows = []

for (let dayIndex = 0; dayIndex < dates.length; dayIndex += 1) {
  for (let shiftIndex = 0; shiftIndex < countsByDate[dayIndex]; shiftIndex += 1) {
    const night = shiftIndex >= 4
    const staffName = people[(dayIndex * 3 + shiftIndex) % people.length]
    const clockIn = night ? (shiftIndex % 2 ? '18:00' : '16:00') : (shiftIndex === 0 ? '10:00' : '11:00')
    const clockOut = night ? '00:00' : (shiftIndex === 3 ? '16:00' : '18:00')
    rows.push({
      staff_name: staffName,
      staff_role: shiftIndex === 0 ? 'leader' : 'staff',
      date: dates[dayIndex],
      clock_in: clockIn,
      clock_out: clockOut,
      notes: `Planned duties: ${clockIn}-${clockOut} ${night ? 'G' : 'P'}. Scheduled shift imported from weekly roster PDF.`,
      duty_summary: `${clockIn}-${clockOut} ${night ? 'G' : 'P'}`,
    })
  }
}

assert.equal(rows.length, 44, 'fixture must model the 44 parsed shifts shown in the reported failure')

const first = await normalizeRosterRows(rows, outletId)
assert.equal(first.rows.length, 44, 'all 44 valid shifts must remain')
assert.deepEqual(first.dates, dates, 'all seven roster dates must remain in order')
assert.equal(first.duplicateCount, 0)
assert.equal(new Set(first.rows.map((row) => row.id)).size, 44, 'every shift must have one stable unique Attendance ID')
assert(first.rows.every((row) => row.id.startsWith('attendance-roster-')))
assert(first.rows.every((row) => row.clock_in.length === 5 && row.clock_out.length === 5), 'times must be normalized to HH:mm')
assert(first.rows.every((row) => row.status === 'scheduled'), 'Duty Roster rows must remain distinct from clock-in/out Attendance')

const repeated = await normalizeRosterRows(rows, outletId)
assert.deepEqual(
  repeated.rows.map((row) => row.id),
  first.rows.map((row) => row.id),
  're-importing the same PDF must produce the same IDs instead of duplicate records',
)

const withDuplicate = await normalizeRosterRows([...rows, { ...rows[0] }], outletId)
assert.equal(withDuplicate.rows.length, 44, 'duplicate PDF rows must not create an extra Attendance record')
assert.equal(withDuplicate.duplicateCount, 1)

const overnight = first.rows.find((row) => row.clock_in === '16:00' && row.clock_out === '00:00')
assert(overnight, 'fixture must contain an overnight shift')
assert.equal(overnight.hours_worked, 8, '16:00 to midnight must be eight hours')

const sampleId = await rosterEntityId(outletId, rows[0])
assert.equal(sampleId, (await rosterEntityId(outletId, { ...rows[0] })), 'stable ID hashing must be deterministic')
assert.notEqual(sampleId, await rosterEntityId('SKONE-BTU', rows[0]), 'the same shift in another outlet must not collide')

await assert.rejects(
  normalizeRosterRows([{ ...rows[0], date: '03/08/2026' }], outletId),
  (error) => error?.code === 'invalid_roster_row',
)
await assert.rejects(
  normalizeRosterRows([{ ...rows[0], clock_in: '25:00' }], outletId),
  (error) => error?.code === 'invalid_roster_row',
)

assert.equal(ATTENDANCE_ROSTER_POLICY.entity, 'Attendance')
assert.equal(ATTENDANCE_ROSTER_POLICY.operation, 'roster_replace')
assert.equal(ATTENDANCE_ROSTER_POLICY.storage, 'd1')
assert.equal(ATTENDANCE_ROSTER_POLICY.replacement, 'soft-delete-selected-outlet-date-scheduled-rows')

class D1Statement {
  constructor(database, sql) {
    this.database = database
    this.sql = sql
    this.values = []
  }

  bind(...values) {
    this.values = values
    return this
  }

  first() {
    return this.database.prepare(this.sql).get(...this.values) || null
  }

  all() {
    return { results: this.database.prepare(this.sql).all(...this.values) }
  }

  run() {
    return this.database.prepare(this.sql).run(...this.values)
  }
}

function d1Adapter(database) {
  return {
    prepare(sql) {
      return new D1Statement(database, sql)
    },
    async batch(statements) {
      database.exec('BEGIN IMMEDIATE')
      try {
        const results = statements.map((statement) => statement.run())
        database.exec('COMMIT')
        return results
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    },
  }
}

function scalar(database, sql, ...values) {
  const row = database.prepare(sql).get(...values)
  return Number(Object.values(row || {})[0] || 0)
}

const sqlite = new DatabaseSync(':memory:')
sqlite.exec(`
  CREATE TABLE ops_records (
    entity TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    outlet_id TEXT NOT NULL DEFAULT '',
    business_date TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT '',
    payload_json TEXT NOT NULL DEFAULT '{}',
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT '',
    updated_by TEXT NOT NULL DEFAULT '',
    deleted_at TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (entity, entity_id)
  );
  CREATE TABLE ops_mutations (
    mutation_id TEXT PRIMARY KEY,
    outlet_id TEXT NOT NULL DEFAULT '',
    entity TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    actor_email TEXT NOT NULL DEFAULT '',
    actor_name TEXT NOT NULL DEFAULT '',
    requested_at TEXT NOT NULL DEFAULT '',
    committed_at TEXT NOT NULL DEFAULT '',
    result_json TEXT NOT NULL DEFAULT '{}'
  );
  CREATE TABLE sheet_sync_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mutation_id TEXT NOT NULL,
    entity TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    outlet_id TEXT NOT NULL DEFAULT '',
    operation TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL DEFAULT '',
    queued_at TEXT NOT NULL DEFAULT '',
    last_attempt_at TEXT NOT NULL DEFAULT '',
    synced_at TEXT NOT NULL DEFAULT '',
    last_error TEXT NOT NULL DEFAULT ''
  );
`)

const timestamp = '2026-08-03T02:00:00.000Z'
const insertRecord = sqlite.prepare(`
  INSERT INTO ops_records (
    entity, entity_id, outlet_id, business_date, status, payload_json,
    version, created_at, created_by, updated_at, updated_by, deleted_at
  ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, '')
`)
insertRecord.run(
  'Outlet', outletId, outletId, '', 'active',
  JSON.stringify({ id: outletId, name: "Stupiak's Pork Burger - Royal Richmond", status: 'active' }),
  timestamp, 'system@chefops.local', timestamp, 'system@chefops.local',
)
insertRecord.run(
  'Attendance', 'actual-attendance-preserved', outletId, dates[1], 'present',
  JSON.stringify({
    id: 'actual-attendance-preserved', outlet_id: outletId, date: dates[1],
    staff_name: 'CLOCK IN STAFF', status: 'present', clock_in: '10:05', clock_out: '',
  }),
  timestamp, 'clock@chefops.local', timestamp, 'clock@chefops.local',
)
insertRecord.run(
  'Attendance', 'old-scheduled-row', outletId, dates[1], 'scheduled',
  JSON.stringify({
    id: 'old-scheduled-row', outlet_id: outletId, date: dates[1],
    staff_name: 'OLD ROSTER STAFF', status: 'scheduled', clock_in: '09:00', clock_out: '17:00',
  }),
  timestamp, 'old-import@chefops.local', timestamp, 'old-import@chefops.local',
)

const pending = []
const queued = []
const env = {
  OPS_DB: d1Adapter(sqlite),
  SHEET_SYNC_QUEUE: {
    async send(message) {
      queued.push(message)
    },
  },
  __CHEFOPS_CTX: {
    waitUntil(promise) {
      pending.push(Promise.resolve(promise))
    },
  },
}
const actor = {
  id: 'owner-1',
  email: 'owner@example.com',
  full_name: 'Owner',
  role: 'owner',
  outlet_id: outletId,
  outlet_ids: JSON.stringify([outletId]),
}
const request = new Request('https://ops.example/api/attendance/import', {
  method: 'POST',
  headers: { 'X-ChefOps-Mutation-Id': 'roster-sql-test-1' },
})
const body = {
  mutation_id: 'roster-sql-test-1',
  batch_id: 'roster-batch-test-1',
  outlet_id: outletId,
  replace_existing: true,
  source: { file_name: 'weekly-roster.pdf' },
  rows,
}

const committed = await commitAttendanceRoster(request, env, actor, body)
await Promise.all(pending.splice(0))
assert.equal(committed.ok, true)
assert.equal(committed.storage, 'd1')
assert.equal(committed.imported, 44)
assert.equal(committed.replaced, 1, 'only the old scheduled row must be replaced')
assert.equal(committed.archived, 1)
assert.equal(
  scalar(sqlite, "SELECT COUNT(*) FROM ops_records WHERE entity = 'Attendance' AND outlet_id = ? AND status = 'scheduled' AND deleted_at = ''", outletId),
  44,
  'D1 must expose exactly the 44 active scheduled shifts after commit',
)
assert.equal(
  scalar(sqlite, "SELECT COUNT(*) FROM ops_records WHERE entity = 'Attendance' AND entity_id = 'actual-attendance-preserved' AND deleted_at = ''"),
  1,
  'non-scheduled clock-in/out Attendance must remain active',
)
assert.equal(
  scalar(sqlite, "SELECT COUNT(*) FROM ops_records WHERE entity = 'Attendance' AND entity_id = 'old-scheduled-row' AND deleted_at <> ''"),
  1,
  'the previous scheduled row must be soft-archived, not physically deleted',
)
assert.equal(scalar(sqlite, 'SELECT COUNT(*) FROM ops_mutations'), 1)
assert.equal(scalar(sqlite, 'SELECT COUNT(*) FROM sheet_sync_outbox'), 1)
assert.equal(queued.length, 1)
assert.equal(queued[0].operation, 'roster_replace')
assert.equal(queued[0].records.length, 44)

const second = await commitAttendanceRoster(
  new Request('https://ops.example/api/attendance/import', {
    method: 'POST',
    headers: { 'X-ChefOps-Mutation-Id': 'roster-sql-test-2' },
  }),
  env,
  actor,
  { ...body, mutation_id: 'roster-sql-test-2', batch_id: 'roster-batch-test-2' },
)
await Promise.all(pending.splice(0))
assert.equal(second.imported, 44)
assert.equal(second.replaced, 44)
assert.equal(second.archived, 0, 'same deterministic IDs are reactivated instead of creating extra archived rows')
assert.equal(
  scalar(sqlite, "SELECT COUNT(*) FROM ops_records WHERE entity = 'Attendance' AND outlet_id = ? AND status = 'scheduled' AND deleted_at = ''", outletId),
  44,
  're-importing the same PDF must keep 44 active scheduled shifts',
)
assert.equal(scalar(sqlite, 'SELECT COUNT(*) FROM ops_mutations'), 2)
assert.equal(scalar(sqlite, 'SELECT COUNT(*) FROM sheet_sync_outbox'), 2)

const replay = await commitAttendanceRoster(
  new Request('https://ops.example/api/attendance/import', {
    method: 'POST',
    headers: { 'X-ChefOps-Mutation-Id': 'roster-sql-test-2' },
  }),
  env,
  actor,
  { ...body, mutation_id: 'roster-sql-test-2', batch_id: 'roster-batch-test-2' },
)
assert.equal(replay.replayed, true)
assert.equal(scalar(sqlite, 'SELECT COUNT(*) FROM ops_mutations'), 2, 'idempotent replay must not add a mutation')
assert.equal(scalar(sqlite, 'SELECT COUNT(*) FROM sheet_sync_outbox'), 2, 'idempotent replay must not add an outbox job')

const entrySource = readFileSync('worker/src/entry.js', 'utf8')
const rosterSource = readFileSync('worker/src/realtime-attendance-roster.js', 'utf8')
const mirrorSource = readFileSync('worker/src/realtime-attendance-roster-mirror.js', 'utf8')
const sourceUpload = readFileSync('worker/src/realtime-attendance-roster-source.js', 'utf8')

assert(
  entrySource.indexOf('const attendanceRosterResponse = await handleRealtimeAttendanceRosterImport')
    < entrySource.indexOf('const appResponse = await app.fetch'),
  'D1 Duty Roster import must intercept the legacy Sheet handler before app.fetch',
)
assert(
  entrySource.indexOf('const rosterSourceResponse = await handleDutyRosterSourceUpload')
    < entrySource.indexOf('const appResponse = await app.fetch'),
  'Duty Roster source receipt must intercept the blocking legacy Drive upload',
)
assert.match(rosterSource, /INSERT INTO ops_records/)
assert.match(rosterSource, /UPDATE ops_records/)
assert.match(rosterSource, /INSERT INTO ops_mutations/)
assert.match(rosterSource, /INSERT INTO sheet_sync_outbox/)
assert.match(rosterSource, /await db\.batch\(statements\)/)
assert.match(rosterSource, /operation: IMPORT_OPERATION/)
assert.match(rosterSource, /status = 'scheduled'/)
assert.match(rosterSource, /status: 'scheduled'/)
assert.match(mirrorSource, /processAttendanceRosterMirrorQueue/)
assert.match(sourceUpload, /drive_sync_status: 'queued'/)
assert.match(sourceUpload, /upload_blocked_roster_import: false/)
assert.doesNotMatch(rosterSource, /d1 migrations apply/i)
assert.doesNotMatch(rosterSource, /DELETE FROM ops_records/i)

sqlite.close()

console.log('ATTENDANCE_ROSTER_IMPORT_TEST_OK=true')
console.log('PARSED_SHIFT_COUNT=44')
console.log('ROSTER_DATE_COUNT=7')
console.log('D1_SQL_TRANSACTION_EXECUTED=true')
console.log('D1_ACTIVE_SCHEDULED_ROWS=44')
console.log('D1_ATOMIC_REPLACE=true')
console.log('STABLE_SHIFT_IDS=true')
console.log('IDEMPOTENT_MUTATION_REPLAY=true')
console.log('DUPLICATE_SHIFT_ROWS_REMOVED=true')
console.log('NON_SCHEDULED_ATTENDANCE_PRESERVED=true')
console.log('PDF_BACKUP_BLOCKS_IMPORT=false')
console.log('SHEET_RUNTIME_WRITE=false')
console.log('D1_MIGRATION_RUN=false')
console.log('PHYSICAL_ATTENDANCE_DELETE=false')
