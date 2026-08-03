import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  ATTENDANCE_ROSTER_POLICY,
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
assert.equal(ATTENDANCE_ROSTER_POLICY.replacement, 'soft-delete-selected-outlet-dates')

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
assert.match(mirrorSource, /processAttendanceRosterMirrorQueue/)
assert.match(sourceUpload, /drive_sync_status: 'queued'/)
assert.match(sourceUpload, /upload_blocked_roster_import: false/)
assert.doesNotMatch(rosterSource, /d1 migrations apply/i)
assert.doesNotMatch(rosterSource, /DELETE FROM ops_records/i)

console.log('ATTENDANCE_ROSTER_IMPORT_TEST_OK=true')
console.log('PARSED_SHIFT_COUNT=44')
console.log('ROSTER_DATE_COUNT=7')
console.log('D1_ATOMIC_REPLACE=true')
console.log('STABLE_SHIFT_IDS=true')
console.log('DUPLICATE_SHIFT_ROWS_REMOVED=true')
console.log('PDF_BACKUP_BLOCKS_IMPORT=false')
console.log('SHEET_RUNTIME_WRITE=false')
console.log('D1_MIGRATION_RUN=false')
console.log('PHYSICAL_ATTENDANCE_DELETE=false')
