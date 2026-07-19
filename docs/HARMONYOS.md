# 鸿蒙版（HarmonyOS NEXT）

鸿蒙版基于 OpenHarmony 官方适配的 Electron（`@electron-ohos/electron-builder` + [openharmony-sig/electron](https://gitcode.com/openharmony-sig/electron) 预编译引擎）构建，功能与桌面版一致（批量队列、多线程、原图直取、降级裁切、涂抹重绘、批量导出、系统通知等均可用）。

**支持设备**：系统要求 HarmonyOS NEXT（5.0 及以上）；设备类型支持 **Tablet（平板）与 2in1（二合一电脑）**。实测不支持 phone（手机），Car / Wearable / TV 未做适配。

**平台差异**：受平台能力限制，应用内自动更新与 Dock 图标换色在鸿蒙上不启用；新版本请在 Release 页下载后按下述步骤重新签名安装。

## 安装 Release 中的 HAP

Release 中的 `*-ohos-arm64.hap` 为未签名包，鸿蒙设备只允许安装已签名的应用。签名只需一次（免费）：

1. 在电脑上安装 [DevEco Studio](https://developer.huawei.com/consumer/cn/deveco-studio/)，注册并登录华为开发者账号（个人账号免费）。
2. 用 DevEco Studio 打开本仓库 `dist/ohos-arm64-unpacked/ohos_hap` 工程（或自行 `npm run dist:ohos` 重新生成）。
3. 进入 **File → Project Structure → Signing Configs**，勾选"Automatically generate signature"自动签名。
4. 点击 **Run** 直接把应用装到已连接的设备（会自动完成签名并安装）；也可以在 Build 菜单构建出已签名 hap 后用 `hdc install` 安装。

## 从源码构建 / 调试

仓库已内置完整鸿蒙工程模板（`ohos/` 目录，144MB 的引擎库 `libelectron.so` 以 zip 形式存放在 `ohos/prebuilt/`，构建时自动解压），clone 后无需另外下载模板。两种方式任选：

### 方式一：直接调试（快速体验，推荐）

仓库 `ohos/` 模板中已内置最近一次发布的应用代码快照（`app.asar`），开箱即用：

1. 安装 DevEco Studio，用其打开仓库根目录的 `ohos/` 工程（等待依赖同步完成；首次构建会自动从 `ohos/prebuilt/` 解压引擎库，只需一次，无需手动操作）。
2. 进入 **File → Project Structure → Signing Configs**，勾选自动签名（工程已引用名为 `default` 的签名配置，签名材料生成后即可用；若报 `no signature file`，检查 `ohos/build-profile.json5` 的 `signingConfigs` 是否已有材料）。
3. 点击 **Run** 装到设备，直接看到完整的水印清理工作台。

### 方式二：自行构建最新代码（修改源码后）

1. 按本机 DevEco 安装位置修改 `electron-builder.ohos.json` 中的 `hvigorwPath` / `ohpmPath` / `sdkPath` 三条路径（Windows 上路径形如 `C:/Program Files/Huawei/DevEco Studio/tools/...`）。
2. 执行 `npm install && npm run dist:ohos`——预准备脚本自动解压引擎库、用 ohpm 恢复鸿蒙依赖，打出 HAP 到 `dist/ohos-arm64-unpacked/`；完成后会**自动把最新应用代码同步回 `ohos/` 模板**（`npm run sync:ohos` 可单独执行），提交后方式一的快照即更新。
3. 用 DevEco Studio 打开 `dist/ohos-arm64-unpacked/ohos_hap` 工程（或直接打开 `ohos/`），自动签名后 Run。

## 把自己的 Electron 项目鸿蒙化？

本项目把完整的移植打包经验沉淀成了一个 Kimi Skill：**[skills/electron-harmonyos](../skills/electron-harmonyos/)**（安装包 `skills/electron-harmonyos.skill`），包含八步流程、签名铁律、踩坑速查表、代码适配清单和可直接复用的脚本。把它装进你的 Kimi，对自己的 Electron 项目说一句"帮我移植到鸿蒙"即可。
