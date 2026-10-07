/* 113入學行銷真班分組與點名系統 Group My Class — 單頁前端，狀態存於 Cloudflare D1 */
const APP_NAME = '113入學行銷真班';
let APP_VERSION = 'v2.114.20261007.114106';   // 顯示於前台標題列，隨後端 API 自動同步更新

const CURRENT_KEY = 'groupmyclass_current_course';   // 僅記住「目前檢視哪一門課」，其餘資料都在伺服器
const PREVIEW_KEY = 'groupmyclass_teacher_preview_mode'; // 記住老師切換之視角模式，重新整理不遺失
const TEACHER_VIEW_KEY = 'groupmyclass_teacher_view'; // 記住老師後台目前檢視功能頁面，重新整理不遺失

function parseViewFromHash() {
  const h = (window.location.hash || '').replace(/^#/, '').toLowerCase().trim();
  // 老師後台視圖
  if (['teacher-attendance', 'logs', 'eval', 'settings', 'course', 'wellbeing', 'system'].includes(h)) return { type: 'teacher', view: h === 'teacher-attendance' ? 'attendance' : h };
  // 前台子系統視圖
  if (['dashboard', 'groups', 'attendance', 'survey', 'password'].includes(h)) return { type: 'public', view: h };
  // 相容舊 hash
  if (h === 'attendance') return { type: 'public', view: 'attendance' };
  return null;
}

// 取出目前 hash 對應的前台子系統名稱（非教師後台視圖時回傳 null）；
// popstate／hashchange 監聽器用來同步瀏覽器上一頁/下一頁時的 publicSubView
function parseSubViewFromHash() {
  const parsed = parseViewFromHash();
  return parsed && parsed.type === 'public' ? parsed.view : null;
}

function getInitialTeacherView() {
  const parsed = parseViewFromHash();
  if (parsed && parsed.type === 'teacher') return parsed.view;
  if (window.history.state && window.history.state.teacherView && ['attendance', 'logs', 'eval', 'settings', 'course', 'wellbeing', 'system', 'bulletin'].includes(window.history.state.teacherView)) {
    return window.history.state.teacherView;
  }
  const saved = localStorage.getItem(TEACHER_VIEW_KEY);
  if (saved && ['attendance', 'logs', 'eval', 'settings', 'course', 'wellbeing', 'system', 'bulletin'].includes(saved)) {
    return saved;
  }
  return 'course';
}

function getInitialPublicSubView() {
  const parsed = parseViewFromHash();
  if (parsed && parsed.type === 'public') return parsed.view;
  if (window.history.state && window.history.state.publicSubView && ['dashboard', 'groups', 'attendance', 'survey', 'password'].includes(window.history.state.publicSubView)) {
    return window.history.state.publicSubView;
  }
  return 'dashboard';
}

const POLL_MS = 15000; // 延長輪詢至 15 秒（操作者自身操作即時響應，15 秒足以同步他人異動）
let lastEtag = '';
let lastUserActivity = Date.now();
let lastPollTime = 0;
const IDLE_TIMEOUT_MS = 60000; // 1 分鐘未有使用者動作視為閒置
const IDLE_POLL_MS = 35000;    // 閒置時降低輪詢頻率至 35 秒，節省 D1 消耗

let state = {
  courses: [],
  session: null,
  currentId: localStorage.getItem(CURRENT_KEY) || null,
  bulletin: [],
  bulletinPageSize: 10,
};
let bulletinPage = 1;     // 前台 [Block B] 公佈欄目前頁碼（每頁 10 筆）
let loginMode = null;   // 前台登入區：null | 'student' | 'teacher'
let publicSubView = getInitialPublicSubView(); // 前台主要顯示區域：'dashboard'（首頁）| 'groups'（分組子系統）| 'attendance'（點名子系統）| 'survey'（問卷子系統）| 'password'（修改個人密碼）
let teacherView = getInitialTeacherView();   // 後台主區：'course' | 'settings' | 'eval' | 'logs' | 'attendance'
let teacherPreviewMode = localStorage.getItem(PREVIEW_KEY) || 'admin';  // 老師預覽模式：'admin' | 'public' | 'leader'
let logActionFilter = 'all';  // 異動日誌細項過濾：'all' 或 LOG_SUB_FILTERS 中目前分類的值（切換管理頁時重設）
let logSearchText = '';       // 異動日誌搜尋關鍵字
let attendanceEditingId = null;     // 後台目前正在編輯的點名時段 id（null＝新增模式）
let attendanceStatScope = 'all';    // 老師後台缺席統計範圍：預設 'all'（整學期）| 'date'（依日期）
let publicAttendanceStatScope = 'all'; // 前台缺席統計範圍：預設 'all'（整學期）| 'date'（依日期）
let leaderAttendanceStatScope = 'all'; // 組長後台缺席統計範圍：預設 'all'（整學期）| 'date'（依日期）
let attendanceStatDate = '';        // 缺席統計所選日期，預設為今天
let attendanceProgressSessionId = ''; // 尚未完成點名排行所選時段，預設為最新時段
let attendanceLeaderboardPage = 1;     // 老師後台組員缺席排行榜目前頁碼（每頁 15 筆）
let careAbsenceThreshold = 5;         // 缺席關懷門檻：缺席次數「超過」此值者列入關懷名單
let publicAttendanceLeaderboardPage = 1; // 前台/組內缺席排行榜目前頁碼（每頁 15 筆）
let publicSurveyUncompletedPages = {};  // 前台總覽各份生活關懷問卷未完成名單頁碼（每頁 15 筆），key：批次 id
let wbSection = 'cards';                // 老師後台「問卷管理」目前顯示的樹狀子節點：cards | care-config | care:<id> | abs-config | abs:<id> | log
let wbTreeOpen = false;                 // 左側樹狀選單「問卷管理」子項目是否展開（預設收折以節省版面）
let careAdminId = '';                   // 老師後台目前檢視的生活關懷問卷批次 id（空白＝第一份）
let viewingAbsenceModal = null;     // 目前查看缺席明細彈窗之學生資料：{ studentKey, studentName, studentId, details: [] } | null
const admOpen = new Set(); // 後台問卷區塊展開狀態（預設收折）
const admOpenAttr = k => admOpen.has(k) ? 'open' : '';
document.addEventListener('toggle', e => {
  const k = e.target && e.target.dataset && e.target.dataset.adm;
  if (k) e.target.open ? admOpen.add(k) : admOpen.delete(k);
}, true);
let surveyActiveTab = 'uncompleted'; // 後台問卷子分頁：'uncompleted' | 'submissions' | 'logs'
let surveyCategoryFilter = 'all';
let surveyGroupFilter = 'all';
let surveySearchText = '';
let viewingSurveyModal = null;      // 查看問卷詳情彈窗
let editingSurveyModal = null;      // 老師修改學生問卷彈窗
let viewingSurveyLogsModal = null;  // 查看歷程日誌彈窗
let showPublicUncompletedModal = false; // 前台查看未完成名單彈窗
let simulateSurveyKey = '';          // 模擬視窗中選取的問卷卡片 key
let simulatingStudentModal = false; // 老師模擬學生身分登入測試彈窗
let publicSurveyCard = '';          // 前台問卷子系統目前進入的卡片：'' = 卡片列表 | 'care:<id>' | 'abs:<id>'
let absPicker = null;               // 老師選擇缺曠輔導學生彈窗：{ surveyId, selected: Set }
let dragSurveyKey = null;           // 後台問卷卡片拖拉中的卡片 key
let listPages = {};                 // 各異動日誌列表目前頁碼（每頁 15 筆），key：'log-group' | 'log-attendance' | 'log-survey' | 'survey-logs'
let attendanceEditSessionId = '';   // 老師「依日期調閱／修改點名紀錄」所選時段
const PREVIEW_GROUP_KEY = 'groupmyclass_teacher_preview_group';
let previewLeaderGroupId = localStorage.getItem(PREVIEW_GROUP_KEY) || ''; // 老師組長登入模式所選組別（空白＝第 1 組）
const LIST_PAGE_SIZE = 15;
const resetLogPages = () => { ['log-group', 'log-attendance', 'log-survey'].forEach(k => { listPages[k] = 1; }); };

/* 列表分頁：回傳本頁資料與分頁列 HTML */
function paginate(key, items) {
  const total = Math.max(1, Math.ceil(items.length / LIST_PAGE_SIZE));
  const page = Math.min(Math.max(1, listPages[key] || 1), total);
  listPages[key] = page;
  const start = (page - 1) * LIST_PAGE_SIZE;
  const btn = (p, label, disabled) => `<button class="pagination-btn" type="button" data-act="set-list-page" data-key="${key}" data-page="${p}" ${disabled ? 'disabled style="opacity:0.4;cursor:not-allowed;"' : ''}>${label}</button>`;
  const pager = items.length > LIST_PAGE_SIZE ? `
    <div class="leaderboard-pagination" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.75rem;padding:0.75rem 0.25rem 0.25rem;border-top:1px solid #f1f5f9;margin-top:0.75rem;">
      <div style="font-size:0.85rem;color:#64748b;">顯示第 <b>${start + 1} - ${Math.min(start + LIST_PAGE_SIZE, items.length)}</b> 筆（共 <b>${items.length}</b> 筆，頁次 <b>${page} / ${total}</b>）</div>
      <div style="display:flex;align-items:center;gap:0.35rem;flex-wrap:wrap;">
        ${btn(1, '⏮ 第一頁', page <= 1)}
        ${btn(page - 1, '◀ 上一頁', page <= 1)}
        ${btn(page + 1, '下一頁 ▶', page >= total)}
        ${btn(total, '最末頁 ⏭', page >= total)}
      </div>
    </div>` : '';
  return { rows: items.slice(start, start + LIST_PAGE_SIZE), pager };
}

/* 生活關懷問卷常數 */
const SURVEY_CATEGORIES = [
  '課程內容 (Nội dung khóa học)',
  '作業問題 (Vấn đề bài tập)',
  '考試問題 (Vấn đề thi cử)',
  '學習困難 (Khó khăn trong học tập)',
  '選修課問題 (Vấn đề môn tự chọn)',
  '出缺席(曠課)、遲到問題 (Vấn đề vắng mặt (bỏ học), đi muộn)',
  '休退學問題 (Vấn đề nghỉ học/thôi học)',
  '家庭關係 (Mối quan hệ gia đình)',
  '健康問題 (Vấn đề sức khỏe)',
  '經濟問題 (Vấn đề kinh tế)',
  '校外租屋 (Thuê nhà ngoài trường)',
  '工讀 (Làm thêm)',
  '其他 (Khác)',
];

const SURVEY_CATEGORY_META = {
  '課程內容 (Nội dung khóa học)': { icon: '📖', group: '課業與學習', color: '#2563eb' },
  '作業問題 (Vấn đề bài tập)': { icon: '📝', group: '課業與學習', color: '#0284c7' },
  '考試問題 (Vấn đề thi cử)': { icon: '✏️', group: '課業與學習', color: '#0891b2' },
  '學習困難 (Khó khăn trong học tập)': { icon: '💡', group: '課業與學習', color: '#4f46e5' },
  '選修課問題 (Vấn đề môn tự chọn)': { icon: '🎯', group: '課業與學習', color: '#7c3aed' },
  '出缺席(曠課)、遲到問題 (Vấn đề vắng mặt (bỏ học), đi muộn)': { icon: '⏰', group: '就學與出缺勤', color: '#d97706' },
  '休退學問題 (Vấn đề nghỉ học/thôi học)': { icon: '🚪', group: '就學與出缺勤', color: '#ea580c' },
  '家庭關係 (Mối quan hệ gia đình)': { icon: '👨‍👩‍👧', group: '身心與家庭', color: '#e11d48' },
  '健康問題 (Vấn đề sức khỏe)': { icon: '🏥', group: '身心與家庭', color: '#dc2626' },
  '經濟問題 (Vấn đề kinh tế)': { icon: '💰', group: '生活與經濟', color: '#059669' },
  '校外租屋 (Thuê nhà ngoài trường)': { icon: '🏠', group: '生活與經濟', color: '#0d9488' },
  '工讀 (Làm thêm)': { icon: '💼', group: '生活與經濟', color: '#16a34a' },
  '其他 (Khác)': { icon: '💬', group: '其他', color: '#64748b' },
};

let busy = false;
let lastSig = '';

/* 日誌按需快取 */
let fullLogsByCourse = {};
let logsLoading = false;

async function loadCourseLogs(courseId, force = false) {
  if (!courseId || (fullLogsByCourse[courseId] && !force) || logsLoading) return;
  logsLoading = true;
  render();
  try {
    const res = await apiPost('teacher:get-logs', { courseId });
    if (res && res.logs) {
      fullLogsByCourse[courseId] = res.logs;
    }
  } catch (e) {
    console.error('載入日誌失敗:', e);
  } finally {
    logsLoading = false;
    render();
  }
}

/* 系統運行紀錄按需快取（以課程為單位；僅進入該頁時讀取，不影響輪詢） */
let systemStatusByCourse = {};
let systemStatusLoading = false;
let systemStatusError = '';

async function loadSystemStatus(courseId, force = false) {
  const key = courseId || '';
  if ((systemStatusByCourse[key] && !force) || systemStatusLoading) return;
  systemStatusLoading = true;
  systemStatusError = '';
  render();
  try {
    const res = await apiPost('teacher:system-status', { courseId: key });
    if (res && res.status) systemStatusByCourse[key] = res.status;
  } catch (e) {
    systemStatusError = String(e.message || e);
  } finally {
    systemStatusLoading = false;
    render();
  }
}

/* ===== API（支援 ETag / 304 快取防護） ===== */
async function apiGet() {
  const headers = { 'cache-control': 'no-cache' };
  if (lastEtag) headers['if-none-match'] = lastEtag;
  const r = await fetch('/api/state', { credentials: 'same-origin', headers });
  if (r.status === 304) return { notModified: true };
  if (!r.ok) throw new Error('讀取資料失敗 (' + r.status + ')');
  const etag = r.headers.get('etag');
  if (etag) lastEtag = etag;
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
  if (data.bulletin && Array.isArray(data.bulletin)) state.bulletin = data.bulletin;
  if (data.bulletinPageSize) state.bulletinPageSize = Number(data.bulletinPageSize);
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
    lastEtag = ''; // 資料異動後重設 ETag，確保下一輪讀取最新資料
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

/* 背景輪詢：其他人的異動會自動出現（支援 304 略過重繪與閒置降頻） */
async function poll() {
  if (busy || document.hidden) return;
  const now = Date.now();
  const isIdle = (now - lastUserActivity) > IDLE_TIMEOUT_MS;
  if (isIdle && (now - lastPollTime < IDLE_POLL_MS)) return;
  lastPollTime = now;

  try {
    const data = await apiGet();
    if (data && data.notModified) return; // 304 狀態無異動，直接返回，不耗費 CPU 與 DOM 重繪
    const sig = JSON.stringify(data.courses || []);
    const sessionChanged = JSON.stringify(data.session || null) !== JSON.stringify(state.session || null);
    const versionChanged = data.version && data.version !== APP_VERSION;
    if (sig !== lastSig || sessionChanged || versionChanged) { apply(data); render(); }
  } catch (e) { /* 網路暫時失敗就略過這輪 */ }
}

/* 監聽使用者動作，智慧喚醒輪詢 */
const recordUserActivity = () => {
  const wasIdle = (Date.now() - lastUserActivity) > IDLE_TIMEOUT_MS;
  lastUserActivity = Date.now();
  if (wasIdle && (Date.now() - lastPollTime >= POLL_MS)) {
    poll();
  }
};
['mousemove', 'keydown', 'touchstart', 'click'].forEach(evt => {
  window.addEventListener(evt, recordUserActivity, { passive: true });
});

/* ===== Course helpers ===== */
const courseById = id => state.courses.find(c => c.id === id) || null;
function cur() {   // 目前檢視中的課程
  if (state.session && state.session.role === 'student') return courseById(state.session.courseId);
  return courseById(state.currentId);
}
const courseLabel = c => [c.year, c.subject].filter(Boolean).join(' · ') || '（未命名課程）';

/* ===== Helpers（皆以某課程為範圍） ===== */
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/* 學號同時是學生預設登入密碼，前台公開頁面一律僅顯示前 3 碼，避免任何訪客取得「姓名＋預設密碼」組合 */
const maskId = id => String(id == null ? '' : id).slice(0, 3) + '*'.repeat(Math.max(0, String(id == null ? '' : id).length - 3));
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
const previewLeaderGroup = c => c.groups.find(g => g.id === previewLeaderGroupId) || c.groups[0] || null;
function me() {
  const c = cur();
  if (!c) return null;
  if (state.session && state.session.role === 'student') return findStudent(c, state.session.id);
  // 若老師處於組長預覽模式，模擬所選組別（未選＝第 1 組）的組長；該組無組長則以第一位組員代入
  if (state.session && state.session.role === 'teacher' && teacherPreviewMode === 'leader') {
    const g = previewLeaderGroup(c);
    if (!g) {
      const anyStudent = c.students[0];
      return anyStudent ? { ...anyStudent, isLeader: true } : { id: 'preview-lead', name: '預覽組長(測試)', isLeader: true, groupId: null };
    }
    const lead = c.students.find(s => s.groupId === g.id && s.isLeader);
    if (lead) return lead;
    const anyMember = c.students.find(s => s.groupId === g.id);
    if (anyMember) return { ...anyMember, isLeader: true };
    return { id: 'preview-lead', name: '預覽組長(測試)', isLeader: true, groupId: g.id };
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

/* ===== 點名 helpers ===== */
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
  const namePart = isDaily ? '一般日常點名（Điểm danh hàng ngày）' : s.name;
  return [s.date, s.timeSlot, namePart].filter(Boolean).join(' · ');
};
/* 老師視角：某時段各組完成度（是否已為全部現有組員留下紀錄），並列出尚未被點名的組員（含組長／副組長）與點名執行者 */
function attendanceGroupProgress(c, sessionId) {
  const recs = attendanceRecordsFor(c, sessionId).filter(r => r.status === 'present' || r.status === 'absent');
  return c.groups.map(g => {
    const mates = members(c, g.id);
    const groupRecs = recs.filter(r => r.groupId === g.id);
    const recordedIds = new Set(groupRecs.map(r => r.studentId));
    const missing = mates.filter(m => !recordedIds.has(m.id));
    const total = mates.length;
    const done = total - missing.length;
    const complete = total > 0 && missing.length === 0;

    const leader = leaderOf(c, g.id);
    const vice = mates.find(m => m.isVice);

    let marker = null;
    let completedAt = null;

    if (groupRecs.length > 0) {
      const sorted = [...groupRecs].sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
      const latest = sorted[0];
      completedAt = latest.updatedAt || latest.createdAt || null;

      const recWithMarker = sorted.find(r => r.markedById || r.markedByName) || latest;
      let markedId = recWithMarker.markedById || '';
      let markedName = recWithMarker.markedByName || '';

      if (markedId === 'teacher' || markedName === '老師' || markedName.includes('老師')) {
        marker = {
          id: markedId || 'teacher',
          name: markedName || '任課老師',
          role: '老師',
          roleBadge: '👨‍🏫 老師',
        };
      } else {
        const st = (markedId && c.students.find(s => s.id === markedId || s.ref === markedId))
          || (markedName && c.students.find(s => s.name === markedName));
        
        const finalId = (st && st.id) ? st.id : markedId;
        const finalName = (st && st.name) ? st.name : markedName;

        let role = '組員';
        let roleBadge = '組員';
        if (st) {
          if (leader && st.id === leader.id) {
            role = '組長';
            roleBadge = '👑 組長';
          } else if (vice && st.id === vice.id) {
            role = '副組長';
            roleBadge = '⭐ 副組長';
          } else if (st.groupId !== g.id) {
            role = '代理';
            roleBadge = '🔁 代理';
          } else if (st.isLeader) {
            role = '組長';
            roleBadge = '👑 組長';
          } else if (st.isVice) {
            role = '副組長';
            roleBadge = '⭐ 副組長';
          }
        } else {
          const isDel = (c.attendanceDelegates || []).some(d => d.sessionId === sessionId && d.groupId === g.id && (d.delegateId === markedId || d.delegateName === markedName));
          if (isDel) {
            role = '代理';
            roleBadge = '🔁 代理';
          }
        }

        if (finalId || finalName) {
          marker = {
            id: finalId,
            name: finalName,
            role: role,
            roleBadge: roleBadge,
            student: st || null,
          };
        }
      }
    }

    return {
      group: g,
      total,
      done,
      missing,
      complete,
      leader,
      vice,
      marker,
      completedAt,
    };
  });
}

/* 統計各組點名人員的任務執行表現排行（以學期為單位） */
function calcRollCallPerformance(c) {
  if (!c || !c.attendanceRecords || !c.attendanceRecords.length) return [];

  // 1. 依 sessionId 與 groupId 歸納各組每次點名紀錄
  const sessionGroupMap = {};
  (c.attendanceRecords || []).forEach(r => {
    if (!r.sessionId || !r.groupId) return;
    const key = r.sessionId + '__' + r.groupId;
    if (!sessionGroupMap[key]) sessionGroupMap[key] = [];
    sessionGroupMap[key].push(r);
  });

  // 2. 統計各場次中全班最早完成點名的組別與操作者
  const sessionEarliest = {};
  const markerStats = {};

  Object.entries(sessionGroupMap).forEach(([sgKey, recs]) => {
    const [sessionId, groupId] = sgKey.split('__');
    const sorted = [...recs].sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
    const latest = sorted[0];
    const compTime = latest.updatedAt || latest.createdAt || 0;

    const recWithMarker = sorted.find(r => r.markedById || r.markedByName) || latest;
    let markedId = recWithMarker.markedById || '';
    let markedName = recWithMarker.markedByName || '';

    if (markedId === 'teacher' || markedName === '老師' || markedName.includes('老師')) {
      markedId = 'teacher';
      markedName = markedName || '任課老師';
    }

    if (!markedId && !markedName) return;

    // 記錄該場次最速完成者（不含老師）
    if (compTime > 0 && markedId !== 'teacher') {
      if (!sessionEarliest[sessionId] || compTime < sessionEarliest[sessionId].time) {
        sessionEarliest[sessionId] = { time: compTime, markerKey: markedId || markedName, groupId };
      }
    }

    const key = markedId || markedName;
    if (!markerStats[key]) {
      const st = (markedId && markedId !== 'teacher' && c.students.find(s => s.id === markedId || s.ref === markedId))
        || (markedName && c.students.find(s => s.name === markedName));
      markerStats[key] = {
        id: (st && st.id) ? st.id : markedId,
        name: (st && st.name) ? st.name : markedName,
        student: st,
        sessionsCount: 0,
        recordsCount: 0,
        timestamps: [],
        groupsMarked: new Set(),
      };
    }
    markerStats[key].sessionsCount += 1;
    markerStats[key].recordsCount += recs.length;
    markerStats[key].groupsMarked.add(groupId);
    if (compTime > 0) markerStats[key].timestamps.push(compTime);
  });

  // 累積全班最速次數
  Object.values(sessionEarliest).forEach(se => {
    if (markerStats[se.markerKey]) {
      markerStats[se.markerKey].fastestCount = (markerStats[se.markerKey].fastestCount || 0) + 1;
    }
  });

  const results = Object.values(markerStats).map(m => {
    let avgMinutes = 0;
    if (m.timestamps.length > 0) {
      const minutesList = m.timestamps.map(t => {
        const d = new Date(t);
        const utcHours = d.getUTCHours();
        const localHours = (utcHours + 8) % 24;
        return localHours * 60 + d.getUTCMinutes();
      });
      avgMinutes = Math.round(minutesList.reduce((a, b) => a + b, 0) / minutesList.length);
    }
    const h = String(Math.floor(avgMinutes / 60)).padStart(2, '0');
    const min = String(avgMinutes % 60).padStart(2, '0');
    const avgTimeStr = avgMinutes > 0 ? `${h}:${min}` : '--:--';

    const latestTs = m.timestamps.length ? Math.max(...m.timestamps) : null;
    const latestTimeFormatted = latestTs ? formatLogTime(latestTs) : '';

    const st = m.student;
    const groupName = st ? ((c.groups.find(g => g.id === st.groupId) || {}).name || '未分組') : (m.id === 'teacher' ? '任課老師' : '跨組代理');
    let role = '組員';
    if (m.id === 'teacher') {
      role = '老師';
    } else if (st) {
      role = st.isLeader ? '組長' : st.isVice ? '副組長' : '組員';
    } else {
      role = '代理';
    }

    return {
      id: m.id,
      name: m.name,
      student: st,
      group: groupName,
      role: role,
      sessionsCount: m.sessionsCount,
      recordsCount: m.recordsCount,
      fastestCount: m.fastestCount || 0,
      avgMinutes,
      avgTimeStr,
      latestTime: latestTs,
      latestTimeFormatted,
    };
  });

  // 排序：點名次數最多者優先 (sessionsCount DESC) -> 最速次數最多者 (fastestCount DESC) -> 平均時刻最早者 (avgMinutes ASC)
  results.sort((a, b) => {
    if (b.sessionsCount !== a.sessionsCount) return b.sessionsCount - a.sessionsCount;
    if (b.fastestCount !== a.fastestCount) return b.fastestCount - a.fastestCount;
    if (a.avgMinutes > 0 && b.avgMinutes > 0 && a.avgMinutes !== b.avgMinutes) return a.avgMinutes - b.avgMinutes;
    return (b.latestTime || 0) - (a.latestTime || 0);
  });

  // 賦予名次、獎牌與稱號
  results.forEach((item, idx) => {
    item.rank = idx + 1;
    if (idx === 0) item.medal = '🥇';
    else if (idx === 1) item.medal = '🥈';
    else if (idx === 2) item.medal = '🥉';
    else item.medal = '';

    const titles = [];
    if (item.fastestCount >= 2) titles.push('⚡ 最速先鋒');
    else if (item.fastestCount === 1) titles.push('⚡ 敏捷代表');

    if (item.sessionsCount >= 4) titles.push('🌟 全勤模範');
    else if (item.sessionsCount >= 3) titles.push('🎖️ 積極盡責');

    if (item.role === '組長') titles.push('👑 領袖風範');
    else if (item.role === '副組長') titles.push('⭐ 得力助手');
    else if (item.role === '代理') titles.push('🤝 義氣相挺');

    item.titleBadge = titles.join(' · ') || '點名達人';
  });

  return results;
}

/* 匯出點名人員表現排行榜為 CSV 檔案 */
function exportMarkerLeaderboardCSV(c) {
  if (!c) return;
  const board = calcRollCallPerformance(c);
  if (!board.length) {
    alert('目前尚無點名執行紀錄可供匯出。');
    return;
  }
  const headers = ['名次', '姓名', '學號', '所屬組別', '身分角色', '累計點名完成組次', '累計標記組員人次', '全班最速完成次數', '平均點名完成時刻', '最近點名時間', '表現稱號'];
  const rows = board.map(item => [
    item.rank,
    item.name,
    item.id,
    item.group,
    item.role,
    item.sessionsCount,
    item.recordsCount,
    item.fastestCount,
    item.avgTimeStr,
    item.latestTimeFormatted || '',
    item.titleBadge
  ]);

  const escapeCSV = val => {
    const s = String(val == null ? '' : val).replace(/"/g, '""');
    return `"${s}"`;
  };

  const csvContent = '\uFEFF' + [
    headers.map(escapeCSV).join(','),
    ...rows.map(r => r.map(escapeCSV).join(','))
  ].join('\r\n');

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const courseName = (c.name || '課程').replace(/[^\w\u4e00-\u9fa5]/g, '_');
  const today = todayDateStr();
  a.href = url;
  a.download = `點名人員任務執行表現學期排行_${courseName}_${today}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
/* 統計各組員缺席次數（支援整學期或特定日期，相容 studentId 與 ref 標識） */
function attendanceAbsentCounts(c, date, filterStudentIds = null) {
  const ids = attendanceSessions(c).filter(s => !date || s.date === date).map(s => s.id);
  const counts = {};
  const filterSet = filterStudentIds ? new Set(filterStudentIds) : null;
  (c.attendanceRecords || []).forEach(r => {
    if (r.status !== 'absent' || !ids.includes(r.sessionId)) return;
    const st = c.students.find(s => (s.id && r.studentId && s.id === r.studentId) || (s.ref && r.ref && s.ref === r.ref) || (s.id && s.id === r.ref) || (s.ref && s.ref === r.studentId));
    const key = r.studentId || (st ? (st.id || st.ref) : r.ref);
    if (!key) return;
    // 前台他人學號已遮蔽（僅前 3 碼），不同組學生可能遮蔽後相同，故優先以唯一 ref 比對；無 ref（老師端）才用完整學號
    if (filterSet && !filterSet.has(r.ref) && !(st && st.ref && filterSet.has(st.ref)) && !filterSet.has(r.studentId) && !(st && !st.ref && filterSet.has(st.id))) return;
    counts[key] = (counts[key] || 0) + 1;
  });
  return counts;
}

/* 缺席關懷名單：整學期缺席次數超過門檻之學生，依缺席次數由多到少排序 */
function careAbsenceList(c, threshold) {
  const counts = attendanceAbsentCounts(c, null);
  const list = [];
  Object.entries(counts).forEach(([key, n]) => {
    const details = getStudentAbsenceList(c, key);
    const dates = [...new Set(details.map(d => d.date))].sort();
    if (n <= threshold) return;
    const rec = (c.attendanceRecords || []).find(r => r.studentId === key || r.ref === key);
    const sid = rec && rec.studentId ? rec.studentId : key;
    const st = c.students.find(x => x.id === sid || (x.ref && x.ref === key));
    const g = st && st.groupId ? c.groups.find(x => x.id === st.groupId) : null;
    list.push({
      key, id: st ? st.id : sid, name: st ? st.name : ((rec && rec.studentName) || sid),
      groupName: g ? g.name : '未分組', count: n,
      lastDate: dates[dates.length - 1] || '',
    });
  });
  return list.sort((a, b) => b.count - a.count ||
    String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
}

/* 導師關懷訊息（中越雙語），供複製至 LINE 私訊 */
function careMessageText(c, x) {
  return `Hi ${x.name}：\n` +
    `點名系統紀錄顯示你本學期目前已缺席 ${x.count} 次（最近一次為 ${x.lastDate}）。\n` +
    `老師很關心你的近況，是不是身體不舒服、打工或生活上遇到了什麼困難呢？如果有任何需要協助的地方，歡迎直接回覆這則訊息或找老師聊聊，我們一起想辦法。\n` +
    `期待在課堂上見到你，加油！💪\n\n` +
    `Hi ${x.name},\n` +
    `Theo hệ thống điểm danh, học kỳ này em đã vắng mặt ${x.count} lần (gần nhất vào ngày ${x.lastDate}).\n` +
    `Thầy/Cô rất quan tâm đến tình hình của em. Em có gặp vấn đề về sức khỏe, công việc làm thêm hay khó khăn gì trong cuộc sống không? Nếu cần hỗ trợ, em cứ trả lời tin nhắn này hoặc gặp Thầy/Cô để trao đổi nhé.\n` +
    `Mong sớm gặp lại em trên lớp. Cố lên em nhé! 💪`;
}

/* 取得特定學生的缺席明細（依日期排序，列出日期、活動/時段名稱、更新時間） */
function getStudentAbsenceList(c, studentKey, date = null) {
  const sessions = attendanceSessions(c);
  const sessionMap = {};
  sessions.forEach(s => { sessionMap[s.id] = s; });

  const matchingRec = (c.attendanceRecords || []).find(r => r.studentId === studentKey || r.ref === studentKey);
  const targetRef = matchingRec ? matchingRec.ref : studentKey;
  const targetSid = matchingRec ? matchingRec.studentId : studentKey;
  const st = c.students.find(s => s.id === targetSid || (targetRef && s.ref === targetRef) || s.id === studentKey || s.ref === studentKey);
  const validKeys = new Set([studentKey, targetSid, targetRef, st?.id, st?.ref].filter(Boolean));

  const list = [];
  (c.attendanceRecords || []).forEach(r => {
    if (r.status !== 'absent') return;
    const recKey = r.studentId || r.ref;
    if (!validKeys.has(recKey) && !validKeys.has(r.studentId) && !validKeys.has(r.ref)) return;
    const session = sessionMap[r.sessionId];
    if (!session) return;
    if (date && session.date !== date) return;

    const isDaily = isDailySession(session);
    const activityName = isDaily
      ? '一般日常點名'
      : (session.name || '重要集會');
    const timeSlotStr = session.timeSlot ? `（${session.timeSlot}）` : '';

    list.push({
      sessionId: session.id,
      date: session.date,
      activityName: `${activityName}${timeSlotStr}`,
      isDaily,
      updatedAt: r.updatedAt || r.createdAt || 0,
      markedByName: r.markedByName || '',
    });
  });

  return list.sort((a, b) => b.date.localeCompare(a.date) || (b.updatedAt - a.updatedAt));
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
      <span>💡 未分組學生欲擔任組長開組請點擊登入：<br><small class="vn-sub">Sinh viên chưa có nhóm muốn làm trưởng nhóm vui lòng đăng nhập:</small></span>
      <button class="btn btn-primary" data-act="open-leader-login" style="padding:0.3rem 0.75rem;font-size:0.82rem;">🎓 登入開組<br><small class="vn-sub">Đăng nhập lập nhóm</small></button>
    </div>
  ` : ''}
  <div class="pick-list">${pool.length
    ? pool.map(s => {
        if (showLoginPrompt) {
          return `<div class="student student-clickable-login" data-act="quick-student-fill" data-name="${esc(s.name)}" data-id="${esc(s.id)}" title="點擊以此身分登入擔任組長 / Bấm để đăng nhập làm trưởng nhóm" style="cursor:pointer;">${esc(s.name)} (${esc(s.id)}) <span class="login-chip" style="margin-left:auto;font-size:0.72rem;background:#dbeafe;color:#1d4ed8;padding:0.1rem 0.4rem;border-radius:4px;">登入開組 ➔<small class="vn-sub">Đăng nhập lập nhóm</small></span></div>`;
        }
        return `<div class="student">${esc(s.name)} (${esc(s.id)})</div>`;
      }).join('')
    : '<p class="file-path">全部學生皆已分組。<br><small class="vn-sub">Tất cả sinh viên đã vào nhóm.</small></p>'}</div>`;
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

  return `
  <section class="block-section group-status-section" id="group-status-block">
    <div class="block-header">
      <div class="block-title-wrap">
        <h2>分組現況<br><small class="vn-sub" style="font-size:0.85rem;color:#64748b;">Tình trạng chia nhóm</small></h2>
      </div>
      ${(!state.session || (state.session && state.session.role !== 'student')) ? `
        <div class="board-actions">
          <button class="btn btn-primary student-login-btn ${loginMode === 'student' ? 'active' : ''}" data-act="open-leader-login" title="登入後，未分組同學即可開組並挑選尚未分組的組員 / Đăng nhập để lập nhóm và chọn thành viên chưa vào nhóm">
            <span class="btn-icon">🎓</span> <span>申請擔任組長<br><small class="vn-sub">Đăng ký làm trưởng nhóm</small></span>
          </button>
        </div>` : ''}
    </div>

    <!-- 顯眼呈顯目前選取的學年度科目 -->
    <div class="current-course-banner">
      <div class="banner-badge">目前選擇科目<br><small class="vn-sub">Môn học hiện tại</small></div>
      <div class="banner-content">
        <div class="banner-main">
          <div class="course-year-tag">${esc(c ? (c.year || '未設學年度') : '尚未選擇學年度（Chưa chọn năm học）')}</div>
          <div class="course-subject-title">${esc(c ? (c.subject || '（未命名科目）') : '請先於左側課程列表選擇課程（Chọn môn học bên trái）')}</div>
        </div>
        ${c ? `
          <div class="course-meta-tags">
            <span class="meta-pill">👥 每組 ${c.groupSize || 4} ± ${c.tolerance || 0} 人（門檻 ${minCap(c)} ~ 上限 ${cap(c)} 人 / ${minCap(c)}~${cap(c)} người）</span>
            <span class="meta-pill">📊 學生數 ${c.students.length} 人 · ${c.groups.length} 組（${c.students.length} SV · ${c.groups.length} nhóm）</span>
            ${c.deadline ? `<span class="meta-pill ${deadlinePassed(c) ? 'expired' : 'active'}">⏳ 分組截止：${esc(formatDeadline(c.deadline))} ${deadlinePassed(c) ? '（已截止 / Đã hết hạn）' : '（進行中 / Đang mở）'}<small class="vn-sub">Hạn chót chia nhóm</small></span>` : '<span class="meta-pill" style="opacity:0.85;">⏳ 分組截止：尚未設定<small class="vn-sub">Hạn chót chia nhóm: Chưa thiết lập</small></span>'}
          </div>` : ''}
      </div>
    </div>

    <!-- 學生登入區塊嵌入於此 -->
    ${loginMode === 'student' ? loginCard() : ''}

    ${!c ? `<p class="file-path empty-notice">請先於左側「學年度分組清單」中點選欲查看分組的學年度與項目。<br><small class="vn-sub">Vui lòng chọn môn học từ danh sách bên trái.</small></p>` : ''}

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
        evalStatusTag = `<span class="tag-status no-leader">無組長<small class="vn-sub">Chưa có trưởng nhóm (-10)</small></span>`;
      } else if (isSubmitted) {
        evalStatusTag = `<span class="tag-status submitted">✅ 組長已完成加分評定<small class="vn-sub">Trưởng nhóm đã đánh giá (+${maxB})</small></span>`;
      } else if (isOverdue) {
        evalStatusTag = `<span class="tag-status overdue">⚠️ 評分逾時<small class="vn-sub">Quá hạn đánh giá</small></span>`;
      } else if (isEvalOpen) {
        evalStatusTag = `<span class="tag-status open">📝 評分開放中${g.peerEvalDeadline ? `（${esc(g.peerEvalDeadline.replace('T', ' '))}截止）` : ''}<small class="vn-sub">Đang mở đánh giá</small></span>`;
      }

      return `<div class="group-card ${self && self.groupId === g.id ? 'mine' : ''} ${isGroupEditActive ? 'reopened' : ''}">
        <div class="group-card-top-tags">
          ${autoCount ? `<span class="tag">自動 ${autoCount}<small class="vn-sub">Tự động</small></span>` : ''}
          ${evalStatusTag}
        </div>
        <h3>${esc(g.name)} <small>${list.length}/${cap(c)} 人${full ? ' · 已滿' : ''}<small class="vn-sub">${list.length}/${cap(c)} người${full ? ' · Đã đủ' : ''}</small></small></h3>
        <p class="file-path">組長：${lead ? esc(lead.name) : '尚未產生'}<small class="vn-sub">Trưởng nhóm: ${lead ? esc(lead.name) : 'Chưa có'}</small></p>
        ${g.allowEdit ? `
          <div class="group-badge-reopened">
            ${isGroupEditActive ? '🔓 老師已重新開放本組挑選<small class="vn-sub">Đã mở lại quyền chọn thành viên</small>' : '⏳ 重新開放挑選已逾時截止<small class="vn-sub">Đã hết hạn</small>'}
            ${g.editDeadline ? `<span style="font-size:0.75rem;opacity:0.9;">（截止：${esc(g.editDeadline.replace('T', ' '))} / Hạn chót）</span>` : ''}
          </div>` : ''}
        <div class="students">${list.length ? list.map(s => {
          const adj = calcAdjustment(c, g, s);
          return `<div class="student ${s.isLeader ? 'leader' : ''} ${s.isVice ? 'vice-leader' : ''}">
            <span class="student-info-col">
              ${esc(s.name)} (${esc(s.id)})${s.isLeader ? ' — ⭐組長<small class="vn-sub">Trưởng nhóm</small>' : s.isVice ? ' — 🛡️副組長<small class="vn-sub">Phó nhóm</small>' : ''}${s.autoAssigned ? ' <span class="tag-inline auto">自動<small class="vn-sub">Tự động</small></span>' : ''}
            </span>
            ${isTeacher ? scoreBadge(adj) : ''}
          </div>`;
        }).join('') : '<div class="student">（尚無成員）<small class="vn-sub">Chưa có thành viên</small></div>'}</div>
        ${isTeacher ? `
          <div class="group-teacher-ctrls">
            <button class="tab-btn ${g.allowEdit ? 'on' : ''}" data-act="toggle-group-edit" data-id="${g.id}" data-allow="${g.allowEdit ? '0' : '1'}">
              ${g.allowEdit ? '🔒 取消開放挑選' : '🔓 重新開放組長挑選'}
            </button>
            ${g.allowEdit && g.editDeadline ? `<span style="font-size:0.75rem;color:#d97706;margin-top:0.25rem;display:block;">截止: ${esc(g.editDeadline.replace('T', ' '))}</span>` : ''}
          </div>` : ''}
      </div>`;
    }).join('')}</div>` : '<p class="file-path empty-notice">老師尚未建立組別，或由學生自行擔任組長開組。<br><small class="vn-sub">Chưa có nhóm nào, sinh viên có thể tự lập nhóm làm trưởng nhóm.</small></p>') : ''}
  </section>

  ${withUnassigned && c && !hideUnassignedForLeader ? `
  <section class="block-section unassigned-section" id="unassigned-block">
    <div class="block-header">
      <div class="block-title-wrap">
        <h2>未分組名單 <span class="badge-count">${pool.length}</span><br><small class="vn-sub" style="font-size:0.85rem;color:#64748b;">Danh sách chưa vào nhóm</small></h2>
      </div>
    </div>
    <div class="unassigned-body">
      ${unassignedList(c)}
    </div>
  </section>` : ''}`;
}

/* ===== [Block A] 頁首頂端導覽區：登入、登出、密碼修改與全域狀態 ===== */
/* ---- 各子系統共用返回按鈕：位置（頂部橫條最左、頁尾置中）、配色與大小一致 ---- */
function subsystemBackBtn(kind = 'home') {
  return kind === 'history'
    ? '<button class="btn btn-back" type="button" data-act="history-back">↩️ 回到上一頁<small class="vn-sub">Quay lại trang trước</small></button>'
    : '<button class="btn btn-back" type="button" data-act="nav-public-subview" data-view="dashboard">⬅️ 返回首頁<small class="vn-sub">Quay lại trang chủ</small></button>';
}

/* ---- 獨立頁面：修改個人密碼（取代原本的彈出對話框，可用「回到上一頁」返回進入前的畫面） ---- */
function renderPasswordChangePage() {
  const s = me();
  return `
  <div class="password-standalone-page">
    <div class="block-identifier-tag">
      <span class="block-tag-code">[Block D]</span>
      <span class="block-tag-name">主要內容顯示區（修改個人密碼）<br><small class="vn-sub">Khu vực hiển thị nội dung chính (Đổi mật khẩu)</small></span>
    </div>

    <div class="subsystem-header-bar">
      ${subsystemBackBtn('history')}
      <div class="subsystem-title-tag">
        <span class="subsystem-icon">🔑</span>
        <div>
          <strong>修改個人密碼</strong>
          <br><small class="vn-sub">Đổi mật khẩu cá nhân</small>
        </div>
      </div>
    </div>

    ${!s ? `
      <p class="file-path empty-notice">請先登入學生帳號才能修改密碼。<br><small class="vn-sub">Vui lòng đăng nhập trước khi đổi mật khẩu.</small></p>
    ` : `
      <div class="block-section" style="max-width:560px;">
        <p class="file-path" style="margin:0 0 0.85rem;color:#475569;">
          您好，<b>${esc(s.name)}</b> (${esc(s.id)})。請在此修改個人登入密碼。<br>
          <small class="vn-sub">Xin chào ${esc(s.name)}. Vui lòng đổi mật khẩu tại đây. Mật khẩu mới tối thiểu 4 ký tự.</small>
        </p>
        <form data-act="change-student-password-page-form" class="form-row" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:0.9rem 1rem;">
          <div class="form-group full">
            <label>目前密碼<br><small class="vn-sub">Mật khẩu hiện tại (Lần đầu: Mã SV)</small></label>
            <input type="password" name="current" placeholder="${s.hasCustomPassword ? '請輸入目前密碼' : '首次修改請輸入您的學號'}" required autocomplete="off" style="width:100%;padding:0.5rem;border:1px solid #cbd5e1;border-radius:6px;">
          </div>
          <div class="form-group full">
            <label>新密碼（至少 4 碼）<br><small class="vn-sub">Mật khẩu mới (Tối thiểu 4 ký tự)</small></label>
            <input type="password" name="next" minlength="4" placeholder="請輸入新密碼" required autocomplete="off" style="width:100%;padding:0.5rem;border:1px solid #cbd5e1;border-radius:6px;">
          </div>
          <div class="form-group full">
            <label>再次確認新密碼<br><small class="vn-sub">Xác nhận mật khẩu mới</small></label>
            <input type="password" name="confirm" minlength="4" placeholder="再次輸入新密碼" required autocomplete="off" style="width:100%;padding:0.5rem;border:1px solid #cbd5e1;border-radius:6px;">
          </div>
          <div class="form-group full" style="margin-top:0.5rem;display:flex;justify-content:flex-end;gap:0.5rem;">
            <button class="btn btn-neutral btn-sm" type="button" data-act="history-back">
              取消<br><small class="vn-sub">Hủy</small>
            </button>
            <button class="btn btn-primary btn-sm" type="submit">
              💾 儲存新密碼<br><small class="vn-sub">Lưu mật khẩu mới</small>
            </button>
          </div>
        </form>
      </div>
    `}

    <div class="subsystem-footer">${subsystemBackBtn('history')}</div>
  </div>`;
}

function nav() {
  const c = cur();
  let right = '';
  let center = '';

  if (state.session) {
    if (state.session.role === 'teacher') {
      right = `
        <div class="preview-mode-switch">
          <span class="preview-switch-label">👁️ 檢視模式：<br><small class="vn-sub">Chế độ xem</small></span>
          <div class="preview-btn-group">
            <button class="mode-btn ${teacherPreviewMode === 'admin' ? 'active' : ''}" data-act="switch-preview" data-mode="admin" title="進入完整老師後台管理介面">
              ⚙️ 老師後台<br><small class="vn-sub">Quản trị</small>
            </button>
            <button class="mode-btn ${teacherPreviewMode === 'public' ? 'active' : ''}" data-act="switch-preview" data-mode="public" title="模擬一般訪客或未登入組員看到的前台畫面">
              👀 一般學生前台<br><small class="vn-sub">Giao diện SV</small>
            </button>
            <button class="mode-btn ${teacherPreviewMode === 'leader' ? 'active' : ''}" data-act="switch-preview" data-mode="leader" title="模擬擔任組長的學生登入後看到的完整挑選與管理畫面">
              🎓 組長登入模式<br><small class="vn-sub">Nhóm trưởng</small>
            </button>
            <button class="mode-btn" data-act="open-simulate-student-modal" title="轉換身分以指定學生身分模擬登入測試問卷">
              🧪 模擬學生問卷<br><small class="vn-sub">Thử nghiệm SV</small>
            </button>
          </div>
        </div>
        <span class="who">👨‍🏫 老師<br><small class="vn-sub">Giáo viên</small></span>
        <button class="tab-btn" data-act="logout">
          登出<br><small class="vn-sub">Đăng xuất</small>
        </button>
      `;
    } else {
      const studentObj = me() || {};
      const who = esc(studentObj.name || '');
      const studentRoleTag = studentObj.isLeader ? '（👑組長）' : studentObj.isVice ? '（⭐副組長）' : '（組員）';

      if (state.session && state.session.simulatedBy === 'teacher') {
        right = `
          <span class="who" style="background:#fef3c7;color:#92400e;padding:0.25rem 0.65rem;border-radius:6px;font-weight:700;border:1px solid #fde68a;">
            🧪 模擬測試：${who}
            <br><small class="vn-sub">Thử nghiệm</small>
          </span>
          <button class="tab-btn" data-act="exit-simulation" style="background:#f59e0b;color:#ffffff;font-weight:700;border-color:#d97706;">
            ↩️ 結束測試<br><small class="vn-sub">Thoát</small>
          </button>
        `;
      } else {
        right = `
          <span class="who">
            🎓 ${who} ${studentRoleTag}
            <br><small class="vn-sub">Sinh viên</small>
          </span>
          <button class="tab-btn" data-act="nav-public-subview" data-view="password" style="background:#f0fdf4;border-color:#86efac;color:#166534;" title="修改個人登入密碼">
            🔑 密碼修改<br><small class="vn-sub">Đổi mật khẩu</small>
          </button>
          <button class="tab-btn" data-act="logout">
            登出<br><small class="vn-sub">Đăng xuất</small>
          </button>
        `;
      }
    }
  } else {
    center = `
      <button class="btn btn-primary btn-sm" data-act="open-leader-login" style="padding:0.35rem 0.95rem;">
        🎓 組長／副組長點名登入<br><small class="vn-sub">Đăng nhập điểm danh</small>
      </button>`;
    right = `
      <button class="teacher-link ${loginMode === 'teacher' ? 'on' : ''}" data-act="show-teacher-login">
        👨‍🏫 老師登入<br><small class="vn-sub">Đăng nhập giáo viên</small>
      </button>`;
  }

  return `<nav>
    <div class="block-identifier-tag" style="position:absolute;top:2px;left:6px;font-size:0.68rem;opacity:0.75;pointer-events:none;">
      <span class="block-tag-code">[Block A]</span>
      <span class="block-tag-name">頁首導覽區</span>
    </div>
    <span class="brand">
      <span class="logo">${APP_NAME}</span>
      <span class="ver">${APP_VERSION}</span>
    </span>
    ${c ? `<span class="course-tag">${esc(courseLabel(c))}</span>` : ''}
    <span class="center">${center}</span>
    <span class="tabs">${right}</span>
  </nav>`;
}

/* context：'groups'（分組子系統：申請擔任組長）| 'attendance'（點名子系統：組長／副組長點名）——說明文字只聚焦該子系統功能 */
function loginCard(context = 'groups') {
  if (loginMode === 'student') {
    const c = cur();
    const isAttendance = context === 'attendance';
    const title = isAttendance
      ? '🎓 組長／副組長點名登入<br><small class="vn-sub">Đăng nhập điểm danh (Nhóm trưởng / Nhóm phó)</small>'
      : '🎓 申請擔任組長登入<br><small class="vn-sub">Đăng nhập đăng ký làm trưởng nhóm</small>';
    const tips = isAttendance ? `
        • 擔任組長或副組長者，登入後即可進行今日組員點名。<br><small class="vn-sub">Nhóm trưởng hoặc nhóm phó sau khi đăng nhập có thể điểm danh thành viên hôm nay.</small>
        • 預設密碼為學號；若忘記密碼請洽老師協助重設。<br><small class="vn-sub">Mật khẩu mặc định là mã SV; nếu quên mật khẩu vui lòng liên hệ giáo viên.</small>` : `
        • 尚未分組的同學登入後即可開組擔任組長，並從未分組名單挑選組員。<br><small class="vn-sub">Sinh viên chưa có nhóm sau khi đăng nhập có thể lập nhóm làm trưởng nhóm và chọn thành viên từ danh sách chưa chia nhóm.</small>
        • 組長或副組長登入後可挑選、釋出組員，組長並可設定副組長。<br><small class="vn-sub">Nhóm trưởng hoặc nhóm phó có thể thêm, loại thành viên; nhóm trưởng có thể đặt nhóm phó.</small>
        • 預設密碼為學號；若忘記密碼請洽老師協助重設。<br><small class="vn-sub">Mật khẩu mặc định là mã SV; nếu quên mật khẩu vui lòng liên hệ giáo viên.</small>`;
    return `<div class="login-bar embedded" id="login">
      <div class="login-header">
        <div>
          <strong>${title}</strong>
        </div>
        <button class="tab-btn close" type="button" data-act="close-login" title="關閉">✕</button>
      </div>
      <form data-act="login-student" class="inline-form">
        <div class="form-group">
          <label>帳號（學生姓名）<br><small class="vn-sub">Tài khoản (Họ và tên)</small></label>
          <input name="name" placeholder="請輸入姓名 (Nhập họ và tên)" required autocomplete="off">
        </div>
        <div class="form-group">
          <label>密碼（預設學號）<br><small class="vn-sub">Mật khẩu (Mặc định: Mã SV)</small></label>
          <input type="password" name="password" placeholder="預設學號 (Mặc định: Mã SV)" required autocomplete="off">
        </div>
        <button class="btn btn-primary" type="submit">
          登入<br><small class="vn-sub">Đăng nhập</small>
        </button>
      </form>
      <p class="file-path">
        目前選取科目：<b>${esc(c ? courseLabel(c) : '請先於左側選擇科目')}</b><br><small class="vn-sub">Môn học đang chọn</small>
        ${tips}
      </p>
    </div>`;
  }
  if (loginMode === 'teacher') {
    return `<div class="login-bar teacher" id="login">
      <div class="login-header">
        <div>
          <strong>👨‍🏫 老師後台登入</strong>
          <br><small class="vn-sub">Đăng nhập giáo viên</small>
        </div>
        <button class="tab-btn close" type="button" data-act="close-login" title="關閉">✕</button>
      </div>
      <form data-act="login-teacher" class="inline-form">
        <div class="form-group pw">
          <label>老師管理密碼<br><small class="vn-sub">Mật khẩu giáo viên</small></label>
          <input type="password" name="password" required autocomplete="off">
        </div>
        <button class="btn btn-secondary" type="submit">
          老師登入<br><small class="vn-sub">Đăng nhập</small>
        </button>
      </form>
    </div>`;
  }
  return '';
}

/* ---- 共用元件：組員缺席排行榜卡片（支援全班或組內、前台或後台，點選數字開明細） ---- */
function renderAbsenceLeaderboardCard(c, { title = '組員缺席排行榜', subTitle = 'Bảng xếp hạng vắng mặt', filterMates = null, scopeAct = 'public-attendance-stat-scope', currentScope = 'all', limit = 15, isPublicFlow = false } = {}) {
  if (!c) return '';
  const filterIds = filterMates ? filterMates.map(m => m.ref || m.id) : null;
  const counts = attendanceAbsentCounts(c, currentScope === 'date' ? (attendanceStatDate || todayDateStr()) : null, filterIds);

  const listSource = filterMates || c.students;
  const leaderboardAll = Object.entries(counts)
    .map(([key, n]) => {
      const matchingRec = (c.attendanceRecords || []).find(r => r.studentId === key || r.ref === key);
      const targetRef = matchingRec ? matchingRec.ref : key;
      const targetSid = matchingRec ? matchingRec.studentId : key;
      const st = listSource.find(x => x.id === targetSid || (targetRef && x.ref === targetRef) || x.id === key || x.ref === key)
        || c.students.find(x => x.id === targetSid || (targetRef && x.ref === targetRef) || x.id === key || x.ref === key);
      const g = st ? c.groups.find(x => x.id === st.groupId) : (matchingRec && matchingRec.groupId ? c.groups.find(x => x.id === matchingRec.groupId) : null);
      const studentName = (st && st.name) ? st.name : ((matchingRec && matchingRec.studentName) ? matchingRec.studentName : key);
      const groupName = g ? g.name : ((matchingRec && matchingRec.groupName) ? matchingRec.groupName : '未分組');
      const displayId = targetSid || (st ? st.id : key);
      return {
        key,
        // 前台公開頁面（isPublicFlow）一律遮蔽學號顯示，避免洩漏學生預設登入密碼；
        // key 仍保留原始值供 view-absence-detail 內部比對缺席明細使用，不受影響
        id: isPublicFlow ? maskId(displayId) : displayId,
        name: studentName,
        groupName: groupName,
        count: n,
      };
    })
    .sort((a, b) => b.count - a.count);

  const pageSize = limit || 15;
  const totalPages = Math.max(1, Math.ceil(leaderboardAll.length / pageSize));
  if (publicAttendanceLeaderboardPage > totalPages) publicAttendanceLeaderboardPage = totalPages;
  if (publicAttendanceLeaderboardPage < 1) publicAttendanceLeaderboardPage = 1;
  const startIndex = (publicAttendanceLeaderboardPage - 1) * pageSize;
  const leaderboard = leaderboardAll.slice(startIndex, startIndex + pageSize);

  const dateStr = attendanceStatDate || todayDateStr();

  const paginationHtml = leaderboardAll.length > pageSize ? `
    <div class="leaderboard-pagination" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.5rem;padding:0.6rem 0.25rem 0.15rem;border-top:1px solid #f1f5f9;margin-top:0.5rem;">
      <div style="font-size:0.8rem;color:#64748b;">
        第 <b>${startIndex + 1} - ${Math.min(startIndex + pageSize, leaderboardAll.length)}</b> 名 / 共 <b>${leaderboardAll.length}</b> 名（第 <b>${publicAttendanceLeaderboardPage} / ${totalPages}</b> 頁）
      </div>
      <div style="display:flex;align-items:center;gap:0.3rem;flex-wrap:wrap;">
        <button class="pagination-btn" data-act="set-public-leaderboard-page" data-page="${publicAttendanceLeaderboardPage - 1}" ${publicAttendanceLeaderboardPage <= 1 ? 'disabled style="opacity:0.4;cursor:not-allowed;"' : ''}>
          ◀ 上一頁 / Trang trước
        </button>
        ${Array.from({ length: totalPages }, (_, idx) => idx + 1).map(p => `
          <button class="pagination-page-btn ${p === publicAttendanceLeaderboardPage ? 'active' : ''}" data-act="set-public-leaderboard-page" data-page="${p}" style="${p === publicAttendanceLeaderboardPage ? 'font-weight:750;background:#3b82f6;color:#fff;border-color:#3b82f6;' : ''}">
            ${p}
          </button>
        `).join('')}
        <button class="pagination-btn" data-act="set-public-leaderboard-page" data-page="${publicAttendanceLeaderboardPage + 1}" ${publicAttendanceLeaderboardPage >= totalPages ? 'disabled style="opacity:0.4;cursor:not-allowed;"' : ''}>
          下一頁 / Trang sau ▶
        </button>
      </div>
    </div>` : '';

  return `
  <div class="absence-leaderboard-box ${isPublicFlow ? 'public-flow' : ''}">
    <div class="absence-leaderboard-header">
      <div style="display:flex;align-items:center;gap:0.4rem;">
        <span style="font-size:1.15rem;">🏆</span>
        <strong style="color:#991b1b;font-size:1.02rem;">${esc(title)}<small class="vn-sub" style="color:#64748b;">${esc(subTitle)}</small></strong>
      </div>
      <div style="display:flex;align-items:center;gap:0.4rem;">
        <select data-act="${esc(scopeAct)}" style="font-size:0.8rem;padding:0.25rem 0.45rem;border-radius:6px;border:1px solid #cbd5e1;">
          <option value="all" ${currentScope === 'all' ? 'selected' : ''}>整個學期（Cả học kỳ）</option>
          <option value="date" ${currentScope === 'date' ? 'selected' : ''}>依日期（${esc(dateStr)} / Theo ngày）</option>
        </select>
      </div>
    </div>
    ${leaderboard.length ? `
    <div class="table-wrap" style="margin:0;">
      <table class="roster" style="background:#fff;margin:0;font-size:0.86rem;">
        <thead>
          <tr>
            <th style="width:48px;">排名<br><small class="vn-sub">Hạng</small></th>
            <th>學號<br><small class="vn-sub">Mã SV</small></th>
            <th>姓名<br><small class="vn-sub">Họ tên</small></th>
            <th>組別<br><small class="vn-sub">Nhóm</small></th>
            <th style="text-align:center;width:95px;">缺席次數<br><small class="vn-sub">Số lần vắng</small></th>
          </tr>
        </thead>
        <tbody>
          ${leaderboard.map((l, i) => {
            const rank = startIndex + i + 1;
            return `
            <tr>
              <td><span style="font-weight:700;color:${rank === 1 ? '#b91c1c' : rank === 2 ? '#ea580c' : rank === 3 ? '#d97706' : '#64748b'};">${rank}</span></td>
              <td>${esc(l.id)}</td>
              <td><b>${esc(l.name)}</b></td>
              <td><span class="group-name-tag" style="font-size:0.75rem;">${esc(l.groupName)}</span></td>
              <td style="text-align:center;">
                <button class="absent-count-badge" data-act="view-absence-detail" data-student="${esc(l.key)}" data-name="${esc(l.name)}" data-id="${esc(l.id)}" title="點選查看缺席日期與對應活動明細 / Xem chi tiết ngày vắng mặt">
                  ⚠️ ${l.count} 次
                </button>
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
    ${paginationHtml}
    ` : '<p class="file-path" style="margin:0.25rem 0 0;font-size:0.84rem;color:#166534;">✅ 統計範圍內目前無任何組員缺席紀錄。<br><small class="vn-sub">Không có ghi nhận vắng mặt.</small></p>'}
  </div>`;
}

/* ===== [Block B] 公佈欄（對接 Notion 班務公告子頁面，每頁 10 筆分頁瀏覽） ===== */
const INITIAL_BULLETIN_PAGES = [{"id":"3eabbaa1-9830-80f8-a2bd-e311722dd16f","date":"20260929","title":"20260929 115-1生活關懷問卷填寫","url":"https://app.notion.com/p/3eabbaa1983080f8a2bde311722dd16f"},{"id":"3e2bbaa1-9830-8015-b891-dfcf3cc61716","date":"20260921","title":"20260921 訪視計劃表更新、提醒9/22演練全員到齊、新學期班網公布欄、點名網址","url":"https://app.notion.com/p/3e2bbaa198308015b891dfcf3cc61716"},{"id":"3dbbbaa1-9830-809c-9953-e9e3e00f662c","date":"20260915","title":"20260915 宣布9/22上課演練「全員到齊」、115-1分組調整、9/24前加退選","url":"https://app.notion.com/p/3dbbbaa19830809c9953e9e3e00f662c"},{"id":"3ccbbaa1-9830-804c-9345-d57c69973444","date":"20260830","title":"20260830 115-1_四技國際專通識學生多元意願調查結果","url":"https://app.notion.com/p/3ccbbaa19830804c9345d57c69973444"},{"id":"63dbbaa1-9830-8222-9f62-019ac8da8b37","date":"20260611","title":"20260611缺曠統計","url":"https://app.notion.com/p/63dbbaa1983082229f62019ac8da8b37"},{"id":"c17bbaa1-9830-82f4-8b97-81597c1200c1","date":"20260608","title":"20260608 班會(暑假前叮嚀)","url":"https://app.notion.com/p/c17bbaa1983082f48b9781597c1200c1"},{"id":"910bbaa1-9830-83f9-9db6-01b8bebce866","date":"20260602","title":"20260602 大掃除競賽(20260430)獲第1名簽獎名單","url":"https://app.notion.com/p/910bbaa1983083f99db601b8bebce866"},{"id":"a7cbbaa1-9830-8215-b794-8147568fa908","date":"20260608","title":"20260608-20260601 班會(校外任務取消)(114-2第2次「組內點名」、及「缺曠輔導追蹤」演練)","url":"https://app.notion.com/p/a7cbbaa198308215b7948147568fa908"},{"id":"462bbaa1-9830-82a3-87b8-8164730e3cc7","date":"20260529","title":"20260529 調整各組副組長名單","url":"https://app.notion.com/p/462bbaa1983082a387b88164730e3cc7"},{"id":"0dabbaa1-9830-83eb-a966-818921891a0f","date":"20260525","title":"20260525-2 擔任幹部獎勵及未配合「全員到課」演練扣分名單","url":"https://app.notion.com/p/0dabbaa1983083eba966818921891a0f"},{"id":"b48bbaa1-9830-83c0-9982-81c6baaa0b1a","date":"20260525","title":"20260525 班會(「全員到課」、「組內點名」、及「缺曠輔導追蹤」演練、115-1訪視調查)","url":"https://app.notion.com/p/b48bbaa1983083c0998281c6baaa0b1a"},{"id":"5c5bbaa1-9830-836d-a291-8100d5201458","date":"20260524","title":"20260524 115-1工讀與賃居調查","url":"https://app.notion.com/p/5c5bbaa19830836da2918100d5201458"},{"id":"637bbaa1-9830-8224-82e0-81b0ad2f471f","date":"20260520","title":"20260520 更新-20260512 截至0511尚未繳費與填寫名單","url":"https://app.notion.com/p/637bbaa19830822482e081b0ad2f471f"},{"id":"5e1bbaa1-9830-8319-bb95-01dee0890b36","date":"20260518","title":"20260518 班會(副組長缺曠輔導追蹤演練、特休規定更新)","url":"https://app.notion.com/p/5e1bbaa198308319bb9501dee0890b36"},{"id":"844bbaa1-9830-82c1-b857-01d026e904bb","date":"20260511","title":"20260511 班會 (114-2最末期學費繳交)","url":"https://app.notion.com/p/844bbaa1983082c1b85701d026e904bb"},{"id":"546bbaa1-9830-8394-8422-01f0b2ad3fda","date":"20260507","title":"20260507 教育部訪視檢討-非常時期全班(含組長)停止請假","url":"https://app.notion.com/p/546bbaa198308394842201f0b2ad3fda"},{"id":"050bbaa1-9830-8288-b104-01dcff4a6997","date":"20260506","title":"20260506 訪視當日請假名單","url":"https://app.notion.com/p/050bbaa198308288b10401dcff4a6997"},{"id":"4bbbbaa1-9830-820f-9e5a-815b3bb086ea","date":"20260504","title":"20260504-2 請假後需於隔日自行確認是否准假","url":"https://app.notion.com/p/4bbbbaa19830820f9e5a815b3bb086ea"},{"id":"e16bbaa1-9830-82b4-9353-012d2e82c31c","date":"20260504","title":"20260504 班會","url":"https://app.notion.com/p/e16bbaa1983082b49353012d2e82c31c"},{"id":"9b5bbaa1-9830-83ab-82fc-81644255adb9","date":"20260427","title":"20260427班會(因招生任務暫停)","url":"https://app.notion.com/p/9b5bbaa1983083ab82fc81644255adb9"},{"id":"805bbaa1-9830-828d-b41c-0183cec37192","date":"20260420","title":"20260420 班會","url":"https://app.notion.com/p/805bbaa19830828db41c0183cec37192"},{"id":"3d7bbaa1-9830-8305-800c-81ef75373ba1","date":"20260430","title":"20260430 114-2期中全校大掃除競賽","url":"https://app.notion.com/p/3d7bbaa198308305800c81ef75373ba1"},{"id":"ff5bbaa1-9830-83a3-a417-0160c3e06b22","date":"20260415","title":"20260415 點名遲到或未到課且未填寫名單","url":"https://app.notion.com/p/ff5bbaa1983083a3a4170160c3e06b22"},{"id":"d46bbaa1-9830-8342-84af-0127b94d38c3","date":"20260414","title":"20260414 註冊組學分數成績查詢通告","url":"https://app.notion.com/p/d46bbaa19830834284af0127b94d38c3"},{"id":"32abbaa1-9830-8319-89b7-8192e0265886","date":"20260413","title":"20260413 考試將近切勿請假","url":"https://app.notion.com/p/32abbaa19830831989b78192e0265886"},{"id":"50dbbaa1-9830-82d4-81c8-8174c05a20e8","date":"20260408","title":"20260408 缺曠記錄與申誡名單","url":"https://app.notion.com/p/50dbbaa1983082d481c88174c05a20e8"},{"id":"79cbbaa1-9830-830f-ba58-012b819066e1","date":"20260407","title":"20260407 切勿缺曠提醒","url":"https://app.notion.com/p/79cbbaa19830830fba58012b819066e1"},{"id":"f8dbbaa1-9830-82e5-8c38-0141cee82f88","date":"20260330","title":"20260330 提醒大學前兩年需兼顧打工與學業","url":"https://app.notion.com/p/f8dbbaa1983082e58c380141cee82f88"},{"id":"92cbbaa1-9830-82b3-8b66-810a7477fc27","date":"20260317","title":"20260317 各組組長1142 學生生活關懷記錄表單發放與填寫","url":"https://app.notion.com/p/92cbbaa1983082b38b66810a7477fc27"},{"id":"a62bbaa1-9830-8362-a575-01cfceb28f14","date":"20260316","title":"20260316 1142訪視老師分配","url":"https://app.notion.com/p/a62bbaa198308362a57501cfceb28f14"},{"id":"544bbaa1-9830-83ac-833f-81476898ebad","date":"20260311","title":"20260311 缺曠記錄與獎懲名單","url":"https://app.notion.com/p/544bbaa1983083ac833f81476898ebad"},{"id":"d06bbaa1-9830-827f-ac91-818757d7604e","date":"20260309","title":"20260309 工讀異動訪視調查","url":"https://app.notion.com/p/d06bbaa19830827fac91818757d7604e"},{"id":"30fbbaa1-9830-8259-9dd0-0171e8db6990","date":"20260309","title":"20260309 訪視記錄表製作、組長特休","url":"https://app.notion.com/p/30fbbaa1983082599dd00171e8db6990"},{"id":"89cbbaa1-9830-83b0-b9d9-811ac0e90b17","date":"20260302","title":"20260302 切勿曠課提醒","url":"https://app.notion.com/p/89cbbaa1983083b0b9d9811ac0e90b17"},{"id":"6f8bbaa1-9830-83ec-98dc-0134f5af932f","date":"20260301","title":"20260301-20260227 填寫工讀與賃居異動","url":"https://app.notion.com/p/6f8bbaa1983083ec98dc0134f5af932f"},{"id":"175bbaa1-9830-8343-b345-01f4c265b0fb","date":"20260225","title":"20260225-2 學生證蓋章","url":"https://app.notion.com/p/175bbaa198308343b34501f4c265b0fb"},{"id":"2d1bbaa1-9830-8386-8dc6-016d82e2ca7b","date":"20260225","title":"20260225 城市科大SDGs行動挑戰賽","url":"https://app.notion.com/p/2d1bbaa1983083868dc6016d82e2ca7b"},{"id":"f29bbaa1-9830-83c0-833b-01dc277235bf","date":"20260223","title":"20260223班會","url":"https://app.notion.com/p/f29bbaa1983083c0833b01dc277235bf"},{"id":"821bbaa1-9830-820d-b069-01ae1bceb253","date":"20260222","title":"20260222-20260212-20260210 114-2第1次學雜費繳費狀況","url":"https://app.notion.com/p/821bbaa19830820db06901ae1bceb253"},{"id":"39abbaa1-9830-83d2-a01d-01ce70123d13","date":"20260107","title":"20260107更新: 20260105-2 申誡(114-1)名單與獎懲規定","url":"https://app.notion.com/p/39abbaa1983083d2a01d01ce70123d13"},{"id":"69fbbaa1-9830-820f-804c-81529167a39d","date":"20260105","title":"20260105-2 申誡(114-1)名單與獎懲規定","url":"https://app.notion.com/p/69fbbaa19830820f804c81529167a39d"},{"id":"56fbbaa1-9830-832e-a9d3-815fe470904a","date":"20251229","title":"20251229  班會","url":"https://app.notion.com/p/56fbbaa19830832ea9d3815fe470904a"},{"id":"efcbbaa1-9830-829c-b8b3-8111a5ac802b","date":"20251226","title":"20251226 轉學務處提醒：(Chuyển thông báo từ Văn phòng Công tác Sinh viên:)","url":"https://app.notion.com/p/efcbbaa19830829cb8b38111a5ac802b"},{"id":"098bbaa1-9830-825d-a83b-818148ee4b6d","date":"20251223","title":"20251223 校慶點名","url":"https://app.notion.com/p/098bbaa19830825da83b818148ee4b6d"},{"id":"f83bbaa1-9830-82cf-8e0c-816b7f66c22c","date":"20251222","title":"20251222 班會(校慶點名、期中考成績單未繳回申誡)","url":"https://app.notion.com/p/f83bbaa1983082cf8e0c816b7f66c22c"},{"id":"280bbaa1-9830-82a4-a4f9-81600bff9f4d","date":"20251212","title":"20251212 期中考成績單繳交統計","url":"https://app.notion.com/p/280bbaa1983082a4a4f981600bff9f4d"},{"id":"6c9bbaa1-9830-83f4-b87b-01c6b850b4f1","date":"20251211","title":"20251211 套軟課程、缺曠申誡、學雜費、訪視記錄表、大專新生學習適應問卷","url":"https://app.notion.com/p/6c9bbaa1983083f4b87b01c6b850b4f1"},{"id":"991bbaa1-9830-8268-b7b3-01efbc29bed5","date":"20251210","title":"20251210-2 學雜費待繳名單","url":"https://app.notion.com/p/991bbaa198308268b7b301efbc29bed5"},{"id":"be2bbaa1-9830-823e-a893-01c9a330473d","date":"20251210","title":"20251210 缺曠統計與申誡名單","url":"https://app.notion.com/p/be2bbaa19830823ea89301c9a330473d"},{"id":"61bbbaa1-9830-82e3-be11-01a0e5d288be","date":"20251208","title":"20251208-2 114學年度全國大專新生學習適應問卷調查","url":"https://app.notion.com/p/61bbbaa1983082e3be1101a0e5d288be"},{"id":"62fbbaa1-9830-820e-8420-8147b3cb7b8c","date":"20251208","title":"20251208 班會(期中考成績、追蹤訪視記錄表、 延遲學雜費)","url":"https://app.notion.com/p/62fbbaa19830820e84208147b3cb7b8c"},{"id":"7b8bbaa1-9830-8312-ab6d-011b39b4760d","date":"20251204","title":"20251204 繳交訪視記錄表、發送期中考成績單","url":"https://app.notion.com/p/7b8bbaa198308312ab6d011b39b4760d"},{"id":"8d9bbaa1-9830-83c3-bfc3-0150d74f8020","date":"20251203","title":"20251203-2 全校大掃除競賽榮獲大範圍組第二名簽請獎勵","url":"https://app.notion.com/p/8d9bbaa1983083c3bfc30150d74f8020"},{"id":"066bbaa1-9830-8350-a52b-0198cdf81a51","date":"20251203","title":"20251203 校務系統4.2.7項「導師輔導滿意度調查問卷」第2次追蹤確認表","url":"https://app.notion.com/p/066bbaa198308350a52b0198cdf81a51"},{"id":"eddbbaa1-9830-82ca-84b7-01699b9aa6dd","date":"20251202","title":"20251202 愛園住宿生參加住宿生座談會","url":"https://app.notion.com/p/eddbbaa1983082ca84b701699b9aa6dd"},{"id":"113bbaa1-9830-833c-b8e3-016148a6ef37","date":"20251201","title":"20251201 班會","url":"https://app.notion.com/p/113bbaa19830833cb8e3016148a6ef37"},{"id":"106bbaa1-9830-83e5-b583-813a27860855","date":"20251127","title":"20251127 (請假注意事項：通知組長、需附件、長假分次請、教學評量、訪視記錄表)","url":"https://app.notion.com/p/106bbaa1983083e5b583813a27860855"},{"id":"df2bbaa1-9830-82a9-9493-01249088a10e","date":"20251124","title":"20251124-2 (訪視記錄表尚未繳交名單)","url":"https://app.notion.com/p/df2bbaa1983082a9949301249088a10e"},{"id":"e07bbaa1-9830-82f6-be6b-813dae169657","date":"20251124","title":"20251124 班會","url":"https://app.notion.com/p/e07bbaa1983082f6be6b813dae169657"},{"id":"436bbaa1-9830-8312-980b-01f300055700","date":"20251117","title":"20251117 班會","url":"https://app.notion.com/p/436bbaa198308312980b01f300055700"},{"id":"8b8bbaa1-9830-83ec-9905-01899ca1177a","date":"20251113","title":"20251113 (提前通知)訪視表繳交、清潔競賽及補考等事宜((Thông báo trước) Về việc nộp Bảng theo dõi thăm kiểm tra, cuộc thi vệ sinh và thi bổ sung)","url":"https://app.notion.com/p/8b8bbaa1983083ec990501899ca1177a"},{"id":"c60bbaa1-9830-82cb-b77a-012bdba8eb91","date":"20251110","title":"20251110-3 填寫工讀或(與)賃居記錄表無法繳交原因","url":"https://app.notion.com/p/c60bbaa1983082cbb77a012bdba8eb91"},{"id":"30ebbaa1-9830-8296-b262-01b00cc87c14","date":"20251110","title":"20251110-2 SDGs攝影人氣競賽投票(Bình chọn cuộc thi ảnh SDGs phổ biến)","url":"https://app.notion.com/p/30ebbaa198308296b26201b00cc87c14"},{"id":"600bbaa1-9830-8332-a04f-816ca7624add","date":"20251110","title":"20251110 班會(點名、催繳訪視記錄表、公佈各組打掃區域)","url":"https://app.notion.com/p/600bbaa198308332a04f816ca7624add"},{"id":"eaabbaa1-9830-8336-864a-01f1c0b488fb","date":"20251105","title":"20251105 分配114-1期中全校大掃除競賽任務","url":"https://app.notion.com/p/eaabbaa198308336864a01f1c0b488fb"},{"id":"f43bbaa1-9830-83a0-8652-810ededc881a","date":"20251103","title":"20251103 班會 (繳交新版訪視記錄表、逾20節曠課警告、114-1行事曆)","url":"https://app.notion.com/p/f43bbaa1983083a08652810ededc881a"},{"id":"1c5bbaa1-9830-8311-a27e-814d14013120","date":"20251030","title":"20251030 (截至今日10/30 12:00為止尚未繳交訪視記錄表的同學請一律改用新版本記錄表)","url":"https://app.notion.com/p/1c5bbaa198308311a27e814d14013120"},{"id":"2e6bbaa1-9830-827b-bcf2-0188fd9a1e9a","date":"20251031","title":"20251031缺勤統計表超過20節將祭出警告","url":"https://app.notion.com/p/2e6bbaa19830827bbcf20188fd9a1e9a"},{"id":"efbbbaa1-9830-839c-a8f3-01e1cd3f4f9e","date":"20251027","title":"20251027班會(繳交工讀、賃居訪視記錄表紙本、工讀注意)","url":"https://app.notion.com/p/efbbbaa19830839ca8f301e1cd3f4f9e"},{"id":"b9abbaa1-9830-8337-8c38-019f6e81862f","date":"20251023","title":"20251023 (組長建群、宣導請假流程與自動核准的要點)","url":"https://app.notion.com/p/b9abbaa1983083378c38019f6e81862f"},{"id":"0b5bbaa1-9830-8308-a8b1-8177c758efdf","date":"20251021","title":"20251021 第1批工讀、賃居訪視記錄表列印簽名名單","url":"https://app.notion.com/p/0b5bbaa198308308a8b18177c758efdf"},{"id":"928bbaa1-9830-83ba-b144-8137968799f9","date":"20251020","title":"20251020班會(缺曠預警、訪視記錄表重填)","url":"https://app.notion.com/p/928bbaa1983083bab1448137968799f9"},{"id":"e21bbaa1-9830-8350-9369-01d82262aa14","date":"20251017","title":"20251017訪視記錄表「更新版本」填寫通告(訪視進度檢查、訪視彙整表網址)","url":"https://app.notion.com/p/e21bbaa198308350936901d82262aa14"},{"id":"de4bbaa1-9830-834f-8333-01ff875cb0ad","date":"20251013","title":"20251013 班會(檢查生活輔導記錄表填寫狀況、訪視照片上傳)","url":"https://app.notion.com/p/de4bbaa19830834f833301ff875cb0ad"},{"id":"b73bbaa1-9830-83f4-a055-01d441edb276","date":"20251008","title":"20251008-2 請假規則說明","url":"https://app.notion.com/p/b73bbaa1983083f4a05501d441edb276"},{"id":"fe5bbaa1-9830-8368-a0f4-811d1a63bcd5","date":"20251008","title":"20251008 114-1生活輔導記錄表單第2次要求填寫公告","url":"https://app.notion.com/p/fe5bbaa198308368a0f4811d1a63bcd5"},{"id":"b2ebbaa1-9830-82b7-99b7-01f7be59d793","date":"20251002","title":"20251002班會(SDGs前測與競賽、生活輔導紀錄)","url":"https://app.notion.com/p/b2ebbaa1983082b799b701f7be59d793"},{"id":"570bbaa1-9830-83a1-8eb6-81e697d043c7","date":"20250926","title":"城市科大國際生SDGs之多元文化攝影競賽(20250926發佈)","url":"https://app.notion.com/p/570bbaa1983083a18eb681e697d043c7"},{"id":"4c1bbaa1-9830-82ea-95ea-81f4e37a8b49","date":"20250922","title":"20250922班會(Họp lớp ngày 22/09/2025)(訪視照片資料夾建立與上傳)","url":"https://app.notion.com/p/4c1bbaa1983082ea95ea81f4e37a8b49"},{"id":"ab2bbaa1-9830-8347-a5d6-81340ac85fea","date":"","title":"1141訪視老師分配表(含雲端資料夾連結)","url":"https://app.notion.com/p/ab2bbaa198308347a5d681340ac85fea"},{"id":"607bbaa1-9830-82f6-999a-01bb2eaae579","date":"20250915","title":"(20250915班會)(Họp lớp ngày 15/09/2025)","url":"https://app.notion.com/p/607bbaa1983082f6999a01bb2eaae579"},{"id":"d4cbbaa1-9830-82e8-a2ed-81b8c15eb90e","date":"20250908","title":"(20250908班會) (Họp lớp ngày 08/09/2025)","url":"https://app.notion.com/p/d4cbbaa1983082e8a2ed81b8c15eb90e"}];

function extractBulletinDate(title) {
  const m = String(title || '').match(/(\d{8})/);
  return m ? m[1] : '';
}

function noticeBlock(c) {
  const items = (state.bulletin && state.bulletin.length) ? state.bulletin : INITIAL_BULLETIN_PAGES;
  const pageSize = Number(state.bulletinPageSize) > 0 ? Number(state.bulletinPageSize) : 10;
  const totalItems = items.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  if (bulletinPage > totalPages) bulletinPage = totalPages;
  if (bulletinPage < 1) bulletinPage = 1;
  const startIndex = (bulletinPage - 1) * pageSize;
  const pageItems = items.slice(startIndex, startIndex + pageSize);

  const paginationHtml = totalPages > 1 ? `
    <div class="leaderboard-pagination bulletin-pagination" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.5rem;padding:0.6rem 0.25rem 0.15rem;border-top:1px solid #fef3c7;margin-top:0.6rem;">
      <div style="font-size:0.8rem;color:#92400e;">
        第 <b>${startIndex + 1} - ${Math.min(startIndex + pageSize, totalItems)}</b> 筆 / 共 <b>${totalItems}</b> 筆（第 <b>${bulletinPage} / ${totalPages}</b> 頁）
        <br><small class="vn-sub">Từ ${startIndex + 1} đến ${Math.min(startIndex + pageSize, totalItems)} / Tổng ${totalItems} (Trang ${bulletinPage}/${totalPages})</small>
      </div>
      <div style="display:flex;align-items:center;gap:0.3rem;flex-wrap:wrap;">
        <button class="pagination-btn" type="button" data-act="set-bulletin-page" data-page="${bulletinPage - 1}" ${bulletinPage <= 1 ? 'disabled style="opacity:0.4;cursor:not-allowed;"' : ''}>
          ◀ 上一頁<br><small class="vn-sub">Trang trước</small>
        </button>
        ${Array.from({ length: totalPages }, (_, idx) => idx + 1).map(p => `
          <button class="pagination-page-btn ${p === bulletinPage ? 'active' : ''}" type="button" data-act="set-bulletin-page" data-page="${p}" style="${p === bulletinPage ? 'font-weight:750;background:#d97706;color:#fff;border-color:#d97706;' : ''}">
            ${p}
          </button>
        `).join('')}
        <button class="pagination-btn" type="button" data-act="set-bulletin-page" data-page="${bulletinPage + 1}" ${bulletinPage >= totalPages ? 'disabled style="opacity:0.4;cursor:not-allowed;"' : ''}>
          下一頁 ▶<br><small class="vn-sub">Trang sau</small>
        </button>
      </div>
    </div>` : '';

  return `
  <section class="block-section notice-block-section" id="notice-block">
    <div class="block-identifier-tag">
      <span class="block-tag-code">[Block B]</span>
      <span class="block-tag-name">公佈欄<br><small class="vn-sub">Bảng thông báo</small></span>
    </div>
    <div class="notice-bulletin-bar">
      <div class="bulletin-bar-header">
        <div style="display:flex;align-items:center;gap:0.45rem;">
          <span class="bulletin-bell-icon">📢</span>
          <strong>公佈欄<small class="vn-sub" style="color:#64748b;">Bảng thông báo</small></strong>
        </div>
        <div style="display:flex;align-items:center;gap:0.6rem;font-size:0.8rem;">
          <a href="https://app.notion.com/p/113-_-975bbaa19830833e955701873b3181e5" target="_blank" rel="noopener noreferrer" class="bulletin-notion-source-link">
            🔗 前往 Notion 班務公告<br><small class="vn-sub" style="color:#0284c7;">Xem bảng thông báo lớp trên Notion</small>
          </a>
        </div>
      </div>
      <div class="bulletin-bar-content">
        <ul class="bulletin-item-list">
          ${pageItems.map(item => {
            const dateStr = item.date || extractBulletinDate(item.title);
            const url = item.url || (item.id ? `https://app.notion.com/p/${item.id.replace(/-/g, '')}` : '#');
            return `
              <li class="bulletin-item-row">
                ${dateStr ? `<span class="bulletin-date-badge">${esc(dateStr)}</span>` : '<span class="bulletin-date-badge bulletin-date-empty">-</span>'}
                <a class="bulletin-item-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer" title="${esc(item.title)}">
                  <span class="bulletin-item-title-text">${esc(item.title)}</span>
                  <span class="bulletin-ext-icon" aria-hidden="true">↗</span>
                </a>
              </li>`;
          }).join('')}
        </ul>
      </div>
      ${paginationHtml}
    </div>
  </section>`;
}

/* ---- 核心監控卡片：未完成問卷名單（前 15 筆分頁切換，學號升冪排序） ---- */
function renderUncompletedSurveysCard(c0, b) {
  if (!c0 || !b || b.visible === false) return '';
  const c = careView(c0, b);
  let pg = publicSurveyUncompletedPages[b.id] || 1;
  const stats = getSurveyStats(c);
  const status = getSurveyStatus(c);
  const uncompletedAll = stats.uncompletedList || [];

  const pageSize = 15;
  const totalPages = Math.max(1, Math.ceil(uncompletedAll.length / pageSize));
  if (pg > totalPages) pg = totalPages;
  if (pg < 1) pg = 1;
  publicSurveyUncompletedPages[b.id] = pg;
  const startIndex = (pg - 1) * pageSize;
  const uncompleted = uncompletedAll.slice(startIndex, startIndex + pageSize);

  const paginationHtml = uncompletedAll.length > pageSize ? `
    <div class="leaderboard-pagination" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.5rem;padding:0.6rem 0.25rem 0.15rem;border-top:1px solid #f1f5f9;margin-top:0.5rem;">
      <div style="font-size:0.8rem;color:#64748b;">
        第 <b>${startIndex + 1} - ${Math.min(startIndex + pageSize, uncompletedAll.length)}</b> 位 / 共 <b>${uncompletedAll.length}</b> 位（第 <b>${pg} / ${totalPages}</b> 頁）
        <br><small class="vn-sub">Từ ${startIndex + 1} đến ${Math.min(startIndex + pageSize, uncompletedAll.length)} / Tổng ${uncompletedAll.length} (Trang ${pg}/${totalPages})</small>
      </div>
      <div style="display:flex;align-items:center;gap:0.3rem;flex-wrap:wrap;">
        <button class="pagination-btn" data-act="set-public-survey-page" data-bid="${esc(b.id)}" data-page="${pg - 1}" ${pg <= 1 ? 'disabled style="opacity:0.4;cursor:not-allowed;"' : ''}>
          ◀ 上一頁<br><small class="vn-sub">Trang trước</small>
        </button>
        ${Array.from({ length: totalPages }, (_, idx) => idx + 1).map(p => `
          <button class="pagination-page-btn ${p === pg ? 'active' : ''}" data-act="set-public-survey-page" data-bid="${esc(b.id)}" data-page="${p}" style="${p === pg ? 'font-weight:750;background:#0d9488;color:#fff;border-color:#0d9488;' : ''}">
            ${p}
          </button>
        `).join('')}
        <button class="pagination-btn" data-act="set-public-survey-page" data-bid="${esc(b.id)}" data-page="${pg + 1}" ${pg >= totalPages ? 'disabled style="opacity:0.4;cursor:not-allowed;"' : ''}>
          下一頁 ▶<br><small class="vn-sub">Trang sau</small>
        </button>
      </div>
    </div>` : '';

  return `
  <div class="uncompleted-surveys-box">
    <div class="uncompleted-surveys-header">
      <div style="display:flex;align-items:center;gap:0.4rem;">
        <span style="font-size:1.15rem;">⏳</span>
        <div>
          <strong style="color:#0f766e;font-size:1.02rem;">${esc(careTitle(c))}－未完成名單</strong>
          <br><small class="vn-sub">Danh sách chưa hoàn thành khảo sát</small>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:0.4rem;">
        <span class="status-badge ${status.badgeClass}">${status.label}</span>
        <span style="font-size:0.78rem;color:#0f766e;font-weight:600;">📅 ${esc(status.timeDesc)}</span>
      </div>
    </div>

    <!-- 進度條 -->
    <div class="survey-card-progress-bar-wrap" style="background:#f0fdfa;border:1px solid #ccfbf1;border-radius:8px;padding:0.6rem 0.85rem;margin-bottom:0.75rem;">
      <div style="display:flex;justify-content:space-between;font-size:0.82rem;color:#0f766e;font-weight:600;margin-bottom:0.25rem;">
        <span>
          💌 生活關懷問卷進度：已完成 ${stats.completed} / ${stats.total} 人
          <br><small class="vn-sub">Tiến độ khảo sát: Đã hoàn thành ${stats.completed} / ${stats.total} người</small>
        </span>
        <span style="text-align:right;">
          ${stats.percent}% (${stats.uncompleted > 0 ? `待完成 ${stats.uncompleted} 人` : '全數完成'})
          <br><small class="vn-sub">${stats.uncompleted > 0 ? `Còn ${stats.uncompleted} người` : 'Hoàn thành tất cả'}</small>
        </span>
      </div>
      <div style="height:8px;background:#e2e8f0;border-radius:999px;overflow:hidden;margin-top:0.35rem;">
        <div style="width:${stats.percent}%;height:100%;background:#0d9488;border-radius:999px;transition:width 0.3s;"></div>
      </div>
    </div>

    ${uncompletedAll.length ? `
    <div class="table-wrap" style="margin:0;">
      <table class="roster" style="background:#fff;margin:0;font-size:0.86rem;">
        <thead>
          <tr>
            <th style="width:40px;">序號<br><small class="vn-sub">STT</small></th>
            <th>學號<br><small class="vn-sub">Mã SV</small></th>
            <th>姓名<br><small class="vn-sub">Họ tên</small></th>
            <th>組別<br><small class="vn-sub">Nhóm</small></th>
            <th>組長<br><small class="vn-sub">Trưởng nhóm</small></th>
            <th style="text-align:center;width:105px;">填寫問卷<br><small class="vn-sub">Điền phiếu</small></th>
          </tr>
        </thead>
        <tbody>
          ${uncompleted.map((st, i) => `
            <tr>
              <td><span style="color:#64748b;font-size:0.8rem;">${startIndex + i + 1}</span></td>
              <td>${esc(st.id)}</td>
              <td><b>${esc(st.name)}</b></td>
              <td><span class="group-name-tag" style="font-size:0.75rem;">${esc(st.groupName)}</span></td>
              <td>${st.rawLeaderName ? `<span style="color:#16a34a;font-weight:600;font-size:0.8rem;">${esc(st.leaderName)}</span>` : '<span style="color:#dc2626;font-size:0.8rem;">（無組長）</span><br><small class="vn-sub">Chưa có nhóm trưởng</small>'}</td>
              <td style="text-align:center;">
                <button class="btn btn-primary btn-xs" data-act="quick-survey-login" data-bid="${esc(b.id)}" data-name="${esc(st.name)}" data-id="${esc(st.id)}" style="padding:0.2rem 0.55rem;font-size:0.78rem;margin:0;">
                  ✍️ 填寫問卷<br><small class="vn-sub">Điền phiếu</small>
                </button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
    ${paginationHtml}
    <div style="padding:0.6rem 0.25rem 0.15rem;border-top:1px solid #f1f5f9;margin-top:0.5rem;">
      <span style="font-size:0.8rem;color:#64748b;">
        共 <b>${uncompletedAll.length}</b> 位同學尚未完成生活關懷問卷
        <br><small class="vn-sub">Tổng cộng có ${uncompletedAll.length} sinh viên chưa hoàn thành</small>
      </span>
    </div>
    ` : ''}
  </div>`;
}

/* ---- 儀表板：三大子系統入口捷徑卡片 ---- */
function renderSubsystemLauncherCards(c) {
  if (!c) return '';
  const stats = getSurveyStats(careCur(c));
  const assignedCount = c.students.filter(s => s.groupId).length;
  const unassignedCount = unassigned(c).length;

  return `
  <div class="subsystem-launcher-grid">
    <!-- 1. 學生分組系統 -->
    <div class="subsystem-launcher-card">
      <div>
        <div style="display:flex;align-items:center;gap:0.45rem;margin-bottom:0.35rem;">
          <span style="font-size:1.35rem;">👥</span>
          <div>
            <strong style="font-size:1.05rem;color:#1e3a8a;">分組子系統</strong>
            <br><small class="vn-sub">Hệ thống con chia nhóm</small>
          </div>
        </div>
        <div style="font-size:0.86rem;color:#334155;margin-bottom:0.75rem;line-height:1.5;">
          進度：<b>${assignedCount}</b> 人已分組 / <b>${unassignedCount}</b> 人待分組 · 共 <b>${c.groups.length}</b> 組<br>
          <span style="font-size:0.8rem;color:#64748b;">每組門檻 ${minCap(c)} ~ 上限 ${cap(c)} 人</span>
          <br><small class="vn-sub">Đã chia ${assignedCount} người / Còn ${unassignedCount} người chưa chia</small>
        </div>
      </div>
      <button class="btn btn-secondary btn-sm" data-act="nav-public-subview" data-view="groups" style="justify-content:center;font-weight:600;">
        進入分組子系統 ➔<br><small class="vn-sub">Vào hệ thống con chia nhóm</small>
      </button>
    </div>

    <!-- 2. 點名子系統 -->
    <div class="subsystem-launcher-card card-attendance" style="background:#fff7ed;border-color:#fed7aa;">
      <div>
        <div style="display:flex;align-items:center;gap:0.45rem;margin-bottom:0.35rem;">
          <span style="font-size:1.35rem;">📋</span>
          <div>
            <strong style="font-size:1.05rem;color:#c2410c;">點名子系統</strong>
            <br><small class="vn-sub">Hệ thống con điểm danh</small>
          </div>
        </div>
        <div style="font-size:0.86rem;color:#7c2d12;margin-bottom:0.75rem;line-height:1.5;">
          今日日常點名：<b>${todayDateStr()}</b> 開放中<br>
          <span style="font-size:0.8rem;color:#ea580c;">組長/副組長點名確認、出缺席排行追蹤</span>
          <br><small class="vn-sub">Điểm danh ngày hôm nay đang mở</small>
        </div>
      </div>
      <button class="btn btn-secondary btn-sm" data-act="nav-public-subview" data-view="attendance" style="justify-content:center;font-weight:600;background:#ffedd5;color:#9a3412;border-color:#fdba74;">
        進入點名子系統 ➔<br><small class="vn-sub">Vào hệ thống con điểm danh</small>
      </button>
    </div>

    <!-- 3. 生活關懷問卷系統 -->
    <div class="subsystem-launcher-card" style="border-color:#99f6e4;background:#f0fdfa;">
      <div>
        <div style="display:flex;align-items:center;gap:0.45rem;margin-bottom:0.35rem;">
          <span style="font-size:1.35rem;">💌</span>
          <div>
            <strong style="font-size:1.05rem;color:#0f766e;">問卷子系統</strong>
            <br><small class="vn-sub">Hệ thống con khảo sát</small>
          </div>
        </div>
        <div style="font-size:0.86rem;color:#134e4a;margin-bottom:0.75rem;line-height:1.5;">
          填寫進度：已完成 <b>${stats.percent}%</b>（${stats.completed}/${stats.total}人）<br>
          <span style="font-size:0.8rem;color:#0d9488;">全體學生線上填寫、修改歷程與未完成追蹤</span>
          <br><small class="vn-sub">Tiến độ điền: Đã hoàn thành ${stats.percent}%</small>
        </div>
      </div>
      <button class="btn btn-primary btn-sm" data-act="nav-public-subview" data-view="survey" style="justify-content:center;font-weight:600;">
        進入問卷子系統 ➔<br><small class="vn-sub">Vào hệ thống con khảo sát</small>
      </button>
    </div>
  </div>`;
}

/* ---- 預設中央主要顯示區域：首頁 ---- */
function renderPublicDashboard(c) {
  // 組長／副組長登入後只可看到自己小組的缺席排行榜，不得出現其他組成員
  const s = me();
  const myGroup = (s && (s.isLeader || s.isVice) && s.groupId) ? c.groups.find(x => x.id === s.groupId) : null;
  return `
  <div class="public-dashboard-content">
    <div class="block-identifier-tag">
      <span class="block-tag-code">[Block D]</span>
      <span class="block-tag-name">主要內容顯示區（首頁）<br><small class="vn-sub">Khu vực hiển thị nội dung chính (Trang chủ)</small></span>
    </div>

    <!-- 三大子系統入口捷徑卡片 -->
    ${renderSubsystemLauncherCards(c)}

    <!-- 中央核心即時監控：組員缺席排行榜 ＆ 未完成問卷名單 -->
    <div class="dashboard-monitoring-grid">
      <div class="monitoring-block monitoring-block-e">
      <div class="block-identifier-tag block-e"><span class="block-tag-code">[Block E]</span> <span class="block-tag-name">組員缺席排行榜</span></div>
      ${renderAbsenceLeaderboardCard(c, myGroup ? {
        title: `${myGroup.name} 組員缺席排行榜`,
        subTitle: 'Bảng xếp hạng vắng mặt của nhóm',
        filterMates: members(c, myGroup.id),
        scopeAct: 'public-attendance-stat-scope',
        currentScope: publicAttendanceStatScope,
        limit: 15,
        isPublicFlow: true
      } : {
        title: '組員缺席排行榜',
        subTitle: 'Bảng xếp hạng vắng mặt',
        scopeAct: 'public-attendance-stat-scope',
        currentScope: publicAttendanceStatScope,
        limit: 15,
        isPublicFlow: true
      })}
      </div>
      <div class="monitoring-block monitoring-block-f">
      <div class="block-identifier-tag block-f"><span class="block-tag-code">[Block F]</span> <span class="block-tag-name">生活關懷問卷調查－未完成名單（含缺曠輔導調查）</span></div>
      ${(() => { const l = surveyCardList(c, true); return l.filter(x => x.type === 'care').map(x => renderUncompletedSurveysCard(c, x.b)).concat(l.filter(x => x.type !== 'care').map(x => renderAbsenceUncompletedCard(c, x.sv))).join(''); })()}
      </div>
    </div>
  </div>`;
}

/* ---- 核心監控卡片：缺曠原因調查（各批次）未完成名單，標題隨問卷副標題變動 ---- */
function renderAbsenceUncompletedCard(c, sv) {
  const p = absenceProgress(sv);
  const rows = (sv.targets || []).filter(t => !t.done)
    .sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
  return `
  <div class="uncompleted-surveys-box">
    <div class="uncompleted-surveys-header">
      <div style="display:flex;align-items:center;gap:0.4rem;">
        <span style="font-size:1.15rem;">📝</span>
        <div>
          <strong style="color:#92400e;font-size:1.02rem;">${esc(absenceTitle(sv))}－未完成名單</strong>
          <br><small class="vn-sub">Danh sách chưa hoàn thành khảo sát lý do vắng mặt</small>
        </div>
      </div>
      <button class="btn btn-primary btn-xs" data-act="open-survey-card" data-key="abs:${esc(sv.id)}" style="margin:0;">進入問卷 ➔<br><small class="vn-sub">Vào phiếu</small></button>
    </div>
    <div style="font-size:0.84rem;color:#78350f;font-weight:600;margin-bottom:0.5rem;">需填寫 ${p.total} 位，已完成 ${p.done} 位（${p.percent}%）</div>
    ${rows.length ? `
    <div class="table-wrap" style="margin:0;max-height:320px;overflow-y:auto;">
      <table class="roster" style="background:#fff;margin:0;font-size:0.86rem;">
        <thead><tr><th>學號</th><th>姓名</th><th>組別</th><th>組長</th></tr></thead>
        <tbody>${rows.map(t => `<tr><td>${esc(t.id)}</td><td><b>${esc(t.name)}</b></td><td>${esc(t.groupName)}</td><td>${esc(t.leaderName)}</td></tr>`).join('')}</tbody>
      </table>
    </div>` : `
    <div style="text-align:center;padding:1.2rem 1rem;background:#f0fdf4;border-radius:8px;border:1px solid #bbf7d0;color:#166534;">
      ${p.total ? '🎉 本次名單同學皆已完成填寫！' : '老師尚未指定需填寫的學生。'}
    </div>`}
  </div>`;
}

/* ---- 期末組員貢獻度評分面板 (組長專屬) ---- */
function renderStudentPeerEvalPanel(c, g, s, mates) {
  if (!s || !s.isLeader || !g) return '';
  const maxB = Number(c && c.maxBonus) > 0 ? Number(c.maxBonus) : 10;
  const isEvalOpen = !!g.peerEvalOpen;
  const isSubmitted = !!g.peerEvalSubmitted;
  const isOverdue = isEvalOpen && evalDeadlinePassed(g) && !isSubmitted;
  const otherMembers = mates.filter(m => m.id !== s.id);

  return `
  <div class="leader-eval-panel" style="margin-top:1.5rem;padding:1.25rem;background:#f0fdf4;border:2px solid #bbf7d0;border-radius:10px;">
    <div class="panel-header" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.5rem;">
      <h3 style="margin:0;color:#166534;">📝 期末組員貢獻度評分<br><small class="vn-sub">Đánh giá đóng góp cuối kỳ</small></h3>
      ${isSubmitted
        ? '<span class="status-badge meets-threshold">✅ 您已完成評分提交<small class="vn-sub">Đã nộp</small></span>'
        : isOverdue
        ? '<span class="status-badge under-threshold">⚠️ 已超過評分截止時間（逾時懲罰生效）<small class="vn-sub">Đã quá hạn</small></span>'
        : isEvalOpen
        ? '<span class="status-badge can-edit">開放評分中<small class="vn-sub">Đang mở</small></span>'
        : '<span class="status-badge is-locked">老師尚未開放評分<small class="vn-sub">Chưa mở</small></span>'}
    </div>

    <div style="margin:0.75rem 0;font-size:0.88rem;color:#14532d;line-height:1.6;">
      <p style="margin:0 0 0.4rem 0;"><b>說明：</b>在老師開放評分期間，組長可依據組員之貢獻與配合程度給予<b>加分 (0 ~ ${maxB} 分)</b>。<br><small class="vn-sub">Trong thời gian mở đánh giá, nhóm trưởng cho điểm cộng từ 0 ~ ${maxB} điểm dựa trên đóng góp.</small></p>
      <p style="margin:0;color:#166534;font-weight:600;"><b>🎁 組長獎勵：</b>組長在老師開放評分權限時進行評分，<b>組長自己可獲得 ${maxB} 分的加分</b>！<br><small class="vn-sub">Thưởng nhóm trưởng: nộp đánh giá sẽ được cộng ngay +${maxB} điểm cuối kỳ!</small></p>
      ${g.peerEvalDeadline ? `<p style="margin:0.4rem 0 0 0;font-weight:600;">⏳ 本組評分截止時間：${esc(g.peerEvalDeadline.replace('T', ' '))}<br><small class="vn-sub">Hạn chót đánh giá</small></p>` : ''}
    </div>

    ${!isEvalOpen ? `
      <div style="padding:0.75rem;background:#fff;border-radius:6px;border:1px dashed #86efac;color:#4b5563;font-size:0.88rem;">
        授課老師尚未開放本組評分權限。待老師開放並公告評分截止時間後，您可在此進行評分。<br><small class="vn-sub">Giáo viên chưa mở quyền đánh giá cho nhóm này.</small>
      </div>` : isOverdue ? `
      <div style="padding:0.75rem;background:#fef2f2;border-radius:6px;border:1px solid #fecaca;color:#991b1b;font-size:0.88rem;">
        已超過老師規定的評分截止時間，組長評分權限已關閉。因未在時限內進行評分，組長無法獲得 ${maxB} 分加分，組員亦無法獲得加分。<br><small class="vn-sub">Đã quá hạn đánh giá, quyền đánh giá của nhóm trưởng đã bị đóng.</small>
      </div>` : !otherMembers.length ? `
      <div style="padding:0.75rem;background:#fff;border-radius:6px;border:1px dashed #86efac;color:#4b5563;font-size:0.88rem;">
        目前組內尚無其他成員。您可直接送出評分以獲得組長專屬的 ${maxB} 分加分：<br><small class="vn-sub">Không có thành viên khác, bấm để nhận điểm cộng nhóm trưởng:</small>
        <form data-act="submit-peer-eval" style="margin-top:0.6rem;">
          <button class="btn btn-primary" type="submit" style="padding:0.45rem 1.2rem;">確認並領取組長 ${maxB} 分加分<br><small class="vn-sub">Nhận ${maxB} điểm cộng</small></button>
        </form>
      </div>` : `
      <form data-act="submit-peer-eval" style="margin-top:1rem;">
        <div class="table-wrap">
          <table class="roster" style="background:#fff;">
            <thead>
              <tr>
                <th>組員姓名（學號）<br><small class="vn-sub">Họ tên &amp; Mã SV</small></th>
                <th>角色<br><small class="vn-sub">Vai trò</small></th>
                <th>期末考加分（0 ~ ${maxB} 分）<br><small class="vn-sub">Điểm cộng</small></th>
                <th>加分原因／貢獻說明（選填）<br><small class="vn-sub">Ghi chú đóng góp, có thể để trống</small></th>
              </tr>
            </thead>
            <tbody>
              ${otherMembers.map(m => {
                let options = `<option value="0" ${m.peerPenalty === 0 ? 'selected' : ''}>+0 分（無額外加分 / Không cộng thêm）</option>`;
                for (let i = 1; i <= maxB; i++) {
                  const extra = (i === maxB) ? '（表現優異 上限 / Xuất sắc）' : '';
                  options += `<option value="${i}" ${m.peerPenalty === i ? 'selected' : ''}>+${i} 分（+${i} điểm）${extra}</option>`;
                }
                return `
                <tr>
                  <td><b>${esc(m.name)}</b> (${esc(m.id)})</td>
                  <td>${m.isVice ? '<span class="tag-inline">副組長<small class="vn-sub">Phó nhóm</small></span>' : '組員<small class="vn-sub">Thành viên</small>'}</td>
                  <td>
                    <select name="penalty_${esc(keyOf(m))}" style="padding:0.35rem 0.5rem;font-size:0.9rem;border:1.5px solid #cbd5e1;border-radius:4px;" ${isSubmitted ? 'disabled' : ''}>
                      ${options}
                    </select>
                  </td>
                  <td>
                    <input type="text" name="comment_${esc(keyOf(m))}" value="${esc(m.peerComment || '')}" placeholder="若有加分可填寫貢獻事蹟 / Ghi chú đóng góp" style="width:100%;max-width:260px;padding:0.35rem 0.5rem;font-size:0.85rem;" ${isSubmitted ? 'disabled' : ''}>
                  </td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
        <div style="margin-top:0.85rem;display:flex;align-items:center;gap:0.75rem;">
          ${isSubmitted ? `
            <span style="color:#166534;font-weight:600;font-size:0.9rem;">✅ 評分已送出完成（您已獲得組長 ${maxB} 分加分）。如需調整請直接修改並重新送出：<br><small class="vn-sub">Đã nộp đánh giá (đã nhận ${maxB} điểm). Có thể sửa và nộp lại:</small></span>
            <button class="btn btn-primary" type="submit" style="padding:0.45rem 1.1rem;font-size:0.9rem;">🔄 重新更新評分<br><small class="vn-sub">Cập nhật đánh giá</small></button>
          ` : `
            <button class="btn btn-primary" type="submit" style="padding:0.5rem 1.4rem;font-size:0.95rem;">📤 送出評分（組長即獲 +${maxB} 分）<br><small class="vn-sub">Nộp đánh giá (nhóm trưởng +${maxB} điểm)</small></button>
            <span style="font-size:0.82rem;color:#64748b;">提交後組長自身立即獲得 ${maxB} 分加分，截止前仍可重複調整。<br><small class="vn-sub">Sau khi nộp nhóm trưởng được cộng ${maxB} điểm, trước hạn chót vẫn có thể điều chỉnh.</small></span>
          `}
        </div>
      </form>`}
  </div>`;
}

/* ---- 學生分組系統子頁面 ---- */
function renderPublicGroupsSection(c) {
  const s = me();
  const isLeaderOrVice = s && (s.isLeader || s.isVice);
  const g = (s && s.groupId) ? c.groups.find(x => x.id === s.groupId) : null;
  const mates = g ? members(c, g.id) : [];
  const closed = deadlinePassed(c);
  const canEdit = canGroupLeaderEdit(c, g);

  let leaderToolsHtml = '';
  if (isLeaderOrVice && g) {
    const min = minCap(c);
    const max = cap(c);
    const needed = Math.max(0, min - mates.length);
    const excess = Math.max(0, mates.length - max);
    const isBelowMin = mates.length < min;
    const isAboveMax = mates.length > max;
    const canDrop = canEdit && (mates.length > min);
    const canPick = canEdit && (mates.length < max);

    leaderToolsHtml = `
    <div class="leader-management-section" style="margin-bottom:1.5rem;">
      ${closed && !canEdit ? `
        <div class="deadline-alert locked">
          <span class="alert-icon">⏳</span>
          <div>
            <strong>已超過分組截止時間，組員名單已鎖定<br><small class="vn-sub">Đã hết hạn chia nhóm, danh sách thành viên đã khóa</small></strong>
            <p>目前分組截止時間已過，組長或副組長無法更換組員。如需更換請聯絡老師開放調整權限。<br><small class="vn-sub">Hiện đã hết hạn, không thể đổi thành viên. Vui lòng liên hệ giáo viên để xin cấp quyền điều chỉnh.</small></p>
          </div>
        </div>
      ` : closed && canEdit ? `
        <div class="deadline-alert unlocked">
          <span class="alert-icon">🔓</span>
          <div>
            <strong>老師已重新開放本科目本組挑選權限<br><small class="vn-sub">Giáo viên đã mở lại quyền chọn thành viên cho nhóm</small></strong>
            <p>您現在可以更換組員或調整副組長。${(g && g.editDeadline) ? `<b style="color:#92400e;">截止時間為：${esc(g.editDeadline.replace('T', ' '))}</b>` : ''}<br><small class="vn-sub">Bạn hiện có thể thay đổi thành viên hoặc đặt nhóm phó.</small></p>
          </div>
        </div>
      ` : ''}

      <!-- 已挑選成員面板 -->
      <div class="selected-members-panel">
        <div class="panel-header">
          <h3 style="margin:0">本組已挑選成員（下限 ${min} 人，上限 ${max} 人，目前 ${mates.length} 人）<br><small class="vn-sub">Thành viên đã chọn trong nhóm (Tối thiểu ${min}, Tối đa ${max}, Hiện có ${mates.length})</small></h3>
          <div class="header-badges">
            ${isBelowMin
              ? `<span class="status-badge under-threshold">⚠️ 低於下限（缺 ${needed} 人）<br><small class="vn-sub">Dưới mức tối thiểu (Thiếu ${needed} người)</small></span>`
              : isAboveMax
              ? `<span class="status-badge under-threshold" style="background:#fef2f2;color:#991b1b;">⚠️ 高於上限（多 ${excess} 人）<br><small class="vn-sub">Vượt quá tối đa (Thừa ${excess} người)</small></span>`
              : `<span class="status-badge meets-threshold">✅ 人數合規（${mates.length}人，符合 ${min}~${max} 人）<br><small class="vn-sub">Hợp lệ (${mates.length} người)</small></span>`}
            ${canEdit ? '<span class="status-badge can-edit">組長/副組長調整中<br><small class="vn-sub">Đang điều chỉnh</small></span>' : '<span class="status-badge is-locked">已鎖定<br><small class="vn-sub">Đã khóa</small></span>'}
          </div>
        </div>
        ${isBelowMin ? `
          <div class="threshold-notice">
            <strong>⚠️ 本組現有成員數（${mates.length} 人）低於分組下限（${min} 人）</strong>
            <p>依規則：此時只能新增組員，請從未分配名單挑選至少 ${needed} 位組員加入。<br><small class="vn-sub">Theo quy định: lúc này chỉ có thể thêm thành viên, vui lòng chọn ít nhất ${needed} người từ danh sách chưa chia nhóm.</small></p>
          </div>` : ''}
        ${isAboveMax ? `
          <div class="threshold-notice" style="background:#fff1f2;color:#9f1239;">
            <strong>⚠️ 本組現有成員數（${mates.length} 人）高於分組上限（${max} 人）</strong>
            <p>依規則：此時只能刪減組員，需將至少 ${excess} 位成員移出釋出至未分配名單中。<br><small class="vn-sub">Theo quy định: lúc này chỉ có thể loại bớt thành viên, cần đưa ít nhất ${excess} người về danh sách chưa chia nhóm.</small></p>
          </div>` : ''}
        <div class="pick-list" style="margin-top:0.75rem">${mates.map(m => `
          <div class="student ${m.isLeader ? 'leader' : ''} ${m.isVice ? 'vice-leader' : ''}">
            <span class="student-name-tag">
              ${esc(m.name)} (${esc(m.id)})${m.isLeader ? ' — ⭐組長<small class="vn-sub">Trưởng nhóm</small>' : m.isVice ? ' — 🛡️副組長<small class="vn-sub">Phó nhóm</small>' : ''}${m.autoAssigned ? ' <span class="tag-inline auto">自動<small class="vn-sub">Tự động</small></span>' : ''}
            </span>
            ${(canEdit && m.id !== s.id && !m.isLeader) ? `
              ${s.isLeader ? `
                <button class="tab-btn ${m.isVice ? 'on' : ''}" data-act="toggle-vice" data-id="${esc(keyOf(m))}">
                  ${m.isVice ? '取消副組長<br><small class="vn-sub">Hủy phó nhóm</small>' : '設為副組長<br><small class="vn-sub">Đặt làm phó nhóm</small>'}</button>
              ` : ''}
              ${canDrop ? `
                <button class="tab-btn" data-act="drop" data-id="${esc(keyOf(m))}" title="移出組員">移出釋出<br><small class="vn-sub">Loại khỏi nhóm</small></button>
              ` : `
                <button class="tab-btn disabled" disabled title="人數已達下限無法移出" style="opacity:0.5;cursor:not-allowed;">不可移出<br><small class="vn-sub">Không thể loại</small></button>
              `}` : ''}
          </div>`).join('')}</div>
      </div>

      <!-- 挑選組員面板 -->
      ${canEdit ? `
        <div class="pick-members-panel" style="margin-top:1.25rem">
          <div class="panel-header">
            <h3 style="margin:0">挑選組員（從未分配名單新增）<br><small class="vn-sub">Chọn thành viên (Thêm từ danh sách chưa chia nhóm)</small></h3>
            ${!canPick ? `<span class="badge-full" style="background:#fee2e2;color:#991b1b;border:1px solid #fca5a5;">已達上限無法再新增<br><small class="vn-sub">Đã đủ số lượng tối đa</small></span>` : ''}
          </div>
          <div class="pick-list" style="margin-top:0.75rem">${unassigned(c).length ? unassigned(c).map(p => `
            <label class="student ${!canPick ? 'disabled' : ''}">
              <input type="checkbox" data-act="pick" data-id="${esc(keyOf(p))}" ${!canPick ? 'disabled' : ''}>
              ${esc(p.name)} (${esc(p.id)})
            </label>`).join('') : '<p class="file-path">目前沒有未分配的成員名單。<br><small class="vn-sub">Hiện không có sinh viên chưa chia nhóm.</small></p>'}</div>
        </div>` : ''}

      <!-- 期末組長評分面板 (僅組長) -->
      ${s.isLeader ? renderStudentPeerEvalPanel(c, g, s, mates) : ''}
    </div>`;
  }

  return `
  <div class="groups-subsystem-page">
    <div class="block-identifier-tag">
      <span class="block-tag-code">[Block D]</span>
      <span class="block-tag-name">主要內容顯示區（分組子系統）<br><small class="vn-sub">Khu vực hiển thị nội dung chính (Hệ thống con chia nhóm)</small></span>
    </div>

    <div class="subsystem-header-bar">
      ${subsystemBackBtn()}
      <div class="subsystem-title-tag">
        <span class="subsystem-icon">👥</span>
        <div>
          <strong>分組子系統</strong>
          <br><small class="vn-sub">Hệ thống con chia nhóm</small>
        </div>
      </div>
      ${s ? `
        <span style="font-size:0.85rem;background:#f0fdf4;color:#166534;border:1px solid #bbf7d0;padding:0.25rem 0.65rem;border-radius:6px;font-weight:600;">
          🎓 學生：${esc(s.name)} (${esc(s.id)})
          <br><small class="vn-sub">Sinh viên: ${esc(s.name)}</small>
        </span>
      ` : ''}
    </div>

    <!-- 僅在點選分組時顯示分組使用方式 -->
    ${howto()}

    <!-- 組長或副組長管理工具 -->
    ${leaderToolsHtml}

    <!-- 分組現況與未分組名單 -->
    ${publicBoard()}

    <div class="subsystem-footer">${subsystemBackBtn()}</div>
  </div>`;
}

/* ---- 點名子系統子頁面 ---- */
function renderPublicAttendanceSection(c) {
  const s = me();
  const isLeaderOrVice = s && (s.isLeader || s.isVice);
  const g = (s && s.groupId) ? c.groups.find(x => x.id === s.groupId) : null;
  const mates = g ? members(c, g.id) : [];

  return `
  <div class="attendance-standalone-page">
    <div class="block-identifier-tag">
      <span class="block-tag-code">[Block D]</span>
      <span class="block-tag-name">主要內容顯示區（點名子系統）<br><small class="vn-sub">Khu vực hiển thị nội dung chính (Hệ thống con điểm danh)</small></span>
    </div>

    <div class="subsystem-header-bar">
      ${subsystemBackBtn()}
      <div class="subsystem-title-tag">
        <span class="subsystem-icon">📋</span>
        <div>
          <strong>點名子系統</strong>
          <br><small class="vn-sub">Hệ thống con điểm danh</small>
        </div>
      </div>
      ${s ? `
        <span style="font-size:0.85rem;background:#f0fdf4;color:#166534;border:1px solid #bbf7d0;padding:0.25rem 0.65rem;border-radius:6px;font-weight:600;">
          🎓 學生：${esc(s.name)} (${esc(s.id)})
          <br><small class="vn-sub">Sinh viên: ${esc(s.name)}</small>
        </span>
      ` : ''}
    </div>

    ${isLeaderOrVice && g ? `
      <!-- 組長或副組長專用今日點名介面 -->
      ${attendanceLeaderPanel(c, g, s, mates)}
      ${(c.attendanceDelegates || []).map(del => attendanceDelegatePanel(c, del)).join('')}
    ` : `
      <!-- 一般點名概況與提示 -->
      <div style="background:#ffffff;border:1px solid #cbd5e1;border-radius:10px;padding:1.25rem;margin-bottom:1.25rem;">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.5rem;margin-bottom:0.75rem;">
          <h3 style="margin:0;font-size:1.1rem;color:#1e3a8a;display:flex;align-items:center;gap:0.4rem;">
            <span>📅</span> <span>今日點名現況<small class="vn-sub">Tình trạng điểm danh hôm nay</small></span>
          </h3>
          <span class="status-badge" style="background:#dbeafe;color:#1d4ed8;border:1px solid #bfdbfe;">
            日期：${todayDateStr()}<br><small class="vn-sub">Ngày</small>
          </span>
        </div>
        <p class="file-path" style="margin:0 0 0.85rem;">
          各組日常點名由各組<b>組長或副組長</b>負責逐一確認組員出席與缺席。<br>
          <small class="vn-sub">Điểm danh hàng ngày do nhóm trưởng hoặc nhóm phó phụ trách kiểm tra.</small>
        </p>
        ${!s ? `
          <div style="padding:0.85rem 1rem;background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.5rem;">
            <span style="font-size:0.88rem;color:#1e40af;">
              💡 擔任組長或副組長之同學，請登入以進行今日點名：
              <br><small class="vn-sub">Sinh viên là nhóm trưởng hoặc nhóm phó vui lòng đăng nhập để điểm danh:</small>
            </span>
            <button class="btn btn-primary btn-sm" data-act="open-leader-login" style="padding:0.35rem 0.95rem;">
              🎓 組長/副組長點名登入<br><small class="vn-sub">Đăng nhập điểm danh</small>
            </button>
          </div>
          ${loginMode === 'student' ? loginCard('attendance') : ''}
        ` : ''}
      </div>
    `}

    <!-- 全班缺席排行榜：組長／副組長已在上方看到自己小組的排行榜，此處不再重複顯示全班名單 -->
    ${isLeaderOrVice && g ? '' : renderAbsenceLeaderboardCard(c, {
      title: '組員缺席排行榜',
      subTitle: 'Bảng xếp hạng vắng mặt',
      scopeAct: 'public-attendance-stat-scope',
      currentScope: publicAttendanceStatScope,
      limit: 15,
      isPublicFlow: true
    })}

    <div class="subsystem-footer">${subsystemBackBtn()}</div>
  </div>`;
}

/* ---- 規劃中問卷展示區塊 ---- */
function renderUpcomingSurveysBox() {
  return `
  <div class="upcoming-surveys-container" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:1.15rem 1.25rem;margin-top:1rem;">
    <div style="display:flex;align-items:center;gap:0.4rem;margin-bottom:0.75rem;">
      <span style="font-size:1.2rem;">📁</span>
      <strong style="color:#475569;font-size:0.95rem;">未來規劃問卷<br><small class="vn-sub">Kế hoạch khảo sát sắp tới</small></strong>
      <span class="status-badge" style="background:#f1f5f9;color:#64748b;font-size:0.75rem;">敬請期待<br><small class="vn-sub">Sắp ra mắt</small></span>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(280px, 1fr));gap:0.85rem;">
      <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:0.85rem 1rem;opacity:0.85;">
        <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.25rem;">
          <span style="font-size:1.25rem;">💳</span>
          <b style="font-size:0.92rem;color:#1e293b;">學雜費一次繳交意願調查</b>
          <span class="node-status-pill upcoming" style="margin-left:auto;">即將推出<br><small class="vn-sub">Sắp ra mắt</small></span>
        </div>
        <p style="margin:0;font-size:0.8rem;color:#64748b;">Khảo sát ý định nộp học phí 1 lần</p>
      </div>
      <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:0.85rem 1rem;opacity:0.85;">
        <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.25rem;">
          <span style="font-size:1.25rem;">📑</span>
          <b style="font-size:0.92rem;color:#1e293b;">學雜費分期繳交狀況調查</b>
          <span class="node-status-pill upcoming" style="margin-left:auto;">即將推出<br><small class="vn-sub">Sắp ra mắt</small></span>
        </div>
        <p style="margin:0;font-size:0.8rem;color:#64748b;">Khảo sát tình trạng trả góp học phí</p>
      </div>
    </div>
  </div>`;
}

/* ---- 獨立問卷頁面：未登入時的專屬登入與說明 ---- */
function renderSurveyStandaloneLogin(c) {
  const status = getSurveyStatus(c);
  return `
  <div class="survey-standalone-page">
    <div class="block-identifier-tag">
      <span class="block-tag-code">[Block D]</span>
      <span class="block-tag-name">主要內容顯示區（問卷子系統）<br><small class="vn-sub">Khu vực hiển thị nội dung chính (Hệ thống con khảo sát)</small></span>
    </div>

    <div class="subsystem-header-bar">
      ${subsystemBackBtn()}
      <div class="subsystem-title-tag">
        <span class="subsystem-icon">💌</span>
        <div>
          <strong>問卷子系統</strong>
          <br><small class="vn-sub">Hệ thống con khảo sát</small>
        </div>
      </div>
    </div>

    <div class="survey-login-layout">
      <!-- 左欄：生活關懷問卷說明 -->
      <div class="survey-intro-card">
        <div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:1rem;">
          <span style="font-size:2.5rem;line-height:1;">💌</span>
          <div>
            <h3 style="margin:0;font-size:1.25rem;color:#0f766e;">${esc(careTitle(c))}</h3>
            <p style="margin:0.2rem 0 0;font-size:0.88rem;color:#0d9488;">Phiếu khảo sát Chăm sóc Cuộc sống</p>
          </div>
        </div>

        <div style="margin-bottom:1.15rem;display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;">
          <span class="status-badge ${status.badgeClass}">${status.label}</span>
          <span style="font-size:0.85rem;color:#0f766e;font-weight:600;">📅 ${esc(status.timeDesc)}</span>
        </div>

        <div style="background:#ffffff;border:1px solid #ccfbf1;border-radius:8px;padding:0.9rem 1rem;margin-bottom:1rem;font-size:0.88rem;color:#134e4a;line-height:1.6;">
          <strong>💡 調查目的與填寫說明：<br><small class="vn-sub">Mục đích và hướng dẫn điền phiếu:</small></strong><br>
          本表單旨在了解全體修課同學於<b>就學、課程、生活、健康及打工租屋</b>各方面的實際情況與生活需求，以提供即時輔導、關懷與校園資源協助。<br>
          <small class="vn-sub">Biểu mẫu này nhằm nắm bắt tình hình học tập và cuộc sống của sinh viên để nhà trường kịp thời hỗ trợ.</small>
        </div>

        <div style="font-size:0.84rem;color:#0f766e;line-height:1.5;">
          🔒 <b>便利與隱私保證：<br><small class="vn-sub">Tiện lợi và bảo mật:</small></b><br>
          • 登入後系統將自動帶入您的學號與姓名並安全鎖定。<br>
          • 每一筆填寫紀錄均帶有時間戳記，後續若狀況變更可隨時重新登入修改並記錄歷程。
        </div>
      </div>

      <!-- 右欄：學生專屬登入卡片 (無干擾獨立填寫) -->
      <div class="survey-login-card">
        <div style="border-bottom:1px solid #e2e8f0;padding-bottom:0.75rem;margin-bottom:1rem;">
          <h3 style="margin:0 0 0.35rem 0;color:#1e293b;font-size:1.15rem;display:flex;align-items:center;gap:0.4rem;">
            <span>🎓</span> <span>學生登入填寫問卷<small class="vn-sub">Đăng nhập điền khảo sát</small></span>
          </h3>
          <p style="margin:0;font-size:0.84rem;color:#64748b;">
            請輸入中文姓名與學號，登入後即可直接填寫或修改問卷。<br>
            <small class="vn-sub">Nhập họ tên và mã sinh viên để điền phiếu.</small>
          </p>
        </div>

        <form data-act="login-student" class="survey-login-form">
          <div class="form-group" style="margin-bottom:1rem;">
            <label style="display:block;font-weight:700;font-size:0.88rem;color:#334155;margin-bottom:0.35rem;">
              帳號（學生姓名）<br><small class="vn-sub">Tài khoản (Họ và tên)</small> <span style="color:#dc2626;">*</span>
            </label>
            <input name="name" placeholder="請輸入姓名 (Nhập họ và tên)" required autocomplete="off" style="width:100%;padding:0.6rem 0.8rem;border:1.5px solid #cbd5e1;border-radius:8px;font-size:0.95rem;">
          </div>
          <div class="form-group" style="margin-bottom:1.25rem;">
            <label style="display:block;font-weight:700;font-size:0.88rem;color:#334155;margin-bottom:0.35rem;">
              密碼（預設學號）<br><small class="vn-sub">Mật khẩu (Mặc định: Mã SV)</small> <span style="color:#dc2626;">*</span>
            </label>
            <input type="password" name="password" placeholder="預設學號 (Mặc định: Mã SV)" required autocomplete="off" style="width:100%;padding:0.6rem 0.8rem;border:1.5px solid #cbd5e1;border-radius:8px;font-size:0.95rem;">
          </div>
          <button class="btn btn-primary" type="submit" style="width:100%;padding:0.7rem;font-size:1rem;font-weight:700;justify-content:center;border-radius:8px;box-shadow:0 2px 6px rgba(37,99,235,0.25);">
            ✍️ 登入並開始填寫<br><small class="vn-sub">Đăng nhập và điền phiếu</small>
          </button>
        </form>

        <div style="margin-top:1rem;padding-top:0.75rem;border-top:1px dashed #e2e8f0;font-size:0.8rem;color:#64748b;line-height:1.4;">
          ※ 全體修課學生皆可登入填寫。預設密碼為<b>學號</b>，若曾自訂密碼請輸入新密碼；若忘記密碼請洽授課老師協助重設。
          <br><small class="vn-sub">Tất cả sinh viên đều có thể đăng nhập. Mật khẩu mặc định là Mã SV.</small>
        </div>
      </div>
    </div>

    <!-- 規劃中問卷區塊（若老師設定隱藏則不顯示） -->
    ${!c.hideUpcomingSurveys ? renderUpcomingSurveysBox() : ''}

    <div class="subsystem-footer">${subsystemBackBtn()}</div>
  </div>`;
}

/* ---- 問卷子系統：卡片列表與缺曠原因調查 ---- */
const surveyCardOpen = new Set();
const surveyCardHead = (key, inner) => `<div data-act="toggle-survey-card" data-key="${esc(key)}" style="display:flex;align-items:center;gap:0.6rem;cursor:pointer;" title="點擊收折/展開">${inner}<span style="margin-left:auto;font-size:1rem;color:#64748b;">${surveyCardOpen.has(key) ? '▼' : '▶'}</span></div>`;
const careTitle = c => `生活關懷問卷調查${c && c.careSubtitle ? '-' + c.careSubtitle : ''}`;
const careKeyId = k => String(k || '').startsWith('care:') ? String(k).slice(5) : '';

/* 生活關懷問卷多批次：將單一批次的資料攤平成「課程檢視」，讓既有的單份問卷畫面／統計函式可直接沿用 */
function careView(c, b) {
  const done = (b && b.done) || {};
  const doneAt = s => (s.id in done ? done[s.id] : (s.ref && s.ref in done ? done[s.ref] : undefined));
  return {
    ...c,
    careBatchId: b ? b.id : '',
    careSubtitle: b ? b.subtitle : '',
    careVisible: b ? b.visible !== false : true,
    surveyStart: b ? b.surveyStart || '' : '',
    surveyEnd: b ? b.surveyEnd || '' : '',
    hideUpcomingSurveys: !!(b && b.hideUpcoming),
    surveySubmissions: (b && b.submissions) || [],
    surveyLogs: (b && b.logs) || [],
    mySurvey: (b && b.mySurvey) || null,
    mySurveyLogs: (b && b.mySurveyLogs) || [],
    students: (c.students || []).map(st => {
      const at = doneAt(st);
      return { ...st, surveyCompleted: at !== undefined, surveyUpdatedAt: at || 0 };
    }),
  };
}

/* 目前操作中的生活關懷問卷：老師看後台選取的批次；學生看目前進入的卡片（未指定則第一份顯示中的問卷） */
function careCur(c) {
  const list = (c && c.careSurveys) || [];
  const isTeacher = state.session && state.session.role === 'teacher';
  const want = isTeacher ? careAdminId : careKeyId(publicSurveyCard);
  const b = list.find(x => x.id === want) || list.find(x => x.visible !== false) || list[0]
    || { id: '', subtitle: '', visible: true, submissions: [], logs: [], done: {} };
  return careView(c, b);
}
/* 問卷管理目前節點；指向已不存在的問卷時退回該問卷的設定節點 */
function wbSec(c) {
  if (wbSection.startsWith('care:') && !((c && c.careSurveys) || []).some(b => 'care:' + b.id === wbSection)) return 'care-config';
  if (wbSection.startsWith('abs:') && !((c && c.absenceSurveys) || []).some(sv => 'abs:' + sv.id === wbSection)) return 'abs-config';
  return wbSection;
}
const absenceTitle = sv => `缺曠原因調查-${sv.subtitle}`;

/* 依老師設定排序的問卷卡片；publicOnly 時略過前台隱藏者 */
function surveyCardList(c, publicOnly) {
  const items = [];
  (c.careSurveys || []).forEach(b => {
    if (!publicOnly || b.visible !== false) items.push({ key: 'care:' + b.id, type: 'care', b });
  });
  (c.absenceSurveys || []).forEach(sv => {
    if (!publicOnly || sv.visible !== false) items.push({ key: 'abs:' + sv.id, type: 'abs', sv });
  });
  const order = c.surveyOrder || [];
  const idx = k => { const i = order.indexOf(k); return i < 0 ? 9999 : i; };
  return items.map((x, i) => ({ x, i })).sort((a, b) => idx(a.x.key) - idx(b.x.key) || a.i - b.i).map(o => o.x);
}

function absenceProgress(sv) {
  const total = (sv.targets || []).length;
  const done = (sv.targets || []).filter(t => t.done).length;
  return { total, done, percent: total ? Math.round(done / total * 100) : 0 };
}

function renderSurveyCardList(c) {
  const s = me();
  const cards = surveyCardList(c, true);
  const cardHtml = x => {
    if (x.type === 'care') {
      const cv = careView(c, x.b);
      const st = getSurveyStatus(cv), stats = getSurveyStats(cv);
      return `
      <div class="survey-list-card" style="border-color:#99f6e4;">
        ${surveyCardHead(x.key, `<span style="font-size:2rem;">💌</span>
          <div><h3 style="margin:0;font-size:1.1rem;color:#0f766e;">${esc(careTitle(cv))}</h3><small class="vn-sub">Phiếu khảo sát Chăm sóc Cuộc sống</small></div>`)}
        <div style="display:${surveyCardOpen.has(x.key) ? 'block' : 'none'};">
        <div style="margin:0.7rem 0;display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap;">
          <span class="status-badge ${st.badgeClass}">${st.label}</span>
          <span style="font-size:0.82rem;color:#475569;">📅 ${esc(st.timeDesc)}</span></div>
        <div style="font-size:0.85rem;color:#134e4a;margin-bottom:0.8rem;">填寫進度：${stats.completed}/${stats.total} 人（${stats.percent}%）</div>
        <button class="btn btn-primary btn-sm" data-act="open-survey-card" data-key="${esc(x.key)}" style="justify-content:center;">進入問卷 ➔<br><small class="vn-sub">Vào phiếu khảo sát</small></button>
        </div>
      </div>`;
    }
    const sv = x.sv, p = absenceProgress(sv);
    const mine = s && sv.isTarget
      ? (sv.myResponse ? '<span class="status-badge can-edit">✅ 你已填寫</span>' : '<span class="status-badge under-threshold">✍️ 待你填寫</span>')
      : '';
    return `
    <div class="survey-list-card" style="border-color:#fcd34d;">
      ${surveyCardHead(x.key, `<span style="font-size:2rem;">📝</span>
        <div><h3 style="margin:0;font-size:1.1rem;color:#92400e;">${esc(absenceTitle(sv))}</h3><small class="vn-sub">Khảo sát lý do vắng mặt</small></div>`)}
      <div style="display:${surveyCardOpen.has(x.key) ? 'block' : 'none'};">
      <div style="margin:0.7rem 0;display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap;">${mine}</div>
      <div style="font-size:0.85rem;color:#78350f;margin-bottom:0.8rem;">需填寫 ${p.total} 位，已完成 ${p.done} 位（${p.percent}%）</div>
      <button class="btn btn-primary btn-sm" data-act="open-survey-card" data-key="${esc(x.key)}" style="justify-content:center;">進入問卷 ➔<br><small class="vn-sub">Vào phiếu khảo sát</small></button>
      </div>
    </div>`;
  };
  return `
  <div class="survey-standalone-page">
    <div class="block-identifier-tag">
      <span class="block-tag-code">[Block D]</span>
      <span class="block-tag-name">主要內容顯示區（問卷子系統）<br><small class="vn-sub">Khu vực hiển thị nội dung chính (Hệ thống con khảo sát)</small></span>
    </div>
    <div class="subsystem-header-bar">
      ${subsystemBackBtn()}
      <div class="subsystem-title-tag"><span class="subsystem-icon">💌</span>
        <div><strong>問卷子系統</strong><br><small class="vn-sub">Hệ thống con khảo sát</small></div></div>
      ${s ? `<span style="font-size:0.85rem;background:#f0fdf4;color:#166534;border:1px solid #bbf7d0;padding:0.25rem 0.65rem;border-radius:6px;font-weight:600;">🎓 ${esc(s.name)} (${esc(s.id)})</span>` : ''}
    </div>
    ${cards.length
      ? `<div style="display:flex;flex-direction:column;gap:1rem;margin-top:1rem;">${cards.map(cardHtml).join('')}</div>`
      : '<p class="file-path" style="margin-top:1rem;">目前沒有開放的問卷。<br><small class="vn-sub">Hiện chưa có phiếu khảo sát nào.</small></p>'}
    ${!c.hideUpcomingSurveys ? renderUpcomingSurveysBox() : ''}
    <div class="subsystem-footer">${subsystemBackBtn()}</div>
  </div>`;
}

/* 名單表格：需填寫該次問卷的學生與其所屬組長 */
function absenceTargetsTable(sv) {
  const rows = (sv.targets || []).slice().sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
  if (!rows.length) return '<p class="file-path">老師尚未指定需填寫的學生。</p>';
  return `
  <div style="overflow-x:auto;"><table class="data-table" style="width:100%;font-size:0.86rem;">
    <thead><tr><th>學號</th><th>姓名</th><th>組別</th><th>所屬組長</th><th>狀態</th></tr></thead>
    <tbody>${rows.map(t => `<tr>
      <td>${esc(t.id)}</td><td>${esc(t.name)}</td><td>${esc(t.groupName)}</td><td>${esc(t.leaderName)}</td>
      <td>${t.done ? '<span style="color:#16a34a;font-weight:600;">✅ 已填寫</span>' : '<span style="color:#dc2626;font-weight:600;">⏳ 尚未填寫</span>'}</td></tr>`).join('')}
    </tbody></table></div>`;
}

function renderAbsenceSurveyDetail(c, sv) {
  const s = me();
  const p = absenceProgress(sv);
  let body;
  if (!s) {
    body = `
    <div class="survey-login-card" style="margin:1rem 0;">
      <h3 style="margin:0 0 0.6rem;font-size:1.05rem;">🎓 學生登入填寫<small class="vn-sub">Đăng nhập điền khảo sát</small></h3>
      <form data-act="login-student" class="survey-login-form">
        <div class="form-group" style="margin-bottom:0.8rem;"><label style="font-weight:700;font-size:0.88rem;">帳號（學生姓名）<br><small class="vn-sub">Họ và tên</small></label>
          <input name="name" required autocomplete="off" style="width:100%;padding:0.6rem 0.8rem;border:1.5px solid #cbd5e1;border-radius:8px;"></div>
        <div class="form-group" style="margin-bottom:1rem;"><label style="font-weight:700;font-size:0.88rem;">密碼（預設學號）<br><small class="vn-sub">Mật khẩu (Mặc định: Mã SV)</small></label>
          <input type="password" name="password" required autocomplete="off" style="width:100%;padding:0.6rem 0.8rem;border:1.5px solid #cbd5e1;border-radius:8px;"></div>
        <button class="btn btn-primary" type="submit" style="width:100%;justify-content:center;">✍️ 登入並開始填寫<br><small class="vn-sub">Đăng nhập và điền phiếu</small></button>
      </form>
    </div>`;
  } else if (!sv.isTarget) {
    body = `<div class="survey-guide-notice" style="margin:1rem 0;padding:0.8rem 1rem;background:#f1f5f9;border-radius:8px;font-size:0.9rem;color:#475569;">
      你不在本次缺曠原因調查的填寫名單中，無需填寫。<br><small class="vn-sub">Bạn không nằm trong danh sách điền phiếu này.</small></div>`;
  } else {
    const my = sv.myResponse;
    body = `
    <form data-act="submit-absence-reason" data-survey="${esc(sv.id)}" class="student-survey-form" style="margin:1rem 0;padding:1rem 1.25rem;background:#fffbeb;border:1px solid #fde68a;border-radius:10px;">
      ${my ? `<div style="margin-bottom:0.8rem;font-size:0.86rem;color:#166534;">✅ 已於 ${esc(formatLogTime(my.updatedAt))} 送出，可修改後重新送出。</div>` : ''}
      <div class="form-row" style="display:flex;gap:1rem;flex-wrap:wrap;margin-bottom:0.8rem;">
        <label style="flex:1;min-width:160px;font-weight:700;font-size:0.88rem;">學號 <small class="vn-sub">Mã SV</small> <span style="color:#dc2626;">*</span>
          <input value="${esc(s.id)}" readonly style="width:100%;padding:0.5rem;background:#f1f5f9;border:1px solid #cbd5e1;border-radius:6px;"></label>
        <label style="flex:1;min-width:160px;font-weight:700;font-size:0.88rem;">姓名 <small class="vn-sub">Họ tên</small> <span style="color:#dc2626;">*</span>
          <input value="${esc(s.name)}" readonly style="width:100%;padding:0.5rem;background:#f1f5f9;border:1px solid #cbd5e1;border-radius:6px;"></label>
      </div>
      <label style="display:block;font-weight:700;font-size:0.88rem;margin-bottom:0.3rem;">缺曠原因說明 <small class="vn-sub">Lý do vắng mặt</small> <span style="color:#dc2626;">*</span></label>
      <textarea name="reason" required rows="5" maxlength="2000" placeholder="請說明缺曠原因 (Vui lòng nhập lý do vắng mặt)" style="width:100%;padding:0.6rem;border:1.5px solid #cbd5e1;border-radius:8px;font:inherit;">${esc(my ? my.reason : '')}</textarea>
      <button class="btn btn-primary" type="submit" style="margin-top:0.8rem;">${my ? '💾 更新送出' : '📨 送出'}<br><small class="vn-sub">${my ? 'Cập nhật' : 'Gửi'}</small></button>
    </form>`;
  }
  return `
  <div class="survey-standalone-page">
    <div class="subsystem-header-bar">
      ${surveyListBackBtn()}
      <div class="subsystem-title-tag"><span class="subsystem-icon">📝</span>
        <div><strong>${esc(absenceTitle(sv))}</strong><br><small class="vn-sub">Khảo sát lý do vắng mặt</small></div></div>
      ${s ? `<span style="font-size:0.85rem;background:#f0fdf4;color:#166534;border:1px solid #bbf7d0;padding:0.25rem 0.65rem;border-radius:6px;font-weight:600;">🎓 ${esc(s.name)} (${esc(s.id)})</span>
        <button class="btn btn-neutral btn-sm" data-act="logout" style="padding:0.25rem 0.65rem;font-size:0.8rem;">登出<br><small class="vn-sub">Đăng xuất</small></button>` : ''}
    </div>
    ${body}
    <h4 style="margin:1rem 0 0.4rem;">📋 本次需填寫名單與所屬組長（${p.done}/${p.total} 已完成）<br><small class="vn-sub">Danh sách sinh viên cần điền và nhóm trưởng</small></h4>
    ${absenceTargetsTable(sv)}
  </div>`;
}

const surveyListBackBtn = () => `<button class="btn btn-secondary btn-sm" data-act="back-survey-list" style="margin:0;">⬅ 返回問卷列表<br><small class="vn-sub">Về danh sách khảo sát</small></button>`;

/* ---- 問卷子系統子頁面 ---- */
function renderPublicSurveySection(c) {
  const key = publicSurveyCard;
  const cb = key.startsWith('care:') ? (c.careSurveys || []).find(x => 'care:' + x.id === key) : null;
  if (cb && cb.visible !== false) {
    return `<div style="margin-bottom:0.75rem;">${surveyListBackBtn()}</div>${renderCareSurveyDetail(careView(c, cb))}`;
  }
  const sv = key.startsWith('abs:') ? (c.absenceSurveys || []).find(x => 'abs:' + x.id === key) : null;
  if (sv) return renderAbsenceSurveyDetail(c, sv);
  return renderSurveyCardList(c);
}

function renderCareSurveyDetail(c) {
  const s = me();
  if (!s) {
    return renderSurveyStandaloneLogin(c);
  }
  const g = c.groups.find(x => x.id === s.groupId);
  const mates = g ? members(c, g.id) : [];
  const isSimulated = state.session && state.session.simulatedBy === 'teacher';

  return `
  <div class="survey-standalone-page">
    <div class="block-identifier-tag">
      <span class="block-tag-code">[Block D]</span>
      <span class="block-tag-name">主要內容顯示區（問卷子系統）<br><small class="vn-sub">Khu vực hiển thị nội dung chính (Hệ thống con khảo sát)</small></span>
    </div>

    <div class="subsystem-header-bar">
      ${subsystemBackBtn()}
      <div class="subsystem-title-tag">
        <span class="subsystem-icon">💌</span>
        <div>
          <strong>問卷子系統</strong>
          <br><small class="vn-sub">Hệ thống con khảo sát</small>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:0.5rem;">
        <span style="font-size:0.85rem;background:#f0fdf4;color:#166534;border:1px solid #bbf7d0;padding:0.25rem 0.65rem;border-radius:6px;font-weight:600;">
          🎓 登入身分：${esc(s.name)} (${esc(s.id)})
          <br><small class="vn-sub">Sinh viên: ${esc(s.name)}</small>
        </span>
        ${isSimulated ? `
          <button class="btn btn-warning btn-sm" data-act="exit-simulation" style="padding:0.25rem 0.65rem;font-size:0.8rem;background:#f59e0b;color:#fff;">
            ↩️ 結束測試<br><small class="vn-sub">Thoát thử nghiệm</small>
          </button>
        ` : `
          <button class="btn btn-neutral btn-sm" data-act="logout" style="padding:0.25rem 0.65rem;font-size:0.8rem;">
            登出<br><small class="vn-sub">Đăng xuất</small>
          </button>
        `}
      </div>
    </div>

    <!-- 生活關懷問卷表單主體 -->
    ${studentSurveyPanel(c, s)}

    <!-- 若為組長或副組長，顯示該組組員填寫狀況 (僅顯示自己組) -->
    ${(s.isLeader || s.isVice) && g ? leaderSurveyStatusPanel(c, g, s, mates) : ''}

    <!-- 規劃中問卷區塊（若老師設定隱藏則不顯示） -->
    ${!c.hideUpcomingSurveys ? renderUpcomingSurveysBox() : ''}

    <div class="subsystem-footer">${subsystemBackBtn()}</div>
  </div>`;
}

/* ---- 依當前子系統視角渲染中央區域 ---- */
function renderSubsystemMain(c) {
  if (publicSubView === 'password') {
    return renderPasswordChangePage();
  }
  if (!c) {
    return `
    <div class="empty-selection-guide">
      <div class="guide-arrow">👈</div>
      <div class="guide-text">
        <strong>請點選左側清單選擇學年度與科目<br><small class="vn-sub">Vui lòng chọn khóa học</small></strong>
        <p>點選任一學年度下的項目，即可在此載入首頁、分組、點名與問卷等子系統。<br><small class="vn-sub">Nhấp vào môn học bất kỳ để tải thông tin.</small></p>
      </div>
    </div>`;
  }
  if (publicSubView === 'groups') {
    return renderPublicGroupsSection(c);
  }
  if (publicSubView === 'attendance') {
    return renderPublicAttendanceSection(c);
  }
  if (publicSubView === 'survey') {
    return renderPublicSurveySection(c);
  }
  return renderPublicDashboard(c);
}

function authScreen() {
  const c = cur();
  return `
  ${loginMode === 'teacher' ? loginCard() : ''}
  ${noticeBlock(c)}
  <div class="home-flow">
    <div class="home-main-layout">
      ${courseTreePublic()}
      <div class="flow-main">
        ${renderSubsystemMain(c)}
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
        <h2>使用方式<br><small class="vn-sub">Cách sử dụng</small></h2>
      </div>
    </div>
    <div class="howto-steps">
      <div class="howto-step-card">
        <div class="step-num">1</div>
        <div class="step-info">
          <strong>選擇學年度分組<br><small class="vn-sub">Chọn năm học và môn học</small></strong>
          <p>在左側樹狀區塊中點選欲查看的<b>學年度分組</b>，右側將即時載入該項目資料。<br><small class="vn-sub">Chọn môn học ở menu bên trái, dữ liệu sẽ hiển thị bên phải.</small></p>
        </div>
      </div>
      <div class="howto-step-card">
        <div class="step-num">2</div>
        <div class="step-info">
          <strong>申請擔任組長開組<br><small class="vn-sub">Đăng ký làm trưởng nhóm để lập nhóm</small></strong>
          <p>點選<b>申請擔任組長</b>（輸入姓名＋學號密碼）登入後即可開組與挑選組員。<br><small class="vn-sub">Bấm "Đăng ký làm trưởng nhóm" (họ tên + mật khẩu mã SV) để lập nhóm và chọn thành viên.</small></p>
        </div>
      </div>
      <div class="howto-step-card">
        <div class="step-num">3</div>
        <div class="step-info">
          <strong>挑選組員與指定副組長<br><small class="vn-sub">Chọn thành viên và chỉ định nhóm phó</small></strong>
          <p>組長可從未分組名單挑選組員、設定副組長。<b>欲加入尚未額滿的各組組員，請一律透過組長加入</b>；被挑選同學不需額外動作。<br><small class="vn-sub">Nhóm trưởng chọn thành viên từ danh sách chưa chia nhóm và đặt nhóm phó. Muốn vào nhóm còn chỗ, vui lòng nhờ nhóm trưởng thêm vào.</small></p>
        </div>
      </div>
      <div class="howto-step-card">
        <div class="step-num">4</div>
        <div class="step-info">
          <strong>截止後自動分配<br><small class="vn-sub">Tự động phân nhóm sau hạn chót</small></strong>
          <p>超過分組截止時間未被挑選者由系統隨機分配至未滿組別，並標示為「自動」。<small class="vn-sub">Sau hạn chót, sinh viên chưa được chọn sẽ được hệ thống phân ngẫu nhiên vào nhóm còn chỗ.</small>${deadlineStr ? `<br><span style="display:inline-block;margin-top:0.35rem;padding:0.15rem 0.5rem;background:${isExpired ? '#fee2e2' : '#fef3c7'};color:${isExpired ? '#991b1b' : '#92400e'};border-radius:4px;font-weight:600;font-size:0.85rem;">⏳ 本科目分組截止時間：${deadlineStr} ${isExpired ? '(已截止)' : ''}</span>` : '<br><span style="color:#64748b;font-size:0.85rem;">（本科目尚未設定分組截止時間）</span>'}</p>
        </div>
      </div>
    </div>
  </section>`;
}

/* ---- [Block C] 左側選單區：前台課程樹狀結構區塊（學年度 → 科目 → 子系統） ---- */
function courseTreePublic() {
  const byYear = {};
  state.courses.forEach(c => {
    const y = c.year || '未分類';
    (byYear[y] = byYear[y] || []).push(c);
  });
  const years = Object.keys(byYear).sort().reverse();
  return `<aside class="block-section tree-section" id="courses-tree-block">
    <div class="block-identifier-tag">
      <span class="block-tag-code">[Block C]</span>
      <span class="block-tag-name">左側選單區<br><small class="vn-sub">Menu bên trái</small></span>
    </div>
    <div class="block-header tree-header">
      <div class="block-title-wrap">
        <span class="step-badge">清單<br><small class="vn-sub">Danh mục</small></span>
        <h2>學年度<br><small class="vn-sub" style="font-weight:normal;font-size:0.82rem;color:#64748b;">Năm học</small></h2>
      </div>
      <p class="block-desc">選擇學年度、科目與子系統<br><small class="vn-sub">Chọn khóa học và hệ thống</small></p>
    </div>
    <div class="tree-content">
      ${years.length ? years.map(y => `
        <div class="tree-year">
          <div class="tree-year-label">${esc(y)} 學年度<br><small class="vn-sub">Năm học</small></div>
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
              ${active ? `
                <ul class="tree-sub-list">
                  <li class="${publicSubView === 'dashboard' ? 'sub-active' : ''}">
                    <button class="tree-subnode-btn" data-act="nav-public-subview" data-view="dashboard" data-course="${c.id}" title="查看組員缺席排行榜與未完成問卷名單">
                      <span class="subnode-icon">🏠</span>
                      <span class="subnode-name">
                        首頁
                        <br><small class="vn-sub">Trang chủ</small>
                      </span>
                    </button>
                  </li>
                  <li class="${publicSubView === 'groups' ? 'sub-active' : ''}">
                    <button class="tree-subnode-btn" data-act="nav-public-subview" data-view="groups" data-course="${c.id}" title="查看分組使用說明、組別現況與挑選組員">
                      <span class="subnode-icon">👥</span>
                      <span class="subnode-name">
                        分組子系統
                        <br><small class="vn-sub">Hệ thống con chia nhóm</small>
                      </span>
                    </button>
                  </li>
                  <li class="${publicSubView === 'attendance' ? 'sub-active' : ''}">
                    <button class="tree-subnode-btn" data-act="nav-public-subview" data-view="attendance" data-course="${c.id}" title="查看點名現況、組長今日點名與缺席統計">
                      <span class="subnode-icon">📋</span>
                      <span class="subnode-name">
                        點名子系統
                        <br><small class="vn-sub">Hệ thống con điểm danh</small>
                      </span>
                    </button>
                  </li>
                  <li class="${publicSubView === 'survey' ? 'sub-active' : ''}">
                    <button class="tree-subnode-btn" data-act="nav-public-subview" data-view="survey" data-course="${c.id}" title="進入獨立問卷填寫頁面">
                      <span class="subnode-icon">💌</span>
                      <span class="subnode-name">
                        問卷子系統
                        <br><small class="vn-sub">Hệ thống con khảo sát</small>
                      </span>
                    </button>
                  </li>
                </ul>
              ` : ''}
            </li>`;
          }).join('')}</ul>
        </div>`).join('') : '<p class="file-path empty-notice">老師尚未建立任何分組。<br><small class="vn-sub">Chưa có khóa học nào.</small></p>'}
    </div>
  </aside>`;
}

/* ---- 後台：左側課程樹 ---- */
function courseTree() {
  const byYear = {};
  state.courses.forEach(c => {
    const y = c.year || '未分類';
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
    <button class="btn btn-secondary" data-act="new-course">＋ 新增分組項目</button>
    <div class="tree-year tree-sys">
      <div class="tree-year-label">系統設定</div>
      <ul>
        <li class="${teacherView === 'settings' ? 'active' : ''}">
          <button data-act="sys-password">🔑 密碼與安全性管理<span class="count">管理者與組長密碼</span></button>
        </li>
        <li class="${teacherView === 'eval' ? 'active' : ''}">
          <button data-act="sys-peer-eval">⚖️ 學期成績加減分與組長評分控制<span class="count">組長評分權限與期末加減分</span></button>
        </li>
        <li class="${teacherView === 'logs' ? 'active' : ''}">
          <button data-act="sys-logs">👥 分組管理<span class="count">分組異動日誌</span></button>
        </li>
        <div class="tree-row-pair">
          <li class="tree-row-item ${teacherView === 'attendance' ? 'active' : ''}">
            <button data-act="sys-attendance">📋 點名管理<span class="count">點名時段、缺曠撤銷與點名異動日誌</span></button>
          </li>
          <li class="tree-row-item ${teacherView === 'wellbeing' ? 'active' : ''}">
            <div class="tree-node-row">
              <button data-act="sys-wellbeing">💌 問卷管理<span class="count">問卷回覆與問卷異動日誌</span></button>
              <button class="wb-tree-toggle" type="button" data-act="toggle-wb-tree" title="${wbTreeOpen ? '收折全部問卷管理子項目' : '展開全部問卷管理子項目'}">${wbTreeOpen ? '▼' : '▶'}</button>
            </div>
          </li>
        </div>
        ${wbTreeOpen ? `<li class="tree-row-pair-sub">${wellbeingSubTree()}</li>` : ''}
        <li class="${teacherView === 'bulletin' ? 'active' : ''}">
          <button data-act="sys-bulletin">📢 公佈欄管理<span class="count">首頁 Block B 顯示筆數設定</span></button>
        </li>
        <li class="${teacherView === 'system' ? 'active' : ''}">
          <button data-act="sys-system">🖥️ 系統運行紀錄<span class="count">排程執行紀錄與日誌自動移除提示</span></button>
        </li>
      </ul>
    </div>
  </aside>`;
}

function wellbeingSubTree() {
  const c = cur();
  if (!c) return '';
  const sec = teacherView === 'wellbeing' ? wbSec(c) : '';
  const node = (key, label, extra = '') => `<li class="${sec === key ? 'active' : ''}"><button data-act="wb-section" data-sec="${esc(key)}">${label}</button>${extra}</li>`;
  const careNodes = (c.careSurveys || []).map(b => node('care:' + b.id, esc(careTitle({ careSubtitle: b.subtitle })))).join('');
  const absNodes = (c.absenceSurveys || []).map(sv => node('abs:' + sv.id, esc(absenceTitle(sv)))).join('');
  return `<ul class="tree-sub">
    ${node('cards', '問卷卡片前台顯示與排列')}
    ${node('care-config', '生活關懷問卷調查設定', careNodes ? `<ul>${careNodes}</ul>` : '')}
    ${node('abs-config', '缺曠原因調查問卷設定', absNodes ? `<ul>${absNodes}</ul>` : '')}
    ${node('log', '問卷設定異動日誌')}
  </ul>`;
}

function teacherSubpageNav(viewTitle, c) {
  return `
  <div class="teacher-subpage-nav">
    <div class="nav-actions">
      <button class="btn btn-primary btn-sm" data-act="back-to-course" title="返回老師後台分組與課程主頁">
        ⬅️ 返回老師後台主頁
      </button>
      <button class="btn btn-secondary btn-sm" type="button" data-act="history-back" title="回到上一頁">
        ↩️ 回到上一頁
      </button>
    </div>
    <div class="nav-breadcrumbs">
      <span class="crumb-root">老師後台</span>
      <span class="crumb-sep">/</span>
      ${c ? `<span class="crumb-course">${esc(courseLabel(c))}</span><span class="crumb-sep">/</span>` : ''}
      <span class="crumb-current"><b>${esc(viewTitle)}</b></span>
    </div>
  </div>`;
}

function teacherScreen() {
  const c = cur();
  let main;
  if (teacherView === 'settings') {
    main = teacherSubpageNav('密碼與安全性管理', c) + teacherPasswordBlock(c);
  } else if (teacherView === 'eval') {
    main = teacherSubpageNav('學期成績加減分與組長評分控制', c) + teacherPeerEvalBlock(c);
  } else if (teacherView === 'logs') {
    main = teacherSubpageNav('分組管理', c) + activityLogPanel(c, 'group');
  } else if (teacherView === 'attendance') {
    main = teacherSubpageNav('點名管理', c) + teacherAttendanceBlock(c) + activityLogPanel(c, 'attendance');
  } else if (teacherView === 'wellbeing') {
    main = teacherSubpageNav('問卷管理', c) + `<div class="block-identifier-tag"><span class="block-tag-code">[Block S]</span> <span class="block-tag-name">問卷管理</span></div>` + teacherWellbeingBlock(c) + (wbSec(c) === 'log' ? activityLogPanel(c, 'survey') : '');
  } else if (teacherView === 'bulletin') {
    main = teacherSubpageNav('公佈欄管理', c) + teacherBulletinBlock();
  } else if (teacherView === 'system') {
    main = teacherSubpageNav('系統運行紀錄', c) + teacherSystemBlock(c);
  } else {
    main = c ? teacherCourse(c) : teacherNoCourse();
  }
  return `<div class="layout">${courseTree()}<main>${main}</main></div>`;
}

/* ---- 老師後台：系統運行紀錄（每日排程自動清除逾期日誌之執行結果與即將移除提示） ---- */
function daysUntil(ts, now) {
  return Math.max(0, Math.ceil((ts - now) / 86400000));
}
function formatDateOnly(ts) {
  return formatLogTime(ts).slice(0, 10);
}

function teacherSystemBlock(c) {
  const key = c ? c.id : '';
  const st = systemStatusByCourse[key];
  if (!st && !systemStatusLoading && !systemStatusError) setTimeout(() => loadSystemStatus(key), 0);
  if (!st) {
    return `<div class="teacher-section"><h2>🖥️ 系統運行紀錄</h2>
      <p class="file-path">${systemStatusError ? `載入失敗：${esc(systemStatusError)}　<button class="btn btn-sm" data-act="refresh-system-status">重新載入</button>` : '載入中…'}</p></div>`;
  }
  const now = Date.now();
  const lastRun = st.runs[0];
  const soon = st.categories.filter(x => x.upcoming.length && daysUntil(x.upcoming[0].deleteAt, now) <= 7);
  const runDeleted = r => r.detail || {};

  const catRows = st.categories.map(x => {
    const upcomingTotal = x.upcoming.reduce((n, u) => n + u.count, 0);
    return `
      <tr>
        <td><b>${esc(x.label)}</b></td>
        <td style="text-align:center;">${x.total} 筆</td>
        <td>${x.oldest ? formatLogTime(x.oldest) : '—'}</td>
        <td>${x.oldestDeleteAt ? `${formatDateOnly(x.oldestDeleteAt)} 03:00（<b>${daysUntil(x.oldestDeleteAt, now)}</b> 天後）` : '—'}</td>
        <td>${upcomingTotal ? `
          <b style="color:#b45309;">${upcomingTotal} 筆</b>
          <details style="margin-top:0.25rem;"><summary style="cursor:pointer;font-size:0.8rem;color:#64748b;">依移除日期</summary>
            <ul style="margin:0.35rem 0 0;padding-left:1.1rem;font-size:0.82rem;">
              ${x.upcoming.map(u => `<li>${formatDateOnly(u.deleteAt)}（${daysUntil(u.deleteAt, now)} 天後）：${u.count} 筆</li>`).join('')}
            </ul>
          </details>` : '<span style="color:#16a34a;">無</span>'}</td>
      </tr>`;
  }).join('');

  const runRows = st.runs.map(r => {
    const d = runDeleted(r);
    return `
      <tr>
        <td style="font-family:monospace;white-space:nowrap;">${formatLogTime(r.startedAt)}</td>
        <td>自動清除逾期日誌</td>
        <td>${r.status === 'ok' ? '<span style="color:#16a34a;font-weight:700;">✅ 成功</span>' : `<span style="color:#b91c1c;font-weight:700;">❌ 失敗</span><div style="font-size:0.78rem;color:#b91c1c;">${esc(d.error || '')}</div>`}</td>
        <td style="text-align:center;">${r.status === 'ok' ? `${d.attendance || 0} / ${d.survey || 0} / ${d.surveyFill || 0}` : '—'}</td>
        <td style="text-align:center;">${Math.max(0, r.finishedAt - r.startedAt)} ms</td>
      </tr>`;
  }).join('');

  return `
  <div class="teacher-section">
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.5rem;">
      <h2 style="margin:0;">🖥️ 系統運行紀錄</h2>
      <button class="btn btn-secondary btn-sm" data-act="refresh-system-status" ${systemStatusLoading ? 'disabled' : ''}>🔄 ${systemStatusLoading ? '更新中…' : '重新整理'}</button>
    </div>
    <p class="file-path" style="margin-top:0.75rem;line-height:1.7;">
      🧹 <b>自動清除規則</b>：點名異動、問卷設定異動、問卷填寫異動日誌保留 <b>${st.retentionDays}</b> 天（約六個月），系統每日 <b>03:00（台北時間）</b> 自動移除逾期紀錄；分組異動日誌不會自動刪除。<br>
      ⏰ 下次執行：<b>${formatLogTime(st.nextRunAt).slice(0, 16)}</b>　｜　上次執行：${lastRun ? `<b>${formatLogTime(lastRun.startedAt)}</b>（${lastRun.status === 'ok' ? '成功' : '失敗'}）` : '尚無執行紀錄'}
    </p>
    ${soon.length ? `
    <div style="background:#fffbeb;border:1px solid #fcd34d;color:#92400e;border-radius:8px;padding:0.75rem 1rem;margin-top:0.5rem;font-size:0.9rem;line-height:1.7;">
      ⚠️ <b>7 天內將自動移除</b>：${soon.map(x => `${esc(x.label)} ${x.upcoming.filter(u => daysUntil(u.deleteAt, now) <= 7).reduce((n, u) => n + u.count, 0)} 筆（最快 ${daysUntil(x.upcoming[0].deleteAt, now)} 天後）`).join('；')}。如需保留，請先至對應管理頁匯出或截圖。
    </div>` : ''}
  </div>

  <div class="teacher-section">
    <h2>即將自動移除的日誌 <small>${c ? esc(courseLabel(c)) : '（請先選擇課程）'}・未來 ${st.windowDays} 天</small></h2>
    ${c ? `
    <div class="table-wrap">
      <table class="roster" style="background:#fff;">
        <thead><tr><th>日誌類別</th><th style="text-align:center;">目前筆數</th><th>最舊紀錄時間</th><th>最舊紀錄移除時間</th><th>${st.windowDays} 天內將移除</th></tr></thead>
        <tbody>${catRows}</tbody>
      </table>
    </div>` : '<p class="file-path">請先從左側點選課程，即可檢視該課程日誌的移除時程。</p>'}
  </div>

  <div class="teacher-section">
    <h2>排程執行紀錄 <small>最近 ${st.runs.length} 次</small></h2>
    ${st.runs.length ? `
    <div class="table-wrap">
      <table class="roster" style="background:#fff;">
        <thead><tr><th>執行時間</th><th>工作</th><th>狀態</th><th style="text-align:center;">刪除筆數<br><small>點名 / 問卷設定 / 問卷填寫</small></th><th style="text-align:center;">耗時</th></tr></thead>
        <tbody>${runRows}</tbody>
      </table>
    </div>` : '<p class="file-path">尚無執行紀錄；排程每日 03:00（台北時間）執行後即會顯示於此（全系統共用，含所有課程）。</p>'}
  </div>`;
}

/* ---- 老師後台：公佈欄管理（首頁 Block B 顯示筆數設定） ---- */
function teacherBulletinBlock() {
  const pageSize = Number(state.bulletinPageSize) > 0 ? Number(state.bulletinPageSize) : 10;
  const items = (state.bulletin && state.bulletin.length) ? state.bulletin : INITIAL_BULLETIN_PAGES;
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return `
  <div class="teacher-section bulletin-admin-box">
    <h2>📢 公佈欄管理<small class="vn-sub" style="display:block;font-size:0.85rem;color:#64748b;font-weight:normal;margin-top:0.2rem;">Quản lý bảng thông báo</small></h2>
    <p class="file-path">
      設定前台首頁 [Block B] 公佈欄每次分頁顯示的公告筆數。目前系統預設為 10 筆，可依需求調整為 5 筆或其他筆數。<br>
      <small class="vn-sub">Cài đặt số lượng thông báo hiển thị trên mỗi trang của [Block B]. Mặc định là 10 mục.</small>
    </p>

    <form data-act="save-bulletin-settings" style="background:#fffdf5;border:1px solid #fef3c7;border-left:4px solid #f59e0b;border-radius:10px;padding:1.3rem 1.6rem;margin:1.3rem 0;max-width:620px;box-shadow:0 1px 3px rgba(245,158,11,0.08);">
      <div class="form-group" style="margin-bottom:1.1rem;">
        <label style="font-weight:700;font-size:0.96rem;color:#92400e;display:block;margin-bottom:0.45rem;">
          每頁顯示公告筆數（筆）
          <small class="vn-sub" style="font-weight:normal;color:#64748b;margin-left:0.3rem;">Số lượng thông báo trên mỗi trang</small>
        </label>
        <div style="display:flex;align-items:center;gap:0.75rem;">
          <input type="number" name="pageSize" id="bulletinPageSizeInput" min="1" max="50" value="${pageSize}" style="width:130px;padding:0.45rem 0.75rem;border:1.5px solid #cbd5e1;border-radius:6px;font-size:1.05rem;font-weight:600;" required>
          <span style="font-size:0.9rem;color:#64748b;">筆 / 頁（Trang）</span>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:1.3rem;flex-wrap:wrap;">
        <span style="font-size:0.84rem;color:#64748b;font-weight:600;">快速選擇：</span>
        <button class="btn btn-secondary btn-sm" type="button" data-act="set-bulletin-pagesize-preset" data-size="5" style="padding:0.25rem 0.7rem;font-size:0.82rem;${pageSize === 5 ? 'background:#d97706;color:#fff;border-color:#d97706;' : ''}">5 筆</button>
        <button class="btn btn-secondary btn-sm" type="button" data-act="set-bulletin-pagesize-preset" data-size="10" style="padding:0.25rem 0.7rem;font-size:0.82rem;${pageSize === 10 ? 'background:#d97706;color:#fff;border-color:#d97706;' : ''}">10 筆</button>
        <button class="btn btn-secondary btn-sm" type="button" data-act="set-bulletin-pagesize-preset" data-size="15" style="padding:0.25rem 0.7rem;font-size:0.82rem;${pageSize === 15 ? 'background:#d97706;color:#fff;border-color:#d97706;' : ''}">15 筆</button>
        <button class="btn btn-secondary btn-sm" type="button" data-act="set-bulletin-pagesize-preset" data-size="20" style="padding:0.25rem 0.7rem;font-size:0.82rem;${pageSize === 20 ? 'background:#d97706;color:#fff;border-color:#d97706;' : ''}">20 筆</button>
      </div>
      <button class="btn btn-primary" type="submit" style="padding:0.5rem 1.4rem;font-size:0.92rem;">
        💾 儲存顯示設定<br><small class="vn-sub">Lưu cài đặt</small>
      </button>
    </form>

    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:1.1rem 1.4rem;max-width:620px;margin-top:1.5rem;">
      <h4 style="margin:0 0 0.6rem;color:#334155;font-size:0.95rem;">📊 公佈欄運行狀態</h4>
      <ul style="margin:0;padding-left:1.2rem;font-size:0.88rem;color:#475569;line-height:1.75;">
        <li>目前每頁顯示：<b style="color:#d97706;">${pageSize}</b> 筆（共需分 <b>${totalPages}</b> 頁）</li>
        <li>公佈欄總公告數：共 <b>${total}</b> 則最新公告</li>
        <li>Notion 來源頁面：<a href="https://app.notion.com/p/113-_-975bbaa19830833e955701873b3181e5" target="_blank" rel="noopener noreferrer" style="color:#0284c7;text-decoration:underline;font-weight:600;">113入學-行銷一真(國際)_班務公告入口 ↗</a></li>
        <li>同步機制：伺服端每 10 分鐘自動快取更新；若遇網路或 API 限制，自動切換至離線快照備援。</li>
      </ul>
    </div>
  </div>`;
}

function teacherNoCourse() {
  return `
  <div class="teacher-section">
    <h2>分組設定</h2>
    <p class="file-path">建立新分組：填寫學年度與名稱後儲存，會出現在左側樹狀清單。</p>
    ${courseForm({ year: '', subject: '', groupSize: 4, tolerance: 1, maxBonus: 10, deadline: '', notice: '' })}
  </div>`;
}

/* 公布欄預設注意事項（課程未自訂公告時，前台 Block B 與後台表單共用） */
function defaultNotice(maxB) {
  return `【期末考成績加減分與評分規定】：
1. 當老師開放組長評分權限時，組長可依據組員之貢獻或配合程度於期末時給予加分 (0 ~ ${maxB} 分)。
2. 組長在老師開放評分權限時進行評分，組長自己可獲得 ${maxB} 分的加分。
3. 超過分組截止時間由系統自動分組造成沒有組長的組別，每位成員期末考成績扣 10 分。`;
}

function courseForm(c) {
  const maxB = (c && Number(c.maxBonus) > 0) ? Number(c.maxBonus) : 10;
  const noticeVal = (c && c.notice !== undefined && c.notice !== null) ? c.notice : defaultNotice(maxB);

  return `<form data-act="save-course">
    <div class="form-row">
      <div class="form-group"><label>學年度</label><input name="year" value="${esc(c.year)}" placeholder="113-1" required></div>
      <div class="form-group"><label>名稱</label><input name="subject" value="${esc(c.subject)}" placeholder="例如：113入學行銷真班" required></div>
      <div class="form-group"><label>每組人數</label><input type="number" min="1" name="groupSize" value="${c.groupSize || 4}"></div>
      <div class="form-group"><label>誤差人數 ±</label><input type="number" min="0" name="tolerance" value="${c.tolerance ?? 1}"></div>
      <div class="form-group"><label>組長加分上限（分）</label><input type="number" min="1" max="100" name="maxBonus" value="${maxB}" placeholder="例如 5 或 10" required></div>
      <div class="form-group"><label>分組截止時間</label><input type="datetime-local" name="deadline" value="${esc(c.deadline || '')}"></div>

    </div>
    <button class="btn btn-primary" type="submit">儲存</button>
  </form>`;
}

/* ---- 後台：學期成績加減分與組長評分控制面板 ---- */
function teacherPeerEvalBlock(c) {
  if (!c) {
    return `
    <div class="teacher-section peer-eval-admin-box">
      <h2>⚖️ 學期成績加減分與組長評分控制</h2>
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
        <button class="btn btn-success" type="button" data-act="export-eval-csv" style="padding:0.4rem 1rem;font-size:0.85rem;margin:0;margin-left:auto;">📥 下載匯出評分結果（依學號排序）</button>
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
                  ? `<span class="status-badge can-edit">開放中</span>`
                  : `<span class="status-badge is-locked">未開放</span>`}
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
  const groupLogs = (c.logs || []).filter(l => logCategoryOf(l.actionType) === 'group');
  return `
  <div class="teacher-section">
    <h2>分組設定 <small>${esc(courseLabel(c))}</small></h2>
    ${courseForm(c)}
    <div class="btn-row" style="margin-top:1rem;justify-content:flex-end;">
      <button class="btn btn-danger btn-sm" data-act="del-course" data-id="${c.id}" title="完全刪除本科目所有資料">🗑️ 刪除整個科目（含名單與分組）</button>
    </div>
  </div>

  <div class="teacher-section grouping-admin-section">
    <div class="grouping-header-row">
      <h2 style="margin:0;">👥 分組管理與組員分配 <small>${esc(courseLabel(c))}</small></h2>
      <div class="grouping-header-actions">
        <button class="btn btn-secondary btn-sm" data-act="export-csv" title="匯出分組名單為 CSV 格式">📥 匯出 CSV</button>
        <button class="btn btn-secondary btn-sm" data-act="export-json" title="匯出完整分組 JSON">📥 匯出 JSON</button>
        <button class="btn btn-secondary btn-sm" data-act="view-course-logs" title="查看本課程組員異動日誌與操作歷史">📜 異動日誌 (${(c.logs || []).length})</button>
      </div>
    </div>

    <!-- 1. 分組截止時間設定列 -->
    <form data-act="set-course-deadline" class="grouping-deadline-bar" style="margin-top:1rem;">
      <label>⏳ 全體分組截止時間：</label>
      <input type="datetime-local" name="deadline" value="${esc(c.deadline || '')}">
      <button class="btn btn-primary" type="submit" style="padding:0.4rem 1rem;font-size:0.85rem;margin:0;">儲存截止時間</button>
      ${c.deadline ? `
        <span class="deadline-status-tag ${deadlinePassed(c) ? 'closed' : 'open'}">
          ${deadlinePassed(c) ? '🚫 已截止（逾時不解散原組，未選學生已自動分配）' : '🟢 分組進行中'}
        </span>
      ` : '<span style="font-size:0.82rem;color:#64748b;">(尚未設定截止時間)</span>'}
    </form>

    <!-- 2. 四格狀態統計數據 -->
    <div class="stats" style="margin-top:1rem;">
      <div class="stat"><div class="value">${total}</div><div class="label">總學生數</div></div>
      <div class="stat"><div class="value">${c.groups.length}</div><div class="label">目前組數</div></div>
      <div class="stat"><div class="value">${assigned}</div><div class="label">已分組人數</div></div>
      <div class="stat"><div class="value" style="color:${total - assigned > 0 ? '#e67e22' : '#27ae60'};">${total - assigned}</div><div class="label">未分組學生</div></div>
    </div>

    <!-- 3. 功能操作卡片群組 (三大模組分類) -->
    <div class="grouping-cards-container" style="margin-top:1.5rem;">

      <!-- 模組一：日常組別維護與擴展 (安全操作) -->
      <div class="grouping-card safe-ops-card">
        <div class="grouping-card-header">
          <strong class="card-title">🟢 組別常態維護與增設</strong>
          <span class="card-badge safe">安全操作</span>
        </div>
        <div class="grouping-card-body">
          <p class="card-intro">此區域操作<b>不會影響或清空</b>現有組別與成員，適合日常維護或截止後補足組別需求。</p>
          <div class="grouping-actions-grid">
            
            <div class="grouping-action-box">
              <div class="action-meta">
                <b>➕ 手動新增單一組別</b>
                <span>為本課程新增 1 個全新組別（第 ${c.groups.length + 1} 組），供學生自行加入或老師手動指派。</span>
              </div>
              <button class="btn btn-secondary" data-act="add-group">新增 1 組</button>
            </div>

            <div class="grouping-action-box">
              <div class="action-meta">
                <b>👥 為未分組學生擴增組別</b>
                <span>依每組 ${c.groupSize || 4} 人自動為剩餘 <b>${total - assigned} 位未分組學生</b> 計算並產生新組別模板。已分組之成員與組別完全不受影響。</span>
              </div>
              <button class="btn btn-success" data-act="make-remaining-groups" ${total - assigned === 0 ? 'disabled' : ''}>
                針對剩餘 ${total - assigned} 人擴增組別
              </button>
            </div>

            <div class="grouping-action-box">
              <div class="action-meta">
                <b>🎲 隨機分配未分組學生</b>
                <span>將未分組學生隨機分派至未滿門檻（${minCap(c)}人）的組別。若現有組別皆已達上限，將自動開新組收納。已完成編組的組別成員完全不變。</span>
              </div>
              <button class="btn btn-primary" data-act="auto-assign" ${total - assigned === 0 ? 'disabled' : ''}>
                隨機分配未分組學生
              </button>
            </div>

          </div>
        </div>
      </div>

      <!-- 模組二：危險區域：全班分組重置 (清楚區分「重新建立空組」vs「清空所有組別」) -->
      <div class="grouping-card danger-ops-card">
        <div class="grouping-card-header">
          <strong class="card-title">⚠️ 全班分組重設與清空 <small>（重要操作，請詳閱差異）</small></strong>
          <span class="card-badge danger">高風險操作</span>
        </div>
        <div class="grouping-card-body">
          <p class="card-intro" style="color:#b91c1c;">
            以下操作將變更全班學生的組別分配狀態。系統於執行前均會<b>自動建立備份快照</b>，若有誤操作可隨時透過「回到上一步」復原。
          </p>

          <div class="grouping-actions-grid two-cols">
            
            <!-- 選項 A：重設並重新產生全班空白組別 -->
            <div class="grouping-action-box highlight-box warning">
              <div class="action-meta">
                <div class="box-badge-tag tag-warning">全班重新分組模板</div>
                <h4 style="margin:0.25rem 0 0.4rem;color:#b45309;">🔄 重新計算並建立全新空組別</h4>
                <div class="box-desc">
                  <b>【適用情境】：</b>學期初或全班推翻重來。<br>
                  <b>【功能效果】：</b>依全班學生總數（${total}人）與每組規定人數（${c.groupSize || 4}人），<b>自動重新建立 ${Math.max(1, Math.ceil(total / Math.max(1, c.groupSize || 4)))} 個空白組別（第 1 ~ ${Math.max(1, Math.ceil(total / Math.max(1, c.groupSize || 4)))} 組）</b>。<br>
                  <b>【學生狀態】：</b>現有分組名單全數清除，學生全體退回未分組。<br>
                  <b>【修課名單】：</b>學生名單與帳號完整保留。
                </div>
              </div>
              <button class="btn btn-warning" data-act="make-groups" style="width:100%;margin-top:0.75rem;">
                🔄 重新建立全新空組別（清空現有）
              </button>
            </div>

            <!-- 選項 B：清空所有組別（組數歸零） -->
            <div class="grouping-action-box highlight-box danger">
              <div class="action-meta">
                <div class="box-badge-tag tag-danger">組別全數刪除歸零</div>
                <h4 style="margin:0.25rem 0 0.4rem;color:#b91c1c;">🗑️ 清空所有組別（不建立新組，組數歸零）</h4>
                <div class="box-desc">
                  <b>【適用情境】：</b>暫時移除所有組別，或改為由學生自創組別。<br>
                  <b>【功能效果】：</b><b>刪除本科目現存的所有組別，組別總數變為 0 組</b>（不會自動產生任何新組別）。<br>
                  <b>【學生狀態】：</b>全體學生釋出為未分組。<br>
                  <b>【修課名單】：</b>學生名單與帳號完整保留。
                </div>
              </div>
              <button class="btn btn-danger" data-act="clear-groups" style="width:100%;margin-top:0.75rem;">
                🗑️ 清空所有組別（組別數歸 0）
              </button>
            </div>

          </div>

          <!-- 快照復原提示列 -->
          ${c.hasSnapshot ? `
            <div class="undo-snapshot-banner" style="margin-top:1rem;padding:0.85rem 1.1rem;background:#ecfdf5;border:1.5px solid #10b981;border-radius:8px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.75rem;">
              <div style="color:#065f46;font-size:0.9rem;">
                <b>🛡️ 系統已自動備份上次分組快照</b>：如剛剛點擊了清空或重設組別，可立即點擊右側按鈕一鍵還原！
              </div>
              <button class="btn btn-undo" data-act="restore-snapshot" style="padding:0.45rem 1.1rem;font-weight:700;margin:0;">
                ↩️ 回到上一步（復原分組狀態）
              </button>
            </div>
          ` : ''}

        </div>
      </div>

    </div>

    <!-- 勾選要刪除的分組組別 -->
    ${c.groups.length ? `
      <div class="select-del-groups-box" style="margin-top:1.5rem;padding:1.2rem;background:#fffaf0;border:1.5px solid #fdebd0;border-radius:8px;">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.5rem;margin-bottom:0.75rem;">
          <strong style="color:#d35400;">🗑️ 勾選刪除特定分組組別</strong>
          <div style="display:flex;gap:0.5rem;">
            <button class="tab-btn" type="button" data-act="select-all-del-groups">全選</button>
            <button class="tab-btn" type="button" data-act="unselect-all-del-groups">取消全選</button>
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
                      : isGroupEditActive ? '<span class="status-badge can-edit">開放挑選中</span>'
                      : '<span class="status-badge under-threshold">已逾專屬截止時間</span>'}
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
      <h2>修課名單</h2>
      <div class="form-group">
        <label>匯入文字檔 .txt / .csv（每行：學號 姓名）</label>
        <input type="file" accept=".txt,.csv" data-act="import-file">
        <div class="file-path">格式範例：<code>410123 王小明</code> 或 <code>410123,王小明</code>；標題列（學號 / 姓名）會自動略過。</div>
      </div>
      <form data-act="add-student" class="form-row">
        <div class="form-group"><label>學號 ID</label><input name="id" required></div>
        <div class="form-group"><label>姓名</label><input name="name" required></div>
        <div class="form-group full"><button class="btn btn-primary" type="submit">新增學生</button></div>
      </form>
      ${rosterTable(c)}
    </div>

    <div class="teacher-section unassigned-panel">
      <h2>未分組名單（${total - assigned}）</h2>
      ${unassignedList(c)}
    </div>
  </div>

  <!-- 最新異動動態預覽卡片 -->
  <div class="teacher-section logs-preview-box" style="margin-top:2rem;">
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.5rem;margin-bottom:0.75rem;">
      <h2 style="margin:0;font-size:1.2rem;">📜 最新分組異動紀錄</h2>
      <button class="btn btn-secondary" data-act="view-course-logs" style="padding:0.35rem 0.85rem;font-size:0.85rem;margin:0;">
        查看完整分組異動日誌 →
      </button>
    </div>
    ${groupLogs.length ? `
      <div class="table-wrap">
        <table class="roster" style="background:#fff;margin:0;">
          <thead>
            <tr>
              <th style="width:150px;">時間</th>
              <th style="width:120px;">類別</th>
              <th style="width:140px;">操作者</th>
              <th>詳細異動說明</th>
            </tr>
          </thead>
          <tbody>
            ${groupLogs.slice(0, 5).map(l => `
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
    case 'restore-group': return '恢復原始組別';
    case 'auto-assign': return '系統自動分配未分組';
    case 'attendance-mark': return '組長/副組長點名標記';
    case 'attendance-correct': return '組長/副組長修正點名';
    case 'attendance-session-save': return '老師設定點名時段';
    case 'attendance-session-delete': return '老師刪除點名時段';
    case 'attendance-unlock': return '老師開放/關閉點名補登';
    case 'attendance-delegate': return '老師指派/取消跨組代理點名';
    case 'attendance-revoke': return '老師撤銷缺曠紀錄';
    case 'attendance-teacher-edit': return '老師修改點名紀錄';
    case 'password-change': return '學生修改密碼';
    case 'password-reset': return '老師重設學生密碼';
    case 'survey-period-set': return '老師設定問卷時段';
    case 'survey-submit': return '學生填寫/修改問卷';
    case 'survey-edit': return '老師修改學生問卷';
    case 'survey-delete': return '老師刪除學生問卷';
    case 'survey-logs-clear':
    case 'survey-logs-clear-all': return '老師清除問卷日誌';
    case 'survey-absence-config': return '老師設定缺曠輔導門檻';
    case 'survey-absence-create': return '老師新增缺曠原因調查';
    case 'survey-absence-update': return '老師更新缺曠原因調查';
    case 'survey-absence-delete': return '老師刪除缺曠原因調查';
    case 'survey-absence-submit': return '學生填寫/修改缺曠原因';
    case 'survey-absence-response-delete': return '老師刪除缺曠原因填寫';
    case 'survey-layout': return '老師調整問卷卡片排序/顯示';
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
    case 'restore-group':
      return '<span class="log-badge tag-teacher">🔄 恢復組別</span>';
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
    case 'attendance-revoke':
      return '<span class="log-badge tag-teacher">↩️ 撤銷缺曠</span>';
    case 'attendance-teacher-edit':
      return '<span class="log-badge tag-teacher">✏️ 老師修改點名</span>';
    case 'password-change':
    case 'password-reset':
      return '<span class="log-badge tag-vice">🔑 密碼變更</span>';
    default:
      if (type.startsWith('teacher') || ['make-groups', 'make-remaining-groups', 'clear-groups', 'restore-snapshot', 'del-groups', 'add-group', 'toggle-group-edit', 'restore-group'].includes(type)) {
        return '<span class="log-badge tag-teacher">🛠️ 老師操作</span>';
      }
      return `<span class="log-badge">${esc(type)}</span>`;
  }
}

/* 異動日誌依管理區分類：點名、問卷各自歸入其管理頁，其餘（分組、組長、老師調整、密碼、系統）歸入分組管理 */
function logCategoryOf(type) {
  const t = String(type || '');
  if (t.startsWith('attendance')) return 'attendance';
  if (t.startsWith('survey')) return 'survey';
  return 'group';
}

const GROUP_TEACHER_TYPES = ['make-groups', 'make-remaining-groups', 'clear-groups', 'restore-snapshot', 'del-groups', 'add-group', 'toggle-group-edit', 'restore-group'];
/* 各分類下的細項篩選：[值, 標籤, 判斷式] */
const LOG_SUB_FILTERS = {
  group: [
    ['pick', '＋ 組長加入組員', t => t === 'pick'],
    ['drop', '－ 組長釋出組員', t => t === 'drop'],
    ['leader', '👑 組長/副組長身分變更', t => ['claim-leader', 'unclaim-leader', 'toggle-vice', 'peer-eval'].includes(t)],
    ['teacher', '🛠️ 老師管理調整', t => t.startsWith('teacher') || GROUP_TEACHER_TYPES.includes(t)],
    ['system', '🤖 系統自動處理', t => ['auto-assign', 'deadline-dissolve', 'restore-group'].includes(t)],
    ['password', '🔑 密碼變更', t => t.startsWith('password')],
  ],
  attendance: [
    ['mark', '📋 組長/副組長點名', t => t === 'attendance-mark' || t === 'attendance-correct'],
    ['revoke', '↩️ 老師撤銷缺曠／修改點名', t => t === 'attendance-revoke' || t === 'attendance-teacher-edit'],
    ['admin', '🛠️ 老師點名設定', t => ['attendance-session-save', 'attendance-session-delete', 'attendance-unlock', 'attendance-delegate'].includes(t)],
  ],
  survey: [],
};
const LOG_PANEL_META = {
  group: {
    title: '📜 分組異動日誌',
    desc: '記載組長加入/釋出組員、身分設定、密碼變更、老師分組調整與系統自動分配等操作歷程。',
    empty: '當組長挑選、釋出組員或老師調整分組時，系統將自動於此留下操作歷程。',
    file: '分組異動日誌',
  },
  attendance: {
    title: '📜 點名異動日誌',
    desc: '記載組長/副組長點名與修正、老師撤銷缺曠、點名時段設定、補登開放與跨組代理等操作歷程。',
    empty: '當組長或副組長點名、或老師調整點名設定時，系統將自動於此留下操作歷程。',
    file: '點名異動日誌',
  },
  survey: {
    title: '📜 問卷設定異動日誌',
    desc: '記載老師設定問卷開放時段、清除問卷日誌等管理操作（學生填寫與修改內容請見上方「問卷異動日誌」分頁）。',
    empty: '當老師調整問卷開放時段或清除問卷日誌時，系統將自動於此留下操作歷程。',
    file: '問卷設定異動日誌',
  },
};

function activityLogPanel(c, category) {
  const meta = LOG_PANEL_META[category];
  if (!c) {
    return `
    <div class="teacher-section">
      <h2>${meta.title}</h2>
      <p class="file-path">請先從左側點選或建立課程，即可檢視該課程的異動日誌。</p>
    </div>`;
  }

  // 若尚未按需載入該課程日誌，自動觸發非同步載入
  if (!fullLogsByCourse[c.id] && !logsLoading) {
    setTimeout(() => loadCourseLogs(c.id), 0);
  }

  const logs = (fullLogsByCourse[c.id] || c.logs || []).filter(l => logCategoryOf(l.actionType) === category);
  const subFilters = LOG_SUB_FILTERS[category];
  const activeSub = subFilters.find(f => f[0] === logActionFilter);
  const todayCount = logs.filter(l => isSameDay(l.createdAt, Date.now())).length;

  const kw = (logSearchText || '').trim().toLowerCase();
  const filtered = logs.filter(l => {
    if (activeSub && !activeSub[2](l.actionType)) return false;
    if (kw) {
      const matchText = `${l.detail} ${l.operatorName} ${l.operatorId} ${l.targetName} ${l.targetId} ${l.groupName} ${formatLogTime(l.createdAt)}`.toLowerCase();
      if (!matchText.includes(kw)) return false;
    }
    return true;
  });
  const isFiltering = !!(kw || activeSub);
  const { rows: pageRows, pager } = paginate('log-' + category, filtered);

  return `
  <div class="teacher-section logs-admin-box">
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:1rem;margin-bottom:1.2rem;">
      <div>
        <h2 style="margin:0;">${meta.title} <small>${esc(courseLabel(c))}</small></h2>
        <p class="file-path" style="margin:0.25rem 0 0 0;">${meta.desc}</p>
      </div>
      <div style="display:flex;gap:0.5rem;flex-wrap:wrap;">
        <button class="btn btn-secondary" data-act="refresh-course-logs" style="padding:0.45rem 0.9rem;font-size:0.85rem;margin:0;" ${logsLoading ? 'disabled' : ''}>
          ${logsLoading ? '⏳ 載入中...' : '🔄 重新整理日誌'}
        </button>
        <button class="btn btn-success" data-act="export-logs-csv" data-category="${category}" style="padding:0.45rem 0.9rem;font-size:0.85rem;margin:0;" ${logs.length ? '' : 'disabled'}>
          📥 匯出${meta.file} CSV
        </button>
        <button class="btn btn-danger" data-act="clear-course-logs" data-category="${category}" style="padding:0.45rem 0.9rem;font-size:0.85rem;margin:0;" ${logs.length ? '' : 'disabled'}>
          🗑️ 清空${meta.file}
        </button>
      </div>
    </div>

    ${logsLoading ? `
      <div style="background:#eff6ff;border:1px solid #bfdbfe;color:#1e40af;padding:0.6rem 0.9rem;border-radius:8px;margin-bottom:1.2rem;font-size:0.86rem;">
        ⏳ 正在向伺服器載入本課程完整異動紀錄...
      </div>` : ''}

    <!-- 統計指標卡片 -->
    <div class="stats" style="margin:0 0 1.5rem 0;">
      <div class="stat"><div class="value">${logs.length}</div><div class="label">總異動筆數</div></div>
      ${subFilters.slice(0, 2).map((f, i) => `<div class="stat"><div class="value" style="color:${i ? '#dc2626' : '#16a34a'};">${logs.filter(l => f[2](l.actionType)).length}</div><div class="label">${f[1].replace(/^\S+\s/, '')}</div></div>`).join('')}
      <div class="stat"><div class="value" style="color:#2563eb;">${todayCount}</div><div class="label">今日最新異動</div></div>
    </div>

    <!-- 搜尋與過濾列 -->
    <div class="logs-filter-bar" style="display:flex;align-items:center;gap:0.75rem;flex-wrap:wrap;background:#f8fafc;padding:0.85rem 1rem;border:1px solid #e2e8f0;border-radius:8px;margin-bottom:1rem;">
      <div style="display:flex;align-items:center;gap:0.4rem;">
        <label style="font-weight:600;font-size:0.85rem;color:#475569;">🔍 搜尋：</label>
        <input type="text" data-act="search-logs" value="${esc(logSearchText)}" placeholder="輸入姓名、學號、組別或關鍵字..." style="padding:0.35rem 0.6rem;font-size:0.85rem;border:1px solid #cbd5e1;border-radius:4px;width:240px;">
      </div>
      ${subFilters.length ? `
      <div style="display:flex;align-items:center;gap:0.4rem;">
        <label style="font-weight:600;font-size:0.85rem;color:#475569;">類別篩選：</label>
        <select data-act="filter-log-action" style="padding:0.35rem 0.6rem;font-size:0.85rem;border:1px solid #cbd5e1;border-radius:4px;background:#fff;">
          <option value="all" ${!activeSub ? 'selected' : ''}>全部動作類別（${logs.length}）</option>
          ${subFilters.map(f => `<option value="${f[0]}" ${activeSub && activeSub[0] === f[0] ? 'selected' : ''}>${f[1]}（${logs.filter(l => f[2](l.actionType)).length}）</option>`).join('')}
        </select>
      </div>` : ''}
      ${isFiltering ? `
        <button class="tab-btn" data-act="reset-log-filter" style="padding:0.3rem 0.6rem;font-size:0.8rem;margin-left:auto;">
          重設篩選
        </button>
      ` : ''}
      <span style="font-size:0.82rem;color:#64748b;margin-left:${isFiltering ? '0' : 'auto'};">
        顯示 ${filtered.length} / 共 ${logs.length} 筆
      </span>
    </div>

    <!-- 日誌資料表 -->
    ${filtered.length ? `
    <div class="table-wrap">
      <table class="roster logs-table" style="background:#fff;">
        <thead>
          <tr>
            <th style="width:150px;">時間</th>
            <th style="width:120px;">動作類別</th>
            <th style="width:130px;">操作者</th>
            <th style="width:95px;">相關組別</th>
            <th style="width:125px;">對象學生</th>
            <th>詳細異動說明</th>
          </tr>
        </thead>
        <tbody>
          ${pageRows.map(l => `
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
    </div>
    ${pager}` : `
    <div style="text-align:center;padding:3rem 1rem;background:#f8fafc;border:1px dashed #cbd5e1;border-radius:8px;color:#64748b;">
      <p style="font-size:1.1rem;margin-bottom:0.5rem;">📭 目前無符合條件的異動紀錄</p>
      <p style="font-size:0.85rem;margin:0;">
        ${logs.length ? '請嘗試更換搜尋關鍵字或調整篩選類別。' : meta.empty}
      </p>
    </div>`}
  </div>`;
}

/* ===== 後台：點名管理 ===== */
function teacherAttendanceBlock(c) {
  if (!c) {
    return `
    <div class="teacher-section">
      <h2>📋 點名管理</h2>
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
    ↩️ <b>撤銷缺曠</b>：於下方「組員缺席排行榜」點選缺席次數即可檢視明細，並可逐筆撤銷缺曠紀錄（改為出席），撤銷動作會記錄於本頁最下方的點名異動日誌。<br>
    📌 <b>重要集會／額外點名</b>：若遇重要集會、系週會、成果展示或期中報告，老師可使用下方表單新增點名時段並<b>加註點名名稱</b>，組長或副組長將於前台專區進行額外點名。超過當天需老師於操作欄開放補登權限才能修改。
  </div>`;

  const sessionForm = `
    <form data-act="save-attendance-session" class="form-row" style="background:#fff;padding:1rem;border:1px solid #e2e8f0;border-radius:8px;margin-bottom:1rem;">
      <div style="width:100%;margin-bottom:0.4rem;font-weight:600;color:#1e293b;font-size:0.95rem;">
        ${editing ? '✏️ 編輯點名時段' : '➕ 新增重要集會／額外點名時段'}
      </div>
      <div class="form-group"><label>點名日期</label><input type="date" name="date" value="${esc(editing ? editing.date : today)}" required></div>
      <div class="form-group"><label>點名時段</label><input name="timeSlot" value="${esc(editing ? editing.timeSlot : '')}" placeholder="例如：第3-4節"></div>
      <div class="form-group"><label>點名名稱／重要集會備註</label><input name="name" value="${esc(editing ? editing.name : '')}" placeholder="例如：系週會、重要集會、期中專案報告"></div>
      <div class="form-group full">
        <button class="btn btn-primary" type="submit">${editing ? '儲存修改' : '新增重要集會時段'}</button>
        ${editing ? `<button class="btn btn-secondary" type="button" data-act="cancel-edit-attendance-session">取消編輯</button>` : ''}
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
          ? '<span class="status-badge can-edit">當日開放編輯</span>'
          : allUnlock
          ? `<span class="status-badge can-edit">已開放全部組別補登${allUnlock.deadline ? `（至 ${esc(allUnlock.deadline.replace('T', ' '))}）` : ''}</span>`
          : '<span class="status-badge is-locked">已鎖定</span>'}
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

  /* ---- 2. 依日期調閱／修改點名紀錄 ---- */
  if (!attendanceStatDate) attendanceStatDate = today;
  const dateSessions = sessions.filter(s => s.date === attendanceStatDate);
  // 該日若無一般日常點名，提供虛擬時段供老師補建紀錄
  if (!dateSessions.some(isDailySession)) {
    dateSessions.unshift({ id: `daily-${attendanceStatDate}`, date: attendanceStatDate, timeSlot: '', name: '一般日常點名', isDaily: true });
  }
  const editSession = dateSessions.find(s => s.id === attendanceEditSessionId) || dateSessions[0];
  const editRecs = {};
  attendanceRecordsFor(c, editSession.id).forEach(r => { editRecs[r.studentId] = r; });
  const statusSelect = (st, rec) => `
    <select data-act="teacher-set-attendance" data-session="${esc(editSession.id)}" data-student="${esc(st.id)}" style="padding:0.25rem 0.4rem;font-size:0.82rem;border-radius:6px;${rec ? (rec.status === 'absent' ? 'background:#fee2e2;color:#991b1b;' : 'background:#dcfce7;color:#166534;') : ''}">
      ${rec ? '' : '<option value="" selected>— 未點名 —</option>'}
      <option value="present" ${rec && rec.status === 'present' ? 'selected' : ''}>✅ 出席</option>
      <option value="absent" ${rec && rec.status === 'absent' ? 'selected' : ''}>❌ 缺席</option>
    </select>`;
  const editRows = c.groups.map(g => {
    const mates = members(c, g.id);
    if (!mates.length) return '';
    return mates.map((st, i) => {
      const rec = editRecs[st.id];
      return `
      <tr>
        ${i === 0 ? `<td rowspan="${mates.length}"><b>${esc(g.name)}</b></td>` : ''}
        <td>${esc(st.id)}</td>
        <td><b>${esc(st.name)}</b>${st.isLeader ? ' 👑' : st.isVice ? ' ⭐' : ''}</td>
        <td>${statusSelect(st, rec)}</td>
        <td style="font-size:0.8rem;color:#64748b;">${rec ? `${esc(rec.markedByName || '-')}／${esc(formatLogTime(rec.updatedAt))}` : '-'}</td>
      </tr>`;
    }).join('');
  }).join('');
  const attendanceEditPanel = `
  <div class="teacher-section">
    <h2>📅 依日期調閱／修改點名紀錄</h2>
    <p class="file-path" style="margin:0 0 0.75rem 0;">選擇日期與點名時段即可調閱各組點名結果，老師可直接修改任一學生的出缺席狀態（不受當日鎖定限制），每筆修改皆記錄於本頁下方點名異動日誌。</p>
    <div style="display:flex;align-items:center;gap:0.75rem;flex-wrap:wrap;margin-bottom:0.85rem;">
      <label style="font-weight:600;font-size:0.88rem;">日期：<input type="date" data-act="attendance-stat-date" value="${esc(attendanceStatDate)}" max="${esc(today)}" style="padding:0.3rem 0.5rem;"></label>
      <label style="font-weight:600;font-size:0.88rem;">時段：
        <select data-act="attendance-edit-session" style="padding:0.3rem 0.5rem;">
          ${dateSessions.map(s => `<option value="${esc(s.id)}" ${s.id === editSession.id ? 'selected' : ''}>${esc(attendanceSessionLabel(s) || s.date)}</option>`).join('')}
        </select>
      </label>
      <span style="font-size:0.82rem;color:#64748b;">已點名 ${Object.keys(editRecs).length} 人／缺席 ${Object.values(editRecs).filter(r => r.status === 'absent').length} 人</span>
    </div>
    ${editRows ? `
    <div class="table-wrap">
      <table class="roster" style="background:#fff;">
        <thead><tr><th>組別</th><th>學號</th><th>姓名</th><th>出缺席</th><th>最後點名者／時間</th></tr></thead>
        <tbody>${editRows}</tbody>
      </table>
    </div>` : '<p class="file-path">尚未建立組別或組員。</p>'}
  </div>`;

  /* ---- 3. 各組點名完成進度即時看板（含未完成組別與已完成組別） ---- */
  const progressSession = attendanceProgressSessionId
    ? sessions.find(s => s.id === attendanceProgressSessionId)
    : (sessions.find(s => s.date === today) || sessions[0] || null);
  const progress = progressSession ? attendanceGroupProgress(c, progressSession.id) : [];
  const incomplete = progress.filter(p => !p.complete && p.total > 0);
  const completed = progress.filter(p => p.complete && p.total > 0);

  /* ---- 4. 點名人員任務執行表現學期排行榜 ---- */
  const markerLeaderboard = calcRollCallPerformance(c);

  /* ---- 缺席關懷名單（整學期缺席次數超過門檻） ---- */
  const careList = careAbsenceList(c, careAbsenceThreshold);

  /* ---- 5. 組員缺席排行榜（支援每頁 15 筆分頁瀏覽） ---- */
  const counts = attendanceAbsentCounts(c, attendanceStatScope === 'date' ? attendanceStatDate : null);
  const leaderboardAll = Object.entries(counts)
    .map(([sid, n]) => {
      const matchingRec = (c.attendanceRecords || []).find(r => r.studentId === sid || r.ref === sid);
      const targetRef = matchingRec ? matchingRec.ref : sid;
      const targetSid = matchingRec ? matchingRec.studentId : sid;
      const st = c.students.find(x => x.id === targetSid || (targetRef && x.ref === targetRef) || x.id === sid || x.ref === sid);
      const g = st ? c.groups.find(x => x.id === st.groupId) : (matchingRec && matchingRec.groupId ? c.groups.find(x => x.id === matchingRec.groupId) : null);
      const studentName = (st && st.name) ? st.name : ((matchingRec && matchingRec.studentName) ? matchingRec.studentName : sid);
      const groupName = g ? g.name : ((matchingRec && matchingRec.groupName) ? matchingRec.groupName : '未分組');
      const displayId = targetSid || (st ? st.id : sid);
      return { id: displayId, name: studentName, groupName: groupName, count: n };
    })
    .sort((a, b) => b.count - a.count);

  const leaderboardPageSize = 15;
  const leaderboardTotalPages = Math.max(1, Math.ceil(leaderboardAll.length / leaderboardPageSize));
  if (attendanceLeaderboardPage > leaderboardTotalPages) attendanceLeaderboardPage = leaderboardTotalPages;
  if (attendanceLeaderboardPage < 1) attendanceLeaderboardPage = 1;

  const leaderboardStartIndex = (attendanceLeaderboardPage - 1) * leaderboardPageSize;
  const leaderboard = leaderboardAll.slice(leaderboardStartIndex, leaderboardStartIndex + leaderboardPageSize);

  return `
  <div class="teacher-section">
    <h2>📋 點名管理 <small>${esc(courseLabel(c))}</small></h2>
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

  ${attendanceEditPanel}

  <div class="teacher-section">
    <h2>目前組長／副組長列表</h2>
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

  <div class="teacher-section attendance-progress-dashboard">
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.75rem;">
      <h2 style="margin:0;">📊 各組點名完成進度即時看板</h2>
      <div style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;">
        <label style="font-weight:600;font-size:0.85rem;color:#334155;">選擇點名時段：</label>
        <select data-act="attendance-progress-session" style="font-weight:600;padding:0.35rem 0.6rem;border-radius:6px;border:1px solid #cbd5e1;">
          ${sessions.map(s => `<option value="${s.id}" ${progressSession && progressSession.id === s.id ? 'selected' : ''}>${esc(attendanceSessionLabel(s))}</option>`).join('') || '<option value="">尚無時段</option>'}
        </select>
      </div>
    </div>

    ${!progressSession ? '<p class="file-path" style="margin-top:1rem;">尚無點名時段。</p>' : `
      <!-- 進度統計總覽條 -->
      <div class="progress-summary-bar">
        <div style="display:flex;align-items:center;gap:0.6rem;flex-wrap:wrap;">
          <span style="font-size:0.92rem;font-weight:750;color:#1e293b;">時段：${esc(attendanceSessionLabel(progressSession))}</span>
          <span class="progress-badge badge-info">總組數：${c.groups.length} 組</span>
          <span class="progress-badge badge-success">🟢 已完成：${completed.length} 組 (${Math.round((completed.length / (c.groups.length || 1)) * 100)}%)</span>
          <span class="progress-badge ${incomplete.length ? 'badge-danger' : 'badge-neutral'}">🔴 未完成：${incomplete.length} 組</span>
        </div>
        <div class="progress-meter-container">
          <div class="progress-meter-fill" style="width:${Math.round((completed.length / (c.groups.length || 1)) * 100)}%;"></div>
        </div>
      </div>

      <!-- 1. 尚未完成點名之組別 -->
      <div class="progress-subpanel" style="margin-top:1.25rem;">
        <h3 style="font-size:1.05rem;color:#b91c1c;display:flex;align-items:center;gap:0.4rem;margin-bottom:0.6rem;">
          <span>🔴 尚未完成點名之組別（含組長與副組長姓名）</span>
        </h3>
        ${incomplete.length ? `
        <div class="table-wrap">
          <table class="roster" style="background:#fff;">
            <thead>
              <tr>
                <th style="min-width:80px;">組別</th>
                <th style="min-width:95px;">完成進度</th>
                <th style="min-width:140px;">組長姓名</th>
                <th style="min-width:140px;">副組長姓名</th>
                <th>尚未被點名的組員名單</th>
                <th style="min-width:210px;">跨組代理點名管理</th>
              </tr>
            </thead>
            <tbody>
              ${incomplete.map(p => {
                const delegates = (c.attendanceDelegates || []).filter(d => d.sessionId === progressSession.id && d.groupId === p.group.id);
                const candidates = c.students.filter(st => (st.isLeader || st.isVice) && st.groupId !== p.group.id);
                const leadStr = p.leader 
                  ? `<b>👑 ${esc(p.leader.name)}</b> <small style="color:#64748b;">(${esc(p.leader.id)})</small>`
                  : `<span style="color:#dc2626;">（無組長）</span>`;
                const viceStr = p.vice 
                  ? `<b>⭐ ${esc(p.vice.name)}</b> <small style="color:#64748b;">(${esc(p.vice.id)})</small>`
                  : `<span style="color:#94a3b8;">（無副組長）</span>`;
                return `
                <tr>
                  <td><b>${esc(p.group.name)}</b></td>
                  <td><span class="status-badge under-threshold">${p.done} / ${p.total} 人</span></td>
                  <td>${leadStr}</td>
                  <td>${viceStr}</td>
                  <td>
                    <div style="display:flex;flex-wrap:wrap;gap:0.35rem;">
                      ${p.missing.map(m => `<span class="attendance-absent-tag">${esc(m.name)} <small>(${esc(m.id)})</small>${m.isLeader ? ' <b style="color:#b91c1c;">組長</b>' : m.isVice ? ' <b style="color:#d97706;">副組長</b>' : ''}</span>`).join('')}
                    </div>
                  </td>
                  <td>
                    ${delegates.map(d => `
                      <div style="display:flex;align-items:center;gap:0.35rem;margin-bottom:0.3rem;font-size:0.82rem;">
                        <span class="group-name-tag">🔁 ${esc(d.delegateName || d.delegateId)}</span>
                        <button class="tab-btn" data-act="remove-attendance-delegate" data-session="${progressSession.id}" data-group="${p.group.id}" data-delegate="${esc(d.delegateId)}">移除</button>
                      </div>`).join('')}
                    <select data-act="assign-attendance-delegate" data-session="${progressSession.id}" data-group="${p.group.id}" style="font-size:0.8rem;padding:0.3rem 0.4rem;width:100%;">
                      <option value="">指派代理組長/副組長跨組點名…</option>
                      ${candidates.map(st => `<option value="${esc(st.id)}">${esc(st.name)} (${esc(st.id)}) － ${esc((c.groups.find(gg => gg.id === st.groupId) || {}).name || '')}</option>`).join('')}
                    </select>
                  </td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>` : '<div class="alert-box success-alert" style="padding:0.85rem 1rem;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;color:#166534;font-weight:600;">🎉 該時段所有組別之全部組員皆已完成點名！</div>'}
      </div>

      <!-- 2. 已完成點名之組別 -->
      <div class="progress-subpanel" style="margin-top:1.5rem;">
        <h3 style="font-size:1.05rem;color:#166534;display:flex;align-items:center;gap:0.4rem;margin-bottom:0.6rem;">
          <span>🟢 已完成點名之組別（含點名人員姓名、學號、身分與完成時間）</span>
        </h3>
        ${completed.length ? `
        <div class="table-wrap">
          <table class="roster" style="background:#fff;">
            <thead>
              <tr>
                <th style="min-width:80px;">組別</th>
                <th style="min-width:95px;">點名進度</th>
                <th style="min-width:180px;">執行點名人員（姓名／學號）</th>
                <th style="min-width:110px;">執行身分角色</th>
                <th style="min-width:160px;">點名完成時間</th>
              </tr>
            </thead>
            <tbody>
              ${completed.map(p => {
                const marker = p.marker;
                const markerDisplay = marker
                  ? `<b>${esc(marker.name)}</b> <small style="color:#64748b;">(${esc(marker.id || '未知學號')})</small>`
                  : (p.leader ? `<b>${esc(p.leader.name)}</b> <small style="color:#64748b;">(${esc(p.leader.id)})</small>` : '<span style="color:#94a3b8;">（未記錄執行者）</span>');
                const roleDisplay = marker
                  ? `<span class="role-badge role-${marker.role === '組長' ? 'leader' : marker.role === '副組長' ? 'vice' : marker.role === '老師' ? 'teacher' : 'delegate'}">${esc(marker.roleBadge || marker.role)}</span>`
                  : (p.leader ? `<span class="role-badge role-leader">👑 組長</span>` : '<span style="color:#94a3b8;">—</span>');
                const timeDisplay = p.completedAt
                  ? `<span style="font-size:0.85rem;color:#334155;font-weight:600;">🕒 ${esc(formatLogTime(p.completedAt))}</span>`
                  : '<span style="color:#94a3b8;">—</span>';
                return `
                <tr>
                  <td><b>${esc(p.group.name)}</b></td>
                  <td><span class="status-badge" style="background:#dcfce7;color:#15803d;font-weight:700;">✅ ${p.done} / ${p.total} 全員完成</span></td>
                  <td>${markerDisplay}</td>
                  <td>${roleDisplay}</td>
                  <td>${timeDisplay}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>` : '<div class="alert-box neutral-alert" style="padding:0.85rem 1rem;background:#fef2f2;border:1px solid #fecaca;border-radius:6px;color:#991b1b;">該時段尚無組別完成點名。</div>'}
      </div>
    `}
  </div>

  <div class="teacher-section marker-leaderboard-section">
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.75rem;margin-bottom:0.75rem;">
      <div>
        <h2 style="margin:0;">🏆 各組點名人員任務執行表現學期排行榜</h2>
        <p style="margin:0.25rem 0 0;font-size:0.83rem;color:#64748b;">
          統計整學期各組負責點名幹部（組長、副組長、代理人）的任務執行表現。評比指標：<b>點名完成次數</b>（越多次越好）、<b>搶先第一完成次數</b>、以及<b>平均點名時刻</b>（越早完成越好）。
        </p>
      </div>
      <div>
        <button class="primary-btn" data-act="export-marker-leaderboard-csv" style="display:flex;align-items:center;gap:0.35rem;padding:0.45rem 0.85rem;font-size:0.85rem;font-weight:600;">
          📥 匯出表現排行榜 CSV
        </button>
      </div>
    </div>

    ${markerLeaderboard.length ? `
    <div class="table-wrap">
      <table class="roster marker-leaderboard-table" style="background:#fff;">
        <thead>
          <tr>
            <th style="min-width:65px;text-align:center;">名次</th>
            <th style="min-width:140px;">執行點名人員</th>
            <th style="min-width:90px;">所屬組別</th>
            <th style="min-width:90px;">身分角色</th>
            <th style="min-width:130px;text-align:center;">累計點名完成組次</th>
            <th style="min-width:110px;text-align:center;">最速完成次數</th>
            <th style="min-width:120px;text-align:center;">平均點名時刻</th>
            <th style="min-width:150px;">最近點名時間</th>
            <th style="min-width:150px;">表現稱號</th>
          </tr>
        </thead>
        <tbody>
          ${markerLeaderboard.map(item => `
          <tr class="${item.rank <= 3 ? `top-rank-row rank-${item.rank}` : ''}">
            <td style="text-align:center;font-weight:700;font-size:1rem;">
              ${item.medal ? `<span class="medal-badge">${item.medal} 第${item.rank}名</span>` : `<span style="color:#64748b;">第 ${item.rank} 名</span>`}
            </td>
            <td>
              <b>${esc(item.name)}</b>
              <div style="font-size:0.75rem;color:#64748b;">學號：${esc(item.id || '—')}</div>
            </td>
            <td><b>${esc(item.group)}</b></td>
            <td>
              <span class="role-badge role-${item.role === '組長' ? 'leader' : item.role === '副組長' ? 'vice' : item.role === '老師' ? 'teacher' : 'delegate'}">
                ${item.role === '組長' ? '👑 組長' : item.role === '副組長' ? '⭐ 副組長' : item.role === '老師' ? '👨‍🏫 老師' : '🔁 代理'}
              </span>
            </td>
            <td style="text-align:center;">
              <span class="marker-count-pill" title="累計為組員留下 ${item.recordsCount} 筆點名紀錄">
                🎯 <b>${item.sessionsCount}</b> 場次
              </span>
              <div style="font-size:0.72rem;color:#64748b;margin-top:2px;">(${item.recordsCount} 人次)</div>
            </td>
            <td style="text-align:center;">
              ${item.fastestCount > 0 ? `<span class="fastest-pill">⚡ ${item.fastestCount} 次第一</span>` : `<span style="color:#94a3b8;">—</span>`}
            </td>
            <td style="text-align:center;">
              ${item.avgTimeStr !== '--:--' ? `<span class="avg-time-pill" title="換算台灣時間 UTC+8 之平均完成時刻">🕒 <b>${item.avgTimeStr}</b></span>` : `<span style="color:#94a3b8;">—</span>`}
            </td>
            <td style="font-size:0.8rem;color:#475569;">
              ${item.latestTimeFormatted ? esc(item.latestTimeFormatted) : '—'}
            </td>
            <td>
              <span class="title-badge">${esc(item.titleBadge)}</span>
            </td>
          </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
    ` : '<p class="file-path">目前整學期尚無點名執行紀錄。</p>'}
  </div>

  <div class="teacher-section">
    <h2>💌 缺席關懷 <small>準備導師 LINE 關心訊息</small></h2>
    <div style="display:flex;align-items:center;justify-content:space-between;gap:0.5rem;flex-wrap:wrap;margin-bottom:0.75rem;">
      <label style="font-size:0.9rem;color:#475569;">整學期缺席超過
        <input type="number" min="0" max="99" value="${careAbsenceThreshold}" data-act="care-absence-threshold" style="width:4.5rem;margin:0 0.25rem;"> 次的學生（共 <b>${careList.length}</b> 位）
      </label>
      ${careList.length ? `<button class="btn btn-primary btn-sm" type="button" data-act="copy-all-care-messages" style="margin:0;">📋 一鍵複製全部關懷訊息</button>` : ''}
    </div>
    ${careList.length ? `
    <div class="table-wrap">
      <table class="roster" style="background:#fff;">
        <thead><tr><th>學號</th><th>姓名</th><th>組別</th><th style="text-align:center;">缺席次數</th><th>最近缺席</th><th>關懷訊息</th></tr></thead>
        <tbody>${careList.map(x => `
          <tr>
            <td>${esc(x.id)}</td>
            <td><b>${esc(x.name)}</b></td>
            <td>${esc(x.groupName)}</td>
            <td style="text-align:center;">
              <button class="absent-count-badge" data-act="view-absence-detail" data-student="${esc(x.key)}" data-name="${esc(x.name)}" data-id="${esc(x.id)}" title="點選查看缺席日期與對應活動明細">⚠️ ${x.count} 次</button>
            </td>
            <td>${esc(x.lastDate)}</td>
            <td>
              <button class="btn btn-sm" type="button" data-act="copy-care-message" data-student="${esc(x.key)}" style="margin:0;">💬 複製 LINE 訊息</button>
              <details style="margin-top:0.35rem;"><summary style="cursor:pointer;font-size:0.8rem;color:#64748b;">預覽</summary>
                <pre class="care-message-preview" style="white-space:pre-wrap;font-family:inherit;font-size:0.8rem;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:0.5rem;margin:0.35rem 0 0;max-width:28rem;">${esc(careMessageText(c, x))}</pre>
              </details>
            </td>
          </tr>`).join('')}</tbody>
      </table>
    </div>` : `<p class="file-path">目前沒有整學期缺席超過 ${careAbsenceThreshold} 次的學生。</p>`}
  </div>

  <div class="teacher-section">
    <h2>組員缺席排行榜</h2>
    <div style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;margin-bottom:0.75rem;">
      <select data-act="attendance-stat-scope">
        <option value="all" ${attendanceStatScope === 'all' ? 'selected' : ''}>整個學期（Cả học kỳ）</option>
        <option value="date" ${attendanceStatScope === 'date' ? 'selected' : ''}>依日期（${esc(attendanceStatDate || todayDateStr())}）</option>
      </select>
    </div>
    ${leaderboard.length ? `
    <div class="table-wrap">
      <table class="roster" style="background:#fff;">
        <thead><tr><th>排名</th><th>學號</th><th>姓名</th><th>組別</th><th style="text-align:center;">缺席次數</th></tr></thead>
        <tbody>${leaderboard.map((l, i) => {
          const rank = leaderboardStartIndex + i + 1;
          return `
          <tr>
            <td><span style="font-weight:700;color:${rank === 1 ? '#b91c1c' : rank === 2 ? '#ea580c' : rank === 3 ? '#d97706' : '#64748b'};">${rank}</span></td>
            <td>${esc(l.id)}</td>
            <td><b>${esc(l.name)}</b></td>
            <td>${esc(l.groupName)}</td>
            <td style="text-align:center;">
              <button class="absent-count-badge" data-act="view-absence-detail" data-student="${esc(l.id)}" data-name="${esc(l.name)}" data-id="${esc(l.id)}" title="點選查看缺席日期與對應活動明細">
                ⚠️ ${l.count} 次
              </button>
            </td>
          </tr>`;
        }).join('')}</tbody>
      </table>
    </div>
    ${leaderboardAll.length > leaderboardPageSize ? `
    <div class="leaderboard-pagination" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.75rem;padding:0.75rem 0.25rem 0.25rem;border-top:1px solid #f1f5f9;margin-top:0.75rem;">
      <div style="font-size:0.85rem;color:#64748b;">
        顯示第 <b>${leaderboardStartIndex + 1} - ${Math.min(leaderboardStartIndex + leaderboardPageSize, leaderboardAll.length)}</b> 名（共 <b>${leaderboardAll.length}</b> 名缺席組員，頁次 <b>${attendanceLeaderboardPage} / ${leaderboardTotalPages}</b>）
      </div>
      <div style="display:flex;align-items:center;gap:0.35rem;flex-wrap:wrap;">
        <button class="pagination-btn" data-act="set-attendance-leaderboard-page" data-page="${attendanceLeaderboardPage - 1}" ${attendanceLeaderboardPage <= 1 ? 'disabled style="opacity:0.4;cursor:not-allowed;"' : ''}>
          ◀ 上一頁
        </button>
        ${Array.from({ length: leaderboardTotalPages }, (_, idx) => idx + 1).map(p => `
          <button class="pagination-page-btn ${p === attendanceLeaderboardPage ? 'active' : ''}" data-act="set-attendance-leaderboard-page" data-page="${p}" style="${p === attendanceLeaderboardPage ? 'font-weight:750;background:#3b82f6;color:#fff;border-color:#3b82f6;' : ''}">
            ${p}
          </button>
        `).join('')}
        <button class="pagination-btn" data-act="set-attendance-leaderboard-page" data-page="${attendanceLeaderboardPage + 1}" ${attendanceLeaderboardPage >= leaderboardTotalPages ? 'disabled style="opacity:0.4;cursor:not-allowed;"' : ''}>
          下一頁 ▶
        </button>
      </div>
    </div>` : ''}
    ` : '<p class="file-path">目前無缺席紀錄。</p>'}
  </div>`;
}

function teacherPasswordBlock(c) {
  const leaders = c ? c.students.filter(s => s.isLeader || s.isVice) : [];

  return `
  <div class="teacher-section">
    <h2>更改管理者密碼</h2>
    <form data-act="change-password" class="pw-form">
      <div class="form-group"><label>目前密碼</label><input type="password" name="current" required autocomplete="off"></div>
      <div class="form-group"><label>新密碼（至少 4 碼）</label><input type="password" name="next" required minlength="4" autocomplete="off"></div>
      <button class="btn btn-primary" type="submit">更新密碼</button>
    </form>
    <p class="file-path">更換老師管理後台密碼。預設密碼為 admin。</p>
  </div>

  <div class="teacher-section" style="margin-top:2rem;">
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.5rem;margin-bottom:0.75rem;">
      <h2 style="margin:0;">🔑 各組組長與副組長密碼管理</h2>
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
              <th>組別</th>
              <th>職位</th>
              <th>學號</th>
              <th>姓名</th>
              <th>密碼狀態</th>
              <th style="width:210px;">密碼管理操作</th>
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
  if (!c.students.length) return '<p class="file-path">尚無學生。</p>';
  const opts = s => ['<option value="">未分組 —</option>']
    .concat(c.groups.map(g => `<option value="${g.id}" ${s.groupId === g.id ? 'selected' : ''}>${esc(g.name)}</option>`))
    .join('');
  return `<div class="table-wrap"><table class="roster">
    <thead><tr><th>學號</th><th>姓名</th><th>組別</th><th>組長</th><th>期末考調分</th><th>動作</th></tr></thead>
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
          <button class="tab-btn" data-act="simulate-student" data-id="${esc(s.id)}" title="轉換身分以此學生登入測試問卷與系統" style="margin-right:0.35rem;">🧪 模擬</button>
          ${isLeadOrVice ? `<button class="tab-btn" data-act="teacher-manage-student-pw" data-id="${esc(s.id)}" data-name="${esc(s.name)}" data-has-custom="${s.hasCustomPassword ? '1' : '0'}" title="協助修改或重設密碼" style="margin-right:0.35rem;">🔑 密碼</button>` : ''}
          <button class="tab-btn" data-act="del-student" data-id="${esc(keyOf(s))}">刪除</button>
        </td>
      </tr>`;
    }).join('')}
    </tbody></table></div>`;
}

/* ===== 生活關懷問卷模組 Student Wellbeing Survey Module ===== */

function copyTextToClipboard(text, successMsg) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => {
      alert(successMsg);
    }).catch(() => {
      fallbackCopy(text, successMsg);
    });
  } else {
    fallbackCopy(text, successMsg);
  }
}

function fallbackCopy(text, successMsg) {
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    alert(successMsg);
  } catch (err) {
    prompt('請手動複製以下名單：', text);
  }
  document.body.removeChild(ta);
}

function getSurveyStatus(c) {
  if (!c) return { status: 'not_set', label: '尚未開放<small class="vn-sub">Chưa mở</small>', badgeClass: 'is-locked', timeDesc: '尚未設定時段', isOpen: false };
  const start = c.surveyStart || '';
  const end = c.surveyEnd || '';
  const now = Date.now();
  if (start && now < parseDate(start)) {
    return {
      status: 'not_started',
      label: '⏳ 尚未開始<small class="vn-sub">Chưa mở</small>',
      badgeClass: 'under-threshold',
      timeDesc: `開放時間：${start.replace('T', ' ')}`,
      isOpen: false,
    };
  }
  if (end && now > parseDate(end)) {
    return {
      status: 'ended',
      label: '🔒 已截止<small class="vn-sub">Đã đóng</small>',
      badgeClass: 'is-locked',
      timeDesc: `截止時間：${end.replace('T', ' ')}`,
      isOpen: false,
    };
  }
  let desc = '不限期開放（永久開放）';
  if (start && end) desc = `${start.replace('T', ' ')} ~ ${end.replace('T', ' ')}`;
  else if (end) desc = `至 ${end.replace('T', ' ')} 截止`;
  else if (start) desc = `自 ${start.replace('T', ' ')} 起開放`;

  return {
    status: 'open',
    label: '🟢 開放填寫中<small class="vn-sub">Đang mở</small>',
    badgeClass: 'can-edit',
    timeDesc: desc,
    isOpen: true,
  };
}

function getSurveyStats(c) {
  if (!c || !c.students) return { total: 0, completed: 0, uncompleted: 0, percent: 0, uncompletedList: [], submissions: [], categoryCounts: {} };
  const total = c.students.length;
  const isTeacher = state.session && state.session.role === 'teacher';
  const uncompletedList = [];
  let completed = 0;
  const categoryCounts = {};

  const subMap = new Map();
  if (isTeacher && c.surveySubmissions) {
    c.surveySubmissions.forEach(sub => {
      subMap.set(sub.studentId, sub);
      const cat = sub.category || '其他 (Khác)';
      categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
    });
  }

  c.students.forEach(s => {
    const isComp = isTeacher
      ? subMap.has(s.id)
      : !!s.surveyCompleted;

    if (isComp) {
      completed++;
    } else {
      const g = s.groupId ? c.groups.find(x => x.id === s.groupId) : null;
      const leader = g ? c.students.find(x => x.groupId === g.id && x.isLeader) : null;
      uncompletedList.push({
        id: s.id,
        ref: s.ref || '',
        name: s.name,
        groupId: s.groupId || '',
        groupName: g ? g.name : '未分組',
        leaderName: leader ? `${leader.name} (${leader.id})` : '（無組長）',
        rawLeaderName: leader ? leader.name : '',
      });
    }
  });

  // 仿照組員缺席排行榜，以學號進行升冪方式排序顯示
  uncompletedList.sort((a, b) =>
    String(a.id).localeCompare(String(b.id), undefined, { numeric: true, sensitivity: 'base' })
  );

  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
  return {
    total,
    completed,
    uncompleted: total - completed,
    percent,
    uncompletedList,
    submissions: c.surveySubmissions || [],
    categoryCounts,
  };
}

function renderCategoryBadge(category) {
  if (!category) return '<span class="status-badge" style="background:#f1f5f9;color:#64748b;">未填寫</span>';
  const meta = SURVEY_CATEGORY_META[category] || { icon: '💬', color: '#64748b' };
  return `<span class="survey-cat-badge" style="border-left: 3px solid ${meta.color};">
    <span class="cat-icon">${meta.icon}</span>
    <span class="cat-text">${esc(category)}</span>
  </span>`;
}

function studentSurveyPanel(c, s) {
  if (!c || !s) return '';
  const mySub = c.mySurvey;
  const isSubmitted = !!mySub;
  const status = getSurveyStatus(c);
  const isEditable = status.isOpen;
  const currentCategory = mySub ? mySub.category : '';
  const currentContent = mySub ? mySub.content : '';

  // 依照主題分組面向
  const groups = {
    '課業與學習 (Học tập & Bài vở)': [
      '課程內容 (Nội dung khóa học)',
      '作業問題 (Vấn đề bài tập)',
      '考試問題 (Vấn đề thi cử)',
      '學習困難 (Khó khăn trong học tập)',
      '選修課問題 (Vấn đề môn tự chọn)',
    ],
    '就學與出缺勤 (Điểm danh & Thôi học)': [
      '出缺席(曠課)、遲到問題 (Vấn đề vắng mặt (bỏ học), đi muộn)',
      '休退學問題 (Vấn đề nghỉ học/thôi học)',
    ],
    '身心與家庭 (Gia đình & Sức khỏe)': [
      '家庭關係 (Mối quan hệ gia đình)',
      '健康問題 (Vấn đề sức khỏe)',
    ],
    '生活與經濟 (Kinh tế & Làm thêm)': [
      '經濟問題 (Vấn đề kinh tế)',
      '校外租屋 (Thuê nhà ngoài trường)',
      '工讀 (Làm thêm)',
    ],
    '其他 (Khác)': [
      '其他 (Khác)',
    ],
  };

  return `
  <div class="student-survey-panel" id="student-survey-section">
    <div class="survey-panel-header">
      <div class="survey-panel-title">
        <span class="survey-icon">💌</span>
        <div>
          <h3 style="margin:0;font-size:1.15rem;color:#1e293b;">生活關懷問卷<br><small class="vn-sub">Phiếu khảo sát chăm sóc cuộc sống</small></h3>
          <div class="survey-time-tag">
            <span class="status-badge ${status.badgeClass}">${status.label}</span>
            <span class="survey-schedule-desc">📅 ${status.timeDesc}</span>
          </div>
        </div>
      </div>
      <div class="survey-header-status">
        ${isSubmitted
          ? '<span class="status-badge meets-threshold" style="font-size:0.85rem;padding:0.35rem 0.75rem;">✅ 您已完成填寫<small class="vn-sub">Đã nộp</small></span>'
          : '<span class="status-badge under-threshold" style="font-size:0.85rem;padding:0.35rem 0.75rem;">⏳ 尚未填寫<small class="vn-sub">Chưa nộp</small></span>'}
      </div>
    </div>

    ${isSubmitted ? `
      <div class="survey-submitted-notice">
        <div class="notice-main">
          <strong>ℹ️ 您已完成此問卷填寫<br><small class="vn-sub">Bạn đã hoàn thành phiếu này</small></strong>
          <p>填寫紀錄已附帶時間戳記儲存。若後續個人情況有任何變動，您可以<b>隨時在此重新修改並再次送出</b>。每次修改的歷程內容均會完整記錄於異動日誌中。
          <br><small class="vn-sub">Bạn có thể chỉnh sửa bất cứ lúc nào. Lịch sử sửa đổi sẽ được ghi lại.</small></p>
        </div>
        <div class="notice-meta">
          <span>🕒 首次送出：<b>${formatLogTime(mySub.createdAt)}</b><small class="vn-sub">Nộp lần đầu</small></span>
          <span>🔄 最後修改：<b>${formatLogTime(mySub.updatedAt)}</b><small class="vn-sub">Cập nhật cuối</small></span>
        </div>
      </div>
    ` : `
      <div class="survey-guide-notice">
        💡 <b>填寫說明：</b>本表單旨在了解同學們於就學、課程、生活、健康及打工租屋各方面的實際情況與需求，以提供即時輔導與關懷協助。學號與姓名已由系統自動帶入，請選擇符合現況的面向並簡述狀況。
        <br><small class="vn-sub">Hướng dẫn: Biểu mẫu này nhằm nắm bắt tình hình học tập và cuộc sống của sinh viên để nhà trường kịp thời hỗ trợ.</small>
      </div>
    `}

    <form data-act="submit-survey" class="student-survey-form">
      <!-- 1 & 2: 學號與姓名（自動帶入） -->
      <div class="form-row survey-autofill-row">
        <div class="form-group">
          <label>學號 <span class="badge-autofill">🔒 自動帶入</span><br><small class="vn-sub">Mã số sinh viên (tự động điền)</small></label>
          <input type="text" value="${esc(s.id)}" readonly disabled class="input-locked">
        </div>
        <div class="form-group">
          <label>姓名 <span class="badge-autofill">🔒 自動帶入</span><br><small class="vn-sub">Họ và tên (tự động điền)</small></label>
          <input type="text" value="${esc(s.name)}" readonly disabled class="input-locked">
        </div>
      </div>

      <!-- 3: 輔導面向(擇一) -->
      <div class="form-group survey-cat-group">
        <label style="font-size:0.95rem;font-weight:700;color:#1e293b;margin-bottom:0.6rem;">
          輔導面向（擇一） <span style="color:#dc2626;">*</span><br><small class="vn-sub">Hướng tư vấn - chọn một</small>
        </label>
        <div class="survey-category-picker">
          ${Object.entries(groups).map(([grpName, cats]) => `
            <div class="survey-cat-theme">
              <div class="theme-title">${esc(grpName)}</div>
              <div class="theme-options">
                ${cats.map(cat => {
                  const meta = SURVEY_CATEGORY_META[cat] || { icon: '💬', color: '#64748b' };
                  const checked = currentCategory === cat;
                  return `
                  <label class="survey-cat-chip ${checked ? 'active' : ''} ${!isEditable ? 'disabled' : ''}">
                    <input type="radio" name="category" value="${esc(cat)}" ${checked ? 'checked' : ''} ${!isEditable ? 'disabled' : ''} required>
                    <span class="chip-icon">${meta.icon}</span>
                    <span class="chip-label">${esc(cat)}</span>
                  </label>`;
                }).join('')}
              </div>
            </div>
          `).join('')}
        </div>
      </div>

      <!-- 4: 自述目前狀況或反映問題 -->
      <div class="form-group" style="margin-top:1.25rem;">
        <label style="font-size:0.95rem;font-weight:700;color:#1e293b;margin-bottom:0.4rem;">
          自述目前狀況或反映問題 <span style="color:#dc2626;">*</span><br><small class="vn-sub">Tự thuật tình hình hiện tại hoặc phản ánh vấn đề</small>
        </label>
        <textarea name="content" rows="4" style="width:100%;padding:0.75rem 0.9rem;border:1.5px solid #cbd5e1;border-radius:8px;font:inherit;font-size:0.92rem;line-height:1.5;" placeholder="請簡要描述您目前的學習、生活、健康狀況，或需要老師協助處理的問題... (Vui lòng mô tả ngắn gọn tình hình hiện tại hoặc những khó khăn bạn đang gặp phải cần hỗ trợ...)" ${!isEditable ? 'disabled' : ''} required>${esc(currentContent)}</textarea>
      </div>

      <!-- 送出按鈕與歷程檢視 -->
      <div class="survey-form-actions">
        ${isEditable ? `
          <button class="btn btn-primary" type="submit" style="padding:0.6rem 1.6rem;font-size:0.95rem;font-weight:600;">
            ${isSubmitted ? '🔄 儲存修改問卷<br><small class="vn-sub">Cập nhật lại khảo sát</small>' : '📤 送出生活關懷問卷<br><small class="vn-sub">Gửi phiếu khảo sát</small>'}
          </button>
        ` : `
          <button class="btn btn-secondary" type="button" disabled style="opacity:0.65;cursor:not-allowed;">
            🔒 目前非開放時段，無法送出問卷<br><small class="vn-sub">Hiện không trong thời gian mở, không thể nộp</small>
          </button>
        `}
        ${(c.mySurveyLogs && c.mySurveyLogs.length) ? `
          <button class="btn btn-secondary" type="button" data-act="view-my-survey-logs" data-id="${esc(s.id)}" style="margin-left:0.5rem;padding:0.6rem 1.1rem;font-size:0.9rem;">
            📜 我的修改紀錄（${c.mySurveyLogs.length} 筆）<br><small class="vn-sub">Lịch sử chỉnh sửa</small>
          </button>
        ` : ''}
      </div>
    </form>
  </div>`;
}

function leaderSurveyStatusPanel(c, g, s, mates) {
  if (!c || !g || !mates.length) return '';
  const completedMates = mates.filter(m => m.surveyCompleted);
  const uncompletedMates = mates.filter(m => !m.surveyCompleted);
  const percent = mates.length > 0 ? Math.round((completedMates.length / mates.length) * 100) : 0;
  const allDone = uncompletedMates.length === 0;

  return `
  <div class="leader-survey-panel" style="margin-top:1.5rem;padding:1.25rem;background:#f0fdfa;border:2px solid #99f6e4;border-radius:10px;">
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.6rem;margin-bottom:0.75rem;">
      <div style="display:flex;align-items:center;gap:0.4rem;">
        <span style="font-size:1.3rem;">💌</span>
        <div>
          <h3 style="margin:0;color:#0f766e;font-size:1.05rem;">
            本組生活關懷問卷填寫狀況（${esc(g.name)}）
          </h3>
          <small class="vn-sub">Tiến độ khảo sát của nhóm</small>
        </div>
      </div>
      <div>
        ${allDone
          ? '<span class="status-badge meets-threshold" style="font-size:0.85rem;">✅ 本組全員已完成<br><small class="vn-sub">Cả nhóm đã hoàn thành</small></span>'
          : `<span class="status-badge under-threshold" style="font-size:0.85rem;">⚠️ 本組尚有 <b>${uncompletedMates.length}</b> 人未完成（共 <b>${mates.length}</b> 人）<br><small class="vn-sub">Còn ${uncompletedMates.length} người chưa nộp (Tổng ${mates.length} người)</small></span>`}
      </div>
    </div>

    <!-- 進度條：嚴格只顯示自己組尚未填寫人數 / 該組總人數 -->
    <div style="margin-bottom:1rem;background:#fff;padding:0.75rem 1rem;border-radius:8px;border:1px solid #ccfbf1;">
      <div style="display:flex;justify-content:space-between;font-size:0.85rem;color:#0f766e;font-weight:600;margin-bottom:0.35rem;">
        <span>
          本組填寫進度：已完成 ${completedMates.length} / ${mates.length} 人（待填寫：${uncompletedMates.length} 人）
          <br><small class="vn-sub">Tiến độ nhóm: Đã nộp ${completedMates.length} / ${mates.length} người (Chưa nộp: ${uncompletedMates.length} người)</small>
        </span>
        <span style="text-align:right;">
          ${percent}%
          <br><small class="vn-sub">${allDone ? 'Hoàn thành' : `Còn ${uncompletedMates.length} người`}</small>
        </span>
      </div>
      <div style="height:10px;background:#e5e7eb;border-radius:999px;overflow:hidden;margin-top:0.35rem;">
        <div style="width:${percent}%;height:100%;background:#0d9488;border-radius:999px;transition:width 0.3s;"></div>
      </div>
    </div>

    <!-- 組員名單列表 -->
    <div class="table-wrap" style="background:#fff;border-radius:8px;border:1px solid #ccfbf1;">
      <table class="roster" style="margin:0;font-size:0.88rem;">
        <thead>
          <tr style="background:#f0fdfa;">
            <th>姓名 (學號)<br><small class="vn-sub">Họ tên &amp; Mã SV</small></th>
            <th>角色<br><small class="vn-sub">Vai trò</small></th>
            <th>問卷狀態<br><small class="vn-sub">Tình trạng khảo sát</small></th>
            <th>最後更新<br><small class="vn-sub">Cập nhật cuối</small></th>
          </tr>
        </thead>
        <tbody>
          ${mates.map(m => {
            const isDone = !!m.surveyCompleted;
            return `
            <tr>
              <td><b>${esc(m.name)}</b> (${esc(m.id)})</td>
              <td>${m.isLeader ? '<span class="tag-inline leader">組長<br><small class="vn-sub">Trưởng nhóm</small></span>' : m.isVice ? '<span class="tag-inline">副組長<br><small class="vn-sub">Phó nhóm</small></span>' : '組員<br><small class="vn-sub">Thành viên</small>'}</td>
              <td>
                ${isDone
                  ? '<span class="status-badge meets-threshold">✅ 已完成<br><small class="vn-sub">Đã nộp</small></span>'
                  : '<span class="status-badge under-threshold">⏳ 尚未填寫<br><small class="vn-sub">Chưa nộp</small></span>'}
              </td>
              <td>${m.surveyUpdatedAt ? formatLogTime(m.surveyUpdatedAt) : '<span style="color:#94a3b8;">-</span>'}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>

    <!-- 催填輔助按鈕 -->
    <div style="margin-top:0.85rem;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.5rem;">
      <span style="font-size:0.82rem;color:#0f766e;">
        💡 提示：組長或副組長可掌握本組填寫進度，點選右方按鈕可複製提醒名單至群組催填。<br>
        <small class="vn-sub">Nhóm trưởng/nhóm phó có thể sao chép nhắc nhở gửi vào nhóm chat.</small>
      </span>
      <button class="btn btn-secondary btn-sm" type="button" data-act="copy-leader-uncompleted-survey" style="padding:0.4rem 1rem;font-size:0.85rem;margin:0;">
        📋 一鍵複製本組未填寫催填名單<br><small class="vn-sub">Sao chép danh sách chưa nộp</small>
      </button>
    </div>
  </div>`;
}

/* ---- 老師後台：問卷卡片管理（排序／顯示）與缺曠原因調查批次 ---- */
function teacherAbsenceSurveyBlock(c, sec) {
  const cards = surveyCardList(c, false);
  const surveys = c.absenceSurveys || [];
  const nextThreshold = c.absenceBase + c.absenceStep * surveys.length;
  const titleOf = x => x.type === 'care' ? '💌 ' + careTitle({ careSubtitle: x.b.subtitle }) : '📝 ' + absenceTitle(x.sv);
  const visibleOf = x => x.type === 'care' ? x.b.visible !== false : x.sv.visible !== false;
  const box = 'background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:1rem 1.25rem;margin-bottom:1.25rem;';
  const inp = 'padding:0.35rem 0.55rem;border:1px solid #cbd5e1;border-radius:4px;font-size:0.85rem;';
  return `
  <div class="abs-survey-admin">
    ${sec === 'cards' ? `<div style="${box}">
      <details data-adm="cards" open><summary class="adm-sum"><h3>🗂️ 問卷卡片前台顯示與排列</h3></summary>
      <p class="file-path" style="margin:0 0 0.7rem;">以滑鼠拖拉 ☰ 調整卡片上下順序（或用 ▲▼ 按鈕）；取消勾選「前台顯示」即可隱藏該問卷。</p>
      <div id="survey-card-sort" style="display:flex;flex-direction:column;gap:0.5rem;">
        ${cards.map((x, i) => `
        <div class="survey-sort-item" draggable="true" data-key="${esc(x.key)}" style="display:flex;align-items:center;gap:0.6rem;background:#fff;border:1px solid #cbd5e1;border-radius:8px;padding:0.5rem 0.75rem;cursor:grab;">
          <span style="font-size:1.1rem;color:#94a3b8;">☰</span>
          <b style="flex:1;">${esc(titleOf(x))}</b>
          <label style="display:inline-flex;align-items:center;gap:0.3rem;font-size:0.85rem;cursor:pointer;">
            <input type="checkbox" data-act="toggle-card-visible" data-key="${esc(x.key)}" ${visibleOf(x) ? 'checked' : ''}> 前台顯示</label>
          <button class="tab-btn" type="button" data-act="move-card" data-key="${esc(x.key)}" data-dir="-1" ${i === 0 ? 'disabled' : ''}>▲</button>
          <button class="tab-btn" type="button" data-act="move-card" data-key="${esc(x.key)}" data-dir="1" ${i === cards.length - 1 ? 'disabled' : ''}>▼</button>
        </div>`).join('')}
      </div>
      </details>
    </div>` : ''}

    ${sec === 'abs-config' ? `<div style="${box}">
      <details data-adm="absence-config" open><summary class="adm-sum"><h3>📝 缺曠原因調查問卷設定</h3></summary>
      <form data-act="save-absence-config" style="display:flex;align-items:center;flex-wrap:wrap;gap:0.75rem;margin-bottom:0.9rem;">
        <label style="font-weight:700;font-size:0.9rem;">缺曠輔導門檻：</label>
        <span style="font-size:0.88rem;">初始達 <input type="number" min="1" name="absenceBase" value="${c.absenceBase}" style="${inp}width:5rem;"> 節，每增加 <input type="number" min="1" name="absenceStep" value="${c.absenceStep}" style="${inp}width:5rem;"> 節再一張輔導記錄</span>
        <button class="btn btn-primary btn-sm" type="submit" style="margin:0;">💾 儲存門檻</button>
        <span class="file-path" style="margin:0;">第1批達${c.absenceBase}節、第2批達${c.absenceBase + c.absenceStep}節、第3批達${c.absenceBase + 2 * c.absenceStep}節…</span>
      </form>
      <form data-act="create-absence-survey" style="display:flex;align-items:center;flex-wrap:wrap;gap:0.75rem;">
        <label style="font-weight:700;font-size:0.9rem;">➕ 新增批次問卷：</label>
        <span style="font-size:0.88rem;">曠課達 <input type="number" min="1" name="threshold" value="${nextThreshold}" style="${inp}width:5rem;"> 節</span>
        <span style="font-size:0.88rem;">副標題 <input name="subtitle" maxlength="60" value="達${nextThreshold}節" style="${inp}width:11rem;"></span>
        <button class="btn btn-success btn-sm" type="submit" style="margin:0;">➕ 新增並選擇學生</button>
        <span class="file-path" style="margin:0;">每新增一份即為獨立問卷，需重新勾選學生並各自統計。</span>
      </form>
      <div style="display:flex;align-items:center;flex-wrap:wrap;gap:0.75rem;margin-top:0.9rem;">
        <label style="font-weight:700;font-size:0.9rem;">🗑️ 刪除問卷：</label>
        <select data-role="abs-delete-select" style="${inp}">
          ${surveys.length ? surveys.map(sv => `<option value="${esc(sv.id)}">${esc(absenceTitle(sv))}</option>`).join('') : '<option value="">（尚無問卷）</option>'}
        </select>
        <button class="btn btn-neutral btn-sm" type="button" data-act="delete-absence-survey" style="margin:0;color:#dc2626;border-color:#fca5a5;" ${surveys.length ? '' : 'disabled'}>🗑️ 刪除所選問卷</button>
      </div>
      </details>
    </div>` : ''}
    ${surveys.filter(sv => sec === 'abs:' + sv.id).map(sv => teacherAbsenceCard(c, sv)).join('')}
  </div>`;
}

function teacherAbsenceCard(c, sv) {
  const p = absenceProgress(sv);
  const pending = (sv.targets || []).filter(t => !t.done);
  const byLeader = {};
  pending.forEach(t => { (byLeader[t.leaderName] = byLeader[t.leaderName] || []).push(t); });
  const resps = (c.absenceResponses || []).filter(r => r.surveyId === sv.id);
  const inp = 'padding:0.35rem 0.55rem;border:1px solid #cbd5e1;border-radius:4px;font-size:0.85rem;';
  return `
  <div class="abs-admin-card" style="background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:1rem 1.25rem;margin-bottom:1.25rem;">
    <details data-adm="abs-${esc(sv.id)}" open>
    <summary class="adm-sum" style="display:flex;align-items:center;flex-wrap:wrap;gap:0.6rem;margin-bottom:0.7rem;">
      <h3 style="flex:1;">📝 ${esc(absenceTitle(sv))}</h3>
      <span class="status-badge ${sv.visible ? 'can-edit' : 'is-locked'}">${sv.visible ? '前台顯示中' : '前台已隱藏'}</span>
      <span style="font-size:0.88rem;">已填 <b>${p.done}</b> / 需填 <b>${p.total}</b>（${p.percent}%）</span>
    </summary>
    <form data-act="update-absence-meta" data-survey="${esc(sv.id)}" style="display:flex;align-items:center;flex-wrap:wrap;gap:0.6rem;margin-bottom:0.7rem;">
      <span style="font-size:0.88rem;">副標題 <input name="subtitle" maxlength="60" value="${esc(sv.subtitle)}" style="${inp}width:11rem;"></span>
      <span style="font-size:0.88rem;">門檻 <input type="number" min="1" name="threshold" value="${sv.threshold}" style="${inp}width:5rem;"> 節</span>
      <button class="btn btn-secondary btn-sm" type="submit" style="margin:0;">💾 儲存</button>
      <button class="btn btn-primary btn-sm" type="button" data-act="open-abs-picker" data-survey="${esc(sv.id)}" style="margin:0;">👥 選擇需填寫學生</button>
      <button class="btn btn-success btn-sm" type="button" data-act="export-absence-csv" data-survey="${esc(sv.id)}" style="margin:0;">📥 匯出填寫內容</button>
    </form>
    <h4 style="margin:0.5rem 0 0.3rem;">⏳ 尚未填寫（${pending.length} 位，依所屬組長）</h4>
    ${pending.length ? Object.keys(byLeader).sort().map(l => `
      <div style="margin-bottom:0.35rem;font-size:0.88rem;"><b>組長：${esc(l)}</b>（${byLeader[l].length} 位）→
        ${byLeader[l].map(t => `${esc(t.name)} (${esc(t.id)})`).join('、')}</div>`).join('')
      : `<p class="file-path" style="margin:0;">${p.total ? '🎉 全部已完成填寫' : '尚未選擇需填寫的學生'}</p>`}
    <h4 style="margin:0.8rem 0 0.3rem;">✅ 已填寫內容（${resps.length} 筆）</h4>
    ${resps.length ? `<div style="overflow-x:auto;"><table class="data-table" style="width:100%;font-size:0.86rem;">
      <thead><tr><th>學號</th><th>姓名</th><th>組別</th><th>組長</th><th>缺曠原因說明</th><th>填寫時間</th><th></th></tr></thead>
      <tbody>${resps.map(r => `<tr><td>${esc(r.studentId)}</td><td>${esc(r.studentName)}</td><td>${esc(r.groupName)}</td><td>${esc(r.leaderName)}</td>
        <td style="white-space:pre-wrap;">${esc(r.reason)}</td><td>${esc(formatLogTime(r.updatedAt))}</td>
        <td><button class="tab-btn" type="button" data-act="delete-absence-response" data-survey="${esc(sv.id)}" data-id="${esc(r.studentId)}" style="color:#dc2626;">🗑️</button></td></tr>`).join('')}
      </tbody></table></div>` : '<p class="file-path" style="margin:0;">尚無填寫紀錄</p>'}
    </details>
  </div>`;
}

function exportAbsenceCSV(c, sv) {
  const respMap = new Map((c.absenceResponses || []).filter(r => r.surveyId === sv.id).map(r => [r.studentId, r]));
  const rows = [['學號', '姓名', '組別', '所屬組長', '填寫狀態', '缺曠原因說明', '首次填寫時間', '最後修改時間']];
  (sv.targets || []).slice().sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true })).forEach(t => {
    const r = respMap.get(t.id);
    rows.push([t.id, t.name, t.groupName, t.leaderName, r ? '已填寫' : '尚未填寫', r ? r.reason : '',
      r ? formatLogTime(r.createdAt) : '', r ? formatLogTime(r.updatedAt) : '']);
  });
  const csv = '﻿' + rows.map(r => r.map(x => `"${String(x).replace(/"/g, '""')}"`).join(',')).join('\n');
  download(csv, 'text/csv;charset=utf-8', `${c.year || ''}_${c.subject || ''}_${absenceTitle(sv)}.csv`);
}

/* 選擇學生彈窗：列出缺曠次數（點名紀錄）供參考，可一鍵勾選達門檻者 */
function absPickerModalHtml(c) {
  if (!absPicker || !c) return '';
  const sv = (c.absenceSurveys || []).find(x => x.id === absPicker.surveyId);
  if (!sv) return '';
  const counts = attendanceAbsentCounts(c, null);
  const rows = c.students.slice().sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
  return `
  <div class="absence-modal-overlay" data-act="close-abs-picker-bg">
    <div class="absence-modal-content" style="max-width:760px;">
      <div class="absence-modal-header">
        <h3>👥 選擇需填寫「${esc(absenceTitle(sv))}」的學生</h3>
        <button class="absence-modal-close-btn" type="button" data-act="close-abs-picker">✕</button>
      </div>
      <div class="absence-modal-body">
        <div style="display:flex;gap:0.5rem;flex-wrap:wrap;align-items:center;margin-bottom:0.7rem;">
          <input data-act="abs-pick-search" placeholder="🔍 搜尋學號／姓名／組別" style="flex:1;min-width:180px;padding:0.4rem 0.6rem;border:1px solid #cbd5e1;border-radius:4px;">
          <button class="tab-btn" type="button" data-act="abs-pick-reach">勾選缺曠達 ${sv.threshold} 次者</button>
          <button class="tab-btn" type="button" data-act="abs-pick-none">全部取消</button>
          <span id="abs-pick-count" style="font-size:0.88rem;">已選 <b>${absPicker.selected.size}</b> 位</span>
        </div>
        <p class="file-path" style="margin:0 0 0.5rem;">缺曠次數取自點名紀錄（每筆缺席計 1），僅供參考；實際曠課節數以學校系統為準。</p>
        <div style="max-height:50vh;overflow:auto;">
        <table class="data-table" style="width:100%;font-size:0.86rem;">
          <thead><tr><th></th><th>學號</th><th>姓名</th><th>組別</th><th>所屬組長</th><th>缺曠次數</th></tr></thead>
          <tbody>${rows.map(s => {
            const g = s.groupId ? c.groups.find(x => x.id === s.groupId) : null;
            const lead = g ? c.students.find(x => x.groupId === g.id && x.isLeader) : null;
            const n = counts[s.id] || 0;
            return `<tr data-q="${esc((s.id + ' ' + s.name + ' ' + (g ? g.name : '')).toLowerCase())}">
              <td><input type="checkbox" data-act="abs-pick-toggle" data-id="${esc(s.id)}" ${absPicker.selected.has(s.id) ? 'checked' : ''}></td>
              <td>${esc(s.id)}</td><td>${esc(s.name)}</td><td>${esc(g ? g.name : '未分組')}</td>
              <td>${esc(lead ? lead.name : '（無組長）')}</td><td>${n}</td></tr>`;
          }).join('')}</tbody>
        </table></div>
      </div>
      <div class="absence-modal-footer" style="display:flex;gap:0.5rem;justify-content:flex-end;padding:0.75rem 1rem;">
        <button class="btn btn-secondary" type="button" data-act="close-abs-picker" style="margin:0;">取消</button>
        <button class="btn btn-primary" type="button" data-act="abs-pick-save" style="margin:0;">💾 儲存名單</button>
      </div>
    </div>
  </div>`;
}

function teacherWellbeingBlock(c) {
  if (!c) {
    return `
    <div class="teacher-section">
      <h2>💌 問卷管理</h2>
      <p class="file-path">請先從左側點選或建立課程，即可管理該課程的生活關懷問卷。</p>
    </div>`;
  }

  const c0 = c;
  const sec = wbSec(c0);
  if (sec.startsWith('care:')) careAdminId = sec.slice(5);
  c = careCur(c0);
  const careList = c0.careSurveys || [];
  const stats = getSurveyStats(c);
  const status = getSurveyStatus(c);
  const submissions = c.surveySubmissions || [];
  const logs = c.surveyLogs || [];
  const surveyLogPage = paginate('survey-logs', logs);

  // 篩選已填寫名單
  let filteredSubmissions = submissions.slice();
  if (surveyGroupFilter !== 'all') {
    filteredSubmissions = filteredSubmissions.filter(s => s.groupId === surveyGroupFilter);
  }
  if (surveyCategoryFilter !== 'all') {
    filteredSubmissions = filteredSubmissions.filter(s => s.category === surveyCategoryFilter);
  }
  if (surveySearchText.trim()) {
    const q = surveySearchText.trim().toLowerCase();
    filteredSubmissions = filteredSubmissions.filter(s =>
      (s.studentId && s.studentId.toLowerCase().includes(q)) ||
      (s.studentName && s.studentName.toLowerCase().includes(q)) ||
      (s.content && s.content.toLowerCase().includes(q)) ||
      (s.category && s.category.toLowerCase().includes(q))
    );
  }

  if (sec === 'cards' || sec === 'abs-config' || sec.startsWith('abs:')) {
    return `<div class="teacher-section wellbeing-admin-section">${teacherAbsenceSurveyBlock(c0, sec)}</div>`;
  }
  if (sec === 'log') return '';

  return `
  <div class="teacher-section wellbeing-admin-section">
    ${sec.startsWith('care:') ? `<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.75rem;margin-bottom:1rem;">
      <div>
        <h2 style="margin:0 0 0.35rem 0;">💌 問卷管理 <small>${esc(courseLabel(c))}</small></h2>
        <p class="file-path" style="margin:0;">查閱全班生活關懷問卷回覆、追蹤尚未填寫名單、管理問卷開放時限與匯出完整紀錄。</p>
      </div>
      <div style="display:flex;gap:0.5rem;align-items:center;">
        <button class="btn btn-success btn-sm" type="button" data-act="export-survey-csv">
          📥 匯出問卷紀錄（Excel/CSV）
        </button>
      </div>
    </div>` : ''}

    ${sec === 'care-config' ? `<div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:1rem 1.25rem;margin-top:1.5rem;">
    <details data-adm="care-config" open>
    <summary class="adm-sum" style="margin-bottom:0.75rem;"><h3>💌 生活關懷問卷調查設定</h3></summary>
    <div style="display:flex;align-items:center;flex-wrap:wrap;gap:0.75rem;margin-bottom:0.75rem;">
      <label style="font-weight:700;font-size:0.9rem;">📚 選擇要檢視的問卷：</label>
      <select data-act="care-admin-select" style="padding:0.4rem 0.6rem;border:1px solid #cbd5e1;border-radius:6px;">
        ${careList.map(b => `<option value="${esc(b.id)}" ${b.id === c.careBatchId ? 'selected' : ''}>${esc(careTitle({ careSubtitle: b.subtitle }))}${b.visible === false ? '（前台隱藏）' : ''}</option>`).join('')}
      </select>
      <button class="btn btn-neutral btn-sm" type="button" data-act="delete-care-survey" style="margin:0;color:#dc2626;border-color:#fca5a5;" ${careList.length <= 1 ? 'disabled' : ''}>🗑️ 刪除所選問卷</button>
    </div>
    <form data-act="create-care-survey" style="display:flex;align-items:center;flex-wrap:wrap;gap:0.75rem;">
      <label style="font-weight:700;font-size:0.9rem;">➕ 新增學期問卷：</label>
      <input name="subtitle" maxlength="60" placeholder="例如 1152" style="padding:0.4rem 0.6rem;border:1px solid #cbd5e1;border-radius:6px;width:11rem;">
      <button class="btn btn-success btn-sm" type="submit" style="margin:0;">➕ 新增問卷</button>
      <span class="file-path" style="margin:0;">每份問卷即為獨立問卷，各自有開放時段、填寫紀錄、未完成名單與日誌；舊學期資料不受影響。</span>
    </form>
    </details>
    </div>` : ''}

    ${sec.startsWith('care:') ? `<details data-adm="care" open style="margin-top:1.5rem;">
    <summary class="adm-sum" style="display:flex;align-items:center;flex-wrap:wrap;gap:0.6rem;margin-bottom:0.75rem;"><h3 style="flex:1;">💌 ${esc(careTitle(c))}</h3><span class="status-badge ${c.careVisible !== false ? 'can-edit' : 'is-locked'}">${c.careVisible !== false ? '前台顯示中' : '前台已隱藏'}</span></summary>

    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:1rem 1.25rem;margin-bottom:1.25rem;">
      <form data-act="save-care-subtitle" style="display:flex;align-items:center;flex-wrap:wrap;gap:0.75rem;">
        <label style="font-weight:700;font-size:0.9rem;">🏷️ 此份問卷副標題：</label>
        <input name="subtitle" maxlength="60" value="${esc(c.careSubtitle || '')}" placeholder="例如 1151" style="padding:0.4rem 0.6rem;border:1px solid #cbd5e1;border-radius:6px;width:11rem;">
        <button class="btn btn-primary btn-sm" type="submit" style="margin:0;">💾 儲存副標題</button>
        <span class="file-path" style="margin:0;">前台標題顯示為「${esc(careTitle(c))}」。</span>
      </form>
    </div>

    <!-- 1. 問卷開放時限設定 -->
    <div class="survey-period-box" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:1rem 1.25rem;margin-bottom:1.25rem;">
      <form data-act="save-survey-period" style="display:flex;align-items:center;flex-wrap:wrap;gap:0.85rem;">
        <label style="font-weight:700;font-size:0.9rem;color:#1e293b;">📅 問卷開放時段設定：</label>
        <div style="display:flex;align-items:center;gap:0.4rem;font-size:0.88rem;">
          <span>開始：</span>
          <input type="datetime-local" name="surveyStart" value="${esc(c.surveyStart || '')}" style="padding:0.35rem 0.55rem;border:1px solid #cbd5e1;border-radius:4px;font-size:0.85rem;">
        </div>
        <div style="display:flex;align-items:center;gap:0.4rem;font-size:0.88rem;">
          <span>結束：</span>
          <input type="datetime-local" name="surveyEnd" value="${esc(c.surveyEnd || '')}" style="padding:0.35rem 0.55rem;border:1px solid #cbd5e1;border-radius:4px;font-size:0.85rem;">
        </div>
        <label style="display:inline-flex;align-items:center;gap:0.35rem;font-size:0.86rem;color:#1e293b;cursor:pointer;background:#ffffff;padding:0.3rem 0.65rem;border:1px solid #cbd5e1;border-radius:6px;">
          <input type="checkbox" name="hideUpcomingSurveys" ${c.hideUpcomingSurveys ? 'checked' : ''}>
          <span>隱藏前台尚未進行的問卷（只顯示進行中問卷）</span>
        </label>
        <button class="btn btn-primary btn-sm" type="submit" style="padding:0.4rem 1rem;font-size:0.85rem;margin:0;">💾 儲存設定</button>
        <button class="btn btn-secondary btn-sm" type="button" data-act="clear-survey-period" style="padding:0.4rem 0.85rem;font-size:0.85rem;margin:0;">♾️ 清空時限 (隨時開放)</button>
        <span class="status-badge ${status.badgeClass}" style="margin-left:auto;">${status.label} (${status.timeDesc})</span>
      </form>
    </div>

    <!-- 2. KPI 統計概覽卡片 -->
    <div class="stats" style="margin-bottom:1.5rem;">
      <div class="stat">
        <div class="value">${stats.total}</div>
        <div class="label">修課學生總數</div>
      </div>
      <div class="stat" style="border-left: 4px solid #16a34a;">
        <div class="value" style="color:#16a34a;">${stats.completed} <small style="font-size:0.9rem;color:#64748b;">(${stats.percent}%)</small></div>
        <div class="label">已完成填寫</div>
      </div>
      <div class="stat" style="border-left: 4px solid ${stats.uncompleted > 0 ? '#ea580c' : '#cbd5e1'};">
        <div class="value" style="color:${stats.uncompleted > 0 ? '#ea580c' : '#64748b'};">${stats.uncompleted}</div>
        <div class="label">尚未完成填寫</div>
      </div>
    </div>

    <!-- 3. 輔導面向分布快速過濾 -->
    <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:1rem 1.25rem;margin-bottom:1.5rem;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.6rem;">
        <span style="font-weight:700;font-size:0.9rem;color:#1e293b;">📊 輔導面向回覆分佈（點選可快速篩選查看）：</span>
        ${surveyCategoryFilter !== 'all' ? `
          <button class="tab-btn" data-act="filter-cat-chip" data-cat="all" style="font-size:0.8rem;padding:0.2rem 0.6rem;">清除篩選</button>
        ` : ''}
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:0.45rem;">
        ${SURVEY_CATEGORIES.map(cat => {
          const count = stats.categoryCounts[cat] || 0;
          const meta = SURVEY_CATEGORY_META[cat] || { icon: '💬', color: '#64748b' };
          const active = surveyCategoryFilter === cat;
          return `
          <button class="survey-stat-chip ${active ? 'active' : ''} ${count === 0 ? 'empty' : ''}" data-act="filter-cat-chip" data-cat="${esc(cat)}" style="border-color:${active ? meta.color : '#e2e8f0'};${active ? `background:${meta.color};color:#fff;` : ''}">
            <span class="chip-icon">${meta.icon}</span>
            <span class="chip-name">${esc(cat.split(' (')[0])}</span>
            <span class="chip-count" style="${active ? 'background:rgba(255,255,255,0.25);color:#fff;' : ''}">${count}</span>
          </button>`;
        }).join('')}
      </div>
    </div>

    <!-- 4. 子分頁切換按鈕 -->
    <div class="tab-btns" style="margin-bottom:1.25rem;">
      <button class="tab-btn ${surveyActiveTab === 'uncompleted' ? 'active' : ''}" data-act="set-survey-tab" data-tab="uncompleted">
        📋 尚未完成名單 (${stats.uncompleted} 人)
      </button>
      <button class="tab-btn ${surveyActiveTab === 'submissions' ? 'active' : ''}" data-act="set-survey-tab" data-tab="submissions">
        📝 問卷填寫資料 (${submissions.length} 筆)
      </button>
      <button class="tab-btn ${surveyActiveTab === 'logs' ? 'active' : ''}" data-act="set-survey-tab" data-tab="logs">
        📜 問卷異動日誌 (${logs.length} 筆)
      </button>
    </div>

    <!-- 分頁 1: 尚未完成名單 -->
    ${surveyActiveTab === 'uncompleted' ? `
      <div>
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.5rem;margin-bottom:0.75rem;">
          <div style="font-size:0.9rem;color:#475569;">
            全班共有 <b>${stats.uncompleted}</b> 位學生尚未完成填寫問卷。
          </div>
          <button class="btn btn-primary btn-sm" type="button" data-act="copy-teacher-uncompleted-survey" style="padding:0.4rem 1.1rem;font-size:0.85rem;margin:0;">
            📋 一鍵複製未完成催填名單 (含組別與組長)
          </button>
        </div>
        ${stats.uncompletedList.length ? `
          <div class="table-wrap">
            <table class="roster">
              <thead>
                <tr>
                  <th>所屬組別</th>
                  <th>該組組長</th>
                  <th>學號</th>
                  <th>姓名</th>
                  <th>問卷填寫狀態</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                ${stats.uncompletedList.map(st => `
                <tr>
                  <td><b>${esc(st.groupName)}</b></td>
                  <td>${st.rawLeaderName ? `<span style="color:#16a34a;font-weight:600;">${esc(st.leaderName)}</span>` : '<span style="color:#dc2626;">（無組長）</span>'}</td>
                  <td><code>${esc(st.id)}</code></td>
                  <td><b>${esc(st.name)}</b></td>
                  <td><span class="status-badge under-threshold">⏳ 尚未填寫</span></td>
                  <td style="white-space:nowrap;">
                    <button class="tab-btn" data-act="simulate-student" data-id="${esc(st.id)}" title="以此未填寫學生身分模擬登入測試問卷">🧪 模擬填寫</button>
                  </td>
                </tr>`).join('')}
              </tbody>
            </table>
          </div>
        ` : `
          <div style="padding:2rem;text-align:center;background:#f0fdf4;border:1px dashed #86efac;border-radius:8px;color:#166534;">
            🎉 太棒了！本課程全體學生皆已完成生活關懷問卷填寫！
          </div>
        `}
      </div>
    ` : ''}

    <!-- 分頁 2: 已填寫問卷清單 -->
    ${surveyActiveTab === 'submissions' ? `
      <div>
        <!-- 搜尋與過濾列 -->
        <div class="survey-filter-toolbar" style="display:flex;align-items:center;flex-wrap:wrap;gap:0.75rem;background:#f8fafc;padding:0.85rem 1rem;border:1px solid #e2e8f0;border-radius:8px;margin-bottom:1rem;">
          <div style="flex:1;min-width:200px;">
            <input type="text" data-act="survey-search-input" value="${esc(surveySearchText)}" placeholder="🔍 搜尋學號、姓名或問題自述內容..." style="width:100%;padding:0.4rem 0.75rem;border:1px solid #cbd5e1;border-radius:4px;font-size:0.85rem;">
          </div>
          <div style="display:flex;align-items:center;gap:0.4rem;">
            <label style="font-size:0.85rem;color:#64748b;">組別：</label>
            <select data-act="survey-group-filter" style="padding:0.35rem 0.6rem;border:1px solid #cbd5e1;border-radius:4px;font-size:0.85rem;">
              <option value="all" ${surveyGroupFilter === 'all' ? 'selected' : ''}>全部組別</option>
              ${c.groups.map(g => `<option value="${esc(g.id)}" ${surveyGroupFilter === g.id ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}
            </select>
          </div>
          <div style="display:flex;align-items:center;gap:0.4rem;">
            <label style="font-size:0.85rem;color:#64748b;">面向：</label>
            <select data-act="survey-cat-filter" style="padding:0.35rem 0.6rem;border:1px solid #cbd5e1;border-radius:4px;font-size:0.85rem;">
              <option value="all" ${surveyCategoryFilter === 'all' ? 'selected' : ''}>全部面向</option>
              ${SURVEY_CATEGORIES.map(cat => `<option value="${esc(cat)}" ${surveyCategoryFilter === cat ? 'selected' : ''}>${esc(cat)}</option>`).join('')}
            </select>
          </div>
          ${(surveyGroupFilter !== 'all' || surveyCategoryFilter !== 'all' || surveySearchText) ? `
            <button class="tab-btn" data-act="reset-survey-filters" style="padding:0.35rem 0.7rem;font-size:0.85rem;">重設條件</button>
          ` : ''}
        </div>

        ${filteredSubmissions.length ? `
          <div class="table-wrap">
            <table class="roster">
              <thead>
                <tr>
                  <th>學號</th>
                  <th>姓名</th>
                  <th>所屬組別</th>
                  <th>輔導面向</th>
                  <th>自述狀況與反映問題</th>
                  <th>首次送出時間</th>
                  <th>最後更新時間</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                ${filteredSubmissions.map(sub => `
                <tr>
                  <td><code>${esc(sub.studentId)}</code></td>
                  <td><b>${esc(sub.studentName)}</b></td>
                  <td>${esc(sub.groupName)}</td>
                  <td>${renderCategoryBadge(sub.category)}</td>
                  <td style="max-width:280px;">
                    <div class="survey-content-snippet" data-act="view-survey-detail" data-id="${esc(sub.studentId)}" title="點選查看完整內容">
                      ${esc(sub.content || '')}
                    </div>
                  </td>
                  <td>${formatLogTime(sub.createdAt)}</td>
                  <td>${formatLogTime(sub.updatedAt)}</td>
                  <td style="white-space:nowrap;">
                    <div style="display:flex;gap:0.3rem;">
                      <button class="tab-btn" data-act="simulate-student" data-id="${esc(sub.studentId)}" title="以此學生身分模擬登入測試問卷">🧪 模擬</button>
                      <button class="tab-btn" data-act="view-survey-detail" data-id="${esc(sub.studentId)}" title="查閱完整內容與歷程">🔍 查閱</button>
                      <button class="tab-btn" data-act="teacher-edit-survey-modal" data-id="${esc(sub.studentId)}" title="修改此筆問卷資料">✏️ 修改</button>
                      <button class="tab-btn" data-act="delete-survey-submission" data-id="${esc(sub.studentId)}" data-name="${esc(sub.studentName)}" title="刪除此筆問卷資料與日誌" style="color:#dc2626;">🗑️ 刪除</button>
                      <button class="tab-btn" data-act="view-survey-logs-modal" data-id="${esc(sub.studentId)}" title="查看異動日誌">📜 歷程</button>
                    </div>
                  </td>
                </tr>`).join('')}
              </tbody>
            </table>
          </div>
        ` : `
          <p class="file-path" style="text-align:center;padding:2rem;">查無符合條件的問卷資料。</p>
        `}
      </div>
    ` : ''}

    <!-- 分頁 3: 問卷異動日誌 -->
    ${surveyActiveTab === 'logs' ? `
      <div>
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.5rem;margin-bottom:0.75rem;">
          <p class="file-path" style="margin:0;">完整記錄學生填寫、重新修改以及老師編輯／刪除之所有問卷異動歷程。</p>
          ${logs.length ? `
            <button class="btn btn-neutral btn-sm" type="button" data-act="clear-course-survey-logs" style="color:#dc2626;border-color:#fca5a5;padding:0.35rem 0.85rem;font-size:0.82rem;margin:0;">
              🗑️ 清空全班問卷日誌
            </button>
          ` : ''}
        </div>
        ${logs.length ? `
          <div class="table-wrap">
            <table class="roster">
              <thead>
                <tr>
                  <th>時間</th>
                  <th>動作</th>
                  <th>操作者</th>
                  <th>對象學生</th>
                  <th>異動歷程說明</th>
                </tr>
              </thead>
              <tbody>
                ${surveyLogPage.rows.map(l => {
                  const isTeacherOp = l.operatorRole === 'teacher';
                  const actionBadge = l.actionType === 'create'
                    ? '<span class="status-badge meets-threshold">首次送出</span>'
                    : l.actionType === 'delete'
                    ? '<span class="status-badge" style="background:#fee2e2;color:#991b1b;border:1px solid #fca5a5;">刪除</span>'
                    : '<span class="status-badge can-edit">修改更新</span>';
                  return `
                  <tr>
                    <td>${formatLogTime(l.createdAt)}</td>
                    <td>${actionBadge}</td>
                    <td>${isTeacherOp ? '<span style="color:#7c3aed;font-weight:600;">👨‍🏫 老師</span>' : `<span>學生 ${esc(l.operatorName)} (${esc(l.operatorId)})</span>`}</td>
                    <td><b>${esc(l.studentName)}</b> (${esc(l.studentId)})</td>
                    <td>
                      <div>${esc(l.diffSummary || '-')}</div>
                      ${(l.prevCategory || l.newCategory) && l.prevCategory !== l.newCategory ? `
                        <div style="font-size:0.78rem;color:#64748b;margin-top:0.2rem;">
                          面向變更：${esc(l.prevCategory || '無')} ➔ ${esc(l.newCategory)}
                        </div>
                      ` : ''}
                    </td>
                  </tr>`;
                }).join('')}
              </tbody>
            </table>
          </div>
          ${surveyLogPage.pager}
        ` : `
          <p class="file-path" style="text-align:center;padding:2rem;">目前尚無任何問卷異動日誌。</p>
        `}
      </div>
    ` : ''}
    </details>` : ''}
  </div>`;
}

function exportSurveyCSV(c) {
  if (!c) return;
  const submissions = c.surveySubmissions || [];
  const subMap = new Map();
  submissions.forEach(s => subMap.set(s.studentId, s));

  const rows = [['學號', '姓名', '組別', '組長', '填寫狀態', '輔導面向', '自述目前狀況或反映問題', '首次填寫時間', '最後修改時間']];

  // 依學號自然排序
  const sortedStudents = c.students.slice().sort((a, b) =>
    String(a.id).localeCompare(String(b.id), undefined, { numeric: true, sensitivity: 'base' })
  );

  sortedStudents.forEach(s => {
    const g = c.groups.find(x => x.id === s.groupId);
    const lead = g ? c.students.find(x => x.groupId === g.id && x.isLeader) : null;
    const sub = subMap.get(s.id);
    rows.push([
      s.id,
      s.name,
      g ? g.name : '未分組',
      lead ? `${lead.name} (${lead.id})` : '（無組長）',
      sub ? '已完成填寫' : '尚未填寫',
      sub ? sub.category : '',
      sub ? sub.content : '',
      sub && sub.createdAt ? formatLogTime(sub.createdAt) : '',
      sub && sub.updatedAt ? formatLogTime(sub.updatedAt) : '',
    ]);
  });

  const csv = '\ufeff' + rows.map(r => r.map(x => `"${String(x).replace(/"/g, '""')}"`).join(',')).join('\n');
  download(csv, 'text/csv;charset=utf-8', `${c.year || ''}_${c.subject || ''}_${careTitle(c)}填寫紀錄.csv`);
}

function surveyModalsHtml() {
  const c0 = cur();
  const c = c0 ? careCur(c0) : c0;
  let html = '';

  // 1. 查閱問卷詳情 Modal
  if (viewingSurveyModal && c) {
    const stId = viewingSurveyModal;
    const isTeacher = state.session && state.session.role === 'teacher';
    const sub = isTeacher
      ? (c.surveySubmissions || []).find(s => s.studentId === stId)
      : (c.mySurvey && me() && me().id === stId ? c.mySurvey : null);
    const st = c.students.find(s => s.id === stId);
    const grp = st && st.groupId ? c.groups.find(g => g.id === st.groupId) : null;
    const leader = grp ? c.students.find(s => s.groupId === grp.id && s.isLeader) : null;
    const logs = (isTeacher ? (c.surveyLogs || []) : (c.mySurveyLogs || [])).filter(l => l.studentId === stId);

    html += `
    <div class="absence-modal-overlay" data-act="close-survey-detail-modal-bg">
      <div class="absence-modal-content" style="max-width:680px;">
        <div class="absence-modal-header">
          <h3><span>💌</span> 生活關懷問卷明細</h3>
          <button class="absence-modal-close-btn" type="button" data-act="close-survey-detail-modal">✕</button>
        </div>
        <div class="absence-modal-body">
          <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:0.75rem 1rem;margin-bottom:1rem;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.4rem;">
            <div>
              <strong style="font-size:1.05rem;">${esc(st ? st.name : stId)}</strong>
              <span style="color:#64748b;font-size:0.85rem;margin-left:0.35rem;">(${esc(stId)})</span>
              <div style="font-size:0.82rem;color:#475569;margin-top:0.25rem;">
                組別：<b>${esc(grp ? grp.name : '未分組')}</b> · 組長：${leader ? `${esc(leader.name)} (${esc(leader.id)})` : '（無組長）'}
              </div>
            </div>
            ${sub ? '<span class="status-badge meets-threshold">✅ 已完成填寫</span>' : '<span class="status-badge under-threshold">⏳ 尚未填寫</span>'}
          </div>

          ${sub ? `
            <div style="margin-bottom:1rem;">
              <label style="font-size:0.85rem;font-weight:700;color:#64748b;display:block;margin-bottom:0.35rem;">輔導面向：</label>
              <div>${renderCategoryBadge(sub.category)}</div>
            </div>

            <div style="margin-bottom:1.25rem;">
              <label style="font-size:0.85rem;font-weight:700;color:#64748b;display:block;margin-bottom:0.35rem;">自述目前狀況或反映問題：</label>
              <div class="survey-modal-content-box">
                ${esc(sub.content || '')}
              </div>
            </div>

            <div style="display:flex;gap:1.5rem;font-size:0.82rem;color:#64748b;margin-bottom:1.25rem;border-top:1px dashed #e2e8f0;padding-top:0.75rem;">
              <span>🕒 首次送出：<b>${formatLogTime(sub.createdAt)}</b></span>
              <span>🔄 最後更新：<b>${formatLogTime(sub.updatedAt)}</b></span>
            </div>

            <!-- 修改歷程日誌時間軸 -->
            <div>
              <label style="font-size:0.85rem;font-weight:700;color:#64748b;display:block;margin-bottom:0.5rem;">📜 歷程異動日誌：</label>
              ${logs.length ? `
                <div class="survey-logs-timeline">
                  ${logs.map(l => `
                    <div class="timeline-item">
                      <div class="timeline-date">${formatLogTime(l.createdAt)}</div>
                      <div class="timeline-operator">操作者（Người thao tác）：${l.operatorRole === 'teacher' ? '<b style="color:#7c3aed;">👨‍🏫 老師（Giáo viên）</b>' : `<b>學生本人（Sinh viên）(${esc(l.operatorName)})</b>`}</div>
                      <div class="timeline-summary">${esc(l.diffSummary || '')}</div>
                    </div>
                  `).join('')}
                </div>
              ` : '<p class="file-path">尚無額外修改紀錄。</p>'}
            </div>
          ` : '<p class="file-path" style="text-align:center;padding:1.5rem;">該學生目前尚未填寫問卷。</p>'}
        </div>
        <div class="absence-modal-footer">
          ${isTeacher && sub ? `
            <button class="btn btn-primary" type="button" data-act="teacher-edit-survey-modal" data-id="${esc(stId)}" style="margin:0;margin-right:auto;padding:0.4rem 1rem;font-size:0.85rem;">
              ✏️ 修改內容
            </button>
          ` : ''}
          <button class="btn btn-secondary" style="padding:0.4rem 1.1rem;font-size:0.88rem;margin:0;" data-act="close-survey-detail-modal">
            關閉
          </button>
        </div>
      </div>
    </div>`;
  }

  // 2. 老師修改問卷 Modal
  if (editingSurveyModal && c) {
    const { studentId, studentName, category, content } = editingSurveyModal;
    html += `
    <div class="absence-modal-overlay" data-act="close-edit-survey-modal-bg">
      <div class="absence-modal-content" style="max-width:600px;">
        <div class="absence-modal-header">
          <h3><span>✏️</span> 修改學生問卷資料</h3>
          <button class="absence-modal-close-btn" type="button" data-act="close-edit-survey-modal">✕</button>
        </div>
        <form data-act="teacher-edit-survey-submit">
          <input type="hidden" name="studentId" value="${esc(studentId)}">
          <div class="absence-modal-body">
            <div style="background:#f8fafc;padding:0.6rem 0.85rem;border-radius:6px;margin-bottom:1rem;font-size:0.9rem;">
              學生：<b>${esc(studentName)}</b> (學號: ${esc(studentId)})
            </div>
            <div class="form-group" style="margin-bottom:1rem;">
              <label style="font-weight:700;display:block;margin-bottom:0.4rem;">輔導面向：</label>
              <select name="category" style="width:100%;padding:0.5rem;border:1px solid #cbd5e1;border-radius:6px;font:inherit;" required>
                ${SURVEY_CATEGORIES.map(cat => `<option value="${esc(cat)}" ${category === cat ? 'selected' : ''}>${esc(cat)}</option>`).join('')}
              </select>
            </div>
            <div class="form-group">
              <label style="font-weight:700;display:block;margin-bottom:0.4rem;">自述目前狀況或反映問題：</label>
              <textarea name="content" rows="6" style="width:100%;padding:0.6rem 0.8rem;border:1.5px solid #cbd5e1;border-radius:6px;font:inherit;" required>${esc(content)}</textarea>
            </div>
          </div>
          <div class="absence-modal-footer">
            <button class="btn btn-secondary" type="button" data-act="close-edit-survey-modal" style="margin:0;padding:0.4rem 1rem;">取消</button>
            <button class="btn btn-primary" type="submit" style="margin:0;padding:0.4rem 1.4rem;">💾 儲存修改</button>
          </div>
        </form>
      </div>
    </div>`;
  }

  // 3. 歷程日誌 Modal
  if (viewingSurveyLogsModal && c) {
    const { studentId, studentName, logs } = viewingSurveyLogsModal;
    html += `
    <div class="absence-modal-overlay" data-act="close-survey-logs-modal-bg">
      <div class="absence-modal-content" style="max-width:620px;">
        <div class="absence-modal-header">
          <h3><span>📜</span> <span>問卷異動日誌歷程<br><small class="vn-sub">Lịch sử chỉnh sửa khảo sát</small></span></h3>
          <button class="absence-modal-close-btn" type="button" data-act="close-survey-logs-modal">✕</button>
        </div>
        <div class="absence-modal-body">
          <div style="background:#f8fafc;padding:0.6rem 0.85rem;border-radius:6px;margin-bottom:1rem;font-size:0.9rem;">
            學生（Sinh viên）：<b>${esc(studentName)}</b> (${esc(studentId)})
          </div>
          ${logs && logs.length ? `
            <div class="survey-logs-timeline">
              ${logs.map(l => `
                <div class="timeline-item">
                  <div class="timeline-date">${formatLogTime(l.createdAt)}</div>
                  <div class="timeline-operator">操作者（Người thao tác）：${l.operatorRole === 'teacher' ? '<b style="color:#7c3aed;">👨‍🏫 老師（Giáo viên）</b>' : `<b>學生本人（Sinh viên）(${esc(l.operatorName)})</b>`}</div>
                  <div class="timeline-summary">${esc(l.diffSummary || '')}</div>
                  ${l.prevCategory !== l.newCategory && (l.prevCategory || l.newCategory) ? `
                    <div style="font-size:0.8rem;color:#475569;margin-top:0.25rem;">
                      面向異動（Thay đổi hướng tư vấn）：${esc(l.prevCategory || '無')} ➔ ${esc(l.newCategory)}
                    </div>
                  ` : ''}
                </div>
              `).join('')}
            </div>
          ` : '<p class="file-path">尚無異動紀錄。<br><small class="vn-sub">Chưa có lịch sử chỉnh sửa.</small></p>'}
        </div>
        <div class="absence-modal-footer">
          ${isTeacher ? `
            <button class="btn btn-neutral btn-sm" type="button" data-act="clear-student-survey-logs" data-id="${esc(studentId)}" style="margin:0;margin-right:auto;color:#dc2626;border-color:#fca5a5;padding:0.4rem 0.9rem;font-size:0.85rem;">
              🗑️ 清除此學生修改紀錄
            </button>
          ` : ''}
          <button class="btn btn-secondary" style="padding:0.4rem 1.1rem;margin:0;" data-act="close-survey-logs-modal">關閉<br><small class="vn-sub">Đóng</small></button>
        </div>
      </div>
    </div>`;
  }

  // 5. 老師轉換身分模擬學生登入測試 Modal
  if (simulatingStudentModal && c) {
    const simCards = surveyCardList(c, false);
    if (!simCards.some(x => x.key === simulateSurveyKey)) simulateSurveyKey = simCards.length ? simCards[0].key : '';
    const simSel = simCards.find(x => x.key === simulateSurveyKey);
    const simTitle = x => (x.type === 'care' ? careTitle(careView(c, x.b)) : absenceTitle(x.sv)) + ((x.type === 'care' ? x.b.visible : x.sv.visible) === false ? '（前台已隱藏）' : '');
    const simStatus = st => {
      if (!simSel) return '';
      if (simSel.type === 'care') return careView(c, simSel.b).students.find(z => z.id === st.id).surveyCompleted ? ' [已完成]' : ' [尚未填寫]';
      return (simSel.sv.studentIds || []).includes(st.id) ? ' [需填寫]' : ' [無需填寫]';
    };
    html += `
    <div class="absence-modal-overlay" data-act="close-simulate-modal-bg">
      <div class="absence-modal-content" style="max-width:580px;">
        <div class="absence-modal-header" style="background:#fef3c7;border-bottom:1px solid #fde68a;">
          <h3 style="color:#92400e;"><span>🧪</span> 轉換身分以學生登入測試問卷</h3>
          <button class="absence-modal-close-btn" type="button" data-act="close-simulate-modal">✕</button>
        </div>
        <div class="absence-modal-body">
          <div style="background:#fefce8;border:1px solid #fef08a;border-radius:8px;padding:0.75rem 1rem;margin-bottom:1rem;font-size:0.88rem;color:#854d0e;line-height:1.5;">
            💡 選擇任一學生後，系統將立即將您轉換為該學生的真實登入身分，讓您測試填寫所選問卷或組別功能。測試完成後可隨時一鍵返回老師後台，並可於後台隨時清除測試日誌。
          </div>
          <div class="form-group" style="margin-bottom:1rem;">
            <label style="font-weight:700;display:block;margin-bottom:0.4rem;">請選擇要測試的問卷：</label>
            <select id="simulate-survey-select" data-act="simulate-survey-change" style="width:100%;padding:0.6rem 0.8rem;border:1.5px solid #cbd5e1;border-radius:8px;font:inherit;font-size:0.92rem;">
              ${simCards.map(x => `<option value="${esc(x.key)}" ${x.key === simulateSurveyKey ? 'selected' : ''}>${esc(simTitle(x))}</option>`).join('')}
            </select>
          </div>
          <div class="form-group" style="margin-bottom:1rem;">
            <label style="font-weight:700;display:block;margin-bottom:0.4rem;">請選擇要模擬的學生：</label>
            <select id="simulate-student-select" style="width:100%;padding:0.6rem 0.8rem;border:1.5px solid #cbd5e1;border-radius:8px;font:inherit;font-size:0.92rem;">
              ${c.students.map(st => {
                const grp = st.groupId ? c.groups.find(g => g.id === st.groupId) : null;
                const grpName = grp ? grp.name : '未分組';
                const roleName = st.isLeader ? ' (組長)' : st.isVice ? ' (副組長)' : '';
                const doneTag = simStatus(st);
                return `<option value="${esc(st.id)}">${esc(st.name)} (${esc(st.id)}) - ${esc(grpName)}${roleName}${doneTag}</option>`;
              }).join('')}
            </select>
          </div>
        </div>
        <div class="absence-modal-footer">
          <button class="btn btn-secondary" type="button" data-act="close-simulate-modal" style="margin:0;padding:0.4rem 1rem;">取消</button>
          <button class="btn btn-primary" type="button" data-act="confirm-simulate-student" style="margin:0;padding:0.4rem 1.4rem;background:#d97706;border-color:#b45309;">
            🚀 開始模擬登入
          </button>
        </div>
      </div>
    </div>`;
  }

  // 4. 前台尚未完成名單 Modal
  if (showPublicUncompletedModal && c) {
    const stats = getSurveyStats(c);
    html += `
    <div class="absence-modal-overlay" data-act="close-public-uncompleted-modal-bg">
      <div class="absence-modal-content" style="max-width:640px;">
        <div class="absence-modal-header">
          <h3><span>📋</span> <span>尚未完成生活關懷問卷名單<br><small class="vn-sub">Danh sách chưa hoàn thành khảo sát</small></span></h3>
          <button class="absence-modal-close-btn" type="button" data-act="close-public-uncompleted-modal">✕</button>
        </div>
        <div class="absence-modal-body">
          <div style="background:#fef3c7;border:1px solid #fde68a;border-radius:8px;padding:0.65rem 0.85rem;margin-bottom:1rem;color:#92400e;font-size:0.88rem;">
            全班共有 <b>${stats.uncompleted}</b> 位同學尚未完成生活關懷問卷，請組長與同組同學互相協助提醒催填！<br><small class="vn-sub">Còn ${stats.uncompleted} sinh viên chưa hoàn thành khảo sát, nhóm trưởng và các bạn vui lòng nhắc nhở nhau!</small>
          </div>
          ${stats.uncompletedList.length ? `
            <div class="table-wrap">
              <table class="roster">
                <thead>
                  <tr>
                    <th>所屬組別<br><small class="vn-sub">Nhóm</small></th>
                    <th>組長<br><small class="vn-sub">Trưởng nhóm</small></th>
                    <th>姓名<br><small class="vn-sub">Họ tên</small></th>
                    <th>狀態<br><small class="vn-sub">Tình trạng</small></th>
                  </tr>
                </thead>
                <tbody>
                  ${stats.uncompletedList.map(st => `
                  <tr>
                    <td><b>${esc(st.groupName)}</b></td>
                    <td>${st.rawLeaderName ? `<span style="color:#16a34a;font-weight:600;">${esc(st.leaderName)}</span>` : '<span style="color:#dc2626;">（無組長）</span><small class="vn-sub">Chưa có trưởng nhóm</small>'}</td>
                    <td><b>${esc(st.name)}</b></td>
                    <td><span class="status-badge under-threshold">⏳ 尚未填寫<small class="vn-sub">Chưa nộp</small></span></td>
                  </tr>`).join('')}
                </tbody>
              </table>
            </div>
          ` : `
            <div style="text-align:center;padding:1.5rem;color:#166534;background:#f0fdf4;border-radius:8px;">
              🎉 全班同學皆已完成問卷填寫！<br><small class="vn-sub">Tất cả sinh viên đã hoàn thành khảo sát!</small>
            </div>
          `}
        </div>
        <div class="absence-modal-footer">
          <button class="btn btn-primary btn-sm" type="button" data-act="copy-public-uncompleted-survey" style="margin:0;margin-right:auto;padding:0.4rem 1rem;">
            📋 一鍵複製未完成名單<br><small class="vn-sub">Sao chép danh sách</small>
          </button>
          <button class="btn btn-secondary" style="padding:0.4rem 1.1rem;margin:0;" data-act="close-public-uncompleted-modal">關閉<br><small class="vn-sub">Đóng</small></button>
        </div>
      </div>
    </div>`;
  }

  html += absPickerModalHtml(c);

  return html;
}

function studentScreen() {
  return authScreen();
}

/* ===== 組長／副組長：點名面板 ===== */
function attendanceLeaderPanel(c, g, s, mates) {
  const sessions = attendanceSessions(c);
  const today = todayDateStr();

  // 1. 取得或準備當日「一般日常點名」時段
  const todayDaily = sessions.find(x => x.date === today && isDailySession(x)) || {
    id: `daily-${today}`,
    courseId: c.id,
    date: today,
    timeSlot: '',
    name: '一般日常點名（Điểm danh hàng ngày）',
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
        ${m.isLeader ? ' <span class="status-badge" style="background:#fef3c7;color:#92400e;font-size:0.75rem;">👑組長<small class="vn-sub">Trưởng nhóm</small></span>' : m.isVice ? ' <span class="status-badge" style="background:#f0fdf4;color:#166534;font-size:0.75rem;">⭐副組長<small class="vn-sub">Phó nhóm</small></span>' : ''}
        ${!st ? ' <span class="status-badge under-threshold" style="font-size:0.75rem;">尚未確認<small class="vn-sub">Chưa xác nhận</small></span>' : ''}
      </span>
      <span style="display:flex;gap:1.25rem;font-size:0.88rem;">
        <label style="cursor:pointer;display:inline-flex;align-items:center;gap:0.3rem;">
          <input type="radio" name="att_${esc(key)}" value="present" ${st === 'present' ? 'checked' : ''} required>
          <span style="color:#166534;font-weight:${st === 'present' ? '700' : 'normal'};">出席<small class="vn-sub">Có mặt</small></span>
        </label>
        <label style="cursor:pointer;display:inline-flex;align-items:center;gap:0.3rem;">
          <input type="radio" name="att_${esc(key)}" value="absent" ${st === 'absent' ? 'checked' : ''} required>
          <span style="color:#dc2626;font-weight:${st === 'absent' ? '700' : 'normal'};">缺席<small class="vn-sub">Vắng mặt</small></span>
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
          今日一般日常點名<br><small class="vn-sub">Điểm danh hàng ngày hôm nay</small>
        </h4>
      </div>
      <div style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;">
        <span class="status-badge" style="background:#dbeafe;color:#1d4ed8;border:1px solid #bfdbfe;font-weight:600;">日期：${esc(today)}<small class="vn-sub">Ngày</small></span>
        ${dailyCompleted
          ? `<span class="status-badge can-edit" style="font-size:0.85rem;">✅ 今日點名已完成（出席 ${dailyPresentCount} / 缺席 ${dailyAbsentCount}）<small class="vn-sub">Đã hoàn thành (Có mặt ${dailyPresentCount} / Vắng ${dailyAbsentCount})</small></span>`
          : dailyMarkedMates.length > 0
          ? `<span class="status-badge under-threshold" style="font-size:0.85rem;">⚠️ 點名進行中（已確認 ${dailyMarkedMates.length}/${mates.length}）<small class="vn-sub">Đang điểm danh: ${dailyMarkedMates.length}/${mates.length}</small></span>`
          : `<span class="status-badge under-threshold" style="font-size:0.85rem;">⏳ 今日尚未點名<small class="vn-sub">Hôm nay chưa điểm danh</small></span>`}
      </div>
    </div>
    <div style="background:#f8fafc;border-left:4px solid #2563eb;padding:0.6rem 0.85rem;margin-bottom:0.85rem;font-size:0.85rem;color:#334155;border-radius:0 6px 6px 0;">
      💡 <b>一般日常點名無需老師在後台建立時段</b>。請組長或副組長<b>逐一確認</b>每位組員今天是否出席或缺席，確認後點選下方送出（當日可隨時重新更新修正）。
      <br><small class="vn-sub">Điểm danh hàng ngày không cần giáo viên tạo trước. Trưởng nhóm hoặc phó nhóm vui lòng xác nhận riêng cho từng thành viên có mặt hoặc vắng mặt hôm nay. Trong ngày có thể cập nhật lại bất kỳ lúc nào.</small>
    </div>
    <form data-act="mark-attendance" data-session="${todayDaily.id}" data-group="${g.id}" class="attendance-mark-form">
      <div class="attendance-mark-list">
        ${renderMemberRows(dailyRecByRef)}
      </div>
      <div style="margin-top:0.9rem;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.6rem;">
        <span style="font-size:0.82rem;color:#64748b;">※ 請逐一為每位組員勾選出缺席後送出。<small class="vn-sub">Vui lòng chọn riêng cho tất cả thành viên rồi gửi.</small></span>
        <button class="btn btn-primary" type="submit" style="padding:0.5rem 1.4rem;font-size:0.92rem;">
          ${dailyMarkedMates.length > 0 ? '🔄 重新更新今日日常點名<br><small class="vn-sub">Cập nhật lại điểm danh</small>' : '📋 送出今日日常點名<br><small class="vn-sub">Gửi điểm danh hàng ngày</small>'}
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
          重要集會與額外點名<br><small class="vn-sub">Điểm danh sự kiện / tập trung quan trọng</small>
        </h4>
      </div>
      <p class="file-path" style="margin:0 0 0.75rem;">
        老師已在後台指定重要集會或額外點名時段，請組長或副組長逐一確認點名：
        <br><small class="vn-sub">Giáo viên đã chỉ định đợt điểm danh sự kiện đặc biệt, trưởng/phó nhóm vui lòng điểm danh:</small>
      </p>
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
                <span class="status-badge can-edit">${isToday ? '今日可編輯<small class="vn-sub">Hôm nay</small>' : '老師已開放補登<small class="vn-sub">Đã mở bổ sung</small>'}</span>
                ${done ? `<span class="status-badge can-edit">✅ 已完成（出席 ${presents} / 缺席 ${absents}）<small class="vn-sub">Đã hoàn thành (Có mặt ${presents} / Vắng ${absents})</small></span>` : ''}
              </div>
            </div>
            <div class="attendance-mark-list">
              ${renderMemberRows(recByRef)}
            </div>
            <div style="margin-top:0.75rem;text-align:right;">
              <button class="btn btn-primary" type="submit" style="padding:0.45rem 1.2rem;font-size:0.9rem;">
                ${marked.length > 0 ? '🔄 重新更新此時段點名<br><small class="vn-sub">Cập nhật điểm danh</small>' : '📋 送出重要集會點名<br><small class="vn-sub">Gửi điểm danh sự kiện</small>'}
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
      <br><small class="vn-sub">Hiện không có đợt điểm danh sự kiện đặc biệt. Khi có sự kiện khoa hoặc đánh giá đồ án, giáo viên sẽ tạo đợt điểm danh tại đây.</small>
    </div>`;
  }

  // 區塊 3：歷史點名紀錄
  let historySection = '';
  if (historySessions.length > 0) {
    historySection = `
    <div style="margin-top:1.25rem;">
      <h5 style="margin:0 0 0.5rem;color:#475569;font-size:0.95rem;">📜 歷史點名紀錄<br><small class="vn-sub">Lịch sử điểm danh</small></h5>
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
              ${isDaily ? ' <span class="status-badge" style="background:#e0f2fe;color:#0369a1;font-size:0.75rem;">日常點名<small class="vn-sub">Hàng ngày</small></span>' : ' <span class="status-badge" style="background:#fef3c7;color:#92400e;font-size:0.75rem;">重要集會<small class="vn-sub">Sự kiện</small></span>'}
            </span>
            <span class="status-badge is-locked">已鎖定<small class="vn-sub">Đã khóa</small></span>
          </div>
          <div style="margin-top:0.25rem;color:#475569;">
            ${!recs.length ? '尚未點名<small class="vn-sub">Chưa điểm danh</small>'
              : absentNames.length ? `缺席：${absentNames.map(esc).join('、')}<small class="vn-sub">Vắng mặt</small>`
              : '✅ 全員到齊<small class="vn-sub">Đầy đủ</small>'}
          </div>
          <div style="margin-top:0.2rem;font-size:0.76rem;color:#94a3b8;">如需補登請聯絡老師開放權限<small class="vn-sub">Liên hệ giáo viên để mở lại</small></div>
        </div>`;
      }).join('')}
    </div>`;
  }

  return `
  <div class="leader-eval-panel" style="margin-top:1.5rem;padding:1.25rem;background:#f8fafc;border:2px solid #cbd5e1;border-radius:12px;">
    <h3 style="margin:0 0 0.5rem;color:#1e3a8a;display:flex;align-items:center;gap:0.4rem;">
      <span>📋</span> <span>點名面板<br><small class="vn-sub">Bảng điểm danh</small></span>
    </h3>
    <p class="file-path" style="margin:0 0 1rem;">
      組長或副組長可於當天直接進行<b>一般日常點名</b>；若遇<b>重要集會</b>，亦可於下方專區進行額外點名。超過當天需老師開放補登權限。
      <br><small class="vn-sub">Trưởng nhóm hoặc phó nhóm có thể tự điểm danh hàng ngày trong ngày hôm nay. Nếu có sự kiện quan trọng, hãy điểm danh ở phần sự kiện bên dưới. Qua ngày cần giáo viên mở quyền bổ sung.</small>
    </p>
    ${dailyCard}
    ${specialCard}
    ${historySection}
    <div style="margin-top:1.25rem;">
      ${renderAbsenceLeaderboardCard(c, {
        title: `${esc(g.name)} 組員缺席排行榜`,
        subTitle: 'Bảng xếp hạng vắng mặt của nhóm',
        filterMates: mates,
        scopeAct: 'leader-attendance-stat-scope',
        currentScope: leaderAttendanceStatScope,
        limit: 20
      })}
    </div>
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
    <h3 style="margin:0 0 0.5rem;color:#6b21a8;">🔁 跨組代理點名<br><small class="vn-sub">Điểm danh hộ nhóm khác</small></h3>
    <p class="file-path" style="margin:0 0 0.75rem;">
      老師已授權您代理「${esc(del.groupName)}」於 ${esc(label)} 的點名（該組組長／副組長皆未到）。
      <br><small class="vn-sub">Được giáo viên ủy quyền điểm danh hộ cho "${esc(del.groupName)}" tại ${esc(label)} vì trưởng/phó nhóm vắng mặt.</small>
    </p>
    ${!editable ? `
      <p class="file-path" style="color:#991b1b;">此授權已失效或已逾期。<br><small class="vn-sub">Ủy quyền này đã hết hạn hoặc không còn hiệu lực.</small></p>
    ` : `
    <form data-act="mark-attendance" data-session="${session.id}" data-group="${del.groupId}" class="attendance-mark-form">
      <div class="attendance-mark-list">
        ${mates.map(m => {
          const key = keyOf(m);
          const st = recByRef[key] || '';
          return `
          <div class="attendance-row" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.5rem;padding:0.3rem 0;border-bottom:1px dashed #e2e8f0;">
            <span>
              ${esc(m.name)} (${esc(m.id)})
              ${m.isLeader ? ' <span class="status-badge" style="background:#fef3c7;color:#92400e;font-size:0.75rem;">👑組長<small class="vn-sub">Trưởng nhóm</small></span>' : m.isVice ? ' <span class="status-badge" style="background:#f0fdf4;color:#166534;font-size:0.75rem;">⭐副組長<small class="vn-sub">Phó nhóm</small></span>' : ''}
              ${!st ? ' <span class="status-badge under-threshold" style="font-size:0.75rem;">尚未確認<small class="vn-sub">Chưa xác nhận</small></span>' : ''}
            </span>
            <span style="display:flex;gap:0.75rem;font-size:0.85rem;">
              <label><input type="radio" name="att_${esc(key)}" value="present" ${st === 'present' ? 'checked' : ''} required> 出席<small class="vn-sub">Có mặt</small></label>
              <label><input type="radio" name="att_${esc(key)}" value="absent" ${st === 'absent' ? 'checked' : ''} required> 缺席<small class="vn-sub">Vắng mặt</small></label>
            </span>
          </div>`;
        }).join('')}
      </div>
      <button class="btn btn-primary" type="submit" style="margin-top:0.75rem;padding:0.4rem 1.1rem;font-size:0.88rem;">送出點名<br><small class="vn-sub">Gửi điểm danh</small></button>
    </form>`}
  </div>`;
}

/* ===== 老師切換預覽模式專用提示橫幅 ===== */
function teacherPreviewBanner() {
  if (state.session && state.session.role === 'student' && state.session.simulatedBy === 'teacher') {
    const s = me();
    const c = cur();
    return `
    <div class="teacher-preview-floating-bar simulation-active" style="background:linear-gradient(90deg, #78350f, #92400e);border-bottom:2px solid #f59e0b;">
      <div class="preview-bar-left">
        <span class="preview-pulse-icon" style="font-size:1.4rem;">🧪</span>
        <span class="preview-text" style="color:#ffffff;">
          <b>【老師模擬學生測試中】</b> 目前正以學生 <b>${esc(s ? s.name : '')} (${esc(s ? s.id : '')})</b> 身分登入測試問卷
          ${c ? `（課程：${esc(courseLabel(c))}）` : ''}
        </span>
      </div>
      <div class="preview-bar-right" style="display:flex;gap:0.5rem;align-items:center;">
        <button class="btn btn-secondary btn-sm" data-act="jump-to-my-survey" style="padding:0.35rem 0.85rem;font-size:0.85rem;margin:0;background:#ffffff;color:#92400e;font-weight:600;">
          ✍️ 前往問卷表單
        </button>
        <button class="btn btn-primary btn-sm" data-act="exit-simulation" style="padding:0.35rem 0.95rem;font-size:0.85rem;margin:0;background:#f59e0b;border-color:#d97706;font-weight:700;color:#ffffff;">
          ↩️ 結束測試，返回老師後台
        </button>
      </div>
    </div>`;
  }
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
      ${isLeader && c && c.groups.length ? `
      <label style="display:flex;align-items:center;gap:0.35rem;font-size:0.85rem;font-weight:600;">
        組別：
        <select data-act="preview-leader-group" style="padding:0.3rem 0.5rem;font-size:0.85rem;border-radius:6px;">
          ${c.groups.map(g => `<option value="${esc(g.id)}" ${previewLeaderGroup(c).id === g.id ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}
        </select>
      </label>` : ''}
      <button class="btn btn-secondary" data-act="switch-preview" data-mode="${isLeader ? 'public' : 'leader'}" style="padding:0.35rem 0.8rem;font-size:0.85rem;margin:0;">
        切換為${isLeader ? '一般學生視角' : '組長登入視角'}
      </button>
      <button class="btn btn-primary" data-act="switch-preview" data-mode="admin" style="padding:0.35rem 0.9rem;font-size:0.85rem;margin:0;">
        ⚙️ 返回老師後台
      </button>
    </div>
  </div>`;
}

/* ===== 缺席明細 Modal 彈窗元件 ===== */
function absenceDetailModalHtml() {
  if (!viewingAbsenceModal) return '';
  const { studentKey, studentName, studentId, details } = viewingAbsenceModal;
  // 僅老師後台（非預覽模式）可撤銷缺曠紀錄，撤銷會寫入點名異動日誌
  const canRevoke = state.session && state.session.role === 'teacher' && teacherPreviewMode === 'admin';
  return `
  <div class="absence-modal-overlay" data-act="close-absence-modal-bg">
    <div class="absence-modal-content">
      <div class="absence-modal-header">
        <h3><span>📋</span> <span>缺席明細<br><small class="vn-sub">Chi tiết vắng mặt</small></span></h3>
        <button class="absence-modal-close-btn" type="button" data-act="close-absence-modal" title="關閉 / Đóng">✕</button>
      </div>
      <div class="absence-modal-body">
        <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:0.65rem 0.85rem;margin-bottom:1rem;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.4rem;">
          <div>
            <strong>${esc(studentName)}</strong>
            <span style="color:#64748b;font-size:0.85rem;margin-left:0.35rem;">(${esc(studentId)})</span>
          </div>
          <span style="font-size:0.85rem;font-weight:700;color:#dc2626;background:#fee2e2;padding:0.15rem 0.5rem;border-radius:999px;">
            共計缺席 ${details.length} 次<small class="vn-sub">Tổng cộng vắng ${details.length} lần</small>
          </span>
        </div>
        ${details.length ? `
          <div class="absence-detail-list">
            ${details.map(d => `
              <div class="absence-detail-item">
                <span class="absence-detail-date">📅 ${esc(d.date)}</span>
                <div style="flex:1;">
                  <div class="absence-detail-name">${esc(d.activityName)}</div>
                  <div style="margin-top:0.2rem;font-size:0.78rem;color:#64748b;">
                    ${d.isDaily ? '<span class="absence-detail-tag">日常點名（Hàng ngày）</span>' : '<span class="absence-detail-tag" style="background:#fef3c7;color:#92400e;">重要集會（Sự kiện）</span>'}
                    ${d.markedByName ? `<span style="margin-left:0.4rem;">點名者（Người điểm danh）：${esc(d.markedByName)}</span>` : ''}
                  </div>
                </div>
                ${canRevoke ? `<button class="tab-btn" type="button" data-act="revoke-absence" data-session="${esc(d.sessionId)}" data-student="${esc(studentKey)}" title="撤銷此筆缺曠紀錄（改為出席，並記錄於點名異動日誌）" style="align-self:center;padding:0.2rem 0.55rem;font-size:0.78rem;color:#b91c1c;border-color:#fca5a5;">↩️ 撤銷缺曠</button>` : ''}
              </div>
            `).join('')}
          </div>
        ` : '<p class="file-path" style="text-align:center;color:#166534;">✅ 該學生目前無任何缺席紀錄。<br><small class="vn-sub">Sinh viên này hiện không có ghi nhận vắng mặt.</small></p>'}
      </div>
      <div class="absence-modal-footer">
        <button class="btn btn-secondary" style="padding:0.4rem 1.1rem;font-size:0.88rem;margin:0;" data-act="close-absence-modal">
          關閉<br><small class="vn-sub">Đóng</small>
        </button>
      </div>
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

  document.getElementById('app').innerHTML =
    nav() + teacherPreviewBanner() + '<div class="container">' + body + '</div>' + absenceDetailModalHtml() + surveyModalsHtml();
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

async function exportLogsCSV(c, category) {
  let logs = fullLogsByCourse[c.id];
  if (!logs || !logs.length) {
    try {
      const res = await apiPost('teacher:get-logs', { courseId: c.id });
      if (res && res.logs) {
        fullLogsByCourse[c.id] = res.logs;
        logs = res.logs;
      }
    } catch (_) {}
  }
  logs = (logs || c.logs || []).filter(l => logCategoryOf(l.actionType) === category);
  const rows = [['時間', '動作類別', '操作者身分', '操作者學號', '操作者姓名', '組別', '對象學號', '對象姓名', '詳細說明']];
  logs.forEach(l => {
    rows.push([
      formatLogTime(l.createdAt),
      formatActionTypeLabel(l.actionType),
      l.operatorRole === 'leader' ? '組長' : l.operatorRole === 'vice' ? '副組長' : l.operatorRole === 'teacher' ? '老師' : l.operatorRole === 'system' ? '系統' : l.operatorRole === 'student' ? '學生' : l.operatorRole,
      l.operatorId || '',
      l.operatorName || '',
      l.groupName || '',
      l.targetId || '',
      l.targetName || '',
      l.detail || '',
    ]);
  });
  const csv = '﻿' + rows.map(r => r.map(x => `"${String(x).replace(/"/g, '""')}"`).join(',')).join('\n');
  download(csv, 'text/csv;charset=utf-8', `${c.year || ''}_${c.subject || ''}_${LOG_PANEL_META[category].file}.csv`);
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
    const tokens = line.split(/\s*[,\t|]\s*|\s+/).filter(Boolean);
    if (tokens.length >= 3 && /^\d{1,3}$/.test(tokens[0]) && /^[a-zA-Z0-9_-]{4,}$/.test(tokens[1])) {
      rows.push({ id: tokens[1], name: tokens.slice(2).join(' ') });
    } else if (tokens.length >= 2) {
      rows.push({ id: tokens[0], name: tokens.slice(1).join(' ') });
    }
  });
  return { rows, skipped };
}

async function importText(c, text) {
  const { rows, skipped } = parseRoster(text);
  if (!rows.length) return alert('檔案沒有可匯入的資料');
  const res = await act('teacher:add-students', { courseId: c.id, students: rows });
  if (!res) return;
  const dup = rows.length - res.added;
  alert(`已匯入 ${res.added} 位學生${skipped ? `（略過標題列 ${skipped} 行）` : ''}${dup > 0 ? `，${dup} 筆學號重複已略過` : ''}`);
}

/* ===== Event delegation ===== */
const app = document.getElementById('app');
const needCourse = () => { const c = cur(); if (!c) { alert('請先選擇或建立課程'); return null; } return c; };

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
    if (!c) return alert('請先選擇課程\nVui lòng chọn khóa học trước');
    const name = (f.name ? f.name.value : '').trim();
    const password = (f.password ? f.password.value : (f.sid ? f.sid.value : '')).trim();
    return act('login-student', { courseId: c.id, name, password },
      { after: () => { loginMode = null; } });
  }
  if (a === 'change-student-password-page-form') {
    const current = (f.current ? f.current.value : '').trim();
    const next = (f.next ? f.next.value : '').trim();
    const confirm = (f.confirm ? f.confirm.value : '').trim();
    if (next !== confirm) {
      return alert('兩次輸入的新密碼不相符！\n(Mật khẩu nhập lại không khớp!)');
    }
    if (next.length < 4) {
      return alert('新密碼長度至少需 4 碼！\n(Mật khẩu phải có ít nhất 4 ký tự!)');
    }
    return act('change-student-password', { current, next }, {
      after: () => {
        alert('🎉 密碼已成功修改！下次登入請使用新密碼。\n(Đổi mật khẩu thành công! Lần đăng nhập sau vui lòng dùng mật khẩu mới.)');
        f.reset();
      }
    });
  }
  if (a === 'change-password') {
    const next = f.next.value;
    return act('teacher:change-password', { current: f.current.value, next },
      { after: () => alert('密碼已更新') });
  }
  if (a === 'save-bulletin-settings') {
    const size = parseInt(f.pageSize.value, 10);
    if (!size || size < 1 || size > 50) return alert('每頁顯示筆數必須在 1 至 50 之間');
    return act('teacher:set-bulletin-settings', { pageSize: size }, {
      after: () => alert(`公佈欄每頁顯示筆數已更新為 ${size} 筆！\n(Đã cập nhật số lượng thông báo mỗi trang: ${size})`),
    });
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
      after: () => alert('分組設定與注意事項已儲存完成！'),
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
      after: () => alert('分組截止時間已更新'),
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
    if (!confirm(`確定送出組員貢獻度評分？送出後您（組長）將獲得 ${maxB} 分加分，組員加分也將即時生效。\n\nXác nhận gửi đánh giá đóng góp? Bạn (Trưởng nhóm) sẽ nhận được +${maxB} điểm thưởng và điểm thưởng của thành viên sẽ có hiệu lực ngay lập tức.`)) return;
    return act('submit-peer-eval', { evaluations },
      { after: () => alert(`期末評分已成功送出！組長已獲得 ${maxB} 分加分，組員加分亦已同步更新。\n\nĐã gửi đánh giá thành công! Trưởng nhóm nhận +${maxB} điểm thưởng.`) });
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
      return alert(`尚有 ${missing.length} 位組員尚未確認出缺席，請組長／副組長逐一確認每位組員是否出席或缺席：\n${missing.map(m => m.name + ' (' + m.id + ')').join('、')}\n\nCòn ${missing.length} thành viên chưa xác nhận điểm danh. Trưởng/Phó nhóm vui lòng kiểm tra từng người.`);
    }
    const records = mates
      .map(m => ({ studentId: keyOf(m), status: fd.get(`att_${keyOf(m)}`) }))
      .filter(r => r.status === 'present' || r.status === 'absent');
    return act('mark-attendance', { sessionId, groupId, records },
      { after: () => alert('點名已送出\nĐã gửi điểm danh thành công') });
  }
  if (a === 'submit-survey') {
    const c = cur(), s = me();
    if (!c || !s) return;
    const catEl = f.querySelector('input[name="category"]:checked');
    if (!catEl || !catEl.value) {
      return alert('請選擇一個輔導面向！\nVui lòng chọn một hướng tư vấn!');
    }
    const content = (f.content ? f.content.value : '').trim();
    if (!content) {
      return alert('請填寫自述狀況或反映問題！\nVui lòng nhập nội dung tự thuật hoặc phản ánh!');
    }
    const cv = careCur(c);
    const isEdit = !!cv.mySurvey;
    const confirmMsg = isEdit
      ? '確定要送出修改的生活關懷問卷嗎？\n您的修改紀錄將會記錄於日誌中。\n\nXác nhận cập nhật khảo sát?'
      : '確定送出生活關懷問卷？\n\nXác nhận gửi khảo sát?';
    if (!confirm(confirmMsg)) return;

    return act('submit-survey', { surveyId: cv.careBatchId, category: catEl.value, content }, {
      after: () => {
        alert(isEdit
          ? '🎉 生活關懷問卷已成功更新！感謝您的反映。\nCập nhật khảo sát thành công!'
          : '🎉 生活關懷問卷已成功送出！感謝您的填寫。\nGửi khảo sát thành công!');
      }
    });
  }
  if (a === 'submit-absence-reason') {
    const reason = (f.reason ? f.reason.value : '').trim();
    if (!reason) return alert('請填寫缺曠原因說明！\nVui lòng nhập lý do vắng mặt!');
    if (!confirm('確定送出缺曠原因調查？\n\nXác nhận gửi khảo sát?')) return;
    return act('submit-absence-reason', { surveyId: f.dataset.survey, reason }, {
      after: () => alert('🎉 缺曠原因已送出！\nGửi khảo sát thành công!'),
    });
  }
  if (a === 'save-care-subtitle') {
    const c = cur();
    if (!c) return;
    return act('teacher:update-care-survey', { courseId: c.id, surveyId: careCur(c).careBatchId, subtitle: f.subtitle.value }, {
      after: () => alert('✅ 生活關懷問卷副標題已儲存'),
    });
  }
  if (a === 'create-care-survey') {
    const c = cur();
    if (!c) return;
    const subtitle = (f.subtitle.value || '').trim();
    if (!subtitle) return alert('請輸入新學期問卷副標題，例如 1152');
    return act('teacher:create-care-survey', { courseId: c.id, subtitle }, {
      after: (r) => {
        if (r && r.surveyId) careAdminId = r.surveyId;
        alert(`✅ 已新增「生活關懷問卷調查-${subtitle}」，請接著設定開放時段。`);
      },
    });
  }
  if (a === 'save-absence-config') {
    const c = cur();
    if (!c) return;
    return act('teacher:save-absence-config', { courseId: c.id, absenceBase: f.absenceBase.value, absenceStep: f.absenceStep.value }, {
      after: () => alert('✅ 缺曠輔導門檻已儲存'),
    });
  }
  if (a === 'create-absence-survey') {
    const c = cur();
    if (!c) return;
    return act('teacher:create-absence-survey', { courseId: c.id, threshold: f.threshold.value, subtitle: f.subtitle.value }, {
      after: data => {
        if (data && data.surveyId) absPicker = { surveyId: data.surveyId, selected: new Set() };
      },
    });
  }
  if (a === 'update-absence-meta') {
    const c = cur();
    if (!c) return;
    return act('teacher:update-absence-survey', { courseId: c.id, surveyId: f.dataset.survey, subtitle: f.subtitle.value, threshold: f.threshold.value }, {
      after: () => alert('✅ 問卷副標題與門檻已儲存'),
    });
  }
  if (a === 'save-survey-period') {
    const c = cur();
    if (!c) return;
    const surveyStart = (f.surveyStart ? f.surveyStart.value : '').trim();
    const surveyEnd = (f.surveyEnd ? f.surveyEnd.value : '').trim();
    if (surveyStart && surveyEnd && surveyStart > surveyEnd) {
      return alert('開始日期時間不得晚於結束日期時間！');
    }
    const hideUpcomingSurveys = !!(f.hideUpcomingSurveys && f.hideUpcomingSurveys.checked);
    return act('teacher:save-survey-period', { courseId: c.id, surveyId: careCur(c).careBatchId, surveyStart, surveyEnd, hideUpcomingSurveys }, {
      after: () => alert('✅ 問卷開放日期段及前台顯示設定已成功儲存！'),
    });
  }
  if (a === 'teacher-edit-survey-submit') {
    const c = cur();
    if (!c) return;
    const studentId = f.studentId.value;
    const category = f.category.value;
    const content = f.content.value.trim();
    if (!content) return alert('請填寫自述內容！');
    return act('teacher:update-survey-submission', { courseId: c.id, surveyId: careCur(c).careBatchId, studentId, category, content }, {
      after: () => {
        editingSurveyModal = null;
        alert('✅ 已成功修改學生問卷內容並記錄異動日誌！');
      }
    });
  }
});

app.addEventListener('click', e => {
  const btn = e.target.closest('[data-act]');
  if (!btn || btn.tagName === 'INPUT' || btn.tagName === 'SELECT' || btn.tagName === 'FORM') return;
  const a = btn.dataset.act, id = btn.dataset.id;
  const c = cur();

  if (a === 'close-absence-modal') {
    viewingAbsenceModal = null;
    return render();
  }
  if (a === 'close-absence-modal-bg') {
    if (e.target.classList.contains('absence-modal-overlay')) {
      viewingAbsenceModal = null;
      return render();
    }
  }
  if (a === 'export-marker-leaderboard-csv') {
    if (!c) return;
    exportMarkerLeaderboardCSV(c);
    return;
  }
  if (a === 'set-list-page') {
    const page = parseInt(btn.dataset.page, 10);
    if (page > 0) { listPages[btn.dataset.key] = page; return render(); }
    return;
  }
  if (a === 'set-attendance-leaderboard-page') {
    const page = parseInt(btn.dataset.page, 10);
    if (page && page > 0) {
      attendanceLeaderboardPage = page;
      return render();
    }
    return;
  }
  if (a === 'set-public-leaderboard-page') {
    const page = parseInt(btn.dataset.page, 10);
    if (page && page > 0) {
      publicAttendanceLeaderboardPage = page;
      return render();
    }
    return;
  }
  if (a === 'view-absence-detail') {
    if (!c) return;
    const studentKey = btn.dataset.student;
    let studentName = btn.dataset.name || studentKey;
    const studentId = btn.dataset.id || studentKey;
    if (!studentName || studentName === studentId) {
      const matchingRec = (c.attendanceRecords || []).find(r => r.studentId === studentKey || r.ref === studentKey);
      const targetRef = matchingRec ? matchingRec.ref : studentKey;
      const targetSid = matchingRec ? matchingRec.studentId : studentKey;
      const st = c.students.find(s => s.id === targetSid || (targetRef && s.ref === targetRef) || s.id === studentKey || s.ref === studentKey);
      if (st && st.name) studentName = st.name;
      else if (matchingRec && matchingRec.studentName) studentName = matchingRec.studentName;
    }
    const details = getStudentAbsenceList(c, studentKey);
    viewingAbsenceModal = { studentKey, studentName, studentId, details };
    return render();
  }
  if (a === 'revoke-absence') {
    if (!c || !viewingAbsenceModal) return;
    const { studentKey, studentName } = viewingAbsenceModal;
    if (!confirm(`確定要撤銷【${studentName}】於此時段的缺曠紀錄嗎？\n\n撤銷後該筆紀錄改為「出席」，並會記錄於點名異動日誌中。`)) return;
    return act('teacher:revoke-absence', { courseId: c.id, sessionId: btn.dataset.session, studentId: btn.dataset.student }, {
      after: () => {
        delete fullLogsByCourse[c.id];
        const fresh = cur();
        if (viewingAbsenceModal && fresh) viewingAbsenceModal.details = getStudentAbsenceList(fresh, studentKey);
      }
    });
  }
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
        localStorage.removeItem(TEACHER_VIEW_KEY);
        try {
          window.history.replaceState({}, '', window.location.pathname + window.location.search);
        } catch (_) {}
      }
    });
  }
  if (a === 'show-teacher-login') { e.preventDefault(); loginMode = loginMode === 'teacher' ? null : 'teacher'; return render(); }
  if (a === 'open-leader-login') {
    // 申請擔任組長：停留在目前分組頁面顯示登入表單，登入後未分組學生即可開組挑選組員（不像 show-student-login 會跳轉去問卷頁）
    e.preventDefault();
    loginMode = loginMode === 'student' ? null : 'student';
    render();
    document.getElementById('login')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
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
function setTeacherView(newView, courseId = null, pushHistory = true) {
  if (courseId !== null && courseId !== undefined) {
    state.currentId = courseId;
    localStorage.setItem(CURRENT_KEY, state.currentId);
  }
  if (teacherView !== newView) { logActionFilter = 'all'; logSearchText = ''; resetLogPages(); }
  teacherView = newView;
  localStorage.setItem(TEACHER_VIEW_KEY, teacherView);

  const targetHash = (teacherView && teacherView !== 'course') ? `#${teacherView}` : '';
  const targetUrl = window.location.pathname + window.location.search + targetHash;

  if (pushHistory) {
    try {
      window.history.pushState({ teacherView, currentId: state.currentId }, '', targetUrl);
    } catch (_) {}
  } else {
    try {
      window.history.replaceState({ teacherView, currentId: state.currentId }, '', targetUrl);
    } catch (_) {}
  }
  render();
  if (teacherView === 'logs') {
    const curCourse = cur();
    if (curCourse) loadCourseLogs(curCourse.id);
  }
}

  if (a === 'set-bulletin-page') {
    const page = parseInt(btn.dataset.page, 10);
    if (page && page > 0) {
      bulletinPage = page;
      render();
      const el = document.getElementById('notice-block');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    return;
  }
  if (a === 'set-public-survey-page') {
    const page = parseInt(btn.dataset.page, 10);
    if (page && page > 0) {
      publicSurveyUncompletedPages[btn.dataset.bid || ''] = page;
      return render();
    }
    return;
  }
  if (a === 'nav-public-subview') {
    publicSubView = btn.dataset.view || 'dashboard';
    if (publicSubView === 'survey') publicSurveyCard = '';
    if (btn.dataset.course && btn.dataset.course !== state.currentId) {
      state.currentId = btn.dataset.course;
      localStorage.setItem(CURRENT_KEY, state.currentId);
    }
    try {
      const targetHash = publicSubView ? `#${publicSubView}` : '';
      const targetUrl = window.location.pathname + window.location.search + targetHash;
      window.history.pushState({ publicSubView, currentId: state.currentId }, '', targetUrl);
    } catch (_) {}
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  if (a === 'open-survey-page' || a === 'show-student-login') {
    e.preventDefault();
    publicSubView = 'survey';
    publicSurveyCard = 'care:' + (btn.dataset.bid || careCur(c || {}).careBatchId);
    loginMode = null;
    try {
      const targetUrl = window.location.pathname + window.location.search + '#survey';
      window.history.pushState({ publicSubView: 'survey', currentId: state.currentId }, '', targetUrl);
    } catch (_) {}
    render();
    setTimeout(() => {
      const nameIn = document.querySelector('.survey-login-form input[name="name"]');
      if (nameIn) nameIn.focus();
    }, 60);
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  if (a === 'quick-survey-login') {
    e.preventDefault();
    publicSubView = 'survey';
    publicSurveyCard = 'care:' + (btn.dataset.bid || careCur(c || {}).careBatchId);
    loginMode = null;
    try {
      const targetUrl = window.location.pathname + window.location.search + '#survey';
      window.history.pushState({ publicSubView: 'survey', currentId: state.currentId }, '', targetUrl);
    } catch (_) {}
    render();
    setTimeout(() => {
      const nameIn = document.querySelector('.survey-login-form input[name="name"]') || document.querySelector('#login input[name="name"]');
      const pwIn = document.querySelector('.survey-login-form input[name="password"]') || document.querySelector('#login input[name="password"]');
      if (nameIn && btn.dataset.name) nameIn.value = btn.dataset.name;
      if (pwIn && btn.dataset.id && !btn.dataset.id.includes('*')) pwIn.value = btn.dataset.id;
      if (pwIn) pwIn.focus();
    }, 60);
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  if (a === 'close-login') { loginMode = null; return render(); }
  if (a === 'sys-password') { return setTeacherView('settings'); }
  if (a === 'sys-peer-eval') { return setTeacherView('eval'); }
  if (a === 'sys-logs') { return setTeacherView('logs'); }
  if (a === 'sys-attendance') { attendanceEditingId = null; return setTeacherView('attendance'); }
  if (a === 'sys-wellbeing') { return setTeacherView('wellbeing'); }
  if (a === 'toggle-wb-tree') { wbTreeOpen = !wbTreeOpen; return render(); }
  if (a === 'wb-section') {
    wbSection = btn.dataset.sec;
    if (wbSection.startsWith('care:')) {
      careAdminId = wbSection.slice(5);
      surveyGroupFilter = 'all';
      surveyCategoryFilter = 'all';
      surveySearchText = '';
    }
    if (teacherView !== 'wellbeing') return setTeacherView('wellbeing');
    return render();
  }
  if (a === 'sys-bulletin') { return setTeacherView('bulletin'); }
  if (a === 'sys-system') { return setTeacherView('system'); }
  if (a === 'refresh-system-status') { const cc = cur(); return loadSystemStatus(cc ? cc.id : '', true); }
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
    return setTeacherView('logs', id || null);
  }
  if (a === 'refresh-course-logs') {
    if (c) loadCourseLogs(c.id, true);
    return;
  }
  if (a === 'back-to-course') { return setTeacherView('course'); }
  if (a === 'history-back') { window.history.back(); return; }
  if (a === 'reset-log-filter') { logSearchText = ''; logActionFilter = 'all'; resetLogPages(); return render(); }
  if (a === 'export-logs-csv') { return c && exportLogsCSV(c, btn.dataset.category); }
  if (a === 'clear-course-logs') {
    if (!c) return;
    const category = btn.dataset.category;
    if (!confirm(`確定要清空「${courseLabel(c)}」的${LOG_PANEL_META[category].file}嗎？\n\n此動作將清除該類所有過往軌跡且無法復原！`)) return;
    delete fullLogsByCourse[c.id];
    return act('teacher:clear-logs', { courseId: c.id, category });
  }
  if (a === 'set-bulletin-pagesize-preset') {
    const size = parseInt(btn.dataset.size, 10);
    const input = document.getElementById('bulletinPageSizeInput');
    if (input) input.value = size;
    return;
  }
  if (a === 'pick-course-node' || a === 'pick-course') {
    const nextView = (teacherView === 'eval' || teacherView === 'logs' || teacherView === 'attendance' || teacherView === 'wellbeing' || teacherView === 'settings' || teacherView === 'system' || teacherView === 'bulletin') ? teacherView : 'course';
    if (!state.session || state.session.role !== 'teacher') {
      publicSubView = 'dashboard';
    }
    return setTeacherView(nextView, id || btn.value);
  }
  if (a === 'new-course') { state.currentId = null; return setTeacherView('course', null); }

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
    if (!c.students.length) return alert('請先匯入學生名單');
    const n = Math.max(1, Math.ceil(c.students.length / Math.max(1, c.groupSize || 4)));
    if (!confirm(`確定要【重新計算並建立全新空組別】？\n\n📌 動作說明：\n1. 將清除現有所有分組，全班 ${c.students.length} 位學生退回未分組狀態。\n2. 系統將依每組 ${c.groupSize || 4} 人，重新產生 ${n} 個全新的空白組別（第 1 ~ 第 ${n} 組）。\n3. 學生名單與登入帳號完整保留。\n\n系統已自動建立備份快照，稍後如有需要可點擊「回到上一步」復原。確定執行？`)) return;
    return act('teacher:make-groups', { courseId: c.id });
  }
  if (a === 'make-remaining-groups') {
    if (!c) return;
    const unassigned = c.students.filter(s => !s.groupId);
    if (!unassigned.length) return alert('目前所有學生皆已分組，無未分組學生');
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
    if (!c.groups.length) return alert('本科目目前已無任何組別');
    if (!confirm(`⚠️ 確定要【清空所有組別（組別數歸 0）】？\n\n📌 動作說明：\n1. 將刪除現有的全部 ${c.groups.length} 個組別，組別數將變為 0 組（不會自動產生任何新組別）。\n2. 全班學生全數退回未分組狀態。\n3. 學生名單與登入帳號完整保留。\n\n系統已自動建立備份快照，稍後如有需要可點擊「回到上一步」復原。確定執行？`)) return;
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
    if (!checked.length) return alert('請先勾選欲刪除的組別');
    if (!confirm(`確定要刪除勾選的 ${checked.length} 個組別？\n\n被刪組別的組員將退回未分組名單，其餘組別與修課名單不受影響。`)) return;
    return act('teacher:del-groups', { courseId: c.id, groupIds: checked });
  }
  if (a === 'auto-assign') {
    if (!c) return;
    const unassignedList = c.students.filter(s => !s.groupId);
    if (!unassignedList.length) return alert('目前所有學生皆已分組，無未分組學生');
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
  if (a === 'unclaim-leader') {
    if (!confirm('確定取消組長身分？\nBạn có chắc muốn từ chức trưởng nhóm không?')) return;
    return act('unclaim-leader');
  }
  if (a === 'toggle-vice') return act('toggle-vice', { studentId: id });
  if (a === 'drop') {
    if (!confirm('確定要將該組員移出？\n移出後該成員將釋出回到「未分配的成員名單」中。\n\nBạn có chắc muốn loại thành viên này khỏi nhóm? Thành viên sẽ quay về danh sách chưa có nhóm.')) return;
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
  }
  if (a === 'teacher-reset-student-pw') {
    if (!c) return;
    const sid = btn.dataset.id;
    const sname = btn.dataset.name;
    if (!confirm(`確定要將【${sname} (${sid})】的登入密碼重設回「預設學號 (${sid})」嗎？`)) return;
    return act('teacher:change-student-password', {
      courseId: c.id,
      studentId: sid,
      resetToDefault: true,
    }, {
      after: () => alert(`✅ 已成功將【${sname}】的登入密碼重設為預設學號：${sid}`),
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

  /* ===== 生活關懷問卷點擊互動 ===== */
  if (a === 'set-survey-tab') {
    surveyActiveTab = btn.dataset.tab || 'uncompleted';
    return render();
  }
  if (a === 'filter-cat-chip') {
    const cat = btn.dataset.cat;
    surveyCategoryFilter = (surveyCategoryFilter === cat) ? 'all' : cat;
    return render();
  }
  if (a === 'reset-survey-filters') {
    surveyCategoryFilter = 'all';
    surveyGroupFilter = 'all';
    surveySearchText = '';
    return render();
  }
  if (a === 'view-survey-detail') {
    viewingSurveyModal = btn.dataset.id;
    return render();
  }
  if (a === 'close-survey-detail-modal') {
    viewingSurveyModal = null;
    return render();
  }
  if (a === 'close-survey-detail-modal-bg') {
    if (e.target.classList.contains('absence-modal-overlay')) {
      viewingSurveyModal = null;
      return render();
    }
  }
  if (a === 'teacher-edit-survey-modal') {
    if (!c) return;
    const sid = btn.dataset.id;
    const sub = (careCur(c).surveySubmissions || []).find(x => x.studentId === sid);
    if (!sub) return;
    const st = c.students.find(x => x.id === sid);
    viewingSurveyModal = null;
    editingSurveyModal = {
      studentId: sid,
      studentName: st ? st.name : sub.studentName || sid,
      category: sub.category || '',
      content: sub.content || '',
    };
    return render();
  }
  if (a === 'close-edit-survey-modal') {
    editingSurveyModal = null;
    return render();
  }
  if (a === 'close-edit-survey-modal-bg') {
    if (e.target.classList.contains('absence-modal-overlay')) {
      editingSurveyModal = null;
      return render();
    }
  }
  if (a === 'simulate-student') {
    if (!c) return;
    const sid = btn.dataset.id;
    const st = c.students.find(s => s.id === sid);
    if (!st) return;
    if (!confirm(`確定轉換身分為學生「${st.name} (${st.id})」登入以測試生活關懷問卷？\n\n轉換後您將能以該學生視角測試填寫、送出與修改問卷。\n隨時可點擊頂部橫幅返回老師後台。`)) return;
    return act('teacher:simulate-student', { courseId: c.id, studentId: sid }, {
      after: () => {
        teacherView = 'course';
        loginMode = null;
        publicSubView = 'survey';
      }
    });
  }
  if (a === 'exit-simulation') {
    return act('exit-simulation', {}, {
      after: () => {
        teacherView = 'wellbeing';
        teacherPreviewMode = 'admin';
      }
    });
  }
  if (a === 'open-simulate-student-modal') {
    simulatingStudentModal = true;
    return render();
  }
  if (a === 'close-simulate-modal' || a === 'close-simulate-modal-bg') {
    if (a === 'close-simulate-modal-bg' && !e.target.classList.contains('absence-modal-overlay')) return;
    simulatingStudentModal = false;
    return render();
  }
  if (a === 'confirm-simulate-student') {
    if (!c) return;
    const sel = document.getElementById('simulate-student-select');
    if (!sel || !sel.value) return;
    const sid = sel.value;
    const cardKey = simulateSurveyKey;
    simulatingStudentModal = false;
    return act('teacher:simulate-student', { courseId: c.id, studentId: sid }, {
      after: () => {
        teacherView = 'course';
        loginMode = null;
        publicSubView = 'survey';
        publicSurveyCard = cardKey;
      }
    });
  }
  if (a === 'clear-student-survey-logs') {
    if (!c) return;
    const sid = btn.dataset.id;
    const st = c.students.find(x => x.id === sid);
    const sname = st ? st.name : sid;
    if (!confirm(`確定要清除學生「${sname} (${sid})」的生活關懷問卷修改紀錄嗎？\n\n此動作將清空該學生的修改歷程日誌，清除測試產生的修改痕跡。`)) return;
    return act('teacher:clear-survey-logs', { courseId: c.id, surveyId: careCur(c).careBatchId, studentId: sid }, {
      after: () => {
        viewingSurveyLogsModal = null;
        alert(`已成功清除【${sname}】的生活關懷問卷修改歷程日誌！`);
      }
    });
  }
  if (a === 'clear-course-survey-logs') {
    if (!c) return;
    if (!confirm(`確定要清空本科目「${courseLabel(c)}」全體學生的生活關懷問卷修改歷程日誌嗎？\n\n注意：此動作將清空所有修改歷程日誌，無法復原！`)) return;
    return act('teacher:clear-survey-logs', { courseId: c.id, surveyId: careCur(c).careBatchId }, {
      after: () => {
        alert('已成功清空全班生活關懷問卷修改歷程日誌！');
      }
    });
  }
  if (a === 'delete-survey-submission') {
    if (!c) return;
    const sid = btn.dataset.id;
    const sname = btn.dataset.name || sid;
    if (!confirm(`確定要刪除學生「${sname} (${sid})」的生活關懷問卷紀錄嗎？\n\n刪除後該學生可重新填寫問卷，此刪除動作亦將記錄於異動日誌。`)) return;
    return act('teacher:delete-survey-submission', { courseId: c.id, surveyId: careCur(c).careBatchId, studentId: sid });
  }
  if (a === 'view-survey-logs-modal') {
    if (!c) return;
    const sid = btn.dataset.id;
    const st = c.students.find(x => x.id === sid);
    const logs = (careCur(c).surveyLogs || []).filter(l => l.studentId === sid);
    viewingSurveyLogsModal = {
      studentId: sid,
      studentName: st ? st.name : sid,
      logs,
    };
    return render();
  }
  if (a === 'view-my-survey-logs') {
    if (!c) return;
    const s = me();
    if (!s) return;
    viewingSurveyLogsModal = {
      studentId: s.id,
      studentName: s.name,
      logs: careCur(c).mySurveyLogs || [],
    };
    return render();
  }
  if (a === 'close-survey-logs-modal') {
    viewingSurveyLogsModal = null;
    return render();
  }
  if (a === 'close-survey-logs-modal-bg') {
    if (e.target.classList.contains('absence-modal-overlay')) {
      viewingSurveyLogsModal = null;
      return render();
    }
  }
  if (a === 'export-survey-csv') {
    if (!c) return;
    exportSurveyCSV(careCur(c));
    return;
  }
  if (a === 'toggle-survey-card') {
    const k = btn.dataset.key || '';
    if (surveyCardOpen.has(k)) surveyCardOpen.delete(k); else surveyCardOpen.add(k);
    return render();
  }
  if (a === 'open-survey-card') {
    publicSurveyCard = btn.dataset.key || '';
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  if (a === 'back-survey-list') {
    publicSurveyCard = '';
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  if (a === 'move-card') {
    if (!c) return;
    const keys = surveyCardList(c, false).map(x => x.key);
    const i = keys.indexOf(btn.dataset.key), j = i + Number(btn.dataset.dir);
    if (i < 0 || j < 0 || j >= keys.length) return;
    [keys[i], keys[j]] = [keys[j], keys[i]];
    return act('teacher:save-survey-layout', { courseId: c.id, order: keys });
  }
  if (a === 'open-abs-picker') {
    if (!c) return;
    const sv = (c.absenceSurveys || []).find(x => x.id === btn.dataset.survey);
    if (!sv) return;
    absPicker = { surveyId: sv.id, selected: new Set(sv.studentIds || []) };
    return render();
  }
  if (a === 'close-abs-picker' || a === 'close-abs-picker-bg') {
    if (a === 'close-abs-picker-bg' && !e.target.classList.contains('absence-modal-overlay')) return;
    absPicker = null;
    return render();
  }
  if (a === 'abs-pick-none') {
    if (absPicker) absPicker.selected.clear();
    return render();
  }
  if (a === 'abs-pick-reach') {
    if (!c || !absPicker) return;
    const sv = (c.absenceSurveys || []).find(x => x.id === absPicker.surveyId);
    const counts = attendanceAbsentCounts(c, null);
    c.students.forEach(s => { if (sv && (counts[s.id] || 0) >= sv.threshold) absPicker.selected.add(s.id); });
    return render();
  }
  if (a === 'abs-pick-save') {
    if (!c || !absPicker) return;
    const payload = { courseId: c.id, surveyId: absPicker.surveyId, studentIds: [...absPicker.selected] };
    return act('teacher:update-absence-survey', payload, {
      after: () => { absPicker = null; },
    });
  }
  if (a === 'export-absence-csv') {
    const sv = c && (c.absenceSurveys || []).find(x => x.id === btn.dataset.survey);
    if (sv) exportAbsenceCSV(c, sv);
    return;
  }
  if (a === 'delete-absence-survey') {
    const selId = btn.parentElement.querySelector('[data-role="abs-delete-select"]')?.value;
    const sv = c && (c.absenceSurveys || []).find(x => x.id === selId);
    if (!sv) return;
    if (!confirm(`確定刪除「${absenceTitle(sv)}」？\n該問卷的名單與全部學生填寫內容都會一併刪除，無法復原。`)) return;
    return act('teacher:delete-absence-survey', { courseId: c.id, surveyId: sv.id });
  }
  if (a === 'delete-care-survey') {
    if (!c) return;
    const cv = careCur(c);
    if (!confirm(`確定要刪除「${careTitle(cv)}」嗎？\n\n該份問卷的全部填寫紀錄與日誌都會一併刪除，無法復原！`)) return;
    return act('teacher:delete-care-survey', { courseId: c.id, surveyId: cv.careBatchId }, {
      after: () => { careAdminId = ''; },
    });
  }
  if (a === 'delete-absence-response') {
    if (!c) return;
    if (!confirm('確定刪除這筆缺曠原因填寫？學生可重新填寫。')) return;
    return act('teacher:delete-absence-response', { courseId: c.id, surveyId: btn.dataset.survey, studentId: btn.dataset.id });
  }
  if (a === 'clear-survey-period') {
    if (!c) return;
    if (!confirm('確定要清除日期限制，改為隨時開放填寫嗎？')) return;
    return act('teacher:save-survey-period', { courseId: c.id, surveyId: careCur(c).careBatchId, surveyStart: '', surveyEnd: '', hideUpcomingSurveys: !!careCur(c).hideUpcomingSurveys }, {
      after: () => alert('已更新為隨時開放填寫！'),
    });
  }
  if (a === 'show-public-uncompleted-modal') {
    showPublicUncompletedModal = true;
    return render();
  }
  if (a === 'close-public-uncompleted-modal') {
    showPublicUncompletedModal = false;
    return render();
  }
  if (a === 'close-public-uncompleted-modal-bg') {
    if (e.target.classList.contains('absence-modal-overlay')) {
      showPublicUncompletedModal = false;
      return render();
    }
  }
  if (a === 'copy-leader-uncompleted-survey') {
    if (!c) return;
    const s = me();
    const g = s && s.groupId ? c.groups.find(x => x.id === s.groupId) : null;
    const cvc = careCur(c);
    const mates = g ? members(cvc, g.id) : [];
    const uncompletedMates = mates.filter(m => !m.surveyCompleted);
    if (!uncompletedMates.length) {
      return alert('🎉 本組所有組員皆已完成問卷填寫！\nCả nhóm đã hoàn thành!');
    }
    const text = `📢【生活關懷問卷填寫提醒 / Nhắc nhở khảo sát】\n課程：${courseLabel(c)}\n組別：${g.name}\n\n目前本組尚有以下同學尚未填寫生活關懷問卷，請撥空儘速登入系統完成填寫：\n${uncompletedMates.map((m, i) => `${i + 1}. ${m.name} (${m.id})`).join('\n')}\n\n👉 請至分組系統登入填寫，謝謝大家配合！\n(Vui lòng đăng nhập hệ thống để hoàn thành khảo sát, cảm ơn các bạn!)`;
    copyTextToClipboard(text, '已複製本組未填寫名單提醒文字！可直接貼至 LINE / Zalo 群組催填。\nĐã sao chép nội dung nhắc nhở!');
    return;
  }
  if (a === 'copy-care-message') {
    if (!c) return;
    const x = careAbsenceList(c, careAbsenceThreshold).find(v => v.key === btn.dataset.student);
    if (!x) return;
    copyTextToClipboard(careMessageText(c, x), `已複製給 ${x.name} 的關懷訊息！可直接貼至 LINE 私訊傳送。`);
    return;
  }
  if (a === 'copy-all-care-messages') {
    if (!c) return;
    const list = careAbsenceList(c, careAbsenceThreshold);
    if (!list.length) return alert(`目前沒有整學期缺席超過 ${careAbsenceThreshold} 次的學生。`);
    const text = list.map(x => `━━━━ ${x.name}（${x.id}｜${x.groupName}｜缺席 ${x.count} 次）━━━━\n${careMessageText(c, x)}`).join('\n\n');
    copyTextToClipboard(text, `已複製 ${list.length} 位學生的關懷訊息！請依姓名分段貼至各自的 LINE 私訊。`);
    return;
  }
  if (a === 'copy-teacher-uncompleted-survey') {
    if (!c) return;
    const stats = getSurveyStats(careCur(c));
    if (!stats.uncompleted) {
      return alert('🎉 本科目所有修課學生皆已完成問卷填寫！');
    }
    const text = `📢【生活關懷問卷未填寫催填提醒名單】\n課程：${courseLabel(c)}\n應填人數：${stats.total} 人 | 未完成：${stats.uncompleted} 人\n\n尚未填寫名單如下：\n${stats.uncompletedList.map((st, i) => `${i + 1}. [${st.groupName}] 組長:${st.leaderName} ➔ ${st.name} (${st.id})`).join('\n')}\n\n請各組組長協助提醒組員至分組平台登入填寫生活關懷問卷，謝謝！`;
    copyTextToClipboard(text, '已複製全班未完成名單提醒文字！可直接貼至班級群組或寄信通知。');
    return;
  }
  if (a === 'copy-public-uncompleted-survey') {
    if (!c) return;
    const stats = getSurveyStats(careCur(c));
    if (!stats.uncompleted) {
      return alert('🎉 本課程全班同學皆已完成問卷填寫！\nTất cả sinh viên đã hoàn thành khảo sát!');
    }
    const text = `📢【生活關懷問卷未填寫提醒 / Nhắc nhở khảo sát】\n課程：${courseLabel(c)}\n未完成人數：${stats.uncompleted} 人\n\n尚未填寫同學名單：\n${stats.uncompletedList.map((st, i) => `${i + 1}. [${st.groupName}] ${st.name}`).join('\n')}\n\n請尚未填寫的同學撥空登入完成問卷，謝謝配合！\n(Vui lòng đăng nhập hệ thống để hoàn thành khảo sát, cảm ơn các bạn!)`;
    copyTextToClipboard(text, '已複製未完成名單！可貼至群組提醒。\nĐã sao chép danh sách!');
    return;
  }
  if (a === 'jump-to-my-survey') {
    publicSubView = 'survey';
    if (btn.dataset.bid || !publicSurveyCard) publicSurveyCard = 'care:' + (btn.dataset.bid || careCur(c || {}).careBatchId);
    render();
    setTimeout(() => {
      const el = document.querySelector('.student-survey-panel');
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        el.style.boxShadow = '0 0 0 4px #0d9488';
        setTimeout(() => { el.style.boxShadow = ''; }, 2000);
      }
    }, 60);
    return;
  }
});

app.addEventListener('change', e => {
  const t = e.target;
  if (t.name === 'category' && t.type === 'radio') {
    document.querySelectorAll('.survey-cat-chip').forEach(chip => {
      chip.classList.toggle('active', chip.querySelector('input[type="radio"]:checked') !== null);
    });
  }
  const a = t.dataset.act;
  if (!a) return;
  const id = t.dataset.id;
  const c = cur();

  if (a === 'simulate-survey-change') {
    simulateSurveyKey = t.value;
    const stu = document.getElementById('simulate-student-select');
    const keep = stu ? stu.value : '';
    render();
    const again = document.getElementById('simulate-student-select');
    if (again && keep) again.value = keep;
    return;
  }
  if (a === 'survey-cat-filter') {
    surveyCategoryFilter = t.value;
    return render();
  }
  if (a === 'abs-pick-toggle') {
    if (!absPicker) return;
    if (t.checked) absPicker.selected.add(id); else absPicker.selected.delete(id);
    const cnt = document.querySelector('#abs-pick-count b');
    if (cnt) cnt.textContent = absPicker.selected.size;
    return;
  }
  if (a === 'toggle-card-visible') {
    if (!c) return;
    const key = t.dataset.key;
    if (key.startsWith('care:')) {
      return act('teacher:save-survey-layout', { courseId: c.id, order: surveyCardList(c, false).map(x => x.key), careSurveyId: key.slice(5), careVisible: t.checked });
    }
    return act('teacher:update-absence-survey', { courseId: c.id, surveyId: key.slice(4), visible: t.checked });
  }
  if (a === 'care-admin-select') {
    careAdminId = t.value;
    surveyGroupFilter = 'all';
    surveyCategoryFilter = 'all';
    surveySearchText = '';
    return render();
  }
  if (a === 'survey-group-filter') {
    surveyGroupFilter = t.value;
    return render();
  }

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
    resetLogPages();
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
  if (a === 'preview-leader-group') {
    previewLeaderGroupId = t.value;
    try { localStorage.setItem(PREVIEW_GROUP_KEY, previewLeaderGroupId); } catch (_) {}
    return render();
  }
  if (a === 'attendance-stat-date') { attendanceStatDate = t.value; attendanceEditSessionId = ''; attendanceLeaderboardPage = 1; return render(); }
  if (a === 'attendance-edit-session') { attendanceEditSessionId = t.value; return render(); }
  if (a === 'teacher-set-attendance') {
    if (!t.value) return;
    return act('teacher:set-attendance-record', { courseId: c.id, sessionId: t.dataset.session, studentId: t.dataset.student, status: t.value }, {
      after: () => { delete fullLogsByCourse[c.id]; }
    });
  }
  if (a === 'attendance-stat-scope') { attendanceStatScope = t.value; attendanceLeaderboardPage = 1; return render(); }
  if (a === 'care-absence-threshold') { careAbsenceThreshold = Math.max(0, parseInt(t.value, 10) || 0); return render(); }
  if (a === 'public-attendance-stat-scope') { publicAttendanceStatScope = t.value; publicAttendanceLeaderboardPage = 1; return render(); }
  if (a === 'leader-attendance-stat-scope') { leaderAttendanceStatScope = t.value; publicAttendanceLeaderboardPage = 1; return render(); }
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
    resetLogPages();
    render();
    const input = document.querySelector('input[data-act="search-logs"]');
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }
  if (a === 'abs-pick-search') {
    const q = t.value.trim().toLowerCase();
    document.querySelectorAll('tr[data-q]').forEach(tr => { tr.style.display = !q || tr.dataset.q.includes(q) ? '' : 'none'; });
    return;
  }
  if (a === 'survey-search-input') {
    surveySearchText = t.value;
    render();
    const input = document.querySelector('input[data-act="survey-search-input"]');
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }
});

/* ===== 後台問卷卡片滑鼠拖拉排序（HTML5 Drag & Drop，放開後儲存順序） ===== */
app.addEventListener('dragstart', e => {
  const item = e.target.closest && e.target.closest('.survey-sort-item');
  if (!item) return;
  dragSurveyKey = item.dataset.key;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', dragSurveyKey);
  setTimeout(() => item.classList.add('dragging'), 0);
});
app.addEventListener('dragover', e => {
  const list = e.target.closest && e.target.closest('#survey-card-sort');
  if (!list || !dragSurveyKey) return;
  e.preventDefault();
  const dragging = list.querySelector('.dragging');
  if (!dragging) return;
  const after = [...list.querySelectorAll('.survey-sort-item:not(.dragging)')].find(el => {
    const r = el.getBoundingClientRect();
    return e.clientY < r.top + r.height / 2;
  });
  if (after) list.insertBefore(dragging, after); else list.appendChild(dragging);
});
app.addEventListener('dragend', () => {
  if (!dragSurveyKey) return;
  dragSurveyKey = null;
  const list = document.getElementById('survey-card-sort');
  const c = cur();
  if (!list || !c) return;
  const order = [...list.querySelectorAll('.survey-sort-item')].map(el => el.dataset.key);
  list.querySelectorAll('.dragging').forEach(el => el.classList.remove('dragging'));
  act('teacher:save-survey-layout', { courseId: c.id, order });
});

/* ===== 瀏覽器上一頁／下一頁 (popstate) 與 hashchange 支援 ===== */
window.addEventListener('popstate', e => {
  let newView = null;
  if (e.state && e.state.teacherView !== undefined) {
    newView = e.state.teacherView;
  } else {
    newView = parseViewFromHash() || 'course';
  }
  if (newView && newView !== teacherView) {
    teacherView = newView;
    localStorage.setItem(TEACHER_VIEW_KEY, teacherView);
  }

  // 同步公開頁面與學生端的子系統 (publicSubView)
  const hashSub = parseSubViewFromHash();
  if (e.state && e.state.publicSubView !== undefined) {
    publicSubView = e.state.publicSubView;
  } else if (hashSub) {
    publicSubView = hashSub;
  }

  if (e.state && e.state.currentId !== undefined && e.state.currentId !== state.currentId) {
    state.currentId = e.state.currentId;
    localStorage.setItem(CURRENT_KEY, state.currentId);
  }
  render();
  if (teacherView === 'logs') {
    const curCourse = cur();
    if (curCourse) loadCourseLogs(curCourse.id);
  }
});

window.addEventListener('hashchange', () => {
  const fromHash = parseViewFromHash();
  if (fromHash && fromHash !== teacherView) {
    teacherView = fromHash;
    localStorage.setItem(TEACHER_VIEW_KEY, teacherView);
  }
  const hashSub = parseSubViewFromHash();
  if (hashSub && hashSub !== publicSubView) {
    publicSubView = hashSub;
  }
  render();
  if (teacherView === 'logs') {
    const curCourse = cur();
    if (curCourse) loadCourseLogs(curCourse.id);
  }
});

/* ===== 啟動 ===== */
(async function start() {
  teacherView = getInitialTeacherView();
  publicSubView = getInitialPublicSubView();
  try {
    const isTeacher = state.session && state.session.role === 'teacher';
    let targetHash = '';
    if (isTeacher) {
      targetHash = (teacherView && teacherView !== 'course') ? `#${teacherView}` : '';
    } else {
      targetHash = (publicSubView && publicSubView !== 'dashboard') ? `#${publicSubView}` : '';
    }
    const targetUrl = window.location.pathname + window.location.search + targetHash;
    window.history.replaceState({ teacherView, publicSubView, currentId: state.currentId }, '', targetUrl);
  } catch (_) {}

  try {
    apply(await apiGet());
  } catch (err) {
    document.getElementById('app').innerHTML =
      `<div class="container"><div class="teacher-section"><h2>連線失敗<br><small class="vn-sub">Lỗi kết nối</small></h2>
       <p class="file-path">${String(err.message)}　請重新整理頁面。</p></div></div>`;
    return;
  }
  render();
  if (teacherView === 'logs') {
    const curCourse = cur();
    if (curCourse) loadCourseLogs(curCourse.id);
  }
  setInterval(poll, POLL_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
})();

