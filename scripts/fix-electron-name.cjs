'use strict';

/*
 * 开发模式（npm start / electron .）下，macOS Dock 悬停名取自 Electron.app 的
 * Info.plist，app.setName() 无法覆盖。本脚本把本地 Electron.app 的
 * CFBundleName / CFBundleDisplayName 改为应用名，并通过 postinstall 自动执行。
 * 打包产物由 electron-builder 按 productName 生成，无需此脚本。
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const APP_DISPLAY_NAME = '水印清理工作台';

if (process.platform !== 'darwin') process.exit(0);

const appBundlePath = path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'Electron.app');
const plistPath = path.join(appBundlePath, 'Contents', 'Info.plist');
if (!fs.existsSync(plistPath)) process.exit(0);

for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
  try {
    execFileSync('/usr/bin/plutil', ['-replace', key, '-string', APP_DISPLAY_NAME, plistPath], { stdio: 'ignore' });
  } catch { /* 忽略单项失败 */ }
}

// 让 LaunchServices 重新登记，Dock 显示名即时生效
try {
  execFileSync('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', appBundlePath], { stdio: 'ignore' });
} catch { /* 忽略 */ }

console.log(`[postinstall] 开发模式 Electron.app 显示名已改为「${APP_DISPLAY_NAME}」`);
