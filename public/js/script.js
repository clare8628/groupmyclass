/* 學生分組程式 Student Grouping — 單頁前端，狀態存於 localStorage */
const APP_NAME = '學生分組系統';
const APP_VERSION = 'v2.0.0';   // 顯示於前台標題列（v2 = Cloudflare D1 共用資料）

const CURRENT_KEY = 'groupstu_current_course';   // 僅記住「目前檢視哪一門課」，其餘資料都在伺服器
const POLL_MS = 5000;

let state = {
  courses: [],
  session: null,
  currentId: localStorage.getItem(CURRENT_KEY) || null,
};
let loginMode = null;   // 前台登入區：null | 'student' | 'teacher'
let teacherView = 'course';   // 後台主區：'course' | 'settings'
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
    if (sig !== lastSig || sessionChanged) { apply(data); render(); }
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
  return (c && state.session && state.session.role === 'student') ? findStudent(c, state.session.id) : null;
}
const teacherPasswordHint = '預設 teacher123，可於後台修改';

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

const deadlinePassed = c => !!c.deadline && Date.now() > new Date(c.deadline).getTime();

/* ===== 前台分組現況 ===== */
function unassignedList(c) {
  const pool = unassigned(c);
  return `<div class="pick-list">${pool.length
    ? pool.map(s => `<div class="student">${esc(s.name)} (${esc(s.id)})</div>`).join('')
    : '<p class="file-path">全部學生皆已分組 Everyone is assigned.</p>'}</div>`;
}

