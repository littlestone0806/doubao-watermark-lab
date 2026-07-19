# 鸿蒙工程模板入库分发（clone 即可构建/调试）

目标：别人 clone 仓库后，既能 `npm run dist:ohos` 自行构建，也能 DevEco Studio 直接打开 `ohos/` Run 出真实应用。每步都是实测踩过的坑。

## 1. 拷贝模板进仓库（ohos/ 目录）

用 rsync 排除构建产物与本机文件：

```bash
rsync -a \
  --exclude='electron/build/' --exclude='web_engine/build/' \
  --exclude='.hvigor/' --exclude='.cxx/' --exclude='.idea/' \
  --exclude='local.properties' --exclude='.preview/' --exclude='ohosTest/' \
  --exclude='oh_modules/' \
  --exclude='electron/libs/arm64-v8a/libelectron.so' \
  /path/to/ohos_hap/ ohos/
```

- `oh_modules` 是软链接（Windows 克隆会坏），排除后用 `ohpm install` 恢复（scripts/prepare-ohos-libs.cjs 自动做）。
- `libelectron.so`（~144MB）超 GitHub 100MB 单文件限制，单独处理（见第 2 步）。

## 2. 修正模板自带的 .gitignore（隐蔽大坑）

官方模板的 `.gitignore` 默认排除 `/electron/libs` 和 `/web_engine/src/main/resources/resfile`——**引擎库和运行时资源（icudtl.dat、resources.pak、locales、v8 快照）全在里面**，不修正的话入库的是残缺模板，构建能过但运行白屏。改写为只排除构建产物：保留 `**/build`、`/.hvigor`、`.cxx`、`oh_modules` 等，删掉 `/electron/libs`、`resfile`、`rawfile`、`oh-package-lock.json5` 相关行。

## 3. libelectron.so：zip 入库 + hvigorfile 自动解压钩子

zip -9 可压到 ~40%（144MB→~58MB），存 `ohos/prebuilt/libelectron.so.zip`。然后在 **`ohos/hvigorfile.ts` 顶部**做幂等解压（hvigor 每次构建都加载此文件，DevEco 直接 Run 和 CLI 打包两条路都覆盖）：

```ts
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

function ensureLibElectron(): void {
    const soPath = path.join(__dirname, 'electron', 'libs', 'arm64-v8a', 'libelectron.so');
    if (fs.existsSync(soPath)) return;
    const zipPath = path.join(__dirname, 'prebuilt', 'libelectron.so.zip');
    if (!fs.existsSync(zipPath)) return;
    fs.mkdirSync(path.dirname(soPath), { recursive: true });
    if (process.platform === 'win32') {
        execFileSync('tar', ['-xf', zipPath, '-C', path.dirname(soPath)], { stdio: 'inherit' });
    } else {
        execFileSync('unzip', ['-o', zipPath, '-d', path.dirname(soPath)], { stdio: 'inherit' });
    }
}
ensureLibElectron();
```

仓库根 .gitignore 追加：`ohos/electron/libs/arm64-v8a/libelectron.so`（解压产物不入库）。

**教训**：解压脚本只挂 npm script 前置是不够的——DevEco 直接 Run 不经过 npm，必须嵌进 hvigorfile。

## 4. 清理模板残留

- 签名材料：`ohos/build-profile.json5` → `signingConfigs: []`（防个人证书泄露），product 保留 `"signingConfig": "default"`。
- 应用名：`electron/src/main/resources/zh_CN/element/string.json` 与 `en_US` 的 `EntryAbility_label`、`AppScope/resources/base/element/string.json` 的 `app_name`。
- 示例应用：`web_engine/src/main/resources/resfile/resources/app.asar` 和 `app/` 是模板示例（或上一个项目的残留），真机直接 Run 会显示它。要么替换为占位引导页，要么同步真实应用快照（第 5 步）。
- bundleName：`AppScope/app.json5` 的 bundleName 会进仓库，想换包名在这里改（builder 打包时会用 appId 覆盖）。

## 5. 快照同步（直接 Run 即见真实应用）

`dist:ohos` 打包时 builder 会把应用代码注入 dist 产物的 `ohos_hap/web_engine/.../resfile/resources/app.asar`（仅几 MB）。写 sync 脚本把它和 AppScope 的 vendor/versionName/versionCode、图标（app_icon.png/startIcon.png）回拷到仓库 `ohos/` 模板，挂为 `postdist:ohos` 自动执行。实现见 scripts/sync-ohos-app.cjs。提交后，clone 用户 DevEco 打开 `ohos/` 签名 Run 就是真实应用。

## 6. deviceTypes

`electron/src/main/module.json5` 的 `deviceTypes` 决定可装设备（官方模板默认 `["2in1", "tablet"]`，不含 phone）。按目标设备修改并真机实测。

## 7. README 双模式说明

- 方式一（快速体验）：DevEco 打开 `ohos/` → 自动签名 → Run（注明首次构建自动解压引擎库）。
- 方式二（自行构建）：改 `electron-builder.ohos.json` 三条 DevEco 路径 → `npm install && npm run dist:ohos` → 打开 dist 工程签名安装。
