# groupstu 視覺設計規範 — 「美術館畫廊」風格

參考來源：https://peer-review-platform.pages.dev/
（樣式取自該站 `/style.css`、`/app.js`，本文件為可直接實作的規格，非印象式描述。）

核心概念：**每一張卡片都是一幅掛在牆上的畫**。畫布是高瘦的直式畫框，
底下是美術館式的小標籤（plaque）。滑鼠靠近時，畫面在畫框內**由下往上緩慢捲動**，
像走近一幅畫、視線往下延伸看到原本被裁掉的部分。

---

## 1. 設計代幣（Design Tokens）

直接放進 `public/css/styles.css` 的 `:root`：

```css
:root {
  --bg:           #f7f7f5;   /* 美術館牆面：微暖的灰白，不用純白 */
  --surface:      #ffffff;   /* 卡片／面板 */
  --border:       #e5e3de;   /* 所有邊框，帶暖調 */
  --text:         #1f1f1d;   /* 主文字，不用純黑 */
  --text-muted:   #6b6a65;   /* 次要文字、標籤 */
  --primary:      #b5552f;   /* 陶土紅：主要動作、active 狀態 */
  --primary-dark: #9a441f;   /* hover／按下 */
  --accent:       #2f6b56;   /* 森綠：成功、次要強調 */
  --star:         #d99a3c;   /* 赭黃：星等、數值強調 */
  --radius:       10px;
  --shadow: 0 1px 3px rgba(0,0,0,.06), 0 1px 2px rgba(0,0,0,.04);

  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI",
               "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", sans-serif;
}
```

規則：
- **不用純白背景、不用純黑文字**。整體是美術館的暖灰白牆。
- 陰影極輕（畫框的浮起感，不是 Material 的層級感）。
- 標題、標籤用襯線字 `Georgia, "Noto Serif TC", serif`；內文用系統無襯線字。
  襯線字是「美術館」語感的來源，只用在標題與 plaque，不要用在表單。

---

## 2. 版面骨架（四層）

由上而下固定四層，`max-width: 1240px` 置中，內距 `16px`：

| 層 | 內容 | groupstu 對應 |
|---|---|---|
| 1 頂欄 `header.top` | sticky、三欄 grid `1fr auto 1fr`：左標題、中登入、右語言＋教師登入 | 標題「學生分組系統」／學生登入／中英切換／教師登入 |
| 2 資訊帶 `.info-band` | `repeat(auto-fit, minmax(180px,1fr))` 的小卡列 | 學年度、科目、每組人數、誤差 ±、分組時限、已分組人數 |
| 3 引言帶 `.quote-band` | 置中襯線大字，配英文斜體副句 | 每次載入換一句課堂／協作短語（中英雙語） |
| 4 畫廊 `.gallery-main` | 排序列 + 卡片網格，`min-height: 80vh` | 排序（組別／人數／完成度）+ 組別卡片牆 |

```css
header.top {
  display: grid; grid-template-columns: 1fr auto 1fr;
  align-items: center; gap: 10px; padding: 14px 16px;
  background: var(--surface); border-bottom: 1px solid var(--border);
  position: sticky; top: 0; z-index: 10;
}
@media (max-width: 640px) {
  header.top { grid-template-columns: 1fr; justify-items: center; text-align: center; }
  .header-center { order: 3; }
  .top-actions  { order: 2; justify-content: center; }
}

.info-band {
  max-width: 1240px; margin: 0 auto; padding: 18px 16px 0;
  display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 14px;
}
.info-card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 14px 16px;
}
.info-card h4 {
  margin: 0 0 4px; font-size: 12px; font-weight: 600; color: var(--text-muted);
  text-transform: uppercase; letter-spacing: .04em;
}
.info-card p { margin: 0; font-size: 14px; line-height: 1.5; }
@media (max-width: 900px) { .info-band { grid-template-columns: 1fr; } }

.quote-band { max-width: 760px; margin: 0 auto; padding: 34px 16px 4px; text-align: center; }
.quote-zh {
  margin: 0; font-family: Georgia, "Noto Serif TC", serif; font-weight: 600;
  font-size: 30px; line-height: 1.5; letter-spacing: .03em; color: var(--text);
}
.quote-zh::before { content: "\201C"; color: var(--primary); font-size: 1.15em; }
.quote-zh::after  { content: "\201D"; color: var(--primary); font-size: 1.15em; }
.quote-en {
  margin: 10px 0 0; font-family: Georgia, "Times New Roman", serif; font-style: italic;
  font-size: 15px; letter-spacing: .04em; color: var(--text-muted);
}
```

---

## 3. 藥丸型分段控制（Pill Group）

