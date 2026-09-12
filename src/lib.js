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
export async function loadState(db) {
  const [courses, groups, students] = await Promise.all([
    db.prepare('SELECT * FROM courses ORDER BY year DESC, created_at ASC').all(),
    db.prepare('SELECT * FROM groups ORDER BY seq ASC').all(),
    db.prepare('SELECT * FROM students ORDER BY seq ASC').all(),
  ]);
  return courses.results.map(c => ({
    id: c.id, year: c.year, subject: c.subject,
    groupSize: c.group_size, tolerance: c.tolerance, deadline: c.deadline,
    groups: groups.results.filter(g => g.course_id === c.id).map(g => ({ id: g.id, name: g.name })),
    students: students.results.filter(s => s.course_id === c.id).map(s => ({
      id: s.id, name: s.name, groupId: s.group_id,
      isLeader: !!s.is_leader, isVice: !!s.is_vice, autoAssigned: !!s.auto_assigned,
    })),
  }));
}

export const cap = c => Number(c.groupSize) + Number(c.tolerance);
export const membersOf = (c, gid) => c.students.filter(s => s.groupId === gid);
export const deadlinePassed = c => !!c.deadline && Date.now() > new Date(c.deadline).getTime();

export function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/* 逾時：未被挑選者隨機分配並標示自動 */
export async function applyDeadline(db, courses) {
  const stmts = [];
  for (const c of courses) {
    if (!deadlinePassed(c) || !c.groups.length) continue;
    for (const s of shuffle(c.students.filter(x => !x.groupId))) {
      const target = c.groups.slice().sort((a, b) => membersOf(c, a.id).length - membersOf(c, b.id).length)[0];
      if (!target || membersOf(c, target.id).length >= cap(c)) continue;
      s.groupId = target.id; s.autoAssigned = true;
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
  const h = await sha256('teacher123');                       // 預設密碼
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
