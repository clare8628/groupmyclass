#!/usr/bin/env node
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

try {
  // 取得目前 git commit 次數（含本次預計為 count + 1）
  const countStr = execSync('git rev-list --count HEAD').toString().trim();
  const nextCount = parseInt(countStr, 10) + 1;

  // 取得台北時區（UTC+8）之年月日時分秒
  const now = new Date();
  const twTime = new Date(now.getTime() + (8 * 60 + now.getTimezoneOffset()) * 60000);
  const pad = n => String(n).padStart(2, '0');
  const yyyy = twTime.getFullYear();
  const MM = pad(twTime.getMonth() + 1);
  const dd = pad(twTime.getDate());
  const HH = pad(twTime.getHours());
  const mm = pad(twTime.getMinutes());
  const ss = pad(twTime.getSeconds());

  const newVer = `v2.${nextCount}.${yyyy}${MM}${dd}.${HH}${mm}${ss}`;

  const verFilePath = path.join(__dirname, '..', 'src', 'version.js');
  fs.writeFileSync(verFilePath, `export const APP_VERSION = '${newVer}';\n`);

  const scriptPath = path.join(__dirname, '..', 'public', 'js', 'script.js');
  let scriptContent = fs.readFileSync(scriptPath, 'utf8');
  scriptContent = scriptContent.replace(/let APP_VERSION = '[^']+';/, `let APP_VERSION = '${newVer}';`);
  fs.writeFileSync(scriptPath, scriptContent);

  // 同步更新 index.html 的 ?v= 快取破壞參數，避免瀏覽器沿用舊版 script.js / styles.css 快取
  const indexPath = path.join(__dirname, '..', 'public', 'index.html');
  let indexContent = fs.readFileSync(indexPath, 'utf8');
  indexContent = indexContent
    .replace(/(href="css\/styles\.css)(\?v=[^"]*)?(")/, `$1?v=${newVer}$3`)
    .replace(/(src="js\/script\.js)(\?v=[^"]*)?(")/, `$1?v=${newVer}$3`);
  fs.writeFileSync(indexPath, indexContent);

  // 將版本檔案加回 staging
  execSync('git add src/version.js public/js/script.js public/index.html');
  console.log(`[Version Hook] 自動更新版本編號至 ${newVer}`);
} catch (err) {
  console.warn('[Version Hook] 更新版本號略過:', err.message);
}
