/* 113入學行銷真班分組系統 Group My Class — 單頁前端，狀態存於 Cloudflare D1 */
const APP_NAME = '113入學行銷真班分組系統';
let APP_VERSION = 'v2.47';   // 顯示於前台標題列，隨後端 API 自動同步更新

const CURRENT_KEY = 'groupmyclass_current_course';   // 僅記住「目前檢視哪一門課」，其餘資料都在伺服器
const PREVIEW_KEY = 'groupmyclass_teacher_preview_mode'; // 記住老師切換之視角模式，重新整理不遺失
const POLL_MS = 5000;

let state = {
  courses: [],
  session: null,
  currentId: localStorage.getItem(CURRENT_KEY) || null,
};
let loginMode = null;   // 前台登入區：null | 'student' | 'teacher'
let teacherView = 'course';   // 後台主區：'course' | 'settings' | 'eval' | 'logs'
let teacherPreviewMode = localStorage.getItem(PREVIEW_KEY) || 'admin';  // 老師預覽模式：'admin' | 'public' | 'leader'
let logActionFilter = 'all';  // 異動日誌類別過濾：'all' | 'pick' | 'drop' | 'leader' | 'teacher' | 'system' | 'attendance'
let logSearchText = '';       // 異動日誌搜尋關鍵字
let attendanceEditingId = null;     // 後台目前正在編輯的點名時段 id（null＝新增模式）
let attendanceStatScope = 'date';   // 缺席統計範圍：'date'（依日期）| 'all'（整學期）
let attendanceStatDate = '';        // 缺席統計所選日期，預設為今天
let attendanceProgressSessionId = ''; // 尚未完成點名排行所選時段，預設為最新時段
let busy = false;
let lastSig = '';

/* ===== API ===== */
async function apiGet() {
  const r = await fetch('/api/state', { credentials: 'same-origin', headers: { 'cache-control': 'no-cache' } });
  if (!r.ok) throw new Error('讀取資料失敗 (' + r.status + ')');
  return r.json();
}

async function apiPost(action, payload = {}) {
  const r = await fetch('/api/action', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...payload }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || ('操作失敗 (' + r.status + ')'));
  return data;
}

/* 套用伺服器回傳的資料 */
function apply(data) {
  if (data.version) APP_VERSION = data.version;
  if (data.courses) state.courses = data.courses;
  if (data.session !== undefined) state.session = data.session;
  if (state.session && state.session.role === 'student') state.currentId = state.session.courseId;
  if (!state.courses.some(c => c.id === state.currentId)) {
    state.currentId = state.courses.length ? state.courses[0].id : null;
  }
  if (state.currentId) localStorage.setItem(CURRENT_KEY, state.currentId);
  lastSig = JSON.stringify(data.courses || []);
}

/* 送出一個動作，成功後重繪 */
async function act(action, payload = {}, opts = {}) {
  if (busy) return null;
  busy = true;
  try {
    const data = await apiPost(action, payload);
    apply(data);
    if (opts.after) opts.after(data);
    render();
    return data;
  } catch (err) {
    alert(err.message);
    return null;
  } finally {
    busy = false;
  }
}

/* 背景輪詢：其他人的異動會自動出現 */
async function poll() {
  if (busy || document.hidden) return;
  try {
    const data = await apiGet();
    const sig = JSON.stringify(data.courses || []);
    const sessionChanged = JSON.stringify(data.session || null) !== JSON.stringify(state.session || null);
    const versionChanged = data.version && data.version !== APP_VERSION;
    if (sig !== lastSig || sessionChanged || versionChanged) { apply(data); render(); }
  } catch (e) { /* 網路暫時失敗就略過這輪 */ }
}

/* ===== Course helpers ===== */
const courseById = id => state.courses.find(c => c.id === id) || null;
function cur() {   // 目前檢視中的課程
  if (state.session && state.session.role === 'student') return courseById(state.session.courseId);
  return courseById(state.currentId);
}
const courseLabel = c => [c.year, c.subject].filter(Boolean).join(' · ') || '（未命名課程）';

/* ===== Helpers（皆以某課程為範圍） ===== */
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cap = c => Number(c.groupSize) + Number(c.tolerance);
const minCap = c => Math.max(1, Number(c.groupSize) - Number(c.tolerance));
const rank = s => s.isLeader ? 0 : s.isVice ? 1 : 2;
/* 組長排最前、副組長次之，其餘維持名單順序 */
const members = (c, gid) => c.students.filter(s => s.groupId === gid)
  .map((s, i) => ({ s, i }))
  .sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i)
  .map(x => x.s);
const unassigned = c => c.students.filter(s => !s.groupId);
const findStudent = (c, id) => c.students.find(s => s.id === id || s.ref === id);
const keyOf = s => s.ref || s.id;   // 送給後端的識別碼
const leaderOf = (c, gid) => members(c, gid).find(s => s.isLeader);
function me() {
  const c = cur();
  if (!c) return null;
  if (state.session && state.session.role === 'student') return findStudent(c, state.session.id);
  // 若老師處於組長預覽模式，模擬當前課程的第一位組長或成員
  if (state.session && state.session.role === 'teacher' && teacherPreviewMode === 'leader') {
    const lead = c.students.find(s => s.isLeader && s.groupId);
    if (lead) return lead;
    // 若尚未有組長，則找任一有組別的學生或第一位學生模擬
    const anyStudent = c.students.find(s => s.groupId) || c.students[0];
    if (anyStudent) return { ...anyStudent, isLeader: true };
    return { id: 'preview-lead', name: '預覽組長(測試)', isLeader: true, groupId: c.groups[0]?.id || null };
  }
  return null;
}
const teacherPasswordHint = '預設 clear6，可於後台修改';

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

const parseDate = str => {
  if (!str) return 0;
  const s = String(str).trim();
  if (s.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(s)) {
    return new Date(s).getTime();
  }
  return new Date(s.replace(' ', 'T') + '+08:00').getTime();
};

const formatDeadline = str => {
  if (!str) return '';
  return str.replace('T', ' ');
};

const deadlinePassed = c => !!c.deadline && Date.now() > parseDate(c.deadline);
const evalDeadlinePassed = g => !!g.peerEvalDeadline && Date.now() > parseDate(g.peerEvalDeadline);
const editDeadlinePassed = g => !!g.editDeadline && Date.now() > parseDate(g.editDeadline);
function canGroupLeaderEdit(c, g) {
  if (!c) return false;
  if (!deadlinePassed(c)) return true;
  if (!g || !g.allowEdit) return false;
  if (g.editDeadline && editDeadlinePassed(g)) return false;
  return true;
}

/* ===== 點名 Attendance（Điểm danh）helpers ===== */
const todayDateStr = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);

/* 判斷點名時段是否為一般日常點名 */
function isDailySession(s) {
  if (!s) return false;
  if (s.isDaily) return true;
  if (s.id && String(s.id).startsWith('daily-')) return true;
  if (s.name === '一般日常點名' || s.name === '日常點名') return true;
  return false;
}

function attendanceSessions(c) {
  const today = todayDateStr();
  const list = (c.attendanceSessions || []).slice();
  const hasTodayDaily = list.some(x => x.date === today && isDailySession(x));
  if (!hasTodayDaily) {
    list.unshift({
      id: `daily-${today}`,
      courseId: c.id,
      date: today,
      timeSlot: '',
      name: '一般日常點名',
      isDaily: true,
      createdAt: 0,
    });
  }
  return list.sort((a, b) =>
    a.date < b.date ? 1 : a.date > b.date ? -1 : (b.createdAt || 0) - (a.createdAt || 0));
}
/* 老師視角的紀錄沒有 ref（用真實學號），這裡統一補上 ref 別名，讓組長面板可共用同一套比對邏輯 */
const attendanceRecordsFor = (c, sessionId) => (c.attendanceRecords || [])
  .filter(r => r.sessionId === sessionId)
  .map(r => ({ ...r, ref: r.ref || r.studentId }));
function attendanceUnlockFor(c, sessionId, groupId) {
  const now = Date.now();
  return (c.attendanceUnlocks || []).find(u => u.sessionId === sessionId
    && (u.groupId === groupId || u.groupId === '')
    && (!u.deadline || parseDate(u.deadline) > now)) || null;
}
function isAttendanceEditable(c, session, groupId) {
  if (!session) return false;
  if (session.date === todayDateStr()) return true;
  return !!attendanceUnlockFor(c, session.id, groupId);
}
const attendanceSessionLabel = s => {
  if (!s) return '';
  const isDaily = isDailySession(s);
  const namePart = isDaily ? '一般日常點名' : s.name;
  return [s.date, s.timeSlot, namePart].filter(Boolean).join(' · ');
};
/* 老師視角：某時段各組完成度（是否已為全部現有組員留下紀錄），並列出尚未被點名的組員（含組長／副組長） */
function attendanceGroupProgress(c, sessionId) {
  const recs = attendanceRecordsFor(c, sessionId).filter(r => r.status === 'present' || r.status === 'absent');
  return c.groups.map(g => {
    const mates = members(c, g.id);
    const recordedIds = new Set(recs.filter(r => r.groupId === g.id).map(r => r.studentId));
    const missing = mates.filter(m => !recordedIds.has(m.id));
    const total = mates.length;
    const done = total - missing.length;
    return { group: g, total, done, missing, complete: total > 0 && missing.length === 0 };
  });
}
/* 老師視角：依日期或整學期（全部時段）統計各組員缺席次數 */
function attendanceAbsentCounts(c, date) {
  const ids = attendanceSessions(c).filter(s => !date || s.date === date).map(s => s.id);
  const counts = {};
  (c.attendanceRecords || []).forEach(r => {
    if (r.status !== 'absent' || !ids.includes(r.sessionId)) return;
    counts[r.studentId] = (counts[r.studentId] || 0) + 1;
  });
  return counts;
}

/* 計算每位同學的期末考調分 */
function calcAdjustment(c, g, s) {
  if (s.adjustment) return s.adjustment;
  if (!s.groupId || !g) return { score: 0, tag: '未分組', reason: '尚未加入組別，無期末考調分', status: 'none' };
  const lead = c.students.find(x => x.groupId === g.id && x.isLeader);

  if (!lead) {
    return { score: -10, tag: '-10分', reason: '超過分組截止時間無組長，全員期末考扣 10 分', status: 'no-leader' };
  }

  const maxB = Number(c && c.maxBonus) > 0 ? Number(c.maxBonus) : 10;
  const isEvalOpen = !!g.peerEvalOpen;
  const isSubmitted = !!g.peerEvalSubmitted;
  const isOverdue = isEvalOpen && evalDeadlinePassed(g) && !isSubmitted;

  if (isSubmitted) {
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
    if (s.isLeader) {
      return { score: 0, tag: '±0分', reason: `組長未於評分截止時間前進行評分，無法獲得 ${maxB} 分加分`, status: 'leader-overdue' };
    } else {
      return { score: 0, tag: '±0分', reason: '組長逾時未進行評分，組員無法獲得加分', status: 'member-overdue' };
    }
  }

  if (isEvalOpen) {
    if (s.isLeader) {
      return { score: 0, tag: '評分中', reason: `組長評分進行中（完成評分後組長自己可獲得 ${maxB} 分加分）`, status: 'leader-pending' };
    } else {
      return { score: 0, tag: '評分中', reason: `組長評分進行中（組長可依貢獻度給予 0~${maxB} 分加分）`, status: 'member-pending' };
    }
  }

  if (s.isLeader) {
    return { score: 0, tag: '待開放', reason: `待老師開放評分權限並完成評分後，組長可獲得 ${maxB} 分加分`, status: 'leader-pending' };
  } else {
    return { score: 0, tag: '待開放', reason: `待老師開放評分權限後，組長可依貢獻度給予 0~${maxB} 分加分`, status: 'member-pending' };
  }
}

function scoreBadge(adj) {
  if (!adj || adj.status === 'none') return '';
  const cls = adj.score > 0 ? 'positive' : adj.score < 0 ? 'negative' : 'neutral';
  return `<span class="score-pill ${cls}" title="${esc(adj.reason)}">期末 ${esc(adj.tag)}</span>`;
}

/* ===== 前台分組現況 ===== */
function unassignedList(c) {
  const pool = unassigned(c);
  const showLoginPrompt = !state.session || (state.session && state.session.role !== 'student');
  return `
  ${showLoginPrompt && pool.length ? `
    <div class="unassigned-login-tip" style="margin-bottom:0.75rem;padding:0.6rem 0.85rem;background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px;font-size:0.85rem;color:#1e40af;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.5rem;">
      <span>💡 未分組學生若欲擔任組長開組，請直接點選下方姓名或點擊登入：</span>
      <button class="btn btn-primary" data-act="show-student-login" style="padding:0.3rem 0.75rem;font-size:0.82rem;">🎓 登入開組（帳號、密碼）</button>
    </div>
  ` : ''}
  <div class="pick-list">${pool.length
    ? pool.map(s => {
        if (showLoginPrompt) {
          return `<div class="student student-clickable-login" data-act="quick-student-fill" data-name="${esc(s.name)}" data-id="${esc(s.id)}" title="點擊以此身分登入擔任組長" style="cursor:pointer;">${esc(s.name)} (${esc(s.id)}) <span class="login-chip" style="margin-left:auto;font-size:0.72rem;background:#dbeafe;color:#1d4ed8;padding:0.1rem 0.4rem;border-radius:4px;">登入開組 ➔</span></div>`;
        }
        return `<div class="student">${esc(s.name)} (${esc(s.id)})</div>`;
      }).join('')
    : '<p class="file-path">全部學生皆已分組 Everyone is assigned.</p>'}</div>`;
}

function publicBoard({ withUnassigned = true } = {}) {
  const c = cur();
  const pool = c ? unassigned(c) : [];
  const self = me();
  const closed = c ? deadlinePassed(c) : false;
  const myGroup = (c && self && self.groupId) ? c.groups.find(x => x.id === self.groupId) : null;
  const canEdit = canGroupLeaderEdit(c, myGroup);
  // 若為組長且已截止且老師未開放調整權限，則隱藏未分組名單區塊
  const isLeader = self && self.isLeader;
  const hideUnassignedForLeader = isLeader && closed && !canEdit;

  // 若為組長登入狀態（或老師切換至組長預覽模式），因為組長已登入挑選，故移除「Step 2」步驟標籤
  const isLeaderView = isLeader || (state.session && state.session.role === 'teacher' && teacherPreviewMode === 'leader');

  return `
  <section class="block-section group-status-section" id="group-status-block">
    <div class="block-header">
      <div class="block-title-wrap">
        ${!isLeaderView ? '<span class="step-badge">Step 2</span>' : ''}
        <h2>分組現況 Group status</h2>
      </div>
      ${(!state.session || (state.session && state.session.role !== 'student')) ? `
        <div class="board-actions">
          <button class="btn btn-primary student-login-btn ${loginMode === 'student' ? 'active' : ''}" data-act="show-student-login">
            <span class="btn-icon">🎓</span> 擔任組長或副組長之學生登入（帳號、密碼）
          </button>
        </div>` : ''}
    </div>

    <!-- 顯眼呈顯目前選取的學年度科目 -->
    <div class="current-course-banner">
      <div class="banner-badge">目前選擇科目 Current Course</div>
      <div class="banner-content">
        <div class="banner-main">
          <div class="course-year-tag">${esc(c ? (c.year || '未設學年度') : '尚未選擇學年度')}</div>
          <div class="course-subject-title">${esc(c ? (c.subject || '（未命名科目）') : '請先於左側課程列表選擇課程')}</div>
        </div>
        ${c ? `
          <div class="course-meta-tags">
            <span class="meta-pill">👥 每組 ${c.groupSize || 4} ± ${c.tolerance || 0} 人（門檻 ${minCap(c)} 人，上限 ${cap(c)} 人）</span>
            <span class="meta-pill">📊 總學生數 ${c.students.length} 人 · ${c.groups.length} 組</span>
            ${c.deadline ? `<span class="meta-pill ${deadlinePassed(c) ? 'expired' : 'active'}">⏳ 全體分組截止時間: ${esc(formatDeadline(c.deadline))} ${deadlinePassed(c) ? '(已截止)' : ''}</span>` : '<span class="meta-pill" style="opacity:0.85;">⏳ 全體分組截止時間: 尚未設定</span>'}
          </div>` : ''}
      </div>
    </div>

    <!-- 學生登入區塊嵌入於此 -->
    ${loginMode === 'student' ? loginCard() : ''}

    ${!c ? `<p class="file-path empty-notice">請先於左側「學年度分組清單」中點選欲查看分組的學年度與項目。</p>` : ''}

    ${c ? (c.groups.length ? `<div class="group-grid">${c.groups.map(g => {
      const list = members(c, g.id);
      const lead = leaderOf(c, g.id);
      const autoCount = list.filter(s => s.autoAssigned).length;
      const full = list.length >= cap(c);
      const isTeacher = state.session && state.session.role === 'teacher' && teacherPreviewMode === 'admin';
      const isEvalOpen = !!g.peerEvalOpen;
      const isSubmitted = !!g.peerEvalSubmitted;
      const isOverdue = isEvalOpen && evalDeadlinePassed(g) && !isSubmitted;
      const isGroupEditActive = g.allowEdit && !editDeadlinePassed(g);

      let evalStatusTag = '';
      const maxB = Number(c && c.maxBonus) > 0 ? Number(c.maxBonus) : 10;
      if (!lead) {
        evalStatusTag = `<span class="tag-status no-leader">無組長 (全員-10)</span>`;
      } else if (isSubmitted) {
        evalStatusTag = `<span class="tag-status submitted">✅ 組長已完成加分評定 (組長+${maxB})</span>`;
      } else if (isOverdue) {
        evalStatusTag = `<span class="tag-status overdue">⚠️ 評分逾時 (無加分)</span>`;
      } else if (isEvalOpen) {
        evalStatusTag = `<span class="tag-status open">📝 評分開放中${g.peerEvalDeadline ? ` (${esc(g.peerEvalDeadline.replace('T', ' '))}截止)` : ''}</span>`;
      }

      return `<div class="group-card ${self && self.groupId === g.id ? 'mine' : ''} ${isGroupEditActive ? 'reopened' : ''}">
        <div class="group-card-top-tags">
          ${autoCount ? `<span class="tag">自動 ${autoCount}</span>` : ''}
          ${evalStatusTag}
        </div>
        <h3>${esc(g.name)} <small>${list.length}/${cap(c)} 人${full ? ' · 已滿' : ''}</small></h3>
        <p class="file-path">組長 Leader: ${lead ? esc(lead.name) : '尚未產生 — none'}</p>
        ${g.allowEdit ? `
          <div class="group-badge-reopened">
            ${isGroupEditActive ? '🔓 老師已重新開放本組挑選' : '⏳ 重新開放挑選已逾時截止'}
            ${g.editDeadline ? `<span style="font-size:0.75rem;opacity:0.9;">（截止：${esc(g.editDeadline.replace('T', ' '))}）</span>` : ''}
          </div>` : ''}
        <div class="students">${list.length ? list.map(s => {
          const adj = calcAdjustment(c, g, s);
          return `<div class="student ${s.isLeader ? 'leader' : ''} ${s.isVice ? 'vice-leader' : ''}">
            <span class="student-info-col">
              ${esc(s.name)} (${esc(s.id)})${s.isLeader ? ' — 組長' : s.isVice ? ' — 副組長' : ''}${s.autoAssigned ? ' <span class="tag-inline auto">自動</span>' : ''}
            </span>
            ${isTeacher ? scoreBadge(adj) : ''}
          </div>`;
        }).join('') : '<div class="student">（尚無成員 Empty）</div>'}</div>
        ${isTeacher ? `
          <div class="group-teacher-ctrls">
            <button class="tab-btn ${g.allowEdit ? 'on' : ''}" data-act="toggle-group-edit" data-id="${g.id}" data-allow="${g.allowEdit ? '0' : '1'}">
              ${g.allowEdit ? '🔒 取消開放挑選' : '🔓 重新開放組長挑選'}
            </button>
            ${g.allowEdit && g.editDeadline ? `<span style="font-size:0.75rem;color:#d97706;margin-top:0.25rem;display:block;">截止: ${esc(g.editDeadline.replace('T', ' '))}</span>` : ''}
          </div>` : ''}
      </div>`;
    }).join('')}</div>` : '<p class="file-path empty-notice">老師尚未建立組別，或由學生自行擔任組長開組。No groups yet.</p>') : ''}
  </section>

  ${withUnassigned && c && !hideUnassignedForLeader ? `
  <section class="block-section unassigned-section" id="unassigned-block">
    <div class="block-header">
      <div class="block-title-wrap">
        <h2>未分組名單 Unassigned <span class="badge-count">${pool.length}</span></h2>
      </div>
    </div>
    <div class="unassigned-body">
      ${unassignedList(c)}
    </div>
  </section>` : ''}`;
}