function publicBoard({ withUnassigned = true } = {}) {
  const c = cur();
  const pool = c ? unassigned(c) : [];
  const self = me();

  return `
  <section class="block-section group-status-section" id="group-status-block">
    <div class="block-header">
      <div class="block-title-wrap">
        <span class="step-badge">Step 3</span>
        <h2>分組現況 Group status</h2>
      </div>
      ${!state.session ? `
        <div class="board-actions">
          <button class="btn btn-primary student-login-btn ${loginMode === 'student' ? 'active' : ''}" data-act="show-student-login">
            <span class="btn-icon">🎓</span> 擔任組長之學生登入 Student login
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
            <span class="meta-pill">👥 每組 ${c.groupSize || 4} ± ${c.tolerance || 0} 人（上限 ${cap(c)} 人）</span>
            <span class="meta-pill">📊 總學生數 ${c.students.length} 人 · ${c.groups.length} 組</span>
            ${c.deadline ? `<span class="meta-pill ${deadlinePassed(c) ? 'expired' : 'active'}">⏳ 時限: ${esc(c.deadline.replace('T', ' '))} ${deadlinePassed(c) ? '(已截止)' : ''}</span>` : ''}
          </div>` : ''}
      </div>
    </div>

    <!-- 學生登入區塊嵌入於此 -->
    ${loginMode === 'student' ? loginCard() : ''}

    ${!c ? `<p class="file-path empty-notice">請先於左側「課程選擇」樹狀清單中點選欲查看分組的學年度與科目。</p>` : ''}

    ${c ? (c.groups.length ? `<div class="group-grid">${c.groups.map(g => {
      const list = members(c, g.id);
      const lead = leaderOf(c, g.id);
      const autoCount = list.filter(s => s.autoAssigned).length;
      const full = list.length >= cap(c);
      return `<div class="group-card ${self && self.groupId === g.id ? 'mine' : ''}">
        ${autoCount ? `<span class="tag">自動 ${autoCount}</span>` : ''}
        <h3>${esc(g.name)} <small>${list.length}/${cap(c)} 人${full ? ' · 已滿' : ''}</small></h3>
        <p class="file-path">組長 Leader: ${lead ? esc(lead.name) : '尚未產生 — none'}</p>
        <div class="students">${list.length ? list.map(s => `
          <div class="student ${s.isLeader ? 'leader' : ''} ${s.isVice ? 'vice-leader' : ''}">
            ${esc(s.name)} (${esc(s.id)})${s.isLeader ? ' — 組長' : s.isVice ? ' — 副組長' : ''}${s.autoAssigned ? ' · 自動' : ''}
          </div>`).join('') : '<div class="student">（尚無成員 Empty）</div>'}</div>
      </div>`;
    }).join('')}</div>` : '<p class="file-path empty-notice">老師尚未建立組別，或由學生自行擔任組長開組。No groups yet.</p>') : ''}
  </section>

  ${withUnassigned && c ? `
  <section class="block-section unassigned-section" id="unassigned-block">
    <div class="block-header">
      <div class="block-title-wrap">
        <span class="step-badge">Step 4</span>
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
    const who = state.session.role === 'teacher' ? '老師 Teacher' : esc((me() || {}).name || '');
    right = `<span class="who">${who}</span><button class="tab-btn" data-act="logout">登出 Logout</button>`;
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

/* ---- 目前選取的課程展示區塊（與左側 Step 2 樹狀區塊產生連動感） ---- */
function courseSelectionBlock() {
  const c = cur();
  return `<section class="block-section courses-overview-section" id="courses-block">
    <div class="block-header">
      <div class="block-title-wrap">
        <span class="step-badge">Step 2 選擇結果</span>
        <h2>課程選擇 Courses</h2>
      </div>
      <div class="courses-link-indicator">
        <span class="link-pulse-dot"></span>
        <span class="link-label">連動自左側課程樹</span>
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
          <h3 class="selected-subject-name">${esc(c.subject || '（未命名科目）')}</h3>
          <div class="selected-specs">
            <div class="spec-item"><span class="spec-label">學生總數</span><span class="spec-val">${c.students.length} 人</span></div>
            <div class="spec-item"><span class="spec-label">組別設定</span><span class="spec-val">${c.groups.length} 組（每組 ${c.groupSize} ± ${c.tolerance} 人）</span></div>
            <div class="spec-item"><span class="spec-label">分組進度</span><span class="spec-val">${c.students.filter(s => s.groupId).length} 人已分組 / ${unassigned(c).length} 人待分組</span></div>
          </div>
        </div>
      ` : `
        <div class="empty-selection-guide">
          <div class="guide-arrow">👈</div>
          <div class="guide-text">
            <strong>請點選左側樹狀列表選擇課程</strong>
            <p>點選任一學年度下的科目，即可在此立即載入該科目的分組設定與現況。</p>
          </div>
        </div>
      `}
    </div>
  </section>`;
}

function authScreen() {
  return `
  ${loginMode === 'teacher' ? loginCard() : ''}
  <div class="home-flow">
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
  return `<section class="block-section howto-section" id="howto-block">
    <div class="block-header">
      <div class="block-title-wrap">
        <span class="step-badge">Step 1</span>
        <h2>使用方式 How it works</h2>
      </div>
    </div>
    <div class="howto-steps">
      <div class="howto-step-card">
        <div class="step-num">1</div>
        <div class="step-info">
          <strong>選擇學年度與科目</strong>
          <p>在左側樹狀區塊中點選欲分組的<b>學年度 → 科目</b>，右側將即時載入該科目資料。</p>
        </div>
      </div>
      <div class="howto-step-card">
        <div class="step-num">2</div>
        <div class="step-info">
          <strong>學生登入開組</strong>
          <p>想當<b>組長</b>請至「分組現況」點選<b>擔任組長之學生登入</b>（姓名+學號），並按下「我要當組長」。</p>
        </div>
      </div>
      <div class="howto-step-card">
        <div class="step-num">3</div>
        <div class="step-info">
          <strong>挑選組員與指定副組長</strong>
          <p>組長可從未分組名單挑選組員、設定副組長。被挑選同學不需額外動作。</p>
        </div>
      </div>
      <div class="howto-step-card">
        <div class="step-num">4</div>
        <div class="step-info">
          <strong>截止後自動分配</strong>
          <p>超過時限未被挑選者由系統隨機分配至未滿組別，並標示為「自動」。</p>
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
        <span class="step-badge">Step 2</span>
        <h2>課程清單</h2>
      </div>
      <p class="block-desc">選擇學年度與科目</p>
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
                  <span class="node-name">${esc(c.subject || '（未命名科目）')}</span>
                </div>
                <span class="node-badge">${c.students.length}人·${c.groups.length}組</span>
              </button>
              ${active ? `<div class="tree-active-pointer" title="連接至右方課程選擇區塊"></div>` : ''}
            </li>`;
          }).join('')}</ul>
        </div>`).join('') : '<p class="file-path empty-notice">老師尚未建立任何課程。No courses yet.</p>'}
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
    <h3>課程 Courses</h3>
    ${years.length ? years.map(y => `
      <div class="tree-year">
        <div class="tree-year-label">${esc(y)}</div>
        <ul>${byYear[y].map(c => `
          <li class="${state.currentId === c.id ? 'active' : ''}">
            <button data-act="pick-course-node" data-id="${c.id}">
              ${esc(c.subject || '（未命名科目）')}
              <span class="count">${c.students.length} 人 / ${c.groups.length} 組</span>
            </button>
          </li>`).join('')}</ul>
      </div>`).join('') : '<p class="file-path">尚無課程，請於右側「課程設定」建立。</p>'}
    <button class="btn btn-secondary" data-act="new-course">＋ 新增課程 New course</button>
    <div class="tree-year tree-sys">
      <div class="tree-year-label">系統設定 System</div>
      <ul>
        <li class="${teacherView === 'settings' ? 'active' : ''}">
          <button data-act="sys-password">更改管理者密碼<span class="count">Change admin password</span></button>
        </li>
      </ul>
    </div>
  </aside>`;
}

