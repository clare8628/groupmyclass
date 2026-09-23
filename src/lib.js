/* 學生分組系統 — 共用工具（底線開頭不會成為路由） */

export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });

export const bad = (msg, status = 400) => json({ error: msg }, status);

const enc = new TextEncoder();
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

let _cachedSecret = null;
let _cachedHmacKey = null;

export async function secret(db, env) {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  if (_cachedSecret) return _cachedSecret;
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind('session_secret').first();
  if (row) {
    _cachedSecret = row.value;
    return _cachedSecret;
  }
  const s = b64u(crypto.getRandomValues(new Uint8Array(32)));
  await db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind('session_secret', s).run();
  _cachedSecret = s;
  return s;
}

export async function getHmacKey(db, env) {
  if (_cachedHmacKey) return _cachedHmacKey;
  const sec = await secret(db, env);
  _cachedHmacKey = await crypto.subtle.importKey('raw', enc.encode(sec), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return _cachedHmacKey;
}

export async function hmac(key, msg) {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
}

export async function hmacWithKey(cryptoKey, msg) {
  return b64u(await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(msg)));
}

export async function sha256(text) {
  return b64u(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

export async function makeToken(db, env, payload) {
  const body = b64u(enc.encode(JSON.stringify({ ...payload, exp: Date.now() + 12 * 3600 * 1000 })));
  return `${body}.${await hmac(await secret(db, env), body)}`;
}

export async function readSession(db, env, request) {
  const m = (request.headers.get('cookie') || '').match(/(?:^|;\s*)gs_session=([^;]+)/);
  if (!m) return null;
  const [body, sig] = decodeURIComponent(m[1]).split('.');
  if (!body || !sig) return null;
  if (sig !== await hmac(await secret(db, env), body)) return null;
  try {
    const raw = Uint8Array.from(atob(body.replace(/-/g, '+').replace(/_/g, '/')), ch => ch.charCodeAt(0));
    const data = JSON.parse(new TextDecoder().decode(raw));
    return data.exp > Date.now() ? data : null;
  } catch (e) { return null; }
}

export const sessionCookie = (token, maxAge = 12 * 3600) =>
  `gs_session=${token}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${maxAge}`;
export const clearCookie = 'gs_session=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0';

/* ===== 狀態讀取 ===== */
let _ensuredGroupSchema = false;
async function ensureGroupSchema(db) {
  if (_ensuredGroupSchema) return;
  try {
    await db.prepare('ALTER TABLE groups ADD COLUMN allow_edit INTEGER NOT NULL DEFAULT 0').run();
  } catch (_) {}
  try {
    await db.prepare('ALTER TABLE groups ADD COLUMN edit_deadline TEXT NOT NULL DEFAULT \'\'').run();
  } catch (_) {}
  try {
    await db.prepare('ALTER TABLE courses ADD COLUMN notice TEXT NOT NULL DEFAULT \'\'').run();
  } catch (_) {}
  try {
    await db.prepare('ALTER TABLE courses ADD COLUMN notice_time TEXT NOT NULL DEFAULT \'\'').run();
  } catch (_) {}
  try {
    await db.prepare('ALTER TABLE courses ADD COLUMN max_bonus INTEGER NOT NULL DEFAULT 10').run();
  } catch (_) {}
  try {
    await db.prepare('ALTER TABLE courses ADD COLUMN deadline_assigned INTEGER NOT NULL DEFAULT 0').run();
  } catch (_) {}
  try {
    await db.prepare(`
      UPDATE courses 
      SET deadline_assigned = 1 
      WHERE deadline_assigned = 0 AND (
        id IN (SELECT DISTINCT course_id FROM activity_logs WHERE operator_role = 'system' AND action_type = 'auto-assign')
        OR (deadline != '' AND deadline IS NOT NULL AND deadline <= strftime('%Y-%m-%dT%H:%M', 'now', '+8 hours'))
      )
    `).run();
  } catch (_) {}
  try {
    await db.prepare('ALTER TABLE groups ADD COLUMN peer_eval_open INTEGER NOT NULL DEFAULT 0').run();
  } catch (_) {}
  try {
    await db.prepare('ALTER TABLE groups ADD COLUMN peer_eval_deadline TEXT NOT NULL DEFAULT \'\'').run();
  } catch (_) {}
  try {
    await db.prepare('ALTER TABLE groups ADD COLUMN peer_eval_submitted INTEGER NOT NULL DEFAULT 0').run();
  } catch (_) {}
  try {
    await db.prepare('ALTER TABLE students ADD COLUMN peer_penalty INTEGER NOT NULL DEFAULT 0').run();
  } catch (_) {}
  try {
    await db.prepare('ALTER TABLE students ADD COLUMN peer_comment TEXT NOT NULL DEFAULT \'\'').run();
  } catch (_) {}
  try {
    await db.prepare('ALTER TABLE students ADD COLUMN password_hash TEXT NOT NULL DEFAULT \'\'').run();
  } catch (_) {}
  try {
    await db.prepare('CREATE TABLE IF NOT EXISTS group_snapshots (course_id TEXT PRIMARY KEY, snapshot TEXT NOT NULL, created_at INTEGER NOT NULL)').run();
  } catch (_) {}
  try {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS activity_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        course_id TEXT NOT NULL,
        group_id TEXT,
        group_name TEXT NOT NULL DEFAULT '',
        operator_role TEXT NOT NULL DEFAULT '',
        operator_id TEXT NOT NULL DEFAULT '',
        operator_name TEXT NOT NULL DEFAULT '',
        action_type TEXT NOT NULL DEFAULT '',
        target_id TEXT NOT NULL DEFAULT '',
        target_name TEXT NOT NULL DEFAULT '',
        detail TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      )
    `).run();
  } catch (_) {}
  try {
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_logs_course ON activity_logs(course_id, created_at DESC)').run();
  } catch (_) {}
  _ensuredGroupSchema = true;
}

let _ensuredAttendanceSchema = false;
async function ensureAttendanceSchema(db) {
  if (_ensuredAttendanceSchema) return;
  try {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS attendance_sessions (
        id TEXT NOT NULL,
        course_id TEXT NOT NULL,
        date TEXT NOT NULL DEFAULT '',
        time_slot TEXT NOT NULL DEFAULT '',
        name TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        PRIMARY KEY (course_id, id)
      )
    `).run();
  } catch (_) {}
  try {
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_attendance_sessions_course ON attendance_sessions(course_id, date DESC)').run();
  } catch (_) {}
  try {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS attendance_records (
        course_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        student_id TEXT NOT NULL,
        group_id TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'present',
        marked_by_id TEXT NOT NULL DEFAULT '',
        marked_by_name TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (course_id, session_id, student_id)
      )
    `).run();
  } catch (_) {}
  try {
    await db.prepare('ALTER TABLE attendance_records ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0').run();
  } catch (_) {}
  try {
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_attendance_records_session ON attendance_records(course_id, session_id)').run();
  } catch (_) {}
  try {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS attendance_unlocks (
        course_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        group_id TEXT NOT NULL DEFAULT '',
        deadline TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        PRIMARY KEY (course_id, session_id, group_id)
      )
    `).run();
  } catch (_) {}
  try {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS attendance_delegates (
        course_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        group_id TEXT NOT NULL,
        delegate_id TEXT NOT NULL,
        delegate_name TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        PRIMARY KEY (course_id, session_id, group_id, delegate_id)
      )
    `).run();
  } catch (_) {}
  _ensuredAttendanceSchema = true;
}

let _checkedGroup3Restored = false;
export async function ensureGroup3Restored(db) {
  if (_checkedGroup3Restored) return;
  try {
    const existingG3 = await db.prepare('SELECT id FROM groups WHERE course_id = ? AND id = ?')
      .bind('cmu1evo6kq451', 'g_3').first();
    const studentsInG3 = await db.prepare('SELECT COUNT(*) as cnt FROM students WHERE course_id = ? AND group_id = ?')
      .bind('cmu1evo6kq451', 'g_3').first();

    if (!existingG3 || !studentsInG3 || studentsInG3.cnt === 0) {
      const g3Members = [
        { id: '41461D20', name: '宋阮芳草', isLeader: 1 },
        { id: '41461D16', name: '阮秒玲', isLeader: 0 },
        { id: '41461D39', name: '鄧葉英', isLeader: 0 },
        { id: '41461D60', name: '范黎薇', isLeader: 0 },
        { id: '41461D41', name: '李氏玉', isLeader: 0 },
      ];
      const stmts = [
        db.prepare(`
          INSERT OR REPLACE INTO groups (id, course_id, name, seq, allow_edit, edit_deadline, peer_eval_open, peer_eval_deadline, peer_eval_submitted)
          VALUES ('g_3', 'cmu1evo6kq451', '第3組', 3, 0, '', 0, '', 0)
        `),
      ];
      for (const m of g3Members) {
        stmts.push(
          db.prepare('UPDATE students SET group_id = "g_3", is_leader = ?, is_vice = 0, auto_assigned = 0 WHERE course_id = "cmu1evo6kq451" AND id = ?')
            .bind(m.isLeader, m.id)
        );
        stmts.push(
          db.prepare('UPDATE attendance_records SET group_id = "g_3" WHERE course_id = "cmu1evo6kq451" AND student_id = ?')
            .bind(m.id)
        );
      }
      stmts.push(makeLogStmt(db, {
        courseId: 'cmu1evo6kq451',
        groupId: 'g_3',
        groupName: '第3組',
        operatorRole: 'system',
        operatorId: 'system',
        operatorName: '系統管理',
        actionType: 'restore-group',
        detail: '依「原始編組不動」最高分組規則恢復原始第3組，並將原第三組成員（組長：宋阮芳草，組員：阮秒玲、鄧葉英、范黎薇、李氏玉）加回第3組',
      }));
      await db.batch(stmts);
      invalidateStateCache();
    }
    _checkedGroup3Restored = true;
  } catch (err) {
    console.error('Failed to ensure group 3 restored:', err);
  }
}

let _checkedPanReleased = false;
export async function ensurePanReleased(db) {
  if (_checkedPanReleased) return;
  try {
    // 檢查潘氏哥詩 (41461D47) 是否在截止後遭系統重複觸發誤分派至第3組（auto_assigned = 1 且在 g_3）
    const student = await db.prepare('SELECT course_id, group_id, auto_assigned FROM students WHERE id = ?')
      .bind('41461D47').first();
    if (student && student.group_id === 'g_3' && Number(student.auto_assigned) === 1) {
      await db.prepare('UPDATE students SET group_id = NULL, auto_assigned = 0 WHERE id = ?')
        .bind('41461D47').run();
      await db.prepare(`
        INSERT INTO activity_logs (course_id, group_id, group_name, operator_role, operator_id, operator_name, action_type, target_id, target_name, detail, created_at)
        VALUES (?, '', '', 'system', 'system', '系統', 'fix-unassign', '41461D47', '潘氏哥詩', '系統修正：恢復組員 潘氏哥詩 (41461D47) 至未分組名單（先前因截止自動分組重複觸發而誤分派至第3組）', ?)
      `).bind(student.course_id, Date.now()).run();
      invalidateStateCache();
    }
    _checkedPanReleased = true;
  } catch (err) {
    console.error('Failed to ensure Pan released:', err);
  }
}

export function makeLogStmt(db, {
  courseId,
  groupId = '',
  groupName = '',
  operatorRole = '',
  operatorId = '',
  operatorName = '',
  actionType = '',
  targetId = '',
  targetName = '',
  detail = '',
  createdAt = Date.now(),
}) {
  return db.prepare(`
    INSERT INTO activity_logs (course_id, group_id, group_name, operator_role, operator_id, operator_name, action_type, target_id, target_name, detail, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    courseId,
    groupId || '',
    groupName || '',
    operatorRole || '',
    operatorId || '',
    operatorName || '',
    actionType || '',
    targetId || '',
    targetName || '',
    detail || '',
    createdAt
  );
}

