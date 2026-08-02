-- Generated from Stupiak's Ops Master on 2026-08-02.
-- Exact one-time User and Outlet directory snapshot for D1.

INSERT INTO ops_records (
  entity, entity_id, outlet_id, business_date, status, payload_json,
  version, created_at, created_by, updated_at, updated_by, deleted_at
) VALUES (
  'User', '1be26369-e731-4d50-bcfb-e64a4f81f330', 'RR-KCH', '', 'active', '{"id":"1be26369-e731-4d50-bcfb-e64a4f81f330","outlet_id":"RR-KCH","created_date":"2026-07-23T08:53:59.642Z","created_by":"miltonlim1993@gmail.com","updated_date":"2026-08-01T05:26:49.513Z","updated_by":"miltonlim1993@gmail.com","deleted_at":"","version":39,"google_sub":"118442267038129935739","email":"miltonlim1993@gmail.com","full_name":"Milton","avatar_url":"https://lh3.googleusercontent.com/a/ACg8ocLPeAv15qez0sJs0Hb2Vsh4ojH1UkljD_pUIxjvD7Ha4hkQEQ=s96-c","role":"owner","phone":"+60168583338","department":"Operations","status":"active","last_login_at":"2026-08-01T05:26:49.513Z","outlet_ids":"[\"RR-KCH\",\"SKONE-BTU\",\"CK-WAREHOUSE\",\"PS-KCH\"]","name_confirmed":true,"name_confirmed_at":"2026-07-25T13:54:25.855Z","name_updated_at":"2026-07-25T13:54:25.855Z"}',
  39, '2026-07-23T08:53:59.642Z', 'miltonlim1993@gmail.com',
  '2026-08-01T05:26:49.513Z', 'miltonlim1993@gmail.com', ''
)
ON CONFLICT(entity, entity_id) DO UPDATE SET
  outlet_id = excluded.outlet_id,
  status = excluded.status,
  payload_json = excluded.payload_json,
  version = excluded.version,
  updated_at = excluded.updated_at,
  updated_by = excluded.updated_by,
  deleted_at = excluded.deleted_at;

INSERT INTO ops_records (
  entity, entity_id, outlet_id, business_date, status, payload_json,
  version, created_at, created_by, updated_at, updated_by, deleted_at
) VALUES (
  'User', '1206ccd9-11a0-454e-8aa9-0fff72e1e697', 'RR-KCH', '', 'active', '{"id":"1206ccd9-11a0-454e-8aa9-0fff72e1e697","outlet_id":"RR-KCH","created_date":"2026-07-24T02:52:35.861Z","created_by":"spbapiconnect@gmail.com","updated_date":"2026-07-30T10:23:56.982Z","updated_by":"spbapiconnect@gmail.com","deleted_at":"","version":16,"google_sub":"105022525691816531040","email":"spbapiconnect@gmail.com","full_name":"SPB API","avatar_url":"https://lh3.googleusercontent.com/a/ACg8ocJp02uA2oz4QgKLrG6xEFx4exKvfXUngDtTv24KMFhBj1MMTw=s96-c","role":"staff","phone":"","department":"Operations","status":"active","last_login_at":"2026-07-30T10:22:16.756Z","outlet_ids":"RR-KCH,SKONE-BTU,CK-WAREHOUSE,PS-KCH","name_confirmed":true,"name_confirmed_at":"2026-07-30T10:23:56.982Z","name_updated_at":"2026-07-30T10:23:56.982Z"}',
  16, '2026-07-24T02:52:35.861Z', 'spbapiconnect@gmail.com',
  '2026-07-30T10:23:56.982Z', 'spbapiconnect@gmail.com', ''
)
ON CONFLICT(entity, entity_id) DO UPDATE SET
  outlet_id = excluded.outlet_id,
  status = excluded.status,
  payload_json = excluded.payload_json,
  version = excluded.version,
  updated_at = excluded.updated_at,
  updated_by = excluded.updated_by,
  deleted_at = excluded.deleted_at;