/* ===== Screens ===== */
function nav() {
  const c = cur();
  let right = '';
  let center = '';
  if (state.session) {
    if (state.session.role === 'teacher') {
      right = `
        <div class="preview-mode-switch">
          <span class="preview-switch-label">👁️ 檢視模式：</span>
          <div class="preview-btn-group">
            <button class="mode-btn ${teacherPreviewMode === 'admin' ? 'active' : ''}" data-act="switch-preview" data-mode="admin" title="進入完整老師後台管理介面">
              ⚙️ 老師後台
            </button>
            <button class="mode-btn ${teacherPreviewMode === 'public' ? 'active' : ''}" data-act="switch-preview" data-mode="public" title="模擬一般訪客或未登入組員看到的前台畫面">
              👀 一般學生前台
            </button>
            <button class="mode-btn ${teacherPreviewMode === 'leader' ? 'active' : ''}" data-act="switch-preview" data-mode="leader" title="模擬擔任組長的學生登入後看到的完整挑選與管理畫面">
              🎓 組長登入模式
            </button>
          </div>
        </div>
        <span class="who">老師 Teacher</span>
        <button class="tab-btn" data-act="logout">登出 Logout</button>
      `;
    } else {
      const who = esc((me() || {}).name || '');
      right = `<span class="who">${who}</span><button class="tab-btn" data-act="logout">登出 Logout</button>`;
    }
  } else {
    center = `<a href="#login" class="student-link ${loginMode === 'student' ? 'on' : ''}" data-act="show-student-login">🎓 擔任組長/副組長之學生登入（帳號、密碼）</a>`;
    right = `<a href="#login" class="teacher-link ${loginMode === 'teacher' ? 'on' : ''}" data-act="show-teacher-login">老師登入 Teacher login</a>`;
  }
  return `<nav>
    <span class="brand">
      <span class="logo">${APP_NAME}</span>
      <span class="ver">${APP_VERSION}</span>
    </span>
    ${c ? `<span class="course-tag">${esc(courseLabel(c))}</span>` : ''}
    <span class="center">${center}</span>
    <span class="tabs">${right}</span>
  </nav>`;
}

function loginCard() {
  if (loginMode === 'student') {
    const c = cur();
    return `<div class="login-bar embedded" id="login">
      <div class="login-header">
        <strong>🎓 擔任組長/副組長之學生登入 Student login</strong>
        <button class="tab-btn close" type="button" data-act="close-login" title="關閉 Close">✕</button>
      </div>
      <form data-act="login-student" class="inline-form">
        <div class="form-group"><label>帳號 Account（姓名或學號）</label><input name="name" placeholder="請輸入姓名或學號" required autocomplete="off"></div>
        <div class="form-group"><label>密碼 Password（預設為學號）</label><input type="password" name="password" placeholder="預設學號，已改請填新密碼" required autocomplete="off"></div>
        <button class="btn btn-primary" type="submit">登入 Sign in</button>
      </form>
      <p class="file-path">目前課程：<b>${esc(c ? courseLabel(c) : '請先於左側選擇課程')}</b>。預設密碼為學號，登入後可於後台自訂密碼。若忘記密碼請洽老師重設。</p>
    </div>`;
  }
  if (loginMode === 'teacher') {
    return `<div class="login-bar teacher" id="login">
      <div class="login-header">
        <strong>老師後台登入 Teacher login</strong>
        <button class="tab-btn close" type="button" data-act="close-login" title="關閉 Close">✕</button>
      </div>
      <form data-act="login-teacher" class="inline-form">
        <div class="form-group pw"><label>老師密碼 Teacher password</label><input type="password" name="password" required autocomplete="off"></div>
        <button class="btn btn-secondary" type="submit">老師登入 Teacher login</button>
      </form>
    </div>`;
  }
  return '';
}

/* ---- 目前選取的課程展示區塊（與左側 Step 1 樹狀區塊產生連動感） ---- */
function courseSelectionBlock() {
  const c = cur();
  const dStr = (c && c.deadline) ? esc(formatDeadline(c.deadline)) : '';
  const isExp = c && deadlinePassed(c);

  return `<section class="block-section courses-overview-section" id="courses-block">
    <div class="block-header">
      <div class="block-title-wrap">
        <span class="step-badge">Step 1 選擇結果</span>
        <h2>學年度分組選擇</h2>
      </div>
      <div class="courses-link-indicator">
        <span class="link-pulse-dot"></span>
        <span class="link-label">連動自左側學年度分組清單</span>
      </div>
    </div>
    <div class="course-selection-card">
      <div class="selection-accent-connector"></div>
      ${c ? `
        <div class="selected-course-details">
          <div class="selected-meta">
            <span class="selected-year-badge">${esc(c.year || '未分類')} 學年度</span>
            <span class="selected-status-tag">目前已選中 Selected</span>
          </div>
          <h3 class="selected-subject-name">${esc(c.subject || '（未命名）')}</h3>
          <div class="selected-specs">
            <div class="spec-item"><span class="spec-label">學生總數</span><span class="spec-val">${c.students.length} 人</span></div>
            <div class="spec-item"><span class="spec-label">組別設定</span><span class="spec-val">${c.groups.length} 組（每組 ${c.groupSize} ± ${c.tolerance} 人，門檻 ${minCap(c)} ~ 上限 ${cap(c)} 人）</span></div>
            <div class="spec-item"><span class="spec-label">分組截止</span><span class="spec-val" style="font-weight:600;color:${isExp ? '#dc2626' : (dStr ? '#166534' : '#64748b')};">${dStr ? `${dStr} ${isExp ? '(已截止)' : '(進行中)'}` : '尚未設定'}</span></div>
            <div class="spec-item"><span class="spec-label">加分上限</span><span class="spec-val">組長評定 0 ~ ${c.maxBonus || 10} 分（組長獎勵 +${c.maxBonus || 10} 分）</span></div>
            <div class="spec-item"><span class="spec-label">分組進度</span><span class="spec-val">${c.students.filter(s => s.groupId).length} 人已分組 / ${unassigned(c).length} 人待分組</span></div>
          </div>
        </div>
      ` : `
        <div class="empty-selection-guide">
          <div class="guide-arrow">👈</div>
          <div class="guide-text">
            <strong>請點選左側清單選擇學年度分組</strong>
            <p>點選任一學年度下的項目，即可在此立即載入該項目的分組設定與現況。</p>
          </div>
        </div>
      `}
    </div>
  </section>`;
}

function bulletinBlock(c) {
  const maxB = (c && Number(c.maxBonus) > 0) ? Number(c.maxBonus) : 10;
  const notice = (c && c.notice) ? c.notice : `【期末考成績加減分與評分規定】：
1. 當老師開放組長評分權限時，組長可依據組員之貢獻或配合程度於期末時給予加分 (0 ~ ${maxB} 分)。
2. 組長在老師開放評分權限時進行評分，組長自己可獲得 ${maxB} 分的加分。
3. 超過分組截止時間由系統自動分組造成沒有組長的組別，每位成員期末考成績扣 10 分。`;

  const timeStr = (c && c.noticeTime) ? esc(c.noticeTime) : '';
  const dStr = (c && c.deadline) ? esc(formatDeadline(c.deadline)) : '';
  const isExp = c && deadlinePassed(c);

  // 將公告依行或段落解析為個別訊息項目，並在最右側加註公告時間
  const lines = notice.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const itemsHtml = lines.length ? lines.map(line => `
    <div class="bulletin-item">
      <div class="bulletin-item-text">${esc(line)}</div>
      ${timeStr ? `<span class="bulletin-item-time" title="公告時間">🕒 ${timeStr}</span>` : ''}
    </div>
  `).join('') : `<div class="bulletin-item"><div class="bulletin-item-text">（暫無公告事項）</div></div>`;

  return `
  <section class="block-section bulletin-section" id="bulletin-block">
    <div class="bulletin-badge-tag">📢 重要公告 BULLETIN</div>
    <div class="bulletin-header">
      <div class="bulletin-title-wrap">
        <h2>分組注意事項與評分規定</h2>
        ${c ? `<span class="bulletin-course-pill">${esc(courseLabel(c))}</span>` : ''}
        ${dStr ? `<span class="bulletin-time-tag" style="background:${isExp ? '#fee2e2' : '#fef3c7'};color:${isExp ? '#991b1b' : '#92400e'};border:1px solid ${isExp ? '#fca5a5' : '#fde68a'};font-weight:600;">⏳ 分組截止：${dStr} ${isExp ? '(已截止)' : '(進行中)'}</span>` : '<span class="bulletin-time-tag" style="color:#64748b;">⏳ 分組截止：尚未設定</span>'}
      </div>
    </div>
    <div class="bulletin-body">
      ${itemsHtml}
    </div>
  </section>`;
}

function authScreen() {
  const c = cur();
  return `
  ${loginMode === 'teacher' ? loginCard() : ''}
  <div class="home-flow">
    ${bulletinBlock(c)}
    ${howto()}
    <div class="home-main-layout">
      ${courseTreePublic()}
      <div class="flow-main">
        ${courseSelectionBlock()}
        ${publicBoard()}
      </div>
    </div>
  </div>`;
}

/* ---- 前台：使用說明 ---- */
function howto() {
  const c = cur();
  const deadlineStr = c && c.deadline ? esc(formatDeadline(c.deadline)) : '';
  const isExpired = c && deadlinePassed(c);

  return `<section class="block-section howto-section" id="howto-block">
    <div class="block-header">
      <div class="block-title-wrap">
        <h2>使用方式 How it works</h2>
      </div>
    </div>
    <div class="howto-steps">
      <div class="howto-step-card">
        <div class="step-num">1</div>
        <div class="step-info">
          <strong>選擇學年度分組</strong>
          <p>在左側樹狀區塊中點選欲查看的<b>學年度分組</b>，右側將即時載入該項目資料。</p>
        </div>
      </div>
      <div class="howto-step-card">
        <div class="step-num">2</div>
        <div class="step-info">
          <strong>學生登入開組</strong>
          <p>組長請至「分組現況」點選<b>擔任組長之學生登入</b>（姓名+學號），並按下「我要當組長」。</p>
        </div>
      </div>
      <div class="howto-step-card">
        <div class="step-num">3</div>
        <div class="step-info">
          <strong>挑選組員與指定副組長</strong>
          <p>組長可從未分組名單挑選組員、設定副組長。<b>欲加入尚未額滿的各組組員，請一律透過組長加入</b>；被挑選同學不需額外動作。</p>
        </div>
      </div>
      <div class="howto-step-card">
        <div class="step-num">4</div>
        <div class="step-info">
          <strong>截止後自動分配</strong>
          <p>超過分組截止時間未被挑選者由系統隨機分配至未滿組別，並標示為「自動」。${deadlineStr ? `<br><span style="display:inline-block;margin-top:0.35rem;padding:0.15rem 0.5rem;background:${isExpired ? '#fee2e2' : '#fef3c7'};color:${isExpired ? '#991b1b' : '#92400e'};border-radius:4px;font-weight:600;font-size:0.85rem;">⏳ 本科目分組截止時間：${deadlineStr} ${isExpired ? '(已截止)' : ''}</span>` : '<br><span style="color:#64748b;font-size:0.85rem;">（本科目尚未設定分組截止時間）</span>'}</p>
        </div>
      </div>
    </div>
  </section>`;
}

/* ---- 前台：左側課程樹狀結構區塊（學年度 → 科目） ---- */
function courseTreePublic() {
  const byYear = {};
  state.courses.forEach(c => {
    const y = c.year || '未分類 Unfiled';
    (byYear[y] = byYear[y] || []).push(c);
  });
  const years = Object.keys(byYear).sort().reverse();
  return `<aside class="block-section tree-section" id="courses-tree-block">
    <div class="block-header tree-header">
      <div class="block-title-wrap">
        <span class="step-badge">Step 1</span>
        <h2>學年度分組清單</h2>
      </div>
      <p class="block-desc">選擇學年度與名稱</p>
    </div>
    <div class="tree-content">
      ${years.length ? years.map(y => `
        <div class="tree-year">
          <div class="tree-year-label">${esc(y)} 學年度</div>
          <ul class="tree-list">${byYear[y].map(c => {
            const active = state.currentId === c.id;
            return `
            <li class="${active ? 'active' : ''}">
              <button class="tree-node-btn" data-act="pick-course-node" data-id="${c.id}">
                <div class="node-main">
                  <span class="node-icon">${active ? '👉' : '📘'}</span>
                  <span class="node-name">${esc(c.subject || '（未命名）')}</span>
                </div>
                <span class="node-badge">${c.students.length}人·${c.groups.length}組</span>
              </button>
              ${active ? `<div class="tree-active-pointer" title="連接至右方學年度分組選擇區塊"></div>` : ''}
            </li>`;
          }).join('')}</ul>
        </div>`).join('') : '<p class="file-path empty-notice">老師尚未建立任何分組。No grouping yet.</p>'}
    </div>
  </aside>`;
}

/* ---- 後台：左側課程樹 ---- */
function courseTree() {
  const byYear = {};
  state.courses.forEach(c => {
    const y = c.year || '未分類 Unfiled';
    (byYear[y] = byYear[y] || []).push(c);
  });
  const years = Object.keys(byYear).sort().reverse();
  return `<aside class="tree">
    <h3>學年度分組清單</h3>
    ${years.length ? years.map(y => `
      <div class="tree-year">
        <div class="tree-year-label">${esc(y)}</div>
        <ul>${byYear[y].map(c => `
          <li class="${state.currentId === c.id && teacherView === 'course' ? 'active' : ''}">
            <button data-act="pick-course-node" data-id="${c.id}">
              ${esc(c.subject || '（未命名）')}
              <span class="count">${c.students.length} 人 / ${c.groups.length} 組</span>
            </button>
          </li>`).join('')}</ul>
      </div>`).join('') : '<p class="file-path">尚無分組，請於右側「分組設定」建立。</p>'}
    <button class="btn btn-secondary" data-act="new-course">＋ 新增分組項目 New</button>
    <div class="tree-year tree-sys">
      <div class="tree-year-label">系統設定 System</div>
      <ul>
        <li class="${teacherView === 'settings' ? 'active' : ''}">
          <button data-act="sys-password">🔑 密碼與安全性管理<span class="count">管理者與組長密碼 Password security</span></button>
        </li>
        <li class="${teacherView === 'eval' ? 'active' : ''}">
          <button data-act="sys-peer-eval">學期成績加減分與組長評分控制<span class="count">Peer evaluation</span></button>
        </li>
        <li class="${teacherView === 'logs' ? 'active' : ''}">
          <button data-act="sys-logs">📜 分組異動日誌<span class="count">Activity logs</span></button>
        </li>
        <li class="${teacherView === 'attendance' ? 'active' : ''}">
          <button data-act="sys-attendance">📋 點名管理（Điểm danh）<span class="count">Attendance</span></button>
        </li>
      </ul>
    </div>
  </aside>`;
}

function teacherScreen() {
  const c = cur();
  let main;
  if (teacherView === 'settings') {
    main = teacherPasswordBlock(c);
  } else if (teacherView === 'eval') {
    main = teacherPeerEvalBlock(c);
  } else if (teacherView === 'logs') {
    main = teacherLogsBlock(c);
  } else if (teacherView === 'attendance') {
    main = teacherAttendanceBlock(c);
  } else {
    main = c ? teacherCourse(c) : teacherNoCourse();
  }
  return `<div class="layout">${courseTree()}<main>${main}</main></div>`;
}

function teacherNoCourse() {
  return `
  <div class="teacher-section">
    <h2>分組設定 Grouping setup</h2>
    <p class="file-path">建立新分組：填寫學年度與名稱後儲存，會出現在左側樹狀清單。</p>
    ${courseForm({ year: '', subject: '', groupSize: 4, tolerance: 1, maxBonus: 10, deadline: '', notice: '' })}
  </div>`;
}