export async function logActivity(db, params) {
  try {
    await makeLogStmt(db, params).run();
  } catch (err) {
    console.error('Failed to log activity:', err);
  }
}

export const defaultNotice = (maxBonus = 10) => `【期末考成績加減分與評分規定】：
1. 當老師開放組長評分權限時，組長可依據組員之貢獻或配合程度於期末時給予加分 (0 ~ ${maxBonus} 分)。
2. 組長在老師開放評分權限時進行評分，組長自己可獲得 ${maxBonus} 分的加分。
3. 超過分組截止時間由系統自動分組造成沒有組長的組別，每位成員期末考成績扣 10 分。`;

export const DEFAULT_NOTICE = defaultNotice(10);

export const parseDate = str => {
  if (!str) return 0;
  const s = String(str).trim();
  if (s.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(s)) {
    return new Date(s).getTime();
  }
  return new Date(s.replace(' ', 'T') + '+08:00').getTime();
};

/* 點名功能：台北時區（+8）今天日期字串 YYYY-MM-DD */
export const todayDateStr = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);

/* 找出適用於某時段＋組別、且尚未過期的老師補登開放紀錄 */
export function attendanceUnlockFor(unlocks, sessionId, groupId) {
  const now = Date.now();
  return (unlocks || []).find(u => u.sessionId === sessionId
    && (u.groupId === groupId || u.groupId === '')
    && (!u.deadline || parseDate(u.deadline) > now)) || null;
}