function teacherScreen() {
  const c = cur();
  const main = teacherView === 'settings'
    ? teacherPasswordBlock()
    : (c ? teacherCourse(c) : teacherNoCourse());
  return `<div class="layout">${courseTree()}<main>${main}</main></div>`;
}

function teacherNoCourse() {
  return `
  <div class="teacher-section">
    <h2>課程設定 Course setup</h2>
    <p class="file-path">建立新課程：填寫學年度與科目名稱後儲存，會出現在左側樹狀清單。</p>
    ${courseForm({ year: '', subject: '', groupSize: 4, tolerance: 1, deadline: '' })}
  </div>`;
}

function courseForm(c) {
  return `<form data-act="save-course">
    <div class="form-row">
      <div class="form-group"><label>學年度 Academic year</label><input name="year" value="${esc(c.year)}" placeholder="114-1" required></div>
      <div class="form-group"><label>科目名稱 Subject</label><input name="subject" value="${esc(c.subject)}" placeholder="資料結構" required></div>
      <div class="form-group"><label>每組人數 Group size</label><input type="number" min="1" name="groupSize" value="${c.groupSize}"></div>
      <div class="form-group"><label>誤差人數 ± Tolerance</label><input type="number" min="0" name="tolerance" value="${c.tolerance}"></div>
      <div class="form-group full"><label>分組時限 Deadline</label><input type="datetime-local" name="deadline" value="${esc(c.deadline)}"></div>
    </div>
    <button class="btn btn-primary" type="submit">儲存 Save</button>
  </form>`;
}

