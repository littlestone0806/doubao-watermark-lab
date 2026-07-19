#!/usr/bin/env node
/**
 * dist:ohos 预准备：
 * 1. 解压 ohos/prebuilt/libelectron.so.zip → ohos/electron/libs/arm64-v8a/libelectron.so
 *   （GitHub 单文件 100MB 限制，144MB 的 libelectron.so 以 zip 形式入库）
 * 2. ohos/oh_modules 缺失时用 DevEco 自带 ohpm 执行 ohpm install（恢复依赖软链接）
 * 两个步骤都是幂等的，已就绪时直接跳过。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const ohosDir = path.join(root, 'ohos');
const soPath = path.join(ohosDir, 'electron', 'libs', 'arm64-v8a', 'libelectron.so');
const zipPath = path.join(ohosDir, 'prebuilt', 'libelectron.so.zip');

function extractLibElectron() {
  if (fs.existsSync(soPath)) {
    console.log('[prepare-ohos] libelectron.so 已就绪，跳过解压');
    return;
  }
  if (!fs.existsSync(zipPath)) {
    throw new Error(`[prepare-ohos] 缺少 ${zipPath}，无法恢复 libelectron.so`);
  }
  console.log('[prepare-ohos] 解压 libelectron.so（约 144MB）...');
  fs.mkdirSync(path.dirname(soPath), { recursive: true });
  if (process.platform === 'win32') {
    // Windows 10+ 自带 bsdtar，可直接解 zip
    execFileSync('tar', ['-xf', zipPath, '-C', path.dirname(soPath)], { stdio: 'inherit' });
  } else {
    execFileSync('unzip', ['-o', zipPath, '-d', path.dirname(soPath)], { stdio: 'inherit' });
  }
  if (!fs.existsSync(soPath)) throw new Error('[prepare-ohos] 解压后仍未找到 libelectron.so');
}

function installOhModules() {
  if (fs.existsSync(path.join(ohosDir, 'oh_modules'))) {
    console.log('[prepare-ohos] oh_modules 已就绪，跳过 ohpm install');
    return;
  }
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'electron-builder.ohos.json'), 'utf8'));
  const ohpmBin = cfg?.ohos?.ohpmPath;
  if (!ohpmBin) {
    console.warn('[prepare-ohos] 未配置 ohpmPath，跳过 ohpm install（请用 DevEco 打开 ohos/ 同步依赖）');
    return;
  }
  const ohpm = path.join(ohpmBin, process.platform === 'win32' ? 'ohpm.bat' : 'ohpm');
  console.log('[prepare-ohos] 执行 ohpm install 恢复鸿蒙依赖...');
  execFileSync(ohpm, ['install'], { cwd: ohosDir, stdio: 'inherit', shell: process.platform === 'win32' });
}

extractLibElectron();
installOhModules();
console.log('[prepare-ohos] 完成');