INSERT INTO ops_records (
  entity, entity_id, outlet_id, business_date, status, payload_json,
  version, created_at, created_by, updated_at, updated_by, deleted_at
) VALUES (
  'User', '8bd6bb48-7b35-4a16-89b1-eebd580e20f2', 'RR-KCH', '', 'active', '{"id":"8bd6bb48-7b35-4a16-89b1-eebd580e20f2","outlet_id":"RR-KCH","created_date":"2026-07-24T04:34:49.128Z","created_by":"sporkburger19@gmail.com","updated_date":"2026-08-02T02:38:35.519Z","updated_by":"miltonlim1993@gmail.com","deleted_at":"","version":33,"google_sub":"100357215514820799304","email":"sporkburger19@gmail.com","full_name":"Stupiak Pork Burger","avatar_url":"https://lh3.googleusercontent.com/a/ACg8ocJJRCXjQy8Kyk2zPbOZpLlEwLz0Si4YalF1oasZF6rrtZ8H6oc=s96-c","role":"owner","phone":"","department":"","status":"active","last_login_at":"2026-08-01T09:10:29.666Z","outlet_ids":"[\"RR-KCH\"]","name_confirmed":true,"name_confirmed_at":"2026-07-25T14:07:25.199Z","name_updated_at":"2026-07-25T14:07:25.199Z"}',
  33, '2026-07-24T04:34:49.128Z', 'sporkburger19@gmail.com',
  '2026-08-02T02:38:35.519Z', 'miltonlim1993@gmail.com', ''
)
ON CONFLICT(entity, entity_id) DO UPDATE SET
  outlet_id = excluded.outlet_id,
  status = excluded.status,
  payload_json = excluded.payload_json,
  version = excluded.version,
  updated_at = excluded.updated_at,
  updated_by = excluded.updated_by,
  deleted_at = excluded.deleted_at;

INSERT INTO ops_records (
  entity, entity_id, outlet_id, business_date, status, payload_json,
  version, created_at, created_by, updated_at, updated_by, deleted_at
) VALUES (
  'User', 'b67c88ee-4d8d-4f43-8314-3b28a98f2ba4', 'RR-KCH', '', 'active', '{"id":"b67c88ee-4d8d-4f43-8314-3b28a98f2ba4","outlet_id":"RR-KCH","created_date":"2026-07-26T06:17:48.170Z","created_by":"xuanxi04@gmail.com","updated_date":"2026-08-02T02:38:42.268Z","updated_by":"miltonlim1993@gmail.com","deleted_at":"","version":5,"google_sub":"106743005719874615855","email":"xuanxi04@gmail.com","full_name":"Lawrence","avatar_url":"https://lh3.googleusercontent.com/a/ACg8ocIDFgPAzHMo7MXlLZNXrxDgBhVh1QorKWTYHB77rv-f8PFNrg=s96-c","role":"owner","phone":"","department":"","status":"active","last_login_at":"2026-07-26T06:18:28.666Z","outlet_ids":"[\"RR-KCH\"]","name_confirmed":true,"name_confirmed_at":"2026-07-26T06:18:35.889Z","name_updated_at":"2026-07-26T06:18:35.889Z"}',
  5, '2026-07-26T06:17:48.170Z', 'xuanxi04@gmail.com',
  '2026-08-02T02:38:42.268Z', 'miltonlim1993@gmail.com', ''
)
ON CONFLICT(entity, entity_id) DO UPDATE SET
  outlet_id = excluded.outlet_id,
  status = excluded.status,
  payload_json = excluded.payload_json,
  version = excluded.version,
  updated_at = excluded.updated_at,
  updated_by = excluded.updated_by,
  deleted_at = excluded.deleted_at;

INSERT INTO ops_records (
  entity, entity_id, outlet_id, business_date, status, payload_json,
  version, created_at, created_by, updated_at, updated_by, deleted_at
) VALUES (
  'User', '3bc13815-cd2c-47c4-8052-31dcadf0f901', 'RR-KCH', '', 'active', '{"id":"3bc13815-cd2c-47c4-8052-31dcadf0f901","outlet_id":"RR-KCH","created_date":"2026-07-28T08:57:42.700Z","created_by":"waylenyeo08@gmail.com","updated_date":"2026-08-02T02:41:20.047Z","updated_by":"waylenyeo08@gmail.com","deleted_at":"","version":5,"google_sub":"108836893947254388078","email":"waylenyeo08@gmail.com","full_name":"Waylen Yeo","avatar_url":"https://lh3.googleusercontent.com/a/ACg8ocKMtdwCySY3M65FRzoMkP8W9LXIGD0mTk04PVGj4U2bWC7TGVaN=s96-c","role":"staff","phone":"","department":"","status":"active","last_login_at":"2026-08-02T02:41:20.047Z","outlet_ids":"RR-KCH","name_confirmed":true,"name_confirmed_at":"2026-07-28T09:10:07.508Z","name_updated_at":"2026-07-28T09:10:07.508Z"}',
  5, '2026-07-28T08:57:42.700Z', 'waylenyeo08@gmail.com',
  '2026-08-02T02:41:20.047Z', 'waylenyeo08@gmail.com', ''
)
ON CONFLICT(entity, entity_id) DO UPDATE SET
  outlet_id = excluded.outlet_id,
  status = excluded.status,
  payload_json = excluded.payload_json,
  version = excluded.version,
  updated_at = excluded.updated_at,
  updated_by = excluded.updated_by,
  deleted_at = excluded.deleted_at;