function courseForm(c) {
  const maxB = (c && Number(c.maxBonus) > 0) ? Number(c.maxBonus) : 10;
  const noticeVal = (c && c.notice !== undefined && c.notice !== null) ? c.notice : `【期末考成績加減分與評分規定】：
1. 當老師開放組長評分權限時，組長可依據組員之貢獻或配合程度於期末時給予加分 (0 ~ ${maxB} 分)。
2. 組長在老師開放評分權限時進行評分，組長自己可獲得 ${maxB} 分的加分。
3. 超過分組截止時間由系統自動分組造成沒有組長的組別，每位成員期末考成績扣 10 分。`;

  return `<form data-act="save-course">
    <div class="form-row">
      <div class="form-group"><label>學年度 Academic year</label><input name="year" value="${esc(c.year)}" placeholder="113-1" required></div>
      <div class="form-group"><label>名稱</label><input name="subject" value="${esc(c.subject)}" placeholder="例如：113入學行銷真班" required></div>
      <div class="form-group"><label>每組人數 Group size</label><input type="number" min="1" name="groupSize" value="${c.groupSize || 4}"></div>
      <div class="form-group"><label>誤差人數 ± Tolerance</label><input type="number" min="0" name="tolerance" value="${c.tolerance ?? 1}"></div>
      <div class="form-group"><label>組長加分上限 Max bonus (分)</label><input type="number" min="1" max="100" name="maxBonus" value="${maxB}" placeholder="例如 5 或 10" required></div>
      <div class="form-group"><label>分組截止時間 Deadline</label><input type="datetime-local" name="deadline" value="${esc(c.deadline || '')}"></div>
      <div class="form-group full">
        <label>公布欄注意事項 Notice (顯示於前台最上方)</label>
        <textarea name="notice" rows="4" style="width:100%;padding:0.6rem;border:1px solid #ddd;border-radius:4px;font:inherit;">${esc(noticeVal)}</textarea>
      </div>
    </div>
    <button class="btn btn-primary" type="submit">儲存 Save</button>
  </form>`;
}

