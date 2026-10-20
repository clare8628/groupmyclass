/* 自主點名（上傳現場照片）：學生於上課時段內以手機即時拍攝教室畫面上傳；Cron 依時間提醒未完成者。
   防作弊（無人監管下盡量證明到課）：
   1. 前端僅開啟即時相機（不提供相簿選取），照片燒入「姓名／時間／驗證碼」
   2. 驗證碼由伺服器於開始拍照時簽發（HMAC，5 分鐘內有效、一次一個），老師審核時比對照片上的碼，舊照片不可能含有當次驗證碼
   3. 教室 GPS 範圍檢查（老師設定座標與半徑，空白＝不檢查）
   4. 照片雜湊去重（同課程重複照片一律拒絕）、同裝置同日替他人點名拒絕
   5. 僅限課表上課日、上課前後時間窗內；老師可逐筆審核退回（退回即改記缺席） */
import {
  json, bad, readSession, secret, hmac, sha256, ensureSchema, markDataChanged, logActivity, makeLogStmt,
  parseJsonArray, addMinutesToHm, hmToMinutes, sendLinePush, pushWithMentions, logLinePush,
} from './lib.js';

const courseLabel = (c) => { const y = c.year || '', s = c.subject || ''; return s.startsWith(y) ? s : `${y}${s}`; };

const WINDOW_BEFORE_MIN = 10;     // 上課前幾分鐘起可點名
const WINDOW_AFTER_MIN = 90;       // 上課後幾分鐘截止
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const CHALLENGE_MIN_MS = 3000;     // 開始拍照到送出至少需幾毫秒（擋機器腳本）
const MAX_PHOTO_BASE64 = 600 * 1024;
const REMINDER_GAP_MIN = 10;       // 第一次提醒 → 第二次提醒 → 最終名單，各間隔分鐘
const CHECK_WINDOW_MIN = 5;
const DEFAULT_BASE_URL = 'https://groupmyclass.clare8628.workers.dev';

const twNow = (now = Date.now()) => new Date(now + 8 * 3600 * 1000);
const dateOf = now => twNow(now).toISOString().slice(0, 10);

/* 取得今天該課程的點名時間窗；open=false 時以 reason 說明原因 */
export async function checkinWindow(db, courseId, now = Date.now()) {
  const tw = twNow(now);
  const date = tw.toISOString().slice(0, 10);
  const set = await db.prepare('SELECT * FROM attendance_reminder_settings WHERE course_id = ?').bind(courseId).first();
  if (!set || !set.self_checkin) return { open: false, reason: '此課程未啟用自主點名', date, set };
  if (!set.enabled) return { open: false, reason: '點名已暫停', date, set };
  const day = await db.prepare('SELECT first_period_time, enabled FROM course_schedule WHERE course_id = ? AND weekday = ?').bind(courseId, tw.getUTCDay()).first();
  if (!day || !day.enabled || !day.first_period_time) return { open: false, reason: '今天沒有課', date, set };
  if ((set.start_date && date < set.start_date) || (set.end_date && date > set.end_date) || parseJsonArray(set.excluded_dates).includes(date)) {
    return { open: false, reason: '今天不在點名有效期間', date, set };
  }
  const startMin = hmToMinutes(day.first_period_time);
  const nowMin = tw.getUTCHours() * 60 + tw.getUTCMinutes();
  const info = { date, set, startHm: day.first_period_time };
  if (nowMin < startMin - WINDOW_BEFORE_MIN) return { ...info, open: false, reason: `尚未開放，${addMinutesToHm(day.first_period_time, -WINDOW_BEFORE_MIN)} 起可點名` };
  if (nowMin > startMin + WINDOW_AFTER_MIN) return { ...info, open: false, reason: `點名已截止（${addMinutesToHm(day.first_period_time, WINDOW_AFTER_MIN)}）` };
  return { ...info, open: true, reason: '' };
}

function haversineMeters(lat1, lng1, lat2, lng2) {
  const rad = d => d * Math.PI / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(a));
}

async function signChallenge(db, env, courseId, studentId, date, code, issuedAt) {
  return hmac(await secret(db, env), `checkin|${courseId}|${studentId}|${date}|${code}|${issuedAt}`);
}