INSERT INTO ops_records (
  entity, entity_id, outlet_id, business_date, status, payload_json,
  version, created_at, created_by, updated_at, updated_by, deleted_at
) VALUES (
  'User', 'a6e58a50-712f-4595-8bb6-f83b88e30e84', 'RR-KCH', '', 'active', '{"id":"a6e58a50-712f-4595-8bb6-f83b88e30e84","outlet_id":"RR-KCH","created_date":"2026-07-28T09:02:57.554Z","created_by":"linzy20050503@gmail.com","updated_date":"2026-08-02T02:45:42.287Z","updated_by":"linzy20050503@gmail.com","deleted_at":"","version":13,"google_sub":"117109100902742009799","email":"linzy20050503@gmail.com","full_name":"ZiYu","avatar_url":"https://lh3.googleusercontent.com/a/ACg8ocK3Gl3qPc8r9k6z3QXRMsGXU_KRmFe40_GoLKHxhrdgcScyZ5mj=s96-c","role":"owner","phone":"","department":"","status":"active","last_login_at":"2026-08-02T02:45:42.287Z","outlet_ids":"[\"RR-KCH\"]","name_confirmed":true,"name_confirmed_at":"2026-07-28T09:25:42.951Z","name_updated_at":"2026-07-28T09:25:42.951Z"}',
  13, '2026-07-28T09:02:57.554Z', 'linzy20050503@gmail.com',
  '2026-08-02T02:45:42.287Z', 'linzy20050503@gmail.com', ''
)
ON CONFLICT(entity, entity_id) DO UPDATE SET
  outlet_id = excluded.outlet_id,
  status = excluded.status,
  payload_json = excluded.payload_json,
  version = excluded.version,
  updated_at = excluded.updated_at,
  updated_by = excluded.updated_by,
  deleted_at = excluded.deleted_at;

INSERT INTO ops_records (
  entity, entity_id, outlet_id, business_date, status, payload_json,
  version, created_at, created_by, updated_at, updated_by, deleted_at
) VALUES (
  'User', 'e3e420e9-4cb2-4f9e-8e69-a40bf18d46c3', 'RR-KCH', '', 'active', '{"id":"e3e420e9-4cb2-4f9e-8e69-a40bf18d46c3","outlet_id":"RR-KCH","created_date":"2026-07-28T09:26:12.616Z","created_by":"zoetanacyw@gmail.com","updated_date":"2026-07-30T04:12:43.949Z","updated_by":"zoetanacyw@gmail.com","deleted_at":"","version":7,"google_sub":"116457295696834205660","email":"zoetanacyw@gmail.com","full_name":"Zoe Tan","avatar_url":"https://lh3.googleusercontent.com/a/ACg8ocJ6BzaiZRfsYkWYEcP5UmPyGGcn6RJVHyAug-3X_8RMe7sWnCYUCw=s96-c","role":"staff","phone":"","department":"","status":"active","last_login_at":"2026-07-30T04:12:43.949Z","outlet_ids":"RR-KCH","name_confirmed":true,"name_confirmed_at":"2026-07-29T06:58:09.979Z","name_updated_at":"2026-07-29T06:58:09.979Z"}',
  7, '2026-07-28T09:26:12.616Z', 'zoetanacyw@gmail.com',
  '2026-07-30T04:12:43.949Z', 'zoetanacyw@gmail.com', ''
)
ON CONFLICT(entity, entity_id) DO UPDATE SET
  outlet_id = excluded.outlet_id,
  status = excluded.status,
  payload_json = excluded.payload_json,
  version = excluded.version,
  updated_at = excluded.updated_at,
  updated_by = excluded.updated_by,
  deleted_at = excluded.deleted_at;

