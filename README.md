# 113入學行銷真班 Student Grouping & Attendance

113入學行銷真班分組與點名系統：老師管理班級課程與名單，學生自行擔任組長並挑選組員，各組支援日常與特殊演練點名管理，前台即時顯示分組與缺席現況。

- 前端：原生 HTML / CSS / JavaScript（無框架）
- 後端：Cloudflare Workers（static assets）+ D1（SQLite）
- 資料共用：所有使用者連到同一個 D1 資料庫，任何人的異動其他人皆可看到（前台每 5 秒輪詢）

## 功能

**前台（訪客／學生）**
- 左側樹狀清單依「學年度 → 科目」選擇課程
- 各組獨立卡片呈現，組長置頂、副組長次之，另闢「未分組名單」區
- 學生以「姓名（帳號）+ 學號（密碼）」登入
- 學生可自行標示為組長（未分組者自動開一組）、挑選組員、標記副組長、移出組員

**後台（老師）**
- 左側學年度分組清單：切換／新增／刪除分組項目
- 分組設定：學年度、名稱、每組人數、誤差人數 ±、分組時限、加分上限
- 修課名單：匯入 .txt/.csv（標題列自動略過、重複學號略過）、手動增刪、指定組別與組長
- 分組管理：建立空組別、新增單組、隨機分配剩餘、清除本科目所有分組
- 逾時未被挑選者自動隨機分配並標示「自動」
- 匯出 JSON / CSV（含 BOM，Excel 中文不亂碼）
- 可修改老師登入密碼（預設 `clear6`，以 SHA-256 存於 D1）
- **點名管理**：設定點名日期、時段與名稱（可不填）；查看各組組長／副組長之點名異動紀錄（組別、學號、姓名、時間）、各組當日缺席標記、依日期或整學期之全班缺席統計，以及尚未完成點名的組別與組員缺席排行榜；可為特定時段（全部或單一組別）開放逾期補登權限
- **點名自動提醒**：上傳課表截圖（PNG）、設定每週各星期第一節上課時間，系統於上課時間＋可調整延遲分鐘數後自動發送 LINE 群組訊息提醒組長點名；提醒訊息可自訂，寒暑假可關閉總開關暫停發送

**組長／副組長點名（Điểm danh）**
- 於老師設定之點名時段當天，可為本組組員標記出席／缺席（雙語＋越南文標示，方便越南籍組長辨識）
- 超過當天則鎖定，需老師個別開放補登權限才能修改

## 安全性

- 老師密碼雜湊後存於 D1，登入後以 HMAC 簽章 cookie 維持 12 小時工作階段
- 學號同時是學生密碼，因此**對非老師一律遮蔽**（顯示 `410***`）；組長操作改用不可逆代號 `ref`
- 所有權限在伺服器端驗證：老師操作需老師 session，挑選組員需該組組長身分，逾時後一律拒絕
- 已知限制：姓名公開可見、學號可被暴力猜測，正式對外使用建議改用校方 SSO 或一次性驗證碼

## 架構

```
public/index.html     外殼，掛載 #app
public/js/script.js   前端全部邏輯（事件委派 + 每 5 秒輪詢）
public/css/styles.css 樣式，支援 RWD
src/index.js          Worker 進入點：/api/* 走 D1，其餘回退靜態資源
src/api.js            GET /api/state、POST /api/action
src/lib.js            共用工具：session、雜湊、學號遮蔽、逾時自動分配
schema.sql            D1 資料表
wrangler.toml         Worker 設定、assets 目錄、D1 binding
```

## 部署（Cloudflare Workers）

1. 建立 D1 資料庫並套用 schema：

```bash
npx wrangler d1 create groupmyclass
npx wrangler d1 execute groupmyclass --remote --file=schema.sql
```

2. 把 `wrangler.toml` 內的 `database_id` 換成上一步輸出的 ID。
3. 部署：

```bash
npx wrangler deploy
```

線上網址：<https://groupmyclass.clare8628.workers.dev>

### 點名自動提醒（LINE）所需設定