/* 學生端：GET status / POST challenge / POST submit（需先以 login-student 登入） */
export async function handleCheckin(request, env, db, url) {
  await ensureSchema(db);
  const session = await readSession(db, env, request);
  if (!session || session.role !== 'student') return bad('請先登入', 401);
  if (session.simulatedBy) return bad('模擬學生身分不可點名', 403);
  const courseId = session.courseId;
  const studentId = session.id;
  const win = await checkinWindow(db, courseId);
  const existing = await db.prepare('SELECT status, created_at FROM selfcheckin_records WHERE course_id = ? AND date = ? AND student_id = ?')
    .bind(courseId, win.date, studentId).first();
  const course = (await db.prepare('SELECT subject, year FROM courses WHERE id = ?').bind(courseId).first()) || {};
  const student = (await db.prepare('SELECT name FROM students WHERE course_id = ? AND id = ?').bind(courseId, studentId).first()) || {};
  const set = win.set || {};
  const geo = { required: Number(set.geo_radius) > 0 };

  if (url.pathname === '/api/checkin/status' && request.method === 'GET') {
    return json({
      ok: true, courseName: courseLabel(course), name: student.name || '', date: win.date,
      open: win.open, reason: win.reason, done: !!existing && existing.status === 'ok', rejected: !!existing && existing.status === 'rejected',
      doneAt: existing ? existing.created_at : 0, geo,
    });
  }
  if (!win.open) return bad(win.reason, 403);
  if (existing && existing.status === 'ok') return bad('今天已完成點名', 409);

  if (url.pathname === '/api/checkin/challenge' && request.method === 'POST') {
    const code = String(Math.floor(1000 + Math.random() * 9000));
    const issuedAt = Date.now();
    const token = `${issuedAt}.${code}.${await signChallenge(db, env, courseId, studentId, win.date, code, issuedAt)}`;
    return json({ ok: true, token, code, issuedAt, expiresInSec: CHALLENGE_TTL_MS / 1000 });
  }

  if (url.pathname === '/api/checkin/submit' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const [issuedRaw, code, sig] = String(body.token || '').split('.');
    const issuedAt = Number(issuedRaw);
    if (!issuedAt || !code || sig !== await signChallenge(db, env, courseId, studentId, win.date, code, issuedAt)) return bad('驗證碼無效，請重新拍照', 400);
    const age = Date.now() - issuedAt;
    if (age > CHALLENGE_TTL_MS) return bad('拍照已逾時（5 分鐘），請重新拍照', 400);
    if (age < CHALLENGE_MIN_MS) return bad('送出過快，請重新拍照', 400);

    const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(body.photo || ''));
    if (!m || !m[1].startsWith('/9j/')) return bad('照片格式錯誤，請以相機拍攝', 400);
    if (m[1].length > MAX_PHOTO_BASE64) return bad('照片過大，請重新拍照', 400);
    if (m[1].length < 8000) return bad('照片內容不足，請拍攝教室畫面', 400);
    const photoHash = await sha256(m[1]);
    if (await db.prepare('SELECT 1 FROM selfcheckin_records WHERE course_id = ? AND photo_hash = ?').bind(courseId, photoHash).first()) return bad('此照片已被使用過，請重新拍攝', 409);

    const deviceId = String(body.deviceId || '').slice(0, 64);
    if (deviceId && await db.prepare("SELECT 1 FROM selfcheckin_records WHERE course_id = ? AND date = ? AND device_id = ? AND student_id != ? AND status = 'ok'")
      .bind(courseId, win.date, deviceId, studentId).first()) return bad('此裝置今天已替其他同學點名，每人須使用自己的手機', 409);

    const lat = Number(body.lat), lng = Number(body.lng), accuracy = Number(body.accuracy);
    const hasGeo = Number.isFinite(lat) && Number.isFinite(lng) && body.lat !== null && body.lat !== undefined;
    const flags = [];
    let distance = null;
    if (geo.required) {
      if (!hasGeo) return bad('需要開啟定位權限才能點名（用於確認在教室）', 400);
      distance = haversineMeters(lat, lng, Number(set.geo_lat), Number(set.geo_lng));
      const slack = Math.min(Number.isFinite(accuracy) ? accuracy : 0, 200);
      if (distance - slack > Number(set.geo_radius)) return bad(`您不在教室範圍內（距離約 ${Math.round(distance)} 公尺）`, 403);
    } else if (hasGeo && Number(set.geo_lat)) {
      distance = haversineMeters(lat, lng, Number(set.geo_lat), Number(set.geo_lng));
    }
    if (!hasGeo) flags.push('no-geo');
    flags.push(`elapsed:${Math.round(age / 1000)}s`);

    const now = Date.now();
    const ip = request.headers.get('cf-connecting-ip') || '';
    await db.batch([
      db.prepare(`INSERT OR REPLACE INTO selfcheckin_records
        (course_id, date, student_id, status, photo, photo_hash, code, lat, lng, accuracy, distance, device_id, ip, flags, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(courseId, win.date, studentId, 'ok', m[1], photoHash, code, hasGeo ? lat : null, hasGeo ? lng : null,
          Number.isFinite(accuracy) ? accuracy : null, distance, deviceId, ip, flags.join(','), now),
      db.prepare(`INSERT OR IGNORE INTO attendance_sessions (id, course_id, date, time_slot, name, created_at) VALUES (?,?,?,?,?,?)`)
        .bind(`daily-${win.date}`, courseId, win.date, '', '一般日常點名', now),
      db.prepare(`INSERT OR REPLACE INTO attendance_records (course_id, session_id, student_id, group_id, status, marked_by_id, marked_by_name, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?)`)
        .bind(courseId, `daily-${win.date}`, studentId, '', 'present', studentId, '自主點名', now, now),
      makeLogStmt(db, {
        courseId, operatorRole: 'student', operatorId: studentId, operatorName: student.name || '',
        actionType: 'attendance-selfcheckin', targetId: studentId, targetName: student.name || '',
        detail: `${student.name || studentId} (${studentId}) 於 ${win.date} 完成自主點名（上傳現場照片${distance !== null ? `，距教室約 ${Math.round(distance)} 公尺` : ''}）`,
        createdAt: now,
      }),
    ]);
    await markDataChanged(db);
    return json({ ok: true, done: true });
  }
  return bad('Not found', 404);
}

/* ===== 老師端 ===== */
/* 當天（或指定日）名單：已點名（不含照片，照片由 photo 端點按需下載）與未完成 */
export async function listSelfCheckin(db, courseId, date) {
  await ensureSchema(db);
  const day = date || dateOf();
  const students = (await db.prepare('SELECT id, name FROM students WHERE course_id = ? ORDER BY seq, id').bind(courseId).all()).results || [];
  const recs = (await db.prepare('SELECT student_id, status, code, lat, lng, accuracy, distance, flags, device_id, created_at FROM selfcheckin_records WHERE course_id = ? AND date = ?')
    .bind(courseId, day).all()).results || [];
  const byId = new Map(recs.map(r => [r.student_id, r]));
  const bound = new Set(((await db.prepare('SELECT student_id FROM line_bindings').all()).results || []).map(r => r.student_id));
  const deviceCount = new Map();
  recs.forEach(r => r.device_id && deviceCount.set(r.device_id, (deviceCount.get(r.device_id) || 0) + 1));
  return {
    date: day,
    items: students.map(s => {
      const r = byId.get(s.id);
      return {
        id: s.id, name: s.name, bound: bound.has(s.id), status: r ? r.status : 'none',
        code: r ? r.code : '', createdAt: r ? r.created_at : 0,
        distance: r && r.distance !== null ? Math.round(r.distance) : null,
        flags: r ? r.flags : '', sharedDevice: !!(r && r.device_id && deviceCount.get(r.device_id) > 1),
      };
    }),
  };
}

export async function getSelfCheckinPhoto(db, courseId, date, studentId) {
  const row = await db.prepare('SELECT photo FROM selfcheckin_records WHERE course_id = ? AND date = ? AND student_id = ?').bind(courseId, date, studentId).first();
  if (!row || !row.photo) return null;
  return new Response(Uint8Array.from(atob(row.photo), ch => ch.charCodeAt(0)), { status: 200, headers: { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=3600' } });
}

/* 老師審核：reject＝退回（記缺席），accept＝恢復為出席 */
export async function reviewSelfCheckin(db, courseId, date, studentId, decision) {
  const rec = await db.prepare('SELECT 1 FROM selfcheckin_records WHERE course_id = ? AND date = ? AND student_id = ?').bind(courseId, date, studentId).first();
  if (!rec) throw new Error('找不到該筆自主點名紀錄');
  const status = decision === 'reject' ? 'rejected' : 'ok';
  const now = Date.now();
  await db.batch([
    db.prepare('UPDATE selfcheckin_records SET status = ? WHERE course_id = ? AND date = ? AND student_id = ?').bind(status, courseId, date, studentId),
    db.prepare("UPDATE attendance_records SET status = ?, updated_at = ? WHERE course_id = ? AND session_id = ? AND student_id = ?")
      .bind(status === 'ok' ? 'present' : 'absent', now, courseId, `daily-${date}`, studentId),
  ]);
  await logActivity(db, {
    courseId, operatorRole: 'teacher', operatorId: 'teacher', operatorName: '老師', actionType: 'attendance-selfcheckin-review', targetId: studentId,
    detail: `老師審核 ${date} 自主點名照片（${studentId}）：${status === 'ok' ? '確認出席' : '退回，改記缺席'}`,
  });
}

/* 老師後台按鈕「發送自主點名流程說明」：開學前先讓全班了解流程，避免上課當天手忙腳亂、老師也忘了交代 */
export async function sendSelfCheckinInstructions(db, env, courseId) {
  await ensureSchema(db);
  const set = await db.prepare('SELECT * FROM attendance_reminder_settings WHERE course_id = ?').bind(courseId).first();
  if (!set || !set.self_checkin) throw new Error('本課程未啟用自主點名');
  if (!set.line_group_id) throw new Error('請先設定 LINE 群組 ID');
  const course = (await db.prepare('SELECT subject, year FROM courses WHERE id = ?').bind(courseId).first()) || {};
  const link = `${env.PUBLIC_BASE_URL || DEFAULT_BASE_URL}/checkin.html?c=${encodeURIComponent(courseId)}`;
  const steps = [
    `點此連結登入：${link}（姓名＋密碼，預設密碼為學號）`,
    '上課時間內（上課前 10 分鐘～上課後 90 分鐘），用手機鏡頭即時拍下教室畫面，不能使用相簿舊照片',
    '照片會自動印上姓名、時間與系統當次簽發的驗證碼',
    Number(set.geo_radius) > 0 ? '請允許手機定位權限，系統會確認您是否在教室範圍內' : '',
    '送出後即完成點名；每人每天限一次，重複使用的照片會被拒絕',
  ].filter(Boolean);
  const text = [
    `【${courseLabel(course)}】自主點名流程說明（開學前請先看過）：`,
    ...steps.map((s, i) => `${i + 1}. ${s}`),
    '若逾時未點名，系統會於群組自動提醒；如有疑問請洽老師。',
  ].join('\n');
  await sendLinePush(env, set.line_group_id, text);
  await logLinePush(db, { courseId, kind: 'selfcheckin-instructions', channel: 'all', groupId: set.line_group_id, summary: '發送自主點名流程說明給全班' });
  await logActivity(db, {
    courseId, operatorRole: 'teacher', operatorId: 'teacher', operatorName: '老師',
    actionType: 'attendance-selfcheckin-instructions', detail: '老師發送自主點名流程說明給全班',
  });
  return { sent: true };
}

/* ===== Cron：自主點名提醒（每 5 分鐘）=====
   第一次提醒（上課後 offset 分鐘）→ +10 分鐘第二次提醒 → +10 分鐘列出仍未完成者；每階段每天每課程只發一次 */
async function pendingStudents(db, courseId, date) {
  const rows = (await db.prepare(`
    SELECT s.id AS id, s.name AS name, lb.line_user_id AS line_user_id
    FROM students s
    LEFT JOIN (
      SELECT student_id, line_user_id, MAX(created_at) AS bound_at
      FROM line_bindings
      GROUP BY student_id
    ) lb ON lb.student_id = s.id
    WHERE s.course_id = ? AND s.id NOT IN (SELECT student_id FROM selfcheckin_records WHERE course_id = ? AND date = ? AND status = 'ok')
    ORDER BY s.seq, s.id
  `).bind(courseId, courseId, date).all()).results || [];
  return { total: rows.length, bound: rows.filter(r => r.line_user_id), unbound: rows.filter(r => !r.line_user_id) };
}



export async function runSelfCheckinReminders(db, env, now = Date.now()) {
  await ensureSchema(db);
  const tw = twNow(now);
  const date = tw.toISOString().slice(0, 10);
  const nowMin = tw.getUTCHours() * 60 + tw.getUTCMinutes();
  const rows = (await db.prepare(`
    SELECT s.course_id AS course_id, s.first_period_time AS first_period_time, s.enabled AS day_enabled,
           r.enabled AS global_enabled, r.offset_minutes AS offset_minutes, r.start_date AS start_date, r.end_date AS end_date,
           r.excluded_dates AS excluded_dates, r.line_group_id AS line_group_id, c.year AS year, c.subject AS subject
    FROM course_schedule s
    JOIN attendance_reminder_settings r ON r.course_id = s.course_id
    JOIN courses c ON c.id = s.course_id
    WHERE s.weekday = ? AND r.self_checkin = 1
  `).bind(tw.getUTCDay()).all().catch(() => ({ results: [] }))).results || [];

  const results = [];
  for (const row of rows) {
    if (!row.day_enabled || !row.global_enabled || !row.first_period_time || !row.line_group_id) continue;
    if ((row.start_date && date < row.start_date) || (row.end_date && date > row.end_date) || parseJsonArray(row.excluded_dates).includes(date)) continue;
    const base = addMinutesToHm(row.first_period_time, row.offset_minutes);
    const link = `${env.PUBLIC_BASE_URL || DEFAULT_BASE_URL}/checkin.html?c=${encodeURIComponent(row.course_id)}`;
    const label = courseLabel(row);
    const stages = [
      { key: 'self1', hm: base },
      { key: 'self2', hm: addMinutesToHm(base, REMINDER_GAP_MIN) },
      { key: 'selffinal', hm: addMinutesToHm(base, REMINDER_GAP_MIN * 2) },
    ];
    for (const st of stages) {
      const elapsed = ((nowMin - hmToMinutes(st.hm)) % 1440 + 1440) % 1440;
      if (elapsed >= CHECK_WINDOW_MIN) continue;
      const runKey = `${date}:${st.key}`;
      if (await db.prepare('SELECT 1 FROM attendance_reminder_runs WHERE course_id = ? AND send_date = ?').bind(row.course_id, runKey).first()) continue;

      let status = 'ok', detail = '', pushed = false;
      try {
        const p = await pendingStudents(db, row.course_id, date);
        if (!p.total) {
          status = 'skipped';
          detail = '全員已完成自主點名';
          if (st.key === 'selffinal') {
            await sendLinePush(env, row.line_group_id, `【${label}】今日全員已完成自主點名 ✅`);
            pushed = true;
          }
        } else if (st.key === 'selffinal') {
          const names = [...p.bound, ...p.unbound].map(x => x.name).join('、');
          await sendLinePush(env, row.line_group_id, `【${label}】自主點名時間已過，以下 ${p.total} 位同學尚未完成：\n${names}`);
          pushed = true;
          detail = `列出未完成 ${p.total} 人`;
        } else {
          const head = `${st.key === 'self2' ? '【第二次提醒】' : ''}【${label}】上課了，請以手機拍攝教室畫面完成自主點名\n尚未完成：`;
          const tail = [`點名連結（需登入）：${link}`, p.unbound.length ? `${p.unbound.map(x => x.name).join('、')}（尚未綁定 LINE，請於群組輸入「綁定 學號」）` : ''].filter(Boolean).join('\n');
          await pushWithMentions(env, row.line_group_id, head, p.bound, tail);
          pushed = true;
          detail = `tag ${p.bound.length} 人、未綁定 ${p.unbound.length} 人`;
        }
      } catch (err) {
        status = 'error';
        detail = String((err && err.message) || err);
      }
      if (pushed) await logLinePush(db, { courseId: row.course_id, kind: `selfcheckin-${st.key}`, channel: 'all', groupId: row.line_group_id, summary: detail, status });
      await db.prepare('INSERT OR REPLACE INTO attendance_reminder_runs (course_id, send_date, status, detail, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(row.course_id, runKey, status, detail, Date.now()).run();
      results.push({ courseId: row.course_id, stage: st.key, status, detail });
    }
  }
  return results;
}