/* ---- 後台：學期成績加減分與組長評分控制面板 ---- */
function teacherPeerEvalBlock(c) {
  if (!c) {
    return `
    <div class="teacher-section peer-eval-admin-box">
      <h2>⚖️ 學期成績加減分與組長評分控制 <small>Peer Evaluation Management</small></h2>
      <p class="file-path">請先從左側點選或建立課程，即可進行該課程的學期成績加減分與組長評分控制。</p>
    </div>`;
  }
  const maxB = (c && Number(c.maxBonus) > 0) ? Number(c.maxBonus) : 10;
  return `
  <div class="teacher-section peer-eval-admin-box">
    <h2>⚖️ 學期成績加減分與組長評分控制 <small>${esc(courseLabel(c))}</small></h2>
    <p class="file-path">規則：開放評分後組長可依組員貢獻度給予加分(0~${maxB}分)；組長進行評分自身可獲得 ${maxB} 分加分；超過分組截止時間由系統自動分組造成沒有組長的組別，每位成員期末考成績扣 10 分。</p>
    
    <div class="peer-eval-global-bar">
      <form data-act="set-all-eval" style="display:flex;align-items:center;flex-wrap:wrap;gap:0.75rem;background:#f8fafc;padding:0.9rem 1.2rem;border:1px solid #e2e8f0;border-radius:8px;">
        <label style="font-weight:600;font-size:0.9rem;">全體組長評分截止時間：</label>
        <input type="datetime-local" name="evalDeadline" style="padding:0.35rem 0.6rem;font-size:0.85rem;" required>
        <button class="btn btn-primary" type="submit" style="padding:0.4rem 1rem;font-size:0.85rem;margin:0;">一鍵開放全體組長評分</button>
        <button class="btn btn-secondary" type="button" data-act="close-all-eval" style="padding:0.4rem 1rem;font-size:0.85rem;margin:0;">一鍵關閉全體評分</button>
        <button class="btn btn-success" type="button" data-act="export-eval-csv" style="padding:0.4rem 1rem;font-size:0.85rem;margin:0;margin-left:auto;">📥 下載匯出評分結果 (依學號排序) Export CSV</button>
      </form>
    </div>

    ${c.groups.length ? `
    <div class="table-wrap" style="margin-top:1rem">
      <table class="roster eval-status-table">
        <thead>
          <tr>
            <th>組別</th>
            <th>組長</th>
            <th>評分權限狀態</th>
            <th>組長評分截止時間</th>
            <th>組長評分進度</th>
            <th>個別操作</th>
          </tr>
        </thead>
        <tbody>
          ${c.groups.map(g => {
            const lead = leaderOf(c, g.id);
            const isOver = evalDeadlinePassed(g);
            return `
            <tr>
              <td><b>${esc(g.name)}</b></td>
              <td>${lead ? `<span style="color:#16a34a;font-weight:600;">${esc(lead.name)} (${esc(lead.id)})</span>` : '<span style="color:#dc2626;">（無組長）</span>'}</td>
              <td>
                ${g.peerEvalOpen
                  ? `<span class="status-badge can-edit">開放中 Open</span>`
                  : `<span class="status-badge is-locked">未開放 Closed</span>`}
              </td>
              <td>${g.peerEvalDeadline ? esc(g.peerEvalDeadline.replace('T', ' ')) : '<span style="color:#94a3b8">未設定</span>'}</td>
              <td>
                ${!lead ? '<span style="color:#64748b">無組長免評分</span>'
                  : g.peerEvalSubmitted ? '<span style="color:#16a34a;font-weight:600;">✅ 組長已完成評分</span>'
                  : (g.peerEvalOpen && isOver) ? '<span style="color:#dc2626;font-weight:600;">⚠️ 逾時未評分 (全組-5/組長-10)</span>'
                  : g.peerEvalOpen ? '<span style="color:#f59e0b;font-weight:600;">⏳ 評分進行中</span>'
                  : '<span style="color:#94a3b8">尚未開放</span>'}
              </td>
              <td>
                ${lead ? `
                  <button class="tab-btn ${g.peerEvalOpen ? 'on' : ''}" data-act="toggle-single-eval" data-id="${g.id}" data-open="${g.peerEvalOpen ? '0' : '1'}">
                    ${g.peerEvalOpen ? '🔒 關閉該組評分' : '🔓 開放該組評分'}
                  </button>` : '<span style="color:#94a3b8">-</span>'}
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>` : '<p class="file-path">尚未建立組別。</p>'}
  </div>`;
}

function teacherCourse(c) {
  const total = c.students.length;
  const assigned = c.students.filter(s => s.groupId).length;
  return `
  <div class="teacher-section">
    <h2>分組設定 Grouping setup <small>${esc(courseLabel(c))}</small></h2>
    ${courseForm(c)}
    <div class="btn-row" style="margin-top:1rem">
      <button class="btn btn-warning" data-act="clear-groups" title="只清除所有組別與學生組別分配，保留修課名單與課程">刪除分組（不刪名單與課程）Delete groups only</button>
      ${c.hasSnapshot ? `
        <button class="btn btn-undo" data-act="restore-snapshot" title="復原至上次清空或建立組別前的分組狀態">↩️ 回到上一步 (復原分組) Undo</button>
      ` : ''}
      <button class="btn btn-danger" data-act="del-course" data-id="${c.id}" title="完全刪除本科目所有資料">刪除整個科目（含名單與分組）Delete course</button>
    </div>
  </div>

  <div class="teacher-section">
    <h2>分組管理 Grouping</h2>

    <!-- 分組截止時間設定 (置於分組管理區塊開頭) -->
    <form data-act="set-course-deadline" class="grouping-deadline-bar">
      <label>⏳ 分組截止時間 Deadline：</label>
      <input type="datetime-local" name="deadline" value="${esc(c.deadline || '')}">
      <button class="btn btn-primary" type="submit" style="padding:0.4rem 1rem;font-size:0.85rem;margin:0;">儲存截止時間</button>
      ${c.deadline ? `
        <span class="deadline-status-tag ${deadlinePassed(c) ? 'closed' : 'open'}">
          ${deadlinePassed(c) ? '🚫 已截止（未選學生已自動分配）Closed' : '🟢 分組進行中 Open'}
        </span>
      ` : '<span style="font-size:0.82rem;color:#64748b;">(尚未設定截止時間)</span>'}
    </form>

    <div class="stats">
      <div class="stat"><div class="value">${total}</div><div class="label">總學生數 Students</div></div>
      <div class="stat"><div class="value">${c.groups.length}</div><div class="label">組別數 Groups</div></div>
      <div class="stat"><div class="value">${assigned}</div><div class="label">已分組 Assigned</div></div>
      <div class="stat"><div class="value">${total - assigned}</div><div class="label">未分組 Unassigned</div></div>
    </div>
    <div class="btn-row">
      <button class="btn btn-primary" data-act="make-groups" title="將重設並清空現有所有分組">建立空組別（清空現有）Create groups</button>
      <button class="btn btn-success" data-act="make-remaining-groups" title="只針對未分組成員依規定人數建立新組別，現有組別與成員不變">針對剩餘組員建立組別 Create for unassigned</button>
      <button class="btn btn-secondary" data-act="add-group">新增一組 Add group</button>
      <button class="btn btn-secondary" data-act="auto-assign" title="隨機分配未分組學生，避開已完成編組的組別，不新增或刪減已完成分組的組別成員">隨機分配剩餘 Auto-assign</button>
      <button class="btn btn-danger" data-act="clear-groups">清除本科目所有分組 Clear all groups</button>
      ${c.hasSnapshot ? `
        <button class="btn btn-undo" data-act="restore-snapshot" title="復原至上次清空或建立組別前的分組狀態">↩️ 回到上一步 (復原分組) Undo</button>
      ` : ''}
      <button class="btn btn-secondary" data-act="export-json">匯出 JSON</button>
      <button class="btn btn-secondary" data-act="export-csv">匯出 CSV</button>
      <button class="btn btn-secondary" data-act="view-course-logs" title="查看本課程組員異動日誌與操作歷史">📜 分組異動日誌 (${(c.logs || []).length})</button>
    </div>

    <!-- 勾選要刪除的分組組別 -->
    ${c.groups.length ? `
      <div class="select-del-groups-box" style="margin-top:1.5rem;padding:1.2rem;background:#fffaf0;border:1.5px solid #fdebd0;border-radius:8px;">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.5rem;margin-bottom:0.75rem;">
          <strong style="color:#d35400;">🗑️ 勾選刪除特定分組組別 Select groups to delete</strong>
          <div style="display:flex;gap:0.5rem;">
            <button class="tab-btn" type="button" data-act="select-all-del-groups">全選 All</button>
            <button class="tab-btn" type="button" data-act="unselect-all-del-groups">取消全選 None</button>
            <button class="btn btn-danger" type="button" data-act="del-selected-groups" style="padding:0.4rem 0.9rem;font-size:0.85rem;margin:0;">刪除勾選組別</button>
          </div>
        </div>
        <p class="file-path" style="margin:0 0 0.75rem 0;">勾選欲刪除的組別並點擊「刪除勾選組別」，被刪組別之組員將退回未分組名單，其餘組別與名單不受影響。</p>
        <div class="del-groups-grid" style="display:grid;grid-template-columns:repeat(auto-fill, minmax(180px, 1fr));gap:0.5rem;">
          ${c.groups.map(g => {
            const count = members(c, g.id).length;
            return `
            <label style="display:flex;align-items:center;gap:0.4rem;background:#fff;padding:0.5rem 0.75rem;border:1px solid #ebd4b9;border-radius:6px;cursor:pointer;font-size:0.9rem;">
              <input type="checkbox" name="del_group_cb" value="${esc(g.id)}">
              <span><b>${esc(g.name)}</b> (${count}人)</span>
            </label>`;
          }).join('')}
        </div>
      </div>` : ''}

    <!-- 特定組別重新開放挑選組員控制面板 -->
    ${c.groups.length ? `
      <div class="reopen-groups-box" style="margin-top:1.5rem;padding:1.2rem;background:#f0fdf4;border:1.5px solid #bbf7d0;border-radius:8px;">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.5rem;margin-bottom:0.75rem;">
          <strong style="color:#166534;">🔓 特定組別重新開放組長挑選組員（可設定新截止時間）</strong>
        </div>
        <p class="file-path" style="margin:0 0 0.75rem 0;">
          即便全體分組截止時間已過，老師仍可在此為特定組別重新開放組長挑選組員權限，並指定「該組專屬之新截止時間」。逾時後將自動鎖定。
        </p>
        <div class="table-wrap">
          <table class="roster" style="background:#fff;">
            <thead>
              <tr>
                <th>組別</th>
                <th>組長</th>
                <th>目前成員</th>
                <th>挑選權限狀態</th>
                <th>專屬新截止時間</th>
                <th>操作（設定新時限並開放）</th>
              </tr>
            </thead>
            <tbody>
              ${c.groups.map(g => {
                const lead = leaderOf(c, g.id);
                const count = members(c, g.id).length;
                const isGroupEditActive = g.allowEdit && !editDeadlinePassed(g);
                return `
                <tr>
                  <td><b>${esc(g.name)}</b></td>
                  <td>${lead ? `<span style="color:#16a34a;font-weight:600;">${esc(lead.name)} (${esc(lead.id)})</span>` : '<span style="color:#94a3b8">（尚未產生組長）</span>'}</td>
                  <td>${count} / ${cap(c)} 人</td>
                  <td>
                    ${!g.allowEdit ? '<span class="status-badge is-locked">未開放（依全體時限）</span>'
                      : isGroupEditActive ? '<span class="status-badge can-edit">開放挑選中 Open</span>'
                      : '<span class="status-badge under-threshold">已逾專屬截止時間 Closed</span>'}
                  </td>
                  <td>
                    ${g.editDeadline ? `<span style="font-weight:600;color:${isGroupEditActive ? '#166534' : '#991b1b'};">${esc(g.editDeadline.replace('T', ' '))}</span>` : (g.allowEdit ? '<span style="color:#64748b;">永久開放（無期限）</span>' : '<span style="color:#94a3b8">-</span>')}
                  </td>
                  <td>
                    ${g.allowEdit ? `
                      <div style="display:flex;align-items:center;gap:0.4rem;flex-wrap:wrap;">
                        <button class="tab-btn on" data-act="toggle-group-edit" data-id="${g.id}" data-allow="0">
                          🔒 關閉開放
                        </button>
                        <button class="tab-btn" data-act="reopen-group-modal" data-id="${g.id}" title="更改該組新截止時間">
                          ⏱️ 更改截止時間
                        </button>
                      </div>
                    ` : `
                      <button class="btn btn-primary" style="padding:0.35rem 0.85rem;font-size:0.85rem;margin:0;" data-act="reopen-group-modal" data-id="${g.id}">
                        🔓 重新開放並設定新時限
                      </button>
                    `}
                  </td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>` : ''}
  </div>

  <div class="roster-row">
    <div class="teacher-section">
      <h2>修課名單 Roster</h2>
      <div class="form-group">
        <label>匯入文字檔 Import .txt / .csv（每行：學號 姓名）</label>
        <input type="file" accept=".txt,.csv" data-act="import-file">
        <div class="file-path">格式範例 Format: <code>410123 王小明</code> 或 <code>410123,王小明</code>；標題列（學號 / 姓名）會自動略過。</div>
      </div>
      <form data-act="add-student" class="form-row">
        <div class="form-group"><label>學號 ID</label><input name="id" required></div>
        <div class="form-group"><label>姓名 Name</label><input name="name" required></div>
        <div class="form-group full"><button class="btn btn-primary" type="submit">新增學生 Add student</button></div>
      </form>
      ${rosterTable(c)}
    </div>

    <div class="teacher-section unassigned-panel">
      <h2>未分組名單 Unassigned (${total - assigned})</h2>
      ${unassignedList(c)}
    </div>
  </div>

  <!-- 最新異動動態預覽卡片 -->
  <div class="teacher-section logs-preview-box" style="margin-top:2rem;">
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.5rem;margin-bottom:0.75rem;">
      <h2 style="margin:0;font-size:1.2rem;">📜 最新分組異動紀錄 <small>Recent Activity</small></h2>
      <button class="btn btn-secondary" data-act="view-course-logs" style="padding:0.35rem 0.85rem;font-size:0.85rem;margin:0;">
        查看完整日誌 (${(c.logs || []).length} 筆) →
      </button>
    </div>
    ${(c.logs && c.logs.length) ? `
      <div class="table-wrap">
        <table class="roster" style="background:#fff;margin:0;">
          <thead>
            <tr>
              <th style="width:150px;">時間 Timestamp</th>
              <th style="width:120px;">類別 Action</th>
              <th style="width:140px;">操作者 Operator</th>
              <th>詳細異動說明 Detail</th>
            </tr>
          </thead>
          <tbody>
            ${c.logs.slice(0, 5).map(l => `
            <tr>
              <td style="font-size:0.82rem;color:#475569;font-family:monospace;white-space:nowrap;">${formatLogTime(l.createdAt)}</td>
              <td>${renderLogBadge(l.actionType)}</td>
              <td><b>${esc(l.operatorName || '-')}</b> <small style="color:#64748b;">(${esc(l.operatorId || '')})</small></td>
              <td>${esc(l.detail)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    ` : '<p class="file-path" style="margin:0;">目前尚無任何異動紀錄。當組長進行組員挑選或釋出時，系統將自動記錄於此。</p>'}
  </div>
  ${publicBoard({ withUnassigned: false })}`;
}

/* ===== 異動日誌輔助函式 ===== */
function formatLogTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return String(ts);
  const pad = n => String(n).padStart(2, '0');
  const y = d.getFullYear();
  const m = pad(d.getMonth() + 1);
  const date = pad(d.getDate());
  const h = pad(d.getHours());
  const min = pad(d.getMinutes());
  const s = pad(d.getSeconds());
  return `${y}-${m}-${date} ${h}:${min}:${s}`;
}

function isSameDay(ts1, ts2) {
  if (!ts1 || !ts2) return false;
  const d1 = new Date(ts1), d2 = new Date(ts2);
  return d1.getFullYear() === d2.getFullYear() && d1.getMonth() === d2.getMonth() && d1.getDate() === d2.getDate();
}

function formatActionTypeLabel(type) {
  switch (type) {
    case 'pick': return '組長加入組員';
    case 'drop': return '組長釋出組員';
    case 'claim-leader': return '登記組長';
    case 'unclaim-leader': return '放棄組長';
    case 'toggle-vice': return '副組長設定變更';
    case 'peer-eval': return '期末組長評分送出';
    case 'teacher-assign': return '老師指派組員';
    case 'teacher-set-leader': return '老師設定組長';
    case 'teacher-auto-assign': return '老師隨機分配';
    case 'make-groups': return '老師重建組別';
    case 'make-remaining-groups': return '老師建立剩餘組別';
    case 'clear-groups': return '老師清空分組';
    case 'restore-snapshot': return '老師復原分組';
    case 'del-groups': return '老師刪除組別';
    case 'add-group': return '老師新增組別';
    case 'toggle-group-edit': return '老師開放/關閉挑選權限';
    case 'deadline-dissolve': return '系統解散不足額組別';
    case 'auto-assign': return '系統自動分配未分組';
    case 'attendance-mark': return '組長/副組長點名標記';
    case 'attendance-correct': return '組長/副組長修正點名';
    case 'attendance-session-save': return '老師設定點名時段';
    case 'attendance-session-delete': return '老師刪除點名時段';
    case 'attendance-unlock': return '老師開放/關閉點名補登';
    case 'attendance-delegate': return '老師指派/取消跨組代理點名';
    default: return type;
  }
}

function renderLogBadge(type) {
  switch (type) {
    case 'pick':
      return '<span class="log-badge tag-pick">＋ 組長加入</span>';
    case 'drop':
      return '<span class="log-badge tag-drop">－ 組長釋出</span>';
    case 'claim-leader':
      return '<span class="log-badge tag-leader">👑 登記組長</span>';
    case 'unclaim-leader':
      return '<span class="log-badge tag-leader">↩️ 放棄組長</span>';
    case 'toggle-vice':
      return '<span class="log-badge tag-vice">⭐ 副組長變更</span>';
    case 'peer-eval':
      return '<span class="log-badge tag-eval">📝 期末評分</span>';
    case 'auto-assign':
    case 'deadline-dissolve':
      return '<span class="log-badge tag-system">🤖 系統處理</span>';
    case 'attendance-mark':
      return '<span class="log-badge tag-vice">📋 點名標記</span>';
    case 'attendance-correct':
      return '<span class="log-badge tag-vice">✏️ 點名修正</span>';
    case 'attendance-session-save':
    case 'attendance-session-delete':
    case 'attendance-unlock':
    case 'attendance-delegate':
      return '<span class="log-badge tag-teacher">📋 點名管理</span>';
    default:
      if (type.startsWith('teacher') || ['make-groups', 'make-remaining-groups', 'clear-groups', 'restore-snapshot', 'del-groups', 'add-group', 'toggle-group-edit'].includes(type)) {
        return '<span class="log-badge tag-teacher">🛠️ 老師操作</span>';
      }
      return `<span class="log-badge">${esc(type)}</span>`;
  }
}

function teacherLogsBlock(c) {
  if (!c) {
    return `
    <div class="teacher-section">
      <h2>📜 學生分組異動日誌 <small>Activity Logs</small></h2>
      <p class="file-path">請先從左側點選或建立課程，即可檢視該課程的學生分組異動日誌。</p>
    </div>`;
  }

  const logs = c.logs || [];
  const pickCount = logs.filter(l => l.actionType === 'pick').length;
  const dropCount = logs.filter(l => l.actionType === 'drop').length;
  const todayCount = logs.filter(l => isSameDay(l.createdAt, Date.now())).length;

  const kw = (logSearchText || '').trim().toLowerCase();
  const filtered = logs.filter(l => {
    if (logActionFilter === 'pick' && l.actionType !== 'pick') return false;
    if (logActionFilter === 'drop' && l.actionType !== 'drop') return false;
    if (logActionFilter === 'leader' && !['claim-leader', 'unclaim-leader', 'toggle-vice', 'peer-eval'].includes(l.actionType)) return false;
    if (logActionFilter === 'teacher' && !(l.actionType.startsWith('teacher') || ['make-groups', 'make-remaining-groups', 'clear-groups', 'restore-snapshot', 'del-groups', 'add-group', 'toggle-group-edit'].includes(l.actionType))) return false;
    if (logActionFilter === 'system' && !['auto-assign', 'deadline-dissolve'].includes(l.actionType)) return false;
    if (logActionFilter === 'attendance' && !l.actionType.startsWith('attendance')) return false;

    if (kw) {
      const matchText = `${l.detail} ${l.operatorName} ${l.operatorId} ${l.targetName} ${l.targetId} ${l.groupName} ${formatLogTime(l.createdAt)}`.toLowerCase();
      if (!matchText.includes(kw)) return false;
    }
    return true;
  });

  return `
  <div class="teacher-section logs-admin-box">
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:1rem;margin-bottom:1.2rem;">
      <div>
        <h2 style="margin:0;">📜 學生分組異動日誌 <small>${esc(courseLabel(c))}</small></h2>
        <p class="file-path" style="margin:0.25rem 0 0 0;">
          即時記載組長加入/釋出組員、身分設定、老師調整與系統排程等所有操作歷程與時間軌跡。
        </p>
      </div>
      <div style="display:flex;gap:0.5rem;flex-wrap:wrap;">
        <button class="btn btn-secondary" data-act="back-to-course" style="padding:0.45rem 0.9rem;font-size:0.85rem;margin:0;">
          🔙 返回分組管理
        </button>
        <button class="btn btn-success" data-act="export-logs-csv" style="padding:0.45rem 0.9rem;font-size:0.85rem;margin:0;" ${logs.length ? '' : 'disabled'}>
          📥 匯出異動日誌 CSV
        </button>
        <button class="btn btn-danger" data-act="clear-course-logs" style="padding:0.45rem 0.9rem;font-size:0.85rem;margin:0;" ${logs.length ? '' : 'disabled'}>
          🗑️ 清空日誌紀錄
        </button>
      </div>
    </div>

    <!-- 統計指標卡片 -->
    <div class="stats" style="margin:0 0 1.5rem 0;">
      <div class="stat"><div class="value">${logs.length}</div><div class="label">總異動筆數 Total</div></div>
      <div class="stat"><div class="value" style="color:#16a34a;">${pickCount}</div><div class="label">組長加入組員 Picks</div></div>
      <div class="stat"><div class="value" style="color:#dc2626;">${dropCount}</div><div class="label">組長釋出組員 Drops</div></div>
      <div class="stat"><div class="value" style="color:#2563eb;">${todayCount}</div><div class="label">今日最新異動 Today</div></div>
    </div>

    <!-- 搜尋與過濾列 -->
    <div class="logs-filter-bar" style="display:flex;align-items:center;gap:0.75rem;flex-wrap:wrap;background:#f8fafc;padding:0.85rem 1rem;border:1px solid #e2e8f0;border-radius:8px;margin-bottom:1rem;">
      <div style="display:flex;align-items:center;gap:0.4rem;">
        <label style="font-weight:600;font-size:0.85rem;color:#475569;">🔍 搜尋：</label>
        <input type="text" data-act="search-logs" value="${esc(logSearchText)}" placeholder="輸入姓名、學號、組別或關鍵字..." style="padding:0.35rem 0.6rem;font-size:0.85rem;border:1px solid #cbd5e1;border-radius:4px;width:240px;">
      </div>
      <div style="display:flex;align-items:center;gap:0.4rem;">
        <label style="font-weight:600;font-size:0.85rem;color:#475569;">類別篩選：</label>
        <select data-act="filter-log-action" style="padding:0.35rem 0.6rem;font-size:0.85rem;border:1px solid #cbd5e1;border-radius:4px;background:#fff;">
          <option value="all" ${logActionFilter === 'all' ? 'selected' : ''}>全部動作類別 All (${logs.length})</option>
          <option value="pick" ${logActionFilter === 'pick' ? 'selected' : ''}>＋ 組長加入組員 (${pickCount})</option>
          <option value="drop" ${logActionFilter === 'drop' ? 'selected' : ''}>－ 組長釋出組員 (${dropCount})</option>
          <option value="leader" ${logActionFilter === 'leader' ? 'selected' : ''}>👑 組長/副組長身分變更</option>
          <option value="teacher" ${logActionFilter === 'teacher' ? 'selected' : ''}>🛠️ 老師管理調整</option>
          <option value="system" ${logActionFilter === 'system' ? 'selected' : ''}>🤖 系統自動處理</option>
          <option value="attendance" ${logActionFilter === 'attendance' ? 'selected' : ''}>📋 點名相關</option>
        </select>
      </div>
      ${(kw || logActionFilter !== 'all') ? `
        <button class="tab-btn" data-act="reset-log-filter" style="padding:0.3rem 0.6rem;font-size:0.8rem;margin-left:auto;">
          重設篩選 Reset
        </button>
      ` : ''}
      <span style="font-size:0.82rem;color:#64748b;margin-left:${(kw || logActionFilter !== 'all') ? '0' : 'auto'};">
        顯示 ${filtered.length} / 共 ${logs.length} 筆
      </span>
    </div>

    <!-- 日誌資料表 -->
    ${filtered.length ? `
    <div class="table-wrap">
      <table class="roster logs-table" style="background:#fff;">
        <thead>
          <tr>
            <th style="width:150px;">時間 Timestamp</th>
            <th style="width:120px;">動作類別 Action</th>
            <th style="width:130px;">操作者 Operator</th>
            <th style="width:95px;">相關組別 Group</th>
            <th style="width:125px;">對象學生 Target</th>
            <th>詳細異動說明 Detail</th>
          </tr>
        </thead>
        <tbody>
          ${filtered.map(l => `
          <tr>
            <td style="font-size:0.82rem;color:#475569;font-family:monospace;white-space:nowrap;">
              ${formatLogTime(l.createdAt)}
            </td>
            <td>${renderLogBadge(l.actionType)}</td>
            <td>
              <b>${esc(l.operatorName || '-')}</b>
              ${l.operatorId && l.operatorId !== l.operatorName ? `<br><small style="color:#64748b;">${esc(l.operatorId)}</small>` : ''}
            </td>
            <td>
              ${l.groupName ? `<span class="group-name-tag">${esc(l.groupName)}</span>` : '<span style="color:#94a3b8;">-</span>'}
            </td>
            <td>
              ${l.targetName ? `<b>${esc(l.targetName)}</b>` : '<span style="color:#94a3b8;">-</span>'}
              ${l.targetId ? `<br><small style="color:#64748b;">${esc(l.targetId)}</small>` : ''}
            </td>
            <td style="line-height:1.4;">
              <span class="log-detail-text">${esc(l.detail)}</span>
            </td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>` : `
    <div style="text-align:center;padding:3rem 1rem;background:#f8fafc;border:1px dashed #cbd5e1;border-radius:8px;color:#64748b;">
      <p style="font-size:1.1rem;margin-bottom:0.5rem;">📭 目前無符合條件的異動紀錄</p>
      <p style="font-size:0.85rem;margin:0;">
        ${logs.length ? '請嘗試更換搜尋關鍵字或調整篩選類別。' : '當組長挑選、釋出組員或老師調整分組時，系統將自動於此留下精準的時間與操作歷程。'}
      </p>
    </div>`}
  </div>`;
}

/* ===== 後台：點名管理 Attendance（Điểm danh）===== */
function teacherAttendanceBlock(c) {
  if (!c) {
    return `
    <div class="teacher-section">
      <h2>📋 點名管理 Attendance <small>Điểm danh</small></h2>
      <p class="file-path">請先從左側點選或建立課程，即可設定該課程的點名時段。</p>
    </div>`;
  }

  const sessions = attendanceSessions(c);
  const editing = attendanceEditingId ? sessions.find(s => s.id === attendanceEditingId) : null;
  const today = todayDateStr();

  /* ---- 1. 點名時段設定 ---- */
  const noticeBanner = `
  <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:0.85rem 1rem;margin-bottom:1.15rem;font-size:0.88rem;color:#1e3a8a;line-height:1.5;">
    💡 <b>一般日常點名已自動啟用</b>：每逢上課當日，系統會自動為組長或副組長開放該日之「一般日常點名」，登入即可直接逐一確認組員出缺席，老師<b>無需</b>事先在此新增日常時段。<br>
    📌 <b>重要集會／額外點名</b>：若遇重要集會、系週會、成果展示或期中報告，老師可使用下方表單新增點名時段並<b>加註點名名稱</b>，組長或副組長將於前台專區進行額外點名。超過當天需老師於操作欄開放補登權限才能修改。
  </div>`;

  const sessionForm = `
    <form data-act="save-attendance-session" class="form-row" style="background:#fff;padding:1rem;border:1px solid #e2e8f0;border-radius:8px;margin-bottom:1rem;">
      <div style="width:100%;margin-bottom:0.4rem;font-weight:600;color:#1e293b;font-size:0.95rem;">
        ${editing ? '✏️ 編輯點名時段 Edit Session' : '➕ 新增重要集會／額外點名時段 Add Special Session'}
      </div>
      <div class="form-group"><label>點名日期 Date（Ngày điểm danh）</label><input type="date" name="date" value="${esc(editing ? editing.date : today)}" required></div>
      <div class="form-group"><label>點名時段 Time slot（Khung giờ）</label><input name="timeSlot" value="${esc(editing ? editing.timeSlot : '')}" placeholder="例如：第3-4節"></div>
      <div class="form-group"><label>點名名稱／重要集會備註 Name（Tên buổi / Sự kiện）</label><input name="name" value="${esc(editing ? editing.name : '')}" placeholder="例如：系週會、重要集會、期中專案報告"></div>
      <div class="form-group full">
        <button class="btn btn-primary" type="submit">${editing ? '儲存修改 Save' : '新增重要集會時段 Add session'}</button>
        ${editing ? `<button class="btn btn-secondary" type="button" data-act="cancel-edit-attendance-session">取消編輯 Cancel</button>` : ''}
      </div>
    </form>`;

  const sessionRows = sessions.map(s => {
    const isToday = s.date === today;
    const isDaily = isDailySession(s);
    const allUnlock = (c.attendanceUnlocks || []).find(u => u.sessionId === s.id && u.groupId === '');
    const typeBadge = isDaily
      ? '<span class="status-badge" style="background:#e0f2fe;color:#0369a1;border:1px solid #7dd3fc;font-weight:600;">📅 一般日常</span>'
      : '<span class="status-badge" style="background:#fef3c7;color:#92400e;border:1px solid #fcd34d;font-weight:600;">📌 重要集會</span>';
    const displayName = isDaily ? (s.name || '一般日常點名') : (s.name ? esc(s.name) : '<span style="color:#94a3b8;">（未命名）</span>');
    const delLabel = isDaily ? '🗑️ 清除點名' : '🗑️ 刪除時段';
    return `
    <tr>
      <td><b>${esc(s.date)}</b>${isToday ? ' <span class="status-badge can-edit">今日</span>' : ''}</td>
      <td>${typeBadge}</td>
      <td>${esc(s.timeSlot) || '<span style="color:#94a3b8;">-</span>'}</td>
      <td><b>${displayName}</b></td>
      <td>
        ${isToday
          ? '<span class="status-badge can-edit">當日開放編輯 Open</span>'
          : allUnlock
          ? `<span class="status-badge can-edit">已開放全部組別補登${allUnlock.deadline ? `（至 ${esc(allUnlock.deadline.replace('T', ' '))}）` : ''}</span>`
          : '<span class="status-badge is-locked">已鎖定 Locked</span>'}
      </td>
      <td style="min-width:260px;">
        <div style="display:flex;flex-wrap:wrap;gap:0.35rem;align-items:center;">
          <button class="tab-btn" data-act="edit-attendance-session" data-id="${s.id}">✏️ 編輯</button>
          <button class="tab-btn" data-act="del-attendance-session" data-id="${s.id}">${delLabel}</button>
          ${!isToday ? `
            <button class="tab-btn" data-act="attendance-unlock-all" data-id="${s.id}" data-allow="1">🔓 開放全部補登</button>
            ${allUnlock ? `<button class="tab-btn" data-act="attendance-unlock-all" data-id="${s.id}" data-allow="0">🔒 關閉全部補登</button>` : ''}
            <select data-act="attendance-unlock-group" data-id="${s.id}" style="padding:0.3rem 0.4rem;font-size:0.8rem;">
              <option value="">指定組別開放/關閉…</option>
              ${c.groups.map(g => {
                const u = (c.attendanceUnlocks || []).find(x => x.sessionId === s.id && x.groupId === g.id);
                return `<option value="${esc(g.id)}">${esc(g.name)}${u ? '（已開放）' : ''}</option>`;
              }).join('')}
            </select>
          ` : ''}
        </div>
      </td>
    </tr>`;
  }).join('');

  /* ---- 2. 依日期查看各組缺席紀錄 ---- */
  if (!attendanceStatDate) attendanceStatDate = today;
  const dailySessions = sessions.filter(s => s.date === attendanceStatDate);
  const dailyRows = c.groups.map(g => {
    const mates = members(c, g.id);
    const perSession = dailySessions.map(s => {
      const recs = attendanceRecordsFor(c, s.id).filter(r => r.groupId === g.id);
      const absentRecs = recs.filter(r => r.status === 'absent');
      const label = attendanceSessionLabel(s) || s.date;
      if (!recs.length) return `<div style="color:#94a3b8;font-size:0.85rem;">${esc(label)}：尚未點名 Not taken</div>`;
      if (!absentRecs.length) return `<div style="color:#166534;font-size:0.85rem;">${esc(label)}：✅ 全員到齊</div>`;
      return `<div style="font-size:0.85rem;">${esc(label)}：${absentRecs.map(r => {
        const st = c.students.find(x => x.id === r.studentId);
        if (!st) return '';
        const corrected = r.createdAt && r.updatedAt && r.updatedAt !== r.createdAt;
        const timeNote = corrected
          ? `點名 ${formatLogTime(r.createdAt)}／修正 ${formatLogTime(r.updatedAt)}`
          : `點名 ${formatLogTime(r.updatedAt)}`;
        return `<span class="attendance-absent-tag" title="${esc(timeNote)}">${esc(st.name)} (${esc(st.id)}) 缺席</span>`;
      }).join(' ')}</div>`;
    }).join('');
    return `
    <tr>
      <td><b>${esc(g.name)}</b></td>
      <td>${mates.length} 人</td>
      <td>${perSession || '<span style="color:#94a3b8;">當日無點名時段</span>'}</td>
    </tr>`;
  }).join('');

  /* ---- 3. 尚未完成點名的組別 ---- */
  const progressSession = attendanceProgressSessionId
    ? sessions.find(s => s.id === attendanceProgressSessionId)
    : (sessions.find(s => s.date === today) || sessions[0] || null);
  const progress = progressSession ? attendanceGroupProgress(c, progressSession.id) : [];
  const incomplete = progress.filter(p => !p.complete && p.total > 0);

  /* ---- 4. 組員缺席排行榜 ---- */
  const counts = attendanceAbsentCounts(c, attendanceStatScope === 'date' ? attendanceStatDate : null);
  const leaderboard = Object.entries(counts)
    .map(([sid, n]) => {
      const st = c.students.find(x => x.id === sid);
      const g = st ? c.groups.find(x => x.id === st.groupId) : null;
      return { id: sid, name: st ? st.name : sid, groupName: g ? g.name : '未分組', count: n };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);

  return `
  <div class="teacher-section">
    <h2>📋 點名管理 Attendance <small>${esc(courseLabel(c))} · Điểm danh</small></h2>
    ${noticeBanner}
    ${sessionForm}
    ${sessions.length ? `
    <div class="table-wrap" style="margin-top:1rem;">
      <table class="roster" style="background:#fff;">
        <thead><tr><th>日期</th><th>類型</th><th>時段</th><th>點名名稱</th><th>狀態</th><th>操作</th></tr></thead>
        <tbody>${sessionRows}</tbody>
      </table>
    </div>` : '<p class="file-path">尚未設定任何點名時段。</p>'}
  </div>

  <div class="teacher-section">
    <h2>目前組長／副組長列表 <small>Current leaders &amp; vice leaders</small></h2>
    ${c.groups.length ? `
    <div class="table-wrap">
      <table class="roster" style="background:#fff;">
        <thead><tr><th>組別</th><th>組長</th><th>副組長</th></tr></thead>
        <tbody>${c.groups.map(g => {
          const lead = leaderOf(c, g.id);
          const vice = members(c, g.id).find(m => m.isVice);
          const renderPerson = (st, role) => {
            if (!st) return `<span style="color:${role === '組長' ? '#dc2626' : '#94a3b8'};">（無${role}）</span>`;
            return `<div style="display:flex;align-items:center;justify-content:space-between;gap:0.5rem;flex-wrap:wrap;">
              <span><b>${esc(st.name)}</b> <small style="color:#64748b;">(${esc(st.id)})</small></span>
              <button class="tab-btn" data-act="teacher-manage-student-pw" data-id="${esc(st.id)}" data-name="${esc(st.name)}" data-has-custom="${st.hasCustomPassword ? '1' : '0'}" title="協助修改或重設密碼 (${st.hasCustomPassword ? '已自訂密碼' : '預設學號'})" style="padding:0.15rem 0.45rem;font-size:0.75rem;">🔑 密碼</button>
            </div>`;
          };
          return `
          <tr>
            <td><b>${esc(g.name)}</b></td>
            <td>${renderPerson(lead, '組長')}</td>
            <td>${renderPerson(vice, '副組長')}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>
    </div>` : '<p class="file-path">尚未建立組別。</p>'}
  </div>

  <div class="teacher-section">
    <h2>各組當日缺席紀錄 <small>Daily absence</small></h2>
    <div style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;margin-bottom:0.75rem;">
      <label style="font-weight:600;font-size:0.85rem;">查詢日期：</label>
      <input type="date" data-act="attendance-stat-date" value="${esc(attendanceStatDate)}">
    </div>
    ${c.groups.length ? `
    <div class="table-wrap">
      <table class="roster" style="background:#fff;">
        <thead><tr><th>組別</th><th>人數</th><th>缺席標記</th></tr></thead>
        <tbody>${dailyRows}</tbody>
      </table>
    </div>` : '<p class="file-path">尚未建立組別。</p>'}
  </div>

  <div class="teacher-section">
    <h2>尚未完成點名的組別與組員 <small>Incomplete groups &amp; members</small></h2>
    <div style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;margin-bottom:0.75rem;">
      <label style="font-weight:600;font-size:0.85rem;">選擇時段：</label>
      <select data-act="attendance-progress-session">
        ${sessions.map(s => `<option value="${s.id}" ${progressSession && progressSession.id === s.id ? 'selected' : ''}>${esc(attendanceSessionLabel(s))}</option>`).join('') || '<option value="">尚無時段</option>'}
      </select>
    </div>
    ${!progressSession ? '<p class="file-path">尚無點名時段。</p>' : incomplete.length ? `
    <div class="table-wrap">
      <table class="roster" style="background:#fff;">
        <thead><tr><th>組別</th><th>完成進度</th><th>尚未被點名的組員（含組長／副組長）</th><th>跨組代理點名 Cross-group delegate</th></tr></thead>
        <tbody>${incomplete.map(p => {
          const delegates = (c.attendanceDelegates || []).filter(d => d.sessionId === progressSession.id && d.groupId === p.group.id);
          const candidates = c.students.filter(st => (st.isLeader || st.isVice) && st.groupId !== p.group.id);
          return `
          <tr>
            <td><b>${esc(p.group.name)}</b></td>
            <td><span class="status-badge under-threshold">${p.done} / ${p.total} 人</span></td>
            <td>${p.missing.map(m => `<span class="attendance-absent-tag">${esc(m.name)} (${esc(m.id)})${m.isLeader ? ' 組長' : m.isVice ? ' 副組長' : ''}</span>`).join(' ')}</td>
            <td style="min-width:220px;">
              ${delegates.map(d => `
                <div style="display:flex;align-items:center;gap:0.35rem;margin-bottom:0.3rem;font-size:0.82rem;">
                  <span class="group-name-tag">🔁 ${esc(d.delegateName || d.delegateId)}</span>
                  <button class="tab-btn" data-act="remove-attendance-delegate" data-session="${progressSession.id}" data-group="${p.group.id}" data-delegate="${esc(d.delegateId)}">移除</button>
                </div>`).join('')}
              <select data-act="assign-attendance-delegate" data-session="${progressSession.id}" data-group="${p.group.id}" style="font-size:0.8rem;padding:0.3rem 0.4rem;">
                <option value="">指派代理組長/副組長跨組點名…</option>
                ${candidates.map(st => `<option value="${esc(st.id)}">${esc(st.name)} (${esc(st.id)}) － ${esc((c.groups.find(gg => gg.id === st.groupId) || {}).name || '')}</option>`).join('')}
              </select>
            </td>
          </tr>`;
        }).join('')}</tbody>
      </table>
    </div>` : '<p class="file-path">✅ 該時段所有組別的全部組員皆已完成點名。</p>'}
  </div>

  <div class="teacher-section">
    <h2>組員缺席排行榜 <small>Absence leaderboard</small></h2>
    <div style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;margin-bottom:0.75rem;">
      <select data-act="attendance-stat-scope">
        <option value="date" ${attendanceStatScope === 'date' ? 'selected' : ''}>依日期（${esc(attendanceStatDate)}）</option>
        <option value="all" ${attendanceStatScope === 'all' ? 'selected' : ''}>整學期 Whole semester</option>
      </select>
    </div>
    ${leaderboard.length ? `
    <div class="table-wrap">
      <table class="roster" style="background:#fff;">
        <thead><tr><th>排名</th><th>學號</th><th>姓名</th><th>組別</th><th>缺席次數</th></tr></thead>
        <tbody>${leaderboard.map((l, i) => `
          <tr><td>${i + 1}</td><td>${esc(l.id)}</td><td>${esc(l.name)}</td><td>${esc(l.groupName)}</td><td><b style="color:#b91c1c;">${l.count}</b></td></tr>
        `).join('')}</tbody>
      </table>
    </div>` : '<p class="file-path">目前無缺席紀錄。</p>'}
  </div>`;
}

function teacherPasswordBlock(c) {
  const leaders = c ? c.students.filter(s => s.isLeader || s.isVice) : [];

  return `
  <div class="teacher-section">
    <h2>更改管理者密碼 <small>Change admin password</small></h2>
    <form data-act="change-password" class="pw-form">
      <div class="form-group"><label>目前密碼 Current</label><input type="password" name="current" required autocomplete="off"></div>
      <div class="form-group"><label>新密碼 New（至少 4 碼）</label><input type="password" name="next" required minlength="4" autocomplete="off"></div>
      <button class="btn btn-primary" type="submit">更新密碼 Update password</button>
    </form>
    <p class="file-path">更換老師管理後台密碼。預設密碼為 admin。</p>
  </div>

  <div class="teacher-section" style="margin-top:2rem;">
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.5rem;margin-bottom:0.75rem;">
      <h2 style="margin:0;">🔑 各組組長與副組長密碼管理 <small>Leader &amp; Vice-leader Passwords</small></h2>
      ${c ? `<span class="status-badge" style="background:#f1f5f9;color:#334155;">目前課程：<b>${esc(c.year)} ${esc(c.subject)}</b></span>` : ''}
    </div>
    <p class="file-path" style="margin:0 0 1rem;color:#475569;">
      擔任組長與副組長之學生登入後台時，預設密碼為「學號」。學生登入後可於其個人後台自行設定新密碼。<br>
      若組長或副組長忘記自訂密碼，老師可在此協助<b>設定新密碼</b>或直接<b>重設回預設學號</b>。
    </p>

    ${!c ? '<p class="file-path" style="color:#dc2626;">請先從左側選擇學年度課程，以檢視該班級之組長／副組長名單。</p>' :
      leaders.length ? `
      <div class="table-wrap">
        <table class="roster" style="background:#fff;">
          <thead>
            <tr>
              <th>組別 Group</th>
              <th>職位 Role</th>
              <th>學號 ID</th>
              <th>姓名 Name</th>
              <th>密碼狀態 Status</th>
              <th style="width:210px;">密碼管理操作 Actions</th>
            </tr>
          </thead>
          <tbody>
            ${leaders.map(s => {
              const g = c.groups.find(x => x.id === s.groupId);
              const roleText = s.isLeader ? '⭐ 組長' : '🛡️ 副組長';
              return `
              <tr>
                <td><b>${esc(g ? g.name : '未編組')}</b></td>
                <td><span class="tag-inline ${s.isLeader ? 'leader' : ''}">${roleText}</span></td>
                <td>${esc(s.id)}</td>
                <td><b>${esc(s.name)}</b></td>
                <td>
                  ${s.hasCustomPassword
                    ? '<span class="status-badge" style="background:#fef3c7;color:#92400e;border:1px solid #fde68a;">🔐 已自訂密碼</span>'
                    : '<span class="status-badge" style="background:#f1f5f9;color:#64748b;border:1px solid #cbd5e1;">ℹ️ 預設學號</span>'}
                </td>
                <td style="white-space:nowrap;">
                  <button class="btn btn-secondary" style="padding:0.25rem 0.6rem;font-size:0.8rem;margin-right:0.35rem;" data-act="teacher-set-student-pw" data-id="${esc(s.id)}" data-name="${esc(s.name)}">✏️ 設定新密碼</button>
                  <button class="tab-btn" style="padding:0.25rem 0.6rem;font-size:0.8rem;" data-act="teacher-reset-student-pw" data-id="${esc(s.id)}" data-name="${esc(s.name)}">🔄 重設為學號</button>
                </td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
      ` : '<p class="file-path">本課程目前尚未產生任何組長或副組長。學生登記或指派為組長／副組長後，即可於此處管理其登入密碼。</p>'
    }
  </div>`;
}

function rosterTable(c) {
  if (!c.students.length) return '<p class="file-path">尚無學生 No students yet.</p>';
  const opts = s => ['<option value="">未分組 —</option>']
    .concat(c.groups.map(g => `<option value="${g.id}" ${s.groupId === g.id ? 'selected' : ''}>${esc(g.name)}</option>`))
    .join('');
  return `<div class="table-wrap"><table class="roster">
    <thead><tr><th>學號 ID</th><th>姓名 Name</th><th>組別 Group</th><th>組長 Leader</th><th>期末考調分</th><th>動作</th></tr></thead>
    <tbody>${c.students.map(s => {
      const g = c.groups.find(x => x.id === s.groupId);
      const adj = calcAdjustment(c, g, s);
      const isLeadOrVice = s.isLeader || s.isVice;
      return `
      <tr>
        <td>${esc(s.id)}</td>
        <td>
          ${esc(s.name)}${s.autoAssigned ? ' <span class="tag-inline auto">自動</span>' : ''}${s.isVice ? ' <span class="tag-inline">副組長</span>' : ''}
          ${isLeadOrVice ? (s.hasCustomPassword ? ' <span title="已自訂密碼" style="cursor:help;font-size:0.75rem;">🔐</span>' : ' <span title="使用預設密碼（學號）" style="cursor:help;font-size:0.75rem;color:#94a3b8;">🔑</span>') : ''}
        </td>
        <td><select data-act="assign-student" data-id="${esc(keyOf(s))}">${opts(s)}</select></td>
        <td><input type="checkbox" data-act="set-leader" data-id="${esc(keyOf(s))}" ${s.isLeader ? 'checked' : ''} ${s.groupId ? '' : 'disabled'}></td>
        <td>${scoreBadge(adj)}</td>
        <td style="white-space:nowrap;">
          ${isLeadOrVice ? `<button class="tab-btn" data-act="teacher-manage-student-pw" data-id="${esc(s.id)}" data-name="${esc(s.name)}" data-has-custom="${s.hasCustomPassword ? '1' : '0'}" title="協助修改或重設密碼" style="margin-right:0.35rem;">🔑 密碼</button>` : ''}
          <button class="tab-btn" data-act="del-student" data-id="${esc(keyOf(s))}">刪除</button>
        </td>
      </tr>`;
    }).join('')}
    </tbody></table></div>`;
}

function studentScreen() {
  const c = cur(), s = me();
  if (!c || !s) { state.session = null; return authScreen(); }
  const g = c.groups.find(x => x.id === s.groupId);
  const mates = g ? members(c, g.id) : [];
  const closed = deadlinePassed(c);
  const canEdit = canGroupLeaderEdit(c, g);
  const otherLeader = g ? mates.find(m => m.isLeader && m.id !== s.id) : null;
  const isPreview = state.session && state.session.role === 'teacher';

  let html = `
  <div class="student-section">
    <h2>${esc(courseLabel(c))}</h2>
    <div class="student-info">
      <strong>學生 Student（Học sinh）:</strong> ${esc(s.name)} (${esc(s.id)})<br>
      <strong>角色 Role（Vai trò）:</strong> ${s.isLeader ? '組長 Leader（Trưởng nhóm）' : s.isVice ? '副組長 Vice leader（Phó nhóm）' : '組員 Member（Thành viên）'}<br>
      <strong>組別 Group（Nhóm）:</strong> ${g ? esc(g.name) : '未分組 Unassigned（Chưa có nhóm）'}${s.autoAssigned ? '（自動分配 Auto-assigned／Tự động phân）' : ''}
    </div>`;

  if (s.isLeader) {
    if (closed && !canEdit) {
      html += `
        <div class="deadline-alert locked">
          <span class="alert-icon">⏳</span>
          <div>
            <strong>已超過分組截止時間，組長無法更換組員 Deadline passed（Đã quá hạn, không thể đổi thành viên）</strong>
            <p>目前分組截止時間已過${(g && g.editDeadline) ? `（本組專屬截止時間 ${esc(g.editDeadline.replace('T', ' '))} 亦已截止）` : ''}，組員名單已鎖定。如需更換，請聯絡老師個別重新開放挑選權限，或由老師於後台手動調整。</p>
          </div>
        </div>`;
    } else if (closed && canEdit) {
      html += `
        <div class="deadline-alert unlocked">
          <span class="alert-icon">🔓</span>
          <div>
            <strong>老師已重新開放本科目本組挑選權限 Permission re-opened（Đã mở lại quyền）</strong>
            <p>授課老師已特別為本組開放重新挑選權限，您現在可以更換組員或調整副組長。${(g && g.editDeadline) ? `<br><b style="color:#92400e;">⏳ 本組專屬截止時間為：${esc(g.editDeadline.replace('T', ' '))}，逾時將自動鎖定。</b>` : ''}</p>
          </div>
        </div>
        ${!isPreview ? `<button class="btn btn-secondary" data-act="unclaim-leader">取消組長身分 Step down（Từ chức trưởng nhóm）</button>` : ''}`;
    } else {
      html += !isPreview ? `<button class="btn btn-secondary" data-act="unclaim-leader">取消組長身分 Step down（Từ chức trưởng nhóm）</button>` : '';
    }
  } else if (closed) {
    html += '<p class="file-path">已超過分組截止時間，無法再變更。Deadline passed.（Đã quá hạn, không thể thay đổi）</p>';
  } else if (otherLeader) {
    html += `<p class="file-path">本組組長為 ${esc(otherLeader.name)}，無法重複擔任。Group already has a leader.（Nhóm đã có trưởng nhóm）</p>`;
  } else {
    html += `
      <div class="leader-actions-row">
        <button class="btn btn-primary" data-act="claim-leader">我要當組長 Become leader（Tôi muốn làm trưởng nhóm）</button>
        <button class="btn btn-neutral" data-act="logout">不願意擔任組長，返回首頁（Không muốn làm trưởng nhóm）</button>
      </div>
      <p class="file-path">${g ? '成為本組組長後即可挑選組員。Sau khi làm trưởng nhóm có thể chọn thành viên.' : '將自動為你開一組並擔任組長。Hệ thống sẽ tự động tạo nhóm cho bạn.'}</p>`;
  }

  /* 組長專用成員管理區塊 */
  if (s.isLeader && g) {
    const min = minCap(c);
    const max = cap(c);
    const needed = Math.max(0, min - mates.length);
    const excess = Math.max(0, mates.length - max);
    const isBelowMin = mates.length < min;
    const isAboveMax = mates.length > max;
    const canDrop = canEdit && (mates.length > min); // 只有高於門檻時才允許刪減組員
    const canPick = canEdit && (mates.length < max); // 只有低於上限時才允許新增組員

    /* 1. 已挑選成員（顯示在挑選組員區塊上方） */
    html += `
    <div class="selected-members-panel">
      <div class="panel-header">
        <h3 style="margin:0">已挑選成員 Selected members（Thành viên đã chọn） <small>（下限 ${min} 人，上限 ${max} 人，目前 ${mates.length} 人）</small></h3>
        <div class="header-badges">
          ${isBelowMin
            ? `<span class="status-badge under-threshold">⚠️ 低於下限（缺 ${needed} 人）· 僅能新增組員 Below minimum（Dưới mức tối thiểu）</span>`
            : isAboveMax
            ? `<span class="status-badge under-threshold" style="background:#fef2f2;color:#991b1b;border-color:#fecaca;">⚠️ 高於上限（多 ${excess} 人）· 僅能刪減組員 Above maximum（Vượt mức tối đa）</span>`
            : `<span class="status-badge meets-threshold">✅ 人數合規（${mates.length}人，符合 ${min}~${max} 人）Valid（Hợp lệ）</span>`}
          ${canEdit ? '<span class="status-badge can-edit">組長調整中 Editable（Đang điều chỉnh）</span>' : '<span class="status-badge is-locked">已鎖定 Locked（Đã khóa）</span>'}
        </div>
      </div>
      ${isBelowMin ? `
        <div class="threshold-notice">
          <strong>⚠️ 本組現有成員數（${mates.length} 人）低於分組下限（${min} 人）</strong>
          <p>依規則：<b>此時組長只能新增組員</b>，且需從未分配的成員名單中挑選至少 <b>${needed}</b> 位組員加入，無法刪減現有成員。請於截止前完成挑選以符合門檻。（Số thành viên hiện tại thấp hơn mức tối thiểu, chỉ có thể thêm thành viên, không thể loại bớt）</p>
        </div>` : ''}
      ${isAboveMax ? `
        <div class="threshold-notice" style="background:#fff1f2;border-color:#fecdd3;color:#9f1239;">
          <strong>⚠️ 本組現有成員數（${mates.length} 人）高於分組上限（${max} 人）</strong>
          <p>依規則：<b>此時組長只能刪減組員</b>，需將至少 <b>${excess}</b> 位成員移出釋出至未分配名單中，無法再新增組員。（Số thành viên hiện tại vượt mức tối đa, chỉ có thể loại bớt, không thể thêm）</p>
        </div>` : ''}
      <div class="pick-list" style="margin-top:0.75rem">${mates.map(m => `
        <div class="student ${m.isLeader ? 'leader' : ''} ${m.isVice ? 'vice-leader' : ''}">
          <span class="student-name-tag">
            ${esc(m.name)} (${esc(m.id)})${m.isLeader ? ' — 組長 Leader（Trưởng nhóm）' : m.isVice ? ' — 副組長 Vice leader（Phó nhóm）' : ''}${m.autoAssigned ? ' <span class="tag-inline auto">自動 Auto（Tự động）</span>' : ''}
          </span>
          ${(canEdit && m.id !== s.id) ? `
            <button class="tab-btn ${m.isVice ? 'on' : ''}" data-act="toggle-vice" data-id="${esc(keyOf(m))}">
              ${m.isVice ? '取消副組長 Unset vice（Hủy phó nhóm）' : '設為副組長 Set vice（Đặt làm phó nhóm）'}</button>
            ${canDrop ? `
              <button class="tab-btn" data-act="drop" data-id="${esc(keyOf(m))}" title="移出組員釋出至未分配名單">移出釋出 Remove（Loại khỏi nhóm）</button>
            ` : `
              <button class="tab-btn disabled" disabled title="現有人數已低於或等於下限（${min}人），依規則無法移出組員，只能新增組員" style="opacity:0.5;cursor:not-allowed;">不可移出 Cannot remove（Không thể loại）</button>
            `}` : ''}
        </div>`).join('')}</div>
      <p class="file-path">提示：每組僅能有一位副組長。若現有人數低於下限只能新增組員；高於上限只能刪減組員釋出至未分配名單。（Mỗi nhóm chỉ có một phó nhóm）</p>
    </div>`;

    /* 2. 挑選組員（顯示在已挑選成員區塊下方） */
    if (canEdit) {
      const pool = unassigned(c);
      html += `
      <div class="pick-members-panel" style="margin-top:1.5rem">
        <div class="panel-header">
          <h3 style="margin:0">挑選組員 Pick members（Chọn thành viên） <small>（從未分配名單新增）</small></h3>
          ${!canPick ? `<span class="badge-full" style="background:#fee2e2;color:#991b1b;border:1px solid #fca5a5;">本組人數（${mates.length}人）已達或高於上限（${max}人），依規定只能刪減組員，無法再新增（Đã đạt mức tối đa, không thể thêm）</span>` : ''}
        </div>
        <div class="pick-list" style="margin-top:0.75rem">${pool.length ? pool.map(p => `
          <label class="student ${!canPick ? 'disabled' : ''}">
            <input type="checkbox" data-act="pick" data-id="${esc(keyOf(p))}" ${!canPick ? 'disabled' : ''}>
            ${esc(p.name)} (${esc(p.id)})
          </label>`).join('')
          : '<p class="file-path">目前沒有未分配的成員名單 No unassigned students.（Hiện không có thành viên chưa phân nhóm）</p>'}</div>
      </div>`;
    }
  }

  /* 組長／副組長皆可執行：點名 Attendance（Điểm danh）—— 置於期末評分之上 */
  if ((s.isLeader || s.isVice) && g) {
    html += attendanceLeaderPanel(c, g, s, mates);
  }

  /* 老師授權之跨組代理點名（防範某組組長／副組長皆未到） */
  if (s.isLeader || s.isVice) {
    (c.attendanceDelegates || []).forEach(del => { html += attendanceDelegatePanel(c, del); });
  }

  /* 組長專屬：期末成員貢獻度評分面板（當老師開放權限時顯示） */
  if (s.isLeader && g) {
    const maxB = Number(c && c.maxBonus) > 0 ? Number(c.maxBonus) : 10;
    const isEvalOpen = !!g.peerEvalOpen;
    const isSubmitted = !!g.peerEvalSubmitted;
    const isOverdue = isEvalOpen && evalDeadlinePassed(g) && !isSubmitted;
    const otherMembers = mates.filter(m => m.id !== s.id);

    html += `
    <div class="leader-eval-panel" style="margin-top:1.5rem;padding:1.25rem;background:#f0fdf4;border:2px solid #bbf7d0;border-radius:10px;">
      <div class="panel-header" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.5rem;">
        <h3 style="margin:0;color:#166534;">📝 期末組員貢獻度評分 Peer Evaluation（Đánh giá đóng góp cuối kỳ）</h3>
        ${isSubmitted
          ? '<span class="status-badge meets-threshold">✅ 您已完成評分提交 Submitted（Đã nộp）</span>'
          : isOverdue
          ? '<span class="status-badge under-threshold">⚠️ 已超過評分截止時間 (逾時懲罰生效) Overdue（Đã quá hạn）</span>'
          : isEvalOpen
          ? '<span class="status-badge can-edit">開放評分中 Open（Đang mở）</span>'
          : '<span class="status-badge is-locked">老師尚未開放評分 Not open（Chưa mở）</span>'}
      </div>

      <div style="margin:0.75rem 0;font-size:0.88rem;color:#14532d;line-height:1.6;">
        <p style="margin:0 0 0.4rem 0;"><b>說明：</b>在老師開放評分期間，組長可依據組員之貢獻與配合程度給予<b>加分 (0 ~ ${maxB} 分)</b>。</p>
        <p style="margin:0;color:#166534;font-weight:600;"><b>🎁 組長獎勵：</b>組長在老師開放評分權限時進行評分，<b>組長自己可獲得 ${maxB} 分的加分</b>！</p>
        ${g.peerEvalDeadline ? `<p style="margin:0.4rem 0 0 0;font-weight:600;">⏳ 本組評分截止時間：${esc(g.peerEvalDeadline.replace('T', ' '))}</p>` : ''}
      </div>

      ${!isEvalOpen ? `
        <div style="padding:0.75rem;background:#fff;border-radius:6px;border:1px dashed #86efac;color:#4b5563;font-size:0.88rem;">
          授課老師尚未開放本組評分權限。待老師開放並公告評分截止時間後，您可在此進行評分。
        </div>` : isOverdue ? `
        <div style="padding:0.75rem;background:#fef2f2;border-radius:6px;border:1px solid #fecaca;color:#991b1b;font-size:0.88rem;">
          已超過老師規定的評分截止時間，組長評分權限已關閉。因未在時限內進行評分，組長無法獲得 ${maxB} 分加分，組員亦無法獲得加分。
        </div>` : !otherMembers.length ? `
        <div style="padding:0.75rem;background:#fff;border-radius:6px;border:1px dashed #86efac;color:#4b5563;font-size:0.88rem;">
          目前組內尚無其他成員。您可直接送出評分以獲得組長專屬的 ${maxB} 分加分：
          <form data-act="submit-peer-eval" style="margin-top:0.6rem;">
            <button class="btn btn-primary" type="submit" style="padding:0.45rem 1.2rem;">確認並領取組長 ${maxB} 分加分</button>
          </form>
        </div>` : `
        <form data-act="submit-peer-eval" style="margin-top:1rem;">
          <div class="table-wrap">
            <table class="roster" style="background:#fff;">
              <thead>
                <tr>
                  <th>組員姓名 (學號) Name（Họ tên）</th>
                  <th>角色 Role（Vai trò）</th>
                  <th>期末考加分 (0 ~ ${maxB} 分) Bonus（Điểm cộng）</th>
                  <th>加分原因 / 貢獻說明 (選填) Note（Ghi chú, có thể để trống）</th>
                </tr>
              </thead>
              <tbody>
                ${otherMembers.map(m => {
                  let options = `<option value="0" ${m.peerPenalty === 0 ? 'selected' : ''}>+0 分（無額外加分）</option>`;
                  for (let i = 1; i <= maxB; i++) {
                    const extra = (i === maxB) ? '（表現優異 / 上限）' : '';
                    options += `<option value="${i}" ${m.peerPenalty === i ? 'selected' : ''}>+${i} 分${extra}</option>`;
                  }
                  return `
                  <tr>
                    <td><b>${esc(m.name)}</b> (${esc(m.id)})</td>
                    <td>${m.isVice ? '<span class="tag-inline">副組長（Phó nhóm）</span>' : '組員（Thành viên）'}</td>
                    <td>
                      <select name="penalty_${esc(keyOf(m))}" style="padding:0.35rem 0.5rem;font-size:0.9rem;border:1.5px solid #cbd5e1;border-radius:4px;" ${isSubmitted ? 'disabled' : ''}>
                        ${options}
                      </select>
                    </td>
                    <td>
                      <input type="text" name="comment_${esc(keyOf(m))}" value="${esc(m.peerComment || '')}" placeholder="若有加分可填寫貢獻事蹟" style="width:100%;max-width:260px;padding:0.35rem 0.5rem;font-size:0.85rem;" ${isSubmitted ? 'disabled' : ''}>
                    </td>
                  </tr>`;
                }).join('')}
              </tbody>
            </table>
          </div>
          <div style="margin-top:0.85rem;display:flex;align-items:center;gap:0.75rem;">
            ${isSubmitted ? `
              <span style="color:#166534;font-weight:600;font-size:0.9rem;">✅ 評分已送出完成（您已獲得組長 ${maxB} 分加分）。如需調整請直接修改並重新送出：</span>
              <button class="btn btn-primary" type="submit" style="padding:0.45rem 1.1rem;font-size:0.9rem;">重新更新評分 Update（Cập nhật）</button>
            ` : `
              <button class="btn btn-primary" type="submit" style="padding:0.5rem 1.4rem;font-size:0.95rem;">送出評分（組長即獲 +${maxB} 分）Submit Evaluation（Gửi đánh giá）</button>
              <span style="font-size:0.82rem;color:#64748b;">提交後組長自身立即獲得 ${maxB} 分加分，截止前仍可重複調整組員分數。</span>
            `}
          </div>
        </form>`}
    </div>`;
  }

  /* 組長／副組長皆可修改個人登入密碼 */
  if (s.isLeader || s.isVice) {
    html += studentPasswordPanel(s);
  }

  return html + '</div>';
}

/* ===== 組長／副組長：個人密碼修改卡片 ===== */
function studentPasswordPanel(s) {
  return `
  <div class="leader-eval-panel" style="margin-top:1.5rem;padding:1.15rem 1.25rem;background:#f8fafc;border:2px solid #cbd5e1;border-radius:12px;">
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.5rem;margin-bottom:0.75rem;">
      <h3 style="margin:0;color:#1e293b;font-size:1.05rem;display:flex;align-items:center;gap:0.4rem;">
        <span>🔑</span> 修改個人登入密碼 <small style="color:#64748b;font-weight:normal;">Change Password（Đổi mật khẩu）</small>
      </h3>
      <span class="status-badge" style="background:#e0f2fe;color:#0369a1;border:1px solid #7dd3fc;font-size:0.8rem;">
        ${s.hasCustomPassword ? '🔐 已自訂密碼' : 'ℹ️ 使用預設密碼（學號）'}
      </span>
    </div>
    <p class="file-path" style="margin:0 0 0.85rem;color:#475569;">
      擔任組長或副組長可在此修改個人登入密碼。預設密碼為您的學號。修改後下次登入請使用新密碼。若日後忘記密碼，可請授課老師於後台協助重設。（Mật khẩu mặc định là mã sinh viên. Nếu quên mật khẩu, hãy nhờ giáo viên đặt lại.）
    </p>
    <form data-act="change-student-password" class="form-row" style="background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:0.9rem 1rem;">
      <div class="form-group" style="flex:1;min-width:180px;">
        <label>目前密碼 Current Password</label>
        <input type="password" name="current" placeholder="${s.hasCustomPassword ? '請輸入目前密碼' : '首次修改請輸入您的學號'}" required autocomplete="off">
      </div>
      <div class="form-group" style="flex:1;min-width:180px;">
        <label>新密碼 New Password（至少 4 碼）</label>
        <input type="password" name="next" minlength="4" placeholder="請輸入新密碼" required autocomplete="off">
      </div>
      <div class="form-group" style="flex:1;min-width:180px;">
        <label>再次確認新密碼 Confirm</label>
        <input type="password" name="confirm" minlength="4" placeholder="請再次輸入新密碼" required autocomplete="off">
      </div>
      <div class="form-group full" style="margin-top:0.25rem;">
        <button class="btn btn-primary" type="submit" style="padding:0.45rem 1.25rem;font-size:0.9rem;">
          💾 儲存修改新密碼 Save Password
        </button>
      </div>
    </form>
  </div>`;
}

/* ===== 組長／副組長：點名面板 Attendance（Điểm danh）===== */
function attendanceLeaderPanel(c, g, s, mates) {
  const sessions = attendanceSessions(c);
  const today = todayDateStr();

  // 1. 取得或準備當日「一般日常點名」時段
  const todayDaily = sessions.find(x => x.date === today && isDailySession(x)) || {
    id: `daily-${today}`,
    courseId: c.id,
    date: today,
    timeSlot: '',
    name: '一般日常點名',
    isDaily: true,
  };

  // 當日日常點名紀錄與狀態
  const dailyRecs = attendanceRecordsFor(c, todayDaily.id).filter(r => r.groupId === g.id);
  const dailyRecByRef = {};
  dailyRecs.forEach(r => { dailyRecByRef[r.ref] = r.status; });
  const dailyMarkedMates = mates.filter(m => dailyRecByRef[keyOf(m)] === 'present' || dailyRecByRef[keyOf(m)] === 'absent');
  const dailyCompleted = mates.length > 0 && dailyMarkedMates.length === mates.length;
  const dailyAbsentCount = mates.filter(m => dailyRecByRef[keyOf(m)] === 'absent').length;
  const dailyPresentCount = mates.filter(m => dailyRecByRef[keyOf(m)] === 'present').length;

  const renderMemberRows = (recMap) => mates.map(m => {
    const key = keyOf(m);
    const st = recMap[key] || '';
    return `
    <div class="attendance-row" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.5rem;padding:0.45rem 0.25rem;border-bottom:1px dashed #e2e8f0;">
      <span style="font-size:0.92rem;">
        <b>${esc(m.name)}</b> <span style="color:#64748b;font-size:0.88rem;">(${esc(m.id)})</span>
        ${m.isLeader ? ' <span class="status-badge" style="background:#fef3c7;color:#92400e;font-size:0.75rem;">👑組長</span>' : m.isVice ? ' <span class="status-badge" style="background:#f0fdf4;color:#166534;font-size:0.75rem;">⭐副組長</span>' : ''}
        ${!st ? ' <span class="status-badge under-threshold" style="font-size:0.75rem;">尚未確認</span>' : ''}
      </span>
      <span style="display:flex;gap:1.25rem;font-size:0.88rem;">
        <label style="cursor:pointer;display:inline-flex;align-items:center;gap:0.3rem;">
          <input type="radio" name="att_${esc(key)}" value="present" ${st === 'present' ? 'checked' : ''} required>
          <span style="color:#166534;font-weight:${st === 'present' ? '700' : 'normal'};">出席 Present（Có mặt）</span>
        </label>
        <label style="cursor:pointer;display:inline-flex;align-items:center;gap:0.3rem;">
          <input type="radio" name="att_${esc(key)}" value="absent" ${st === 'absent' ? 'checked' : ''} required>
          <span style="color:#dc2626;font-weight:${st === 'absent' ? '700' : 'normal'};">缺席 Absent（Vắng mặt）</span>
        </label>
      </span>
    </div>`;
  }).join('');

  // 區塊 1：今日一般日常點名卡片
  const dailyCard = `
  <div style="background:#ffffff;border:2px solid #2563eb;border-radius:10px;padding:1.15rem 1.25rem;margin-bottom:1.25rem;box-shadow:0 2px 4px rgba(37,99,235,0.06);">
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.5rem;margin-bottom:0.75rem;">
      <div style="display:flex;align-items:center;gap:0.5rem;">
        <span style="font-size:1.35rem;">📅</span>
        <h4 style="margin:0;font-size:1.1rem;color:#1e3a8a;">
          今日一般日常點名 Daily Attendance <small style="font-weight:normal;color:#64748b;">（Điểm danh hàng ngày hôm nay）</small>
        </h4>
      </div>
      <div style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;">
        <span class="status-badge" style="background:#dbeafe;color:#1d4ed8;border:1px solid #bfdbfe;font-weight:600;">日期：${esc(today)}</span>
        ${dailyCompleted
          ? `<span class="status-badge can-edit" style="font-size:0.85rem;">✅ 今日點名已完成（出席 ${dailyPresentCount} / 缺席 ${dailyAbsentCount}）</span>`
          : dailyMarkedMates.length > 0
          ? `<span class="status-badge under-threshold" style="font-size:0.85rem;">⚠️ 點名進行中（已確認 ${dailyMarkedMates.length}/${mates.length} 人）</span>`
          : `<span class="status-badge under-threshold" style="font-size:0.85rem;">⏳ 今日尚未點名 Not Yet Taken</span>`}
      </div>
    </div>
    <div style="background:#f8fafc;border-left:4px solid #2563eb;padding:0.6rem 0.85rem;margin-bottom:0.85rem;font-size:0.85rem;color:#334155;border-radius:0 6px 6px 0;">
      💡 <b>一般日常點名無需老師在後台建立時段</b>。請組長或副組長<b>逐一確認</b>每位組員今天是否出席或缺席，確認後點選下方送出（當日可隨時重新更新修正）。<br>
      <small style="color:#64748b;">(Không cần giáo viên tạo trước. Trưởng/Phó nhóm vui lòng xác nhận từng thành viên có mặt hoặc vắng mặt hôm nay.)</small>
    </div>
    <form data-act="mark-attendance" data-session="${todayDaily.id}" data-group="${g.id}" class="attendance-mark-form">
      <div class="attendance-mark-list">
        ${renderMemberRows(dailyRecByRef)}
      </div>
      <div style="margin-top:0.9rem;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.6rem;">
        <span style="font-size:0.82rem;color:#64748b;">※ 請逐一為每位組員勾選出缺席後送出（Vui lòng chọn đủ cho tất cả thành viên）。</span>
        <button class="btn btn-primary" type="submit" style="padding:0.5rem 1.4rem;font-size:0.92rem;">
          ${dailyMarkedMates.length > 0 ? '🔄 重新更新今日日常點名 Update Daily Attendance' : '📋 送出今日日常點名 Submit Daily Attendance'}
        </button>
      </div>
    </form>
  </div>`;

  // 2. 重要集會與額外點名時段（排除今日一般日常點名後的其餘時段）
  const specialSessions = sessions.filter(x => x.id !== todayDaily.id);
  const activeSpecialSessions = specialSessions.filter(x => isAttendanceEditable(c, x, g.id));
  const historySessions = specialSessions.filter(x => !isAttendanceEditable(c, x, g.id)).slice(0, 10);

  // 區塊 2：重要集會與額外點名時段
  let specialCard = '';
  if (activeSpecialSessions.length > 0) {
    specialCard = `
    <div style="background:#ffffff;border:2px solid #f59e0b;border-radius:10px;padding:1.15rem 1.25rem;margin-bottom:1.25rem;box-shadow:0 2px 4px rgba(245,158,11,0.06);">
      <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.75rem;">
        <span style="font-size:1.35rem;">📌</span>
        <h4 style="margin:0;font-size:1.1rem;color:#b45309;">
          重要集會與額外點名 Special Sessions &amp; Assemblies <small style="font-weight:normal;color:#78350f;">（Điểm danh sự kiện / tập trung quan trọng）</small>
        </h4>
      </div>
      <p class="file-path" style="margin:0 0 0.75rem;">老師已在後台指定重要集會或額外點名時段，請組長或副組長逐一確認點名：</p>
      ${activeSpecialSessions.map(session => {
        const recs = attendanceRecordsFor(c, session.id).filter(r => r.groupId === g.id);
        const recByRef = {};
        recs.forEach(r => { recByRef[r.ref] = r.status; });
        const label = attendanceSessionLabel(session) || session.date;
        const isToday = session.date === today;
        const marked = mates.filter(m => recByRef[keyOf(m)] === 'present' || recByRef[keyOf(m)] === 'absent');
        const done = mates.length > 0 && marked.length === mates.length;
        const absents = mates.filter(m => recByRef[keyOf(m)] === 'absent').length;
        const presents = mates.filter(m => recByRef[keyOf(m)] === 'present').length;
        return `
        <div style="border:1px solid #fed7aa;background:#fffaf5;border-radius:8px;padding:0.9rem 1rem;margin-bottom:0.85rem;">
          <form data-act="mark-attendance" data-session="${session.id}" data-group="${g.id}" class="attendance-mark-form">
            <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.4rem;margin-bottom:0.6rem;">
              <b style="font-size:0.98rem;color:#9a3412;">${esc(label)}</b>
              <div style="display:flex;align-items:center;gap:0.4rem;">
                <span class="status-badge can-edit">${isToday ? '今日可編輯 Today' : '老師已開放補登 Unlocked'}</span>
                ${done ? `<span class="status-badge can-edit">✅ 已完成（出席 ${presents} / 缺席 ${absents}）</span>` : ''}
              </div>
            </div>
            <div class="attendance-mark-list">
              ${renderMemberRows(recByRef)}
            </div>
            <div style="margin-top:0.75rem;text-align:right;">
              <button class="btn btn-primary" type="submit" style="padding:0.45rem 1.2rem;font-size:0.9rem;">
                ${marked.length > 0 ? '🔄 重新更新此時段點名 Update' : '📋 送出重要集會點名 Submit'}
              </button>
            </div>
          </form>
        </div>`;
      }).join('')}
    </div>`;
  } else {
    specialCard = `
    <div style="background:#fffbeb;border:1px dashed #fcd34d;border-radius:8px;padding:0.75rem 1rem;margin-bottom:1.25rem;font-size:0.86rem;color:#92400e;">
      📌 <b>重要集會與額外點名時段</b>：目前無老師設定的特殊集會點名時段。若遇系週會、專案評審或重要集會，老師將於後台加註名稱並新增時段，屆時將在此處開放額外點名。
    </div>`;
  }

  // 區塊 3：歷史點名紀錄
  let historySection = '';
  if (historySessions.length > 0) {
    historySection = `
    <div style="margin-top:1.25rem;">
      <h5 style="margin:0 0 0.5rem;color:#475569;font-size:0.95rem;">📜 歷史點名紀錄 Past Attendance Records（Lịch sử điểm danh）</h5>
      ${historySessions.map(session => {
        const recs = attendanceRecordsFor(c, session.id).filter(r => r.groupId === g.id);
        const label = attendanceSessionLabel(session) || session.date;
        const absentNames = recs.filter(r => r.status === 'absent').map(r => {
          const m = mates.find(x => x.ref === r.ref);
          return m ? `${m.name} (${m.id})` : r.ref;
        });
        const isDaily = isDailySession(session);
        return `
        <div class="attendance-session-row" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:0.65rem 0.9rem;margin-bottom:0.5rem;font-size:0.86rem;">
          <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.4rem;">
            <span>
              <b>${esc(label)}</b>
              ${isDaily ? ' <span class="status-badge" style="background:#e0f2fe;color:#0369a1;font-size:0.75rem;">日常點名</span>' : ' <span class="status-badge" style="background:#fef3c7;color:#92400e;font-size:0.75rem;">重要集會</span>'}
            </span>
            <span class="status-badge is-locked">已鎖定 Locked</span>
          </div>
          <div style="margin-top:0.25rem;color:#475569;">
            ${!recs.length ? '尚未點名 Not taken（Chưa điểm danh）'
              : absentNames.length ? `缺席 Absent（Vắng mặt）：${absentNames.map(esc).join('、')}`
              : '✅ 全員到齊 All present（Đầy đủ）'}
          </div>
          <div style="margin-top:0.2rem;font-size:0.76rem;color:#94a3b8;">如需補登請聯絡老師開放權限 Ask teacher to unlock（Liên hệ giáo viên để mở lại）</div>
        </div>`;
      }).join('')}
    </div>`;
  }

  return `
  <div class="leader-eval-panel" style="margin-top:1.5rem;padding:1.25rem;background:#f8fafc;border:2px solid #cbd5e1;border-radius:12px;">
    <h3 style="margin:0 0 0.5rem;color:#1e3a8a;display:flex;align-items:center;gap:0.4rem;">
      <span>📋</span> 點名面板 Attendance <small style="color:#64748b;font-weight:normal;">Điểm danh</small>
    </h3>
    <p class="file-path" style="margin:0 0 1rem;">
      組長 Leader（Trưởng nhóm）或副組長 Vice leader（Phó nhóm）可於當天直接進行<b>一般日常點名</b>；若遇<b>重要集會</b>，亦可於下方專區進行額外點名。超過當天需老師開放補登權限。
    </p>
    ${dailyCard}
    ${specialCard}
    ${historySection}
  </div>`;
}

/* ===== 跨組代理點名：老師授權某組長／副組長代理另一組（該組組長／副組長皆未到）點名 ===== */
function attendanceDelegatePanel(c, del) {
  const session = attendanceSessions(c).find(x => x.id === del.sessionId);
  if (!session) return '';
  const mates = members(c, del.groupId);
  const editable = isAttendanceEditable(c, session, del.groupId);
  const recs = attendanceRecordsFor(c, session.id).filter(r => r.groupId === del.groupId);
  const recByRef = {};
  recs.forEach(r => { recByRef[r.ref] = r.status; });
  const label = attendanceSessionLabel(session) || session.date;

  return `
  <div class="leader-eval-panel" style="margin-top:1.5rem;padding:1.25rem;background:#fdf4ff;border:2px solid #e9d5ff;border-radius:10px;">
    <h3 style="margin:0 0 0.5rem;color:#6b21a8;">🔁 跨組代理點名 Cross-group delegate（Điểm danh hộ nhóm khác）</h3>
    <p class="file-path" style="margin:0 0 0.75rem;">老師已授權您代理「${esc(del.groupName)}」於 ${esc(label)} 的點名（該組組長／副組長皆未到）。Authorized by teacher to mark attendance for another group（Được giáo viên ủy quyền điểm danh hộ nhóm khác）。</p>
    ${!editable ? `
      <p class="file-path" style="color:#991b1b;">此授權已失效或已逾期。This authorization is no longer active.</p>
    ` : `
    <form data-act="mark-attendance" data-session="${session.id}" data-group="${del.groupId}" class="attendance-mark-form">
      <div class="attendance-mark-list">
        ${mates.map(m => {
          const key = keyOf(m);
          const st = recByRef[key] || '';
          return `
          <div class="attendance-row" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.5rem;padding:0.3rem 0;border-bottom:1px dashed #e2e8f0;">
            <span>${esc(m.name)} (${esc(m.id)})${m.isLeader ? ' 👑組長（Trưởng nhóm）' : m.isVice ? ' ⭐副組長（Phó nhóm）' : ''}${!st ? ' <span class="status-badge under-threshold">尚未點名（Chưa điểm danh）</span>' : ''}</span>
            <span style="display:flex;gap:0.75rem;font-size:0.85rem;">
              <label><input type="radio" name="att_${esc(key)}" value="present" ${st === 'present' ? 'checked' : ''}> 出席 Present（Có mặt）</label>
              <label><input type="radio" name="att_${esc(key)}" value="absent" ${st === 'absent' ? 'checked' : ''}> 缺席 Absent（Vắng mặt）</label>
            </span>
          </div>`;
        }).join('')}
      </div>
      <button class="btn btn-primary" type="submit" style="margin-top:0.75rem;padding:0.4rem 1.1rem;font-size:0.88rem;">送出點名 Submit（Gửi điểm danh）</button>
    </form>`}
  </div>`;
}

/* ===== 老師切換預覽模式專用提示橫幅 ===== */
function teacherPreviewBanner() {
  if (!state.session || state.session.role !== 'teacher' || teacherPreviewMode === 'admin') return '';
  const isLeader = teacherPreviewMode === 'leader';
  const c = cur();
  return `
  <div class="teacher-preview-floating-bar">
    <div class="preview-bar-left">
      <span class="preview-pulse-icon">${isLeader ? '🎓' : '👀'}</span>
      <span class="preview-text">
        目前為<b>【${isLeader ? '擔任組長之學生登入' : '一般學生看到的前台'}】</b>視角預覽模式
        ${c ? `（課程：${esc(courseLabel(c))}）` : ''}
      </span>
    </div>
    <div class="preview-bar-right">
      <button class="btn btn-secondary" data-act="switch-preview" data-mode="${isLeader ? 'public' : 'leader'}" style="padding:0.35rem 0.8rem;font-size:0.85rem;margin:0;">
        切換為${isLeader ? '一般學生視角' : '組長登入視角'}
      </button>
      <button class="btn btn-primary" data-act="switch-preview" data-mode="admin" style="padding:0.35rem 0.9rem;font-size:0.85rem;margin:0;">
        ⚙️ 返回老師後台 Exit Preview
      </button>
    </div>
  </div>`;
}

/* ===== Render ===== */
function render() {
  const isTeacher = state.session && state.session.role === 'teacher';
  const isStudent = state.session && state.session.role === 'student';

  let body = '';
  if (!state.session) {
    body = authScreen();
  } else if (isTeacher) {
    if (teacherPreviewMode === 'public') {
      body = authScreen();
    } else if (teacherPreviewMode === 'leader') {
      body = studentScreen();
    } else {
      body = teacherScreen();
    }
  } else {
    body = studentScreen();
  }

  const showHowto = isStudent || (isTeacher && teacherPreviewMode === 'leader');

  document.getElementById('app').innerHTML =
    nav() + teacherPreviewBanner() + '<div class="container">' + (showHowto ? howto() : '') + body + '</div>';
  if (!state.session && loginMode) {
    const first = document.querySelector('#login input');
    if (first) first.focus();
  }
}

/* ===== Export ===== */
function exportJSON(c) {
  download(JSON.stringify({ year: c.year, subject: c.subject, groups: c.groups, students: c.students, exportedAt: new Date().toISOString() }, null, 2),
    'application/json', `${c.year || 'grouping'}_${c.subject || 'data'}.json`);
}

function exportCSV(c) {
  const rows = [['學號', '姓名', '組別', '角色', '自動分組', '期末考調分', '調分原因說明', '組長加分評定', '組長評語']];
  // 依學號排序（支援純數字與文字學號自然排序）
  const sortedStudents = c.students.slice().sort((a, b) =>
    String(a.id).localeCompare(String(b.id), undefined, { numeric: true, sensitivity: 'base' })
  );
  sortedStudents.forEach(s => {
    const g = c.groups.find(x => x.id === s.groupId);
    const adj = calcAdjustment(c, g, s);
    rows.push([
      s.id,
      s.name,
      g ? g.name : '',
      s.isLeader ? '組長' : s.isVice ? '副組長' : '組員',
      s.autoAssigned ? 'Y' : 'N',
      adj.score,
      adj.reason,
      s.peerPenalty ? `+${s.peerPenalty}分` : '0分',
      s.peerComment || '',
    ]);
  });
  const csv = '﻿' + rows.map(r => r.map(x => `"${String(x).replace(/"/g, '""')}"`).join(',')).join('\n');
  download(csv, `${c.year || 'grouping'}_${c.subject || 'data'}_grading.csv`);
}

function exportLogsCSV(c) {
  const rows = [['時間', '動作類別', '操作者身分', '操作者學號', '操作者姓名', '組別', '對象學號', '對象姓名', '詳細說明']];
  const logs = c.logs || [];
  logs.forEach(l => {
    rows.push([
      formatLogTime(l.createdAt),
      formatActionTypeLabel(l.actionType),
      l.operatorRole === 'leader' ? '組長' : l.operatorRole === 'teacher' ? '老師' : l.operatorRole === 'system' ? '系統' : l.operatorRole,
      l.operatorId || '',
      l.operatorName || '',
      l.groupName || '',
      l.targetId || '',
      l.targetName || '',
      l.detail || '',
    ]);
  });
  const csv = '﻿' + rows.map(r => r.map(x => `"${String(x).replace(/"/g, '""')}"`).join(',')).join('\n');
  download(csv, 'text/csv;charset=utf-8', `${c.year || ''}_${c.subject || ''}_分組異動日誌.csv`);
}

function download(content, type, filename) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* 標題列（學號 / 姓名 / ID / Name）自動略過 */
const isHeaderLine = line => /學號|學生證號|姓名|名字|student\s*(id|no)|^\s*id\b|\bname\b/i.test(line);

function parseRoster(text) {
  const rows = [];
  let skipped = 0;
  text.replace(/^\ufeff/, '').split(/\r?\n/).map(l => l.trim()).filter(Boolean).forEach(line => {
    if (isHeaderLine(line)) { skipped++; return; }
    const [id, name] = line.split(/\s*[,\t|]\s*|\s+/).filter(Boolean);
    if (id && name) rows.push({ id, name });
  });
  return { rows, skipped };
}

async function importText(c, text) {
  const { rows, skipped } = parseRoster(text);
  if (!rows.length) return alert('檔案沒有可匯入的資料 Nothing to import');
  const res = await act('teacher:add-students', { courseId: c.id, students: rows });
  if (!res) return;
  const dup = rows.length - res.added;
  alert(`已匯入 ${res.added} 位學生${skipped ? `（略過標題列 ${skipped} 行）` : ''}${dup > 0 ? `，${dup} 筆學號重複已略過` : ''}`);
}

/* ===== Event delegation ===== */
const app = document.getElementById('app');
const needCourse = () => { const c = cur(); if (!c) { alert('請先選擇或建立課程 Select a course first'); return null; } return c; };

app.addEventListener('submit', e => {
  const a = e.target.dataset.act;
  if (!a) return;
  e.preventDefault();
  const f = e.target;

  if (a === 'login-teacher') {
    return act('login-teacher', { password: f.password.value }, { after: () => { loginMode = null; teacherPreviewMode = 'admin'; } });
  }
  if (a === 'login-student') {
    const c = cur();
    if (!c) return alert('請先選擇課程 Select a course');
    const name = (f.name ? f.name.value : '').trim();
    const password = (f.password ? f.password.value : (f.sid ? f.sid.value : '')).trim();
    return act('login-student', { courseId: c.id, name, password },
      { after: () => { loginMode = null; } });
  }
  if (a === 'change-student-password') {
    const current = (f.current ? f.current.value : '').trim();
    const next = (f.next ? f.next.value : '').trim();
    const confirm = (f.confirm ? f.confirm.value : '').trim();
    if (next !== confirm) {
      return alert('兩次輸入的新密碼不相符！\nPasswords do not match.');
    }
    if (next.length < 4) {
      return alert('新密碼長度至少需 4 碼！\nPassword must be at least 4 characters.');
    }
    return act('change-student-password', { current, next }, {
      after: () => {
        alert('🎉 密碼已成功修改！下次登入請使用新密碼。\nPassword changed successfully.');
        f.reset();
      }
    });
  }
  if (a === 'change-password') {
    const next = f.next.value;
    return act('teacher:change-password', { current: f.current.value, next },
      { after: () => alert('密碼已更新 Password updated') });
  }
  if (a === 'save-course') {
    const c = cur();
    return act('teacher:save-course', {
      id: c ? c.id : null,
      year: f.year.value.trim(), subject: f.subject.value.trim(),
      groupSize: Math.max(1, parseInt(f.groupSize.value) || 4),
      tolerance: Math.max(0, parseInt(f.tolerance.value) || 0),
      maxBonus: Math.max(1, parseInt(f.maxBonus ? f.maxBonus.value : 10) || 10),
      deadline: f.deadline ? f.deadline.value : (c ? (c.deadline || '') : ''),
      notice: f.notice ? f.notice.value : '',
    }, {
      after: () => alert('分組設定與注意事項已儲存完成！\nGrouping setup and notice saved successfully.'),
    }).then(data => {
      if (data && data.courseId && data.courseId !== state.currentId) {
        state.currentId = data.courseId;
        localStorage.setItem(CURRENT_KEY, data.courseId);
        render();
      }
    });
  }
  if (a === 'set-course-deadline') {
    const c = cur();
    if (!c) return;
    const deadlineVal = f.deadline ? f.deadline.value : '';
    return act('teacher:save-course', {
      id: c.id,
      year: c.year,
      subject: c.subject,
      groupSize: c.groupSize,
      tolerance: c.tolerance,
      maxBonus: c.maxBonus !== undefined ? c.maxBonus : 10,
      deadline: deadlineVal,
      notice: c.notice !== undefined ? c.notice : '',
    }, {
      after: () => alert('分組截止時間已更新 Grouping deadline updated'),
    });
  }
  if (a === 'set-all-eval') {
    const c = cur();
    if (!c) return;
    const deadline = f.evalDeadline.value;
    if (!deadline) return alert('請選擇評分截止時間');
    return act('teacher:set-all-peer-eval', { courseId: c.id, open: true, deadline },
      { after: () => alert('已成功為全體組長開放評分權限！') });
  }
  if (a === 'submit-peer-eval') {
    const c = cur(), s = me();
    if (!c || !s || !s.groupId) return;
    const g = c.groups.find(x => x.id === s.groupId);
    if (!g) return;
    const maxB = Number(c && c.maxBonus) > 0 ? Number(c.maxBonus) : 10;
    const mates = members(c, g.id).filter(m => m.id !== s.id);
    const evaluations = mates.map(m => {
      const key = keyOf(m);
      const sel = f[`penalty_${key}`];
      const inp = f[`comment_${key}`];
      return {
        studentId: key,
        penalty: sel ? parseInt(sel.value) || 0 : 0,
        comment: inp ? inp.value.trim() : '',
      };
    });
    if (!confirm(`確定送出組員貢獻度評分？送出後您（組長）將獲得 ${maxB} 分加分，組員加分也將即時生效。`)) return;
    return act('submit-peer-eval', { evaluations },
      { after: () => alert(`期末評分已成功送出！組長已獲得 ${maxB} 分加分，組員加分亦已同步更新。`) });
  }
  if (a === 'add-student') {
    const c = needCourse(); if (!c) return;
    return act('teacher:add-students', { courseId: c.id, students: [{ id: f.id.value.trim(), name: f.name.value.trim() }] });
  }
  if (a === 'save-attendance-session') {
    const c = needCourse(); if (!c) return;
    return act('teacher:save-attendance-session', {
      courseId: c.id,
      id: attendanceEditingId || undefined,
      date: f.date.value,
      timeSlot: f.timeSlot.value.trim(),
      name: f.name.value.trim(),
    }, { after: () => { attendanceEditingId = null; } });
  }
  if (a === 'mark-attendance') {
    const c = cur(), s = me();
    if (!c || !s) return;
    const groupId = f.dataset.group || s.groupId;
    if (!groupId) return;
    const mates = members(c, groupId);
    const sessionId = f.dataset.session;
    const fd = new FormData(f);
    const missing = mates.filter(m => !fd.get(`att_${keyOf(m)}`));
    if (missing.length > 0) {
      return alert(`尚有 ${missing.length} 位組員尚未確認出缺席，請組長／副組長逐一確認每位組員是否出席或缺席：\n${missing.map(m => m.name + ' (' + m.id + ')').join('、')}\n\n(Vui lòng xác nhận riêng cho tất cả thành viên)`);
    }
    const records = mates
      .map(m => ({ studentId: keyOf(m), status: fd.get(`att_${keyOf(m)}`) }))
      .filter(r => r.status === 'present' || r.status === 'absent');
    return act('mark-attendance', { sessionId, groupId, records },
      { after: () => alert('點名已送出 Attendance submitted（Đã gửi điểm danh）') });
  }
});

app.addEventListener('click', e => {
  const btn = e.target.closest('[data-act]');
  if (!btn || btn.tagName === 'INPUT' || btn.tagName === 'SELECT' || btn.tagName === 'FORM') return;
  const a = btn.dataset.act, id = btn.dataset.id;
  const c = cur();

  if (a === 'switch-preview') {
    teacherPreviewMode = btn.dataset.mode || 'admin';
    localStorage.setItem(PREVIEW_KEY, teacherPreviewMode);
    return render();
  }
  if (a === 'logout') {
    return act('logout', {}, {
      after: () => {
        loginMode = null;
        teacherView = 'course';
        teacherPreviewMode = 'admin';
        localStorage.removeItem(PREVIEW_KEY);
      }
    });
  }
  if (a === 'show-teacher-login') { e.preventDefault(); loginMode = loginMode === 'teacher' ? null : 'teacher'; return render(); }
  if (a === 'quick-student-fill') {
    e.preventDefault();
    loginMode = 'student';
    render();
    const nameIn = document.querySelector('#login input[name="name"]');
    const pwIn = document.querySelector('#login input[name="password"]') || document.querySelector('#login input[name="sid"]');
    if (nameIn && btn.dataset.name) nameIn.value = btn.dataset.name;
    if (pwIn) {
      if (btn.dataset.id && !btn.dataset.id.includes('*')) pwIn.value = btn.dataset.id;
      pwIn.focus();
    }
    document.getElementById('login')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  if (a === 'show-student-login') { e.preventDefault(); loginMode = loginMode === 'student' ? null : 'student'; return render(); }
  if (a === 'close-login') { loginMode = null; return render(); }
  if (a === 'sys-password') { teacherView = 'settings'; return render(); }
  if (a === 'sys-peer-eval') { teacherView = 'eval'; return render(); }
  if (a === 'sys-logs') { teacherView = 'logs'; return render(); }
  if (a === 'sys-attendance') { teacherView = 'attendance'; attendanceEditingId = null; return render(); }
  if (a === 'edit-attendance-session') { attendanceEditingId = id; return render(); }
  if (a === 'cancel-edit-attendance-session') { attendanceEditingId = null; return render(); }
  if (a === 'del-attendance-session') {
    if (!c) return;
    const s = (c.attendanceSessions || []).find(x => x.id === id);
    if (!s || !confirm(`確定刪除點名時段「${attendanceSessionLabel(s) || s.date}」？此時段所有點名紀錄將一併刪除，且無法復原！`)) return;
    return act('teacher:del-attendance-session', { courseId: c.id, sessionId: id });
  }
  if (a === 'attendance-unlock-all') {
    if (!c) return;
    const allow = btn.dataset.allow === '1';
    let deadline = '';
    if (allow) {
      deadline = prompt('請輸入全部組別補登截止時間（格式 YYYY-MM-DDTHH:mm，留白＝不限期）：', '');
      if (deadline === null) return;
    }
    return act('teacher:set-attendance-unlock', { courseId: c.id, sessionId: id, groupId: '', allow, deadline: (deadline || '').trim() });
  }
  if (a === 'remove-attendance-delegate') {
    if (!c) return;
    return act('teacher:set-attendance-delegate', {
      courseId: c.id,
      sessionId: btn.dataset.session,
      groupId: btn.dataset.group,
      delegateId: btn.dataset.delegate,
      allow: false,
    });
  }
  if (a === 'view-course-logs') {
    if (id) state.currentId = id;
    teacherView = 'logs';
    return render();
  }
  if (a === 'back-to-course') { teacherView = 'course'; return render(); }
  if (a === 'reset-log-filter') { logSearchText = ''; logActionFilter = 'all'; return render(); }
  if (a === 'export-logs-csv') { return c && exportLogsCSV(c); }
  if (a === 'clear-course-logs') {
    if (!c) return;
    if (!confirm(`確定要清空「${courseLabel(c)}」的所有異動日誌紀錄嗎？\n\n此動作將清除所有過往軌跡且無法復原！`)) return;
    return act('teacher:clear-logs', { courseId: c.id });
  }
  if (a === 'pick-course-node' || a === 'pick-course') {
    state.currentId = id || btn.value;
    if (teacherView !== 'eval' && teacherView !== 'logs') {
      teacherView = 'course';
    }
    localStorage.setItem(CURRENT_KEY, state.currentId);
    return render();
  }
  if (a === 'new-course') { state.currentId = null; teacherView = 'course'; return render(); }

  if (a === 'del-course') {
    const target = state.courses.find(x => x.id === id);
    if (!target || !confirm(`確定刪除「${courseLabel(target)}」及其名單與分組？`)) return;
    return act('teacher:del-course', { courseId: id });
  }
  if (a === 'del-student') {
    if (!c) return;
    return act('teacher:del-student', { courseId: c.id, studentId: id });
  }
  if (a === 'make-groups') {
    if (!c) return;
    if (!c.students.length) return alert('請先匯入學生名單 Import roster first');
    if (!confirm('將重建組別並清空現有分組，確定？\n\n系統將自動備份當前狀態，稍後如有需要可點擊「回到上一步」復原。')) return;
    return act('teacher:make-groups', { courseId: c.id });
  }
  if (a === 'make-remaining-groups') {
    if (!c) return;
    const unassigned = c.students.filter(s => !s.groupId);
    if (!unassigned.length) return alert('目前所有學生皆已分組，無未分組學生 No unassigned students');
    const needCount = Math.max(1, Math.ceil(unassigned.length / Math.max(1, c.groupSize)));
    if (!confirm(`目前有 ${unassigned.length} 位未分組學生，預計依每組 ${c.groupSize} 人建立 ${needCount} 個新組別。\n\n已建立之現有組別與成員將完全保留，確定建立？`)) return;
    return act('teacher:make-remaining-groups', { courseId: c.id });
  }
  if (a === 'restore-snapshot') {
    if (!c) return;
    if (!confirm(`確定要回到上一步？\n\n這將會復原上次清空或建立組別前的所有組別、組長與分組狀態！`)) return;
    return act('teacher:restore-groups-snapshot', { courseId: c.id },
      { after: () => alert('已成功回到上一步，分組狀態已復原！') });
  }
  if (a === 'add-group') { if (!c) return; return act('teacher:add-group', { courseId: c.id }); }
  if (a === 'clear-groups') {
    if (!c) return;
    if (!c.groups.length) return alert('本科目尚無分組 No groups to clear');
    if (!confirm(`確定刪除「${courseLabel(c)}」的所有分組？\n\n注意：學生名單與分組設定皆會完整保留，僅清空組別與組別分配。\n系統將自動備份，稍後如有需要可點擊「回到上一步」復原。`)) return;
    return act('teacher:clear-groups', { courseId: c.id });
  }
  if (a === 'select-all-del-groups') {
    document.querySelectorAll('input[name="del_group_cb"]').forEach(cb => { cb.checked = true; });
    return;
  }
  if (a === 'unselect-all-del-groups') {
    document.querySelectorAll('input[name="del_group_cb"]').forEach(cb => { cb.checked = false; });
    return;
  }
  if (a === 'del-selected-groups') {
    if (!c) return;
    const checked = Array.from(document.querySelectorAll('input[name="del_group_cb"]:checked')).map(cb => cb.value);
    if (!checked.length) return alert('請先勾選欲刪除的組別 Please select at least one group');
    if (!confirm(`確定要刪除勾選的 ${checked.length} 個組別？\n\n被刪組別的組員將退回未分組名單，其餘組別與修課名單不受影響。`)) return;
    return act('teacher:del-groups', { courseId: c.id, groupIds: checked });
  }
  if (a === 'auto-assign') {
    if (!c) return;
    const unassignedList = c.students.filter(s => !s.groupId);
    if (!unassignedList.length) return alert('目前所有學生皆已分組，無未分組學生 No unassigned students');
    const min = minCap(c);
    const completedCount = c.groups.filter(g => members(c, g.id).length >= min).length;
    const incompleteCount = c.groups.length - completedCount;
    if (!confirm(`確定要隨機分配剩餘的 ${unassignedList.length} 位未分組學生？\n\n📌 規則說明：\n• 系統將嚴格避開已達門檻（${min}人）的 ${completedCount} 個已完成組別，絕不更動其成員與名單。\n• 僅分配至未達門檻的 ${incompleteCount} 個組別；若現有組別皆已完成，系統將自動為剩餘組員建立新組別收納。`)) return;
    return act('teacher:auto-assign', { courseId: c.id },
      { after: () => alert('已成功完成剩餘學生隨機分配！已完成編組的組別成員完全保持不變。') });
  }
  if (a === 'toggle-group-edit') {
    if (!c) return;
    const allowEdit = btn.dataset.allow === '1';
    return act('teacher:toggle-group-edit', { courseId: c.id, groupId: id, allowEdit });
  }
  if (a === 'reopen-group-modal') {
    if (!c) return;
    const targetGroup = c.groups.find(x => x.id === id);
    if (!targetGroup) return;
    const defaultTime = targetGroup.editDeadline || new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 16);
    const newDeadline = prompt(`請設定【${targetGroup.name}】組長重新挑選組員的新截止時間：\n(格式: YYYY-MM-DDTHH:mm，例如 ${defaultTime}；若不設期限請按確定保留空值或取消)`, defaultTime);
    if (newDeadline === null) return; // 使用者按取消
    return act('teacher:toggle-group-edit', {
      courseId: c.id,
      groupId: id,
      allowEdit: true,
      editDeadline: newDeadline.trim(),
    }, {
      after: () => alert(`已成功重新開放【${targetGroup.name}】組長挑選組員！${newDeadline ? `\n新截止時間為：${newDeadline.replace('T', ' ')}` : ''}`),
    });
  }
  if (a === 'close-all-eval') {
    if (!c) return;
    if (!confirm('確定關閉全體組長的評分權限？')) return;
    return act('teacher:set-all-peer-eval', { courseId: c.id, open: false },
      { after: () => alert('已關閉全體組長評分權限。') });
  }
  if (a === 'toggle-single-eval') {
    if (!c) return;
    const open = btn.dataset.open === '1';
    const targetGroup = c.groups.find(x => x.id === id);
    let deadline = targetGroup ? targetGroup.peerEvalDeadline : '';
    if (open && !deadline) {
      deadline = prompt('請輸入該組評分截止時間 (格式: YYYY-MM-DDTHH:mm，例如 2026-06-30T23:59)：', new Date(Date.now() + 7*86400000).toISOString().slice(0, 16));
      if (!deadline) return;
    }
    return act('teacher:set-peer-eval', { courseId: c.id, groupId: id, open, deadline });
  }
  if (a === 'export-json') return c && exportJSON(c);
  if (a === 'export-csv' || a === 'export-eval-csv') return c && exportCSV(c);

  if (a === 'claim-leader') return act('claim-leader');
  if (a === 'unclaim-leader') return act('unclaim-leader');
  if (a === 'toggle-vice') return act('toggle-vice', { studentId: id });
  if (a === 'drop') {
    if (!confirm('確定要將該組員移出？\n\n移出後該成員將釋出回到「未分配的成員名單」中。')) return;
    return act('drop', { studentId: id });
  }
  if (a === 'teacher-set-student-pw') {
    if (!c) return;
    const sid = btn.dataset.id;
    const sname = btn.dataset.name;
    const newPw = prompt(`請輸入要為【${sname} (${sid})】設定的新密碼（至少 4 碼）：`, '');
    if (newPw === null) return;
    const trimmed = newPw.trim();
    if (trimmed.length < 4) {
      return alert('新密碼長度至少需 4 碼！\nPassword must be at least 4 characters.');
    }
    return act('teacher:change-student-password', {
      courseId: c.id,
      studentId: sid,
      next: trimmed,
      resetToDefault: false,
    }, {
      after: () => alert(`✅ 已成功為【${sname}】設定新密碼！\nPassword updated successfully.`),
    });
  }
  if (a === 'teacher-reset-student-pw') {
    if (!c) return;
    const sid = btn.dataset.id;
    const sname = btn.dataset.name;
    if (!confirm(`確定要將【${sname} (${sid})】的登入密碼重設回「預設學號 (${sid})」嗎？\nReset password back to student ID?`)) return;
    return act('teacher:change-student-password', {
      courseId: c.id,
      studentId: sid,
      resetToDefault: true,
    }, {
      after: () => alert(`✅ 已成功將【${sname}】的登入密碼重設為預設學號：${sid}\nPassword reset to student ID.`),
    });
  }
  if (a === 'teacher-manage-student-pw') {
    if (!c) return;
    const sid = btn.dataset.id;
    const sname = btn.dataset.name;
    const hasCustom = btn.dataset.hasCustom === '1';
    const choice = prompt(
      `【組長／副組長密碼管理】\n學生姓名：${sname}\n學號：${sid}\n目前密碼狀態：${hasCustom ? '🔐 已自訂密碼' : 'ℹ️ 使用預設學號'}\n\n請選擇要執行的操作：\n1. 輸入「1」：重設密碼回預設學號（${sid}）\n2. 輸入「2」：手動為該學生設定新密碼\n\n請輸入 1 或 2（按取消放棄）：`,
      '1'
    );
    if (!choice) return;
    if (choice.trim() === '1') {
      if (!confirm(`確定要將【${sname} (${sid})】的登入密碼重設回「預設學號 (${sid})」嗎？`)) return;
      return act('teacher:change-student-password', {
        courseId: c.id,
        studentId: sid,
        resetToDefault: true,
      }, {
        after: () => alert(`✅ 已成功將【${sname}】的登入密碼重設為學號：${sid}`),
      });
    } else if (choice.trim() === '2') {
      const newPw = prompt(`請輸入要為【${sname} (${sid})】設定的新密碼（至少 4 碼）：`, '');
      if (newPw === null) return;
      const trimmed = newPw.trim();
      if (trimmed.length < 4) {
        return alert('新密碼長度至少需 4 碼！');
      }
      return act('teacher:change-student-password', {
        courseId: c.id,
        studentId: sid,
        next: trimmed,
        resetToDefault: false,
      }, {
        after: () => alert(`✅ 已成功為【${sname}】設定新密碼！`),
      });
    } else {
      alert('輸入無效，請輸入 1 或 2。');
    }
  }
});

app.addEventListener('change', e => {
  const t = e.target;
  const a = t.dataset.act;
  if (!a) return;
  const id = t.dataset.id;
  const c = cur();

  if (a === 'pick-course') {
    state.currentId = t.value;
    localStorage.setItem(CURRENT_KEY, state.currentId);
    return render();
  }
  if (a === 'import-file') {
    if (!needCourse()) return;
    const file = t.files[0];
    if (!file) return;
    const r = new FileReader();
    r.onload = ev => importText(cur(), ev.target.result);
    return r.readAsText(file);
  }
  if (!c) return;
  if (a === 'filter-log-action') {
    logActionFilter = t.value;
    return render();
  }
  if (a === 'assign-student') return act('teacher:assign-student', { courseId: c.id, studentId: id, groupId: t.value || null });
  if (a === 'set-leader') return act('teacher:set-leader', { courseId: c.id, studentId: id, on: t.checked });
  if (a === 'pick') return act('pick', { studentId: id });
  if (a === 'attendance-unlock-group') {
    const groupId = t.value;
    t.value = '';
    if (!groupId) return;
    const already = (c.attendanceUnlocks || []).some(u => u.sessionId === id && u.groupId === groupId);
    if (already) return act('teacher:set-attendance-unlock', { courseId: c.id, sessionId: id, groupId, allow: false });
    const deadline = prompt('請輸入該組補登截止時間（格式 YYYY-MM-DDTHH:mm，留白＝不限期）：', '');
    if (deadline === null) return;
    return act('teacher:set-attendance-unlock', { courseId: c.id, sessionId: id, groupId, allow: true, deadline: deadline.trim() });
  }
  if (a === 'attendance-stat-date') { attendanceStatDate = t.value; return render(); }
  if (a === 'attendance-stat-scope') { attendanceStatScope = t.value; return render(); }
  if (a === 'attendance-progress-session') { attendanceProgressSessionId = t.value; return render(); }
  if (a === 'assign-attendance-delegate') {
    const delegateId = t.value;
    const sessionId = t.dataset.session, groupId = t.dataset.group;
    t.value = '';
    if (!delegateId) return;
    return act('teacher:set-attendance-delegate', { courseId: c.id, sessionId, groupId, delegateId, allow: true });
  }
});

app.addEventListener('input', e => {
  const t = e.target;
  const a = t.dataset.act;
  if (!a) return;
  if (a === 'search-logs') {
    logSearchText = t.value;
    render();
    const input = document.querySelector('input[data-act="search-logs"]');
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }
});

/* ===== 啟動 ===== */
(async function start() {
  try {
    apply(await apiGet());
  } catch (err) {
    document.getElementById('app').innerHTML =
      `<div class="container"><div class="teacher-section"><h2>連線失敗 Connection error</h2>
       <p class="file-path">${String(err.message)}　請重新整理頁面。</p></div></div>`;
    return;
  }
  render();
  setInterval(poll, POLL_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
})();
