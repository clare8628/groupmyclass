/* 113入學行銷真班分組系統 Group My Class — 單頁前端，狀態存於 Cloudflare D1 */
const APP_NAME = '113入學行銷真班分組系統';
let APP_VERSION = 'v2.38';   // 顯示於前台標題列，隨後端 API 自動同步更新

const CURRENT_KEY = 'groupmyclass_current_course';   // 僅記住「目前檢視哪一門課」，其餘資料都在伺服器
const PREVIEW_KEY = 'groupmyclass_teacher_preview_mode'; // 記住老師切換之視角模式，重新整理不遺失
const POLL_MS = 5000;

let state = {
  courses: [],
  session: null,
  currentId: localStorage.getItem(CURRENT_KEY) || null,
};
let loginMode = null;   // 前台登入區：null | 'student' | 'teacher'
let teacherView = 'course';   // 後台主區：'course' | 'settings' | 'eval'
let teacherPreviewMode = localStorage.getItem(PREVIEW_KEY) || 'admin';  // 老師預覽模式：'admin' | 'public' | 'leader'
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
      <button class="btn btn-primary" data-act="show-student-login" style="padding:0.3rem 0.75rem;font-size:0.82rem;">🎓 登入開組（輸入姓名、學號）</button>
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
            <span class="btn-icon">🎓</span> 擔任組長之學生登入（輸入姓名、學號）
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
    right = `<a href="#login" class="teacher-link ${loginMode === 'teacher' ? 'on' : ''}" data-act="show-teacher-login">老師登入 Teacher login</a>`;
  }
  return `<nav>
    <span class="brand">
      <span class="logo">${APP_NAME}</span>
      <span class="ver">${APP_VERSION}</span>
    </span>
    ${c ? `<span class="course-tag">${esc(courseLabel(c))}</span>` : ''}
    <span class="tabs">${right}</span>
  </nav>`;
}

