BEGIN TRANSACTION;
INSERT INTO ops_records (
entity, entity_id, outlet_id, business_date, status, payload_json,
version, created_at, created_by, updated_at, updated_by, deleted_at
) VALUES ('Attendance', 'e9b29d38-5661-4931-a428-cb4a336708ce', 'RR-KCH', '2026-08-02', 'scheduled', '{"id":"e9b29d38-5661-4931-a428-cb4a336708ce","outlet_id":"RR-KCH","created_date":"2026-07-31T04:25:25.605Z","created_by":"miltonlim1993@gmail.com","updated_date":"2026-07-31T04:25:25.605Z","updated_by":"miltonlim1993@gmail.com","deleted_at":"","version":1,"staff_name":"ZIYU","staff_role":"leader","date":"2026-08-02","clock_in":"10:00","clock_out":"18:00","status":"scheduled","hours_worked":8,"notes":"Planned duties: 10:00-11:00 OPEN; 11:00-18:00 DF. Scheduled shift imported from RR-KCH weekly duty roster."}', 1, '2026-07-31T04:25:25.605Z', 'miltonlim1993@gmail.com', '2026-07-31T04:25:25.605Z', 'miltonlim1993@gmail.com', '')
ON CONFLICT(entity, entity_id) DO UPDATE SET
outlet_id=excluded.outlet_id,
business_date=excluded.business_date,
status=excluded.status,
payload_json=excluded.payload_json,
version=CASE WHEN ops_records.version > excluded.version THEN ops_records.version ELSE excluded.version END,
updated_at=excluded.updated_at,
updated_by=excluded.updated_by,
deleted_at='';
INSERT INTO ops_records (
entity, entity_id, outlet_id, business_date, status, payload_json,
version, created_at, created_by, updated_at, updated_by, deleted_at
) VALUES ('Attendance', '3edcfb0d-44be-457f-8771-fe108cffffd0', 'RR-KCH', '2026-08-02', 'scheduled', '{"id":"3edcfb0d-44be-457f-8771-fe108cffffd0","outlet_id":"RR-KCH","created_date":"2026-07-31T04:25:25.605Z","created_by":"miltonlim1993@gmail.com","updated_date":"2026-07-31T04:25:25.605Z","updated_by":"miltonlim1993@gmail.com","deleted_at":"","version":1,"staff_name":"CHONG YU HUA","staff_role":"staff","date":"2026-08-02","clock_in":"11:00","clock_out":"18:00","status":"scheduled","hours_worked":7,"notes":"Planned duties: 11:00-18:00 P. Scheduled shift imported from RR-KCH weekly duty roster."}', 1, '2026-07-31T04:25:25.605Z', 'miltonlim1993@gmail.com', '2026-07-31T04:25:25.605Z', 'miltonlim1993@gmail.com', '')
ON CONFLICT(entity, entity_id) DO UPDATE SET
outlet_id=excluded.outlet_id,
business_date=excluded.business_date,
status=excluded.status,
payload_json=excluded.payload_json,
version=CASE WHEN ops_records.version > excluded.version THEN ops_records.version ELSE excluded.version END,
updated_at=excluded.updated_at,
updated_by=excluded.updated_by,
deleted_at='';
INSERT INTO ops_records (
entity, entity_id, outlet_id, business_date, status, payload_json,
version, created_at, created_by, updated_at, updated_by, deleted_at
) VALUES ('Attendance', '207eca34-c1f4-4d30-b2fe-ad87723b8793', 'RR-KCH', '2026-08-02', 'scheduled', '{"id":"207eca34-c1f4-4d30-b2fe-ad87723b8793","outlet_id":"RR-KCH","created_date":"2026-07-31T04:25:25.605Z","created_by":"miltonlim1993@gmail.com","updated_date":"2026-07-31T04:25:25.605Z","updated_by":"miltonlim1993@gmail.com","deleted_at":"","version":1,"staff_name":"DARREN","staff_role":"staff","date":"2026-08-02","clock_in":"11:00","clock_out":"18:00","status":"scheduled","hours_worked":7,"notes":"Planned duties: 11:00-18:00 C. Scheduled shift imported from RR-KCH weekly duty roster."}', 1, '2026-07-31T04:25:25.605Z', 'miltonlim1993@gmail.com', '2026-07-31T04:25:25.605Z', 'miltonlim1993@gmail.com', '')
ON CONFLICT(entity, entity_id) DO UPDATE SET
outlet_id=excluded.outlet_id,
business_date=excluded.business_date,
status=excluded.status,
payload_json=excluded.payload_json,
version=CASE WHEN ops_records.version > excluded.version THEN ops_records.version ELSE excluded.version END,
updated_at=excluded.updated_at,
updated_by=excluded.updated_by,
deleted_at='';
INSERT INTO ops_records (
entity, entity_id, outlet_id, business_date, status, payload_json,
version, created_at, created_by, updated_at, updated_by, deleted_at
) VALUES ('Attendance', '9d63e9df-11cd-45f9-9c99-b500aef7cbe4', 'RR-KCH', '2026-08-02', 'scheduled', '{"id":"9d63e9df-11cd-45f9-9c99-b500aef7cbe4","outlet_id":"RR-KCH","created_date":"2026-07-31T04:25:25.605Z","created_by":"miltonlim1993@gmail.com","updated_date":"2026-07-31T04:25:25.605Z","updated_by":"miltonlim1993@gmail.com","deleted_at":"","version":1,"staff_name":"WAYLEN","staff_role":"staff","date":"2026-08-02","clock_in":"11:00","clock_out":"16:00","status":"scheduled","hours_worked":5,"notes":"Planned duties: 11:00-16:00 G. Scheduled shift imported from RR-KCH weekly duty roster."}', 1, '2026-07-31T04:25:25.605Z', 'miltonlim1993@gmail.com', '2026-07-31T04:25:25.605Z', 'miltonlim1993@gmail.com', '')
ON CONFLICT(entity, entity_id) DO UPDATE SET
outlet_id=excluded.outlet_id,
business_date=excluded.business_date,
status=excluded.status,
payload_json=excluded.payload_json,
version=CASE WHEN ops_records.version > excluded.version THEN ops_records.version ELSE excluded.version END,
updated_at=excluded.updated_at,
updated_by=excluded.updated_by,
deleted_at='';
INSERT INTO ops_records (
entity, entity_id, outlet_id, business_date, status, payload_json,
version, created_at, created_by, updated_at, updated_by, deleted_at
) VALUES ('Attendance', 'ae2f3a46-b3b7-4fd1-ac40-f5729d4913a6', 'RR-KCH', '2026-08-02', 'scheduled', '{"id":"ae2f3a46-b3b7-4fd1-ac40-f5729d4913a6","outlet_id":"RR-KCH","created_date":"2026-07-31T04:25:25.605Z","created_by":"miltonlim1993@gmail.com","updated_date":"2026-07-31T04:25:25.605Z","updated_by":"miltonlim1993@gmail.com","deleted_at":"","version":1,"staff_name":"LYDIA","staff_role":"staff","date":"2026-08-02","clock_in":"16:00","clock_out":"00:00","status":"scheduled","hours_worked":8,"notes":"Planned duties: 16:00-00:00 G. Scheduled shift imported from RR-KCH weekly duty roster."}', 1, '2026-07-31T04:25:25.605Z', 'miltonlim1993@gmail.com', '2026-07-31T04:25:25.605Z', 'miltonlim1993@gmail.com', '')
ON CONFLICT(entity, entity_id) DO UPDATE SET
outlet_id=excluded.outlet_id,
business_date=excluded.business_date,
status=excluded.status,
payload_json=excluded.payload_json,
version=CASE WHEN ops_records.version > excluded.version THEN ops_records.version ELSE excluded.version END,
updated_at=excluded.updated_at,
updated_by=excluded.updated_by,
deleted_at='';
INSERT INTO ops_records (
entity, entity_id, outlet_id, business_date, status, payload_json,
version, created_at, created_by, updated_at, updated_by, deleted_at
) VALUES ('Attendance', 'e9c6f11b-be8b-401f-a4d6-5c23b7c08583', 'RR-KCH', '2026-08-02', 'scheduled', '{"id":"e9c6f11b-be8b-401f-a4d6-5c23b7c08583","outlet_id":"RR-KCH","created_date":"2026-07-31T04:25:25.605Z","created_by":"miltonlim1993@gmail.com","updated_date":"2026-07-31T04:25:25.605Z","updated_by":"miltonlim1993@gmail.com","deleted_at":"","version":1,"staff_name":"LAWRENCE","staff_role":"leader","date":"2026-08-02","clock_in":"18:00","clock_out":"00:00","status":"scheduled","hours_worked":6,"notes":"Planned duties: 18:00-00:00 DF. Scheduled shift imported from RR-KCH weekly duty roster."}', 1, '2026-07-31T04:25:25.605Z', 'miltonlim1993@gmail.com', '2026-07-31T04:25:25.605Z', 'miltonlim1993@gmail.com', '')
ON CONFLICT(entity, entity_id) DO UPDATE SET
outlet_id=excluded.outlet_id,
business_date=excluded.business_date,
status=excluded.status,
payload_json=excluded.payload_json,
version=CASE WHEN ops_records.version > excluded.version THEN ops_records.version ELSE excluded.version END,
updated_at=excluded.updated_at,
updated_by=excluded.updated_by,
deleted_at='';
INSERT INTO ops_records (
entity, entity_id, outlet_id, business_date, status, payload_json,
version, created_at, created_by, updated_at, updated_by, deleted_at
) VALUES ('Attendance', 'fc40c18b-10d6-4e8b-ac5d-1211b970513e', 'RR-KCH', '2026-08-02', 'scheduled', '{"id":"fc40c18b-10d6-4e8b-ac5d-1211b970513e","outlet_id":"RR-KCH","created_date":"2026-07-31T04:25:25.605Z","created_by":"miltonlim1993@gmail.com","updated_date":"2026-07-31T04:25:25.605Z","updated_by":"miltonlim1993@gmail.com","deleted_at":"","version":1,"staff_name":"ONG YUNG REN","staff_role":"staff","date":"2026-08-02","clock_in":"18:00","clock_out":"00:00","status":"scheduled","hours_worked":6,"notes":"Planned duties: 18:00-00:00 P. Scheduled shift imported from RR-KCH weekly duty roster."}', 1, '2026-07-31T04:25:25.605Z', 'miltonlim1993@gmail.com', '2026-07-31T04:25:25.605Z', 'miltonlim1993@gmail.com', '')
ON CONFLICT(entity, entity_id) DO UPDATE SET
outlet_id=excluded.outlet_id,
business_date=excluded.business_date,
status=excluded.status,
payload_json=excluded.payload_json,
version=CASE WHEN ops_records.version > excluded.version THEN ops_records.version ELSE excluded.version END,
updated_at=excluded.updated_at,
updated_by=excluded.updated_by,
deleted_at='';
INSERT INTO ops_records (
entity, entity_id, outlet_id, business_date, status, payload_json,
version, created_at, created_by, updated_at, updated_by, deleted_at
) VALUES ('Attendance', 'fb812581-7118-4ba9-bfdc-ff1c4ec44704', 'RR-KCH', '2026-08-02', 'scheduled', '{"id":"fb812581-7118-4ba9-bfdc-ff1c4ec44704","outlet_id":"RR-KCH","created_date":"2026-07-31T04:25:25.605Z","created_by":"miltonlim1993@gmail.com","updated_date":"2026-07-31T04:25:25.605Z","updated_by":"miltonlim1993@gmail.com","deleted_at":"","version":1,"staff_name":"TEN","staff_role":"staff","date":"2026-08-02","clock_in":"18:00","clock_out":"00:00","status":"scheduled","hours_worked":6,"notes":"Planned duties: 18:00-00:00 C. Scheduled shift imported from RR-KCH weekly duty roster."}', 1, '2026-07-31T04:25:25.605Z', 'miltonlim1993@gmail.com', '2026-07-31T04:25:25.605Z', 'miltonlim1993@gmail.com', '')
ON CONFLICT(entity, entity_id) DO UPDATE SET
outlet_id=excluded.outlet_id,
business_date=excluded.business_date,
status=excluded.status,
payload_json=excluded.payload_json,
version=CASE WHEN ops_records.version > excluded.version THEN ops_records.version ELSE excluded.version END,
updated_at=excluded.updated_at,
updated_by=excluded.updated_by,
deleted_at='';
COMMIT;