# 验证与真机调试

## 构建产物静态验证（不打到设备就能做）

```bash
# 1. app.asar 内是本项目代码而非模板示例
node -e "const a=require('@electron/asar');const l=a.listPackage('dist/ohos-arm64-unpacked/ohos_hap/web_engine/src/main/resources/resfile/resources/app.asar');console.log(l.includes('/src/main.js'), l.length)"

# 2. HAP 内含引擎库与应用代码（白屏两大根因排查）
unzip -l dist/ohos-arm64-unpacked/*-ohos-arm64.hap | grep -E "libelectron.so|app.asar"

# 3. 包名/版本/设备类型
grep bundleName dist/ohos-arm64-unpacked/ohos_hap/AppScope/app.json5
grep -A4 deviceTypes dist/ohos-arm64-unpacked/ohos_hap/electron/src/main/module.json5
```

## 安装路径

builder 产出的 `-signed.hap` 是 OpenHarmony 社区 CA 自签，**零售鸿蒙设备不信任**。真机安装：DevEco Studio 打开 dist 里的 `ohos_hap` 工程 → File → Project Structure → Signing Configs → 勾选自动签名（免费，材料绑定 bundleName 与已注册设备）→ Run。

## hdc 调试命令（设备连着开发机时可远程操作）

hdc 位于 `<sdkPath>/default/openharmony/toolchains/hdc`（找不到就 `find <sdkPath> -name hdc`）。

```bash
hdc list targets                                  # 确认设备在线
hdc shell bm dump -a | grep <包名关键字>           # 确认应用已安装（先看这个，别假设）
hdc shell aa start -b <bundleName> -a EntryAbility # 命令行拉起应用
hdc shell hilog -r                                # 清空日志
hdc shell hilog -x | grep -iE "electron|error|fatal"  # 抓运行日志
```

注意：`aa start` 报 ability not installed 时先 `bm dump -a` 确认真实包名——设备上可能根本没有你以为的那个应用（用户可能装在另一台设备上，或安装失败但旧图标残留）。

## 真机功能验证清单（按应用能力裁剪）

- 登录态持久化分区是否正常（重启应用保持登录）
- 隐藏工作窗口的 show/hide 与 Tray 唤回
- CDP 链路：debugger 附加、文件上传（DOM.setFileInputFiles）、网络响应体读取
- 输出文件写入沙箱目录、应用内"打开输出目录"能否唤起文件管理器
- 对话框/拖拽添加文件（外部路径不可读时的 fallback）
- 剪贴板读取（首次触发权限弹窗）
- 系统通知
