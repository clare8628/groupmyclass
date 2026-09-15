#!/usr/bin/env node
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

try {
  // 取得目前 git commit 次數（含本次預計為 count + 1）
  const countStr = execSync('git rev-list --count HEAD').toString().trim();
  const nextCount = parseInt(countStr, 10) + 1;
  const newVer = `v2.${nextCount}`;

  const verFilePath = path.join(__dirname, '..', 'src', 'version.js');
  fs.writeFileSync(verFilePath, `export const APP_VERSION = '${newVer}';\n`);

  const scriptPath = path.join(__dirname, '..', 'public', 'js', 'script.js');
  let scriptContent = fs.readFileSync(scriptPath, 'utf8');
  scriptContent = scriptContent.replace(/let APP_VERSION = '[^']+';/, `let APP_VERSION = '${newVer}';`);
  fs.writeFileSync(scriptPath, scriptContent);

  // 將版本檔案加回 staging
  execSync('git add src/version.js public/js/script.js');
  console.log(`[Version Hook] 自動更新版本編號至 ${newVer}`);
} catch (err) {
  console.warn('[Version Hook] 更新版本號略過:', err.message);
}