function teacherCourse(c) {
  const total = c.students.length;
  const assigned = c.students.filter(s => s.groupId).length;
  return `
  <div class="teacher-section">
    <h2>課程設定 Course setup <small>${esc(courseLabel(c))}</small></h2>
    ${courseForm(c)}
    <button class="btn btn-danger" data-act="del-course" data-id="${c.id}">刪除整個科目（含名單與分組）Delete course</button>
  </div>

  <div class="teacher-section">
    <h2>分組管理 Grouping</h2>
    <div class="stats">
      <div class="stat"><div class="value">${total}</div><div class="label">總學生數 Students</div></div>
      <div class="stat"><div class="value">${c.groups.length}</div><div class="label">組別數 Groups</div></div>
      <div class="stat"><div class="value">${assigned}</div><div class="label">已分組 Assigned</div></div>
      <div class="stat"><div class="value">${total - assigned}</div><div class="label">未分組 Unassigned</div></div>
    </div>
    <div class="btn-row">
      <button class="btn btn-primary" data-act="make-groups">建立空組別 Create groups</button>
      <button class="btn btn-secondary" data-act="add-group">新增一組 Add group</button>
      <button class="btn btn-secondary" data-act="auto-assign">隨機分配剩餘 Auto-assign</button>
      <button class="btn btn-danger" data-act="clear-groups">清除本科目所有分組 Clear all groups</button>
      <button class="btn btn-secondary" data-act="export-json">匯出 JSON</button>
      <button class="btn btn-secondary" data-act="export-csv">匯出 CSV</button>
    </div>
    ${c.deadline ? `<p class="file-path">時限 Deadline: ${esc(c.deadline.replace('T', ' '))} — ${deadlinePassed(c) ? '已截止（未選學生已自動分配）Closed' : '進行中 Open'}</p>` : ''}
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
    <thead><tr><th>學號 ID</th><th>姓名 Name</th><th>組別 Group</th><th>組長 Leader</th><th></th></tr></thead>
    <tbody>${c.students.map(s => `
      <tr>
        <td>${esc(s.id)}</td>
        <td>${esc(s.name)}${s.autoAssigned ? ' <span class="tag-inline auto">自動</span>' : ''}${s.isVice ? ' <span class="tag-inline">副組長</span>' : ''}</td>
        <td><select data-act="assign-student" data-id="${esc(keyOf(s))}">${opts(s)}</select></td>
        <td><input type="checkbox" data-act="set-leader" data-id="${esc(keyOf(s))}" ${s.isLeader ? 'checked' : ''} ${s.groupId ? '' : 'disabled'}></td>
        <td><button class="tab-btn" data-act="del-student" data-id="${esc(keyOf(s))}">刪除</button></td>
      </tr>`).join('')}
    </tbody></table></div>`;
}

