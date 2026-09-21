import {
  json, bad, sha256, makeToken, readSession, sessionCookie, clearCookie,
  loadState, cap, minCap, membersOf, deadlinePassed, shuffle, teacherHash, nextSeq,
  applyDeadline, publicize, resolveStudent, canGroupLeaderEdit,
  makeLogStmt, logActivity, evalDeadlinePassed, isAttendanceEditable,
  isDailySession, todayDateStr,
} from './lib.js';
import { APP_VERSION } from './version.js';

/* 確保點名時段寫入資料庫（用於日常點名自動建立或補登驗證） */
async function ensureSessionInDb(db, courseId, s) {
  if (!s) return;
  const isDaily = isDailySession(s);
  await db.prepare(`
    INSERT OR IGNORE INTO attendance_sessions (id, course_id, date, time_slot, name, created_at)
    VALUES (?,?,?,?,?,?)
  `).bind(s.id, courseId, s.date, s.timeSlot || '', s.name || (isDaily ? '一般日常點名' : ''), s.createdAt || Date.now()).run();
}

/* GET /api/state — 公開讀取全部課程／名單／分組 */
export async function handleState(request, env, db) {
  const session = await readSession(db, env, request);
  const courses = await applyDeadline(db, await loadState(db));
  return json({ courses: await publicize(db, env, courses, session), session, version: APP_VERSION });
}

