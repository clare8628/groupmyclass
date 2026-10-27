# GRO-46 小日記漏寫檢查

> 已定案並實作於獨立 repo：https://github.com/clare8628/dailynote（本機：`develop/groupmyclass/dailynote/`，未納入本 repo）

## 已確認需求
- 讀取方式：文件「知道連結者可檢視」，用 `export?format=txt` 下載，免金鑰。
- 格式：`YYYYMMDD` 日期行 + `Johnson: …` / `Julia: …`（最新在最上面）。
- 通知：clare@ml.tpcu.edu.tw；日報＝隔日早上 08:00（台北）檢查前一天；月報＝每月最後一天。
- 規則：自 20261016 起；假日都要寫；無日期標題＝兩人皆漏寫；不限字數；補寫期限當日後 3 天（不含當日），過期才算漏寫；每次 100 元。
- 不用資料庫（D1 額度快滿）：每次由文件重算，結果寫 `logs/*.json` 供查核。
- 排程：GitHub Actions cron，不佔用 Cloudflare。

## 仍需 Clare 提供
1. Email 寄送服務：Resend API Key（GitHub Secret `RESEND_API_KEY`）與已驗證寄件地址（Variable `MAIL_FROM`）；或改用 Gmail 應用程式密碼 SMTP。
2. 確認「補寫期限」算法：10/16 沒寫 → 10/19 前補上不算漏寫（目前實作）。
3. 確認月底當天仍在期限內的日期，是否接受順延計入下月月報（目前實作）。
4. 家長/導師留言（如 `Both：`、`@Both`）不會被當成小日記，是否正確。
5. 文件至今 10/23 後 Johnson 尚無內容，上線後 10/26 起將開始通知，確認無誤再啟用 Actions。
