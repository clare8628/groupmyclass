-- 學生分組系統 D1 schema
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS courses (
  id          TEXT PRIMARY KEY,
  year        TEXT NOT NULL DEFAULT '',
  subject     TEXT NOT NULL DEFAULT '',
  group_size  INTEGER NOT NULL DEFAULT 4,
  tolerance   INTEGER NOT NULL DEFAULT 1,
  max_bonus   INTEGER NOT NULL DEFAULT 10,
  deadline    TEXT NOT NULL DEFAULT '',
  notice      TEXT NOT NULL DEFAULT '',
  notice_time TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS groups (
  id                  TEXT NOT NULL,
  course_id           TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  seq                 INTEGER NOT NULL DEFAULT 0,
  allow_edit          INTEGER NOT NULL DEFAULT 0,
  edit_deadline       TEXT NOT NULL DEFAULT '',
  peer_eval_open      INTEGER NOT NULL DEFAULT 0,
  peer_eval_deadline  TEXT NOT NULL DEFAULT '',
  peer_eval_submitted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (course_id, id)
);

CREATE TABLE IF NOT EXISTS students (
  course_id     TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  id            TEXT NOT NULL,          -- 學號
  name          TEXT NOT NULL,
  group_id      TEXT,
  is_leader     INTEGER NOT NULL DEFAULT 0,
  is_vice       INTEGER NOT NULL DEFAULT 0,
  auto_assigned INTEGER NOT NULL DEFAULT 0,
  peer_penalty  INTEGER NOT NULL DEFAULT 0,  -- 加分 (0 到 10)
  peer_comment  TEXT NOT NULL DEFAULT '',    -- 加分原因與貢獻說明
  seq           INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (course_id, id)
);

CREATE INDEX IF NOT EXISTS idx_students_group ON students(course_id, group_id);

CREATE TABLE IF NOT EXISTS group_snapshots (
  course_id  TEXT PRIMARY KEY REFERENCES courses(id) ON DELETE CASCADE,
  snapshot   TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS activity_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id     TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  group_id      TEXT,
  group_name    TEXT NOT NULL DEFAULT '',
  operator_role TEXT NOT NULL DEFAULT '',
  operator_id   TEXT NOT NULL DEFAULT '',
  operator_name TEXT NOT NULL DEFAULT '',
  action_type   TEXT NOT NULL DEFAULT '',
  target_id     TEXT NOT NULL DEFAULT '',
  target_name   TEXT NOT NULL DEFAULT '',
  detail        TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_logs_course ON activity_logs(course_id, created_at DESC);

-- 點名功能：老師設定的點名時段
CREATE TABLE IF NOT EXISTS attendance_sessions (
  id          TEXT NOT NULL,
  course_id   TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  date        TEXT NOT NULL DEFAULT '',   -- YYYY-MM-DD
  time_slot   TEXT NOT NULL DEFAULT '',   -- 時段文字，例如「第3-4節」
  name        TEXT NOT NULL DEFAULT '',   -- 點名名稱，可空白
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (course_id, id)
);

CREATE INDEX IF NOT EXISTS idx_attendance_sessions_course ON attendance_sessions(course_id, date DESC);

-- 點名功能：組長／副組長為組員標記之出缺席紀錄
CREATE TABLE IF NOT EXISTS attendance_records (
  course_id      TEXT NOT NULL,
  session_id     TEXT NOT NULL,
  student_id     TEXT NOT NULL,           -- 學號
  group_id       TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'present',  -- 'present' | 'absent'
  marked_by_id   TEXT NOT NULL DEFAULT '',
  marked_by_name TEXT NOT NULL DEFAULT '',
  created_at     INTEGER NOT NULL DEFAULT 0,  -- 首次點名時間
  updated_at     INTEGER NOT NULL,            -- 最後修正時間
  PRIMARY KEY (course_id, session_id, student_id)
);

CREATE INDEX IF NOT EXISTS idx_attendance_records_session ON attendance_records(course_id, session_id);

-- 點名功能：老師針對特定時段／組別開放「超過當日」之補登權限
CREATE TABLE IF NOT EXISTS attendance_unlocks (
  course_id  TEXT NOT NULL,
  session_id TEXT NOT NULL,
  group_id   TEXT NOT NULL DEFAULT '',    -- '' 表示開放給該時段的全部組別
  deadline   TEXT NOT NULL DEFAULT '',    -- 可空白＝不限期
  created_at INTEGER NOT NULL,
  PRIMARY KEY (course_id, session_id, group_id)
);

-- 點名功能：老師授權某位組長／副組長跨組代理特定時段／組別之點名
CREATE TABLE IF NOT EXISTS attendance_delegates (
  course_id     TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  group_id      TEXT NOT NULL,   -- 被代理的組別
  delegate_id   TEXT NOT NULL,   -- 代理點名之學生學號（通常為另一組組長／副組長）
  delegate_name TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (course_id, session_id, group_id, delegate_id)
);

