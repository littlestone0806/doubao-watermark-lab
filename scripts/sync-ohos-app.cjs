#!/usr/bin/env node
/**
 * 把 dist:ohos 打包产物中已注入应用代码的 app.asar 同步回仓库内的 ohos/ 模板，
 * 并同步 AppScope 版本号/厂商信息。同步后提交仓库，用户 clone 即可用 DevEco Studio
 * 直接 Run ohos/ 看到真实应用，无需先自行构建。
 * （dist:ohos 完成后会自动调用本脚本；也可手动 npm run sync:ohos）
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const distProject = path.join(root, 'dist', 'ohos-arm64-unpacked', 'ohos_hap');
const tplProject = path.join(root, 'ohos');

const relAsar = path.join('web_engine', 'src', 'main', 'resources', 'resfile', 'resources', 'app.asar');
const srcAsar = path.join(distProject, relAsar);
const dstAsar = path.join(tplProject, relAsar);

if (!fs.existsSync(srcAsar)) {
  console.error('[sync-ohos] 未找到打包产物，请先执行 npm run dist:ohos');
  process.exit(1);
}

fs.copyFileSync(srcAsar, dstAsar);
console.log(`[sync-ohos] app.asar 已同步（${(fs.statSync(dstAsar).size / 1e6).toFixed(1)} MB）`);

// 同步 AppScope 的 vendor / versionCode / versionName（以打包产物为准，其来自 package.json）
const appJsonPath = path.join('AppScope', 'app.json5');
const distApp = fs.readFileSync(path.join(distProject, appJsonPath), 'utf8');
const tplPath = path.join(tplProject, appJsonPath);
let tplApp = fs.readFileSync(tplPath, 'utf8');
for (const key of ['vendor', 'versionCode', 'versionName']) {
  const m = distApp.match(new RegExp(`${key}:\\s*('[^']*'|\\d+)`));
  if (m) tplApp = tplApp.replace(new RegExp(`${key}:\\s*('[^']*'|\\d+)`), `${key}: ${m[1]}`);
}
fs.writeFileSync(tplPath, tplApp);
console.log('[sync-ohos] AppScope 版本信息已同步：', tplApp.match(/versionName:\s*'[^']*'/)[0]);
console.log('[sync-ohos] 完成。如 app.asar 有变化，请提交仓库让 clone 用户拿到最新快照。');