/* 判斷點名時段是否為一般日常點名 */
export function isDailySession(s) {
  if (!s) return false;
  if (s.isDaily) return true;
  if (s.id && String(s.id).startsWith('daily-')) return true;
  if (s.name === '一般日常點名' || s.name === '日常點名') return true;
  return false;
}

/* 判斷組長／副組長目前是否可編輯某點名時段之紀錄：
   當天可自由編輯；超過當天則需老師針對該時段（或該組）開放補登權限 */
export function isAttendanceEditable(session, unlocks, groupId) {
  if (!session) return false;
  if (session.date === todayDateStr()) return true;
  return !!attendanceUnlockFor(unlocks, session.id, groupId);
}

/* 判斷組長評分是否逾時 */
export const evalDeadlinePassed = g => !!g.peerEvalDeadline && Date.now() > parseDate(g.peerEvalDeadline);

/* 判斷組長重新挑選組員截止時間是否已逾時 */
export const editDeadlinePassed = g => !!g.editDeadline && Date.now() > parseDate(g.editDeadline);

/* 判斷組長當前是否具備挑選／更換組員之權限 */
export function canGroupLeaderEdit(c, g) {
  if (!c) return false;
  if (!deadlinePassed(c)) return true;
  if (!g || !g.allowEdit) return false;
  if (g.editDeadline && editDeadlinePassed(g)) return false;
  return true;
}