所有切換（語言、排序、檢視模式）統一長這樣：外框圓角膠囊 + 內部按鈕，
active 用 `--primary` 實心填色白字，其餘透明。**全站不要出現第二種切換樣式。**

```css
.pill-group {
  display: inline-flex; gap: 4px;
  border: 1px solid var(--border); border-radius: 999px; padding: 3px;
}
.pill-tab {
  border: none; background: none; border-radius: 999px;
  padding: 5px 12px; font-size: 12px; font-weight: 600;
  cursor: pointer; color: var(--text-muted);
}
.pill-tab.active { background: var(--primary); color: #fff; }
.pill-tab:hover:not(.active) { color: var(--text); }

/* 獨立的圓角按鈕（登入／教師登入等） */
.pill-btn {
  border: 1px solid var(--border); background: var(--surface); border-radius: 999px;
  padding: 6px 14px; font-size: 13px; cursor: pointer; color: var(--text);
}
.pill-btn:hover { border-color: var(--primary); color: var(--primary); }
```

---

## 4. 畫作卡片（本風格的主角）

### 4.1 網格

```css
.gallery-main { max-width: 1240px; margin: 0 auto; padding: 20px 16px 64px; min-height: 80vh; }
.gallery-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 22px 18px;          /* 直向間距大於橫向：像掛在同一面牆上的一排畫 */
}
```

### 4.2 畫框 + plaque

重點：卡片本身 **背景透明、無邊框、無陰影**——邊框與陰影只給「畫布」，
文字直接落在牆面上。這是它看起來像美術館而不像後台列表的關鍵。

```css
.gallery-card {
  background: transparent; display: flex; flex-direction: column;
  text-decoration: none; color: inherit;
  transition: transform .15s ease;
}
.gallery-card:hover { transform: translateY(-3px); }   /* 整幅畫微微浮起 */

.gallery-card .thumb-wrap {
  aspect-ratio: 1 / 2;                 /* 直式高瘦畫框 */
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;                  /* 比一般卡片更小的圓角，接近實體畫框 */
  overflow: hidden;                    /* 捲動效果的裁切邊界 */
  box-shadow: var(--shadow);
}

/* 沒有內容可截圖時的替代畫布：三色漸層當抽象畫 */
.gallery-card .thumb-wrap.thumb-fallback {
  background: linear-gradient(135deg, var(--primary), var(--star), var(--accent));
}
.gallery-card .thumb-wrap.thumb-fallback img { display: none; }

/* 美術館標籤 */
.gallery-card .plaque { padding: 8px 2px 0; text-align: center; }
.gallery-card .plaque h3 {
  font-family: Georgia, "Noto Serif TC", serif;
  font-size: 12.5px; font-weight: 600; margin: 0; line-height: 1.3;
}
.gallery-card .plaque .author {
  font-size: 11px; font-style: italic; color: var(--text-muted); margin: 2px 0 0;
}
.gallery-card .plaque .rating {
  font-size: 11px; font-weight: 600; color: var(--star); margin: 3px 0 0;
}
```

---

## 5. Hover 由下往上捲動（核心互動）

原理：畫布 `overflow: hidden` + 內容比畫框高，hover 時把內容
`translateY(負值)` 推上去，用**長時間、linear** 的 transition 讓它「緩慢滑動」而非彈跳。

### 5.1 CSS

```css
.gallery-card .thumb-wrap img {
  width: 120%;            /* 刻意比畫框寬，製造可捲動的垂直餘裕（代價是輕微側邊裁切） */
  max-width: none;
  height: auto;
  display: block;
  position: relative;
  left: -10%;             /* 把加寬的部分左右均分，維持置中 */
  transform: translateY(0);
  transition: transform 3.2s linear;   /* 慢、等速：像視線緩緩下移 */
}
.gallery-card .thumb-wrap:hover img {
  transform: translateY(var(--hover-shift, 0));
}
```

三個不能改的參數：
- `3.2s`：低於 2s 會變成「甩動」，失去畫廊的沉靜感。
- `linear`：用 ease 會有加速度，看起來像動畫特效而不是視線移動。
- `--hover-shift` 由 JS 依實際渲染高度算出，**不要寫死百分比**——寫死會在圖片比例不同時捲過頭或捲不到底。

### 5.2 JS：計算 `--hover-shift`

```js
// 依實際渲染高度算出「超出畫框的部分」，hover 時剛好捲到底、不多不少。
function setupHoverScroll(inner, wrap) {
  const recalc = () => {
    if (!inner.clientWidth || !wrap.clientHeight) return;
    const rendered = inner.scrollHeight || inner.clientHeight;
    const excess = Math.max(0, rendered - wrap.clientHeight);
    inner.style.setProperty("--hover-shift", `-${excess}px`);
  };
  const later = () => requestAnimationFrame(() => Promise.resolve().then(recalc));

  inner.addEventListener("load", later);      // <img> 用
  if (inner.complete !== false) setTimeout(later, 100);   // 已快取／非圖片內容
  window.addEventListener("resize", later);
}
```

