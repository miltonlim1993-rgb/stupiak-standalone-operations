# Attendance → Workforce Consequence Authority

Slice 008 migrates only the LOOP-021 attendance-to-workforce-consequence record family. It does not migrate Payroll, Timesheet, Leave, recruitment, onboarding, disciplinary workflows, or biometric devices. D1 migration count remains 3 because the accepted `ops_records`, `ops_mutations`, and `sheet_sync_outbox` substrate already represents the required records.

## Causal chain

`WRK-DUTY-SCHEDULE` (`Attendance`, contract `statvara-duty-schedule-v1`)
→ `WRK-CLOCK-EVENT` (`AttendanceClockEvent`)
→ `WRK-ATTENDANCE-RECORD` (`AttendanceRecord`)
→ explicit worked-time `WorkforceConsequence`
→ source-labelled `attendance_report_projection` outbox handoff.

The participating frozen commands are:

- `CMD-WRK-01-046`, `CMD-WRK-01-047`, `CMD-WRK-01-048`: existing schedule creation, assignment, and publication controls represented by the protected roster import boundary.
- `CMD-WRK-02-051`: self clock-in, `Scheduled → Clocked in` (`TR-011-001`).
- `CMD-WRK-02-052`: self clock-out, `Clocked in → Completed` (`TR-011-002`).
- `CMD-WRK-02-054`: the frozen Scheduled → Archived transition (`TR-011-003`). It is not reinterpreted as a correction command; retained Frappe use remains legacy for unmigrated records.
- `CMD-WRK-03-055` and `CMD-INT-01-224`: retained downstream/reporting consumers. They receive durable source identity; they do not become attendance authority.

The essential protected correction operation is introduced narrowly as candidate operation `attendance.correct`; it has no fabricated Phase 1 Command ID. No new historical command ID is invented.

## Authority and lifecycle

The current active D1 `User` is employee identity authority at command acceptance. A published roster row becomes a usable schedule expectation only when the trusted import runtime resolves exactly one active human D1 user with the same canonical full name and assigned outlet. Ambiguous and unresolved names remain visible roster facts but cannot authorize clock events.

The client supplies only the selected schedule or attendance resource plus a stable mutation ID. Employee identity, event timestamps, lifecycle status, worked duration, and consequence are server managed. Device timestamps and offline drafts have no attendance authority. Current user status, capability, principal type, and exact assigned outlet are re-read from D1 when a command reaches the server.

Clock-in captures an immutable schedule snapshot containing schedule ID, schedule version, outlet, business date, local expected times, timezone, and source lineage. Later roster changes do not rewrite accepted history. Clock-out uses trusted server instants and derives integer worked seconds. It deliberately does not infer lateness, absence, overtime, leave, or payroll policy because those rules are not proven in the frozen LOOP-021 baseline.

Normal worked-time completion does not require a second human decision. A disputed finalized result uses the protected correction command: the original record stays byte-identical, the replacement names the original and prior replacement, the correcting human and reason are recorded, and a new consequence supersedes the prior reporting consequence.

## Protected handoff and boundaries

Completion atomically creates a durable `WorkforceConsequence` and `sheet_sync_outbox` intent. The handoff includes attendance record ID/version, schedule ID/version, employee ID, outlet, business date, consequence type, and worked seconds. Delivery can retry independently; a UI or report is not completion authority.

Attendance financial mutation authority is `none`. The attendance path does not create or update Salary, Payroll Entry, Payment, Payment Allocation, Employee Receivable, Supplier Invoice, GL/Journal Entry, Timesheet, or Leave records. Payroll remains a separately authorized legacy downstream process. Timesheet and reports may consume a source-labelled consequence, but neither becomes attendance authority by implication.

Generic mutating `/api/entities/Attendance*` and `/api/entities/WorkforceConsequence` routes are blocked for the migrated family. Unmigrated Frappe HR records are not globally removed. The protected D1 records accept writes only through the command-specific API.

## Completion fact

The exact candidate completion fact is:

> Attendance event is authoritative and drives an explicit report consequence.

An attendance row existing, or an employee merely clocking in, is not closure. Closure requires completed accepted attendance, its derived consequence, and the durable protected handoff identity.