/* POST /api/action — 所有異動，依角色驗證 */
export async function handleAction(request, env, db, body) {
  const action = body && body.action;
  if (!action) return bad('缺少 action');
  const session = await readSession(db, env, request);
  const courses = await loadState(db);
  const course = id => courses.find(c => c.id === id);
  const ok = async (extra = {}, headers = {}) => {
    const view = extra.session !== undefined ? extra.session : session;
    return json({ ok: true, courses: await publicize(db, env, await loadState(db), view), version: APP_VERSION, ...extra }, 200, headers);
  };

  const saveSnapshot = async (db, courseId) => {
    const [snapGroups, snapStudents] = await Promise.all([
      db.prepare('SELECT id, course_id, name, seq, allow_edit, edit_deadline, peer_eval_open, peer_eval_deadline, peer_eval_submitted FROM groups WHERE course_id = ?').bind(courseId).all(),
      db.prepare('SELECT id, group_id, is_leader, is_vice, auto_assigned, peer_penalty, peer_comment FROM students WHERE course_id = ?').bind(courseId).all(),
    ]);
    const payload = JSON.stringify({
      groups: snapGroups.results || [],
      students: snapStudents.results || [],
    });
    await db.prepare('INSERT OR REPLACE INTO group_snapshots (course_id, snapshot, created_at) VALUES (?, ?, ?)')
      .bind(courseId, payload, Date.now()).run();
  };

  /* ---- 登入／登出 ---- */
  if (action === 'login-teacher') {
    if (await sha256(String(body.password || '')) !== await teacherHash(db)) return bad('密碼錯誤 Wrong password', 401);
    const token = await makeToken(db, env, { role: 'teacher' });
    return ok({ session: { role: 'teacher' } }, { 'set-cookie': sessionCookie(token) });
  }
  if (action === 'login-student') {
    const c = course(body.courseId);
    if (!c) return bad('課程不存在 Course not found', 404);
    const inputAccount = String(body.name || body.account || '').trim();
    const inputPassword = String(body.password || body.sid || '').trim();
    if (!inputAccount || !inputPassword) {
      return bad('請輸入姓名或學號，以及密碼 Please enter account and password（Vui lòng nhập họ tên/mã SV và mật khẩu）', 400);
    }
    // 先依學號或姓名尋找學生
    const s = c.students.find(x => x.name === inputAccount || x.id === inputAccount);
    if (!s) return bad('找不到該學生，或不在本課程修課名單中 Student not found in this course（Không tìm thấy sinh viên trong khóa học này）', 401);

    // 驗證密碼：若有自訂密碼 hash 則比對雜湊；若尚未自訂則預設密碼為學號
    let valid = false;
    if (s.password_hash) {
      valid = (await sha256(inputPassword)) === s.password_hash;
    } else {
      valid = inputPassword === s.id;
    }
    if (!valid) {
      return bad('密碼錯誤 Wrong password（Mật khẩu không đúng. Mật khẩu mặc định là mã SV, nếu đã đổi hãy nhập mật khẩu mới; nếu quên hãy nhờ giáo viên đặt lại）', 401);
    }
    const token = await makeToken(db, env, { role: 'student', id: s.id, courseId: c.id });
    return ok({ session: { role: 'student', id: s.id, courseId: c.id } }, { 'set-cookie': sessionCookie(token) });
  }
  if (action === 'logout') return ok({ session: null }, { 'set-cookie': clearCookie });

  /* ---- 老師 ---- */
  if (action.startsWith('teacher:')) {
    if (!session || session.role !== 'teacher') return bad('需要老師權限 Teacher only', 403);
    const op = action.slice(8);

    if (op === 'change-password') {
      if (await sha256(String(body.current || '')) !== await teacherHash(db)) return bad('目前密碼錯誤', 401);
      const next = String(body.next || '');
      if (next.length < 4) return bad('新密碼至少 4 碼');
      await db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
        .bind('teacher_password', await sha256(next)).run();
      return ok();
    }
    if (op === 'change-student-password') {
      const c = course(body.courseId);
      if (!c) return bad('課程不存在 Course not found', 404);
      const studentId = String(body.studentId || '').trim();
      const s = c.students.find(x => x.id === studentId);
      if (!s) return bad('找不到該學生 Student not found', 404);
      const resetToDefault = !!body.resetToDefault;
      let newHash = '';
      if (!resetToDefault) {
        const next = String(body.next || '').trim();
        if (next.length < 4) return bad('新密碼至少需 4 碼 Password must be at least 4 chars', 400);
        newHash = await sha256(next);
      }
      await db.prepare('UPDATE students SET password_hash=? WHERE course_id=? AND id=?')
        .bind(newHash, c.id, s.id).run();

      const roleLabel = s.isLeader ? '組長' : s.isVice ? '副組長' : '學生';
      const myGroup = s.groupId ? c.groups.find(g => g.id === s.groupId) : null;
      const gName = myGroup ? `「${myGroup.name}」` : '';
      await logActivity(db, {
        courseId: c.id,
        groupId: s.groupId || '',
        groupName: myGroup ? myGroup.name : '',
        operatorRole: 'teacher',
        operatorId: 'teacher',
        operatorName: '老師',
        actionType: 'password-reset',
        targetId: s.id,
        targetName: s.name,
        detail: `老師將${gName}${roleLabel} ${s.name} (${s.id}) 的登入密碼${resetToDefault ? '重設為預設學號' : '修改為新自訂密碼'}`,
      });
      return ok({ studentId: s.id, hasCustomPassword: !resetToDefault });
    }
    if (op === 'save-course') {
      const exists = course(body.id);
      const id = exists ? body.id : ('c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
      const nowStr = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');
      const noticeVal = body.notice !== undefined ? String(body.notice) : '';
      const noticeTime = (exists && exists.notice === noticeVal && exists.noticeTime) ? exists.noticeTime : nowStr;

      const args = [
        body.year || '',
        body.subject || '',
        Number(body.groupSize) || 4,
        Number(body.tolerance) || 0,
        Number(body.maxBonus) > 0 ? Number(body.maxBonus) : 10,
        body.deadline || '',
        noticeVal,
        noticeTime,
      ];
      if (exists) {
        await db.prepare('UPDATE courses SET year=?, subject=?, group_size=?, tolerance=?, max_bonus=?, deadline=?, notice=?, notice_time=? WHERE id=?').bind(...args, id).run();
      } else {
        await db.prepare('INSERT INTO courses (id, year, subject, group_size, tolerance, max_bonus, deadline, notice, notice_time, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
          .bind(id, ...args, Date.now()).run();
      }
      return ok({ courseId: id });
    }
    if (op === 'del-course') {
      await db.batch([
        db.prepare('DELETE FROM activity_logs WHERE course_id = ?').bind(body.courseId),
        db.prepare('DELETE FROM students WHERE course_id = ?').bind(body.courseId),
        db.prepare('DELETE FROM groups WHERE course_id = ?').bind(body.courseId),
        db.prepare('DELETE FROM courses WHERE id = ?').bind(body.courseId),
      ]);
      return ok();
    }
    if (op === 'del-groups') {
      const c = course(body.courseId);
      if (!c) return bad('課程不存在', 404);
      const groupIds = Array.isArray(body.groupIds) ? body.groupIds : [];
      if (!groupIds.length) return bad('請選擇欲刪除的組別', 400);

      const delNames = [];
      const stmts = [];
      for (const gid of groupIds) {
        const g = c.groups.find(x => x.id === gid);
        if (g) delNames.push(g.name);
        // 將該組成員重置為未分組
        stmts.push(db.prepare('UPDATE students SET group_id=NULL, is_leader=0, is_vice=0, auto_assigned=0 WHERE course_id=? AND group_id=?').bind(c.id, gid));
        stmts.push(db.prepare('DELETE FROM groups WHERE course_id=? AND id=?').bind(c.id, gid));
      }
      stmts.push(makeLogStmt(db, {
        courseId: c.id,
        operatorRole: 'teacher',
        operatorId: 'teacher',
        operatorName: '老師',
        actionType: 'del-groups',
        detail: `老師刪除組別「${delNames.join('、')}」，組員已釋出為未分組`,
      }));
      await db.batch(stmts);
      return ok();
    }
    if (op === 'add-students') {
      const c = course(body.courseId);
      if (!c) return bad('課程不存在', 404);
      let seq = await nextSeq(db, 'students', c.id);
      const seen = new Set(c.students.map(s => s.id));
      const rows = [];
      for (const x of (body.students || [])) {
        const id = String(x.id || '').trim(), name = String(x.name || '').trim();
        if (!id || !name || seen.has(id)) continue;
        seen.add(id);
        rows.push({ id, name });
      }
      if (!rows.length) return ok({ added: 0 });
      await db.batch(rows.map(x => db.prepare('INSERT INTO students (course_id, id, name, seq) VALUES (?,?,?,?)')
        .bind(c.id, x.id, x.name, seq++)));
      return ok({ added: rows.length });
    }
    if (op === 'del-student') {
      const cc = course(body.courseId);
      const victim = cc && await resolveStudent(db, env, cc, body.studentId);
      if (!victim) return bad('學生不存在', 404);
      await db.prepare('DELETE FROM students WHERE course_id = ? AND id = ?').bind(body.courseId, victim.id).run();
      return ok();
    }
    if (op === 'assign-student') {
      const c = course(body.courseId);
      if (!c) return bad('課程不存在', 404);
      const s = await resolveStudent(db, env, c, body.studentId);
      if (!s) return bad('學生不存在', 404);
      const gid = body.groupId || null;
      if (gid && s.groupId !== gid && membersOf(c, gid).length >= cap(c)) return bad(`該組已達上限 ${cap(c)} 人`);
      const targetG = gid ? c.groups.find(x => x.id === gid) : null;
      const targetGName = targetG ? targetG.name : '未分組';
      const detail = `老師將學生 ${s.name} (${s.id}) ${gid ? `指派至「${targetGName}」` : '移至未分組名單'}`;
      await db.batch([
        db.prepare('UPDATE students SET group_id=?, auto_assigned=0, is_leader=CASE WHEN ? IS NULL THEN 0 ELSE is_leader END, is_vice=CASE WHEN ? IS NULL THEN 0 ELSE is_vice END WHERE course_id=? AND id=?')
          .bind(gid, gid, gid, c.id, s.id),
        makeLogStmt(db, {
          courseId: c.id,
          groupId: gid || '',
          groupName: targetGName,
          operatorRole: 'teacher',
          operatorId: 'teacher',
          operatorName: '老師',
          actionType: 'teacher-assign',
          targetId: s.id,
          targetName: s.name,
          detail,
        }),
      ]);
      return ok();
    }
    if (op === 'set-leader') {
      const c = course(body.courseId);
      const s = c && await resolveStudent(db, env, c, body.studentId);
      if (!s || !s.groupId) return bad('學生未分組', 400);
      const g = c.groups.find(x => x.id === s.groupId);
      const gName = g ? g.name : '';
      const on = body.on ? 1 : 0;
      const detail = `老師${on ? '指定' : '取消'}學生 ${s.name} (${s.id}) 為「${gName}」組長`;
      await db.batch([
        db.prepare('UPDATE students SET is_leader=0 WHERE course_id=? AND group_id=?').bind(c.id, s.groupId),
        db.prepare('UPDATE students SET is_leader=?, is_vice=CASE WHEN ?=1 THEN 0 ELSE is_vice END WHERE course_id=? AND id=?')
          .bind(on, on, c.id, s.id),
        makeLogStmt(db, {
          courseId: c.id,
          groupId: s.groupId,
          groupName: gName,
          operatorRole: 'teacher',
          operatorId: 'teacher',
          operatorName: '老師',
          actionType: 'teacher-set-leader',
          targetId: s.id,
          targetName: s.name,
          detail,
        }),
      ]);
      return ok();
    }
    if (op === 'make-groups') {
      const c = course(body.courseId);
      if (!c) return bad('課程不存在', 404);
      await saveSnapshot(db, c.id);
      const n = Math.max(1, Math.ceil(c.students.length / Math.max(1, c.groupSize)));
      const stmts = [
        db.prepare('DELETE FROM groups WHERE course_id = ?').bind(c.id),
        db.prepare('UPDATE students SET group_id=NULL, is_leader=0, is_vice=0, auto_assigned=0 WHERE course_id=?').bind(c.id),
      ];
      for (let i = 1; i <= n; i++) {
        stmts.push(db.prepare('INSERT INTO groups (id, course_id, name, seq) VALUES (?,?,?,?)')
          .bind('g' + i, c.id, '第 ' + i + ' 組', i));
      }
      stmts.push(makeLogStmt(db, {
        courseId: c.id,
        operatorRole: 'teacher',
        operatorId: 'teacher',
        operatorName: '老師',
        actionType: 'make-groups',
        detail: `老師重新建立 ${n} 個空組別（清空現有分組）`,
      }));
      await db.batch(stmts);
      return ok();
    }
    if (op === 'make-remaining-groups') {
      const c = course(body.courseId);
      if (!c) return bad('課程不存在', 404);
      const unassigned = c.students.filter(s => !s.groupId);
      if (!unassigned.length) return bad('目前所有學生皆已分組，無未分組學生', 400);

      await saveSnapshot(db, c.id);
      const needCount = Math.max(1, Math.ceil(unassigned.length / Math.max(1, c.groupSize)));
      const curCount = c.groups.length;
      let seq = await nextSeq(db, 'groups', c.id);

      const stmts = [];
      for (let i = 1; i <= needCount; i++) {
        const gid = 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const gname = '第 ' + (curCount + i) + ' 組';
        stmts.push(db.prepare('INSERT INTO groups (id, course_id, name, seq) VALUES (?,?,?,?)')
          .bind(gid, c.id, gname, seq++));
      }
      stmts.push(makeLogStmt(db, {
        courseId: c.id,
        operatorRole: 'teacher',
        operatorId: 'teacher',
        operatorName: '老師',
        actionType: 'make-remaining-groups',
        detail: `老師為剩餘 ${unassigned.length} 位未分組學生建立 ${needCount} 個新組別`,
      }));
      await db.batch(stmts);
      return ok({ addedGroups: needCount });
    }
    if (op === 'restore-groups-snapshot') {
      const c = course(body.courseId);
      if (!c) return bad('課程不存在', 404);
      const row = await db.prepare('SELECT snapshot FROM group_snapshots WHERE course_id = ?').bind(c.id).first();
      if (!row || !row.snapshot) return bad('目前無可復原的步驟紀錄', 400);

      let data = null;
      try {
        data = JSON.parse(row.snapshot);
      } catch (e) {
        return bad('快照資料損壞無法復原', 500);
      }

      const snapGroups = Array.isArray(data.groups) ? data.groups : [];
      const snapStudents = Array.isArray(data.students) ? data.students : [];

      const stmts = [
        db.prepare('DELETE FROM groups WHERE course_id = ?').bind(c.id),
        db.prepare('UPDATE students SET group_id=NULL, is_leader=0, is_vice=0, auto_assigned=0, peer_penalty=0, peer_comment=\'\' WHERE course_id=?').bind(c.id),
      ];

      for (const g of snapGroups) {
        stmts.push(db.prepare('INSERT INTO groups (id, course_id, name, seq, allow_edit, edit_deadline, peer_eval_open, peer_eval_deadline, peer_eval_submitted) VALUES (?,?,?,?,?,?,?,?,?)')
          .bind(g.id, c.id, g.name, g.seq || 0, g.allow_edit ? 1 : 0, g.edit_deadline || '', g.peer_eval_open ? 1 : 0, g.peer_eval_deadline || '', g.peer_eval_submitted ? 1 : 0));
      }

      for (const s of snapStudents) {
        stmts.push(db.prepare('UPDATE students SET group_id=?, is_leader=?, is_vice=?, auto_assigned=?, peer_penalty=?, peer_comment=? WHERE course_id=? AND id=?')
          .bind(s.group_id, s.is_leader ? 1 : 0, s.is_vice ? 1 : 0, s.auto_assigned ? 1 : 0, Number(s.peer_penalty) || 0, s.peer_comment || '', c.id, s.id));
      }

      stmts.push(db.prepare('DELETE FROM group_snapshots WHERE course_id = ?').bind(c.id));
      stmts.push(makeLogStmt(db, {
        courseId: c.id,
        operatorRole: 'teacher',
        operatorId: 'teacher',
        operatorName: '老師',
        actionType: 'restore-snapshot',
        detail: '老師執行復原分組（回到上一步快照狀態）',
      }));

      await db.batch(stmts);
      return ok();
    }
    if (op === 'add-group') {
      const c = course(body.courseId);
      if (!c) return bad('課程不存在', 404);
      const seq = await nextSeq(db, 'groups', c.id);
      const gname = '第 ' + (c.groups.length + 1) + ' 組';
      const gid = 'g' + Date.now().toString(36);
      await db.batch([
        db.prepare('INSERT INTO groups (id, course_id, name, seq) VALUES (?,?,?,?)').bind(gid, c.id, gname, seq),
        makeLogStmt(db, {
          courseId: c.id,
          groupId: gid,
          groupName: gname,
          operatorRole: 'teacher',
          operatorId: 'teacher',
          operatorName: '老師',
          actionType: 'add-group',
          detail: `老師新增一組「${gname}」`,
        }),
      ]);
      return ok();
    }
    if (op === 'clear-groups') {
      const c = course(body.courseId);
      if (c) {
        await saveSnapshot(db, c.id);
      }
      await db.batch([
        db.prepare('DELETE FROM groups WHERE course_id = ?').bind(body.courseId),
        db.prepare('UPDATE students SET group_id=NULL, is_leader=0, is_vice=0, auto_assigned=0 WHERE course_id=?').bind(body.courseId),
        makeLogStmt(db, {
          courseId: body.courseId,
          operatorRole: 'teacher',
          operatorId: 'teacher',
          operatorName: '老師',
          actionType: 'clear-groups',
          detail: '老師清除所有分組與學生組別分配',
        }),
      ]);
      return ok();
    }
    if (op === 'toggle-group-edit') {
      const c = course(body.courseId);
      if (!c) return bad('課程不存在', 404);
      const g = c.groups.find(x => x.id === body.groupId);
      if (!g) return bad('組別不存在', 404);
      const allow = body.allowEdit ? 1 : 0;
      const editDeadline = allow ? (body.editDeadline !== undefined ? String(body.editDeadline) : '') : '';
      const deadlineInfo = (allow && editDeadline) ? `（專屬截止時間：${editDeadline.replace('T', ' ')}）` : '';
      const detail = `老師${allow ? '開放' : '關閉'}「${g.name}」組長挑選權限${deadlineInfo}`;
      await db.batch([
        db.prepare('UPDATE groups SET allow_edit=?, edit_deadline=? WHERE course_id=? AND id=?')
          .bind(allow, editDeadline, c.id, g.id),
        makeLogStmt(db, {
          courseId: c.id,
          groupId: g.id,
          groupName: g.name,
          operatorRole: 'teacher',
          operatorId: 'teacher',
          operatorName: '老師',
          actionType: 'toggle-group-edit',
          detail,
        }),
      ]);
      return ok();
    }
    if (op === 'set-peer-eval') {
      const c = course(body.courseId);
      if (!c) return bad('課程不存在', 404);
      const g = c.groups.find(x => x.id === body.groupId);
      if (!g) return bad('組別不存在', 404);
      const open = body.open ? 1 : 0;
      const deadline = body.deadline !== undefined ? String(body.deadline) : g.peerEvalDeadline;
      await db.prepare('UPDATE groups SET peer_eval_open=?, peer_eval_deadline=? WHERE course_id=? AND id=?')
        .bind(open, deadline, c.id, g.id).run();
      return ok();
    }
    if (op === 'set-all-peer-eval') {
      const c = course(body.courseId);
      if (!c) return bad('課程不存在', 404);
      const open = body.open ? 1 : 0;
      const deadline = body.deadline !== undefined ? String(body.deadline) : '';
      await db.prepare('UPDATE groups SET peer_eval_open=?, peer_eval_deadline=? WHERE course_id=?')
        .bind(open, deadline, c.id).run();
      return ok();
    }
    if (op === 'auto-assign') {
      const c = course(body.courseId);
      if (!c) return bad('課程不存在', 404);
      const unassignedStudents = c.students.filter(x => !x.groupId);
      if (!unassignedStudents.length) return bad('目前沒有未分組學生 No unassigned students', 400);

      const min = minCap(c);
      const max = cap(c);

      // 篩選出「尚未完成分組」的組別（成員數小於最低門檻 minCap）
      // 已達到或超過最低門檻的組別視為「已完成編組的組別」，嚴格避開，不可新增或刪減其成員
      let candidateGroups = c.groups.filter(g => membersOf(c, g.id).length < min);

      // 若目前沒有任何未滿門檻的組別，但仍有剩餘未分組學生，
      // 則依每組規定人數建立新的組別供剩餘學生分配，絕不更動已完成分組的組別
      if (!candidateGroups.length) {
        const groupSize = Math.max(1, Number(c.groupSize) || 4);
        const needNewGroups = Math.max(1, Math.ceil(unassignedStudents.length / groupSize));
        let seq = await nextSeq(db, 'groups', c.id);
        const newGroupStmts = [];
        const createdGroups = [];
        for (let i = 0; i < needNewGroups; i++) {
          const newGid = 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5) + i;
          const newName = '第 ' + (c.groups.length + i + 1) + ' 組';
          newGroupStmts.push(db.prepare('INSERT INTO groups (id, course_id, name, seq) VALUES (?,?,?,?)')
            .bind(newGid, c.id, newName, seq++));
          createdGroups.push({ id: newGid, name: newName });
        }
        await db.batch(newGroupStmts);
        candidateGroups = createdGroups;
      }

      const stmts = [];
      const shuffled = shuffle(unassignedStudents);
      const groupCounts = {};
      candidateGroups.forEach(g => {
        groupCounts[g.id] = membersOf(c, g.id).length;
      });

      for (const s of shuffled) {
        // 依照候選組別目前人數由少到多排序
        const target = candidateGroups.slice().sort((a, b) => groupCounts[a.id] - groupCounts[b.id])[0];
        if (!target || groupCounts[target.id] >= max) {
          // 若所有候選組別皆已達人數上限，動態開新組收納剩餘組員
          const newGid = 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
          const newName = '第 ' + (c.groups.length + candidateGroups.length + 1) + ' 組';
          const seq = await nextSeq(db, 'groups', c.id);
          stmts.push(db.prepare('INSERT INTO groups (id, course_id, name, seq) VALUES (?,?,?,?)')
            .bind(newGid, c.id, newName, seq));
          const newG = { id: newGid, name: newName };
          candidateGroups.push(newG);
          groupCounts[newGid] = 1;
          s.groupId = newGid;
          s.autoAssigned = true;
          stmts.push(db.prepare('UPDATE students SET group_id=?, auto_assigned=1 WHERE course_id=? AND id=?').bind(newGid, c.id, s.id));
          continue;
        }

        groupCounts[target.id]++;
        s.groupId = target.id;
        s.autoAssigned = true;
        stmts.push(db.prepare('UPDATE students SET group_id=?, auto_assigned=1 WHERE course_id=? AND id=?').bind(target.id, c.id, s.id));
      }

      stmts.push(makeLogStmt(db, {
        courseId: c.id,
        operatorRole: 'teacher',
        operatorId: 'teacher',
        operatorName: '老師',
        actionType: 'teacher-auto-assign',
        detail: `老師執行系統隨機分配剩餘未分組學生（共分配 ${shuffled.length} 位學生至各組）`,
      }));

      if (stmts.length) await db.batch(stmts);
      return ok();
    }
    if (op === 'save-attendance-session') {
      const c = course(body.courseId);
      if (!c) return bad('課程不存在', 404);
      const date = String(body.date || '').trim();
      if (!date) return bad('請填寫點名日期', 400);
      const timeSlot = String(body.timeSlot || '').trim();
      const name = String(body.name || '').trim();
      const existing = body.id && (c.attendanceSessions || []).find(x => x.id === body.id);
      const id = existing ? existing.id : ('as' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
      await db.prepare(`
        INSERT INTO attendance_sessions (id, course_id, date, time_slot, name, created_at)
        VALUES (?,?,?,?,?,?)
        ON CONFLICT(course_id, id) DO UPDATE SET date=excluded.date, time_slot=excluded.time_slot, name=excluded.name
      `).bind(id, c.id, date, timeSlot, name, Date.now()).run();
      const isDaily = isDailySession({ id, name });
      const label = `${date}${timeSlot ? ` ${timeSlot}` : ''}${name ? ` ${name}` : (isDaily ? ' 一般日常點名' : '')}`;
      await logActivity(db, {
        courseId: c.id,
        operatorRole: 'teacher',
        operatorId: 'teacher',
        operatorName: '老師',
        actionType: 'attendance-session-save',
        detail: `老師${existing ? '修改' : '新增'}點名時段「${label}」`,
      });
      return ok({ sessionId: id });
    }
    if (op === 'del-attendance-session') {
      const c = course(body.courseId);
      if (!c) return bad('課程不存在', 404);
      const s = (c.attendanceSessions || []).find(x => x.id === body.sessionId);
      if (!s) return bad('點名時段不存在', 404);
      const isDaily = isDailySession(s);
      await db.batch([
        db.prepare('DELETE FROM attendance_records WHERE course_id=? AND session_id=?').bind(c.id, s.id),
        db.prepare('DELETE FROM attendance_unlocks WHERE course_id=? AND session_id=?').bind(c.id, s.id),
        db.prepare('DELETE FROM attendance_delegates WHERE course_id=? AND session_id=?').bind(c.id, s.id),
        db.prepare('DELETE FROM attendance_sessions WHERE course_id=? AND id=?').bind(c.id, s.id),
        makeLogStmt(db, {
          courseId: c.id,
          operatorRole: 'teacher',
          operatorId: 'teacher',
          operatorName: '老師',
          actionType: 'attendance-session-delete',
          detail: `老師刪除點名時段「${s.date}${s.timeSlot ? ` ${s.timeSlot}` : ''}${s.name ? ` ${s.name}` : (isDaily ? ' 一般日常點名' : '')}」及其所有點名紀錄`,
        }),
      ]);
      return ok();
    }
    if (op === 'set-attendance-unlock') {
      const c = course(body.courseId);
      if (!c) return bad('課程不存在', 404);
      const s = (c.attendanceSessions || []).find(x => x.id === body.sessionId);
      if (!s) return bad('點名時段不存在', 404);
      await ensureSessionInDb(db, c.id, s);
      const groupId = body.groupId ? String(body.groupId) : '';
      const g = groupId ? c.groups.find(x => x.id === groupId) : null;
      const scopeLabel = groupId ? `「${g ? g.name : groupId}」` : '全部組別';
      if (body.allow) {
        const deadline = body.deadline !== undefined ? String(body.deadline) : '';
        await db.prepare('INSERT OR REPLACE INTO attendance_unlocks (course_id, session_id, group_id, deadline, created_at) VALUES (?,?,?,?,?)')
          .bind(c.id, s.id, groupId, deadline, Date.now()).run();
        await logActivity(db, {
          courseId: c.id,
          groupId,
          groupName: g ? g.name : '',
          operatorRole: 'teacher',
          operatorId: 'teacher',
          operatorName: '老師',
          actionType: 'attendance-unlock',
          detail: `老師開放${scopeLabel}補登「${s.date}${s.timeSlot ? ` ${s.timeSlot}` : ''}」點名紀錄${deadline ? `（截止 ${deadline.replace('T', ' ')}）` : '（不限期）'}`,
        });
      } else {
        await db.prepare('DELETE FROM attendance_unlocks WHERE course_id=? AND session_id=? AND group_id=?').bind(c.id, s.id, groupId).run();
        await logActivity(db, {
          courseId: c.id,
          groupId,
          groupName: g ? g.name : '',
          operatorRole: 'teacher',
          operatorId: 'teacher',
          operatorName: '老師',
          actionType: 'attendance-unlock',
          detail: `老師關閉${scopeLabel}對「${s.date}${s.timeSlot ? ` ${s.timeSlot}` : ''}」的點名補登權限`,
        });
      }
      return ok();
    }
    if (op === 'set-attendance-delegate') {
      const c = course(body.courseId);
      if (!c) return bad('課程不存在', 404);
      const s = (c.attendanceSessions || []).find(x => x.id === body.sessionId);
      if (!s) return bad('點名時段不存在', 404);
      await ensureSessionInDb(db, c.id, s);
      const groupId = String(body.groupId || '');
      const g = c.groups.find(x => x.id === groupId);
      if (!g) return bad('組別不存在', 404);
      const delegate = await resolveStudent(db, env, c, body.delegateId);
      if (!delegate) return bad('找不到該學生', 404);
      const delegateGroup = c.groups.find(x => x.id === delegate.groupId);

      if (body.allow) {
        if (!delegate.isLeader && !delegate.isVice) return bad('僅能指定目前擔任組長或副組長的學生代理跨組點名', 400);
        if (delegate.groupId === groupId) return bad('該學生已屬於本組，無需代理', 400);
        await db.prepare('INSERT OR REPLACE INTO attendance_delegates (course_id, session_id, group_id, delegate_id, delegate_name, created_at) VALUES (?,?,?,?,?,?)')
          .bind(c.id, s.id, groupId, delegate.id, delegate.name, Date.now()).run();
        await logActivity(db, {
          courseId: c.id,
          groupId,
          groupName: g.name,
          operatorRole: 'teacher',
          operatorId: 'teacher',
          operatorName: '老師',
          actionType: 'attendance-delegate',
          targetId: delegate.id,
          targetName: delegate.name,
          detail: `老師授權 ${delegate.name} (${delegate.id})（原屬「${delegateGroup ? delegateGroup.name : '無組別'}」）跨組代理「${g.name}」於「${s.date}${s.timeSlot ? ` ${s.timeSlot}` : ''}」之點名`,
        });
      } else {
        await db.prepare('DELETE FROM attendance_delegates WHERE course_id=? AND session_id=? AND group_id=? AND delegate_id=?')
          .bind(c.id, s.id, groupId, delegate.id).run();
        await logActivity(db, {
          courseId: c.id,
          groupId,
          groupName: g.name,
          operatorRole: 'teacher',
          operatorId: 'teacher',
          operatorName: '老師',
          actionType: 'attendance-delegate',
          targetId: delegate.id,
          targetName: delegate.name,
          detail: `老師取消 ${delegate.name} (${delegate.id}) 跨組代理「${g.name}」於「${s.date}」之點名授權`,
        });
      }
      return ok();
    }
    if (op === 'clear-logs') {
      const c = course(body.courseId);
      if (!c) return bad('課程不存在', 404);
      await db.prepare('DELETE FROM activity_logs WHERE course_id = ?').bind(c.id).run();
      return ok();
    }
    return bad('未知操作 Unknown action: ' + op, 400);
  }

  /* ---- 學生（組長） ---- */
  if (!session || session.role !== 'student') return bad('請先登入 Sign in first', 401);
  const c = course(session.courseId);
  if (!c) return bad('課程不存在', 404);
  const self = c.students.find(s => s.id === session.id);
  if (!self) return bad('學生不存在', 404);

  const myGroup = self.groupId ? c.groups.find(g => g.id === self.groupId) : null;
  const canEdit = canGroupLeaderEdit(c, myGroup);

  if (action === 'change-student-password') {
    if (!self.isLeader && !self.isVice) return bad('僅組長或副組長可修改個人密碼 Leader or vice leader only（Chỉ nhóm trưởng hoặc nhóm phó mới có thể đổi mật khẩu）', 403);
    const current = String(body.current || '').trim();
    const next = String(body.next || '').trim();
    if (!current) return bad('請輸入目前密碼 Please enter current password（Vui lòng nhập mật khẩu hiện tại）', 400);
    if (next.length < 4) return bad('新密碼長度至少需 4 碼 Password must be at least 4 characters（Mật khẩu mới phải có ít nhất 4 ký tự）', 400);

    // 驗證目前密碼：若尚未修改過，預設密碼為學號
    let currentValid = false;
    if (self.password_hash) {
      currentValid = (await sha256(current)) === self.password_hash;
    } else {
      currentValid = current === self.id;
    }
    if (!currentValid) return bad('目前密碼不正確 Incorrect current password（Mật khẩu hiện tại không đúng. Lần đầu đổi hãy dùng mã SV）', 401);

    const newHash = await sha256(next);
    await db.prepare('UPDATE students SET password_hash=? WHERE course_id=? AND id=?')
      .bind(newHash, c.id, self.id).run();

    const roleLabel = self.isLeader ? '組長' : '副組長';
    const gName = myGroup ? `「${myGroup.name}」` : '';
    await logActivity(db, {
      courseId: c.id,
      groupId: self.groupId || '',
      groupName: myGroup ? myGroup.name : '',
      operatorRole: self.isLeader ? 'leader' : 'vice',
      operatorId: self.id,
      operatorName: self.name,
      actionType: 'password-change',
      targetId: self.id,
      targetName: self.name,
      detail: `${roleLabel} ${self.name} (${self.id}) 修改個人登入密碼`,
    });
    return ok();
  }

  if (action === 'claim-leader') {
    if (deadlinePassed(c)) return bad('已超過分組截止時間，無法再登記為組長 Deadline passed（Đã hết hạn chia nhóm, không thể đăng ký làm nhóm trưởng）', 403);
    let gid = self.groupId;
    let gName = '';
    const stmts = [];
    if (!gid) {
      const empty = c.groups.find(g => !membersOf(c, g.id).length);
      if (empty) {
        gid = empty.id;
        gName = empty.name;
      } else {
        gid = 'g' + Date.now().toString(36);
        gName = '第 ' + (c.groups.length + 1) + ' 組';
        const seq = await nextSeq(db, 'groups', c.id);
        stmts.push(db.prepare('INSERT INTO groups (id, course_id, name, seq) VALUES (?,?,?,?)')
          .bind(gid, c.id, gName, seq));
      }
    } else {
      const g = c.groups.find(x => x.id === gid);
      gName = g ? g.name : '';
    }
    if (membersOf(c, gid).some(m => m.isLeader && m.id !== self.id)) return bad('本組已有組長 This group already has a leader（Nhóm này đã có nhóm trưởng）', 409);
    stmts.push(db.prepare('UPDATE students SET group_id=?, is_leader=1, is_vice=0, auto_assigned=0 WHERE course_id=? AND id=?')
      .bind(gid, c.id, self.id));
    stmts.push(makeLogStmt(db, {
      courseId: c.id,
      groupId: gid,
      groupName: gName,
      operatorRole: 'leader',
      operatorId: self.id,
      operatorName: self.name,
      actionType: 'claim-leader',
      targetId: self.id,
      targetName: self.name,
      detail: `學生 ${self.name} (${self.id}) 登記為「${gName}」組長`,
    }));
    await db.batch(stmts);
    return ok();
  }
  if (action === 'unclaim-leader') {
    if (!canEdit) return bad('已超過分組截止時間，無法取消組長身分 Deadline passed（Đã hết hạn chia nhóm, không thể hủy quyền nhóm trưởng）', 403);
    const g = c.groups.find(x => x.id === self.groupId);
    const gName = g ? g.name : '';
    const vice = membersOf(c, self.groupId).find(m => m.isVice && m.id !== self.id);
    if (vice) {
      // 副組長自動晉級組長，原組長退為一般組員
      await db.batch([
        db.prepare('UPDATE students SET is_leader=0 WHERE course_id=? AND id=?').bind(c.id, self.id),
        db.prepare('UPDATE students SET is_leader=1, is_vice=0 WHERE course_id=? AND id=?').bind(c.id, vice.id),
        makeLogStmt(db, {
          courseId: c.id,
          groupId: self.groupId,
          groupName: gName,
          operatorRole: 'leader',
          operatorId: self.id,
          operatorName: self.name,
          actionType: 'unclaim-leader',
          targetId: vice.id,
          targetName: vice.name,
          detail: `組長 ${self.name} (${self.id}) 放棄組長身分，副組長 ${vice.name} (${vice.id}) 自動晉級為「${gName}」組長`,
        }),
      ]);
    } else {
      await db.batch([
        db.prepare('UPDATE students SET is_leader=0 WHERE course_id=? AND id=?').bind(c.id, self.id),
        makeLogStmt(db, {
          courseId: c.id,
          groupId: self.groupId,
          groupName: gName,
          operatorRole: 'leader',
          operatorId: self.id,
          operatorName: self.name,
          actionType: 'unclaim-leader',
          targetId: self.id,
          targetName: self.name,
          detail: `組長 ${self.name} (${self.id}) 放棄「${gName}」組長身分`,
        }),
      ]);
    }
    return ok();
  }
  if (action === 'submit-peer-eval') {
    if (!self.isLeader) return bad('僅組長可進行評分 Leader only（Chỉ nhóm trưởng mới có thể đánh giá）', 403);
    if (!myGroup) return bad('尚未加入組別 Not in a group（Chưa vào nhóm）', 400);
    if (!myGroup.peerEvalOpen) return bad('老師尚未開放本組組長評分權限 Peer evaluation is not open（Giáo viên chưa mở quyền đánh giá cho nhóm này）', 403);
    if (evalDeadlinePassed(myGroup)) return bad('組長評分截止時間已過，無法再提交評分 Deadline passed（Đã quá hạn đánh giá, không thể nộp điểm）', 403);

    const evaluations = Array.isArray(body.evaluations) ? body.evaluations : [];
    const maxB = Number(c.maxBonus) > 0 ? Number(c.maxBonus) : 10;
    const stmts = [];
    for (const ev of evaluations) {
      const target = await resolveStudent(db, env, c, ev.studentId);
      if (!target || target.groupId !== self.groupId || target.id === self.id) continue;
      const bonus = Math.max(0, Math.min(maxB, parseInt(ev.penalty) || 0));
      const comment = String(ev.comment || '').trim().slice(0, 100);
      stmts.push(db.prepare('UPDATE students SET peer_penalty=?, peer_comment=? WHERE course_id=? AND id=?')
        .bind(bonus, comment, c.id, target.id));
    }
    // 標記該組組長已完成送出評分
    stmts.push(db.prepare('UPDATE groups SET peer_eval_submitted=1 WHERE course_id=? AND id=?')
      .bind(c.id, self.groupId));
    stmts.push(makeLogStmt(db, {
      courseId: c.id,
      groupId: self.groupId,
      groupName: myGroup.name,
      operatorRole: 'leader',
      operatorId: self.id,
      operatorName: self.name,
      actionType: 'peer-eval',
      detail: `組長 ${self.name} (${self.id}) 完成送出「${myGroup.name}」期末組長評分`,
    }));
    if (stmts.length) await db.batch(stmts);
    return ok();
  }
  if (action === 'mark-attendance') {
    if (!self.isLeader && !self.isVice) return bad('僅組長或副組長可執行點名 Leader or vice leader only（Chỉ nhóm trưởng hoặc nhóm phó mới có thể điểm danh）', 403);
    const today = todayDateStr();
    let session = (c.attendanceSessions || []).find(x => x.id === body.sessionId);
    if (!session && (body.sessionId === `daily-${today}` || body.sessionId === 'daily')) {
      session = { id: `daily-${today}`, courseId: c.id, date: today, timeSlot: '', name: '一般日常點名', isDaily: true, createdAt: Date.now() };
    }
    if (!session) return bad('點名時段不存在 Session not found（Buổi điểm danh không tồn tại）', 404);

    const targetGroupId = body.groupId ? String(body.groupId) : self.groupId;
    if (!targetGroupId) return bad('尚未加入組別 Not in a group（Chưa vào nhóm）', 400);

    let isDelegate = false;
    if (targetGroupId !== self.groupId) {
      isDelegate = (c.attendanceDelegates || []).some(d => d.sessionId === session.id && d.groupId === targetGroupId && d.delegateId === self.id);
      if (!isDelegate) return bad('您未被授權代理該組點名 Not authorized to mark for this group（Bạn chưa được ủy quyền điểm danh nhóm này）', 403);
    }
    if (!isDelegate && !isAttendanceEditable(session, c.attendanceUnlocks || [], targetGroupId)) {
      return bad('已超過當日，點名紀錄已鎖定，需老師開放補登權限 Locked, ask teacher to unlock（Đã qua ngày, bản điểm danh đã khóa, cần nhờ giáo viên mở quyền）', 403);
    }

    // 確保點名時段已持久化至資料庫（特別是當日自動生成的日常點名時段）
    await ensureSessionInDb(db, c.id, session);

    const g = c.groups.find(x => x.id === targetGroupId);
    const gName = g ? g.name : '';
    const selfGroup = c.groups.find(x => x.id === self.groupId);
    const existingByStudent = {};
    (c.attendanceRecords || [])
      .filter(r => r.sessionId === session.id && r.groupId === targetGroupId)
      .forEach(r => { existingByStudent[r.studentId] = { status: r.status, createdAt: r.createdAt }; });

    const now = Date.now();
    const roleLabel = self.isLeader ? '組長' : '副組長';
    const delegateNote = isDelegate ? `（跨組代理，原屬「${selfGroup ? selfGroup.name : ''}」）` : '';
    const isDaily = isDailySession(session);
    const sessionLabel = isDaily
      ? `${session.date}「一般日常點名」`
      : `${session.date}${session.timeSlot ? ` ${session.timeSlot}` : ''}${session.name ? `「${session.name}」` : ''}`;
    const stmts = [];
    for (const rec of (Array.isArray(body.records) ? body.records : [])) {
      const t = await resolveStudent(db, env, c, rec.studentId);
      if (!t || t.groupId !== targetGroupId) continue;
      const status = rec.status === 'absent' ? 'absent' : 'present';
      const prior = existingByStudent[t.id];
      const createdAt = prior ? prior.createdAt : now;
      stmts.push(db.prepare(`
        INSERT OR REPLACE INTO attendance_records
          (course_id, session_id, student_id, group_id, status, marked_by_id, marked_by_name, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?)
      `).bind(c.id, session.id, t.id, targetGroupId, status, self.id, self.name, createdAt, now));

      if (!prior) {
        stmts.push(makeLogStmt(db, {
          courseId: c.id,
          groupId: targetGroupId,
          groupName: gName,
          operatorRole: self.isLeader ? 'leader' : 'vice',
          operatorId: self.id,
          operatorName: self.name,
          actionType: 'attendance-mark',
          targetId: t.id,
          targetName: t.name,
          detail: `${roleLabel} ${self.name} (${self.id})${delegateNote} 於「${gName}」${sessionLabel}點名，將 ${t.name} (${t.id}) 標記為「${status === 'absent' ? '缺席' : '出席'}」`,
          createdAt: now,
        }));
      } else if (prior.status !== status) {
        stmts.push(makeLogStmt(db, {
          courseId: c.id,
          groupId: targetGroupId,
          groupName: gName,
          operatorRole: self.isLeader ? 'leader' : 'vice',
          operatorId: self.id,
          operatorName: self.name,
          actionType: 'attendance-correct',
          targetId: t.id,
          targetName: t.name,
          detail: `${roleLabel} ${self.name} (${self.id})${delegateNote} 修正「${gName}」${sessionLabel}點名紀錄，將 ${t.name} (${t.id}) 由「${prior.status === 'absent' ? '缺席' : '出席'}」改為「${status === 'absent' ? '缺席' : '出席'}」`,
          createdAt: now,
        }));
      }
    }
    if (stmts.length) await db.batch(stmts);
    return ok();
  }

  if (!self.isLeader) return bad('僅組長可操作 Leader only（Chỉ nhóm trưởng mới có thể thao tác）', 403);
  if (!canEdit) return bad('已超過分組截止時間，組長不得更換組員 Deadline passed（Đã hết hạn chia nhóm, nhóm trưởng không thể đổi thành viên）', 403);

  if (action === 'pick') {
    const curMembers = membersOf(c, self.groupId);
    const max = cap(c);
    if (curMembers.length >= max) {
      return bad(`本組現有成員數（${curMembers.length} 人）已達或高於上限（${max} 人），組長只能刪減組員釋出至未分配名單，無法再新增組員。Group is full（Nhóm đã đủ hoặc vượt quá số lượng tối đa ${max} người, chỉ có thể loại bớt, không thể thêm thành viên）。`, 409);
    }
    const t = await resolveStudent(db, env, c, body.studentId);
    if (!t) return bad('學生不存在 Student not found（Sinh viên không tồn tại）', 404);
    if (t.groupId) return bad('該生已被分組 Already assigned（Sinh viên này đã vào nhóm khác）', 409);
    const g = myGroup || c.groups.find(x => x.id === self.groupId);
    const gName = g ? g.name : '';
    const detail = `組長 ${self.name} (${self.id}) 將組員 ${t.name} (${t.id}) 加入「${gName}」`;
    await db.batch([
      db.prepare('UPDATE students SET group_id=?, auto_assigned=0 WHERE course_id=? AND id=?')
        .bind(self.groupId, c.id, t.id),
      makeLogStmt(db, {
        courseId: c.id,
        groupId: self.groupId,
        groupName: gName,
        operatorRole: 'leader',
        operatorId: self.id,
        operatorName: self.name,
        actionType: 'pick',
        targetId: t.id,
        targetName: t.name,
        detail,
      }),
    ]);
    return ok();
  }
  if (action === 'drop') {
    const curMembers = membersOf(c, self.groupId);
    const min = minCap(c);
    if (curMembers.length <= min) {
      return bad(`本組現有成員數（${curMembers.length} 人）已低於或等於下限（${min} 人），組長只能新增組員，無法再刪減成員。Group is at minimum size（Nhóm đang ở mức tối thiểu ${min} người, chỉ có thể thêm, không thể loại bớt thành viên）。`, 400);
    }
    const t = await resolveStudent(db, env, c, body.studentId);
    if (!t || t.groupId !== self.groupId || t.id === self.id) return bad('無法移出該學生 Cannot remove student（Không thể loại sinh viên này）', 400);
    const g = myGroup || c.groups.find(x => x.id === self.groupId);
    const gName = g ? g.name : '';
    const detail = `組長 ${self.name} (${self.id}) 將組員 ${t.name} (${t.id}) 釋出至未分組名單（原組別：「${gName}」）`;
    await db.batch([
      db.prepare('UPDATE students SET group_id=NULL, is_vice=0, auto_assigned=0 WHERE course_id=? AND id=?')
        .bind(c.id, t.id),
      makeLogStmt(db, {
        courseId: c.id,
        groupId: self.groupId,
        groupName: gName,
        operatorRole: 'leader',
        operatorId: self.id,
        operatorName: self.name,
        actionType: 'drop',
        targetId: t.id,
        targetName: t.name,
        detail,
      }),
    ]);
    return ok();
  }
  if (action === 'toggle-vice') {
    const t = await resolveStudent(db, env, c, body.studentId);
    if (!t || t.groupId !== self.groupId || t.id === self.id) return bad('無法指定該學生', 400);
    const on = t.isVice ? 0 : 1;
    const g = myGroup || c.groups.find(x => x.id === self.groupId);
    const gName = g ? g.name : '';
    const detail = `組長 ${self.name} (${self.id}) ${on ? '指定' : '取消'} ${t.name} (${t.id}) 為「${gName}」副組長`;
    await db.batch([
      db.prepare('UPDATE students SET is_vice=0 WHERE course_id=? AND group_id=?').bind(c.id, self.groupId),
      db.prepare('UPDATE students SET is_vice=? WHERE course_id=? AND id=?').bind(on, c.id, t.id),
      makeLogStmt(db, {
        courseId: c.id,
        groupId: self.groupId,
        groupName: gName,
        operatorRole: 'leader',
        operatorId: self.id,
        operatorName: self.name,
        actionType: 'toggle-vice',
        targetId: t.id,
        targetName: t.name,
        detail,
      }),
    ]);
    return ok();
  }
  return bad('未知操作 Unknown action: ' + action, 400);
}
