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
    await db.prepare('CREATE TABLE IF NOT EXISTS group_snapshots (course_id TEXT PRIMARY KEY, snapshot TEXT NOT NULL, created_at INTEGER NOT NULL)').run();
  } catch (_) {}
  _ensuredGroupSchema = true;
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

export async function loadState(db) {
  await ensureGroupSchema(db);
  const [courses, groups, students, snapshots] = await Promise.all([
    db.prepare('SELECT * FROM courses ORDER BY year DESC, created_at ASC').all(),
    db.prepare('SELECT * FROM groups ORDER BY seq ASC').all(),
    db.prepare('SELECT * FROM students ORDER BY seq ASC').all(),
    db.prepare('SELECT course_id FROM group_snapshots').all().catch(() => ({ results: [] })),
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
    }));

    // 計算每位同學的調分結果
    const maxBonusVal = Number(c.max_bonus) > 0 ? Number(c.max_bonus) : 10;
    const courseObj = {
      id: c.id, year: c.year, subject: c.subject,
      groupSize: c.group_size, tolerance: c.tolerance,
      maxBonus: maxBonusVal,
      deadline: c.deadline,
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

    return courseObj;
  });
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
   1. 學生組長建立之組別若人數未達最低門檻 minCap，則視為未完成建立並予以解散，成員釋出為未分組；
   2. 剩餘未被挑選者隨機分配至組別並標示自動。 */
export async function applyDeadline(db, courses) {
  const stmts = [];
  for (const c of courses) {
    if (!deadlinePassed(c) || !c.groups.length) continue;

    // 步驟 1：檢查並解散未達最低門檻之組別
    const min = minCap(c);
    const validGroups = [];
    for (const g of c.groups) {
      const gMembers = membersOf(c, g.id);
      if (gMembers.length < min) {
        // 未達門檻：清空該組成員並刪除該組別
        for (const m of gMembers) {
          m.groupId = null;
          m.isLeader = false;
          m.isVice = false;
        }
        stmts.push(db.prepare('UPDATE students SET group_id = NULL, is_leader = 0, is_vice = 0 WHERE course_id = ? AND group_id = ?').bind(c.id, g.id));
        stmts.push(db.prepare('DELETE FROM groups WHERE course_id = ? AND id = ?').bind(c.id, g.id));
      } else {
        validGroups.push(g);
      }
    }
    c.groups = validGroups;

    // 步驟 2：將未分組學生隨機分配至現有組別（系統隨機分組不限最低門檻）
    if (!validGroups.length) continue;
    for (const s of shuffle(c.students.filter(x => !x.groupId))) {
      const target = validGroups.slice().sort((a, b) => membersOf(c, a.id).length - membersOf(c, b.id).length)[0];
      if (!target || membersOf(c, target.id).length >= cap(c)) continue;
      s.groupId = target.id;
      s.autoAssigned = true;
      stmts.push(db.prepare('UPDATE students SET group_id = ?, auto_assigned = 1 WHERE course_id = ? AND id = ?')
        .bind(target.id, c.id, s.id));
    }
  }
  if (stmts.length) await db.batch(stmts);
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
  return ((r && r.m) || 0) + 1;
};

/* ===== 對外遮蔽學號 =====
   學號同時是學生的登入密碼，因此非老師的回應一律遮蔽；
   組長操作改用 ref（以 session secret 推導的不可逆代號）。 */
const maskId = id => String(id).slice(0, 3) + '*'.repeat(Math.max(0, String(id).length - 3));

export async function studentRef(db, env, courseId, id, preloadedKey = null) {
  const k = preloadedKey || await getHmacKey(db, env);
  return (await hmacWithKey(k, 'ref:' + courseId + ':' + id)).slice(0, 16);
}

export async function publicize(db, env, courses, session) {
  if (session && session.role === 'teacher') return courses;
  const selfId = session && session.role === 'student' ? session.id : null;
  const selfCourse = session && session.courseId;
  const hmacKey = await getHmacKey(db, env);
  const out = [];
  for (const c of courses) {
    const students = [];
    for (const s of c.students) {
      const mine = selfId && s.id === selfId && c.id === selfCourse;
      students.push({
        ...s,
        id: mine ? s.id : maskId(s.id),
        ref: await studentRef(db, env, c.id, s.id, hmacKey),
        peerPenalty: 0,
        peerComment: '',
        adjustment: null,
      });
    }
    out.push({ ...c, students });
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