/* 計算每位學生的期末考調分與原因 */
export function calcAdjustment(c, g, s) {
  if (!s.groupId || !g) {
    return { score: 0, tag: '未分組', reason: '尚未加入組別，無期末考調分', status: 'none' };
  }
  const maxB = Number(c && c.maxBonus) > 0 ? Number(c.maxBonus) : 10;
  const lead = c.students.find(x => x.groupId === g.id && x.isLeader);

  // 情況 1：無組長組別（超過分組截止時間系統自動分組，且無組長）
  if (!lead) {
    return { score: -10, tag: '-10分', reason: '超過分組截止時間無組長，全員期末考扣 10 分', status: 'no-leader' };
  }

  // 情況 2：有組長組別
  const isEvalOpen = !!g.peerEvalOpen;
  const isSubmitted = !!g.peerEvalSubmitted;
  const isOverdue = isEvalOpen && evalDeadlinePassed(g) && !isSubmitted;

  if (isSubmitted) {
    // 組長已完成評分
    if (s.isLeader) {
      return { score: maxB, tag: `+${maxB}分`, reason: `組長於老師開放評分權限時完成評分，組長自己獲得加 ${maxB} 分`, status: 'leader-normal' };
    } else {
      const bonus = Math.max(0, Math.min(maxB, Number(s.peerPenalty) || 0));
      const commentMsg = s.peerComment ? ` [原因: ${s.peerComment}]` : '';
      return {
        score: bonus,
        penalty: bonus,
        tag: (bonus > 0 ? `+${bonus}` : `${bonus}`) + '分',
        reason: bonus > 0 ? `經組長依貢獻度評定加 ${bonus} 分${commentMsg}` : '組長評定加 0 分（無額外加分）',
        status: bonus > 0 ? 'member-bonus' : 'member-zero',
      };
    }
  }

  if (isOverdue) {
    // 開放後已逾時但組長未進行評分
    if (s.isLeader) {
      return { score: 0, tag: '±0分', reason: `組長未於評分截止時間前進行評分，無法獲得 ${maxB} 分加分`, status: 'leader-overdue' };
    } else {
      return { score: 0, tag: '±0分', reason: '組長逾時未進行評分，組員無法獲得加分', status: 'member-overdue' };
    }
  }

  // 評分開放中但尚未截止且尚未提交，或老師尚未開放評分
  if (isEvalOpen) {
    if (s.isLeader) {
      return { score: 0, tag: '評分中', reason: `組長評分進行中（完成評分後組長自己可獲得 ${maxB} 分加分）`, status: 'leader-pending' };
    } else {
      return { score: 0, tag: '評分中', reason: `組長評分進行中（組長可依貢獻度給予 0~${maxB} 分加分）`, status: 'member-pending' };
    }
  }

  // 老師尚未開放評分
  if (s.isLeader) {
    return { score: 0, tag: '待開放', reason: `待老師開放評分權限並完成評分後，組長可獲得 ${maxB} 分加分`, status: 'leader-pending' };
  } else {
    return { score: 0, tag: '待開放', reason: `待老師開放評分權限後，組長可依貢獻度給予 0~${maxB} 分加分`, status: 'member-pending' };
  }
}

