import {
  json, bad, sha256, makeToken, readSession, sessionCookie, clearCookie,
  loadState, cap, membersOf, deadlinePassed, shuffle, teacherHash, nextSeq,
  applyDeadline, publicize, resolveStudent,
} from './lib.js';

/* GET /api/state — 公開讀取全部課程／名單／分組 */
export async function handleState(request, env, db) {
  const session = await readSession(db, env, request);
  const courses = await applyDeadline(db, await loadState(db));
  return json({ courses: await publicize(db, env, courses, session), session });
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
    return json({ ok: true, courses: await publicize(db, env, await loadState(db), view), ...extra }, 200, headers);
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
    const s = c.students.find(x => x.name === String(body.name || '').trim() && x.id === String(body.sid || '').trim());
    if (!s) return bad('姓名或學號不正確，或不在本課程修課名單中', 401);
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
    if (op === 'save-course') {
      const exists = course(body.id);
      const id = exists ? body.id : ('c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
      const args = [body.year || '', body.subject || '', Number(body.groupSize) || 4, Number(body.tolerance) || 0, body.deadline || ''];
      if (exists) {
        await db.prepare('UPDATE courses SET year=?, subject=?, group_size=?, tolerance=?, deadline=? WHERE id=?').bind(...args, id).run();
      } else {
        await db.prepare('INSERT INTO courses (id, year, subject, group_size, tolerance, deadline, created_at) VALUES (?,?,?,?,?,?,?)')
          .bind(id, ...args, Date.now()).run();
      }
      return ok({ courseId: id });
    }
    if (op === 'del-course') {
      await db.batch([
        db.prepare('DELETE FROM students WHERE course_id = ?').bind(body.courseId),
        db.prepare('DELETE FROM groups WHERE course_id = ?').bind(body.courseId),
        db.prepare('DELETE FROM courses WHERE id = ?').bind(body.courseId),
      ]);
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
      await db.prepare('UPDATE students SET group_id=?, auto_assigned=0, is_leader=CASE WHEN ? IS NULL THEN 0 ELSE is_leader END, is_vice=CASE WHEN ? IS NULL THEN 0 ELSE is_vice END WHERE course_id=? AND id=?')
        .bind(gid, gid, gid, c.id, s.id).run();
      return ok();
    }
    if (op === 'set-leader') {
      const c = course(body.courseId);
      const s = c && await resolveStudent(db, env, c, body.studentId);
      if (!s || !s.groupId) return bad('學生未分組', 400);
      const on = body.on ? 1 : 0;
      await db.batch([
        db.prepare('UPDATE students SET is_leader=0 WHERE course_id=? AND group_id=?').bind(c.id, s.groupId),
        db.prepare('UPDATE students SET is_leader=?, is_vice=CASE WHEN ?=1 THEN 0 ELSE is_vice END WHERE course_id=? AND id=?')
          .bind(on, on, c.id, s.id),
      ]);
      return ok();
    }
    if (op === 'make-groups') {
      const c = course(body.courseId);
      if (!c) return bad('課程不存在', 404);
      const n = Math.max(1, Math.ceil(c.students.length / Math.max(1, c.groupSize)));
      const stmts = [
        db.prepare('DELETE FROM groups WHERE course_id = ?').bind(c.id),
        db.prepare('UPDATE students SET group_id=NULL, is_leader=0, is_vice=0, auto_assigned=0 WHERE course_id=?').bind(c.id),
      ];
      for (let i = 1; i <= n; i++) {
        stmts.push(db.prepare('INSERT INTO groups (id, course_id, name, seq) VALUES (?,?,?,?)')
          .bind('g' + i, c.id, '第 ' + i + ' 組', i));
      }
      await db.batch(stmts);
      return ok();
    }
    if (op === 'add-group') {
      const c = course(body.courseId);
      if (!c) return bad('課程不存在', 404);
      const seq = await nextSeq(db, 'groups', c.id);
      await db.prepare('INSERT INTO groups (id, course_id, name, seq) VALUES (?,?,?,?)')
        .bind('g' + Date.now().toString(36), c.id, '第 ' + (c.groups.length + 1) + ' 組', seq).run();
      return ok();
    }
    if (op === 'clear-groups') {
      await db.batch([
        db.prepare('DELETE FROM groups WHERE course_id = ?').bind(body.courseId),
        db.prepare('UPDATE students SET group_id=NULL, is_leader=0, is_vice=0, auto_assigned=0 WHERE course_id=?').bind(body.courseId),
      ]);
      return ok();
    }
    if (op === 'toggle-group-edit') {
      const c = course(body.courseId);
      if (!c) return bad('課程不存在', 404);
      const g = c.groups.find(x => x.id === body.groupId);
      if (!g) return bad('組別不存在', 404);
      const allow = body.allowEdit ? 1 : 0;
      await db.prepare('UPDATE groups SET allow_edit=? WHERE course_id=? AND id=?')
        .bind(allow, c.id, g.id).run();
      return ok();
    }
    if (op === 'auto-assign') {
      const c = course(body.courseId);
      if (!c || !c.groups.length) return bad('請先建立組別', 400);
      const stmts = [];
      for (const s of shuffle(c.students.filter(x => !x.groupId))) {
        const target = c.groups.slice().sort((a, b) => membersOf(c, a.id).length - membersOf(c, b.id).length)[0];
        if (!target || membersOf(c, target.id).length >= cap(c)) continue;
        s.groupId = target.id; s.autoAssigned = true;
        stmts.push(db.prepare('UPDATE students SET group_id=?, auto_assigned=1 WHERE course_id=? AND id=?').bind(target.id, c.id, s.id));
      }
      if (stmts.length) await db.batch(stmts);
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
  const canEdit = !deadlinePassed(c) || (myGroup && myGroup.allowEdit);

  if (action === 'claim-leader') {
    if (deadlinePassed(c)) return bad('已超過分組時限，無法再登記為組長 Deadline passed', 403);
    let gid = self.groupId;
    if (!gid) {
      const empty = c.groups.find(g => !membersOf(c, g.id).length);
      if (empty) gid = empty.id;
      else {
        gid = 'g' + Date.now().toString(36);
        const seq = await nextSeq(db, 'groups', c.id);
        await db.prepare('INSERT INTO groups (id, course_id, name, seq) VALUES (?,?,?,?)')
          .bind(gid, c.id, '第 ' + (c.groups.length + 1) + ' 組', seq).run();
      }
    }
    if (membersOf(c, gid).some(m => m.isLeader && m.id !== self.id)) return bad('本組已有組長 This group already has a leader', 409);
    await db.prepare('UPDATE students SET group_id=?, is_leader=1, is_vice=0, auto_assigned=0 WHERE course_id=? AND id=?')
      .bind(gid, c.id, self.id).run();
    return ok();
  }
  if (action === 'unclaim-leader') {
    if (!canEdit) return bad('已超過分組時限，無法取消組長身分 Deadline passed', 403);
    await db.prepare('UPDATE students SET is_leader=0 WHERE course_id=? AND id=?').bind(c.id, self.id).run();
    return ok();
  }
  if (!self.isLeader) return bad('僅組長可操作 Leader only', 403);
  if (!canEdit) return bad('已超過分組時限，組長不得更換組員（需由老師個別開放權限或手動調整）Deadline passed', 403);

  if (action === 'pick') {
    const t = await resolveStudent(db, env, c, body.studentId);
    if (!t) return bad('學生不存在', 404);
    if (t.groupId) return bad('該生已被分組 Already assigned', 409);
    if (membersOf(c, self.groupId).length >= cap(c)) return bad(`本組已達上限 ${cap(c)} 人`, 409);
    await db.prepare('UPDATE students SET group_id=?, auto_assigned=0 WHERE course_id=? AND id=?')
      .bind(self.groupId, c.id, t.id).run();
    return ok();
  }
  if (action === 'drop') {
    const t = await resolveStudent(db, env, c, body.studentId);
    if (!t || t.groupId !== self.groupId || t.id === self.id) return bad('無法移出該學生', 400);
    await db.prepare('UPDATE students SET group_id=NULL, is_vice=0, auto_assigned=0 WHERE course_id=? AND id=?')
      .bind(c.id, t.id).run();
    return ok();
  }
  if (action === 'toggle-vice') {
    const t = await resolveStudent(db, env, c, body.studentId);
    if (!t || t.groupId !== self.groupId || t.id === self.id) return bad('無法指定該學生', 400);
    const on = t.isVice ? 0 : 1;
    await db.batch([
      db.prepare('UPDATE students SET is_vice=0 WHERE course_id=? AND group_id=?').bind(c.id, self.groupId),
      db.prepare('UPDATE students SET is_vice=? WHERE course_id=? AND id=?').bind(on, c.id, t.id),
    ]);
    return ok();
  }
  return bad('未知操作 Unknown action: ' + action, 400);
}
