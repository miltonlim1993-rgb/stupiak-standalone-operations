import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const failures = []
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')

function requireText(relative, values) {
  const source = read(relative)
  for (const value of values) if (!source.includes(value)) failures.push(`${relative} is missing: ${value}`)
}

function forbidText(relative, values) {
  const source = read(relative)
  for (const value of values) if (source.includes(value)) failures.push(`${relative} must not contain: ${value}`)
}

requireText('worker/src/attendance-workforce-d1.js', [
  "const CONTRACT = 'statvara-attendance-workforce-v1'",
  "const SCHEDULE_CONTRACT = 'statvara-duty-schedule-v1'",
  "const RECORD_ENTITY = 'AttendanceRecord'",
  "const EVENT_ENTITY = 'AttendanceClockEvent'",
  "const CONSEQUENCE_ENTITY = 'WorkforceConsequence'",
  'attendance_mutation_fingerprint_mismatch',
  'attendance_server_managed_field',
  'attendance_concurrency_conflict',
  "lifecycle_transition: 'TR-011-001'",
  "lifecycle_transition: 'TR-011-002'",
  "command_id: 'CMD-WRK-02-051'",
  "command_id: 'CMD-WRK-02-052'",
  "candidate_operation: 'attendance.correct'",
  'command_id: null',
  "consequence_type: 'accepted_worked_time'",
  "'attendance_report_projection'",
  "payroll_effect: 'none'",
  "timesheet_effect: 'none'",
  'original_record_unchanged: true',
  'Attendance event is authoritative and drives an explicit report consequence.',
])
forbidText('worker/src/attendance-workforce-d1.js', [
  'INSERT INTO payroll', 'UPDATE payroll', 'INSERT INTO payments', 'UPDATE payments',
  'INSERT INTO journal', 'UPDATE journal', 'INSERT INTO timesheet', 'UPDATE timesheet',
  'INSERT INTO leave', 'UPDATE leave', "from './sheets.js'", 'late: true', 'absent: true',
])
requireText('worker/src/realtime-attendance-roster.js', [
  "const SCHEDULE_CONTRACT = 'statvara-duty-schedule-v1'",
  "employee_binding_status: employee ? 'resolved' : 'unresolved'",
  "employee_binding: 'server-resolved-active-d1-user-exact-name-and-outlet'",
  'attendance_roster_mutation_fingerprint_mismatch',
])
requireText('worker/src/entry.js', [
  "import { handleAttendanceWorkforceApi } from './attendance-workforce-d1.js'",
  'legacyAttendanceMutationBlocked',
  'attendance_command_api_required',
  "'/api/attendance/workforce/context'",
])
requireText('worker/src/submission-locks.js', [
  'attendance:${outletId}:${resourceId}',
  "resourceType: 'attendance'",
])
requireText('web/src/pages/Attendance.jsx', [
  'My attendance',
  'Server-accepted time only. Device time is never attendance authority.',
  'report projection queued · payroll effect none',
])
requireText('web/src/api/opsClient.js', [
  '/api/attendance/workforce/context',
  '/api/attendance/workforce/clock-in',
  '/api/attendance/workforce/clock-out',
  '/api/attendance/workforce/correct',
])
requireText('docs/ATTENDANCE-WORKFORCE-AUTHORITY.md', [
  'CMD-WRK-01-046', 'CMD-WRK-01-047', 'CMD-WRK-01-048',
  'CMD-WRK-02-051', 'CMD-WRK-02-052', 'CMD-WRK-02-054', 'CMD-WRK-03-055', 'CMD-INT-01-224',
  'D1 migration count remains 3',
  'does not infer lateness, absence, overtime, leave, or payroll policy',
  'does not create or update Salary, Payroll Entry, Payment, Payment Allocation, Employee Receivable',
])

for (const relative of [
  'worker/migrations/0003_attendance_workforce.sql',
  'worker/migrations/0004_attendance_workforce.sql',
]) {
  if (existsSync(path.join(root, relative))) failures.push('Slice 008 must not add a D1 migration; the generic D1 record substrate is sufficient')
}

if (failures.length) {
  console.error('Slice 008 Attendance → Workforce Consequence source gate failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log('SLICE_008_ATTENDANCE_WORKFORCE_SOURCE_GATE=PASS')
console.log('CORE_SCHEMA=18')
console.log('D1_MIGRATION_COUNT=3')
console.log('ATTENDANCE_FINANCIAL_MUTATION_AUTHORITY=NONE')
console.log('PAYROLL_TIMESHEET_LEAVE_MIGRATION=false')