function studentScreen() {
  const c = cur(), s = me();
  if (!c || !s) { state.session = null; return authScreen(); }
  const g = c.groups.find(x => x.id === s.groupId);
  const mates = g ? members(c, g.id) : [];
  const closed = deadlinePassed(c);
  const otherLeader = g ? mates.find(m => m.isLeader && m.id !== s.id) : null;

  let html = `
  <div class="student-section">
    <h2>${esc(courseLabel(c))}</h2>
    <div class="student-info">
      <strong>學生 Student:</strong> ${esc(s.name)} (${esc(s.id)})<br>
      <strong>角色 Role:</strong> ${s.isLeader ? '組長 Leader' : s.isVice ? '副組長 Vice leader' : '組員 Member'}<br>
      <strong>組別 Group:</strong> ${g ? esc(g.name) : '未分組 Unassigned'}${s.autoAssigned ? '（自動分配 Auto-assigned）' : ''}
    </div>`;

  if (closed) {
    html += '<p class="file-path">已超過分組時限，無法再變更。Deadline passed.</p>';
  } else if (s.isLeader) {
    html += `<button class="btn btn-secondary" data-act="unclaim-leader">取消組長身分 Step down</button>`;
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

  if (s.isLeader && g && !closed) {
    const pool = unassigned(c);
    html += `
    <h3 style="margin-top:1.5rem">挑選組員 Pick members（上限 ${cap(c)} 人，目前 ${mates.length}）</h3>
    <div class="pick-list">${pool.length ? pool.map(p => `
      <label class="student"><input type="checkbox" data-act="pick" data-id="${esc(keyOf(p))}"> ${esc(p.name)} (${esc(p.id)})</label>`).join('')
        : '<p class="file-path">目前沒有未分組的學生 No unassigned students.</p>'}</div>

    <h3 style="margin-top:1.5rem">本組成員 My members <small>（可標記副組長 Mark a vice leader）</small></h3>
    <div class="pick-list">${mates.map(m => `
      <div class="student ${m.isLeader ? 'leader' : ''} ${m.isVice ? 'vice-leader' : ''}">
        ${esc(m.name)} (${esc(m.id)})${m.isLeader ? ' — 組長' : m.isVice ? ' — 副組長' : ''}
        ${m.id !== s.id ? `
          <button class="tab-btn ${m.isVice ? 'on' : ''}" data-act="toggle-vice" data-id="${esc(keyOf(m))}">
            ${m.isVice ? '取消副組長' : '設為副組長'}</button>
          <button class="tab-btn" data-act="drop" data-id="${esc(keyOf(m))}">移出</button>` : ''}
      </div>`).join('')}</div>
    <p class="file-path">每組僅能有一位副組長，重新指定會自動取代前一位。One vice leader per group.</p>`;
  }
  return html + '</div>' + publicBoard();
}

/* ===== Render ===== */
function render() {
  const isStudent = state.session && state.session.role === 'student';
  const body = !state.session ? authScreen()
    : state.session.role === 'teacher' ? teacherScreen()
    : studentScreen();
  document.getElementById('app').innerHTML =
    nav() + '<div class="container">' + (isStudent ? howto() : '') + body + '</div>';
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
  const rows = [['學號', '姓名', '組別', '角色', '自動分組']];
  c.students.forEach(s => {
    const g = c.groups.find(x => x.id === s.groupId);
    rows.push([s.id, s.name, g ? g.name : '', s.isLeader ? '組長' : s.isVice ? '副組長' : '組員', s.autoAssigned ? 'Y' : 'N']);
  });
  const csv = '﻿' + rows.map(r => r.map(x => `"${String(x).replace(/"/g, '""')}"`).join(',')).join('\n');
  download(csv, 'text/csv', `${c.year || 'grouping'}_${c.subject || 'data'}.csv`);
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
    return act('login-teacher', { password: f.password.value }, { after: () => { loginMode = null; } });
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
      deadline: f.deadline.value,
    }).then(data => {
      if (data && data.courseId && data.courseId !== state.currentId) {
        state.currentId = data.courseId;
        localStorage.setItem(CURRENT_KEY, data.courseId);
        render();
      }
    });
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

  if (a === 'logout') return act('logout', {}, { after: () => { loginMode = null; teacherView = 'course'; } });
  if (a === 'show-teacher-login') { e.preventDefault(); loginMode = loginMode === 'teacher' ? null : 'teacher'; return render(); }
  if (a === 'show-student-login') { e.preventDefault(); loginMode = loginMode === 'student' ? null : 'student'; return render(); }
  if (a === 'close-login') { loginMode = null; return render(); }
  if (a === 'sys-password') { teacherView = 'settings'; return render(); }
  if (a === 'pick-course-node' || a === 'pick-course') {
    state.currentId = id || btn.value;
    teacherView = 'course';
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
    if (!confirm('將重建組別並清空現有分組，確定？')) return;
    return act('teacher:make-groups', { courseId: c.id });
  }
  if (a === 'add-group') { if (!c) return; return act('teacher:add-group', { courseId: c.id }); }
  if (a === 'clear-groups') {
    if (!c) return;
    if (!c.groups.length) return alert('本科目尚無分組 No groups to clear');
    if (!confirm(`確定清除「${courseLabel(c)}」的所有分組？學生名單會保留。`)) return;
    return act('teacher:clear-groups', { courseId: c.id });
  }
  if (a === 'auto-assign') {
    if (!c) return;
    if (!c.groups.length) return alert('請先建立組別 Create groups first');
    return act('teacher:auto-assign', { courseId: c.id });
  }
  if (a === 'export-json') return c && exportJSON(c);
  if (a === 'export-csv') return c && exportCSV(c);

  if (a === 'claim-leader') return act('claim-leader');
  if (a === 'unclaim-leader') return act('unclaim-leader');
  if (a === 'toggle-vice') return act('toggle-vice', { studentId: id });
  if (a === 'drop') return act('drop', { studentId: id });
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