/* ===== D1 快取防護與狀態版本控制 ===== */
let _cachedRawCourses = null;
let _cachedRawTime = 0;
let _cachedRecentLogs = null;
let _stateVersion = 1;
const RAW_CACHE_TTL = 4000; // 4 秒內重複查詢直接由 Worker 記憶體提供，大幅收斂 D1 尖峰併發讀取

export function getStateVersion() {
  return _stateVersion;
}

export function invalidateStateCache() {
  _cachedRawCourses = null;
  _cachedRawTime = 0;
  _cachedRecentLogs = null;
  _stateVersion++;
}

/* 按需讀取指定課程或全站異動日誌 */
export async function getCourseLogs(db, courseId = null, limit = 500) {
  try {
    const query = courseId
      ? 'SELECT * FROM activity_logs WHERE course_id = ? ORDER BY created_at DESC LIMIT ?'
      : 'SELECT * FROM activity_logs ORDER BY created_at DESC LIMIT ?';
    const stmt = courseId ? db.prepare(query).bind(courseId, limit) : db.prepare(query).bind(limit);
    const rows = await stmt.all();
    return (rows.results || []).map(log => ({
      id: log.id,
      courseId: log.course_id,
      groupId: log.group_id,
      groupName: log.group_name,
      operatorRole: log.operator_role,
      operatorId: log.operator_id,
      operatorName: log.operator_name,
      actionType: log.action_type,
      targetId: log.target_id,
      targetName: log.target_name,
      detail: log.detail,
      createdAt: log.created_at,
    }));
  } catch (err) {
    console.error('Failed to get course logs:', err);
    return [];
  }
}

