---
name: electron-harmonyos
description: 将 Electron 桌面应用移植并打包到鸿蒙 HarmonyOS NEXT 设备（Tablet / 2in1）的完整流程。当用户需要把 Electron 项目构建为鸿蒙 HAP 包、适配 openharmony 平台、使用 @electron-ohos/electron-builder 或 openharmony-sig/electron 引擎、解决鸿蒙打包签名/白屏/引擎库缺失问题、或将鸿蒙工程模板入库分发时使用。关键词：鸿蒙、HarmonyOS、HAP、DevEco Studio、hvigor、电子鸿蒙化、Electron 移植。
---

# Electron 应用移植鸿蒙 HarmonyOS NEXT

基于 OpenHarmony 官方适配的 Electron（`@electron-ohos/electron-builder` + 预编译 `ohos_hap` 引擎模板）。**不要源码编译引擎**，用官方预编译模板 + npm 打包器。

## 总流程（按序执行）

1. **能力预验证（POC）**：若应用依赖 CDP（webContents.debugger、DOM.setFileInputFiles、Network.getResponseBody 等），先做最小 POC 工程真机验证三项能力全部 PASS，再投入正式适配。鸿蒙引擎的 Electron 版本可能落后于主项目（如模板 34 vs 项目 43），审计用到的 API 是否在模板版本中存在。
2. **环境准备**：安装 DevEco Studio 并登录华为账号，真机跑通 hello world。确认三条路径（macOS 默认）：
   - hvigorwPath `/Applications/DevEco-Studio.app/Contents/tools/hvigor/bin`
   - ohpmPath `/Applications/DevEco-Studio.app/Contents/tools/ohpm/bin`
   - sdkPath `/Applications/DevEco-Studio.app/Contents/sdk`（内含 hap-sign-tool）
   - CLI 构建必须：`JAVA_HOME="/Applications/DevEco-Studio.app/Contents/jbr/Contents/Home"`；直接调 hvigorw 还需 `DEVECO_SDK_HOME=<sdkPath>`（DevEco GUI 自动带，CLI 不带 → 报 `Invalid value of 'DEVECO_SDK_HOME'`）
3. **获取引擎模板**：openharmony-sig/electron 的预编译 `ohos_hap` 工程（gitcode.com/openharmony-sig/electron）。确认内含 AppScope、electron（含 libs/arm64-v8a/*.so）、web_engine（含 src/main/resources/resfile 运行时资源）。
4. **代码平台适配**：见 [references/code-adaptation.md](references/code-adaptation.md)。
5. **打包配置**：用**独立配置文件** `electron-builder.ohos.json`（不要写进 package.json 的 build 里），脚本：`"dist:ohos": "JAVA_HOME=... electron-builder-ohos --ohos -c electron-builder.ohos.json"`。模板见 [assets/electron-builder.ohos.json](assets/electron-builder.ohos.json)。bundleName 取自该配置的 `appId`（builder 无 ohos 级 appId 覆盖），与 mac/win 分开配置互不影响。
6. **签名**：规则很简单但全是坑，见下方"签名三条铁律"。
7. **验证**：构建后必查——`app.asar` 内是本项目代码（用 `@electron/asar` 的 `listPackage`）、HAP 内含 `libelectron.so` 与 app.asar（`unzip -l`）、AppScope bundleName/versionName 正确。真机验证清单见 [references/verification.md](references/verification.md)。
8. **模板入库分发（可选）**：让别人 clone 即可构建/调试，见 [references/template-packaging.md](references/template-packaging.md)。配套脚本在 [scripts/](scripts/)：prepare-ohos-libs.cjs（引擎库解压+ohpm install）、sync-ohos-app.cjs（打包产物回同步模板快照）。

## 签名三条铁律

1. **DevEco 自动签名的证书材料绑定 bundleName**。模板原 bundleName 签过名后，改 appId 会导致 `SignHap` 报 bundleName 不匹配。打包配置的 appId 必须与模板签名材料一致，或清空签名材料用社区证书（见第 3 条）。
2. **product 里必须保留 `"signingConfig": "default"` 引用**（ohos/build-profile.json5 → app.products）。删掉它，DevEco 直接 Run 打出 unsigned 包，安装报 `no signature file`；CLI 打包不受影响（electron-builder 用 SDK 社区证书自签），问题只会在 DevEco 调试时暴露。
3. **发布开源模板前剥离个人签名材料**：`signingConfigs: []`（certpath/keyPassword/profile 都在里面，泄露个人证书）。空数组时 CLI 构建自动回退 SDK 默认社区 CA 自签，任何人均可复现；用户拿到后 DevEco 一键自动签名即可真机安装。零售鸿蒙设备不信任社区 CA，必须经 DevEco 签名。

## 踩坑速查表

| 症状 | 根因 | 解法 |
| --- | --- | --- |
| DevEco Run 报 `no signature file` | product 缺 `signingConfig` 引用 | 见铁律 2 |
| SignHap 报 bundleName 不匹配 | 签名材料绑定旧 bundleName | 见铁律 1、3 |
| 真机白屏（图标正常） | HAP 里缺 libelectron.so 或 app.asar 是模板残留示例 | `unzip -l` 查 HAP；引擎库自动恢复见 template-packaging.md |
| 应用名/图标是旧的 | 模板残留：EntryAbility_label（zh_CN+en_US string.json）、AppScope app_name、app_icon.png/startIcon.png、resfile/resources/app.asar 示例 | 全部替换为项目资源 |
| CLI 报 `DEVECO_SDK_HOME` 无效 | 直接调 hvigorw 缺环境变量 |  export DEVECO_SDK_HOME=<sdkPath> |
| spawn hvigorw ENOENT | JAVA_HOME 未指向 DevEco 自带 JBR | 用 jbr/Contents/Home |
| GitHub push 被拒/警告 | libelectron.so 144MB 超 100MB 限制 | zip 压缩至 ~58MB 入库 + hvigorfile 自动解压钩子（scripts/ 有实现） |
| 克隆后 oh_modules 报错 | oh_modules 是软链接，不应入库 | .gitignore 排除，ohpm install 恢复 |
| 手机装不上 | module.json5 deviceTypes 无 phone | 按目标设备改 deviceTypes（phone/tablet/2in1/car/wearable/tv），实测确认 |

## 设备类型

鸿蒙设备分 phone / tablet / 2in1 / car / wearable / tv，由 `electron/src/main/module.json5` 的 `deviceTypes` 决定，官方 Electron 模板默认 `["2in1", "tablet"]`（手机跑不了是配置问题不是 bug）。写文档时按设备类别表述，不列具体机型。

## 运行时差异速记

- `process.platform === 'openharmony'`，用常量 `IS_OHOS` 做守卫。
- 鸿蒙上需关闭/降级：自动更新（electron-updater 不可用）、无边框窗口（无三键）、Dock 相关 API；Tray 可用（工作台后台运行依赖它）。
- 文件系统只有沙箱可写：输出目录默认到 `userData` 下；系统对话框选的外部路径可能不可读，必要时复制进沙箱。
- 权限在打包配置的 `requestPermissions` 声明（INTERNET 通常已由 web_engine 模块声明）；剪贴板读取需 `ohos.permission.READ_PASTEBOARD` 带中文 reason，运行时 `systemPreferences.requestSystemPermission?.('pasteboard')`。