function loginCard() {
  if (loginMode === 'student') {
    const c = cur();
    return `<div class="login-bar embedded" id="login">
      <div class="login-header">
        <strong>擔任組長之學生登入 Student login</strong>
        <button class="tab-btn close" type="button" data-act="close-login" title="關閉 Close">✕</button>
      </div>
      <form data-act="login-student" class="inline-form">
        <div class="form-group"><label>姓名 Name（帳號）</label><input name="name" placeholder="王小明" required autocomplete="off"></div>
        <div class="form-group"><label>學號 Student ID（密碼）</label><input type="password" name="sid" placeholder="410001" required autocomplete="off"></div>
        <button class="btn btn-primary" type="submit">登入 Sign in</button>
      </form>
      <p class="file-path">目前登入課程：<b>${esc(c ? courseLabel(c) : '請先於左側選擇課程')}</b>。登入後可擔任組長並挑選組員。</p>
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
          <button data-act="sys-password">更改管理者密碼<span class="count">Change admin password</span></button>
        </li>
        <li class="${teacherView === 'eval' ? 'active' : ''}">
          <button data-act="sys-peer-eval">學期成績加減分與組長評分控制<span class="count">Peer evaluation</span></button>
        </li>
      </ul>
    </div>
  </aside>`;
}

function teacherScreen() {
  const c = cur();
  let main;
  if (teacherView === 'settings') {
    main = teacherPasswordBlock();
  } else if (teacherView === 'eval') {
    main = teacherPeerEvalBlock(c);
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
  ${publicBoard({ withUnassigned: false })}`;
}

function teacherPasswordBlock() {
  return `
  <div class="teacher-section">
    <h2>更改管理者密碼 <small>Change admin password</small></h2>
    <form data-act="change-password" class="pw-form">
      <div class="form-group"><label>目前密碼 Current</label><input type="password" name="current" required autocomplete="off"></div>
      <div class="form-group"><label>新密碼 New（至少 4 碼）</label><input type="password" name="next" required minlength="4" autocomplete="off"></div>
      <button class="btn btn-primary" type="submit">更新密碼 Update password</button>
    </form>
    <p class="file-path">學生登入固定為「姓名 + 學號」，不需另設密碼。Students sign in with name + student ID.</p>
  </div>`;
}

function rosterTable(c) {
  if (!c.students.length) return '<p class="file-path">尚無學生 No students yet.</p>';
  const opts = s => ['<option value="">未分組 —</option>']
    .concat(c.groups.map(g => `<option value="${g.id}" ${s.groupId === g.id ? 'selected' : ''}>${esc(g.name)}</option>`))
    .join('');
  return `<div class="table-wrap"><table class="roster">
    <thead><tr><th>學號 ID</th><th>姓名 Name</th><th>組別 Group</th><th>組長 Leader</th><th>期末考調分</th><th></th></tr></thead>
    <tbody>${c.students.map(s => {
      const g = c.groups.find(x => x.id === s.groupId);
      const adj = calcAdjustment(c, g, s);
      return `
      <tr>
        <td>${esc(s.id)}</td>
        <td>${esc(s.name)}${s.autoAssigned ? ' <span class="tag-inline auto">自動</span>' : ''}${s.isVice ? ' <span class="tag-inline">副組長</span>' : ''}</td>
        <td><select data-act="assign-student" data-id="${esc(keyOf(s))}">${opts(s)}</select></td>
        <td><input type="checkbox" data-act="set-leader" data-id="${esc(keyOf(s))}" ${s.isLeader ? 'checked' : ''} ${s.groupId ? '' : 'disabled'}></td>
        <td>${scoreBadge(adj)}</td>
        <td><button class="tab-btn" data-act="del-student" data-id="${esc(keyOf(s))}">刪除</button></td>
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
      <strong>學生 Student:</strong> ${esc(s.name)} (${esc(s.id)})<br>
      <strong>角色 Role:</strong> ${s.isLeader ? '組長 Leader' : s.isVice ? '副組長 Vice leader' : '組員 Member'}<br>
      <strong>組別 Group:</strong> ${g ? esc(g.name) : '未分組 Unassigned'}${s.autoAssigned ? '（自動分配 Auto-assigned）' : ''}
    </div>`;

  if (s.isLeader) {
    if (closed && !canEdit) {
      html += `
        <div class="deadline-alert locked">
          <span class="alert-icon">⏳</span>
          <div>
            <strong>已超過分組截止時間，組長無法更換組員 Deadline passed</strong>
            <p>目前分組截止時間已過${(g && g.editDeadline) ? `（本組專屬截止時間 ${esc(g.editDeadline.replace('T', ' '))} 亦已截止）` : ''}，組員名單已鎖定。如需更換，請聯絡老師個別重新開放挑選權限，或由老師於後台手動調整。</p>
          </div>
        </div>`;
    } else if (closed && canEdit) {
      html += `
        <div class="deadline-alert unlocked">
          <span class="alert-icon">🔓</span>
          <div>
            <strong>老師已重新開放本科目本組挑選權限 Permission re-opened</strong>
            <p>授課老師已特別為本組開放重新挑選權限，您現在可以更換組員或調整副組長。${(g && g.editDeadline) ? `<br><b style="color:#92400e;">⏳ 本組專屬截止時間為：${esc(g.editDeadline.replace('T', ' '))}，逾時將自動鎖定。</b>` : ''}</p>
          </div>
        </div>
        ${!isPreview ? `<button class="btn btn-secondary" data-act="unclaim-leader">取消組長身分 Step down</button>` : ''}`;
    } else {
      html += !isPreview ? `<button class="btn btn-secondary" data-act="unclaim-leader">取消組長身分 Step down</button>` : '';
    }
  } else if (closed) {
    html += '<p class="file-path">已超過分組截止時間，無法再變更。Deadline passed.</p>';
  } else if (otherLeader) {
    html += `<p class="file-path">本組組長為 ${esc(otherLeader.name)}，無法重複擔任。Group already has a leader.</p>`;
  } else {
    html += `
      <div class="leader-actions-row">
        <button class="btn btn-primary" data-act="claim-leader">我要當組長 Become leader</button>
        <button class="btn btn-neutral" data-act="logout">不願意擔任組長，返回首頁</button>
      </div>
      <p class="file-path">${g ? '成為本組組長後即可挑選組員。' : '將自動為你開一組並擔任組長。'}</p>`;
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
        <h3 style="margin:0">已挑選成員 Selected members <small>（下限 ${min} 人，上限 ${max} 人，目前 ${mates.length} 人）</small></h3>
        <div class="header-badges">
          ${isBelowMin
            ? `<span class="status-badge under-threshold">⚠️ 低於下限（缺 ${needed} 人）· 僅能新增組員</span>`
            : isAboveMax
            ? `<span class="status-badge under-threshold" style="background:#fef2f2;color:#991b1b;border-color:#fecaca;">⚠️ 高於上限（多 ${excess} 人）· 僅能刪減組員</span>`
            : `<span class="status-badge meets-threshold">✅ 人數合規（${mates.length}人，符合 ${min}~${max} 人）</span>`}
          ${canEdit ? '<span class="status-badge can-edit">組長調整中</span>' : '<span class="status-badge is-locked">已鎖定</span>'}
        </div>
      </div>
      ${isBelowMin ? `
        <div class="threshold-notice">
          <strong>⚠️ 本組現有成員數（${mates.length} 人）低於分組下限（${min} 人）</strong>
          <p>依規則：<b>此時組長只能新增組員</b>，且需從未分配的成員名單中挑選至少 <b>${needed}</b> 位組員加入，無法刪減現有成員。請於截止前完成挑選以符合門檻。</p>
        </div>` : ''}
      ${isAboveMax ? `
        <div class="threshold-notice" style="background:#fff1f2;border-color:#fecdd3;color:#9f1239;">
          <strong>⚠️ 本組現有成員數（${mates.length} 人）高於分組上限（${max} 人）</strong>
          <p>依規則：<b>此時組長只能刪減組員</b>，需將至少 <b>${excess}</b> 位成員移出釋出至未分配名單中，無法再新增組員。</p>
        </div>` : ''}
      <div class="pick-list" style="margin-top:0.75rem">${mates.map(m => `
        <div class="student ${m.isLeader ? 'leader' : ''} ${m.isVice ? 'vice-leader' : ''}">
          <span class="student-name-tag">
            ${esc(m.name)} (${esc(m.id)})${m.isLeader ? ' — 組長' : m.isVice ? ' — 副組長' : ''}${m.autoAssigned ? ' <span class="tag-inline auto">自動</span>' : ''}
          </span>
          ${(canEdit && m.id !== s.id) ? `
            <button class="tab-btn ${m.isVice ? 'on' : ''}" data-act="toggle-vice" data-id="${esc(keyOf(m))}">
              ${m.isVice ? '取消副組長' : '設為副組長'}</button>
            ${canDrop ? `
              <button class="tab-btn" data-act="drop" data-id="${esc(keyOf(m))}" title="移出組員釋出至未分配名單">移出釋出</button>
            ` : `
              <button class="tab-btn disabled" disabled title="現有人數已低於或等於下限（${min}人），依規則無法移出組員，只能新增組員" style="opacity:0.5;cursor:not-allowed;">不可移出</button>
            `}` : ''}
        </div>`).join('')}</div>
      <p class="file-path">提示：每組僅能有一位副組長。若現有人數低於下限只能新增組員；高於上限只能刪減組員釋出至未分配名單。</p>
    </div>`;

    /* 2. 挑選組員（顯示在已挑選成員區塊下方） */
    if (canEdit) {
      const pool = unassigned(c);
      html += `
      <div class="pick-members-panel" style="margin-top:1.5rem">
        <div class="panel-header">
          <h3 style="margin:0">挑選組員 Pick members <small>（從未分配名單新增）</small></h3>
          ${!canPick ? `<span class="badge-full" style="background:#fee2e2;color:#991b1b;border:1px solid #fca5a5;">本組人數（${mates.length}人）已達或高於上限（${max}人），依規定只能刪減組員，無法再新增</span>` : ''}
        </div>
        <div class="pick-list" style="margin-top:0.75rem">${pool.length ? pool.map(p => `
          <label class="student ${!canPick ? 'disabled' : ''}">
            <input type="checkbox" data-act="pick" data-id="${esc(keyOf(p))}" ${!canPick ? 'disabled' : ''}>
            ${esc(p.name)} (${esc(p.id)})
          </label>`).join('')
          : '<p class="file-path">目前沒有未分配的成員名單 No unassigned students.</p>'}</div>
      </div>`;
    }

    /* 3. 組長專屬：期末成員貢獻度評分面板（當老師開放權限時顯示） */
    const maxB = Number(c && c.maxBonus) > 0 ? Number(c.maxBonus) : 10;
    const isEvalOpen = !!g.peerEvalOpen;
    const isSubmitted = !!g.peerEvalSubmitted;
    const isOverdue = isEvalOpen && evalDeadlinePassed(g) && !isSubmitted;
    const otherMembers = mates.filter(m => m.id !== s.id);

    html += `
    <div class="leader-eval-panel" style="margin-top:1.5rem;padding:1.25rem;background:#f0fdf4;border:2px solid #bbf7d0;border-radius:10px;">
      <div class="panel-header" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.5rem;">
        <h3 style="margin:0;color:#166534;">📝 期末組員貢獻度評分 Peer Evaluation</h3>
        ${isSubmitted
          ? '<span class="status-badge meets-threshold">✅ 您已完成評分提交</span>'
          : isOverdue
          ? '<span class="status-badge under-threshold">⚠️ 已超過評分截止時間 (逾時懲罰生效)</span>'
          : isEvalOpen
          ? '<span class="status-badge can-edit">開放評分中 Open</span>'
          : '<span class="status-badge is-locked">老師尚未開放評分</span>'}
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
                  <th>組員姓名 (學號)</th>
                  <th>角色</th>
                  <th>期末考加分 (0 ~ ${maxB} 分)</th>
                  <th>加分原因 / 貢獻說明 (選填)</th>
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
                    <td>${m.isVice ? '<span class="tag-inline">副組長</span>' : '組員'}</td>
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
              <button class="btn btn-primary" type="submit" style="padding:0.45rem 1.1rem;font-size:0.9rem;">重新更新評分 Update</button>
            ` : `
              <button class="btn btn-primary" type="submit" style="padding:0.5rem 1.4rem;font-size:0.95rem;">送出評分（組長即獲 +${maxB} 分）Submit Evaluation</button>
              <span style="font-size:0.82rem;color:#64748b;">提交後組長自身立即獲得 ${maxB} 分加分，截止前仍可重複調整組員分數。</span>
            `}
          </div>
        </form>`}
    </div>`;
  }
  return html + '</div>' + publicBoard();
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
    return act('login-student', { courseId: c.id, name: f.name.value.trim(), sid: f.sid.value.trim() },
      { after: () => { loginMode = null; } });
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
    const sidIn = document.querySelector('#login input[name="sid"]');
    if (nameIn && btn.dataset.name) nameIn.value = btn.dataset.name;
    if (sidIn) {
      if (btn.dataset.id && !btn.dataset.id.includes('*')) sidIn.value = btn.dataset.id;
      sidIn.focus();
    }
    document.getElementById('login')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  if (a === 'show-student-login') { e.preventDefault(); loginMode = loginMode === 'student' ? null : 'student'; return render(); }
  if (a === 'close-login') { loginMode = null; return render(); }
  if (a === 'sys-password') { teacherView = 'settings'; return render(); }
  if (a === 'sys-peer-eval') { teacherView = 'eval'; return render(); }
  if (a === 'pick-course-node' || a === 'pick-course') {
    state.currentId = id || btn.value;
    if (teacherView !== 'eval') {
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
  if (a === 'assign-student') return act('teacher:assign-student', { courseId: c.id, studentId: id, groupId: t.value || null });
  if (a === 'set-leader') return act('teacher:set-leader', { courseId: c.id, studentId: id, on: t.checked });
  if (a === 'pick') return act('pick', { studentId: id });
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
