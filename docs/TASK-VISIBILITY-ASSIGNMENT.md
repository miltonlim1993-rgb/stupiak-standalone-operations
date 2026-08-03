# Operational Task visibility and assignment policy

Last reviewed: 2026-08-03 (Asia/Kuching)

## Reported symptom

A staff device opened Daily Tasks for RR-KCH on 03/08/2026 and displayed the page controls but no task cards.

The current task bootstrap does not query Attendance or Duty Roster to decide whether a user may see tasks. It scopes the request by the outlets assigned to the user's account. Therefore being off duty is not a supported reason for hiding an outlet task.

The client historically renders only `MORNING`, `DAILY`, and `NIGHT` task groups. A task with an unknown, custom, or missing shift can exist in the response but remain invisible on the page. The empty page also did not explain whether the server returned zero tasks or the client failed to place them in a group.

## Required behavior

### Visibility

Every active account assigned to an outlet may see that outlet's operational tasks for the selected date.

Visibility does not require:

- an Attendance row;
- a Duty Roster row;
- being scheduled for the selected date;
- being the task assignee.

The bootstrap response does not remove tasks based on the viewer's assignment. It decorates every returned task with:

- `can_view`;
- `can_execute`;
- `assignment_read_only`;
- `assignment_access_state`;
- `time_access_state`;
- `assignment`;
- `visibility_scope`;
- `attendance_required_for_visibility`.

### Assignment

Assignment remains authoritative for mutation rights.

A directly assigned task may be updated by:

- the assigned user; or
- a manager/owner override.

A role-assigned task may be updated by that role or a higher role in the existing OPS role hierarchy.

An outlet member who is not eligible to execute still receives the task, but the response uses `LOCKED` for compatibility with existing APK/PWA clients. The original time-window state remains available as `time_access_state`, while `assignment_access_state` is `VIEW_ONLY`.

The backend enforces this before:

- operational task start/save/complete;
- TaskPhoto realtime mutations.

Client-side readonly state is not the security boundary.

## Shift compatibility

The response normalizes known aliases:

- opening/AM variants → `MORNING`;
- general/day variants → `DAILY`;
- closing/PM variants → `NIGHT`.

Unknown or missing shifts fall back to `DAILY`, so an existing task cannot silently disappear merely because its shift label is not one of the three hard-coded client groups. The original value is preserved as `config.schedule.source_shift_id`.

## Data safety

This change does not:

- update an existing Task assignment;
- clear `assigned_to_user_id`;
- change `assigned_to_role`;
- generate Attendance;
- read Attendance for task visibility;
- create, migrate, or alter a D1 table;
- backfill tasks;
- delete historical Task or TaskPhoto records.

Bootstrap decoration is read-only. Task and photo writes continue only when a user performs an allowed action.

## Rollback

Rollback is code-only. Reverting the Worker revision removes the audience decorator and assignment guards. No data rollback is required because this policy does not rewrite existing Task assignment or historical records.

## Verification

1. A staff account assigned to RR-KCH but absent from the selected day's roster receives the same outlet task list as an on-duty viewer.
2. A directly assigned user sees `can_execute=true`.
3. Another staff member sees the same task with `can_execute=false` and `assignment_access_state=VIEW_ONLY`.
4. The non-assignee can open and read the task in an existing client, but task start/save/complete returns `task_assignment_view_only`.
5. The non-assignee cannot add or mutate TaskPhoto records.
6. A manager can execute through the operational override.
7. An unknown shift is returned under `DAILY`, with the source shift preserved.
8. Bootstrap does not query Attendance and does not write D1.
9. No migration, backfill, assignment rewrite, or historical deletion occurs.