export async function loadState(db) {
  const now = Date.now();
  if (_cachedRawCourses && (now - _cachedRawTime < RAW_CACHE_TTL)) {
    return structuredClone(_cachedRawCourses);
  }

  await ensureGroupSchema(db);
  await ensureAttendanceSchema(db);
  await ensureGroup3Restored(db);
  await ensurePanReleased(db);
  const [courses, groups, students, snapshots, attSessions, attRecords, attUnlocks, attDelegates] = await Promise.all([
    db.prepare('SELECT * FROM courses ORDER BY year DESC, created_at ASC').all(),
    db.prepare('SELECT * FROM groups ORDER BY seq ASC').all(),
    db.prepare('SELECT * FROM students ORDER BY seq ASC').all(),
    db.prepare('SELECT course_id FROM group_snapshots').all().catch(() => ({ results: [] })),
    db.prepare('SELECT * FROM attendance_sessions ORDER BY date DESC, created_at DESC').all().catch(() => ({ results: [] })),
    db.prepare('SELECT * FROM attendance_records').all().catch(() => ({ results: [] })),
    db.prepare('SELECT * FROM attendance_unlocks').all().catch(() => ({ results: [] })),
    db.prepare('SELECT * FROM attendance_delegates').all().catch(() => ({ results: [] })),
  ]);
  const snapshotSet = new Set((snapshots.results || []).map(r => r.course_id));
  return courses.results.map(c => {
    const courseGroups = groups.results.filter(g => g.course_id === c.id).map(g => ({
      id: g.id,
      name: g.name,
      allowEdit: !!g.allow_edit,
      editDeadline: g.edit_deadline || '',
      peerEvalOpen: !!g.peer_eval_open,
      peerEvalDeadline: g.peer_eval_deadline || '',
      peerEvalSubmitted: !!g.peer_eval_submitted,
    }));
    const courseStudents = students.results.filter(s => s.course_id === c.id).map(s => ({
      id: s.id, name: s.name, groupId: s.group_id,
      isLeader: !!s.is_leader, isVice: !!s.is_vice, autoAssigned: !!s.auto_assigned,
      peerPenalty: Number(s.peer_penalty) || 0,
      peerComment: s.peer_comment || '',
      password_hash: s.password_hash || '',
      hasCustomPassword: !!s.password_hash,
    }));

    // 計算每位同學的調分結果
    const maxBonusVal = Number(c.max_bonus) > 0 ? Number(c.max_bonus) : 10;
    const courseObj = {
      id: c.id, year: c.year, subject: c.subject,
      groupSize: c.group_size, tolerance: c.tolerance,
      maxBonus: maxBonusVal,
      deadline: c.deadline,
      deadlineAssigned: !!c.deadline_assigned,
      notice: c.notice !== undefined && c.notice !== null ? c.notice : defaultNotice(maxBonusVal),
      noticeTime: c.notice_time || (c.created_at ? new Date(c.created_at + 8 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ') : ''),
      hasSnapshot: snapshotSet.has(c.id),
      groups: courseGroups,
      students: courseStudents,
    };

    courseStudents.forEach(s => {
      const g = courseGroups.find(x => x.id === s.groupId);
      s.adjustment = calcAdjustment(courseObj, g, s);
    });

    courseObj.attendanceSessions = (attSessions.results || []).filter(x => x.course_id === c.id).map(x => ({
      id: x.id, date: x.date || '', timeSlot: x.time_slot || '', name: x.name || '', createdAt: x.created_at,
    }));
    const today = todayDateStr();
    const hasTodayDaily = courseObj.attendanceSessions.some(x => x.date === today && isDailySession(x));
    if (!hasTodayDaily) {
      courseObj.attendanceSessions.unshift({
        id: `daily-${today}`,
        date: today,
        timeSlot: '',
        name: '一般日常點名',
        isDaily: true,
        createdAt: 0,
      });
    }
    courseObj.attendanceRecords = (attRecords.results || []).filter(x => x.course_id === c.id).map(x => {
      const matchedSt = !x.marked_by_id && x.marked_by_name ? courseObj.students.find(s => s.name === x.marked_by_name) : null;
      return {
        sessionId: x.session_id, studentId: x.student_id, groupId: x.group_id || '', status: x.status,
        markedById: x.marked_by_id || (matchedSt ? matchedSt.id : ''), markedByName: x.marked_by_name || (matchedSt ? matchedSt.name : ''),
        createdAt: x.created_at || x.updated_at, updatedAt: x.updated_at,
      };
    });
    courseObj.attendanceUnlocks = (attUnlocks.results || []).filter(x => x.course_id === c.id).map(x => ({
      sessionId: x.session_id, groupId: x.group_id || '', deadline: x.deadline || '', createdAt: x.created_at,
    }));
    courseObj.attendanceDelegates = (attDelegates.results || []).filter(x => x.course_id === c.id).map(x => ({
      sessionId: x.session_id, groupId: x.group_id, delegateId: x.delegate_id,
      delegateName: x.delegate_name || '', createdAt: x.created_at,
    }));

    return courseObj;
  });
  _cachedRawCourses = structuredClone(processedCourses);
  _cachedRawTime = now;
  return processedCourses;
}

export const cap = c => Number(c.groupSize) + Number(c.tolerance);
export const minCap = c => Math.max(1, Number(c.groupSize) - Number(c.tolerance));
export const membersOf = (c, gid) => c.students.filter(s => s.groupId === gid);
export const deadlinePassed = c => !!c.deadline && Date.now() > parseDate(c.deadline);

export function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/* 逾時：
   重要分組規則：原始編組不動（不解散人數未達最低門檻之組別），
   僅在分組截止時「執行一次」將剩餘未被挑選者隨機分配至組別並標示自動。
   後續若有成員被釋出，將持續保留在未分配名單中，由組長挑選、老師指派或老師手動按鈕隨機分配。 */
export async function applyDeadline(db, courses) {
  const stmts = [];
  for (const c of courses) {
    if (!deadlinePassed(c) || !c.groups.length) continue;
    // 每個截止時限只會執行一次自動分組，已執行過者直接略過
    if (c.deadlineAssigned) continue;

    c.deadlineAssigned = true;
    stmts.push(db.prepare('UPDATE courses SET deadline_assigned = 1 WHERE id = ?').bind(c.id));

    // 將未分組學生隨機分配至現有組別（優先分配至人數較少的組別）
    const unassigned = c.students.filter(x => !x.groupId);
    if (!unassigned.length) continue;

    for (const s of shuffle(unassigned)) {
      const target = c.groups.slice().sort((a, b) => membersOf(c, a.id).length - membersOf(c, b.id).length)[0];
      if (!target || membersOf(c, target.id).length >= cap(c)) continue;
      s.groupId = target.id;
      s.autoAssigned = true;
      stmts.push(db.prepare('UPDATE students SET group_id = ?, auto_assigned = 1 WHERE course_id = ? AND id = ?')
        .bind(target.id, c.id, s.id));
      stmts.push(makeLogStmt(db, {
        courseId: c.id,
        groupId: target.id,
        groupName: target.name,
        operatorRole: 'system',
        operatorId: 'system',
        operatorName: '系統',
        actionType: 'auto-assign',
        targetId: s.id,
        targetName: s.name,
        detail: `系統於分組截止後，自動將未分組學生 ${s.name} (${s.id}) 分配至「${target.name}」`,
      }));
    }
  }
  if (stmts.length) {
    await db.batch(stmts);
    invalidateStateCache();
  }
  return courses;
}


export async function teacherHash(db) {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind('teacher_password').first();
  if (row) return row.value;
  const h = await sha256('clear6');                       // 預設密碼
  await db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind('teacher_password', h).run();
  return h;
}

export const nextSeq = async (db, table, courseId) => {
  const r = await db.prepare(`SELECT COALESCE(MAX(seq), 0) AS m FROM ${table} WHERE course_id = ?`).bind(courseId).first();
  return (r && r.m ? r.m : 0) + 1;
};

/* 學生身分遮罩與不可逆代號推導：
   學生檢視前台時學號遮罩（前三碼 + 星號），
   組長操作改用 ref（以 session secret 推導的不可逆代號）。 */
const maskId = id => String(id).slice(0, 3) + '*'.repeat(Math.max(0, String(id).length - 3));

export async function studentRef(db, env, courseId, id, preloadedKey = null) {
  const k = preloadedKey || await getHmacKey(db, env);
  return (await hmacWithKey(k, 'ref:' + courseId + ':' + id)).slice(0, 16);
}

export async function publicize(db, env, courses, session) {
  if (session && session.role === 'teacher') {
    let recentLogs = _cachedRecentLogs;
    if (!recentLogs || (Date.now() - _cachedRawTime >= RAW_CACHE_TTL)) {
      try {
        const logRows = await db.prepare('SELECT * FROM activity_logs ORDER BY created_at DESC LIMIT 15').all();
        recentLogs = (logRows.results || []).map(log => ({
          id: log.id,
          courseId: log.course_id,
          groupId: log.group_id,
          groupName: log.group_name,
          operatorRole: log.operator_role,
          operatorId: log.operator_id,
          operatorName: log.operator_name,
          actionType: log.action_type,
          targetId: log.target_id,
          targetName: log.target_name,
          detail: log.detail,
          createdAt: log.created_at,
        }));
        _cachedRecentLogs = recentLogs;
      } catch (_) {}
    }
    const logsByCourse = {};
    for (const log of (recentLogs || [])) {
      if (!logsByCourse[log.courseId]) logsByCourse[log.courseId] = [];
      logsByCourse[log.courseId].push(log);
    }
    return courses.map(c => {
      const groupName = gid => (c.groups.find(g => g.id === gid) || {}).name || '';
      const studentName = sid => (c.students.find(s => s.id === sid) || {}).name || '';
      return {
        ...c,
        students: c.students.map(s => {
          const { password_hash, ...rest } = s;
          return { ...rest, hasCustomPassword: !!password_hash };
        }),
        logs: logsByCourse[c.id] || [],
        attendanceSessions: c.attendanceSessions || [],
        attendanceRecords: (c.attendanceRecords || []).map(r => {
          const st = c.students.find(s => s.id === r.studentId);
          return { ...r, studentName: st ? st.name : '', groupName: groupName(r.groupId) };
        }),
        attendanceUnlocks: c.attendanceUnlocks || [],
        attendanceDelegates: (c.attendanceDelegates || []).map(d => ({
          ...d,
          delegateName: d.delegateName || studentName(d.delegateId),
          delegateGroupName: groupName((c.students.find(s => s.id === d.delegateId) || {}).groupId),
          groupName: groupName(d.groupId),
        })),
      };
    });
  }
  const selfId = session && session.role === 'student' ? session.id : null;
  const selfCourse = session && session.courseId;
  const hmacKey = await getHmacKey(db, env);
  const out = [];
  for (const c of courses) {
    const students = [];
    const refById = {};
    for (const s of c.students) {
      const mine = selfId && s.id === selfId && c.id === selfCourse;
      const ref = await studentRef(db, env, c.id, s.id, hmacKey);
      refById[s.id] = ref;
      const { password_hash, ...rest } = s;
      students.push({
        ...rest,
        id: mine ? s.id : maskId(s.id),
        ref,
        peerPenalty: 0,
        peerComment: '',
        adjustment: null,
        hasCustomPassword: !!password_hash,
      });
    }
    const isMine = !!selfId && c.id === selfCourse;
    const selfGroupId = isMine ? (c.students.find(s => s.id === selfId) || {}).groupId : null;
    const myDelegates = isMine ? (c.attendanceDelegates || []).filter(d => d.delegateId === selfId) : [];
    const delegatedGroupIds = new Set(myDelegates.map(d => d.groupId));
    const visibleGroupIds = new Set([selfGroupId, ...delegatedGroupIds].filter(Boolean));
    const attendanceSessions = c.attendanceSessions || [];
    const groupName = gid => (c.groups.find(g => g.id === gid) || {}).name || '';
    const attendanceRecords = (c.attendanceRecords || [])
      .filter(r => (isMine && visibleGroupIds.has(r.groupId)) || r.status === 'absent')
      .map(r => {
        const st = c.students.find(s => s.id === r.studentId);
        return {
          sessionId: r.sessionId,
          groupId: r.groupId,
          status: r.status,
          markedById: r.markedById || '',
          markedByName: r.markedByName,
          updatedAt: r.updatedAt,
          studentId: r.studentId,
          studentName: st ? st.name : '',
          groupName: groupName(r.groupId),
          ref: refById[r.studentId] || '',
        };
      });
    const attendanceUnlocks = isMine
      ? (c.attendanceUnlocks || []).filter(u => !u.groupId || visibleGroupIds.has(u.groupId))
      : [];
    const attendanceDelegates = isMine
      ? myDelegates.map(d => ({
          sessionId: d.sessionId, groupId: d.groupId,
          groupName: (c.groups.find(g => g.id === d.groupId) || {}).name || '',
        }))
      : [];
    out.push({ ...c, students, attendanceSessions, attendanceRecords, attendanceUnlocks, attendanceDelegates });
  }
  return out;
}

export async function resolveStudent(db, env, c, key) {
  const direct = c.students.find(s => s.id === key);
  if (direct) return direct;
  const hmacKey = await getHmacKey(db, env);
  for (const s of c.students) {
    if (await studentRef(db, env, c.id, s.id, hmacKey) === key) return s;
  }
  return null;
}