> 圖片版另外需要 `naturalWidth/naturalHeight` 換算：
> `rendered = img.clientWidth * (img.naturalHeight / img.naturalWidth)`。

### 5.3 觸控與無障礙

- 觸控裝置沒有 hover：以 `@media (hover: hover)` 包住捲動規則，觸控版直接顯示完整內容或改為可點開。
- 尊重系統設定：

```css
@media (prefers-reduced-motion: reduce) {
  .gallery-card, .gallery-card .thumb-wrap img { transition: none; }
  .gallery-card:hover { transform: none; }
}
```

- 卡片若是連結，用 `<a>` 當根元素並加 `rel="noopener"`；`:focus-visible` 要有和 hover 同等的外觀變化（鍵盤使用者看得到）。

---

## 6. 套用到 groupstu 的對應表

groupstu 沒有「作品截圖」，但**每一組就是一幅畫**——組員名單天然比畫框高，
正是可以往上捲的內容。不需要 mshots 之類的外部截圖服務。

| 畫廊元素 | groupstu 實作 |
|---|---|
| 畫框 `.thumb-wrap`（1:2 直式） | 組別卡片的名單區，`overflow:hidden`；裡面是該組全部組員 |
| 畫框內容 | 組長（置頂、`--primary` 標記）→ 副組長（`--accent`）→ 組員（依序）→ 自動分配者（`--text-muted` + 「自動」標籤） |
| Hover 捲動 | 滑鼠靠近時名單由下往上滑，看完整組名單；離開回到頂端（只顯示組長＋前幾人） |
| `thumb-fallback` 漸層 | 空組別：三色漸層畫布 + 中央「尚無組員」 |
| plaque `h3` | 組別名稱（第 N 組） |
| plaque `.author` | 組長姓名（斜體） |
| plaque `.rating` | `n / m 人`，滿員時改用 `--accent`，未滿用 `--star` |
| 排序列 pill | 組別 / 人數 / 完成度 |
| 資訊帶 6 卡 | 學年度、科目、每組人數、誤差 ±、分組時限倒數、已分組／總人數 |
| 未分組名單 | 畫廊下方獨立一區，同樣的卡片語彙但畫框改為 `aspect-ratio: 2/1` 橫式，與「已成組」在視覺上分開 |

前台既有的 5 秒輪詢重繪時，**不要整塊 `innerHTML = ""` 重建**——會打斷正在進行的 hover 捲動。
以組別 id 做 diff，只更新變動的卡片。

---

## 7. 表單與彈窗（維持同一套語彙）

```css
.modal-overlay {
  position: fixed; inset: 0; background: rgba(31,31,29,.5);
  display: flex; align-items: flex-start; justify-content: center;
  padding: 40px 16px; overflow-y: auto; z-index: 100;
}
.modal {
  background: var(--surface); border-radius: var(--radius);
  box-shadow: 0 20px 50px rgba(0,0,0,.25);
  padding: 24px; width: 100%; max-width: 480px; position: relative;
}

label { display: block; font-size: 13px; font-weight: 600; margin: 14px 0 6px; }
input[type=text], input[type=password], textarea, select {
  width: 100%; padding: 10px 12px;
  border: 1px solid var(--border); border-radius: 8px;
  font-size: 14px; background: var(--bg); color: var(--text); font-family: inherit;
}
input:focus, textarea:focus, select:focus {
  outline: none; border-color: var(--primary); background: var(--surface);
}
```

輸入框平時是 `--bg`（凹陷感），focus 時轉 `--surface` 並染上 `--primary` 邊框——
這是全站唯一的 focus 表現方式。

---

## 8. 檢查清單

- [ ] 牆面 `--bg`，卡片外框透明、只有畫布有邊框陰影
- [ ] 畫框 `aspect-ratio: 1/2`、`overflow: hidden`、`border-radius: 6px`
- [ ] hover：卡片 `translateY(-3px)` + 內容 `translateY(--hover-shift)`，`3.2s linear`
- [ ] `--hover-shift` 由 JS 量測後設定，非寫死
- [ ] plaque 三行（標題襯線 / 副標斜體 / 數值 `--star`）置中
- [ ] 所有切換都是 pill group，active 為 `--primary` 實心
- [ ] 標題與 plaque 用襯線字，表單一律無襯線
- [ ] 640px / 900px 兩個斷點都試過
- [ ] `prefers-reduced-motion` 與 `hover: hover` 皆已處理
- [ ] 中英雙語：所有可見字串走 `data-i18n`