INSERT INTO ops_records (
  entity, entity_id, outlet_id, business_date, status, payload_json,
  version, created_at, created_by, updated_at, updated_by, deleted_at
) VALUES (
  'User', '52b6cf3f-3a4a-4c7c-b2d8-95bc26a6f92d', 'RR-KCH', '', 'active', '{"id":"52b6cf3f-3a4a-4c7c-b2d8-95bc26a6f92d","outlet_id":"RR-KCH","created_date":"2026-07-28T09:26:16.605Z","created_by":"lydiathen0690@gmail.com","updated_date":"2026-07-31T03:00:22.837Z","updated_by":"lydiathen0690@gmail.com","deleted_at":"","version":5,"google_sub":"107982002674612924217","email":"lydiathen0690@gmail.com","full_name":"En","avatar_url":"https://lh3.googleusercontent.com/a/ACg8ocLNcaGTYStt3R8aq-QMlajjUUOp2ewucJzjalgDbhiEYpc=s96-c","role":"staff","phone":"","department":"","status":"active","last_login_at":"2026-07-31T03:00:20.904Z","outlet_ids":"RR-KCH","name_confirmed":true,"name_confirmed_at":"2026-07-31T03:00:22.837Z","name_updated_at":"2026-07-31T03:00:22.837Z"}',
  5, '2026-07-28T09:26:16.605Z', 'lydiathen0690@gmail.com',
  '2026-07-31T03:00:22.837Z', 'lydiathen0690@gmail.com', ''
)
ON CONFLICT(entity, entity_id) DO UPDATE SET
  outlet_id = excluded.outlet_id,
  status = excluded.status,
  payload_json = excluded.payload_json,
  version = excluded.version,
  updated_at = excluded.updated_at,
  updated_by = excluded.updated_by,
  deleted_at = excluded.deleted_at;

INSERT INTO ops_records (
  entity, entity_id, outlet_id, business_date, status, payload_json,
  version, created_at, created_by, updated_at, updated_by, deleted_at
) VALUES (
  'User', '37220180-ae30-405f-bcee-ce8e1da698f1', 'RR-KCH', '', 'active', '{"id":"37220180-ae30-405f-bcee-ce8e1da698f1","outlet_id":"RR-KCH","created_date":"2026-07-29T06:55:10.593Z","created_by":"zasonchong02@gmail.com","updated_date":"2026-08-02T02:35:37.995Z","updated_by":"miltonlim1993@gmail.com","deleted_at":"","version":6,"google_sub":"114251771294628518950","email":"zasonchong02@gmail.com","full_name":"Nian Kang Chong","avatar_url":"https://lh3.googleusercontent.com/a/ACg8ocLPI7Skn9nOfFvnD9aLxWlwrFbHmJVKFWTzhao-aU-pZZtnTKSf=s96-c","role":"owner","phone":"","department":"","status":"active","last_login_at":"2026-07-29T06:59:12.404Z","outlet_ids":"[\"RR-KCH\"]","name_confirmed":true,"name_confirmed_at":"2026-07-29T06:56:26.864Z","name_updated_at":"2026-07-29T06:56:26.864Z"}',
  6, '2026-07-29T06:55:10.593Z', 'zasonchong02@gmail.com',
  '2026-08-02T02:35:37.995Z', 'miltonlim1993@gmail.com', ''
)
ON CONFLICT(entity, entity_id) DO UPDATE SET
  outlet_id = excluded.outlet_id,
  status = excluded.status,
  payload_json = excluded.payload_json,
  version = excluded.version,
  updated_at = excluded.updated_at,
  updated_by = excluded.updated_by,
  deleted_at = excluded.deleted_at;

INSERT INTO ops_records (
  entity, entity_id, outlet_id, business_date, status, payload_json,
  version, created_at, created_by, updated_at, updated_by, deleted_at
) VALUES (
  'Outlet', 'RR-KCH', 'RR-KCH', '', 'active', '{"id":"RR-KCH","outlet_id":"RR-KCH","created_date":"2026-07-23T08:53:59.642Z","created_by":"miltonlim1993@gmail.com","updated_date":"2026-07-23T08:53:59.642Z","updated_by":"miltonlim1993@gmail.com","deleted_at":"","version":1,"name":"Stupiak''s Pork Burger - Royal Richmond","code":"MAIN","address":"","status":"active","timezone":"Asia/Kuala_Lumpur"}',
  1, '2026-07-23T08:53:59.642Z', 'miltonlim1993@gmail.com',
  '2026-07-23T08:53:59.642Z', 'miltonlim1993@gmail.com', ''
)
ON CONFLICT(entity, entity_id) DO UPDATE SET
  outlet_id = excluded.outlet_id,
  status = excluded.status,
  payload_json = excluded.payload_json,
  version = excluded.version,
  updated_at = excluded.updated_at,
  updated_by = excluded.updated_by,
  deleted_at = excluded.deleted_at;