1. 於 [LINE Developers](https://developers.line.biz/) 建立 Messaging API 官方帳號頻道，取得 Channel Access Token 與 Channel Secret。
2. 設定 Worker Secrets：

```bash
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
npx wrangler secret put LINE_CHANNEL_SECRET
```

   - **指令照原樣輸入，不要把 `LINE_CHANNEL_ACCESS_TOKEN` 換成你的 Token**——它是密鑰「名稱」。
   - 在本專案資料夾開終端機（Mac 的「終端機」App，`cd` 到 `groupmyclass` 目錄；需已 `wrangler login`）執行指令，按 Enter 後會出現提示 `Enter a secret value:`，此時才貼上你的 Token（貼上時畫面不會顯示字元，屬正常），再按 Enter。
   - `LINE_CHANNEL_SECRET` 同樣方式再做一次，值貼 Channel Secret。
   - **Channel ID（純數字，如 `2011976290`）不是 Token，不要貼給 `LINE_CHANNEL_ACCESS_TOKEN`。** 若已貼錯，重新執行同一條指令、貼上正確 Token 即可覆蓋。
   - **Channel secret** 可在 LINE Official Account Manager → 設定 → Messaging API 頁面直接複製（貼給 `LINE_CHANNEL_SECRET`）。
   - **Channel access token 不在 Official Account Manager 的頁面上**，要到 [LINE Developers Console](https://developers.line.biz/console/)（用同一個 LINE 帳號登入）→ 選 Provider → 選該 Channel（如「點名提醒」）→ **「Messaging API」分頁**最下方「Channel access token (long-lived)」→ 按 **Issue** 產生後複製。Official Account Manager 的 Messaging API 頁面底部「LINE Developers Console」連結可直接前往。
3. 設定 Webhook（在 LINE Developers Console → 選你的 Provider → 選該 Messaging API Channel → **「Messaging API」分頁**，往下捲到 **「Webhook settings」** 區塊）：
   - 在 **Webhook URL** 欄位按 Edit，填入 `https://groupmyclass.clare8628.workers.dev/api/line-webhook`，按 Update，再按 **Verify** 確認回傳 Success。
   - 把下方 **Use webhook** 開關打開。
   - 同一分頁的 **LINE Official Account features**（點 Auto-reply messages 的 Edit 會跳到 LINE Official Account Manager）建議把「自動回應訊息」與「加入好友的歡迎訊息」關閉；並確認「允許加入群組與多人聊天室（Allow bot to join group chats）」已開啟，否則 Bot 無法被拉進班級群組。
   - 若你是在 **LINE Official Account Manager → 設定 → 回應設定** 畫面操作（該頁各開關對照）：
     - **Webhook**：目前為關閉，**必須打開**（等同 Use webhook；需先在 Messaging API 頁填好 Webhook URL）。
     - **聊天**：可維持開啟（不影響本功能）。
     - **加入好友的歡迎訊息**：維持關閉即可。
     - **回應方式**：維持「手動聊天」即可，不要選「Bot」或自動回應，以免干擾 Bot 在群組回覆群組 ID。
     - 「允許加入群組與多人聊天室」不在此頁，位於 **設定 → 帳號設定**，請確認已開啟。
   - 若分頁中找不到 Messaging API，代表此 Channel 尚未啟用 Messaging API，請先在 LINE Official Account Manager 的「設定 → Messaging API」啟用。
4. 將官方帳號加入班級 LINE 群組；Bot 會自動在群組內回覆群組 ID，複製貼到老師後台「點名管理 → 點名自動提醒」的「LINE 群組 ID」欄位即可。
   - **Bot 在 Webhook／密鑰設定完成「之前」就已在群組內**：加入事件只會觸發一次，不會補回覆。請在群組內直接輸入 `群組ID`（或 `group id`），Bot 就會回覆該群組 ID；不必退群重加。
   - 仍無回覆時依序檢查：兩個 wrangler 密鑰已設定且已重新部署、LINE Developers 的 Webhook「Verify」顯示 Success、「Use webhook」已開啟、LINE Official Account Manager 的回應設定中 Webhook 已開啟。回覆失敗的原因會寫在 Worker 日誌（`npx wrangler tail`）。

以上 1～3 步屬於一次性的雲端後台設定（需老師/管理者具備 Cloudflare 與 LINE Developers 帳號權限），設定完成後無需再操作；第 4 步與日常的提醒訊息、延遲分鐘、開關設定則都在「老師後台 → 點名管理 → 點名自動提醒」頁面完成，不需再碰指令列。

5. **組長／副組長綁定 LINE（提醒要 tag 到人，必須先做這步）**：LINE 官方帳號無法用姓名或學號反查某人的 LINE userId，必須由本人在群組內主動發一句話，系統才拿得到 userId。因此每位組長或副組長只需在**班級群組**輸入：
   ```
   綁定 學號
   ```
   例如 `綁定 B10912345`（「綁定」與學號間可留空白，也支援 `綁定:學號`、`綁定-學號`）。系統會核對該學號在這門課是否為組長或副組長，核對成功會回覆「OO 已綁定」；核對失敗（學號不存在、或不是組長／副組長）會回覆原因，可重新輸入。組長與副組長任一方綁定即可，兩位都綁定時，第一次提醒先 tag 組長；若組長逾「後台設定的分鐘數」（預設 5 分鐘，可在「點名自動提醒」設定頁調整，0～120）仍未點名，再補發一則 tag 副組長。只有一位綁定時，第一次提醒就 tag 那一位。
   - 不想老師自己一個一個去催告，可在「老師後台 → 點名管理 → 點名自動提醒」按 **📣 發送綁定教學訊息**：系統會自動查出目前尚未綁定的組／副組長名單，一次推播操作說明到群組；全部綁定完成時按鈕會回覆「不需發送」。
   - 綁定只需做一次，除非該組長／副組長已離開這門課的組別。

   **替代方案與取捨**：
   - 老師後台手動輸入各組長 userId：仍需組長先跟 Bot 互動老師才拿得到 userId，等於多一道工序，比現行方案更麻煩，故不採用。
   - LINE Login／LIFF 綁定頁（點擊登入自動帶出 userId，不必打字）：防呆性較高，但需另外申請 LINE Login Channel、架設授權頁面與回呼邏輯，開發與維運成本高出許多，暫不採用。
   - 依群組發言自動配對：LINE 訊息本身不含使用者姓名，仍需人工配對，且容易配錯人，風險較高，不採用。
   - 現行文字指令綁定是「免額外串接」與「操作門檻」之間最務實的折衷；已將指令容錯度放寬、並提供一鍵教學訊息按鈕，降低操作門檻。

#### 檢查頻率

Cron 目前設定為**每 5 分鐘**檢查一次（`wrangler.toml` 的 `[triggers] crons`），提醒最慢會比設定時間晚 5 分鐘內送出；系統以 `attendance_reminder_runs` 保證同一課程同一天只送一次，不會因檢查多次而重複發送。這是基礎設施層的設定（寫在 `wrangler.toml`、需重新部署才會生效），無法從老師後台直接調整；若要改回更即時（例如每分鐘）或更省資源（例如每 15 分鐘），請告知 Tom 調整並重新部署。各課程「上課時間＋提醒延遲分鐘」仍可在老師後台自由調整，不受此頻率限制。

### 自主點名（無人監管，照片佐證）

後台「點名自動提醒」勾選「自主點名模式」的課程（如 115-1華語B1輔導課修課點名單，`c_hb1_1151`）：全體修課學生在群組輸入「綁定 學號」→ 上課後 N 分鐘 tag 未完成者並附 `/checkin.html?c=<課程id>` 連結 → 10 分鐘後第二次提醒 → 再 10 分鐘列出仍未完成者。學生登入（姓名＋密碼，預設學號）後以即時相機拍照上傳。

防舊照片／代點：僅開即時相機、照片燒入姓名／時間／伺服器簽發的 4 碼驗證碼（5 分鐘有效，老師於「自主點名審核」比對）、GPS 教室範圍（可選）、照片雜湊去重、同裝置同日不得替他人點名、僅限課表上課日時間窗（上課前 10 分～後 90 分）。老師可逐筆退回（改記缺席）。名單僅預載圖片中可見的 15 位，其餘請由後台補登。

要改成 push 後自動部署，可於 Cloudflare Dashboard →
Workers & Pages → `groupmyclass` → Settings → Builds → Connect to Git，選擇本 repo 與 `main` 分支。

## 本機開發

```bash
npx wrangler d1 execute groupmyclass --local --file=schema.sql
npx wrangler dev
# http://localhost:8787
```

> 注意：本版需要 Worker 才能運作，直接開啟 `public/index.html` 或用靜態伺服器會無法讀取資料。
