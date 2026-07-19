import { appTasks } from '@ohos/hvigor-ohos-plugin';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * 构建前自动恢复 libelectron.so：
 * 引擎主库 144MB 超过 GitHub 单文件限制，以 zip 形式存放在 prebuilt/ 下。
 * 本文件每次 hvigor 构建都会被加载，此处做幂等检查——缺失才解压。
 * 这样无论是 DevEco Studio 直接 Run，还是 electron-builder 打包，引擎库都自动就位。
 */
function ensureLibElectron(): void {
    const soPath = path.join(__dirname, 'electron', 'libs', 'arm64-v8a', 'libelectron.so');
    if (fs.existsSync(soPath)) return;
    const zipPath = path.join(__dirname, 'prebuilt', 'libelectron.so.zip');
    if (!fs.existsSync(zipPath)) {
        console.warn('[hvigor] 未找到 prebuilt/libelectron.so.zip，无法恢复引擎库');
        return;
    }
    console.log('[hvigor] 解压 libelectron.so（约 144MB，仅首次）...');
    fs.mkdirSync(path.dirname(soPath), { recursive: true });
    if (process.platform === 'win32') {
        execFileSync('tar', ['-xf', zipPath, '-C', path.dirname(soPath)], { stdio: 'inherit' });
    } else {
        execFileSync('unzip', ['-o', zipPath, '-d', path.dirname(soPath)], { stdio: 'inherit' });
    }
}

ensureLibElectron();

export default {
    system: appTasks,  /* Built-in plugin of Hvigor. It cannot be modified. */
    plugins:[]         /* Custom plugin to extend the functionality of Hvigor. */
}