INSERT INTO ops_records (
  entity, entity_id, outlet_id, business_date, status, payload_json,
  version, created_at, created_by, updated_at, updated_by, deleted_at
) VALUES (
  'Outlet', 'SKONE-BTU', 'SKONE-BTU', '', 'active', '{"id":"SKONE-BTU","outlet_id":"SKONE-BTU","created_date":"2026-07-23T08:53:59.642Z","created_by":"miltonlim1993@gmail.com","updated_date":"2026-07-23T08:53:59.642Z","updated_by":"miltonlim1993@gmail.com","deleted_at":"","version":1,"name":"Stupiak''s Pork Burger - Sk One","code":"MAIN","address":"","status":"active","timezone":"Asia/Kuala_Lumpur"}',
  1, '2026-07-23T08:53:59.642Z', 'miltonlim1993@gmail.com',
  '2026-07-23T08:53:59.642Z', 'miltonlim1993@gmail.com', ''
)
ON CONFLICT(entity, entity_id) DO UPDATE SET
  outlet_id = excluded.outlet_id,
  status = excluded.status,
  payload_json = excluded.payload_json,
  version = excluded.version,
  updated_at = excluded.updated_at,
  updated_by = excluded.updated_by,
  deleted_at = excluded.deleted_at;

INSERT INTO ops_records (
  entity, entity_id, outlet_id, business_date, status, payload_json,
  version, created_at, created_by, updated_at, updated_by, deleted_at
) VALUES (
  'Outlet', 'CK-WAREHOUSE', 'CK-WAREHOUSE', '', 'active', '{"id":"CK-WAREHOUSE","outlet_id":"CK-WAREHOUSE","created_date":"2026-07-23T08:53:59.642Z","created_by":"miltonlim1993@gmail.com","updated_date":"2026-07-23T08:53:59.642Z","updated_by":"miltonlim1993@gmail.com","deleted_at":"","version":1,"name":"Stupiak''s Pork Burger - Central Kitchen","code":"MAIN","address":"","status":"active","timezone":"Asia/Kuala_Lumpur"}',
  1, '2026-07-23T08:53:59.642Z', 'miltonlim1993@gmail.com',
  '2026-07-23T08:53:59.642Z', 'miltonlim1993@gmail.com', ''
)
ON CONFLICT(entity, entity_id) DO UPDATE SET
  outlet_id = excluded.outlet_id,
  status = excluded.status,
  payload_json = excluded.payload_json,
  version = excluded.version,
  updated_at = excluded.updated_at,
  updated_by = excluded.updated_by,
  deleted_at = excluded.deleted_at;

INSERT INTO ops_records (
  entity, entity_id, outlet_id, business_date, status, payload_json,
  version, created_at, created_by, updated_at, updated_by, deleted_at
) VALUES (
  'Outlet', 'PS-KCH', 'PS-KCH', '', 'active', '{"id":"PS-KCH","outlet_id":"PS-KCH","created_date":"2026-07-23T08:53:59.642Z","created_by":"miltonlim1993@gmail.com","updated_date":"2026-07-23T08:53:59.642Z","updated_by":"miltonlim1993@gmail.com","deleted_at":"","version":1,"name":"Stupiak''s Pork Burger - Pine Square","code":"MAIN","address":"","status":"active","timezone":"Asia/Kuala_Lumpur"}',
  1, '2026-07-23T08:53:59.642Z', 'miltonlim1993@gmail.com',
  '2026-07-23T08:53:59.642Z', 'miltonlim1993@gmail.com', ''
)
ON CONFLICT(entity, entity_id) DO UPDATE SET
  outlet_id = excluded.outlet_id,
  status = excluded.status,
  payload_json = excluded.payload_json,
  version = excluded.version,
  updated_at = excluded.updated_at,
  updated_by = excluded.updated_by,
  deleted_at = excluded.deleted_at;
